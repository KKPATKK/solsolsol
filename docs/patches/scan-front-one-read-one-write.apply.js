#!/usr/bin/env node
/**
 * scan 嘅 **front 階段 = 一個讀 + 一個寫**（2026-09-25，docs/round-trips.md §4.13）。
 *
 * §4.11 量度出一個 tick 嘅 Turso 唔係一條肥 loop，而係一堆**散**嘅一次性
 * statement；§4.12 收咗 tail。剩落嘅大頭係 front：每一條腿都自己讀一次自己嗰條
 * `worker_state` gate row，**每個 tick 都讀**：
 *
 *   1. `listEnabledChats()`                                 1 read（scan 第一個讀）
 *   2. `resumeLaunchBackfill` → `schema_alter_v2_done`       1 read（未完成之前每 tick）
 *   3. `pruneOldTokenStats`   → `token_stats_last_prune`     1 read（每 tick，就算唔到期）
 *   4. `runPeriodicBackfill`  → `birdeye_backfill_at`        1 read（每 tick）
 *
 * 四條 subrequest 都係「一條 worker_state row + 隔籬一個 chat listing」——同 tail
 * 一樣嘅形狀，所以用同一招：
 *
 *   - **一個讀**：`Db.readScanFront(keys)` 一個 `batch([stateRows, chats], "read")`。
 *     scan 開頭讀一次，三條腿改成食 pre-read 嘅值（`Db.gateOf`）。冇 front 嘅
 *     caller（command handler、diagnostic、test）行為完全不變，仍然自己讀。
 *   - **一個寫**：三條腿嘅 bookkeeping（launch backfill 嘅完成旗、Birdeye backfill
 *     嘅 interval stamp、prune 嘅 counter + stamp）入同一個 buffer，
 *     `Db.writeScanFront` 一次 batch 落地。`Scanner.flushScanFront` 喺 pool
 *     階段之後（正常路徑）同 scan 嘅 `finally`（提早 return 嘅路徑）各叫一次；
 *     buffer 空就係 no-op，所以叫兩次唔會多一個 request。
 *
 * **保留嘅紀律**：
 *   - gate row **喺 map 入面就算存在**（absent = 從未寫過，係一個讀數，唔可以
 *     當成「冇讀過」再讀一次）—— 呢個係 `gateOf` 同 scanner 嗰句 inline lookup
 *     嘅意思。
 *   - prune 嘅 counter 用 ADD 語句（同 `bumpTelemetryCounter` 逐字一樣嘅 SQL），
 *     delta 係 0 就**唔入 batch**（以前 delta 0 唔會寫）。
 *   - 一個被拒嘅 batch = 全部冇寫：每一條都係「呢個 maintenance job 上次幾時
 *     跑」，下個 tick 由頭推導，所以 flush 只 log 唔 throw，scan 唔會因為
 *     bookkeeping 而失敗。
 *   - `listEnabledChats` 嘅 projection（`SELECT * FROM chat_settings WHERE
 *     enabled = 1`）同 ORDER 完全唔變，`mapRow` 亦係同一個。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");
/** Class members sit two spaces in; the module-level block does not. */
const indent2 = (s) =>
  s
    .split("\n")
    .map((l) => (l.length === 0 ? l : `  ${l}`))
    .join("\n");

// ---------------------------------------------------------------- src/db.ts --

