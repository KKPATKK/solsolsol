#!/usr/bin/env node
/**
 * 一個 tick 嘅 tail = **一個讀 + 一個寫**（live 2026-09-25，見 docs/round-trips.md §4.12）。
 *
 * 之前一個 tick 嘅 tail 係咁：
 *
 *   1. `getWorkerState(push_deferral)`                        1 read
 *   2. duplicate guard：`getPushAudit()`
 *      ＋（有 pending 時）`getWorkerState(push_ledger)` ＋ `listPushWatch(60)`  1–3 reads
 *   3. 有 drop 就寫一次 shrink                                 1 write
 *   4. `syncPostScanTelemetry()`：`readPostScanTelemetry(4 keys)`   1 read
 *      ＋（有嘢變就）`setWorkerStatesMany`                      1 write（最多）
 *   5. delta 要落地就再寫一次 deferral row                     1 write
 *
 * 即係一個「全部到期」嘅 tick 花 **6 個 Turso round trip** 去決定寫乜。每一個
 * 都係 invocation 50 個 subrequest 之一，而 tracker pass 係最後一個用呢個
 * budget 嘅人（§4.9）—— 所以佢哋合成：
 *
 *   - **一個讀**：`Db.readPostScanTelemetry` 由「四個 key」變成「caller 俾嘅
 *     key set」（`TAIL_STATE_KEYS`：deferral / ledger / audit / skip / birdeye），
 *     listing 兩個照舊。實作同上面 `getWorkerStates(keys)` 一模一樣嘅
 *     `IN (?, …)`。
 *   - **一個寫**：duplicate guard 嘅 shrink、三個 telemetry merge、deferral
 *     delta 全部入同一個 `setWorkerStatesMany` batch。同一條 row 兩次寫嘅情況
 *     （shrink + delta）次序不變：後面嗰個 supersede 前面嗰個，同以前兩次
 *     獨立寫嘅最終結果 byte-identical。
 *
 * **保留嘅紀律**（唔可以當係純 refactor）：
 *   - duplicate guard 依然係第一個跑，而且「in-memory drop 即刻應用」不變；
 *   - 所有 in-memory 狀態（`pushDeferralSnapshot` / `pushDeferralBaseline` /
 *     `stalledUnflushed` / three mirrors / deltas）**只在 batch landed 之後**
 *     才前進 —— 一個被拒嘅 batch 等於三條失敗嘅單獨寫：乜都冇動，下個 tick
 *     原封不動再試。shrink 亦因此唔會「自己一個 landed」而 delta 冇。
 *   - telemetry throttle 照舊「試過就前進」（best-effort telemetry，
 *     delta 未清就係 re-offer 機制）。
 *
 * 另外：`syncPostScanTelemetry` / `runPostScanTelemetry` 呢對函數冇咗 —— 讀
 * 已經喺 tail 開頭發生，所以 throttle 判斷搬入 `syncPushDeferralCounters`，
 * merge 本身變成一個 **pure planner**（`planPostScanTelemetry`：read 入，
 * writes ＋ landed 之後要套嘅 side effect 出）。三個 `*_SYNC_BOUND_MS`
 * 常數同時退役：一個讀一個寫唔需要三段 900ms race。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

// ---------------------------------------------------------------- src/db.ts --

const DB_DOC = lines(
  "  /**",
  "   * The whole tick tail in ONE read request: the `worker_state` rows the tail",
  "   * reconciles (deferral snapshot, push-baseline ledger, delivery audit ring,",
  "   * skip-capture counters, Birdeye CU ledger) plus the two live listings the",
  "   * duplicate guard and the ledger sync read (the pushed rows and the enabled",
  "   * chats' band). The key set is the CALLER's (worker.ts TAIL_STATE_KEYS), so",
  "   * a row that moves into the tail costs bytes rather than a round trip — which",
  "   * is how the deferral snapshot and the duplicate guard's three proof sources",
  "   * stopped paying their own reads.",
);

const DB_READ_HEAD = lines(
  "  async readPostScanTelemetry(",
  "    stateKeys: readonly string[],",
  "    pushWatchLimit = 60,",
  "  ): Promise<{",
);

const DB_READ_SQL = lines(
  "        {",
  "          // Non-empty by contract (the tick tail passes its five rows); N keys,",
  "          // one statement — the same shape as getWorkerStates above.",
  "          sql: `SELECT key, value FROM worker_state WHERE key IN (${stateKeys",
  "            .map(() => \"?\")",
  "            .join(\",\")})`,",
  "          args: [...stateKeys],",
  "        },",
);

// ------------------------------------------------------------ src/worker.ts --

const TAIL_KEYS = lines(
  "",
  "/**",
  " * Every durable row the tick tail owns, read in ONE request",
  " * (Db.readPostScanTelemetry) at the top of syncPushDeferralCounters:",
  " *",
  " *  - `push_deferral` — the snapshot the duplicate guard trims and the counters",
  " *    are folded into;",
  " *  - `push_ledger` / `push_audit` — the ledger reconciliation's two sources,",
  " *    which are also the duplicate guard's hardest proof of delivery;",
  " *  - `skip_capture` / `birdeye_cu_v1` — the other two throttled 5-minute rows.",
  " *",
  " * Before this the tail read them separately — the deferral row, then the audit",
  " * ring (plus the ledger row and the watch listing whenever something was",
  " * pending), then a second four-row batch for the telemetry — so a tick with",
  " * everything due spent SIX round trips deciding what to write. Each one is a",
  " * subrequest out of the invocation's 50 and the tracker pass spends the same",
  " * budget LAST (docs/round-trips.md §4.9), so they are one request now. The row",
  " * set is unchanged: readPostScanTelemetry's ORDER BY ... LIMIT is byte-for-byte",
  " * listPushWatch's.",
  " */",
  "const TAIL_STATE_KEYS = [",
  "  PUSH_DEFERRAL_STATE_KEY,",
  "  PUSH_LEDGER_STATE_KEY,",
  "  PUSH_AUDIT_STATE_KEY,",
  "  SKIP_CAPTURE_STATE_KEY,",
  "  BIRDEYE_CU_STATE_KEY,",
  "] as const;",
  "",
  "/**",
  " * What that one read hands back: the raw rows (a missing key is a row that was",
  " * never written) plus the watch listing and the enabled chat band, which the",
  " * duplicate guard's proofs and the ledger merge read.",
  " */",
  "type TailReadout = Awaited<ReturnType<Db[\"readPostScanTelemetry\"]>>;",
);

