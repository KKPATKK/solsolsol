// Use the Web-standard (HTTP/fetch-based) build explicitly: on Cloudflare
// Workers the main entry would resolve to the Node/WebSocket client (tsconfig
// is CommonJS, so wrangler picks the "require" condition), which cannot
// connect there. `@libsql/client/web` ships CJS + ESM variants, so the same
// import works in Node and on Workers. https:// URLs additionally force the
// pure-HTTP transport everywhere.
import { createClient, type Client } from "@libsql/client/web";
import {
  DB_LATENCY_PROBE_COUNT_KEY,
  DB_LATENCY_PROBE_KEY,
  DB_LATENCY_SAMPLES,
  clampLatencySamples,
  type DbLatencyMeasurement,
  type DbLatencyOp,
  type DbLatencyRaw,
} from "./dblatency";

/**
 * The `worker_state` key holding the pushed-token counter — the cached
 * `seen_tokens` row count /health reads instead of a COUNT(*) per ping.
 *
 * Named here because the claim and release paths below now move it INSIDE
 * their own batch, where the increment has to come from SQL itself
 * (`changes()`, see claimTokenPush) rather than from a second awaited call:
 * one key, one place that knows how it moves.
 */
export const SEEN_TOKENS_COUNT_KEY = "telemetry_seen_tokens_count";

/**
 * The other half of the pair above: the cached `token_stats` row count that
 * /health publishes as `tokenStatsCount` (the re-eval pool's coverage). It is
 * moved by `rowsAffected` on every insert (recordTokenStats,
 * recordTokenStatsMany) and by the deleted count on every prune
 * (pruneOldTokenStats).
 *
 * Named HERE (2026-09-30) because Db.reconcileTelemetryCounts writes both rows
 * of the pair by name, and the pair's whole failure mode is one writer
 * forgetting which row its rows belong to: scripts/backfill-pumpfun.mjs
 * inserted token_stats rows without touching this counter, so those rows were
 * never counted while the prune that later removed them still decremented it —
 * a one-time hole (measured: /health 45,517 against the live 52,401) that no
 * later incremental bump can close, because a counter can only add the rows it
 * is told about.
 */
export const TOKEN_STATS_COUNT_KEY = "telemetry_token_stats_count";

/**
 * The two statements that move the counter above, as SQL text.
 *
 * Constants because every caller must run them verbatim: the claim and release
 * paths (claimTokenPush / unclaimTokenPush), removeChat's /debug/chats batch,
 * and the /debug/db-latency probe, whose whole job is to prove that a statement
 * following an INSERT inside a batch sees THAT insert's row count
 * (`changes()`). Inlining any copy would let the probe keep passing while the
 * claim it describes drifted away from it.
 *
 * `changes()` is the delta because a batch cannot branch in TypeScript before
 * it is sent: the row count of the statement just before it — 1 when the
 * INSERT landed, 0 when INSERT OR IGNORE skipped it (see claimTokenPush), and
 * the deleted count when that statement is a DELETE (unclaimTokenPush,
 * removeChat).
 */
const CLAIM_COUNTER_UPSERT_SQL = `INSERT INTO worker_state (key, value) VALUES (?, changes())
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(value AS INTEGER) + changes()`;
const CLAIM_COUNTER_RELEASE_SQL = `INSERT INTO worker_state (key, value) VALUES (?, -changes())
      ON CONFLICT(key) DO UPDATE SET
        value = CAST(value AS INTEGER) - changes()`;

/**
 * Hard timeout for every Turso HTTP request. The database has been
 * intermittently degraded (5s+ round trips, occasional 522s and hangs); a
 * hung request must fail fast and be retried next tick instead of wedging
 * the scan (DB calls have no timeout by default). Healthy round trips are
 * ~100-300ms, so the cap only ever cuts off genuine hangs.
 *
 * 2026-09-12: 15000 → 6000. Dead-tick anatomy (the recurring ~60s rows
 * "died before its completion flush", clustering every ~3rd tick with the
 * pair/pool cache TTL expiry): the tick envelope is pre-race ~1s + 12s
 * scan race, so the completion flush starts at t≈13s with ~10s of wall
 * time before Cloudflare's ~24s invocation kill. A single hung DB call —
 * the flush itself, or a scan-phase call racing a 4s budget whose abort
 * signal never fires — could previously wait out its full 15s timeout and
 * die at t≈28s, AFTER the kill: the flush never landed, the heartbeat
 * froze in phase=scanning, and the next tick backfilled a dead tick. At
 * 6s the abort fires at t≈19s (inside the window), the flush lands by
 * ~19-21s, and the flush's 2.5s racing retry fits too. One lever, three
 * failure shapes fixed.
 *
 * 2026-09-20: 6000 → 2500. The completion flush runs AFTER the scanner's
 * exitScanMode(), i.e. its writes are NOT on the 1.2s scan leash but on this
 * timeout, and its whole wall-clock budget is SCAN_FLUSH_RESERVE_MS (4.5s) of
 * which the first attempt occupies FLUSH_ATTEMPT_BOUND_MS (1.2s) before the
 * racing retry starts. The worker's own retry comment states the constraint —
 * "the hard-wall error arrives only after DB_REQUEST_TIMEOUT_MS*1.2, which
 * alone can outlive the flush window" — but nothing enforced it: at 6s the
 * hard wall is 7.2s, so a stalled flush write could not even FAIL inside the
 * 3.3s the retry races in, which makes a stalled flush a dead tick by
 * construction (the scanner's work, its pushes, all lost from scan_history).
 * 2500 puts the hard wall at 3.0s, inside that 3.3s, so the stalled request
 * now rejects while there is still reserve for the idempotent batch's second
 * attempt to land. 2500 is ~8x the healthy round trip (100-300ms) and ~4x the
 * slowest healthy scan query measured in production (poolMs 145-600ms), so
 * nothing healthy is cut short; the conversion is "guaranteed dead tick" →
 * "retried flush". Pinned by the "flush retry can land" case in
 * scripts/test-unit.js, which fails if either constant drifts out of range.
 *
 * Restore upward (15000 was the pre-2026-09-12 value) only after a stretch
 * with zero dead ticks AND Turso p99 round trips comfortably under 2s.
 */
export const DB_REQUEST_TIMEOUT_MS = 2_500;
/**
 * Tick-scoped cap for the round trips the SCAN makes (see
 * Db.enterScanMode). DB_REQUEST_TIMEOUT_MS is sized for the completion flush
 * and command handlers, which have seconds of wall time of their own; the
 * scan does not. Its ladder gives the eval region ~3.3s of a 4.2s deadline
 * and the worker kills the tick at ~4.85s, so a single un-raced round trip
 * allowed 6s of transport (7.2s to the hard wall) is guaranteed to outlive
 * the WHOLE tick. Live 2026-09-17 08:38:30Z: a tick with a candidate died at
 * 5000ms carrying feedsMs/poolMs/pairs but no evalMs — that field is written
 * after the candidate/push loop, so the death was inside an un-raced round
 * trip, exactly the 1-in-8-tick shape that also dropped candidate pushes
 * (`candidates: 1, pushed: 0` with every `fails` counter at 0).
 *
 * 1.2s is 2x the slowest HEALTHY scan round trip measured in production
 * (poolMs 145-600ms for the biggest query the tick makes), so a healthy tick
 * never notices it, while a stalled call now fails inside the eval window
 * and lets the rest of the ladder run. The hard wall is 1.2x this, so even a
 * stalling libsql retry ladder lands at ~1.44s.
 */
export const SCAN_DB_TIMEOUT_MS = 1_200;
/**
 * Min gap between token_stats prunes. Discovery inflow is ~140 coins/min
 * and only rows older than the 30h re-eval window are removed, so a 10-min
 * lag has zero functional impact while cutting the prune's rows-read by
 * 10x (it used to run every 60s tick — see pruneOldTokenStats). The
 * timestamp is shared via worker_state so concurrent isolates (cron +
 * HTTP fallback) share one cadence.
 */
const TOKEN_STATS_PRUNE_INTERVAL_MS = 10 * 60_000;

/**
 * Min gap between live re-derivations of the two cached table counters (see
 * Db.reconcileTelemetryCounts), and the `worker_state` row holding the stamp.
 *
 * WHY A NET EXISTS AT ALL (measured 2026-09-30): both counters are maintained
 * incrementally, and readTelemetryCounter only self-heals a NEGATIVE value, so
 * any POSITIVE drift is permanent by construction. Production had exactly that:
 * /health `tokenStatsCount` read 45,517 while /debug/pool's live COUNT(*) read
 * 52,401 — a frozen −6,884 across 8 paired samples over 11 minutes, both sides
 * moving 1:1 and a −282 prune hitting both. The cause was one insert path that
 * never bumped (scripts/backfill-pumpfun.mjs, fixed in the same change); the
 * gap itself needs a re-derivation, since no incremental bump can add rows it
 * was never told about.
 *
 * WHY AN HOUR: the reconcile is two full COUNT(*) scans — precisely the cost
 * the counters exist to avoid — so it must be rare, where the incremental bumps
 * are per tick. An hour is also the coarsest unit that still repairs a drift
 * minutes into the shift in which an operator reads the page, and the
 * tick-level counters are unaffected: this is a floor under them, not their
 * source.
 *
 * WHY THE MAINTENANCE PASS: it is the only invocation in the fleet with a
 * clock coarser than the tick (every 5 minutes) and no user waiting on it — the
 * same reason its other legs live there. See Scanner.runMaintenanceJobs.
 */
export const TELEMETRY_RECONCILE_INTERVAL_MS = 60 * 60_000;
/** `worker_state` row: epoch (ms) of the last reconcile above. */
export const TELEMETRY_RECONCILE_AT_KEY = "telemetry_reconcile_at";
/**
 * How far behind the alert clock the RECONSTRUCTED completion stamp of a
 * terminal row sits (see Db.restampTerminalCompletion). One send slice — the
 * same "a card send takes a beat" arithmetic as pushwatch.TRACKER_SEND_CAP_MS.
 * It exists so a repaired row reads as a well-formed drain
 * (`0 < last_checked - last_alert_at <= the 5-minute slack` in
 * pushwatch.terminalRowIssues) instead of delta 0, which IS the
 * lost-completion signature the repair exists to clear.
 */
const TERMINAL_COMPLETION_SEND_MS = 1_000;

export interface ChatSettings {
  chatId: string;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  /** Minimum market cap in USD. */
  minMarketCapUsd: number;
  /** Maximum market cap in USD (coins above are skipped — mid-cap range). */
  maxMarketCapUsd: number;
  /** Minimum token age in minutes. */
  minAgeMinutes: number;
  /** Maximum token age in minutes (coins older than this are skipped). */
  maxAgeMinutes: number;
  /** Minimum 5-minute volume in USD. */
  min5mVolUsd: number;
  /**
   * Minimum 1-hour volume in USD (0 disables). Filters out coins whose
   * whole tape is thin — a $6K 5m spike on a $15K/day coin is noise, not
   * momentum.
   */
  min1hVolUsd: number;
  /** Minimum 5-minute price change in percent (e.g. 18 = +18%). */
  min5mChgPct: number;
  /**
   * Minimum 1-hour price change in percent for the compound momentum gate
   * (a coin qualifies on 5m ≥ min5mChgPct OR 1h ≥ this — catches coins
   * sampled mid-pullback between spikes).
   */
  min1hChgPct: number;
  enabled: boolean;
}

/**
 * Current filter profile: mid-cap coins ($40K–$380K) aged 80m–26h, qualified
 * through either a hot 5m tape ($4.5K + 20%) or a steady 1h tape ($15K +
 * 40%). The first-minute-volume, sniper, bundler and top-10 holder filters
 * were removed (bundler/top-10 data is shown on the card for reference
 * only).
 */
export const DEFAULT_SETTINGS: Omit<ChatSettings, "chatId"> = {
  // $10K floor: DexScreener reporting liquidity ~0 means the LP was pulled or
  // never seeded (soft-rug signature — e.g. CatGPT 2026-08-21 pushed with
  // liquidity.usd = 0 while mcap showed $126K). Set 0 to disable the gate.
  minLiquidityUsd: 10000,
  minVolume24hUsd: 0,
  minMarketCapUsd: 40000,
  maxMarketCapUsd: 380000,
  minAgeMinutes: 80,
  maxAgeMinutes: 1560, // 26h
  min5mVolUsd: 4500,
  min1hVolUsd: 15000,
  min5mChgPct: 20,
  min1hChgPct: 40,
  enabled: false,
};

/**
 * Re-eval pool hot zone (see Db.getReevalPool): coins whose launch is within
 * [window entry − POOL_HOT_BELOW_MS, entry + POOL_HOT_ABOVE_MS] — about to
 * qualify or freshly qualified — are evaluated EVERY scan. This is the
 * push-latency-critical cohort: a coin that crosses the gates right after
 * entering the window should be pushed within a minute, not whenever its
 * rotation slot next comes up. The above-entry side is 30 min (was 1h, 2h
 * before that): a coin that fails a gate at entry almost never flips within
 * hours, so a wide warm side mostly burns rows-read (the hot band is
 * read+sorted every scan, and it is the pool query's dominant Turso rows-read
 * consumer). It is not free to remove, though — the warm side is what writes a
 * coin's max_mcap_observed BEFORE it can qualify, the high-water mark the
 * whole rotation ranks and prunes on.
 *
 * 2026-09-29 (measured, then fixed): the band and its LIMIT had drifted apart.
 * The rotation audit read the live band at 607 rows against a 300-row
 * POOL_HOT_MAX, so the nearest-entry-first LIMIT reached only ages 61–99min
 * and CLIPPED 82 of the 268 ELIGIBLE rows (ages 99–110min) on every scan —
 * the "hot zone is evaluated every scan" guarantee was false for 31% of the
 * cohort it exists for. The band is now sized to fit UNDER its LIMIT: 30 min
 * of warm side (437 rows measured) under a 460-row budget, so nothing is
 * clipped. 460 + the unchanged near/far rotation budget (740) is why
 * RE_EVAL_POOL_SIZE is 1200 (was 1000, see src/config.ts). Sizing the warm
 * side down rather than the budget up is deliberate — the same measurement
 * prices the warm side at rows-read per row that cannot qualify at that age,
 * which is why it went 2h → 1h before. RE-MEASURE before moving either number:
 * a band that outgrows its LIMIT again silently stops reading its OLDEST
 * eligible tier, which is the one closest to the near sweep.
 */
const POOL_HOT_BELOW_MS = 0.5 * 3600_000;
const POOL_HOT_ABOVE_MS = 0.5 * 3600_000;
/** Max hot-zone coins per scan; the rest of the pool limit goes to rotation. */
const POOL_HOT_MAX = 460;
/**
 * Graduated rotation (2026-08-16 redesign, replaces the uniform-slot sweep):
 * the rotation zone — everything older than the hot zone — is split into TWO
 * tiers with different sweep cadences, because qualification probability
 * decays steeply with age:
 *
 *   NEAR zone: [window entry, entry + POOL_NEAR_WINDOW_MS] of age. Coins that
 *     just entered the window are the most likely to cross the mcap/volume
 *     gates, so their slots are swept frequently (POOL_NEAR_SLOTS × the 5-min
 *     pool cache = 10-min full sweep by default).
 *   FAR zone: the rest of the window (entry+6h → maxAge). Qualification is
 *     rare this deep in, so it is swept slowly (POOL_FAR_SLOTS × 5 min =
 *     30-min full sweep by default) — every coin is still re-checked at
 *     least once per sweep, but the old tail stops consuming most of the
 *     budget.
 *
 * The old uniform rotation (REEVAL_ROTATION_MINUTES → N equal slots over the
 * whole zone) gave every coin the same 30-min re-check cadence regardless of
 * how likely it was to qualify, and in dense bands the per-slot LIMIT
 * (ordered by distance to the slot center) systematically dropped edge coins
 * — starvation was reduced but not eliminated. The tiered version
 * concentrates the budget where qualification actually happens, and the
 * rotation bands order by qualification signal (max_mcap_observed) so the
 * LIMIT always picks the most promising coins.
 */
const POOL_NEAR_WINDOW_MS = 6 * 3600_000;
/** Near-zone slot count (10-min full sweep at the default pool cache). */
const POOL_NEAR_SLOTS = 2;
/** Far-zone slot count (30-min full sweep at the default pool cache). */
const POOL_FAR_SLOTS = 6;
/** Share of the rotation budget given to the near zone (rest → far zone). */
const POOL_NEAR_LIMIT_SHARE = 0.7;
/**
 * Buckets a near/far band's overflow rotates through (see poolBandOrder).
 *
 * WHY: a rotation band is read in signal order (max_mcap_observed, then
 * first_m5_vol) and capped at its per-slot LIMIT, so a sub-window holding more
 * rows than its LIMIT is truncated to the same signal-ordered head on every
 * visit — the rest is never read, "however often its slot comes around" (the
 * 2026-09-15 sizing note in wrangler.toml). Resizing the slots fixed that once;
 * by 2026-09-29 growth had undone it, and the overflow had collapsed into a
 * single TIE GROUP: the live worst far sub-window held 400 rows against a
 * 210-row LIMIT, of which 256 shared the identical key (no peak, zero
 * first_m5_vol) and only 66 of that group fitted — 190 rows readable only if
 * something rotated the choice. Those rows carry no signal to lose, so a tie
 * break appended AFTER both signal keys cannot demote a row that has signal:
 * it only decides WHICH of the indistinguishable rows the LIMIT takes, and
 * advances that choice once per recurrence of the band. Measured on that
 * sub-window: K=8 serves 76.8% of the band over 8 recurrences (2.4h) where the
 * fixed ordering serves the same 52.5% forever; K=16 reaches 100% over 16.
 * The key is the token's last character (base58 ⇒ evenly spread), which keeps
 * the rotation deterministic and cacheable — unlike RANDOM().
 */
const POOL_BAND_ROTATE_BUCKETS = 8;

/**
 * The ORDER BY a re-eval band is read with, shared by Db.getReevalPool and
 * Db.getReevalPoolBatched so the two band splits cannot drift (the batched copy
 * builds its own SQL, and a unit test pins the two to the same tokens in the
 * same order).
 *
 * `rotate: true` means the caller must bind the band's rotation phase as the
 * next argument after the seen-clause args and BEFORE `center`/`LIMIT` — the
 * fragment carries exactly one `?`.
 */
function poolBandOrder(orderBy: "entry" | "signal"): {
  sql: string;
  rotate: boolean;
} {
  if (orderBy === "entry") {
    return { sql: "ORDER BY ABS(launch_ms - ?)", rotate: false };
  }
  return {
    sql:
      "ORDER BY COALESCE(max_mcap_observed, 0) DESC, " +
      "COALESCE(first_m5_vol, 0) DESC, " +
      `((UNICODE(SUBSTR(token, -1)) + ?) % ${POOL_BAND_ROTATE_BUCKETS})`,
    rotate: true,
  };
}
/**
 * Rotation cadence default — must match the caller's pool cache TTL so
 * every cache expiry moves to the next slot instead of re-serving the same
 * slice. The scanner passes its configured TTL (REEVAL_POOL_CACHE_SECONDS,
 * default 180s) as rotationPeriodMs; this constant is the db-side default
 * (300s) used when no period is given (tests, /debug/pool fallback).
 */
const POOL_ROTATION_PERIOD_MS = 300_000;

/**
 * Liquidity below which a pool counts as dead for the re-eval pool query
 * (2026-09-19).
 *
 * WHY A RECENCY PRUNE WAS NEEDED: the pool's liquidity filter read
 * `max_liquidity_observed`, a lifetime high-water that only ever rises, so a
 * coin that HAD a pool and lost it passed the prune forever — it was swept,
 * pair-fetched and rejected at the gate on every rotation while live coins
 * shared the slice with it. Live 2026-09-19: the reject log was ~98% liquidity
 * failures (48 of 49, 48 of 50), ~72% of them `流动性 —` (liquidity 0/null),
 * `fails.other 72` against `mcap 8 / chg 4 / age 1`, `agedEval 4` of ~91
 * evaluated coins — and DexScreener showed exactly the escape: `wildebeest`
 * peaked at $242,572 liquidity and now reads 0, `CASH` 43,735 → 2,323,
 * `upcoin` 25,953 → 3,586 (3 of 11 sampled coins), all still passing the 6K
 * prune built on their own high-water.
 *
 * WHY THIS THRESHOLD: the floor is deliberately far below the narrowest chat
 * gate ($10K) — the point is to drop pools that are GONE (0, or a few hundred
 * dollars of dust), not to second-guess coins that still hold a real LP and
 * could grow into the gate. A coin whose recent reading is only recorded ONCE
 * and is below this floor is excluded until its discovery feed finds it again
 * (the same permanent-exclusion trade-off the mcap and peak-liquidity prunes
 * already make). NULL still passes: a row nobody has measured since this column
 * existed keeps the old, high-water-only behavior.
 */
const DEAD_LIQUIDITY_USD = 1_000;

/**
 * How many consecutive pool sweeps may come back with NO reading at all before
 * a stored reading stops vouching for a coin (2026-10-08).
 *
 * WHY A FRESHNESS MARK WAS NEEDED: the floor above only judges a coin the
 * scan can still SEE. A coin whose pair vanishes entirely — the pool closed,
 * the mint drained out of DexScreener's answer, no venue left to read — comes
 * back from the pair fetch with nothing, so `last_liquidity_usd` is never
 * overwritten and the last reading it DID get (≥ $1K, above the floor) keeps
 * the corpse in every rotation forever: rows-read, a pair-fetch slot and a
 * reject per sweep, for a coin that can no longer qualify. The other prunes
 * cannot answer this either — `max_mcap_observed` / `max_liquidity_observed`
 * are lifetime high-water marks by construction.
 *
 * WHY SWEEPS AND NOT A WALL-CLOCK TTL: the mark counts sweeps that came back
 * EMPTY, so it advances only when the pool actually asked AND the transport
 * answered for everything else (see scanner.poolSweepMisses). A stalled scan —
 * cron outage, degraded database — advances nothing, so a quiet period can
 * never mass-evict live coins; a wall-clock bound would instead have to guess
 * an interval longer than the worst rotation recurrence and would still age
 * out every coin that window failed to reach. Sweeps are also the unit the
 * pool is denominated in: the rotation, not the clock, decides how often a
 * coin is looked at.
 *
 * WHY THREE: the healthy-batch guard means one bad batch (a 429 window, the
 * deadline cutting the tail) can never mark anything. What is left is a
 * COIN-LEVEL absence — three consecutive sweeps of the same coin, each a full
 * rotation apart (~13 minutes at the 90-coin slice against a 1,200-coin
 * pool), came back with no pair at all. A live coin the pair lane can serve
 * does not do that; a closed pool does nothing else.
 *
 * WHY A MARK INSTEAD OF A DELETE: the row carries every other prune's input
 * (launch_ms window, mcap high-water, first-seen age). Deleting it would
 * re-register the mint as a fresh discovery — resetting firstSeenAt, which is
 * the age gate's own basis. The mark is a column, the eviction is the pool
 * query's predicate, and a discovery feed that finds the coin again clears it
 * on the first fresh reading (the same "excluded until the feed finds it
 * again" trade-off the mcap and liquidity prunes already make).
 */
export const DEAD_POOL_MISS_MAX = 3;

/**
 * The freshness mark's SQL half, built from the two constants above so the
 * predicate, the histogram's counting and the offline instruments cannot
 * drift. Three-valued logic is load-bearing: a NULL `last_liquidity_usd`
 * (nobody has measured this row since the column existed) makes the mark
 * NULL, and every reader below reads that as ALIVE — the fail-open discipline
 * the rest of the prunes follow.
 */
const DEAD_POOL_MARK =
  `(last_liquidity_usd IS NOT NULL AND ` +
  `(last_liquidity_usd < ${DEAD_LIQUIDITY_USD} OR sweeps_since_reading >= ${DEAD_POOL_MISS_MAX}))`;

/**
 * The pool pre-filter that a recent reading AND its freshness drive (see
 * DEAD_LIQUIDITY_USD / DEAD_POOL_MISS_MAX). Constant-only, so it needs no
 * bound argument in either query builder — and both MUST carry it, or the
 * batched path would re-admit the corpses the per-band path drops (the same
 * drift the pair of builders is tested for).
 */
const DEAD_POOL_CLAUSE = `(last_liquidity_usd IS NULL OR NOT (${DEAD_POOL_MARK}))`;

/**
 * How long a row may sit in the pool with NO mcap evidence at all before the
 * pool stops carrying it (2026-10-09).
 *
 * WHAT COUNTS AS EVIDENCE: a non-NULL `max_mcap_observed`. The scanner's
 * raise loop records that column from every served pair leg — DexScreener,
 * Jupiter, Gecko — but ONLY on a positive reading (`marketCap <= 0` records
 * nothing). NULL therefore means "every time this coin was actually looked
 * at, its mcap read non-positive": the coin has never been observed alive.
 * Measured live 2026-10-09: 10,394 rows in the pool's 30h window (14% of
 * 72,304) had no mcap reading — every one of them also had no DexScreener
 * liquidity reading at all — and 531 of one sweep's 966 returned rows (55%)
 * were that population: pairs the gates can only reject, each paying a
 * pair-fetch slot and its rows-read.
 *
 * WHY THE POOL AND NOT A GATE: the mcap floor prune already drops coins whose
 * KNOWN peak is hopeless; NULL is deliberately exempt (fail-open: an
 * unmeasured coin is never pruned on a guess). That exemption is right while
 * the coin could still be measured, and wrong forever after: a coin nobody has
 * ever measured will never be measured into a push — no positive reading
 * means no qualification — so every later sweep is paid for a row that CANNOT
 * answer differently.
 *
 * WHY A WALL CLOCK AND NOT A SWEEP MARK (unlike DEAD_POOL_MISS_MAX): that
 * mark counts MISSING readings and needs the healthy-batch guard so a dead
 * transport cannot evict live coins. Here nothing is evicted for a missing
 * reading — the eviction reads a column that only served, non-positive
 * readings could ever have set, and the transport's health is already baked
 * into whether those readings happened at all. The grace exists only so a coin
 * the pair lane has not REACHED yet is not mistaken for one it has repeatedly
 * judged: the worst rotation recurrence measured on this pool is 8 far-band
 * recurrences (≈2.4h, docs/round-trips.md §4.48), and this bound is 2.5x that
 * worst case.
 *
 * WHY SIX HOURS: 3h would sit barely above the measured worst-case coverage
 * (1.25x — no room for a 429 window or a sweep's tail cut by the deadline) and
 * 12h leaves half the population seated (5,552 of 10,394 in-window rows) for
 * no extra signal; 6h cuts 8,124 of the 10,394 (78%) while every coin the
 * pool was still plausibly going to measure keeps its seat.
 *
 * WHAT IT COSTS, AND WHY THAT IS THE ACCEPTED SIDE: a row evicted here is out
 * of the sweep pool until a discovery feed finds the coin again — the feed's
 * own evaluation still reads it every tick, and the first positive mcap any
 * leg records clears the clause (it reads the column, not a one-way mark).
 * That is the trade every other prune in this file already makes: the pool
 * spends its rows on coins that can still qualify, and the grace is what keeps
 * the trade off the fresh tail — a coin first seen inside the window is never
 * judged on evidence nobody had time to collect.
 */
export const POOL_MCAP_EVIDENCE_GRACE_MS = 6 * 3600_000;

/**
 * The no-evidence pre-filter's SQL half. A BOUND argument — the cutoff moves
 * with the tick's clock — and both builders MUST carry it with the cutoff
 * bound right after `first_seen_at`, or the batched path would re-admit the
 * rows the per-band path drops (the same drift DEAD_POOL_CLAUSE's note warns
 * about).
 */
const POOL_MCAP_EVIDENCE_CLAUSE = `(max_mcap_observed IS NOT NULL OR first_seen_at > ?)`;

/**
 * The market-cap floor's SQL half, as a LITERAL — and why it has to be one.
 *
 * 2026-10-07 (measured): a sweep billed ~18.5k rows to return 1.2k, because
 * `max_mcap_observed >= ?` can only be applied AFTER the launch_ms index range
 * has been walked — ~86% of every band's candidates are rows whose known peak
 * is under the floor. A PARTIAL index is the only access path that skips them,
 * and SQLite matches one only when the query's predicate is the SAME
 * expression: a bound parameter matches a pinned constant only while the
 * planner sees that same value, the literal always does (and a DIFFERENT value
 * falls back to the full walk rather than answering from a stale index —
 * verified locally and on prod). So this ONE helper renders the floor (both
 * callers and the index DDL), and the two cannot drift. A stale index — one pinned to a floor the caller no longer passes —
 * is never chosen, because the implication cannot be proven, so a changed gate
 * costs the old full walk and never a wrong answer.
 */
export function mcapFloorLiteral(minQualifyMcap: number): string {
  return String(minQualifyMcap);
}

/** The index NAME for a floor: identifiers cannot carry the decimal point. */
export function poolBandIndexName(minQualifyMcap: number): string {
  return `idx_pool_band_m${mcapFloorLiteral(minQualifyMcap).replace(".", "_")}`;
}

/** Opening stats captured the first time the scanner ever saw a token. */
export interface TokenStats {
  token: string;
  firstSeenAt: number;
  /** m5 volume at first observation — approximates the opening volume. */
  firstM5Vol: number;
  /** Token age in minutes at first observation. */
  firstSeenAgeMin: number;
  /**
   * Estimated launch time (epoch ms) = firstSeenAt - firstSeenAgeMin*60s.
   * Stored + indexed so the re-eval pool query runs as a narrow range scan
   * instead of evaluating the computed expression across every token_stats
   * row (~400K — the dominant Turso rows-read consumer, alerted 2026-08-16).
   */
  launchMs: number;
  /** Exact first-minute volume from Birdeye (null = not measured yet). */
  birdeye1mVol: number | null;
  /** Bundler/insider supply share in percent from RugCheck (null = unknown). */
  rugcheckBundlerPct: number | null;
  /** Top-10 holder concentration in percent from RugCheck (null = unknown). */
  rugcheckTop10Pct: number | null;
  /**
   * Count of wallets Birdeye tags as smart_trader among the top traders
   * (excluding bundler/dev-tagged wallets), null = unknown.
   */
  birdeyeProTraders: number | null;
  /** Sniper buy share of supply in percent from Birdeye (null = unknown). */
  birdeyeSniperPct: number | null;
  /**
   * Holder count from Birdeye's token_overview and when it was READ (epoch
   * ms). §4.15/§4.16 added these as a SHARED cache: both buyers of a coin's
   * reading — the card path's enrich batch and the tracker's holder probe —
   * wrote it here and a reader reused one inside BIRDEYE_HOLDER_CACHE_MIN.
   *
   * §4.17 (2026-09-25) retired both ends: the card's holders line is gone (its
   * number already rides the free Axiom summary), so nothing buys or reads
   * this cache any more. The columns stay declared — a stale row must not turn
   * into a schema question — and the tracker keeps its own per-row reading in
   * `push_watch` (holders_at_push / holders_last). Null = never read;
   * `holderCountAt` 0/null means the same thing as `holderCount` null.
   */
  holderCount?: number | null;
  holderCountAt?: number | null;
  /** Lowest market cap since listing (USD), null = unknown. */
  minMcapObserved: number | null;
  /**
   * Highest market cap ever observed by the scanner (pool pre-filter and
   * rotation-band ordering signal — see Db.getReevalPool). Null for rows
   * written before the v3 migration or never seen with pair data.
   */
  maxMcapObserved?: number | null;
  /**
   * Highest pooled liquidity (USD) ever observed by the scanner. The pool
   * pre-filters on it: coins whose peak liquidity never reached the
   * qualifying floor are dead corpses (a real mid-cap coin always holds
   * $10K+ LP) — without this prune their huge max_mcap_observed ranked
   * them FIRST in every rotation band under the signal ordering and they
   * permanently occupied the per-band LIMITs (2026-09-10 audit: ~215 of
   * ~330 coins evaluated per tick failed the liquidity gate). Null = never
   * seen with pair data → kept.
   */
  maxLiquidityObserved?: number | null;
  /** Cached supply-flow detector result (JSON of SupplyFlowResult), null = not analyzed. */
  supplyFlowJson: string | null;
  /** When the cached supply-flow result was produced (epoch ms). */
  supplyFlowAt: number | null;
  /**
   * Which discovery feed first registered this coin ("dex" | "pump" |
   * "gecko" | "geoTrend" | "gmgn" | "axiom" | "jup" | "jupTrend") —
   * enables per-feed quality attribution. Null for legacy rows.
   */
  discoveredVia?: string | null;
}