const DB_TYPES = lines(
  "/**",
  " * The scan front's ONE read (2026-09-25, docs/round-trips.md §4.13): the",
  " * `worker_state` rows the front's maintenance legs gate on, plus the enabled",
  " * chats — one libsql `batch`, so the row set is exactly what it was and only the",
  " * round trips are gone.",
  " *",
  " * Before this every leg paid its own single-row lookup on EVERY tick:",
  " *",
  " *   - the enabled-chats listing (the scan's first read);",
  " *   - the launch_ms migration's completion flag (Db.resumeLaunchBackfill);",
  " *   - the token_stats prune's interval stamp (Db.pruneOldTokenStats);",
  " *   - the Birdeye new-listing backfill's interval stamp",
  " *     (Scanner.runPeriodicBackfill).",
  " *",
  " * Four subrequests out of the invocation's 50, for one `worker_state` lookup",
  " * with a chat row beside it — the same shape the tick tail already pays",
  " * (Db.readPostScanTelemetry, §4.12). The writing half is Db.writeScanFront.",
  " *",
  " * A key that is ABSENT from `gates` is a row that was never written, which is a",
  " * different reading from \"not read at all\": a caller that passes a front must",
  " * treat a missing key as null and must NOT re-read (see Db.gateOf).",
  " */",
  "export interface ScanFront {",
  "  /** `worker_state` rows by key, as of this read (absent = never written). */",
  "  gates: Map<string, string>;",
  "  /** Same projection and ordering as listEnabledChats. */",
  "  chats: ChatSettings[];",
  "  /** Bookkeeping the front's legs queue for its ONE write (Db.writeScanFront). */",
  "  writes: ScanFrontWrite[];",
  "}",
  "",
  "/** One queued front bookkeeping row (see Db.writeScanFront). */",
  "export interface ScanFrontWrite {",
  "  key: string;",
  "  value: string;",
  "  /**",
  "   * ADD the value to the row's INTEGER cast instead of replacing it — the",
  "   * telemetry-counter shape (Db.bumpTelemetryCounter). The SQL is that",
  "   * method's, verbatim.",
  "   */",
  "  add?: boolean;",
  "}",
  "",
  "/**",
  " * The front's gate keys, in one place so the read and the legs cannot drift:",
  " * the launch_ms migration flag, the token_stats prune stamp and the Birdeye",
  " * backfill stamp. Every one of them is a \"when did this job last run\" row,",
  " * read once per tick.",
  " */",
  "export const SCAN_FRONT_GATE_KEYS = [",
  "  \"schema_alter_v2_done\",",
  "  \"token_stats_last_prune\",",
  "  \"birdeye_backfill_at\",",
  "] as const;",
);

// ------------------------------------------------------------ class methods --