const DROP_HEAD = lines(
  "/**",
  " * Forget deferred obligations the delivery audit ring already discharged (the",
  " * rule is deliveredDeferredTokens; the duplicate it fixes is 2026-09-20 00:47Z",
  " * GROYPER — a card, then the same card again two minutes later).",
  " *",
  " * Three deliberate choices:",
  " *  - FRESH read, not the module mirror: the duplicate lands on the very next",
  " *    tick, which is inside the push-ledger sync's 5-minute throttle, so a",
  " *    reused copy would be exactly the copy that cannot see the push yet. The",
  " *    read rides the tail's ONE request (TAIL_STATE_KEYS) and happens after the",
  " *    completion flush, where a round trip cannot cost a card or the flush",
  " *    window.",
  " *  - Best-effort: a read that fails leaves the pending list exactly as it was",
  " *    (the caller re-offers the whole tail on the next tick). The cost of that",
  " *    is the duplicate we already had, never a forgotten obligation.",
  " *  - THREE proof sources, because the ring alone is too short-lived: the audit",
  " *    ring holds ~30 deliveries of ALL kinds (initial, resend, follow-up, heal),",
  " *    and live 2026-09-20 it rolled two of the four stale tokens out of its",
  " *    window inside 13 minutes. The durable push ledger carries `initial`",
  " *    provenance for 7 days / 240 pushes, and `push_watch` rows (written right",
  " *    after a successful push) cover the `resend`-only deliveries the ledger by",
  " *    design does not record. All three travel in that one read and are folded",
  " *    into one proof set; only the kind whitelist in deliveredDeferredTokens",
  " *    decides.",
  " *",
  " * Pure apart from the shared registry drop (the caller does every read), so it",
  " * cannot quietly grow a round trip: the tail's read is the only read this rule",
  " * has.",
  " */",
  "function dropDeliveredPendings(tail: TailReadout, pending: readonly string[]): string[] {",
);

const DROP_READ = lines(
  "  // The audit ring is read on EVERY tick, not only when something is pending:",
  "  // it is also where the duplicate count comes from (noteDuplicateCards), and",
  "  // without that number on the heartbeat neither the operator's report nor any",
  "  // fix can be measured. It and the two other proof sources (durable ledger,",
  "  // watch rows) ride the tail's one request unconditionally now — the count is",
  "  // free, and the proof sources cost their rows, not a round trip.",
  "  const audit = parsePushAuditState(tail.states.get(PUSH_AUDIT_STATE_KEY) ?? null);",
  "  const ledgerRaw = tail.states.get(PUSH_LEDGER_STATE_KEY) ?? null;",
  "  const watchRows = tail.pushWatch;",
);

const DEFERRAL_HEAD = lines(
  "export async function syncPushDeferralCounters(",
  "  summary: ScanSummary | null,",
  "  database: Db | null = db,",
  "  now = Date.now(),",
  "): Promise<void> {",
  "  // Called after the completion flush; keep the expensive telemetry reads here",
  "  // rather than on the scan's pre-race path.",
  "  //",
  "  // ORDER MATTERS, and the duplicate guard is why. This function is raced on",
  "  // the tick's tail with `min(DEFERRAL_SYNC_BOUND_MS, remainingFlushMs())`, and",
  "  // its telemetry half used to be a separate block with its own 900ms bound",
  "  // that ran FIRST — so a tick where that throttle fired never reached the",
  "  // guard at all: live 2026-09-20 the two delivered-but-owed tokens",
  "  // `DFQHUegJW…` / `BmnGRH8N1…` stayed pending across two deploys and four",
  "  // minutes of ticks even though the rule matches them (verified by replaying",
  "  // the live pending list against the live watch rows offline). The guard runs",
  "  // FIRST now, and since the whole tail is ONE read + ONE batch there is",
  "  // nothing left for the telemetry to starve: an in-memory drop is applied the",
  "  // moment it is proved, and the row that persists it shares its transaction",
  "  // with the telemetry that used to starve it.",
  "  //",
  "  // The optional `database` / `now` are the unit-test seam, the same shape",
  "  // syncPushLedger / syncSkipCaptureState / syncBirdeyeCu carry; production",
  "  // calls this with the summary alone.",
  "  if (!database) return;",
);