/**
 * Thin wrapper around the Turso (libSQL) client.
 *
/**
 * 2026-09-13 (dead-tick fix): hard wall around a libsql client's
 * execute()/batch(). The HTTP client retries internally when its transport
 * fetch aborts (our DB_REQUEST_TIMEOUT_MS signal), so a request's promise
 * can outlive the signal 2-3x — the "hanging write" shape that killed
 * completion flushes and produced the recurring 60-93s dead ticks. The
 * wall races every call against a timer 1.2x `timeoutMs` (DB_REQUEST_TIMEOUT_MS
 * by default, SCAN_DB_TIMEOUT_MS for a tick — see Db.enterScanMode): if the
 * client is still grinding through its retry ladder at that point, the
 * CALLER gets a hard error instead of an eternity. The late-settling
 * libsql promise is dropped (the race keeps its handlers attached, so a
 * retry that eventually commits simply has no reader; every caller is
 * idempotent by design — the flush deletes its own row before inserting).
 * Exported so unit tests can verify the wall with mock clients.
 */
export function wrapClientWithHardWall<T extends object>(
  client: T,
  /** Transport budget this wrapper's wall is derived from (1.2x). */
  timeoutMs: number = DB_REQUEST_TIMEOUT_MS,
  /**
   * Called with the ms the CALLER actually waited for each call — wall time
   * included, because a stalled call is exactly the cost this measures (see
   * Db.enterScanMode).
   */
  onCost?: (ms: number) => void,
): T {
  return new Proxy(client, {
    get(target, prop) {
      if (prop !== "execute" && prop !== "batch") {
        return Reflect.get(target, prop);
      }
      return (...args: unknown[]) => {
        const t0 = Date.now();
        const op = (
          Reflect.get(target, prop) as (...a: unknown[]) => Promise<unknown>
        ).apply(target, args);
        const raced = Promise.race([
          op,
          new Promise<never>((_, reject) => {
            const t = setTimeout(
              () =>
                reject(
                  new Error(
                    `db ${String(prop)} hit the ${Math.round(
                      timeoutMs * 1.2,
                    )}ms hard wall — libsql retry loop never settled`,
                  ),
                ),
              timeoutMs * 1.2,
            );
            // Release the timer as soon as the operation settles so a
            // busy isolate never holds thousands of live timers.
            op.finally(() => clearTimeout(t)).catch(() => {});
          }),
        ]);
        if (onCost) {
          raced.finally(() => onCost(Date.now() - t0)).catch(() => {});
        }
        return raced;
      };
    },
  });
}

/**
 * seen_tokens uses a composite primary key (chat_id, token) so a coin is
 * pushed at most once per chat, while the same coin may still qualify for
 * different chats with different filters.
 */
/**
 * The columns a tracker check writes (see updatePushWatchCheck and
 * claimPushWatchCheck below). ONE shape for both writers: a silent row and an
 * alerting row must persist exactly the same fields, or a row's recorded state
 * would depend on whether it happened to fire a card.
 */
interface PushWatchCheckValues {
  peakMcap: number;
  lastLiquidity: number | null;
  lastVol5m?: number | null;
  /** Dead-state low (lower low while silent-watching; null = keep). */
  deadTroughMcap?: number | null;
  followupsSent?: number;
  lastState?: string | null;
  lastAlertAt?: number;
  /** Resurrection: reset the push-time mcap baseline to this value. */
  mcapAtPush?: number;
  /** 📈 alert fired: roll the holders baseline forward to this value. */
  holdersAtPush?: number;
  /** CSV of 🚀 stages already announced (undefined = keep; '' = clear). */
  upStages?: string | null;
  /**
   * 🟢 revivals announced since the last 🚀 runup card — the 💪 strong-buy
   * rule's memory (see pushwatch.STRONG_BUY_REVIVES). A NUMBER here always
   * lands (0 included: the two rules that consume the pattern both reset it);
   * undefined = leave the column alone, which is what every writer that does
   * not run the rule engine (and every early return) passes.
   */
  revivesSinceUp?: number;
  /** New 🧨 sell-pressure streak count (persisted as-is). */
  sellDomStreak?: number;
  /** Latest observed mcap (🏁 recap final value). */
  lastMcap?: number;
  /**
   * Pin-on-first-sight / the mark of the pool being judged (see the
   * pool-pinning note in src/pushwatch.ts). Written only into a NULL column:
   * a legacy row is pinned to the pool its first successful check actually
   * read, and a pinned row's value is never overwritten by a check write. A
   * CONFIRMED switch is rewritten only by Db.repinPushWatchPools, which is a
   * compare-and-swap on the old pin.
   */
  poolAddress?: string | null;
}

/**
 * Hard cap on the cron-tick ring kept in worker_state (`scheduled_tick_ring`):
 * 90 entries ≈ 90 minutes of delivery history, which is what tells "cron did
 * not deliver" apart from "the tick died before its completion flush" after
 * the fact.
 */
export const SCHEDULED_TICK_RING_MAX = 90;

/**
 * Parse the cron-tick ring (see SCHEDULED_TICK_RING_MAX / bumpScheduledTick).
 * Corrupted or non-numeric entries are dropped rather than thrown: the ring is
 * a diagnostic and must never cost a tick.
 */
export function parseScheduledTickRing(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is number => typeof v === "number");
  } catch {
    return [];
  }
}

/**
 * WHICH invocation ran a scan (2026-09-27, measured live): the cron tick and
 * the HTTP fallback both write scan_history rows with nothing to tell them
 * apart, and the fallback turned out to drive 26 of 76 completions (34%) in a
 * 90-minute window — so "cron stopped delivering" could not be read off the
 * history at all. The tag travels as a PARAMETER from the handler (never
 * module state: the pass's own delivery shares the isolate and overwrites
 * module-scope readings — a tick's done heartbeat published
 * `subreqs.current.owner:"pass"` on 2026-09-27), lands in the heartbeat's
 * `via`, and is counted durably by the statements below.
 */
export type ScanTrigger = "cron" | "http" | "manual" | "clock";

/** The durable counter row per trigger (see scanTriggerStatements). */
export const SCAN_TRIGGER_COUNTER_KEYS: Record<ScanTrigger, string> = {
  cron: "scan_trigger_cron",
  http: "scan_trigger_http",
  manual: "scan_trigger_manual",
  // The sub-minute clock's own row (2026-10-02, worker.TickClock): a scan the
  // DO relayed is not a cron arrival and not an HTTP rescue, and folding it
  // into `cron` would make the ONE reading these counters exist for — "how
  // much of the scanning is actually cron" — read wrong by exactly the share
  // the clock drives.
  clock: "scan_trigger_clock",
};

/** The counters as a key list, for the front read that publishes them. */
export const SCAN_TRIGGER_STATE_KEYS: readonly string[] = [
  SCAN_TRIGGER_COUNTER_KEYS.cron,
  SCAN_TRIGGER_COUNTER_KEYS.http,
  SCAN_TRIGGER_COUNTER_KEYS.manual,
  SCAN_TRIGGER_COUNTER_KEYS.clock,
];

/** The fleet-wide per-trigger scan counts (see parseScanTriggerCounts). */
export interface ScanTriggerCounts {
  cron: number;
  http: number;
  manual: number;
  clock: number;
}

/**
 * The completion timestamp of the last COUNTED scan (see
 * scanTriggerStatements): the idempotence key for a retried flush, and a
 * reading of its own — it is the `at` of the newest scan_history row the
 * counters account for.
 */
export const SCAN_TRIGGER_GUARD_KEY = "scan_trigger_last_at";

/**
 * Increment one trigger's counter as READ-FREE statements, on the same
 * discipline as scheduledTickStatements: they ride the completion batch the
 * tick already pays for (see persistScanCompletion), so attribution costs
 * ZERO extra round trips — and the row is durable, so it survives the isolate
 * that produced it.
 *
 * IDEMPOTENT UNDER THE FLUSH RETRY, which is the reason for `at`: the retry
 * re-sends the SAME batch (a first attempt that committed but lost its response
 * must not count the scan twice), and the other statements in that batch are
 * idempotent for the same reason (upsert heartbeat, delete-then-insert history).
 * The increment is therefore gated on the completion's own `at` and the guard
 * row is written after it, in the same transaction.
 */