const DB_METHODS = indent2(
  lines(
    "/**",
    " * The scan front in ONE read request: the gate rows above plus the enabled",
  " * chats. Read with a `batch` rather than two awaits for the reason the tail's",
  " * grouped read exists — the invocation's 50 subrequests are the binding",
  " * constraint and Turso round trips are 63-83% of them.",
  " *",
  " * `stateKeys` is non-empty by contract (the scan passes SCAN_FRONT_GATE_KEYS);",
  " * an empty array falls back to the chats-only read, so a caller with nothing to",
  " * gate on still pays one request and not a throw.",
  " */",
  "async readScanFront(",
  "  stateKeys: readonly string[] = SCAN_FRONT_GATE_KEYS,",
  "): Promise<ScanFront> {",
  "  const chats = {",
  "    sql: \"SELECT * FROM chat_settings WHERE enabled = 1\",",
  "    args: [] as Array<string | number | null>,",
  "  };",
  "  const state = {",
  "    sql: `SELECT key, value FROM worker_state WHERE key IN (${stateKeys",
  "      .map(() => \"?\")",
  "      .join(\",\")})`,",
  "    args: [...stateKeys] as Array<string | number | null>,",
  "  };",
  "  const res = await this.get().batch(",
  "    stateKeys.length === 0 ? [chats] : [state, chats],",
  "    \"read\",",
  "  );",
  "  const gates = new Map<string, string>();",
  "  if (stateKeys.length > 0) {",
  "    for (const row of res[0]?.rows ?? []) {",
  "      const r = row as Record<string, unknown>;",
  "      gates.set(String(r.key), String(r.value));",
  "    }",
  "  }",
  "  const chatRows = res[stateKeys.length === 0 ? 0 : 1]?.rows ?? [];",
  "  return {",
  "    gates,",
  "    chats: chatRows.map((row) => this.mapRow(row as Record<string, unknown>)),",
  "    writes: [],",
  "  };",
  "}",
  "",
  "/**",
  " * The front's ONE write: every bookkeeping row its legs queued, in one request.",
  " * A rejected batch leaves all of them unwritten, which is exactly what the",
  " * separate writes reached — each row answers \"when did this job last run\", so",
  " * the next tick re-derives it (see Scanner.flushScanFront).",
  " */",
  "async writeScanFront(entries: readonly ScanFrontWrite[]): Promise<void> {",
  "  if (entries.length === 0) return;",
  "  await this.get().batch(",
  "    entries.map((e) =>",
  "      e.add",
  "        ? {",
  "            sql: \"INSERT INTO worker_state (key, value) VALUES (?, ?)\" +",
  "              \" ON CONFLICT(key) DO UPDATE SET\" +",
  "              \" value = CAST(value AS INTEGER) + excluded.value\",",
  "            args: [e.key, e.value],",
  "          }",
  "        : {",
  "            sql: \"INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value\",",
  "            args: [e.key, e.value],",
  "          },",
  "    ),",
  "    \"write\",",
  "  );",
  "}",
  "",
  "/**",
  " * One front gate: the value the front's single read carried, or a read of its",
  " * own when the caller has no front (a command handler, a diagnostic, a test).",
  " * A key missing from the map is the row being absent — presence in the map is",
  " * what says the read happened, so this never turns \"not read\" into \"no row\".",
  " */",
  "private async gateOf(",
  "  front: ScanFront | null | undefined,",
  "  key: string,",
  "): Promise<string | null> {",
  "  if (front) return front.gates.get(key) ?? null;",
  "  return this.getWorkerState(key);",
  "}",
  "",
  "/**",
  " * Queue one front bookkeeping row on the front's single batch, or write it on",
  " * its own when there is no front. A zero ADD delta is not queued at all — the",
  " * same no-op bumpTelemetryCounter makes (see writeScanFront).",
  " */",
  "private async frontStamp(",
  "  front: ScanFront | null | undefined,",
  "  key: string,",
  "  value: string,",
  "  add = false,",
  "): Promise<void> {",
  "  if (front) {",
  "    if (add && Number(value) === 0) return;",
  "    front.writes.push({ key, value, add });",
  "    return;",
  "  }",
  "  if (add) {",
  "    await this.bumpTelemetryCounter(key, Number(value));",
  "    return;",
  "  }",
    "  await this.setWorkerState(key, value);",
    "}",
  ),
);

const DB_CLASS_HEAD = lines(
  "export class Db {",
  "  /**",
  "   * Entries kept in the shared delivery ring (see recordPushDelivery).",
);

const DB_SET_MANY = lines(
  "  async setWorkerStatesMany(",
  "    entries: Array<{ key: string; value: string }>,",
  "  ): Promise<void> {",
  "    if (entries.length === 0) return;",
  "    await this.get().batch(",
  "      entries.map((e) => ({",
  "        sql: \"INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value\",",
  "        args: [e.key, e.value],",
  "      })),",
  "      \"write\",",
  "    );",
  "  }",
);

const DB_RESUME_HEAD = lines(
  "  async resumeLaunchBackfill(budgetMs: number): Promise<boolean> {",
  "    if (await this.getWorkerState(\"schema_alter_v2_done\")) return true;",
);

const DB_RESUME_HEAD_NEW = lines(
  "  async resumeLaunchBackfill(",
  "    budgetMs: number,",
  "    front?: ScanFront | null,",
  "  ): Promise<boolean> {",
  "    // The gate rides the front's ONE read on a tick (see readScanFront): this",
  "    // is a per-tick single-row lookup until the flag is set.",
  "    if (await this.gateOf(front, \"schema_alter_v2_done\")) return true;",
);

