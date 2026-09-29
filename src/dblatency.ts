/*
 * Turso round-trip probe — the pure half of the `/debug/db-latency` route
 * (2026-09-29). The measurement itself lives in `Db.measureLatency`, because
 * it needs the live libsql client; everything that can be decided offline
 * (which ops are probed, how a sample set is summarized, which region the
 * connection URL points at, whether the counter arithmetic held) lives here so
 * it is unit-testable without a database.
 *
 * WHY THE PROBE EXISTS
 * The tick's push path gives its Turso CLAIM a 400ms slice
 * (scanner.CARD_CLAIM_BUDGET_MS). Until this change that claim was TWO
 * sequential round trips — the `seen_tokens` INSERT OR IGNORE followed by an
 * awaited telemetry-counter upsert — and the Worker does not run next to the
 * database: live on 2026-09-29 the isolates answered /health from ATL, DFW,
 * MIA, DUB and SYD while the database sat in `aws-ap-northeast-1` (Tokyo),
 * with `poolMs` (ONE batch request) measuring 0-812ms. Two intercontinental
 * round trips is more than 400ms often enough to matter, and a claim that
 * misses its slice DEFERS the card (`cardSendDeferred`,
 * `/debug/deferral.pending`) instead of sending it.
 *
 * The probe answers the four questions that argument rests on, from the Worker
 * itself (the only place the number is meaningful — a laptop or CI box has a
 * different path to the database):
 *
 *   1. REGION / round trip: `select1` is a pure round trip (no rows, no
 *      work), and the report carries the database's own region next to the
 *      colo Cloudflare served the request from, so "far from the database" is
 *      a reading rather than a guess.
 *   2. CONNECTION REUSE: every op keeps its per-sample raw ms, so a first
 *      sample that is much slower than the rest is the connection setup a cold
 *      isolate pays (the client is created per isolate and reused inside it —
 *      see Db.connect — and a cron tick normally lands on a fresh one).
 *   3. THE CLAIM'S SHAPE: `claimShapeTwoTrip` and `claimShapeOneTrip` run the
 *      same two statements the claim runs — an INSERT OR IGNORE followed by
 *      the counter upsert — as two sequential requests and as one batch. The
 *      difference is exactly what the batching bought, measured on the live
 *      path (`claimShapeSavingMs`).
 *   4. THE COUNTER'S ARITHMETIC: the batched claim's second statement derives
 *      its delta from SQL itself (`changes()`, see Db.claimTokenPush) because
 *      a batch cannot branch in TypeScript. That is the one thing this change
 *      could get subtly wrong, so the probe CHECKS it on the live engine
 *      instead of trusting SQLite compatibility: each sample inserts under a
 *      fresh probe key (so the two-trip shape's insert always wins and the
 *      one-trip shape's insert on that same key always loses) and the report
 *      carries the counter's before/after plus the delta a working `changes()`
 *      must produce — 2 per sample: one from the plain upsert, one from the
 *      two-trip insert winning, none from the batch insert that lost. A
 *      `changes()` that always returned 0 or always 1 changes that number, so
 *      `changesVerdict` turns it into a word.
 *
 * SAFETY: the probe never touches a table the push path reads. Its writes land
 * on `worker_state` probe rows only (`db_latency_probe:<nonce>:<sample>` rows
 * are deleted at the end of the call; `db_latency_probe_count` is the one row
 * kept, because the counter check above needs to accumulate), and
 * `scripts/test-unit.js` pins that the probe module's CODE never names the
 * push-identity table — claiming a coin is the one thing a diagnostic must not
 * be able to do.
 */

/** Row the probe's INSERT-shape statements target. Never read by the tick. */
export const DB_LATENCY_PROBE_KEY = "db_latency_probe";
/** Row the probe's counter-UPDATE shape targets (the claim's second half). */
export const DB_LATENCY_PROBE_COUNT_KEY = "db_latency_probe_count";
/** Samples per op when the caller does not ask (3 samples x 6 round trips). */
export const DB_LATENCY_SAMPLES = 3;
/**
 * Ceiling for `?samples=`. Every sample costs six round trips, and the route
 * is an HTTP request against the SAME database the tick is using — 8 is
 * ~48 requests, which is already more than a diagnostic should spend.
 */
export const DB_LATENCY_SAMPLES_MAX = 8;
/**
 * Counter increments a working `changes()` must produce per sample: the plain
 * upsert (+1), the two-trip insert winning on its fresh key (+1), and the
 * one-trip insert on that same key losing (+0). See changesVerdict.
 */
export const DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE = 2;

/**
 * The probed ops, in the order each sample runs them. Names are the report's
 * keys, so they are stable API for whoever reads `/debug/db-latency`.
 */
