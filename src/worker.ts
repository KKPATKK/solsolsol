import { webhookCallback, type Bot } from "grammy";
import {
  BirdeyeClient,
  BIRDEYE_CU_LEDGER_DAYS,
  BIRDEYE_CU_PRICES,
  birdeyeUtcDay,
  consumeBirdeyeCuByDay,
  consumeBirdeyeCuDelta,
  peekBirdeyeCuByDay,
  peekBirdeyeCuDelta,
  type BirdeyeCuCounts,
} from "./birdeye";
import { createBot, tradeKeyboard, type FlowCheckResult } from "./bot";
import { loadConfig, type AppConfig } from "./config";
import {
  Db,
  SCAN_TRIGGER_STATE_KEYS,
  parseScanTriggerCounts,
  parseScheduledTickRing,
  parseTelemetryCounter,
  parseTradeModeOverride,
  telemetryCounterUsable,
  type ScanTrigger,
  type ScanTriggerCounts,
  type ScheduledTickEntry,
} from "./db";
// Subclass with the last-good pool fallback: the method it wraps lives past
// the file-sync window in src/db.ts, so the production path is adjusted here.
import { PoolFallbackDb, poolFallbackStats } from "./poolfallback";
// Early-return capture: the scanner nulls its own lastSkip in the same tick it
// records a reason, so the reason is captured instead (see src/skipcapture.ts).
import {
  SKIP_CAPTURE_STATE_KEY,
  emptySkipCaptureState,
  installSkipCapture,
  markSkipCaptureSynced,
  mergeSkipCaptureState,
  noteSkipReason,
  parseSkipCaptureState,
  skipCaptureSnapshot,
  takeSkipCaptureDelta,
  type SkipCaptureState,
  type SkipDelta,
} from "./skipcapture";
// Turso round-trip probe (see /debug/db-latency and src/dblatency.ts): the
// pure helpers live in that module so this route stays a thin reader of one
// measurement.
import {
  changesVerdict,
  claimShapeSavingMs,
  clampLatencySamples,
  dbRegionFromUrl,
  summarizeLatencyOps,
  DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE,
} from "./dblatency";
import {
  DexScreenerClient,
  DEX_LIST_CACHE_HITS_KEY,
  DEX_LIST_CACHE_LAST_KEY,
  DEX_LIST_CACHE_MISSES_KEY,
  DEX_LIST_CACHE_REFUSED_KEY,
} from "./dexscreener";
import { HeliusClient, type SupplyFlowResult } from "./helius";
import { RugcheckClient } from "./rugcheck";
import {
  Scanner,
  forgetDeferredTokens,
  POOL_MCAP_PRUNE_RATIO,
  POOL_LIQUIDITY_PRUNE_RATIO,
} from "./scanner";
import { deferralRegistryView, deferredPushTokens, feedMakeupView } from "./deferredmakeup";
import {
  installTickProbe,
  dbStepView,
  writeDrainView,
  drainDeferredWrites,
  DEFERRED_MAX_CALLS_PER_DRAIN,
  DEFERRED_DEAD_PREDECESSOR_MAX_CALLS,
  noteDuplicateCards,
  noteTrackerPassSpend,
  WRITE_DRAIN_ERROR_KEY,
  drainErrorIsStale,
  type WriteDrainErrorRecord,
} from "./tickprobe";
import {
  PUSH_DEFERRAL_STATE_KEY,
  heldBackCandidates,
  loadPushDeferralSnapshot,
  nextPushDeferralSnapshot,
  deliveredDeferredTokens,
  deliveredFollowupTokens,
  duplicateInitialTokens,
  parsePushDeferralSnapshot,
  pushDeferralAlreadyApplied,
  pushDeferralDelta,
  type PushDeferralSnapshot,
} from "./deferrallog";
import {
  PUSH_LEDGER_STATE_KEY,
  ledgerDeliveredTokens,
  mergePushLedger,
  parsePushLedger,
  pushLedgerStats,
} from "./pushledger";
import { JupiterClient, TradeService } from "./jupiter";
import { PumpFunClient } from "./pumpfun";
import { MeteoraClient } from "./meteora";
import {
  GeckoTerminalClient,
  GECKO_ALT_BASE_URL,
  GECKO_CACHE_TTL_S,
  GECKO_USER_AGENT,
  COINGECKO_DEMO_HEADER,
  COINGECKO_PRO_HEADER,
} from "./geckoterminal";
// Heal-path counters: module scope in the tracker, read here so /health can
// answer "did the self-heal reuse the push-time baseline, and how often".
import {
  liquidityIsComparable,
  pushWatchHealStats,
  revivedBaseline,
  terminalRowIssues,
  trackerPassPulse,
  terminalRowRepair,
} from "./pushwatch";
import { JupTokensClient } from "./jupfeeds";
import { GmgnClient } from "./gmgn";
import { AxiomClient, parseAxiomTokenInfo, type AxiomTokenInfo } from "./axiom";
import { renderMessage } from "./render";
import type {
  FrontLeg,
  PassRelayTag,
  QualifyingCoin,
  ScanSummary,
} from "./scanner";
import { ArkhamClient } from "./arkham";
import { CrimeWalletClient } from "./crimewallets";
import { WalletAnalyzer } from "./walletanalysis";
import { FlurryAnalyzer } from "./flurry";
import {
  beginSubreqWindow,
  countSubreq,
  subreqRemaining,
  subreqView,
  type SubreqOwner,
} from "./subreqs";

/**
 * Count every subrequest this invocation makes — the quantity Cloudflare
 * limits to 50 per invocation, and the one this tick dies on (see
 * src/subreqs.ts for the whole rationale).
 *
 * Installed once per isolate, at module load, so it cannot miss a client: the
 * DB is @libsql/client/web (one HTTP request per statement batch) and every
 * upstream client (gecko, pump.fun, Meteora, DexScreener, Jupiter, Birdeye,
 * Helius, GMGN, Telegram) calls this same global. The wrapper counts and then
 * forwards the call unchanged — one increment, no clone, no extra request.
 * The window it counts into is opened per tick by beginPreTick, and its phase
 * ring is stamped by the tick probe's markPhase wrapper. The target is passed
 * through so the window carries a per-host split as well (see countSubreq):
 * the ring is blind in the common zero-candidate tick, the host split is not.
 */
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => {
  countSubreq(input);
  return realFetch(input, init);
}) as typeof fetch;

/**
 * Cloudflare Worker entry for the scanner.
 *
 * The long-running process model (src/index.ts: http server + long polling +
 * setInterval loop) cannot exist on serverless. This Worker exposes:
 *   - fetch():  /health telemetry for UptimeRobot, and the Telegram webhook
 *               (grammY "cloudflare-mod" adapter) for /start /filter /on /off.
 *   - scheduled(): a cron trigger (see wrangler.toml) that runs one scanner
 *               pass per tick — the replacement for the setInterval loop.
 *
 * Module-scoped state (db handle, bot, scanner, last-scan telemetry) survives
 * across invocations while the isolate stays warm. Turso is the source of
 * truth for anything durable; isolate evictions are harmless (re-init runs
 * idempotent DDL + re-reads state from the database).
 */

interface Env {
  [key: string]: string | undefined;
  TELEGRAM_BOT_TOKEN?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  BIRDEYE_API_KEY?: string;
  HELIUS_API_KEY?: string;
  SCAN_INTERVAL_SECONDS?: string;
  SCAN_PROFILE_LIMIT?: string;
  CRON_RELAY_URL?: string;
  /** The sub-minute clock's tick period in seconds (see TickClock). */
  CLOCK_TICK_SECONDS?: string;
}

/** Minimal ScheduledEvent shape — avoids pulling in workers-types. */
interface ScheduledEventLike {
  cron?: string;
}

/** Minimal ExecutionContext shape — avoids pulling in workers-types. */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The invocation's waitUntil, when the handler driving the tick has one. The
 * HTTP fallback always has (`maybeRunScanIfStale` is itself a waitUntil);
 * `scheduled` gets one only from its third argument, which is why that
 * argument has to be added. The tick's deferred token_stats writes are fired
 * WITHOUT being awaited, and an un-awaited promise is cancelled the moment
 * the handler returns — measured 2026-09-19 as `writeDrain` 4 calls / 4
 * failures (100%), i.e. the bookkeeping never landed. Holding the drain
 * promise here keeps the isolate alive for it WITHOUT adding its cost to the
 * tick itself.
 */
let tickWaitUntil: ((promise: Promise<unknown>) => void) | null = null;

// --- Module-scoped state (warm-isolate lifetime) ---
let db: Db | null = null;
let scanner: Scanner | null = null;
let bot: Bot | null = null;
let webhook: ((req: Request) => Promise<Response>) | null = null;
let dex: DexScreenerClient | null = null;

/**
 * Liquidity the scan ACTUALLY observed this tick, token → usd (2026-09-19).
 *
 * Filled by the pair-fetch wrapper installed in init() and flushed after the
 * tick (see flushObservedLiquidity): it is the raw material for the pool's
 * dead-pool prune (db.ts DEAD_LIQUIDITY_USD) AND for the freshness mark that
 * rides it (db.ts DEAD_POOL_MISS_MAX). The pool used to pre-filter on
 * `max_liquidity_observed`, a lifetime high-water, so a coin that had a pool
 * and LOST it stayed in the sweep forever — live 2026-09-19: 48 of 49 logged
 * rejects were liquidity failures (~72% of them liquidity 0/null) while a coin
 * like `wildebeest` read $0 against a $242K peak. Only readings the scan itself
 * produced go in here: no liquidity field (`null`) leaves the column as it was,
 * so a coin nobody has measured keeps the old behavior instead of being pruned
 * on a guess — and only the leg those rules are CALIBRATED on may write it
 * (observedLiquidityUsd, 2026-10-08: a Jupiter/Gecko reading is a different
 * metric of the same pool, ~half or less, and would push a live coin under the
 * floor).
 */
let observedLiquidity = new Map<string, number>();

/**
 * The liquidity a fetched pair may put in `last_liquidity_usd`, or undefined
 * when the pair carries nothing this column may be judged by (2026-10-08).
 *
 * WHY THE PROVENANCE GUARD. The column is the input of TWO
 * DexScreener-calibrated rules — the re-eval pool's dead-pool floor
 * (db.DEAD_LIQUIDITY_USD) and the freshness mark that rides on it
 * (db.DEAD_POOL_MISS_MAX) — while the other two legs of this bot read the SAME
 * pool as a DIFFERENT metric: Jupiter's per-token `liquidity` is 0.46-0.58x
 * DexScreener's for the very same pool (measured 2026-09-20 over the tracker's
 * rotation, 10 of 14 rows) and GeckoTerminal's reserve under-reports it too
 * (it sums only the pools it indexes). Feeding either in can only leave the
 * stored reading SHORT of the truth, and the pool's prune is one-way and
 * permanent: a live coin whose recorded reading lands under $1K does not
 * return to the sweep until a discovery feed re-registers it — a permanent
 * missed push, the one cost worse than a one-tick delay. The mirror argument
 * decides the freshness half: a reading that is not the same metric must not
 * CLEAR a mark a DexScreener-calibrated rule set.
 *
 * Same rule as every sibling consumer, from the same source of truth
 * (pushwatch.liquidityIsComparable): the scanner's high-water raise
 * (updateTokenMaxMcaps) already omits a non-comparable leg for exactly this
 * reason, and comparableLiquidity() is how the tracker's own liquidity rules
 * read one. `feedSource` absent (fixtures, synthetic pairs, legacy rows) =
 * DexScreener's, which is what keeps this a guard and not a behavior change
 * for the DexScreener lane this wrapper is installed on.
 *
 * WHAT IT DOES NOT DECIDE: a non-comparable answer is NOT a sweep miss either
 * (scanner.poolSweepMisses counts the pool coins the pair answer LEFT OUT, and
 * a Jupiter answer means the pool was readable). Such a coin therefore neither
 * advances nor clears its mark — the correct fail-safe direction, since no
 * unjudgeable evidence may prune a coin, and the next DexScreener-served sweep
 * of the same token records it and resets the mark normally.
 */
export function observedLiquidityUsd(pair: {
  liquidity?: { usd: number | null } | null;
  feedSource?: "dexscreener" | "jupiter" | "gecko";
}): number | undefined {
  if (!liquidityIsComparable(pair)) return undefined;
  const liq = pair.liquidity?.usd;
  // A finite reading including 0: a drained pool's $0 IS its identifying
  // signal, and it is what the floor drops the coin on.
  return typeof liq === "number" && Number.isFinite(liq) ? liq : undefined;
}
let helius: HeliusClient | null = null;
let birdeye: BirdeyeClient | null = null;
let gmgn: GmgnClient | null = null;
let axiom: AxiomClient | null = null;
let arkham: ArkhamClient | null = null;
let crimeWallets: CrimeWalletClient | null = null;
let walletAnalyzer: WalletAnalyzer | null = null;
let flurryAnalyzer: FlurryAnalyzer | null = null;
let trade: TradeService | null = null;
let cfg: AppConfig | null = null;
/** Cooldown for the /debug/flow endpoint: re-analysis of the same mint is
 * expensive (~150–300 Helius credits), so throttle manual triggers. */
const FLOW_DEBUG_COOLDOWN_MS = 30_000;
const flowDebugLastRunAt = new Map<string, number>();
/** Cooldown for the /debug/tick endpoint (manual scan trigger). */
const TICK_DEBUG_COOLDOWN_MS = 25_000;
let tickDebugLastRunAt = 0;
/**
 * Cooldown for /debug/db-latency (see the route). Each call spends six round
 * trips per sample against the SAME database the tick is pushing through, so
 * a poll loop must not be able to add load to the push path — while a human
 * iterating on the numbers should never notice the wait.
 */
const DB_LATENCY_COOLDOWN_MS = 15_000;
let dbLatencyLastRunAt = 0;
/**
 * Cooldown for the /debug/backfill endpoint (one-shot Birdeye backfill).
 * It costs real CU (30–80 per request) and does a full 42h window walk, so
 * keep it manual and rare.
 */
const BACKFILL_DEBUG_COOLDOWN_MS = 5 * 60_000;
let backfillDebugLastRunAt = 0;
/**
 * Durable TTL cache for the two /debug endpoints whose read is a FULL-TABLE
 * SCAN of `token_stats`, and which were completely ungated until now:
 *
 *   /debug/pool       — getPoolHistogram: COUNT(*) over the whole table plus a
 *                       NOT EXISTS probe per row. Measured 2026-10-06 at
 *                       82,711 rows read for a ~0.6s response, and it ALSO
 *                       builds a fresh Db and awaits its init on every call.
 *   /debug/feed-stats — getFeedAttribution: the same full scan LEFT JOINed to
 *                       seen_tokens (~1.0s live).
 *
 * Both answer slowly-changing aggregates (the pool histogram moves with the
 * rotation; the per-feed coin counts move with discovery), yet the endpoints
 * exist to be POLLED — which is exactly what made them expensive: a minute-by-
 * minute reader re-read the entire table every request for a number that had
 * barely moved. This is the single largest avoidable Turso rows-read on the box.
 *
 * WHY DURABLE (a worker_state row) and not an isolate memo: the fleet answers
 * these from whichever isolate Cloudflare routes to, so a per-isolate memo
 * misses on every cold isolate and still lets the scan through. One shared row
 * is a HIT from any isolate. A hit costs ONE keyed row read against the
 * whole-table scan it replaces; a miss pays the scan once and re-seeds the row
 * for the rest of the window.
 *
 * A cached response carries `cached: true` and `cacheAgeMs`, and its own `now`
 * still names the moment the numbers were TAKEN — so the pool histogram's `now`
 * stays consistent with its buckets instead of drifting to read-time. Cache
 * errors are never fatal: an unreadable row is a miss, and a failed seed only
 * means the next poll recomputes.
 */
const DEBUG_SCAN_CACHE_TTL_MS = 5 * 60_000;
const DEBUG_SCAN_CACHE_PREFIX = "debug_scan_cache:";

/** The cached body plus how stale it is, or null on a miss/expiry/error. */
async function readDebugScanCache<T>(
  name: string,
): Promise<{ body: T; ageMs: number } | null> {
  const target = db;
  if (!target) return null;
  try {
    const raw = await target.getWorkerState(DEBUG_SCAN_CACHE_PREFIX + name);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; body?: T };
    if (typeof parsed.at !== "number" || parsed.body === undefined) return null;
    const ageMs = Date.now() - parsed.at;
    if (ageMs < 0 || ageMs >= DEBUG_SCAN_CACHE_TTL_MS) return null;
    return { body: parsed.body, ageMs };
  } catch {
    return null;
  }
}

/** Seed the row (best-effort — see the block comment above). */
async function writeDebugScanCache<T>(name: string, body: T): Promise<void> {
  const target = db;
  if (!target) return;
  try {
    await target.setWorkerState(
      DEBUG_SCAN_CACHE_PREFIX + name,
      JSON.stringify({ at: Date.now(), body }),
    );
  } catch {
    /* best-effort: a failed seed only means the next poll recomputes */
  }
}
/** Minimum gap between fallback scans triggered from the fetch path. */
// How often the HTTP-triggered fallback may LOOK. Cron (1/min) is the primary
// driver, and since 2026-09-27 the fallback is a RESCUE rather than a cadence
// participant: this 60s still bounds how often a request may check, but the
// scan itself now needs the heartbeat to be scanRescueGapMs stale — two missed
// cadences. The old 60s heartbeat check let the fallback fire into EVERY minute
// whose tick was merely late: measured live 05:13-05:30Z (cron ring vs
// scan_history), 26 of 76 completions in 90 minutes were the fallback's, i.e.
// the "cron tick" a reader sees in scan_history was one in three times an HTTP
// invocation — and each of those scans armed the next tick's gate skip.
//
// WHY NOT SHORTER (the 2026-08-14 dead-cron case, and the 2026-09-03 ~4-min
// delivery pause): a genuinely dead cron is still rescued within ~2 minutes,
// which is the same window the outage alert uses; the cost of waiting one extra
// cadence is bounded, and the cost of firing early is the loop above.
const SCAN_TRIGGER_INTERVAL_MS = 60_000;
/**
 * The cron period both trigger expressions share (see TRACKER_CRON and
 * wrangler.toml). Named because the cadence gate's margin
 * must leave the gate strictly above ONE period for any interval larger than
 * it — that is what keeps 90/120 skipping alternate ticks.
 */
export const SCAN_CRON_PERIOD_MS = 60_000;
/**
 * The sub-minute clock's period bounds (see TickClock / clockTickMs): below
 * 15s the scan's own 3-4s duration plus dispatch jitter leaves no room for a
 * gate, and above 5 minutes the clock is a slower cron with extra parts. The
 * tuned value lives in wrangler.toml (`CLOCK_TICK_SECONDS`).
 */
export const TICK_CLOCK_MIN_MS = 15_000;
export const TICK_CLOCK_MAX_MS = 300_000;
/**
 * The fallback's rescue threshold: how stale the last COMPLETED scan must be
 * before an HTTP request may run the scan itself. Two missed cadences, with a
 * 120s floor so the 60s default needs 120s. "Two" is the point: a tick which
 * is merely late (<1 cadence) still scans for itself, and the fallback only
 * engages once that has already failed.
 */
export const SCAN_RESCUE_MIN_GAP_MS = 120_000;
/** The fallback's threshold for a configured scan interval (see above). */
export function scanRescueGapMs(scanGapMs: number): number {
  return Math.max(SCAN_RESCUE_MIN_GAP_MS, scanGapMs * 2);
}
let lastScanTriggerAt = 0;
let lastScanAt: number | null = null;
let lastScanOk = false;
let scanCount = 0;
let initPromise: Promise<void> | null = null;
/**
 * The cached init promise's age bookkeeping (see trackInitBoot): when the boot
 * currently in `initPromise` was created, 0 whenever nothing is pending. Read
 * only through cachedInitVerdict, and only while `initPromise` is set.
 */
const initBoot: { pendingSince: number } = { pendingSince: 0 };

// Diagnostics surfaced via /health so the state of the serverless runtime can
// be observed directly (no terminal access to the isolate).
let dbReady = false;
let botReady = false;
let scannerReady = false;
let initError: string | null = null;
let tursoConfigured = false;
let lastScanMs: number | null = null;
let lastScanError: string | null = null;
let scheduledTicks = 0;
/**
 * Wall-clock of the last scheduled tick that RETURNED in this isolate (0 =
 * none since it booted). The witness behind the pre-init arrival stamp (see
 * shouldStampArrival): a tick killed inside init never reaches its own tail,
 * so this isolate's memory is the cheap signal that says "the arrival I am
 * looking at follows a delivery that never returned" — the one shape the
 * claim-riding arrival bookkeeping (Db.scheduledTickStatements) cannot record,
 * because recording it needs a claim. Only the scheduled handler moves it: the
 * HTTP fallback drives ticks too, but a CRON arrival is what this stamp is a
 * witness of.
 */
let scheduledTickFinishedAt = 0;
let scanRunning = false;
// Whether the HELIUS_API_KEY secret reached the Worker (presence only — never the value).
let heliusConfigured = false;
// Whether the BIRDEYE_API_KEY secret reached the Worker (presence only — never the value).
let birdeyeConfigured = false;
let gmgnConfigured = false;
// Whether ARKHAM_API_KEY reached the Worker (presence only — never the value).
let arkhamConfigured = false;
let crimeWalletsConfigured = false;
let walletAnalyzerConfigured = false;
// Whether AXIOM_EMAIL/PASSWORD reached the Worker (presence only).
let axiomConfigured = false;
// Whether the BOT_WALLET_PRIVATE_KEY secret reached the Worker (presence only).
let tradeConfigured = false;
// Whether the JUPITER_API_KEY secret reached the Worker (presence only —
// requests then carry the x-api-key header for higher rate limits).
let jupiterKeyed = false;
// DexScreener rate-limit telemetry. The per-isolate client counter (see
// DexScreenerClient.getStats) only ever reflects the isolate answering a
// request, so a 429 is also persisted cross-isolate in Turso (db.bumpDex429)
// and mirrored here for the cheap /health read.
let dex429Total = 0;
let dex429At: number | null = null;
// Cross-isolate deferral counters. The scanner's own totals
// (summary.cardSendDeferredTotal / summary.deferRecovered) are per-isolate
// and die with the isolate that produced them, which is why the fleet-wide
// numbers live in Turso (worker_state `push_deferral`, see src/deferrallog.ts)
// and are mirrored here so both heartbeat writes carry them for /health. The
// mirror is re-read from the row once per tick (syncPushDeferralCounters),
// because /health serves whichever isolate wrote the last heartbeat — a
// boot-time-only copy would publish totals that another isolate has already
// moved past.
let pushDeferralSnapshot: PushDeferralSnapshot | null = null;
/**
 * Cumulative scanner totals as of the last CONFIRMED deferral write. The
 * delta between a live summary and this baseline is what gets persisted, and
 * the baseline only advances once the write landed — so a write that failed
 * (or was killed with the invocation) re-offers the same delta on the next
 * tick instead of dropping it, and a delta can never be counted twice.
 *
 * `stalled` is optional here on purpose: the dead-tick rebuild resets this
 * cursor from a literal that predates the counter, and an absent field must
 * read as zero rather than fail to compile. It costs nothing — the amount
 * added for held-back coins comes from stalledUnflushed, not from this
 * difference, and this field only rides along to keep the delta one shape.
 *
 * `pruned` is optional for that same reason, but it IS a cursor difference
 * (like `deferred`/`recovered`): the retirements it counts live on the
 * scanner's registry, which the dead-tick rebuild replaces together with
 * this baseline — see the reset at both rebuild sites.
 */
let pushDeferralBaseline: {
  deferred: number;
  recovered: number;
  stalled?: number;
  pruned?: number;
} = {
  deferred: 0,
  recovered: 0,
  stalled: 0,
  pruned: 0,
};
/**
 * Candidate coins this isolate has watched a tick END with: qualifying coins
 * in hand and no card delivered for them, minus the ones the tick REFUSED a
 * claim slice (those are already counted in `deferred`, see
 * cardSendDeferredTotal on the scanner).
 *
 * Worker-side, and derived from what the summary carries, because the shape
 * it exists to expose has no counter of its own anywhere: the chain stage
 * breaks out of the candidate loop on its own deadline (`chain deadline
 * reached — deferring N candidate(s) to next tick`, scanner.ts) BEFORE the
 * claim stage is ever reached, and logs it without recording it. Two live
 * consequences, both fixed by turning the gap into a number: a deployment's
 * `candidates 1, pushed 0` ticks could outnumber its recorded deferrals
 * indefinitely (2026-09-19: 33 of 118 ticks against 5-6 deferrals/hour), and
 * the rate could not be read from /health at all. See stalledTotal in
 * src/deferrallog.ts for what this count can and cannot attribute — it is a
 * lower bound on chain-stage deferrals, since a candidate skipped because
 * every enabled chat already had the coin is counted in it too.
 *
 * Cumulative, and used for exactly two things: the log line and the applied
 * marker that makes a lost write idempotent. The amount that actually gets
 * ADDED to the durable row is stalledUnflushed below.
 */
let stalledCandidatesTotal = 0;
/**
 * Held-back coins counted since the last CONFIRMED deferral write — the
 * pending DELTA for `stalledTotal`, deliberately kept apart from
 * `pushDeferralBaseline`.
 *
 * `deferred`/`recovered` are cursor differences (isolate total − baseline),
 * which is safe only because the dead-tick rebuild resets BOTH the Scanner
 * that produces those totals and the baseline that follows them. This counter
 * has no such pairing: it lives in worker module state, which the rebuild
 * leaves alone (only the clients and the Scanner are replaced), while the
 * rebuild's baseline literal carries no `stalled` field — so as a cursor
 * difference it would read `stalled − 0` and re-offer every held-back coin
 * counted since boot as fresh, once per rebuild. A pending delta has no such
 * failure mode: it grows on every completed tick and is cleared in exactly
 * one place, after a write that actually landed.
 */
let stalledUnflushed = 0;
/**
 * How long the post-flush deferral sync may take before the tick moves on.
 * Telemetry is never allowed to extend the invocation: the outer finally still
 * has bookkeeping to run (the dead-tick streak, the safety-net lock release),
 * and a sync this bounds away is simply re-offered next tick. Generous against
 * the ~100-400ms a healthy read + write costs.
 */
const DEFERRAL_SYNC_BOUND_MS = 1_000;

// Durable push-baseline ledger (src/pushledger.ts). `push_watch.mcap_at_push`
// is written by THREE code paths (the push itself, the self-heal enrollment
// and the dead-resurrection reset) and only the first is the gate value —
// which is how 7/39 rows ended up carrying a "push mcap" nowhere near any
// filter band (2026-09-19 audit). The ledger keeps one immutable record per
// pushed token (true push mcap + the band in force + whether a row's baseline
// was later rewritten), so calibration stops depending on a mutable column.
// Same shape as the deferral counters above: durable row = source of truth,
// this module-local copy only feeds the heartbeat's cheap /health read.
type PushLedgerView = ReturnType<typeof pushLedgerStats> & {
  /**
   * Heal-path counters (src/pushwatch.ts). They ride the ledger view because
   * the completion heartbeat serializes this mirror and nothing else this
   * module owns, while the self-heal is exactly a push-baseline event: how many
   * baselines were re-seeded from the ledger's push-time value rather than from
   * the coin's current mcap. The pre-race heartbeat additionally carries a flat
   * `heal` copy, so the numbers stay readable on a tick where the ledger view
   * is unavailable.
   */
  heal?: ReturnType<typeof pushWatchHealStats>;
};
let pushLedgerMirror: PushLedgerView | null = null;
/**
 * Minimum gap between reconciliations. Push volume is ~5/h and both sources
 * (the audit ring holds 30 entries, rows live 26h) tolerate minutes of lag,
 * while every pass costs a few Turso round trips — so this is throttled off
 * the per-minute path instead of running every tick.
 */
const PUSH_LEDGER_SYNC_MIN_GAP_MS = 5 * 60_000;
// PUSH_LEDGER_SYNC_BOUND_MS retired: the reconciliation rides the deferral
// tail's one read + one write now (syncPushDeferralCounters), which the call
// site bounds once. Stacked per-sync bounds were three 900ms races around
// round trips that no longer exist.
let pushLedgerSyncedAt = 0;

/**
 * The delivery audit ring's `worker_state` key. Db.getPushAudit() reads this
 * same row; the tick tail's read (TAIL_STATE_KEYS) fetches it alongside the
 * deferral/ledger/skip/Birdeye rows, so neither the ledger reconciliation nor
 * the duplicate guard's proof costs an extra round trip.
 */
const PUSH_AUDIT_STATE_KEY = "push_audit";

/**
 * Fleet-wide early-return counters (src/skipcapture.ts): the durable half of
 * "the sweep returned without evaluating anything, because X". The isolate copy
 * answers why the tick being reported did nothing; this one answers how often
 * that happens, which one isolate's ~10-20 minute lifetime cannot.
 */
let skipCaptureMirror: SkipCaptureState = emptySkipCaptureState();
/** Same throttle/bound rationale as the ledger sync: telemetry off the tick path. */
const SKIP_CAPTURE_SYNC_MIN_GAP_MS = 5 * 60_000;
// SKIP_CAPTURE_SYNC_BOUND_MS retired: same one read + one write as the ledger.
let skipCaptureSyncedAt = 0;

/**
 * Durable Birdeye CU ledger.
 *
 * Birdeye's free tier is 30_000 CU a MONTH for the whole bot and, until
 * now, nothing in this repo counted it: the quota table in
 * docs/round-trips.md §4.4.2 was inferred from the push count, not
 * measured. The client charges every request ATTEMPT into module state
 * (src/birdeye.ts BIRDEYE_CU_PRICES); this is the durable half — a
 * day-keyed total in worker_state, so the number survives isolate recycling
 * and /health can read it from any isolate.
 *
 * Why not count it live per tick: a per-tick round trip is exactly what the
 * 50-subrequest invocation budget cannot pay (docs/round-trips.md §1), so
 * the drain rides the throttled post-scan telemetry instead. What that
 * costs is bounded and stated: an isolate recycled inside the sync gap
 * loses its OWN delta (≤ one gap of spend), which is why the read is
 * unconditional — a fresh isolate republishes the fleet total rather than
 * starting from zero and under-reporting the month.
 */
const BIRDEYE_CU_STATE_KEY = "birdeye_cu_v1";

/**
 * The same accounting, split by endpoint (see planBirdeyeCuBySync). A SECOND
 * key rather than a second shape in the first one: `birdeye_cu_v1` is already
 * durable, already read by /health and already carries the days that predate
 * this breakdown, and a day total with no split is not the same reading as a
 * day total whose split is zero. The two rows are written in the SAME batch
 * and read in the SAME request, so the split costs no round trip — only
 * payload.
 */
const BIRDEYE_CU_BY_STATE_KEY = "birdeye_cu_by_v1";

/**
 * Every durable row the tick tail owns, read in ONE request
 * (Db.readPostScanTelemetry) at the top of syncPushDeferralCounters:
 *
 *  - `push_deferral` — the snapshot the duplicate guard trims and the counters
 *    are folded into;
 *  - `push_ledger` / `push_audit` — the ledger reconciliation's two sources,
 *    which are also the duplicate guard's hardest proof of delivery;
 *  - `skip_capture` / `birdeye_cu_v1` — the other two throttled 5-minute rows.
 *
 * Before this the tail read them separately — the deferral row, then the audit
 * ring (plus the ledger row and the watch listing whenever something was
 * pending), then a second four-row batch for the telemetry — so a tick with
 * everything due spent SIX round trips deciding what to write. Each one is a
 * subrequest out of the invocation's 50 and the tracker pass spends the same
 * budget LAST (docs/round-trips.md §4.9), so they are one request now. The row
 * set is unchanged: readPostScanTelemetry's ORDER BY ... LIMIT is byte-for-byte
 * listPushWatch's.
 */
const TAIL_STATE_KEYS = [
  PUSH_DEFERRAL_STATE_KEY,
  PUSH_LEDGER_STATE_KEY,
  PUSH_AUDIT_STATE_KEY,
  SKIP_CAPTURE_STATE_KEY,
  BIRDEYE_CU_STATE_KEY,
  BIRDEYE_CU_BY_STATE_KEY,
] as const;

/**
 * What that one read hands back: the raw rows (a missing key is a row that was
 * never written) plus the watch listing and the enabled chat band, which the
 * duplicate guard's proofs and the ledger merge read.
 */
type TailReadout = Awaited<ReturnType<Db["readPostScanTelemetry"]>>;
/** Same telemetry throttle/bound rationale as the ledger and skip syncs. */
const BIRDEYE_CU_SYNC_MIN_GAP_MS = 5 * 60_000;
// BIRDEYE_CU_SYNC_BOUND_MS retired: same one read + one write as the ledger.
let birdeyeCuSyncedAt = 0;

/** Birdeye's free-tier allowance, reported when config does not override it. */
export const BIRDEYE_MONTHLY_CU_DEFAULT = 30_000;

/** `YYYY-MM-DD` and nothing else (the ledger's only accepted day keys). */
function isBirdeyeDayKey(day: string): boolean {
  if (day.length !== 10 || day[4] !== "-" || day[7] !== "-") return false;
  for (let i = 0; i < day.length; i++) {
    if (i === 4 || i === 7) continue;
    const c = day.charCodeAt(i);
    if (c < 48 || c > 57) return false; // 0-9
  }
  return true;
}

/** Pure parser for the durable ledger (`{ v: 1, days: { "YYYY-MM-DD": cu } }`). */
export function parseBirdeyeCuLedger(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { days?: unknown };
    const days = parsed?.days;
    if (!days || typeof days !== "object") return {};
    const out: Record<string, number> = {};
    for (const [day, cu] of Object.entries(days as Record<string, unknown>)) {
      const n = Number(cu);
      if (isBirdeyeDayKey(day) && Number.isFinite(n) && n >= 0) out[day] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Pure merge: add this isolate's deltas to the durable day map and drop days
 * older than the retention window. The ledger only has to answer "this
 * calendar month", so a fixed tail is all a reader can want and keeps the
 * row small.
 */
export function mergeBirdeyeCuLedger(
  durable: Record<string, number>,
  delta: Map<string, number>,
  now = Date.now(),
): Record<string, number> {
  const next: Record<string, number> = { ...durable };
  for (const [day, cu] of delta) next[day] = (next[day] ?? 0) + cu;
  const cutoff = birdeyeUtcDay(now - BIRDEYE_CU_LEDGER_DAYS * 86_400_000);
  for (const day of Object.keys(next)) {
    if (day < cutoff) delete next[day];
  }
  return next;
}

/** Pure reader: today's CU plus the calendar month's total (quota window). */
export function birdeyeCuStats(
  days: Record<string, number>,
  now = Date.now(),
): { day: string; today: number; monthCu: number } {
  const day = birdeyeUtcDay(now);
  const month = day.slice(0, 7);
  let monthCu = 0;
  for (const [d, cu] of Object.entries(days)) {
    if (d.startsWith(month)) monthCu += cu;
  }
  return { day, today: days[day] ?? 0, monthCu };
}

/** This isolate's unpersisted spend, for /health's `pendingCu`. */
function birdeyeCuPendingTotal(): number {
  let total = 0;
  for (const cu of peekBirdeyeCuDelta().values()) total += cu;
  return total;
}

/**
 * Pure parser for the per-endpoint ledger (`{ v: 1, days: { day: counts } }`).
 * As defensive as the total ledger's: an unknown endpoint name, a negative or
 * non-finite number and a malformed day key are all dropped, so a hand-edited
 * or older row degrades to "no reading" instead of feeding a budget decision a
 * number nobody spent.
 */
export function parseBirdeyeCuByLedger(raw: string | null): Record<string, BirdeyeCuCounts> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { days?: unknown };
    const days = parsed?.days;
    if (!days || typeof days !== "object") return {};
    const known = Object.keys(BIRDEYE_CU_PRICES) as Array<keyof typeof BIRDEYE_CU_PRICES>;
    const out: Record<string, BirdeyeCuCounts> = {};
    for (const [day, counts] of Object.entries(days as Record<string, unknown>)) {
      if (!isBirdeyeDayKey(day) || !counts || typeof counts !== "object") continue;
      const cells: BirdeyeCuCounts = {};
      for (const endpoint of known) {
        const cell = (counts as Record<string, unknown>)[endpoint];
        if (!cell || typeof cell !== "object") continue;
        const calls = Number((cell as Record<string, unknown>).calls);
        const cu = Number((cell as Record<string, unknown>).cu);
        if (!Number.isFinite(calls) || !Number.isFinite(cu)) continue;
        if (calls < 0 || cu < 0) continue;
        if (calls === 0 && cu === 0) continue; // nothing billed here
        cells[endpoint] = { calls, cu };
      }
      if (Object.keys(cells).length > 0) out[day] = cells;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Pure merge for the split ledger: add this isolate's cells to the durable
 * ones, then apply the SAME retention window the total ledger uses — the two
 * rows must never disagree about which days exist, or /health would print a
 * month total whose breakdown is missing the days it covers.
 */
export function mergeBirdeyeCuByLedger(
  durable: Record<string, BirdeyeCuCounts>,
  delta: Map<string, BirdeyeCuCounts>,
  now = Date.now(),
): Record<string, BirdeyeCuCounts> {
  const next: Record<string, BirdeyeCuCounts> = {};
  for (const [day, counts] of Object.entries(durable)) {
    const copy: BirdeyeCuCounts = {};
    for (const [endpoint, cell] of Object.entries(
      counts as Record<string, { calls: number; cu: number } | undefined>,
    )) {
      if (cell) (copy as Record<string, { calls: number; cu: number }>)[endpoint] = { ...cell };
    }
    next[day] = copy;
  }
  for (const [day, counts] of delta) {
    const target =
      next[day] ?? (next[day] = {} as BirdeyeCuCounts);
    for (const [endpoint, cell] of Object.entries(
      counts as Record<string, { calls: number; cu: number } | undefined>,
    )) {
      if (!cell) continue;
      const rec = target as Record<string, { calls: number; cu: number }>;
      const own = rec[endpoint] ?? { calls: 0, cu: 0 };
      rec[endpoint] = { calls: own.calls + cell.calls, cu: own.cu + cell.cu };
    }
  }
  const cutoff = birdeyeUtcDay(now - BIRDEYE_CU_LEDGER_DAYS * 86_400_000);
  for (const day of Object.keys(next)) {
    if (day < cutoff) delete next[day];
  }
  return next;
}

/** Pure reader for the split ledger: today's cells, plus the month's. */
export function birdeyeCuByStats(
  days: Record<string, BirdeyeCuCounts>,
  now = Date.now(),
): { today: BirdeyeCuCounts; month: BirdeyeCuCounts } {
  const day = birdeyeUtcDay(now);
  const month = day.slice(0, 7);
  const today: BirdeyeCuCounts = {};
  const monthCells: BirdeyeCuCounts = {};
  const add = (target: BirdeyeCuCounts, counts: BirdeyeCuCounts): void => {
    for (const [endpoint, cell] of Object.entries(
      counts as Record<string, { calls: number; cu: number } | undefined>,
    )) {
      if (!cell) continue;
      const rec = target as Record<string, { calls: number; cu: number }>;
      const own = rec[endpoint] ?? { calls: 0, cu: 0 };
      rec[endpoint] = { calls: own.calls + cell.calls, cu: own.cu + cell.cu };
    }
  };
  for (const [d, counts] of Object.entries(days)) {
    if (!d.startsWith(month)) continue;
    add(monthCells, counts);
    if (d === day) add(today, counts);
  }
  return { today, month: monthCells };
}

/**
 * The day totals, newest first — what turns `monthCu` (one number whose window
 * starts wherever the counter was deployed) into a rate an operator can divide
 * by the days it covers. Reporting only, like every other reader here.
 */
export function birdeyeCuRecentDays(
  days: Record<string, number>,
  limit = 7,
): Array<{ day: string; cu: number }> {
  return Object.entries(days)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, Math.max(0, limit))
    .map(([day, cu]) => ({ day, cu }));
}

/**
 * Persist this isolate's Birdeye CU delta (see the ledger above). Same
 * discipline as the push-ledger and skip-capture syncs: the READ is
 * unconditional, and the in-memory delta is only cleared after a write that
 * actually landed, so a failed write re-offers it instead of dropping it.
 *
 * No production caller any more: the tick tail calls planBirdeyeCuSync inside
 * its one read + one write, and this single-key form survives as that
 * planner's test seam (scripts/test-unit.js).
 */
export async function syncBirdeyeCu(
  now = Date.now(),
  database: Db | null = db,
): Promise<void> {
  if (!database) return;
  // Both rows, ONE read and ONE write — the same shape the tick tail uses
  // (planPostScanTelemetry), so this seam prices what production pays. The
  // split's delta is cleared only after the batch that carried it landed,
  // exactly like the total's.
  const { delta, next, byDelta, byNext } = planBirdeyeCuSyncGrouped(
    await database.getWorkerStates([BIRDEYE_CU_STATE_KEY, BIRDEYE_CU_BY_STATE_KEY]),
    now,
  );
  if (!next && !byNext) return;
  const writes: Array<{ key: string; value: string }> = [];
  if (next) writes.push({ key: BIRDEYE_CU_STATE_KEY, value: next });
  if (byNext) writes.push({ key: BIRDEYE_CU_BY_STATE_KEY, value: byNext });
  await database.setWorkerStatesMany(writes);
  if (next) consumeBirdeyeCuDelta(delta);
  if (byNext) consumeBirdeyeCuByDay(byDelta);
}

/**
 * Both ledgers planned against the tail's ONE read: the day totals, and the
 * per-endpoint split that answers WHICH caller spent them. Each half keeps its
 * own delta so a rejected batch re-offers both instead of clearing either.
 */
function planBirdeyeCuSyncGrouped(
  states: Map<string, string>,
  now: number,
): {
  delta: Map<string, number>;
  next: string | null;
  byDelta: Map<string, BirdeyeCuCounts>;
  byNext: string | null;
} {
  const total = planBirdeyeCuSync(states.get(BIRDEYE_CU_STATE_KEY) ?? null, now);
  const by = planBirdeyeCuBySync(states.get(BIRDEYE_CU_BY_STATE_KEY) ?? null, now);
  return { ...total, ...by };
}

/**
 * The Birdeye CU merge as a pure function, shared by the single sync and the
 * grouped post-scan telemetry path so both write the same row. `next` null
 * means this isolate has nothing new to persist; the delta is handed back so
 * the caller can consume it only after a write that actually landed.
 */
function planBirdeyeCuSync(
  raw: string | null,
  now: number,
): { delta: Map<string, number>; next: string | null } {
  const delta = peekBirdeyeCuDelta();
  if (delta.size === 0) return { delta, next: null };
  const days = mergeBirdeyeCuLedger(parseBirdeyeCuLedger(raw), delta, now);
  return { delta, next: JSON.stringify({ v: 1, days }) };
}

/** Same planner for the per-endpoint ledger (see BIRDEYE_CU_BY_STATE_KEY). */
function planBirdeyeCuBySync(
  raw: string | null,
  now: number,
): { byDelta: Map<string, BirdeyeCuCounts>; byNext: string | null } {
  const byDelta = peekBirdeyeCuByDay();
  if (byDelta.size === 0) return { byDelta, byNext: null };
  const days = mergeBirdeyeCuByLedger(parseBirdeyeCuByLedger(raw), byDelta, now);
  return { byDelta, byNext: JSON.stringify({ v: 1, days }) };
}

/**
 * Cross-isolate 429 bookkeeping: the scan that trips DexScreener's batched
 * limit may run in any isolate, so the count lives in Turso while this
 * module-local mirror keeps /health from reading it twice per request. This
 * is the "is 250ms spacing safe?" monitor for DEX_REQUEST_INTERVAL_MS —
 * fired from the client's hook, never from the scan's critical path.
 */
async function recordDex429(at: number): Promise<void> {
  dex429Total++;
  dex429At = at;
  try {
    await db?.bumpDex429(at);
  } catch {
    // telemetry only — never fail a scan over a counter write
  }
}

/**
 * Persist the tick's observed liquidity (see observedLiquidity) so the pool's
 * dead-pool prune can read how much of a pool is left instead of how much it
 * ever had (db.ts DEAD_LIQUIDITY_USD).
 *
 * Called AFTER the tick and behind the deferred-write drain, never inside it:
 * the drain carries the tick's own persistence, and both are fire-and-forget so
 * neither can delay a card's claim or the completion flush. The map is cleared
 * BEFORE the write on purpose — a failed round trip costs one tick of freshness
 * on a signal that is recomputed on every sweep, and re-sending a stale batch
 * later would report liquidity from a tick that is already over.
 *
 * The same call owns the FRESHNESS MARK's half (2026-10-08): the pool coins
 * the sweep asked for and got nothing back for, taken once from the scanner
 * that ran the sweep (Scanner.takePoolSweepMisses — see poolSweepMisses and
 * db.DEAD_POOL_MISS_MAX). They ride here because this is the only place both
 * halves of the same fact exist: the readings that CLEAR the mark and the
 * empty sweeps that ADVANCE it are produced by one sweep, so writing them
 * together is what makes an overlap impossible. The advance runs first on
 * purpose — if a coin were ever in both lists (the construction forbids it: a
 * coin with a pair cannot be a miss), it must land on 0, alive. A prune that
 * can never be undone may only fail toward serving a coin.
 */
async function flushObservedLiquidity(source: Scanner | null): Promise<void> {
  if (!db) return;
  const missed = source?.takePoolSweepMisses() ?? [];
  // Taken BEFORE the empty-map return below: a tick whose pair batch came back
  // refused is exactly a tick with no readings and no misses (the scanner's
  // coverage guard empties the list), and a tick whose pool coins got nothing
  // is exactly a tick with misses and possibly no readings. Neither half may
  // be skipped by the other's emptiness.
  if (observedLiquidity.size === 0 && missed.length === 0) return;
  if (missed.length > 0) {
    try {
      await db.noteSweptWithoutReading(missed);
    } catch (err) {
      console.warn(
        "[worker] pool sweep-miss write failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const rows = [...observedLiquidity].map(([token, liquidityUsd]) => ({
    token,
    liquidityUsd,
  }));
  observedLiquidity = new Map();
  if (rows.length > 0) {
    try {
      await db.recordObservedLiquidity(rows);
    } catch (err) {
      console.warn(
        "[worker] observed-liquidity write failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Forget deferred obligations the delivery audit ring already discharged (the
 * rule is deliveredDeferredTokens; the duplicate it fixes is 2026-09-20 00:47Z
 * GROYPER — a card, then the same card again two minutes later).
 *
 * Three deliberate choices:
 *  - FRESH read, not the module mirror: the duplicate lands on the very next
 *    tick, which is inside the push-ledger sync's 5-minute throttle, so a
 *    reused copy would be exactly the copy that cannot see the push yet. The
 *    read rides the tail's ONE request (TAIL_STATE_KEYS) and happens after the
 *    completion flush, where a round trip cannot cost a card or the flush
 *    window.
 *  - Best-effort: a read that fails leaves the pending list exactly as it was
 *    (the caller re-offers the whole tail on the next tick). The cost of that
 *    is the duplicate we already had, never a forgotten obligation.
 *  - THREE proof sources, because the ring alone is too short-lived: the audit
 *    ring holds ~30 deliveries of ALL kinds (initial, resend, follow-up, heal),
 *    and live 2026-09-20 it rolled two of the four stale tokens out of its
 *    window inside 13 minutes. The durable push ledger carries `initial`
 *    provenance for 7 days / 240 pushes, and `push_watch` rows (written right
 *    after a successful push) cover the `resend`-only deliveries the ledger by
 *    design does not record. All three travel in that one read and are folded
 *    into one proof set; only the kind whitelist in deliveredDeferredTokens
 *    decides.
 *
 * Pure apart from the shared registry drop (the caller does every read), so it
 * cannot quietly grow a round trip: the tail's read is the only read this rule
 * has.
 */
function dropDeliveredPendings(tail: TailReadout, pending: readonly string[]): string[] {
  // The audit ring is read on EVERY tick, not only when something is pending:
  // it is also where the duplicate count comes from (noteDuplicateCards), and
  // without that number on the heartbeat neither the operator's report nor any
  // fix can be measured. It and the two other proof sources (durable ledger,
  // watch rows) ride the tail's one request unconditionally now — the count is
  // free, and the proof sources cost their rows, not a round trip.
  const audit = parsePushAuditState(tail.states.get(PUSH_AUDIT_STATE_KEY) ?? null);
  const ledgerRaw = tail.states.get(PUSH_LEDGER_STATE_KEY) ?? null;
  const watchRows = tail.pushWatch;
  // Duplicate telemetry rides the read that is already here. It is taken BEFORE
  // the early return below, because a token pushed twice has nothing to do with
  // whether anything is currently owed — and it only ever COUNTS: the one
  // function allowed to drop an obligation is deliveredDeferredTokens, and only
  // on hard proof of delivery.
  try {
    noteDuplicateCards(duplicateInitialTokens(audit));
  } catch {
    /* telemetry only */
  }
  if (pending.length === 0) return [];
  // Each source is labelled with the kind the rule expects: the ledger's
  // `initial-send` entries ARE audit `initial` provenance (that is the merge's
  // only accepted source), and a watch row is its own `pushed-row` proof (see
  // DELIVERED_CARD_KINDS — a row exists only for a token a push delivered).
  const proof = [
    ...audit,
    ...ledgerDeliveredTokens(parsePushLedger(ledgerRaw)).map((token) => ({
      token,
      kind: "initial" as const,
    })),
    ...watchRows.map((row) => ({ token: row.token, kind: "pushed-row" as const })),
  ];
  const stale = deliveredDeferredTokens(pending, proof);
  if (stale.length === 0) return [];
  const forgotten = forgetDeferredTokens(stale);
  console.log(
    `[worker] forgot ${forgotten} deferred obligation(s) already delivered — a lost completion write had left them owed (duplicate guard)`,
  );
  return stale;
}

/**
 * Bring the durable deferral counters (src/deferrallog.ts) in step with this
 * tick's summary, and refresh the copy the heartbeat publishes.
 *
 * Called AFTER the completion flush on purpose: the flush is the tick's last
 * must-land write, so telemetry that runs after it can only ever cost the
 * counters — never the heartbeat, the scan_history row or the lease release.
 *
 * The READ is unconditional, the WRITE is not. Reading only on ticks that
 * deferred something would leave this isolate publishing its pre-write copy
 * forever the moment ANOTHER isolate added to the row, and /health serves
 * whichever heartbeat was written last — so the fleet totals would visibly go
 * backwards, or the first make-up push would be hidden behind a stale null,
 * on exactly the milestone the counters exist to prove.
 */
export async function syncPushDeferralCounters(
  summary: ScanSummary | null,
  database: Db | null = db,
  now = Date.now(),
): Promise<void> {
  // Called after the completion flush; keep the expensive telemetry reads here
  // rather than on the scan's pre-race path.
  //
  // ORDER MATTERS, and the duplicate guard is why. This function is raced on
  // the tick's tail with `min(DEFERRAL_SYNC_BOUND_MS, remainingFlushMs())`, and
  // its telemetry half used to be a separate block with its own 900ms bound
  // that ran FIRST — so a tick where that throttle fired never reached the
  // guard at all: live 2026-09-20 the two delivered-but-owed tokens
  // `DFQHUegJW…` / `BmnGRH8N1…` stayed pending across two deploys and four
  // minutes of ticks even though the rule matches them (verified by replaying
  // the live pending list against the live watch rows offline). The guard runs
  // FIRST now, and since the whole tail is ONE read + ONE batch there is
  // nothing left for the telemetry to starve: an in-memory drop is applied the
  // moment it is proved, and the row that persists it shares its transaction
  // with the telemetry that used to starve it.
  //
  // The optional `database` / `now` are the unit-test seam, the same shape
  // syncPushLedger / syncSkipCaptureState / syncBirdeyeCu carry; production
  // calls this with the summary alone.
  if (!database) return;
  // Held-back candidates: the tick's own gap, counted once per completed
  // summary (see heldBackCandidates — the derivation, and why it is a lower
  // bound on chain-stage deferrals, live with it and its unit tests).
  const heldBack = heldBackCandidates(summary);
  if (heldBack > 0) {
    stalledCandidatesTotal += heldBack;
    // The pending delta too: this is the amount a landed write will add, and
    // it survives a rebuild (see stalledUnflushed).
    stalledUnflushed += heldBack;
  }
  const totals = {
    deferred: summary?.cardSendDeferredTotal ?? 0,
    recovered: summary?.deferRecovered ?? 0,
    stalled: stalledCandidatesTotal,
    // Retirements are a CURSOR difference like deferred/recovered (the
    // registry and the baseline above are replaced together by the
    // dead-tick rebuild), never a pending delta like stalled.
    pruned: summary?.deferPruned ?? 0,
  };
  const ledgerDue = now - pushLedgerSyncedAt >= PUSH_LEDGER_SYNC_MIN_GAP_MS;
  const skipDue = now - skipCaptureSyncedAt >= SKIP_CAPTURE_SYNC_MIN_GAP_MS;
  const birdeyeDue = now - birdeyeCuSyncedAt >= BIRDEYE_CU_SYNC_MIN_GAP_MS;
  // ONE read for the whole tail (see TAIL_STATE_KEYS): the duplicate guard's
  // three proof sources, the deferral row it trims, and the three telemetry
  // rows. A failed read re-offers all of it next tick and writes nothing.
  let tail: TailReadout;
  try {
    tail = await database.readPostScanTelemetry(TAIL_STATE_KEYS);
  } catch (err) {
    console.warn(
      "[worker] tick tail read failed (deferral counters and telemetry re-offered next tick):",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  const raw = tail.states.get(PUSH_DEFERRAL_STATE_KEY) ?? null;
  const durable = parsePushDeferralSnapshot(raw);
  // Duplicate guard: a delivered coin must not stay "owed". The push and the
  // pending-list write ride the same completion flush, so a lost flush leaves
  // it pending and the make-up pass pushes the card again (see
  // dropDeliveredPendings). Seeding happens AFTER the drop, so neither the
  // registry nor the published gauge can resurrect it.
  const stale = dropDeliveredPendings(tail, durable?.pendingTokens ?? []);
  const owedPending = durable
    ? durable.pendingTokens.filter((token) => !stale.includes(token))
    : [];
  // The row is authoritative: mirror it even when this isolate has nothing of
  // its own to add (that is the cross-isolate refresh).
  const refreshMirror = (): void => {
    if (durable) {
      pushDeferralSnapshot = {
        ...durable,
        pending: owedPending.length,
        pendingTokens: owedPending,
      };
      scanner?.seedDeferredTokens(owedPending);
    }
  };
  // Apply it NOW rather than waiting for the delta path below: the seed and the
  // published list must reflect the drop even on a tick whose write never lands
  // (that in-memory half is what actually stops the duplicate push — the write
  // only stops a later RECYCLE from re-seeding it).
  refreshMirror();
  // What the whole tail writes, in ONE batch at the end (see the landing point
  // below): the duplicate guard's shrink first — a later write to the same row
  // supersedes it, exactly the order the two round trips kept — then the
  // telemetry merges, then the deferral delta.
  const writes: Array<{ key: string; value: string }> = [];
  let shrunk: PushDeferralSnapshot | null = null;
  if (stale.length > 0) {
    // Persist the shrunken pending list before any other round trip on this
    // tail. Zero deltas on purpose: this row carries the drop, not counters,
    // and the delta row below supersedes it when both are planned.
    shrunk = nextPushDeferralSnapshot(
      raw,
      { deferred: 0, recovered: 0, stalled: 0, pending: owedPending.length },
      now,
      { owner: SCAN_LOCK_OWNER, ...totals },
      owedPending,
    );
    writes.push({ key: PUSH_DEFERRAL_STATE_KEY, value: JSON.stringify(shrunk) });
  }
  // The three throttled telemetry merges ride the SAME read and land in the
  // SAME batch: they used to be a second read plus a second write, each with
  // its own 900ms bound.
  const telemetry = planPostScanTelemetry(
    now,
    { ledger: ledgerDue, skip: skipDue, birdeye: birdeyeDue },
    tail,
  );
  writes.push(...telemetry.writes);
  const cursorDelta = pushDeferralDelta(pushDeferralBaseline, totals);
  // The held-back half rides its own pending delta (see stalledUnflushed), and
  // that is what makes a chain-deferral-only tick persist at all: cursorDelta
  // is null whenever the scanner's own counters did not move — exactly the
  // shape this counter exists for. `totals.stalled` still travels with every
  // write as the applied marker, but it is not the amount added. Retirements
  // (pruned) travel on the CURSOR, like deferred/recovered, because they are
  // scanner state the dead-tick rebuild resets alongside this baseline.
  const delta = {
    deferred: cursorDelta?.deferred ?? 0,
    recovered: cursorDelta?.recovered ?? 0,
    stalled: stalledUnflushed,
    pruned: cursorDelta?.pruned ?? 0,
  };
  // `stale.length > 0` keeps the write path open for a drop-only tick: the
  // durable row has to lose those tokens too, or a recycled isolate re-seeds
  // them from storage (see the seed call site) and pushes the same card again.
  // A RETIREMENT-only tick rides the same way through its own delta
  // (`delta.pruned`): that is what persists the pending list the prune
  // shrank, and why a prune with no deferral/recovery/held-back coin still
  // writes.
  let next: PushDeferralSnapshot | null = null;
  let acked = false;
  if (
    delta.deferred <= 0 &&
    delta.recovered <= 0 &&
    delta.stalled <= 0 &&
    delta.pruned <= 0 &&
    stale.length === 0
  ) {
    // Nothing new for the deferral row; the telemetry half of the batch (if
    // anything is due) still lands below.
  } else if (stale.length === 0 && pushDeferralAlreadyApplied(durable, SCAN_LOCK_OWNER, totals)) {
    // A previous attempt of this very write committed while its response was
    // lost (hard wall, invocation kill). The row already carries it — ACK
    // rather than add it a second time.
    acked = true;
  } else {
    next = nextPushDeferralSnapshot(
      raw,
      {
        ...delta,
        // NOT the gauge any more: the snapshot derives `pending` from the list
        // below (see nextPushDeferralSnapshot), because the two must be one
        // fact. This value is the scanner's scan-time count (`deferPending`),
        // taken before the duplicate guard trimmed the list, and publishing it
        // is what made /health read "pending 7" next to a 5-token list on
        // 2026-09-20. It still travels: it is the fallback gauge for a caller
        // that passes no list at all.
        pending: summary?.deferPending ?? 0,
      },
      now,
      { owner: SCAN_LOCK_OWNER, ...totals },
      deferredPushTokens(),
    );
    writes.push({ key: PUSH_DEFERRAL_STATE_KEY, value: JSON.stringify(next) });
  }
  // ONE write for the whole tail: the guard's shrink, the three telemetry
  // merges and the deferral delta land together or not at all. A rejected batch
  // leaves every in-memory delta pending and the baseline where it was — the
  // discipline the separate writes kept, now the transaction's own property.
  let landed = writes.length === 0;
  if (writes.length > 0) {
    try {
      await database.setWorkerStatesMany(writes);
      landed = true;
    } catch (err) {
      console.error(
        "[worker] tick tail write failed (deferral counters and telemetry re-offered next tick):",
        err instanceof Error ? err.message : err,
      );
    }
  }
  // The telemetry throttle advances whether or not the batch landed: those rows
  // are best-effort telemetry, a failed write is already re-offered through the
  // un-cleared deltas, and the next attempt waits out the same gap.
  const settledAt = Date.now();
  if (ledgerDue) pushLedgerSyncedAt = settledAt;
  if (skipDue) skipCaptureSyncedAt = settledAt;
  if (birdeyeDue) birdeyeCuSyncedAt = settledAt;
  if (landed) {
    // Telemetry side effects only AFTER the batch lands, in the order the
    // standalone syncs applied them: a landed write is the only thing that
    // clears a delta or refreshes a mirror.
    if (telemetry.skipDelta && telemetry.skipMerged) {
      markSkipCaptureSynced();
      console.log(
        `[worker] skip capture persisted: +${telemetry.skipDelta.total} early return(s) (fleet total ${telemetry.skipMerged.total}, last "${telemetry.skipMerged.lastReason ?? "unknown"}")`,
      );
    }
    if (telemetry.birdeyeDelta) consumeBirdeyeCuDelta(telemetry.birdeyeDelta);
    if (telemetry.birdeyeByDelta) consumeBirdeyeCuByDay(telemetry.birdeyeByDelta);
    if (telemetry.ledgerMirror) pushLedgerMirror = telemetry.ledgerMirror;
    if (telemetry.skipMirror) skipCaptureMirror = telemetry.skipMirror;
  }
  if (acked) {
    pushDeferralBaseline = totals;
    stalledUnflushed = 0;
  }
  if (next && landed) {
    pushDeferralSnapshot = next;
    // Baseline advances ONLY here. A write that threw (or was killed past the
    // invocation's wall clock) leaves it untouched, so the next tick re-offers
    // the same delta — and the applied marker above stops that re-offer from
    // double-counting a write that did land.
    pushDeferralBaseline = totals;
    // The held-back delta clears here and nowhere else — one shared landing
    // point with the cursor above, so a lost write re-offers both together.
    stalledUnflushed = 0;
    console.log(
      `[worker] deferral counters persisted: +${delta.deferred} deferred / +${delta.recovered} recovered / +${delta.stalled} held back / +${delta.pruned} retired (totals ${next.deferredTotal}/${next.recoveredTotal}/${next.stalledTotal}/${next.prunedTotal})`,
    );
  } else if (shrunk && landed) {
    pushDeferralSnapshot = shrunk;
  } else {
    // Nothing was planned for the row, or nothing landed: republish what the
    // read found (the cross-isolate refresh — /health serves whichever
    // heartbeat was written last, so a stale mirror goes visibly backwards).
    refreshMirror();
  }
}

/**
 * Reconcile the durable push-baseline ledger (src/pushledger.ts) with the two
 * sources it can read but never edit: the delivery audit ring (authoritative
 * push-time mcap, last ~30 deliveries) and the live `push_watch` listing (the
 * baseline each row carries NOW — a mismatch against the ledger is exactly how
 * a heal/resurrection rewrite becomes visible). The band in force is stamped
 * alongside, so "was this push inside the band?" stays answerable after the
 * operator retunes the filter.
 *
 * The WRITE is skipped when nothing changed, and the pass itself is off the
 * tick's own path: telemetry may never extend the invocation, and a pass that
 * is bounded away is simply re-offered on the next tick it is due.
 *
 * No production caller any more: the tick tail calls this file's PLANNER (see
 * planPushLedgerSync / planSkipCaptureSync / planBirdeyeCuSync) inside its one
 * read + one write, and this single-key form survives as that planner's test
 * seam (scripts/test-unit.js) — the shape it had before §4.12 grouped the tail.
 */
export async function syncPushLedger(
  now = Date.now(),
  database: Db | null = db,
): Promise<void> {
  if (!database) return;
  const raw = await database.getWorkerState(PUSH_LEDGER_STATE_KEY);
  const [audit, rows, chats] = await Promise.all([
    database.getPushAudit(),
    database.listPushWatch(60),
    database.listEnabledChats(),
  ]);
  const { serialized, mirror } = planPushLedgerSync(raw, audit, rows, chats, now);
  if (serialized !== raw) {
    await database.setWorkerState(PUSH_LEDGER_STATE_KEY, serialized);
  }
  pushLedgerMirror = mirror;
}

/** One audit-ring entry as this module reads it (Db.getPushAudit's shape). */
type PushAuditEntryLike = {
  token: string;
  at: number;
  mcapAtPush?: number;
  kind?: string | null;
};

/**
 * Pure mirror of Db.getPushAudit's own parse — both read the same
 * `worker_state.push_audit` ring — needed because the grouped read hands back
 * the raw value instead of paying that method's extra round trip. Tolerant, in
 * the repo's usual style: a missing or non-array row degrades to "nothing yet".
 */
function parsePushAuditState(raw: string | null): PushAuditEntryLike[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PushAuditEntryLike[]) : [];
  } catch {
    return [];
  }
}

/**
 * The push-baseline ledger's merge as a pure function, shared by the single
 * sync and the grouped post-scan telemetry path (see Db.readPostScanTelemetry)
 * so both write byte-identical rows — the reason it is not inlined twice.
 * `mirror` always comes back, even when `serialized` equals the durable row:
 * /health serves this module's copy, and a tick that reconciles nothing still
 * has to refresh it from storage.
 */
function planPushLedgerSync(
  raw: string | null,
  audit: PushAuditEntryLike[],
  rows: Array<{ token: string; pushedAt: number; mcapAtPush: number }>,
  chats: Array<{ minMarketCapUsd: number; maxMarketCapUsd: number }>,
  now: number,
): { serialized: string; mirror: PushLedgerView } {
  // Widest band across enabled chats, matching how the scan's pool window is
  // derived; null when nothing is enabled (then no band is stamped).
  const band =
    chats.length > 0
      ? {
          min: Math.min(...chats.map((c) => c.minMarketCapUsd)),
          max: Math.max(...chats.map((c) => c.maxMarketCapUsd)),
        }
      : null;
  const next = mergePushLedger(parsePushLedger(raw), {
    audit: audit.map((a) => ({
      token: a.token,
      at: a.at,
      mcapAtPush: a.mcapAtPush ?? null,
      kind: a.kind ?? null,
    })),
    rows: rows.map((r) => ({
      token: r.token,
      pushedAt: r.pushedAt,
      mcapAtPush: r.mcapAtPush,
    })),
    band,
    now,
  });
  return {
    serialized: JSON.stringify(next),
    mirror: { ...pushLedgerStats(next, now), heal: pushWatchHealStats() },
  };
}

/**
 * Accumulate this isolate's early-return reasons (src/skipcapture.ts) into the
 * durable row, so "how often does the sweep return without evaluating
 * anything, and why" survives isolate recycling.
 *
 * Same shape as the deferral/ledger syncs: the READ is unconditional (a
 * recycled isolate must republish the fleet total rather than its own zero) and
 * the persist baseline advances only after a write that actually landed, so a
 * failed write re-offers its delta instead of dropping it.
 *
 * No production caller any more: the tick tail calls this file's PLANNER (see
 * planSkipCaptureSync) inside its one read + one write, and this single-key
 * form survives as that planner's test seam (scripts/test-unit.js).
 */
export async function syncSkipCaptureState(
  now = Date.now(),
  database: Db | null = db,
): Promise<void> {
  if (!database) return;
  const raw = await database.getWorkerState(SKIP_CAPTURE_STATE_KEY);
  const { delta, durable, next } = planSkipCaptureSync(raw, now);
  if (!delta || !next) {
    skipCaptureMirror = durable;
    return;
  }
  await database.setWorkerState(SKIP_CAPTURE_STATE_KEY, JSON.stringify(next));
  skipCaptureMirror = next;
  markSkipCaptureSynced();
  console.log(
    `[worker] skip capture persisted: +${delta.total} early return(s) (fleet total ${next.total}, last "${next.lastReason ?? "unknown"}")`,
  );
}

/**
 * The skip-capture counters' merge as a pure function, shared by the single
 * sync and the grouped post-scan telemetry path. `next` null means this isolate
 * has nothing new to persist; `durable` always comes back so the mirror can be
 * refreshed from the row even on a tick that writes nothing (the cross-isolate
 * read that keeps /health from serving a stale copy).
 */
function planSkipCaptureSync(
  raw: string | null,
  now: number,
): {
  delta: SkipDelta | null;
  durable: SkipCaptureState;
  next: SkipCaptureState | null;
} {
  const delta = takeSkipCaptureDelta();
  const durable = parseSkipCaptureState(raw);
  if (!delta) return { delta: null, durable, next: null };
  return { delta, durable, next: mergeSkipCaptureState(durable, delta, now) };
}

/**
 * (`syncPostScanTelemetry`'s throttled block lives in syncPushDeferralCounters
 * now: the tail pays ONE read before the throttles are even consulted, so the
 * dues are computed there and the merges below are planned in the same breath.
 * There is no second read left to race a bound around.)
 */

/**
 * The three throttled telemetry merges as a PURE plan: the tail's read in,
 * the rows to write and the side effects to apply once they land, out.
 *
 * It used to be an async body that paid its own read and its own batch
 * (syncPostScanTelemetry's grouped half, which is where the round trips went).
 * The caller now hands it the tail's single read and lands every write in the
 * tail's single batch, so the merges keep their exact shapes and lose only the
 * round trips.
 */
function planPostScanTelemetry(
  now: number,
  dues: { ledger: boolean; skip: boolean; birdeye: boolean },
  tail: TailReadout,
): {
  writes: Array<{ key: string; value: string }>;
  ledgerMirror: PushLedgerView | null;
  skipMirror: SkipCaptureState | null;
  skipDelta: SkipDelta | null;
  skipMerged: SkipCaptureState | null;
  birdeyeDelta: Map<string, number> | null;
  birdeyeByDelta: Map<string, BirdeyeCuCounts> | null;
} {
  const { states, pushWatch, chats } = tail;
  const writes: Array<{ key: string; value: string }> = [];
  let ledgerMirror: PushLedgerView | null = null;
  let skipMirror: SkipCaptureState | null = null;
  let skipDelta: SkipDelta | null = null;
  let skipMerged: SkipCaptureState | null = null;
  let birdeyeDelta: Map<string, number> | null = null;
  let birdeyeByDelta: Map<string, BirdeyeCuCounts> | null = null;
  if (dues.ledger) {
    const raw = states.get(PUSH_LEDGER_STATE_KEY) ?? null;
    const plan = planPushLedgerSync(
      raw,
      parsePushAuditState(states.get(PUSH_AUDIT_STATE_KEY) ?? null),
      pushWatch,
      chats,
      now,
    );
    if (plan.serialized !== raw) {
      writes.push({ key: PUSH_LEDGER_STATE_KEY, value: plan.serialized });
    }
    ledgerMirror = plan.mirror;
  }
  if (dues.skip) {
    const plan = planSkipCaptureSync(
      states.get(SKIP_CAPTURE_STATE_KEY) ?? null,
      now,
    );
    skipMirror = plan.next ?? plan.durable;
    if (plan.delta && plan.next) {
      writes.push({
        key: SKIP_CAPTURE_STATE_KEY,
        value: JSON.stringify(plan.next),
      });
      skipDelta = plan.delta;
      skipMerged = plan.next;
    }
  }
  if (dues.birdeye) {
    // Both CU rows from THIS read: the totals and the per-endpoint split that
    // says which caller spent them (docs/round-trips.md §4.14). One read, one
    // batch — the split adds payload, never a round trip.
    const plan = planBirdeyeCuSyncGrouped(states, now);
    if (plan.next) {
      writes.push({ key: BIRDEYE_CU_STATE_KEY, value: plan.next });
      birdeyeDelta = plan.delta;
    }
    if (plan.byNext) {
      writes.push({ key: BIRDEYE_CU_BY_STATE_KEY, value: plan.byNext });
      birdeyeByDelta = plan.byDelta;
    }
  }
  // Nothing is landed here: the caller owns the one batch and applies these
  // only after it resolves (a rejected batch leaves every delta pending).
  return {
    writes,
    ledgerMirror,
    skipMirror,
    skipDelta,
    skipMerged,
    birdeyeDelta,
    birdeyeByDelta,
  };
}

/**
 * Fingerprint of the env-derived trade settings (presence only — never the
 * secret VALUE). Cloudflare delivers fresh bindings to warm isolates on
 * every invocation, but cfg is loaded once per isolate; comparing this
 * fingerprint lets ensureInitialized detect dashboard changes (secret added,
 * TRADE_MODE flipped, amount changed) and re-initialize so they take effect
 * WITHOUT a redeploy. Safety property for a money-moving bot: flipping
 * TRADE_MODE to off in the dashboard must stop trading immediately.
 */
export function tradeFingerprint(env: Env): string {
  return [
    env.BOT_WALLET_PRIVATE_KEY ? "key:1" : "key:0",
    env.TRADE_MODE ?? "",
    env.TRADE_AMOUNT_SOL ?? "",
    env.TRADE_BUY_BALANCE_PCT ?? "",
    env.TRADE_SLIPPAGE_PCT ?? "",
    env.TRADE_PRIORITY_FEE_SOL ?? "",
    env.TRADE_MAX_DAILY_BUYS ?? "",
    env.TRADE_TIMEOUT_MS ?? "",
    env.JUPITER_API_BASE ?? "",
    env.JUPITER_API_KEY ? "jkey:1" : "jkey:0",
    env.TRADE_RPC_URL ?? "",
    env.BOT_ADMIN_IDS ?? "",
  ].join("|");
}

/** Last trade-settings fingerprint applied at init (see tradeFingerprint). */
let lastTradeFp = "";

/** Alert when the previous scan finished more than this long ago (missed ticks). */
const OUTAGE_ALERT_GAP_MS = 3 * 60_000;
/** Don't re-alert within this window for the same continuing outage. */
const OUTAGE_ALERT_COOLDOWN_MS = 30 * 60_000;
/**
 * Hard budget for the whole scheduled tick. Cloudflare kills the invocation
 * at a ~24s effective wall-clock limit (not the ~30s the platform
 * advertises), so the tick must fit: lean pre-race (~1s: batched tick
 * counter + claim/heartbeat) + scan (this budget) + the completion flush
 * (ONE batched round trip) ≈ 20-21s. There are NO DB writes after the race
 * anymore, so nothing can be lost to the wall-clock kill (observed
 * 2026-09-03: tail writes kept losing that race and froze the heartbeat /
 * dropped history rows).
 *
 * History: 22s was the maximum that landed for a while (completion rows
 * written at ~22.3-22.8s persisted reliably 12:55-14:02Z on 2026-09-03),
 * and a 25s race (c60e2e4) wrote completions at ~25s and landed ZERO rows
 * for 15+ minutes — so the effective wall-clock envelope of a cron
 * invocation here is ~24s, not the ~30s the platform advertises. Measured
 * again live on 2026-09-03 15:0x-15:1xZ: with a 22s race the completion
 * flush (attempted at ~22.7s including the pre-race claim/heartbeat round
 * trip) stopped landing ENTIRELY — zero scan_history rows for 30+ minutes
 * while the start heartbeat kept getting written every tick — freezing the
 * heartbeat in phase=scanning and re-triggering the outage-alert pattern.
 * Re-measured live 2026-09-04 04:00-07:00Z: with the 19s race the flush
 * (attempted ~19.5s in) STILL stops landing for stretches of 5-20 minutes —
 * zero scan_history rows while the start heartbeat keeps getting written
 * every tick (heartbeat frozen in phase=scanning, the outage-alert
 * pattern). The effective kill therefore fluctuates just past ~20s, not a
 * clean ~24s, so the budget is cut to 16s: the flush starts ~16.3-16.5s in
 * and lands with ~3-4s of margin against the earliest observed kill. This
 * pairs with the cooperative scan abort (Scanner.abort — runScan calls it
 * the moment the race trips, so the background scan stops issuing new
 * work at its next phase boundary instead of grinding on as a zombie
 * alongside the flush). Cut again 16s → 15s on 2026-09-05: the 16s-era
 * flush stopped landing ENTIRELY right after the backfill deploy
 * (observed live 09:00-09:15Z — every tick died before its flush, zero
 * completions, each tick only visible via the next-tick backfill row), so
 * the kill point had drifted into the 16s flush window. 15s starts the
 * flush ~1.5s earlier; the re-eval pool absorbs the lost scan work (a
 * shorter budget costs tick latency, never coin coverage). Do NOT raise
 * this constant without first verifying live that completions still land
 * (22s+ landed zero rows; 19s produced recurring 5-20 min holes).
 *
 * Cut again 15s → 13s on 2026-09-07 (directive: the budget number does not
 * matter — EVERY tick must complete): the live history showed dead ticks
 * still clustering (16:29-16:33Z, 15:55-15:57Z, 15:44-15:47Z — four-plus
 * consecutive ticks whose ~16.5s flush never landed, each backfilled by
 * the next tick). The flush now starts ~13.2-13.5s in, buying ~2s more
 * margin against both the fluctuating kill point and Turso write-latency
 * spikes; the flush also retries once after a settled failure (see below).
 * The rotation slice + re-eval pool absorb the 2s of lost scan work.
 *
 * Cut again 13s → 11s the same day, after the 13s build went live: of its
 * first 6 ticks, ZERO scanned cleanly (2 timeout rows landed at 13.3-13.5s,
 * 4 flushes hung and died) while claims kept landing every minute — reads
 * and claim-writes healthy, only the mid-teens flush window is lethal on
 * heavy ticks. 11.2s buys another 2s of headroom; the pool absorbs the
 * scan work.
 *
 * Raised 11s → 12s on 2026-09-09 (directive: ~90% of ticks were tripping
 * the budget by only 100-300ms at 11.1-11.3s once GeckoTerminal recovered
 * and the pool grew to ~650 rows — the pool-eval phase was being aborted
 * ~0.1s before it would have finished). 12s starts the flush ~12.3s in,
 * 2026-09-21 (9.5 → 12s): the envelope is raised to fund the post-push
 * tracker pass, which now runs in the tick tail AFTER the completion flush
 * (see TRACKER_PASS_BUDGET_MS). That ordering is what makes the raise safe: the
 * 12s dead-tick era above was an envelope where a slow scan could push the
 * FLUSH past the kill point, and the fix was SCAN_FLUSH_RESERVE_MS — which is
 * unchanged and still taken out of the scan's race. Everything the tracker pass
 * does happens after the completion write has already landed, so it can only
 * ever lose its own work (one rotation pass, retried next tick), never a tick's
 * completion. Measured before the raise: the pass reached the tail ~7.4s into
 * the tick, leaving it 1150ms of the old budget — one row per pass against the
 * 29 a sweep has to cover.
 * still ~8s clear of the ~20s kill window, and OK ticks measured 8.8-10.1s
 * all morning, so the 1s raise converts those marginal ticks to completions
 * without approaching the lethal mid-teens flush window.
 *
 * Consequence: scans that finish inside the budget persist a full summary;
 * slower scans (hot pool) write an ok=false timeout row and their feed
 * counters (pool/candidates/pushed) are carried by the NEXT tick's row via
 * scanner.lastSummary. Deferred candidates stay in the re-eval pool, so a
 * shorter budget costs tick latency, never coin coverage.
 *
 * 2026-09-21 (reverted inside the hour): 9_500 → 12_000 was tried to fund the
 * new post-flush tracker pass out of this same envelope, and the live
 * signature of the 2026-09-15 outage came straight back — /debug/scan-history
 * showed `previous tick died before its completion flush` 8 times in 40
 * minutes (gaps 60-104s) because the race then ends at ~7.5s and the flush
 * reserve runs to 12s, past the ~9.6s cron kill this envelope is sized
 * against. The tracker pass does NOT need a wider envelope: the scan plus its
 * completion flush settle at ~2.3-3.1s of the 9.5s (measured on the live
 * heartbeat: `ms 2149`/`2201`/`2358` at flush), so the pass is funded from
 * the tail that was already going unused. Never widen this number to make
 * room for a new tail stage — the tail IS what is left after the flush.
 *
 * RAISED 9_500 → 20_000 on 2026-09-28, with the account on Workers Paid.
 * Every cut documented above was bought against the Free plan's 10ms CPU wall:
 * the kill that seemed to move between ~9.6s and ~24s WAS that wall landing
 * mid-invocation rather than a wall-clock limit (docs/cpu-10ms-root-cause.md —
 * dead invocations pin at exactly cpuTime 10,000us). This tick measures ~33ms
 * of CPU: ~3x the Free wall and ~1/900th of the paid 30s, so on this plan the
 * only constraint left is the cron minute itself, and 20s of it leaves the
 * next tick ~40s of clear air while the flush reserve (unchanged) still starts
 * the completion write ~15.5s in. What keeps a HEALTHY tick short is the
 * scan's own deadline (SCAN_TICK_DEADLINE_MS); this number now only decides
 * how much of a SLOW tick may finish instead of being cut.
 */
export const SCAN_TICK_BUDGET_MS = 20_000;

/**
 * The last tracker pass that THREW, with the isolate's own pulse of what it
 * had managed to do (see trackerPassPulse in pushwatch.ts).
 *
 * WHY it is module state and not a durable row: the pass writes its coverage
 * row twice — `running` at the start, the note at the very end — so a pass
 * that is killed mid-flight (or whose final write the database refuses) leaves
 * a durable record that says `running` forever. Live 2026-09-25: 60s+ of
 * `phase: running` with the rotation stalled while the tick itself was healthy.
 * The heartbeat summary carries this on the NEXT tick (the summary is built
 * before the pass runs), which is enough for a single /health read to name the
 * stage and the counters instead of a bare `running`.
 */
let trackerPassFailure: {
  at: number;
  message: string;
  live: ReturnType<typeof trackerPassPulse>;
} | null = null;
/**
 * Wall-clock slice, taken at the END of a tick, for ONE post-push tracker
 * pass (see Scanner.runTrackerPass and pushwatch.TRACKER_TICK_BUDGET_MS).
 *
 * The pass advances the tracked-coin rotation — least-recently-checked first,
 * one head of six rows per pass — and it has no cadence of its own. It used to
 * run INSIDE the scan, on whatever the scan's phases left: 400-1200ms of a
 * ~4.7s race window, so one or two rows per tick and a 29-row sweep measured
 * in tens of minutes (live 2026-09-21: `rows 0/29 ... budget-cut` and
 * `pairs 0/6` tick after tick, with the head of the queue never moving).
 *
 * The tick's budget is 9.5s and the scan plus its completion flush settle at
 * ~4s of it, so the pass is funded from that tail instead — and AFTER the
 * flush, so a slow pass can never cost the tick its completion write, which is
 * the one loss the whole dead-tick machinery exists to prevent. A pass that
 * overruns its slice is clamped by the next tick's budget, not by the scan.
 *
 * 2026-09-21: 2_500 → 3_500 → 5_000, measured at every step rather than
 * guessed. The first live sample of the stage clock was
 * `allow 2500 spend[setup 746/3 heal 2926/7 pairs 0/0 rows 0/0] trips 10` —
 * a housekeeping stage eating the whole allowance (see
 * pushwatch.TRACKER_HEAL_BUDGET_MS for that half of the fix).
 *
 * With the heal sliced and the pass moved in front of the deferral sync (so
 * it starts right behind the flush instead of up to a second later), the live
 * tick reads `flush 03:53:46 → note 03:53:50 trackerMs 3590`, i.e. the pass
 * runs 3.1s into a 9.5s envelope, spends 3.6s and the invocation is done at
 * ~5.5s. At 3_500 the pass was still budget-cut after THREE rows — a ~420ms
 * Turso round trip per row, and rows only get what setup (~785ms/3 trips) and
 * the pair batch (~150ms) leave — so 22-26 active rows needed ~8 ticks.
 * 5_000 spends the tick's unused tail instead: the pass ends by ~8.1s, its
 * note (its last write) by ~8.5s, and the tick still keeps
 * TRACKER_PASS_TAIL_MS against the ~9.6s kill — while each pass fits
 * TRACKER_PAIR_HEAD rows instead of half of it.
 */
const TRACKER_PASS_BUDGET_MS = 5_000;
/**
 * Wall-clock budget for the maintenance invocation's whole job (see
 * MAINTENANCE_CRON and runMaintenanceInvocation).
 *
 * Its legs are interval-gated (the Birdeye backfill hourly, the crime list by
 * its own TTL, and since 2026-09-30 the telemetry-count reconcile hourly) and
 * all three are no-ops on almost every delivery, so the number
 * only has to cover the passes that DO work: the backfill walks up to ~4
 * six-hour Birdeye chunks and then writes one batch of token rows; the crime
 * refresh downloads and persists ~4.8K addresses. Neither is close to this,
 * and each leg is additionally raced against this deadline by its caller (see
 * Scanner.runMaintenanceJobs), so an upstream that hangs costs the pass its
 * remaining work and never the invocation.
 *
 * SIZED AGAINST THE ENVELOPE, not against the work: the cron invocation that
 * carries the scan is measured at ~9.6s before the runtime kills it, and this
 * delivery owns nothing else in that envelope. There is no reason to spend
 * more of it than a leg needs — a cut maintenance pass costs one interval of
 * freshness (the next delivery is 5 minutes away and every leg is idempotent).
 */
const MAINTENANCE_BUDGET_MS = 6_000;
/**
 * Subrequests held back from the SCAN for the post-flush tracker pass.
 *
 * WHY (live 2026-09-25): the pass is the LAST stage of the tick and the only
 * one that defers by name, so it is the residual claimant of the
 * invocation's 50-subrequest allowance — and the scan, which runs first, had
 * no reservation for it at all. The result was
 * `ok:0/0 deferred:subreq-budget` pass after pass while the rotation stalled
 * (rows went unchecked for 41 minutes), i.e. the coverage loss was visible
 * only in the pass note. The drain already yields (DRAIN_TRACKER_RESERVE);
 * this is the same discipline one stage earlier: the scan's OPTIONAL legs
 * are the only work in a tick that can be dropped, and they now stand down
 * while the pass's slice is intact.
 *
 * THE NUMBER is the pass's own arithmetic, and the first version of it was
 * short by exactly one CARD: entry (pushwatch.TRACKER_SUBREQ_FLOOR 3) + the
 * tail's writes (pushwatch.TRACKER_SUBREQ_RESERVE 6) = 9 lets a pass start
 * and close cleanly while every alerting row behind it is refused — live
 * 2026-09-26T21:39Z, two consecutive passes read `rows 8/30 … subreq-cut 22
 * defer-send 22` while the rotation aged in hours (the oldest row 126
 * minutes). One alerting row's path (the claim+reservation batch, the send
 * and the final write — see pushwatch.TRACKER_ALERT_PATH_SUBREQ) is 3 more
 * since 2026-09-27: it was 4 while those two CAS writes were separate round
 * trips, which is where the 13 came from, and the pair now rides ONE batch
 * (Db.claimAndReservePushWatch). So the slice is 12: what the pass needs to
 * be worth starting IS a delivered card, not just a closed ledger.
 * `scanSubreqLeft` applies it; the scan's other gating is unchanged.
 */
export const TRACKER_PASS_SUBREQ_RESERVE = 12;
/**
 * The tracker pass's OWN cron delivery — the second `[triggers].crons`
 * expression in wrangler.toml, and the one thing that gives the pass a
 * 50-subrequest invocation of its own.
 *
 * WHY A SEPARATE INVOCATION (live 2026-09-27T01:31-01:57Z, measured against
 * the deployed claim+reservation merge): the pass shares the scan tick's
 * allowance as its LAST stage, so it never sees more than what the tick has
 * left — and the tick's front + scan + flush spend 18-39 of the 38 usable
 * subrequests before the pass is offered anything (`heartbeat.subreqs.usable
 * 38`; `tickProgress {stage: "postscan", subreqs: 39}`). The stage split then
 * shows the pass paying for it by name: `ok:0/0 deferred:subreq-budget trips
 * 0` on the fat ticks (its entry gate, not one row touched), and
 * `defer-send 6 subreq-cut 6` on the thin ones — every alerting row refused at
 * TRACKER_SUBREQ_RESERVE after the pass had already spent its slice. The
 * refusal count tracked the SUBREQUEST counter, not the clock and not Turso's
 * latency: `db 110ms` refused 10 rows while `db 3421ms` refused 6, and no
 * sampled pass ever said `budget-cut`.
 *
 * A card costs the counter ~4-5 subrequests (the claim+reservation batch, the
 * Telegram send, the delivery-audit read AND its write, the final check
 * write), so a residual claimant holding single digits delivers 0-1 cards a
 * minute however cheap one card gets — which is exactly the `alerted 0`-`1`
 * every sampled pass read. In its own invocation the pass pays init plus its
 * own work and nothing else: the scan stops lending it anything, and the same
 * pass meets the same rotation with ~30 subrequests in hand instead of ~6.
 *
 * `event.cron` carries the trigger's expression CHARACTER FOR CHARACTER (see
 * Cloudflare's scheduled-handler docs), so the comparison below is exact — and
 * with two triggers configured, a string this constant does not match is a
 * scan tick, never a silently dropped delivery (see runTrackerInvocation's
 * fallback note).
 */
export const TRACKER_CRON = "*/1 * * * *";
/**
 * Pure: is this scheduled delivery the tracker pass's own invocation?
 *
 * Trims only the OUTSIDE of the string: the platform matches its configured
 * expression exactly (so an expression whose INNER spacing differs is a
 * trigger this Worker does not claim — and defaulting those to the pass
 * would hand a stranger's delivery the pass's budget while the scan tick's
 * own routing silently stopped matching.
 */
export function isTrackerCron(cron: string | null | undefined): boolean {
  return typeof cron === "string" && cron.trim() === TRACKER_CRON;
}
/**
 * The MAINTENANCE delivery's own expression (see wrangler.toml and
 * runMaintenanceInvocation): the interval-gated, side-effect-only legs — the
 * Birdeye backfill and the crime-wallet refresh — moved out of the scan tick's
 * front phase and into an invocation of their own.
 *
 * WHY A FIVE-MINUTE PERIOD AND NOT EVERY MINUTE: neither job wants a per-minute
 * cadence (the
 * backfill's own gate is hourly, the crime list's TTL is longer), and the tick
 * pays for the legs it carries — the backfill spends up to its share of the
 * front phase on the hour it is due, inside the same window the pair fetch and
 * the gates need. Five minutes keeps both jobs' freshness identical to what
 * the tick delivered (their own gates, not the cron period, decide when they
 * run) while removing them from the minute the tick is trying to spend on
 * coins.
 *
 * WHY IT STILL NEEDS A FALLBACK, like the pass: this platform has silently
 * stopped delivering cron events to this Worker before (docs/uptime-monitor.md)
 * and this expression is new. The leg decision is therefore not the cron at
 * all — it is the row this invocation writes (scanner.
 * MAINTENANCE_PASS_STATE_KEY, riding the scan front's ONE read): a tick runs
 * the legs itself the moment that row is older than
 * scanner.MAINTENANCE_PASS_FALLBACK_FRESH_MS. A dead trigger costs freshness,
 * never a leg.
 *
 * `event.cron` carries the trigger's expression CHARACTER FOR CHARACTER (see
 * Cloudflare's scheduled-handler docs), so the comparison below is exact — and
 * with three triggers configured, a string neither predicate matches is a scan
 * tick, never a silently dropped delivery.
 */
export const MAINTENANCE_CRON = "*/5 * * * *";
/**
 * Pure: is this scheduled delivery the maintenance invocation's own?
 *
 * Same trim-only-the-outside rule as isTrackerCron, and for the same reason:
 * an expression whose INNER spacing differs is a trigger this Worker does not
 * claim, and defaulting it here would hand a stranger's delivery this budget
 * while its own routing stopped matching.
 */
export function isMaintenanceCron(cron: string | null | undefined): boolean {
  return typeof cron === "string" && cron.trim() === MAINTENANCE_CRON;
}
/**
 * How stale the durable pass row has to be before the SCAN TICK runs the pass
 * itself (the fallback, see runTrackerInvocation).
 *
 * WHY IT EXISTS AT ALL: the platform has silently stopped delivering cron
 * events to this Worker before (docs/uptime-monitor.md, and the community
 * reports it links), and a pass nobody runs is the one failure the tracker
 * cannot report on its own — the row would simply stop moving. The pass's own
 * delivery is therefore an OWNER, not a requirement: the tick takes over
 * whenever the row is older than this.
 *
 * WHY 2 MINUTES: the healthy shape is the pass delivery writing the row every
 * ~60s, and the tick reads the row from its own scan FRONT
 * (SCAN_FRONT_GATE_KEYS, read ~3-5s into the tick, i.e. up to one full minute
 * older than the pass delivery's newest write). 120s is that minute plus the
 * whole cron period, so a late tick still yields — and a dead delivery costs a
 * pass roughly every 3 minutes, which is the fallback's degraded cadence, not
 * a stop. Measured against the live readings this replaces: a pass that runs
 * every 3 minutes while the trigger is down still covers the 30-row rotation
 * (the very passes that read `rows 24-30/30`), whereas 0-1 cards a minute was
 * the shape that made the split necessary.
 */
export const TRACKER_PASS_FALLBACK_FRESH_MS = 120_000;
/**
 * The scan's view of the invocation's remaining subrequests: the counter
 * with the tracker pass's slice already taken off (see
 * TRACKER_PASS_SUBREQ_RESERVE). Pure and exported so the arithmetic is
 * pinned by a test rather than by the call site's comment. Negative is a
 * valid answer ("the pass's slice is already gone"); a caller must not
 * clamp it to 0, which would read as "exactly at the reserve" and hide the
 * overspend.
 */
export function scanSubreqLeft(
  remaining: number,
  /**
   * The slice to hold back, defaulting to the pass's full one. It is a
   * PARAMETER because the reservation is conditional since 2026-09-27: a tick
   * whose own pass stage will stand down for the pass's own cron delivery
   * (see Scanner.trackerPassSlice) hands the scan the whole allowance — the
   * slice exists for a pass THIS invocation might run, and a tick that runs
   * none would be holding subrequests it can never spend while its optional
   * legs stand down ~12 early.
   */
  reserve: number = TRACKER_PASS_SUBREQ_RESERVE,
): number {
  return remaining - reserve;
}
/**
 * Tick tail kept clear after the tracker pass for the tick's own bookkeeping
 * (streak counters, an isolate rebuild's re-init, the scan-lock safety
 * release). The pass is clamped by what is left of this, so a long scan simply
 * gets a shorter pass — never a tick that dies with its bookkeeping unwritten.
 */
const TRACKER_PASS_TAIL_MS = 1_000;
/**
 * Wall-clock slice RESERVED at the end of every tick for the completion
 * flush (heartbeat + scan_history row + lock release) and the streak
 * bookkeeping behind it. The race now ends at
 * `SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - preRaceSpend` instead of
 * at the whole budget, so the flush ALWAYS starts ~6s in and every await
 * on it is bounded by what is left of this reserve — the flush can no
 * longer be pushed past the kill point by a slow scan or a slow Turso
 * write.
 *
 * 2026-09-15 (dead-tick fix, the worst observed state): with the 12s
 * budget every CRON tick died before its flush for hours (12:01-13:24Z:
 * 60+ consecutive rows `previous tick died before its completion flush`,
 * heartbeat frozen at phase=scanning while the claim landed every minute;
 * 20+ more at 12:52-13:14Z). Signature: HTTP-triggered runs (generous
 * wall clock) completed the SAME work in 9.6-12.5s and flushed fine,
 * while cron invocations never did — so the effective cron kill had
 * drifted BELOW the ~12.3s flush start, not into the mid-teens window the
 * earlier cuts were chasing. Evidence for the new envelope: cron ticks
 * that DID land flushed at 8.7-9.6s (13:07:31 ms=8657, 11:18:36 ms=5384,
 * 11:19:37 ms=6414), i.e. the kill sits just past ~9.6s. A 9.5s total
 * tick with a 3.5s flush reserve starts the flush at ~6s and lands it at
 * ~6.5-7s — ~2.5-3s of margin against the earliest observed kill, instead
 * of the ~0.2s the old layout had. The lost scan seconds are absorbed by
 * the rotation slice + re-eval pool (a shorter budget costs tick latency,
 * never coin coverage), and a completed 6s scan every minute beats a dead
 * 12s tick that evaluates nothing — which is exactly why no qualifying
 * coin has been pushed since 2026-09-06.
 *
 * 2026-09-16: 3500 → 4500. The 9.5s/3.5s pair starts the flush at ~6.0s,
 * and the live scan-history shows what that costs: ticks whose flush began
 * at 6.0s landed while the invocation still had wall clock (06:32–06:35Z
 * timeout rows), then from 06:36Z EVERY tick died before its flush for
 * 70+ minutes (120 consecutive "died before its completion flush" rows,
 * heartbeat frozen in phase=scanning, zero pushes). The kill point
 * fluctuates in the ~6–9s range, so a flush starting at 6.0s is a coin
 * flip; the same 9.5s budget with a 4.5s reserve starts it at ~5.0s and
 * still leaves the flush its full retry ladder. Nothing is given up by the
 * earlier start: the scan's internal deadline (SCAN_TICK_DEADLINE_MS,
 * 4.6s) already ends the scan before it, and a scan cut a second earlier
 * defers its work to the re-eval pool exactly as every other budget cut
 * has (latency, never coverage).
 */
// Exported so scripts/test-unit.js can pin the flush arithmetic below against
// DB_REQUEST_TIMEOUT_MS: the reserve minus the first-attempt bound is the
// window the racing retry races IN, and a transport hard wall (1.2x the
// request timeout) longer than that window turns every stalled flush into a
// dead tick, however much reserve is budgeted.
export const SCAN_FLUSH_RESERVE_MS = 4_500;
/**
 * How long the flush waits for its FIRST completion-write attempt before
 * firing the concurrent retry. The batch is idempotent (it clears its own
 * `at` row before inserting), so a racing retry can only help; what the
 * bound controls is how long a WEDGED write holds the tick. 2.5s meant a
 * hung attempt + its retry could still be in flight when Cloudflare killed
 * the invocation (the flush starts at ~5s, the kill lands ~6–9s in), so a
 * hung write was a guaranteed dead tick. 1.2s fires the retry while there
 * is still room for a settled second attempt to land.
 */
export const FLUSH_ATTEMPT_BOUND_MS = 1_200;
/**
 * The tick's PRE-FLUSH progress record (TICK_PROGRESS_KEY): the ONE durable
 * piece of evidence a tick killed while flushing can leave behind, and the
 * only way the successor can tell "died inside the flush" from "died before
 * the flush started" — two shapes with two different fixes (see
 * docs/scan-completion-loss.md).
 *
 * WHY IT IS WRITTEN IN FRONT OF THE FLUSH: because at the subrequest ceiling
 * the LAST write to die is the telemetry one, so a post-mortem written after
 * the failure would be refused by the very condition it exists to report.
 *
 * The record is not allowed to buy that evidence with the flush's margin:
 *
 *   - AWAIT_RESERVE_MS — the record is AWAITED only while this much of the tick
 *     budget is left. Below it the write is still fired, just never awaited in
 *     front of the flush (the record's own `stage` says which half it was in):
 *     a late tick's flush is worth more than its own post-mortem.
 *   - BOUND_MS — even then the await is bounded, so a slow Turso cannot turn
 *     the record into the next lost flush. A record that misses the bound is
 *     left running (idempotent) and the flush proceeds.
 */
export const TICK_PROGRESS_BOUND_MS = 600;
export const TICK_PROGRESS_AWAIT_RESERVE_MS = 2_500;
/**
 * Where a tick's PRE-SCAN time went — the slice of the envelope nothing
 * published (2026-09-21).
 *
 * WHY. The race window is `SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS -
 * preRaceSpend`, so the scan's own 4.2s deadline only holds while the round
 * trip in front of it is short: at ~600ms of preRace the granted window is
 * 4.39s (live 10:01:06Z: `scan exceeded its 4386ms race window`), i.e. the scan
 * was cut by the RACE rather than by its own deadline — and every millisecond
 * of preRace is one taken from the gate/push phase, the only phase that can
 * push a coin. On top of that sits a second, invisible slice: everything the
 * handler does BEFORE `startedAt` — the cron counter write (its own short-lived
 * Db client), `ensureInitialized` (schema DDL on a cold isolate), the
 * cadence-gate heartbeat read and the outage check. The budget is measured
 * from `startedAt`, so that slice does not shrink the race window; it eats the
 * invocation's wall clock, which is exactly what the ~9.6s kill measures.
 *
 * `dbSteps` / `modeRead` (tickprobe) answer a DIFFERENT question — DB calls and
 * the trade-mode prefetch INSIDE the scan — so the pre-scan slice had no
 * reading at all. This is that reading.
 */
export interface PreTickSteps {
  /** Cron counter write, before init (its own raw client + one round trip). */
  bump: number;
  /** ensureInitialized: db init + migrations (cold isolates pay the DDL). */
  init: number;
  /** Cadence-gate heartbeat read (doubles as backfill + outage input). */
  gate: number;
  /** checkOutageAndAlert (normally a cached read; an alert writes). */
  outage: number;
  /**
   * Payload assembly: snapshot getters (skip capture, heal, dex stats,
   * deferral, push-baseline ledger) plus the serialize, measured from
   * `startedAt`. Pure CPU — a live 4.5KB heartbeat payload serializes in
   * 0.013ms — so this half exists to be ruled OUT: if `preRaceMs` is large
   * while this is ~0, the loss is the claim's, not the payload's.
   */
  json: number;
  /**
   * The claim round trip: the ONE must-land write before scanning (heartbeat +
   * lock INSERT + any backfill row, batched). The other half of `preRaceMs`,
   * and the half a slower Turso — or a cold isolate's first request — turns
   * into lost race window.
   */
  claim: number;
}

/** The pre-scan split of one tick (published as `summary.preTick`). */
export interface PreTickView {
  /** Handler entry (epoch) — align with heartbeat.at / scan_history.at. */
  at: number;
  steps: PreTickSteps;
  /** Handler entry → `startedAt` (the envelope's origin). null = unmeasured. */
  preStartMs: number | null;
  /** `startedAt` → race start: the slice taken out of the scan's window. */
  preRaceMs: number | null;
  /** The race window this tick was actually granted. */
  raceMs: number | null;
}

export const PRE_TICK_ZERO_STEPS: PreTickSteps = {
  bump: 0,
  init: 0,
  gate: 0,
  outage: 0,
  json: 0,
  claim: 0,
};

/**
 * Pure split of a tick's pre-scan envelope (exported for unit tests): the
 * numbers the race arithmetic actually uses, with `null` for anything not
 * measured rather than a fabricated 0.
 */
export function buildPreTickSplit(input: {
  entryAt: number;
  steps: PreTickSteps;
  startedAt: number;
  raceAt: number;
  raceMs: number;
}): PreTickView {
  const { entryAt, steps, startedAt, raceAt, raceMs } = input;
  return {
    at: entryAt,
    steps: { ...steps },
    preStartMs: entryAt > 0 && startedAt >= entryAt ? startedAt - entryAt : null,
    preRaceMs: raceAt >= startedAt ? raceAt - startedAt : 0,
    raceMs,
  };
}

/**
 * The race window a tick is actually granted, given how much of the budget
 * its pre-race phase already spent. Exported so the tuning relationship below
 * is pinned by a test rather than by this comment alone.
 *
 * `SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS` is what a tick with a free
 * pre-race phase gets; every further millisecond comes straight out of the
 * scan, and behind the scan, out of the candidate chain — the only phase that
 * can push a coin.
 *
 * WHY THERE IS NO FLOOR (2026-09-25, docs/scan-completion-loss.md Patch 1):
 * the old `Math.max(2_500, ...)` broke the very invariant this calculation
 * exists to hold. `preRace + scanRace + flush <= SCAN_TICK_BUDGET_MS` only
 * held while the floor did not bind: at preRace 7s the sum is
 * 7 + 2.5 + 4.5 = 14s, i.e. the slow-front tick the clamp exists to protect
 * was exactly the tick it killed before its completion flush — and a
 * recovering successor is a slow-front tick BY CONSTRUCTION (rebuild +
 * re-init, sometimes a cold list fetch), which is how one death became a
 * chain (live 2026-09-25: deaths climbing in the gate/front stage again, no
 * completed cron tick for 26 minutes). Clamping to [0, budget - reserve]
 * means a tick that cannot afford a scan spends its envelope on the
 * COMPLETION instead: `scanRaceMs === 0` fires the timeout branch at once,
 * `scanner.abort()` stops the scan at its next phase boundary, and the row
 * that lands says so. A completed 0s scan (candidate deferred, re-offered
 * next tick) beats a dead tick that evaluates nothing.
 *
 * THE SHED FLOOR IS NOT A GRANT FLOOR (2026-09-28): the arithmetic below still
 * drains 1:1 to zero and still returns 0 rather than a minimum, so nothing HERE
 * changed. What changed is what the CALLER does with a window this small — see
 * SCAN_RACE_MIN_USEFUL_MS and scanRaceShedReason.
 */
export function scanRaceWindowMs(preRaceSpendMs: number): number {
  return Math.max(
    0,
    Math.min(
      SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS,
      SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - preRaceSpendMs,
    ),
  );
}

/**
 * The smallest race window a scan can still be GRANTED — below it the tick's
 * scan is SHED instead (see scanRaceShedReason).
 *
 * WHY A FLOOR IS RIGHT HERE even though granting one is not (2026-09-28): the
 * floor removed from the GRANT in 2026-09-25 clamped the window UPWARDS, which
 * broke `preRace + scanRace + flush <= SCAN_TICK_BUDGET_MS` and killed the very
 * tick it was meant to protect. This one clamps nothing: it only decides whether
 * a window that is ALREADY too small gets spent on a scan at all, so it can
 * never lengthen a tick.
 *
 * WHERE THE NUMBER COMES FROM (measured, not chosen). The scan's own front is
 * the feed phase — live /health 2026-09-28 04:54Z read `feedsMs 541` — and the
 * pair phase behind it is a FIXED 1,000ms window (PAIRS_FETCH_BUDGET_MS), so a
 * granted window under ~1,541ms cannot reach the pair phase and cannot evaluate
 * a single coin, which is the only way a tick can push. The live readings sit
 * on either side of that line: ticks cut at a 680ms window landed
 * `profiles 0 pool 0 candidates 0` for 26 minutes straight (03:50-04:18Z,
 * while the isolate was CPU-starved), while ticks cut at 3,430ms and 3,629ms
 * landed `profiles 25` and `profiles 31` with candidates beside them. 1,500
 * keeps the line between the two with room on both sides.
 *
 * WHAT A SHED TICK COSTS: one rotation turn of evaluation, exactly like every
 * other budget cut — the re-eval pool re-offers the candidate next tick. What it
 * saves is the whole scan: in the 680ms case the feeds, the pool query and the
 * scan's CPU were all spent to produce a row that says `profiles 0`.
 */
export const SCAN_RACE_MIN_USEFUL_MS = 1_500;

/**
 * The skip reason a tick records when its granted race window is too small to
 * scan in (see SCAN_RACE_MIN_USEFUL_MS), or null when the window is usable.
 *
 * Same shape as drainShedReason's rule: a pure function returning null for the
 * ordinary case, exported so the boundary is pinned by a test rather than by a
 * comment. The caller ZEROES the window when this is non-null, which reuses the
 * already-tested `scanRaceMs === 0` branch — the timeout fires at once,
 * abort() stops the scan at its next phase boundary, and the completion row (the
 * tick's mandatory half, and the only thing the no-completion alert reads) still
 * lands.
 *
 * Recording the reason as well is what makes a shed COUNTABLE: in scan_history
 * a shed tick looks like any other timeout, and a shed and a genuine cut have
 * different fixes.
 */
export const SCAN_RACE_SHED_REASON = "race-window-shed";

export function scanRaceShedReason(grantedRaceMs: number): string | null {
  return grantedRaceMs < SCAN_RACE_MIN_USEFUL_MS
    ? SCAN_RACE_SHED_REASON
    : null;
}

/**
 * The handler's pre-scan steps in one line (see PreTickSteps).
 *
 * `rest` is the part of the window the NAMED steps do not account for, printed
 * for the same reason the front split below prints its own remainder: a big
 * `rest` is work nobody measured, and a big `init` is the cold rebuild that
 * pays it (see deadTickRebuildDecision). Pure and exported so the arithmetic is
 * pinned by a test rather than by this comment.
 */
export function preStartSplitNote(
  entryAt: number,
  startedAt: number,
  steps: PreTickSteps,
): string {
  const total = entryAt > 0 && startedAt >= entryAt ? startedAt - entryAt : 0;
  const named = steps.bump + steps.init + steps.gate + steps.outage;
  return (
    `preStart ${total}ms [bump ${steps.bump} init ${steps.init} ` +
    `gate ${steps.gate} outage ${steps.outage} rest ${Math.max(0, total - named)}]`
  );
}

/**
 * The FRONT SPLIT in one line (see PreTickView): handler entry -> race start,
 * named part by part, with each half's remainder named too.
 *
 * WHY IT EXISTS (2026-09-28, live). The race-window error used to print only
 * `preRace 4320ms = json 0 + claim 1440` — a third of the number a reader opens
 * it for. The other 2880ms (the cold `init` above all) had to be reconstructed
 * by subtraction, and could not be reconstructed AT ALL for a tick that died
 * before the race: its only durable stamp is the admission record, which rides
 * the claim, and at that moment `preRaceMs` does not exist yet. So the split is
 * published in TWO places — whole, in the race-window error, and as far as it
 * is known, on every durable stamp (see TickProgressRecord.front).
 *
 * `front = preStart + preRace` is the whole envelope the scan's race window is
 * granted inside (see scanRaceWindowMs), so the two things a reader needs are
 * the total and which named step owns it.
 */
export function frontSplitNote(v: PreTickView | null | undefined): string {
  if (!v || v.preStartMs === null || v.preRaceMs === null) return "front n/a";
  const preStart = v.preStartMs;
  const preRace = v.preRaceMs;
  const rest = Math.max(0, preRace - v.steps.json - v.steps.claim);
  return (
    `front ${preStart + preRace}ms = ` +
    `${preStartSplitNote(v.at, v.at + preStart, v.steps)} + ` +
    `preRace ${preRace}ms [json ${v.steps.json} claim ${v.steps.claim} rest ${rest}]`
  );
}

/** Latest pre-scan split, module state like every other per-isolate counter. */
let preTick: PreTickView = {
  at: 0,
  steps: { ...PRE_TICK_ZERO_STEPS },
  preStartMs: null,
  preRaceMs: null,
  raceMs: null,
};
/** Handler entry of the tick in progress (0 = nothing recorded). */
let preTickEntryAt = 0;

/**
 * PER-TICK LEG RING (see /debug/tick-legs). What the durable rows cannot
 * carry: scan_history keeps 8 columns and the heartbeat keeps only the LATEST
 * tick's legs — which is exactly why the 2026-10-02 429-storm slow ticks
 * (8-14s, 00:49-01:06Z) could not be attributed after the fact: the split
 * existed only while that tick's /health answered. This ring keeps the last
 * TICK_LEG_RING_SIZE ticks of THIS isolate with the split intact — the front
 * (preStart / preRace / steps), every scan leg (feeds / pool / poolWait /
 * poolLegMs / pairs / pairs-jup / eval / db), the counters, the cut note and
 * the subrequest spend.
 *
 * COST, stated plainly: module memory only — no Turso round trip, no
 * subrequest, nothing added to the tick's critical path. The trade-off is the
 * one every module-scoped counter in this file makes: the ring dies with the
 * isolate (eviction or a deploy), so it answers "where did the ticks I just
 * watched spend their time", never "what did the fleet do yesterday" —
 * scan_history owns that half.
 */
export const TICK_LEG_RING_SIZE = 120;

/** One recorded tick, shaped for a reader chasing "which leg held it". */
export interface TickLegRow {
  /** Completion time (epoch, same clock as scan_history.at). */
  at: number;
  /** Who ran this scan (cron | http | manual). */
  via: string;
  ok: boolean;
  /** Tick wall time (startedAt → flush read; excludes preStart). */
  ms: number;
  err: string | null;
  /** The race cut this tick (ok=false with the window in `err`). */
  cut: boolean;
  /** The in-flight stage at the cut (see Scanner.stageSnapshot), when cut. */
  cutNote: string | null;
  /** The scanner's early-return reason, when it returned early. */
  skip: string | null;
  /** Subrequests spent at completion. */
  subs: number | null;
  preStartMs: number | null;
  preRaceMs: number | null;
  raceMs: number | null;
  steps: PreTickSteps | null;
  profiles: number | null;
  pool: number | null;
  candidates: number | null;
  pushed: number | null;
  feedsMs: number | null;
  preFeedMs: number | null;
  poolMs: number | null;
  poolWaitMs: number | null;
  poolLegMs: Partial<Record<FrontLeg, number>> | null;
  pairs: number | null;
  pairsJup: number | null;
  pairsMissing: number | null;
  evalMs: number | null;
  dbMs: number | null;
  /**
   * Rows reused from the last good pool snapshot because the read was
   * abandoned at the cap (see scanner.poolSliceForTick) — null when the tick
   * evaluated its own read's rows.
   */
  poolStale: number | null;
}

/**
 * Pure projection for the ring (exported so the mapping is pinned offline, the
 * same discipline as buildPreTickSplit): a tick with no summary — a cut, a
 * shed, or an early return — must record `null` legs rather than fabricated
 * zeros, because "no reading" and "spent 0ms" are different answers.
 */
export function buildTickLegRow(input: {
  at: number;
  via: string;
  ok: boolean;
  ms: number;
  err: string | null;
  cut: boolean;
  cutNote: string | null;
  preTick: PreTickView | null;
  subs: number | null;
  summary: ScanSummary | null;
  skip: string | null;
}): TickLegRow {
  const s = input.summary;
  const p = input.preTick;
  return {
    at: input.at,
    via: input.via,
    ok: input.ok,
    ms: input.ms,
    err: input.err,
    cut: input.cut,
    cutNote: input.cutNote,
    skip: input.skip,
    subs: input.subs,
    preStartMs: p?.preStartMs ?? null,
    preRaceMs: p?.preRaceMs ?? null,
    raceMs: p?.raceMs ?? null,
    steps: p ? { ...p.steps } : null,
    profiles: s?.profiles ?? null,
    pool: s?.pool ?? null,
    candidates: s?.candidates ?? null,
    pushed: s?.pushed ?? null,
    feedsMs: s?.feedsMs ?? null,
    preFeedMs: s?.preFeedMs ?? null,
    poolMs: s?.poolMs ?? null,
    poolWaitMs: s?.poolWaitMs ?? null,
    poolLegMs: s?.poolLegMs ? { ...s.poolLegMs } : null,
    pairs: s?.pairs ?? null,
    pairsJup: s?.pairsJup ?? null,
    pairsMissing: s?.pairsMissing ?? null,
    evalMs: s?.evalMs ?? null,
    dbMs: s?.dbMs ?? null,
    poolStale: s?.poolStale ?? null,
  };
}

const tickLegRing: TickLegRow[] = [];

/** Append one tick, trimming the oldest past the capacity. */
export function recordTickLeg(row: TickLegRow): void {
  tickLegRing.push(row);
  if (tickLegRing.length > TICK_LEG_RING_SIZE) {
    tickLegRing.splice(0, tickLegRing.length - TICK_LEG_RING_SIZE);
  }
}

/** The last `limit` ticks, newest first (the order /debug/tick-legs serves). */
export function tickLegRows(limit: number): TickLegRow[] {
  const n = Math.min(Math.max(1, Math.floor(limit) || 1), tickLegRing.length);
  return tickLegRing.slice(tickLegRing.length - n).reverse();
}

export function tickLegRingSize(): number {
  return tickLegRing.length;
}

/** Test seam: the ring is module state (same shape as poolfallback's reset). */
export function resetTickLegRing(): void {
  tickLegRing.length = 0;
}

/**
 * The durable half of the ring (see /debug/tick-legs): a slow tick's row is
 * written to worker_state under TICK_LEG_SLOW_KEY, because the in-memory ring
 * above lives in the ISOLATE THAT TICKED — and that isolate is not the one
 * answering HTTP reads (live 2026-10-02, right after the ring's own deploy:
 * every /health sampled `scanCount 0` while the durable heartbeat's claim
 * counter climbed, and /debug/tick-legs answered `count 0` on every request).
 * A module-only ring could not answer the question it exists for, so the
 * slow ticks — the ones anyone actually asks about — get a durable row.
 *
 * COST: two subrequests (one read to keep the previous rows, one write to
 * append) on ticks that are rare by construction (TICK_LEG_SLOW_MS: 7 of 500
 * live ticks, all inside the 2026-10-02 storm). Fired WITHOUT awaiting (the
 * invocation's tickWaitUntil holds them open), and never on the tick's
 * critical path.
 */
export const TICK_LEG_SLOW_KEY = "tick_leg_slow";
export const TICK_LEG_SLOW_MS = 8_000;
export const TICK_LEG_SLOW_RING_SIZE = 20;

/** Whether this tick is slow enough to be worth the durable row. */
export function slowTickLegDue(ms: number): boolean {
  return ms >= TICK_LEG_SLOW_MS;
}

/**
 * Tolerant parse of the durable ring (exported for the tests): a corrupt or
 * truncated row must cost a reading, never the endpoint — junk rows are
 * dropped and only the newest `max` are kept.
 */
export function parseTickLegRing(
  raw: string | null,
  max: number = TICK_LEG_SLOW_RING_SIZE,
): TickLegRow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (v): v is TickLegRow =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as TickLegRow).at === "number" &&
          typeof (v as TickLegRow).ms === "number",
      )
      .slice(-max);
  } catch {
    return [];
  }
}

/** The ring a slow tick produces from the one it replaces (append + trim). */
export function nextSlowTickRing(
  raw: string | null,
  row: TickLegRow,
  max: number = TICK_LEG_SLOW_RING_SIZE,
): TickLegRow[] {
  return [...parseTickLegRing(raw, max), row].slice(-max);
}

/**
 * Append one slow row to the durable ring — best effort, never throws, never
 * awaited on the tick's path. A lost slow-row is a lost reading, never a lost
 * tick.
 */
export async function persistSlowTickLeg(row: TickLegRow): Promise<void> {
  const client = db;
  if (!client) return;
  try {
    const raw = await client.getWorkerState(TICK_LEG_SLOW_KEY);
    await client.setWorkerState(
      TICK_LEG_SLOW_KEY,
      JSON.stringify(nextSlowTickRing(raw ?? null, row)),
    );
  } catch {
    // Swallowed at the source: an unhandled rejection can take the isolate
    // down with it, and this record is the least important thing the tick
    // does.
  }
}

/**
 * The tick's heartbeat read, shared between the three consumers that would
 * each otherwise pay their own round trip for the SAME worker_state row:
 * ensureInitialized's dead-tick recovery check, the cadence gate in the
 * scheduled handler, and the HTTP fallback's own gate (maybeRunScanIfStale).
 * Every read is a subrequest and the invocation's budget is the binding
 * constraint (Workers Free: 50 subrequests per invocation), so this is reused
 * within one tick only — see HEARTBEAT_REUSE_MS.
 */
let lastHeartbeatRead: { raw: string | null; at: number } | null = null;

/**
 * The CRON-ARRIVAL keys the cadence gate needs (`scheduled_tick_total` /
 * `scheduled_tick_ring`), captured by the SAME statement as the heartbeat
 * when that read landed. `null` = not captured (the read timed out), and the
 * gate then fetches them itself — the shape every tick used to pay: its own
 * round trip, i.e. one more subrequest out of the invocation's 50 plus
 * ~190ms of the tick's front path (live 2026-09-24: `init 187 gate 189`).
 * Reused within one tick only (HEARTBEAT_REUSE_MS), never across ticks: a
 * stale ring would drop arrivals from what the claim batch writes.
 */
let lastCronKeysRead: { map: Map<string, string> | null; at: number } | null = null;

/**
 * The tick's pre-flush progress record (see runScan's `noteProgress` and
 * docs/patches/tick-progress-record.apply.js), written by the tick that may
 * not survive to publish anything else.
 *
 * WHY (2026-09-24, live): every dead row reads `previous tick died before its
 * completion flush` and its `ms` is `now - at` — one cron cadence (53-66s),
 * NOT the dead tick's lifetime, and NOT where it died. Two of the six
 * occurrences were HTTP-fallback ticks and two started within 15ms-1.7s of a
 * tick that completed normally, so the row cannot even group its own cases.
 * This record is the missing half: the tick stamps its stage, its flush
 * payload size and its subrequest count BEFORE the flush, and re-stamps the
 * reason if that flush hangs or fails.
 */
export const TICK_PROGRESS_KEY = "tick_progress";

/**
 * The pre-flush record read, captured by ensureInitialized's ONE statement
 * (see WEDGE_READ_KEYS) and reused within that tick only
 * (HEARTBEAT_REUSE_MS) — the same discipline as lastHeartbeatRead, because
 * every read is a subrequest out of the invocation's 50. `null` means "no
 * READING", never "no record": a timed-out read must not be reported as an
 * absent record, so the fallback read happens on the (rare) tick that has a
 * death to explain.
 */
let lastProgressRead: { raw: string | null; at: number } | null = null;

/**
 * What ensureInitialized fetches in its one read: the heartbeat (three
 * consumers share it) plus the cron-arrival pair the cadence gate needs, so
 * a cron tick's front path needs no second read at all. The tick's pre-flush
 * progress record rides the SAME statement — one more key in a statement that
 * was already going out costs no subrequest, and the successor tick is the
 * only witness a killed tick can have.
 *
 * ROUND 4 (2026-09-26, docs/round-trips.md §4.25): the trade-mode override
 * rides it too. Measured live across three consecutive ticks, that row was
 * the last EVERY-TICK single-key read in the census
 * (`getWorkerState:trade_mode_override 1` / 86-117ms, `modeRead reads 1
 * reuses 0`) — while `scan_heartbeat` showed ZERO on the same ticks, its
 * readers already sharing this very statement. The tick's prefetch finds the
 * value primed from here (see frontModeOverrideRead) and pays nothing.
 *
 * EXPORTED for the same reason cronGateLoad is: the merge's whole promise is
 * a round-trip count, so what the statement carries has to be assertable
 * offline instead of only observed live.
 */
/**
 * The rows the cold-init boot block needs (see ensureInitialized's
 * initPromise): the stored Axiom token, and the three telemetry mirrors a
 * recycled isolate answers /health with before it has any numbers of its own.
 *
 * Named as its own list because they ride the FRONT's statement (below) and
 * the boot block's own read is now only the fallback — one list, so the two
 * cannot drift.
 */
export const BOOT_STATE_KEYS = [
  "axiom_access_token",
  PUSH_DEFERRAL_STATE_KEY,
  PUSH_LEDGER_STATE_KEY,
  SKIP_CAPTURE_STATE_KEY,
  // The per-trigger scan counters ride the front statement (and this list's
  // fallback read) so a recycled isolate can answer "cron vs fallback" before
  // it has any reading of its own — same discipline as the three mirrors above.
  ...SCAN_TRIGGER_STATE_KEYS,
];

export const WEDGE_READ_KEYS = [
  "scan_heartbeat",
  "scheduled_tick_total",
  "scheduled_tick_ring",
  TICK_PROGRESS_KEY,
  // Round 4: the tick prefetch's row (TradeService.primeModeOverride).
  "trade_mode_override",
  // 2026-09-27: the boot rows ride it too. This statement is the cold
  // isolate's FIRST read, and the boot block runs ~300ms later in the SAME
  // invocation reading four more keys — a second round trip for values this
  // one already had in hand. Measured live: a census window read
  // `getWorkerStates 5 calls / 616ms`, the front's largest single item, and
  // the boot read was one of them on every cold isolate. A read that TIMED OUT
  // leaves lastBootKeysRead's map null and the boot block fetches its own copy,
  // so the failure mode of the merge is the old shape, not a missing row.
  ...BOOT_STATE_KEYS,
];

/**
 * The front statement's map, as the boot block consumes it (see
 * BOOT_STATE_KEYS / WEDGE_READ_KEYS). Same discipline as lastCronKeysRead and
 * lastProgressRead: `map: null` means NO READING — the read timed out — and
 * must never be read as "no rows", because one of these keys decides whether
 * the Axiom client is built. The boot block falls back to its own read when
 * this is null or older than HEARTBEAT_REUSE_MS.
 */
let lastBootKeysRead: { map: Map<string, string> | null; at: number } | null = null;

/**
 * The trade-mode row as the tick-front's ONE batch read it (see
 * WEDGE_READ_KEYS), or null when there is no READING to trust: no front read
 * this invocation, one that TIMED OUT (its `map` is null), or one older than
 * HEARTBEAT_REUSE_MS.
 *
 * The three-state contract is the point. `{ raw: null }` is a real reading —
 * the row is absent, i.e. no override — and must prime the cache as such.
 * `null` (no reading) must NOT prime: the prefetch then pays its own round
 * trip, the pre-round-4 shape, which is strictly safer than inventing a mode.
 * Same discipline as lastHeartbeatRead / lastProgressRead, and the reason
 * the caller reads `if (ride !== null)` rather than testing the value.
 */
export function frontModeOverrideRead(): { raw: string | null; at: number } | null {
  const seen = lastCronKeysRead;
  if (seen === null || seen.map === null) return null;
  if (Date.now() - seen.at > HEARTBEAT_REUSE_MS) return null;
  return { raw: seen.map.get("trade_mode_override") ?? null, at: seen.at };
}

/**
 * The fleet-wide per-trigger scan counts (see Db.ScanTriggerCounts) as of the
 * last completed scan this isolate knows about. Two writers keep it fresh: the
 * per-invocation front read (`ensureInitialized`, which already asks for these
 * keys) and the boot block's mirror prime on a cold isolate. It lags the scan
 * being reported by exactly one completion — the increment commits with that
 * scan's own flush batch — which is the same "as of the last confirmed write"
 * discipline the deferral snapshot documents.
 */
let scanTriggerMirror: ScanTriggerCounts = {
  cron: 0,
  http: 0,
  manual: 0,
  clock: 0,
};

/**
 * What the cadence gate still has to fetch itself, given what the tick's
 * first DB contact already captured. Pure and exported so the merge is
 * unit-tested instead of only observed live: an EMPTY list is the merged
 * shape — the gate pays NO round trip, which is one subrequest out of the
 * invocation's 50 and ~190ms of the tick's front path.
 */
export function cronGateLoad(heartbeatFresh: boolean, cronFresh: boolean): string[] {
  const keys: string[] = [];
  if (!heartbeatFresh) keys.push("scan_heartbeat");
  if (!cronFresh) keys.push("scheduled_tick_total", "scheduled_tick_ring");
  return keys;
}

/**
 * How long the shared heartbeat read above stays reusable. Wide enough to cover
 * the few hundred ms between ensureInitialized and the gate in the same tick,
 * short enough that the next tick (or a /health request a second later) always
 * re-reads: a stale heartbeat would shift the cadence gate and the dead-tick
 * backfill test by exactly that much.
 */
const HEARTBEAT_REUSE_MS = 2_000;

/**
 * How stale `scheduledTickFinishedAt` may be before the next arrival is stamped
 * before init. Every scheduled tick returns within ~5-10s of its arrival (scan
 * + flush + tracker pass, or one cadence-gate skip) and the trigger fires every
 * 60s, so 90s is one cadence of slack for jitter: a healthy warm isolate stamps
 * nothing, while an isolate whose last tick died stamps EVERY arrival it then
 * receives — the flag cannot move again until a tick returns, which is what
 * makes a wedge's deliveries countable instead of invisible.
 */
export const SCHEDULED_ARRIVAL_SUSPECT_GAP_MS = 90_000;
/**
 * Bound on the pre-init stamp (see recoveryAwait). The stamp sits in FRONT of
 * init on exactly the ticks whose front is already suspect, so it may never be
 * allowed to spend the envelope it exists to observe: a bounded-away stamp is
 * left running (the write is idempotent) and costs the tick nothing.
 */
const PRE_INIT_ARRIVAL_BOUND_MS = 1_500;
/**
 * Bound on the tick's front INIT (see `scheduled`). The cron handler's front
 * is the one stage that runs before any bookkeeping: `ensureInitialized`
 * pays the schema DDL on a cold isolate, the dead-tick recovery read on a
 * warm one, and the Turso handshake — and until now it was awaited
 * UNBOUNDED. A wedged init therefore died inside the invocation before the
 * gate could record the arrival: live 2026-09-25 `scheduled_tick_at` stood
 * still for 26 minutes while the HTTP fallback kept landing scans, i.e. cron
 * looked dead for a reason nothing published. Bounding it turns that into a
 * tick that RECORDS its arrival and returns (the path a missing scanner
 * already takes), so the next delivery — or the fallback — retries against
 * a fresh promise. 3_500 leaves the scan a real window: the race clamp above
 * absorbs anything slower, and it is ~3x the live warm-isolate Turso init.
 */
export const FRONT_INIT_BOUND_MS = 3_500;

/**
 * Whether this arrival must be stamped before init: true when this isolate has
 * no completed scheduled tick to point at (cold, or one that never returned).
 * Pure and exported so the rule is unit-tested (scripts/test-unit.js) instead of
 * only observed live — a 0 flag means "never finished here", NOT "finished at
 * the epoch", and the export exists for the same reason
 * deadTickRebuildDecision's does.
 */
export function shouldStampArrival(
  lastFinishedAt: number,
  now: number,
  gapMs: number = SCHEDULED_ARRIVAL_SUSPECT_GAP_MS,
): boolean {
  if (!Number.isFinite(lastFinishedAt) || lastFinishedAt <= 0) return true;
  return now - lastFinishedAt > gapMs;
}

/**
 * Cron-arrival bookkeeping through a standalone raw client — the pre-2026-09-23
 * shape, kept for the paths where the claim batch that normally carries it
 * provably will not run: no scanner (a broken init would otherwise make cron
 * look dead from /health, which is exactly what this counter is for) and an
 * unreadable worker_state. Returns what it cost, for summary.preTick.steps.bump.
 */
async function bumpScheduledTickLegacy(env: Env): Promise<number> {
  const at = Date.now();
  try {
    if (env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN) {
      const probe = new Db(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
      await probe.bumpScheduledTick();
    }
  } catch (err) {
    console.error("[worker] standalone cron counter failed:", err);
  }
  return Date.now() - at;
}

/** Pre-scan split of the tick that finished most recently (see the header). */
export function preTickView(): PreTickView {
  return { ...preTick, steps: { ...preTick.steps } };
}

/** Start a fresh pre-scan split for a tick entering the handler. */
/**
 * Start the PRE-SCAN SLICE at `entryAt`: the entry stamp the split is measured
 * from (see PreTickView), with the step split reset.
 *
 * WHY IT IS APART FROM beginPreTick (2026-09-27): a caller that only wants the
 * slice MEASURED must not reset this isolate's subrequest counter — the HTTP
 * fallback used to do exactly that on every request, including the uptime
 * monitor's /health ping, which then returned without scanning. The reset rolled
 * the scan tick's own window mid-scan: its remaining counts landed in a
 * stranger's window and, once windows carried owners, the tick's own reading
 * came back `owner:"http"` (live 03:56-03:57Z).
 */
function markPreTickEntry(entryAt: number): void {
  preTickEntryAt = entryAt;
  preTick = {
    at: entryAt,
    steps: { ...PRE_TICK_ZERO_STEPS },
    preStartMs: null,
    preRaceMs: null,
    raceMs: null,
  };
}

/**
 * The seam for the paths whose window IS their own: the slice stamp PLUS the
 * subrequest window — the unit Cloudflare limits to 50 per invocation (see
 * src/subreqs.ts). Anything else this isolate serves inside the same window (a
 * webhook, a /debug probe) is counted into it as an upper bound, and the phase
 * ring localizes the spend.
 *
 * The HTTP fallback does NOT enter here: it stamps with markPreTickEntry at the
 * request's entry and opens its window only where it commits to scanning, so a
 * ping that then returns cannot roll the scan tick's window mid-scan (see
 * markPreTickEntry, measured 2026-09-27 03:56-03:57Z).
 *
 * The OWNER rides along (2026-09-27): the pass's own cron delivery is a
 * separate invocation that lands on this same isolate most minutes, so without
 * it a scan front and a pass rotation are one indistinguishable `turso: N` —
 * and every question about the front's cost is unanswerable.
 */
function beginPreTick(entryAt: number, owner: SubreqOwner = "unknown"): void {
  beginSubreqWindow(entryAt, owner);
  markPreTickEntry(entryAt);
}

/**
 * Cross-isolate single-flight lease for one scan pass (see
 * Db.claimScanLock). The cadence gate is a read-then-act heartbeat check, so
 * two isolates can both see the same stale heartbeat and start a full scan
 * in the same second (cron + the HTTP fallback, or parallel uptime-monitor
 * requests) — observed 2026-09-03 as duplicate scan_history completion rows
 * at the same timestamp, each burning a full second round of upstream calls
 * + Turso rows-read. The lock makes the loser skip. 55s covers the whole
 * scan envelope (15s budget + ~1s flush + pre-race round trip) with margin
 * and still expires fast if the holder isolate dies mid-scan (Cloudflare
 * kills invocations around ~20-30s).
 *
 * 2026-09-16: 55000 → 15000, tracking the tick envelope (9.5s budget, race
 * at ~5.0s, flush done by ~6s). 55s was sized for a 15s-scan era and it
 * silently disabled the HTTP rescue path in exactly the failure it exists
 * for: a tick that dies before its flush NEVER releases the lease, so for
 * the next 55s every trigger — including the external /health fallback that
 * is supposed to complete a scan with its generous wall clock — lost the
 * CAS claim and skipped. Live proof: /debug/tick during the 2026-09-16
 * 06:36Z+ dead-tick stretch returned `ok:false, ms:548, summary:null` — the
 * lost lease, not a failed scan. 15s is ~1.5× the whole honest envelope, so
 * a live scan keeps its lease while a dead holder frees it well inside one
 * cron period (the previous fix in this file — the takeover branch below —
 * then re-claims it and the scan proceeds).
 *
 * 2026-09-28 (15_000 → 30_000): the tick envelope went to 20s on Workers Paid
 * (see SCAN_TICK_BUDGET_MS), so the lease has to outlive it again — 1.5x the
 * honest envelope is the ratio this constant was last sized at. A dead holder
 * still frees the lease long inside the external monitor's rescue gate, which
 * needs max(120s, 2 x SCAN_INTERVAL_SECONDS) of silence before it will scan.
 */
const SCAN_LOCK_TTL_MS = 30_000;
/**
 * The cadence gate's jitter budget: slack the configured interval gets before
 * the gate refuses a tick. The gate is `now - heartbeat.at >= gateMs`, and
 * `at` is the previous scan's COMPLETION (the completion flush overwrites the
 * claim's start stamp with `flushedAt`), so what the gate measures is
 * completion-to-entry of the next tick. The old flat 10s margin was sized for
 * the claim offset alone (2026-09-07: a strict comparison skipped every other
 * tick) and cannot absorb dispatch jitter: measured 2026-09-27 from the cron
 * ring, 18 of 90 arrivals landed at :10 or later, up to :29 — and every late
 * completion (:2x) was followed by a ~100s hole, because the next tick read
 * age ~35-45s and skipped.
 *
 * WHY NOT 30s FOR EVERY INTERVAL: for an interval longer than one cron period
 * the gate IS the cadence knob — 90s is implemented by skipping every other
 * 1-minute tick, which needs the gate strictly above 60s (90 - 20 = 70; with a
 * full 30s margin it would land exactly on 60 and the setting would silently
 * become 60s). So the margin shrinks to whatever room is left above one period.
 *
 * Overlap safety is the scan lock's job (CAS claim + TTL), not the gate's: a
 * margin this size can never start a scan on top of a live one.
 */
export const SCAN_GATE_JITTER_MS = 30_000;
/** Never let the gate land right on one cron period (see scanGateMs). */
export const SCAN_GATE_MIN_MARGIN_MS = 10_000;
/**
 * Floor for a SUB-MINUTE gate (see scanGateMs): one scan takes 3-4s, so a
 * threshold below this would let a second trigger start a scan on top of the
 * completion it is still measuring. Only the clock's regime reaches it.
 */
export const SCAN_GATE_SUBMIN_FLOOR_MS = 5_000;
/**
 * The cadence gate's threshold for a configured scan interval: scan when the
 * last COMPLETION is at least this old. Pure and exported so the modes this
 * file must keep working are asserted in tests instead of watched live: the
 * 60s default ("scan on every tick"), 90s ("skip every other tick") and —
 * since 2026-10-02 — the sub-minute clock's regime (see TickClock), where the
 * interval IS the target and the gate keeps HALF of it as slack.
 *
 * WHY HALF BELOW ONE CRON PERIOD: the gate measures completion-to-entry, so
 * the previous scan's own duration (~3-4s measured) plus dispatch jitter has
 * to fit inside the slack. At 30s the gate lands at 15s — a healthy clock tick
 * 30s after the last completion reads age ~26s and scans, and even a slow 8s
 * scan (age ~22s) still does. The 60s-and-up arithmetic is untouched: the
 * jitter budget there is what keeps 90s skipping every other tick instead of
 * silently becoming 60s.
 */
export function scanGateMs(scanGapMs: number): number {
  if (scanGapMs < SCAN_CRON_PERIOD_MS) {
    const interval = Math.max(TICK_CLOCK_MIN_MS, scanGapMs);
    return Math.max(
      SCAN_GATE_SUBMIN_FLOOR_MS,
      interval - Math.min(SCAN_GATE_JITTER_MS, Math.floor(interval / 2)),
    );
  }
  const interval = scanGapMs;
  if (interval === SCAN_CRON_PERIOD_MS) {
    return interval - SCAN_GATE_JITTER_MS;
  }
  const room = interval - SCAN_CRON_PERIOD_MS - SCAN_GATE_MIN_MARGIN_MS;
  return interval - Math.min(SCAN_GATE_JITTER_MS, Math.max(0, room));
}
/** Opaque per-isolate owner tag for scan-lock claims. */
const SCAN_LOCK_OWNER = `iso-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/**
 * How old a phase=scanning heartbeat must be before the next tick treats
 * its tick as dead and backfills the missing scan_history row. A live scan
 * flushes phase=done within ~17-18s of its start (16s budget + flush), so
 * anything still scanning at 45s died before the flush. The cadence gates
 * (scheduled + HTTP fallback) only start a new scan when the heartbeat is
 * >= 60s old anyway, so this never fires on a still-running tick, and 45s
 * stays below every supported SCAN_INTERVAL_SECONDS (60/90/120). The
 * backfilled row is written by the next tick that wins the scan lease, so
 * scan_history no longer depends on the scan isolate surviving long enough
 * to flush (the recurring 5-20 min zero-row holes — observed 2026-09-05:
 * a 416s hole 08:28:40 -> 08:35:36 even under the 16s budget).
 */
const BACKFILL_STALE_MS = 45_000;

/**
 * Decide whether the previous tick died before its completion flush. The
 * scan_heartbeat is overwritten by every claim, so runScan captures it
 * BEFORE claiming; after winning the lease, a phase=scanning heartbeat
 * older than staleMs means that tick started a scan but never flushed (the
 * completion batch sets phase=done atomically with the history row, so a
 * done heartbeat implies its row already landed). Returns the dead tick's
 * start time + liveness span for the backfill row, or null when there is
 * nothing to backfill.
 */
export function deadTickBackfillInfo(
  heartbeatRaw: string | null,
  now: number,
  staleMs: number,
): { at: number; ms: number } | null {
  if (!heartbeatRaw) return null;
  let hb: { at?: unknown; phase?: unknown } | null = null;
  try {
    hb = JSON.parse(heartbeatRaw) as { at?: unknown; phase?: unknown } | null;
  } catch {
    return null;
  }
  if (!hb || hb.phase !== "scanning") return null;
  const at = typeof hb.at === "number" ? hb.at : 0;
  if (!(at > 0) || now - at < staleMs) return null;
  return { at, ms: now - at };
}

/**
 * The pre-flush progress record (see TICK_PROGRESS_KEY): written by the tick
 * itself before the flush it may not survive, read by the successor that has
 * to explain the death.
 */
export interface TickProgressRecord {
  /** The tick's startedAt — the SAME value its heartbeat carries as `at`. */
  at: number;
  /**
   * Where the tick was when it stamped.
   *
   * THE PHASE LADDER (see tickPhaseLadder) — stamped as the tick crosses each
   * boundary, so a death BEFORE the flush can still be attributed to a phase:
   * `scan` (admitted, the scan not yet entered), `front` (the discovery feeds
   * returned), `pair` (the pool read and the pair fetch returned), `gate` (the
   * candidate chain: registration, eval, the per-chat gates, the push).
   *
   * THE FLUSH STAGES, stamped once the scan is over: `postscan` (flush in
   * front of it), `postscan-late` (same point, but too late to wait for the
   * stamp), `flush-hung`, `flush-failed`, `flush-retry-failed`.
   */
  stage: string;
  /** When this stamp was written (epoch ms). */
  t: number;
  /** `t - at`: how far into the tick this stamp was written. */
  ms: number;
  /** The completion batch's heartbeat payload, in bytes. */
  payloadBytes: number;
  /** Wall clock the scan had spent before the flush started. */
  scanMs: number;
  /** The front split (`preTick.preRaceMs`) — the cold-front reading. */
  preRaceMs: number;
  /**
   * The front split as far as it was KNOWN when this stamp was written (see
   * preStartSplitNote / frontSplitNote) — a durable STRING because this row is
   * the only witness a killed tick leaves.
   *
   * Two shapes, and the shape is part of the reading: at the ADMISSION stamp
   * (which rides the claim) the pre-race phase is still running, so the value
   * is the `preStart` half alone — enough to name a cold `init`; every stamp
   * from the race onwards carries the whole `front = preStart + preRace` line.
   */
  front: string | null;
  /** Subrequests counted so far in the invocation (see src/subreqs.ts). */
  subreqs: number;
  /** Whether the scan race cut this tick (`timedOut`). */
  cut: boolean;
  /** The scan's error, or the flush's own failure reason. */
  err: string | null;
}

/**
 * How much of a failure reason the record keeps (it is read, not parsed).
 *
 * RAISED 160 -> 320 (2026-09-28): the race-window error now carries the whole
 * front split (~190 chars), and the number a reader opens that message for is
 * the remainder at its END — a 160-char cap cut off exactly the reading the
 * message was extended to provide.
 */
export const TICK_PROGRESS_ERR_MAX = 320;
/**
 * How much of the front split the record keeps. Sized for the longest line the
 * two formatters can produce (the whole front, every step named 0-99999), so a
 * stamp never reports a split with its tail cut off.
 */
export const TICK_PROGRESS_FRONT_MAX = 220;

/**
 * What one stamp carries. `at` is the tick's startedAt — the value that keys
 * the record to ONE tick, which is what lets the successor refuse to credit
 * another tick's stamp to this death (see tickProgressNote).
 */
export interface TickProgressFields {
  at: number;
  stage: string;
  payloadBytes: number;
  scanMs: number;
  preRaceMs: number;
  /** The front split so far (see TickProgressRecord.front); null = not known. */
  front?: string | null;
  subreqs: number;
  cut: boolean;
  err: string | null;
}

/** Build one. Time is taken here so `t`/`ms` can never disagree. */
export function tickProgressRecord(fields: TickProgressFields): string {
  const t = Date.now();
  const whole = (n: unknown) => {
    const v = Number(n ?? 0);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  };
  const rec: TickProgressRecord = {
    at: whole(fields.at),
    stage: String(fields.stage).slice(0, 32),
    t,
    ms: Math.max(0, t - whole(fields.at)),
    payloadBytes: whole(fields.payloadBytes),
    scanMs: whole(fields.scanMs),
    preRaceMs: whole(fields.preRaceMs),
    front: fields.front ? String(fields.front).slice(0, TICK_PROGRESS_FRONT_MAX) : null,
    subreqs: whole(fields.subreqs),
    cut: fields.cut === true,
    err: fields.err ? String(fields.err).slice(0, TICK_PROGRESS_ERR_MAX) : null,
  };
  return JSON.stringify(rec);
}

/**
 * The tick's PHASE LADDER (see TICK_PROGRESS_KEY): the same one row, stamped
 * again as the tick crosses each phase boundary, so a tick that dies BEFORE
 * its pre-flush record can still be attributed to a phase instead of to the
 * whole pre-flush stretch.
 *
 * WHY (2026-09-24, live). The pre-flush record only lands once the scan is
 * over, and four of the first four deaths it captured (20:04-20:06Z, 21:43Z)
 * never wrote one of their own: every note read `prog none: the row still
 * holds an earlier tick's stamp`, i.e. the record could only say "before the
 * flush", which is where the entire tick lives. The phases in that stretch
 * are `scan` (admitted, scan not yet entered), `front` (the discovery feeds
 * returned), `pair` (the pool read and the pair fetch returned) and `gate`
 * (the candidate chain entered).
 *
 * THE COST MODEL, which is the only reason this is not four awaited writes:
 *
 *   - Each stamp is ONE worker_state write (one subrequest). Nothing else.
 *   - The ladder NEVER awaits them: the tick queues a stamp and walks on, so a
 *     stamp costs the tick ZERO wall clock. The write lands ~200ms later,
 *     while the tick is already in the next phase — which matters because the
 *     late tick is the one that dies, and this telemetry must never be the
 *     reason.
 *   - The queue is STRICTLY ordered: two writes to ONE row in flight at once
 *     could land out of order and let a LATER phase describe a tick that never
 *     got there. Each stamp chains on the previous one's settlement, and
 *     refusals are absorbed so one refused write cannot stall the row behind
 *     it.
 *   - The pre-flush record rides the SAME queue, which is what keeps the row
 *     honest: what the successor reads is the last stamp written, not a phase
 *     stamp that overtook it.
 *
 * Only the last stamp to land survives, and that is the reading: the row names
 * the last phase the tick reached AND stamped in time. A phase whose write
 * never landed reads as the phase before it — a bounded unknown.
 */
export interface TickPhaseLadder {
  /** Queue one stamp. Resolves when its own write has settled. */
  stamp(fields: TickProgressFields): Promise<unknown>;
  /** The queue as of this call — what the pre-flush record queues behind. */
  tail(): Promise<unknown>;
}

export function tickPhaseLadder(
  write: (recordJson: string) => Promise<unknown>,
): TickPhaseLadder {
  let tail: Promise<unknown> = Promise.resolve();
  const stamp = (fields: TickProgressFields) => {
    const json = tickProgressRecord(fields);
    // `.then(run, run)`: a refused PREDECESSOR must not cancel the stamps
    // behind it — a lost stamp is a reading, a stalled ladder is a lost row.
    const run = () => write(json);
    const chained = tail.then(run, run);
    // The queue absorbs the refusal; the caller still gets the real promise.
    tail = chained.then(
      () => {},
      () => {},
    );
    return chained;
  };
  return { stamp, tail: () => tail };
}

/**
 * `now - at` for a durable epoch read by /health, or null when there is no
 * reading at all (a missing row is NOT a row written at the epoch).
 *
 * WHY AN AGE AND NOT JUST THE TIMESTAMP (2026-09-24): two of /health's
 * readings are snapshots that stay put BY DESIGN, and a bare timestamp next
 * to counters that DO move is what let them read as live:
 *
 *   - `writeDrainError.pending` is the queue size AT the failure — a clean
 *     drain never rewrites the row (see persistDrainError), so it sat at 15
 *     from 11:58 all day while the SQL it named had been fixed 41 seconds
 *     before that stamp was written.
 *   - `scheduledTickAt` frozen for 2h35m is a cron ring hole (deliveries
 *     arriving, every tick dying inside init, scans still landing from the
 *     HTTP fallback), and the heartbeat cannot show it because the fallback
 *     keeps the heartbeat green.
 *
 * An age is what a monitor can alert on. A timestamp is what a human reads.
 */
export function healthAgeMs(now: number, at: number | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.max(0, Math.round(now - value));
}

/**
 * Parse one back; null when it is not a record this code wrote. Strict on
 * purpose: `at` + `stage` are the two fields every reading depends on, and a
 * row that is missing either one must not be dressed up as a tick's progress.
 */
export function parseTickProgress(
  raw: string | null | undefined,
): TickProgressRecord | null {
  if (!raw) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const num = (x: unknown) => {
    const v = Number(x ?? 0);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  };
  const at = num(rec.at);
  const stage = typeof rec.stage === "string" ? rec.stage : "";
  if (at <= 0 || stage === "") return null;
  return {
    at,
    stage,
    t: num(rec.t),
    ms: num(rec.ms),
    payloadBytes: num(rec.payloadBytes),
    scanMs: num(rec.scanMs),
    preRaceMs: num(rec.preRaceMs),
    front: typeof rec.front === "string" ? rec.front : null,
    subreqs: num(rec.subreqs),
    cut: rec.cut === true,
    err: typeof rec.err === "string" ? rec.err : null,
  };
}

/**
 * What the successor appends to the backfill row's `err`: the one sentence
 * that turns "a tick died" into "this tick died HERE, with this batch, at this
 * spend". Always returns something — an absent record is itself the reading
 * `prog none`, and saying that is the difference between a bounded unknown and
 * a blank cell a reader has to interpret.
 *
 * The `at` comparison is what makes it safe against ANY earlier tick's row: a
 * record that belongs to another tick is reported as such, never credited to
 * this death.
 */
export function tickProgressNote(
  raw: string | null | undefined,
  deadAt: number,
  limit = 240,
): string {
  const none = (why: string) => ` [prog none: ${why}]`.slice(0, limit);
  const rec = parseTickProgress(raw);
  if (!rec) return none("died before the pre-flush record, or its own write was lost");
  if (rec.at !== deadAt) {
    // The record is keyed by the tick's startedAt, so an EARLIER stamp is not
    // this tick's evidence at all — it means the dead tick never reached its
    // own pre-flush point, which is the `prog none` reading and is reported
    // with the reason instead of a bare "none". A NEWER stamp cannot come
    // from a death this successor is backfilling (the successor stamps only at
    // the end of its OWN tick), so it is named as what it is, not assumed
    // away.
    return rec.at < deadAt
      ? none(
          `the row still holds an earlier tick's stamp (at ${rec.at}): this tick never landed its own, so it died before its first phase stamp`,
        )
      : ` [prog other (at ${rec.at} ≠ ${deadAt})]`.slice(0, limit);
  }
  const bits = [`prog ${rec.stage}`, `+${rec.ms}ms`];
  // A PHASE stamp carries no batch (payloadBytes 0): the size only means
  // something once the record describes a flush (see tickPhaseLadder).
  if (rec.payloadBytes > 0) bits.push(`${rec.payloadBytes}B`);
  // 0 = the split did not exist when this record was written (the admission
  // stamp, which rides the claim — see Db.claimScanLock): printing it as
  // "0ms" would read as a pre-race phase that cost nothing.
  bits.push(`subreqs ${rec.subreqs}`, `preRace ${rec.preRaceMs > 0 ? `${rec.preRaceMs}ms` : "n/a"}`);
  // The front split, printed BEFORE cut/err on purpose: this note is bounded,
  // and the split is the reading that says WHY the tick ran out of window — a
  // truncated tail must lose the error text, never this (it is also why the
  // err copy is placed last).
  if (rec.front) bits.push(rec.front);
  if (rec.cut) bits.push("cut");
  if (rec.err) bits.push(`err:${rec.err}`);
  return ` [${bits.join(" ")}]`.slice(0, limit);
}

/** How often a scan was skipped because another isolate held the scan lock. */
let crossIsolateScanSkips = 0;
/** How many times a dead predecessor tick's history row was backfilled. */
let backfilledTicks = 0;
/**
 * Consecutive dead ticks. One dead tick is noise (a Turso spike, a wall-clock
 * kill); a STREAK means the module-scoped state (a hung upstream fetch, a
 * libsql connection stuck in an internal retry loop) is wedged — 2026-09-08
 * 12:26-12:59Z logged 29 consecutive dead ticks on a poisoned isolate while
 * healthy isolates kept landing OK rows.
 *
 * WHAT CHANGED (2026-09-19 16:05-16:33Z live: 23 consecutive cron ticks and
 * 28 minutes with ZERO scan rows). Cron fired every minute, every tick won
 * the claim, wrote its phase=scanning heartbeat — and died before its
 * completion flush, while the breaker never fired ONCE. The reason is
 * structural: a tick killed by the invocation wall clock runs no `finally`,
 * so both the counter increment and the rebuild that lived there were
 * unreachable during exactly the failure they exist for. Only a redeploy
 * ended it.
 *
 * The rebuild therefore moved to the SUCCESSOR tick, as early as this module
 * can reach it: the top of ensureInitialized, which every scheduled and HTTP
 * tick calls before it scans (see the dead-tick recovery block there). The
 * witness is the same signal the history backfill uses — a stale
 * phase=scanning heartbeat means the predecessor never flushed — and the
 * recovering tick drops the module-scoped clients + scanner, rebuilds them
 * inline and then scans the SAME tick, so recovery costs no scan minute.
 *
 * The recovery announces itself by rewriting the heartbeat with `rebuiltAt`
 * while KEEPING the dead tick's `at` (writing `now` would make the cadence
 * gate skip the very tick that just rebuilt the state). That marker is what
 * stops one death from rebuilding on every later tick, so no durable counter
 * is needed.
 *
 * Why the counter below has no publish site yet: the free way to carry it is
 * the claim heartbeat the tick already writes, and that write sits past this
 * repo's file-edit window (the same window that forced this rebuild to move).
 * The helpers stay exported and unit-tested so the escalation rule is pinned
 * the moment that write becomes editable; the shipped path uses the marker.
 */
let deadTickStreak = 0;
/** Streak length that triggers the module-state rebuild (2 dead ticks). */
export const DEAD_TICK_STREAK_RESET = 2;

/**
 * Whether the tick currently running backfilled a dead predecessor — i.e. THIS
 * is the tick that has to prove a wave of deaths is over. Module state because
 * the two places that need it live in different scopes: runScan proves it (see
 * the backfill there) and the drain, fired from the tick's tail, spends by it
 * (see DEFERRED_DEAD_PREDECESSOR_MAX_CALLS).
 */
let deadPredecessorThisTick = false;

/**
 * The drain's call ceiling for a tick (see DEFERRED_DEAD_PREDECESSOR_MAX_CALLS
 * and DEFERRED_MAX_CALLS_PER_DRAIN). Pure + exported so the rule is unit-tested
 * (scripts/test-tick-path.js) instead of only observed in production.
 */
export function drainCallCeiling(deadPredecessor: boolean): number {
  return deadPredecessor
    ? DEFERRED_DEAD_PREDECESSOR_MAX_CALLS
    : DEFERRED_MAX_CALLS_PER_DRAIN;
}

/**
 * The reason to publish when that ceiling is the lowered one (see the drain's
 * `shed` field), or null when this tick drains at the normal ceiling.
 */
export function drainShedReason(deadPredecessor: boolean): string | null {
  return deadPredecessor ? "dead-predecessor" : null;
}
/**
 * Bound on the successor's dead-tick check (see the recovery block in
 * ensureInitialized). It must stay far below the tick's front window: the
 * check is a guard around the scan, never a second source of ticks that
 * outlive it. A timed-out check does nothing this tick; the next one retries.
 */
const WEDGE_CHECK_BOUND_MS = 1_500;
/**
 * Bound on EACH database await the recovery itself performs (the heartbeat
 * announce and the no-completion alert). The recovery runs BEFORE the scan on
 * exactly the ticks that are already in trouble, and its round trips used to
 * inherit the full DB_REQUEST_TIMEOUT_MS ladder (then 6s transport, 7.2s hard
 * wall — 2.5s/3.0s since 2026-09-20, see db.ts): the read + two writes could
 * grow the front phase to ~22s, past
 * Cloudflare's invocation kill, so the tick doing the recovering died too and
 * the stretch just continued. 800ms is ~6x the live Turso round trip (~130ms),
 * and caps the whole recovery at WEDGE_CHECK_BOUND_MS + 2x this — a fraction
 * of the tick budget, spent before the scan rather than inside it. A
 * bounded-away write is left running (every write on this path is idempotent)
 * and re-offered by the next tick.
 */
export const RECOVERY_DB_BOUND_MS = 800;
/**
 * Await `work` for at most `ms`, treating a timeout and a rejection as the
 * same "did not settle" answer. Recovery bookkeeping must never be able to
 * fail — or delay — the tick that is doing the recovering, so this returns
 * null instead of throwing (the caller's own try/catch would otherwise abort
 * the rest of the recovery, e.g. the alert after a failed announce write).
 * Exported for the offline tests.
 */
export async function recoveryAwait<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
    return raced as T | null;
  } catch (err) {
    console.warn(
      `[worker] dead-tick recovery ${what} failed — continuing:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
/** Set when the recovery rebuilt the module state; surfaced via /health. */
let wedgedStateResets = 0;

/**
 * The streak the previous tick published (0 when the row is missing,
 * unparsable, or carries no usable value). Exported for the offline tests:
 * this drives the pre-scan rebuild, so a heartbeat written before the field
 * existed must degrade to "no streak", never to a rebuild storm.
 */
export function heartbeatDeadStreak(raw: string | null | undefined): number {
  if (!raw) return 0;
  try {
    const hb = JSON.parse(raw) as { deadStreak?: unknown } | null;
    const n = Number(hb?.deadStreak ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/**
 * The streak THIS tick publishes: the predecessor's value, +1 only when the
 * predecessor is PROVEN dead. Pure + exported so the escalation rule is
 * unit-tested instead of only observed in production.
 */
export function nextDeadStreak(prevStreak: number, predecessorDead: boolean): number {
  const prev =
    Number.isFinite(prevStreak) && prevStreak > 0 ? Math.floor(prevStreak) : 0;
  return predecessorDead ? prev + 1 : prev;
}

/**
 * `rebuiltAt` from a heartbeat row (null when absent or unparsable): the
 * marker the recovery writes after it rebuilt the module state. It is what
 * separates "this heartbeat is stale because the state behind it is fresh"
 * from "this heartbeat is stale because the tick died" — without it, the
 * recovery tick's own heartbeat would look like another death and every
 * later tick would rebuild again. Exported for the offline tests.
 */
export function heartbeatRebuiltAt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const hb = JSON.parse(raw) as { rebuiltAt?: unknown } | null;
    const n = Number(hb?.rebuiltAt ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The rebuild marker THIS tick's claim heartbeat must republish (see
 * deadTickRebuildDecision).
 *
 * WHY IT IS MODULE STATE AND NOT A LOCAL (2026-09-28, live). The recovery used
 * to announce itself ONLY in its own heartbeat row, and the claim that follows
 * in the same tick — the row every later tick actually reads — did not carry
 * the marker. So the recovering tick's own `phase: scanning` heartbeat (stale
 * by construction, because a stretching tick never flushes) read as ANOTHER
 * death, and every later tick of the same stretch rebuilt again: a cold re-init
 * (new PoolFallbackDb + db.init() + the boot reads) on the one tick whose whole
 * problem is that its front is too expensive. Measured live 2026-09-28
 * 03:17-03:38Z: `rebuiltAt` re-appearing at 03:31:04.95 in the middle of a
 * 21-minute stretch, with `init-no-scanner` recorded at 03:39:13.21 — an
 * invocation that reached the end of a bounded init with no scanner at all.
 *
 * Set in ensureInitialized's recovery block BEFORE runScan builds the claim:
 * a rebuild sets it now, a tick whose predecessor is still dead CARRIES the
 * published one (the death has already been answered), and a tick whose
 * predecessor is healthy CLEARS it (the stretch is over, so a later death earns
 * a fresh rebuild). null = no rebuild is in force.
 */
let rebuildMarker: number | null = null;

/**
 * The successor's rebuild verdict, as a pure function so the recovery rule is
 * unit-tested instead of only observed in production (scripts/test-tick-path.js).
 *
 * Rebuild iff the predecessor is PROVEN dead — a phase=scanning heartbeat
 * older than staleMs, the exact test the history backfill uses — and its
 * heartbeat carries no `rebuiltAt` marker. The marker is what makes the
 * recovery idempotent: without it, the recovering tick's own (scanning,
 * stale) heartbeat would read as another death and every later tick would
 * rebuild again, forever, while never scanning.
 *
 * Note the deliberate absence of a "2 consecutive deaths" threshold: the
 * predecessor test already requires a proven non-flush, and the cost of a
 * spurious rebuild (one re-init on the tick after a one-off kill) is orders
 * of magnitude below the cost of NOT rebuilding (28 minutes of zero scans,
 * 2026-09-19 16:05-16:33Z). DEAD_TICK_STREAK_RESET stays as the documented
 * escalation threshold for the counter-based path above.
 */
export function deadTickRebuildDecision(
  prevRaw: string | null | undefined,
  now: number,
  staleMs: number,
): { rebuild: false } | { rebuild: true; deadAt: number } {
  const dead = prevRaw ? deadTickBackfillInfo(prevRaw, now, staleMs) : null;
  if (!dead) return { rebuild: false };
  if (heartbeatRebuiltAt(prevRaw) !== null) return { rebuild: false };
  return { rebuild: true, deadAt: dead.at };
}

/**
 * Durable record behind the completion-based outage alert. Deliberately NOT
 * scan_heartbeat: every tick's claim overwrites that row right AFTER the
 * successor's recovery write, which is why heartbeat age can never grow past
 * one cadence while ticks keep claiming — 2026-09-19 16:05-16:33Z ran 28
 * minutes with ZERO completions, and the age-based checkOutageAndAlert stayed
 * silent throughout because the claim refreshed `at` every 60s (the status page
 * read green the whole way). Track completions instead.
 *
 * The row is {start: beginning of the current no-completion stretch, tickAt:
 * wall clock of the death tick that last touched it}. `tickAt` IS the
 * continuity test (wedgeChainEntry): a stored row is a continuation only when
 * the dead predecessor started within tolerance of it, i.e. the row was written
 * by the tick immediately before that predecessor. Rows left over from an
 * outage that already ended fail the test and are replaced, so nothing has to
 * clean up on healthy ticks — day-to-day this costs ZERO round trips and is
 * paid only while ticks are dying.
 */
export const SCAN_WEDGE_STATE_KEY = "scan_wedge";

/** Continuity slack for the row above: 2 cron cadences plus Turso jitter. */
const WEDGE_CHAIN_TOLERANCE_MS = 3 * 60_000;

function parseWedgeEntry(
  raw: string | null | undefined,
): { start: number; tickAt: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { start?: unknown; tickAt?: unknown } | null;
    const start = Number(v?.start ?? 0);
    const tickAt = Number(v?.tickAt ?? 0);
    if (!Number.isFinite(start) || !Number.isFinite(tickAt)) return null;
    if (!(start > 0) || !(tickAt > 0)) return null;
    return { start, tickAt };
  } catch {
    return null;
  }
}

/**
 * Advance (or restart) the durable no-completion stretch — pure and exported so
 * the chain rule is unit-tested (scripts/test-tick-path.js) instead of only
 * observed in production. `start` is preserved across ticks for as long as the
 * deaths keep coming, which is what makes `now - start` the age of the last
 * COMPLETION rather than the age of the last heartbeat.
 */
export function wedgeChainEntry(
  raw: string | null | undefined,
  deadAt: number,
  now: number,
  toleranceMs: number,
): { start: number; tickAt: number } {
  const stored = parseWedgeEntry(raw);
  const continues =
    stored !== null &&
    stored.start <= deadAt &&
    deadAt >= stored.tickAt - toleranceMs &&
    deadAt <= stored.tickAt + toleranceMs;
  return continues ? { start: stored.start, tickAt: now } : { start: deadAt, tickAt: now };
}

/**
 * How long a stretch of LOST COMPLETIONS has to run before it is worth a
 * Telegram page — deliberately NOT OUTAGE_ALERT_GAP_MS, because the two alerts
 * measure different things and only one of them is usually an outage.
 *
 * Measured 2026-09-20: ~44% of ticks lost their completion write while the
 * scanner itself was fine — of the recent pushes that fell inside the
 * scan-history ring, ALL 8 came from ticks the record calls dead
 * (docs/scan-completion-loss.md). A 3-minute threshold therefore paged on
 * telemetry loss alone, several times an hour. The age-based
 * checkOutageAndAlert keeps its 3 minutes and still owns the genuinely bad
 * shape (no tick claiming at all), which this path can never see: by
 * construction a death tick DID claim.
 *
 * 10 minutes is past every lost-flush stretch measured (the longest run of
 * dead rows observed is 13) while still catching a real wedge — the 2026-09-19
 * 16:05-16:33Z incident ran 28 minutes.
 */
export const COMPLETION_ALERT_GAP_MS = 10 * 60_000;

/**
 * The page decision, pure and exported so the rule is unit-tested rather than
 * only observed live (scripts/test-tick-path.js). `alerting` is false for the
 * two cases that must stay quiet: too short a stretch, and a cooldown that has
 * not elapsed. A zero/absent `lastAlertAt` is "never alerted", not "alerted at
 * the epoch" — the pre-existing intent the raw comparison got from `> 0`
 * checks elsewhere in this file.
 */
export function shouldAlertNoCompletion(
  silentMs: number,
  lastAlertAt: number,
  now: number,
  gapMs: number = COMPLETION_ALERT_GAP_MS,
  cooldownMs: number = OUTAGE_ALERT_COOLDOWN_MS,
): { alerting: boolean; minutes: number } {
  const minutes = Math.max(1, Math.round(silentMs / 60_000));
  if (silentMs < gapMs) return { alerting: false, minutes };
  if (Number.isFinite(lastAlertAt) && lastAlertAt > 0 && now - lastAlertAt < cooldownMs) {
    return { alerting: false, minutes };
  }
  return { alerting: true, minutes };
}

/**
 * Both halves of the completion-based outage alert, in one place: keep the
 * durable stretch current, then alert when it outlives COMPLETION_ALERT_GAP_MS.
 * Only ever called from a death tick, so its round trips are paid exactly while
 * scans are not landing. The cooldown row is the same one checkOutageAndAlert
 * uses, so the two alerts can never double-post for one episode (that one still
 * owns the separate "no tick claimed at all" case, where this path never runs).
 */
async function trackNoCompletionStretch(deadAt: number, now: number): Promise<void> {
  const store = db;
  if (!store) return;
  const entry = wedgeChainEntry(
    await store.getWorkerState(SCAN_WEDGE_STATE_KEY),
    deadAt,
    now,
    WEDGE_CHAIN_TOLERANCE_MS,
  );
  await store.setWorkerState(SCAN_WEDGE_STATE_KEY, JSON.stringify(entry));
  const silentMs = now - entry.start;
  // Cheap gate first: a stretch this short can never page, so no cooldown read.
  if (!bot || silentMs < COMPLETION_ALERT_GAP_MS) return;
  const lastAlertRaw = await store.getWorkerState("outage_alert_at");
  const verdict = shouldAlertNoCompletion(
    silentMs,
    lastAlertRaw ? Number(lastAlertRaw) : 0,
    now,
  );
  if (!verdict.alerting) return;
  const chats = await store.listEnabledChats();
  if (chats.length === 0) return;
  // Says what it measures: the tick DID claim (that is how this path is
  // reached at all), so the scan was almost certainly running — what is lost is
  // the completion WRITE. Announcing that distinction is the difference
  // between an operator checking the cards and one chasing a phantom outage.
  const text =
    `⚠️ 扫描器已连续约 ${verdict.minutes} 分钟没有任何一次扫描完成落地` +
    `（扫描本身可能仍在运行，丢失的是完成写入；最早未完成的一轮开始于 ${new Date(entry.start).toISOString()}）\n` +
    `状态页: https://solana-meme-bot.cool1999k.workers.dev/health`;
  for (const chat of chats) {
    try {
      await bot.api.sendMessage(chat.chatId, text);
    } catch (err) {
      console.error("[worker] completion-outage alert failed:", err);
    }
  }
  await store.setWorkerState("outage_alert_at", String(now));
}

/**
 * How long the cached init promise may stay UNSETTLED before the next tick
 * drops it and lets a fresh attempt rebuild the isolate (see
 * cachedInitVerdict). Generous on purpose: a healthy boot is ~1-2s (the handler
 * only allows FRONT_INIT_BOUND_MS = 3.5s in front of a tick), so 60s is ~17x
 * the measured cost and a merely SLOW Turso can never be mistaken for a hung
 * one. The cost of waiting is bounded and honest — an isolate that reaches this
 * barrier is answering every tick with the `!scanner` guard anyway.
 */
export const INIT_UNSETTLED_MAX_MS = 60_000;

/**
 * What a tick should do with the CACHED init promise. Pure and exported so the
 * two shapes this closes can be asserted offline instead of watched live:
 *
 *   - `reuse`: nothing is pending, or the pending boot is young — the normal
 *     shape, and the one that must never re-init (the cache is what keeps a
 *     warm isolate from paying init on every tick and every request).
 *   - `drop`: the boot has been UNSETTLED past `maxMs`, i.e. it is hung. It
 *     will never set `scanner`, so every later tick would answer the
 *     `!scanner` guard for as long as Cloudflare keeps the isolate warm — the
 *     failure measured 2026-09-27 (cron ticks arriving every minute, no scan
 *     completed for ~9h, ending only when a deploy replaced the isolate).
 *     Dropping the cache is what lets the SAME tick start a fresh boot.
 */
export function cachedInitVerdict(
  pendingSince: number,
  now: number,
  maxMs: number = INIT_UNSETTLED_MAX_MS,
): "reuse" | "drop" {
  return pendingSince > 0 && now - pendingSince > maxMs ? "drop" : "reuse";
}

/**
 * Wire a freshly created init boot to the cache it is about to occupy.
 * Exported (like the rest of this file's tick machinery) so the shapes below
 * can be pinned offline.
 *
 * WHY THE SETTLE HANDLERS LIVE HERE, and not at the call site: the cached
 * promise is handed to every later tick, so it must stop being cached the
 * moment it can only make them fail, and `ensureInitialized` cannot do that
 * for itself — its own reset sits AFTER `await initPromise`, which a REJECTION
 * throws straight past, and a boot that never settles never reaches it at all.
 * The two shapes are therefore:
 *
 *   - REJECTED (a constructor that throws — grammy on a bad token, a client
 *     that validates its config, anything unguarded in the boot body): the
 *     cache is cleared at once so the next tick retries, and `onReject` gets
 *     the reason so the failure is visible instead of silent. Attaching a
 *     handler also stops a boot that rejects AFTER its creator's 3.5s front
 *     bound from surfacing as an UNHANDLED rejection on that isolate.
 *   - STILL PENDING: handled by the next caller's cachedInitVerdict, which
 *     drops it past INIT_UNSETTLED_MAX_MS (see there for why).
 *
 * `isCurrent()` is the identity test: a boot a newer one has already replaced
 * must not zero the LIVE boot's age, or the staleness guard would be blinded by
 * the very settle it is waiting for. Its rejection is still reported — that is
 * a real failure of a real attempt — but the cache is left alone.
 */
export function trackInitBoot<T>(
  boot: Promise<T>,
  state: { pendingSince: number },
  handlers: { isCurrent: () => boolean; onReject: (err: unknown) => void },
  now: () => number = () => Date.now(),
): void {
  state.pendingSince = now();
  void boot.then(
    () => {
      if (handlers.isCurrent()) state.pendingSince = 0;
    },
    (err: unknown) => {
      if (handlers.isCurrent()) state.pendingSince = 0;
      handlers.onReject(err);
    },
  );
}

async function ensureInitialized(env: Env): Promise<void> {
  // Dead-tick recovery (see DEAD_TICK_STREAK_RESET). The SUCCESSOR tick is the
  // only witness a killed tick can have, and this is the earliest hook every
  // scheduled and HTTP path reaches before it scans. A predecessor that died
  // before its completion flush leaves a stale phase=scanning heartbeat — the
  // same test the history backfill uses proves it — so the recovering tick
  // drops the module-scoped clients + scanner and rebuilds them here, then
  // goes on to scan this same tick. No scan minute is lost.
  //
  // Why not in runScan's `finally`, where the breaker used to live: a tick
  // killed by the invocation wall clock runs no `finally` at all, which is how
  // 2026-09-19 16:05-16:33Z reached 23 consecutive dead ticks and 28 minutes of
  // zero scan rows with the breaker never firing once.
  //
  // Cost, stated plainly: one single-row read per tick (~110ms live). The free
  // alternative — carrying a streak counter in the claim heartbeat — needs the
  // claim/heartbeat write sites, which sit past this repo's file-edit window.
  // The read is bounded so that slow Turso can never turn this check into the
  // very thing it exists to fix (a tick that outlives its window).
  if (db && dbReady) {
    try {
      const kb = await Promise.race([
        db.getWorkerStates(WEDGE_READ_KEYS),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), WEDGE_CHECK_BOUND_MS),
        ),
      ]);
      const prevRaw = kb?.get("scan_heartbeat") ?? null;
      const now = Date.now();
      // ...and the SAME statement carries the cron-arrival keys, so a cron
      // tick's front path needs no second read (see lastCronKeysRead /
      // cronGateLoad). `kb` stays null when this read TIMED OUT, and that
      // null is what tells the gate to fetch them itself — a timeout here
      // must not be read as "the ring is empty", or the claim batch would
      // write a one-entry ring and drop the history.
      lastCronKeysRead = { map: kb, at: now };
      // This IS the tick's heartbeat read: the cadence gate below and the HTTP
      // fallback's own gate would each re-read the SAME row — one subrequest
      // apiece out of a 50-subrequest invocation budget, plus ~110-265ms of
      // wall clock each. Shared instead of duplicated (see lastHeartbeatRead /
      // HEARTBEAT_REUSE_MS).
      lastHeartbeatRead = { raw: prevRaw, at: now };
      // The dead-tick evidence rides the SAME statement (see WEDGE_READ_KEYS),
      // and only when that read actually LANDED: recording a timed-out read as
      // "this tick has no record" would turn an unknown into a false claim.
      if (kb) {
        lastProgressRead = { raw: kb.get(TICK_PROGRESS_KEY) ?? null, at: now };
      }
      // The same statement now carries the boot rows (see BOOT_STATE_KEYS), so
      // init's block below reads them from here instead of paying a second
      // round trip for four keys it already has. Recorded ONLY when the read
      // landed: a timed-out front read must not be dressed up as boot rows.
      lastBootKeysRead = { map: kb, at: now };
      // The per-trigger scan counts ride the SAME statement (see
      // SCAN_TRIGGER_STATE_KEYS): /health reads "cron vs fallback" from a read
      // the invocation already paid for, on every invocation, warm or cold.
      if (kb) {
        scanTriggerMirror = parseScanTriggerCounts(kb);
      }
      // Is the predecessor PROVEN dead (see deadTickBackfillInfo)? Asked ONCE
      // here, because two consumers in this block need the same answer: the
      // recovery verdict, and the no-completion stretch below.
      const deadNow = prevRaw ? deadTickBackfillInfo(prevRaw, now, BACKFILL_STALE_MS) : null;
      const verdict = deadTickRebuildDecision(prevRaw, now, BACKFILL_STALE_MS);
      // What the claim below must republish (see rebuildMarker). Three cases,
      // and the distinction is the whole point of the fix:
      //   - this tick rebuilt       -> a NEW marker, now;
      //   - predecessor still dead  -> CARRY the published one: this death has
      //                                already been answered and the stretch
      //                                is still running, so rebuilding again
      //                                would pay a cold boot per tick;
      //   - predecessor healthy     -> CLEAR it: the stretch is over.
      rebuildMarker =
        verdict.rebuild ? now : deadNow !== null ? heartbeatRebuiltAt(prevRaw) : null;
      if (verdict.rebuild) {
        console.error(
          `[worker] predecessor tick died before its completion flush (started ${new Date(
            verdict.deadAt,
          ).toISOString()}) — rebuilding module state before this scan`,
        );
        dex = null;
        helius = null;
        birdeye = null;
        gmgn = null;
        axiom = null;
        arkham = null;
        crimeWallets = null;
        walletAnalyzer = null;
        flurryAnalyzer = null;
        scanner = null;
        scannerReady = false;
        initPromise = null;
        wedgedStateResets++;
        // The rebuilt Scanner restarts its counters at zero, so a surviving
        // baseline would make every later increment look "already written"
        // (delta <= 0) and silently drop it.
        pushDeferralBaseline = { deferred: 0, recovered: 0, pruned: 0 };
        // Announce the rebuild in the heartbeat, keeping the DEAD tick's `at`:
        // `now` would make the cadence gate skip the tick that just rebuilt the
        // state, and `rebuiltAt` is the marker that stops the same death from
        // rebuilding again on every later tick. One extra round trip, paid only
        // on a recovery tick.
        //
        // The claim this tick goes on to win still sees that same stale
        // phase=scanning row, so runScan writes the dead tick's backfill row as
        // usual — the recovery adds a rebuild, not a hole in scan_history.
        // Bounded: the announce is a nicety (it stops one death from
        // rebuilding on every later tick) and must not become the next death.
        await recoveryAwait(
          db.setWorkerState(
            "scan_heartbeat",
            JSON.stringify({
              at: verdict.deadAt,
              ok: true,
              phase: "scanning",
              rebuiltAt: Date.now(),
            }),
          ),
          RECOVERY_DB_BOUND_MS,
          "heartbeat announce",
        );
      }
      // Outage tracking on COMPLETIONS, not on heartbeats — see
      // trackNoCompletionStretch for why the age-based checkOutageAndAlert can
      // never fire while ticks keep claiming, and why the successor tick is the
      // only one that can keep the durable record. Dead-only: a heartbeat this
      // tick can read as healthy means a completion landed, which is what ends
      // the stretch (the row's own continuity test is what retires it).
      if (deadNow) {
        // Bounded for the same reason as the announce write: the alert is the
        // LAST thing this tick needs, and a hung wedge read/write here would
        // spend the successor's front window on bookkeeping — the
        // amplification that turned one lost completion into the 2026-09-19
        // chains of 5+ dead ticks. The stretch stays open, so a bounded-away
        // alert is late, never lost.
        await recoveryAwait(
          trackNoCompletionStretch(deadNow.at, now),
          RECOVERY_DB_BOUND_MS,
          "no-completion alert",
        );
      }
    } catch (err) {
      console.warn(
        "[worker] dead-tick recovery check failed — continuing:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  const fp = tradeFingerprint(env);
  if (initPromise && fp !== lastTradeFp) {
    // Trade bindings changed since init (e.g. the wallet secret was added or
    // TRADE_MODE was flipped in the dashboard) — re-initialize so the change
    // takes effect without a redeploy. Turso/scan state survive: db is
    // module-level and re-init only overwrites the clients, bot and trade.
    console.log("[worker] trade bindings changed — re-initializing");
    initPromise = null;
  }
  if (initPromise && cachedInitVerdict(initBoot.pendingSince, Date.now()) === "drop") {
    // Hung, not merely slow (see cachedInitVerdict): it will never set
    // `scanner`, so this tick drops the cache and boots again rather than
    // answering the `!scanner` guard for the rest of the isolate's life.
    console.error(
      `[worker] init promise still unsettled after ${Math.round(
        (Date.now() - initBoot.pendingSince) / 1000,
      )}s — dropping the cached init so this tick can rebuild`,
    );
    initPromise = null;
    initBoot.pendingSince = 0;
  }
  if (initPromise) return initPromise;
  const boot = (async () => {
    const config = loadConfig(env);
    cfg = config;
    lastTradeFp = fp;
    tursoConfigured = Boolean(config.tursoUrl);
    heliusConfigured = Boolean(config.heliusApiKey);
    birdeyeConfigured = Boolean(config.birdeyeApiKey);
    gmgnConfigured = Boolean(config.gmgnApiKey) && config.gmgnEnabled;
    arkhamConfigured = Boolean(config.arkhamEnabled && config.arkhamApiKey);
    crimeWalletsConfigured = Boolean(config.crimeWallets.enabled);
    walletAnalyzerConfigured = Boolean(config.walletAnalysis.enabled);
    // Axiom is configured when there are login credentials OR already
    // persisted tokens (Google/SSO accounts have no password — their tokens
    // land in worker_state, which is re-checked after DB init).
    axiomConfigured = Boolean(
      config.axiomEnabled && config.axiomEmail && config.axiomPassword,
    );
    tradeConfigured = Boolean(config.trade.walletSecret);
    jupiterKeyed = Boolean(config.trade.jupiterApiKey);      if (config.tursoUrl) {
        try {
          db = new PoolFallbackDb(config.tursoUrl, config.tursoAuthToken);
          await db.init();
          dbReady = true;
          console.log("[worker] Turso ready");
          // ONE read for the four rows this boot needs (2026-09-26) — and
          // since 2026-09-27 the FRONT statement carries them, so the healthy
          // path is zero reads (see BOOT_STATE_KEYS / lastBootKeysRead).
          //
          // WHY: an isolate recycles and the next one pays this block again —
          // four worker_state reads, each a full Turso round trip and, on the
          // invocation's books, one of its 50 subrequests. getWorkerStates
          // exists for exactly this shape ("Many keys, ONE round trip", see
          // db.ts) and the tick's front read already uses it. Live
          // 2026-09-25: a census window read "getWorkerState 5 calls /
          // 2559ms" — the largest single method in a ~20-round-trip tick —
          // and this block is four of those keys on every cold isolate.
          //
          // ONE try around the four (they used to have one each): the three
          // mirrors are best-effort telemetry that a refused read leaves at
          // its previous value either way, and the axiom flag below is a
          // nicety the credential check re-derives. A failed read is "no
          // reading", never "no row": the map simply lacks the key, which is
          // the same null the four single reads produced.
          // ...and they are already in hand on the healthy path (2026-09-27):
          // the front statement ABOVE read them (see BOOT_STATE_KEYS), in this
          // same invocation, ~300ms ago. So this block pays ZERO subrequests
          // and keeps its old shape only as the fallback — a front read that
          // timed out (null map) or one older than the reuse window.
          let bootStates: Map<string, string> | null =
            lastBootKeysRead !== null &&
            Date.now() - lastBootKeysRead.at <= HEARTBEAT_REUSE_MS
              ? lastBootKeysRead.map
              : null;
          if (bootStates === null) {
            try {
              bootStates =
                (await db?.getWorkerStates([...BOOT_STATE_KEYS])) ?? null;
            } catch {
              // telemetry only — never fail init over a counter read
            }
          }
          // A Google/SSO Axiom account has no password — its tokens reach
          // worker_state out of band, so the feed is "configured" whenever a
          // stored access token exists too.
          const storedAxiomToken = bootStates?.get("axiom_access_token") ?? null;
          if (storedAxiomToken && config.axiomEnabled) axiomConfigured = true;
          if (bootStates) {
            // Mirror the durable deferral counters (src/deferrallog.ts) so this
            // isolate's heartbeats carry the fleet-wide numbers even before it
            // has any of its own. A row that does not exist yet loads as an
            // all-zero snapshot (never null): /health then reads "nothing has
            // been deferred yet" instead of something indistinguishable from a
            // missing counter channel, which is what makes the first rise
            // visible as 0 → 1 rather than null → object.
            try {
              pushDeferralSnapshot = loadPushDeferralSnapshot(
                bootStates.get(PUSH_DEFERRAL_STATE_KEY) ?? null,
              );
            } catch {
              // telemetry only — never fail init over a counter read
            }
            // Same for the push-baseline ledger (src/pushledger.ts): a freshly
            // recycled isolate answers /health with the durable view instead of
            // null until its first reconciliation comes due.
            try {
              pushLedgerMirror = {
                ...pushLedgerStats(
                  parsePushLedger(bootStates.get(PUSH_LEDGER_STATE_KEY) ?? null),
                  Date.now(),
                ),
                heal: pushWatchHealStats(),
              };
            } catch {
              // telemetry only — never fail init over a ledger read
            }
            // Same for the early-return counters (src/skipcapture.ts): a
            // recycled isolate answers /health with the fleet totals instead of
            // zeros until its own first sync comes due.
            try {
              skipCaptureMirror = parseSkipCaptureState(
                bootStates.get(SKIP_CAPTURE_STATE_KEY) ?? null,
              );
            } catch {
              // telemetry only — never fail init over a counter read
            }
            // Same for the per-trigger scan counts (see SCAN_TRIGGER_STATE_KEYS
            // / scanTriggerMirror): a recycled isolate answers "how much of the
            // scanning is actually cron" with the durable totals instead of
            // zeros until its front read refreshes them.
            try {
              scanTriggerMirror = parseScanTriggerCounts(bootStates);
            } catch {
              // telemetry only — never fail init over a counter read
            }
          }
        } catch (err) {
          initError = err instanceof Error ? err.message : String(err);
          console.error("[worker] Turso init failed:", initError);
        }
      } else {
      console.warn("[worker] TURSO_DATABASE_URL missing — persistence disabled");
    }

    dex = new DexScreenerClient(config, {
      onBatch429: (at) => {
        void recordDex429(at);
      },
    });
    // Record what each pair fetch ACTUALLY returned (see observedLiquidity):
    // the scanner keeps only in-memory state, so the worker — which owns the
    // end-of-tick write — has to see the map as it goes by. Cheap: one Map
    // insert per coin per tick, no extra request. The reading is filtered
    // through observedLiquidityUsd, so a leg the pool's USD floors are not
    // calibrated on can never reach the column.
    const fetchPairs = dex.fetchPairsForTokens.bind(dex);
    dex.fetchPairsForTokens = async (addresses, deadline) => {
      const pairs = await fetchPairs(addresses, deadline);
      for (const [token, pair] of pairs) {
        const liq = observedLiquidityUsd(pair);
        if (liq !== undefined) observedLiquidity.set(token, liq);
      }
      return pairs;
    };

    if (config.telegramBotToken) {
      birdeye = null;
      if (config.birdeyeApiKey) {
        try {
          birdeye = new BirdeyeClient(config);
        } catch (err) {
          console.warn(
            "[worker] Birdeye client not ready:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      gmgn = null;
      if (config.gmgnApiKey && config.gmgnEnabled) {
        try {
          gmgn = new GmgnClient(config);
        } catch (err) {
          console.warn(
            "[worker] GMGN client not ready:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      axiom = null;
      // The client is created whenever the feed is enabled, the bot-users
      // push gate is armed, OR a stored session exists — credentials are
      // optional (Google/SSO accounts store tokens instead of a password;
      // the client's login methods guard on that).
      //
      // AXIOM_ENABLED=0 short-circuits ALL of it: no client means no trending
      // call, no per-candidate /token-info and no refresh attempt, so a dead
      // session cannot keep spending API calls and firing admin alerts while
      // it waits for a manual browser re-login (the state 2026-08-27 → 09-19).
      if (
        config.axiomEnabled &&
        (config.axiomTrendingLimit > 0 ||
          config.axiomMinBotUsers > 0 ||
          axiomConfigured ||
          Boolean(config.axiomEmail && config.axiomPassword))
      ) {
        try {
          axiom = new AxiomClient(config);
        } catch (err) {
          console.warn(
            "[worker] Axiom client not ready:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      arkham = null;
      if (config.arkhamEnabled && config.arkhamApiKey) {
        try {
          arkham = new ArkhamClient(config);
        } catch (err) {
          console.warn(
            "[worker] Arkham client not ready:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      crimeWallets = null;
      if (config.crimeWallets.enabled) {
        try {
          crimeWallets = new CrimeWalletClient(config, db);
        } catch (err) {
          console.warn(
            "[worker] Crime-wallet client not ready:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      helius = new HeliusClient(config);

      // Jupiter direct trading (off by default; only constructed when the
      // wallet secret exists).
      if (config.trade.walletSecret && db) {
        trade = new TradeService(config.trade, new JupiterClient(config.trade), db);
        console.log(
          `[worker] Jupiter trading ready (mode=${config.trade.mode}, ${config.trade.amountSol} SOL/buy)`,
        );
      }

      bot = createBot(
        config.telegramBotToken,
        db,
        config.scanIntervalSeconds,
        analyzeMintFlow,
        trade ?? undefined,
        config.adminIds,
      );
      webhook = webhookCallback(bot, "cloudflare-mod");
      botReady = true;

      walletAnalyzer = null;
      if (config.walletAnalysis.enabled) {
        try {
          walletAnalyzer = new WalletAnalyzer(config, db, helius);
        } catch (err) {
          console.warn(
            "[worker] Wallet-analyzer client not ready:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Flurry launch forensics — deploy-slot bundle gate + funding lineage
      // (ported from github.com/NerdHerderDani/flurry, Apache-2.0). Last gate
      // before each push; fail-open; verdicts cached per mint.
      flurryAnalyzer = null;
      if (config.flurry.enabled && helius) {
        try {
          flurryAnalyzer = new FlurryAnalyzer(config, helius);
        } catch (err) {
          console.warn(
            "[worker] Flurry forensics client not ready:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      if (db) {
        scanner = new Scanner(
          db,
          bot,
          dex,
          config,
          birdeye,
          new RugcheckClient(config),
          helius,
          trade ?? undefined,
          // pump.fun discovery — the launch slot's ALWAYS-ON feed since
          // 2026-09-28 (PUMPFUN_PROFILE_LIMIT=20), on every tick; best-effort,
          // a blocked/degraded feed returns [].
          new PumpFunClient(config),
          // GeckoTerminal new-pools discovery — keyed (COINGECKO_API_KEY) and
          // therefore a 5-MINUTE leg, covers every Solana DEX incl. pump.fun
          // graduates; best-effort — blocked or degraded feeds return [] and
          // the scan continues on the others (see the cadence gate + the
          // launch-slot chain in src/scanner.ts).
          new GeckoTerminalClient(config),
          // Jupiter Token v2 discovery — recent launchpad launches (the
          // pump.fun frontend-api replacement) + 24h trending (null when
          // both feed limits are 0).
          config.jupiterRecentLimit > 0 || config.jupiterTrendLimit > 0
            ? new JupTokensClient(config)
            : null,
          // GMGN OpenAPI — candidate enrichment (smart money / wash-trading)
          // + trending discovery feed (null when no key configured).
          gmgn,
          // Axiom Trade trending — login-based momentum feed (null when no
          // credentials configured).
          axiom,
          // Arkham Intelligence — smart-money holder attribution (null when
          // no ARKHAM_API_KEY configured). Card-only enrichment.
          arkham,
          // Crime-wallet blocklist — creator + top-holder owners matched
          // against the community list (null when disabled). Flags the card;
          // CRIME_WALLETS_BLOCK=true turns a hit into a push blocker.
          crimeWallets ?? undefined,
          // Wallet analysis — creator profile + holder ages + cross-coin
          // clustering for pushed coins (null when disabled).
          walletAnalyzer ?? undefined,
          // Flurry launch forensics — deploy-slot bundle gate + funding
          // lineage (null when disabled). Last gate before each push.
          flurryAnalyzer ?? undefined,
          // Meteora Data API newest-pools discovery — GECKO'S COVER since
          // 2026-09-28: reached on every tick gecko's 5-minute cadence holds
          // back, and on a due tick whose fetch came back empty or refused
          // (best-effort; see src/meteora.ts).
          new MeteoraClient(config),
        );
        // Capture every early-return reason the scanner records: it sets
        // lastSkip back to null in runOnce's finally within the same tick, so
        // without this the reason never reaches a reader (src/skipcapture.ts).
        installSkipCapture(scanner);
        // Tick probe (src/tickprobe.ts): keeps every phase stamp of the tick
        // (the scanner keeps only the last one, and the completion path
        // overwrites even that with `done`), and hangs the worker's own
        // per-tick numbers off the summary the completion heartbeat already
        // serializes — the only channel reachable from here.
        //
        // Two live problems it exists for:
        //   - Where did the 4 seconds go on a `candidates 1, pushed 0` tick?
        //     `summary.phases` answers it: the last stamp before the card is
        //     refused is the chain step that ran out of clock, and its ms is
        //     the distance to the claim window (cardClaimDeadline).
        //   - The trade-mode read used to sit UNBOUNDED inside that window
        //     (TradeService.effectiveMode is awaited in the chain right before
        //     the card is rendered and claimed). Kicking it off at the tick's
        //     start makes the chain's call a cache hit instead of a Turso
        //     round trip the tick cannot afford — with `modeRead` publishing
        //     reads/reuses/timeouts so the effect is visible, not assumed.
        // The DB seam (src/tickprobe.ts): the gates' registration read is
        // timed, and the tick's two WRITE round trips (registration insert +
        // max-mcap UPDATE) are taken off the scan's CRITICAL PATH — they used
        // to sit between the pair fetch and the candidate chain, the stretch
        // that kept the card's claim arriving past the boundary (live:
        // `cand>0 & pushed=0` on every candidate tick, front phases ending at
        // 3.2-3.4s against a 3550ms claim gate). The scanner is handed resolved
        // promises and the real calls are drained from onTickEnd below, i.e.
        // after the chain and the tracker pass.
        installTickProbe(scanner, {
          onTickStart: () => {
            // ROUND 4 (§4.25): the override row already rode the tick-front
            // batch, so the cache is primed from it BEFORE the prefetch —
            // which is then a no-op, leaving this tick no mode read at all.
            // A front read that timed out, never happened, or is too old
            // leaves the ride null and the prefetch reads for itself (the
            // pre-round-4 shape: slower, never wrong).
            const ride = frontModeOverrideRead();
            if (ride !== null) trade?.primeModeOverride(ride.raw, ride.at);
            trade?.prefetchMode();
          },
          onTickEnd: (summary) => {
            const view = summary as Record<string, unknown> | null;
            if (!view) return;
            view.modeRead = trade?.modeStats() ?? null;
            view.feedMakeup = feedMakeupView();
            view.dbSteps = dbStepView();
            // Where the time BEFORE the scan went (handler steps + the claim
            // round trip) — the reading `dbSteps` / `modeRead` cannot give,
            // because both measure work INSIDE the scan (see PreTickView).
            view.preTick = preTickView();
            // Describes the drain that ran after the PREVIOUS tick: the
            // summary is serialized before this tick's own drain starts.
            view.writeDrain = writeDrainView();
            // The tracker's own account of its last pass, and the last failure
            // the worker itself caught. Both are MODULE state on purpose: the
            // pass's durable coverage row reads `running` for a pass that was
            // killed, and the write that would have said why is the one the
            // database just refused (live 2026-09-25).
            view.pushWatchLive = trackerPassPulse();
            view.pushWatchFail = trackerPassFailure;
            // Fire the drain WITHOUT awaiting it — and, on a tick that
            // backfilled a death, under a ONE-CALL ceiling: the tick's budget
            // is done with these writes (that is the whole point of deferring
            // them), so the invocation tail must not pay for them either. The
            // queue is module state, so an isolate recycled before the drain
            // lands simply hands the same calls to the next tick's drain -- in
            // call order, which is the order the scanner wrote them in (the
            // registration insert first, then the max-mcap UPDATE). Same
            // pattern the deferral-counter sync already relies on ("its
            // promise is left running -- an idempotent write is welcome to
            // land late").
            //
            // THIS HOOK RUNS BEFORE THE COMPLETION FLUSH (it is the scanner's
            // runOnce wrapper `finally`), so these round trips do sit in front
            // of the one write a tick cannot lose, and that is deliberate:
            // moving the drain behind the flush was shipped 2026-09-28 02:21Z
            // and reverted within the hour, because post-flush there is NO
            // room left — the check below is `subreqRemaining() <= reserve`
            // and the flush has already spent its share, so the queue stopped
            // draining outright (`calls 0` on every tick, `owedTokens`
            // 124 -> 244 -> 293 -> 344 -> 420 pinned at the force cap) against
            // `calls 1-4` with a queue that fell again on the build before it.
            // What protects the flush instead is the death-driven shed: the
            // tick that backfilled a death — the one that has to land a
            // completion to end the stretch — spends ONE call here instead of
            // up to DEFERRED_MAX_CALLS_PER_DRAIN. Moving the drain safely
            // would need a real budget SPLIT (an explicit share for the drain,
            // the flush and the pass) rather than one reserve they take turns
            // measuring against.
            const drained = drainDeferredWrites(subreqRemaining, {
              maxCalls: drainCallCeiling(deadPredecessorThisTick),
              shed: drainShedReason(deadPredecessorThisTick),
            }).then(() => flushObservedLiquidity(scanner));
            // Keep the isolate alive for it when the handler handed us a
            // waitUntil (see tickWaitUntil): an un-awaited promise is
            // cancelled the instant the handler returns, which is exactly
            // why these writes never landed on the cron path.
            if (tickWaitUntil) {
              try {
                tickWaitUntil(drained);
              } catch {
                // A stale context must never break the tick's tail.
                void drained;
              }
            } else {
              void drained;
            }
          },
          db,
          deferWrites: true,
        });
        // Hydrate durable deferred-card identities before the first scan in
        // this isolate; counters alone cannot guarantee a make-up push. Gated
        // on the row having been READ: hydrating ALSO marks the registry
        // authoritative for the tick-tail write (see deferredPushTokens in
        // the registry's own module), and an isolate that never read this
        // row must not be able to clear it.
        if (pushDeferralSnapshot) {
          scanner.seedDeferredTokens(pushDeferralSnapshot.pendingTokens);
        }
        scannerReady = true;
      }
    }
  })();
  initPromise = boot;
  // The cache must not outlive the boot it describes (see trackInitBoot): a
  // REJECTED boot clears it here, because the reset below is unreachable on
  // that path — the `await` underneath raises past it, and a hung boot never
  // reaches it at all. The failure is logged either way, so a throwing
  // constructor is a reading instead of the silent, hours-long wedge it
  // produced on 2026-09-27.
  trackInitBoot(boot, initBoot, {
    isCurrent: () => initPromise === boot,
    onReject: (err) => {
      console.error(
        "[worker] init THREW — dropping the cached init so the next tick retries:",
        err instanceof Error ? err.message : err,
      );
      if (initPromise === boot) {
        initPromise = null;
        initBoot.pendingSince = 0;
      }
    },
  });
  await boot;
  // A failed Turso init (transient 522 / timeout) must not stick forever:
  // reset so the next tick re-attempts init and the isolate self-heals
  // once the database recovers, instead of staying scanner-less until
  // Cloudflare evicts it. NOTE: this arm is the SETTLED-but-not-ready shape
  // (db.init() threw inside its own try) — the throwing and hung shapes are
  // trackInitBoot's and cachedInitVerdict's above.
  if (tursoConfigured && !dbReady) {
    console.warn("[worker] Turso init failed — will retry on the next tick");
    initPromise = null;
    initBoot.pendingSince = 0;
  }
}

/**
 * The tracker pass's own invocation (see TRACKER_CRON and wrangler.toml).
 *
 * WHAT IT DOES: init, then ONE pass with the full TRACKER_PASS_BUDGET_MS and
 * the invocation's whole subrequest window to itself. Nothing else — no scan
 * lock, no cadence gate, no scan heartbeat, no cron-arrival bookkeeping, and
 * none of the tick tail's telemetry (the scan tick still owns all of that, and
 * still runs every minute). The point of the split is that this delivery
 * spends its 38 usable subrequests on the rotation instead of lending the
 * scan's leftovers to it: measured live, the tick's pass ran on 0-6 of them
 * (`ok:0/0 deferred:subreq-budget`, `defer-send N subreq-cut N`).
 *
 * RUNS WHERE THE RELAY PUTS IT (2026-10-02): the delivery's first move is its
 * relay to the placed fetch path (see the relay block at the bottom), so in
 * the healthy shape this body executes at NRT beside the database; the
 * relay's local fallback calls the same body in the cron region. Which one ran
 * is written into the pass row as `relay` (the relayTag parameter) — and the
 * relayed readings are already in: passes come back `relay:"inner"` with
 * `db` between 216ms and 1546ms across shapes (reads single-digit ms, writes
 * tens) and `trackerMs` as low as 216ms, against the ~738ms `db` the ORD pass
 * reported. The distance is no longer the pass's whole cost — its own writes
 * are the floor — which is what any further tuning should read.
 *
 * WHY THE PASS STILL HAS A FALLBACK: this trigger's expression is new, and
 * this platform has silently stopped delivering cron events to this Worker
 * before (docs/uptime-monitor.md). The pass's durable row IS the ownership
 * clock — a scan tick runs the pass itself once that row is older than
 * TRACKER_PASS_FALLBACK_FRESH_MS (see Scanner.runTrackerPass) — so the worst
 * case is the pass cadence, never a card that nobody announces. For the same
 * reason a failure here is only logged: the next delivery (this one or a tick)
 * picks the pass up, and the row keeps saying when it last really ran.
 */
async function runTrackerInvocation(
  env: Env,
  /**
   * Which region this run's invocation is in (see the relay block's THE
   * MARKER): "inner" = the placed replay, "failed" / "skipped" = the cron-side
   * fallback, null = a caller that cannot say. A parameter, never module
   * state — the three deliveries can share one warm isolate. Carried into the
   * pass row.
   */
  relayTag: PassRelayTag | null = null,
): Promise<void> {
  const initAt = Date.now();
  await recoveryAwait(ensureInitialized(env), FRONT_INIT_BOUND_MS, "init");
  preTick.steps.init = Date.now() - initAt;
  // No scanner = init failed or was cut. Nothing to record: this delivery is
  // not a scan arrival, and the pass row is what says whether a pass ran.
  if (!scanner) return;
  // The tick's waitUntil hand-off, for the same reason the tick passes it (see
  // pushwatch.holdForTick): a CUT card's delivery proof is an un-awaited promise
  // created at the pass's tail, and an un-awaited promise is cancelled the
  // moment the handler returns.
  const hold = tickWaitUntil;
  try {
    await scanner.runTrackerPass(
      Date.now() + TRACKER_PASS_BUDGET_MS,
      hold ? (p: Promise<unknown>) => hold(p) : undefined,
      subreqRemaining,
      // Where this invocation ran (see the relay block): the pass row carries
      // it, so "the relay worked" is durable even though the pass writes no
      // scan heartbeat. Null (a caller that cannot say) omits the field.
      { via: "cron-pass", relay: relayTag ?? undefined },
    );
  } catch (err) {
    // A pass can also be killed mid-flight (no catch ever runs), which is why
    // the pulse rides every heartbeat — see the tick path's own report.
    console.error(
      "[worker] tracker delivery pass failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The maintenance delivery's own invocation (see MAINTENANCE_CRON and
 * wrangler.toml).
 *
 * WHAT IT DOES: init, then Scanner.runMaintenanceJobs with
 * MAINTENANCE_BUDGET_MS — the Birdeye periodic backfill, the crime-wallet
 * list refresh and the telemetry-count reconcile, all interval-gated, all side
 * effects. Nothing the scan tick
 * owns is touched here: no scan lock, no cadence gate, no cron-arrival counter,
 * no heartbeat, no tick telemetry. That is deliberate and load-bearing — the
 * arrival counters and the cadence gate both compare SCAN arrivals, so a
 * delivery that never scans must not move them (the rule runTrackerInvocation
 * documents for the same reason).
 *
 * RUNS WHERE THE RELAY PUTS IT (2026-10-02): like the pass above, the
 * delivery relays itself to the placed fetch path first (see the relay
 * block), and this body is both the placed replay's implementation and the
 * local fallback; the stamp it writes carries `relay`.
 *
 * WHY THIS IS SAFE TO SPLIT AT ALL: neither leg's result is consumed by the
 * invocation that produced it. The backfill seeds unseen coins into token_stats
 * and the crime refresh persists the blocklist for the fleet to hydrate, so the
 * only thing that changes is WHICH invocation pays their wall clock — and the
 * scan tick, the one whose latency a reader can see, stops paying it.
 *
 * FAILURE SHAPE: logged, never rethrown, and the row goes unwritten — which is
 * exactly the signal the tick's fallback reads (scanner.
 * MAINTENANCE_PASS_FALLBACK_FRESH_MS), so a failing invocation ends with the
 * tick running the legs again rather than with the legs quietly stopping.
 */
async function runMaintenanceInvocation(
  env: Env,
  /**
   * Which region this run's invocation is in (see the relay block's THE
   * MARKER): "inner" = the placed replay, "failed" / "skipped" = the cron-side
   * fallback, null = a caller that cannot say. Carried into the stamp.
   */
  relayTag: PassRelayTag | null = null,
): Promise<void> {
  const initAt = Date.now();
  await recoveryAwait(ensureInitialized(env), FRONT_INIT_BOUND_MS, "init");
  preTick.steps.init = Date.now() - initAt;
  // No scanner = init failed or was cut. Nothing to do and nothing to record:
  // this delivery is not a scan arrival, and the row it would have written is
  // what tells the tick to fall back — which it will, on the next tick.
  if (!scanner) return;
  try {
    await scanner.runMaintenanceJobs(
      Date.now() + MAINTENANCE_BUDGET_MS,
      // Where this invocation ran (see the relay block): the maintenance stamp
      // carries it, and the next tick republishes it as diag.maintRelay.
      relayTag ?? undefined,
    );
  } catch (err) {
    console.error(
      "[worker] maintenance invocation failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Where THIS invocation ran — the reading a scheduled event cannot give
 * itself.
 *
 * WHY IT EXISTS (2026-10-02): whether moving the Turso group near the cron
 * path is worth its migration depends on a number nothing in this Worker
 * measures — WHERE the unplaced `scheduled` invocation actually executes.
 * The tick's DB timings can only say "far from the database" (init 1.2-1.5s a
 * tick, against the placed fetch path's single-digit ms); they cannot say
 * which region, and a region move aimed at the wrong one is worse than none.
 * A scheduled event carries no `request.cf`, so the only way to see the colo
 * is to ask an outside Cloudflare endpoint: /cdn-cgi/trace answers with
 * `colo=XXX`, terminated by the data center nearest the subrequest's egress
 * — i.e. this invocation's own.
 *
 * COST, stated so it can be judged: one subrequest per scan (of the paid
 * 1,000), ~10-50ms, started at runScan's top and read by the completion
 * payload — never awaited on a critical path, never fatal (null = did not
 * answer). Delete this probe and its `colo` field once the region question
 * is answered.
 */
const CRON_COLO_PROBE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const CRON_COLO_PROBE_BOUND_MS = 1_500;

/** Pure parser for the trace body (exported for the unit test). */
export function parseTraceColo(text: string): string | null {
  const m = /^colo=(\S+)$/m.exec(text);
  return m ? m[1] : null;
}

/** Best-effort: null means "did not answer", never a failed tick. */
async function probeCronColo(): Promise<string | null> {
  try {
    const res = await fetch(CRON_COLO_PROBE_URL, {
      signal: AbortSignal.timeout(CRON_COLO_PROBE_BOUND_MS),
    });
    if (!res.ok) return null;
    return parseTraceColo(await res.text());
  } catch {
    return null;
  }
}

async function runScan(
  prevHeartbeatRawArg?: string | null,
  envRef?: Env,
  /**
   * Cron-arrival bookkeeping to ride the claim batch (see
   * Db.scheduledTickStatements): the handler read the ring with its gate read,
   * so the counter/timestamp/ring cost this tick ZERO extra round trips when
   * the claim lands, and are written on their own only when it does not.
   */
  cronTick?: ScheduledTickEntry | null,
  /**
   * Which invocation runs this scan (see Db.ScanTrigger): "cron" for the
   * scheduled tick, "http" for the fallback, "manual" for /debug/tick. It is
   * stamped as `via` into both heartbeats and the completion payload, and the
   * completion batch counts it durably (Db.scanTriggerStatements) — the ONE
   * reading that answers "how much of the scanning is actually cron".
   *
   * A PARAMETER, never module state: the pass's own delivery lands on this same
   * isolate and overwrites module-scope readings (measured 2026-09-27: a tick's
   * done heartbeat published `subreqs.current.owner:"pass"`, the pass
   * invocation's window). Attribution read at flush time would name the wrong
   * owner; a local cannot.
   */
  via: ScanTrigger = "cron",
  /**
   * Which region THIS scan's invocation ran in (see the relay block's THE
   * MARKER): "inner" = the placed replay a relay drove, "failed"/"skipped" =
   * the cron side's local fallback, null = an HTTP/manual scan. A parameter
   * for the same reason `via` is one — a module-scope reading was measured
   * naming the wrong run on 2026-10-02 (the tracker pass's route cleared the
   * scan's marker mid-flight).
   */
  relayTag: PassRelayTag | null = null,
): Promise<void> {
  if (!scanner) {
    // Same silence as the handler's guard above, on the HTTP path: an
    // invocation that meant to scan (a rescue, a manual tick) and could not,
    // with nothing durable to show for it.
    noteSkipReason("init-no-scanner");
    return;
  }
  const scanVia: ScanTrigger = via;
  // Started BEFORE the claim and read at the flush, so the probe's ~10-50ms
  // never sits on the wall-clock-critical path (see probeCronColo). The
  // sentinel matters: a plain null at flush time would be indistinguishable
  // from "still pending", and reading the previous tick's answer is exactly
  // the misattribution this is meant to prevent.
  let cronColo: string | null | "pending" = "pending";
  void probeCronColo().then((c) => {
    cronColo = c;
  });
  // Cross-isolate single-flight: cron and the HTTP fallback may run on
  // DIFFERENT isolates that each read the same stale heartbeat and both
  // start a scan in the same second (observed 2026-09-03 — duplicate
  // scan_history rows at the same timestamp). Only one isolate scans per
  // lease; the loser skips this tick and the next trigger retries.
  // WALL-CLOCK DISCIPLINE: the claim is batched with the start-heartbeat
  // write (ONE round trip — the same as the pre-lock heartbeat write), the
  // dead-tick backfill row RIDES that same claim batch (conditional on our
  // lock value, so a racing loser can't duplicate it), and the release
  // rides in the completion-flush batch. This guard adds ZERO round trips
  // to a tick whose completion flush lives on a ~1s margin against
  // Cloudflare's invocation kill (2026-09-05: the separate backfill write
  // was pushing the flush past the kill point — zero completions for 15+
  // min). Fail-open: a DB error logs and scans anyway (with a standalone
  // heartbeat write for liveness) rather than risk a silent outage; a
  // missing DB implies no scanner (early return above).
  const startedAt = Date.now();
  let scanLock: string | null = null;
  let claimErrored = false;
  // The PRE-RACE round trips run on the tick's DB leash as well (see
  // Db.enterScanMode). The claim is 1-3 walled round trips (insert-or-ignore,
  // then the CAS takeover's SELECT + UPDATE) and the dead-predecessor
  // heartbeat read can be another, so on a degraded Turso this phase alone
  // measured 9000ms of a 9500ms tick — `preRace 9000ms = json 0 + claim 3000`
  // on five consecutive ticks (live 2026-09-23 02:37-02:41Z). The scan then
  // ran with its 2500ms floor, the tick died at 11500ms, and the tracker pass
  // was skipped entirely: a whole rotation turn lost, not just a card.
  // At 1.4s a trip the same phase cannot spend the scan's window.
  //
  // Paired exit below: immediately before the completion flush, so the flush
  // keeps the longer window the tick-scoped leash was never meant to replace
  // (see DB_REQUEST_TIMEOUT_MS), and the tracker pass re-enters it for itself
  // (see Scanner.runTrackerPass).
  db?.enterScanMode();
  // The PRE-CLAIM heartbeat tells us whether the previous tick died before
  // its completion flush (the flush batch sets phase=done atomically with
  // the history row, so a scanning heartbeat long past its budget means its
  // row never landed). The scheduled handler and the HTTP fallback already
  // read this heartbeat for their cadence gates — they pass it in so the
  // tick adds NO extra round trip; /debug/tick (diagnostic only) reads it
  // here.
  let prevHeartbeatRaw = prevHeartbeatRawArg ?? null;
  if (prevHeartbeatRaw === null && db) {
    try {
      prevHeartbeatRaw = await db.getWorkerState("scan_heartbeat");
    } catch {
      // best-effort — a failed read just skips the backfill this tick
    }
  }
  const heartbeatAt = Date.now();
  // Backfill entry for a dead predecessor: written by the next tick that
  // wins the lease, riding the claim batch (zero extra round trips). The
  // row records that the tick started but never flushed, so scan_history
  // never grows >4-min holes just because an isolate was killed between
  // scan end and flush.
  const dead = prevHeartbeatRaw
    ? deadTickBackfillInfo(prevHeartbeatRaw, Date.now(), BACKFILL_STALE_MS)
    : null;
  // THIS tick's own account of what it found, for the tail that spends by it:
  // the drain behind the completion flush lands ONE call when this tick is the
  // one that has to prove the deaths are over (see
  // DEFERRED_DEAD_PREDECESSOR_MAX_CALLS).
  deadPredecessorThisTick = dead !== null;
  // The dead tick's own pre-flush record (TICK_PROGRESS_KEY). It rode
  // ensureInitialized's ONE statement, so the normal path pays nothing; the
  // fallback read happens ONLY on the tick that has a death to explain, where
  // one round trip is cheaper than the guess it replaces (these are the ticks
  // already paying for a rebuild and a no-completion alert).
  let prevProgressRaw: string | null = null;
  if (dead && db) {
    prevProgressRaw =
      lastProgressRead !== null &&
      Date.now() - lastProgressRead.at <= HEARTBEAT_REUSE_MS
        ? lastProgressRead.raw
        : await db.getWorkerState(TICK_PROGRESS_KEY).catch(() => null);
  }
  // Durable dead-tick streak (see DEAD_TICK_STREAK_RESET): read from the
  // heartbeat the previous tick left, escalated only when that tick is proven
  // dead, and published below in this tick's own claim heartbeat — so the next
  // tick inherits it even if THIS one is killed before its flush.
  const prevDeadStreak = heartbeatDeadStreak(prevHeartbeatRaw);
  const deadStreakNow = nextDeadStreak(prevDeadStreak, dead !== null);
  const backfillEntry = dead
    ? {
        at: dead.at,
        ok: false,
        ms: dead.ms,
        // The sentence a reader actually opens. `ms` is `now - at`, i.e. ONE
        // CRON CADENCE — not the dead tick's lifetime — so the note is what
        // says how far it got: `prog none` = it never reached the pre-flush
        // point (died in its scan or its front); anything else = it reached the
        // flush, with the payload size, the spend and, when the flush then
        // failed, the reason (see TICK_PROGRESS_KEY).
        err:
          "previous tick died before its completion flush (backfilled by next tick)" +
          tickProgressNote(prevProgressRaw, dead.at),
        profiles: null,
        pool: null,
        candidates: null,
        pushed: null,
      }
    : null;
  // Early-return reason view (src/skipcapture.ts). The scanner's own lastSkip
  // is nulled in the same tick it is set, so these fields are how /health
  // answers "why did the sweep evaluate nothing": `skipAt < at` means this tick
  // ran a real scan and the reason predates it (the reason is never invented).
  const startSkip = skipCaptureSnapshot();
  const heartbeatJson = JSON.stringify({
    at: startedAt,
    // Which invocation ran this scan (see runScan's `via`): the /health
    // reading that tells a fallback rescue apart from a cron tick.
    via: scanVia,
    ok: true,
    phase: "scanning",
    // The rebuild marker this tick inherited or set (see rebuildMarker). It
    // MUST ride the claim and not only the rebuild's own announce write: the
    // claim is the row every later tick reads, so a marker that lives only in
    // the announce is erased the moment the recovering tick wins its claim —
    // and that tick's own stale heartbeat then reads as another death on every
    // later tick, rebuilding forever while never scanning, which is the exact
    // failure the marker exists to prevent.
    rebuiltAt: rebuildMarker,
    ms: null,
    err: null,
    skip: startSkip?.reason ?? null,
    skipAt: startSkip?.at ?? null,
    // Subrequests counted so far in this invocation (see src/subreqs.ts).
    // At claim time this is the pre-scan front (init + gate + claim), which
    // is exactly the slice the tick's OWN budget measurement excludes.
    subreqs: subreqView(),
    // Fleet-wide early-return counters (durable row): the isolate view above
    // answers why the tick being reported did nothing, this answers how often.
    skipCapture: skipCaptureMirror,
    // Heal-path counters (src/pushwatch.ts). The self-heal's enrollment is the
    // one place a push baseline could silently come from the coin's CURRENT
    // mcap instead of the push-time value, so "how many heals, and how many of
    // them found a ledger entry" is the runtime proof of that fix; each pass
    // also leaves a durable audit entry (/debug/push-audit).
    heal: pushWatchHealStats(),
    // DexScreener rate-limit watch for the 250ms dispatch spacing: the live
    // client stats (intervalMs / http429 / blockedForMs / cacheSize) plus the
    // fleet-wide 429-episode total mirrored in Turso by db.bumpDex429. Written
    // every tick with the claim, so /health.heartbeat always carries it —
    // `blockedForMs > 0` is the "we are being limited right now" signal and
    // a rising dex429Total is the "250ms is too fast, restore 350" signal.
    // The completed-scan copy rides the summary (scanner publishes the same
    // getStats object), so a 429 is visible whichever heartbeat is freshest.
    dex: dex?.getStats() ?? null,
    dex429Total,
    dex429At,
    // Fleet-wide deferral counters (see persistPushDeferralDelta): the
    // in-memory summary below is only THIS isolate's, so /health gets the
    // durable copy here — `deferredTotal`/`recoveredTotal` rising and
    // `    firstRecoveredAt` being stamped ARE the "a deferred coin really is
    // pushed back later" proof, and the event ring is its rate (see the init
    // load in ensureInitialized).
    deferral: pushDeferralSnapshot,
    // Push-baseline ledger view (src/pushledger.ts): the true push mcap per
    // token, the band in force, which pushes landed outside it, and which
    // rows' baselines were rewritten afterwards (heal / resurrection). The
    // pre-race copy is the freshest one published every tick, so /health
    // always carries it.
    pushLedger: pushLedgerMirror,
    // Fleet-wide per-trigger scan counts (see Db.scanTriggerStatements), as of
    // this invocation's front read. The completion batch increments them, so
    // this value is one completed scan behind — the same lag the deferral
    // snapshot above documents.
    scanTriggers: scanTriggerMirror,
  });
  preTick.steps.json = Date.now() - heartbeatAt;
  if (db) {
    const claimAt = Date.now();
    // The tick's ADMISSION stamp rides the claim (2026-09-26): the ladder's
    // first stamp was a request of its own, and its reading — admitted, the
    // scan not yet entered — is what this batch already writes (the heartbeat
    // above carries the same `at` and phase). Measured live: the ladder cost
    // FIVE requests per tick (the census's largest DB item) and this is the
    // one that was free. `preRaceMs: 0` is honest — the pre-race split is
    // computed after the claim returns, so it did not exist at stamp time
    // (the note renders a 0 as `preRace n/a`).
    const admissionRecord = tickProgressRecord({
      at: startedAt,
      stage: "scan",
      payloadBytes: 0,
      scanMs: 0,
      preRaceMs: 0,
      // The pre-race phase is still RUNNING here (this stamp rides the claim),
      // so the split is the handler half alone: `preStart` with `init` named.
      // That is the reading a stretch needs for a tick killed between the claim
      // and the race, whose only durable stamp is this one.
      front: preStartSplitNote(preTickEntryAt, startedAt, preTick.steps),
      subreqs: subreqView().current.total,
      cut: false,
      err: null,
    });
    try {
      scanLock = await db.claimScanLock(
        SCAN_LOCK_OWNER,
        startedAt,
        SCAN_LOCK_TTL_MS,
        heartbeatJson,
        backfillEntry,
        cronTick ?? null,
        admissionRecord,
      );
    } catch (err) {
      claimErrored = true;
      console.error(
        "[worker] scan-lock claim failed — scanning anyway:",
        err instanceof Error ? err.message : err,
      );
    }
    preTick.steps.claim = Date.now() - claimAt;
  }
  if (scanLock === null && !claimErrored) {
    // Another isolate won the lease (its heartbeat write went out with the
    // claim, so liveness is covered) — skip this tick.
    crossIsolateScanSkips++;
    // The lease loss itself is neutral, but a dead predecessor seen on the
    // losing path still counts toward the streak: the current live pattern
    // (2026-09-08 18:28Z+) is a poisoned isolate that wins the claim INSERT
    // in its own isolate but whose flush never lands — every OTHER isolate
    // then sees a dead heartbeat every tick. If only the backfill path
    // counted, the winner's streak would climb while the losers stay at 0
    // and the breaker never fires on the isolate that needs rebuilding.
    // Losing isolates that see NO dead predecessor remain fully neutral.
    if (dead) {
      deadTickStreak++;
      console.warn(
        `[worker] lease lost AND predecessor tick died — dead-tick streak ${deadTickStreak}`,
      );
    }
    console.log("[worker] scan skipped — another isolate holds the scan lock");
    // The counter above is module state on THIS isolate and is only published by
    // whichever invocation happens to serve /health; the reason rides the
    // durable row with every other one (2026-09-27).
    noteSkipReason("scan-lock-lost");
    // The claim never carried the cron-arrival bookkeeping, so write it here:
    // this tick DID arrive (that is what the counter records), it simply lost
    // the lease to another isolate's scan. ONE write, no read — the handler
    // already holds the ring.
    if (cronTick) {
      try {
        await db?.writeScheduledTick(cronTick);
      } catch {
        /* cron bookkeeping is best-effort — never blocks the tick */
      }
    }
    // This tick never reaches the finally below, so the leash opened at
    // startedAt has to be closed here instead of leaking past it.
    db?.exitScanMode();
    return;
  }
  if (claimErrored) {
    // Fail-open path: the batched claim+heartbeat never ran, so restore
    // the pre-lock standalone liveness write before scanning unlocked.
    try {
      await db?.setWorkerState("scan_heartbeat", heartbeatJson);
    } catch (err) {
      console.error("[worker] start heartbeat write failed:", err);
    }
    // The claim batch never ran, so it cannot have carried the cron-arrival
    // bookkeeping either — write it on its own (ONE write, no read).
    if (cronTick) {
      try {
        await db?.writeScheduledTick(cronTick);
      } catch (err) {
        console.error("[worker] cron bookkeeping write failed:", err);
      }
    }
  }
  if (scanLock !== null && backfillEntry) {
    // The backfill row rode the winning claim batch — already in
    // scan_history. Telemetry + log only, never on the flush path.
    backfilledTicks++;
    console.log(
      `[worker] backfilled dead tick at ${new Date(backfillEntry.at).toISOString()} (lived ${backfillEntry.ms}ms, flush lost)`,
    );
  }
  // Non-critical telemetry is deliberately not on the pre-race path. The
  // claim/heartbeat is the only must-land write before scanning; ledger and
  // skip-capture reconciliation run after the completion flush below, so a
  // slow Turso read cannot steal the deferred-card/gate window.
  // Wedged-isolate circuit breaker: track consecutive dead ticks. The
  // predecessor's death counts toward the streak (this isolate is the one
  // that keeps seeing deaths — if the deaths are its own doing, the streak
  // climbs), and our own flush landing resets it below. See
  // DEAD_TICK_STREAK_RESET for the rationale.
  if (backfillEntry) deadTickStreak++;
  let rebuilt = false;
  let timedOut = false;
  // The err clause naming the scan's in-flight stage at the instant the race
  // tripped (see Scanner.stageSnapshot), or "" when there was nothing to
  // name. Composed INSIDE the timeout callback, never read when the err below
  // is: the cooperative abort lets the scan cross one more phase boundary
  // before this tick resumes, and the clause must name the stage the CUT
  // found, not the one the scan moved into after it.
  let cutStageNote = "";
  // Whether OUR completion batch settled (success or fast error). Set
  // in the inner finally, read in the outer finally for streak
  // bookkeeping: a settled flush is the isolate-liveness proof the old
  // heartbeat re-read approximated one DB round trip later.
  let flushSettled = false;
  try {
    // Liveness-first heartbeat (phase=scanning) already went out with the
    // claim batch: a tick killed by the ~30s wall clock mid-scan can no
    // longer freeze the heartbeat (the 2026-09-03 outage alerts — cron
    // delivered every minute but the completion write in the tail kept
    // losing the race). The cadence gate sees a fresh `at`, so the
    // effective scan rate returns to the configured 60s and the alert only
    // fires when ticks genuinely stop.
    // ── the phase ladder, hoisted out of the inner try (see
    // tickPhaseLadder) ───────────────────────────────────────────────
    // The tick's durable whereabouts, queued and never awaited. Declared
    // HERE, outside the inner try, because the pre-flush record that rides
    // this queue is written in that try's `finally` block — which cannot see
    // a binding declared in the try's body (tsc caught exactly that).
    const ladder = tickPhaseLadder((json) => {
      const client = db;
      if (!client) return Promise.resolve();
      try {
        const write = client.setWorkerState(TICK_PROGRESS_KEY, json);
        // Swallowed at the source: an unhandled rejection can take the
        // isolate down with it, and a phase stamp is the least important
        // thing the invocation does.
        write.catch(() => {});
        return write;
      } catch {
        return Promise.resolve();
      }
    });
    try {
      // Race the scan against the tick budget. runOnce never rejects (it
      // catches its own errors), so the first to settle wins; on timeout
      // the abort above stops the scan at its next phase boundary and the
      // seq guard in Scanner keeps a straggler from clobbering a newer
      // tick's state.
      // Dead-tick fix 2026-09-13 (adaptive budget): the race used to be
      // SCAN_TICK_BUDGET_MS from ITS OWN start, but the tick already spent
      // ~1-4s on the pre-race phase (counter read+write, claim/heartbeat
      // round trip, outage check). On a slow pre-race the envelope grew
      // silently — race end at startedAt+budget+preRaceMs, flush after —
      // and crossed Cloudflare's fluctuating ~20s kill, killing the tick
      // before its completion flush ("died before its completion flush",
      // clustered on ticks whose claim round trip ran long). The budget is
      // now measured from the tick's startedAt, so the flush ALWAYS starts
      // inside the same wall-clock window no matter how slow the pre-race
      // phase was. The constant's floor still applies to ticks with a fast
      // pre-race (the common case).
      // The race ends EARLY, leaving SCAN_FLUSH_RESERVE_MS for the
      // completion flush below: the tick envelope is then
      // preRace + scanRace + flush <= SCAN_TICK_BUDGET_MS no matter how slow
      // the pre-race phase was, so there is always time left to land the
      // flush before Cloudflare kills the invocation.
      const grantedRaceMs = scanRaceWindowMs(Date.now() - startedAt);
      // A window the scan cannot reach its pair phase in is SHED, not granted
      // (2026-09-28): the tick keeps its completion flush — the mandatory half,
      // and the only thing the no-completion alert reads — and gives up a scan
      // that could only land `profiles 0`. Zeroing the window reuses the
      // documented `scanRaceMs === 0` branch below, and the reason is recorded
      // so the shed shows up in the skip counters instead of reading as a cut.
      const raceShedReason = scanRaceShedReason(grantedRaceMs);
      if (raceShedReason) noteSkipReason(raceShedReason);
      const scanRaceMs = raceShedReason ? 0 : grantedRaceMs;
      // Publish the split BEFORE the race runs: a tick the race cuts must
      // still say how much of its window the pre-race phase took (see
      // PreTickView — this is the number the race arithmetic uses).
      preTick = buildPreTickSplit({
        entryAt: preTickEntryAt,
        steps: preTick.steps,
        startedAt,
        raceAt: Date.now(),
        raceMs: scanRaceMs,
      });
      // The phases INSIDE the scan are stamped through the scanner's hook
      // below — without it the row would stop at the admission stamp, which
      // is where four of four captured deaths stopped. The ADMISSION stamp
      // itself no longer queues here (2026-09-26): it rides the claim batch
      // above, so the ladder's own writes start with the scan's first phase
      // (or with the postscan record on a tick whose scan never stamped).
      const notePhase = (phase: string) =>
        void ladder.stamp({
          at: startedAt,
          stage: phase,
          payloadBytes: 0,
          scanMs: 0,
          preRaceMs: preTick?.preRaceMs ?? 0,
          front: frontSplitNote(preTick),
          subreqs: subreqView().current.total,
          cut: false,
          err: null,
        });
      if (scanner) scanner.onTickPhase = notePhase;
      // Wired only for the duration of the scan: the hook is unwired after
      // the race, so the tail (the tracker pass) cannot stamp a phase the
      // scan never had.
      // ONE capture for both halves: the call and the slice probe below must be
      // the same scanner, and TS cannot keep this call site's narrowing inside
      // a closure that outlives it (a null scanner is unreachable here — the
      // tick's own guard returned before this point).
      const scanOwner = scanner;
      await Promise.race([
        // The scan is handed the invocation's remaining allowance so its
        // OPTIONAL legs can yield before they starve the tail (see
        // SCAN_SUBREQ_FLOOR): the tracker pass runs after this scan and is
        // the residual claimant of the same 50.
        // The scan's counter carries the tracker pass's slice (see
        // TRACKER_PASS_SUBREQ_RESERVE): optional legs stand down while the
        // pass's tail is intact, instead of the scan spending it and the pass
        // deferring by name.
        //
        // ...AND THE SLICE IS CONDITIONAL (2026-09-27): when the pass's own
        // cron delivery already owns this minute, the tick's pass stage stands
        // down (see Scanner.runTrackerPass) and there is nothing left to hold
        // back — so the slice goes to the scan, whose optional legs then stand
        // down at the invocation's real floor instead of ~12 early. The
        // question is asked AT THE LAST MOMENT a pass could start
        // (`startedAt + SCAN_TICK_BUDGET_MS`, the tick's whole envelope), and
        // it reads the same front row and the same window the pass stage reads:
        // a row that will still be inside the window then is one the pass stage
        // is bound to stand down for, which is what keeps the two decisions from
        // disagreeing about a row that crosses the window in between.
        scanOwner.runOnce(() =>
          scanSubreqLeft(
            subreqRemaining(),
            scanOwner.trackerPassSlice(
              TRACKER_PASS_FALLBACK_FRESH_MS,
              TRACKER_PASS_SUBREQ_RESERVE,
              startedAt + SCAN_TICK_BUDGET_MS,
            ),
          ),
        ),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            // Snapshot BEFORE the abort: see cutStageNote — the reading is the
            // stage in flight at the cut, and abort() only marks the scan to
            // stop at its next boundary, so this is the last moment the pair
            // still describes the hold the race tripped on.
            const cut = scanner?.stageSnapshot() ?? null;
            cutStageNote = cut
              ? `, cut in the ${cut.stage} stage (${cut.ms}ms in)`
              : "";
            // Cooperative stop: tell runOnce its budget is up so the
            // background scan returns at its next phase boundary instead of
            // grinding on until Cloudflare kills the isolate — the zombie
            // tail kept issuing upstream requests alongside the completion
            // flush below (burning quota) and lengthened the window in
            // which a slow flush round trip could lose to the wall-clock
            // kill (the recurring 5-20 min zero-row holes).
            scanner?.abort();
            resolve();
          }, scanRaceMs);
        }),
      ]);
      // The scan is over: unwire the phase hook, so the tick's tail (the
      // tracker pass) cannot stamp a phase the scan never had. The pre-flush
      // record below takes over from here (see TICK_PROGRESS_KEY).
      if (scanner) scanner.onTickPhase = null;
      lastScanOk = !timedOut;
      // Report the SCAN RACE window, not the whole tick budget: the race now
      // ends SCAN_FLUSH_RESERVE_MS early, so quoting the budget sent the
      // operator chasing a 9.5s timeout on ticks that were cut at ~6s.
      // The pre-race split rides along because THIS row is the one a reader
      // chases, and without it the lost window can only be reconstructed by
      // subtraction (budget - reserve - window). Naming both halves also
      // separates a CPU-heavy payload from a slow claim round trip, which
      // have different fixes.
      // The stage the race cut rides the err (see cutStageNote /
      // Scanner.stageSnapshot) — the one reading no other telemetry carries,
      // because a cut tick flushes before the scanner publishes anything, and
      // CF analytics only ever proved the invocation stayed alive. It is the
      // SAME err string the completion flush persists into scan_history, so
      // the row an operator opens names what held the scan (and for how long),
      // not just that it was held. Deliberately absent on the shed path: a
      // shed tick refused the window up front and never entered a stage — its
      // own message already names the front as the reason.
      lastScanError = timedOut
        ? raceShedReason
          ? `scan shed: the front left a ${grantedRaceMs}ms window, under the ${SCAN_RACE_MIN_USEFUL_MS}ms floor it takes to reach the pair phase (tick budget ${SCAN_TICK_BUDGET_MS}ms, flush reserve ${SCAN_FLUSH_RESERVE_MS}ms, ${frontSplitNote(preTick)})`
          : `scan exceeded its ${scanRaceMs}ms race window (tick budget ${SCAN_TICK_BUDGET_MS}ms, flush reserve ${SCAN_FLUSH_RESERVE_MS}ms, ${frontSplitNote(preTick)})${cutStageNote}`
        : null;
      if (timedOut) {
        console.error(
          raceShedReason
            ? `[worker] scan shed: only ${grantedRaceMs}ms of race window is under the ${SCAN_RACE_MIN_USEFUL_MS}ms floor — completion written without scanning`
            : `[worker] scan ran past its ${scanRaceMs}ms race window — completion written with timeout flag`,
        );
      }
    } catch (err) {
      lastScanOk = false;
      lastScanError = err instanceof Error ? err.message : String(err);
      console.error("[worker] scheduled scan failed:", lastScanError);
    } finally {
      // Ends the pre-race leash: the completion flush below keeps the default
      // window on purpose (see DB_REQUEST_TIMEOUT_MS / Db.enterScanMode).
      db?.exitScanMode();
      lastScanMs = Date.now() - startedAt;
      lastScanAt = Date.now();
      scanCount++;
      const summary = scanner?.lastSummary ?? null;
      // Completion flush, ONE batched round trip (heartbeat phase=done +
      // history row + scan-lock release) in the same tick — the lock is
      // freed here so the guard adds NO extra end-of-tick write. Pre-race
      // work is lean — batched scheduled counter, no redundant reads — so
      // the 15s race + this write fits inside the effective wall envelope.
      // If a rare Turso spike still kills it, the start heartbeat already
      // proved liveness, only this row is lost, and the lock self-heals
      // via its TTL + stale takeover on the next tick.
      // Flush = ONE batched round trip (heartbeat phase=done + history row +
      // lock release). Two failure shapes, two remedies:
      //   - settled failure (fast Turso 4xx/5xx): ONE sequential retry after
      //     a 300ms backoff.
      //   - HANGING write (observed live post-13s-deploy 2026-09-07: 4 dead
      //     ticks in 6 while claims landed every minute — the libsql client
      //     internally retries quota/5xx errors, so the flush promise never
      //     settles and a sequential retry never fires before the kill):
      //     if the first attempt hasn't settled within 2.5s, fire a
      //     CONCURRENT retry and await it. Safe: the batch is idempotent
      //     (it deletes its own `at` history row before inserting), so a
      //     first attempt that commits late can never produce a duplicate.
      // Narrowed snapshots: the module-level lets are `number | null`, and
      // TS does not carry the assignment narrowing from the enclosing block
      // into the closure below — copy them into consts first.
      const flushedAt: number = lastScanAt;
      const flushedMs: number = lastScanMs;
      // Captured early-return reason for the tick this flush reports (see
      // src/skipcapture.ts). Read ONCE, outside the closure, so `skip` and
      // `skipAt` can never disagree about which early return they describe.
      const skipView = skipCaptureSnapshot();
      // PER-TICK LEG RING (see TickLegRow): recorded BEFORE the flush, so a
      // slow or lost completion write cannot take this tick's split with it —
      // the ring is the one place the wall-time breakdown survives without
      // paying a round trip. Recorded for EVERY tick, cut/shed/early-return
      // included: those are exactly the shapes that produced no summary, and
      // the question "which leg held it" is asked about them the most.
      const legRow = buildTickLegRow({
        at: flushedAt,
        via: scanVia,
        ok: lastScanOk,
        ms: flushedMs,
        err: lastScanError,
        cut: timedOut,
        cutNote: cutStageNote || null,
        preTick,
        subs: subreqView().current.total,
        summary,
        skip: skipView?.reason ?? null,
      });
      recordTickLeg(legRow);
      // The durable half (see TICK_LEG_SLOW_KEY): the in-memory ring lives in
      // the isolate that TICKED, which is not the one HTTP reads reach — so a
      // slow tick also lands in worker_state. Fired, never awaited; the
      // invocation's tickWaitUntil keeps it open when the handler handed one
      // over (the same discipline as the deferred-write drain).
      if (slowTickLegDue(legRow.ms)) {
        const sink = persistSlowTickLeg(legRow);
        if (tickWaitUntil) {
          try {
            tickWaitUntil(sink);
          } catch {
            void sink;
          }
        } else {
          void sink;
        }
      }
      // The completion payload is built ONCE, here, and its byte size is
      // measured in front of the flush: a LOST flush is chased with the two
      // numbers only this tick can see — how big the batch was and what the
      // invocation had left to spend (see TICK_PROGRESS_KEY). The retry below
      // re-uses the same string instead of re-serializing ~9.5KB.
      const buildFlushPayload = () =>
        JSON.stringify({
            at: flushedAt,
            // Who ran this scan (see runScan's `via`) — the done heartbeat is
            // what /health serves between ticks, so the attribution rides it
            // too, not only the scanning row.
            via: scanVia,
            // WHERE the invocation actually ran (see probeCronColo): the
            // scheduled event carries no request, so this is the only place
            // the region question can be answered from. Null = the probe had
            // not settled by the flush, or answered nothing — never a guess.
            colo: cronColo === "pending" ? null : cronColo,
            // WHICH PATH RAN THIS TICK (see the relay block at the bottom):
            // "inner" = the placed fetch invocation a cron relay drove;
            // "failed"/"skipped" = the cron ran the tick in its OWN region
            // because the relay could not (or was not configured to) — the
            // pre-relay shape. Null = an HTTP/manual scan. Read together with
            // `colo` above: a relayed tick is "inner" + NRT, a fallen-back one
            // "failed" + ORD.
            relay: relayTag,
            ok: lastScanOk,
            phase: "done",
            count: scanCount,
            ms: flushedMs,
            err: lastScanError,
            // The scanner's own reason for returning early, captured because
            // it nulls the field in this same tick (src/skipcapture.ts):
            // `skipAt >= flushedAt` = the tick reported here returned early,
            // `skipAt < flushedAt` = it ran a real scan and this is older.
            skip: skipView?.reason ?? null,
            skipAt: skipView?.at ?? null,
            // Fleet-wide early-return counters (durable row).
            skipCapture: skipCaptureMirror,
            // The invocation's subrequest reading (see src/subreqs.ts):
            // `current` is this tick's spend with the phase ring that says
            // WHERE it went, and `recent` is the window before it — which
            // is how a tick that died on the budget is read, since a killed
            // invocation never gets to publish anything itself.
            subreqs: subreqView(),
            // The idle-tick signature: green, but nothing was evaluated
            // because BOTH the profile feed and the re-eval pool read came
            // back empty. Kept ALONGSIDE `skip` because they answer different
            // questions: `idle` is the shape (this tick evaluated nothing),
            // while `skip` is the scanner's stated reason. An idle tick with
            // `skip: null` is the one that matters most — the sweep died
            // without stating a reason rather than being told to return
            // (2026-09-19: the pool read overran POOL_FETCH_BUDGET_MS on most
            // ticks and the whole sweep silently stopped for 10-minute
            // stretches while every heartbeat read ok:true).
            idle:
              lastScanOk && summary
                ? summary.profiles === 0 && summary.pool === 0
                : null,
            // Last-good pool fallbacks in this isolate's lifetime
            // (src/poolfallback.ts): a non-zero count means the re-eval pool
            // read failed and the tick re-swept an older slice instead of
            // evaluating nothing.
            poolFallback: poolFallbackStats(),
            // The durable deferral counters as of the LAST confirmed write
            // (persistPushDeferralDelta runs after this flush, and the next
            // tick's `phase: scanning` heartbeat publishes the fresh copy).
            deferral: pushDeferralSnapshot,
            pushLedger: pushLedgerMirror,
            // See the scanning heartbeat above: the counts lag one completed
            // scan behind the row this very flush is about to write.
            scanTriggers: scanTriggerMirror,
            summary,
          });
      const flushJson = buildFlushPayload();
      // PRE-FLUSH PROGRESS RECORD (see TICK_PROGRESS_KEY). The scan is over:
      // this is the last point at which the tick can say, durably, that it got
      // this far. Awaited while the tick still has TICK_PROGRESS_AWAIT_
      // RESERVE_MS of its budget left (so the evidence is in Turso BEFORE the
      // flush it describes), fired and NOT awaited below that, bounded when it
      // is awaited, and never allowed to reject: a lost record is not a lost
      // tick, a delayed flush is.
      // The pre-flush record rides the phase ladder's queue: the row must end
      // with THIS stamp, not with a phase stamp that overtook it (see
      // tickPhaseLadder). Awaited only by the caller below, and only while the
      // tick can still afford it.
      const noteProgress = (stage: string, why?: string | null) =>
        ladder.stamp({
          at: startedAt,
          stage,
          payloadBytes: flushJson.length,
          scanMs: flushedMs,
          preRaceMs: preTick?.preRaceMs ?? 0,
          front: frontSplitNote(preTick),
          subreqs: subreqView().current.total,
          cut: timedOut,
          err: why ?? lastScanError,
        });
      {
        const late =
          startedAt + SCAN_TICK_BUDGET_MS - Date.now() <
          TICK_PROGRESS_AWAIT_RESERVE_MS;
        const stamp = noteProgress(late ? "postscan-late" : "postscan");
        if (stamp && !late) {
          try {
            await Promise.race([
              stamp,
              new Promise((resolve) =>
                setTimeout(resolve, TICK_PROGRESS_BOUND_MS),
              ),
            ]);
          } catch {
            /* the flush below outranks this record */
          }
        }
      }
      const flushCompletion = () =>
        db?.persistScanCompletion(
          flushJson,
          {
            at: flushedAt,
            ok: lastScanOk,
            ms: flushedMs,
            err: lastScanError,
            profiles: summary?.profiles ?? null,
            pool: summary?.pool ?? null,
            candidates: summary?.candidates ?? null,
            pushed: summary?.pushed ?? null,
          },
          scanLock,
          // Durable attribution: the counter increments in the SAME batch (zero
          // extra round trips) and is published by the next invocation's front
          // read — so "cron vs fallback" survives this isolate and never
          // depends on module state (see runScan's `via`).
          scanVia,
        ) ?? Promise.resolve();
      const flushStartedAt = Date.now();
      // Every await on the flush path is bounded by what is LEFT of the
      // reserve (never by a fixed 2.5s that could overrun it): the tick can
      // no longer spend its last seconds inside an abandoned retry while
      // Cloudflare kills the invocation just before the batch commits.
      const flushDeadline = flushStartedAt + SCAN_FLUSH_RESERVE_MS;
      // The 250ms floor keeps a last-gasp attempt alive long enough to be
      // useful, but every step re-reads the deadline and the retries below
      // are skipped outright once it has passed — so stacked attempts can
      // never walk the tick past the reserve into the kill window.
      const remainingFlushMs = () =>
        Math.max(250, flushDeadline - Date.now());
      let settled = false;
      const attempt1 = flushCompletion();
      const mark = attempt1.then(
        () => {
          settled = true;
          flushSettled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await Promise.race([
          mark,
          new Promise((resolve) =>
            setTimeout(resolve, Math.min(FLUSH_ATTEMPT_BOUND_MS, remainingFlushMs())),
          ),
        ]);
        if (!settled && Date.now() < flushDeadline) {
          // The tick is being lost to a write that does not settle. Stamp
          // WHICH attempt and what the invocation had already spent: the
          // subrequest ceiling is the standing suspect (the counter cannot see
          // ~12 of them, see src/subreqs.ts) and only this tick can measure it.
          noteProgress(
            "flush-hung",
            `attempt1 unsettled after ${Date.now() - flushStartedAt}ms`,
          );
          console.error(
            "[worker] completion write hung — firing racing retry",
          );
          // The racing retry is bounded by the reserve too. It is awaited
          // only through the race; its own settlement still records the
          // flush proof when it lands in time (the batch is idempotent).
          const racing = flushCompletion();
          racing.then(
            () => {
              flushSettled = true;
            },
            () => {},
          );
          await Promise.race([
            racing.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, remainingFlushMs())),
          ]);
        } else {
          // Success resolves here; a settled rejection throws into the
          // catch below for the backoff retry.
          await attempt1;
        }
      } catch (err) {
        // THE ONE READING THIS WHOLE PATCH EXISTS FOR: until now a lost
        // completion write left no reason anywhere — the flush's error was
        // logged and dropped, so the successor could only say "it died". The
        // record carries the refusal itself (a settled 4xx/5xx, a transport
        // hard wall, or the runtime's `Too many subrequests`).
        noteProgress(
          "flush-failed",
          err instanceof Error ? err.message : String(err),
        );
        console.error("[worker] completion write failed — retrying once:", err);
        if (Date.now() >= flushDeadline) {
          console.error(
            "[worker] flush reserve exhausted — leaving the row to the next tick's backfill",
          );
        } else {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(300, remainingFlushMs() / 2)),
        );
        try {
          // Bound the retry by the reserve: the hard-wall error arrives
          // only after DB_REQUEST_TIMEOUT_MS*1.2, which alone can outlive
          // the flush window. The idempotent batch makes a late commit
          // from the abandoned retry harmless. A retry that lands inside
          // the bound IS the flush proof (it clears the dead-tick streak).
          const retry = flushCompletion();
          retry.then(
            () => {
              flushSettled = true;
            },
            () => {},
          );
          await Promise.race([
            retry,
            new Promise((resolve) => setTimeout(resolve, remainingFlushMs())),
          ]);
        } catch (err2) {
          noteProgress(
            "flush-retry-failed",
            err2 instanceof Error ? err2.message : String(err2),
          );
          console.error("[worker] completion retry failed:", err2);
        }
        }
      }
      // Post-push tracker pass — the tick's FIRST tail work, funded by the
      // budget the scan left over (see TRACKER_PASS_BUDGET_MS). It runs after
      // the completion flush on purpose (the flush is the one write a tick
      // cannot lose, and the pass bounds every stage of its own) and BEFORE
      // the deferral-counter sync, which is why it moved: the sync is bounded
      // at DEFERRAL_SYNC_BOUND_MS (1s) and can spend up to that whole second
      // starting late, and a pass that starts a second later is a pass that
      // ends past the invocation's wall clock — measured live 2026-09-21
      // 03:4xZ: with the sync in front, the pass completed on roughly half
      // the ticks (the row writes proved the pass ran; no note was persisted,
      // because the persist is its last step). Everything the sync can lose
      // is its own telemetry and is re-offered next tick (see its comment
      // below), while a pass that does not finish costs the rotation a whole
      // tick. Best-effort either way: its note is persisted by the pass itself
      // and carried in the next heartbeat's summary.
      const trackerBudgetMs = Math.min(
        TRACKER_PASS_BUDGET_MS,
        startedAt + SCAN_TICK_BUDGET_MS - TRACKER_PASS_TAIL_MS - Date.now(),
      );
      if (scanner && trackerBudgetMs > 0) {
        try {
          // Hold the pass's cut-card proofs for this tick (see
          // pushwatch.holdForTick): the audit entry a CUT send produces is an
          // un-awaited promise at the pass's tail, and an un-awaited promise is
          // cancelled the instant this handler returns — which is why the proof
          // never landed and `dup-skip` never fired (live 2026-09-23: 12 `p:`
          // marks, 0 with a proof). Nothing about the pass's decisions changes;
          // only its bookkeeping is kept alive.
          const holdTick = tickWaitUntil;
          // WHAT THIS PASS COSTS, measured rather than assumed (see
          // tickprobe.noteTrackerPassSpend): the write drain ahead of this
          // stage yields a reserve, and a FLAT one yielded more than the pass
          // needed on every tick of 2026-09-28 — live 00:02-00:28Z the queue
          // went 305 -> 2098 owed records with `calls 0`. ONLY this call site
          // reports: the pass's own cron delivery owns its whole subrequest
          // window, so its spend there is not the shape the reserve is for.
          const passSubreqBefore = subreqRemaining();
          await scanner.runTrackerPass(
            Date.now() + trackerBudgetMs,
            holdTick ? (p: Promise<unknown>) => holdTick(p) : undefined,
            // The invocation's OTHER ceiling (see src/subreqs.ts). The pass
            // runs last, so it is the residual claimant: measured on a cold
            // isolate the front (init + scan + completion flush) had already
            // spent 47 of the 50 Workers Free allows, and the pass's first
            // Turso call is what the runtime then refused — killing the row loop
            // and the deferral sync and write drain behind it. Handing the
            // counter in lets the pass defer by name instead, and keeps its
            // own reserve for those tail writes.
            subreqRemaining,
            // FALLBACK ONLY (see TRACKER_CRON and runTrackerInvocation): this
            // tick runs a pass of its own only when the pass's OWN delivery has
            // not written the durable row inside this window. In the healthy
            // shape that row is seconds old here, so the pass stands down and
            // the tick keeps every subrequest it has for the scan — and if the
            // second cron expression ever stops being delivered, this same call
            // takes the rotation over within two minutes, so the cards never
            // depend on the new trigger.
            {
              peerPassFreshMs: TRACKER_PASS_FALLBACK_FRESH_MS,
              via: "tick",
              // The tick's own region reading rides its fallback pass too, so
              // the row says where the pass ran whichever owner served it.
              relay: relayTag ?? undefined,
            },
          );
          noteTrackerPassSpend(passSubreqBefore - subreqRemaining());
          // The pass returned: its rotation ran, so the last failure is history.
          trackerPassFailure = null;
        } catch (err) {
          // A pass can also be killed mid-flight (no catch ever runs), which is
          // why the pulse below rides EVERY heartbeat: it carries the stage and
          // the counters of whatever the last attempt managed to do.
          const message = err instanceof Error ? err.message : String(err);
          trackerPassFailure = {
            at: Date.now(),
            message: message.slice(0, 200),
            live: trackerPassPulse(),
          };
          console.error("[worker] tracker pass failed:", message);
        }
      } else if (scanner) {
        // No room for a pass this tick (a cut tick spends its whole envelope
        // in the scan and the flush), so the pass never starts and its durable
        // coverage line would simply stop moving — the 2026-09-23 02:37-02:41Z
        // shape: five consecutive cut ticks, note frozen at 02:36:26Z, which
        // /health cannot tell from a lost write. A skipped tick IS a reading,
        // so publish it as one: the same bounded, awaited worker_state write
        // every other tick-tail telemetry uses, and the row then says which
        // kind of tick it was instead of going quiet.
        try {
          await scanner.noteTrackerSkipped(
            `tick ${lastScanMs}ms${timedOut ? " timed-out" : " no-budget"}`,
          );
        } catch (err) {
          console.error(
            "[worker] tracker skip note failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      // Cross-isolate deferral counters, synced only after the completion
      // flush AND the tracker pass have had their turn (see
      // syncPushDeferralCounters). It is awaited
      // so the isolate cannot be recycled mid-write, but everything it can
      // lose is its own telemetry: both Db calls carry the standard hard
      // wall, the delta is re-offered next tick if the write failed, and the
      // row's applied marker keeps that re-offer from double-counting a
      // write that actually landed.
      try {
        // Bounded like every other await on this tail (see
        // DEFERRAL_SYNC_BOUND_MS): a hung Turso read must not walk the
        // invocation past the wall clock and cost the outer finally its
        // bookkeeping. A bounded-away sync is re-offered next tick, and its
        // promise is left running (an idempotent write is welcome to land
        // late — the next tick's read mirrors it).
        await Promise.race([
          syncPushDeferralCounters(summary),
          new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.max(
                250, // last-gasp floor: a write that lands late is idempotent
                Math.min(
                  DEFERRAL_SYNC_BOUND_MS,
                  remainingFlushMs(),
                  // The tracker pass ran first, so what is left for the sync
                  // is the tick's tail, not the flush reserve.
                  startedAt + SCAN_TICK_BUDGET_MS - TRACKER_PASS_TAIL_MS - Date.now(),
                ),
              ),
            ),
          ),
        ]);
      } catch (err) {
        console.error(
          "[worker] deferral counter sync failed:",
          err instanceof Error ? err.message : err,
        );
      }

    }
  } finally {
    // Streak bookkeeping AFTER the flush attempt. The old check re-read
    // scan_heartbeat from the DB and reset the streak on phase=done, but
    // (a) that read is an extra unraced await on the wall-clock-critical
    // tail, and (b) it can credit ANOTHER isolate's done heartbeat: the
    // 2026-09-13 live pattern had reads landing every tick while this
    // isolate's flushes hung, so the streak stayed pinned at 0 and the
    // wedged-isolate rebuild never fired for hours. Reset on OUR OWN
    // flush settling instead (the heartbeat+row batch landing here IS
    // the phase=done proof); count our own failure/hang as a dead tick
    // (matching the next tick's backfill of our dead heartbeat).
    if (flushSettled) {
      deadTickStreak = 0;
    } else {
      deadTickStreak++;
    }
    if (deadTickStreak >= DEAD_TICK_STREAK_RESET && scanner) {
      // This isolate has now seen DEAD_TICK_STREAK_RESET consecutive dead
      // ticks (its own deaths or its backfills of the same wedged
      // predecessor). Its module-scoped clients are the prime suspect: a
      // hung upstream fetch promise or a libsql client stuck in an internal
      // retry loop never settles, so the 12s race resolves but the scan
      // promise (and any write sharing the connection) never does. Drop the
      // clients + scanner + webhook so ensureInitialized rebuilds them from
      // scratch on the next tick — fresh fetch connections and a fresh
      // libsql client. initPromise=null makes the rebuild happen even on a
      // warm isolate (it normally early-returns). bot survives: the webhook
      // is re-created alongside it.
      console.error(
        `[worker] ${deadTickStreak} consecutive dead ticks — rebuilding module state (fresh clients + connections)`,
      );
      dex = null;
      helius = null;
      birdeye = null;
      gmgn = null;
      axiom = null;
      arkham = null;
      crimeWallets = null;
      walletAnalyzer = null;
      flurryAnalyzer = null;
      scanner = null;
      scannerReady = false;
      initPromise = null;
      deadTickStreak = 0;
      wedgedStateResets++;
      rebuilt = true;
      // The rebuilt Scanner restarts its counters at zero, so a surviving
      // baseline would make every later increment look "already written"
      // (delta <= 0) and silently drop it.
      pushDeferralBaseline = { deferred: 0, recovered: 0, pruned: 0 };
    }
    // Only rebuild when the tick still has room: re-init costs DB round
    // trips, and spending them here would eat the very margin that lets the
    // next tick's flush land (the failure this guard exists to prevent).
    // When it is too late, defer: initPromise stays null and the next tick's
    // ensureInitialized (called by the handler before runScan) rebuilds.
    if (rebuilt && Date.now() - startedAt < SCAN_TICK_BUDGET_MS) {
      // Rebuild synchronously so the NEXT request (likely the UptimeRobot
      // /health poll seconds later) finds a ready scanner instead of paying
      // the init cost inside its own wall-clock window.
      try {
        await ensureInitialized(envRef!);
      } catch (err) {
        console.error(
          "[worker] post-reset re-init failed (next tick retries):",
          err instanceof Error ? err.message : err,
        );
      }
    } else if (rebuilt) {
      console.warn(
        "[worker] module state rebuilt after the tick budget — deferring re-init to the next tick",
      );
    }
    // Safety net only: normally the completion batch already released the
    // lock (exact-value DELETE). This runs when the flush itself threw
    // (DB down) — the DELETE is then a no-op if the batch still went out,
    // and a best-effort release otherwise; a surviving lock expires via
    // its TTL and is CAS-taken over by the next tick.
    if (scanLock !== null) {
      try {
        await db?.releaseScanLock(scanLock);
      } catch (err) {
        console.error(
          "[worker] scan-lock release failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

/**
 * Outage detection: when a scheduled tick fires and the previous scan
 * finished more than OUTAGE_ALERT_GAP_MS ago, the scanner was down or
 * stuck. Alert each enabled chat once per episode (cooldown-bounded).
 */
async function checkOutageAndAlert(heartbeatAt?: number | null): Promise<void> {
  if (!db || !bot) return;
  // Reuse the cadence gate's heartbeat read (passed in by the scheduled
  // handler) — every extra Turso round trip counts against the ~30s wall
  // clock. Falls back to reading it itself when called without one.
  let lastScanAt = typeof heartbeatAt === "number" && heartbeatAt > 0 ? heartbeatAt : 0;
  if (!lastScanAt) {
    const raw = await db.getWorkerState("scan_heartbeat");
    if (!raw) return; // first ever run — no history yet
    try {
      lastScanAt = ((JSON.parse(raw) as { at?: number } | null)?.at ?? 0) || 0;
    } catch {
      return;
    }
  }
  const gapMs = Date.now() - lastScanAt;
  if (gapMs < OUTAGE_ALERT_GAP_MS) return;
  const lastAlertRaw = await db.getWorkerState("outage_alert_at");
  const lastAlertAt = lastAlertRaw ? Number(lastAlertRaw) : 0;
  if (Date.now() - lastAlertAt < OUTAGE_ALERT_COOLDOWN_MS) return;
  const chats = await db.listEnabledChats();
  if (chats.length === 0) return;
  const minutes = Math.round(gapMs / 60_000);
  const recoveredAt = new Date(lastScanAt).toISOString();
  const text =
    `⚠️ 扫描器曾中断约 ${minutes} 分钟（上次扫描 ${recoveredAt}，现已恢复）\n` +
    `状态页: https://solana-meme-bot.cool1999k.workers.dev/health`;
  for (const chat of chats) {
    try {
      await bot.api.sendMessage(chat.chatId, text);
    } catch (err) {
      console.error("[worker] outage alert failed:", err);
    }
  }
  await db.setWorkerState("outage_alert_at", String(Date.now()));
}

/**
 * Manual on-chain supply-flow check for one mint — the engine behind both
 * the Telegram /flow command and the /debug/flow endpoint. Uses the exact
 * production code path (DexScreener pair lookup → Helius analyzeSupplyFlow
 * with the configured SUPPLY_FLOW_* thresholds) and caches the result in
 * Turso so a subsequent scanner pass on the same coin reuses it instead of
 * re-spending credits.
 */
async function analyzeMintFlow(mint: string): Promise<FlowCheckResult> {
  const t0 = Date.now();
  if (!helius || !cfg?.heliusApiKey) {
    return { ok: false, error: "HELIUS_API_KEY 未配置" };
  }
  if (!dex) {
    return { ok: false, error: "数据源未就绪" };
  }
  try {
    const pairs = await dex.fetchPairsForTokens([mint]);
    const pair = pairs.get(mint);
    if (!pair) {
      return { ok: false, error: "DexScreener 查无此币的交易对" };
    }
    const price = Number(pair.priceUsd);
    const supply =
      Number.isFinite(price) && price > 0 ? pair.marketCap / price : 0;
    if (supply <= 0) {
      return { ok: false, error: "无法由价格推算供应量" };
    }
    const sf = cfg.supplyFlow;
    const ageMin = Math.round((Date.now() - pair.pairCreatedAt) / 60_000);
    // Has the bot pushed this coin before? (seen_tokens, read live so a
    // push that happened after a cached flow verdict still shows.)
    let pushedInfo: { pushed: boolean; at?: number } = { pushed: false };
    if (db) {
      try {
        pushedInfo = await db.getTokenPushedInfo(mint);
      } catch {
        // best-effort — missing marker is harmless
      }
    }
    // Fresh cached verdict (same window the scanner uses) → reuse instead of
    // re-spending ~150–300 Helius credits on a coin just checked.
    if (db) {
      try {
        const cached = await db.getTokenStats(mint);
        if (
          cached &&
          cached.supplyFlowJson &&
          cached.supplyFlowAt !== null &&
          Date.now() - cached.supplyFlowAt < sf.refreshMs
        ) {
          const parsed = JSON.parse(cached.supplyFlowJson) as SupplyFlowResult;
          return {
            ok: true,
            symbol: pair.baseToken.symbol,
            marketCapUsd: pair.marketCap,
            ageMin,
            ms: Date.now() - t0,
            cached: true,
            pushed: pushedInfo.pushed,
            pushedAt: pushedInfo.at,
            result: parsed,
          };
        }
      } catch {
        // cache read failed → analyze fresh
      }
    }
    const result = await Promise.race([
      helius.analyzeSupplyFlow(mint, pair.pairAddress, supply, {
        windowMs: sf.windowMs,
        minFeeders: sf.minFeeders,
        minFedPct: sf.minFedPct,
        minSells: sf.minSells,
        topAccounts: sf.topAccounts,
        checkInflow: sf.checkInflow,
        now: Date.now(),
      }),
      // Hard cap: a slow/stuck gTFA must not hang the webhook request.
      new Promise<SupplyFlowResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              ok: false,
              flagged: false,
              feeders: 0,
              fedPct: 0,
              sells: 0,
              collector: null,
              analyzedAt: Date.now(),
              windowMs: sf.windowMs,
            }),
          25_000,
        ),
      ),
    ]);
    // Cache for the scanner (best-effort): INSERT OR IGNORE the stats row so
    // the coin joins the re-eval pool, then store the fresh flow verdict.
    if (result.ok && db) {
      try {
        await db.recordTokenStats({
          token: mint,
          firstSeenAt: Date.now(),
          firstM5Vol: pair.volume.m5,
          firstSeenAgeMin: Math.max(0, ageMin),
          launchMs: pair.pairCreatedAt,
          birdeye1mVol: null,
          rugcheckBundlerPct: null,
          rugcheckTop10Pct: null,
          birdeyeProTraders: null,
          birdeyeSniperPct: null,
          minMcapObserved: null,
          supplyFlowJson: null,
          supplyFlowAt: null,
        });
        await db.updateTokenSupplyFlow(mint, JSON.stringify(result));
      } catch {
        // A failed cache write must not fail the check itself.
      }
    }
    return {
      ok: true,
      symbol: pair.baseToken.symbol,
      marketCapUsd: pair.marketCap,
      ageMin,
      ms: Date.now() - t0,
      pushed: pushedInfo.pushed,
      pushedAt: pushedInfo.at,
      result,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resilience net for dead cron delivery: every HTTP request (UptimeRobot
 * polls /health every minute, webhooks arrive as Telegram messages) fires a
 * scan in the background IF the last scan is stale. Keeps the scanner alive
 * even when the Cron Trigger stops delivering (observed 2026-08-14: heartbeat
 * frozen while the scan path itself ran fine via /debug/tick). Fire-and
 * -forget so request latency is unaffected; runScan's own race keeps the
 * work inside Cloudflare's wall-clock window, and the next request retries.
 */
async function maybeRunScanIfStale(
  env?: Env,
  ctx?: ExecutionContextLike,
): Promise<void> {
  if (!scanner) return;
  const now = Date.now();
  // This request's waitUntil, wired for the SAME tick tail the cron path
  // wires at `scheduled` (see tickWaitUntil). Without it a fallback-driven
  // tick runs the tracker pass with a null (or a stale, already-finished)
  // keepAlive, so `pushwatch.holdForTick` drops every CUT card's proof on the
  // floor (`void promise` — the promise is cancelled with the invocation) and
  // the audit ring gets no entry for a card that DID reach the chat.
  //
  // Consequence, measured live 2026-09-23: BillSmith's up50 card was
  // announced three times (02:26Z, 02:35Z, 03:03Z) and only the third left an
  // audit entry (msg 3865, sig up50). The first two were cut sends: their
  // rollback left only an attempt mark, and the missing proof is exactly what
  // the next check asks for before it may refuse a duplicate. No proof ⇒
  // fail-open ⇒ send again. The proof is the ONLY thing that can stop it, so
  // a tick path that can never produce one guarantees the duplicate.
  //
  // Ordering: set BEFORE the scan so the pass inherits it, and never cleared
  // — the held proofs still need this context after runScan returns, and the
  // next invocation overwrites it at its own entry.
  if (ctx) tickWaitUntil = (promise) => ctx.waitUntil(promise);
  // The HTTP fallback's own pre-scan slice: measured from here, because this
  // is where a request's work before the scan starts (see PreTickView) — but
  // ONLY the stamp. The subrequest window is opened below, where this request
  // actually commits to scanning: opening it here (the pre-2026-09-27 shape)
  // reset the counter on every request, and this path is driven once a minute by
  // the uptime monitor, which then returned at the dedupe below — rolling the
  // scan tick's window mid-scan and handing the tick's remaining counts to a
  // window that never scanned.
  markPreTickEntry(now);
  if (now - lastScanTriggerAt < SCAN_TRIGGER_INTERVAL_MS) return;
  lastScanTriggerAt = now;
  // Dedupe against a healthy cron: skip unless the last COMPLETED scan is
  // TWO missed cadences old (see scanRescueGapMs). The heartbeat's `at` is
  // the completion time (the flush overwrites the claim's start stamp), so a
  // tick that is merely late — the normal shape of a skipped minute — still
  // holds the heartbeat well inside the rescue gap and scans for ITSELF.
  // The fallback exists to rescue a DEAD cron, not to take over a late tick:
  // at the old one-cadence threshold it did exactly that (26 of 76 completions
  // in a measured 90-minute window), and each rescue then armed the next
  // tick's skip.
  // The heartbeat read doubles as the backfill input for runScan (a dead
  // predecessor's stale scanning heartbeat) — pass it down so the tick
  // adds no extra round trip on the wall-clock-critical path.
  let hbRaw: string | null = null;
  // The rescue threshold in the configured cadence (same arithmetic as the
  // cron gate): a 90s deployment needs 180s of silence before a request takes
  // the scan over.
  const scanGapMs = Math.max(
    SCAN_CRON_PERIOD_MS,
    (cfg?.scanIntervalSeconds ?? 60) * 1000,
  );
  const rescueGapMs = scanRescueGapMs(scanGapMs);
  try {
    // Reuse the read ensureInitialized just paid for when it is still fresh
    // (see lastHeartbeatRead): the uptime monitor drives this path once a
    // minute, and both reads are the very same row.
    const cachedHb = lastHeartbeatRead;
    hbRaw =
      cachedHb !== null && Date.now() - cachedHb.at <= HEARTBEAT_REUSE_MS
        ? cachedHb.raw
        : ((await db?.getWorkerState("scan_heartbeat")) ?? null);
    const at = hbRaw ? ((JSON.parse(hbRaw) as { at?: number } | null)?.at ?? 0) : 0;
    if (typeof at === "number" && now - at < rescueGapMs) return;
  } catch {
    // heartbeat unreadable — fail open and run the fallback scan
  }
  // COMMITTED (see markPreTickEntry above): this request is the scan's owner,
  // so the window it opens is a scan's window — and every path that returned
  // above left the open window alone.
  beginSubreqWindow(now, "http");
  try {
    await runScan(hbRaw, env, null, "http");
  } catch (err) {
    console.error(
      "[worker] fallback scan failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * ============================================================================
 * THE CRON DELIVERIES' RELAY INTO THE PLACED FETCH PATH (2026-10-02)
 * ============================================================================
 *
 * WHAT IT IS. Every cron delivery — the scan tick, the tracker pass and the
 * maintenance legs (SCAN_CRON / TRACKER_CRON / MAINTENANCE_CRON) — runs its
 * work through ONE HTTP request to this Worker's own public URL, so the work
 * executes on the placed FETCH path instead of in the cron region. Nothing
 * about a delivery changes: the placed invocation replays the same delivery
 * by calling `worker.scheduled({ cron }, env, ctx, { relay: false })`, so it
 * gets the same beginPreTick window, waitUntil, routing (tracker / maintenance
 * / scan), pre-init arrival stamp, cadence gate and runScan the platform's own
 * delivery would run — only the data center differs. WHICH delivery arrives
 * travels in the x-cron-relay-delivery header; the placed route maps it back
 * to THIS module's own cron constant (see DELIVERY_CRONS), so the wire never
 * carries a cron string the handler has to trust.
 *
 * WHY (measured 2026-10-02). `[placement]` pins the FETCH path to NRT, next to
 * the Turso database (aws-ap-northeast-1), and its statements collapsed 12-15x
 * (select1 113-123ms -> 8-9ms, readRow 107-116 -> 9-10, claimShapeTwoTrip
 * 263-270 -> 56-70, /debug/db-latency). Placement does NOT move the cron path
 * (docs: fetch handlers only), and the colo probe (69b11f0) answered ORD for
 * 11 of 11 cron ticks while the tick's own heavy reads stayed in the ~1.4s
 * class (front init 1.2-1.5s, getReevalPool 2.2-2.9s — both live heartbeat
 * readings). Those reads are chains of round trips, so the smallest change
 * that shortens them is to run the tick where the trips are short.
 *
 * WHY AN HTTP RELAY AND NOT A DURABLE OBJECT (yet): the DO option buys
 * sub-minute cadence and single-owner state, but it also moves the scanner's
 * module state (rings, caches, mirrors) into a DO and rewrites every
 * diagnostic that reads them. The relay is one route and one call site per
 * delivery, and leaves tick legs, heartbeat and rings working unchanged.
 *
 * WHY THE TRACKER AND MAINTENANCE DELIVERIES RELAY TOO (2026-10-02, the
 * follow-up the first cut named as its own change). They run no scan, but
 * their DB cost is the same shape: the tracker pass's durable note read
 * `db 738ms` per pass at ORD — a chain of Turso round trips, reads
 * single-digit ms on the placed path — and the maintenance legs write their
 * token_stats batches and the crime list from the same distance. (Measured
 * after the relay: the relayed pass's `db` spans 216-1546ms across shapes,
 * its own writes the floor, and `trackerMs` reaches 216ms.) So each delivery
 * relays itself; the routing is unchanged, because the replayed delivery
 * enters the SAME branches the platform's own delivery does (see
 * `scheduled`). Which
 * region a run really happened in is durable, one marker per delivery: the
 * pass row and the maintenance stamp carry `relay`, exactly like the scan
 * heartbeat's field (see THE MARKER below).
 *
 * FAIL-SAFE, IN ORDER: no CRON_RELAY_URL (or no bot token to authenticate
 * with) -> "skipped", the delivery runs locally; refused/timed-out/erroring
 * relay -> "failed", the same local work the Worker has always run. A
 * timed-out relay can overlap the placed invocation it gave up on — that is
 * the same cron-vs-HTTP overlap the DB scan lock, the pass's
 * claim+reservation batch and the cadence gate already arbitrate (the loser
 * skips a tick; it cannot double-push). The rollback is deleting the var; no
 * cron path depended on the relay.
 *
 * AUTH: the relay presents the bot token (TELEGRAM_BOT_TOKEN) in a header and
 * the route compares it. The route is public (workers.dev), so it must not
 * answer a caller that cannot present the configured secret — and it answers
 * 404 rather than 401 so it does not confirm its own existence. An
 * authenticated request naming a delivery that is not one of the three is
 * answered 400, never replayed.
 *
 * CROSS-REGION ROUTING: Cloudflare's docs (error 1042) say a global fetch()
 * to another Worker on the same zone fails unless the
 * global_fetch_strictly_public compatibility flag is set — set in
 * wrangler.toml. Every other fetch this Worker makes targets a third-party
 * host, so the flag decides only how this relay is routed.
 *
 * THE MARKER: every delivery that runs leaves a durable `relay` reading of
 * its own — the scan completion heartbeat, the tracker pass row
 * (Scanner.persistPassNote) and the maintenance stamp
 * (scanner.MAINTENANCE_PASS_STATE_KEY, surfaced on the next tick as
 * summary.diag.maintRelay). "inner" = the placed fetch invocation a relay
 * drove; "failed"/"skipped" = the cron ran the work in its OWN region because
 * the relay could not (or was not configured to) — the pre-relay shape; null =
 * a scan written by a path that was not a cron delivery. Read together with
 * `colo` where the row carries one: a relayed run is "inner" + NRT, a
 * fallen-back one "failed" + ORD.
 *
 * THE READING IS A PARAMETER, NEVER MODULE STATE (2026-10-02, measured): the
 * three deliveries can share one warm isolate, and the first cut's single
 * module-scope outcome let the tracker pass's route CLEAR it while a scan tick
 * was still in flight — the tick's completion heartbeat then read
 * `relay: null` although it had run on the placed path, while the pass row on
 * the very same isolate read `inner`. So each invocation answers for itself:
 * `opts.relayTag` names the placed replay (see handleCronRelay) and
 * relayCronDelivery RETURNS the tag the cron side must publish when it falls
 * back. This is runScan's own rule for `via` ("a PARAMETER, never module
 * state") applied to the region reading.
 */
export const CRON_RELAY_PATH = "/internal/cron-relay";
/**
 * The scan tick's own expression (wrangler.toml [triggers].crons, FIRST
 * entry). Replayed into the relayed invocation so it routes to the SCAN
 * branch: the two special deliveries compare their own expressions and answer
 * false for this one (see isTrackerCron / isMaintenanceCron).
 */
export const SCAN_CRON = "* * * * *";
/**
 * The three deliveries the relay can carry, and the canonical expression each
 * one replays. A delivery is NAMED on the wire (CRON_RELAY_DELIVERY_HEADER)
 * and mapped here, so the placed route never replays a caller-supplied cron
 * string: an authenticated caller can only ask for one of these three, and a
 * scan tick keeps arriving as SCAN_CRON.
 */
export type CronRelayDelivery = "scan" | "tracker" | "maintenance";
export const DELIVERY_CRONS: Record<CronRelayDelivery, string> = {
  scan: SCAN_CRON,
  tracker: TRACKER_CRON,
  maintenance: MAINTENANCE_CRON,
};
/**
 * How long a cron waits for the placed invocation before giving up and
 * running the work locally: above every relayed envelope (the scan tick's 20s
 * SCAN_TICK_BUDGET_MS, the tracker pass's 5s budget, the maintenance pass's
 * 6s), so only a wedged invocation falls back (healthy runs settle in 1-4s),
 * and far inside the 15-minute Cron Trigger duration limit — the cron only
 * sits on a fetch here, its own CPU stays tiny.
 */
const CRON_RELAY_BOUND_MS = 26_000;
/** The header the placed route authenticates (see handleCronRelay). */
const CRON_RELAY_HEADER = "x-cron-relay";
/** The header naming which delivery to replay (see DELIVERY_CRONS). */
const CRON_RELAY_DELIVERY_HEADER = "x-cron-relay-delivery";
/** Pure: the relay URL for a configured base (trailing slashes tolerated). */
export function cronRelayUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}${CRON_RELAY_PATH}`;
}

/** Pure: does this request carry the relay secret? (see handleCronRelay) */
export function isCronRelayRequest(
  method: string,
  presented: string | null,
  token: string | undefined,
): boolean {
  return (
    method === "POST" &&
    typeof token === "string" &&
    token.length > 0 &&
    presented === token
  );
}

/** Pure: the delivery a relay request names, or null for an unknown one. */
export function parseCronRelayDelivery(
  value: string | null | undefined,
): CronRelayDelivery | null {
  return value === "scan" || value === "tracker" || value === "maintenance"
    ? value
    : null;
}

/**
 * The header naming WHO is relaying (see TickClock): absent = the cron
 * delivery itself, `clock` = the sub-minute clock's alarm. The placed route
 * turns this into the replayed run's ScanTrigger, so `/health.scanTriggers`
 * and the heartbeat's `via` can separate a clock scan from a cron one — the
 * clock's arrivals deliberately carry NONE of the cron bookkeeping (see
 * `scheduled`), so counting them as cron now would quietly corrupt the very
 * readings (the tick ring, scheduled_tick_total, the pre-init stamp) that cron
 * liveness is monitored with.
 */
const CRON_RELAY_SOURCE_HEADER = "x-cron-relay-source";

/** Pure: the relay source a request names, or null when it is the cron. */
export function parseCronRelaySource(
  value: string | null | undefined,
): "clock" | null {
  return value === "clock" ? "clock" : null;
}

/**
 * The cron half: run this delivery through the placed fetch path. Returns
 * "relayed" when the placed invocation ran it (the caller must NOT run the
 * local work); otherwise the tag the LOCAL run must publish — "failed" when
 * the relay was refused/timed-out/erroring, "skipped" when it was not
 * configured at all. A return value, not module state: see THE MARKER in the
 * block comment above.
 *
 * `source` names WHO relays: null = the cron delivery itself (whose caller
 * runs the local fallback on a non-"relayed" answer), "clock" = the
 * sub-minute clock's alarm (see TickClock), which has NO local fallback — it
 * is only a trigger, and on failure the cron delivery remains the cadence.
 * The header is also what makes the replayed run's trigger honest (`via`).
 */
async function relayCronDelivery(
  env: Env,
  delivery: CronRelayDelivery,
  source: "clock" | null = null,
): Promise<"relayed" | "failed" | "skipped"> {
  const base = env.CRON_RELAY_URL;
  const secret = env.TELEGRAM_BOT_TOKEN;
  if (!base || !secret) {
    return "skipped";
  }
  const fromClock = source === "clock";
  try {
    const res = await fetch(cronRelayUrl(base), {
      method: "POST",
      headers: {
        [CRON_RELAY_HEADER]: secret,
        [CRON_RELAY_DELIVERY_HEADER]: delivery,
        ...(fromClock ? { [CRON_RELAY_SOURCE_HEADER]: source } : {}),
      },
      signal: AbortSignal.timeout(CRON_RELAY_BOUND_MS),
    });
    if (!res.ok) {
      console.error(
        `[worker] ${delivery} relay${fromClock ? " (clock)" : ""} answered ${res.status}; ${fromClock ? "the cron delivery remains the cadence" : "running it in the cron region"}`,
      );
      return "failed";
    }
    const body = (await res.json().catch(() => null)) as { ms?: number } | null;
    // Log-only; the durable proof is the run's own row (`relay: "inner"`,
    // plus its placed colo where the row carries one). `cf-placement` rides
    // the response and is visible only to the caller — the placed handler
    // cannot read its own placement, which is why /debug/db-latency's colo
    // note warns against reading it there.
    console.log(
      `[worker] ${delivery} relay: the placed invocation ran it in ${body?.ms ?? "?"}ms (${res.headers.get("cf-placement") ?? "no placement header"})`,
    );
    return "relayed";
  } catch (err) {
    console.error(
      `[worker] ${delivery} relay${fromClock ? " (clock)" : ""} failed; ${fromClock ? "the cron delivery remains the cadence" : "running it in the cron region"}:`,
      err instanceof Error ? err.message : err,
    );
    return "failed";
  }
}

/**
 * The placed half: authenticate the relay, resolve the named delivery to this
 * module's own cron constant and replay it through the scheduled handler with
 * `relay: false` (see `scheduled`), so the work runs with the platform's own
 * entry semantics inside THIS placed invocation. The response carries the
 * wall time for the cron's log, and never anything the run itself measured —
 * those land in its own durable row.
 */
async function handleCronRelay(
  request: Request,
  env: Env,
  ctx: ExecutionContextLike,
): Promise<Response> {
  if (
    !isCronRelayRequest(
      request.method,
      request.headers.get(CRON_RELAY_HEADER),
      env.TELEGRAM_BOT_TOKEN,
    )
  ) {
    return new Response("Not Found", { status: 404 });
  }
  const delivery = parseCronRelayDelivery(
    request.headers.get(CRON_RELAY_DELIVERY_HEADER),
  );
  if (!delivery) {
    return Response.json(
      { ok: false, error: "unknown relay delivery" },
      { status: 400 },
    );
  }
  // WHO is asking (see parseCronRelaySource): the clock's alarm or a cron
  // delivery. It rides `opts.via` into the replayed run's ScanTrigger.
  const source = parseCronRelaySource(
    request.headers.get(CRON_RELAY_SOURCE_HEADER),
  );
  const startedAt = Date.now();
  try {
    // `relayTag: "inner"` is the placed run's OWN region reading (see THE
    // MARKER): a parameter, so this invocation can never colour another one.
    await worker.scheduled({ cron: DELIVERY_CRONS[delivery] }, env, ctx, {
      relay: false,
      relayTag: "inner",
      ...(source === null ? {} : { via: source }),
    });
    return Response.json({ ok: true, delivery, ms: Date.now() - startedAt });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] relayed ${delivery} run failed:`, message);
    return Response.json(
      { ok: false, error: message, ms: Date.now() - startedAt },
      { status: 500 },
    );
  }
}

/**
 * ============================================================================
 * THE SUB-MINUTE CLOCK (2026-10-02): a Durable Object's alarm drives the scan
 * and tracker deliveries faster than a Cron Trigger can
 * ============================================================================
 *
 * WHY IT EXISTS. A Cron Trigger is a five-field expression, so the fastest
 * cadence this Worker's platform triggers can carry is once a minute (see
 * [triggers].crons, and SCAN_INTERVAL_SECONDS's "the fastest cadence the 1-min
 * cron can drive"). A Durable Object alarm has no such floor: the object
 * re-arms itself for the next tick the moment the current one finishes
 * (Cloudflare: "Alarms are more fine grained than Cron Triggers"). This is the
 * Durable Object lever the placement block's NEXT STEP named — and it needs no
 * Turso migration, because the clock only TRIGGERS: every tick it fires still
 * runs on the placed fetch path (NRT, beside the database) through the same
 * relay every cron delivery uses (see the relay block above).
 *
 * WHAT ONE TICK DOES: one relay POST per delivery — `scan` and `tracker`, in
 * PARALLEL (they are independent invocations of this Worker; the platform
 * already delivers those two crons on the same minute, so nothing about their
 * concurrency is new) — and then it re-arms. It holds no state a tick needs,
 * writes no rows of its own, and its work is visible exactly where the cron's
 * is: the scan heartbeat (`via: "clock"`, `relay: "inner"`), the durable
 * per-trigger counter (`scan_trigger_clock`) and the pass row's own timestamps.
 *
 * WHY THE CLOCK DOES NOT RUN THE TICK ITSELF: a Durable Object's location is
 * fixed at creation (a hint, not a promise), while the whole 2026-10-02 relay
 * exercise was about the tick's DB round trips running where they measure
 * single-digit ms — NRT, beside the Turso group. Relaying keeps ONE execution
 * site for the work and makes the clock purely a trigger; the price is one extra
 * internal hop per tick (~50-100ms), paid because nothing else in this Worker
 * can ask for the work at NRT on demand.
 *
 * THE GATE IS STILL THE CADENCE. A clock tick ASKS for a scan exactly like a
 * cron tick; it does not force one. The threshold is `scanGateMs(clockTickMs)`
 * (half the interval below one cron period), so a late alarm, a cron arrival in
 * the same seconds, and a scan still in flight all end in the ordinary
 * gate/scan-lock arbitration and can never overlap. The clock is therefore
 * REPLACEABLE in both directions: if it dies, the cron's cadence continues from
 * the same place — and every cron scan delivery re-arms it (see armTickClock);
 * if the cron dies, the clock keeps scanning, and the HTTP rescue still exists
 * for both dying together.
 *
 * CRON BOOKKEEPING IS THE CRON'S. A clock arrival carries NONE of it: no tick
 * ring entry, no scheduled_tick_total bump, no pre-init arrival stamp and no
 * `scheduledTickFinishedAt` move. Those readings exist to answer "is the cron
 * trigger delivering, and do its ticks finish?", and a clock arrival recorded
 * there would make a DEAD cron look alive — the exact misreading
 * docs/uptime-monitor.md was written about. The clock's own liveness is its
 * scan heartbeat pace, its trigger counter and /debug/clock.
 *
 * CONFIG: `CLOCK_TICK_SECONDS` (wrangler.toml [vars]). Unset, "0", junk or
 * negative = the clock is OFF (the DO is never armed; rollback is deleting the
 * key or setting 0, no code change). Clamped to [15s, 300s] so a typo can
 * neither hot-loop alarms (each one costs a DO request) nor turn the clock into
 * a slower cron. While it is ON its period IS the scan cadence (the gate
 * follows it); SCAN_INTERVAL_SECONDS is the cadence when the clock is off.
 *
 * COST, so it can be judged: at 30s that is 2 alarms/minute (~87.6K/month), one
 * DO request per alarm plus its two relay subrequests, and each relayed tick is
 * an ordinary Worker request — the order of a tenth of the plan's included
 * requests at the time of writing. The readings that decide whether the faster
 * cadence is worth it are the scan_history spacing, `scanTriggers.clock`,
 * /debug/dex429 and the tick's own summary: a faster cadence spends upstream
 * calls and Turso rows 2-3x faster, and upstream 429s are this Worker's known
 * ceiling.
 *
 * FAILURE SHAPE: every alarm body is caught (never rethrown) and the next alarm
 * is set in `finally`. Cloudflare's rule is why: an alarm() that throws is
 * retried up to 6 times and then the loop is DEAD until the next setAlarm — so
 * a downstream outage, a relay timeout or a bug in this file must not be able
 * to end the clock. A tick whose relays fail is simply lost (the cron carries
 * the cadence), and the next cron scan re-arms an alarm that is somehow gone.
 * `armIfUnset` never moves a pending alarm, so a healthy loop's phase cannot be
 * reset by the cron.
 */
interface DurableObjectStorageLike {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTimeMs: number): Promise<void>;
}
interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}
interface DurableObjectStubLike {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

/** The clock's single instance: one alarm loop, one cadence. */
export const TICK_CLOCK_NAME = "tick-clock";
/**
 * The DO's own fetch surface. Any origin works — the object routes on the
 * pathname alone — so the constant exists to keep the callers from inventing
 * strings.
 */
export const TICK_CLOCK_ORIGIN = "https://tick-clock";
export const TICK_CLOCK_ARM_PATH = "/arm";
export const TICK_CLOCK_STATUS_PATH = "/status";

/**
 * The clock's tick period in ms, 0 when the clock is off. Pure and exported
 * for the unit test: unset / "0" / junk / negative all read as OFF (the
 * rollback), and a value inside the supported range is clamped rather than
 * trusted — a typo must not be able to hot-loop alarms or silently disable the
 * cadence knob this Worker documents in SCAN_INTERVAL_SECONDS.
 */
export function clockTickMs(env: { CLOCK_TICK_SECONDS?: string }): number {
  const raw = Number(env.CLOCK_TICK_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(
    TICK_CLOCK_MAX_MS,
    Math.max(TICK_CLOCK_MIN_MS, Math.round(raw * 1000)),
  );
}

/**
 * The clock's binding out of the env. The ONE cast in this file that reads a
 * binding off `Env`: its `[key: string]: string | undefined` index signature is
 * what keeps `Env` assignable to NodeJS.ProcessEnv for loadConfig, and a
 * DurableObjectNamespace is not a string — so the binding is read here instead
 * of widening the index signature (which would break that assignment). A
 * deployment without the binding (an older version, a local dev run) reads as
 * null and the clock is simply off.
 */
function tickClockBinding(env: Env): DurableObjectNamespaceLike | null {
  const ns = (env as unknown as { TICK_CLOCK?: DurableObjectNamespaceLike })
    .TICK_CLOCK;
  return ns && typeof ns.idFromName === "function" && typeof ns.get === "function"
    ? ns
    : null;
}

/**
 * Keep the clock armed: called by every CRON scan delivery (never by the
 * clock's own), so a clock whose alarm was somehow lost comes back on the next
 * minute. Fire-and-forget through ctx.waitUntil — the tick must never wait on
 * the clock's storage — and `armIfUnset` on the other side never moves an alarm
 * that is already pending, so a healthy loop keeps its phase.
 *
 * Cost: one DO request per cron minute (~43.2K/month at the 60s cron) — the
 * price of the clock being self-healing instead of depending on a manual arm.
 */
function armTickClock(env: Env, ctx: ExecutionContextLike): void {
  const ns = tickClockBinding(env);
  if (!ns || clockTickMs(env) <= 0) return;
  try {
    const stub = ns.get(ns.idFromName(TICK_CLOCK_NAME));
    ctx.waitUntil(
      stub
        .fetch(`${TICK_CLOCK_ORIGIN}${TICK_CLOCK_ARM_PATH}`, { method: "POST" })
        .then(() => undefined)
        .catch(() => undefined),
    );
  } catch (err) {
    console.error(
      "[worker] clock arm failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The sub-minute clock (see the block comment above). Exported under the name
 * wrangler.toml's `[[durable_objects.bindings]] class_name` uses — the class
 * name IS the contract, so it must not be renamed without that file.
 */
export class TickClock {
  private readonly state: DurableObjectStateLike;
  private readonly env: Env;
  /**
   * The status reading is deliberately MEMORY-ONLY (the alarm is the durable
   * part): a per-tick storage write would buy nothing a reader of /debug/clock
   * cannot get from the alarm time plus the scan heartbeat, and every storage
   * op inside an alarm is a line item. It resets when the object is evicted,
   * which is exactly when `alarmAt` (durable) becomes the reading that matters.
   */
  private ticks = 0;
  private lastTickAt: number | null = null;
  private lastAlarmAt: number | null = null;
  private lastResults: { scan: string; tracker: string } | null = null;
  private lastWorkMs: number | null = null;

  constructor(state: DurableObjectStateLike, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === TICK_CLOCK_ARM_PATH) {
      const armed = await this.armIfUnset();
      return Response.json({ ok: true, armed, ...(await this.status()) });
    }
    if (url.pathname === TICK_CLOCK_STATUS_PATH) {
      return Response.json({ ok: true, ...(await this.status()) });
    }
    return new Response("Not Found", { status: 404 });
  }

  /**
   * Arm the loop IF nothing is pending. Never moves a live alarm: the cron
   * calls this every minute, and resetting a pending alarm would push the next
   * tick back to "one clock period from now" on every cron minute — i.e. it
   * would halve the cadence it exists to raise.
   */
  private async armIfUnset(): Promise<boolean> {
    if (clockTickMs(this.env) <= 0) return false;
    if ((await this.state.storage.getAlarm()) !== null) return false;
    // Alarm now, not now + period: the arm request is a fresh start, and the
    // first tick should be the one that proves the loop works.
    await this.state.storage.setAlarm(Date.now());
    return true;
  }

  private async status(): Promise<Record<string, unknown>> {
    const tickMs = clockTickMs(this.env);
    let alarmAt: number | null = null;
    try {
      alarmAt = await this.state.storage.getAlarm();
    } catch {
      // An unreadable alarm time is reported as "not armed" — the caller (a
      // human on /debug/clock) should see the null, not an exception.
    }
    return {
      on: tickMs > 0,
      tickMs,
      relayConfigured: Boolean(
        this.env.CRON_RELAY_URL && this.env.TELEGRAM_BOT_TOKEN,
      ),
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      lastAlarmAt: this.lastAlarmAt,
      lastWorkMs: this.lastWorkMs,
      lastResults: this.lastResults,
      alarmAt,
      now: Date.now(),
    };
  }

  async alarm(): Promise<void> {
    const tickMs = clockTickMs(this.env);
    try {
      if (tickMs > 0) {
        const startedAt = Date.now();
        this.ticks += 1;
        this.lastTickAt = startedAt;
        // Parallel on purpose (see the block comment): the two deliveries are
        // independent invocations, and awaiting them in series would make the
        // alarm's own span the sum of two ticks' wall clocks.
        const [scan, tracker] = await Promise.all([
          relayCronDelivery(this.env, "scan", "clock"),
          relayCronDelivery(this.env, "tracker", "clock"),
        ]);
        this.lastResults = { scan, tracker };
        this.lastWorkMs = Date.now() - startedAt;
      }
    } catch (err) {
      // NEVER rethrow (see the block comment): a throw is 6 retries and then a
      // dead loop.
      console.error(
        "[worker] clock tick failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      // Re-arm whether or not the work ran: the alarm IS the loop, and the
      // cron's armTickClock is the backstop if even this fails. A disabled
      // clock (`CLOCK_TICK_SECONDS` pulled mid-loop) stops here and only the
      // cron can restart it — which is the intended kill switch.
      if (tickMs > 0) {
        try {
          this.lastAlarmAt = Date.now() + tickMs;
          await this.state.storage.setAlarm(this.lastAlarmAt);
        } catch (err) {
          console.error(
            "[worker] clock re-arm failed; the next cron scan re-arms it:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
  }
}

const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<Response> {
    await ensureInitialized(env);
    const url = new URL(request.url);
    // THE RELAY'S PLACED HALF (see the relay block at the bottom): each cron
    // delivery (scan tick / tracker pass / maintenance legs) arrives here as
    // an HTTP request to this Worker's own URL.
    // Routed BEFORE the rescue-scanner arm below ON PURPOSE: the relayed
    // invocation drives its own run, and arming maybeRunScanIfStale beside it
    // would let a rescue scan race that run inside the same isolate (the
    // rescue's dedupe reads the heartbeat, and the case it exists for — a
    // previous tick that died — is exactly when that heartbeat is stale).
    if (url.pathname === CRON_RELAY_PATH) {
      return handleCronRelay(request, env, ctx);
    }
    // Keep the scanner alive independently of cron delivery. waitUntil keeps
    // the isolate alive until the background scan settles — a bare `void`
    // promise gets frozen with the isolate right after the response returns,
    // which wedges the scanner's running-lock mid-scan (observed
    // 2026-08-14: heartbeat frozen for 90+ minutes while the lock read
    // "previous-scan-still-running"). Guarded by the last-trigger timestamp.
    ctx.waitUntil(maybeRunScanIfStale(env, ctx));

    // UptimeRobot target: distinguishes "worker up" from "scanner working".
    // /debug/card-preview — renders ONE push card with LIVE Axiom
    // token-info data for ?pair=<pairAddress> and sends it to ?chatId=
    // (defaults to the first admin). Pure preview: no DB writes, no seen
    // claims; market rows are clearly-marked placeholders so only the new
    // Axiom summary line is under test. If the payload can't resolve, the
    // card intentionally shows the legacy lines — that fallback IS part of
    // what's being previewed.
    if (url.pathname === "/debug/card-preview") {
      const client = axiom;
      if (!client) {
        return Response.json({ ok: false, error: "Axiom client unavailable" });
      }
      const pairAddr = (url.searchParams.get("pair") ?? "").trim();
      if (!pairAddr) {
        return Response.json(
          { ok: false, error: "missing ?pair=<pairAddress>" },
          { status: 400 },
        );
      }
      let chatId = (url.searchParams.get("chatId") ?? "").trim();
      if (!chatId && cfg?.adminIds.length) chatId = String(cfg.adminIds[0]);
      if (!chatId) {
        return Response.json(
          { ok: false, error: "missing ?chatId= and no admins configured" },
          { status: 400 },
        );
      }
      let axiomPayload: AxiomTokenInfo | null = null;
      try {
        const accessToken = await db?.getWorkerState("axiom_access_token");
        if (accessToken) {
          const sessionRefresh = await db?.getWorkerState("axiom_refresh_token");
          try {
            const out = await client.fetchTokenInfo(
              accessToken,
              pairAddr,
              "/token-info-v2",
              "pairAddress",
              "",
              undefined,
              sessionRefresh ?? undefined,
            );
            axiomPayload = parseAxiomTokenInfo(out.data);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (/auth/.test(msg)) {
              const refreshToken = await db?.getWorkerState("axiom_refresh_token");
              if (refreshToken) {
                const fresh = await client.refreshAccessToken(refreshToken);
                if (fresh?.accessToken) {
                  await db?.setWorkerState("axiom_access_token", fresh.accessToken);
                  if (fresh.refreshToken) {
                    await db?.setWorkerState("axiom_refresh_token", fresh.refreshToken);
                  }
                  const out2 = await client.fetchTokenInfo(
                    fresh.accessToken,
                    pairAddr,
                    "/token-info-v2",
                    "pairAddress",
                    "",
                    undefined,
                    fresh.refreshToken ?? sessionRefresh ?? undefined,
                  );
                  axiomPayload = parseAxiomTokenInfo(out2.data);
                }
              }
            }
          }
        }
      } catch {
        axiomPayload = null; // fallback branch — legacy lines stay visible
      }
      const now = Date.now();
      const mockCoin = {
        chatId,
        profile: { tokenAddress: pairAddr, name: "Card Preview", symbol: "PREVIEW" },
        pair: {
          baseToken: { address: pairAddr, name: "Card Preview", symbol: "PREVIEW" },
          pairAddress: pairAddr,
          priceUsd: 0.0001329,
          marketCap: 132900,
          liquidity: { usd: 21000 },
          pairCreatedAt: now - 5 * 3600_000,
          priceChange: { m5: 3.2 },
          volume: { m5: 23400, h24: 183000 },
        },
        stats: { token: pairAddr },
      } as unknown as QualifyingCoin;
      // §4.17: the card takes no sniper/holder value any more — those two
      // Birdeye-bought lines are gone (the free Axiom line prints both).
      const message = renderMessage(
        mockCoin,
        null,
        null,
        true,
        null,
        null,
        null,
        { hit: false, creatorHit: false, holderHits: [], checkedHolders: 0, loaded: false, holders: [] },
        null,
        null,
        axiomPayload,
        null, // flurry forensics — hidden when disabled
      );
      let sent = false;
      let sendError: string | null = null;
      try {
        await bot!.api.sendMessage(chatId, message);
        sent = true;
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err);
      }
      return Response.json({ ok: sent, chatId, sent, sendError, message });
    }

    if (url.pathname === "/health") {
      let heartbeat: unknown = null;
      let lastScanGapMs: number | null = null;
      let tickProgress: unknown = null;
      // The mode row rides the SAME statement (round 4, §4.25): /health used
      // to read it a SECOND time (the single-row read) for a value this
      // request had already paid for. `modeLanded` is the reading-vs-missing
      // split the prime below needs: "read, row absent" is a real reading
      // (no override), "no reading at all" must not become one.
      let modeRaw: string | null = null;
      let modeReadAt = 0;
      let modeLanded = false;
      try {
        // All three rows in ONE statement (see Db.getWorkerStates): the
        // progress record is the tick's own account of how far it got before
        // its flush, so a stale phase=scanning heartbeat can be READ together
        // with the reason it is stale (see TICK_PROGRESS_KEY).
        const rows = await db?.getWorkerStates([
          "scan_heartbeat",
          TICK_PROGRESS_KEY,
          "trade_mode_override",
        ]);
        const raw = rows?.get("scan_heartbeat") ?? null;
        heartbeat = raw ? JSON.parse(raw) : null;
        const progressRaw = rows?.get(TICK_PROGRESS_KEY) ?? null;
        tickProgress = progressRaw ? JSON.parse(progressRaw) : null;
        const at = (heartbeat as { at?: number } | null)?.at;
        if (typeof at === "number") lastScanGapMs = Date.now() - at;
        if (rows) {
          modeRaw = rows.get("trade_mode_override") ?? null;
          modeReadAt = Date.now();
          modeLanded = true;
        }
      } catch {
        heartbeat = null;
      }
      // Effective trade mode: Telegram /setmode override wins over env. Both
      // numbers now come from the ONE row read above (round 4, §4.25):
      // `tradeModeOverride` is that raw value through the shared validation
      // (parseTradeModeOverride — the rule the single-row read applies),
      // and a row this request actually read primes the service, so
      // effectiveMode is answered from it instead of paying a second round
      // trip for the very same row.
      let effectiveTradeMode: string = cfg?.trade.mode ?? "off";
      let tradeModeOverride: string | null = null;
      try {
        if (modeLanded) {
          trade?.primeModeOverride(modeRaw, modeReadAt);
          tradeModeOverride = parseTradeModeOverride(modeRaw);
        }
        effectiveTradeMode = (await trade?.effectiveMode()) ?? effectiveTradeMode;
      } catch {
        // telemetry only — never fail /health over the mode read
      }
      // The last tracker pass's coverage line, read from Turso rather than
      // from this isolate's scanner: the pass persists it (see
      // Scanner.runTrackerPass), which is what lets the STAGE SPLIT be read
      // from any isolate. The in-memory copy in `summary.pushWatch` is only
      // populated when the next tick lands on the same isolate, so on the
      // 2026-09-21 stall it was usually absent — the one number that explained
      // the zero-row tracker was the one number /health could not show.
      // Assigned from the page's ONE batched read below (see
      // Db.readHealthFront): this row used to be a round trip of its own,
      // for a request the front already pays for.
      let pushWatchPass: unknown = null;
      // Cross-isolate cron diagnostics: the scheduled handler persists a
      // running total + last event time to Turso, so any isolate serving
      // /health can prove whether the Cron Trigger is actually delivering.
      let scheduledTickTotal: number | null = null;
      let scheduledTickAt: number | null = null;
      let scheduledArrivalTotal: number | null = null;
      let scheduledArrivalAt: number | null = null;
      let enabledChats: number | null = null;
      let tokenStatsCount: number | null = null;
      let pushedTotal: number | null = null;
      // The drain's own record of its last failure, read from its durable row
      // (see WRITE_DRAIN_ERROR_KEY in src/tickprobe.ts) rather than from this
      // isolate's mirror: the isolate that accumulates a backlog is not the one
      // answering this request — live 2026-09-24, a poll landing on a pristine
      // isolate reported `writeDrain {at 0}` while 47 writes waited elsewhere,
      // so the reason has to be readable from ANY isolate.
      let writeDrainError: WriteDrainErrorRecord | null = null;
      // Birdeye CU accounting (see the ledger above): the free tier is
      // 30_000 CU a MONTH for the whole bot, and §4.4.2's table was an
      // estimate until this existed. Read from Turso, not from an isolate
      // mirror, so any isolate answers with the fleet's month-to-date.
      let birdeyeCu: {
        day: string;
        today: number;
        monthCu: number;
        pendingCu: number;
        monthlyMax: number;
        /** Day totals, newest first: `monthCu` as a rate (see the helper). */
        recentDays: Array<{ day: string; cu: number }>;
        /** WHICH endpoint spent it, today and month-to-date (§4.14). */
        byEndpoint: { today: BirdeyeCuCounts; month: BirdeyeCuCounts };
      } | null = null;
      // The list-feed edge cache, as the SCANNER journaled it (see
      // src/dexscreener.ts). Read from Turso for the reason above: the
      // counters move on the tick, and /health is answered by whichever
      // isolate the request lands on. null = no tick has reported yet,
      // which is a different reading from 0/0.
      let dexListCache: {
        hits: number;
        misses: number;
        /** List requests the origin REFUSED (non-2xx). Published because the
         * TTL question needs both halves: `misses` = the edge entry expired
         * and the origin answered, `refused` = the origin said no, so the lane
         * never had a cache verdict to report. */
        refused: number;
        /** hits / (hits + misses) as a percentage, or null while none of the
         * two was answered. Read it WITH `refused`: this ratio is over the
         * responses that arrived, and a lane refused most ticks can hold it
         * near 100 (live 2026-09-30: 99.8% while 19 of 21 requests were 429). */
        hitPct: number | null;
        /** The last list-lane outcome the durable row carries: a
         * `cf-cache-status` on a 2xx, or `HTTP-<code>` on a refusal. */
        lastStatus: string | null;
      } | null = null;
      try {
        // The two arrival records in ONE read (was two): the claim-riding
        // counter/timestamp, plus the PRE-INIT stamp (see the scheduled
        // handler). Reading them together is what makes the pair comparable —
        // `scheduledArrivalAt > scheduledTickAt` means the newest cron delivery
        // never accounted for itself, i.e. the tick died in front of its claim.
        const front = await db?.readHealthFront([
          "scheduled_tick_total",
          "scheduled_tick_at",
          "scheduled_arrival_total",
          "scheduled_arrival_at",
          // The failed drain's record rides THIS read (the handler already
          // batches these keys into one request, so it costs no extra round
          // trip) — see WRITE_DRAIN_ERROR_KEY in src/tickprobe.ts.
          "write_drain_error",
          // Both CU ledgers ride this batch too: /health used to read the
          // total on its own round trip, and the per-endpoint split would
          // have been a third. Same request, so the breakdown is free.
          BIRDEYE_CU_STATE_KEY,
          BIRDEYE_CU_BY_STATE_KEY,
          // The tracker pass line and both telemetry counters ride THIS
          // request (2026-09-26): each was a round trip of its own for a row
          // one batch carries for free — see Db.readHealthFront, which also
          // answers the enabled-chats count in the same batch.
          "push_watch_pass",
          "telemetry_token_stats_count",
          "telemetry_seen_tokens_count",
          // The list-feed edge-cache ledger the scanner journals
          // (2026-09-26): the answer to LIST_FEED_CACHE_TTL_S rides THIS
          // request for the same reason the two counters above do. The
          // names are imported, never retyped — a literal here and a
          // literal in the scanner is how the two ends drift apart.
          DEX_LIST_CACHE_HITS_KEY,
          DEX_LIST_CACHE_MISSES_KEY,
          DEX_LIST_CACHE_REFUSED_KEY,
          DEX_LIST_CACHE_LAST_KEY,
        ]);
        const tickState = front?.states;
        const rawTotal = tickState?.get("scheduled_tick_total") ?? null;
        const rawAt = tickState?.get("scheduled_tick_at") ?? null;
        const rawArrivalTotal = tickState?.get("scheduled_arrival_total") ?? null;
        const rawArrivalAt = tickState?.get("scheduled_arrival_at") ?? null;
        scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;
        scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;
        scheduledArrivalTotal = rawArrivalTotal ? parseInt(rawArrivalTotal, 10) || 0 : null;
        scheduledArrivalAt = rawArrivalAt ? parseInt(rawArrivalAt, 10) || 0 : null;
        // A malformed or absent row reads as "no record" rather than failing
        // the page: this is forensics, and an unreadable row must never cost
        // the health read an operator is using to diagnose exactly that kind of
        // breakage.
        const rawDrainError = tickState?.get("write_drain_error") ?? null;
        if (rawDrainError !== null) {
          try {
            writeDrainError = JSON.parse(rawDrainError) as WriteDrainErrorRecord;
          } catch {
            writeDrainError = null;
          }
        }
        // RETIRE A STALE RECORD (2026-09-27). The row is cleared by the isolate
        // that WROTE it (see clearPersistedDrainError), so an isolate recycled
        // before its own recovery leaves it standing forever: live that day a
        // poll read a record from 2026-09-25 (2.2 days old, `pending 30`) while
        // every drain behind it had landed. The reader that RENDERS the field
        // is the one place that sees it from any isolate, and /health is polled
        // every minute, so retiring it here costs ONE write per incident:
        // nothing to do when there is no row, and a LIVE row stays the writer's
        // own to clear — this only touches what WRITE_DRAIN_ERROR_STALE_MS
        // already calls history. Durable like the clear (waited on, not
        // floating: an un-awaited write is cancelled when the handler returns).
        if (db && drainErrorIsStale(writeDrainError, Date.now())) {
          const retiring = db
            .setWorkerState(WRITE_DRAIN_ERROR_KEY, "")
            .catch(() => undefined);
          try {
            ctx.waitUntil(retiring);
          } catch {
            // A caller without a live context (tests) must not see a rejection.
            void retiring;
          }
        }
        const rawPass = tickState?.get("push_watch_pass") ?? null;
        pushWatchPass = rawPass ? JSON.parse(rawPass) : null;
        // The count, not the listing: /health only ever used the length of
        // listEnabledChats, so its row mapping was decoded for nothing — the
        // front's second statement answers it with COUNT(*).
        enabledChats = front ? front.enabledChats : null;
        // The counters ride the same batch. The heal path (absent or
        // negative — see parseTelemetryCounter) is the only case that still
        // pays a round trip, and it re-derives the number through the SAME
        // rule the single-row read applies rather than a second copy of it.
        const statsRaw = parseTelemetryCounter(
          tickState?.get("telemetry_token_stats_count"),
        );
        tokenStatsCount = telemetryCounterUsable(statsRaw)
          ? statsRaw
          : ((await db?.countTokenStats()) ?? null);
        const seenRaw = parseTelemetryCounter(
          tickState?.get("telemetry_seen_tokens_count"),
        );
        pushedTotal = telemetryCounterUsable(seenRaw)
          ? seenRaw
          : ((await db?.countSeenTokens()) ?? null);
        const cuDays = parseBirdeyeCuLedger(
          tickState?.get(BIRDEYE_CU_STATE_KEY) ?? null,
        );
        birdeyeCu = {
          ...birdeyeCuStats(cuDays),
          // This isolate's unpersisted spend is real spend too: the durable
          // row only moves when the throttled sync lands, so the stored
          // total alone under-reads for up to one sync gap.
          pendingCu: birdeyeCuPendingTotal(),
          monthlyMax: cfg?.birdeyeMonthlyCuMax ?? BIRDEYE_MONTHLY_CU_DEFAULT,
          // The month total alone cannot say whether 46K CU of spend is the
          // holder probe, the card path or a debug endpoint — and the probe
          // and the card share `/defi/token_overview`, so only the CALL
          // count (calibratable against Birdeye's own dashboard) plus the
          // pass note's `probe<N>` can separate them.
          recentDays: birdeyeCuRecentDays(cuDays),
          byEndpoint: birdeyeCuByStats(
            parseBirdeyeCuByLedger(tickState?.get(BIRDEYE_CU_BY_STATE_KEY) ?? null),
          ),
        };
        // Same batch, same rule: a row that is absent or drifted is not a
        // number, and the pair is reported only when at least one of them
        // IS one — a zero ADD is never written, so an absent row means the
        // window has not reported yet rather than "nothing was answered".
        const listCacheHits = parseTelemetryCounter(
          tickState?.get(DEX_LIST_CACHE_HITS_KEY),
        );
        const listCacheMisses = parseTelemetryCounter(
          tickState?.get(DEX_LIST_CACHE_MISSES_KEY),
        );
        const listCacheRefused = parseTelemetryCounter(
          tickState?.get(DEX_LIST_CACHE_REFUSED_KEY),
        );
        if (
          telemetryCounterUsable(listCacheHits) ||
          telemetryCounterUsable(listCacheMisses) ||
          // A lane that has ONLY ever been refused is the reading this row was
          // added for (2026-09-30): gating on the two 2xx counters alone would
          // publish null for exactly the state the operator needs to see.
          telemetryCounterUsable(listCacheRefused)
        ) {
          const hits = telemetryCounterUsable(listCacheHits) ? listCacheHits : 0;
          const misses = telemetryCounterUsable(listCacheMisses)
            ? listCacheMisses
            : 0;
          const refused = telemetryCounterUsable(listCacheRefused)
            ? listCacheRefused
            : 0;
          const answered = hits + misses;
          dexListCache = {
            hits,
            misses,
            refused,
            hitPct:
              answered > 0 ? +((hits / answered) * 100).toFixed(1) : null,
            lastStatus: tickState?.get(DEX_LIST_CACHE_LAST_KEY) ?? null,
          };
        }
      } catch {
        // telemetry only — never fail /health over the reads
      }
      return Response.json({
        ok: true,
        scanCount,
        lastScanOk,
        lastScanAt: lastScanAt ? new Date(lastScanAt).toISOString() : null,
        dbReady,
        botReady,
        scannerReady,
        heliusConfigured,
        birdeyeConfigured,
        gmgnConfigured,
        arkhamConfigured,
        crimeWalletsConfigured,
        walletAnalyzerConfigured,
        axiomConfigured,
        tradeConfigured,
        jupiterKeyed,
        crimeWallets: crimeWallets?.status ?? null,
        tradeMode: effectiveTradeMode,
        tradeModeOverride,
        adminConfigured: (cfg?.adminIds.length ?? 0) > 0,
        initError,
        lastScanMs,
        lastScanError,
        scheduledTicks,
        scheduledTickTotal,
        scheduledTickAt: scheduledTickAt
          ? new Date(scheduledTickAt).toISOString()
          : null,
        // Pre-init arrival stamps (see Db.stampScheduledArrival): the counter
        // only moves for an arrival whose predecessor never returned, so a
        // rising total WHILE scheduledTickAt stands still is the "cron is
        // delivering and the ticks die in front of their claim" reading.
        scheduledArrivalTotal,
        scheduledArrivalAt: scheduledArrivalAt
          ? new Date(scheduledArrivalAt).toISOString()
          : null,
        scheduledArrivalUnaccounted:
          scheduledArrivalAt !== null &&
          (scheduledTickAt === null || scheduledArrivalAt > scheduledTickAt),
        // The number behind that boolean, and the one a monitor can alert
        // on: how long since a cron tick last CLAIMED. A healthy 60s
        // cadence reads ~60-120s; the 2h35m it read on 2026-09-24
        // (20:06:20 → 22:41:20) was a ring hole — cron deliveries arriving,
        // every tick dying inside init, scans still landing from the HTTP
        // fallback, so the heartbeat stayed green and NOTHING flagged it
        // (see shouldStampArrival's own note on the 2026-09-23 holes).
        scheduledTickHoleMs: healthAgeMs(Date.now(), scheduledTickAt),
        enabledChats,
        tokenStatsCount,
        pushedTotal,
        birdeyeCu,
        dexListCache,
        // WHY the last deferred write failed (method + error + when + how many
        // were waiting). This is the answer the field's absence asked for: live
        // 2026-09-24, `writeDrain {pending 47, totals {calls 57, ms 17759,
        // failures 38}}` with no cause on any public surface. The in-memory
        // mirror (`heartbeat.summary.writeDrain.lastError`) still reports the
        // same thing, but only for an isolate that has drained since.
        writeDrainError,
        // HOW OLD that record is (see healthAgeMs). `pending` inside it is
        // the queue size AT the failure, never the backlog now: a clean
        // drain writes nothing, so the row keeps the last failure's numbers
        // for as long as the bot stays healthy. Live 2026-09-24: it read
        // `pending 15` all day while its own `at` (11:58:37.643Z) sat 41
        // seconds BEFORE the commit that ended those failures — the age is
        // the one reading that says so.
        writeDrainErrorAgeMs: healthAgeMs(
          Date.now(),
          writeDrainError === null ? null : writeDrainError.at,
        ),
        // ...and whether that record still describes an ACTIVE failure. The
        // row is a snapshot only a FAILURE rewrites, so after a recovery it
        // sat there for hours (live 2026-09-25: 8.4h, `pending 15`) and read
        // as live. The drain clears it on its own recovery (see
        // clearPersistedDrainError); this flag covers the cross-isolate case —
        // the isolate answering /health is not necessarily the one that
        // failed — so a stale record can never be read as a current one.
        // The SAME threshold the retire above applies (see drainErrorIsStale),
        // so a row this handler would delete can never be the one the flag
        // calls live. null keeps its old meaning ("no usable record") — an
        // unreadable row must not read as a boolean either way.
        writeDrainErrorStale:
          writeDrainError === null || !(Number(writeDrainError.at) > 0)
            ? null
            : drainErrorIsStale(writeDrainError, Date.now()),
        lastSkip: scanner?.lastSkip ?? null,
        scanRunning,
        // Cross-isolate single-flight: how often this isolate skipped a
        // scan because another isolate held the lock (expected to rise when
        // cron + the HTTP fallback would previously have double-scanned).
        scanLockSkips: crossIsolateScanSkips,
        // Dead-tick backfills: how many predecessor ticks died before their
        // completion flush and had their scan_history row written by the
        // next tick (see BACKFILL_STALE_MS). Rising while lastScanGapMs
        // stays low = history self-healing instead of holes.
        backfilledTicks,
        // Wedged-isolate circuit breaker: current consecutive-dead-tick
        // streak (0 = healthy) and how many times this isolate rebuilt its
        // module-scoped clients after a streak tripped (see
        // DEAD_TICK_STREAK_RESET). A rising reset count with a low streak
        // means the breaker is doing its job; a streak pinned at the
        // threshold means the rebuild itself is not fixing the wedge.
        deadTickStreak,
        wedgedStateResets,
        crossIsolateScanSkips,
        heartbeat,
        lastScanGapMs,
        // The tick's own last pre-flush record: its `at` matches the
        // heartbeat's when the tick reached its flush, and its `stage` says
        // whether that flush then failed or hung (see TICK_PROGRESS_KEY).
        // A stale phase=scanning heartbeat with `prog none`/null here is the
        // other shape — the death was earlier than the flush.
        tickProgress,
        summary: scanner?.lastSummary ?? null,
        pushWatchPass,
        now: new Date().toISOString(),
      });
    }

    // Scan-history + cron-delivery forensics — the page the outage alert
    // links to. Dumps the last N scan_history rows with gaps > 2 min
    // flagged, plus the scheduled-tick ring: if the ring kept ticking
    // during a heartbeat gap, cron delivered and the ticks died before
    // writing the heartbeat (init stall / wall-clock kill / DB write
    // failure); if the ring itself has the gap, the Cron Trigger paused
    // (best-effort delivery — the documented 2026-08-14 / 2026-09-03
    // behavior). ?rows=N overrides the default 120.
    if (url.pathname === "/debug/scan-history") {
      try {
        const limit = Math.min(
          500,
          Math.max(10, Number(url.searchParams.get("rows") ?? 120) || 120),
        );
        const rows = (await db?.getScanHistory(limit)) ?? [];
        const gaps: Array<{ from: string; to: string; gapSec: number }> = [];
        for (let i = 1; i < rows.length; i++) {
          const gapSec = (rows[i - 1].at - rows[i].at) / 1000;
          if (gapSec > 120) {
            gaps.push({
              from: new Date(rows[i - 1].at).toISOString(),
              to: new Date(rows[i].at).toISOString(),
              gapSec: Math.round(gapSec),
            });
          }
        }
        let ring: number[] = [];
        let scheduledTickTotal: number | null = null;
        let scheduledTickAt: number | null = null;
        let scheduledArrivalTotal: number | null = null;
        let scheduledArrivalAt: number | null = null;
        let outageAlertAt: number | null = null;
        // The last tracker pass's coverage line, as persisted by the pass
        // itself (see Scanner.runTrackerPass): the stage split that explains
        // HOW a rotation tick was spent, on the page built for exactly this
        // kind of forensics. In-memory carrying reached /health only when the
        // next tick landed on the same isolate (rare in practice), which is
        // why the 2026-09-21 stall had no stage split to read.
        let pushWatchPass: unknown = null;
        try {
          // ONE read for all of these (was five subrequests): this page is the
          // forensics tool for the arrival question below, so the pre-init stamp
          // belongs here next to the ring it explains.
          const state = await db?.getWorkerStates([
            "scheduled_tick_ring",
            "scheduled_tick_total",
            "scheduled_tick_at",
            "scheduled_arrival_total",
            "scheduled_arrival_at",
            "outage_alert_at",
            "push_watch_pass",
          ]);
          const rawRing = state?.get("scheduled_tick_ring") ?? null;
          if (rawRing) {
            const parsed = JSON.parse(rawRing) as unknown;
            if (Array.isArray(parsed)) {
              ring = parsed.filter((v): v is number => typeof v === "number");
            }
          }
          const rawTotal = state?.get("scheduled_tick_total") ?? null;
          const rawAt = state?.get("scheduled_tick_at") ?? null;
          const rawArrivalTotal = state?.get("scheduled_arrival_total") ?? null;
          const rawArrivalAt = state?.get("scheduled_arrival_at") ?? null;
          const rawAlert = state?.get("outage_alert_at") ?? null;
          const rawPass = state?.get("push_watch_pass") ?? null;
          scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;
          scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;
          scheduledArrivalTotal = rawArrivalTotal ? parseInt(rawArrivalTotal, 10) || 0 : null;
          scheduledArrivalAt = rawArrivalAt ? parseInt(rawArrivalAt, 10) || 0 : null;
          outageAlertAt = rawAlert ? Number(rawAlert) : null;
          pushWatchPass = rawPass ? JSON.parse(rawPass) : null;
        } catch {
          // telemetry only — never fail the endpoint over these reads
        }
        return Response.json({
          ok: true,
          now: new Date().toISOString(),
          count: rows.length,
          rows: rows.map((r) => ({
            at: new Date(r.at).toISOString(),
            ok: r.ok,
            ms: r.ms,
            err: r.err,
            profiles: r.profiles,
            pool: r.pool,
            candidates: r.candidates,
            pushed: r.pushed,
          })),
          gaps: gaps.slice(0, 20),
          pushWatchPass,
          scheduledTickTotal,
          scheduledTickAt: scheduledTickAt
            ? new Date(scheduledTickAt).toISOString()
            : null,
          // The pre-init arrival stamps: the ring can only record an arrival
          // that reached a claim, so a ring hole is ambiguous on its own —
          // `scheduledArrivalTotal` rising while the ring stands still is the
          // half that says the delivery happened (see
          // Db.stampScheduledArrival).
          scheduledArrivalTotal,
          scheduledArrivalAt: scheduledArrivalAt
            ? new Date(scheduledArrivalAt).toISOString()
            : null,
          scheduledArrivalUnaccounted:
            scheduledArrivalAt !== null &&
            (scheduledTickAt === null || scheduledArrivalAt > scheduledTickAt),
          // Newest first; a missing minute here while scan rows exist is
          // the cross-check for "cron delivered but ticks died".
          tickRing: ring
            .slice(-90)
            .reverse()
            .map((t) => new Date(t).toISOString()),
          outageAlertAt: outageAlertAt
            ? new Date(outageAlertAt).toISOString()
            : null,
        });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // PER-TICK LEG RING (see TickLegRow): the last ticks of THIS isolate with
    // the leg split the durable rows cannot carry — the front's preStart/
    // preRace/steps, every scan leg (feeds/pool/poolWait/poolLegMs/pairs/
    // pairs-jup/eval/db), the counters, the cut note and the subrequest
    // spend. The 2026-10-02 429-storm slow ticks (8-14s, 00:49-01:06Z) could
    // not be attributed after the fact because the split lived only in
    // /health's latest-tick fields; this route is where it survives (per
    // isolate, capacity TICK_LEG_RING_SIZE, newest first, ?rows=N to size the
    // answer).
    if (url.pathname === "/debug/tick-legs") {
      const limit = Math.min(
        TICK_LEG_RING_SIZE,
        Math.max(1, Number(url.searchParams.get("rows") ?? 60) || 60),
      );
      // The durable half (see TICK_LEG_SLOW_KEY): `rows` is THIS isolate's
      // in-memory ring, `slow` is the fleet's last TICK_LEG_SLOW_RING_SIZE
      // slow ticks (>= TICK_LEG_SLOW_MS), newest first — the half that still
      // answers when the request lands on an isolate that never ticked.
      let slow: TickLegRow[] = [];
      try {
        const raw = await db?.getWorkerState(TICK_LEG_SLOW_KEY);
        slow = parseTickLegRing(raw ?? null).reverse();
      } catch {
        // Debug route: an unreadable durable ring must not fail the
        // in-memory half.
      }
      return Response.json({
        ok: true,
        now: new Date().toISOString(),
        count: tickLegRingSize(),
        capacity: TICK_LEG_RING_SIZE,
        slowMs: TICK_LEG_SLOW_MS,
        slowCapacity: TICK_LEG_SLOW_RING_SIZE,
        rows: tickLegRows(limit),
        slow,
      });
    }

    // GMGN connectivity probe — calls the real client from the worker's own
    // egress so a "gmgn feed 0" can be diagnosed as blocked (403/challenge),
    // rate-limited, or a parser mismatch without guessing.
    if (url.pathname === "/debug/gmgn") {
      const client = gmgn;
      if (!client) {
        return Response.json({ ok: false, error: "GMGN not configured" });
      }
      try {
        const t0 = Date.now();
        const items = await client.fetchTrending(5);
        return Response.json({
          ok: true,
          count: items.length,
          ms: Date.now() - t0,
          sample: items.slice(0, 3).map((i) => ({
            symbol: i.symbol,
            mcap: i.marketCap,
            smart: i.smartDegenCount,
            wash: i.isWashTrading,
          })),
        });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Arkham smart-money probe — verifies the real holders response shape
    // from the worker's own egress with the stored key (diagnoses a card
    // line of 未配置 vs a 4xx auth issue vs a parser mismatch). ?address=
    // is a Solana token mint; ?raw=1 dumps the parsed holders.
    if (url.pathname === "/debug/arkham") {
      const client = arkham;
      const mint = (url.searchParams.get("address") ?? "").trim();
      if (!client) {
        return Response.json({ ok: false, error: "ARKHAM_API_KEY 未配置" });
      }
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return Response.json({ ok: false, error: "missing/invalid ?address=" }, { status: 400 });
      }
      try {
        const t0 = Date.now();
        const holders = await client.fetchTokenHolders(mint);
        return Response.json({
          ok: true,
          ms: Date.now() - t0,
          holderCount: holders?.holderCount ?? 0,
          smartMoneyCount: holders?.smartMoney.length ?? 0,
          smartMoney: holders?.smartMoney.slice(0, 5).map((h) => ({
            name: h.entityName,
            type: h.entityType,
            pct: h.pctOfCap === null ? null : +(h.pctOfCap * 100).toFixed(2),
          })),
        });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Crime-wallet blocklist status — whether the community list is loaded
    // in this isolate, its size, the last refresh error, and the persisted
    // refresh time from worker_state. ?refresh=1 forces a re-fetch (the
    // first load happens automatically on the next scan tick otherwise).
    if (url.pathname === "/debug/crime-wallets") {
      const client = crimeWallets;
      if (!client) {
        return Response.json({
          ok: false,
          error: "crime-wallets disabled (CRIME_WALLETS_ENABLED=false)",
        });
      }
      let refreshed: { ok: boolean; size: number } | null = null;
      if (url.searchParams.get("refresh") === "1") {
        refreshed = await client.refreshIfStale(true);
      }
      let persistedUpdatedAt: number | null = null;
      try {
        const raw = await db?.getWorkerState("crime_wallets_updated_at");
        persistedUpdatedAt = raw ? Number(raw) : null;
      } catch {
        // telemetry only
      }
      return Response.json({
        ok: true,
        enabled: true,
        ...client.status,
        persistedUpdatedAt,
        refreshed,
      });
    }

    // /debug/holder-clusters — cross-coin wallet clustering diagnostics
    // (wallet analysis feature C): every wallet that appeared as a top
    // holder (or creator) of >= minCoins distinct pushed coins in the last
    // `days` days, ranked by coin count then recency. This is the live
    // global view of the same data the push card's 🔁 關聯錢包 line uses —
    // the way to spot coordinated wallets that are not (yet) on any list.
    if (url.pathname === "/debug/holder-clusters") {
      if (!db) {
        return Response.json({ ok: false, error: "TURSO not configured" });
      }
      const minCoins = Math.max(1, Number(url.searchParams.get("minCoins") ?? 2));
      const days = Math.max(1, Number(url.searchParams.get("days") ?? 14));
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25)));
      try {
        const clusters = await db.getGlobalHolderClusters(
          Date.now() - days * 24 * 3600_000,
          minCoins,
          limit,
        );
        return Response.json({
          ok: true,
          windowDays: days,
          minCoins,
          count: clusters.length,
          clusters,
        });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // The five /debug/axiom-* probes were removed 2026-09-29: Axiom is off
    // (AXIOM_ENABLED=0), and /debug/axiom-tokens was an unauthenticated write
    // of a session token straight into worker_state.

    // GeckoTerminal trending probe — ground truth for the momentum feed:
    // reports the raw HTTP status + parse count so a persistent geoTrend: 0
    // is diagnosable as rate-limited (429), changed shape, or empty feed.
    if (url.pathname === "/debug/gecko-trending") {
      const res = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token&limit=20`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) },
      );
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // non-JSON body
      }
      const items = (parsed as { data?: unknown[] } | null)?.data ?? [];
      return Response.json({
        ok: res.ok,
        status: res.status,
        rawBytes: text.length,
        count: Array.isArray(items) ? items.length : 0,
        bodyPreview: text.slice(0, 200),
      });
    }

    // Alternate-host probe (see GECKO_ALT_BASE_URL): the gecko fallback asks
    // CoinGecko's Onchain API when the primary is paused. Deployed 2026-09-21,
    // the worker's own egress got **403** there while a normal host gets 200 —
    // and the body said why: `Please add a descriptive User-Agent`. So this
    // fetches the same URL three ways — with the client's UA, without it, and
    // with it plus the Cloudflare cache options — which rules one variable out
    // at a time instead of guessing.
    if (url.pathname === "/debug/gecko-alt") {
      const target = `${GECKO_ALT_BASE_URL}/networks/solana/new_pools?page=1`;
      const probe = async (withUa: boolean, withCache: boolean) => {
        try {
          const headers: Record<string, string> = { Accept: "application/json" };
          if (withUa) headers["User-Agent"] = GECKO_USER_AGENT;
          const init: Record<string, unknown> = {
            headers,
            signal: AbortSignal.timeout(10_000),
          };
          if (withCache) {
            init.cf = {
              cacheEverything: true,
              cacheTtl: GECKO_CACHE_TTL_S,
              cacheTtlByStatus: { "200-299": GECKO_CACHE_TTL_S, "300-399": 0, "400-599": 0 },
            };
          }
          const res = await fetch(target, init as RequestInit);
          const text = await res.text();
          let items: unknown[] = [];
          try {
            const parsed = JSON.parse(text) as { data?: unknown[] };
            items = Array.isArray(parsed?.data) ? parsed.data : [];
          } catch {
            // non-JSON body
          }
          return {
            status: res.status,
            ok: res.ok,
            cacheStatus: res.headers.get("cf-cache-status"),
            contentType: res.headers.get("content-type"),
            rawBytes: text.length,
            count: items.length,
            bodyPreview: text.slice(0, 200),
          };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      };
      const [ua, noUa, uaCached] = await Promise.all([
        probe(true, false),
        probe(false, false),
        probe(true, true),
      ]);
      return Response.json({ target, userAgent: GECKO_USER_AGENT, ua, noUa, uaCached });
    }

    // KEYED-HOST PROBE (2026-10-04): which (host, key-header) pairing the
    // DEPLOYED CoinGecko key is actually accepted on.
    //
    // WHY: /health can say the primary 429-walls while the alt answered 401,
    // but it cannot say WHICH refusal the key itself caused. The client sends
    // exactly ONE header — x-cg-demo-api-key or x-cg-pro-api-key, chosen by
    // COINGECKO_API_PLAN (`demo` by default) — so a plan/key mismatch is
    // invisible from the counters: a demo key sent as pro (or the reverse) is
    // refused at every host while `summary.gecko` only shows the refusal. This
    // route replays the deployed key through every Host × Header pair, so the
    // pair answering 200 names the key's real plan — and the pair the client
    // SHOULD be sending. It also echoes the configured plan/header NAMES (never
    // the key itself), which is how a dashboard-only COINGECKO_API_PLAN var is
    // confirmed from the outside.
    //
    // `?mint=<address>` adds the post-push snapshot path (the tracker's leg),
    // because a path can be refused differently from new_pools — the 401 this
    // route was built for was read off whichever leg asked last.
    //
    // `?bust=1` appends a unique `cb=` value, so every reading is an ORIGIN
    // answer: without it the first matrix came back `cf-cache-status: HIT` for
    // every variant — keyed, keyless and both headers alike — because
    // CoinGecko publishes `s-maxage=60` and the cache answers before any auth
    // is checked. A cached 200 proves nothing about the key; a busted one is
    // the only route to the 401/429 the feed actually hits.
    //
    // Read-only: raw fetches, no client counters, no backoff state, no cache —
    // the same contract as /debug/gecko-alt. Keyed variants spend a few calls
    // of the key's quota.
    if (url.pathname === "/debug/gecko-key") {
      const key = cfg?.coingeckoApiKey ?? null;
      const plan = cfg?.coingeckoApiPlan ?? "demo";
      const configuredHeader =
        plan === "pro" ? COINGECKO_PRO_HEADER : COINGECKO_DEMO_HEADER;
      const mint = (url.searchParams.get("mint") ?? "").trim();
      const bust = url.searchParams.get("bust") === "1" ? `&cb=${Date.now()}` : "";
      // `?seq=1` serialises the requests with a gap instead of firing them in
      // parallel. WHY: the first busted run sent 4 parallel probes per host and
      // EVERY primary variant came back 429 — which its own keyless reading
      // already produces, so a self-inflicted burst would be indistinguishable
      // from the wall the feed actually hits. `?only=demo` narrows the set the
      // same way when one pairing is the question.
      const seq = url.searchParams.get("seq") === "1";
      const allVariants = ["configured", "demo", "pro", "keyless", "param-demo", "param-pro"];
      const only = (url.searchParams.get("only") ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter((v) => allVariants.includes(v));
      const variants = only.length > 0 ? only : allVariants;
      const hosts: Array<{ host: string; base: string }> = [
        { host: "primary", base: "https://api.geckoterminal.com/api/v2" },
        { host: "alt-public", base: GECKO_ALT_BASE_URL },
        { host: "alt-pro", base: "https://pro-api.coingecko.com/api/v3/onchain" },
      ];
      // Certainly-not-secret shape facts about the stored key: a mangled secret
      // (quotes, an embedded newline/space, a truncated paste) is refused with
      // the same 401 as a valid-but-wrong-plan key, and the two need different
      // fixes. Booleans + lengths only — no key material.
      const keyShape = key === null
        ? null
        : {
            length: key.length,
            trimmedLength: key.trim().length,
            startsWithCG: key.startsWith("CG-"),
            alnumDashOnly: /^[A-Za-z0-9-]+$/.test(key),
          };
      // The header each variant sends: `configured` is what the client sends
      // today, `demo`/`pro` isolate the header question, `keyless` is the
      // baseline (a clean keyless reading proves the host serves the path at
      // all — the 2026-10-04 storm reads keyless as 429, never as 401), and the
      // `param-*` pair asks whether CoinGecko wants the key in the QUERY for
      // this path (`?x_cg_demo_api_key=`) instead of a header — the docs' other
      // supported form, untested until now.
      const headerFor = (label: string): string | null => {
        if (label === "keyless" || label.startsWith("param-")) return null;
        if (label === "configured") return configuredHeader;
        return label === "pro" ? COINGECKO_PRO_HEADER : COINGECKO_DEMO_HEADER;
      };
      const paramFor = (label: string): string | null =>
        label === "param-demo"
          ? "x_cg_demo_api_key"
          : label === "param-pro"
            ? "x_cg_pro_api_key"
            : null;
      const probe = async (base: string, path: string, label: string) => {
        const name = headerFor(label);
        const param = paramFor(label);
        const headers: Record<string, string> = {
          Accept: "application/json",
          "User-Agent": GECKO_USER_AGENT,
        };
        if (name !== null && key !== null) headers[name] = key;
        const target =
          param !== null && key !== null
            ? `${base}${path}${path.includes("?") ? "&" : "?"}${param}=${encodeURIComponent(key)}`
            : `${base}${path}`;
        try {
          const res = await fetch(target, {
            headers,
            signal: AbortSignal.timeout(10_000),
          });
          const text = await res.text();
          let count: number | null = null;
          let apiError: unknown = null;
          try {
            const parsed = JSON.parse(text) as {
              data?: unknown[];
              status?: unknown;
              title?: unknown;
            };
            count = Array.isArray(parsed?.data) ? parsed.data.length : null;
            const st = parsed?.status;
            apiError =
              st !== null && typeof st === "object"
                ? {
                    errorCode: (st as { error_code?: unknown }).error_code ?? null,
                    errorMessage:
                      (st as { error_message?: unknown }).error_message ?? null,
                  }
                : (st ?? parsed?.title ?? null);
          } catch {
            // non-JSON body
          }
          return {
            header: name,
            query: param,
            status: res.status,
            ok: res.ok,
            cacheStatus: res.headers.get("cf-cache-status"),
            count,
            apiError,
          };
        } catch (err) {
          return {
            header: name,
            query: param,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      };
      const run = async (base: string, path: string): Promise<Record<string, unknown>> => {
        const out: Record<string, unknown> = {};
        if (seq) {
          for (const v of variants) {
            out[v] = await probe(base, path, v);
            await new Promise((r) => setTimeout(r, 1_200));
          }
          return out;
        }
        await Promise.all(
          variants.map(async (v) => {
            out[v] = await probe(base, path, v);
          }),
        );
        return out;
      };
      const matrix: Array<Record<string, unknown>> = [];
      for (const h of hosts) {
        const row: Record<string, unknown> = {
          host: h.host,
          base: h.base,
          newPools: await run(h.base, `/networks/solana/new_pools?page=1${bust}`),
        };
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
          row.snapshot = await probe(
            h.base,
            `/networks/solana/tokens/${mint}${bust}`,
            "configured",
          );
        }
        matrix.push(row);
      }
      return Response.json({
        ok: true,
        keyed: key !== null,
        plan,
        configuredHeader,
        busted: bust !== "",
        sequential: seq,
        variants,
        keyShape,
        matrix,
      });
    }

    // Discovery-source probe: every candidate "new pools / new coins" feed is
    // reachable from a normal host, but the WORKER'S OWN EGRESS is the only
    // placement that counts — gecko's alternate host looked fine from a clean
    // host and answered 403/429 from here (see docs/gecko-429.md). Each
    // candidate is reported with its status, size, item count and, when the
    // payload carries one, the age of its newest coin, so a source is picked on
    // measurement instead of reputation.
    //
    // Raydium and Orca are included to show WHY they cannot serve this: neither
    // exposes a creation-time order (their own specs list only liquidity /
    // volume / fee / apr / tvl — Raydium's `/pools/info/list-v2?sortField=` and
    // Orca's `?sortBy=` reject anything else), so there is no way to ask either
    // one for "the newest pools". Meteora's public DLMM/DAMM hosts answer 404
    // from a clean host, which is why it is only probed, never wired.
    if (url.pathname === "/debug/pool-source") {
      type ProbeReport = Record<string, unknown>;
      const probe = async (
        label: string,
        target: string,
        pick: (json: unknown) => ProbeReport,
        // A COMPARISON TARGET is allowed to be dead on purpose. Some entries
        // below exist only to keep a replacement host's reading comparable
        // (the legacy pump.fun host is the live example), and their failure is
        // the documented state rather than an alarm — so a probe that says so
        // tags EVERY non-200 answer with `expected: true` + the reason, and a
        // reader (or a monitor) can tell a deliberately dead control apart
        // from a live feed that actually broke.
        expectedDead?: string,
      ): Promise<ProbeReport> => {
        const dead = (rep: ProbeReport): ProbeReport =>
          expectedDead === undefined
            ? rep
            : { ...rep, expected: true, expectedNote: expectedDead };
        try {
          const res = await fetch(target, {
            headers: { Accept: "application/json", "User-Agent": GECKO_USER_AGENT },
            signal: AbortSignal.timeout(10_000),
          });
          const text = await res.text();
          if (!res.ok) {
            return dead({ label, status: res.status, bytes: text.length, body: text.slice(0, 120) });
          }
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // non-JSON body (challenge page / HTML)
            return dead({ label, status: res.status, bytes: text.length, body: text.slice(0, 120) });
          }
          return { label, status: res.status, bytes: text.length, ...pick(parsed) };
        } catch (err) {
          return dead({ label, error: err instanceof Error ? err.message : String(err) });
        }
      };
      // pump.fun rows carry `created_timestamp` in ms → the age of the newest
      // coin is the freshness proof for a launch feed.
      const coins = (json: unknown): ProbeReport => {
        const rows = Array.isArray(json) ? json : [];
        const times = rows
          .map((r) => Number((r as { created_timestamp?: number } | null)?.created_timestamp))
          .filter((n) => Number.isFinite(n) && n > 0);
        const newest = times.length > 0 ? Math.max(...times) : 0;
        return {
          count: rows.length,
          newestAgeS: newest > 0 ? Math.round((Date.now() - newest) / 1000) : null,
        };
      };
      // GeckoTerminal-shaped envelopes (`data: []`) and DexScreener arrays.
      const envelope = (json: unknown): ProbeReport => {
        const data = (json as { data?: unknown } | null)?.data;
        return { count: Array.isArray(data) ? data.length : 0 };
      };
      const solanaBoosts = (json: unknown): ProbeReport => {
        const rows = Array.isArray(json) ? json : [];
        return {
          count: rows.filter((r) => (r as { chainId?: string } | null)?.chainId === "solana")
            .length,
        };
      };
      // Meteora's CURRENT Data API host. The old `dlmm-api.meteora.ag`
      // answers 404 to EVERY path, root included (measured 2026-09-21), which
      // is why this source was previously written off as "does not exist" —
      // the docs now publish `dlmm.datapi.meteora.ag` / `damm-v2.datapi.meteora.ag`.
      // Rows live under `data[]` with `created_at` in ms, the pool's two sides
      // under `token_x` / `token_y`, and the endpoint sorts server-side by
      // `sort_by=pool_created_at:desc` — i.e. it can answer "the newest pools",
      // which Raydium and Orca both cannot. Wrapped SOL is quoted on every
      // launch pool, so the OTHER side is the mint a caller would register.
      const pools = (json: unknown): ProbeReport => {
        const raw = (json as { data?: unknown } | null)?.data;
        const list = (Array.isArray(raw) ? raw : []) as Array<{
          created_at?: number;
          launchpad?: string | null;
          tvl?: number | null;
          token_x?: { address?: string } | null;
          token_y?: { address?: string } | null;
        }>;
        const times = list
          .map((r) => Number(r?.created_at))
          .filter((n) => Number.isFinite(n) && n > 0);
        const newest = times.length > 0 ? Math.max(...times) : 0;
        const head = list.find((r) => Number(r?.created_at) === newest) ?? list[0];
        const quote = "So11111111111111111111111111111111111111112";
        const xs = head?.token_x?.address;
        const ys = head?.token_y?.address;
        return {
          count: list.length,
          newestAgeS: newest > 0 ? Math.round((Date.now() - newest) / 1000) : null,
          newestMint: (xs === quote ? ys : xs)?.slice(0, 12) ?? null,
          newestLaunchpad: head?.launchpad ?? null,
          newestTvl: head?.tvl ?? null,
        };
      };
      const results = await Promise.all([
        probe(
          "pumpfun-v3",
          "https://frontend-api-v3.pump.fun/coins?limit=20&offset=0&sort=created_timestamp&order=DESC",
          coins,
        ),
        // DEAD ON PURPOSE (2026-09-21): the host this client used BEFORE v3
        // answers 530 / Cloudflare error 1016 (origin DNS gone), and it is kept
        // here as the comparison that makes pumpfun-v3's 200 mean something —
        // production never calls it, because src/pumpfun.ts's BASE_URL is the
        // v3 host (see that file's header). Marked expected-dead so the 530
        // reads as the documented control it is instead of as a feed that
        // broke.
        probe(
          "pumpfun-legacy",
          "https://frontend-api.pump.fun/coins?limit=20&offset=0",
          coins,
          "legacy host — 530 / CF error 1016 since 2026-09-21; production uses the v3 host (src/pumpfun.ts BASE_URL)",
        ),
        probe(
          "dexscreener-boosts",
          "https://api.dexscreener.com/token-boosts/latest/v1",
          solanaBoosts,
        ),
        probe(
          "raydium-list-v2",
          "https://api-v3.raydium.io/pools/info/list-v2?poolType=Standard&size=5&sortField=liquidity&sortType=desc",
          envelope,
        ),
        probe("orca-pools", "https://api.orca.so/v2/solana/pools?limit=3", envelope),
        probe(
          "meteora-dlmm-old-host",
          "https://dlmm-api.meteora.ag/pair/all_by_groups?page=0&limit=5",
          envelope,
        ),
        probe(
          "meteora-damm-v2",
          "https://damm-v2.datapi.meteora.ag/pools?page=1&page_size=10&sort_by=pool_created_at:desc",
          pools,
        ),
        probe(
          "meteora-dlmm",
          "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=10&sort_by=pool_created_at:desc",
          pools,
        ),
        probe(
          "meteora-dbc",
          "https://dbc.datapi.meteora.ag/pools?page=1&page_size=10&sort_by=pool_created_at:desc",
          pools,
        ),
      ]);
      return Response.json({ ok: true, results });
    }

    // Jupiter Token v2 feed probe — verifies the discovery client's two
    // endpoints from the worker's own egress (recent launchpad launches +
    // 24h trending). Pass ?raw=1 to include the first parsed profiles.
    if (url.pathname === "/debug/jupiter") {
      if (!cfg) return Response.json({ ok: false, error: "not initialized" });
      const client = new JupTokensClient(cfg);
      // ?organic=<mint> — the push card's 🌱 有機度 reading, asked from the
      // WORKER's own egress (2026-09-26). The card line is display-only and
      // best-effort, so a missing line has two possible halves: no window in
      // the tick, or no data from this egress. This answers the second one
      // with the same call the scanner makes, plus its latency — one request
      // instead of another push-and-wait cycle.
      const organicMint = (url.searchParams.get("organic") ?? "").trim();
      if (organicMint) {
        const t0 = Date.now();
        const reading = await client.fetchOrganicScore(organicMint);
        return Response.json({
          ok: reading !== null,
          mint: organicMint,
          ms: Date.now() - t0,
          reading,
        });
      }
      const [recent, trending] = await Promise.all([
        client.fetchRecentTokens(5),
        client.fetchTrendingTokens(5),
      ]);
      return Response.json({
        ok: recent.length > 0 || trending.length > 0,
        recent: recent.length,
        trending: trending.length,
        sample:
          url.searchParams.get("raw") === "1"
            ? { recent: recent.slice(0, 3), trending: trending.slice(0, 3) }
            : undefined,
      });
    }

    // Birdeye token-overview probe — verifies the real holders response
    // shape from the worker's own egress (the schema isn't published, so
    // this lets a card-line "—" be diagnosed as missing data vs a parser
    // mismatch). Creator is verified separately via /debug/flow or a
    // RugCheck report (creator isn't in the Birdeye free-tier endpoints).
    if (url.pathname === "/debug/birdeye-overview") {
      const mint = (url.searchParams.get("address") ?? "").trim();
      if (!mint) {
        return Response.json({ ok: false, error: "missing ?address=" });
      }
      if (!birdeye) {
        return Response.json({ ok: false, error: "Birdeye not configured" });
      }
      try {
        const t0 = Date.now();
        const info = await birdeye.getTokenOverview(mint);
        return Response.json({
          ok: true,
          ms: Date.now() - t0,
          holderCount: info.holderCount,
        });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Post-push watch list — the tracker's current rows (peak vs push mcap,
    // holder growth, alert bookkeeping) for verifying follow-ups work.
    if (url.pathname === "/debug/push-watch") {
      // ?mint=<address> tombstones that row (same as the 🔕 button) — for
      // cards whose keyboard was already cleared before a tap could land.
      const mint = url.searchParams.get("mint");
      if (mint && request.method === "POST") {
        if (!db) return Response.json({ ok: false, error: "no db" });
        await db.setPushWatchState(mint, "unwatched");
        return Response.json({ ok: true, unwatched: mint });
      }
      // POST ?repair=<address> — apply the documented repair to ONE row whose
      // terminal state disagrees with the write that produced it (see
      // pushwatch.terminalRowIssues: the pre-fix single-column terminalizer and
      // the dead-tick lost-completion class). Per-row on purpose, because a
      // repair can RE-ARM a row and there is no bulk lever for that. The delivery
      // audit decides which repair, exactly as the tracker's own settle does for
      // a cut terminal send: a card PROVED delivered keeps the transition and
      // only re-stamps the alert clock (inert — a 'rug' row is never
      // re-evaluated); an unproved one is re-armed so the 💧 condition is
      // re-derived instead of the row sitting silent for good.
      const repair = url.searchParams.get("repair");
      if (repair && request.method === "POST") {
        if (!db) return Response.json({ ok: false, error: "no db" });
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(repair)) {
          return Response.json({ ok: false, error: "invalid mint" }, { status: 400 });
        }
        const row = (await db.listPushWatch(500)).find((r) => r.token === repair);
        if (!row) return Response.json({ ok: false, error: "not tracked" });
        const rowIssues = terminalRowIssues(row);
        if (rowIssues.length === 0) {
          return Response.json({ ok: true, repaired: false, reason: "consistent" });
        }
        const proved = new Set(
          deliveredFollowupTokens(await db.getPushAudit()),
        ).has(repair);
        const plan = terminalRowRepair(rowIssues, proved);
        if (plan === "arm_alert_clock") {
          const done = await db.armTerminalAlertClock(repair);
          return Response.json({ ok: true, repaired: done, plan, proved, issues: rowIssues });
        }
        if (plan === "restamp_completion") {
          const done = await db.restampTerminalCompletion(repair);
          return Response.json({ ok: true, repaired: done, plan, proved, issues: rowIssues });
        }
        if (plan === "re_arm_row") {
          const done = await db.rearmPushWatchAlert(repair);
          return Response.json({ ok: true, repaired: done, plan, proved, issues: rowIssues });
        }
        // A measurement that contradicts its own state is a stale number
        // rather than a wrong verdict. Reported for a human, never rewritten.
        return Response.json({ ok: true, repaired: false, plan, proved, manual: true, issues: rowIssues });
      }
      // ?limit=N widens the census past the 40-row default: rows can outlive the
      // 24h window (prune races the enrollment self-heal), so a fixed cap can
      // hide exactly the rows being audited. `issues` runs the same rule the
      // repair action applies, so ONE read answers "is anything inconsistent".
      const limitRaw = Number(url.searchParams.get("limit") ?? 40);
      const limit = Number.isFinite(limitRaw)
        ? Math.min(Math.max(Math.trunc(limitRaw), 1), 500)
        : 40;
      const rows = db ? await db.listPushWatch(limit) : [];
      const issues = rows
        .map((r) => ({
          token: r.token,
          symbol: r.symbol,
          lastState: r.lastState,
          lastChecked: r.lastChecked,
          lastAlertAt: r.lastAlertAt,
          lastLiquidity: r.lastLiquidity,
          issues: terminalRowIssues(r),
        }))
        .filter((r) => r.issues.length > 0);
      return Response.json({
        ok: true,
        count: rows.length,
        limit,
        issueCount: issues.length,
        // The muted card sigs (PUSH_WATCH_MUTE) THIS isolate booted with.
        // The pass note only shows ` muted N` once a muted transition fires,
        // so without this echo the switch's liveness would be unobservable
        // until then — and this is the reading that proves a redeploy landed.
        mutedSigs: cfg?.pushWatch.mutedSigs ?? [],
        // Birdeye holder probes allowed per pass (PUSH_WATCH_MAX_HOLDER_CHECKS),
        // 0 = the holder stage is switched off. Same reason as `mutedSigs`: with
        // the stage off there is no `probe`/`miss` movement in the note to read,
        // so this echo is what proves the redeploy that stopped the CU landed.
        maxHolderChecksPerTick: cfg?.pushWatch.maxHolderChecksPerTick ?? null,
        issues,
        rows: rows.map((r) => ({
          ...r,
          chgSincePushPct:
            r.mcapAtPush > 0
              ? Math.round((r.peakMcap / r.mcapAtPush - 1) * 1000) / 10
              : null,
        })),
      });
    }

    // POST /debug/resend?mint=<address> — re-deliver a compact card with
    // live data for pushes whose first card never arrived client-side
    // (XST / GLITCH / Félicette / RING). Keyboard included so tracking can
    // still be stopped from the re-sent card; audited as kind:"resend".
    if (url.pathname === "/debug/resend") {
      const mint = url.searchParams.get("mint") ?? "";
      if (request.method !== "POST") {
        return Response.json({ ok: false, error: "POST only" }, { status: 405 });
      }
      if (!bot || !dex || !db) {
        return Response.json({ ok: false, error: "not ready" }, { status: 503 });
      }
      const row = (await db.listPushWatch(40)).find((r) => r.token === mint);
      if (!row) {
        return Response.json({ ok: false, error: "not tracked" }, { status: 404 });
      }
      const pair = (await dex.fetchPairsForTokens([mint])).get(mint);
      if (!pair) {
        return Response.json({ ok: false, error: "no pair data" }, { status: 404 });
      }
      const usd = (n: number | null | undefined) =>
        n == null || !Number.isFinite(n)
          ? "—"
          : "$" + Math.round(n).toLocaleString("en-US");
      const pctStr = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
      const chg =
        row.mcapAtPush > 0 ? (pair.marketCap / row.mcapAtPush - 1) * 100 : null;
      const peakPct =
        row.mcapAtPush > 0 ? (row.peakMcap / row.mcapAtPush - 1) * 100 : null;
      // This card quotes `mcap_at_push` as 推送時. That column has three
      // writers (docs/push-baseline-ledger.md) and a revival is NOT the
      // push-time value, so a re-delivered card for a revived row must not
      // claim it is (see revivedBaseline).
      const baseLabel = revivedBaseline(String(row.upStages ?? "").split(","), row.mcapAtPush)
        ? "復活基準"
        : "推送時";
      const ageMin = Math.max(
        0,
        Math.round((Date.now() - pair.pairCreatedAt) / 60_000),
      );
      const text =
        `📤 補發推送 ${pair.baseToken.symbol}（${row.symbol ?? pair.baseToken.symbol}）\n` +
        `💰 市值 ${usd(pair.marketCap)}（${baseLabel} ${usd(row.mcapAtPush)}${chg === null ? "" : "，" + pctStr(chg)}）\n` +
        `📈 推送後峰值 ${pctStr(peakPct ?? 0)}\n` +
        `💧 流動性 ${usd(pair.liquidity.usd)} | ⏱ 年齡 ${ageMin} 分鐘\n` +
        `📊 5m量 ${usd(pair.volume.m5)} | 5m ${pctStr(pair.priceChange.m5)}\n` +
        `🔗 ${pair.url}`;
      const mode = (await trade?.effectiveMode()) ?? "off";
      const sent = await bot.api.sendMessage(row.chatId, text, {
        reply_markup: {
          inline_keyboard: tradeKeyboard(
            mint,
            trade?.buySizeLabel ?? "",
            mode,
            { modeSwitch: Boolean(trade), unwatch: true },
          ),
        },
      });
      try {
        await db.recordPushDelivery({
          chatId: row.chatId,
          token: mint,
          symbol: row.symbol,
          messageId: Number((sent as { message_id?: unknown }).message_id ?? 0),
          kind: "resend",
        });
      } catch {
        /* audit is best-effort */
      }
      return Response.json({ ok: true, resent: mint });
    }

    // Delivery audit ring: the last 30 successful initial push sends with
    // Telegram's message_id — answers "was the card actually sent?" with
    // hard evidence instead of inference (XST / GLITCH reports).
    if (url.pathname === "/debug/push-audit") {
      // ?token= (mint or a prefix), ?since= (epoch ms) and ?limit= turn the
      // ring into the ONE answer a "I never got the +200% notice" report
      // needs: WHICH of this coin's cards went out, and when. Read whole it
      // was minutes of history shared by every chat — live 2026-09-25,
      // parafactual's up400 card was its only surviving entry (see
      // PUSH_AUDIT_MAX in src/db.ts, raised to 200 by the same change).
      const rows = (await db?.getPushAudit()) ?? [];
      const token = url.searchParams.get("token");
      const since = Number(url.searchParams.get("since") ?? 0) || 0;
      const limit = Number(url.searchParams.get("limit") ?? 0) || 0;
      const matching = rows.filter(
        (r) =>
          (!token || r.token === token || r.token.startsWith(token)) &&
          (since === 0 || r.at >= since),
      );
      return Response.json({
        ok: true,
        count: limit > 0 ? Math.min(limit, matching.length) : matching.length,
        total: rows.length,
        rows: limit > 0 ? matching.slice(-limit) : matching,
      });
    }

    // Push history — read-only distribution of seen_tokens for diagnosing
    // "why is push volume low" (all pushes ever, grouped by day, oldest 20).
    if (url.pathname === "/debug/token") {
      const mint = url.searchParams.get("mint") ?? "";
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return Response.json({ ok: false, error: "invalid mint" }, { status: 400 });
      }
      try {
        const stats = await db?.getTokenStatsMany([mint]).then((m) => m.get(mint) ?? null);
        return Response.json({ ok: true, stats });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }
    if (url.pathname === "/debug/feed-stats") {
      // Durable TTL cache FIRST (see DEBUG_SCAN_CACHE_*): the read behind this
      // endpoint is a full-table scan of token_stats, so a poll loop must be
      // answered from the shared row rather than re-scanning per request.
      const cached = await readDebugScanCache<
        Array<{ feed: string; coins: number; pushed: number }>
      >("feed-stats");
      if (cached) {
        return Response.json({
          ok: true,
          byFeed: cached.body,
          cached: true,
          cacheAgeMs: cached.ageMs,
        });
      }
      try {
        const rows = await db?.getFeedAttribution();
        const body = rows ?? [];
        await writeDebugScanCache("feed-stats", body);
        return Response.json({ ok: true, byFeed: body, cached: false });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }
    // Deferred-card ledger probe (2026-09-26). One read-only request answers
    // both halves of "are the owed cards moving, and why not":
    //
    //  - `durable`: the row the whole fleet shares — the pending list, the
    //    cumulative counters (deferred/recovered/stalled/pruned) and the
    //    prune stamps. Re-read here rather than mirroring the tick's copy, so
    //    a cold isolate answers with the live row too.
    //  - `isolate`: THIS isolate's registry — how long each owed coin has
    //    been owed, its consecutive no-pair misses, the window the last
    //    observation judged against, and the recent retirements with the
    //    reason and the age each was judged at. Asymmetry, on purpose: a COLD
    //    isolate has not ticked yet, so it hydrates nothing and this half
    //    reads empty (windowMaxAgeMin: null) while `durable` is already the
    //    fleet's live row — "this isolate has not seeded yet", never "nothing
    //    is owed".
    //
    // The acceptance point for the prune rule is the pair: `pending` falling
    // while `prunedTotal` rises, with `lastPruned` naming each coin.
    if (url.pathname === "/debug/deferral") {
      try {
        const raw = await db?.getWorkerState(PUSH_DEFERRAL_STATE_KEY);
        return Response.json({
          ok: true,
          now: Date.now(),
          durable: loadPushDeferralSnapshot(raw ?? null),
          isolate: deferralRegistryView(),
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }
    // Fleet-wide DexScreener rate-limit history — the durable half of the 429
    // bookkeeping (see db.bumpDex429). Read-only: three worker_state rows, no
    // writes, so it is safe to poll while diagnosing.
    //
    // What each number is: `total` counts every 429 RESPONSE ever recorded
    // (the drip), while `ring` holds the EPISODES the client notified one per
    // 90s backoff window (see DexScreenerClient.note429 — a storm is three
    // retry attempts per batch, and the hook is debounced so the durable write
    // is not a write flood). So `total` answers "how hard", the ring answers
    // "clustered or steady" — and the ring is the reason this endpoint exists:
    // 2026-09-21 the shared egress IP started 429ing the profiles endpoint on
    // nearly every tick, and the only way to tell a deploy-clustered burst
    // from a steady drip was this READ, which had no reader.
    if (url.pathname === "/debug/db-latency") {
      // Turso round-trip probe (2026-09-29). The push path gives its claim a
      // 400ms slice (scanner.CARD_CLAIM_BUDGET_MS) against a database this
      // Worker does not run next to, and until the batching shipped with this
      // route the claim was TWO sequential requests. This endpoint is the
      // measurement behind that argument, taken from the isolate answering
      // it, because nowhere else shares this isolate's path to the database:
      //
      //   select1             pure round trip — the distance/handshake number.
      //   readRow             the tick's front-read shape (one row by key).
      //   writeUpsert         the fleet-wide writer's cost, isolated.
      //   claimShapeTwoTrip   the claim's OLD shape: INSERT OR IGNORE then an
      //                       awaited counter upsert — two requests.
      //   claimShapeOneTrip   the claim's shape NOW: the same two statements
      //                       in ONE batch (see Db.claimTokenPush).
      //
      // `claimShapeSavingMs` is the difference between them, and `rawMs`
      // keeps every sample so a slow FIRST sample (connection setup on a cold
      // isolate) stays visible instead of being averaged into the median.
      // `colo` (where the request ENTERED Cloudflare) next to `dbRegion`
      // (parsed from the connection URL) is the distance question itself.
      // CAVEAT, measured 2026-10-02 with the [placement] block live: `colo`
      // reports the ENTRY data center, NOT where the code ran — the placed
      // fetch path still reads `colo: LAX` while its round trips collapsed to
      // single-digit ms because execution moved next to the database. The
      // placement proof (`cf-placement: remote-…`) rides the RESPONSE, which a
      // handler cannot read about itself, so read the `ops` below against the
      // [placement] block's before/after table instead of trusting `colo`.
      //
      // Read-mostly: the only writes land on two fixed worker_state probe
      // rows, never seen_tokens — see src/dblatency.ts.
      const since = Date.now() - dbLatencyLastRunAt;
      if (since < DB_LATENCY_COOLDOWN_MS) {
        return Response.json(
          {
            ok: false,
            error: "cooldown — the probe spends real round trips",
            retryAfterSec: Math.ceil((DB_LATENCY_COOLDOWN_MS - since) / 1000),
          },
          { status: 429 },
        );
      }
      if (!db) {
        return Response.json(
          { ok: false, error: "db 未就緒", initError, dbReady },
          { status: 503 },
        );
      }
      try {
        dbLatencyLastRunAt = Date.now();
        const requested = clampLatencySamples(url.searchParams.get("samples"));
        const measured = await db.measureLatency(requested);
        const ops = summarizeLatencyOps(measured.raw);
        return Response.json({
          ok: true,
          at: new Date().toISOString(),
          colo:
            (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? null,
          dbRegion: dbRegionFromUrl(env.TURSO_DATABASE_URL),
          samples: measured.samples,
          ops,
          claimShapeSavingMs: claimShapeSavingMs(ops),
          // The arithmetic check. Each sample must move the probe counter by
          // DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE, which only happens if the
          // statement after an INSERT inside a batch sees THAT insert's
          // changes() — the basis of the batched claim (Db.claimTokenPush).
          // \"verified\" is the live proof that batching the counter is safe;
          // \"mismatch\" is the reading that says it is not.
          changes: {
            before: measured.counterBefore,
            after: measured.counterAfter,
            expectedDelta:
              measured.samples * DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE,
            verdict: changesVerdict(
              measured.counterBefore,
              measured.counterAfter,
              measured.samples,
            ),
          },
          rawMs: measured.raw,
        });
      } catch (err) {
        return Response.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 500 },
        );
      }
    }
    if (url.pathname === "/debug/dex429") {
      try {
        const [rawTotal, rawAt, rawRing] = await Promise.all([
          db?.getWorkerState("dex_429_total"),
          db?.getWorkerState("dex_429_at"),
          db?.getWorkerState("dex_429_ring"),
        ]);
        let ring: number[] = [];
        if (rawRing) {
          try {
            const parsed = JSON.parse(rawRing);
            if (Array.isArray(parsed)) {
              ring = parsed.filter((v): v is number => typeof v === "number");
            }
          } catch {
            ring = []; // corrupted ring — report the totals instead of failing
          }
        }
        const now = Date.now();
        const countSince = (ms: number) => ring.filter((t) => now - t <= ms).length;
        return Response.json({
          ok: true,
          total: rawTotal ? parseInt(rawTotal, 10) || 0 : 0,
          lastAt: rawAt ? new Date(Number(rawAt)).toISOString() : null,
          // The ring holds the last 50 EPISODES, so the window counts below
          // undercount a storm longer than 50 episodes — `total` is the volume
          // and these are the shape.
          ringSize: ring.length,
          lastHour: countSince(3_600_000),
          last6h: countSince(6 * 3_600_000),
          last24h: countSince(24 * 3_600_000),
          ring: ring
            .slice(-20)
            .map((t) => ({ at: new Date(t).toISOString(), agoMin: Math.round((now - t) / 60_000) })),
        });
      } catch (err) {
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }
    if (url.pathname === "/debug/pushes") {
      const rows = (await db?.listSeenTokens()) ?? [];
      const byDay = new Map<string, number>();
      for (const r of rows) {
        const day = new Date(r.firstSeenAt).toISOString().slice(0, 10);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
      }
      const byChat = new Map<string, number>();
      for (const r of rows) {
        byChat.set(r.chatId, (byChat.get(r.chatId) ?? 0) + 1);
      }
      return Response.json({
        ok: true,
        total: rows.length,
        byDay: [...byDay.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([day, n]) => ({ day, n })),
        byChat: [...byChat.entries()].map(([chatId, n]) => ({ chatId, n })),
        firstAt: rows.length > 0 ? new Date(rows[0].firstSeenAt).toISOString() : null,
        lastAt:
          rows.length > 0
            ? new Date(rows[rows.length - 1].firstSeenAt).toISOString()
            : null,
        recent: rows.slice(-20).reverse().map((r) => ({
          at: new Date(r.firstSeenAt).toISOString(),
          token: `${r.token.slice(0, 6)}…${r.token.slice(-4)}`,
        })),
      });
    }

    // All chats' filter profiles (incl. disabled) — the pool query bounds
    // use the WIDEST enabled chat, so a stale wide chat silently widens the
    // tracked age window; this surfaces each chat's settings at a glance.
    // lastPushError shows the most recent failed Telegram delivery to that
    // chat (worker_state push_fail_<chatId>, written by the scanner) — the
    // reason a chat can receive fewer coins than another with identical
    // filters.
    // DELETE /debug/chats?chatId=... removes a chat entirely (settings +
    // seen history). Guarded to POST/DELETE so crawlers can't trigger it.
    if (url.pathname === "/debug/chats" && (request.method === "POST" || request.method === "DELETE")) {
      const chatId = url.searchParams.get("chatId");
      if (!chatId) {
        return Response.json({ ok: false, error: "chatId required" }, { status: 400 });
      }
      const removed = (await db?.removeChat(chatId)) ?? false;
      return Response.json({ ok: true, removed, chatId });
    }
    if (url.pathname === "/debug/chats") {
      const chats = (await db?.listAllChats()) ?? [];
      const enabled = chats.filter((c) => c.enabled);
      const chatsOut = [];
      for (const c of chats) {
        let lastPushError: {
          at?: number;
          code?: number | null;
          description?: string;
          token?: string;
          count?: number;
        } | null = null;
        try {
          const raw = await db?.getWorkerState(`push_fail_${c.chatId}`);
          if (raw) lastPushError = JSON.parse(raw);
        } catch {
          // corrupt state — omit
        }
        chatsOut.push({
          chatId: c.chatId,
          enabled: c.enabled,
          minMarketCapUsd: c.minMarketCapUsd,
          maxMarketCapUsd: c.maxMarketCapUsd,
          minAgeMinutes: c.minAgeMinutes,
          maxAgeMinutes: c.maxAgeMinutes,
          minLiquidityUsd: c.minLiquidityUsd,
          min5mVolUsd: c.min5mVolUsd,
          min5mChgPct: c.min5mChgPct,
          min1hChgPct: c.min1hChgPct,
          lastPushError,
        });
      }
      return Response.json({
        ok: true,
        total: chats.length,
        enabled: enabled.length,
        // The values that actually drive scanning (widest enabled chat).
        poolWindow:
          enabled.length > 0
            ? {
                minAgeMin: Math.min(...enabled.map((c) => c.minAgeMinutes)),
                maxAgeMin: Math.max(...enabled.map((c) => c.maxAgeMinutes)),
                minMcapUsd: Math.min(...enabled.map((c) => c.minMarketCapUsd)),
              }
            : null,
        chats: chatsOut,
      });
    }

    // The sub-minute clock's own surface (see TickClock): /debug/clock reads
    // the DO's status — on/off, when the next alarm is due, what its last
    // tick's two relays answered, how many ticks this instance has run — and
    // `?arm=1` arms it if nothing is pending (the same call the cron scan
    // delivery makes every minute; it never moves a live alarm). The DO is
    // asked DIRECTLY rather than read from a mirror: the alarm time is the one
    // reading that says the loop is actually alive, and it exists only inside
    // the object.
    if (url.pathname === "/debug/clock") {
      const ns = tickClockBinding(env);
      const tickMs = clockTickMs(env);
      if (!ns) {
        return Response.json(
          {
            ok: false,
            error: "TICK_CLOCK binding missing (deploy with the DO binding to use the clock)",
            on: tickMs > 0,
            tickMs,
          },
          { status: 503 },
        );
      }
      try {
        const stub = ns.get(ns.idFromName(TICK_CLOCK_NAME));
        const arm = url.searchParams.get("arm");
        const res = await stub.fetch(
          `${TICK_CLOCK_ORIGIN}${arm ? TICK_CLOCK_ARM_PATH : TICK_CLOCK_STATUS_PATH}`,
          { method: arm ? "POST" : "GET" },
        );
        const body = (await res.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        return Response.json({ ok: res.ok, tickMs, ...(body ?? {}) });
      } catch (err) {
        return Response.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            tickMs,
          },
          { status: 502 },
        );
      }
    }

    // Manual scan trigger — runs the exact scheduled-path wrapper (runScan:
    // scan + heartbeat + scan_history), so it is both the diagnostic that
    // distinguishes "cron not firing" from "scan path broken" and the manual
    // recovery lever. runOnce is re-entrant safe and budget-guarded; runScan
    // races the scan against the 15s tick budget and never rejects.
    if (url.pathname === "/debug/tick") {
      const sinceLast = Date.now() - tickDebugLastRunAt;
      if (sinceLast < TICK_DEBUG_COOLDOWN_MS) {
        return Response.json(
          {
            ok: false,
            error: "cooldown — runScan is minute-budgeted, wait a bit",
            retryAfterSec: Math.ceil(
              (TICK_DEBUG_COOLDOWN_MS - sinceLast) / 1000,
            ),
          },
          { status: 429 },
        );
      }
      tickDebugLastRunAt = Date.now();
      if (!scanner) {
        return Response.json(
          {
            ok: false,
            error: "scanner 未就緒（Turso 初始化失敗？）",
            initError,
            dbReady,
          },
          { status: 503 },
        );
      }
      const t0 = Date.now();
      await runScan(undefined, env, null, "manual");
      return Response.json({
        ok: lastScanOk,
        ms: Date.now() - t0,
        lastScanError,
        summary: scanner.lastSummary,
      });
    }

    // Manual on-chain supply-flow check (same engine as Telegram /flow) —
    // diagnostic route for verifying the production Helius gTFA path on any
    // real coin. Cooldown-bounded per mint to protect the credit budget.
    if (url.pathname === "/debug/flow") {
      const mint = (url.searchParams.get("mint") ?? "").trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return Response.json({ ok: false, error: "invalid mint" }, { status: 400 });
      }
      const last = flowDebugLastRunAt.get(mint) ?? 0;
      const wait = FLOW_DEBUG_COOLDOWN_MS - (Date.now() - last);
      if (wait > 0) {
        return Response.json(
          {
            ok: false,
            error: "cooldown — re-analysis is credit-expensive",
            retryAfterSec: Math.ceil(wait / 1000),
          },
          { status: 429 },
        );
      }
      flowDebugLastRunAt.set(mint, Date.now());
      const res = await analyzeMintFlow(mint);
      return Response.json({ mint, ...res });
    }

    // One-shot backfill: seed token_stats with recently created Solana coins
    // from Birdeye's fresh-launch feed (new_listing), which includes pump.fun
    // launches via meme_platform_enabled=true. The pump.fun HTTP API itself
    // blocks every datacenter egress we have (sandbox/Worker/GitHub Actions
    // all get 530), so Birdeye — already keyed and reachable from the Worker
    // — is the backfill's discovery source. Cooldown-bounded (CU cost);
    // INSERT OR IGNORE makes it idempotent, safe to re-run after tweaks.
    if (url.pathname === "/debug/backfill") {
      const sinceLast = Date.now() - backfillDebugLastRunAt;
      if (sinceLast < BACKFILL_DEBUG_COOLDOWN_MS) {
        return Response.json(
          {
            ok: false,
            error: "cooldown — backfill is CU-bounded, wait a bit",
            retryAfterSec: Math.ceil(
              (BACKFILL_DEBUG_COOLDOWN_MS - sinceLast) / 1000,
            ),
          },
          { status: 429 },
        );
      }
      backfillDebugLastRunAt = Date.now();
      if (!birdeye || !db) {
        return Response.json(
          {
            ok: false,
            error: "Birdeye 或資料庫未就緒（key/DB 未配置？）",
            birdeyeConfigured,
            dbReady,
          },
          { status: 503 },
        );
      }
      const t0 = Date.now();
      try {
        // Raw schema probe first — the docs don't publish new_listing's item
        // fields, so surface the actual response for the first run.
        let probe: unknown = null;
        try {
          probe = await birdeye.probeNewListing();
        } catch (err) {
          probe = err instanceof Error ? err.message : String(err);
        }
        // Walk the 42h window in 6h chunks (time_to must stay within ~3 days).
        const windowMs = 42 * 3600_000;
        const chunkSec = 6 * 3600;
        const now = Date.now();
        const toFloor = Math.floor(now / 1000);
        const fromFloor = Math.floor((now - windowMs) / 1000);
        const found: Array<{ address: string; createdAtSec: number | null }> =
          [];
        const seen = new Set<string>();
        for (let to = toFloor; to > fromFloor; to -= chunkSec) {
          let items: Array<{ address: string; createdAtSec: number | null }> =
            [];
          try {
            items = await birdeye.fetchNewListings(to, 20);
          } catch (err) {
            console.error(
              "[worker] backfill new_listing failed:",
              err instanceof Error ? err.message : err,
            );
            break;
          }
          let added = 0;
          for (const it of items) {
            if (seen.has(it.address)) continue;
            seen.add(it.address);
            added++;
            if (it.createdAtSec !== null) found.push(it);
          }
          if (added === 0) break; // window walked — nothing further back
        }
        // Seed the re-eval pool (INSERT OR IGNORE — idempotent).
        const stats = found.map((it) => ({
          token: it.address,
          firstSeenAt: it.createdAtSec! * 1000,
          firstM5Vol: 0,
          firstSeenAgeMin: (now - it.createdAtSec! * 1000) / 60_000,
          launchMs: it.createdAtSec! * 1000,
          birdeye1mVol: null,
          rugcheckBundlerPct: null,
          rugcheckTop10Pct: null,
          birdeyeProTraders: null,
          birdeyeSniperPct: null,
          minMcapObserved: null,
          supplyFlowJson: null,
          supplyFlowAt: null,
        }));
        await db.recordTokenStatsMany(stats);
        return Response.json({
          ok: true,
          ms: Date.now() - t0,
          fetched: found.length,
          seeded: stats.length,
          chunkCount: Math.ceil(windowMs / (chunkSec * 1000)),
          probe,
          sample: found.slice(0, 3),
        });
      } catch (err) {
        return Response.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            ms: Date.now() - t0,
          },
          { status: 500 },
        );
      }
    }

    // Read-only Jupiter connection check (no money moves): derives the
    // trading wallet, checks its SOL balance, and runs one tiny SOL→USDC
    // quote to prove the full swap path works before any real-money mode.
    if (url.pathname === "/debug/trade") {
      if (!trade) {
        return Response.json({
          ok: false,
          error: "BOT_WALLET_PRIVATE_KEY 未配置（或数据库未就绪）",
          mode: cfg?.trade.mode ?? "off",
        });
      }
      const v = await trade.verify();
      return Response.json({
        ok: v.ok,
        mode: v.mode,
        wallet: v.wallet,
        balanceSol: v.balanceSol ?? null,
        quoteOk: v.quoteOk ?? false,
        amountSol: cfg!.trade.amountSol,
        buyBalancePct: cfg!.trade.buyBalancePct,
        buySizeLabel: trade.buySizeLabel,
        slippagePct: cfg!.trade.slippagePct,
        error: v.error,
      });
    }

    // Telegram webhook introspection: reports getWebhookInfo so a dead
    // /start (messages not delivered) is diagnosable as a missing/moved
    // webhook registration. ?set=1 re-registers this worker's own URL
    // (https://<host>/webhook) — safe to call any time.
    if (url.pathname === "/debug/webhook") {
      const token = cfg?.telegramBotToken;
      if (!token) {
        return Response.json({
          ok: false,
          error: "TELEGRAM_BOT_TOKEN not configured",
        });
      }
      try {
        if (url.searchParams.get("set") === "1") {
          const whUrl = `https://${url.host}/webhook`;
          const r = await fetch(
            `https://api.telegram.org/bot${token}/setWebhook`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: whUrl }),
            },
          );
          const j: unknown = await r.json();
          return Response.json({ ok: true, action: "set", url: whUrl, telegram: j });
        }
        const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
        const j: unknown = await r.json();
        return Response.json({ ok: true, telegram: j });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // /debug/test-push — sends one real test message to any chat and
    // surfaces Telegram's RAW response (error_code + description). Gives a
    // 100% verdict on delivery to a specific chat: e.g. a group the bot was
    // kicked from returns 403 "bot is not a member of the chat" while the
    // scanner's sendMessage errors only land in Cloudflare logs. Harmless
    // (one message, no DB writes) — mirrors /debug/webhook's direct fetch
    // so the exact Telegram JSON is visible either way.
    if (url.pathname === "/debug/test-push") {
      const token = cfg?.telegramBotToken;
      if (!token) {
        return Response.json({
          ok: false,
          error: "TELEGRAM_BOT_TOKEN not configured",
        });
      }
      const chatId = (url.searchParams.get("chatId") ?? "").trim();
      if (!chatId) {
        return Response.json(
          { ok: false, error: "missing ?chatId=" },
          { status: 400 },
        );
      }
      const text = `🧪 Test push from solana-meme-bot @ ${new Date().toISOString()}`;
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
        const j = (await r.json()) as { ok?: boolean };
        return Response.json({
          ok: j.ok === true,
          chatId,
          httpStatus: r.status,
          telegram: j,
        });
      } catch (err) {
        return Response.json({
          ok: false,
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // /debug/pool — diagnostic for zero-push stretches. Age histogram of
    // never-pushed token_stats rows vs what the scanner's re-eval pool query
    // actually returns right now (live chat settings, same query shape). If
    // eligibleInWindow ≫ poolLimit with most coins 12h+ old, the pool's
    // LIMIT is starving the older half of the window in a dense launch
    // market; if eligibleInWindow < poolLimit, the pool covers everything
    // and zero pushes just means nothing qualifies.
    if (url.pathname === "/debug/pool") {
      if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
        return Response.json({ ok: false, error: "TURSO not configured" });
      }
      // Durable TTL cache FIRST, before the probe Db is even constructed: a
      // hit skips the client init AND the whole-table histogram scan (see
      // DEBUG_SCAN_CACHE_*).
      const cached = await readDebugScanCache<Record<string, unknown>>("pool");
      if (cached) {
        return Response.json({
          ...cached.body,
          cached: true,
          cacheAgeMs: cached.ageMs,
        });
      }
      const probe = new Db(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
      // Db.get() requires the client to be connected (init does this; the
      // lazy connect() used by other probe methods doesn't set it).
      await probe.init();
      const now = Date.now();
      const chats = await probe.listEnabledChats();
      // Mirror the scanner's chat-aware seen exclusion so the probe's
      // eligible/returned counts match what production actually evaluates.
      const seenChatIds = chats.map((c) => c.chatId);
      const hist = await probe.getPoolHistogram(now, seenChatIds);
      let poolQueryBuckets: Record<string, number> | null = null;
      let poolQueryCount = 0;
      // The floors this probe applies — computed once, ECHOED in the response
      // (2026-09-28). Until then the probe pruned at minMcap / 2 (half the
      // scanner's ratio) with no liquidity floor and no ceiling, so its
      // poolQueryCount was an inflated upper bound and no floor change could be
      // read off this endpoint at all. It now mirrors the scanner's pool query
      // and names the floors it used, which is what makes a live reading
      // checkable against src/scanner.ts instead of taken on trust.
      // (Empty chat list → 0 = "no floor", rather than Math.min of nothing.)
      const poolMinMcapUsd = chats.length
        ? Math.min(...chats.map((c) => c.minMarketCapUsd))
        : 0;
      const poolMaxMcapUsd = chats.length
        ? Math.max(...chats.map((c) => c.maxMarketCapUsd))
        : 0;
      const poolMinLiquidityUsd = chats.length
        ? Math.min(...chats.map((c) => c.minLiquidityUsd))
        : 0;
      try {
        const minAge = Math.min(...chats.map((c) => c.minAgeMinutes));
        const maxAge = Math.max(...chats.map((c) => c.maxAgeMinutes));
        const minMcap = poolMinMcapUsd;
        const pool = await probe.getReevalPool({
          sinceMs: now - 30 * 3600_000,
          minLaunchMs: now - (maxAge + 180) * 60_000,
          maxLaunchMs: now - (minAge - 180) * 60_000,
          windowEntryLaunchMs: now - minAge * 60_000,
          // The scanner's OWN budget, from config (2026-09-29). This was a
          // hardcoded 1000, which made the probe count a smaller pool than the
          // tick reads the moment RE_EVAL_POOL_SIZE moved — and the whole point
          // of the endpoint is that its `poolQueryCount` is the tick's reach.
          limit: cfg?.reevalPoolSize ?? 1000,
          // Mirror the scanner's configured tiered rotation (near slots
          // swept every ~10 min, far slots every ~30 min, plus the
          // pre-qualification filter) so the probe's age histogram matches
          // what production actually evaluates.
          nearSlots: cfg?.reevalNearSlots ?? 2,
          farSlots: cfg?.reevalFarSlots ?? 6,
          rotationPeriodMs: cfg?.reevalPoolCacheMs,
          // The scanner's OWN ratio (2026-09-28). This probe used
          // minMcap / 2 — a LOOSER floor than production's, so its
          // poolQueryCount over-reported the rows the tick could reach and no
          // floor change could be read off this endpoint. It mirrors now.
          minQualifyMcap: minMcap * POOL_MCAP_PRUNE_RATIO,
          // The scanner's other two pool filters, mirrored so this count is
          // comparable to the tick's: the ceiling (its literal 2, matching
          // src/scanner.ts's maxQualifyMcap) drops the pump-and-dump corpses
          // that rank FIRST under the signal ordering, and the liquidity floor
          // drops the dead-liquidity ones — both otherwise inflate this count.
          maxQualifyMcap: poolMaxMcapUsd * 2,
          minQualifyLiquidity: poolMinLiquidityUsd * POOL_LIQUIDITY_PRUNE_RATIO,
          seenChatIds,
        });
        poolQueryCount = pool.length;
        poolQueryBuckets = {
          "0-3h": 0,
          "3-6h": 0,
          "6-12h": 0,
          "12-24h": 0,
          "24-43h": 0,
          ">43h": 0,
        };
        const H = 3600_000;
        for (const s of pool) {
          const age = now - s.launchMs;
          const key =
            age < 3 * H
              ? "0-3h"
              : age < 6 * H
                ? "3-6h"
                : age < 12 * H
                  ? "6-12h"
                  : age < 24 * H
                    ? "12-24h"
                    : age < 43 * H
                      ? "24-43h"
                      : ">43h";
          poolQueryBuckets[key]++;
        }
      } catch (err) {
        console.error(
          "[worker] /debug/pool pool-query probe failed:",
          err instanceof Error ? err.message : err,
        );
      }
      const body = {
        ok: true,
        now: new Date(now).toISOString(),
        total: hist.total,
        neverPushed: hist.neverPushed,
        buckets: hist.buckets,
        eligibleInWindow: hist.eligibleInWindow,
        // The freshness mark's population (2026-10-08 — see
        // db.DEAD_POOL_MISS_MAX): rows held out of the sweep for coming back
        // empty too many times, and rows one empty sweep away. They are what
        // makes a poolQueryCount that fell interpretable: it fell because
        // these rows left, not because the floors moved.
        deadMarked: hist.deadMarked,
        deadPending: hist.deadPending,
        // The budget the query above actually ran with (see its `limit`):
        // echoing a literal here reported a pool the tick no longer reads.
        poolLimit: cfg?.reevalPoolSize ?? 1000,
        poolQueryCount,
        poolQueryBuckets,
        // Which floors produced poolQueryCount (see the comment above them):
        // a live reading shows the ratios the DEPLOYED code is pruning at.
        mcapPruneRatio: POOL_MCAP_PRUNE_RATIO,
        mcapFloorUsd: poolMinMcapUsd * POOL_MCAP_PRUNE_RATIO,
        mcapCeilingUsd: poolMaxMcapUsd * 2,
        liquidityPruneRatio: POOL_LIQUIDITY_PRUNE_RATIO,
        liquidityFloorUsd: poolMinLiquidityUsd * POOL_LIQUIDITY_PRUNE_RATIO,
      };
      await writeDebugScanCache("pool", body);
      return Response.json({ ...body, cached: false });
    }

    // An unrouted /debug path is a 404, answered BEFORE the webhook fallback
    // below. That fallback is handed every request the router did not claim,
    // and grammY's cloudflare-mod adapter throws on a non-POST, so an unknown
    // debug path came back as a Cloudflare 1101 ("Worker threw a JavaScript
    // exception") — which reads exactly like the Worker crashing. The whole
    // namespace is covered, bare /debug included; none of it can ever be the
    // webhook, which is registered at /webhook (see /debug/webhook?set=1).
    if (url.pathname === "/debug" || url.pathname.startsWith("/debug/")) {
      return Response.json(
        { ok: false, error: `unknown debug endpoint: ${url.pathname}` },
        { status: 404 },
      );
    }

    // Telegram webhook (grammY registers commands on this bot instance).
    // POST-only on purpose: Telegram never sends anything else, and this gate
    // is also what lets the fallback below be reached at all — without it,
    // GET / and GET /favicon.ico were 1101s too, because the request went to
    // grammY and threw there.
    if (webhook && request.method === "POST") {
      return webhook(request);
    }
    return new Response("Solana Meme Coin Scanner worker", { status: 200 });
  },

  async scheduled(
    event: ScheduledEventLike,
    env: Env,
    ctx: ExecutionContextLike,
    /**
     * Present only when the caller is this Worker's OWN relay route (see
     * handleCronRelay): `relay: false` says this invocation IS the placed
     * half of a relay and must not relay again, `relayTag` is the region
     * reading that run must publish (always "inner" — the route runs on the
     * placed fetch path), and `via: "clock"` says the caller is the
     * sub-minute clock's alarm rather than a cron delivery (see TickClock) —
     * the one difference the scan branch below acts on. The platform calls
     * this method with three arguments; the relay route is the only
     * four-argument call site.
     */
    opts?: { relay?: boolean; relayTag?: PassRelayTag; via?: "clock" },
  ): Promise<void> {
    // Keep the invocation open for the tick's deferred writes (see
    // tickWaitUntil): a fire-and-forget drain is cancelled when the handler
    // returns — the 100%-failure shape measured above. The tracker's own
    // delivery enters through this same prologue on purpose: a pass needs a
    // subrequest window of its own (beginSubreqWindow, see src/subreqs.ts) and
    // the waitUntil that keeps a CUT card's delivery proof alive, and neither
    // of those is scan-specific.
    // ...tagged by trigger BEFORE the routing below (a pure string compare,
    // so the tag cannot change the routing it describes): the pass's own
    // delivery is a window of its own, and everything a reader concludes about
    // "the tick front's spend" depends on the two not being mixed.
    beginPreTick(
      Date.now(),
      isTrackerCron(event.cron)
        ? "pass"
        : isMaintenanceCron(event.cron)
          ? "maint"
          : "scan",
    );
    tickWaitUntil = (promise) => ctx.waitUntil(promise);
    // THE TRACKER'S OWN DELIVERY (see TRACKER_CRON): the pass, and nothing
    // else. First its relay attempt (see the relay block at the bottom): the
    // pass's own durable note read `db 738ms` per pass in the cron region — a
    // chain of Turso round trips, reads single-digit ms on the placed path —
    // so the pass is replayed there. On ANY relay failure the branch falls
    // through to the same local pass the Worker always ran. (Measured after
    // the relay: the relayed `db` spans 216-1546ms across pass shapes, its own
    // writes the floor, and `trackerMs` reaches 216ms.) After the relay attempt the
    // local run returns BEFORE scheduledTicks, the cron-arrival stamp and the
    // cadence gate, because all three count SCAN arrivals — the injected
    // cadence gate and the outage check both compare them, so a delivery that
    // never scans must not move them. This delivery's own liveness is the pass
    // row it writes (see runTrackerInvocation, and the tick's fallback).
    if (isTrackerCron(event.cron)) {
      // The region reading this run publishes (see THE MARKER): the placed
      // replay's own `opts.relayTag`, or the failed/skipped tag of the relay
      // attempt this delivery is about to make. A parameter, never module
      // state — the three deliveries share this isolate.
      let relayTag: PassRelayTag | null = opts?.relayTag ?? null;
      if (opts?.relay !== false) {
        const relay = await relayCronDelivery(env, "tracker");
        if (relay === "relayed") return;
        relayTag = relay;
      }
      await runTrackerInvocation(env, relayTag);
      return;
    }
    // THE MAINTENANCE DELIVERY (see MAINTENANCE_CRON): same shape and the same
    // reason as the pass above — relay first, then the local legs — and the
    // local run returns BEFORE scheduledTicks, the cron-arrival stamp and the
    // cadence gate, because all three count SCAN arrivals. Its own liveness is
    // the row it writes, and the tick's fallback is what makes a missed
    // delivery cost freshness instead of a leg.
    if (isMaintenanceCron(event.cron)) {
      let relayTag: PassRelayTag | null = opts?.relayTag ?? null;
      if (opts?.relay !== false) {
        const relay = await relayCronDelivery(env, "maintenance");
        if (relay === "relayed") return;
        relayTag = relay;
      }
      await runMaintenanceInvocation(env, relayTag);
      return;
    }
    // RELAY THE SCAN TO THE PLACED FETCH PATH (see the relay block at the
    // bottom): this invocation runs in the cron region (measured ORD, 11/11
    // on 2026-10-02), while the fetch path is placed next to the database
    // (NRT, single-digit-ms statements against the cron path's ~1.4s ones).
    // The tick's slowest stages are chains of exactly those round trips, so
    // the tick is replayed where they are short. NOTHING below changes: a
    // relay that cannot run falls through to the same local tick this Worker
    // has always run, and the completion heartbeat's `relay` field names
    // which path actually ran it. `relay: false` is the placed invocation's
    // own call back into this handler (see handleCronRelay) — it must never
    // relay again.
    // The region reading the local scan publishes when the relay does not run
    // it (see THE MARKER): the placed replay's own `opts.relayTag`, or the
    // failed/skipped tag of the attempt below.
    // WHICH TRIGGER ASKED (2026-10-02, see TickClock): "clock" is the DO
    // clock's alarm arriving through the relay route (handleCronRelay parses
    // it off the wire); absent is the platform's own cron delivery. The two
    // differ in EXACTLY two ways below — a clock arrival carries NONE of the
    // cron bookkeeping (the tick ring, scheduled_tick_total, the pre-init
    // stamp, `scheduledTickFinishedAt`: recording it there would let a DEAD
    // cron read as alive, the misreading docs/uptime-monitor.md exists for),
    // and it is counted as its own ScanTrigger so the per-trigger counters
    // still answer "how much of the scanning is actually cron". Everything
    // else — the gate, the scan lock, runScan — is deliberately identical.
    const clockDelivery = opts?.via === "clock";
    let scanRelayTag: PassRelayTag | null = opts?.relayTag ?? null;
    if (opts?.relay !== false) {
      const relay = await relayCronDelivery(env, "scan");
      if (relay === "relayed") {
        // The placed invocation ran the whole tick — its own arrival stamp,
        // cadence gate, scan and completion flush — so this delivery is DONE.
        // Mark it returned (see shouldStampArrival): the next delivery needs
        // no pre-init stamp on account of this one.
        scheduledTickFinishedAt = Date.now();
        return;
      }
      scanRelayTag = relay;
    }
    // THE CLOCK'S ARM KEEPER (see armTickClock): a confirmed CRON scan
    // delivery — relayed or local — is where a clock whose alarm was somehow
    // lost comes back on, one DO request per cron minute. The clock's own
    // ticks never arm (they ARE the alarm).
    if (!clockDelivery) armTickClock(env, ctx);
    if (!clockDelivery) scheduledTicks++;
    // Cron-arrival bookkeeping rides the scan-lock claim (see
    // Db.scheduledTickStatements), so a normal tick pays ZERO extra round trips
    // for it: it used to pay a read AND a write through its own raw client
    // (live `bump 564-2211ms` in summary.preTick) on an invocation whose
    // binding constraint is the 50-subrequest budget. Every path that cannot
    // reach a claim still records the arrival — the cadence-gate skip below,
    // both no-claim arms of runScan, and the !scanner fallback right here —
    // because the counter exists so a slow/failed init cannot make cron look
    // dead from /health (observed 2026-08-14).
    const cronAt = Date.now();
    // PRE-INIT ARRIVAL STAMP (see shouldStampArrival / Db.stampScheduledArrival).
    // Every other arrival record is reachable only past init — the claim batch
    // carries it, and each path that cannot reach a claim writes it on its own —
    // so a tick killed inside init leaves no trace and reads from /health
    // exactly like "cron stopped delivering" (measured 2026-09-23: a 19-minute
    // ring hole and a 2h42m one, with scans still landing from the HTTP monitor).
    // This stamp is written BEFORE init, on the arrivals whose predecessor never
    // returned, so the two causes can be told apart afterwards.
    if (!clockDelivery && shouldStampArrival(scheduledTickFinishedAt, cronAt)) {
      try {
        // The module handle is null on a cold isolate (init has not built it
        // yet), which is why the fallback builds one the same way
        // bumpScheduledTickLegacy does. Either way: one write, no read.
        const stamp =
          db !== null
            ? db.stampScheduledArrival(cronAt)
            : env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN
              ? new Db(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN).stampScheduledArrival(
                  cronAt,
                )
              : null;
        if (stamp) {
          await recoveryAwait(stamp, PRE_INIT_ARRIVAL_BOUND_MS, "cron arrival stamp");
        }
      } catch (err) {
        // The stamp must never cost the tick: this is the path a dying tick
        // takes, and the stamp is the only thing it is here to leave behind.
        console.error(
          "[worker] pre-init cron arrival stamp failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    const initAt = Date.now();
    // BOUNDED (see FRONT_INIT_BOUND_MS): the init in front of this tick's
    // gate was the last UNBOUNDED front await, and a wedged one died before
    // the arrival could be written — which is how a cron hole read like a
    // dead trigger while the HTTP fallback kept scanning. A timed-out init
    // falls through to the `!scanner` guard below, which records the arrival
    // with the standalone raw client and returns; the pending initPromise is
    // picked up by the next delivery.
    await recoveryAwait(ensureInitialized(env), FRONT_INIT_BOUND_MS, "init");
    preTick.steps.init = Date.now() - initAt;
    if (!scanner) {
      // WHY THIS TICK DID NOTHING (2026-09-27): the arrival above is recorded,
      // the scan below never starts, and before this line no counter, no
      // heartbeat field and no log said so — a 2-minute cadence then read as if
      // half the arrivals had never been delivered (measured 07:39-08:11 that
      // day). The reason rides the next completion's tail write (see
      // src/skipcapture.ts).
      // A clock arrival records nothing on this arm either (see
      // clockDelivery): the counter and the flag are the CRON's, and the next
      // cron delivery records its own arrival.
      noteSkipReason("init-no-scanner");
      if (!clockDelivery) {
        preTick.steps.bump = await bumpScheduledTickLegacy(env);
        scheduledTickFinishedAt = Date.now();
      }
      return;
    }
    // Cadence gate: the cron trigger fires every minute; SCAN_INTERVAL_SECONDS
    // (default 60s) lets the operator slow the scan (e.g. 90s — every other
    // tick, halving upstream API pressure and Turso rows-read). Skip the
    // scan when one completed recently; the DB heartbeat is the
    // cross-isolate source of truth (an in-memory timestamp can't gate
    // another isolate's cron delivery). The HTTP-driven fallback
    // (maybeRunScanIfStale) still rescues a dead cron within 2 min.
    //
    // WITH THE CLOCK ON, THE CLOCK'S PERIOD IS THE CADENCE (2026-10-02, see
    // TickClock): `scanGateMs` gets the clock's period, and its sub-minute
    // arithmetic keeps HALF of it as slack — which is what lets a 20s/30s tick
    // pass its own gate (completion-to-entry is the period minus the scan's
    // ~3-4s) while still refusing two triggers inside the same seconds.
    // SCAN_INTERVAL_SECONDS keeps its meaning for the clock-off deployment.
    const clockMs = clockTickMs(env);
    const scanGapMs =
      clockMs > 0
        ? clockMs
        : Math.max(SCAN_CRON_PERIOD_MS, (cfg?.scanIntervalSeconds ?? 60) * 1000);
    // Gate against the previous COMPLETION minus the jitter budget (see
    // scanGateMs): a strict `scanGapMs` comparison skips a tick whenever the
    // previous scan landed late (2026-09-27 live: every :2x completion was
    // followed by a ~100s hole), so the margin exists to let this tick CATCH
    // UP instead of losing its minute. The scan lock, not this gate, prevents
    // overlapping scans.
    const gateMs = scanGateMs(scanGapMs);
    // This gate read ALSO carries the cron-tick ring: the heartbeat doubles as
    // the backfill input for runScan (a dead predecessor's stale scanning
    // heartbeat) and the outage check — pass both down so the tick adds no
    // extra round trips — and the ring is what the claim batch needs to record
    // the arrival. One subrequest for all of it, and the heartbeat itself is
    // usually REUSED from ensureInitialized (see lastHeartbeatRead), so a cron
    // tick's front reads one row instead of three.
    const gateAt = Date.now();
    let hbRaw: string | null = null;
    let hbAt: number | null = null;
    let cronTick: ScheduledTickEntry | null = null;
    try {
      const cachedHb =
        lastHeartbeatRead !== null &&
        Date.now() - lastHeartbeatRead.at <= HEARTBEAT_REUSE_MS
          ? lastHeartbeatRead.raw
          : undefined;
      const cachedCron =
        lastCronKeysRead !== null &&
        Date.now() - lastCronKeysRead.at <= HEARTBEAT_REUSE_MS
          ? lastCronKeysRead.map
          : null;
      // The plan, pure and unit-tested (see cronGateLoad): with both caches
      // warm — the normal cron shape, because init just paid for all three
      // keys in ONE statement — the gate reads NOTHING. Whatever it still
      // has to fetch is merged OVER the cached rows, so the ring handed to
      // the claim is never the cached half of a mixed pair.
      const keys = cronGateLoad(cachedHb !== undefined, cachedCron !== null);
      let kb: Map<string, string> | null = cachedCron;
      if (keys.length > 0) {
        const fresh = await db?.getWorkerStates(keys);
        kb = kb !== null ? new Map([...kb, ...(fresh ?? [])]) : fresh ?? null;
      }
      hbRaw =
        cachedHb !== undefined ? cachedHb : (kb?.get("scan_heartbeat") ?? null);
      const at = hbRaw
        ? ((JSON.parse(hbRaw) as { at?: number } | null)?.at ?? 0)
        : 0;
      hbAt = typeof at === "number" && at > 0 ? at : null;
      cronTick = clockDelivery
        ? null
        : {
            at: cronAt,
            ring: [
              ...parseScheduledTickRing(kb?.get("scheduled_tick_ring") ?? null),
              cronAt,
            ],
          };
      if (hbAt !== null && Date.now() - hbAt < gateMs) {
        console.log(
          `[worker] ${clockDelivery ? "clock" : "cron"} tick skipped — last scan claimed ${Math.round((Date.now() - hbAt) / 1000)}s ago (< ${Math.round(gateMs / 1000)}s)`,
        );
        // Counted like every other early return (2026-09-27): in the 60s mode
        // this is rare and should read ~0, while in a 90s/120s deployment it is
        // the cadence knob WORKING — either way "how often does the gate skip"
        // belongs in the same reading as the scanner's own reasons. A clock
        // tick's skip gets its OWN reason string: the two triggers have
        // different fixes, and the counters must tell "the cron is
        // over-firing" apart from "the clock is over-firing".
        noteSkipReason(clockDelivery ? "clock-gate" : "cron-gate");
        // A skipped CRON tick still ARRIVED — record it (ONE write, no read).
        // A clock arrival is not a cron arrival (see clockDelivery) and has
        // nothing to record — `cronTick` is null for it by construction.
        if (cronTick) {
          try {
            await db?.writeScheduledTick(cronTick);
          } catch (err) {
            console.error("[worker] skipped-tick cron bookkeeping failed:", err);
          }
        }
        // A SKIP is a return: a CRON arrival is accounted for (its own write
        // went out above), so the next arrival needs no pre-init stamp. The
        // clock's tick is not that flag's business (see clockDelivery).
        if (!clockDelivery) scheduledTickFinishedAt = Date.now();
        return;
      }
    } catch {
      // Heartbeat unreadable — fail open and run the scan. The arrival is
      // recorded through the standalone raw-client bump: with worker_state
      // unreadable there is no ring to hand the claim, and no reason to trust
      // the claim batch to run at all. A clock arrival has no arrival to
      // record and simply falls through (see clockDelivery).
      cronTick = null;
      if (!clockDelivery) preTick.steps.bump = await bumpScheduledTickLegacy(env);
    } finally {
      // Covers the `return` arm too: a SKIPPED tick still reports what its
      // gate read cost, which is the tick shape a reader is chasing.
      preTick.steps.gate = Date.now() - gateAt;
    }
    // Detect missed ticks (previous scan finished too long ago) and alert.
    try {
      const outageAt = Date.now();
      await checkOutageAndAlert(hbAt);
      preTick.steps.outage = Date.now() - outageAt;
    } catch (err) {
      console.error("[worker] outage check failed:", err);
    }
    scanRunning = true;
    try {
      // The trigger this scan is COUNTED under (see Db.ScanTrigger): the
      // clock gets its own value so `/health.scanTriggers.clock` and the
      // heartbeat's `via` answer "who is actually driving the cadence"
      // directly, instead of leaving a reader to infer it from timing.
      await runScan(
        hbRaw,
        env,
        cronTick,
        clockDelivery ? "clock" : "cron",
        scanRelayTag,
      );
    } finally {
      scanRunning = false;
    }
    // The tick RETURNED: this isolate's newest CRON arrival is accounted for,
    // which is the flag that keeps the pre-init stamp off the next one (see
    // shouldStampArrival). Set LAST on purpose — a tick that dies anywhere
    // above leaves the flag where it was, and that stale flag IS the witness.
    // A clock tick must not move it: the flag describes the cron trigger's
    // deliveries, and a busy clock would hide a cron that stopped finishing.
    if (!clockDelivery) scheduledTickFinishedAt = Date.now();
  },
};

export default worker;