const DB_RESUME_DONE = lines(
  "      if (updated < 5000) {",
  "        await this.setWorkerState(\"schema_alter_v2_done\", \"1\");",
  "        console.log(\"[db] launch_ms backfill complete\");",
  "        return true;",
  "      }",
);

const DB_RESUME_DONE_NEW = lines(
  "      if (updated < 5000) {",
  "        // Queued on the front's ONE batch when a tick is driving (see",
  "        // writeScanFront); a standalone caller writes it here as before.",
  "        await this.frontStamp(front, \"schema_alter_v2_done\", \"1\");",
  "        console.log(\"[db] launch_ms backfill complete\");",
  "        return true;",
  "      }",
);

const DB_PRUNE_HEAD = lines(
  "  async pruneOldTokenStats(olderThanMs: number): Promise<number> {",
  "    const lastPrune = await this.getWorkerState(\"token_stats_last_prune\");",
);

const DB_PRUNE_HEAD_NEW = lines(
  "  async pruneOldTokenStats(",
  "    olderThanMs: number,",
  "    front?: ScanFront | null,",
  "  ): Promise<number> {",
  "    // The interval gate rides the front's ONE read on a tick (see",
  "    // readScanFront): it is asked on EVERY tick, due or not.",
  "    const lastPrune = await this.gateOf(front, \"token_stats_last_prune\");",
);

const DB_PRUNE_WRITES = lines(
  "    await this.bumpTelemetryCounter(\"telemetry_token_stats_count\", -deleted);",
  "    await this.setWorkerState(\"token_stats_last_prune\", String(Date.now()));",
  "    return deleted;",
);

const DB_PRUNE_WRITES_NEW = lines(
  "    // The prune's two bookkeeping rows go on the front's ONE batch (see",
  "    // writeScanFront), so a due prune costs the deletes plus no extra round trip",
  "    // for the counter and the stamp. No front = the old two writes, verbatim.",
  "    await this.frontStamp(front, \"telemetry_token_stats_count\", String(-deleted), true);",
  "    await this.frontStamp(front, \"token_stats_last_prune\", String(Date.now()));",
  "    return deleted;",
);

// ------------------------------------------------------------ src/scanner.ts --

const SC_IMPORT = "import type { Db, TokenStats } from \"./db\";";

const SC_IMPORT_NEW = lines(
  "import {",
  "  SCAN_FRONT_GATE_KEYS,",
  "  type Db,",
  "  type ScanFront,",
  "  type TokenStats,",
  "} from \"./db\";",
);

const SC_FIELD = "  private launchBackfillDone = false;";

const SC_FIELD_NEW = lines(
  "  private launchBackfillDone = false;",
  "  /**",
  "   * The tick's front read (see Db.readScanFront): the enabled chats and the",
  "   * three maintenance gate rows, in ONE request, plus the write buffer the",
  "   * front's legs queue their bookkeeping on (Db.writeScanFront). Null outside a",
  "   * tick — a standalone Scanner — where each leg falls back to its own",
  "   * single-row read, exactly as it did before this existed.",
  "   */",
  "  private scanFront: ScanFront | null = null;",
);

const SC_STAMP = lines(
  "  /** One phase stamp, never thrown into the scan (see onTickPhase). */",
  "  private stampPhase(phase: string): void {",
  "    const hook = this.onTickPhase;",
  "    if (!hook) return;",
  "    try {",
  "      hook(phase);",
  "    } catch {",
  "      /* a stamp is telemetry */",
  "    }",
  "  }",
);