const DEFERRAL_READ = lines(
  "  const ledgerDue = now - pushLedgerSyncedAt >= PUSH_LEDGER_SYNC_MIN_GAP_MS;",
  "  const skipDue = now - skipCaptureSyncedAt >= SKIP_CAPTURE_SYNC_MIN_GAP_MS;",
  "  const birdeyeDue = now - birdeyeCuSyncedAt >= BIRDEYE_CU_SYNC_MIN_GAP_MS;",
  "  // ONE read for the whole tail (see TAIL_STATE_KEYS): the duplicate guard's",
  "  // three proof sources, the deferral row it trims, and the three telemetry",
  "  // rows. A failed read re-offers all of it next tick and writes nothing.",
  "  let tail: TailReadout;",
  "  try {",
  "    tail = await database.readPostScanTelemetry(TAIL_STATE_KEYS);",
  "  } catch (err) {",
  "    console.warn(",
  "      \"[worker] tick tail read failed (deferral counters and telemetry re-offered next tick):\",",
  "      err instanceof Error ? err.message : err,",
  "    );",
  "    return;",
  "  }",
  "  const raw = tail.states.get(PUSH_DEFERRAL_STATE_KEY) ?? null;",
  "  const durable = parsePushDeferralSnapshot(raw);",
);

const DEFERRAL_PLAN_HEAD = lines(
  "  refreshMirror();",
  "  // What the whole tail writes, in ONE batch at the end (see the landing point",
  "  // below): the duplicate guard's shrink first — a later write to the same row",
  "  // supersedes it, exactly the order the two round trips kept — then the",
  "  // telemetry merges, then the deferral delta.",
  "  const writes: Array<{ key: string; value: string }> = [];",
  "  let shrunk: PushDeferralSnapshot | null = null;",
  "  if (stale.length > 0) {",
);

const DEFERRAL_SHRINK = lines(
  "    // tail. Zero deltas on purpose: this row carries the drop, not counters,",
  "    // and the delta row below supersedes it when both are planned.",
  "    shrunk = nextPushDeferralSnapshot(",
  "      raw,",
  "      { deferred: 0, recovered: 0, stalled: 0, pending: owedPending.length },",
  "      now,",
  "      { owner: SCAN_LOCK_OWNER, ...totals },",
  "      owedPending,",
  "    );",
  "    writes.push({ key: PUSH_DEFERRAL_STATE_KEY, value: JSON.stringify(shrunk) });",
  "  }",
  "  // The three throttled telemetry merges ride the SAME read and land in the",
  "  // SAME batch: they used to be a second read plus a second write, each with",
  "  // its own 900ms bound.",
  "  const telemetry = planPostScanTelemetry(",
  "    now,",
  "    { ledger: ledgerDue, skip: skipDue, birdeye: birdeyeDue },",
  "    tail,",
  "  );",
  "  writes.push(...telemetry.writes);",
);