export const DB_LATENCY_OPS = [
  /** `SELECT 1`: pure round trip, the region/handshake number. */
  "select1",
  /** Single-row read of a key the tick keeps fresh (the front-read shape). */
  "readRow",
  /** One-row upsert: the fleet-wide writer's cost, isolated. */
  "writeUpsert",
  /** The claim's OLD shape: INSERT OR IGNORE + counter upsert, 2 requests. */
  "claimShapeTwoTrip",
  /** The claim's shape since the batching fix: the same two in ONE batch. */
  "claimShapeOneTrip",
] as const;

export type DbLatencyOp = (typeof DB_LATENCY_OPS)[number];

/** Raw ms per op, in sample order (kept so connection setup stays visible). */
export type DbLatencyRaw = Partial<Record<DbLatencyOp, number[]>>;

/**
 * One probe run: the samples, plus the counter reading the `changes()` check
 * is made of (`null` when the row could not be read — the verdict then says so
 * rather than guessing).
 */
export interface DbLatencyMeasurement {
  samples: number;
  raw: DbLatencyRaw;
  counterBefore: number | null;
  counterAfter: number | null;
}

export interface LatencySummary {
  n: number;
  min: number;
  p50: number;
  max: number;
}

export type DbLatencyReport = Partial<Record<DbLatencyOp, LatencySummary>>;

/**
 * `?samples=N` -> a usable count. Anything missing, unparseable or below 1
 * falls back to the default rather than erroring: the probe's job is to return
 * numbers, and `clampLatencySamples(undefined)` must be the common path.
 */
export function clampLatencySamples(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1) return DB_LATENCY_SAMPLES;
  return Math.min(DB_LATENCY_SAMPLES_MAX, n);
}

/**
 * min/median/max of one op's samples. Non-finite and negative entries are
 * dropped (a failed sample is recorded as its wall time, and a clock step can
 * only produce a nonsense value); an empty set summarizes to zeros rather than
 * throwing, so a probe that could not reach the database still answers.
 */
export function summarizeLatency(ms: readonly number[]): LatencySummary {
  const clean = ms
    .filter((v) => Number.isFinite(v) && v >= 0)
    .slice()
    .sort((a, b) => a - b);
  if (clean.length === 0) return { n: 0, min: 0, p50: 0, max: 0 };
  const mid = Math.floor(clean.length / 2);
  const p50 =
    clean.length % 2 === 1
      ? clean[mid]
      : Math.round((clean[mid - 1] + clean[mid]) / 2);
  return { n: clean.length, min: clean[0], p50, max: clean[clean.length - 1] };
}

/** Per-op summaries for a raw sample set (see Db.measureLatency). */
export function summarizeLatencyOps(raw: DbLatencyRaw): DbLatencyReport {
  const out: DbLatencyReport = {};
  for (const op of DB_LATENCY_OPS) {
    const samples = raw[op];
    if (samples) out[op] = summarizeLatency(samples);
  }
  return out;
}

/**
 * What the batching fix saved on the live path: the two-trip claim minus the
 * one-trip claim, both on their medians. Negative means the batch was slower
 * on this isolate (possible on a warm connection where the two-trip shape
 * overlaps better) — reported as measured, never clamped, because the point of
 * the probe is to keep this claim honest.
 */
export function claimShapeSavingMs(report: DbLatencyReport): number | null {
  const two = report.claimShapeTwoTrip?.p50;
  const one = report.claimShapeOneTrip?.p50;
  if (typeof two !== "number" || typeof one !== "number") return null;
  return two - one;
}

/**
 * Did the batched claim's `changes()` arithmetic hold on the live engine?
 *
 * `verified` means the counter moved by exactly
 * `samples x DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE`, which is only possible if
 * the statement after an INSERT inside a batch sees THAT insert's row count —
 * the whole basis of claimTokenPush's one-request counter. `mismatch` is the
 * live answer that it does not, and every reading is paired with the delta it
 * came from so a mismatch can be diagnosed rather than just believed.
 */
export function changesVerdict(
  before: number | null,
  after: number | null,
  samples: number,
): "verified" | "mismatch" | "unavailable" {
  if (before === null || after === null) return "unavailable";
  const expected = samples * DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE;
  return after - before === expected ? "verified" : "mismatch";
}

/**
 * The database's own region, read out of the connection URL — e.g.
 * `libsql://<org>.aws-ap-northeast-1.turso.io` -> `aws-ap-northeast-1`. Only
 * that token is returned: the report is written to be safe to read out loud,
 * and the rest of the hostname is the org's own business. Null when the URL
 * carries no recognisable region (a local `file:` DB, a self-hosted server).
 */
export function dbRegionFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const m = /(aws-[a-z0-9-]+)\./i.exec(url);
  return m ? m[1].toLowerCase() : null;
}
