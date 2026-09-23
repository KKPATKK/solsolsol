#!/usr/bin/env node
/**
 * Count Birdeye CU, durably, so the quota can be watched.
 *
 * The free tier is 30_000 CU a MONTH for the WHOLE bot and a request is billed
 * whether or not its payload lands. docs/round-trips.md §4.4.2 laid out the
 * quota table, but every row except the holder probe was INFERRED from the
 * push count — nothing in the repo counted a Birdeye call. The card path's own
 * `/defi/token_overview` (20 CU × 40-52 pushes/day = 24-31K CU/month) was the
 * inference that mattered most: on its own it can consume the whole quota.
 *
 * So: the client charges every request ATTEMPT (src/birdeye.ts,
 * BIRDEYE_CU_PRICES) into module state; this script adds the durable half and
 * the readout —
 *
 *  1. a day-keyed total in worker_state (`birdeye_cu_v1`), merged with the
 *     same "read, merge, write, and only then advance the in-memory baseline"
 *     discipline the push-ledger and skip-capture syncs use, so a failed write
 *     re-offers its delta instead of dropping it;
 *  2. the drain rides the THROTTLED post-scan telemetry, not the tick path: a
 *     per-tick round trip is exactly what the 50-subrequest invocation budget
 *     cannot pay (docs/round-trips.md §1). The cost of that choice is stated
 *     in the block comment (an isolate recycled inside the gap loses its own
 *     delta, bounded by the gap) and mitigated by the unconditional read;
 *  3. /health reports `birdeyeCu` = today's CU, the calendar month's total
 *     (the quota window), this isolate's unpersisted spend, and the ceiling —
 *     so §4.4.2's inferred table can be replaced with measurements before
 *     anyone decides WHICH paid calls to refuse.
 *
 * Deliberately NOT here: refusing calls once the quota is reached. Dropping one
 * changes what the card shows (the §4.4.2 note: "card display / push
 * verification semantics — not to be done on the side"), and the whole point of
 * the counter is to make that decision against numbers rather than estimates.
 *
 * src/worker.ts carries the edits below the file tools' window (see
 * docs/round-trips.md §6). Same discipline as the other patches in this
 * directory: every replacement must match EXACTLY once, or nothing is written.
 */
const fs = require("fs");

const lines = (...xs) => xs.join("\n");