const DEFERRAL_TAIL = lines(
  "  const cursorDelta = pushDeferralDelta(pushDeferralBaseline, totals);",
  "  // The held-back half rides its own pending delta (see stalledUnflushed), and",
  "  // that is what makes a chain-deferral-only tick persist at all: cursorDelta",
  "  // is null whenever the scanner's own counters did not move — exactly the",
  "  // shape this counter exists for. `totals.stalled` still travels with every",
  "  // write as the applied marker, but it is not the amount added.",
  "  const delta = {",
  "    deferred: cursorDelta?.deferred ?? 0,",
  "    recovered: cursorDelta?.recovered ?? 0,",
  "    stalled: stalledUnflushed,",
  "  };",
  "  // `stale.length > 0` keeps the write path open for a drop-only tick: the",
  "  // durable row has to lose those tokens too, or a recycled isolate re-seeds",
  "  // them from storage (see the seed call site) and pushes the same card again.",
  "  let next: PushDeferralSnapshot | null = null;",
  "  let acked = false;",
  "  if (",
  "    delta.deferred <= 0 &&",
  "    delta.recovered <= 0 &&",
  "    delta.stalled <= 0 &&",
  "    stale.length === 0",
  "  ) {",
  "    // Nothing new for the deferral row; the telemetry half of the batch (if",
  "    // anything is due) still lands below.",
  "  } else if (stale.length === 0 && pushDeferralAlreadyApplied(durable, SCAN_LOCK_OWNER, totals)) {",
  "    // A previous attempt of this very write committed while its response was",
  "    // lost (hard wall, invocation kill). The row already carries it — ACK",
  "    // rather than add it a second time.",
  "    acked = true;",
  "  } else {",
  "    next = nextPushDeferralSnapshot(",
  "      raw,",
  "      {",
  "        ...delta,",
  "        // NOT the gauge any more: the snapshot derives `pending` from the list",
  "        // below (see nextPushDeferralSnapshot), because the two must be one",
  "        // fact. This value is the scanner's scan-time count (`deferPending`),",
  "        // taken before the duplicate guard trimmed the list, and publishing it",
  "        // is what made /health read \"pending 7\" next to a 5-token list on",
  "        // 2026-09-20. It still travels: it is the fallback gauge for a caller",
  "        // that passes no list at all.",
  "        pending: summary?.deferPending ?? 0,",
  "      },",
  "      now,",
  "      { owner: SCAN_LOCK_OWNER, ...totals },",
  "      deferredPushTokens(),",
  "    );",
  "    writes.push({ key: PUSH_DEFERRAL_STATE_KEY, value: JSON.stringify(next) });",
  "  }",
  "  // ONE write for the whole tail: the guard's shrink, the three telemetry",
  "  // merges and the deferral delta land together or not at all. A rejected batch",
  "  // leaves every in-memory delta pending and the baseline where it was — the",
  "  // discipline the separate writes kept, now the transaction's own property.",
  "  let landed = writes.length === 0;",
  "  if (writes.length > 0) {",
  "    try {",
  "      await database.setWorkerStatesMany(writes);",
  "      landed = true;",
  "    } catch (err) {",
  "      console.error(",
  "        \"[worker] tick tail write failed (deferral counters and telemetry re-offered next tick):\",",
  "        err instanceof Error ? err.message : err,",
  "      );",
  "    }",
  "  }",
  "  // The telemetry throttle advances whether or not the batch landed: those rows",
  "  // are best-effort telemetry, a failed write is already re-offered through the",
  "  // un-cleared deltas, and the next attempt waits out the same gap.",
  "  const settledAt = Date.now();",
  "  if (ledgerDue) pushLedgerSyncedAt = settledAt;",
  "  if (skipDue) skipCaptureSyncedAt = settledAt;",
  "  if (birdeyeDue) birdeyeCuSyncedAt = settledAt;",
  "  if (landed) {",
  "    // Telemetry side effects only AFTER the batch lands, in the order the",
  "    // standalone syncs applied them: a landed write is the only thing that",
  "    // clears a delta or refreshes a mirror.",
  "    if (telemetry.skipDelta && telemetry.skipMerged) {",
  "      markSkipCaptureSynced();",
  "      console.log(",
  "        `[worker] skip capture persisted: +${telemetry.skipDelta.total} early return(s) (fleet total ${telemetry.skipMerged.total}, last \"${telemetry.skipMerged.lastReason ?? \"unknown\"}\")`,",
  "      );",
  "    }",
  "    if (telemetry.birdeyeDelta) consumeBirdeyeCuDelta(telemetry.birdeyeDelta);",
  "    if (telemetry.ledgerMirror) pushLedgerMirror = telemetry.ledgerMirror;",
  "    if (telemetry.skipMirror) skipCaptureMirror = telemetry.skipMirror;",
  "  }",
  "  if (acked) {",
  "    pushDeferralBaseline = totals;",
  "    stalledUnflushed = 0;",
  "  }",
  "  if (next && landed) {",
  "    pushDeferralSnapshot = next;",
  "    // Baseline advances ONLY here. A write that threw (or was killed past the",
  "    // invocation's wall clock) leaves it untouched, so the next tick re-offers",
  "    // the same delta — and the applied marker above stops that re-offer from",
  "    // double-counting a write that did land.",
  "    pushDeferralBaseline = totals;",
  "    // The held-back delta clears here and nowhere else — one shared landing",
  "    // point with the cursor above, so a lost write re-offers both together.",
  "    stalledUnflushed = 0;",
  "    console.log(",
  "      `[worker] deferral counters persisted: +${delta.deferred} deferred / +${delta.recovered} recovered / +${delta.stalled} held back (totals ${next.deferredTotal}/${next.recoveredTotal}/${next.stalledTotal})`,",
  "    );",
  "  } else if (shrunk && landed) {",
  "    pushDeferralSnapshot = shrunk;",
  "  } else {",
  "    // Nothing was planned for the row, or nothing landed: republish what the",
  "    // read found (the cross-isolate refresh — /health serves whichever",
  "    // heartbeat was written last, so a stale mirror goes visibly backwards).",
  "    refreshMirror();",
  "  }",
  "}",
);

const PLAN_HEAD = lines(
  "/**",
  " * The three throttled telemetry merges as a PURE plan: the tail's read in,",
  " * the rows to write and the side effects to apply once they land, out.",
  " *",
  " * It used to be an async body that paid its own read and its own batch",
  " * (syncPostScanTelemetry's grouped half, which is where the round trips went).",
  " * The caller now hands it the tail's single read and lands every write in the",
  " * tail's single batch, so the merges keep their exact shapes and lose only the",
  " * round trips.",
  " */",
  "function planPostScanTelemetry(",
  "  now: number,",
  "  dues: { ledger: boolean; skip: boolean; birdeye: boolean },",
  "  tail: TailReadout,",
  "): {",
  "  writes: Array<{ key: string; value: string }>;",
  "  ledgerMirror: PushLedgerView | null;",
  "  skipMirror: SkipCaptureState | null;",
  "  skipDelta: SkipDelta | null;",
  "  skipMerged: SkipCaptureState | null;",
  "  birdeyeDelta: Map<string, number> | null;",
  "} {",
  "  const { states, pushWatch, chats } = tail;",
);

const PLAN_RETURN = lines(
  "  // Nothing is landed here: the caller owns the one batch and applies these",
  "  // only after it resolves (a rejected batch leaves every delta pending).",
  "  return { writes, ledgerMirror, skipMirror, skipDelta, skipMerged, birdeyeDelta };",
  "}",
);

const RETIRED_THROTTLE = lines(
  "/**",
  " * (`syncPostScanTelemetry`'s throttled block lives in syncPushDeferralCounters",
  " * now: the tail pays ONE read before the throttles are even consulted, so the",
  " * dues are computed there and the merges below are planned in the same breath.",
  " * There is no second read left to race a bound around.)",
  " */",
);