const SC_STAMP_NEW = lines(
  SC_STAMP,
  "",
  "  /**",
  "   * Land the front's queued bookkeeping in ONE write request (see",
  "   * Db.writeScanFront). Idempotent: an empty buffer is a no-op, so the normal",
  "   * path (after the pool phase) and the scan's `finally` (every early return)",
  "   * can both call it and only ever pay for one batch. A rejected batch is logged",
  "   * and swallowed — each row answers \"when did this maintenance job last run\",",
  "   * which the next tick re-derives, and the scan must never fail over",
  "   * bookkeeping.",
  "   */",
  "  private async flushScanFront(): Promise<void> {",
  "    const front = this.scanFront;",
  "    if (!front || front.writes.length === 0) return;",
  "    // Emptied BEFORE the write: a rejected batch must not be re-offered, or the",
  "    // prune's counter would be added twice.",
  "    const writes = front.writes;",
  "    front.writes = [];",
  "    try {",
  "      await this.db.writeScanFront(writes);",
  "    } catch (err) {",
  "      console.error(",
  "        \"[scanner] scan-front bookkeeping write failed:\",",
  "        err instanceof Error ? err.message : err,",
  "      );",
  "    }",
  "  }",
  "",
  "  /**",
  "   * Queue one front bookkeeping row on the tick's single write, or write it on",
  "   * its own when there is no front (a standalone Scanner).",
  "   */",
  "  private async stampFront(key: string, value: string): Promise<void> {",
  "    const front = this.scanFront;",
  "    if (front) {",
  "      front.writes.push({ key, value });",
  "      return;",
  "    }",
  "    await this.db.setWorkerState(key, value);",
  "  }",
);

const SC_CHATS = lines(
  "      const chats = await this.db.listEnabledChats();",
  "      if (chats.length === 0) {",
  "        console.log(\"[scanner] no chats with push enabled, skipping\");",
  "        this.lastSkip = \"no-chats-enabled\";",
  "        return;",
  "      }",
);

const SC_CHATS_NEW = lines(
  "      // THE FRONT'S ONE READ (see Db.readScanFront): the enabled chats and the",
  "      // three `worker_state` gate rows the front's maintenance legs consult",
  "      // (schema_alter_v2_done / token_stats_last_prune / birdeye_backfill_at),",
  "      // in ONE request. Each of those legs used to pay its own single-row lookup",
  "      // on EVERY tick — four subrequests out of the invocation's 50 for what is",
  "      // one `worker_state` lookup with a chat row beside it (docs/round-trips.md",
  "      // §4.13). The projection and ordering of the chats half are unchanged",
  "      // (Db.readScanFront issues the same SELECT listEnabledChats does).",
  "      const front = await this.db.readScanFront(SCAN_FRONT_GATE_KEYS);",
  "      this.scanFront = front;",
  "      const chats = front.chats;",
  "      if (chats.length === 0) {",
  "        console.log(\"[scanner] no chats with push enabled, skipping\");",
  "        this.lastSkip = \"no-chats-enabled\";",
  "        return;",
  "      }",
);

const SC_RESUME = "          this.launchBackfillDone = await this.db.resumeLaunchBackfill(4_000);";

const SC_RESUME_NEW =
  "          this.launchBackfillDone = await this.db.resumeLaunchBackfill(4_000, this.scanFront);";

const SC_PRUNE = lines(
  "      try {",
  "        await this.fetchFeedCapped(",
  "          () => this.db.pruneOldTokenStats(now - RE_EVAL_WINDOW_MS),",
  "          undefined,",
  "          poolDeadline,",
  "        );",
  "      } catch (err) {",
  "        console.error(",
  "          \"[scanner] token_stats prune failed:\",",
  "          err instanceof Error ? err.message : err,",
  "        );",
  "      }",
);

const SC_PRUNE_NEW = lines(
  "      try {",
  "        await this.fetchFeedCapped(",
  "          () => this.db.pruneOldTokenStats(now - RE_EVAL_WINDOW_MS, this.scanFront),",
  "          undefined,",
  "          poolDeadline,",
  "        );",
  "      } catch (err) {",
  "        console.error(",
  "          \"[scanner] token_stats prune failed:\",",
  "          err instanceof Error ? err.message : err,",
  "        );",
  "      }",
  "      // ...and the front's ONE write (see Db.writeScanFront): the launch_ms",
  "      // migration flag, the Birdeye backfill stamp and the prune's counter +",
  "      // stamp, in one request instead of up to four. Idempotent — the scan's",
  "      // `finally` calls this again for the paths that return earlier.",
  "      await this.flushScanFront();",
);

