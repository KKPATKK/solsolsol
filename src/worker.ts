import { webhookCallback, type Bot } from "grammy";
import {
  BirdeyeClient,
  BIRDEYE_CU_LEDGER_DAYS,
  birdeyeUtcDay,
  consumeBirdeyeCuDelta,
  peekBirdeyeCuDelta,
} from "./birdeye";
import { createBot, tradeKeyboard, type FlowCheckResult } from "./bot";
import { loadConfig, type AppConfig } from "./config";
import { Db, parseScheduledTickRing, type ScheduledTickEntry } from "./db";
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
  parseSkipCaptureState,
  skipCaptureSnapshot,
  takeSkipCaptureDelta,
  type SkipCaptureState,
} from "./skipcapture";
import { DexScreenerClient } from "./dexscreener";
import { HeliusClient, type SupplyFlowResult } from "./helius";
import { RugcheckClient } from "./rugcheck";
import { Scanner, deferredPushTokens, forgetDeferredTokens } from "./scanner";
import { feedMakeupView } from "./deferredmakeup";
import {
  installTickProbe,
  dbStepView,
  writeDrainView,
  drainDeferredWrites,
  noteDuplicateCards,
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
import { GeckoTerminalClient, GECKO_ALT_BASE_URL, GECKO_CACHE_TTL_S, GECKO_USER_AGENT } from "./geckoterminal";
// Heal-path counters: module scope in the tracker, read here so /health can
// answer "did the self-heal reuse the push-time baseline, and how often".
import {
  pushWatchHealStats,
  terminalRowIssues,
  terminalRowRepair,
} from "./pushwatch";
import { JupTokensClient } from "./jupfeeds";
import { GmgnClient } from "./gmgn";
import { AxiomClient, parseAxiomTokenInfo, type AxiomTokenInfo } from "./axiom";
import { renderMessage } from "./render";
import type { QualifyingCoin, ScanSummary } from "./scanner";
import { ArkhamClient } from "./arkham";
import { CrimeWalletClient } from "./crimewallets";
import { WalletAnalyzer } from "./walletanalysis";
import { FlurryAnalyzer } from "./flurry";
import {
  beginSubreqWindow,
  countSubreq,
  subreqView,
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
 * dead-pool prune (db.ts DEAD_LIQUIDITY_USD). The pool used to pre-filter on
 * `max_liquidity_observed`, a lifetime high-water, so a coin that had a pool
 * and LOST it stayed in the sweep forever — live 2026-09-19: 48 of 49 logged
 * rejects were liquidity failures (~72% of them liquidity 0/null) while a coin
 * like `wildebeest` read $0 against a $242K peak. Only readings the scan itself
 * produced go in here: no liquidity field (`null`) leaves the column as it was,
 * so a coin nobody has measured keeps the old behavior instead of being pruned
 * on a guess.
 */
let observedLiquidity = new Map<string, number>();
let helius: HeliusClient | null = null;
let birdeye: BirdeyeClient | null = null;
let gmgn: GmgnClient | null = null;
let axiom: AxiomClient | null = null;
let arkham: ArkhamClient | null = null;
let crimeWallets: CrimeWalletClient | null = null;
let walletAnalyzer: WalletAnalyzer | null = null;
let flurryAnalyzer: FlurryAnalyzer | null = null;
/** OTP JWT from the pending Axiom login step 1 (module-local, short-lived). */
let pendingAxiomOtpJwt: string | null = null;
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
 * Cooldown for the /debug/backfill endpoint (one-shot Birdeye backfill).
 * It costs real CU (30–80 per request) and does a full 42h window walk, so
 * keep it manual and rare.
 */
const BACKFILL_DEBUG_COOLDOWN_MS = 5 * 60_000;
let backfillDebugLastRunAt = 0;
/** Minimum gap between fallback scans triggered from the fetch path. */
// How often the HTTP-triggered fallback scan may fire. Cron (1/min) is the
// primary driver; 60s keeps the fallback from double-scanning during
// healthy cron delivery while still self-healing within ~1 minute if cron
// stops (observed 2026-08-14: cron dead for 24h+, fallback kept the bot
// alive; observed 2026-09-03: a ~4-min cron delivery pause produced a
// heartbeat freeze + outage alert because no request arrived in the
// window — tightened from 120s so any webhook/monitor request rescues
// sooner. The heartbeat-freshness check below still dedupes against
// healthy cron, so the effective cadence stays 1/min when cron works).
const SCAN_TRIGGER_INTERVAL_MS = 60_000;
let lastScanTriggerAt = 0;
let lastScanAt: number | null = null;
let lastScanOk = false;
let scanCount = 0;
let initPromise: Promise<void> | null = null;

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
 */
let pushDeferralBaseline: { deferred: number; recovered: number; stalled?: number } = {
  deferred: 0,
  recovered: 0,
  stalled: 0,
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
/** How long a reconciliation may take before the tick moves on (see below). */
const PUSH_LEDGER_SYNC_BOUND_MS = 900;
let pushLedgerSyncedAt = 0;

/**
 * Fleet-wide early-return counters (src/skipcapture.ts): the durable half of
 * "the sweep returned without evaluating anything, because X". The isolate copy
 * answers why the tick being reported did nothing; this one answers how often
 * that happens, which one isolate's ~10-20 minute lifetime cannot.
 */
let skipCaptureMirror: SkipCaptureState = emptySkipCaptureState();
/** Same throttle/bound rationale as the ledger sync: telemetry off the tick path. */
const SKIP_CAPTURE_SYNC_MIN_GAP_MS = 5 * 60_000;
const SKIP_CAPTURE_SYNC_BOUND_MS = 900;
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
/** Same telemetry throttle/bound rationale as the ledger and skip syncs. */
const BIRDEYE_CU_SYNC_MIN_GAP_MS = 5 * 60_000;
const BIRDEYE_CU_SYNC_BOUND_MS = 900;
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
 * Persist this isolate's Birdeye CU delta (see the ledger above). Same
 * discipline as the push-ledger and skip-capture syncs: the READ is
 * unconditional, and the in-memory delta is only cleared after a write that
 * actually landed, so a failed write re-offers it instead of dropping it.
 */
export async function syncBirdeyeCu(
  now = Date.now(),
  database: Db | null = db,
): Promise<void> {
  if (!database) return;
  const delta = peekBirdeyeCuDelta();
  const durable = parseBirdeyeCuLedger(
    await database.getWorkerState(BIRDEYE_CU_STATE_KEY),
  );
  if (delta.size === 0) return;
  const next = mergeBirdeyeCuLedger(durable, delta, now);
  await database.setWorkerState(
    BIRDEYE_CU_STATE_KEY,
    JSON.stringify({ v: 1, days: next }),
  );
  consumeBirdeyeCuDelta(delta);
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
 */
async function flushObservedLiquidity(): Promise<void> {
  if (!db || observedLiquidity.size === 0) return;
  const rows = [...observedLiquidity].map(([token, liquidityUsd]) => ({
    token,
    liquidityUsd,
  }));
  observedLiquidity = new Map();
  try {
    await db.recordObservedLiquidity(rows);
  } catch (err) {
    console.warn(
      "[worker] observed-liquidity write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Forget deferred obligations the delivery audit ring already discharged (the
 * rule is deliveredDeferredTokens; the duplicate it fixes is 2026-09-20 00:47Z
 * GROYPER — a card, then the same card again two minutes later).
 *
 * Two deliberate choices:
 *  - FRESH read, not the module mirror: the duplicate lands on the very next
 *    tick, which is inside the push-ledger sync's 5-minute throttle, so a
 *    reused copy would be exactly the copy that cannot see the push yet. This
 *    runs after the completion flush, where one extra round trip cannot cost a
 *    card or the flush window.
 *  - Best-effort: a failed read returns "nothing proved delivered", i.e. the
 *    pending list is left exactly as it was. The cost of that is the duplicate
 *    we already had, never a forgotten obligation.
 *  - THREE proof sources, because the ring alone is too short-lived: the audit
 *    ring holds ~30 deliveries of ALL kinds (initial, resend, follow-up, heal),
 *    and live 2026-09-20 it rolled two of the four stale tokens out of its
 *    window inside 13 minutes. The durable push ledger carries `initial`
 *    provenance for 7 days / 240 pushes, and `push_watch` rows (written right
 *    after a successful push) cover the `resend`-only deliveries the ledger by
 *    design does not record. All three are read in parallel and folded into one
 *    proof set; only the kind whitelist in deliveredDeferredTokens decides.
 */
async function dropDeliveredPendings(
  database: Db,
  pending: readonly string[],
): Promise<string[]> {
  // The audit ring is read on EVERY tick, not only when something is pending:
  // it is also where the duplicate count comes from (noteDuplicateCards), and
  // without that number on the heartbeat neither the operator's report nor any
  // fix can be measured. The two other proof sources (durable ledger, watch
  // rows) are only fetched when they can actually be used, so a tick with
  // nothing pending pays one read instead of three.
  let audit: Awaited<ReturnType<Db["getPushAudit"]>>;
  let ledgerRaw: string | null = null;
  let watchRows: Awaited<ReturnType<Db["listPushWatch"]>> = [];
  try {
    if (pending.length === 0) {
      audit = await database.getPushAudit();
    } else {
      [audit, ledgerRaw, watchRows] = await Promise.all([
        database.getPushAudit(),
        database.getWorkerState(PUSH_LEDGER_STATE_KEY),
        database.listPushWatch(60),
      ]);
    }
  } catch (err) {
    console.warn(
      "[worker] delivery-proof read failed (deferral duplicate guard skipped):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
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
async function syncPushDeferralCounters(summary: ScanSummary | null): Promise<void> {
  // Called after the completion flush; keep the expensive telemetry reads here
  // rather than on the scan's pre-race path.
  //
  // ORDER MATTERS, and the duplicate guard is why. This function is raced on
  // the tick's tail with `min(DEFERRAL_SYNC_BOUND_MS, remainingFlushMs())`, and
  // syncPostScanTelemetry's throttled ledger sync is itself bounded at 900ms —
  // so when the duplicate guard sat AFTER it, a tick where that throttle fired
  // never reached the guard at all: live 2026-09-20 the two delivered-but-owed
  // tokens `DFQHUegJW…` / `BmnGRH8N1…` stayed pending across two deploys and
  // four minutes of ticks even though the rule matches them (verified by replaying
  // the live pending list against the live watch rows offline). The guard now
  // runs FIRST (one parallel round trip), applies its in-memory effect
  // immediately, and persists the shrink before the telemetry that starved it.
  if (!db) return;
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
  };
  const raw = await db.getWorkerState(PUSH_DEFERRAL_STATE_KEY);
  const durable = parsePushDeferralSnapshot(raw);
  // Duplicate guard: a delivered coin must not stay "owed". The push and the
  // pending-list write ride the same completion flush, so a lost flush leaves
  // it pending and the make-up pass pushes the card again (see
  // dropDeliveredPendings). Seeding happens AFTER the drop, so neither the
  // registry nor the published gauge can resurrect it.
  const stale = await dropDeliveredPendings(db, durable?.pendingTokens ?? []);
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
  if (stale.length > 0) {
    // Persist the shrunken pending list before any other round trip on this
    // tail. Zero deltas on purpose: this write carries the drop, not counters,
    // and the normal delta path below may still follow with its own.
    try {
      const shrunk = nextPushDeferralSnapshot(
        raw,
        { deferred: 0, recovered: 0, stalled: 0, pending: owedPending.length },
        Date.now(),
        { owner: SCAN_LOCK_OWNER, ...totals },
        owedPending,
      );
      await db.setWorkerState(PUSH_DEFERRAL_STATE_KEY, JSON.stringify(shrunk));
      pushDeferralSnapshot = shrunk;
    } catch (err) {
      console.warn(
        "[worker] deferral shrink write failed (next tick re-offers it):",
        err instanceof Error ? err.message : err,
      );
    }
  }
  await syncPostScanTelemetry();
  const cursorDelta = pushDeferralDelta(pushDeferralBaseline, totals);
  // The held-back half rides its own pending delta (see stalledUnflushed), and
  // that is what makes a chain-deferral-only tick persist at all: cursorDelta
  // is null whenever the scanner's own counters did not move — exactly the
  // shape this counter exists for. `totals.stalled` still travels with every
  // write as the applied marker, but it is not the amount added.
  const delta = {
    deferred: cursorDelta?.deferred ?? 0,
    recovered: cursorDelta?.recovered ?? 0,
    stalled: stalledUnflushed,
  };
  // `stale.length > 0` keeps the write path open for a drop-only tick: the
  // durable row has to lose those tokens too, or a recycled isolate re-seeds
  // them from storage (see the seed call site) and pushes the same card again.
  if (
    delta.deferred <= 0 &&
    delta.recovered <= 0 &&
    delta.stalled <= 0 &&
    stale.length === 0
  ) {
    refreshMirror();
    return;
  }
  if (stale.length === 0 && pushDeferralAlreadyApplied(durable, SCAN_LOCK_OWNER, totals)) {
    // A previous attempt of this very write committed while its response was
    // lost (hard wall, invocation kill). The row already carries it — ACK
    // rather than add it a second time.
    pushDeferralBaseline = totals;
    stalledUnflushed = 0;
    refreshMirror();
    return;
  }
  const next = nextPushDeferralSnapshot(
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
    Date.now(),
    { owner: SCAN_LOCK_OWNER, ...totals },
    deferredPushTokens(),
  );
  await db.setWorkerState(PUSH_DEFERRAL_STATE_KEY, JSON.stringify(next));
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
    `[worker] deferral counters persisted: +${delta.deferred} deferred / +${delta.recovered} recovered / +${delta.stalled} held back (totals ${next.deferredTotal}/${next.recoveredTotal}/${next.stalledTotal})`,
  );
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
 * The WRITE is skipped when nothing changed (the common case), so a steady
 * tick costs three reads and no write. Called off the pre-race path under a
 * throttle and a race bound: telemetry may never extend the invocation, and a
 * pass that is bounded away is simply re-offered on the next tick it is due.
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
      kind: (a as { kind?: string | null }).kind ?? null,
    })),
    rows: rows.map((r) => ({
      token: r.token,
      pushedAt: r.pushedAt,
      mcapAtPush: r.mcapAtPush,
    })),
    band,
    now,
  });
  const serialized = JSON.stringify(next);
  if (serialized !== raw) {
    await database.setWorkerState(PUSH_LEDGER_STATE_KEY, serialized);
  }
  pushLedgerMirror = { ...pushLedgerStats(next, now), heal: pushWatchHealStats() };
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
 */
export async function syncSkipCaptureState(
  now = Date.now(),
  database: Db | null = db,
): Promise<void> {
  if (!database) return;
  const delta = takeSkipCaptureDelta();
  const raw = await database.getWorkerState(SKIP_CAPTURE_STATE_KEY);
  const durable = parseSkipCaptureState(raw);
  if (!delta) {
    skipCaptureMirror = durable;
    return;
  }
  const next = mergeSkipCaptureState(durable, delta, now);
  await database.setWorkerState(SKIP_CAPTURE_STATE_KEY, JSON.stringify(next));
  skipCaptureMirror = next;
  markSkipCaptureSynced();
  console.log(
    `[worker] skip capture persisted: +${delta.total} early return(s) (fleet total ${next.total}, last "${next.lastReason ?? "unknown"}")`,
  );
}

/**
 * Persist non-critical telemetry after the scan completion batch. Keeping
 * these reads off the pre-race path protects the candidate send window.
 */
async function syncPostScanTelemetry(now = Date.now()): Promise<void> {
  if (!db) return;
  if (now - pushLedgerSyncedAt >= PUSH_LEDGER_SYNC_MIN_GAP_MS) {
    try {
      await Promise.race([
        syncPushLedger(now),
        new Promise((resolve) => setTimeout(resolve, PUSH_LEDGER_SYNC_BOUND_MS)),
      ]);
    } catch (err) {
      console.warn("[worker] post-scan push-ledger sync failed:", err);
    }
    pushLedgerSyncedAt = Date.now();
  }
  if (now - skipCaptureSyncedAt >= SKIP_CAPTURE_SYNC_MIN_GAP_MS) {
    try {
      await Promise.race([
        syncSkipCaptureState(now),
        new Promise((resolve) => setTimeout(resolve, SKIP_CAPTURE_SYNC_BOUND_MS)),
      ]);
    } catch (err) {
      console.warn("[worker] post-scan skip-capture sync failed:", err);
    }
    skipCaptureSyncedAt = Date.now();
  }
  if (now - birdeyeCuSyncedAt >= BIRDEYE_CU_SYNC_MIN_GAP_MS) {
    try {
      await Promise.race([
        syncBirdeyeCu(now),
        new Promise((resolve) => setTimeout(resolve, BIRDEYE_CU_SYNC_BOUND_MS)),
      ]);
    } catch (err) {
      console.warn("[worker] post-scan Birdeye CU sync failed:", err);
    }
    birdeyeCuSyncedAt = Date.now();
  }
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
 */
export const SCAN_TICK_BUDGET_MS = 9_500;
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
 * can push a coin. The 2_500ms floor stops a very slow pre-race from erasing
 * the scan entirely (a tick AT the floor is the alarm, not the fix: see
 * PreTickView and the two live witnesses below).
 */
export function scanRaceWindowMs(preRaceSpendMs: number): number {
  return Math.max(
    2_500,
    SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - preRaceSpendMs,
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
 * How long the shared heartbeat read above stays reusable. Wide enough to cover
 * the few hundred ms between ensureInitialized and the gate in the same tick,
 * short enough that the next tick (or a /health request a second later) always
 * re-reads: a stale heartbeat would shift the cadence gate and the dead-tick
 * backfill test by exactly that much.
 */
const HEARTBEAT_REUSE_MS = 2_000;

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
function beginPreTick(entryAt: number): void {
  // The subrequest window opens here, with the pre-scan split: both
  // handlers (cron and the HTTP fallback) enter through this seam, so a
  // window is one scan attempt's spend — the unit Cloudflare limits to 50
  // per invocation (see src/subreqs.ts). Anything else this isolate serves
  // inside the same window (a webhook, a /debug probe) is counted too, so
  // the reading is an upper bound on the tick; the phase ring is what
  // localizes it.
  beginSubreqWindow(entryAt);
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
 */
const SCAN_LOCK_TTL_MS = 15_000;
/**
 * Slack allowed between two scans beyond SCAN_INTERVAL_SECONDS when the
 * cadence gate compares against the previous tick's CLAIM time. The gate is
 * `now - heartbeat.at >= scanGapMs`, and `at` is written by the claim batch
 * ~1-4s AFTER cron fires — so a strict 60s gate measures ~56-58s on the
 * next tick and systematically skips it (live evidence 2026-09-07:
 * scan_history gaps of 121-122s, heartbeat 86s stale while a tick had
 * fired 28s earlier — every other tick silently did nothing). The margin
 * covers the claim offset + cron delivery jitter; overlap safety is the
 * scan lock's job (CAS claim, 55s TTL), not the gate's. With the margin,
 * SCAN_INTERVAL_SECONDS=60 scans on EVERY tick; 90/120 still gate to
 * every-other / every-third tick (gaps 60 < 80 < 120). Set generously:
 * a margin up to ~20s cannot double-scan (the previous scan releases the
 * lock at claim+~15s and a second trigger loses the CAS claim).
 */
const SCAN_GATE_MARGIN_MS = 10_000;
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
      const prevRaw = await Promise.race([
        db.getWorkerState("scan_heartbeat"),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), WEDGE_CHECK_BOUND_MS),
        ),
      ]);
      const now = Date.now();
      // This IS the tick's heartbeat read: the cadence gate below and the HTTP
      // fallback's own gate would each re-read the SAME row — one subrequest
      // apiece out of a 50-subrequest invocation budget, plus ~110-265ms of
      // wall clock each. Shared instead of duplicated (see lastHeartbeatRead /
      // HEARTBEAT_REUSE_MS).
      lastHeartbeatRead = { raw: prevRaw, at: now };
      const verdict = deadTickRebuildDecision(prevRaw, now, BACKFILL_STALE_MS);
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
        pushDeferralBaseline = { deferred: 0, recovered: 0 };
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
      const dead = prevRaw ? deadTickBackfillInfo(prevRaw, now, BACKFILL_STALE_MS) : null;
      if (dead) {
        // Bounded for the same reason as the announce write: the alert is the
        // LAST thing this tick needs, and a hung wedge read/write here would
        // spend the successor's front window on bookkeeping — the
        // amplification that turned one lost completion into the 2026-09-19
        // chains of 5+ dead ticks. The stretch stays open, so a bounded-away
        // alert is late, never lost.
        await recoveryAwait(
          trackNoCompletionStretch(dead.at, now),
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
  if (initPromise) return initPromise;
  initPromise = (async () => {
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
    // persisted tokens (Google/SSO accounts have no password — they get
    // tokens via /debug/axiom-tokens, which is re-checked after DB init).
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
          // A Google/SSO Axiom account has no password — its tokens are
          // persisted by /debug/axiom-tokens, so the feed is "configured"
          // whenever a stored access token exists too.
          const storedAxiomToken = await db?.getWorkerState("axiom_access_token");
          if (storedAxiomToken && config.axiomEnabled) axiomConfigured = true;
          // Mirror the durable deferral counters (src/deferrallog.ts) so this
          // isolate's heartbeats carry the fleet-wide numbers even before it
          // has any of its own. A row that does not exist yet loads as an
          // all-zero snapshot (never null): /health then reads "nothing has
          // been deferred yet" instead of something indistinguishable from a
          // missing counter channel, which is what makes the first rise
          // visible as 0 → 1 rather than null → object.
          try {
            pushDeferralSnapshot = loadPushDeferralSnapshot(
              await db?.getWorkerState(PUSH_DEFERRAL_STATE_KEY),
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
                parsePushLedger(await db?.getWorkerState(PUSH_LEDGER_STATE_KEY)),
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
              await db?.getWorkerState(SKIP_CAPTURE_STATE_KEY),
            );
          } catch {
            // telemetry only — never fail init over a counter read
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
    // insert per coin per tick, no extra request.
    const fetchPairs = dex.fetchPairsForTokens.bind(dex);
    dex.fetchPairsForTokens = async (addresses, deadline) => {
      const pairs = await fetchPairs(addresses, deadline);
      for (const [token, pair] of pairs) {
        const liq = pair.liquidity?.usd;
        if (typeof liq === "number" && Number.isFinite(liq))
          observedLiquidity.set(token, liq);
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
      // optional (Google/SSO accounts provide tokens via /debug/axiom-tokens
      // instead of a password; the client's login methods guard on that).
      // Decoupling from the trending switch keeps /debug/axiom-token-info
      // usable while the feed is off.
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
          // pump.fun discovery widens coverage beyond the DexScreener
          // profiles feed (best-effort — blocked/degraded feeds return []).
          new PumpFunClient(config),
          // GeckoTerminal new-pools discovery — free (no key), covers every
          // Solana DEX incl. pump.fun graduates (best-effort — blocked or
          // degraded feeds return [] and the scan continues on the others).
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
          // Meteora Data API newest-pools discovery — the launch slot's third
          // and last keyless source (best-effort; reached only when gecko's
          // new_pools AND pump.fun both came back empty — see src/meteora.ts).
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
          onTickStart: () => trade?.prefetchMode(),
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
            // Fire the drain WITHOUT awaiting it: the tick's budget is done
            // with these writes (that is the whole point of deferring them),
            // so the invocation tail must not pay for them either. The queue
            // is module state, so an isolate recycled before the drain lands
            // simply hands the same calls to the next tick's drain -- in call
            // order, which is the order the scanner wrote them in (the
            // registration insert first, then the max-mcap UPDATE). Same
            // pattern the deferral-counter sync already relies on ("its
            // promise is left running -- an idempotent write is welcome to
            // land late").
            const drained = drainDeferredWrites().then(() => flushObservedLiquidity());
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
        // this isolate; counters alone cannot guarantee a make-up push.
        scanner.seedDeferredTokens(pushDeferralSnapshot?.pendingTokens ?? []);
        scannerReady = true;
      }
    }
  })();
  await initPromise;
  // A failed Turso init (transient 522 / timeout) must not stick forever:
  // reset so the next tick re-attempts init and the isolate self-heals
  // once the database recovers, instead of staying scanner-less until
  // Cloudflare evicts it.
  if (tursoConfigured && !dbReady) {
    console.warn("[worker] Turso init failed — will retry on the next tick");
    initPromise = null;
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
): Promise<void> {
  if (!scanner) return;
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
        err: "previous tick died before its completion flush (backfilled by next tick)",
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
    ok: true,
    phase: "scanning",
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
  });
  preTick.steps.json = Date.now() - heartbeatAt;
  if (db) {
    const claimAt = Date.now();
    try {
      scanLock = await db.claimScanLock(
        SCAN_LOCK_OWNER,
        startedAt,
        SCAN_LOCK_TTL_MS,
        heartbeatJson,
        backfillEntry,
        cronTick ?? null,
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
      const scanRaceMs = scanRaceWindowMs(Date.now() - startedAt);
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
      await Promise.race([
        scanner.runOnce(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
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
      lastScanOk = !timedOut;
      // Report the SCAN RACE window, not the whole tick budget: the race now
      // ends SCAN_FLUSH_RESERVE_MS early, so quoting the budget sent the
      // operator chasing a 9.5s timeout on ticks that were cut at ~6s.
      // The pre-race split rides along because THIS row is the one a reader
      // chases, and without it the lost window can only be reconstructed by
      // subtraction (budget - reserve - window). Naming both halves also
      // separates a CPU-heavy payload from a slow claim round trip, which
      // have different fixes.
      lastScanError = timedOut
        ? `scan exceeded its ${scanRaceMs}ms race window (tick budget ${SCAN_TICK_BUDGET_MS}ms, flush reserve ${SCAN_FLUSH_RESERVE_MS}ms, preRace ${preTick.preRaceMs}ms = json ${preTick.steps.json} + claim ${preTick.steps.claim})`
        : null;
      if (timedOut) {
        console.error(`[worker] scan ran past its ${scanRaceMs}ms race window — completion written with timeout flag`);
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
      const flushCompletion = () =>
        db?.persistScanCompletion(
          JSON.stringify({
            at: flushedAt,
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
            summary,
          }),
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
          await scanner.runTrackerPass(
            Date.now() + trackerBudgetMs,
            holdTick ? (p: Promise<unknown>) => holdTick(p) : undefined,
          );
        } catch (err) {
          console.error(
            "[worker] tracker pass failed:",
            err instanceof Error ? err.message : err,
          );
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
      pushDeferralBaseline = { deferred: 0, recovered: 0 };
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
  // is where a request's work before the scan starts (see PreTickView).
  beginPreTick(now);
  if (now - lastScanTriggerAt < SCAN_TRIGGER_INTERVAL_MS) return;
  lastScanTriggerAt = now;
  // Dedupe against a healthy cron: skip when a scan already completed
  // recently (the heartbeat is written at scan completion). The fallback
  // exists to rescue a DEAD cron, not to double the scan rate — every extra
  // scan doubles the Turso rows-read and the upstream API pressure (which
  // is what triggers the gecko 429s). When cron delivers, this makes the
  // effective cadence exactly the configured 60s instead of ~1.5x it.
  // The heartbeat read doubles as the backfill input for runScan (a dead
  // predecessor's stale scanning heartbeat) — pass it down so the tick
  // adds no extra round trip on the wall-clock-critical path.
  let hbRaw: string | null = null;
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
    if (typeof at === "number" && now - at < SCAN_TRIGGER_INTERVAL_MS) return;
  } catch {
    // heartbeat unreadable — fail open and run the fallback scan
  }
  try {
    await runScan(hbRaw, env);
  } catch (err) {
    console.error(
      "[worker] fallback scan failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<Response> {
    await ensureInitialized(env);
    // Keep the scanner alive independently of cron delivery. waitUntil keeps
    // the isolate alive until the background scan settles — a bare `void`
    // promise gets frozen with the isolate right after the response returns,
    // which wedges the scanner's running-lock mid-scan (observed
    // 2026-08-14: heartbeat frozen for 90+ minutes while the lock read
    // "previous-scan-still-running"). Guarded by the last-trigger timestamp.
    ctx.waitUntil(maybeRunScanIfStale(env, ctx));
    const url = new URL(request.url);

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
      const message = renderMessage(
        mockCoin,
        null,
        null,
        null,
        true,
        null,
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
      try {
        const raw = await db?.getWorkerState("scan_heartbeat");
        heartbeat = raw ? JSON.parse(raw) : null;
        const at = (heartbeat as { at?: number } | null)?.at;
        if (typeof at === "number") lastScanGapMs = Date.now() - at;
      } catch {
        heartbeat = null;
      }
      // Effective trade mode: Telegram /setmode override wins over env.
      let effectiveTradeMode: string = cfg?.trade.mode ?? "off";
      let tradeModeOverride: string | null = null;
      try {
        effectiveTradeMode = (await trade?.effectiveMode()) ?? effectiveTradeMode;
        tradeModeOverride = (await db?.getTradeModeOverride()) ?? null;
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
      let pushWatchPass: unknown = null;
      try {
        const rawPass = await db?.getWorkerState("push_watch_pass");
        pushWatchPass = rawPass ? JSON.parse(rawPass) : null;
      } catch {
        pushWatchPass = null;
      }
      // Cross-isolate cron diagnostics: the scheduled handler persists a
      // running total + last event time to Turso, so any isolate serving
      // /health can prove whether the Cron Trigger is actually delivering.
      let scheduledTickTotal: number | null = null;
      let scheduledTickAt: number | null = null;
      let enabledChats: number | null = null;
      let tokenStatsCount: number | null = null;
      let pushedTotal: number | null = null;
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
      } | null = null;
      try {
        const rawTotal = await db?.getWorkerState("scheduled_tick_total");
        const rawAt = await db?.getWorkerState("scheduled_tick_at");
        scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;
        scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;
        enabledChats = (await db?.listEnabledChats())?.length ?? null;
        tokenStatsCount = (await db?.countTokenStats()) ?? null;
        pushedTotal = (await db?.countSeenTokens()) ?? null;
        const rawCu = await db?.getWorkerState(BIRDEYE_CU_STATE_KEY);
        birdeyeCu = {
          ...birdeyeCuStats(parseBirdeyeCuLedger(rawCu ?? null)),
          // This isolate's unpersisted spend is real spend too: the durable
          // row only moves when the throttled sync lands, so the stored
          // total alone under-reads for up to one sync gap.
          pendingCu: birdeyeCuPendingTotal(),
          monthlyMax: cfg?.birdeyeMonthlyCuMax ?? BIRDEYE_MONTHLY_CU_DEFAULT,
        };
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
        enabledChats,
        tokenStatsCount,
        pushedTotal,
        birdeyeCu,
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
        let outageAlertAt: number | null = null;
        // The last tracker pass's coverage line, as persisted by the pass
        // itself (see Scanner.runTrackerPass): the stage split that explains
        // HOW a rotation tick was spent, on the page built for exactly this
        // kind of forensics. In-memory carrying reached /health only when the
        // next tick landed on the same isolate (rare in practice), which is
        // why the 2026-09-21 stall had no stage split to read.
        let pushWatchPass: unknown = null;
        try {
          const rawRing = await db?.getWorkerState("scheduled_tick_ring");
          if (rawRing) {
            const parsed = JSON.parse(rawRing) as unknown;
            if (Array.isArray(parsed)) {
              ring = parsed.filter((v): v is number => typeof v === "number");
            }
          }
          const rawTotal = await db?.getWorkerState("scheduled_tick_total");
          const rawAt = await db?.getWorkerState("scheduled_tick_at");
          const rawAlert = await db?.getWorkerState("outage_alert_at");
          const rawPass = await db?.getWorkerState("push_watch_pass");
          scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;
          scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;
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

    // Axiom Trade login + trending probe. Login is interactive: step 1
    // (no params) submits the stored email/password and emails an OTP code;
    // step 2 (?otp=XXXXXX) completes login and persists the access/refresh
    // tokens in worker_state (survives isolate recycling). The trending
    // probe (?noauth=1 skips token use) exercises the same client the
    // scanner uses.
    if (url.pathname === "/debug/axiom-login") {
      const client = axiom;
      if (!client) {
        return Response.json({
          ok: false,
          error: "Axiom feed disabled (AXIOM_TRENDING_LIMIT=0) — the OTP login also needs AXIOM_EMAIL + AXIOM_PASSWORD (not available for Google/SSO accounts — use /debug/axiom-tokens)",
        });
      }
      const otp = (url.searchParams.get("otp") ?? "").trim();
      try {
        if (!otp) {
          const step1 = await client.loginStep1();
          if (!step1.otpJwtToken) {
            return Response.json({
              ok: false,
              error: "login step1 returned no otpJwtToken",
              raw: step1.raw,
            });
          }
          // Cache the OTP JWT briefly so step 2 doesn't need it re-sent.
          pendingAxiomOtpJwt = step1.otpJwtToken;
          return Response.json({
            ok: true,
            step: 1,
            message: "OTP code emailed — call again with ?otp=<code>",
          });
        }
        const jwt = pendingAxiomOtpJwt;
        if (!jwt) {
          return Response.json({
            ok: false,
            error: "no pending login — call /debug/axiom-login first (step 1)",
          });
        }
        const step2 = await client.loginStep2(jwt, otp);
        if (!step2.accessToken || !step2.refreshToken) {
          return Response.json({
            ok: false,
            error: "login step2 returned no tokens",
            raw: step2.raw,
          });
        }
        await db?.setWorkerState("axiom_access_token", step2.accessToken);
        await db?.setWorkerState("axiom_refresh_token", step2.refreshToken);
        pendingAxiomOtpJwt = null;
        return Response.json({ ok: true, step: 2, loggedIn: true });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Axiom token injection — for accounts without a password (Google/SSO):
    // log in on axiom.trade in your own browser, copy the auth-access-token
    // and auth-refresh-token cookie values, then call
    //   /debug/axiom-tokens?access=<token>&refresh=<token>
    // `access` alone is accepted (verifies worker egress immediately);
    // `refresh` is optional but strongly recommended — without it the feed
    // dies when the access token expires (JWT lifetime ≈ 16 min).
    if (url.pathname === "/debug/axiom-tokens") {
      const access = (url.searchParams.get("access") ?? "").trim();
      const refresh = (url.searchParams.get("refresh") ?? "").trim();
      if (!access) {
        return Response.json({
          ok: false,
          error: "missing ?access=<token> (refresh=<token> optional)",
        });
      }
      await db?.setWorkerState("axiom_access_token", access);
      if (refresh) {
        await db?.setWorkerState("axiom_refresh_token", refresh);
      }
      const storedRefresh = Boolean(refresh);
      axiomConfigured = true;
      const res: Record<string, unknown> = {
        ok: true,
        stored: true,
        refreshStored: storedRefresh,
        hint: storedRefresh
          ? "call /debug/axiom-trending to verify the feed"
          : "no refresh token stored — the feed will stop when the access token expires",
      };
      // Report the JWT expiry so the user can see how long the access token
      // is valid (middle segment is base64url JSON with iat/exp).
      try {
        const parts = access.split(".");
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf8"),
          );
          if (typeof payload.exp === "number") {
            res.accessExpiresAt = new Date(payload.exp * 1000).toISOString();
            res.accessLifetimeMin = Math.round((payload.exp - payload.iat) / 60);
          }
        }
      } catch {
        // non-JWT access token — skip expiry info
      }
      // Immediately verify with the just-stored token when a client exists.
      if (axiom) {
        try {
          const items = await axiom.fetchTrending(access, "1h", 5);
          res.count = items.length;
          res.sample = items.slice(0, 2).map((i) => ({
            symbol: i.symbol,
            mcap: i.marketCapUsd,
            sniper: i.sniperCount,
          }));
        } catch (err) {
          res.probeError = err instanceof Error ? err.message : String(err);
        }
      }
      return Response.json(res);
    }

    // Axiom refresh probe — exercises refreshAccessToken from the worker's
    // own egress with the stored refresh token (diagnoses whether the
    // refresh endpoint is reachable: 200 + new token = healthy; 418 = the
    // endpoint's bot-protection blocks worker fetch, like GMGN's edge did).
    if (url.pathname === "/debug/axiom-refresh") {
      const client = axiom;
      if (!client) {
        return Response.json({
          ok: false,
          error: "Axiom feed disabled (AXIOM_TRENDING_LIMIT=0)",
        });
      }
      const refreshToken = await db?.getWorkerState("axiom_refresh_token");
      if (!refreshToken) {
        return Response.json({ ok: false, error: "no refresh token stored" });
      }
      try {
        const out = await client.refreshAccessToken(refreshToken);
        if (out.accessToken) {
          await db?.setWorkerState("axiom_access_token", out.accessToken);
          if (out.refreshToken) {
            await db?.setWorkerState("axiom_refresh_token", out.refreshToken);
          }
        }
        return Response.json({
          ok: Boolean(out.accessToken),
          accessToken: out.accessToken ? "refreshed-and-stored" : null,
          refreshRotated: Boolean(out.refreshToken),
        });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Axiom trending probe — verifies the feed works end-to-end from the
    // worker's own egress with the stored token (diagnoses auth-expiry vs
    // blocked-egress vs parser mismatch).
    if (url.pathname === "/debug/axiom-trending") {
      const client = axiom;
      if (!client) {
        return Response.json({
          ok: false,
          error: "Axiom feed disabled (AXIOM_TRENDING_LIMIT=0)",
        });
      }
      const accessToken = await db?.getWorkerState("axiom_access_token");
      if (!accessToken) {
        return Response.json({
          ok: false,
          error: "not logged in — run /debug/axiom-login first",
        });
      }
      try {
        const t0 = Date.now();
        const items = await client.fetchTrending(accessToken, "1h", 10);
        return Response.json({
          ok: true,
          count: items.length,
          ms: Date.now() - t0,
          sample: items.slice(0, 3).map((i) => ({
            symbol: i.symbol,
            mcap: i.marketCapUsd,
            sniper: i.sniperCount,
            insiderPct: i.insiderPct,
            bundlePct: i.bundlePct,
            holders: i.holderCount,
          })),
        });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Axiom token-info probe — per-token detail metrics (holders,
    // numBotUsers, concentration) from /token-info-v2 using the stored session.
    // Refreshes once and retries on auth failure. Reveals the live schema
    // so card enrichment can be designed against real field names.
    if (url.pathname === "/debug/axiom-token-info") {
      const mint = (url.searchParams.get("mint") ?? "").trim();
      // Endpoint discovery: ?path=/xxx&param=yyy probes candidate API
      // surfaces with the live session. Defaults mirror the PRODUCTION
      // combo (/token-info-v2 + pairAddress) — the v2 endpoint returns full
      // data including numBotUsers, concentration, etc.
      const rawPath = url.searchParams.get("path") ?? "/token-info-v2";
      const path = rawPath.startsWith("/") ? rawPath : "/token-info-v2";
      const param = (url.searchParams.get("param") ?? "pairAddress").replace(/[^a-zA-Z0-9_]/g, "");
      // Raw passthrough for endpoints that require additional params
      // (e.g. top-traders-v4 needs onlyTrackedWallets + a v= timestamp).
      const extraQuery = (url.searchParams.get("extra") ?? "").replace(/[^a-zA-Z0-9_=&.]/g, "");
      // Optional host override for endpoint discovery — some routes only
      // exist on specific gateways (e.g. axiom.trade/api, api.axiomtrade.com).
      const hostsParam = (url.searchParams.get("host") ?? "")
        .split(",")
        .map((h) => h.trim().replace(/[^a-z0-9.\-]/g, ""))
        .filter(Boolean);
      if (!mint) {
        return Response.json({ ok: false, error: "missing ?mint=<address>" });
      }
      const client = axiom;
      if (!client) {
        return Response.json({
          ok: false,
          error: "Axiom client disabled",
        });
      }
      let accessToken = await db?.getWorkerState("axiom_access_token");
      if (!accessToken) {
        return Response.json({
          ok: false,
          error: "not logged in — run /debug/axiom-login first",
        });
      }
      // Refresh ONLY when the stored JWT is actually expired (or nearly):
      // every refresh rotates the refresh token, so unconditional refreshes
      // burn the session (the failure mode that killed it once already).
      const jwtExpired = (tok: string): boolean => {
        try {
          const payload = JSON.parse(
            Buffer.from(tok.split(".")[1] ?? "", "base64url").toString("utf8"),
          ) as { exp?: number };
          return !payload.exp || payload.exp * 1000 < Date.now() + 60_000;
        } catch {
          return true;
        }
      };
      const refreshToken0 = await db?.getWorkerState("axiom_refresh_token");
      if (!accessToken || jwtExpired(accessToken)) {
        if (refreshToken0) {
          try {
            const fresh = await client.refreshAccessToken(refreshToken0);
            if (fresh.accessToken) {
              accessToken = fresh.accessToken;
              await db?.setWorkerState("axiom_access_token", fresh.accessToken);
              if (fresh.refreshToken) {
                await db?.setWorkerState("axiom_refresh_token", fresh.refreshToken);
              }
            }
          } catch {
            // keep the stored token — maybe still valid
          }
        }
      }
      try {
        const out = await client.fetchTokenInfo(
          accessToken,
          mint,
          path,
          param,
          extraQuery,
          hostsParam.length ? hostsParam : undefined,
          refreshToken0 ?? undefined,
        );
        return Response.json({ ok: out.status === 200, status: out.status, data: out.data });
      } catch (err) {
        return Response.json({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

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
      ): Promise<ProbeReport> => {
        try {
          const res = await fetch(target, {
            headers: { Accept: "application/json", "User-Agent": GECKO_USER_AGENT },
            signal: AbortSignal.timeout(10_000),
          });
          const text = await res.text();
          if (!res.ok) {
            return { label, status: res.status, bytes: text.length, body: text.slice(0, 120) };
          }
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // non-JSON body (challenge page / HTML)
            return { label, status: res.status, bytes: text.length, body: text.slice(0, 120) };
          }
          return { label, status: res.status, bytes: text.length, ...pick(parsed) };
        } catch (err) {
          return { label, error: err instanceof Error ? err.message : String(err) };
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
        probe("pumpfun-legacy", "https://frontend-api.pump.fun/coins?limit=20&offset=0", coins),
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
      const ageMin = Math.max(
        0,
        Math.round((Date.now() - pair.pairCreatedAt) / 60_000),
      );
      const text =
        `📤 補發推送 ${pair.baseToken.symbol}（${row.symbol ?? pair.baseToken.symbol}）\n` +
        `💰 市值 ${usd(pair.marketCap)}（推送時 ${usd(row.mcapAtPush)}${chg === null ? "" : "，" + pctStr(chg)}）\n` +
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
      const rows = (await db?.getPushAudit()) ?? [];
      return Response.json({ ok: true, count: rows.length, rows });
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
      try {
        const rows = await db?.getFeedAttribution();
        return Response.json({ ok: true, byFeed: rows ?? [] });
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
      await runScan(undefined, env);
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
      try {
        const minAge = Math.min(...chats.map((c) => c.minAgeMinutes));
        const maxAge = Math.max(...chats.map((c) => c.maxAgeMinutes));
        const minMcap = Math.min(...chats.map((c) => c.minMarketCapUsd));
        const pool = await probe.getReevalPool({
          sinceMs: now - 30 * 3600_000,
          minLaunchMs: now - (maxAge + 180) * 60_000,
          maxLaunchMs: now - (minAge - 180) * 60_000,
          windowEntryLaunchMs: now - minAge * 60_000,
          limit: 1000,
          // Mirror the scanner's configured tiered rotation (near slots
          // swept every ~10 min, far slots every ~30 min, plus the
          // pre-qualification filter) so the probe's age histogram matches
          // what production actually evaluates.
          nearSlots: cfg?.reevalNearSlots ?? 2,
          farSlots: cfg?.reevalFarSlots ?? 6,
          rotationPeriodMs: cfg?.reevalPoolCacheMs,
          minQualifyMcap: minMcap / 2,
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
      return Response.json({
        ok: true,
        now: new Date(now).toISOString(),
        total: hist.total,
        neverPushed: hist.neverPushed,
        buckets: hist.buckets,
        eligibleInWindow: hist.eligibleInWindow,
        poolLimit: 1000,
        poolQueryCount,
        poolQueryBuckets,
      });
    }

    // Telegram webhook (grammY registers commands on this bot instance).
    if (webhook) {
      return webhook(request);
    }
    return new Response("Solana Meme Coin Scanner worker", { status: 200 });
  },

  async scheduled(
    _event: ScheduledEventLike,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    // Keep the invocation open for the tick's deferred writes (see
    // tickWaitUntil): a fire-and-forget drain is cancelled when the handler
    // returns — the 100%-failure shape measured above.
    beginPreTick(Date.now());
    tickWaitUntil = (promise) => ctx.waitUntil(promise);
    scheduledTicks++;
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
    const initAt = Date.now();
    await ensureInitialized(env);
    preTick.steps.init = Date.now() - initAt;
    if (!scanner) {
      preTick.steps.bump = await bumpScheduledTickLegacy(env);
      return;
    }
    // Cadence gate: the cron trigger fires every minute; SCAN_INTERVAL_SECONDS
    // (default 60s) lets the operator slow the scan (e.g. 90s — every other
    // tick, halving upstream API pressure and Turso rows-read). Skip the
    // scan when one completed recently; the DB heartbeat is the
    // cross-isolate source of truth (an in-memory timestamp can't gate
    // another isolate's cron delivery). The HTTP-driven fallback
    // (maybeRunScanIfStale) still rescues a dead cron within 2 min.
    const scanGapMs = Math.max(60_000, (cfg?.scanIntervalSeconds ?? 60) * 1000);
    // Gate against the CLAIM time minus the jitter margin (see
    // SCAN_GATE_MARGIN_MS): the heartbeat's `at` lands 1-4s after cron
    // fires, so a strict `scanGapMs` comparison skips every other tick at
    // the 60s cadence (2026-09-07 live: 121s history gaps). The scan lock,
    // not this gate, prevents overlapping scans.
    const gateMs = scanGapMs - SCAN_GATE_MARGIN_MS;
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
      const keys = ["scheduled_tick_total", "scheduled_tick_ring"];
      if (cachedHb === undefined) keys.push("scan_heartbeat");
      const kb = await db?.getWorkerStates(keys);
      hbRaw =
        cachedHb !== undefined ? cachedHb : (kb?.get("scan_heartbeat") ?? null);
      const at = hbRaw
        ? ((JSON.parse(hbRaw) as { at?: number } | null)?.at ?? 0)
        : 0;
      hbAt = typeof at === "number" && at > 0 ? at : null;
      cronTick = {
        at: cronAt,
        ring: [
          ...parseScheduledTickRing(kb?.get("scheduled_tick_ring") ?? null),
          cronAt,
        ],
      };
      if (hbAt !== null && Date.now() - hbAt < gateMs) {
        console.log(
          `[worker] cron tick skipped — last scan claimed ${Math.round((Date.now() - hbAt) / 1000)}s ago (< ${Math.round(gateMs / 1000)}s)`,
        );
        // A skipped tick still ARRIVED — record it (ONE write, no read).
        try {
          await db?.writeScheduledTick(cronTick);
        } catch (err) {
          console.error("[worker] skipped-tick cron bookkeeping failed:", err);
        }
        return;
      }
    } catch {
      // Heartbeat unreadable — fail open and run the scan. The arrival is
      // recorded through the standalone raw-client bump: with worker_state
      // unreadable there is no ring to hand the claim, and no reason to trust
      // the claim batch to run at all.
      cronTick = null;
      preTick.steps.bump = await bumpScheduledTickLegacy(env);
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
      await runScan(hbRaw, env, cronTick);
    } finally {
      scanRunning = false;
    }
  },
};