const PATCHES = [
  // ------------------------------------------------------------- src/db.ts --
  {
    file: "src/db.ts",
    what: "the grouped read's doc names the tick tail and its caller-supplied key set",
    marker: "The whole tick tail in ONE read request",
    anchor: lines(
      "  /**",
      "   * The whole post-scan telemetry block in ONE read request: the four",
      "   * `worker_state` rows the three 5-minute syncs reconcile (push-baseline",
      "   * ledger, delivery audit ring, skip-capture counters, Birdeye CU ledger) plus",
      "   * the two live listings the ledger sync needs to detect a rewritten baseline",
      "   * (`push_watch`'s current baselines and the enabled chats' band).",
    ),
    replacement: DB_DOC,
  },
  {
    file: "src/db.ts",
    what: "and its key list becomes the caller's",
    marker: "    stateKeys: readonly string[],",
    anchor: lines(
      "  async readPostScanTelemetry(",
      "    ledgerKey: string,",
      "    auditKey: string,",
      "    skipKey: string,",
      "    birdeyeKey: string,",
      "    pushWatchLimit = 60,",
      "  ): Promise<{",
    ),
    replacement: DB_READ_HEAD,
  },
  {
    file: "src/db.ts",
    what: "N keys, one statement (the same IN list getWorkerStates builds)",
    marker: "          sql: `SELECT key, value FROM worker_state WHERE key IN (${stateKeys",
    anchor: lines(
      "        {",
      '          sql: "SELECT key, value FROM worker_state WHERE key IN (?, ?, ?, ?)",',
      "          args: [ledgerKey, auditKey, skipKey, birdeyeKey],",
      "        },",
    ),
    replacement: DB_READ_SQL,
  },
  {
    file: "src/db.ts",
    what: "the batch write's doc follows the moved landing point",
    marker: "after this resolves (see syncPushDeferralCounters in src/worker.ts).",
    anchor: "   * after this resolves (see syncPostScanTelemetry in src/worker.ts).",
    replacement: "   * after this resolves (see syncPushDeferralCounters in src/worker.ts).",
  },

  // --------------------------------------------------------- src/worker.ts --
  {
    file: "src/worker.ts",
    what: "the tail's key set, named once",
    marker: "const TAIL_STATE_KEYS",
    anchor: 'const BIRDEYE_CU_STATE_KEY = "birdeye_cu_v1";',
    replacement: lines('const BIRDEYE_CU_STATE_KEY = "birdeye_cu_v1";', TAIL_KEYS),
  },
  {
    file: "src/worker.ts",
    what: "the audit key's doc points at the tail's read",
    marker: "the tick tail's read (TAIL_STATE_KEYS) fetches it",
    anchor: lines(
      " * The delivery audit ring's `worker_state` key. Db.getPushAudit() reads this",
      " * same row; the grouped post-scan telemetry read",
      " * (Db.readPostScanTelemetry) fetches it alongside the ledger/skip/Birdeye rows",
      " * so the ledger reconciliation costs no extra round trip.",
    ),
    replacement: lines(
      " * The delivery audit ring's `worker_state` key. Db.getPushAudit() reads this",
      " * same row; the tick tail's read (TAIL_STATE_KEYS) fetches it alongside the",
      " * deferral/ledger/skip/Birdeye rows, so neither the ledger reconciliation nor",
      " * the duplicate guard's proof costs an extra round trip.",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the three per-sync race bounds retire with the round trips they bounded",
    marker: "PUSH_LEDGER_SYNC_BOUND_MS retired",
    anchor: lines(
      "/** How long a reconciliation may take before the tick moves on (see below). */",
      "const PUSH_LEDGER_SYNC_BOUND_MS = 900;",
    ),
    replacement: lines(
      "// PUSH_LEDGER_SYNC_BOUND_MS retired: the reconciliation rides the deferral",
      "// tail's one read + one write now (syncPushDeferralCounters), which the call",
      "// site bounds once. Stacked per-sync bounds were three 900ms races around",
      "// round trips that no longer exist.",
    ),
  },
  {
    file: "src/worker.ts",
    what: "same for the skip-capture bound",
    marker: "SKIP_CAPTURE_SYNC_BOUND_MS retired",
    anchor: "const SKIP_CAPTURE_SYNC_BOUND_MS = 900;",
    replacement: "// SKIP_CAPTURE_SYNC_BOUND_MS retired: same one read + one write as the ledger.",
  },
  {
    file: "src/worker.ts",
    what: "and for the Birdeye CU bound",
    marker: "BIRDEYE_CU_SYNC_BOUND_MS retired",
    anchor: "const BIRDEYE_CU_SYNC_BOUND_MS = 900;",
    replacement: "// BIRDEYE_CU_SYNC_BOUND_MS retired: same one read + one write as the ledger.",
  },
  {
    file: "src/worker.ts",
    what: "the duplicate guard becomes a function of the tail's read",
    marker: "function dropDeliveredPendings(tail: TailReadout, pending: readonly string[]): string[] {",
    anchor: lines(
      "/**",
      " * Forget deferred obligations the delivery audit ring already discharged (the",
      " * rule is deliveredDeferredTokens; the duplicate it fixes is 2026-09-20 00:47Z",
      " * GROYPER — a card, then the same card again two minutes later).",
      " *",
      " * Two deliberate choices:",
      " *  - FRESH read, not the module mirror: the duplicate lands on the very next",
      " *    tick, which is inside the push-ledger sync's 5-minute throttle, so a",
      " *    reused copy would be exactly the copy that cannot see the push yet. This",
      " *    runs after the completion flush, where one extra round trip cannot cost a",
      " *    card or the flush window.",
      " *  - Best-effort: a failed read returns \"nothing proved delivered\", i.e. the",
      " *    pending list is left exactly as it was. The cost of that is the duplicate",
      " *    we already had, never a forgotten obligation.",
      " *  - THREE proof sources, because the ring alone is too short-lived: the audit",
      " *    ring holds ~30 deliveries of ALL kinds (initial, resend, follow-up, heal),",
      " *    and live 2026-09-20 it rolled two of the four stale tokens out of its",
      " *    window inside 13 minutes. The durable push ledger carries `initial`",
      " *    provenance for 7 days / 240 pushes, and `push_watch` rows (written right",
      " *    after a successful push) cover the `resend`-only deliveries the ledger by",
      " *    design does not record. All three are read in parallel and folded into one",
      " *    proof set; only the kind whitelist in deliveredDeferredTokens decides.",
      " */",
      "async function dropDeliveredPendings(",
      "  database: Db,",
      "  pending: readonly string[],",
      "): Promise<string[]> {",
    ),
    replacement: DROP_HEAD,
  },
  {
    file: "src/worker.ts",
    what: "and it reads that one readout instead of paying three",
    marker: "const audit = parsePushAuditState(tail.states.get(PUSH_AUDIT_STATE_KEY) ?? null);",
    anchor: lines(
      "  // The audit ring is read on EVERY tick, not only when something is pending:",
      "  // it is also where the duplicate count comes from (noteDuplicateCards), and",
      "  // without that number on the heartbeat neither the operator's report nor any",
      "  // fix can be measured. The two other proof sources (durable ledger, watch",
      "  // rows) are only fetched when they can actually be used, so a tick with",
      "  // nothing pending pays one read instead of three.",
      "  let audit: Awaited<ReturnType<Db[\"getPushAudit\"]>>;",
      "  let ledgerRaw: string | null = null;",
      "  let watchRows: Awaited<ReturnType<Db[\"listPushWatch\"]>> = [];",
      "  try {",
      "    if (pending.length === 0) {",
      "      audit = await database.getPushAudit();",
      "    } else {",
      "      [audit, ledgerRaw, watchRows] = await Promise.all([",
      "        database.getPushAudit(),",
      "        database.getWorkerState(PUSH_LEDGER_STATE_KEY),",
      "        database.listPushWatch(60),",
      "      ]);",
      "    }",
      "  } catch (err) {",
      "    console.warn(",
      "      \"[worker] delivery-proof read failed (deferral duplicate guard skipped):\",",
      "      err instanceof Error ? err.message : err,",
      "    );",
      "    return [];",
      "  }",
    ),
    replacement: DROP_READ,
  },
  {
    file: "src/worker.ts",
    what: "the deferral tail takes a test seam and drops the dead-dependency comment",
    marker: "export async function syncPushDeferralCounters(",
    anchor: lines(
      "async function syncPushDeferralCounters(summary: ScanSummary | null): Promise<void> {",
      "  // Called after the completion flush; keep the expensive telemetry reads here",
      "  // rather than on the scan's pre-race path.",
      "  //",
      "  // ORDER MATTERS, and the duplicate guard is why. This function is raced on",
      "  // the tick's tail with `min(DEFERRAL_SYNC_BOUND_MS, remainingFlushMs())`, and",
      "  // syncPostScanTelemetry's throttled ledger sync is itself bounded at 900ms —",
      "  // so when the duplicate guard sat AFTER it, a tick where that throttle fired",
      "  // never reached the guard at all: live 2026-09-20 the two delivered-but-owed",
      "  // tokens `DFQHUegJW…` / `BmnGRH8N1…` stayed pending across two deploys and",
      "  // four minutes of ticks even though the rule matches them (verified by replaying",
      "  // the live pending list against the live watch rows offline). The guard now",
      "  // runs FIRST (one parallel round trip), applies its in-memory effect",
      "  // immediately, and persists the shrink before the telemetry that starved it.",
      "  if (!db) return;",
    ),
    replacement: DEFERRAL_HEAD,
  },
  {
    file: "src/worker.ts",
    what: "the tail opens with ONE read (dues, proof sources and counters together)",
    marker: "tail = await database.readPostScanTelemetry(TAIL_STATE_KEYS);",
    anchor: lines(
      "  const raw = await db.getWorkerState(PUSH_DEFERRAL_STATE_KEY);",
      "  const durable = parsePushDeferralSnapshot(raw);",
    ),
    replacement: DEFERRAL_READ,
  },
  {
    file: "src/worker.ts",
    what: "the guard no longer awaits its own I/O",
    marker: "const stale = dropDeliveredPendings(tail, durable?.pendingTokens ?? []);",
    anchor: "  const stale = await dropDeliveredPendings(db, durable?.pendingTokens ?? []);",
    replacement: "  const stale = dropDeliveredPendings(tail, durable?.pendingTokens ?? []);",
  },
  {
    file: "src/worker.ts",
    what: "the one batch is declared before the shrink that opens it",
    marker: "  let shrunk: PushDeferralSnapshot | null = null;",
    anchor: lines("  refreshMirror();", "  if (stale.length > 0) {"),
    replacement: DEFERRAL_PLAN_HEAD,
  },
  {
    file: "src/worker.ts",
    what: "the shrink is buffered, and the telemetry merges ride the same read",
    marker: "  writes.push(...telemetry.writes);",
    anchor: lines(
      "    // tail. Zero deltas on purpose: this write carries the drop, not counters,",
      "    // and the normal delta path below may still follow with its own.",
      "    try {",
      "      const shrunk = nextPushDeferralSnapshot(",
      "        raw,",
      "        { deferred: 0, recovered: 0, stalled: 0, pending: owedPending.length },",
      "        Date.now(),",
      "        { owner: SCAN_LOCK_OWNER, ...totals },",
      "        owedPending,",
      "      );",
      "      await db.setWorkerState(PUSH_DEFERRAL_STATE_KEY, JSON.stringify(shrunk));",
      "      pushDeferralSnapshot = shrunk;",
      "    } catch (err) {",
      "      console.warn(",
      "        \"[worker] deferral shrink write failed (next tick re-offers it):\",",
      "        err instanceof Error ? err.message : err,",
      "      );",
      "    }",
      "  }",
      "  await syncPostScanTelemetry();",
    ),
    replacement: DEFERRAL_SHRINK,
  },
  {
    file: "src/worker.ts",
    what: "the delta decision, the ONE batch, and the landed-only side effects",
    marker: "[worker] tick tail write failed",
    anchor: lines(
      "  const cursorDelta = pushDeferralDelta(pushDeferralBaseline, totals);",
      "  // The held-back half rides its own pending delta (see stalledUnflushed), and",
      "  // that is what makes a chain-deferral-only tick persist at all: cursorDelta",
      "  // is null whenever the scanner's own counters did not move — exactly the",
      "  // shape this counter exists for. `totals.stalled` still travels with every",
      "  // write as the applied marker, but it is not the amount added.",
      "  const delta = {",
      "    deferred: cursorDelta?.deferred ?? 0,",
      "    recovered: cursorDelta?.recovered ?? 0,",
      "    stalled: stalledUnflushed,",
      "  };",
      "  // `stale.length > 0` keeps the write path open for a drop-only tick: the",
      "  // durable row has to lose those tokens too, or a recycled isolate re-seeds",
      "  // them from storage (see the seed call site) and pushes the same card again.",
      "  if (",
      "    delta.deferred <= 0 &&",
      "    delta.recovered <= 0 &&",
      "    delta.stalled <= 0 &&",
      "    stale.length === 0",
      "  ) {",
      "    refreshMirror();",
      "    return;",
      "  }",
      "  if (stale.length === 0 && pushDeferralAlreadyApplied(durable, SCAN_LOCK_OWNER, totals)) {",
      "    // A previous attempt of this very write committed while its response was",
      "    // lost (hard wall, invocation kill). The row already carries it — ACK",
      "    // rather than add it a second time.",
      "    pushDeferralBaseline = totals;",
      "    stalledUnflushed = 0;",
      "    refreshMirror();",
      "    return;",
      "  }",
      "  const next = nextPushDeferralSnapshot(",
      "    raw,",
      "    {",
      "      ...delta,",
      "      // NOT the gauge any more: the snapshot derives `pending` from the list",
      "      // below (see nextPushDeferralSnapshot), because the two must be one",
      "      // fact. This value is the scanner's scan-time count (`deferPending`),",
      "      // taken before the duplicate guard trimmed the list, and publishing it",
      "      // is what made /health read \"pending 7\" next to a 5-token list on",
      "      // 2026-09-20. It still travels: it is the fallback gauge for a caller",
      "      // that passes no list at all.",
      "      pending: summary?.deferPending ?? 0,",
      "    },",
      "    Date.now(),",
      "    { owner: SCAN_LOCK_OWNER, ...totals },",
      "    deferredPushTokens(),",
      "  );",
      "  await db.setWorkerState(PUSH_DEFERRAL_STATE_KEY, JSON.stringify(next));",
      "  pushDeferralSnapshot = next;",
      "  // Baseline advances ONLY here. A write that threw (or was killed past the",
      "  // invocation's wall clock) leaves it untouched, so the next tick re-offers",
      "  // the same delta — and the applied marker above stops that re-offer from",
      "  // double-counting a write that did land.",
      "  pushDeferralBaseline = totals;",
      "  // The held-back delta clears here and nowhere else — one shared landing",
      "  // point with the cursor above, so a lost write re-offers both together.",
      "  stalledUnflushed = 0;",
      "  console.log(",
      "    `[worker] deferral counters persisted: +${delta.deferred} deferred / +${delta.recovered} recovered / +${delta.stalled} held back (totals ${next.deferredTotal}/${next.recoveredTotal}/${next.stalledTotal})`,",
      "  );",
      "}",
    ),
    replacement: DEFERRAL_TAIL,
  },
  {
    file: "src/worker.ts",
    what: "the standalone throttled telemetry function retires (its read is the tail's now)",
    marker: "throttled block lives in syncPushDeferralCounters",
    anchor: lines(
      "/**",
      " * Persist non-critical telemetry after the scan completion batch. Keeping",
      " * these reads off the pre-race path protects the candidate send window.",
      " *",
      " * The three syncs used to run back to back, each paying its own read — and its",
      " * own write when something changed — so a tick where all three came due (the",
      " * common 5-minute shape) spent SIX Turso round trips. They are grouped here",
      " * into ONE read request and ONE batched write (Db.readPostScanTelemetry /",
      " * Db.setWorkerStatesMany): the measured host split put 63-83% of a tick's",
      " * subrequests into Turso round trips, and every one of these is a subrequest",
      " * out of the invocation's 50 (docs/round-trips.md §4.6.2). The throttles,",
      " * guards and per-sync merges are unchanged — the same rows are skipped when",
      " * nothing changed — and the writes land as one batch, so a rejected batch",
      " * leaves exactly the state three failed single writes did: every in-memory",
      " * delta still pending for the next attempt.",
      " */",
      "async function syncPostScanTelemetry(now = Date.now()): Promise<void> {",
      "  if (!db) return;",
      "  const ledgerDue = now - pushLedgerSyncedAt >= PUSH_LEDGER_SYNC_MIN_GAP_MS;",
      "  const skipDue = now - skipCaptureSyncedAt >= SKIP_CAPTURE_SYNC_MIN_GAP_MS;",
      "  const birdeyeDue = now - birdeyeCuSyncedAt >= BIRDEYE_CU_SYNC_MIN_GAP_MS;",
      "  if (!ledgerDue && !skipDue && !birdeyeDue) return;",
      "  try {",
      "    await Promise.race([",
      "      runPostScanTelemetry(now, ledgerDue, skipDue, birdeyeDue),",
      "      new Promise((resolve) =>",
      "        setTimeout(",
      "          resolve,",
      "          Math.max(",
      "            PUSH_LEDGER_SYNC_BOUND_MS,",
      "            SKIP_CAPTURE_SYNC_BOUND_MS,",
      "            BIRDEYE_CU_SYNC_BOUND_MS,",
      "          ),",
      "        ),",
      "      ),",
      "    ]);",
      "  } catch (err) {",
      "    console.warn(\"[worker] post-scan telemetry sync failed:\", err);",
      "  }",
      "  // The throttle advances whether or not the batch landed. These rows are",
      "  // best-effort telemetry, and a failed write is already re-offered through the",
      "  // un-cleared deltas, so the next attempt waits out the same gap.",
      "  if (ledgerDue) pushLedgerSyncedAt = Date.now();",
      "  if (skipDue) skipCaptureSyncedAt = Date.now();",
      "  if (birdeyeDue) birdeyeCuSyncedAt = Date.now();",
      "}",
    ),
    replacement: RETIRED_THROTTLE,
  },
  {
    file: "src/worker.ts",
    what: "and its grouped body becomes the pure planner",
    marker: "function planPostScanTelemetry(",
    anchor: lines(
      "/**",
      " * The grouped body of syncPostScanTelemetry: one read, the three merges, one",
      " * batch write. Split out of the caller so a SINGLE bound covers the whole",
      " * block, where the old shape stacked three sequential 900ms bounds.",
      " */",
      "async function runPostScanTelemetry(",
      "  now: number,",
      "  ledgerDue: boolean,",
      "  skipDue: boolean,",
      "  birdeyeDue: boolean,",
      "): Promise<void> {",
      "  const database = db;",
      "  if (!database) return;",
      "  const { states, pushWatch, chats } = await database.readPostScanTelemetry(",
      "    PUSH_LEDGER_STATE_KEY,",
      "    PUSH_AUDIT_STATE_KEY,",
      "    SKIP_CAPTURE_STATE_KEY,",
      "    BIRDEYE_CU_STATE_KEY,",
      "  );",
    ),
    replacement: PLAN_HEAD,
  },
  {
    file: "src/worker.ts",
    what: "the ledger merge reads its due flag from the plan",
    marker: "  if (dues.ledger) {",
    anchor: "  if (ledgerDue) {",
    replacement: "  if (dues.ledger) {",
  },
  {
    file: "src/worker.ts",
    what: "so does the skip-capture merge",
    marker: "  if (dues.skip) {",
    anchor: "  if (skipDue) {",
    replacement: "  if (dues.skip) {",
  },
  {
    file: "src/worker.ts",
    what: "and the Birdeye one",
    marker: "  if (dues.birdeye) {",
    anchor: "  if (birdeyeDue) {",
    replacement: "  if (dues.birdeye) {",
  },
  {
    file: "src/worker.ts",
    what: "the planner returns the writes + the landed-only side effects instead of landing them",
    marker: "  return { writes, ledgerMirror, skipMirror, skipDelta, skipMerged, birdeyeDelta };",
    anchor: lines(
      "  if (writes.length > 0) await database.setWorkerStatesMany(writes);",
      "  // Side effects only AFTER the batch lands: a rejected batch leaves every",
      "  // in-memory delta pending (the same discipline the single syncs kept).",
      "  if (skipDelta && skipMerged) {",
      "    markSkipCaptureSynced();",
      "    console.log(",
      "      `[worker] skip capture persisted: +${skipDelta.total} early return(s) (fleet total ${skipMerged.total}, last \"${skipMerged.lastReason ?? \"unknown\"}\")`,",
      "    );",
      "  }",
      "  if (birdeyeDelta) consumeBirdeyeCuDelta(birdeyeDelta);",
      "  if (ledgerMirror) pushLedgerMirror = ledgerMirror;",
      "  if (skipMirror) skipCaptureMirror = skipMirror;",
      "}",
    ),
    replacement: PLAN_RETURN,
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