const SC_BACKFILL_HEAD = lines(
  "  private async runPeriodicBackfill(): Promise<number> {",
  "    const birdeye = this.birdeye;",
  "    if (!birdeye || !this.config.birdeyeBackfillEnabled) return 0;",
  "    const cfg = this.config;",
  "    const lastRaw = await this.db.getWorkerState(\"birdeye_backfill_at\");",
);

const SC_BACKFILL_HEAD_NEW = lines(
  "  private async runPeriodicBackfill(): Promise<number> {",
  "    const birdeye = this.birdeye;",
  "    if (!birdeye || !this.config.birdeyeBackfillEnabled) return 0;",
  "    const cfg = this.config;",
  "    // The interval gate is asked on EVERY tick, due or not, so on a tick it",
  "    // rides the front's ONE read (see Db.readScanFront). A key that is MISSING",
  "    // from the map is a row that was never written, not a read that was",
  "    // skipped — hence `?? null` and no fallback read.",
  "    const lastRaw =",
  "      this.scanFront !== null",
  "        ? this.scanFront.gates.get(\"birdeye_backfill_at\") ?? null",
  "        : await this.db.getWorkerState(\"birdeye_backfill_at\");",
);

const SC_BACKFILL_STAMP_EMPTY = lines(
  "    if (found.length === 0) {",
  "      // Still mark the run so a permanently-empty feed doesn't re-trigger",
  "      // every scan (and burn CU retrying).",
  "      await this.db.setWorkerState(\"birdeye_backfill_at\", String(now));",
  "      return 0;",
  "    }",
);

const SC_BACKFILL_STAMP_EMPTY_NEW = lines(
  "    if (found.length === 0) {",
  "      // Still mark the run so a permanently-empty feed doesn't re-trigger",
  "      // every scan (and burn CU retrying).",
  "      await this.stampFront(\"birdeye_backfill_at\", String(now));",
  "      return 0;",
  "    }",
);

const SC_BACKFILL_STAMP = lines(
  "    await this.db.recordTokenStatsMany(stats);",
  "    await this.db.setWorkerState(\"birdeye_backfill_at\", String(now));",
  "    return stats.length;",
);

const SC_BACKFILL_STAMP_NEW = lines(
  "    await this.db.recordTokenStatsMany(stats);",
  "    await this.stampFront(\"birdeye_backfill_at\", String(now));",
  "    return stats.length;",
);

const SC_FINALLY = lines("    } finally {", "      clearTimeout(watchdog);");

const SC_FINALLY_NEW = lines(
  "    } finally {",
  "      // A path that left the scan early (a subrequest floor cut, a stop check,",
  "      // an empty pool) still owes the front's queued bookkeeping — the normal",
  "      // path already landed it right after the pool phase, so this is a no-op",
  "      // then (see flushScanFront).",
  "      await this.flushScanFront();",
  "      // The front is tick-scoped: a later tick must never read a stale gate.",
  "      this.scanFront = null;",
  "      clearTimeout(watchdog);",
);