export function scanTriggerStatements(
  via: ScanTrigger,
  at: number,
): Array<{ sql: string; args: Array<string | number | null> }> {
  const key = SCAN_TRIGGER_COUNTER_KEYS[via];
  return [
    {
      // The row must exist before the UPDATE can increment it.
      sql: `INSERT OR IGNORE INTO worker_state (key, value) VALUES ('${key}', '0')`,
      args: [],
    },
    {
      // NULL guard (first ever completion) IS NOT the stamp -> counts; the
      // same stamp again (the retry) -> no-op.
      sql: `UPDATE worker_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
             WHERE key = '${key}'
               AND (SELECT value FROM worker_state WHERE key = '${SCAN_TRIGGER_GUARD_KEY}') IS NOT ?`,
      args: [String(at)],
    },
    {
      sql: `INSERT INTO worker_state (key, value) VALUES ('${SCAN_TRIGGER_GUARD_KEY}', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [String(at)],
    },
  ];
}

/**
 * The counters out of a worker_state map (see SCAN_TRIGGER_STATE_KEYS). A
 * missing, unparseable or negative value reads as 0 — telemetry must never
 * make a caller throw (same discipline as parseScheduledTickRing).
 */
export function parseScanTriggerCounts(
  states: Map<string, string> | null | undefined,
): ScanTriggerCounts {
  const read = (key: string): number => {
    const raw = states?.get(key) ?? null;
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  };
  return {
    cron: read(SCAN_TRIGGER_COUNTER_KEYS.cron),
    http: read(SCAN_TRIGGER_COUNTER_KEYS.http),
    manual: read(SCAN_TRIGGER_COUNTER_KEYS.manual),
    clock: read(SCAN_TRIGGER_COUNTER_KEYS.clock),
  };
}

/**
 * The cron-arrival bookkeeping that can ride a tick's claim batch (see
 * Db.scheduledTickStatements): the cron event time plus the ring to store.
 */
export interface ScheduledTickEntry {
  /** Cron event time (epoch ms) — `scheduled_tick_at` and the ring's tail. */
  at: number;
  /** The ring to store (the caller appends and caps, see the parser above). */
  ring: number[];
}

/**
 * Validate a raw `trade_mode_override` row value — the ONE rule, shared by
 * every reader of that row: Db.getTradeModeOverride (the single-row read),
 * /health (which gets the row out of its own batch) and TradeService's
 * primed cache (round 4, docs/round-trips.md §4.25).
 *
 * Anything else — a junk value from a hand edit, an empty row, a row that
 * was never written — is null, i.e. "no override, use the env config".
 * Collapsing "could not read" into this null is why the batch readers must
 * only call it when their read LANDED (see worker.ts's frontModeOverrideRead
 * and the /health handler's `modeLanded`).
 */
export function parseTradeModeOverride(
  raw: string | null | undefined,
): "off" | "manual" | "auto" | null {
  return raw === "off" || raw === "manual" || raw === "auto" ? raw : null;
}

/**
 * The scan front's ONE read (2026-09-25, docs/round-trips.md §4.13): the
 * `worker_state` rows the front's maintenance legs gate on, plus the enabled
 * chats — one libsql `batch`, so the row set is exactly what it was and only the
 * round trips are gone.
 *
 * Before this every leg paid its own single-row lookup on EVERY tick:
 *
 *   - the enabled-chats listing (the scan's first read);
 *   - the launch_ms migration's completion flag (Db.resumeLaunchBackfill);
 *   - the token_stats prune's interval stamp (Db.pruneOldTokenStats);
 *   - the Birdeye new-listing backfill's interval stamp
 *     (Scanner.runPeriodicBackfill).
 *
 * Four subrequests out of the invocation's 50, for one `worker_state` lookup
 * with a chat row beside it — the same shape the tick tail already pays
 * (Db.readPostScanTelemetry, §4.12). The writing half is Db.writeScanFront.
 *
 * A key that is ABSENT from `gates` is a row that was never written, which is a
 * different reading from "not read at all": a caller that passes a front must
 * treat a missing key as null and must NOT re-read (see Db.gateOf).
 */
export interface ScanFront {
  /** `worker_state` rows by key, as of this read (absent = never written). */
  gates: Map<string, string>;
  /** Same projection and ordering as listEnabledChats. */
  chats: ChatSettings[];
  /** Bookkeeping the front's legs queue for its ONE write (Db.writeScanFront). */
  writes: ScanFrontWrite[];
}

/** One queued front bookkeeping row (see Db.writeScanFront). */
export interface ScanFrontWrite {
  key: string;
  value: string;
  /**
   * ADD the value to the row's INTEGER cast instead of replacing it — the
   * telemetry-counter shape (Db.bumpTelemetryCounter). The SQL is that
   * method's, verbatim.
   */
  add?: boolean;
}

/**
 * A telemetry counter row as a number: the integer it holds, or null when the
 * row is absent or not integer-shaped.
 *
 * A NEGATIVE value is returned as it is, on purpose: it is the drifted state
 * readTelemetryCounter self-heals (observed telemetry_token_stats_count =
 * -3105, where the incremental bumps had drifted past zero), and folding it
 * into the same null an absent row returns would erase the only signal that a
 * heal is due.
 *
 * Exported and pure because the judgement has TWO callers: the single-row
 * read inside Db and /health's batched front (Db.readHealthFront), which
 * receives the row for free and must not re-invent the rule.
 */
export function parseTelemetryCounter(
  raw: string | null | undefined,
): number | null {
  if (raw === null || raw === undefined) return null;
  return /^-?\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * Whether a counter read may be SERVED, or has to be re-derived from the live
 * COUNT(*) instead: absent and negative are both "re-derive" (see
 * parseTelemetryCounter for why negative is kept rather than discarded).
 */
export function telemetryCounterUsable(value: number | null): value is number {
  return value !== null && value >= 0;
}

/**
 * The durable home of the client's last-good profile list (see
 * ProfileFeedSnapshot in src/dexscreener.ts).
 *
 * It rides the front READ because the seed has to be in the client before the
 * feed fan-out decides what to evaluate, and it rides the front WRITE because
 * the journal must not cost a request of its own — the same discipline the
 * list-cache ledger follows one row over. REPLACED, never ADDed: the row is a
 * snapshot (a stamp plus the tokens), not a counter, and the scanner only
 * writes it when this tick's list is newer than the one it seeded from (see
 * Scanner.stampProfileFeedSnapshot).
 */
export const DEX_PROFILES_LAST_KEY = "dex_profiles_last";

/**
 * The front's gate keys, in one place so the read and the legs cannot drift:
 * the launch_ms migration flag, the token_stats prune stamp, the Birdeye
 * backfill stamp and the last-good profile list (see DEX_PROFILES_LAST_KEY —
 * read, not gated on). Every one of them is a row the front's own work needs
 * once per tick, read in ONE statement.
 */
/**
 * worker_state row: the epoch (ms) of the launch slot's last GeckoTerminal
 * new-pools FETCH ATTEMPT (see Scanner's launch-slot chain + geckoDiscoveryDue).
 *
 * WHY DURABLE AND NOT module state: the gecko leg is now quota-bound rather
 * than rate-bound (a CoinGecko key moves the limiter off the shared egress IP
 * onto the key — 10K calls/month on the demo plan), so the thing worth
 * enforcing is "at most one origin fetch per GECKOTERMINAL_DISCOVERY_INTERVAL"
 * across the WHOLE fleet. This Worker's isolates churn every ~30s, so a
 * per-isolate timestamp would reset long before the window elapsed and spend
 * the key's quota at the tick rate. The row rides the front's ONE read and ONE
 * write (SCAN_FRONT_GATE_KEYS below), so the gate costs zero extra round trips.
 */
export const GECKO_DISCOVERY_AT_KEY = "gecko_discovery_at";

/**
 * The DexScreener BOOSTS lane's cadence stamp (see Scanner.boostsDiscoveryDue +
 * DEXSCREENER_BOOSTS_INTERVAL_SECONDS in src/config.ts).
 *
 * SAME SHAPE, SAME REASON as GECKO_DISCOVERY_AT_KEY above, and the reason is
 * the HOST rather than a key: /token-boosts/latest/v1 lives on
 * api.dexscreener.com, whose limiter is charged per SOURCE IP — an address this
 * Worker shares with the whole fleet, so `pairCacheRefused` and
 * `listCacheRefused` climb no matter how carefully this client spaces its own
 * calls (measured 2026-09-25, docs/profiles-feed-zeros.md). At one request per
 * tick the boosts lane is HALF of this Worker's calls to that host for a lane
 * whose lifetime yield is a few dozen coins and a handful of cards
 * (`/debug/feed-stats` boosts), so the cadence is the honest trade: a boosted
 * mint is only judged once it ages into the qualifying window, which makes
 * registering it minutes late free — exactly the arithmetic that let gecko's
 * keyed leg drop to one fetch per 5 minutes.
 *
 * DURABLE for the gecko row's reason: isolates churn every ~30s, so a
 * per-isolate stamp would reset long before the window elapsed and the gate
 * would never hold. The row rides SCAN_FRONT_GATE_KEYS' existing IN-list, so
 * the question costs zero extra round trips.
 */
export const DEX_BOOSTS_AT_KEY = "dex_boosts_at";

export const SCAN_FRONT_GATE_KEYS = [
  "schema_alter_v2_done",
  "token_stats_last_prune",
  "birdeye_backfill_at",
  DEX_PROFILES_LAST_KEY,
  // The gecko discovery cadence stamp (GECKO_DISCOVERY_AT_KEY above): read to
  // decide whether this tick may spend a gecko fetch, written on the ticks
  // that do. One row on an IN-list that is already paid for.
  GECKO_DISCOVERY_AT_KEY,
  // The boosts lane's cadence stamp (DEX_BOOSTS_AT_KEY above): read to decide
  // whether this tick may spend a /token-boosts fetch, written on the ticks
  // that do. One more row on the same IN-list, never a request of its own.
  DEX_BOOSTS_AT_KEY,
  // The tracker pass's own row (pushwatch.TRACKER_PASS_STATE_KEY, spelled as
  // the literal because that module imports THIS one). It is READ, not gated
  // on: a tick's fallback pass asks it whether the pass's own cron delivery
  // already ran this minute (see worker.TRACKER_PASS_FALLBACK_FRESH_MS), and
  // riding this statement is what makes that question cost no round trip — the
  // IN-list is one row longer, not one request longer.
  "push_watch_pass",
  // The maintenance invocation's own row (scanner.MAINTENANCE_PASS_STATE_KEY,
  // spelled as the literal for exactly the import direction the pass row above
  // documents). READ, not gated on: a scan tick asks it whether the two
  // interval-gated side-effect legs (the Birdeye backfill and the crime-wallet
  // refresh) are still owned by the maintenance trigger or have fallen back to
  // this tick (see worker.MAINTENANCE_CRON and scanner.maintenancePassFresh).
  // Riding this statement is what makes that question cost no round trip.
  "maintenance_pass_at",
  // The FLEET-WIDE DexScreener spacing row (dexscreener.DEX_SPACING_STATE_KEY,
  // spelled as the literal for the same import-direction reason as the two
  // rows above). READ to inherit the raises an earlier isolate earned from a
  // 429, WRITTEN only on a tick whose step count actually moved, so joining
  // this list costs the tick an IN-list entry and never a round trip.
  "dex_spacing",
] as const;

/**
 * One `push_watch` row as the tracker reads it (see Db.listPushWatch).
 *
 * WHY IT IS A NAMED TYPE (2026-09-26): the pass's entry batch returns the
 * SAME listing (see Db.beginTrackerPass), and a second inline copy of
 * these twenty fields is a silent way for the two to drift apart — a row
 * field added on one side only would read as `undefined` on the other.
 * The extraction is byte-for-byte, so both signatures are one definition.
 */
export interface PushWatchListRow {
    token: string;
    chatId: string;
    symbol: string | null;
    pushedAt: number;
    mcapAtPush: number;
    peakMcap: number;
    lastLiquidity: number | null;
    lastVol5m: number | null;
    deadTroughMcap: number | null;
    holdersAtPush: number | null;
    holdersLast: number | null;
    holdersCheckedAt: number | null;
    /** Consecutive 🧨 sell-dominant checks (streak; resets on recovery). */
    sellDomStreak: number;
    /** Latest tracker-observed mcap (🏁 recap final value). */
    lastMcap: number | null;
    lastChecked: number;
    lastAlertAt: number;
    followupsSent: number;
    lastState: string | null;
    upStages: string | null;
    /**
     * 🟢 revivals announced since the last 🚀 runup card (the 💪 strong-buy
     * rule's memory). 0 for a row that has none — every row inserted before
     * the column existed reads as 0 through the NOT NULL DEFAULT.
     */
    revivesSinceUp: number;
    /**
     * The pool this row is PINNED to (see the pool-pinning note in
     * src/pushwatch.ts). Null = legacy row, pinned on its first successful
     * check write with the pool it was actually judged on.
     */
    poolAddress: string | null;
}

/**
 * worker_state key holding the fingerprint of the DDL `init` ran last (see the
 * fingerprint gate inside `init`). Read once per cold isolate; written only
 * when the batch actually ran.
 */
export const SCHEMA_DDL_FINGERPRINT_KEY = "schema_ddl_fingerprint";

/**
 * Every table addColumnIfMissing is called for (checked 2026-09-26:
 * token_stats 15 call sites, chat_settings 7, push_watch 4). Listed here
 * because the batched probe below has to ask for their columns UP FRONT
 * — a table missing from this list is not broken, it just keeps paying
 * the old one-round-trip-per-column path.
 */
export const COLUMN_PROBE_TABLES = ["chat_settings", "token_stats", "push_watch"] as const;

/**
 * Cache key for one column: `table\0column`. The separator is a NUL
 * rather than a dot so a table name containing a dot could never be
 * confused with a column of another table.
 */
function columnKey(table: string, column: string): string {
  return `${table}\u0000${column}`;
}

/**
 * FNV-1a over the init DDL statements, as 8 hex digits.
 *
 * Deliberately NOT a cryptographic hash: this decides whether to skip
 * idempotent `CREATE ... IF NOT EXISTS` statements, where the only requirement
 * is that any edit to the list produces a different value. A cheap non-crypto
 * hash is also the right cost here — the gate exists to spend less CPU than
 * the batch it skips, so it must not itself become work.
 *
 * The statements are hashed WITH a separator between them, so moving text
 * across a statement boundary (["ab","c"] vs ["a","bc"]) still changes the
 * value. Exported for the unit tests that pin the gate's behaviour.
 */
export function schemaFingerprint(statements: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const statement of statements) {
    for (let i = 0; i < statement.length; i++) {
      h ^= statement.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2f;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The one-time migration flags that `init` asks for, in the ORDER its
 * reads index them (2026-09-29).
 *
 * WHY DATA AND NOT NINE INLINE STATEMENTS. The boot batch below (`init`'s
 * ONE read) and the destructuring that consumes its slice have to agree about
 * the order, and the previous shape put the statements in one place and the
 * positions in another — which is how `schema_alter_v4` /
 * `settings_v5` were crossed once already (the comment that used to sit on
 * those two lines said so). One list, one order, both sides derived from it.
 */
export const MIGRATION_FLAG_KEYS = [
  "settings_v2_applied",
  "schema_alter_v1_done",
  "schema_alter_v2_done",
  "settings_v3_applied",
  "settings_v4_applied",
  "schema_alter_v3_done",
  "settings_v5_applied",
  "schema_alter_v4_done",
  "settings_v6_applied",
] as const;

/**
 * The telemetry-seed marker (see the seed block at the end of `init`).
 * Keyed here because the boot read asks for it as a ROW while the seed block
 * writes it inside SQL text; both spell the same name.
 */
export const TELEMETRY_SEED_MARKER_KEY = "telemetry_counts_seeded_v1";

/** The `batch` reply shape (see Db.init's boot read). */
type BatchRows = Awaited<ReturnType<Client["batch"]>>;

/**
 * A `worker_state.push_audit` ring as read from its row: an array of
 * entries, or `[]` for an absent / unreadable / non-array value.
 * Tolerant on purpose — every reader of this ring treats "nothing readable" as
 * "nothing proven", and a parse that threw would turn a diagnostics row into a
 * failed heal.
 *
 * Exported and pure because the ring now has THREE readers that must agree:
 * Db.getPushAudit, Db.getInitialPushAuditTokens and the tracker pass's carried
 * proof parser (pushwatch.deliveredProofFromRows), which receives the RAW row
 * inside the heal's ONE read instead of paying a request of its own.
 */
export function parsePushAuditRing(
  raw: string | null | undefined,
): Array<{ kind?: string; token?: string; sig?: string; at?: number }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as never) : [];
  } catch {
    return [];
  }
}

/**
 * Every token with an "initial" audit entry, out of an ALREADY-PARSED ring
 * (see parsePushAuditRing). The rule lives here so Db.getInitialPushAuditTokens
 * and the tracker heal's carried read cannot drift — they answer the same
 * question off the same row, and only one of them pays a request for it.
 */
export function initialPushAuditTokens(
  ring: ReadonlyArray<{ kind?: string; token?: string }>,
): Set<string> {
  const out = new Set<string>();
  for (const entry of ring) {
    if (entry?.kind === "initial" && entry.token) out.add(String(entry.token));
  }
  return out;
}

/**
 * The graduated-rotation slot for a clock reading — the ONE computation behind
 * both pool queries AND the edge-cache key that fronts them (2026-09-28).
 *
 * It was two identical inline expressions (getReevalPool and
 * getReevalPoolBatched) until the pool snapshot cache needed the same slot in
 * its URL. A third copy is the kind of drift that turns into "the cache
 * answered for the wrong window", so it lives here now. Callers must pass the
 * same rotationPeriodMs they pass in the query opts — production uses the
 * configured REEVAL_POOL_CACHE_SECONDS, which is also the cache TTL, so each
 * expiry advances to the next slot.
 */
export function poolRotationSlot(
  now: number,
  rotationPeriodMs: number = POOL_ROTATION_PERIOD_MS,
): number {
  return Math.floor(now / rotationPeriodMs);
}

export class Db {
  /**
   * Entries kept in the shared delivery ring (see recordPushDelivery).
   * Bounded by what a worker_state JSON value can carry comfortably (~30KB)
   * and by the hours a "which of this coin's cards went out?" question
   * spans.
   */
  private static readonly PUSH_AUDIT_MAX = 200;
  private client: Client | null = null;
  private readonly url: string;
  private readonly authToken?: string;
  /** Pre-built client (unit tests: local `file:` libsql, no network). */
  private readonly injectedClient?: Client;
  /**
   * Tick-scoped client, created on the first enterScanMode() and reused for
   * the isolate's lifetime. See SCAN_DB_TIMEOUT_MS: same connection settings,
   * 5x shorter leash, so a scan round trip cannot outlive the tick.
   */
  private scanClient: Client | null = null;
  /** True while a scan is running (see enterScanMode). */
  private scanMode = false;
  /** Ms spent inside tick-scoped round trips since the last enterScanMode(). */
  private scanDbMs = 0;

  constructor(url: string, authToken?: string, injectedClient?: Client) {
    this.url = url;
    this.authToken = authToken;
    this.injectedClient = injectedClient;
  }

  /**
   * Many keys, ONE round trip. Every getWorkerState call is a subrequest, and
   * the invocation's budget counts Turso's HTTP requests too (Workers Free: 50
   * subrequests per invocation) — so the tick-front reads (scan_heartbeat plus
   * the cron-tick counter/ring) are read together instead of one key at a
   * time. Missing rows are simply absent from the map.
   *
   * It lives in the reachable head of this class on purpose: the worker's
   * scheduled handler cannot reach getWorkerState's own neighbourhood (the
   * same ~48KB file-sync window that produced getReevalPoolBatched).
   */
  async getWorkerStates(keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (keys.length === 0) return out;
    const res = await this.get().execute({
      sql: `SELECT key, value FROM worker_state WHERE key IN (${keys
        .map(() => "?")
        .join(",")})`,
      args: keys,
    });
    for (const row of res.rows) {
      const rec = row as Record<string, unknown>;
      out.set(String(rec.key), String(rec.value));
    }
    return out;
  }

  /**
   * The whole tick tail in ONE read request: the `worker_state` rows the tail
   * reconciles (deferral snapshot, push-baseline ledger, delivery audit ring,
   * skip-capture counters, Birdeye CU ledger) plus the two live listings the
   * duplicate guard and the ledger sync read (the pushed rows and the enabled
   * chats' band). The key set is the CALLER's (worker.ts TAIL_STATE_KEYS), so
   * a row that moves into the tail costs bytes rather than a round trip — which
   * is how the deferral snapshot and the duplicate guard's three proof sources
   * stopped paying their own reads.
   *
   * Why one request and not six: the tick's binding constraint is the
   * 50-subrequest invocation budget (docs/round-trips.md §1), the measured host
   * split put 63-83% of a window into Turso round trips, and the three syncs on
   * their own paid SIX reads when they came due together — the common
   * 5-minute shape (§4.6.2). A libsql `batch` is one HTTP request whose results
   * come back in statement order, so every read keeps its exact shape and loses
   * nothing but the round trips.
   *
   * The listings are deliberately NOT the full listPushWatch / listEnabledChats
   * projections: the reconciliation reads only `token` / `pushed_at` /
   * `mcap_at_push` and the two band columns, and the ORDER BY ... LIMIT below is
   * byte-for-byte the listing's, so the row SET is identical. The unit test
   * "the grouped post-scan telemetry read is ONE round trip" pins both the row
   * equivalence and the single-request shape.
   */
  async readPostScanTelemetry(
    stateKeys: readonly string[],
    pushWatchLimit = 60,
  ): Promise<{
    states: Map<string, string>;
    pushWatch: Array<{ token: string; pushedAt: number; mcapAtPush: number }>;
    chats: Array<{ minMarketCapUsd: number; maxMarketCapUsd: number }>;
  }> {
    const res = await this.get().batch(
      [
        {
          // Non-empty by contract (the tick tail passes its five rows); N keys,
          // one statement — the same shape as getWorkerStates above.
          sql: `SELECT key, value FROM worker_state WHERE key IN (${stateKeys
            .map(() => "?")
            .join(",")})`,
          args: [...stateKeys],
        },
        {
          // Same set as listPushWatch(pushWatchLimit): active rows claim their
          // slots first (oldest last_checked first), terminal tombstones fill
          // any leftovers by pushed_at.
          sql: `SELECT token, pushed_at, mcap_at_push FROM push_watch
                 ORDER BY CASE WHEN COALESCE(last_state, '') IN ('rug', 'unwatched', 'expired') THEN 1 ELSE 0 END,
                          CASE WHEN COALESCE(last_state, '') IN ('rug', 'unwatched', 'expired')
                               THEN pushed_at ELSE last_checked END ASC
                 LIMIT ?`,
          args: [pushWatchLimit],
        },
        {
          sql: "SELECT min_market_cap_usd, max_market_cap_usd FROM chat_settings WHERE enabled = 1",
          args: [],
        },
      ],
      "read",
    );
    const states = new Map<string, string>();
    for (const row of res[0]?.rows ?? []) {
      const r = row as Record<string, unknown>;
      states.set(String(r.key), String(r.value));
    }
    const pushWatch = (res[1]?.rows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        pushedAt: Number(r.pushed_at ?? 0),
        mcapAtPush: Number(r.mcap_at_push ?? 0),
      };
    });
    const chats = (res[2]?.rows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        minMarketCapUsd: Number(r.min_market_cap_usd ?? DEFAULT_SETTINGS.minMarketCapUsd),
        maxMarketCapUsd: Number(r.max_market_cap_usd ?? DEFAULT_SETTINGS.maxMarketCapUsd),
      };
    });
    return { states, pushWatch, chats };
  }

  /**
   * The same upsert `setWorkerState` issues, for N keys in ONE write request —
   * the write half of the grouped post-scan telemetry read above. A rejected
   * batch leaves every row unwritten, which is exactly the state three failed
   * single-key writes reached: the caller's in-memory deltas are only cleared
   * after this resolves (see syncPushDeferralCounters in src/worker.ts).
   */
  async setWorkerStatesMany(
    entries: Array<{ key: string; value: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.get().batch(
      entries.map((e) => ({
        sql: "INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        args: [e.key, e.value],
      })),
      "write",
    );
  }

  /**
   * The scan front in ONE read request: the gate rows above plus the enabled
   * chats. Read with a `batch` rather than two awaits for the reason the tail's
   * grouped read exists — the invocation's 50 subrequests are the binding
   * constraint and Turso round trips are 63-83% of them.
   *
   * `stateKeys` is non-empty by contract (the scan passes SCAN_FRONT_GATE_KEYS);
   * an empty array falls back to the chats-only read, so a caller with nothing to
   * gate on still pays one request and not a throw.
   */
  async readScanFront(
    stateKeys: readonly string[] = SCAN_FRONT_GATE_KEYS,
  ): Promise<ScanFront> {
    const chats = {
      sql: "SELECT * FROM chat_settings WHERE enabled = 1",
      args: [] as Array<string | number | null>,
    };
    const state = {
      sql: `SELECT key, value FROM worker_state WHERE key IN (${stateKeys
        .map(() => "?")
        .join(",")})`,
      args: [...stateKeys] as Array<string | number | null>,
    };
    const res = await this.get().batch(
      stateKeys.length === 0 ? [chats] : [state, chats],
      "read",
    );
    const gates = new Map<string, string>();
    if (stateKeys.length > 0) {
      for (const row of res[0]?.rows ?? []) {
        const r = row as Record<string, unknown>;
        gates.set(String(r.key), String(r.value));
      }
    }
    const chatRows = res[stateKeys.length === 0 ? 0 : 1]?.rows ?? [];
    return {
      gates,
      chats: chatRows.map((row) => this.mapRow(row as Record<string, unknown>)),
      writes: [],
    };
  }

  /**
   * The front's ONE write: every bookkeeping row its legs queued, in one request.
   * A rejected batch leaves all of them unwritten, which is exactly what the
   * separate writes reached — each row answers "when did this job last run", so
   * the next tick re-derives it (see Scanner.flushScanFront).
   */
  async writeScanFront(entries: readonly ScanFrontWrite[]): Promise<void> {
    if (entries.length === 0) return;
    await this.get().batch(
      entries.map((e) =>
        e.add
          ? {
              sql: "INSERT INTO worker_state (key, value) VALUES (?, ?)" +
                " ON CONFLICT(key) DO UPDATE SET" +
                " value = CAST(value AS INTEGER) + excluded.value",
              args: [e.key, e.value],
            }
          : {
              sql: "INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
              args: [e.key, e.value],
            },
      ),
      "write",
    );
  }

  /**
   * One front gate: the value the front's single read carried, or a read of its
   * own when the caller has no front (a command handler, a diagnostic, a test).
   * A key missing from the map is the row being absent — presence in the map is
   * what says the read happened, so this never turns "not read" into "no row".
   */
  private async gateOf(
    front: ScanFront | null | undefined,
    key: string,
  ): Promise<string | null> {
    if (front) return front.gates.get(key) ?? null;
    return this.getWorkerState(key);
  }

  /**
   * Queue one front bookkeeping row on the front's single batch, or write it on
   * its own when there is no front. A zero ADD delta is not queued at all — the
   * same no-op bumpTelemetryCounter makes (see writeScanFront).
   */
  private async frontStamp(
    front: ScanFront | null | undefined,
    key: string,
    value: string,
    add = false,
  ): Promise<void> {
    if (front) {
      if (add && Number(value) === 0) return;
      front.writes.push({ key, value, add });
      return;
    }
    if (add) {
      await this.bumpTelemetryCounter(key, Number(value));
      return;
    }
    await this.setWorkerState(key, value);
  }

  /**
   * The cron-arrival bookkeeping (worker_state `scheduled_tick_total` /
   * `scheduled_tick_at` / `scheduled_tick_ring`) as READ-FREE statements: the
   * counter increments in SQL, and the ring/timestamp come from the caller,
   * which already read the ring with its cadence-gate read. That is what lets a
   * normal cron tick pay ZERO extra round trips — the statements ride inside
   * the scan-lock claim batch (see claimScanLock), the tick's first must-land
   * write. Before this, every cron tick paid a read AND a write through its own
   * raw client (live `bump 564-2211ms` in summary.preTick) on an invocation
   * whose binding constraint is the 50-subrequest budget.
   */
  scheduledTickStatements(
    entry: ScheduledTickEntry,
  ): Array<{ sql: string; args: Array<string | number | null> }> {
    return [
      {
        // The row must exist before the UPDATE can increment it.
        sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES ('scheduled_tick_total', '0')",
        args: [],
      },
      {
        sql: "UPDATE worker_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'scheduled_tick_total'",
        args: [],
      },
      {
        sql: "INSERT INTO worker_state (key, value) VALUES ('scheduled_tick_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        args: [String(entry.at)],
      },
      {
        sql: "INSERT INTO worker_state (key, value) VALUES ('scheduled_tick_ring', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        args: [JSON.stringify(entry.ring.slice(-SCHEDULED_TICK_RING_MAX))],
      },
    ];
  }

  /**
   * The same bookkeeping in ONE write and NO read, for a tick that never
   * reaches a claim (the cadence-gate skip path, or a lease lost to another
   * isolate): the caller already holds the ring.
   */
  async writeScheduledTick(entry: ScheduledTickEntry): Promise<void> {
    await this.get().batch(this.scheduledTickStatements(entry), "write");
  }

  /**
   * The PRE-INIT cron-arrival stamp: one write and NO read, issued BEFORE
   * ensureInitialized, so an arrival still leaves a trace when the tick dies
   * inside init.
   *
   * WHY (2026-09-24, live): the arrival bookkeeping rides the scan-lock claim
   * (see scheduledTickStatements) and every path that cannot reach a claim
   * writes it on its own — but ALL of them are reachable only AFTER init. A
   * tick killed inside init therefore records nothing, and a stretch of them
   * reads exactly like "the Cron Trigger stopped delivering": the sampled ring
   * froze for 19 minutes (2026-09-23 23:43:26 -> 00:02:26Z) and again for 2h42m
   * (20:21:26 -> 23:03:26Z) while scans kept landing every ~70s (the HTTP
   * monitor's fallback), and the durable counter moved 54_546 (13:46Z) ->
   * 54_846 (23:56Z) over a 10h window — about HALF of the expected beats were
   * never recorded. The successor-tick recovery can only prove an arrival
   * reached the heartbeat read; nothing could prove the delivery itself.
   *
   * Cost: ONE subrequest (Workers Free counts Turso's HTTP requests) and NO
   * read — the counter increments in SQL and the timestamp is the caller's
   * clock, which is exactly the shape the 2026-09-23 §1 cut removed from the
   * normal path (a fresh raw client's read AND write per tick, `bump
   * 564-2211ms` live). The worker calls it only for an arrival whose
   * predecessor never returned (see shouldStampArrival), so a healthy warm
   * isolate pays nothing for it.
   */
  async stampScheduledArrival(at: number): Promise<void> {
    // connect(), NOT get(). This write runs BEFORE ensureInitialized, on the
    // arrivals whose front is already suspect — and get() throws "Database is
    // not initialized" on a handle whose init has not run. The worker's
    // cold-isolate fallback is exactly such a handle (a raw `new Db(...)` that
    // never calls init, the same shape bumpScheduledTickLegacy builds), so
    // get() here made the stamp a silent no-op on the one path it exists for:
    // live 2026-09-24 the cron trigger was delivering every minute (the ring's
    // newest entry and scheduled_tick_at both advanced, and the front was
    // healthy) while scheduled_arrival_total stayed ABSENT after a deploy —
    // because the cold handle's stamp threw straight into the worker's catch.
    // The unit test below pins the never-initialized handle so this cannot
    // regress back to a write that only works once something else has connected.
    await this.connect().batch(
      [
        {
          sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES ('scheduled_arrival_total', '0')",
          args: [],
        },
        {
          sql: "UPDATE worker_state SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'scheduled_arrival_total'",
          args: [],
        },
        {
          sql: "INSERT INTO worker_state (key, value) VALUES ('scheduled_arrival_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          args: [String(at)],
        },
      ],
      "write",
    );
  }

  /**
   * The tracker pass's setup writes in ONE round trip: the 🏁 recap claims for
   * the rows leaving the tracking window, plus the prune that deletes exactly
   * those rows. Statement order is the caller's (claims first, then the
   * DELETE) and batch results come back in statement order, so the per-row
   * `won` flags still come from the claim statements themselves — the
   * compare-and-swap that stops a second isolate from re-announcing a recap is
   * untouched. `pruned` is the DELETE's row count.
   *
   * Each of the two was its own subrequest out of the invocation's
   * 50-subrequest budget (Workers Free counts Turso's HTTP requests too), and
   * the pass's whole design is its round-trip count (the `trips N` in the
   * note): on a pass with rows leaving the window this is 2 trips → 1, and the
   * DELETE can never run without the claims it belongs with — the same batch
   * either lands both or neither, so a row can no longer be deleted while the
   * claim that would have announced it never went out.
   */
  async claimRecapsAndPrune(
    tokens: string[],
    olderThanMs: number,
  ): Promise<{ won: boolean[]; pruned: number }> {
    const statements: Array<{ sql: string; args: Array<string | number | null> }> =
      tokens.map((token) => ({
        sql: `UPDATE push_watch SET last_state = 'expired'
            WHERE token = ?
              AND (last_state IS NULL OR last_state NOT IN ('expired', 'unwatched'))`,
        args: [token],
      }));
    statements.push({
      sql: "DELETE FROM push_watch WHERE pushed_at < ?",
      args: [olderThanMs],
    });
    const res = await this.get().batch(statements, "write");
    return {
      won: res.slice(0, tokens.length).map((r) => Number(r.rowsAffected ?? 0) > 0),
      pruned: Number(res[tokens.length]?.rowsAffected ?? 0),
    };
  }

  /**
   * The tracker pass's heal-stage opening reads in ONE round trip: the
   * untracked pushes (seen_tokens rows with no push_watch row — pushes whose
   * enrollment hook never ran) and the durable push-baseline ledger row. The
   * heal needs both at the same moment, and each was its own subrequest; the
   * ledger read also used to be paid only after the untracked list came back
   * non-empty, which on a starved pass pushed the enrollments themselves into
   * the budget cut. Same rows, same order, one request.
   *
   * WIDENED 2026-09-29 (the same fix, one stage over). The heal asks its next
   * question immediately after this read — "was a card for this token ever
   * DELIVERED?" — and answered it with three MORE requests: the initial-only
   * audit set, the unconfirmed-card record, and the whole ring again
   * (pushwatch.readDeliveredTokens). Live `dbTickSteps` on one tick:
   * `findUntrackedPushesAndLedger 589`, `getWorkerState:push_audit 289`,
   * `getPushAudit 289` — 1.17s of opening bookkeeping for one stage.
   *
   * So when the caller names the unconfirmed record's key, the SAME batch also
   * carries `worker_state.push_audit` and that row: four statements, ONE
   * request, and `proofsCarried` says they are this read's own. The audit ring
   * is read even on a pass whose untracked list comes back empty — it rides a
   * request that was already going out, and the alternative (a conditional
   * second request) is the cost this exists to remove.
   *
   * `proofsCarried` is explicit rather than "auditRaw is defined" so a
   * caller whose Db is a narrow double (the heal tests') is told plainly that
   * the rows are NOT here and must ask readDeliveredTokens itself.
   */
  async findUntrackedPushesAndLedger(
    sinceMs: number,
    ledgerKey: string,
    limit = 10,
    /** The unconfirmed-card record's key (deferrallog.UNCONFIRMED_CARD_STATE_KEY).
     * Spelled as a parameter rather than imported because src/deferrallog.ts
     * imports THIS module. Only the heal passes it. */
    unconfirmedKey?: string,
  ): Promise<{
    missing: Array<{ token: string; chatId: string; pushedAt: number }>;
    ledgerRaw: string | null;
    /** The `push_audit` ring as THIS request read it (parse it with
     * parsePushAuditRing). Present iff `proofsCarried`. */
    auditRaw?: string | null;
    /** The unconfirmed-card record as THIS request read it. */
    unconfirmedRaw?: string | null;
    /** Whether the two rows above are this read's own (see the doc). */
    proofsCarried?: boolean;
  }> {
    const res = await this.get().batch(
      [
        {
          sql: `SELECT s.token, s.chat_id, MIN(s.first_seen_at) AS pushed_at
                  FROM seen_tokens s
                 WHERE s.first_seen_at > ?
                   AND NOT EXISTS (SELECT 1 FROM push_watch pw WHERE pw.token = s.token)
                 GROUP BY s.token, s.chat_id
                 ORDER BY pushed_at DESC
                 LIMIT ?`,
          args: [sinceMs, limit],
        },
        { sql: "SELECT value FROM worker_state WHERE key = ?", args: [ledgerKey] },
        // The proof rows (see the widened doc above): the delivery audit ring
        // and the unconfirmed-card record. Appended only when the caller named
        // the second key, so a caller that wants nothing else still pays the
        // narrow two-statement shape.
        ...(unconfirmedKey
          ? [
              {
                sql: "SELECT value FROM worker_state WHERE key = 'push_audit'",
                args: [] as Array<string | null>,
              },
              {
                sql: "SELECT value FROM worker_state WHERE key = ?",
                args: [unconfirmedKey] as Array<string | null>,
              },
            ]
          : []),
      ],
      "read",
    );
    const missing = (res[0]?.rows ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        chatId: String(r.chat_id),
        pushedAt: Number(r.pushed_at ?? 0),
      };
    });
    const ledgerRow = (res[1]?.rows ?? [])[0] as Record<string, unknown> | undefined;
    if (!unconfirmedKey) {
      return { missing, ledgerRaw: ledgerRow ? String(ledgerRow.value) : null };
    }
    const proofRow = (i: number) =>
      (res[i]?.rows ?? [])[0] as Record<string, unknown> | undefined;
    const auditEntry = proofRow(2);
    const unconfirmedEntry = proofRow(3);
    return {
      missing,
      ledgerRaw: ledgerRow ? String(ledgerRow.value) : null,
      auditRaw: auditEntry ? String(auditEntry.value) : null,
      unconfirmedRaw: unconfirmedEntry ? String(unconfirmedEntry.value) : null,
      proofsCarried: true,
    };
  }

  /**
   * The tracker pass's holder writes in ONE round trip: one UPDATE per probed
   * row, batched. Scope is unchanged — each row still gets exactly its own
   * count and its own `holders_checked_at`, so the refresh cadence per row is
   * the same — but N probes now cost 1 subrequest instead of N on an
   * invocation whose budget is 50. A rejected batch parks every row it covered
   * (see the holder stage in src/pushwatch.ts), the same state a row whose own
   * write failed used to reach.
   *
   * 2026-09-25 (§4.17): this batch ALSO wrote the shared holder cache
   * (token_stats.holder_count / holder_count_at) so the card side could reuse
   * the probe's reading instead of buying its own (§4.16). That reader is gone
   * — the card's holders line was removed, and with it the only
   * `/defi/token_overview` the card path ever bought — so the statements went
   * with it. A cache nobody reads must not keep a second UPDATE per row inside
   * the one request this method exists to keep at one; the row's own
   * `holders_at_push` / `holders_last` (what the growth and divergence alerts
   * are computed from) is unchanged.
   */
  async setPushWatchHoldersMany(
    updates: Array<{ token: string; holders: number; at: number }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    await this.get().batch(
      [
        ...updates.map((u) => ({
          sql: `UPDATE push_watch SET
                  holders_at_push = COALESCE(holders_at_push, ?),
                  holders_last = ?, holders_checked_at = ?
                WHERE token = ?`,
          args: [u.holders, u.holders, u.at, u.token],
        })),
      ],
      "write",
    );
  }

  /**
   * The row loop's SILENT half in ONE round trip: claim AND record N rows at
   * once (see PushWatcher.runTick).
   *
   * Every statement is exactly the compare-and-swap `claimPushWatchCheck` sends
   * today — `SET <check fields>, last_checked = ?` guarded by
   * `last_checked = ?` — so the cross-isolate exclusion, the per-row atomicity
   * and the field set are unchanged. What changes is the COUNT: a pass pays one
   * subrequest for the whole head instead of one round trip per observed row.
   * That was the row loop's cost (live 2026-09-23: `rows 5/30 spend[…] trips 9`,
   * a ~150-400ms store trip per row) while ~90% of the rows a pass touches have
   * nothing to announce — which is why a pass covered a handful of rows a minute
   * instead of its whole head.
   *
   * Result order follows statement order — the same contract the recap claims
   * rely on — so the caller's `won[i]` belongs to `updates[i]`: false means
   * another isolate claimed that row first, precisely what the per-row call
   * reported.
   */
  async claimPushWatchChecksMany(
    updates: Array<{
      token: string;
      expectedLastChecked: number;
      now: number;
      v: PushWatchCheckValues;
    }>,
  ): Promise<boolean[]> {
    if (updates.length === 0) return [];
    const res = await this.get().batch(
      updates.map((u) => {
        const set = this.pushWatchCheckSet(u.v, u.now);
        return {
          sql: `UPDATE push_watch SET ${set.sql}
            WHERE token = ? AND last_checked = ?`,
          args: [...set.args, u.token, u.expectedLastChecked],
        };
      }),
      "write",
    );
    return res.map((r) => Number(r.rowsAffected ?? 0) > 0);
  }

  /**
   * The band query's partial index — the one access path that skips the rows
   * the market-cap floor is going to reject anyway (2026-10-07).
   *
 * WHAT IT BUYS (measured 2026-10-07, scripts/pool-read-cost.js burst + the
 * platform's rows_read): 18.5k rows per pool read before, 5.75k after — 3.2x
 * off the single largest reader the bot has, with the A/B check confirming the
 * same 518 near-band tokens come back token-for-token through either index.
 * The band's range is launch_ms and the floor is on max_mcap_observed, so
 * without this the floor is a post-walk filter over ~86% dead candidates; a
 * partial index pinned to the floor's literal (see mcapFloorLiteral) lets the
 * range walk only the rows the floor admits.
   *
   * WHERE IT IS CALLED FROM: the SCANNER, once per isolate per floor — not from
   * getReevalPoolBatched, because the audit instruments drive that method at a
   * LADDER of ratios (pool-mcap-floor.js) and would each mint an index for a
   * floor production never uses.
   *
   * FAILURE IS CHEAP AND SILENT-ISH: the index is an optimization, so a failure
   * only means the next sweep keeps the pre-2026-10-07 plan; the retry interval
   * keeps a broken DDL from being re-attempted on every tick.
   */
  private poolBandIndexFloor: number | null = null;
  private poolBandIndexRetryAt = 0;
  async ensurePoolBandIndex(minQualifyMcap: number): Promise<void> {
    if (!Number.isFinite(minQualifyMcap)) return;
    if (this.poolBandIndexFloor === minQualifyMcap) return;
    if (Date.now() < this.poolBandIndexRetryAt) return;
    const name = poolBandIndexName(minQualifyMcap);
    try {
      await this.get().execute({
        sql: `CREATE INDEX IF NOT EXISTS ${name} ON token_stats(launch_ms)
              WHERE (max_mcap_observed IS NULL OR max_mcap_observed >= ${mcapFloorLiteral(minQualifyMcap)})`,
        args: [],
      });
      this.poolBandIndexFloor = minQualifyMcap;
      console.log(`[db] pool band index ready: ${name}`);
    } catch (err) {
      this.poolBandIndexRetryAt = Date.now() + 30 * 60_000;
      console.warn(
        "[db] pool band index unavailable (band walks stay full-range):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * One-round-trip variant of getReevalPool (2026-09-19).
   *
   * Why a second method and not a reshape of getReevalPool: the original plus
   * its band helper queryReevalBand sit past the ~48KB file-sync window, so the
   * production path has to be adjusted from the reachable part of this class.
   * The Worker hands the scanner src/poolfallback.ts's subclass, which calls
   * this method. The band split below MUST stay identical to getReevalPool's —
   * the unit test "getReevalPoolBatched: same bands, one round trip" pins both
   * to the same tokens in the same order, so drift in either copy fails the
   * suite.
   *
   * The win is ROUND TRIPS, not SQL: the original issues the hot, near and far
   * band queries as three sequential awaits (measured 2026-09-19: the pool read
   * took 352-457ms, ≈3 × the ~130ms Turso round trip), while this sends the same
   * three statements as ONE batched request — the same shape the completion
   * flush already uses. Rows read are unchanged, per-band LIMITs still apply,
   * and result order is preserved because batch results come back in statement
   * order (hot, then near, then far, exactly as `out.push` ordered them).
   */
  async getReevalPoolBatched(
    opts: Parameters<Db["getReevalPool"]>[0],
  ): Promise<TokenStats[]> {
    const now = opts.now ?? Date.now();
    // Same cutoff the per-band builder derives (see getReevalPool): one clock,
    // one instant, so the two paths cannot disagree about which rows' grace
    // has run out — the drift guard test asserts the resulting sets match.
    const mcapEvidenceSinceMs = now - POOL_MCAP_EVIDENCE_GRACE_MS;
    const center = opts.windowEntryLaunchMs;
    const spanLo = opts.minLaunchMs;
    const spanHi = opts.maxLaunchMs;
    const hotLo = Math.max(spanLo, center - POOL_HOT_BELOW_MS);
    const hotHi = Math.min(spanHi, center + POOL_HOT_ABOVE_MS);
    const hotLimit = Math.min(opts.limit, POOL_HOT_MAX);
    const bands: Array<{
      lo: number;
      hi: number;
      center: number;
      limit: number;
      orderBy: "entry" | "signal";
      /** See queryReevalBand / POOL_BAND_ROTATE_BUCKETS ("signal" only). */
      rotatePhase?: number;
    }> = [];
    if (hotHi > hotLo) {
      bands.push({ lo: hotLo, hi: hotHi, center, limit: hotLimit, orderBy: "entry" });
    }
    const rotLimit = Math.max(0, opts.limit - hotLimit);
    const rotLo = spanLo; // oldest launch in the window
    const rotHi = hotLo; // everything older than the hot zone
    if (rotLimit > 0 && rotHi > rotLo) {
      const nearLo = Math.max(rotLo, center - POOL_NEAR_WINDOW_MS);
      const nearSlots = Math.max(1, Math.floor(opts.nearSlots ?? POOL_NEAR_SLOTS));
      const farSlots = Math.max(1, Math.floor(opts.farSlots ?? POOL_FAR_SLOTS));
      const nearLimit = Math.max(
        0,
        Math.min(rotLimit, Math.round(rotLimit * POOL_NEAR_LIMIT_SHARE)),
      );
      const farLimit = Math.max(0, rotLimit - nearLimit);
      const slot = poolRotationSlot(now, opts.rotationPeriodMs);
      // Must match getReevalPool's phases exactly (the unit test pins the two
      // paths to the same tokens in the same order).
      const nearPhase = Math.floor(slot / nearSlots);
      const farPhase = Math.floor(slot / farSlots);
      if (rotHi > nearLo && nearLimit > 0) {
        const slotW = (rotHi - nearLo) / nearSlots;
        const s = slot % nearSlots;
        const lo = rotHi - (s + 1) * slotW;
        const hi = rotHi - s * slotW;
        bands.push({
          lo,
          hi,
          center: (lo + hi) / 2,
          limit: nearLimit,
          orderBy: "signal",
          rotatePhase: nearPhase,
        });
      }
      if (nearLo > rotLo && farLimit > 0) {
        const slotW = (nearLo - rotLo) / farSlots;
        const s = slot % farSlots;
        const lo = nearLo - (s + 1) * slotW;
        const hi = nearLo - s * slotW;
        bands.push({
          lo,
          hi,
          center: (lo + hi) / 2,
          limit: farLimit,
          orderBy: "signal",
          rotatePhase: farPhase,
        });
      }
    }
    if (bands.length === 0) return [];
    const seen = this.seenExclusion(opts.seenChatIds);
    const statements = bands.map((b) => {
      const clauses: string[] = [DEAD_POOL_CLAUSE, POOL_MCAP_EVIDENCE_CLAUSE];
      const args: Array<string | number> = [b.lo, b.hi, opts.sinceMs, mcapEvidenceSinceMs];
      // Literal floor, no argument — see mcapFloorLiteral. Both builders must
      // carry the SAME shape or the drift guard pins them apart.
      if (opts.minQualifyMcap !== undefined) {
        clauses.push(
          `(max_mcap_observed IS NULL OR max_mcap_observed >= ${mcapFloorLiteral(opts.minQualifyMcap)})`,
        );
      }
      if (opts.maxQualifyMcap !== undefined) {
        clauses.push(`(max_mcap_observed IS NULL OR max_mcap_observed <= ?)`);
        args.push(opts.maxQualifyMcap);
      }
      if (opts.minQualifyLiquidity !== undefined) {
        clauses.push(
          `(max_liquidity_observed IS NULL OR max_liquidity_observed >= ?)`,
        );
        args.push(opts.minQualifyLiquidity);
      }
      args.push(...seen.args);
      // The ORDER BY comes from the SAME helper the per-band path uses (see
      // poolBandOrder), so a change to the signal ordering or its rotation tie
      // break cannot land on one path only.
      const order = poolBandOrder(b.orderBy);
      if (order.rotate) args.push(b.rotatePhase ?? 0);
      if (b.orderBy === "signal") {
        args.push(b.limit);
        return {
          sql: `SELECT * FROM token_stats
                WHERE launch_ms BETWEEN ? AND ?
                  AND first_seen_at > ?${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
                  ${seen.clause}
                ${order.sql}
                LIMIT ?`,
          args,
        };
      }
      args.push(b.center, b.limit);
      return {
        sql: `SELECT * FROM token_stats
              WHERE launch_ms BETWEEN ? AND ?
                AND first_seen_at > ?${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""}
                ${seen.clause}
              ${order.sql}
              LIMIT ?`,
        args,
      };
    });
    const results = await this.get().batch(statements, "read");
    const out: TokenStats[] = [];
    for (const result of results) {
      for (const row of result.rows) out.push(this.statsFromRow(row));
    }
    return out;
  }

  /** Creates the libsql client once (lazy; no network until first call). */
  private connect(): Client {
    if (this.client) return this.client;
    if (this.injectedClient) {
      // Test clients go through the same hard wall: a mock (or a real
      // client) that never settles must reject near the wall instead of
      // hanging the caller — that behavior is exactly what the unit tests
      // assert. Healthy local file clients settle in single-digit ms and
      // never notice the wall.
      this.client = wrapClientWithHardWall(this.injectedClient);
      return this.client;
    }
    this.client = wrapClientWithHardWall(this.createRawClient(DB_REQUEST_TIMEOUT_MS));
    return this.client;
  }

  /**
   * Builds a raw (unwrapped) libsql client whose TRANSPORT aborts at
   * `timeoutMs`. The hard wall around it is 1.2x that — see
   * wrapClientWithHardWall for why one signal is not enough (the HTTP client
   * retries internally after an abort, so its promise can outlive the
   * signal 2-3x).
   */
  private createRawClient(timeoutMs: number): Client {
    // libsql:// is a WebSocket scheme; https:// drives the HTTP transport,
    // which works reliably on Workers (fetch) and in Node alike.
    const httpUrl = this.url.replace(/^libsql:\/\//, "https://");
    return createClient({
      url: httpUrl,
      authToken: this.authToken,
      // Bound every request: a stalled Turso call aborts instead of hanging
      // the caller indefinitely.
      fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
        }),
    });
  }

  /**
   * Tick-scoped client: same connection, SCAN_DB_TIMEOUT_MS leash. Built on
   * first use and kept for the isolate's lifetime (the wrapped client holds
   * no request state, and re-creating it per tick would re-allocate the
   * transport on the hot path).
   */
  private ensureScanClient(): Client {
    if (this.scanClient) return this.scanClient;
    const raw = this.injectedClient ?? this.createRawClient(SCAN_DB_TIMEOUT_MS);
    const wrapped = wrapClientWithHardWall(raw, SCAN_DB_TIMEOUT_MS, (ms) => {
      // Reachable only in scan mode (see get()), so this counter is the
      // tick's own un-raced Turso cost. A call that started inside a scan and
      // settles after exitScanMode() adds its ms to the NEXT tick's count
      // (the tick had already given up on it); that bias is a few ms wide and
      // only ever overstates, never hides, the cost.
      this.scanDbMs += ms;
    });
    return (this.scanClient = wrapped);
  }

  /**
   * Enters the tick-scoped DB cap for one scan (see SCAN_DB_TIMEOUT_MS).
   * From here until exitScanMode() every round trip — the scanner's own and
   * the post-push tracker's, since both live inside the tick — fails inside
   * the tick instead of outliving it.
   *
   * Scope note: this is a flag on the shared Db instance, so a command
   * handler running on the SAME isolate during a scan window also gets the
   * shorter leash. That is the safe direction — the alternative is a stalled
   * call that kills the tick — and handlers surface their own errors.
   */
  enterScanMode(): void {
    this.scanMode = true;
    this.scanDbMs = 0;
  }

  /**
   * Leaves scan mode and returns the ms the scan spent in tick-scoped round
   * trips. Reported in the scan summary (`diag.dbMs`) so the un-raced Turso
   * cost is visible per tick instead of inferred after a death.
   */
  exitScanMode(): number {
    this.scanMode = false;
    const ms = this.scanDbMs;
    this.scanDbMs = 0;
    return ms;
  }

  async init(): Promise<void> {
    const c = this.connect();
    // All idempotent DDL in ONE batched round trip. Previously each statement
    // was its own round trip (~14 of them, each up to DB_REQUEST_TIMEOUT_MS),
    // so a degraded database could push init past the ~30s scheduled-event
    // wall clock and kill the tick before the scanner initialized — cron then
    // LOOKED dead from /health (observed 2026-08-14).
    //
    // THE FINGERPRINT GATE (2026-09-26). One round trip, but not a cheap one:
    // measured with scripts/cpu-profile.js against this same database, the
    // DDL batch costs 46-189ms of CPU on the client (18 long statements to
    // encode and their results to decode) while a single-row read costs
    // 2.4-5.8ms. That made it the largest single CPU item in a tick — and an
    // isolate recycles, so the next one pays it again: this is the one cost a
    // cron Worker pays for a schema that has not changed since yesterday.
    // Workers Free allows 10ms of CPU per invocation, Cloudflare has been
    // killing this Worker with `exceededResources` because of it, so the DDL
    // is now behind a fingerprint: read ONE small row, run the batch only when
    // that row does not already describe exactly these statements.
    //
    // The fingerprint is derived from `ddl` ITSELF, not hand-maintained, so a
    // statement added or edited above busts the gate automatically — the
    // failure a hand-kept version number would eventually produce (DDL
    // skipped, table missing) is not reachable here. Any read failure is also
    // a mismatch: an unknown schema is exactly when the DDL should run.
    const ddl: string[] = [
        `CREATE TABLE IF NOT EXISTS chat_settings (
          chat_id TEXT PRIMARY KEY,
          min_liquidity_usd REAL NOT NULL DEFAULT 10000,
          min_volume_24h_usd REAL NOT NULL DEFAULT 0,
          min_market_cap_usd REAL NOT NULL DEFAULT 40000,
          max_market_cap_usd REAL NOT NULL DEFAULT 380000,
          min_age_minutes REAL NOT NULL DEFAULT 80,
          max_age_minutes REAL NOT NULL DEFAULT 1560,
          min_5m_vol_usd REAL NOT NULL DEFAULT 4500,
          min_1h_vol_usd REAL NOT NULL DEFAULT 15000,
          min_5m_chg_pct REAL NOT NULL DEFAULT 20,
          min_1h_chg_pct REAL NOT NULL DEFAULT 40,
          enabled INTEGER NOT NULL DEFAULT 0
        );`,
        `CREATE TABLE IF NOT EXISTS worker_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );`,
        `CREATE TABLE IF NOT EXISTS seen_tokens (
          chat_id TEXT NOT NULL,
          token TEXT NOT NULL,
          first_seen_at INTEGER NOT NULL,
          PRIMARY KEY (chat_id, token)
        );`,
        `CREATE TABLE IF NOT EXISTS token_stats (
          token TEXT PRIMARY KEY,
          first_seen_at INTEGER NOT NULL,
          discovered_via TEXT,
          first_m5_vol REAL NOT NULL,
          first_seen_age_min REAL NOT NULL,
          launch_ms INTEGER,
          birdeye_1m_vol REAL,
          rugcheck_bundler_pct REAL,
          rugcheck_top10_pct REAL,
          birdeye_pro_traders INTEGER,
          birdeye_sniper_pct REAL,
          holder_count INTEGER,
          holder_count_at INTEGER,
          min_mcap_observed REAL,
          max_mcap_observed REAL,
          max_liquidity_observed REAL,
          supply_flow TEXT,
          supply_flow_at INTEGER
        );`,
        // Permanent per-tick scan history, so interruptions are visible long
        // after the fact (the scan_heartbeat row only keeps the latest value).
        `CREATE TABLE IF NOT EXISTS scan_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          ok INTEGER NOT NULL,
          ms INTEGER NOT NULL,
          err TEXT,
          profiles INTEGER,
          pool INTEGER,
          candidates INTEGER,
          pushed INTEGER
        );`,
        `CREATE INDEX IF NOT EXISTS idx_scan_history_at ON scan_history(at);`,
        // The re-eval pool query filters token_stats by first_seen_at and
        // anti-joins seen_tokens every tick; these indexes keep it fast as
        // both tables grow (token_stats is pruned each tick).
        `CREATE INDEX IF NOT EXISTS idx_token_stats_first_seen ON token_stats(first_seen_at);`,
        `CREATE INDEX IF NOT EXISTS idx_seen_tokens_token ON seen_tokens(token);`,
        // Trade log: one row per bought token (UNIQUE(token) ⇒ a coin is
        // bought at most once, enforced at the DB layer regardless of mode).
        `CREATE TABLE IF NOT EXISTS trade_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL UNIQUE,
          chat_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          tx_hash TEXT,
          amount_sol REAL NOT NULL,
          slippage_pct REAL NOT NULL,
          error TEXT,
          created_at INTEGER NOT NULL
        );`,
        `CREATE INDEX IF NOT EXISTS idx_trade_log_created ON trade_log(created_at);`,
        // Sell log: every exit attempt (half/all). NOT unique on token — you
        // can legitimately sell half now and the rest later. Mirrors trade_log.
        `CREATE TABLE IF NOT EXISTS sell_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          tx_hash TEXT,
          amount_token REAL,
          error TEXT,
          created_at INTEGER NOT NULL
        );`,
        `CREATE INDEX IF NOT EXISTS idx_sell_log_created ON sell_log(created_at);`,
        // Post-push watch list: every pushed coin is tracked for a bounded
        // window so the bot can report continuation (🚀 rising stages) or
        // breakdown (⚠️ weak / 💀 dead) — the "which pushes keep going"
        // feedback loop. One row per pushed token; refreshed from a single
        // DexScreener batch call per tick (see PushWatcher).
        `CREATE TABLE IF NOT EXISTS push_watch (
          token TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          symbol TEXT,
          pushed_at INTEGER NOT NULL,
          mcap_at_push REAL NOT NULL,
          peak_mcap REAL NOT NULL,
          last_liquidity REAL,
          holders_at_push INTEGER,
          holders_last INTEGER,
          holders_checked_at INTEGER,
          last_checked INTEGER NOT NULL DEFAULT 0,
          last_alert_at INTEGER NOT NULL DEFAULT 0,
          followups_sent INTEGER NOT NULL DEFAULT 0,
          last_state TEXT,
          last_vol_5m REAL,
          dead_trough_mcap REAL,
          sell_dom_streak INTEGER NOT NULL DEFAULT 0,
          last_mcap REAL,
          up_stages TEXT,
          revives_since_up INTEGER NOT NULL DEFAULT 0,
          pool_address TEXT
        );`,
        `CREATE INDEX IF NOT EXISTS idx_push_watch_pushed ON push_watch(pushed_at);`,
        // Pushed-coin top-holder snapshots (wallet analysis, feature C): one
        // row per (pushed token, holder owner) plus the creator row, written
        // at push time. Cross-coin clustering = "same wallets repeatedly
        // appearing across pushed coins" (coordinated-activity detection).
        // Rows are tiny (≤ 9 per push) and pruned after the clustering
        // window, so growth is bounded.
        `CREATE TABLE IF NOT EXISTS pushed_holders (
          token TEXT NOT NULL,
          owner TEXT NOT NULL,
          rank INTEGER NOT NULL,
          ui_amount REAL NOT NULL DEFAULT 0,
          is_creator INTEGER NOT NULL DEFAULT 0,
          crime_hit INTEGER NOT NULL DEFAULT 0,
          pushed_at INTEGER NOT NULL,
          PRIMARY KEY (token, owner)
        );`,
        `CREATE INDEX IF NOT EXISTS idx_pushed_holders_owner ON pushed_holders(owner, pushed_at);`,
        `CREATE INDEX IF NOT EXISTS idx_pushed_holders_at ON pushed_holders(pushed_at);`,
    ];

    // THE BOOT READ (2026-09-29): ONE request answers every question this boot
    // block asks.
    //
    // See the fingerprint gate comment above `ddl`: the marker is one small
    // row (~46 bytes on the wire) against ~8KB of statements, so the gate is
    // worth a read of its own. What the gate is NOT worth is the rest of the
    // block paying a request EACH — and that is what a recycled isolate was
    // billed for. The four questions (the marker, the nine migration flags, the
    // column probe and the telemetry-seed marker) were four sequential Turso
    // round trips because each was written where it was needed instead of where
    // it could be paid for. Measured live 2026-09-29: a cron tick's front split
    // reads `preStart 1006 init 1008` — `init` IS the front — while the
    // Worker's egress measures ~250-290ms per Turso request (`dbTickSteps`).
    // Four of them IS the second. The gate is doing its job inside it
    // (scripts/test-schema-gate.js pins that a SECOND init runs no DDL at all);
    // what was left is the round trips its own legs each paid separately.
    //
    // A libsql batch is ONE HTTP request — the statements run in order on one
    // connection — so the same rows in the same order now cost what the marker
    // read alone used to. Every consumer below takes its slice of that ONE
    // reply. The only path that still pays separately is this batch having
    // FAILED, which is the database whose `worker_state` does not exist yet
    // (the never-initialized one, i.e. the one the DDL below has just created);
    // that path re-reads the flags after the DDL, exactly as it did before.
    const ddlFingerprint = schemaFingerprint(ddl);
    /** One `worker_state` row by key, in the boot batch's own shape. */
    const flagRead = (
      key: string,
    ): { sql: string; args: Array<string | null> } => ({
      sql: "SELECT value FROM worker_state WHERE key = ?",
      args: [key],
    });
    // Slice offsets into the boot batch, named so the readers below cannot
    // drift from the order the statements are sent in (the destructuring used
    // to be positional across two separate arrays — see MIGRATION_FLAG_KEYS).
    const FLAG_INDEX = 1;
    const PROBE_INDEX = FLAG_INDEX + MIGRATION_FLAG_KEYS.length;
    const TELEMETRY_INDEX = PROBE_INDEX + COLUMN_PROBE_TABLES.length;
    let boot: BatchRows | null = null;
    try {
      boot = await c.batch(
        [
          flagRead(SCHEMA_DDL_FINGERPRINT_KEY),
          ...MIGRATION_FLAG_KEYS.map(flagRead),
          ...COLUMN_PROBE_TABLES.map((table) => ({
            sql: "SELECT name FROM pragma_table_info(?)",
            args: [table] as Array<string | null>,
          })),
          flagRead(TELEMETRY_SEED_MARKER_KEY),
        ],
        "read",
      );
    } catch {
      // Every `worker_state` failure mode — table absent (a database that
      // has never been initialized), refused read, timeout — means an
      // UNKNOWN schema, which is exactly when the DDL should run. Swallowing
      // it here is required, not optional: a gate that could throw would
      // turn a cheap optimisation into a way for init to fail on the one
      // database it has never seen.
      //
      // It ALSO means the whole boot read failed, so `flags` below re-reads
      // its slice on its own after the DDL: the pre-2026-09-29 shape, paid only
      // by the one database that has no `worker_state` yet.
      boot = null;
    }
    const bootRes = boot;
    const storedFingerprint =
      bootRes && bootRes[0]?.rows.length > 0
        ? String(bootRes[0].rows[0].value)
        : null;
    if (storedFingerprint !== ddlFingerprint) {
      await c.batch(ddl, "write");
      // Stamped AFTER the batch, so the marker can never claim a schema the
      // database does not have. Best-effort: a refused write only means the
      // next cold isolate pays the DDL again, which is the pre-gate shape.
      try {
        await c.batch(
          [
            {
              sql: "INSERT OR REPLACE INTO worker_state (key, value) VALUES (?, ?)",
              args: [SCHEMA_DDL_FINGERPRINT_KEY, ddlFingerprint],
            },
          ],
          "write",
        );
      } catch {
        /* telemetry-grade: the gate must never be able to fail init */
      }
    }

    // The column probe: the slice the boot read above already carried, but ONLY
    // when the schema those rows describe is the one already in place. On a
    // mismatch they were read BEFORE the DDL landed, so priming the cache with
    // them would answer "column missing" for a column the DDL just added — the
    // silent migration skip scripts/test-schema-gate.js exists to prevent. The
    // carry is dropped in that case and the lazy probe runs after the DDL.
    if (bootRes && storedFingerprint === ddlFingerprint) {
      this.columnProbeRows = COLUMN_PROBE_TABLES.map(
        (_, i) =>
          (bootRes[PROBE_INDEX + i]?.rows ?? []) as Array<
            Record<string, unknown>
          >,
      );
    }

    // The migration flags: the boot read's own slice, or a batch of their own
    // when that read failed (a database with no `worker_state` yet — the one
    // the DDL above has just created). Same rows, same ORDER as before, and the
    // destructuring below is unchanged.
    const flags: BatchRows = bootRes
      ? bootRes.slice(FLAG_INDEX, PROBE_INDEX)
      : await c.batch(MIGRATION_FLAG_KEYS.map(flagRead), "read");
    const settingsV2 =
      flags[0].rows.length > 0 ? String(flags[0].rows[0].value) : null;
    const schemaAlterDone =
      flags[1].rows.length > 0 ? String(flags[1].rows[0].value) : null;
    const schemaAlterV2 =
      flags[2].rows.length > 0 ? String(flags[2].rows[0].value) : null;
    const settingsV3 =
      flags[3].rows.length > 0 ? String(flags[3].rows[0].value) : null;
    const settingsV4 =
      flags[4].rows.length > 0 ? String(flags[4].rows[0].value) : null;
    const schemaAlterV3 =
      flags[5].rows.length > 0 ? String(flags[5].rows[0].value) : null;
    const schemaAlterV4 =
      flags[7].rows.length > 0 ? String(flags[7].rows[0].value) : null;
    const settingsV5 =
      flags[6].rows.length > 0 ? String(flags[6].rows[0].value) : null;
    const settingsV6 =
      flags[8].rows.length > 0 ? String(flags[8].rows[0].value) : null;

    // One-time migration: existing chats keep their old filter values unless
    // reset. The operator specified a new filter profile, so apply it to all
    // chats once; future /filter customizations are preserved after this.
    const d = DEFAULT_SETTINGS;
    if (!settingsV2) {
      await this.get().execute({
        sql: `UPDATE chat_settings SET
          min_market_cap_usd = ?,
          max_market_cap_usd = ?,
          min_age_minutes = ?,
          max_age_minutes = ?,
          min_5m_vol_usd = ?,
          min_5m_chg_pct = ?`,
        args: [
          d.minMarketCapUsd,
          d.maxMarketCapUsd,
          d.minAgeMinutes,
          d.maxAgeMinutes,
          d.min5mVolUsd,
          d.min5mChgPct,
        ],
      });
      await this.setWorkerState("settings_v2_applied", "1");
      console.log("[db] applied new filter defaults to existing chats (settings_v2)");
    }
    // settings_v3: operator lowered the minimum coin age gate 300m→180m.
    // Apply once to existing chats; later /filter customizations are kept.
    if (!settingsV3) {
      await this.get().execute({
        sql: "UPDATE chat_settings SET min_age_minutes = ?",
        args: [d.minAgeMinutes],
      });
      await this.setWorkerState("settings_v3_applied", "1");
      console.log("[db] applied min-age default 180m to existing chats (settings_v3)");
    }
    // settings_v5: operator retuned the profile — $40K–$380K, 80–1260m,
    // $4.5K 5m vol, 20% 5m chg. Apply once to existing chats; later
    // /filter customizations are kept.
    if (!settingsV5) {
      await this.get().execute({
        sql: `UPDATE chat_settings SET
          max_market_cap_usd = ?,
          min_age_minutes = ?,
          max_age_minutes = ?,
          min_5m_vol_usd = ?,
          min_5m_chg_pct = ?`,
        args: [
          d.maxMarketCapUsd,
          d.minAgeMinutes,
          d.maxAgeMinutes,
          d.min5mVolUsd,
          d.min5mChgPct,
        ],
      });
      await this.setWorkerState("settings_v5_applied", "1");
      console.log("[db] applied retuned filter defaults to existing chats (settings_v5)");
    }
    // settings_v4: the liquidity gate shipped defaulted to 0 (= disabled), so
    // zero-liquidity soft-rugs slipped through. Give every chat that never
    // opted into a floor the new $10K default; explicit values are kept.
    if (!settingsV4) {
      await this.get().execute({
        sql: "UPDATE chat_settings SET min_liquidity_usd = ? WHERE min_liquidity_usd = 0",
        args: [d.minLiquidityUsd],
      });
      await this.setWorkerState("settings_v4_applied", "1");
      console.log("[db] applied min-liquidity default to existing chats (settings_v4)");
    }
    // settings_v6: operator widened the age window ceiling 1260m→1560m
    // (21h→26h) — late-blooming runners like GLITCH re-ignited past 21h.
    // Apply once to existing chats; later /filter customizations are kept.
    if (!settingsV6) {
      await this.get().execute({
        sql: "UPDATE chat_settings SET max_age_minutes = ?",
        args: [d.maxAgeMinutes],
      });
      await this.setWorkerState("settings_v6_applied", "1");
      console.log("[db] applied max-age default 1560m to existing chats (settings_v6)");
    }
    // One-time legacy column backfills (databases created before these
    // columns existed). Fresh databases already carry every column in the
    // CREATE TABLE, so this runs at most once per database; bump the flag
    // name (v1→v2…) if new ALTERs are ever added.
    if (!schemaAlterDone) {
      await this.addColumnIfMissing("chat_settings", "min_market_cap_usd", "REAL NOT NULL DEFAULT 40000");
      await this.addColumnIfMissing("chat_settings", "max_market_cap_usd", "REAL NOT NULL DEFAULT 300000");
      await this.addColumnIfMissing("chat_settings", "min_age_minutes", "REAL NOT NULL DEFAULT 180");
      await this.addColumnIfMissing("chat_settings", "max_age_minutes", "REAL NOT NULL DEFAULT 1680");
      await this.addColumnIfMissing("chat_settings", "min_5m_vol_usd", "REAL NOT NULL DEFAULT 6000");
      await this.addColumnIfMissing("chat_settings", "min_5m_chg_pct", "REAL NOT NULL DEFAULT 30");
      await this.addColumnIfMissing("token_stats", "birdeye_1m_vol", "REAL");
      await this.addColumnIfMissing("token_stats", "rugcheck_bundler_pct", "REAL");
      await this.addColumnIfMissing("token_stats", "rugcheck_top10_pct", "REAL");
      await this.addColumnIfMissing("token_stats", "birdeye_pro_traders", "INTEGER");
      await this.addColumnIfMissing("token_stats", "birdeye_sniper_pct", "REAL");
      await this.addColumnIfMissing("token_stats", "min_mcap_observed", "REAL");
      await this.addColumnIfMissing("token_stats", "supply_flow", "TEXT");
      await this.addColumnIfMissing("token_stats", "supply_flow_at", "INTEGER");
      await this.setWorkerState("schema_alter_v1_done", "1");
    }
    // schema_alter_v3: 1h-volume push gate column (default $20K, existing
    // chats inherit the default via the column DEFAULT).
    if (!schemaAlterV3) {
      await this.addColumnIfMissing("chat_settings", "min_1h_vol_usd", "REAL NOT NULL DEFAULT 15000");
      await this.setWorkerState("schema_alter_v3_done", "1");
      console.log("[db] added chat_settings.min_1h_vol_usd (schema_alter_v3)");
    }
    // schema_alter_v4: persistent 🚀 stage memory (announced milestones must
    // survive ⚠️/🔥 overwriting lastState).
    if (!schemaAlterV4) {
      await this.addColumnIfMissing("push_watch", "up_stages", "TEXT");
      await this.setWorkerState("schema_alter_v4_done", "1");
      console.log("[db] added push_watch.up_stages (schema_alter_v4)");
    }
    // v2: store launch_ms (estimated launch time) so the re-eval pool query
    // can use the idx_token_stats_launch index instead of computing
    // (first_seen_at - first_seen_age_min * 60000) on every row (~400K) and
    // sorting the result — the scan's dominant Turso rows-read consumer.
    // Existing rows are backfilled in bounded chunks (a single huge UPDATE
    // could exceed the 15s request timeout on a degraded database). Fresh
    // databases already carry the column from CREATE TABLE, so this is a
    // no-op backfill for them.
    //
    // Only a SMALL slice is kicked off here: a long init eats into the
    // scheduled event's ~30s wall clock before the scan even starts, and a
    // 20s budget on a slow database still leaves ~350K legacy rows undone
    // with no way to resume on a warm isolate (init runs once per isolate;
    // the next chance to continue could be an isolate recycle hours away).
    // The scanner resumes the rest per tick via resumeLaunchBackfill until
    // the flag is set, so legacy rows become visible to the banded pool
    // query within minutes instead of hours.
    if (!schemaAlterV2) {
      await this.addColumnIfMissing("token_stats", "launch_ms", "INTEGER");
      await this.get().execute({
        sql: "CREATE INDEX IF NOT EXISTS idx_token_stats_launch ON token_stats(launch_ms)",
        args: [],
      });
      let done = false;
      const kickBudget = Date.now() + 6_000;
      for (let i = 0; i < 4 && Date.now() < kickBudget; i++) {
        const updated = await this.backfillLaunchChunk();
        if (updated < 5000) {
          done = true; // no NULL rows left — migration complete
          break;
        }
      }
      if (done) {
        await this.setWorkerState("schema_alter_v2_done", "1");
        console.log("[db] launch_ms backfill complete");
      } else {
        console.log("[db] launch_ms backfill started — resuming on later ticks");
      }
    }
    // v3: max_mcap_observed — highest market cap the scanner has ever seen
    // for each coin. The re-eval pool pre-filters on it (coins repeatedly
    // observed far below the qualifying gate stop consuming sweep budget)
    // and orders rotation bands by it, so the LIMIT picks the most promising
    // coins. Unconditional because addColumnIfMissing is idempotent (fresh
    // databases already carry the column from CREATE TABLE).
    await this.addColumnIfMissing("token_stats", "max_mcap_observed", "REAL");
    // Peak-liquidity tracking: the pool pre-filters on it (coins whose peak
    // liquidity never reached the qualifying floor are dead corpses whose
    // huge max_mcap_observed would otherwise rank them FIRST in every band).
    // Unconditional because addColumnIfMissing is idempotent.
    await this.addColumnIfMissing("token_stats", "max_liquidity_observed", "REAL");
    // Recent-liquidity tracking (2026-09-19): how much liquidity each coin
    // ACTUALLY had the last time the scan looked at it (see
    // DEAD_LIQUIDITY_USD). The high-water above cannot answer "is this pool
    // still there?" — this column can, and it is what the pool's dead-pool
    // prune reads. Unconditional because addColumnIfMissing is idempotent.
    await this.addColumnIfMissing("token_stats", "last_liquidity_usd", "REAL");
    // Freshness OF that reading (2026-10-08): how many consecutive pool sweeps
    // have come back with NO reading for this coin (see DEAD_POOL_MISS_MAX).
    // The column above judges what a reading SAID; this one judges whether the
    // reading is still being CONFIRMED — a coin whose pair has vanished never
    // gets a new reading, so without this the last live one vouches for it
    // forever. Unconditional — addColumnIfMissing is idempotent.
    await this.addColumnIfMissing(
      "token_stats",
      "sweeps_since_reading",
      "INTEGER NOT NULL DEFAULT 0",
    );
    // Feed attribution: which discovery feed first registered each coin
    // (per-feed quality stats). Unconditional — idempotent.
    await this.addColumnIfMissing("token_stats", "discovered_via", "TEXT");
    // Holder-count cache columns (2026-09-25): the last count BOUGHT from
    // Birdeye's token_overview and when it was read. §4.15/§4.16 added them
    // for a SHARED cache (the card's enrich and the tracker's holder probe
    // both wrote it, reused inside BIRDEYE_HOLDER_CACHE_MIN); §4.17 retired
    // BOTH ends together with the card's holders line, so nothing reads or
    // writes them today. The columns stay declared — a stale row must not
    // become a schema question — and the tracker keeps its own reading in
    // `push_watch`. Unconditional — idempotent.
    await this.addColumnIfMissing("token_stats", "holder_count", "INTEGER");
    await this.addColumnIfMissing("token_stats", "holder_count_at", "INTEGER");
    // v4: min_1h_chg_pct — the compound momentum gate's 1-hour leg (chat
    // filter). Unconditional because addColumnIfMissing is idempotent.
    await this.addColumnIfMissing(
      "chat_settings",
      "min_1h_chg_pct",
      "REAL NOT NULL DEFAULT 40",
    );
    // push_watch.last_vol_5m — the volume-ignition early-warning signal
    // compares the fresh 5m volume against the previous check's. Idempotent.
    await this.addColumnIfMissing("push_watch", "last_vol_5m", "REAL");
    // push_watch.dead_trough_mcap — the dead-state low anchoring the
    // trough × 1.5 resurrection trigger. Idempotent.
    await this.addColumnIfMissing("push_watch", "dead_trough_mcap", "REAL");
    // push_watch.sell_dom_streak / last_mcap — 🩸 distribution streak + the
    // latest mcap for the 🏁 case-closed recap. Idempotent.
    await this.addColumnIfMissing(
      "push_watch",
      "sell_dom_streak",
      "INTEGER NOT NULL DEFAULT 0",
    );
    await this.addColumnIfMissing("push_watch", "last_mcap", "REAL");
    // push_watch.revives_since_up — the 💪 strong-buy rule's memory (🟢
    // revivals since the last 🚀 runup card). Unconditional because
    // addColumnIfMissing is idempotent; existing rows read the 0 default.
    await this.addColumnIfMissing(
      "push_watch",
      "revives_since_up",
      "INTEGER NOT NULL DEFAULT 0",
    );
    // push_watch.pool_address — the pool a row is PINNED to (the pool its
    // push was based on, see the pool-pinning note in src/pushwatch.ts).
    // Written at enrollment, on a legacy row's first successful check write
    // (COALESCE — the pool it was actually judged on), and on a confirmed
    // pool switch (Db.repinPushWatchPools). NULL = never pinned. Idempotent.
    await this.addColumnIfMissing("push_watch", "pool_address", "TEXT");
    // Telemetry counters: /health used to run COUNT(*) over token_stats
    // (~400K rows) and seen_tokens (~50K rows) on every ping — at the 1-min
    // uptime-monitor cadence that alone is ~600M rows/day (alerted
    // 2026-08-16). Seed the counters once per database here, then keep them
    // fresh with cheap incremental bumps (see bumpTelemetryCounter) so
    // /health reads two tiny worker_state rows instead of two full scans.
    // The seed marker rode the boot read too (see above): on a recycled
    // isolate this was the FOURTH and last request the pre-2026-09-29 init paid
    // separately. A failed boot read falls back to the single-key read, which
    // is the shape every path had before.
    const telemetrySeeded = bootRes
      ? (bootRes[TELEMETRY_INDEX]?.rows.length ?? 0) > 0
        ? String(bootRes[TELEMETRY_INDEX].rows[0].value)
        : null
      : await this.getWorkerState(TELEMETRY_SEED_MARKER_KEY);
    if (!telemetrySeeded) {
      const counts = await c.batch(
        [
          { sql: "SELECT COUNT(*) AS n FROM token_stats", args: [] },
          { sql: "SELECT COUNT(*) AS n FROM seen_tokens", args: [] },
        ],
        "read",
      );
      const n1 = Number(
        (counts[0].rows[0] as { n?: number | bigint } | undefined)?.n ?? 0,
      );
      const n2 = Number(
        (counts[1].rows[0] as { n?: number | bigint } | undefined)?.n ?? 0,
      );
      await c.batch(
        [
          {
            sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES ('telemetry_token_stats_count', ?)",
            args: [String(n1)],
          },
          {
            sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES ('telemetry_seen_tokens_count', ?)",
            args: [String(n2)],
          },
          {
            sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES ('telemetry_counts_seeded_v1', '1')",
            args: [],
          },
        ],
        "write",
      );
    }
  }

  /**
   * Record how much liquidity each evaluated coin ACTUALLY had on this tick
   * (2026-09-19) — the recency signal the pool's dead-pool prune reads (see
   * DEAD_LIQUIDITY_USD).
   *
   * WHY IT IS A SEPARATE WRITE and not part of updateTokenMaxMcaps: that
   * method is a RAISE-ONLY high-water update, and it only receives coins whose
   * mcap or liquidity hit a new high. A pool that drains writes nothing — the
   * corpse keeps its peak forever, which is exactly the escape this column
   * closes. The caller (worker.ts) collects the pair map the scan actually
   * used and sends EVERY coin with a finite reading, so the column tracks the
   * present instead of the best day.
   *
   * One CASE statement per chunk of coins, in ONE round trip: the scan
   * evaluates ~90 pool coins + ~25 feed coins per tick, and the caller fires
   * this AFTER the tick (it can never delay a card's claim). Same
   * fire-and-forget contract as the deferred-write drain: a lost isolate
   * simply re-observes on the next tick.
   *
   * It is also the ONLY thing that clears the freshness mark (2026-10-08):
   * the same statement resets `sweeps_since_reading` to 0, because a reading
   * that arrived IS the proof the pool asked for in the first place. Keeping
   * the reset here rather than in a second statement is what makes the mark
   * impossible to leave stuck on a coin the pair lane is demonstrably still
   * serving (see DEAD_POOL_MISS_MAX).
   */
  async recordObservedLiquidity(
    rows: Array<{ token: string; liquidityUsd: number }>,
    chunk = 120,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    let updated = 0;
    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk);
      const cases = slice.map(() => "WHEN ? THEN ?").join(" ");
      const args: Array<string | number> = [];
      for (const r of slice) args.push(r.token, r.liquidityUsd);
      for (const r of slice) args.push(r.token);
      const res = await this.get().execute({
        sql: `UPDATE token_stats SET last_liquidity_usd = CASE token ${cases} END,
              sweeps_since_reading = 0
              WHERE token IN (${slice.map(() => "?").join(",")})`,
        args,
      });
      updated += Number(res.rowsAffected ?? 0);
    }
    return updated;
  }

  /**
   * Advance the freshness mark for pool coins a sweep ASKED for and got no
   * reading back for (2026-10-08 — see DEAD_POOL_MISS_MAX).
   *
   * The caller is worker.flushObservedLiquidity, from the list the scanner
   * built in poolSweepMisses: pool coins handed to the pair fetch whose token
   * was absent from the answer on a HEALTHY batch. The guard lives in the
   * scanner (it owns the coverage reading); this method only counts what it is
   * given, so the rule and the SQL stay one thing each.
   *
   * A `+ 1` per coin per sweep, chunked into the same one-round-trip shape as
   * recordObservedLiquidity, and fire-and-forget for the same reason: a lost
   * write costs one sweep of freshness on a mark that is recomputed on every
   * rotation, never a wrong verdict. The reset back to 0 is NOT here — only a
   * real reading may clear the mark (see recordObservedLiquidity).
   */
  async noteSweptWithoutReading(tokens: string[], chunk = 120): Promise<number> {
    if (tokens.length === 0) return 0;
    let updated = 0;
    for (let i = 0; i < tokens.length; i += chunk) {
      const slice = tokens.slice(i, i + chunk);
      const res = await this.get().execute({
        sql: `UPDATE token_stats SET sweeps_since_reading = sweeps_since_reading + 1
              WHERE token IN (${slice.map(() => "?").join(",")})`,
        args: [...slice],
      });
      updated += Number(res.rowsAffected ?? 0);
    }
    return updated;
  }

  /**
   * Record that a scheduled cron event arrived — raw upserts that work even
   * BEFORE init() (worker_state exists in every live database; connect() is
   * lazy and needs no DDL). This is the cross-isolate proof that the Cron
   * Trigger is delivering: a slow/failed init otherwise kills the scheduled
   * event inside the ~30s wall clock and cron looks dead from /health even
   * though the trigger fires (observed 2026-08-14).
   */
  async bumpScheduledTick(): Promise<void> {
    const c = this.connect();
    const now = Date.now();
    const nowStr = String(now);
    // ONE read for all three keys + ONE batched write: this runs before
    // every scheduled scan, so its round trips count against the ~30s wall
    // clock (observed 2026-09-03: a 5-round-trip counter pushed the tick's
    // completion write over the edge and dropped history rows).
    const res = await c.execute({
      sql: `SELECT key, value FROM worker_state
            WHERE key IN ('scheduled_tick_total', 'scheduled_tick_at', 'scheduled_tick_ring')`,
      args: [],
    });
    const vals = new Map<string, string>();
    for (const r of res.rows) {
      vals.set(String(r.key), String(r.value));
    }
    const prev = parseInt(vals.get("scheduled_tick_total") ?? "0", 10) || 0;
    // Rolling ring of recent cron delivery times (last 90), so a heartbeat
    // gap is diagnosable afterwards: a gap in the RING = cron didn't
    // deliver; ticks present in the ring but missing from scan_history =
    // ticks arrived but died before the scan completed.
    let ring: number[] = [];
    const rawRing = vals.get("scheduled_tick_ring");
    if (rawRing) {
      try {
        const parsed = JSON.parse(rawRing);
        if (Array.isArray(parsed)) {
          ring = parsed.filter((v): v is number => typeof v === "number");
        }
      } catch {
        // corrupted ring — start fresh
      }
    }
    ring.push(now);
    await c.batch(
      [
        {
          sql: "INSERT INTO worker_state (key, value) VALUES ('scheduled_tick_total', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          args: [String(prev + 1)],
        },
        {
          sql: "INSERT INTO worker_state (key, value) VALUES ('scheduled_tick_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          args: [nowStr],
        },
        {
          sql: "INSERT INTO worker_state (key, value) VALUES ('scheduled_tick_ring', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          args: [JSON.stringify(ring.slice(-90))],
        },
      ],
      "write",
    );
  }

  /**
   * Record a DexScreener batched-endpoint 429, cross-isolate. The scan that
   * trips the limit can run in any isolate, so a per-isolate counter would
   * read 0 from whichever isolate answers /health — the total and the recent
   * event ring live in Turso instead (same shape as bumpScheduledTick: one
   * read for all three keys, one batched write). Cheap by construction: a 429
   * also arms the client's 90s cache-only backoff, so this fires at most a
   * few times an hour even when the shared egress IP is being limited.
   */
  async bumpDex429(at: number): Promise<void> {
    const c = this.connect();
    const res = await c.execute({
      sql: `SELECT key, value FROM worker_state
            WHERE key IN ('dex_429_total', 'dex_429_at', 'dex_429_ring')`,
      args: [],
    });
    const vals = new Map<string, string>();
    for (const r of res.rows) {
      vals.set(String(r.key), String(r.value));
    }
    const prev = parseInt(vals.get("dex_429_total") ?? "0", 10) || 0;
    // Ring of the last 50 rate-limit events, so a burst is diagnosable
    // afterwards (are they clustered around a deploy, a feed storm, or a
    // steady drip?) instead of collapsing into a single "last seen" time.
    let ring: number[] = [];
    const rawRing = vals.get("dex_429_ring");
    if (rawRing) {
      try {
        const parsed = JSON.parse(rawRing);
        if (Array.isArray(parsed)) {
          ring = parsed.filter((v): v is number => typeof v === "number");
        }
      } catch {
        // corrupted ring — start fresh
      }
    }
    ring.push(at);
    await c.batch(
      [
        {
          sql: "INSERT INTO worker_state (key, value) VALUES ('dex_429_total', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          args: [String(prev + 1)],
        },
        {
          sql: "INSERT INTO worker_state (key, value) VALUES ('dex_429_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          args: [String(at)],
        },
        {
          sql: "INSERT INTO worker_state (key, value) VALUES ('dex_429_ring', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          args: [JSON.stringify(ring.slice(-50))],
        },
      ],
      "write",
    );
  }

  /**
   * Columns this isolate has already confirmed exist, keyed
   * `table\0column` (see columnKey). Null until the first probe.
   */
  private columnCache: Set<string> | null = null;

  /**
   * Column rows the boot read ALREADY carried (see Db.init's ONE read). Set
   * only when that read's schema matched the running DDL, consumed by the first
   * readColumnNames() below, and cleared there whatever happens next.
   */
  private columnProbeRows: Array<Array<Record<string, unknown>>> | null = null;

  /**
   * Whether `table.column` exists — WITHOUT a round trip of its own once
   * the cache is primed.
   *
   * WHY THIS EXISTS (2026-09-26, CPU). addColumnIfMissing used to ask the
   * database one column at a time, by attempting an ALTER and reading
   * SQLite's "duplicate column name" as a negative answer: one round trip
   * PER COLUMN on every cold isolate — 26 call sites, 12 reached on this
   * schema. scripts/cpu-profile.js measured a libsql round trip at 2.4-5.8ms
   * of CLIENT CPU even for a 46-byte, one-row reply (the encode/decode, not
   * the network), so the probes alone were ~30-70ms: the largest item left
   * in a tick once the DDL batch went behind a fingerprint. Cloudflare kills
   * these invocations with `exceededResources` at exactly 10,000us, the
   * Workers Free CPU ceiling, while the same minutes' surviving invocations
   * report 13,000-187,000us. The answer is to ask ONCE: one batched read of
   * pragma_table_info for every table this migration touches, then answer
   * every following call from memory.
   */
  private async columnExists(table: string, column: string): Promise<boolean> {
    if (this.columnCache === null) this.columnCache = await this.readColumnNames();
    return this.columnCache.has(columnKey(table, column));
  }

  /**
   * Every column of COLUMN_PROBE_TABLES, in ONE round trip.
   *
   * Best-effort by design: on an unreadable batch it returns an empty set,
   * which makes every following columnExists() false and so reproduces the
   * pre-2026-09-26 behaviour exactly — one ALTER per call, duplicates
   * swallowed — instead of skipping a migration that might be needed. A
   * table the DDL has not created yet returns zero rows (verified against
   * libsql; it does not throw), which is the same answer as an empty table.
   */
  private async readColumnNames(): Promise<Set<string>> {
    const found = new Set<string>();
    // The carry is taken AND CLEARED unconditionally: rows a previous boot left
    // behind must never answer a later probe, and a carry left set after a
    // failure would be reused by the next call as if it were fresh.
    const carried = this.columnProbeRows;
    this.columnProbeRows = null;
    try {
      const rows: Array<ReadonlyArray<Record<string, unknown>>> =
        carried ??
        (
          await this.get().batch(
            COLUMN_PROBE_TABLES.map((table) => ({
              sql: "SELECT name FROM pragma_table_info(?)",
              args: [table],
            })),
            "read",
          )
        ).map((res) => res?.rows ?? []);
      COLUMN_PROBE_TABLES.forEach((table, i) => {
        for (const row of rows[i] ?? []) {
          found.add(columnKey(table, String(row.name ?? "")));
        }
      });
    } catch (err) {
      console.warn(
        "[db] column probe unavailable, falling back to one ALTER per column:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return found;
  }

  private async addColumnIfMissing(
    table: string,
    column: string,
    definition: string,
  ): Promise<void> {
    if (await this.columnExists(table, column)) return;
    try {
      await this.get().execute({
        sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
        args: [],
      });
      // Keep the cache honest for the rest of this isolate's init: without
      // this, a second call for the same column in the same init would pay
      // an ALTER that must fail — the exact cost this cache exists to avoid.
      this.columnCache?.add(columnKey(table, column));
      console.log(`[db] added column ${table}.${column}`);
    } catch (err) {
      // SQLite throws "duplicate column name" when it already exists — fine.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/duplicate column/i.test(msg)) {
        console.warn(`[db] migrate ${table}.${column} skipped:`, msg);
      }
    }
  }

  /**
   * Backfill one bounded chunk of the launch_ms migration (see init and
   * resumeLaunchBackfill). Bounds: the subquery collects at most 5000 NULL
   * rows per call, so a single statement never reads more than a few
   * thousand rows even on a 350K-row table.
   */
  private async backfillLaunchChunk(): Promise<number> {
    const res = await this.get().execute({
      sql: `UPDATE token_stats
            SET launch_ms = first_seen_at - first_seen_age_min * 60000
            WHERE launch_ms IS NULL
              AND token IN (
                SELECT token FROM token_stats WHERE launch_ms IS NULL LIMIT 5000
              )`,
      args: [],
    });
    return Number(res.rowsAffected ?? 0);
  }

  /**
   * Resume the launch_ms backfill migration (see init). Called once per scan
   * tick until the migration flag is set, so a migration that outlived its
   * in-init budget keeps making progress on a warm isolate instead of
   * waiting for the next isolate recycle (legacy rows with NULL launch_ms
   * are invisible to the banded re-eval pool query meanwhile). Bounded: at
   * most 4 chunks or `budgetMs`, whichever comes first, so a slow database
   * can't blow the tick budget. Returns true when the migration is complete
   * (or was already) — the caller caches that so this stops being called.
   * Idempotent and concurrency-safe: chunks are independent, and the flag is
   * only set once no NULL rows remain (a chunk < 5000 means the subquery's
   * LIMIT didn't cap — there are no NULL rows left to collect).
   */
  async resumeLaunchBackfill(
    budgetMs: number,
    front?: ScanFront | null,
  ): Promise<boolean> {
    // The gate rides the front's ONE read on a tick (see readScanFront): this
    // is a per-tick single-row lookup until the flag is set.
    if (await this.gateOf(front, "schema_alter_v2_done")) return true;
    const deadline = Date.now() + budgetMs;
    for (let i = 0; i < 4 && Date.now() < deadline; i++) {
      const updated = await this.backfillLaunchChunk();
      if (updated < 5000) {
        // Queued on the front's ONE batch when a tick is driving (see
        // writeScanFront); a standalone caller writes it here as before.
        await this.frontStamp(front, "schema_alter_v2_done", "1");
        console.log("[db] launch_ms backfill complete");
        return true;
      }
    }
    return false;
  }

  private get(): Client {
    if (!this.client) {
      throw new Error("Database is not initialized");
    }
    return this.scanMode ? this.ensureScanClient() : this.client;
  }

  private mapRow(row: Record<string, unknown>): ChatSettings {
    return {
      chatId: String(row.chat_id),
      minLiquidityUsd: Number(row.min_liquidity_usd ?? 0),
      minVolume24hUsd: Number(row.min_volume_24h_usd ?? 0),
      minMarketCapUsd: Number(row.min_market_cap_usd ?? DEFAULT_SETTINGS.minMarketCapUsd),
      maxMarketCapUsd: Number(row.max_market_cap_usd ?? DEFAULT_SETTINGS.maxMarketCapUsd),
      minAgeMinutes: Number(row.min_age_minutes ?? DEFAULT_SETTINGS.minAgeMinutes),
      maxAgeMinutes: Number(row.max_age_minutes ?? DEFAULT_SETTINGS.maxAgeMinutes),
      min5mVolUsd: Number(row.min_5m_vol_usd ?? DEFAULT_SETTINGS.min5mVolUsd),
      min1hVolUsd: Number(row.min_1h_vol_usd ?? DEFAULT_SETTINGS.min1hVolUsd),
      min5mChgPct: Number(row.min_5m_chg_pct ?? DEFAULT_SETTINGS.min5mChgPct),
      min1hChgPct: Number(row.min_1h_chg_pct ?? DEFAULT_SETTINGS.min1hChgPct),
      enabled: Number(row.enabled) === 1,
    };
  }

  async getChatSettings(chatId: string): Promise<ChatSettings | null> {
    const res = await this.get().execute({
      sql: "SELECT * FROM chat_settings WHERE chat_id = ?",
      args: [chatId],
    });
    const row = res.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async saveChatSettings(settings: ChatSettings): Promise<void> {
    await this.get().execute({
      sql: `
        INSERT INTO chat_settings
          (chat_id, min_liquidity_usd, min_volume_24h_usd,
           min_market_cap_usd, max_market_cap_usd, min_age_minutes, max_age_minutes,
           min_5m_vol_usd, min_1h_vol_usd, min_5m_chg_pct, min_1h_chg_pct, enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
          min_liquidity_usd = excluded.min_liquidity_usd,
          min_volume_24h_usd = excluded.min_volume_24h_usd,
          min_market_cap_usd = excluded.min_market_cap_usd,
          max_market_cap_usd = excluded.max_market_cap_usd,
          min_age_minutes = excluded.min_age_minutes,
          max_age_minutes = excluded.max_age_minutes,
          min_5m_vol_usd = excluded.min_5m_vol_usd,
          min_1h_vol_usd = excluded.min_1h_vol_usd,
          min_5m_chg_pct = excluded.min_5m_chg_pct,
          min_1h_chg_pct = excluded.min_1h_chg_pct,
          enabled = excluded.enabled
      `,
      args: [
        settings.chatId,
        settings.minLiquidityUsd,
        settings.minVolume24hUsd,
        settings.minMarketCapUsd,
        settings.maxMarketCapUsd,
        settings.minAgeMinutes,
        settings.maxAgeMinutes,
        settings.min5mVolUsd,
        settings.min1hVolUsd,
        settings.min5mChgPct,
        settings.min1hChgPct,
        settings.enabled ? 1 : 0,
      ],
    });
  }

  async listEnabledChats(): Promise<ChatSettings[]> {
    const res = await this.get().execute({
      sql: "SELECT * FROM chat_settings WHERE enabled = 1",
      args: [],
    });
    return res.rows.map((row) => this.mapRow(row));
  }

  /**
   * Every chat row regardless of push state (operator diagnostics —
   * /debug/chats). Lets the operator see each chat's full filter profile,
   * including disabled ones, since the pool query bounds use the WIDEST
   * enabled chat and a stale wide chat silently widens the tracked window.
   */
  async listAllChats(): Promise<ChatSettings[]> {
    const res = await this.get().execute({
      sql: "SELECT * FROM chat_settings ORDER BY chat_id",
      args: [],
    });
    return res.rows.map((row) => this.mapRow(row));
  }

  /**
   * Remove a chat entirely (settings + seen history). Returns whether it
   * existed.
   *
   * ONE BATCH, THREE STATEMENTS (2026-09-30): the seen_tokens delete used to
   * land on its own, without moving the counter /health publishes as
   * `pushedTotal` — so every chat removal left that counter high by the chat's
   * row count (measured: 727 against /debug/pushes' 721; the only caller is
   * the /debug/chats?chatId=... DELETE). The release statement is
   * unclaimTokenPush's own constant: `changes()` is the DELETE's row count, so
   * the counter subtracts exactly the rows this batch removed. Riding one
   * batch also means a failed request can never ship half a removal (rows
   * deleted, counter unmoved) — the two travel together or not at all.
   */
  async removeChat(chatId: string): Promise<boolean> {
    const res = await this.get().batch(
      [
        {
          sql: "DELETE FROM chat_settings WHERE chat_id = ?",
          args: [chatId],
        },
        {
          sql: "DELETE FROM seen_tokens WHERE chat_id = ?",
          args: [chatId],
        },
        { sql: CLAIM_COUNTER_RELEASE_SQL, args: [SEEN_TOKENS_COUNT_KEY] },
      ],
      "write",
    );
    return Number(res[0]?.rowsAffected ?? 0) > 0;
  }

  async isTokenSeen(chatId: string, token: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: "SELECT 1 AS seen FROM seen_tokens WHERE chat_id = ? AND token = ? LIMIT 1",
      args: [chatId, token],
    });
    return res.rows.length > 0;
  }

  /**
   * Whether a token was ever pushed to any chat, and when the first push
   * happened (seen_tokens rows are written by markTokenSeen on every push).
   * Used by /flow to mark coins the bot has already alerted on.
   */
  async getTokenPushedInfo(
    token: string,
  ): Promise<{ pushed: boolean; at?: number }> {
    const res = await this.get().execute({
      sql: "SELECT first_seen_at FROM seen_tokens WHERE token = ? ORDER BY first_seen_at LIMIT 1",
      args: [token],
    });
    const row = res.rows[0];
    if (!row) return { pushed: false };
    const at = Number((row as Record<string, unknown>).first_seen_at);
    return Number.isFinite(at) && at > 0
      ? { pushed: true, at }
      : { pushed: true };
  }

  /**
   * Cross-isolate telemetry: Cloudflare Workers isolates have independent
   * module state, so /health on one isolate cannot see counters living on
   * the isolate that ran the scheduled scanner. Persisting the scan
   * heartbeat in Turso makes the scanner observable from anywhere.
   */
  async setWorkerState(key: string, value: string): Promise<void> {
    await this.get().execute({
      sql: "INSERT INTO worker_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [key, value],
    });
  }

  async getWorkerState(key: string): Promise<string | null> {
    const res = await this.get().execute({
      sql: "SELECT value FROM worker_state WHERE key = ?",
      args: [key],
    });
    const row = res.rows[0];
    if (!row) return null;
    const v = (row as Record<string, unknown>).value;
    return v === null || v === undefined ? null : String(v);
  }

  /**
   * Cross-isolate single-flight claim for one full scan pass. The cadence
   * gate (worker_state scan_heartbeat) is a read-then-act check: two
   * isolates can both see the same stale heartbeat and start a full scan
   * within the same second (cron delivery + the HTTP-triggered fallback on
   * different isolates, or parallel uptime-monitor requests) — observed as
   * duplicate scan_history completion rows at the same timestamp
   * (2026-09-03: ~10 double scans in the last 90 rows). Every duplicate
   * burns a second full round of feed calls and Turso rows-read, and its
   * per-candidate Helius/Birdeye work is NOT shielded by the other
   * isolate's in-memory caches.
   *
   * Value format is "<untilMs>|<owner>" — deliberately not JSON, so release
   * can be an exact-value DELETE and a holder can never clear someone
   * else's lock. Claim is insert-or-ignore, then a CAS takeover when the
   * existing row is stale (the holder isolate died inside its scan; the TTL
   * far exceeds the scan envelope). Returns the exact value to pass to
   * releaseScanLock, or null when another isolate holds a live lock. Throws
   * on DB errors — the caller logs and scans anyway (fail-open).
   *
   * WALL-CLOCK DISCIPLINE (2026-09-03 lesson): the scan tick's completion
   * flush lives on a ~1s margin against Cloudflare's invocation kill (~24s
   * effective), so this claim must NOT add round trips to the critical
   * path. When `heartbeatJson` is passed, the claim insert and the
   * start-heartbeat upsert run in ONE batched round trip — the same as the
   * pre-lock single heartbeat write the worker used to make. A dead-tick
   * backfill row (`historyEntry`) rides that SAME batch (2026-09-05: the
   * separate backfill write was pushing the flush past the kill point —
   * zero completions landed for 15+ min). Note that a racing LOSER's batch
   * also stamps the heartbeat: that is fine and accurate — a scan IS
   * running that second (the winner's), the stamp differs only by
   * milliseconds, and the lock still lets exactly one isolate run it. The
   * backfill INSERT is guarded by an EXISTS on OUR lock value so a loser's
   * batch can never duplicate the row (the duplicate-completion-rows
   * problem the lock was built to prevent). The stale-takeover path costs
   * extra reads, but only when a holder isolate died, which is rare.
   */
  async claimScanLock(
    owner: string,
    now: number,
    ttlMs: number,
    heartbeatJson?: string | null,
    historyEntry?: {
      at: number;
      ok: boolean;
      ms: number;
      err: string | null;
      profiles: number | null;
      pool: number | null;
      candidates: number | null;
      pushed: number | null;
    } | null,
    /**
     * Cron-arrival bookkeeping that rides THIS claim batch (see
     * scheduledTickStatements): the caller read the ring with its gate read, so
     * a cron tick's counter/timestamp/ring land with its own first must-land
     * write instead of costing their own round trips.
     */
    cronTick?: ScheduledTickEntry | null,
    /**
     * The tick's ADMISSION stamp (worker.TICK_PROGRESS_KEY), written WITH the
     * claim that admits it (2026-09-26).
     *
     * WHY: the phase ladder's first stamp used to be a request of its own
     * (~150ms after the claim), and its whole reading — "this tick was
     * admitted, the scan not yet entered" — is already written by this batch
     * (the heartbeat below carries the same `at` and `phase: "scanning"`).
     * Measured live 2026-09-26 with the labelled census: the ladder cost FIVE
     * requests per tick, the single largest DB item in a ~21-request tick,
     * and the per-tick census under-read it at 2 because the trail lands
     * after the scan window. Riding the claim makes the stamp free.
     *
     * GUARDED (see historyStmt): the stamp is written only when THIS tick's
     * claim won the lock, so a tick that lost the lease — and therefore
     * skipped the scan — cannot stamp a phase it never reached. A refused
     * batch loses the stamp with the claim: the pre-merge shape (no claim,
     * no admission reading).
     */
    tickProgressJson?: string | null,
  ): Promise<string | null> {
    const value = `${now + ttlMs}|${owner}`;
    const claimStmt: { sql: string; args: Array<string | number | null> } = {
      sql: "INSERT INTO worker_state (key, value) VALUES ('scan_lock', ?) ON CONFLICT(key) DO NOTHING",
      args: [value],
    };
    const heartbeatStmt: { sql: string; args: Array<string | number | null> } | null =
      heartbeatJson
        ? {
            sql: "INSERT INTO worker_state (key, value) VALUES ('scan_heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            args: [heartbeatJson],
          }
        : null;
    const historyStmt: { sql: string; args: Array<string | number | null> } | null =
      historyEntry
        ? {
            sql: `INSERT INTO scan_history (at, ok, ms, err, profiles, pool, candidates, pushed)
                  SELECT ?, 0, ?, ?, NULL, NULL, NULL, NULL
                  WHERE EXISTS (SELECT 1 FROM worker_state WHERE key = 'scan_lock' AND value = ?)`,
            args: [historyEntry.at, historyEntry.ms, historyEntry.err, value],
          }
        : null;
    const progressStmt: { sql: string; args: Array<string | number | null> } | null =
      tickProgressJson
        ? {
            // INSERT..SELECT carries an explicit WHERE because SQLite's
            // UPSERT parser needs one to disambiguate the ON CONFLICT clause
            // (the documented workaround), and that WHERE is the guard: the
            // row lands only while this tick's own lock value is in place.
            sql: `INSERT INTO worker_state (key, value)
                  SELECT 'tick_progress', ?
                  WHERE EXISTS (SELECT 1 FROM worker_state WHERE key = 'scan_lock' AND value = ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            args: [tickProgressJson, value],
          }
        : null;
    const cronStatements = cronTick ? this.scheduledTickStatements(cronTick) : [];
    const winBatch = [
      claimStmt,
      heartbeatStmt,
      historyStmt,
      progressStmt,
      ...cronStatements,
    ].filter(
      (s): s is { sql: string; args: Array<string | number | null> } => s !== null,
    );
    // Winner path: one batched round trip carrying the claim + heartbeat
    // (+ the dead-tick backfill row when a predecessor died mid-scan,
    //  + the caller's cron-arrival bookkeeping).
    if (heartbeatStmt || historyStmt || progressStmt || cronStatements.length > 0) {
      const batch = await this.get().batch(winBatch, "write");
      if (Number(batch[0]?.rowsAffected ?? 0) > 0) return value;
    } else {
      const ins = await this.get().execute(claimStmt);
      if (Number(ins.rowsAffected ?? 0) > 0) return value;
    }
    const cur = await this.get().execute({
      sql: "SELECT value FROM worker_state WHERE key = 'scan_lock'",
      args: [],
    });
    const raw = cur.rows[0]
      ? String((cur.rows[0] as Record<string, unknown>).value ?? "")
      : "";
    if (!raw) {
      // Row vanished between insert and read (owner released mid-claim) —
      // retry once instead of losing this claim to a race.
      if (heartbeatStmt || historyStmt || progressStmt || cronStatements.length > 0) {
        const batch = await this.get().batch(winBatch, "write");
        return Number(batch[0]?.rowsAffected ?? 0) > 0 ? value : null;
      }
      const ins2 = await this.get().execute(claimStmt);
      return Number(ins2.rowsAffected ?? 0) > 0 ? value : null;
    }
    const until = Number(raw.split("|")[0]) || 0;
    if (until > now) return null; // live lock held by another isolate
    // Stale row → CAS takeover (only if nobody else claimed it in between).
    const upd = await this.get().execute({
      sql: "UPDATE worker_state SET value = ? WHERE key = 'scan_lock' AND value = ?",
      args: [value, raw],
    });
    const won = Number(upd.rowsAffected ?? 0) > 0;
    if (won && (heartbeatStmt || historyStmt || progressStmt || cronStatements.length > 0)) {
      // Rare path (dead holder): restore liveness with a separate write —
      // one extra round trip only when a takeover actually happens. The
      // ADMISSION stamp rides it for the same reason it rides the win path
      // (2026-09-26): the takeover UPDATE above already put this tick's lock
      // value in place, so the stamp's guard sees it.
      try {
        await this.get().batch(
          [heartbeatStmt, historyStmt, progressStmt, ...cronStatements].filter(
            (s): s is { sql: string; args: Array<string | number | null> } => s !== null,
          ),
          "write",
        );
      } catch {
        /* heartbeat is best-effort — the scan still proceeds */
      }
    }
    return won ? value : null;
  }

  /**
   * Release a scan lock this isolate acquired (exact-value delete — a stale
   * value is a no-op, so a slow old holder can never clear a new owner).
   */
  async releaseScanLock(value: string): Promise<void> {
    await this.get().execute({
      sql: "DELETE FROM worker_state WHERE key = 'scan_lock' AND value = ?",
      args: [value],
    });
  }

  /** All pushed rows in seen_tokens, oldest first (telemetry for /debug/pushes). */
  async listSeenTokens(): Promise<{ chatId: string; token: string; firstSeenAt: number }[]> {
    try {
      const res = await this.get().execute({
        sql: "SELECT chat_id, token, first_seen_at FROM seen_tokens ORDER BY first_seen_at ASC",
        args: [],
      });
      return res.rows.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          chatId: String(r.chat_id ?? ""),
          token: String(r.token ?? ""),
          firstSeenAt: Number(r.first_seen_at ?? 0),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Atomically add `delta` to a worker_state integer counter. Used to keep
   * the /health table counts (countSeenTokens/countTokenStats) fresh without
   * a COUNT(*) per read. The upsert-add is atomic in SQLite, so concurrent
   * isolates can never lose an increment (a read-modify-write could).
   * Telemetry only — a failed bump must never fail the write it follows.
   *
   * PUBLIC because there is a second ADD path with the same contract:
   * Scanner.stampListCacheDelta writes its counters through this method when
   * the scanner has no front (a standalone Scanner, see Scanner.stampFront).
   * The SQL is inside, so the two paths cannot come to disagree about what an
   * ADD is — and the swallowing above is exactly what that path needs.
   */
  async bumpTelemetryCounter(
    key: string,
    delta: number,
  ): Promise<void> {
    if (delta === 0) return;
    try {
      await this.get().execute({
        sql: `INSERT INTO worker_state (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET
                value = CAST(value AS INTEGER) + excluded.value`,
        args: [key, String(delta)],
      });
    } catch (err) {
      console.warn(`[db] telemetry counter ${key} bump failed:`, err);
    }
  }

  /**
   * Read a cached table count (worker_state integer), falling back to a live
   * COUNT(*) only when the cache is missing (e.g. a database seeded before
   * the counters existed). /health hits this on every ping, so the common
   * path must be the single-row read, never a full table scan.
   */
  private async readTelemetryCounter(
    key: string,
    fallbackSql: string,
  ): Promise<number> {
    let cached: number | null = null;
    try {
      cached = parseTelemetryCounter(await this.getWorkerState(key));
    } catch {
      // fall through to the live count
    }
    // Self-heal (2026-09-11): the counter tracks a row COUNT, so it can
    // never legitimately go negative. A negative cached value means the
    // incremental bumps drifted past zero (prune deletions outweighing
    // inserts across isolates — observed telemetry_token_stats_count =
    // -3105), at which point every later bump is also off. Reconcile once
    // per negative read: live COUNT(*) becomes the new truth and re-seeds
    // the counter. Best-effort telemetry — if the live count fails, return
    // the cached value rather than 0. The missing-cache path keeps the old
    // behavior (no re-seed — the schema seed owns initial population).
    if (cached === null || cached < 0) {
      try {
        const res = await this.get().execute({ sql: fallbackSql, args: [] });
        const row = res.rows[0] as { n?: number | bigint } | undefined;
        const live = Number(row?.n ?? 0);
        if (cached !== null && cached < 0) {
          await this.setWorkerState(key, String(live));
        }
        return live;
      } catch {
        return cached ?? 0;
      }
    }
    return cached;
  }

  /** Total pushed rows in seen_tokens (telemetry for /health). */
  async countSeenTokens(): Promise<number> {
    return this.readTelemetryCounter(
      "telemetry_seen_tokens_count",
      "SELECT COUNT(*) AS n FROM seen_tokens",
    );
  }

  /** Total rows in token_stats (telemetry for /health — pool coverage). */
  async countTokenStats(): Promise<number> {
    return this.readTelemetryCounter(
      TOKEN_STATS_COUNT_KEY,
      "SELECT COUNT(*) AS n FROM token_stats",
    );
  }

  /**
   * Re-derive BOTH cached table counters from live COUNT(*)s and re-seed their
   * rows, at most once per TELEMETRY_RECONCILE_INTERVAL_MS. Returns the counts
   * it wrote, or null when it was not due (or the live read failed).
   *
   * WHY A RE-DERIVATION AND NOT AN ADDITIVE REPAIR: the counters are maintained
   * by incremental bumps, and readTelemetryCounter only self-heals a NEGATIVE
   * value, so a positive gap (measured: tokenStatsCount 6,884 below the live
   * COUNT(*) across 8 paired samples over 11 minutes — see
   * TELEMETRY_RECONCILE_INTERVAL_MS) has no repair path at all. Every table write in this file bumps, so an ADD would
   * have to know WHICH writer skipped its bump, and how much; a whole-table
   * COUNT(*) does not have to know anything. That is why this exists once an
   * hour rather than on the tick.
   *
   * NOT ATOMIC, on purpose and bounded: a bump landing between the COUNT(*) and
   * the re-seed is lost (the row is overwritten, not added to), so the error is
   * whatever one tick inserted in those few milliseconds — and it is
   * re-derived, never compounded, by the next reconcile. The incremental path stays the fresh one; this is
   * the drift floor under it.
   *
   * Also what repaired the seen_tokens side of the same bug in production: the
   * counter is bumped by markTokenSeen/claimTokenPush, and Db.removeChat used to
   * delete a chat's rows without decrementing, so `pushedTotal` read high after
   * every chat removal (measured before this shipped: 727 against
   * /debug/pushes' 721). That writer is fixed as of 2026-09-30 — its DELETE
   * rides one batch
   * with the release statement (see removeChat) — and this reconcile remains
   * the floor under both counters.
   *
   * Cost when due: one single-row read (the gate), then TWO requests — one read
   * batch for both counts, one write batch for both re-seeds plus the stamp —
   * which is what makes an hourly scan of two ~50K-row tables affordable. When
   * not due (the 11/12 of passes either side of the hour): one single-row read.
   */
  async reconcileTelemetryCounts(
    now: number,
  ): Promise<{ tokens: number; seen: number } | null> {
    let lastRaw: string | null = null;
    try {
      lastRaw = await this.getWorkerState(TELEMETRY_RECONCILE_AT_KEY);
    } catch {
      // A failed gate read is a pass that cannot prove it is due. Take the
      // audit-due direction (run it): the cost is one scan per pass instead of
      // one per hour, and a database that cannot answer even this is already
      // being reported as unhealthy everywhere else.
      lastRaw = null;
    }
    if (
      lastRaw !== null &&
      Number.isFinite(Number(lastRaw)) &&
      now - Number(lastRaw) < TELEMETRY_RECONCILE_INTERVAL_MS
    ) {
      return null; // not due yet
    }
    let counts: { tokens: number; seen: number };
    try {
      const res = await this.get().batch(
        [
          { sql: "SELECT COUNT(*) AS n FROM token_stats", args: [] },
          { sql: "SELECT COUNT(*) AS n FROM seen_tokens", args: [] },
        ],
        "read",
      );
      const count = (batchRes: typeof res, i: number): number =>
        Number(
          (batchRes[i]?.rows[0] as { n?: number | bigint } | undefined)?.n ?? 0,
        );
      counts = { tokens: count(res, 0), seen: count(res, 1) };
    } catch (err) {
      console.warn("[db] telemetry reconcile count failed:", err);
      return null;
    }
    try {
      await this.setWorkerStatesMany([
        { key: TOKEN_STATS_COUNT_KEY, value: String(counts.tokens) },
        { key: SEEN_TOKENS_COUNT_KEY, value: String(counts.seen) },
        { key: TELEMETRY_RECONCILE_AT_KEY, value: String(now) },
      ]);
    } catch (err) {
      console.warn("[db] telemetry reconcile write failed:", err);
      return null;
    }
    return counts;
  }

  /**
   * Everything /health reads in ONE round trip (2026-09-26).
   *
   * The page's forensic rows are read by an uptime monitor once a minute,
   * and they used to arrive as two batched reads plus four single-key reads
   * (~6 round trips, ~15-20ms of CPU at the 2.4-5.8ms scripts/cpu-profile.js
   * measures per round trip) — under the same 10ms Workers Free ceiling that
   * Cloudflare has been killing this Worker's invocations for. Same shape as
   * Db.readScanFront: one batch, one request, and the caller passes the keys
   * it needs so the list stays visible where it is used.
   *
   * `enabledChats` is a COUNT, not the listing: /health only ever used the
   * length of listEnabledChats, so the row mapping was decoded for nothing.
   *
   * Failure is all-or-nothing, like every other batched read here: the caller
   * catches once and the page renders with nulls, which is what its per-block
   * try/catch already did for the reads that lived in separate requests.
   */
  async readHealthFront(keys: readonly string[]): Promise<{
    states: Map<string, string>;
    enabledChats: number;
  }> {
    const state = {
      sql: `SELECT key, value FROM worker_state WHERE key IN (${keys
        .map(() => "?")
        .join(",")})`,
      args: [...keys] as Array<string | number | null>,
    };
    const chats = {
      sql: "SELECT COUNT(*) AS n FROM chat_settings WHERE enabled = 1",
      args: [] as Array<string | number | null>,
    };
    const res = await this.get().batch([state, chats], "read");
    const states = new Map<string, string>();
    for (const row of res[0]?.rows ?? []) {
      const r = row as Record<string, unknown>;
      states.set(String(r.key), String(r.value));
    }
    const counted = res[1]?.rows?.[0] as { n?: number | bigint } | undefined;
    return { states, enabledChats: Number(counted?.n ?? 0) };
  }

  /**
   * Last N scan-history rows (newest first) for gap forensics — the data
   * behind /debug/scan-history. A gap in these rows while the tick ring
   * (scheduled_tick_ring) shows deliveries means ticks died before the
   * heartbeat/history write (init stall or wall-clock kill), not that cron
   * stopped.
   */
  async getScanHistory(limit = 120): Promise<
    Array<{
      at: number;
      ok: boolean;
      ms: number;
      err: string | null;
      profiles: number | null;
      pool: number | null;
      candidates: number | null;
      pushed: number | null;
    }>
  > {
    const res = await this.get().execute({
      sql: `SELECT at, ok, ms, err, profiles, pool, candidates, pushed
            FROM scan_history ORDER BY at DESC LIMIT ?`,
      args: [limit],
    });
    return res.rows.map((r) => ({
      at: Number(r.at),
      ok: Number(r.ok) === 1,
      ms: Number(r.ms),
      err: r.err === null ? null : String(r.err),
      profiles: r.profiles === null ? null : Number(r.profiles),
      pool: r.pool === null ? null : Number(r.pool),
      candidates: r.candidates === null ? null : Number(r.candidates),
      pushed: r.pushed === null ? null : Number(r.pushed),
    }));
  }

  /**
   * In-memory mirror of history_last_prune: the prune check used to read
   * worker_state on EVERY insert, adding a Turso round-trip to the tick's
   * completion path (which must fit in the ~30s wall clock — observed
   * 2026-09-03: tail DB writes losing that race dropped completion rows).
   * Re-check the worker_state gate at most once per hour per isolate; the
   * DELETE itself stays gated by the DB-side timestamp, once per day.
   */
  private lastHistoryPruneCheckAt = 0;

  /**
   * Persist one tick's completion in a SINGLE batched round trip — the
   * scan_heartbeat upsert plus the scan_history insert. Called from the
   * tick's finally: pre-race work is kept lean (batched scheduled counter,
   * no redundant reads) so the race budget + this one write fits inside
   * Cloudflare's ~30s wall clock, and the completion always lands on the
   * isolate that ran the scan (a deferred cross-isolate flush strands rows
   * when ticks land on different isolates — observed 2026-09-03). The prune
   * gate is re-checked at most once per hour per isolate.
   */
  async persistScanCompletion(
    heartbeatJson: string,
    history: {
      at: number;
      ok: boolean;
      ms: number;
      err: string | null;
      profiles: number | null;
      pool: number | null;
      candidates: number | null;
      pushed: number | null;
    } | null,
    /**
     * Exact value of the scan lock this isolate holds (see
     * claimScanLock). When provided, its release DELETE rides in the same
     * completion batch — the tick's end-of-scan cost stays ONE round trip
     * (no extra write on the wall-clock-critical path). Null when the scan
     * ran without a lock (fail-open claim error).
     */
    scanLockValue: string | null = null,
    /**
     * Which invocation ran the scan (see ScanTrigger). When given, the matching
     * counter increments IN THIS BATCH — the attribution rides the round trip
     * the flush already pays, and it commits in the same transaction that
     * publishes the completion, so a completion that lands is a completion that
     * is counted. Null = do not count (heartbeat-only flushes are not scans).
     */
    via: ScanTrigger | null = null,
  ): Promise<void> {
    const c = this.get();
    const ops: Array<{
      sql: string;
      args: Array<string | number | null>;
    }> = [
      {
        sql: "INSERT INTO worker_state (key, value) VALUES ('scan_heartbeat', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        args: [heartbeatJson],
      },
    ];
    if (scanLockValue) {
      ops.push({
        sql: "DELETE FROM worker_state WHERE key = 'scan_lock' AND value = ?",
        args: [scanLockValue],
      });
    }
    if (via !== null && history !== null) {
      // Attribution rides the flush (see ScanTrigger): zero extra round trips,
      // and only a completion that is being written is counted — keyed on its
      // own `at` so a retried flush cannot count it twice.
      ops.push(...scanTriggerStatements(via, history.at));
    }
    if (history) {
      // Idempotent insert: clear any row with the same timestamp first (the
      // batch runs as one transaction), so the worker's flush retry after a
      // committed-but-response-lost first attempt can never duplicate a
      // scan_history row.
      ops.push({
        sql: "DELETE FROM scan_history WHERE at = ?",
        args: [history.at],
      });
      ops.push({
        sql: `INSERT INTO scan_history (at, ok, ms, err, profiles, pool, candidates, pushed)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          history.at,
          history.ok ? 1 : 0,
          history.ms,
          history.err,
          history.profiles,
          history.pool,
          history.candidates,
          history.pushed,
        ],
      });
    }
    await c.batch(ops, "write");
    // Prune gate — cheap on the hot path: one read per hour per isolate at
    // most; the DELETE itself stays gated by the DB timestamp (once/day).
    // Dead-tick fix 2026-09-13: skip the prune-check read entirely on a
    // heartbeat-only flush (history=null) — one less unraced await on the
    // wall-clock-critical flush path; hourly housekeeping can wait.
    if (!history) {
      return;
    }
    if (Date.now() - this.lastHistoryPruneCheckAt < 3600_000) return;
    this.lastHistoryPruneCheckAt = Date.now();
    const lastPrune = await this.getWorkerState("history_last_prune");
    if (!lastPrune || Date.now() - Number(lastPrune) > 24 * 3600_000) {
      await c.execute({
        sql: "DELETE FROM scan_history WHERE at < ?",
        args: [Date.now() - 30 * 24 * 3600_000],
      });
      await this.setWorkerState("history_last_prune", String(Date.now()));
    }
  }

  /** Record a Trojan buy attempt (UNIQUE(token): one row per coin). */
  async recordTrade(entry: {
    token: string;
    chatId: string;
    mode: "auto" | "manual";
    status: "success" | "failed";
    txHash: string | null;
    amountSol: number;
    slippagePct: number;
    error: string | null;
  }): Promise<void> {
    await this.get().execute({
      sql: `INSERT OR IGNORE INTO trade_log
            (token, chat_id, mode, status, tx_hash, amount_sol, slippage_pct, error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.token,
        entry.chatId,
        entry.mode,
        entry.status,
        entry.txHash,
        entry.amountSol,
        entry.slippagePct,
        entry.error,
        Date.now(),
      ],
    });
  }

  /** Whether a buy was ever attempted for this token (any chat, any mode). */
  async hasTraded(token: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: "SELECT 1 AS seen FROM trade_log WHERE token = ? LIMIT 1",
      args: [token],
    });
    return res.rows.length > 0;
  }

  /** Number of buy attempts since `sinceMs` (rolling daily-budget guard). */
  async countTradesSince(sinceMs: number): Promise<number> {
    const res = await this.get().execute({
      sql: "SELECT COUNT(*) AS n FROM trade_log WHERE created_at >= ?",
      args: [sinceMs],
    });
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? Number(row.n ?? 0) : 0;
  }

  /**
   * Telegram-set trade-mode override (worker_state key trade_mode_override).
   * Takes precedence over the env TRADE_MODE var in every money-moving path;
   * null means "no override — use the env config". Invalid stored values
   * (e.g. a stale hand edit) are ignored and treated as no override — the
   * rule itself lives in parseTradeModeOverride, so a reader that already
   * holds the raw row (a batch, see docs/round-trips.md §4.25) applies
   * exactly the same one instead of re-reading this row.
   */
  async getTradeModeOverride(): Promise<"off" | "manual" | "auto" | null> {
    return parseTradeModeOverride(await this.getWorkerState("trade_mode_override"));
  }

  /** Persist (or clear, when null) the Telegram trade-mode override. */
  async setTradeModeOverride(
    mode: "off" | "manual" | "auto" | null,
  ): Promise<void> {
    if (mode === null) {
      await this.get().execute({
        sql: "DELETE FROM worker_state WHERE key = ?",
        args: ["trade_mode_override"],
      });
      return;
    }
    await this.setWorkerState("trade_mode_override", mode);
  }

  /** Record a sell attempt (half/all) — no UNIQUE: sells can repeat. */
  async recordSell(entry: {
    token: string;
    chatId: string;
    mode: "half" | "all";
    status: "success" | "failed";
    txHash: string | null;
    amountToken: number | null;
    error: string | null;
  }): Promise<void> {
    await this.get().execute({
      sql: `INSERT INTO sell_log
            (token, chat_id, mode, status, tx_hash, amount_token, error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        entry.token,
        entry.chatId,
        entry.mode,
        entry.status,
        entry.txHash,
        entry.amountToken,
        entry.error,
        Date.now(),
      ],
    });
  }

  /** Most recent sell attempts (newest first) for diagnostics. */
  async latestSells(
    limit: number,
  ): Promise<Array<{ token: string; status: string; txHash: string | null; mode: string; error: string | null; createdAt: number }>> {
    const res = await this.get().execute({
      sql: "SELECT token, mode, status, tx_hash, error, created_at FROM sell_log ORDER BY created_at DESC LIMIT ?",
      args: [Math.max(1, Math.min(limit, 50))],
    });
    return res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        mode: String(r.mode),
        status: String(r.status),
        txHash: r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
        error: r.error === null || r.error === undefined ? null : String(r.error),
        createdAt: Number(r.created_at),
      };
    });
  }

  /** Most recent trade attempts (newest first) for diagnostics. */
  async latestTrades(
    limit: number,
  ): Promise<Array<{ token: string; status: string; txHash: string | null; mode: string; error: string | null; createdAt: number }>> {
    const res = await this.get().execute({
      sql: "SELECT token, mode, status, tx_hash, error, created_at FROM trade_log ORDER BY created_at DESC LIMIT ?",
      args: [Math.max(1, Math.min(limit, 50))],
    });
    return res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        mode: String(r.mode),
        status: String(r.status),
        txHash: r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
        error: r.error === null || r.error === undefined ? null : String(r.error),
        createdAt: Number(r.created_at),
      };
    });
  }

  async markTokenSeen(chatId: string, token: string): Promise<void> {
    const res = await this.get().execute({
      sql: "INSERT OR IGNORE INTO seen_tokens (chat_id, token, first_seen_at) VALUES (?, ?, ?)",
      args: [chatId, token, Date.now()],
    });
    // Keep the /health count fresh (INSERT OR IGNORE: rowsAffected 0 when
    // the coin was already marked — e.g. a re-push guard — so no bump).
    await this.bumpTelemetryCounter(
      "telemetry_seen_tokens_count",
      Number(res.rowsAffected ?? 0),
    );
  }

  /**
   * Atomic push claim: INSERT OR IGNORE into seen_tokens BEFORE sending the
   * card. Overlapping scans (deploy soft-switch isolates, cron + /health
   * both driving a tick) can all pass the isTokenSeen check-then-act window,
   * but only one caller wins this insert — duplicate push cards become
   * impossible at the storage layer. On failed delivery call
   * unclaimTokenPush so the chat-aware re-eval pool can retry later.
   *
   * ONE ROUND TRIP, NOT TWO (2026-09-29). The claim used to be the insert
   * followed by an AWAITED bumpTelemetryCounter — two sequential Turso
   * requests — while the push path gives the claim a 400ms slice
   * (scanner.CARD_CLAIM_BUDGET_MS). The Worker does not run next to the
   * database (live: ATL/DFW/MIA/DUB/SYD isolates against an
   * `aws-ap-northeast-1` database, with a single `poolMs` batch request
   * measuring 0-812ms), so a second round trip was enough to push a healthy
   * claim past its bound and DEFER the card — the `deferred:1` per tick and
   * `/debug/deferral.pending` shape this batching exists to remove. A libsql
   * batch is ONE HTTP request (the statements run in order on one
   * connection), so the slice now covers what it was calibrated for.
   *
   * The counter must still move only when the insert WON, and a batch cannot
   * branch in TypeScript before it is sent — so the second statement asks
   * SQLite itself: `changes()` is the row count of the statement just
   * completed (1 when the insert landed, 0 when OR IGNORE skipped it). A lost
   * claim therefore adds exactly what the guarded bump added, and the winning
   * result is still read from the first statement's rowsAffected.
   */
  async claimTokenPush(chatId: string, token: string): Promise<boolean> {
    const res = await this.get().batch(
      [
        {
          sql: "INSERT OR IGNORE INTO seen_tokens (chat_id, token, first_seen_at) VALUES (?, ?, ?)",
          args: [chatId, token, Date.now()],
        },
        { sql: CLAIM_COUNTER_UPSERT_SQL, args: [SEEN_TOKENS_COUNT_KEY] },
      ],
      "write",
    );
    return Number(res[0]?.rowsAffected ?? 0) > 0;
  }

  /**
   * Release a push claim after a failed delivery (retry stays possible).
   *
   * Same one-round-trip shape as claimTokenPush — the delete and the counter
   * ride one batch, with `changes()` supplying the delta instead of a second
   * awaited call. It lands a small correctness fix on the way: the old version
   * always subtracted 1, even for a release whose row never existed
   * ("deleting a row that never landed is a no-op", see boundClaim), which
   * walked the cached count down over time. Subtracting the DELETE's own row
   * count keeps the counter equal to the table.
   */
  async unclaimTokenPush(chatId: string, token: string): Promise<void> {
    await this.get().batch(
      [
        {
          sql: "DELETE FROM seen_tokens WHERE chat_id = ? AND token = ?",
          args: [chatId, token],
        },
        { sql: CLAIM_COUNTER_RELEASE_SQL, args: [SEEN_TOKENS_COUNT_KEY] },
      ],
      "write",
    );
  }

  /**
   * Times the round-trip shapes the tick's hot path depends on, FROM THIS
   * ISOLATE — the only place a Worker->Turso measurement means anything (a
   * laptop or CI box reaches the database over a different path).
   *
   * Read-mostly by construction: the only writes touch worker_state probe rows
   * (see src/dblatency.ts), never a table the push path reads, and the claim's
   * own table is deliberately absent.
   *
   * It also CHECKS the batched claim's arithmetic instead of trusting it. Each
   * sample inserts under a fresh key, so the two-trip shape's insert wins
   * (changes() = 1 → the counter moves once) and the one-trip shape's insert on
   * that same key loses (changes() = 0 → the counter must NOT move). The
   * counter is read before and after and handed back with the samples, where
   * dblatency.changesVerdict turns "2 per sample" into verified / mismatch.
   *
   * A failed sample is recorded as its wall time instead of thrown: a call
   * that timed out IS the reading this probe is looking for, and one bad op
   * must not cost the whole report.
   */
  async measureLatency(
    samples: number = DB_LATENCY_SAMPLES,
  ): Promise<DbLatencyMeasurement> {
    const n = clampLatencySamples(samples);
    const raw: DbLatencyRaw = {};
    const counterBefore = await this.readProbeCounter();
    const nonce = Date.now().toString(36);
    const keys: string[] = [];
    const time = async (
      op: DbLatencyOp,
      fn: () => Promise<unknown>,
    ): Promise<void> => {
      const t0 = Date.now();
      try {
        await fn();
      } catch {
        // The wait is the measurement; the error is not this probe's business.
      }
      const list = raw[op] ?? (raw[op] = []);
      list.push(Date.now() - t0);
    };
    for (let i = 0; i < n; i++) {
      // FRESH key per sample: that is what makes the two shapes differ in a
      // way the counter can see (see the method doc). The rows are deleted at
      // the end of the call, so nothing accumulates but the counter.
      const key = `${DB_LATENCY_PROBE_KEY}:${nonce}:${i}`;
      keys.push(key);
      const insertProbe = {
        sql: "INSERT OR IGNORE INTO worker_state (key, value) VALUES (?, ?)",
        args: [key, "0"],
      };
      // The claim's OWN statement, on a probe row: the probe exists to prove
      // this SQL, so it must not carry a second copy of it.
      const countProbe = {
        sql: CLAIM_COUNTER_UPSERT_SQL,
        args: [DB_LATENCY_PROBE_COUNT_KEY],
      };
      const bumpProbe = {
        sql: `INSERT INTO worker_state (key, value) VALUES (?, 1)
              ON CONFLICT(key) DO UPDATE SET
                value = CAST(value AS INTEGER) + 1`,
        args: [DB_LATENCY_PROBE_COUNT_KEY],
      };
      // Re-read per sample so a mid-probe rebuild of the client (dead-tick
      // reset) cannot leave the rest of the report measuring a dead proxy.
      const c = this.get();
      await time("select1", () => c.execute("SELECT 1"));
      await time("readRow", () =>
        c.execute({
          sql: "SELECT value FROM worker_state WHERE key = ?",
          args: ["scan_heartbeat"],
        }),
      );
      await time("writeUpsert", () => c.execute(bumpProbe));
      // The claim's two shapes, statement for statement. Two requests vs one
      // is the ONLY difference, which is what CARD_CLAIM_BUDGET_MS cares
      // about.
      await time("claimShapeTwoTrip", async () => {
        await c.execute(insertProbe);
        await c.execute(countProbe);
      });
      await time("claimShapeOneTrip", () =>
        c.batch([insertProbe, countProbe], "write"),
      );
    }
    const counterAfter = await this.readProbeCounter();
    // One request retires this call's rows. A leftover probe row would be
    // inert, so a failure here never fails the report.
    try {
      await this.get().batch(
        keys.map((key) => ({
          sql: "DELETE FROM worker_state WHERE key = ?",
          args: [key],
        })),
        "write",
      );
    } catch {
      /* inert leftover */
    }
    return { samples: n, raw, counterBefore, counterAfter };
  }

  /**
   * The probe's counter row as a number (see measureLatency). An absent row is
   * 0 — the probe's first call has none yet, and that is a real reading. An
   * unreadable row is null, which makes changesVerdict answer "unavailable"
   * instead of inventing a verdict from a guess.
   */
  private async readProbeCounter(): Promise<number | null> {
    try {
      const raw = await this.getWorkerState(DB_LATENCY_PROBE_COUNT_KEY);
      if (raw === null || raw === undefined || raw === "") return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Delivery audit ring (worker_state JSON, last N entries): records the
   * Telegram message_id returned by each successful initial push card send,
   * so a "never received the first card" report (XST, GLITCH) can be
   * answered definitively — "sent at T, Telegram accepted it as message M"
   * — instead of inferred from indirect evidence. Read-modify-write is
   * acceptable here: the audit is best-effort diagnostics and losing an
   * entry to a cross-isolate race is fine.
   */
  async recordPushDelivery(entry: {
    chatId: string;
    token: string;
    symbol: string | null;
    messageId: number;
    mcapAtPush?: number;
    /** "initial" = first push card (scanner); "followup" = tracker alert. */
    kind?: string;
    /**
     * The tracker card's transition signature (see CUT_MARK_PREFIX in
     * src/pushwatch.ts): the identity a re-derivation of the SAME card can be
     * matched against, so a proof can only ever stand for the transition it is
     * about (deferrallog.deliveredFollowupProofs). Untagged entries are indexed
     * under the token alone — the coarse rule this key replaced.
     */
    sig?: string;
  }): Promise<void> {
    const raw = await this.getWorkerState("push_audit");
    let list: unknown[] = [];
    try {
      list = raw ? (JSON.parse(raw) as unknown[]) : [];
    } catch {
      list = [];
    }
    list.push({ ...entry, at: Date.now() });
    // 200, not 30: this ONE row is shared by every chat and every card kind,
    // so on a busy day a 30-entry ring covered minutes — and the question it
    // exists to answer ("did coin X get its +200% card an hour ago?") spans
    // hours. Live 2026-09-25: parafactual's up400 card was the ring's only
    // entry for the token, with its earlier stages long rolled out. The
    // readers that only need INITIAL cards (hasInitialPushAudit /
    // getInitialPushAuditTokens) are strictly better off with a wider window.
    if (list.length > Db.PUSH_AUDIT_MAX) list = list.slice(-Db.PUSH_AUDIT_MAX);
    await this.setWorkerState("push_audit", JSON.stringify(list));
  }

  /**
   * Whether a token has an "initial" delivery-audit entry — i.e. Telegram
   * verifiably accepted its first card. A claimed-but-unaudited recent
   * push means the sending isolate died mid-request (deploy eviction) and
   * the card never went out; the self-heal uses this to re-send instead
   * of silently enrolling tracking for a card nobody ever received.
   */
  async hasInitialPushAudit(token: string): Promise<boolean> {
    return (await this.getInitialPushAuditTokens()).has(token);
  }

  /**
   * Every token with an "initial" audit entry, in ONE read. The self-heal
   * asks this per candidate coin, and each ask re-read the SAME worker_state
   * row (up to 10 identical round trips on a pass that only has ~1s of tick
   * budget) — the same merge as the rest of this change (2026-09-17).
   */
  async getInitialPushAuditTokens(): Promise<Set<string>> {
    // The rule is initialPushAuditTokens, shared with the tracker heal's
    // CARRIED read (see findUntrackedPushesAndLedger): the two answer the same
    // question off the same row, and one of them does not pay a request for it,
    // so a rule kept in two places would eventually disagree.
    return initialPushAuditTokens(
      parsePushAuditRing(await this.getWorkerState("push_audit")),
    );
  }

  /** Newest-last view of the delivery audit ring for /debug/push-audit. */
  async getPushAudit(): Promise<
    Array<{
      chatId: string;
      token: string;
      symbol: string | null;
      messageId: number;
      mcapAtPush?: number;
      /** "initial" (scanner) | "followup" (tracker) | … — see deferrallog. */
      kind?: string;
      /** The card's transition sig (recordPushDelivery / cardProofKey). */
      sig?: string;
      at: number;
    }>
  > {
    const raw = await this.getWorkerState("push_audit");
    try {
      return raw ? (JSON.parse(raw) as never) : [];
    } catch {
      return [];
    }
  }

  private statsFromRow(row: Record<string, unknown>): TokenStats {
    const birdeye = row.birdeye_1m_vol;
    const rugcheck = row.rugcheck_bundler_pct;
    const top10 = row.rugcheck_top10_pct;
    const proTraders = row.birdeye_pro_traders;
    const sniperPct = row.birdeye_sniper_pct;
    const holderCount = row.holder_count;
    const holderCountAt = row.holder_count_at;
    const minMcap = row.min_mcap_observed;
    const flowJson = row.supply_flow;
    const flowAt = row.supply_flow_at;
    const via = row.discovered_via;
    return {
      token: String(row.token),
      firstSeenAt: Number(row.first_seen_at),
      firstM5Vol: Number(row.first_m5_vol),
      firstSeenAgeMin: Number(row.first_seen_age_min),
      // Rows written before the launch_ms migration fall back to the same
      // computed value the old query used, so nothing changes for them.
      launchMs: Number(
        row.launch_ms ??
          Number(row.first_seen_at) - Number(row.first_seen_age_min) * 60_000,
      ),
      birdeye1mVol: birdeye === null || birdeye === undefined ? null : Number(birdeye),
      rugcheckBundlerPct:
        rugcheck === null || rugcheck === undefined ? null : Number(rugcheck),
      rugcheckTop10Pct:
        top10 === null || top10 === undefined ? null : Number(top10),
      birdeyeProTraders:
        proTraders === null || proTraders === undefined ? null : Number(proTraders),
      birdeyeSniperPct:
        sniperPct === null || sniperPct === undefined ? null : Number(sniperPct),
      holderCount:
        holderCount === null || holderCount === undefined
          ? null
          : Number(holderCount),
      holderCountAt:
        holderCountAt === null || holderCountAt === undefined
          ? null
          : Number(holderCountAt),
      minMcapObserved:
        minMcap === null || minMcap === undefined ? null : Number(minMcap),
      maxMcapObserved:
        row.max_mcap_observed === null || row.max_mcap_observed === undefined
          ? null
          : Number(row.max_mcap_observed),
      maxLiquidityObserved:
        row.max_liquidity_observed === null ||
        row.max_liquidity_observed === undefined
          ? null
          : Number(row.max_liquidity_observed),
      supplyFlowJson:
        flowJson === null || flowJson === undefined ? null : String(flowJson),
      supplyFlowAt:
        flowAt === null || flowAt === undefined ? null : Number(flowAt),
      discoveredVia:
        via === null || via === undefined ? null : String(via),
    };
  }

  /**
   * Per-feed attribution: how many coins each discovery feed registered,
   * and how many of them were ever pushed (quality signal). One aggregate
   * query over token_stats LEFT JOIN seen_tokens.
   */
  async getFeedAttribution(): Promise<
    Array<{ feed: string; coins: number; pushed: number }>
  > {
    const res = await this.get().execute({
      sql: `SELECT COALESCE(t.discovered_via, 'legacy') AS feed,
                   COUNT(*) AS coins,
                   COUNT(DISTINCT s.token) AS pushed
              FROM token_stats t
              LEFT JOIN seen_tokens s ON s.token = t.token
             GROUP BY feed
             ORDER BY pushed DESC, coins DESC`,
      args: [],
    });
    return res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        feed: String(r.feed),
        coins: Number(r.coins ?? 0),
        pushed: Number(r.pushed ?? 0),
      };
    });
  }

  async getTokenStats(token: string): Promise<TokenStats | null> {
    const res = await this.get().execute({
      sql: "SELECT * FROM token_stats WHERE token = ?",
      args: [token],
    });
    const row = res.rows[0];
    if (!row) return null;
    return this.statsFromRow(row);
  }

  /**
   * Fetch stats for many tokens in ONE query. The scanner calls this once
   * per tick for the whole profiles feed; with per-token queries the tick
   * would make ~20 sequential Turso round trips, which dominates the scan
   * time whenever the database is slow (observed: ~5s per round trip).
   */
  async getTokenStatsMany(tokens: string[]): Promise<Map<string, TokenStats>> {
    const out = new Map<string, TokenStats>();
    if (tokens.length === 0) return out;
    const res = await this.get().execute({
      sql: `SELECT * FROM token_stats WHERE token IN (${tokens
        .map(() => "?")
        .join(",")})`,
      args: tokens,
    });
    for (const row of res.rows) {
      const stats = this.statsFromRow(row);
      out.set(stats.token, stats);
    }
    return out;
  }

  /**
   * Tokens that have never been pushed to any chat and are nearing or inside
   * the qualifying age window. This is the re-evaluation pool: DexScreener's
   * profiles feed only ever contains young tokens, so coins that must age
   * into the window (e.g. 6h minimum) would otherwise rotate out of the feed
   * and be lost forever. The pool instead keeps them until they qualify.
   *
   * `launch_ms` records the estimated launch time (pairCreatedAt or feed
   * openTimestamp at first observation). The query returns only tokens whose
   * launch falls within [minLaunchMs, maxLaunchMs], ordered by distance to
   * the window entry point — tokens that can qualify right now (or within
   * minutes) are always evaluated first.
   *
   * Index strategy (rows-read alert 2026-08-16): the previous version
   * filtered on the computed expression (first_seen_at - age*60s) and sorted
   * by ABS(launch - entry), which forced SQLite to scan and sort EVERY
   * token_stats row (~400K) per run. Candidates are ordered by distance to
   * the entry point, so only rows near the entry are ever returned: scan the
   * launch_ms index in a narrow band around the entry, widening until the
   * limit is met or the whole window is covered. That turns the ~400K-row
   * scan into a range scan over a few thousand rows. NOT EXISTS probes the
   * seen_tokens index per candidate instead of materializing the whole table
   * per query.
   *
   * Coverage fix (2026-08-16, zero-push bug): the widening loop stopped as
   * soon as the band around the entry held `limit` rows, and the pool is
   * ordered by proximity to the entry — so in a dense launch market the
   * LIMIT filled up with coins just below the age gate and coins that had
   * already aged past the gate were NEVER re-evaluated (measured: 26.8K
   * eligible never-pushed coins in the window, pool returned 1000 coins ALL
   * aged 3-6h, zero aged 6h+). Older coins only drift farther from the
   * entry over time, so they never came back.
   *
   * Structure now (2026-08-16): the pool splits into a HOT zone (coins
   * around the entry, evaluated every scan, ordered by distance to the
   * entry — the push-latency-critical cohort) plus a GRADUATED rotation:
   *
   *   NEAR zone (entry → entry+6h of age): the coins most likely to cross
   *     the gates after entering — POOL_NEAR_SLOTS slots swept every ~10 min.
   *   FAR zone (older tail): POOL_FAR_SLOTS slots swept every ~30 min —
   *     every coin is still re-checked at least once per far sweep, but the
   *     old tail stops consuming most of the budget.
   *
   * Rotation bands are ordered by qualification signal (max_mcap_observed
   * DESC, then first_m5_vol DESC), NOT distance to the slot center — the
   * per-slot LIMIT then always picks the most promising coins instead of
   * arbitrarily dropping band-edge coins in dense markets (the residual
   * starvation of the earlier uniform-slot design). When minQualifyMcap is
   * set, coins whose known max mcap is below it are dropped from every band
   * (NULL = never seen with pair data → kept): the sweep budget
   * concentrates on coins that can actually qualify. Rows-read stays
   * bounded: each scan reads the hot band (~1.5h of launches) plus one near
   * slot plus one far slot, never the whole window.
   */
  async getReevalPool(opts: {
    /** first_seen_at >= this (drops tokens whose launch is too far in the past). */
    sinceMs: number;
    /** Estimated launch must be >= this (age <= maxAgeMinutes + margin). */
    minLaunchMs: number;
    /** Estimated launch must be <= this (age >= minAgeMinutes - margin). */
    maxLaunchMs: number;
    /** Estimated launch of a token that just entered the window (age == minAgeMinutes). */
    windowEntryLaunchMs: number;
    limit: number;
    /**
     * Near-zone slot count (see POOL_NEAR_SLOTS). Default 2 → a full
     * near-zone sweep every ~10 min at the default pool cache.
     */
    nearSlots?: number;
    /**
     * Far-zone slot count (see POOL_FAR_SLOTS). Default 6 → a full
     * far-zone sweep every ~30 min at the default pool cache.
     */
    farSlots?: number;
    /**
     * Rotation period in ms — MUST equal the caller's pool cache TTL so
     * each cache expiry advances to the next slot. Defaults to
     * POOL_ROTATION_PERIOD_MS (300s); production passes the configured
     * REEVAL_POOL_CACHE_SECONDS (default 180s → 6-min near / 18-min far
     * sweeps at the default slot counts).
     */
    rotationPeriodMs?: number;
    /**
     * Pre-qualification floor: when set, coins whose max_mcap_observed is
     * known and below this value are dropped from every band (NULL = never
     * seen with pair data → kept). The scanner passes 0.6× the widest
     * chat's minMarketCapUsd.
     */
    minQualifyMcap?: number;
    /**
     * Pre-qualification ceiling: when set, coins whose max_mcap_observed is
     * known and ABOVE this value are dropped from every band (NULL = never
     * seen with pair data → kept). The scanner passes 2× the widest
     * chat's maxMarketCapUsd. A coin that already peaked at double the
     * ceiling usually retraces through the qualifying band long before it
     * could re-qualify, yet its huge peak ranks FIRST under the signal
     * ordering — pump-and-dump corpses (2026-09-10 audit: NVDA/HOOD/
     * LAPTOP, liquidity $0, peaks in the millions) were permanently
     * occupying the band LIMITs and starving live mid-cap coins out of the
     * sweep. Same semantics as the floor: a pruned coin stops updating
     * max_mcap_observed, so one that collapses back under the ceiling is
     * missed.
     */
    maxQualifyMcap?: number;
    /**
     * Liquidity pre-qualification floor: when set, coins whose
     * max_liquidity_observed is known and below this value are dropped from
     * every band (NULL = never seen with pair data → kept). The scanner
     * passes POOL_LIQUIDITY_PRUNE_RATIO × the widest chat's
     * minLiquidityUsd (0.8 since 2026-09-28, up from 0.6 — the ratio lives in
     * that one exported constant in src/scanner.ts so this note cannot drift
     * from the value again). This is the LIQUIDITY floor; the MARKET-CAP
     * floor two docstrings up is a separate ratio and is unchanged by that
     * raise. Dead-liquidity
     * corpses (ZenoCoin/NEMOTRON/Ggwiz — mcap $100K+ over $0–$15 LP)
     * never had real liquidity, so the mcap prunes cannot remove them; their
     * huge max_mcap_observed ranks them FIRST in every band and ~215 of
     * ~330 coins evaluated per tick failed the liquidity gate (2026-09-10
     * audit). Same trade-off as the mcap prunes: a pruned coin stops
     * updating max_liquidity_observed, so one that later adds deep LP is
     * missed.
     */
    minQualifyLiquidity?: number;
    /**
     * Enabled chat IDs (chat_settings WHERE enabled = 1). When provided, a
     * token is excluded from the pool only when EVERY one of these chats has
     * already seen it — a coin pushed to one chat but missed by another
     * (failed Telegram delivery) stays in the pool so the missed chat gets a
     * retry on a later scan. When omitted (legacy callers/tests), the old
     * token-level exclusion applies: any seen row removes the coin.
     */
    seenChatIds?: string[];
    /** Override for deterministic tests; defaults to Date.now(). */
    now?: number;
  }): Promise<TokenStats[]> {
    const now = opts.now ?? Date.now();
    // The no-evidence cutoff (see POOL_MCAP_EVIDENCE_GRACE_MS), derived from
    // THIS call's clock so every band — and the batched builder — cuts at the
    // same instant.
    const mcapEvidenceSinceMs = now - POOL_MCAP_EVIDENCE_GRACE_MS;
    const center = opts.windowEntryLaunchMs;
    const spanLo = opts.minLaunchMs;
    const spanHi = opts.maxLaunchMs;
    const hotLo = Math.max(spanLo, center - POOL_HOT_BELOW_MS);
    const hotHi = Math.min(spanHi, center + POOL_HOT_ABOVE_MS);
    const hotLimit = Math.min(opts.limit, POOL_HOT_MAX);
    const out: TokenStats[] = [];
    if (hotHi > hotLo) {
      // Hot zone: every scan, nearest to the entry first (latency-critical).
      out.push(
        ...(await this.queryReevalBand(hotLo, hotHi, center, {
          sinceMs: opts.sinceMs,
          mcapEvidenceSinceMs,
          limit: hotLimit,
          minQualifyMcap: opts.minQualifyMcap,
          maxQualifyMcap: opts.maxQualifyMcap,
          minQualifyLiquidity: opts.minQualifyLiquidity,
          seenChatIds: opts.seenChatIds,
          orderBy: "entry",
        })),
      );
    }
    const rotLimit = Math.max(0, opts.limit - hotLimit);
    if (rotLimit <= 0) return out;
    const rotLo = spanLo; // oldest launch in the window
    const rotHi = hotLo; // everything older than the hot zone
    if (rotHi <= rotLo) return out;
    const nearLo = Math.max(rotLo, center - POOL_NEAR_WINDOW_MS);
    const nearSlots = Math.max(1, Math.floor(opts.nearSlots ?? POOL_NEAR_SLOTS));
    const farSlots = Math.max(1, Math.floor(opts.farSlots ?? POOL_FAR_SLOTS));
    const nearLimit = Math.max(
      0,
      Math.min(rotLimit, Math.round(rotLimit * POOL_NEAR_LIMIT_SHARE)),
    );
    const farLimit = Math.max(0, rotLimit - nearLimit);
    const slot = poolRotationSlot(now, opts.rotationPeriodMs);
    // One rotation step per RECURRENCE of a given sub-window (see
    // POOL_BAND_ROTATE_BUCKETS): the near zone's window comes back every
    // nearSlots slot-periods, the far zone's every farSlots, and the phase must
    // advance exactly once per recurrence so that the overflow's bucket choice
    // moves on rather than repeating.
    const nearPhase = Math.floor(slot / nearSlots);
    const farPhase = Math.floor(slot / farSlots);
    // Near zone: entry → entry + POOL_NEAR_WINDOW_MS of age — fresh
    // in-window coins, most likely to cross the gates → frequent sweep.
    if (rotHi > nearLo && nearLimit > 0) {
      const slotW = (rotHi - nearLo) / nearSlots;
      const s = slot % nearSlots;
      const lo = rotHi - (s + 1) * slotW;
      const hi = rotHi - s * slotW;
      out.push(
        ...(await this.queryReevalBand(lo, hi, (lo + hi) / 2, {
          sinceMs: opts.sinceMs,
          mcapEvidenceSinceMs,
          limit: nearLimit,
          minQualifyMcap: opts.minQualifyMcap,
          maxQualifyMcap: opts.maxQualifyMcap,
          minQualifyLiquidity: opts.minQualifyLiquidity,
          seenChatIds: opts.seenChatIds,
          orderBy: "signal",
          rotatePhase: nearPhase,
        })),
      );
    }
    // Far zone: the older tail — qualification is rare this deep, so sweep
    // it slowly; every coin is still re-checked at least once per sweep.
    if (nearLo > rotLo && farLimit > 0) {
      const slotW = (nearLo - rotLo) / farSlots;
      const s = slot % farSlots;
      const lo = nearLo - (s + 1) * slotW;
      const hi = nearLo - s * slotW;
      out.push(
        ...(await this.queryReevalBand(lo, hi, (lo + hi) / 2, {
          sinceMs: opts.sinceMs,
          mcapEvidenceSinceMs,
          limit: farLimit,
          minQualifyMcap: opts.minQualifyMcap,
          maxQualifyMcap: opts.maxQualifyMcap,
          minQualifyLiquidity: opts.minQualifyLiquidity,
          seenChatIds: opts.seenChatIds,
          orderBy: "signal",
          rotatePhase: farPhase,
        })),
      );
    }
    return out;
  }

  /**
   * One banded re-eval pool query (see getReevalPool). `orderBy` "entry"
   * ranks by distance to the band center (hot zone — nearest to the window
   * entry first); "signal" ranks by qualification signal
   * (max_mcap_observed, then first_m5_vol) so the per-band LIMIT picks the
   * most promising coins instead of arbitrary band-edge ones — and then
   * resolves the remaining TIES by `rotatePhase` bucket, so a sub-window
   * holding more rows than its LIMIT does not hand the same overflow to
   * nobody forever (see poolBandOrder / POOL_BAND_ROTATE_BUCKETS).
   */
  private async queryReevalBand(
    lo: number,
    hi: number,
    center: number,
    opts: {
      sinceMs: number;
      /**
       * The no-evidence cutoff (see POOL_MCAP_EVIDENCE_GRACE_MS): a row with
       * no mcap reading is carried only while `first_seen_at >` this bound.
       * Computed by the caller from its own clock, so every band of one call
       * cuts at the same instant.
       */
      mcapEvidenceSinceMs: number;
      limit: number;
      minQualifyMcap?: number;
      maxQualifyMcap?: number;
      minQualifyLiquidity?: number;
      seenChatIds?: string[];
      orderBy: "entry" | "signal";
      /**
       * Rotation phase for the "signal" ordering's tie break. Callers pass the
       * band's own recurrence index (see getReevalPool); "entry" ignores it.
       */
      rotatePhase?: number;
    },
  ): Promise<TokenStats[]> {
    // The dead-pool pre-filter rides BOTH builders (see DEAD_POOL_CLAUSE).
    // Until 2026-09-29 it reached only the batched one: that is the production
    // path, but this per-band read is its FALLBACK (poolfallback.ts calls
    // super.getReevalPool when the batch throws), so a clause on one side only
    // re-admitted the corpses the other drops exactly when the transport was
    // already degraded — and it made every offline instrument that reads this
    // path measure a pool larger than the tick's (found while measuring the
    // band sizes behind POOL_BAND_ROTATE_BUCKETS).
    //
    // The no-evidence clause rides both builders the same way: a row that has
    // never recorded a positive mcap is carried only inside its grace (see
    // POOL_MCAP_EVIDENCE_GRACE_MS) — the fail-open kept, its clock bounded.
    const clauses: string[] = [DEAD_POOL_CLAUSE, POOL_MCAP_EVIDENCE_CLAUSE];
    // A LITERAL, not a bound argument — see mcapFloorLiteral: this is what lets
    // Db.ensurePoolBandIndex's partial index cover the band's range.
    if (opts.minQualifyMcap !== undefined)
      clauses.push(
        `(max_mcap_observed IS NULL OR max_mcap_observed >= ${mcapFloorLiteral(opts.minQualifyMcap)})`,
      );
    if (opts.maxQualifyMcap !== undefined)
      clauses.push(`(max_mcap_observed IS NULL OR max_mcap_observed <= ?)`);
    if (opts.minQualifyLiquidity !== undefined)
      clauses.push(
        `(max_liquidity_observed IS NULL OR max_liquidity_observed >= ?)`,
      );
    const qualifyClause = clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
    const seen = this.seenExclusion(opts.seenChatIds);
    // The evidence cutoff binds first — the clause's placeholder sits right
    // after `first_seen_at > ?`, before every floor's (order is binding order).
    const args: Array<string | number> = [lo, hi, opts.sinceMs, opts.mcapEvidenceSinceMs];
    // No argument for minQualifyMcap: it rides the SQL as a literal (see
    // mcapFloorLiteral) so the partial index can cover this range.
    if (opts.maxQualifyMcap !== undefined) args.push(opts.maxQualifyMcap);
    if (opts.minQualifyLiquidity !== undefined)
      args.push(opts.minQualifyLiquidity);
    args.push(...seen.args);
    const order = poolBandOrder(opts.orderBy);
    if (order.rotate) args.push(opts.rotatePhase ?? 0);
    if (opts.orderBy === "entry") args.push(center);
    args.push(opts.limit);
    const res = await this.get().execute({
      sql: `SELECT * FROM token_stats
            WHERE launch_ms BETWEEN ? AND ?
              AND first_seen_at > ?
              ${qualifyClause}
              ${seen.clause}
            ${order.sql}
            LIMIT ?`,
      args,
    });
    return res.rows.map((row) => this.statsFromRow(row));
  }

  /**
   * SQL fragment + args that implement the pool's "seen" exclusion.
   *
   * Chat-aware (seenChatIds provided): a token is excluded only when EVERY
   * enabled chat has already seen it — the scanner passes the enabled chat
   * list so a coin whose push to one chat failed (Telegram error) stays in
   * the re-eval pool and is retried for the missed chat instead of being
   * lost forever (the bug behind cross-chat push inconsistency). The
   * subquery walks the idx_seen_tokens_token index per candidate and the
   * chat_settings table is tiny (a handful of rows), so rows-read stays
   * bounded like the legacy NOT EXISTS probe.
   *
   * Legacy (seenChatIds omitted): any seen row removes the coin, matching
   * the pre-2026-08-17 behavior used by tests and one-shot callers.
   */
  private seenExclusion(seenChatIds?: string[]): {
    clause: string;
    args: Array<string | number>;
  } {
    if (seenChatIds && seenChatIds.length > 0) {
      return {
        clause: `AND (
          SELECT COUNT(*) FROM seen_tokens s
          WHERE s.token = token_stats.token
            AND s.chat_id IN (${seenChatIds.map(() => "?").join(",")})
        ) < ?`,
        args: [...seenChatIds, seenChatIds.length],
      };
    }
    return {
      clause:
        "AND NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token)",
      args: [],
    };
  }

  /**
   * Raise max_mcap_observed to the given CURRENT market cap for tokens whose
   * stored value is lower (one batched statement; entries with no raise are
   * no-ops). The re-eval pool uses this as its qualification pre-signal: a
   * coin repeatedly observed far below minQualifyMcap stops consuming sweep
   * budget, and rotation bands order by it so the LIMIT picks the most
   * promising coins.
   */
  /**
   * Record the top-holder snapshot of one pushed coin (wallet analysis,
   * feature C): the creator row plus each resolved top holder, tagged with
   * their rank, whether they are the creator and whether they hit the crime
   * list. INSERT OR IGNORE so a coin pushed to several chats / retried
   * across ticks only stores one snapshot. Callers pass `pushedAt` so the
   * cluster window is anchored to the push time, not the write time.
   */
  async recordPushedHolders(
    rows: Array<{
      token: string;
      owner: string;
      rank: number;
      uiAmount: number;
      isCreator: boolean;
      crimeHit: boolean;
    }>,
    pushedAt: number,
  ): Promise<void> {
    if (rows.length === 0) return;
    const placeholders = rows.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(",");
    const args: Array<string | number> = [];
    for (const r of rows) {
      args.push(
        r.token,
        r.owner,
        r.rank,
        Number.isFinite(r.uiAmount) ? r.uiAmount : 0,
        r.isCreator ? 1 : 0,
        r.crimeHit ? 1 : 0,
        pushedAt,
      );
    }
    await this.get().execute({
      sql: `INSERT OR IGNORE INTO pushed_holders (token, owner, rank, ui_amount, is_creator, crime_hit, pushed_at) VALUES ${placeholders}`,
      args,
    });
  }

  /**
   * Post-push watch rows (see push_watch DDL): written at push time,
   * refreshed once per tick from a single DexScreener batch call, deleted
   * when the window ends or the coin dies. Tiny table (≤ maxTracked rows).
   */
  async upsertPushWatch(row: {
    token: string;
    chatId: string;
    symbol: string | null;
    pushedAt: number;
    mcapAtPush: number;
    liquidityUsd: number | null;
    /** The pool the push is based on (see the pool-pinning note); absent = unpinned. */
    poolAddress?: string | null;
  }): Promise<void> {
    await this.upsertPushWatchMany([row]);
  }

  /**
   * One round trip for N enrollments (multi-VALUES INSERT, the same shape
   * recordTokenStatsMany uses). The self-heal used to upsert per healed coin
   * — one round trip each, against the pass's ~1s tick budget.
   */
  async upsertPushWatchMany(
    rows: Array<{
      token: string;
      chatId: string;
      symbol: string | null;
      pushedAt: number;
      mcapAtPush: number;
      liquidityUsd: number | null;
      /** The pool the push is based on (see the pool-pinning note); absent = unpinned. */
      poolAddress?: string | null;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const now = Date.now();
    const placeholders = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(",");
    const args: Array<string | number | null> = [];
    for (const row of rows) {
      args.push(
        row.token,
        row.chatId,
        row.symbol,
        row.pushedAt,
        row.mcapAtPush,
        row.mcapAtPush,
        row.liquidityUsd,
        now,
        row.poolAddress ?? null,
      );
    }
    await this.get().execute({
      sql: `INSERT INTO push_watch
              (token, chat_id, symbol, pushed_at, mcap_at_push, peak_mcap,
               last_liquidity, last_checked, pool_address)
            VALUES ${placeholders}
            ON CONFLICT(token) DO NOTHING`,
      args,
    });
  }

  /**
   * Recent pushes (seen_tokens) that have no push_watch row — i.e. pushes
   * whose enrollment hook never ran (an old pre-tracker isolate handled the
   * scan, or the process died between push and upsert). The tracker seeds
   * these so a missed hook can never permanently drop a coin from follow-up.
   */
  async findUntrackedPushes(
    sinceMs: number,
    limit = 10,
  ): Promise<Array<{ token: string; chatId: string; pushedAt: number }>> {
    const res = await this.get().execute({
      sql: `SELECT s.token, s.chat_id, MIN(s.first_seen_at) AS pushed_at
              FROM seen_tokens s
             WHERE s.first_seen_at > ?
               AND NOT EXISTS (SELECT 1 FROM push_watch pw WHERE pw.token = s.token)
             GROUP BY s.token, s.chat_id
             ORDER BY pushed_at DESC
             LIMIT ?`,
      args: [sinceMs, limit],
    });
    return res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        chatId: String(r.chat_id),
        pushedAt: Number(r.pushed_at ?? 0),
      };
    });
  }

  async listPushWatch(limit = 40): Promise<PushWatchListRow[]> {
    const res = await this.get().execute({
      // Active rows claim their slots FIRST; terminal rows (rug / unwatched /
      // expired tombstones kept only so the self-heal skips them) fill any
      // leftovers. Without this, a burst of pushes inside the 24h window
      // could evict older ACTIVE coins from the listing — they would
      // silently stop being refreshed.
      //
      // Active rows are ordered by LAST CHECKED, oldest first — the same
      // order the row loop itself rotates in (see PushWatcher.runTick).
      // PUSH_WATCH_MAX_TRACKED (30) is a hard LIMIT, and ordering the active
      // rows by pushed_at DESC meant that once MORE than 30 coins were alive
      // the oldest ones dropped out of every snapshot for good: the loop can
      // only pick within the listing, so those rows were never claimed,
      // re-checked or recapped — they just aged out silently (measured
      // 2026-09-18: 40 active rows, one last checked 267 minutes earlier,
      // `rows 0/30` while the listing was full of freshly-pushed coins).
      // Terminal rows sort by pushed_at so a tombstone burst still drains
      // oldest-first.
      sql: `SELECT * FROM push_watch
            ORDER BY CASE WHEN COALESCE(last_state, '') IN ('rug', 'unwatched', 'expired') THEN 1 ELSE 0 END,
                     CASE WHEN COALESCE(last_state, '') IN ('rug', 'unwatched', 'expired')
                          THEN pushed_at ELSE last_checked END ASC
            LIMIT ?`,
      args: [limit],
    });
    return this.mapPushWatchRows(res.rows);
  }

  /**
   * The tracker pass's ENTRY, in ONE request (2026-09-26).
   *
   * WHY (docs/round-trips.md §4.11: a tick's Turso is ~20 DISTINCT one-shot
   * statements, not one fat loop — the pass's own note read `trips 5`): the
   * pass opened with three of them, none of which depends on the others:
   *
   *   1. the `push_watch` listing the pass rotates AND its recap/prune read
   *      (the same SELECT listPushWatch issues, byte for byte);
   *   2. the single `worker_state` row the settle stage decides on
   *      (deferrallog.UNCONFIRMED_TERMINAL_STATE_KEY) — a caller that knows
   *      which row it will need passes the key here and reads it for free;
   *   3. the RUNNING stamp on `push_watch_pass`, so the durable row moves the
   *      moment a pass starts (a stuck pass must not look like a quiet one).
   *
   * A libsql batch is ONE HTTP request whose statements run in order, so all
   * three ride it: 3 round trips -> 1 on a tick whose binding constraint is
   * Workers Free's 50 subrequests per invocation, where every Turso round
   * trip is one. The saving also lands in FRONT of the row rotation, which
   * is the stage the whole pass exists for.
   *
   * A batch is a transaction, so a refusal loses all three readings — the
   * caller re-reads the listing, re-writes the stamp and lets the settle
   * stage read its own row (the pre-merge shapes, see PushWatcher.runTick),
   * i.e. a refused batch costs today's price and never a lost reading.
   *
   * `stateKeys` empty => no state statement at all (an `IN ()` is not SQL)
   * and an empty map. A caller must read `states.get(k)` as "this batch did
   * not carry that row", never as "the row does not exist" — the same
   * discipline the scan front's gates keep (Db.readScanFront).
   */
  async beginTrackerPass(
    stampKey: string,
    stampValue: string,
    stateKeys: readonly string[],
    limit: number,
  ): Promise<{ rows: PushWatchListRow[]; states: Map<string, string> }> {
    const statements: Array<{
      sql: string;
      args: Array<string | number | null>;
    }> = [];
    if (stateKeys.length > 0) {
      statements.push({
        sql: `SELECT key, value FROM worker_state WHERE key IN (${stateKeys
          .map(() => "?")
          .join(",")})`,
        args: [...stateKeys],
      });
    }
    const stateSlot = statements.length - 1;
    statements.push({
      // listPushWatch's own listing, verbatim: the row SET the pass rotates
      // and the rows its prune keeps are the ones the standalone listing
      // returns (active rows first, oldest last_checked first).
      sql: `SELECT * FROM push_watch
            ORDER BY CASE WHEN COALESCE(last_state, '') IN ('rug', 'unwatched', 'expired') THEN 1 ELSE 0 END,
                     CASE WHEN COALESCE(last_state, '') IN ('rug', 'unwatched', 'expired')
                          THEN pushed_at ELSE last_checked END ASC
            LIMIT ?`,
      args: [limit],
    });
    statements.push({
      // setWorkerState's own upsert, last: the reads above must not be able
      // to observe a stamp written for a pass that never got its listing.
      sql: "INSERT INTO worker_state (key, value) VALUES (?, ?)" +
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      args: [stampKey, stampValue],
    });
    const res = await this.get().batch(statements, "write");
    const states = new Map<string, string>();
    if (stateSlot >= 0) {
      for (const row of res[stateSlot]?.rows ?? []) {
        const r = row as Record<string, unknown>;
        states.set(String(r.key), String(r.value));
      }
    }
    return {
      rows: this.mapPushWatchRows(res[stateSlot + 1]?.rows ?? []),
      states,
    };
  }

  /**
   * The shared mapping for a push_watch listing — ONE definition, used by
   * listPushWatch and by the pass's entry batch (see beginTrackerPass), so
   * the two cannot drift apart.
   */
  private mapPushWatchRows(
    rows: ReadonlyArray<Record<string, unknown>>,
  ): PushWatchListRow[] {
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        token: String(r.token),
        chatId: String(r.chat_id),
        symbol: r.symbol === null || r.symbol === undefined ? null : String(r.symbol),
        pushedAt: Number(r.pushed_at ?? 0),
        mcapAtPush: Number(r.mcap_at_push ?? 0),
        peakMcap: Number(r.peak_mcap ?? 0),
        lastLiquidity:
          r.last_liquidity === null || r.last_liquidity === undefined
            ? null
            : Number(r.last_liquidity),
        lastVol5m:
          r.last_vol_5m === null || r.last_vol_5m === undefined
            ? null
            : Number(r.last_vol_5m),
        deadTroughMcap:
          r.dead_trough_mcap === null || r.dead_trough_mcap === undefined
            ? null
            : Number(r.dead_trough_mcap),
        holdersAtPush:
          r.holders_at_push === null || r.holders_at_push === undefined
            ? null
            : Number(r.holders_at_push),
        holdersLast:
          r.holders_last === null || r.holders_last === undefined
            ? null
            : Number(r.holders_last),
        holdersCheckedAt:
          r.holders_checked_at === null || r.holders_checked_at === undefined
            ? null
            : Number(r.holders_checked_at),
        sellDomStreak: Number(r.sell_dom_streak ?? 0),
        lastMcap:
          r.last_mcap === null || r.last_mcap === undefined
            ? null
            : Number(r.last_mcap),
        lastChecked: Number(r.last_checked ?? 0),
        lastAlertAt: Number(r.last_alert_at ?? 0),
        followupsSent: Number(r.followups_sent ?? 0),
        lastState: r.last_state === null || r.last_state === undefined ? null : String(r.last_state),
        upStages: r.up_stages === null || r.up_stages === undefined ? null : String(r.up_stages),
        revivesSinceUp: Number(r.revives_since_up ?? 0),
        poolAddress:
          r.pool_address === null || r.pool_address === undefined
            ? null
            : String(r.pool_address),
      };
    });
  }

  /** Persist one tracker check (mcap/liquidity refresh + alert bookkeeping). */
  /**
   * The SET clause + bound values of a check write. ONE definition, shared by
   * both writers below — one keyed by token, one keyed by token + the
   * checked-at stamp the caller claimed — so their column lists cannot drift
   * apart.
   */
  private pushWatchCheckSet(
    v: PushWatchCheckValues,
    checkedAt: number,
  ): { sql: string; args: (string | number | null)[] } {
    return {
      sql: `peak_mcap = ?, last_liquidity = ?, last_checked = ?,
              followups_sent = ?, last_state = ?, last_alert_at = ?,
              last_vol_5m = COALESCE(?, last_vol_5m),
              dead_trough_mcap = COALESCE(?, dead_trough_mcap),
              mcap_at_push = COALESCE(?, mcap_at_push),
              holders_at_push = COALESCE(?, holders_at_push),
              sell_dom_streak = ?,
              up_stages = COALESCE(?, up_stages),
              revives_since_up = COALESCE(?, revives_since_up),
              last_mcap = ?,
              pool_address = COALESCE(pool_address, ?)`,
      args: [
        v.peakMcap,
        v.lastLiquidity,
        checkedAt,
        v.followupsSent ?? 0,
        v.lastState ?? null,
        v.lastAlertAt ?? 0,
        v.lastVol5m ?? null,
        v.deadTroughMcap ?? null,
        v.mcapAtPush ?? null,
        v.holdersAtPush ?? null,
        v.sellDomStreak ?? 0,
        v.upStages ?? null,
        v.revivesSinceUp ?? null,
        v.lastMcap ?? null,
        v.poolAddress ?? null,
      ],
    };
  }

  async updatePushWatchCheck(
    token: string,
    v: PushWatchCheckValues,
  ): Promise<void> {
    const set = this.pushWatchCheckSet(v, Date.now());
    await this.get().execute({
      sql: `UPDATE push_watch SET ${set.sql} WHERE token = ?`,
      args: [...set.args, token],
    });
  }

  /**
   * Re-pin rows whose PINNED pool has left DexScreener's response — the
   * second half of the tracker's pool-switch policy (see the pool-pinning
   * note in src/pushwatch.ts): the pass that detects a switch neither judges
   * the row nor leaves it on a dead pin; it points the row at the pool the
   * token batch now represents it with, and the NEXT pass judges from there.
   *
   * ONE batch for every switch the pass confirmed, in the same shape as every
   * other multi-row write here: one row per statement (a multi-row UPDATE
   * cannot say which token moved), one round trip total.
   *
   * The WHERE is a compare-and-swap on the pin the caller READ — `pool_address
   * = ?` (the old value). Two isolates detecting the same switch both write
   * the same new pin, but a stale writer must never clobber a re-pin that a
   * fresher pass already landed (they could name different new pools after a
   * second switch); losing the race is free — the row still carries a pin the
   * next pass can resolve, and a row whose pin stays stale simply re-detects
   * on the next tick.
   */
  async repinPushWatchPools(
    updates: Array<{ token: string; from: string; to: string }>,
  ): Promise<void> {
    if (updates.length === 0) return;
    await this.get().batch(
      updates.map((u) => ({
        sql: "UPDATE push_watch SET pool_address = ? WHERE token = ? AND pool_address = ?",
        args: [u.to, u.token, u.from],
      })),
      "write",
    );
  }

  /**
   * Claim AND record a row's check in ONE round trip — the SILENT half of the
   * tracker's row loop (see PushWatcher.runTick).
   *
   * The loop spent two round trips on every row it merely observed: a
   * claimPushWatch compare-and-swap on last_checked, then this check write.
   * Only the ALERTING path needs them separated (the claim must land before a
   * card is reserved and sent, and a lost race must skip the row entirely); a
   * row with nothing to announce needs one writer, and carrying the same CAS
   * in the WHERE clause gives exactly the same cross-isolate exclusion.
   * Measured 2026-09-21: a Turso round trip costs ~110-200ms here and the
   * pass's allowance is 1.2-1.6s, so halving the trips per observed row is
   * what turns a 29-row rotation from tens of minutes into single digits.
   *
   * Returns false when another isolate claimed the row (or it vanished) —
   * precisely when the two-step claim + write would have skipped it.
   */
  /**
   * Repair rows whose stored push baseline is not a READING.
   *
   * `mcap_at_push` is the denominator of every derived number on a row: the
   * recap's 推送 line, `chgSincePush` (against `max(baseline, 1)`, src/
   * pushwatch.ts), and the dead-state resurrection floor (`(dead_trough_mcap
   * ?? mcap_at_push) * RESURRECTION_MULT`). A row carrying 0 there therefore
   * reports a seven-figure percentage move and re-arms a resurrection on ANY
   * later reading. Live 2026-09-24 (/debug/push-watch): two rows (💲, 玉兔)
   * were in that state — enrolled by the tracker's self-heal from a pair whose
   * source had no price. The heal's own guard refuses to seed another one (see
   * docs/patches/pushwatch-zero-mcap-baseline.apply.js), but a guard cannot
   * rewrite what is already stored, which is this method's whole job.
   *
   * The substitute is the row's OWN `peak_mcap`: the highest real reading the
   * tracker took for that coin, i.e. the only valuation evidence left once the
   * push-time one never existed. The push ledger cannot help by construction —
   * these rows have no `initial` entry to copy from (that is what
   * /debug/push-audit shows for both), which is exactly why the heal had to
   * fall back to a live price in the first place.
   *
   * Deliberately NOT the live market cap, which is the obvious-looking choice:
   * for a row with no recorded trough the floor above is built from this
   * column, so repairing a corpse's baseline to its current price re-arms the
   * very false resurrection this repair exists to stop (1.5 × a dead coin's
   * price is a number it can reach again by accident). A peak-based floor asks
   * the coin to regain 1.5 × what it once reached, which is what "revived"
   * should mean.
   *
   * Both WHERE terms are guards, not filters: `mcap_at_push <= 0` re-asserts
   * the defect ON the write, so a concurrent isolate that already repaired the
   * row — or a genuinely fresh baseline — can never be overwritten, and
   * `peak_mcap > 0` is the honesty guard: a row with no positive reading
   * anywhere is left alone rather than handed an invented number.
   *
   * Deliberately UNPARAMETERISED — the whole table rather than a token list
   * from the caller. A list would be easier to justify but cannot work: the
   * two row sources a pass holds are the rotation (which drops terminal rows,
   * and a drained coin IS terminal) and the listing (capped at
   * PUSH_WATCH_MAX_TRACKED with active rows first, so at 30 active rows it is
   * exactly the live `rows 30/30` shape — full, and holding only active rows).
   * The caller therefore runs this once per isolate; see the baseline-repair
   * stage in PushWatcher.runTick.
   *
   * Returns how many rows changed, so the caller can report it: 0 on every
   * attempt after the backlog is fixed, which is what keeps the caller's cost
   * bounded rather than recurring.
   */
  async repairPushWatchBaselines(): Promise<number> {
    const res = await this.get().execute({
      sql: `UPDATE push_watch
              SET mcap_at_push = peak_mcap
            WHERE mcap_at_push <= 0
              AND peak_mcap > 0`,
      args: [],
    });
    return Number(res.rowsAffected ?? 0);
  }

  async claimPushWatchCheck(
    token: string,
    expectedLastChecked: number,
    now: number,
    v: PushWatchCheckValues,
  ): Promise<boolean> {
    const set = this.pushWatchCheckSet(v, now);
    const res = await this.get().execute({
      sql: `UPDATE push_watch SET ${set.sql}
            WHERE token = ? AND last_checked = ?`,
      args: [...set.args, token, expectedLastChecked],
    });
    return Number(res.rowsAffected ?? 0) > 0;
  }

  async setPushWatchHolders(token: string, holders: number, at: number): Promise<void> {
    await this.get().execute({
      sql: `UPDATE push_watch SET
              holders_at_push = COALESCE(holders_at_push, ?),
              holders_last = ?, holders_checked_at = ?
            WHERE token = ?`,
      args: [holders, holders, at, token],
    });
  }

  async deletePushWatch(token: string): Promise<void> {
    await this.get().execute({
      sql: "DELETE FROM push_watch WHERE token = ?",
      args: [token],
    });
  }

  /**
   * Tombstone a row instead of deleting it: findUntrackedPushes’ self-heal
   * re-enrolls any pushed coin absent from push_watch, so a plain DELETE is
   * undone on the next tick. A last_state="unwatched" row is skipped by the
   * rules engine (same as "rug") and ages out via prunePushWatch.
   */
  async setPushWatchState(token: string, state: string): Promise<void> {
    await this.get().execute({
      sql: "UPDATE push_watch SET last_state = ? WHERE token = ?",
      args: [state, token],
    });
  }

  /**
   * setPushWatchState that reports whether a row actually matched. The
   * push_watch table survives on INSERT-OR-IGNORE upserts and bounded
   * prunes, so a token can legitimately be absent (never enrolled, window
   * pruned) or already tombstoned — the unwatch button needs that
   * distinction to give honest feedback instead of a blanket "stopped"
   * toast. Returns false on zero affected rows.
   */
  async setPushWatchStateIfTracked(token: string, state: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: "UPDATE push_watch SET last_state = ? WHERE token = ?",
      args: [state, token],
    });
    return Number(res.rowsAffected ?? 0) > 0;
  }

  /**
   * Re-arm a row whose TERMINAL card (the 💧 drain card — the only alert that
   * stops tracking) was never PROVEN delivered.
   *
   * The tracker now treats a cut terminal send the way the initial-card path
   * does (deferrallog.cardSendDisposition("abandoned")): it stops waiting on a
   * request that may already be in the chat, KEEPS the terminal transition (a
   * card that says 停止追蹤 must not leave the row ACTIVE with its cooldown
   * unarmed — live 2026-09-20: Lobby's 💧 card arrived while the row stayed
   * live and re-alertable), and records the unknown delivery durably. This is
   * the other half of that rule: once the record ages out of its grace with no
   * audit proof, the card may have been lost, so the row goes back to ACTIVE
   * with its alert clock cleared and `last_checked` zeroed — the very next pass
   * re-evaluates it (front of the rotation) and re-announces the same card.
   * Deferring the re-announce instead of rolling back immediately is the whole
   * point: the immediate version re-sent cards that were already in flight.
   *
   * Guarded on `last_state = 'rug'`, so it can never resurrect a row the user
   * silenced (🔕 unwatched) or one a concurrent isolate already tombstoned
   * (expired) — those are terminal for another reason and must stay quiet.
   * Returns false when no such row matched (pruned, or it moved on).
   *
   * It also strips the drain rule's ARMED MARK ('liq1', see
   * pushwatch.DRAIN_CONFIRM_MARK — that constant is where the token is
   * defined, this SQL is the only place that removes it) while leaving every
   * other persistent mark (🚀 stages, w35/w45, div) exactly as it was. The arm
   * is what made the verdict TERMINAL, so a row handed back with it still set
   * would end tracking again on its very next sub-floor reading — a
   * one-reading rug hiding behind a two-reading rule, with no ⚠️ warning card
   * in between. The CSV surgery is token-exact (',' + column + ',') so it can
   * never clip a neighbouring mark.
   */
  async rearmPushWatchAlert(token: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: `UPDATE push_watch SET last_state = NULL, last_alert_at = 0, last_checked = 0,\n              up_stages = NULLIF(TRIM(REPLACE(',' || COALESCE(up_stages, '') || ',', ',liq1,', ','), ','), '')\n            WHERE token = ?\n              AND last_state = 'rug'`,
      args: [token],
    });
    return Number(res.rowsAffected ?? 0) > 0;
  }

  /**
   * Write back the half of a terminal row's completion that never landed — the
   * row hygiene rule in pushwatch.terminalRowIssues("lost_completion_write"),
   * used only when the delivery audit PROVES the 💧 card is in the chat (so
   * the transition is legitimate and must stay).
   *
   * The reserve wrote `last_state = 'rug'` and `last_alert_at = now` in ONE
   * statement and the completion write (a FRESH clock read taken after the
   * send) never followed, so the row is frozen at
   * `last_checked === last_alert_at` — the exact shape a well-formed drain row
   * cannot have (delta 0 IS the lost-completion signature, see
   * terminalRowIssues). Re-stamping `last_checked` one send slice behind the
   * alert clock reconstructs a well-formed row without claiming anything about
   * the delivery: the state, the clock and the last-written measurements all
   * stay exactly as the reserve left them, and the row is inert either way (a
   * 'rug' row is never re-evaluated — see PushWatcher.runTick's activeRows).
   *
   * Guarded on the frozen shape AND on 'rug' only, so it can never touch a
   * live row, a 🔕 tombstone (unwatched), a window recap (expired) or a row
   * whose completion already landed. Returns false when nothing matched.
   */
  async restampTerminalCompletion(token: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: `UPDATE push_watch SET last_checked = last_alert_at + ?
            WHERE token = ?
              AND last_state = 'rug'
              AND last_alert_at > 0
              AND last_checked = last_alert_at`,
      args: [TERMINAL_COMPLETION_SEND_MS, token],
    });
    return Number(res.rowsAffected ?? 0) > 0;
  }

  /**
   * Record that the alert behind an already-terminal 💧 row was consumed, for
   * a row that reached the terminal state without arming its clock — the row
   * hygiene rule in pushwatch.terminalRowIssues("unarmed_alert_clock").
   *
   * Used when the delivery audit PROVES the card is in the chat (so the
   * transition is legitimate and must stay), but the bookkeeping never moved:
   * an older single-column writer set `last_state` alone, leaving
   * `last_alert_at` at 0 or at a pre-drain value. Arming the clock makes the
   * row self-consistent and, unlike rearmPushWatchAlert, keeps it terminal —
   * it is inert by construction, since a 'rug' row is never re-evaluated (see
   * PushWatcher.runTick's activeRows filter).
   *
   * Guarded three ways so it can only ever tighten a real drain row: 'rug'
   * only (never the user's 🔕 tombstone or a window 'expired'), a claimed row
   * only, and never backwards (`last_alert_at < last_checked`).
   */
  async armTerminalAlertClock(token: string): Promise<boolean> {
    const res = await this.get().execute({
      sql: `UPDATE push_watch SET last_alert_at = last_checked
            WHERE token = ?
              AND last_state = 'rug'
              AND last_checked > 0
              AND last_alert_at < last_checked`,
      args: [token],
    });
    return Number(res.rowsAffected ?? 0) > 0;
  }

  /**
   * Atomic per-tick claim (compare-and-swap on last_checked): bump the
   * stamp only if it still holds the value the caller read. Two isolates
   * can run overlapping tracker ticks (deploy soft-switch, cron overlap)
   * and would otherwise evaluate the same row from the same snapshot and
   * send duplicate alerts — the double ⚠️ JEFFERY incident. The winner
   * claims the row; the loser skips it for this tick.
   */
  async claimPushWatch(
    token: string,
    expectedLastChecked: number,
    now: number,
  ): Promise<boolean> {
    const res = await this.get().execute({
      sql:
        "UPDATE push_watch SET last_checked = ? WHERE token = ? AND last_checked = ?",
      args: [now, token, expectedLastChecked],
    });
    return Number(res.rowsAffected ?? 0) > 0;
  }

  /**
   * Recap dedupe: mark an expiring row recap-sent BEFORE delivering the 🏁
   * card. Returns false when another isolate already claimed it or the user
   * tombstoned the coin (🔕 unwatched rows stay silent — they were opted out
   * of all follow-ups). Prune removes the row regardless of delivery.
   */
  /**
   * Atomic alert reservation (the authoritative duplicate-alert guard).
   * The caller read (last_state, last_alert_at) from a snapshot and the
   * rules engine decided to fire; this flips BOTH to their post-alert
   * values only if they still match the snapshot. Two isolates evaluating
   * the same row can otherwise both pass a last_checked-only claim:
   * isolate B reading between A's claim and A's final write inherits A's
   * claimed stamp but sees the pre-alert state, and re-fires. Reserving
   * the transition BEFORE sending closes that window — exactly one
   * isolate's WHERE matches, the loser skips delivery.
   */
  async reservePushWatchAlert(
    token: string,
    fromState: string | null,
    fromAlertAt: number,
    toState: string | null,
    alertAt: number,
  ): Promise<boolean> {
    const res = await this.get().execute({
      sql: `UPDATE push_watch SET last_state = ?, last_alert_at = ?
            WHERE token = ? AND last_state IS ? AND last_alert_at = ?`,
      args: [toState, alertAt, token, fromState, fromAlertAt],
    });
    return Number(res.rowsAffected ?? 0) > 0;
  }

  /**
   * ONE round trip for the alerting path's two writes — the per-tick claim
   * and the alert reservation, in that order (2026-09-27).
   *
   * WHY: an alerting row paid claim (1) + reservation (1) + send (1) + final
   * write (1) = FOUR subrequests, and the first two touch the same row with
   * nothing between them but an `await`. Live readings measured what that
   * costs the pass that only exists to deliver cards: `rows 13-21/30 …
   * defer-send 9-17` per pass while the tick's front had already spent 18-36
   * of the invocation's 50. Batching the pair makes a card cost THREE — the
   * +33% the tracker's card throughput is actually short of (see
   * pushwatch.TRACKER_ALERT_PATH_SUBREQ and
   * worker.TRACKER_PASS_SUBREQ_RESERVE).
   *
   * WHAT IS UNCHANGED: both statements are the exact compare-and-swaps
   * claimPushWatch and reservePushWatchAlert send — same guards, same
   * columns — and the AUTHORITATIVE duplicate guard is still the
   * reservation: matching on (last_state, last_alert_at) is what makes
   * exactly one contender's UPDATE win, so the loser skips delivery.
   *
   * WHAT THE SECOND STATEMENT ADDS is `last_checked = ?`, bound to this
   * batch's own claim stamp. Statement order alone could not stop the
   * reservation from committing on a row a CONCURRENT isolate claimed
   * between the caller's read and this batch: the row then carries that
   * isolate's stamp, the reservation's guard fails, and the caller takes its
   * ordinary lost-reservation path (hold the announcement, land the
   * measurements, re-derive next pass). Two isolates stamping the same
   * millisecond still cannot both reserve — the (last_state, last_alert_at)
   * CAS decides, exactly as it did when the two writes were separate.
   *
   * Result order follows statement order — the same contract the recap
   * claims and the silent-row batch rely on — so `claimed` false means the
   * caller must leave the row completely untouched.
   */
  async claimAndReservePushWatch(
    token: string,
    expectedLastChecked: number,
    now: number,
    fromState: string | null,
    fromAlertAt: number,
    toState: string | null,
    alertAt: number,
  ): Promise<{ claimed: boolean; reserved: boolean }> {
    const res = await this.get().batch(
      [
        {
          sql: "UPDATE push_watch SET last_checked = ? WHERE token = ? AND last_checked = ?",
          args: [now, token, expectedLastChecked],
        },
        {
          sql: `UPDATE push_watch SET last_state = ?, last_alert_at = ?
                WHERE token = ? AND last_state IS ? AND last_alert_at = ?
                  AND last_checked = ?`,
          args: [toState, alertAt, token, fromState, fromAlertAt, now],
        },
      ],
      "write",
    );
    return {
      claimed: Number(res[0]?.rowsAffected ?? 0) > 0,
      reserved: Number(res[1]?.rowsAffected ?? 0) > 0,
    };
  }

  async markRecapClaimed(token: string): Promise<boolean> {
    const [won] = await this.markRecapClaimedMany([token]);
    return won === true;
  }

  /**
   * Batched recap claims: ONE round trip for every row leaving the tracking
   * window, with per-row results so the caller still sends a 🏁 card only for
   * the claims it actually won. A single multi-row UPDATE cannot say WHICH
   * rows matched, and answering it with SELECT-then-UPDATE would reopen the
   * duplicate-recap race this compare-and-swap exists to close — so the
   * statements ride in one batch() instead (one request, executed in order).
   */
  async markRecapClaimedMany(tokens: string[]): Promise<boolean[]> {
    if (tokens.length === 0) return [];
    const res = await this.get().batch(
      tokens.map((token) => ({
        sql: "UPDATE push_watch SET last_state = 'expired'\n            WHERE token = ?\n              AND (last_state IS NULL OR last_state NOT IN ('expired', 'unwatched'))",
        args: [token],
      })),
      "write",
    );
    return res.map((r) => Number(r.rowsAffected ?? 0) > 0);
  }

  async prunePushWatch(olderThanMs: number): Promise<number> {
    const res = await this.get().execute({
      sql: "DELETE FROM push_watch WHERE pushed_at < ?",
      args: [olderThanMs],
    });
    return Number(res.rowsAffected ?? 0);
  }

  /**
   * Per-owner cluster stats over pushed_holders: how many DISTINCT pushed
   * coins each owner was a top holder (or creator) of since `sinceMs`, the
   * most recent push, and whether any of their rows is the creator row.
   * One query for the whole wallet batch (rows are few — ~9 per push).
   */
  async getHolderClusters(
    owners: string[],
    sinceMs: number,
    minCoins: number,
  ): Promise<
    Array<{
      owner: string;
      coins: number;
      lastSeenAt: number;
      isCreator: boolean;
    }>
  > {
    if (owners.length === 0) return [];
    const res = await this.get().execute({
      sql: `SELECT owner,
                   COUNT(DISTINCT token) AS coins,
                   MAX(pushed_at) AS last_seen,
                   MAX(is_creator) AS is_creator
            FROM pushed_holders
            WHERE owner IN (${owners.map(() => "?").join(",")}) AND pushed_at > ?
            GROUP BY owner
            HAVING coins >= ?`,
      args: [...owners, sinceMs, minCoins],
    });
    return res.rows.map((row) => ({
      owner: String(row.owner),
      coins: Number(row.coins ?? 0),
      lastSeenAt: Number(row.last_seen ?? 0),
      isCreator: Number(row.is_creator ?? 0) === 1,
    }));
  }

  /**
   * Global cluster scan for /debug/holder-clusters: every wallet that was a
   * top holder (or creator) of >= minCoins distinct pushed coins in the
   * window, ranked by coin count then most recent activity. Small table, so
   * a plain GROUP BY scan is cheap (bounded by the window filter + LIMIT).
   */
  async getGlobalHolderClusters(
    sinceMs: number,
    minCoins: number,
    limit = 25,
  ): Promise<
    Array<{
      owner: string;
      coins: number;
      lastSeenAt: number;
      isCreator: boolean;
      crimeHits: number;
    }>
  > {
    const res = await this.get().execute({
      sql: `SELECT owner,
                   COUNT(DISTINCT token) AS coins,
                   MAX(pushed_at) AS last_seen,
                   MAX(is_creator) AS is_creator,
                   SUM(crime_hit) AS crime_hits
            FROM pushed_holders
            WHERE pushed_at > ?
            GROUP BY owner
            HAVING coins >= ?
            ORDER BY coins DESC, last_seen DESC
            LIMIT ?`,
      args: [sinceMs, minCoins, limit],
    });
    return res.rows.map((row) => ({
      owner: String(row.owner),
      coins: Number(row.coins ?? 0),
      lastSeenAt: Number(row.last_seen ?? 0),
      isCreator: Number(row.is_creator ?? 0) === 1,
      crimeHits: Number(row.crime_hits ?? 0),
    }));
  }

  /**
   * Prune pushed_holders rows older than `olderThanMs` (bounded chunk — the
   * table is tiny, so one pass suffices; the analyzer rate-limits calls via
   * worker_state `pushed_holders_last_prune`).
   */
  async prunePushedHolders(olderThanMs: number, maxRows = 5000): Promise<number> {
    const res = await this.get().execute({
      sql: `DELETE FROM pushed_holders WHERE rowid IN (
              SELECT rowid FROM pushed_holders WHERE pushed_at < ? LIMIT ?
            )`,
      args: [olderThanMs, maxRows],
    });
    return Number(res.rowsAffected ?? 0);
  }

  async updateTokenMaxMcaps(
    entries: Array<{ token: string; mcapUsd: number; liquidityUsd?: number }>,
  ): Promise<void> {
    if (entries.length === 0) return;
    const mcapCases = entries
      .map(
        () =>
          `WHEN token = ? AND (max_mcap_observed IS NULL OR max_mcap_observed < ?) THEN ?`,
      )
      .join(" ");
    // A zero liquidity reading is still recorded (finite 0): it is the
    // corpse signal the pool prune keys on. Entries WITHOUT a reading are
    // excluded from the liquidity CASE entirely (no WHERE leg for them).
    const liqEntries = entries.filter(
      (e) => e.liquidityUsd !== undefined && Number.isFinite(e.liquidityUsd),
    );
    const liqCases = liqEntries
      .map(
        () =>
          `WHEN token = ? AND (max_liquidity_observed IS NULL OR max_liquidity_observed < ?) THEN ?`,
      )
      .join(" ");
    // Placeholder binding order MUST match the SQL: every mcap CASE arg
    // first, then every liquidity CASE arg, then the IN-list — interleaving
    // per entry binds the mcap CASE's later placeholders to liq values
    // (caught by the unit test: the raise silently applied to the wrong
    // column).
    const mcapArgs: Array<string | number> = [];
    const liqArgs: Array<string | number> = [];
    const tokens: string[] = [];
    for (const e of entries) {
      mcapArgs.push(e.token, e.mcapUsd, e.mcapUsd);
      tokens.push(e.token);
    }
    for (const e of liqEntries) {
      const liq = Math.max(0, e.liquidityUsd!);
      liqArgs.push(e.token, liq, liq);
    }
    // The comma after the mcap CASE belongs to the LIQUIDITY clause, not to
    // the statement. Emitted unconditionally it produced `... END,` followed
    // by `WHERE` whenever a batch carried no comparable liquidity reading at
    // all (every coin that tick served by the Jupiter/Gecko legs — see
    // liquidityIsComparable), and libsql rejects the whole statement:
    // `SQL string could not be parsed: near WHERE, "None": syntax error at
    // (3, 18)`. Not a partial failure — that tick's mcap raises never landed,
    // and the deferred entry was retried twice more before being dropped,
    // which is the backlog `writeDrain.pending` showed for days (2026-09-24:
    // pending 47, and the named cause once the drain record was made
    // durable: updateTokenMaxMcaps, pending 11).
    await this.get().execute({
      sql: `UPDATE token_stats SET
              max_mcap_observed = CASE ${mcapCases} ELSE max_mcap_observed END${
                liqCases
                  ? `,
              max_liquidity_observed = CASE ${liqCases} ELSE max_liquidity_observed END`
                  : ""
              }
            WHERE token IN (${tokens.map(() => "?").join(",")})`,
      args: [...mcapArgs, ...liqArgs, ...tokens],
    });
  }

  /**
   * Diagnostic for /debug/pool: age distribution of token_stats rows
   * (never-pushed vs total) plus how many never-pushed coins sit inside the
   * re-eval window (launch 3h–43h ago). Tells whether a zero-push stretch is
   * a cold market (pool covers the whole window but nothing qualifies) or a
   * coverage gap (the pool's LIMIT starves 12h+ coins in a dense launch
   * market — see Scanner.getReevalPoolCached).
   */
  async getPoolHistogram(
    now: number,
    /** Enabled chat ids — the histogram's eligibleInWindow mirrors the
     * chat-aware pool exclusion (see seenExclusion) when provided. */
    seenChatIds?: string[],
  ): Promise<{
    total: number;
    neverPushed: number;
    buckets: Record<string, number>;
    eligibleInWindow: number;
    /**
     * The pool's own dead predicate, counted — see DEAD_POOL_MARK.
     *
     * `deadMarked` = rows the re-eval pool query holds OUT right now. That is
     * the $1K liquidity FLOOR (which has pruned since 2026-09-19) PLUS the
     * freshness bound — so on a database whose `sweeps_since_reading` was just
     * created (every row at its 0 default) it reads exactly the floor's
     * steady-state population, and only a strike of empty sweeps moves it.
     * `deadPending` = rows inside the freshness window (0 < streak < bound),
     * i.e. the rows the sweep-by-sweep count is watching. Read against
     * `total`/`eligibleInWindow` they answer "is this block of the table
     * corpses, and is the freshness half finding any of its own": both ride
     * the full-table scan this endpoint already pays for, so they are free.
     */
    deadMarked: number;
    deadPending: number;
  }> {
    const H = 3600_000;
    const res = await this.get().execute({
      sql: `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token) THEN 1 ELSE 0 END) AS never_pushed,
        SUM(CASE WHEN launch_ms > ? THEN 1 ELSE 0 END) AS b0_3h,
        SUM(CASE WHEN launch_ms > ? AND launch_ms <= ? THEN 1 ELSE 0 END) AS b3_6h,
        SUM(CASE WHEN launch_ms > ? AND launch_ms <= ? THEN 1 ELSE 0 END) AS b6_12h,
        SUM(CASE WHEN launch_ms > ? AND launch_ms <= ? THEN 1 ELSE 0 END) AS b12_24h,
        SUM(CASE WHEN launch_ms > ? AND launch_ms <= ? THEN 1 ELSE 0 END) AS b24_43h,
        SUM(CASE WHEN launch_ms <= ? THEN 1 ELSE 0 END) AS b_over43h,
        SUM(CASE WHEN ${DEAD_POOL_MARK} THEN 1 ELSE 0 END) AS dead_marked,
        SUM(CASE WHEN last_liquidity_usd IS NOT NULL
                  AND sweeps_since_reading > 0
                  AND sweeps_since_reading < ${DEAD_POOL_MISS_MAX}
                 THEN 1 ELSE 0 END) AS dead_pending
      FROM token_stats`,
      args: [
        now - 3 * H,
        now - 6 * H,
        now - 3 * H,
        now - 12 * H,
        now - 6 * H,
        now - 24 * H,
        now - 12 * H,
        now - 43 * H,
        now - 24 * H,
        now - 43 * H,
      ],
    });
    const r = res.rows[0] as Record<string, number | null>;
    const seen = this.seenExclusion(seenChatIds);
    const elig = await this.get().execute({
      sql: `SELECT COUNT(*) AS n FROM token_stats
            WHERE launch_ms BETWEEN ? AND ?
              AND first_seen_at > ?
              ${seen.clause}`,
      args: [now - 43 * H, now - 3 * H, now - 42 * H, ...seen.args],
    });
    return {
      total: Number(r.total ?? 0),
      neverPushed: Number(r.never_pushed ?? 0),
      buckets: {
        "0-3h": Number(r.b0_3h ?? 0),
        "3-6h": Number(r.b3_6h ?? 0),
        "6-12h": Number(r.b6_12h ?? 0),
        "12-24h": Number(r.b12_24h ?? 0),
        "24-43h": Number(r.b24_43h ?? 0),
        ">43h": Number(r.b_over43h ?? 0),
      },
      eligibleInWindow: Number(elig.rows[0]?.n ?? 0),
      deadMarked: Number(r.dead_marked ?? 0),
      deadPending: Number(r.dead_pending ?? 0),
    };
  }

  async recordTokenStats(stats: TokenStats): Promise<void> {
    const res = await this.get().execute({
      sql: "INSERT OR IGNORE INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed, max_mcap_observed, supply_flow, supply_flow_at, discovered_via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)",
      args: [stats.token, stats.firstSeenAt, stats.firstM5Vol, stats.firstSeenAgeMin, stats.launchMs, stats.birdeye1mVol, stats.rugcheckBundlerPct, stats.rugcheckTop10Pct, stats.birdeyeProTraders, stats.birdeyeSniperPct, stats.minMcapObserved, stats.discoveredVia ?? null],
    });
    await this.bumpTelemetryCounter(
      "telemetry_token_stats_count",
      Number(res.rowsAffected ?? 0),
    );
  }

  /**
   * Record stats for several first-seen tokens in ONE multi-row insert.
   * Same rationale as getTokenStatsMany: batch to keep the tick's Turso
   * round trips low when the database is slow.
   */
  async recordTokenStatsMany(statsList: TokenStats[]): Promise<void> {
    if (statsList.length === 0) return;
    const placeholders = statsList
      .map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)")
      .join(",");
    const args: Array<string | number | null> = [];
    for (const s of statsList) {
      args.push(
        s.token,
        s.firstSeenAt,
        s.firstM5Vol,
        s.firstSeenAgeMin,
        s.launchMs,
        s.birdeye1mVol,
        s.rugcheckBundlerPct,
        s.rugcheckTop10Pct,
        s.birdeyeProTraders,
        s.birdeyeSniperPct,
        s.minMcapObserved,
        s.discoveredVia ?? null,
      );
    }
    const res = await this.get().execute({
      sql: `INSERT OR IGNORE INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed, max_mcap_observed, supply_flow, supply_flow_at, discovered_via) VALUES ${placeholders}`,
      args,
    });
    await this.bumpTelemetryCounter(
      "telemetry_token_stats_count",
      Number(res.rowsAffected ?? 0),
    );
  }

  /**
   * Drop token_stats rows older than `olderThanMs` that were never pushed
   * (unreachable by the re-eval pool query, which only reads the last ~30h).
   * Bounds storage growth from pump.fun discovery, which registers 100+
   * new coins per scan; pushed coins keep their rows so /flow and cached
   * verdicts still work.
   *
   * Rows-read discipline (alerted 2026-08-16): the previous version ran an
   * un-chunked DELETE every 60s tick. It used the first_seen_at index, but
   * without ANALYZE statistics SQLite's default selectivity estimate for
   * the range is ~25%, so the plan could walk a large share of the
   * ~400K-row table per tick. This version (a) rate-limits the prune to
   * once per TOKEN_STATS_PRUNE_INTERVAL_MS (shared via worker_state across
   * isolates) and (b) deletes in bounded chunks (LIMIT 5000, max 3 chunks
   * per run), so a single statement can never read more than a few thousand
   * rows even when a backlog exists. Verified plan: the inner SELECT walks
   * idx_token_stats_first_seen and stops at LIMIT; NOT EXISTS probes the
   * seen_tokens index per candidate.
   */
  async pruneOldTokenStats(
    olderThanMs: number,
    front?: ScanFront | null,
  ): Promise<number> {
    // The interval gate rides the front's ONE read on a tick (see
    // readScanFront): it is asked on EVERY tick, due or not.
    const lastPrune = await this.gateOf(front, "token_stats_last_prune");
    if (lastPrune !== null && Date.now() - Number(lastPrune) < TOKEN_STATS_PRUNE_INTERVAL_MS) {
      return 0; // not due yet — the table can hold 10 min of extra rows safely
    }
    let deleted = 0;
    for (let chunk = 0; chunk < 3; chunk++) {
      const res = await this.get().execute({
        sql: `DELETE FROM token_stats WHERE token IN (
                SELECT token FROM token_stats
                WHERE first_seen_at < ?
                  AND NOT EXISTS (SELECT 1 FROM seen_tokens s WHERE s.token = token_stats.token)
                LIMIT 5000)`,
        args: [olderThanMs],
      });
      const n = Number(res.rowsAffected ?? 0);
      deleted += n;
      if (n < 5000) break; // backlog cleared
    }
    // Keep the /health count fresh (NOT EXISTS probes the seen_tokens index
    // per candidate instead of materializing the whole table like NOT IN did).
    // The prune's two bookkeeping rows go on the front's ONE batch (see
    // writeScanFront), so a due prune costs the deletes plus no extra round trip
    // for the counter and the stamp. No front = the old two writes, verbatim.
    await this.frontStamp(front, "telemetry_token_stats_count", String(-deleted), true);
    await this.frontStamp(front, "token_stats_last_prune", String(Date.now()));
    return deleted;
  }

  async updateTokenBirdeyeVol(token: string, volume: number): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET birdeye_1m_vol = ? WHERE token = ?",
      args: [volume, token],
    });
  }

  async updateTokenRugcheckData(
    token: string,
    bundlerPct: number | null,
    top10Pct: number | null,
  ): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET rugcheck_bundler_pct = ?, rugcheck_top10_pct = ? WHERE token = ?",
      args: [bundlerPct, top10Pct, token],
    });
  }

  async updateTokenProTraders(token: string, count: number): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET birdeye_pro_traders = ? WHERE token = ?",
      args: [count, token],
    });
  }

  async updateTokenSniperPct(token: string, sniperPct: number): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET birdeye_sniper_pct = ? WHERE token = ?",
      args: [sniperPct, token],
    });
  }

  async updateTokenMinMcap(token: string, minMcap: number): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET min_mcap_observed = ? WHERE token = ?",
      args: [minMcap, token],
    });
  }

  /** Cache the supply-flow detector result for a token (reused until refreshMs elapses). */
  async updateTokenSupplyFlow(token: string, json: string): Promise<void> {
    await this.get().execute({
      sql: "UPDATE token_stats SET supply_flow = ?, supply_flow_at = ? WHERE token = ?",
      args: [json, Date.now(), token],
    });
  }
}