const edits = [
  {
    file: "src/config.ts",
    name: "the quota knob (interface)",
    old: lines(
      "  /** Minimum spacing between Birdeye HTTP requests (rate limiting). */",
      "  birdeyeRequestIntervalMs: number;",
    ),
    next: lines(
      "  /** Minimum spacing between Birdeye HTTP requests (rate limiting). */",
      "  birdeyeRequestIntervalMs: number;",
      "  /**",
      "   * Birdeye's CU allowance per calendar month (BIRDEYE_MONTHLY_CU_MAX,",
      "   * default 30_000 = the free tier). Reporting only: /health's `birdeyeCu`",
      "   * divides the measured month-to-date spend by this, so the quota is",
      "   * observable instead of inferred from the push count. WHICH paid calls to",
      "   * refuse once it runs out stays a separate, explicit decision — dropping",
      "   * one changes what the card shows (see docs/round-trips.md §4.4.2).",
      "   */",
      "  birdeyeMonthlyCuMax: number;",
    ),
  },
  {
    file: "src/config.ts",
    name: "the quota knob (parsing)",
    old: lines(
      "    birdeyeRequestIntervalMs: Number.isFinite(Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))",
      "      ? Math.max(0, Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))",
      "      : 1100,",
    ),
    next: lines(
      "    birdeyeRequestIntervalMs: Number.isFinite(Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))",
      "      ? Math.max(0, Number(env.BIRDEYE_REQUEST_INTERVAL_MS ?? 1100))",
      "      : 1100,",
      "    birdeyeMonthlyCuMax: Number.isFinite(Number(env.BIRDEYE_MONTHLY_CU_MAX ?? 30000))",
      "      ? Math.max(0, Math.floor(Number(env.BIRDEYE_MONTHLY_CU_MAX ?? 30000)))",
      "      : 30000,",
    ),
  },
  {
    file: "src/worker.ts",
    name: "the ledger, its pure helpers and the sync",
    old: "async function recordDex429(at: number): Promise<void> {",
    next: lines(
      "/**",
      " * Durable Birdeye CU ledger.",
      " *",
      " * Birdeye's free tier is 30_000 CU a MONTH for the whole bot and, until",
      " * now, nothing in this repo counted it: the quota table in",
      " * docs/round-trips.md §4.4.2 was inferred from the push count, not",
      " * measured. The client charges every request ATTEMPT into module state",
      " * (src/birdeye.ts BIRDEYE_CU_PRICES); this is the durable half — a",
      " * day-keyed total in worker_state, so the number survives isolate recycling",
      " * and /health can read it from any isolate.",
      " *",
      " * Why not count it live per tick: a per-tick round trip is exactly what the",
      " * 50-subrequest invocation budget cannot pay (docs/round-trips.md §1), so",
      " * the drain rides the throttled post-scan telemetry instead. What that",
      " * costs is bounded and stated: an isolate recycled inside the sync gap",
      " * loses its OWN delta (≤ one gap of spend), which is why the read is",
      " * unconditional — a fresh isolate republishes the fleet total rather than",
      " * starting from zero and under-reporting the month.",
      " */",
      'const BIRDEYE_CU_STATE_KEY = "birdeye_cu_v1";',
      "/** Same telemetry throttle/bound rationale as the ledger and skip syncs. */",
      "const BIRDEYE_CU_SYNC_MIN_GAP_MS = 5 * 60_000;",
      "const BIRDEYE_CU_SYNC_BOUND_MS = 900;",
      "let birdeyeCuSyncedAt = 0;",
      "",
      "/** Birdeye's free-tier allowance, reported when config does not override it. */",
      "export const BIRDEYE_MONTHLY_CU_DEFAULT = 30_000;",
      "",
      "/** `YYYY-MM-DD` and nothing else (the ledger's only accepted day keys). */",
      "function isBirdeyeDayKey(day: string): boolean {",
      '  if (day.length !== 10 || day[4] !== "-" || day[7] !== "-") return false;',
      "  for (let i = 0; i < day.length; i++) {",
      "    if (i === 4 || i === 7) continue;",
      "    const c = day.charCodeAt(i);",
      "    if (c < 48 || c > 57) return false; // 0-9",
      "  }",
      "  return true;",
      "}",
      "",
      "/** Pure parser for the durable ledger (`{ v: 1, days: { \"YYYY-MM-DD\": cu } }`). */",
      "export function parseBirdeyeCuLedger(raw: string | null): Record<string, number> {",
      "  if (!raw) return {};",
      "  try {",
      "    const parsed = JSON.parse(raw) as { days?: unknown };",
      "    const days = parsed?.days;",
      "    if (!days || typeof days !== \"object\") return {};",
      "    const out: Record<string, number> = {};",
      "    for (const [day, cu] of Object.entries(days as Record<string, unknown>)) {",
      "      const n = Number(cu);",
      "      if (isBirdeyeDayKey(day) && Number.isFinite(n) && n >= 0) out[day] = n;",
      "    }",
      "    return out;",
      "  } catch {",
      "    return {};",
      "  }",
      "}",
      "",
      "/**",
      " * Pure merge: add this isolate's deltas to the durable day map and drop days",
      " * older than the retention window. The ledger only has to answer \"this",
      " * calendar month\", so a fixed tail is all a reader can want and keeps the",
      " * row small.",
      " */",
      "export function mergeBirdeyeCuLedger(",
      "  durable: Record<string, number>,",
      "  delta: Map<string, number>,",
      "  now = Date.now(),",
      "): Record<string, number> {",
      "  const next: Record<string, number> = { ...durable };",
      "  for (const [day, cu] of delta) next[day] = (next[day] ?? 0) + cu;",
      "  const cutoff = birdeyeUtcDay(now - BIRDEYE_CU_LEDGER_DAYS * 86_400_000);",
      "  for (const day of Object.keys(next)) {",
      "    if (day < cutoff) delete next[day];",
      "  }",
      "  return next;",
      "}",
      "",
      "/** Pure reader: today's CU plus the calendar month's total (quota window). */",
      "export function birdeyeCuStats(",
      "  days: Record<string, number>,",
      "  now = Date.now(),",
      "): { day: string; today: number; monthCu: number } {",
      "  const day = birdeyeUtcDay(now);",
      "  const month = day.slice(0, 7);",
      "  let monthCu = 0;",
      "  for (const [d, cu] of Object.entries(days)) {",
      "    if (d.startsWith(month)) monthCu += cu;",
      "  }",
      "  return { day, today: days[day] ?? 0, monthCu };",
      "}",
      "",
      "/** This isolate's unpersisted spend, for /health's `pendingCu`. */",
      "function birdeyeCuPendingTotal(): number {",
      "  let total = 0;",
      "  for (const cu of peekBirdeyeCuDelta().values()) total += cu;",
      "  return total;",
      "}",
      "",
      "/**",
      " * Persist this isolate's Birdeye CU delta (see the ledger above). Same",
      " * discipline as the push-ledger and skip-capture syncs: the READ is",
      " * unconditional, and the in-memory delta is only cleared after a write that",
      " * actually landed, so a failed write re-offers it instead of dropping it.",
      " */",
      "export async function syncBirdeyeCu(",
      "  now = Date.now(),",
      "  database: Db | null = db,",
      "): Promise<void> {",
      "  if (!database) return;",
      "  const delta = peekBirdeyeCuDelta();",
      "  const durable = parseBirdeyeCuLedger(",
      "    await database.getWorkerState(BIRDEYE_CU_STATE_KEY),",
      "  );",
      "  if (delta.size === 0) return;",
      "  const next = mergeBirdeyeCuLedger(durable, delta, now);",
      "  await database.setWorkerState(",
      "    BIRDEYE_CU_STATE_KEY,",
      "    JSON.stringify({ v: 1, days: next }),",
      "  );",
      "  consumeBirdeyeCuDelta(delta);",
      "}",
      "",
      "async function recordDex429(at: number): Promise<void> {",
    ),
  },
  {
    file: "src/worker.ts",
    name: "the sync rides the throttled post-scan telemetry",
    old: lines(
      '      console.warn("[worker] post-scan skip-capture sync failed:", err);',
      "    }",
      "    skipCaptureSyncedAt = Date.now();",
      "  }",
      "}",
    ),
    next: lines(
      '      console.warn("[worker] post-scan skip-capture sync failed:", err);',
      "    }",
      "    skipCaptureSyncedAt = Date.now();",
      "  }",
      "  if (now - birdeyeCuSyncedAt >= BIRDEYE_CU_SYNC_MIN_GAP_MS) {",
      "    try {",
      "      await Promise.race([",
      "        syncBirdeyeCu(now),",
      "        new Promise((resolve) => setTimeout(resolve, BIRDEYE_CU_SYNC_BOUND_MS)),",
      "      ]);",
      "    } catch (err) {",
      '      console.warn("[worker] post-scan Birdeye CU sync failed:", err);',
      "    }",
      "    birdeyeCuSyncedAt = Date.now();",
      "  }",
      "}",
    ),
  },
  {
    file: "src/worker.ts",
    name: "the /health readout is declared",
    old: lines(
      "      let tokenStatsCount: number | null = null;",
      "      let pushedTotal: number | null = null;",
    ),
    next: lines(
      "      let tokenStatsCount: number | null = null;",
      "      let pushedTotal: number | null = null;",
      "      // Birdeye CU accounting (see the ledger above): the free tier is",
      "      // 30_000 CU a MONTH for the whole bot, and §4.4.2's table was an",
      "      // estimate until this existed. Read from Turso, not from an isolate",
      "      // mirror, so any isolate answers with the fleet's month-to-date.",
      "      let birdeyeCu: {",
      "        day: string;",
      "        today: number;",
      "        monthCu: number;",
      "        pendingCu: number;",
      "        monthlyMax: number;",
      "      } | null = null;",
    ),
  },
  {
    file: "src/worker.ts",
    name: "the /health readout is read",
    old: lines(
      "        pushedTotal = (await db?.countSeenTokens()) ?? null;",
      "      } catch {",
      "        // telemetry only — never fail /health over the reads",
      "      }",
    ),
    next: lines(
      "        pushedTotal = (await db?.countSeenTokens()) ?? null;",
      "        const rawCu = await db?.getWorkerState(BIRDEYE_CU_STATE_KEY);",
      "        birdeyeCu = {",
      "          ...birdeyeCuStats(parseBirdeyeCuLedger(rawCu ?? null)),",
      "          // This isolate's unpersisted spend is real spend too: the durable",
      "          // row only moves when the throttled sync lands, so the stored",
      "          // total alone under-reads for up to one sync gap.",
      "          pendingCu: birdeyeCuPendingTotal(),",
      "          monthlyMax: cfg?.birdeyeMonthlyCuMax ?? BIRDEYE_MONTHLY_CU_DEFAULT,",
      "        };",
      "      } catch {",
      "        // telemetry only — never fail /health over the reads",
      "      }",
    ),
  },
  {
    file: "src/worker.ts",
    name: "the /health readout is served",
    old: lines(
      "        enabledChats,",
      "        tokenStatsCount,",
      "        pushedTotal,",
      "        lastSkip: scanner?.lastSkip ?? null,",
    ),
    next: lines(
      "        enabledChats,",
      "        tokenStatsCount,",
      "        pushedTotal,",
      "        birdeyeCu,",
      "        lastSkip: scanner?.lastSkip ?? null,",
    ),
  },
];

const byFile = new Map();
for (const e of edits) {
  if (!byFile.has(e.file)) byFile.set(e.file, fs.readFileSync(e.file, "utf8"));
  const text = byFile.get(e.file);
  const first = text.indexOf(e.old);
  if (first < 0) {
    console.error("MISS      " + e.file + ": " + e.name);
    process.exit(1);
  }
  if (text.indexOf(e.old, first + 1) >= 0) {
    console.error("AMBIGUOUS " + e.file + ": " + e.name);
    process.exit(1);
  }
  byFile.set(
    e.file,
    text.slice(0, first) + e.next + text.slice(first + e.old.length),
  );
  console.log("ok        " + e.file + ": " + e.name);
}

for (const [file, text] of byFile) fs.writeFileSync(file, text);
console.log("written: " + [...byFile.keys()].join(", "));