const PATCHES = [
  {
    file: "src/db.ts",
    what: "the front's types and key set sit above the class",
    marker: "export interface ScanFront {",
    anchor: DB_CLASS_HEAD,
    replacement: lines(DB_TYPES, "", DB_CLASS_HEAD),
  },
  {
    file: "src/db.ts",
    what: "the front's read/write/gate helpers land next to the tail's grouped pair",
    marker: "async readScanFront(",
    anchor: DB_SET_MANY,
    replacement: lines(DB_SET_MANY, "", DB_METHODS),
  },
  {
    file: "src/db.ts",
    what: "the launch_ms backfill takes its gate from the front",
    marker: "if (await this.gateOf(front, \"schema_alter_v2_done\")) return true;",
    anchor: DB_RESUME_HEAD,
    replacement: DB_RESUME_HEAD_NEW,
  },
  {
    file: "src/db.ts",
    what: "and queues its completion flag on the front's batch",
    marker: "await this.frontStamp(front, \"schema_alter_v2_done\", \"1\");",
    anchor: DB_RESUME_DONE,
    replacement: DB_RESUME_DONE_NEW,
  },
  {
    file: "src/db.ts",
    what: "the prune takes its interval gate from the front",
    marker: "const lastPrune = await this.gateOf(front, \"token_stats_last_prune\");",
    anchor: DB_PRUNE_HEAD,
    replacement: DB_PRUNE_HEAD_NEW,
  },
  {
    file: "src/db.ts",
    what: "and queues its counter + stamp on the front's batch",
    marker: "await this.frontStamp(front, \"telemetry_token_stats_count\", String(-deleted), true);",
    anchor: DB_PRUNE_WRITES,
    replacement: DB_PRUNE_WRITES_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "the front's types and key set come from db.ts",
    marker: "  SCAN_FRONT_GATE_KEYS,",
    anchor: SC_IMPORT,
    replacement: SC_IMPORT_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "the tick holds the front read",
    marker: "  private scanFront: ScanFront | null = null;",
    anchor: SC_FIELD,
    replacement: SC_FIELD_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "the flush and the stamp helper sit with the phase stamp",
    marker: "private async flushScanFront(): Promise<void> {",
    anchor: SC_STAMP,
    replacement: SC_STAMP_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "the chats read becomes the whole front read",
    marker: "const front = await this.db.readScanFront(SCAN_FRONT_GATE_KEYS);",
    anchor: SC_CHATS,
    replacement: SC_CHATS_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "the launch_ms resume is handed the front",
    marker: "resumeLaunchBackfill(4_000, this.scanFront)",
    anchor: SC_RESUME,
    replacement: SC_RESUME_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "the prune is handed the front, and the front's ONE write follows it",
    marker: "pruneOldTokenStats(now - RE_EVAL_WINDOW_MS, this.scanFront)",
    anchor: SC_PRUNE,
    replacement: SC_PRUNE_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "the Birdeye backfill's interval gate rides the front read",
    marker: "this.scanFront.gates.get(\"birdeye_backfill_at\") ?? null",
    anchor: SC_BACKFILL_HEAD,
    replacement: SC_BACKFILL_HEAD_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "its empty-feed stamp is queued",
    marker: "await this.stampFront(\"birdeye_backfill_at\", String(now));\n      return 0;",
    anchor: SC_BACKFILL_STAMP_EMPTY,
    replacement: SC_BACKFILL_STAMP_EMPTY_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "and so is its real-run stamp",
    marker: "await this.stampFront(\"birdeye_backfill_at\", String(now));\n    return stats.length;",
    anchor: SC_BACKFILL_STAMP,
    replacement: SC_BACKFILL_STAMP_NEW,
  },
  {
    file: "src/scanner.ts",
    what: "every early return still lands (and clears) the front",
    marker: "      await this.flushScanFront();\n      // The front is tick-scoped",
    anchor: SC_FINALLY,
    replacement: SC_FINALLY_NEW,
  },
];

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;

for (const patch of PATCHES) {
  const text = bufferOf(patch.file);
  if (typeof patch.marker === "string" && text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const at = text.indexOf(patch.anchor);
  if (at < 0) {
    console.error(`MISS      ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  if (text.indexOf(patch.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  buffers.set(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchor above");
  process.exit(1);
}
let writes = 0;
for (const [file, text] of buffers) {
  if (text === fs.readFileSync(file, "utf8")) continue;
  fs.writeFileSync(file, text);
  writes += 1;
}
console.log(`\nall patches applied (${writes} file(s) written)`);
