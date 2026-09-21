import type { AppConfig } from "./config";
import type { Db } from "./db";
import type { BirdeyeClient } from "./birdeye";
import { fmtUsd } from "./format";
import { tradeKeyboard } from "./bot";
import {
  PUSH_LEDGER_STATE_KEY,
  findLedgerEntry,
  parsePushLedger,
} from "./pushledger";
// The self-heal's resend gate asks the same question the deferral guard does
// ("was a card for this token delivered?"), so it asks it with the same rule.
// The tracker's terminal card (2026-09-20) adds the other half of that rule:
// the disposition itself, the durable ring an abandoned send leaves, and the
// proof its settle reads back.
import {
  UNCONFIRMED_CARD_GRACE_MS,
  UNCONFIRMED_CARD_STATE_KEY,
  UNCONFIRMED_TERMINAL_STATE_KEY,
  addUnconfirmedCardSend,
  cardSendDisposition,
  deliveredCardTokens,
  deliveredFollowupTokens,
  parseUnconfirmedCardSends,
  removeUnconfirmedCardSend,
  serializeUnconfirmedCardSends,
  settleUnconfirmedCardSends,
} from "./deferrallog";

/**
 * Post-push tracker: every pushed coin is watched for a bounded window so
 * the bot can answer "which pushes keep going?" — the feedback loop the
 * scan pipeline lacks (a pushed coin is marked seen and never re-evaluated).
 *
 * Data budget: ONE DexScreener batched call per tick (≤30 addresses, reused
 * fetchPairsForTokens) + at most `maxHolderChecksPerTick` Birdeye holder
 * probes. Turso writes are one small UPDATE per tracked coin per tick.
 *
 * Alert kinds (each fires once per stage/state, with a per-coin cooldown):
 *   🚀 rising stages  — mcap crosses +50% / +100% / +200% / +400% vs push
 *   🔥 ignition       — 5m volume jumps from dormant (< $10K) to ≥ $15K
 *                       before any rising stage (early new-leg warning)
 *   ⚠️ weak           — ≥35% off the post-push peak (only if it had run up)
 *   💀 dead           — ≥55% off peak → fires once, then SILENT watch;
 *                       recovery to trough × 1.5 resurrects the row with
 *                       a fresh baseline (V-reversals)
 *   💧 liquidity      — collapsed >55% since the last check, OR absolute
 *                       floor breach (< $10K) → drained LP, mcap unreliable,
 *                       tracking stops
 *   📈 holders        — holder count +10% / +25% / +50% vs push (Birdeye)
 */

/**
 * Wall-clock slice ONE post-push tracker pass may use.
 *
 * The pass IS the tracker's rotation mechanism: it walks the tracked rows
 * least-recently-checked first, and each pass advances that queue by a head
 * (TRACKER_PAIR_HEAD rows at best). Where its time comes FROM has moved twice,
 * both times because measurement said so:
 *
 *  - 2026-09-17: 500 → 1000 → 1600. The pass ran INSIDE the scan and its
 *    mandatory stages (recap/prune, the self-heal read, one DexScreener
 *    batch) cost ~550-700ms, so at 500ms the row loop broke before its first
 *    row: 28 active rows went unrefreshed while /health read the healthy
 *    `ok:0/0`. 1600 covered one full row plus a second row's slack, spent out
 *    of whatever the scan tick had left.
 *  - 2026-09-21: the pass MOVED OUT of the scan (see Scanner.runTrackerPass
 *    and worker.TRACKER_PASS_BUDGET_MS) and this became its own ceiling. The
 *    scan's phases end at ~3.1s of a ~4.7s race window, so "whatever the tick
 *    has left" measured 400-1200ms — one or two rows per pass, i.e. a 29-row
 *    rotation in tens of minutes however cheap a row got. The same tick leaves
 *    ~4s of its budget unused behind the completion flush, so the pass is
 *    funded from there now: after the flush, with this as its ceiling.
 *
 * 2500ms is the measured cost of a full head: ~400ms of setup (listing,
 * recap/prune, terminal settle), ~600ms of pair batch (one DexScreener
 * request, capped by TRACKER_PAIRS_BUDGET_MS), then ONE store round trip per
 * silent row (~110-200ms each) plus any card sends — which are gated
 * separately by TRACKER_SEND_MIN_MS, not by this number.
 */
const TRACKER_TICK_BUDGET_MS = 5_000;
/**
 * Budget reserved BEFORE a row is claimed (see the row loop). A SILENT row —
 * nothing to announce, which is nearly every row on nearly every pass — costs
 * ONE round trip now (the claim and the check write are the same UPDATE, see
 * Db.claimPushWatchCheck), so ~300ms is the whole of what it needs to start
 * and land. A row that WILL alert is not gated by this number: the send-slice
 * check further down refuses it unless TRACKER_SEND_MIN_MS per card still
 * fits, and that reservation is the one that actually has to be honoured.
 *
 * It used to be a flat 900ms for every row, because every row's work was
 * claim + send + audit + write with nothing distinguishing the shapes. Applied
 * to silent rows that was five times their true cost and it capped the pass at
 * ONE row per tick: `rows 1/29 ... budget-cut` on every healthy tick, a 29-row
 * rotation measured in tens of minutes (live 2026-09-21).
 */
const TRACKER_ROW_MIN_MS = 300;
/**
 * Slice the SELF-HEAL stage may spend before it stands down and leaves the
 * rest of the pass to the rotation. Measured live 2026-09-21 03:12Z with the
 * stage clock on, this is the stage that stopped the whole tracker:
 *
 *   `ok:0/0 deferred:tick-budget allow 2500 spend[setup 746/3 heal 2926/7
 *    pairs 0/0 rows 0/0 holders 0/0] trips 10`
 *
 * The heal alone outran the entire allowance (its path — untracked-push
 * listing, delivered-card proof, push ledger, trade mode, one DexScreener
 * batch, the batched enroll INSERT and the audit row — is five to seven
 * store round trips at ~250-420ms each), so the pair batch never dispatched,
 * the row loop never ran, and the pass returned `deferred` with ZERO rows
 * evaluated on every tick: a 29-row rotation whose oldest row was 99 minutes
 * stale while /health read healthy, and the same heal work redone next tick.
 * The heal is a backstop (a push whose enrollment hook never ran), so it may
 * never eat the rotation's slice. The cap is sized to COMPLETE the stage when
 * the batch answers: the measured 2_926ms is seven round trips at the slow
 * end of the live range (~420ms), so 2_600 holds a working heal (and is what
 * lets a chronic one actually finish and stop being chronic) while still
 * leaving the reserve below untouched — the same seven trips at the healthy
 * ~250ms are ~1_750ms.
 */
const TRACKER_HEAL_BUDGET_MS = 2_600;
/**
 * Room the heal needs before it is even started. Below this the stage is
 * skipped whole and says so in the coverage note (`heal-skipped`), costing
 * the rotation nothing: the missing pushes are re-offered on the next pass by
 * the same listing. Its listing alone is one round trip (~250-420ms live).
 */
const TRACKER_HEAL_MIN_MS = 450;
/**
 * Rows the pass reserves for the ROTATION before any housekeeping stage may
 * spend anything: the pair batch (TRACKER_PAIRS_BUDGET_MS) plus this many
 * rows at TRACKER_ROW_MIN_MS each. The 2026-09-21 stall was housekeeping (the
 * heal) spending what the rows needed, so every optional stage's deadline is
 * now derived by SUBTRACTING this instead of hoping the rows still fit.
 * Two rows (plus the batch) is the floor that keeps a rotation moving even on
 * a tick where the heal had real work; a pass with nothing to heal gets the
 * whole allowance and runs the head.
 */
const TRACKER_ROW_RESERVE = 2;
/**
 * Hard ceiling on the time ONE ROW may spend sending its cards. A row can
 * carry up to four 🚀 stage cards and the sends were awaited with NOTHING
 * bounding them, so one slow Telegram response held the whole pass (and, when
 * the pass ran in front of the push path, the whole tick) open. Telegram
 * answers in a few hundred ms; a send that misses this ceiling is treated
 * exactly like a failed one — logged, not retried, because the state
 * transition was already reserved (see reservePushWatchAlert) and a retry
 * could deliver the duplicate card that guard exists to prevent.
 */
const TRACKER_SEND_CAP_MS = 1_000;
/**
 * Send slice for a row that starts AFTER the pass deadline. The first row of a
 * pass is exempt from the row reserve (the progress floor that keeps post-push
 * monitoring alive — see the 2026-09-17 zero-row fix), so it can begin with no
 * time left at all; bounding its sends at the full TRACKER_SEND_CAP_MS is what
 * let the pass finish ~1.3s past its deadline and push the whole tick into the
 * worker's kill window (live 2026-09-18: trackerMs 1895 against a 640ms
 * allowance, tick 4857ms of a ~4840ms race window, the flush landing on the
 * edge). A late row now gets one Telegram round trip's worth instead: a card
 * that misses it is logged and counted in the pass note (`undelivered N`)
 * and its transition is rolled back, so the next tick re-announces it —
 * the reservation only has to hold for the rest of THIS pass.
 */
const TRACKER_SEND_FLOOR_MS = 350;
/**
 * Send slice a card needs before its row may be STARTED. The reservation
 * below happens BEFORE the send, so a row that begins without this much
 * left cannot deliver its card inside this pass; it is then rolled back
 * and re-announced on the next tick (`undelivered N` in the note). The
 * pass still refuses such a row outright rather than collect the rollback,
 * because a refused row costs nothing at all (live 2026-09-18
 * 02:58Z/03:00Z: the reservation stood and the card was lost for good).
 * outright: no claim, no reservation, no write at all, so the card is
 * delivered by the next tick with a fresh budget and the row keeps its
 * place at the front of the rotation. 350ms is a healthy Telegram round
 * trip; the slice a row gets is TRACKER_SEND_CAP_MS, so a pass that starts
 * late still delivers one or two cards.
 */
const TRACKER_SEND_MIN_MS = 350;
/**
 * Cap on the Birdeye holder probe, which is purely ADDITIVE (a card detail):
 * nothing is reserved before it, `holders_checked_at` is only written on
 * success, so a miss costs nothing and is retried on the next tick. It was
 * the other unbounded await in the pass (a cold Birdeye round trip is
 * ~400-1500ms against a 1000ms budget).
 */
const TRACKER_HOLDER_CAP_MS = 400;
/**
 * Hard cap on the tracker's OWN DexScreener batch (the pass's one mandatory
 * request, handed to the client as a caller deadline so it stops dispatching
 * past it). Without this cap the batch ran on the client's own
 * PAIRS_FETCH_BUDGET_MS (1250ms) — LONGER than the pass budget — so a slow
 * batch silently consumed the entire pass and left the row loop with
 * nothing (see TRACKER_TICK_BUDGET_MS). 600ms still fits the shared
 * 250ms dispatch spacing plus a healthy round trip; a batch that misses it
 * is retried on the next tick (the pair cache makes the retry cheap).
 */
const TRACKER_PAIRS_BUDGET_MS = 600;
/**
 * Rows the pair batch covers: the HEAD of the rotation queue, not the whole
 * watch list. The row loop fits one or two rows inside the pass budget, so
 * asking DexScreener for all 30 addresses spent the pass's one mandatory
 * request on coins that were never evaluated this tick — and a batch that
 * missed its cap then made EVERY row a pair miss, so the pass did nothing at
 * all and reported `pairs 0/30 miss 30` (live 2026-09-18 02:01Z).
 *
 * 6 → 10 with the 5_000ms allowance (2026-09-21): at 3_500 the pass was
 * budget-cut after three rows (`rows 3/23 ... budget-cut`), so six covered
 * the head twice over; at 5_000 the loop can reach ~8-9 rows, and a head
 * smaller than that would silently cap the rotation at the head size. Ten
 * addresses is still ONE DexScreener request (the API takes up to 30) inside
 * the same ~150-600ms cap.
 */
const TRACKER_PAIR_HEAD = 10;
/**
 * Age past which a row the tracker has NEVER evaluated is treated as a
 * BACKFILL instead of a live follow-up: its push is older than the alert
 * cooldown (30 min) and nothing was observing the coin since, so whatever
 * its price did happened in a blind window. The first pass then absorbs the
 * state silently — bookkeeping (peak, liquidity, mcap, stage marks) is
 * written exactly as a normal pass would, but no card is sent — and only NEW
 * information alerts from the next check on. Without it, recovering from a
 * tracking outage fires a one-off burst of ~30 stale ⚠️/💀/💧 cards for
drawdowns that are hours old, and re-announces 🚀 milestones the operator
never had a chance to act on. The peak is still recorded, so the window's
🏁 recap reports the ride honestly ("峰值 +190%") without the spam.
 */
/**
 * Cap on the tokens waiting for a make-up send (see pendingUndelivered). A
 * held-back row normally comes back within one or two passes; the cap only
 * exists so a row that never re-fires (or was tombstoned meanwhile) cannot
 * grow the set forever — the oldest entry is evicted first.
 */
const TRACKER_UNDELIVERED_MAX = 200;
const STALE_BACKFILL_MS = 45 * 60_000;
/** Rising-stage thresholds (%) above the push-time mcap → state suffix. */
const RISING_STAGES = [50, 100, 200, 400] as const;
/**
 * Grace window for the self-heal's first-card resend: a claim newer than
 * this without an initial-audit entry is treated as "isolate died before
 * the card went out" and gets a re-sent card. Older claims predate the
 * audit ring (delivered long ago) or are far past any recovery point.
 */
const FIRST_CARD_RESEND_GRACE_MS = 15 * 60_000;
/**
 * Delivered-card proof for the resend gate: every token the audit ring shows a
 * card was ACCEPTED for, whatever kind wrote it — see
 * deferrallog.deliveredCardTokens for the rule and for why this one duplicate
 * became five (a card cut by the send deadline is delivered with no audit
 * entry, and the 補發 that followed wrote the token's only entry, kind
 * `resend`, which the old initial-only gate could not see).
 *
 * Read through a seam rather than by adding a method to the Db interface: the
 * Db doubles the heal tests drive implement the narrower initial-only reader,
 * and both readers are the SAME `push_audit` worker_state row, so the wider one
 * costs one extra trip per heal pass (only on a pass that found untracked
 * pushes) and nothing at all on a normal tick. A seam without the ring reader
 * degrades to the initial-only set — the pre-widen behaviour, never a crash and
 * never a dropped resend.
 */
async function readDeliveredTokens(database: Db): Promise<{
  tokens: Set<string>;
  unconfirmed: Set<string>;
  trips: number;
}> {
  const initial = await database.getInitialPushAuditTokens();
  let trips = 1;
  // Unconfirmed sends (deferrallog.UNCONFIRMED_CARD_STATE_KEY, the third state
  // of the send): a card whose send was ABANDONED — the race stopped waiting
  // while the request was still in flight, so it may already be in the chat and
  // it wrote no audit entry. That is proof of NOTHING, so it must NOT join
  // `tokens` (which is what licenses forgetting an obligation); it is its own
  // set and its only job is to hold the 補發 back while the record is pending
  // (see the gate below), because the record's own settle — the background
  // audit write, or the worker's reconcile — decides which it was.
  //
  // Fail-open both ways: an unreadable row (the heal tests' Db doubles
  // implement only the initial reader) reads as "none", which is exactly the
  // pre-three-state behaviour — the 補發 goes out when it used to.
  let unconfirmed = new Set<string>();
  const stateRead = (database as Partial<Pick<Db, "getWorkerState">>).getWorkerState;
  if (typeof stateRead === "function") {
    try {
      unconfirmed = new Set(
        parseUnconfirmedCardSends(
          await stateRead.call(database, UNCONFIRMED_CARD_STATE_KEY),
        ).map((r) => r.token),
      );
    } catch {
      unconfirmed = new Set();
    }
    trips += 1;
  }
  const read = (
    database as Partial<Pick<Db, "getPushAudit">>
  ).getPushAudit;
  if (typeof read !== "function") return { tokens: initial, unconfirmed, trips };
  try {
    const ring = await read.call(database);
    return {
      tokens: new Set([...initial, ...deliveredCardTokens(ring)]),
      unconfirmed,
      trips: trips + 1,
    };
  } catch {
    return { tokens: initial, unconfirmed, trips };
  }
}

/**
 * Heal-path counters (module scope, same shape as src/poolfallback.ts's).
 *
 * The self-heal's claim — a healed row is seeded from the ledger's push-time
 * value rather than the coin's CURRENT price — had no observable at all: the
 * enrollment it writes looks exactly like a normal one, and after the
 * 2026-09-19 fix it no longer produces the divergence the ledger would flag.
 * So these counters record the event (how many heals, and how many took the
 * ledger value vs the documented fallback), and each pass leaves ONE durable
 * entry in the delivery audit ring naming the coin and the baseline it was
 * seeded with (see the write after the enrollment batch).
 */
let healEnrolledTotal = 0;
let healFromLedgerTotal = 0;
let healFromCurrentMcapTotal = 0;
let healLastAt: number | null = null;

/** Read-only view for the heartbeat mirror (the worker reports it on /health). */
export function pushWatchHealStats(): {
  enrolled: number;
  fromLedger: number;
  fromCurrentMcap: number;
  lastAt: number | null;
} {
  return {
    enrolled: healEnrolledTotal,
    fromLedger: healFromLedgerTotal,
    fromCurrentMcap: healFromCurrentMcapTotal,
    lastAt: healLastAt,
  };
}

/** Test seam: the counters are module state, so tests need a reset. */
export function resetPushWatchHealStats(): void {
  healEnrolledTotal = 0;
  healFromLedgerTotal = 0;
  healFromCurrentMcapTotal = 0;
  healLastAt = null;
}
/**
 * ⚡ Price/holder divergence (the JEFFERY shape): price ≥ +25% vs push while
 * the holder base shrank ≥10% vs its rolling baseline — the run is being
 * carried by fewer and fewer wallets, so pullbacks tend to be fast and
 * deep. One card per activation; the "div" mark (persistent in up_stages)
 * re-arms as soon as either side of the condition recovers.
 */
const DIVERGENCE_MIN_GAIN_PCT = 25;
const DIVERGENCE_MIN_DROP_PCT = 0.10;
/** Drawdown-from-peak thresholds for the weak / dead states (%). */
const WEAK_DRAWDOWN_PCT = 35;
const DEAD_DRAWDOWN_PCT = 55;
/** A coin must have run up at least this much before "weak" can fire. */
const WEAK_MIN_RUNUP_PCT = 15;
/** Liquidity crash: current < 45% of the last check AND last ≥ $5K. */
const LIQ_CRASH_RATIO = 0.45;
const LIQ_CRASH_MIN_LAST_USD = 5_000;
/**
 * Absolute liquidity floor: below this the pool is considered drained.
 * DexScreener keeps reporting "marketCap" from the last traded price even
 * with zero liquidity, so every mcap-derived signal (rising stages, weak,
 * dead) becomes noise — stop tracking instead of acting on fake numbers.
 */
export const LIQ_FLOOR_USD = 10_000;
/**
 * The only liquidity reading a USD-level rule may judge: DexScreener's.
 *
 * This floor (and LIQ_CRASH_RATIO below, and the row's stored baseline) is
 * calibrated on DexScreener's `liquidity.usd` — the POOL's total USD
 * reserve. The tracker is fed by three legs (DexScreener → Jupiter →
 * GeckoTerminal) and the other two report a DIFFERENT metric of the same
 * pool, roughly half of it. Measured 2026-09-20 over the rotation: 10 of 14
 * recently-checked rows carried a reading at 0.46–0.58× the DexScreener
 * value (Lobby 7950 vs 17446, SI 13305 vs 26568, DONATED 29327 vs 55212)
 * while matching Jupiter's own `liquidity` to within 2%.
 *
 * The mismatch is not cosmetic: the floor is an ABSOLUTE $10K test, so a
 * healthy $17–21K pool read through the Jupiter leg looks drained. That is
 * exactly what fired the 💧 流動性枯竭 … 停止追蹤 card on a live Lobby
 * (2026-09-20 20:16 HKT) and marked it terminal. LIQ_CRASH_RATIO compares
 * two readings, so mixing legs fabricates drops that never happened too.
 *
 * Same discipline as the push gates' "missing data never judges": a reading
 * from any other leg counts as UNKNOWN for liquidity rules, and the row
 * keeps its last comparable baseline instead of overwriting it with a
 * number that cannot be compared to it. The next DexScreener-sourced check
 * of that row judges normally (the rotation re-checks every row within
 * minutes), so a real drain is still caught — just never on evidence that
 * is off by a factor of two.
 *
 * `feedSource` absent (legacy rows, test fixtures, synthetic pairs) =
 * DexScreener.
 */
export function comparableLiquidity(pair: {
  liquidity: { usd: number | null };
  feedSource?: "dexscreener" | "jupiter" | "gecko";
}): number | null {
  if (!liquidityIsComparable(pair)) return null;
  return pair.liquidity.usd;
}

/**
 * Whether this pair's `liquidity` came from the one leg every USD-level rule
 * is calibrated on (see comparableLiquidity).
 *
 * comparableLiquidity answers "what may a rule read?" (null = UNJUDGED). This
 * answers the narrower question a consumer asks when it must tell "that leg is
 * not comparable" from "that comparable leg has no reading": the push gate
 * (scanner.ts gateLiquidityUsd) still counts a missing DexScreener reading as
 * $0 depth — a drained pool reports 0 and must keep failing the floor — so it
 * cannot collapse both cases onto null. One source of truth for the rule
 * either way: untagged pairs (fixtures, synthetic, legacy rows) are
 * DexScreener's.
 */
export function liquidityIsComparable(pair: {
  feedSource?: "dexscreener" | "jupiter" | "gecko";
}): boolean {
  return pair.feedSource === undefined || pair.feedSource === "dexscreener";
}
/**
 * Volume ignition: a tracked coin whose 5m volume jumps from dormant
 * (< DORMANT) to >= VOL is often the first breath of a new leg (the CONK
 * pattern: 75 min of quiet consolidation, then a volume spike minutes
 * before the god candle). Early-warning only — it never fires once the
 * +50% rising stage has been crossed, where 🚀 alerts take over.
 */
export const IGNITION_VOL_USD = 15_000;
export const IGNITION_DORMANT_USD = 10_000;
/**
 * Holder-growth threshold vs the ROLLING baseline (holders_at_push). Each
 * 📈 alert rolls the baseline forward to the current count, so every card
 * reports fresh incremental growth (+10% over the last REPORTED step)
 * instead of re-measuring the same push-time delta.
 */
const MIN_HOLDER_GROWTH_PCT = 10;
/**
 * Sell-pressure dominance (🩸 distribution early-warning): an h1 window
 * where sells outnumber buys by more than 1/SELL_DOM_RATIO counts as a
 * sell-dominant check. SELL_DOM_STREAK_NEEDED consecutive checks = a
 * sustained distribution pattern — fires well before the -35% weak alert.
 * Only coins that actually ran up qualify: a flat loser's tape is naturally
 * sell-heavy, and its downside is already covered by weak/dead.
 */
const SELL_DOM_RATIO = 0.7;
const SELL_DOM_STREAK_NEEDED = 3;
const SELL_DOM_MIN_RUNUP_PCT = 15;
/** Minimum gap between 🩸 cards for the same coin. Thin-tape losers flip the
 * buy/sell ratio across the dominance line every few checks; without pacing,
 * each re-armed episode re-fires a near-identical card (same rolling 1h
 * counts). Paced episodes are deferred, not dropped — see the >= below. */
const SELL_DOM_PACE_MS = 60 * 60_000;
/**
 * Resurrection trigger: a 💀-marked coin re-alerts when it recovers to
 * this multiple of its DEAD-TIME TROUGH (not the push baseline). Requiring
 * the full push baseline means a deep flush (-70%) can practically never
 * resurrect even on a real reversal; trough × 1.5 catches the V while it
 * is happening. Legacy rows without a recorded trough fall back to the
 * push baseline × the same multiple.
 */
const RESURRECTION_MULT = 1.5;

export interface PushWatchRow {
  token: string;
  chatId: string;
  symbol: string | null;
  pushedAt: number;
  mcapAtPush: number;
  peakMcap: number;
  lastLiquidity: number | null;
  lastVol5m: number | null;
  /** Lowest mcap observed while in the dead state (resurrection anchor). */
  deadTroughMcap: number | null;
  holdersAtPush: number | null;
  holdersLast: number | null;
  holdersCheckedAt: number | null;
  lastChecked: number;
  lastAlertAt: number;
  followupsSent: number;
  lastState: string | null;
  /** Consecutive sell-dominant checks (🩸 streak; resets on recovery). */
  sellDomStreak: number;
  /** Most recent mcap seen by the tracker (recap final value). */
  lastMcap: number | null;
  /** CSV of 🚀 stages already announced (up50,up100,…). Persistent so a
   * ⚠️/🔥 overwrite of lastState cannot re-announce the same milestone. */
  upStages: string | null;
}

export interface WatchAlert {
  kind:
    | "rising"
    | "weak"
    | "dead"
    | "divergence"
    | "liquidity"
    | "holders"
    | "ignition"
    | "sell-pressure";
  text: string;
}

export interface WatchEval {
  alerts: WatchAlert[];
  /** New peak mcap to persist (max of stored and live). */
  peakMcap: number;
  followupsSent: number;
  lastState: string | null;
  lastAlertAt: number;
  stopTracking: boolean;
  /**
   * Set on resurrection: the row's mcapAtPush (and peak) should be reset
   * to this value so the next cycle measures from the recovery point.
   */
  resetBaselineMcap?: number;
  /**
   * Set when a 📈 holder alert fires: roll holders_at_push forward to this
   * value so the NEXT card measures incremental growth from the last
   * reported count, not the push-time number (kills the "216 → 340" /
   * "216 → 341" repeat shape).
   */
  resetBaselineHolders?: number;
  /** New dead-state trough to persist (lower low while silent-watching). */
  deadTroughMcap?: number | null;
  /** New 🩸 streak count to persist. */
  sellDomStreak: number;
  /** CSV to persist into up_stages (undefined = keep; '' = clear, resurrection). */
  announcedUpStages?: string;
}

function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(0)}%`;
}

/**
 * Pure rules engine (exported for offline unit tests). Given the stored row
 * and the freshly-fetched pair data, decide which alerts fire and what to
 * persist. Never throws; cooldown suppresses spam but bookkeeping still
 * updates so peaks/liquidity stay fresh.
 */
export function evaluateWatch(
  row: PushWatchRow,
  now: number,
  live: {
    mcap: number;
    liquidity: number | null;
    chg5m: number;
    vol5m: number;
    buysH1: number;
    sellsH1: number;
  },
  cfg: { cooldownMs: number; liqFloorUsd?: number },
): WatchEval {
  const alerts: WatchAlert[] = [];
  const symbol = row.symbol ?? "?";
  const peakMcap = Math.max(row.peakMcap, live.mcap);
  const chgSincePush = (live.mcap / Math.max(row.mcapAtPush, 1) - 1) * 100;
  const drawdownFromPeak =
    peakMcap > 0 ? (live.mcap / peakMcap - 1) * 100 : 0;
  const cooledDown = now - row.lastAlertAt >= cfg.cooldownMs;
  let lastState = row.lastState;
  let lastAlertAt = row.lastAlertAt;
  let followupsSent = row.followupsSent;
  let resetBaselineHolders: number | undefined;
  let announcedUpStages: string | undefined;

  const fire = (kind: WatchAlert["kind"], text: string) => {
    alerts.push({ kind, text });
    lastAlertAt = now;
    followupsSent += 1;
  };

  // Liquidity drained outright (LP ≈ 0): the reported mcap is just the last
  // traded price × supply and carries no information. Wins over every other
  // state so we never send 🚀 off a zombie number.
  const liqFloor = cfg.liqFloorUsd ?? LIQ_FLOOR_USD;
  if (live.liquidity !== null && live.liquidity < liqFloor) {
    fire(
      "liquidity",
      `💧 流動性枯竭 ${symbol} | LP 僅剩 ${fmtUsd(live.liquidity)}（< ${fmtUsd(liqFloor)}），市值數據已失真（LP 被抽乾），停止追蹤`,
    );
    return {
      alerts,
      peakMcap,
      followupsSent,
      lastState: "rug",
      lastAlertAt,
      stopTracking: true,
      sellDomStreak: row.sellDomStreak ?? 0,
    };
  }

  // Resurrection / silent-watch: once a coin is 💀 it is FULLY silent
  // until it recovers to trough × 1.5 (then a fresh cycle starts). Without
  // this absorption the stale-peak math would keep firing weak/ignition on
  // every bounce below the target.
  if (row.lastState === "dead") {
    const target = (row.deadTroughMcap ?? row.mcapAtPush) * RESURRECTION_MULT;
    if (live.mcap >= target) {
      fire(
        "rising",
        `🟢 死而復生 ${symbol} | 從低點 ${fmtUsd(row.deadTroughMcap ?? live.mcap)} 反彈越過 ${fmtUsd(target)}（×${RESURRECTION_MULT}），重置基準繼續追蹤`,
      );
      return {
        alerts,
        peakMcap: live.mcap,
        followupsSent,
        lastState: null,
        lastAlertAt,
        stopTracking: false,
        resetBaselineMcap: live.mcap,
        deadTroughMcap: null,
        sellDomStreak: 0,
        announcedUpStages: "",
      };
    }
    const trough = Math.min(row.deadTroughMcap ?? live.mcap, live.mcap);
    return {
      alerts,
      peakMcap,
      followupsSent,
      lastState: "dead",
      lastAlertAt,
      stopTracking: false,
      deadTroughMcap: trough,
      sellDomStreak: row.sellDomStreak ?? 0,
    };
  }

  // Dead: ≥55% off the peak. Fires ONCE (the row then enters the silent
  // watch above) — deep-flush V-reversals are common, so recovery to
  // trough × 1.5 resurrects it. Peak is always ≥ push mcap, so this also
  // catches never-ran-up straight dumps.
  if (drawdownFromPeak <= -DEAD_DRAWDOWN_PCT) {
    fire(
      "dead",
      `💀 走死 ${symbol} | 峰值 ${fmtUsd(peakMcap)} → 現 ${fmtUsd(live.mcap)} (${pct(drawdownFromPeak)})，轉入靜默監控（收復 ${fmtUsd(live.mcap * RESURRECTION_MULT)}＝低點 ×1.5 會再通知）`,
    );
    return {
      alerts,
      peakMcap,
      followupsSent,
      lastState: "dead",
      lastAlertAt,
      stopTracking: false,
      deadTroughMcap: live.mcap,
      sellDomStreak: row.sellDomStreak ?? 0,
    };
  }

  // Sell-pressure dominance (🩸 distribution early-warning): consecutive 1h
  // windows with sells outnumbering buys. Fires from the Nth streak check
  // onward, paced at most one card per SELL_DOM_PACE_MS — thin tapes flip
  // the ratio back and forth, resetting the streak and re-arming rapidly;
  // the pace gate turns that into at most one card per hour per coin.
  // Runs OUTSIDE the cooldown gate: distribution is worth seeing promptly,
  // and the streak plus pace together keep it from becoming noise.
  const runupFromPushPct = (peakMcap / Math.max(row.mcapAtPush, 1) - 1) * 100;
  let sellDomStreak = row.sellDomStreak ?? 0;
  if (live.sellsH1 > 0 && live.buysH1 / live.sellsH1 < SELL_DOM_RATIO) {
    sellDomStreak += 1;
  } else {
    sellDomStreak = 0;
  }
  if (
    sellDomStreak >= SELL_DOM_STREAK_NEEDED &&
    runupFromPushPct >= SELL_DOM_MIN_RUNUP_PCT &&
    now - (row.lastAlertAt ?? 0) >= SELL_DOM_PACE_MS
  ) {
    fire(
      "sell-pressure",
      `🩸 賣壓主導 ${symbol} | 1h 買賣比 ${(live.buysH1 / Math.max(live.sellsH1, 1)).toFixed(1)}:1，` +
        `連續 ${sellDomStreak} 次檢查賣壓佔優（賣 ${live.sellsH1} vs 買 ${live.buysH1}）— 分佈出貨形態`,
    );
  }

  if (cooledDown) {
    // Volume ignition (early-warning, pre-🚀 only): dormant tape suddenly
    // prints a big 5m volume bar.
    if (
      chgSincePush < RISING_STAGES[0] &&
      live.vol5m >= IGNITION_VOL_USD &&
      (row.lastVol5m ?? 0) < IGNITION_DORMANT_USD &&
      lastState !== "ignite"
    ) {
      fire(
        "ignition",
        `🔥 量能點火 ${symbol} | 5m量 ${fmtUsd(live.vol5m)}（前值 ${fmtUsd(row.lastVol5m ?? 0)}）| 5m ${pct(live.chg5m)} — 疑似新一段行情啟動`,
      );
      lastState = "ignite";
    }

    // Rising stages: fire the highest crossed stage not yet announced.
    // Memory lives in the PERSISTENT up_stages column — lastState is shared
    // with ⚠️/🔥 and gets wiped by them, which re-announced the same
    // milestone (three 🚀 JEFFERY cards in one hour). The card also names
    // the NEXT milestone so every card carries forward-looking info.
    const firedStages = new Set<string>();
    for (const s of (row.upStages ?? "").split(",")) if (s) firedStages.add(s);
    if (lastState?.startsWith("up")) firedStages.add(lastState);
    const preFireStages = [...firedStages].sort().join(",");
    for (let i = RISING_STAGES.length - 1; i >= 0; i--) {
      const stage = RISING_STAGES[i];
      const state = `up${stage}`;
      if (chgSincePush >= stage && !firedStages.has(state)) {
        const bs =
          live.buysH1 + live.sellsH1 > 0
            ? `${(live.buysH1 / Math.max(live.sellsH1, 1)).toFixed(1)}:1`
            : "—";
        const nextStage = i + 1 < RISING_STAGES.length ? RISING_STAGES[i + 1] : null;
        fire(
          "rising",
          `🚀 續漲 ${symbol} | 推送時 ${fmtUsd(row.mcapAtPush)} → ${fmtUsd(live.mcap)} (${pct(chgSincePush)}) | 峰值回撤 ${pct(drawdownFromPeak)} | 5m ${pct(live.chg5m)} | 買賣比 ${bs}(h1)` +
            (nextStage ? ` | 下一關 +${nextStage}%` : " | 已達最高里程碑"),
        );
        firedStages.add(state);
        lastState = state;
        break; // one stage per cooldown window
      }
    }
    {
      const csv = [...firedStages].sort().join(",");
      if (csv !== (row.upStages ?? "").split(",").sort().join(",")) {
        announcedUpStages = csv;
      }
    }

    // Weak: meaningful runup then ≥35% off the peak. Depth-staged with
    // PERSISTENT memory (w35/w45 marks in up_stages next to the 🚀 stages):
    // a 📈/🚀 overwriting lastState used to re-fire the same ⚠️ one cooldown
    // later (BABYCATE -37% then -39%). Escalates once more at -45%; re-arms
    // only on real recovery above -25%; dead takes over at -55%.
    const runupPct = (row.peakMcap / Math.max(row.mcapAtPush, 1) - 1) * 100;
    if (drawdownFromPeak > -25) {
      firedStages.delete("w35");
      firedStages.delete("w45");
    }
    const weakMark = drawdownFromPeak <= -45 ? "w45" : "w35";
    if (
      drawdownFromPeak <= -WEAK_DRAWDOWN_PCT &&
      runupPct >= WEAK_MIN_RUNUP_PCT &&
      !firedStages.has(weakMark)
    ) {
      fire(
        "weak",
        `⚠️ 動能轉弱 ${symbol} | 峰值 ${fmtUsd(peakMcap)} → 現 ${fmtUsd(live.mcap)} (${pct(drawdownFromPeak)})`,
      );
      firedStages.add(weakMark);
      lastState = "weak";
      const csv = [...firedStages].sort().join(",");
      if (csv !== (row.upStages ?? "").split(",").sort().join(",")) {
        announcedUpStages = csv;
      }
    }

    // Liquidity crash.
    if (
      live.liquidity !== null &&
      row.lastLiquidity !== null &&
      row.lastLiquidity >= LIQ_CRASH_MIN_LAST_USD &&
      live.liquidity < row.lastLiquidity * LIQ_CRASH_RATIO &&
      lastState !== "liq"
    ) {
      const dropPct = (live.liquidity / row.lastLiquidity - 1) * 100;
      fire(
        "liquidity",
        `💧 流動性驟降 ${symbol} | ${fmtUsd(row.lastLiquidity)} → ${fmtUsd(live.liquidity)} (${pct(dropPct)})`,
      );
      lastState = "liq";
    }

    // Holder growth (Birdeye), measured against a ROLLING baseline: each
    // 📈 alert rolls holders_at_push forward, so a repeat requires ANOTHER
    // +10% of NEW holders — a +1 drift like 340 → 341 never re-fires. The
    // old stage machine keyed off the shared lastState, so any 🚀/⚠️ alert
    // wiping it let the same-stage 📈 re-send with near-identical content.
    if (
      cooledDown &&
      row.holdersAtPush !== null &&
      row.holdersLast !== null &&
      lastState !== "hold"
    ) {
      const growth =
        (row.holdersLast / Math.max(row.holdersAtPush, 1) - 1) * 100;
      if (growth >= MIN_HOLDER_GROWTH_PCT) {
        fire(
          "holders",
          `📈 持倉增長 ${symbol} | ${row.holdersAtPush.toLocaleString()} → ${row.holdersLast.toLocaleString()} (+${growth.toFixed(0)}%)`,
        );
        lastState = "hold";
        resetBaselineHolders = row.holdersLast;
      }
    }

    // ⚡ Divergence detector: strong price gain on a SHRINKING holder base.
    // Persistent "div" mark (up_stages): fires once per activation and
    // re-arms as soon as holders stop shrinking or the gain cools off.
    if (row.holdersAtPush !== null && row.holdersLast !== null && row.holdersAtPush > 0) {
      const holderRatio = row.holdersLast / row.holdersAtPush;
      const divActive =
        chgSincePush >= DIVERGENCE_MIN_GAIN_PCT &&
        holderRatio <= 1 - DIVERGENCE_MIN_DROP_PCT;
      if (!divActive && firedStages.has("div")) {
        firedStages.delete("div");
        const csv = [...firedStages].sort().join(",");
        if (csv !== (row.upStages ?? "").split(",").sort().join(",")) {
          announcedUpStages = csv;
        }
      }
      if (
        cooledDown &&
        divActive &&
        !firedStages.has("div")
      ) {
        fire(
          "divergence",
          `⚡ 籌碼集中 ${symbol} | 價 ${pct(chgSincePush)}（推送時 ${fmtUsd(row.mcapAtPush)} → ${fmtUsd(live.mcap)}）| 持倉 ${row.holdersAtPush.toLocaleString()} → ${row.holdersLast.toLocaleString()} (${pct((holderRatio - 1) * 100)})— 價漲人跌：漲幅由越來越少的錢包推動，回撤會又快又深`,
        );
        firedStages.add("div");
        lastState = "divergence";
        const csv = [...firedStages].sort().join(",");
        if (csv !== (row.upStages ?? "").split(",").sort().join(",")) {
          announcedUpStages = csv;
        }
      }
    }
  }

  return {
    alerts,
    peakMcap,
    followupsSent,
    lastState,
    lastAlertAt,
    stopTracking: false,
    resetBaselineHolders,
    sellDomStreak,
    announcedUpStages,
  };
}

/**
 * Final verdict for a coin leaving the tracking window — one line for the
 * 🏁 recap card. Aligned with the rule engine's semantics: rug beats
 * everything (LP data is fake), a -55%+ finish is 走死 regardless of peak,
 * then the peak multiple grades the ride.
 */
export function recapVerdict(
  mcapAtPush: number,
  peakMcap: number,
  finalMcap: number | null,
  lastState: string | null,
): string {
  if (lastState === "rug") return "💧 rug（LP 枯竭，數據已失真）";
  const finalRatio =
    mcapAtPush > 0 && finalMcap !== null ? finalMcap / mcapAtPush : 1;
  if (finalRatio <= 0.45) return "💀 走死收場（較推送 -55%+）";
  const peakX = mcapAtPush > 0 ? peakMcap / mcapAtPush : 0;
  if (peakX >= 4) return "🏆 金狗級（峰值 +300%+）";
  if (peakX >= 2) return "🚀 強勢（峰值 +100%+）";
  if (peakX >= 1.5) return "📈 穩漲（峰值 +50%+）";
  if (finalRatio >= 0.9) return "➡️ 橫盤收場（守住推送價）";
  return "📉 回落收場";
}

/** The one-per-coin 🏁 card sent when a coin exits the tracking window. */
export function recapMessage(row: PushWatchRow): string {
  const symbol = row.symbol ?? row.token.slice(0, 6);
  const peakPct = row.mcapAtPush > 0 ? (row.peakMcap / row.mcapAtPush - 1) * 100 : 0;
  const verdict = recapVerdict(
    row.mcapAtPush,
    row.peakMcap,
    row.lastMcap ?? null,
    row.lastState,
  );
  const hours = Math.max(0, Math.round((Date.now() - row.pushedAt) / 3_600_000));
  return (
    `🏁 結案報告 ${symbol} | 追蹤 ~${hours}h\n` +
    `推送 ${fmtUsd(row.mcapAtPush)} → 峰值 ${fmtUsd(row.peakMcap)}（最高 +${peakPct.toFixed(0)}%）` +
    (row.lastMcap !== null ? ` → 終值 ${fmtUsd(row.lastMcap)}` : "") +
    `\n判定：${verdict} | 跟進警報 ${row.followupsSent} 次`
  );
}

/**
 * One TERMINAL card send's outcome: Telegram ACCEPTED the card, Telegram
 * REJECTED it, or we STOPPED WAITING while the request was still in flight.
 * The third state is the whole point — the two-state send folded it into
 * "failed" and rolled the row's announcement back, which is how a card that
 * said 停止追蹤 left its row ACTIVE and re-announceable (live 2026-09-20,
 * Lobby). The initial-card path made the same fix one commit earlier; see
 * deferrallog.cardSendDisposition for the rule they share.
 */
type TerminalSendOutcome =
  | { outcome: "sent"; message: unknown }
  | { outcome: "failed" }
  | { outcome: "abandoned" };

/**
 * Service wrapper: owns the per-tick refresh loop and the Telegram delivery.
 * All network/db work is best-effort — a tracker failure must never affect
 * the scan or a push.
 */
export class PushWatcher {
  /**
   * The rotation queue's HEAD from the last pass (see runTick). The scanner's
   * front pair phase reads it so the tracker's coins are fetched alongside
   * the pool (see Scanner.lastPairs / pairsForTracker): tracked coins are
   * PUSHED coins, which the re-eval pool query excludes, so without this the
   * tracker's own batch is the only thing that ever asks for them — and while
   * DexScreener is rate-limited that batch comes back empty and the pass
   * evaluates zero rows (live 2026-09-18 02:37Z and 02:41Z: `pairs 0/6 miss 1`
   * on both, from a client reporting `http429 4, blockedForMs 30256,
   * cacheSize 0` — while the front phase still resolved 130/130 through the
   * Jupiter fallback). One tick of lag is enough: the head advances by a row
   * or two per pass, so yesterday's head covers today's.
   */
  private lastHeadTokens: string[] = [];
  /**
   * Cross-tick ledger for cards a pass could not deliver. `undelivered`
   * is per PASS (it feeds the note), so the rate vanished with the next
   * tick's note and "the card really was re-announced later" could not be
   * observed at all — the note only ever showed the loss, never the
   * recovery. These counters are per ISOLATE and ride every runTick
   * result, so /health carries the running totals across ticks.
   */
  private undeliveredTotal = 0;
  private recoveredUndeliveredTotal = 0;
  /**
   * Tokens whose last pass held a card back (rolled back, not recorded as
   * announced). Bounded — a row that never re-fires (or is tombstoned)
   * must not grow this forever; the oldest entry is evicted first.
   */
  private readonly pendingUndelivered = new Set<string>();
  /**
   * TERMINAL cards (the 💧 drain card) whose send was ABANDONED this isolate
   * has seen: the race stopped waiting while the request was still in flight,
   * so the card may or may not be in the chat. Cumulative for /health (the
   * pass note carries the per-pass number) because this path deliberately does
   * NOT roll back — the same "counted so it is observable instead of merely
   * argued" discipline as undeliveredTotal.
   */
  private terminalAbandonedTotal = 0;
  /**
   * Unconfirmed terminal records THIS isolate wrote since its last successful
   * settle read. The settle also probes ONCE per isolate (settleProbed) for a
   * record an isolate that already died could not settle — the reason the ring
   * is durable at all — so a pass with nothing pending costs no round trip.
   */
  private unconfirmedWrites = 0;
  private settleProbed = false;

  /** Tokens the last pass put at the front of its rotation queue. */
  headTokens(): string[] {
    return [...this.lastHeadTokens];
  }

  /**
   * Record that `cards` cards for this row could not be delivered, so the
   * cumulative counter and the make-up backlog move together (and the backlog
   * stays bounded).
   */
  private markUndelivered(token: string, cards: number): void {
    this.undeliveredTotal += cards;
    this.pendingUndelivered.add(token);
    while (this.pendingUndelivered.size > TRACKER_UNDELIVERED_MAX) {
      const oldest = this.pendingUndelivered.values().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.pendingUndelivered.delete(oldest);
    }
  }

  constructor(
    private readonly db: Db,
    private readonly bot: {
    api: {
      sendMessage(
        chatId: string,
        text: string,
        opts?: { reply_markup?: unknown },
      ): Promise<unknown>;
    };
  },
    private readonly birdeye: BirdeyeClient | null,
    private readonly config: AppConfig,
    /** Live pair data for ≤30 addresses (the DexScreener client method). */
    private readonly pairsFor: (
      addresses: string[],
      /** Optional epoch-ms cap for this call (see TRACKER_PAIRS_BUDGET_MS). */
      deadlineMs?: number,
    ) => Promise<Map<string, import("./dexscreener").PairInfo>>,
    /**
     * Trade service (optional — null when BOT_WALLET_PRIVATE_KEY is unset).
     * The heal-resend uses it to render the same buy/sell/mode buttons a
     * normal first card carries; null degrades to link + unwatch only.
     */
    private readonly trade?: {
      effectiveMode(): Promise<"off" | "manual" | "auto">;
      buySizeLabel: string;
    } | null,
  ) {}

  private hasTrade(): boolean {
    return Boolean(this.trade);
  }

  private tradeBuySizeLabel(): string {
    return this.trade?.buySizeLabel ?? "";
  }

  private async tradeMode(): Promise<"off" | "manual" | "auto"> {
    return this.trade ? await this.trade.effectiveMode() : "off";
  }

  /**
   * Bounds ONE network stage to `capMs`. The work is NOT cancelled — the
   * caller stops waiting and a late settle is dropped, the same contract as
   * the scanner's bestEffort(). Callers decide what a miss MEANS (the alert
   * loop treats it as a failed send, the holder probe as a skip).
   *
   * Why this exists: the pass awaited its two network stages with nothing
   * bounding them. Every budget check happens BETWEEN stages, so a stage that
   * never returns held the pass open regardless of its budget — live
   * 2026-09-17: `trackerMs 1962` against a 1000ms budget (tick 4310ms of a
   * 4839ms race window). The DB layer has had a cap since the scan-cap change
   * (SCAN_DB_TIMEOUT_MS); these two were the remaining unbounded awaits.
   */
  private async bounded<T>(
    work: Promise<T>,
    capMs: number,
    fallback: T,
  ): Promise<T> {
    if (capMs <= 0) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), capMs);
        }),
      ]);
    } finally {
      // Release the timer as soon as the stage settles (same discipline as
      // the DB hard wall) so a busy isolate holds no idle timers.
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Called right after a successful push (ON CONFLICT DO NOTHING dedupes). */
  async onPush(
    chatId: string,
    token: string,
    symbol: string | null,
    mcapAtPush: number,
    liquidityUsd: number | null,
  ): Promise<void> {
    await this.db.upsertPushWatch({
      token,
      chatId,
      symbol,
      pushedAt: Date.now(),
      mcapAtPush,
      liquidityUsd,
    });
    // `mcapAtPush` here IS the gate value (the same frozen pair object the
    // band tested), and it is the value the durable push-baseline ledger
    // records as authoritative for this token (see src/pushledger.ts and the
    // worker's syncPushLedger). Nothing extra is written on the push path:
    // this runs inside the tick's card-send slice, where a round trip is
    // budget the card itself may need.
  }

  /**
   * One tracker pass: prune expired rows, refresh ≤30 coins via one
   * DexScreener batch, evaluate rules, deliver alerts, and refresh holder
   * counts for at most `maxHolderChecksPerTick` coins (oldest check first).
   *
   * `deadlineMs` (optional) is an absolute epoch ms the CALLER's tick must be
   * done by. The scanner calls this pass LAST, after the candidate/push
   * phase, so the deadline is whatever the tick has left (minus its finish
   * reserve) — follow-ups are hour-scale and every row is re-claimed on the
   * next tick, so a truncated pass loses only latency while a delayed push is
   * gone for good. When provided, the pass is clamped to that AND to
   * TRACKER_TICK_BUDGET_MS. Either way the limit is checked only BETWEEN
   * stages and rows, so a truncated pass can never cut an alert after its
   * reservation was written (left-over rows are claimed and evaluated on the
   * next tick) — with ONE exception: the loop's first row always runs, so a
   * pass structurally cannot end with zero rows evaluated (the 2026-09-17
   * silent-stop shape).
   *
   * The returned `note` is the pass's coverage line: whenever any active row
   * went unchecked it names how many rows ran, how many of the requested
   * tokens came back from the pair batch, and why the rest were skipped. That
   * exists so a starved tracker is visible in /health instead of reporting a
   * healthy-looking `ok:0/0`.
   */
  async runTick(deadlineMs?: number): Promise<{
    checked: number;
    alerted: number;
    /**
     * Coverage/skip line: rows evaluated, tokens the pair batch returned,
     * every skip reason, and the pass's Turso round-trip count (`trips N`).
     * Always present — it used to be omitted on a "clean" pass, which is
     * exactly how a starved tracker looked healthy in /health.
     */
    note?: string;
    /** Turso round trips this pass made (see the merge notes inside). */
    trips: number;
    /**
     * Cards THIS pass could not deliver (send slice spent, timed out, or
     * the call threw). Every one is rolled back and re-announced later.
     */
    undelivered: number;
    /** Cumulative undelivered cards this isolate (survives the pass note). */
    undeliveredTotal: number;
    /** Of those, the ones a later pass actually re-announced. */
    recoveredUndelivered: number;
    /** Tokens still waiting for their make-up send. */
    pendingUndelivered: number;
    /**
     * TERMINAL cards whose send was abandoned this pass. NOT part of
     * `undelivered` — those are rolled back and re-announced, these keep their
     * transition and leave a durable record for the settle instead. Optional:
     * every pass that defers before the row loop attempts no card at all.
     */
    terminalAbandoned?: number;
    /** Rows re-armed this pass because their 💧 card was never proven sent. */
    rearmedCards?: number;
    /**
     * Terminal cards abandoned by this ISOLATE (the note's number is per pass,
     * so this is the one that survives the next tick's note). Cumulative, the
     * same shape as undeliveredTotal.
     */
    terminalAbandonedTotal?: number;
  }> {
    const cfg = this.config.pushWatch;
    const now = Date.now();
    const budgetMs =
      typeof deadlineMs === "number" && Number.isFinite(deadlineMs)
        ? Math.max(0, Math.min(TRACKER_TICK_BUDGET_MS, deadlineMs - now))
        : TRACKER_TICK_BUDGET_MS;
    const deadline = now + budgetMs;
    const past = () => Date.now() > deadline;
    // Round-trip ledger for the pass (reported in the coverage note). Every
    // Turso call below is a full request on a pass that only holds
    // TRACKER_TICK_BUDGET_MS, so this count is the tracker's real cost driver.
    let trips = 0;
    // Per-stage clock for the pass, reported in the coverage note as
    // `ms/trips`. The pass has no cadence of its own — it is handed whatever
    // the scan tick has left — so `allow` plus this split is the only way to
    // tell WHICH stage ate the budget. 2026-09-21: every tick reported
    // `ok:0/0 deferred:tick-budget` while 30 rows aged out, and nothing in
    // /health said whether the listing, the self-heal, the pair batch or the
    // row loop was responsible (the note is per-pass and /health keeps only
    // the latest summary, so a stage loss was invisible the moment the next
    // tick overwrote it).
    const spent = {
      setup: { ms: 0, trips: 0 }, // listing + recap + prune + terminal settle
      heal: { ms: 0, trips: 0 }, // untracked-push self-heal (reads + 補發)
      pairs: { ms: 0, trips: 0 }, // the head pair batch (one request)
      rows: { ms: 0, trips: 0 }, // the row loop: claim, reserve, send, write
      holders: { ms: 0, trips: 0 }, // Birdeye holder probes (additive)
    };
    // Self-heal OUTCOME, next to its clock: the trips count alone cannot tell
    // a chronic heal (the same missing pushes re-read every tick) from a
    // one-off, and it cannot show that the stage was skipped for room or cut
    // at its slice. `heal 1800/7 miss3 enrolled3`, `heal-cut 1000/4 miss3
    // enrolled0` and `heal-skipped 40/0 miss0 enrolled0` are the three shapes
    // the 2026-09-21 stall hid behind.
    let healMissing = 0;
    let healEnrolled = 0;
    let healCut = false;
    let healSkipped = false;
    const stageNote = () =>
      `allow ${budgetMs} spend[setup ${spent.setup.ms}/${spent.setup.trips}` +
      ` heal${healSkipped ? "-skipped" : healCut ? "-cut" : ""}` +
      ` ${spent.heal.ms}/${spent.heal.trips}` +
      ` miss${healMissing} enrolled${healEnrolled}` +
      ` pairs ${spent.pairs.ms}/${spent.pairs.trips}` +
      ` rows ${spent.rows.ms}/${spent.rows.trips}` +
      ` holders ${spent.holders.ms}/${spent.holders.trips}]`;
    const deferred = {
      checked: 0,
      alerted: 0,
      // Read at return time, so a deferral names the stage it stopped in.
      get note() {
        return `deferred:tick-budget ${stageNote()} trips ${trips}`;
      },
      // Both deferral returns happen BEFORE the row loop, so no card was
      // even attempted — the per-pass count is 0 and the cumulative
      // totals are the isolate's running values.
      undelivered: 0,
      undeliveredTotal: this.undeliveredTotal,
      recoveredUndelivered: this.recoveredUndeliveredTotal,
      pendingUndelivered: this.pendingUndelivered.size,
      // Read at return time, so a deferral reports the trips made before it.
      get trips() {
        return trips;
      },
    };
    // Case-closed recaps: every coin leaving the window gets ONE summary
    // card before the bulk prune deletes it. Best-effort send — a failed
    // delivery must never keep a dead row alive forever.
    const windowCutoff = now - cfg.windowHours * 3_600_000;
    // ONE listing per tick. The recap pass and the row loop below used to read
    // the SAME table separately — two round trips of ~150-300ms each on a pass
    // with ~1s of budget (2026-09-17). The snapshot is taken BEFORE
    // recap/prune/heal and reused for the loop; the loop keeps only the rows
    // the prune would have kept, so a row that just got its 🏁 recap is still
    // never evaluated again.
    const setupStart = Date.now();
    const setupTrips = trips;
    let snapshot: PushWatchRow[] | null = null;
    try {
      snapshot = await this.db.listPushWatch(cfg.maxTracked);
      trips += 1;
    } catch {
      /* listing failed — the loop re-reads below, the prune still runs */
    }
    const expiring = (snapshot ?? []).filter(
      (x) => x.pushedAt < windowCutoff && x.lastState !== "unwatched",
    );
    if (expiring.length > 0) {
      // Claims FIRST, in ONE batched round trip, then the cards: the
      // claim-before-send guarantee is unchanged (a batch is one request,
      // executed in order), but N expiring rows now cost 1 trip instead of N.
      let won: boolean[];
      try {
        won = await this.db.markRecapClaimedMany(expiring.map((r) => r.token));
        trips += 1;
      } catch {
        won = expiring.map(() => false); // best-effort: no card without a claim
      }
      for (let i = 0; i < expiring.length; i++) {
        if (!won[i]) continue;
        try {
          await this.bot.api.sendMessage(
            expiring[i].chatId,
            recapMessage(expiring[i]),
          );
        } catch {
          /* best-effort */
        }
      }
    }
    // The prune deletes exactly the rows past the window. When the listing was
    // COMPLETE (fewer rows than the limit, so nothing sat outside it) and held
    // no such row, the DELETE provably matches nothing — skip the round trip.
    const listingComplete = snapshot !== null && snapshot.length < cfg.maxTracked;
    const pruneNeeded =
      !listingComplete || (snapshot ?? []).some((r) => r.pushedAt < windowCutoff);
    if (pruneNeeded) {
      await this.db.prunePushWatch(windowCutoff);
      trips += 1;
    }
    // Budget gate BETWEEN stages: the recap/prune above is idempotent (a
    // recap claims its row as it sends), so bailing here costs only latency —
    // the remaining stages run on the next tick with fresh rows.
    if (past()) return deferred;
    // Settle abandoned TERMINAL cards before anything else in the pass: a 💧
    // drain card whose send was abandoned KEEPS its row's terminal transition
    // and leaves a durable record (see the alert loop). Proved delivered → the
    // record is dropped; unproven after UNCONFIRMED_CARD_GRACE_MS → the row is
    // re-armed and the card re-announced. That is the rollback the two-state
    // send did IMMEDIATELY, now deferred until we actually know, so a card that
    // was already in flight is not sent a second time.
    // Early in the pass on purpose: the re-armed row has its last_checked
    // zeroed, so it takes the front of the next rotation.
    const settle = await this.settleUnconfirmedCards(now);
    trips += settle.trips;
    const rearmedCards = settle.rearmed;
    spent.setup.ms = Date.now() - setupStart;
    spent.setup.trips = trips - setupTrips;
    // Heal missed enrollments: pushes recorded in seen_tokens but absent
    // from push_watch (an old pre-tracker isolate handled that scan, or the
    // process died between the push and the upsert). Seeded with the TRUE
    // push-time mcap from the durable ledger (src/pushledger.ts) when it has
    // one, so a healed row stays comparable with the filter band; an unaudited
    // push falls back to the current mcap and is the only case that measures
    // "from tracking start". Extra DexScreener call only when something is
    // actually missing; a no-pair coin retries on the next tick.
    const healStart = Date.now();
    const healTrips = trips;
    // The heal's slice: its own cap, and never past the rotation's reserve
    // (see TRACKER_HEAL_BUDGET_MS / TRACKER_ROW_RESERVE). Everything below is
    // bounded by it, so a chronic heal costs the pass a slice instead of the
    // whole allowance.
    const healDeadline = Math.min(
      healStart + TRACKER_HEAL_BUDGET_MS,
      deadline -
        (TRACKER_PAIRS_BUDGET_MS + TRACKER_ROW_RESERVE * TRACKER_ROW_MIN_MS),
    );
    const healPast = () => Date.now() > healDeadline;
    if (healDeadline - healStart < TRACKER_HEAL_MIN_MS) healSkipped = true;
    try {
      let missing: Array<{
        token: string;
        chatId: string;
        pushedAt: number;
      }> = [];
      if (!healSkipped) {
        trips += 1;
        missing = await this.db.findUntrackedPushes(
          now - cfg.windowHours * 3_600_000,
          10,
        );
        healMissing = missing.length;
      }
      if (missing.length > 0) {
        // Two reads hoisted out of the per-coin loop: the audit ring is ONE
        // worker_state row (hasInitialPushAudit re-read it for every coin) and
        // the trade mode is ONE setting (the re-send keyboard asked for it per
        // coin). Both are one trip for the whole batch now, and the
        // enrollments land in a single batched INSERT at the end.
        // Delivered-card proof, NOT initial-card proof — the audit ring is ONE
        // worker_state row, read once for the whole batch. The gate below asks
        // "did the operator ever get a card for this coin?", and the 補發 card
        // this very loop sends is proof of exactly that (kind `resend`). Asking
        // only about `initial` left a token whose first card was cut by the send
        // deadline looking "never delivered" — that card does leave the chat,
        // but it writes no audit entry — so every later pass re-sent another
        // 補發 and the operator got the same coin five times in eleven minutes
        // (live 2026-09-20: PONDER 10:48-11:08 HKT; the ring shows the resend
        // rows, GROYPER 00:49Z, JEV, STACK, MEMEMAN). A token with no entry at
        // all is still re-sent on this pass — the never-miss half.
        const proof = await readDeliveredTokens(this.db);
        const delivered = proof.tokens;
        // A card send that was ABANDONED (three-state send) is not proof of
        // delivery — but it is not a licence to send the 補發 either: the card
        // may already be in the chat, and this pass is the very duplicate loop
        // (five PONDER cards in eleven minutes) this gate exists to close. The
        // unconfirmed record settles within ~1s (the background audit write)
        // or, at the latest, two tick cadences later in the worker's reconcile
        // — which releases the claim when nothing proved delivery, so the coin
        // is re-pushed by a normal scan instead. Nothing is silenced for good:
        // a token with no entry anywhere still gets its 補發 on this pass.
        const unconfirmed = proof.unconfirmed;
        trips += proof.trips;
        // Durable push-baseline ledger (src/pushledger.ts): the true
        // push-time mcap per token, copied out of the delivery audit ring and
        // kept across deploys. ONE worker_state read covers the whole batch.
        const ledger = parsePushLedger(
          await this.db.getWorkerState(PUSH_LEDGER_STATE_KEY),
        );
        trips += 1;
        const resendMode = await this.tradeMode();
        if (this.hasTrade()) trips += 1;
        const enroll: Array<{
          token: string;
          chatId: string;
          symbol: string | null;
          pushedAt: number;
          mcapAtPush: number;
          liquidityUsd: number | null;
        }> = [];
        /**
         * First healed coin of this pass, for the ONE durable audit entry
         * written after the batch lands (see below). Deliberately not one entry
         * per coin: the audit ring is 30 slots and the ledger reconciles
         * against it, so a burst of heals must not evict recent initial sends.
         */
        let healProof: {
          token: string;
          chatId: string;
          symbol: string | null;
          mcapAtPush: number;
          fromLedger: boolean;
        } | null = null;
        // Call-time deadline, like the head batch above: this stage runs even
        // LATER in the pass than that batch does, so a `now`-based cap here is
        // always already spent. Clamped to the heal's own slice as well: past
        // it the client's dispatch guard answers an EMPTY map (it refuses to
        // issue the request at all), which is exactly what a cut stage means —
        // nothing is enrolled or re-sent off a request that never went out,
        // and the next pass re-reads the same missing tokens. Marking the cut
        // is what makes a starved heal visible in the note instead of it
        // looking like "those coins have no pairs".
        if (healPast()) healCut = true;
        const missPairs = await this.pairsFor(
          missing.map((m) => m.token),
          Date.now() +
            Math.max(
              0,
              Math.min(TRACKER_PAIRS_BUDGET_MS, healDeadline - Date.now()),
            ),
        );
        for (const m of missing) {
          const pair = missPairs.get(m.token);
          if (!pair) continue;
          // A RECENTLY-claimed coin with no delivered-card audit entry means
          // the sending isolate died between claim and send (deploy
          // eviction — XST/GLITCH/Félicette/RING): the card never reached
          // Telegram, so re-send it instead of silently enrolling tracking
          // for a push nobody saw. Older unaudited pushes predate the audit
          // ring and were delivered normally — keep silent enrollment.
          //
          // "No delivered-card entry" rather than "no initial-card entry" is
          // what bounds this to ONE 補發 per coin: the re-send below writes its
          // own `resend` entry, so the next pass (and every pass for the rest
          // of the 15-minute grace) sees proof and only enrolls. A coin with no
          // entry at all is still re-sent — the card the user is owed is never
          // dropped by this gate.
          const recentClaim = now - m.pushedAt <= FIRST_CARD_RESEND_GRACE_MS;
          let resent = false;
          if (recentClaim && !delivered.has(m.token) && !unconfirmed.has(m.token)) {
            try {
              const usd = (n: number | null | undefined) =>
                n == null || !Number.isFinite(n)
                  ? "—"
                  : "$" + Math.round(n).toLocaleString("en-US");
              const pctStr = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
              const ageMin = Math.max(
                0,
                Math.round((Date.now() - pair.pairCreatedAt) / 60_000),
              );
              // Bounded like the alert sends: a timed-out re-send throws into
              // the catch below (logged, no audit entry), and the audit ring
              // staying unwritten is what makes the next pass try again.
              const sent = await this.bounded(
                this.bot.api.sendMessage(
                  m.chatId,
                  `📤 補發推送 ${pair.baseToken.symbol}（首次卡片未送達）\n` +
                    `💰 市值 ${usd(pair.marketCap)}\n` +
                    `💧 流動性 ${usd(pair.liquidity.usd)} | ⏱ 年齡 ${ageMin} 分鐘\n` +
                    `📊 5m量 ${usd(pair.volume.m5)} | 5m ${pctStr(pair.priceChange.m5)}`,
                  {
                    reply_markup: {
                      // Full first-card keyboard (axiom link + trade actions +
                      // mode switch + unwatch): the original card never went
                      // out, so the re-send must be indistinguishable from a
                      // normal push card. Mode is resolved live so the buttons
                      // match the operator's current /setmode.
                      inline_keyboard: tradeKeyboard(
                        m.token,
                        this.tradeBuySizeLabel(),
                        resendMode,
                        { modeSwitch: this.hasTrade(), unwatch: true },
                      ),
                    },
                  },
                ),
                TRACKER_SEND_CAP_MS,
                null,
              );
              if (sent === null) {
                throw new Error(
                  `re-send timed out after ${TRACKER_SEND_CAP_MS}ms`,
                );
              }
              resent = true;
              try {
                trips += 1;
                await this.db.recordPushDelivery({
                  chatId: m.chatId,
                  token: m.token,
                  symbol: pair.baseToken.symbol ?? null,
                  messageId: Number(
                    (sent as { message_id?: unknown }).message_id ?? 0,
                  ),
                  mcapAtPush: pair.marketCap,
                  kind: "resend",
                });
              } catch {
                /* audit is best-effort */
              }
            } catch (err) {
              console.error(
                `[push-watch] heal resend failed for ${pair.baseToken.symbol ?? m.token}:`,
                err instanceof Error ? err.message : err,
              );
            }
          }
          // Baseline = the value the gate actually saw at push time whenever
          // the ledger has it. Seeding the coin's CURRENT mcap (the old
          // behaviour) is what put a $12K baseline on a $45K push and an
          // FDV-shaped $1.59M on a coin whose market cap never passed $341K
          // (2026-09-19 audit). Only a push older than the ledger falls back
          // to the current value.
          const known = findLedgerEntry(ledger, m.token);
          const healedMcap = known?.mcapAtPush ?? pair.marketCap;
          healEnrolledTotal += 1;
          healLastAt = Date.now();
          if (known) healFromLedgerTotal += 1;
          else healFromCurrentMcapTotal += 1;
          if (healProof === null) {
            healProof = {
              token: m.token,
              chatId: m.chatId,
              symbol: pair.baseToken.symbol ?? null,
              mcapAtPush: healedMcap,
              fromLedger: known !== null,
            };
          }
          enroll.push({
            token: m.token,
            chatId: m.chatId,
            symbol: pair.baseToken.symbol ?? null,
            pushedAt: m.pushedAt,
            mcapAtPush: healedMcap,
            liquidityUsd: comparableLiquidity(pair),
          });
          if (resent) continue; // fresh card just went out — skip holder seed noise
        }
        healEnrolled = enroll.length;
        // ONE round trip for every healed coin (was one per coin). The insert
        // is idempotent (ON CONFLICT DO NOTHING) and the self-heal re-runs next
        // tick, so batching late cannot lose an enrollment.
        if (enroll.length > 0) {
          await this.db.upsertPushWatchMany(enroll);
          trips += 1;
        }
        // Durable trace of the heal path, written AFTER the enrollment landed.
        // `kind` is never "initial", so the resend gate
        // (getInitialPushAuditTokens) and the ledger merge (which accepts only
        // "initial") both ignore it by construction, and the two kind values
        // carry the provenance: "heal-ledger" = seeded from the push-time
        // value, "heal-current" = the documented fallback for a push older than
        // the ledger. /debug/push-audit is where a human confirms a healed row
        // really does carry its push-time baseline.
        if (healProof !== null) {
          const proof = healProof;
          try {
            trips += 1;
            await this.db.recordPushDelivery({
              chatId: proof.chatId,
              token: proof.token,
              symbol: proof.symbol,
              messageId: 0,
              mcapAtPush: proof.mcapAtPush,
              kind: proof.fromLedger ? "heal-ledger" : "heal-current",
            });
          } catch {
            /* audit is best-effort */
          }
        }
      }
    } catch {
      /* healing is best-effort */
    }
    spent.heal.ms = Date.now() - healStart;
    spent.heal.trips = trips - healTrips;
    if (past()) return deferred;
    // Reuse the snapshot (see the merge note at the top of the pass). Rows the
    // prune removed — everything past the window, i.e. exactly the ones the
    // recap just handled — are filtered out here; rows the self-heal enrolled
    // this tick simply join the rotation on the next one. The table is read
    // again ONLY when the listing failed (nothing to reuse).
    const rows: PushWatchRow[] =
      snapshot !== null
        ? snapshot.filter((r) => r.pushedAt >= windowCutoff)
        : ((trips += 1), await this.db.listPushWatch(cfg.maxTracked));
    // Only rug (drained LP) rows are terminal: kept so the self-heal does
    // not re-enroll them, and skipped here. Dead rows stay ACTIVE but the
    // rules engine keeps them silent until a resurrection.
    const activeRows = rows.filter(
      (r) =>
        r.lastState !== "rug" &&
        r.lastState !== "unwatched" &&
        // A concurrent isolate's recap can tombstone a row between our
        // snapshot and here; it must not be evaluated after its 🏁 card.
        r.lastState !== "expired",
    );
    if (activeRows.length === 0)
      return {
        checked: 0,
        alerted: 0,
        note: `rows 0/${activeRows.length} ${rows.length === 0 ? "no-rows" : "all-terminal"} ${stageNote()} trips ${trips}`,
        trips,
        undelivered: 0,
        undeliveredTotal: this.undeliveredTotal,
        recoveredUndelivered: this.recoveredUndeliveredTotal,
        pendingUndelivered: this.pendingUndelivered.size,
      };

    // Rotation: LEAST-recently-checked first. The loop only fits a few rows
    // per tick (each one costs a claim plus an update round trip), and
    // iterating newest-first re-read the same head every tick — every pushed
    // coin outside the head would sit unmonitored for its whole tracking
    // window (the sibling of the 2026-09-17 zero-row bug: with the row
    // allowance restored, a fixed head would monitor ~3 of 30 coins).
    // Ordered this way each tick advances the round-robin; a freshly pushed
    // coin (last_checked = its insert stamp) joins the back of that queue and
    // is watched within one cycle. Same rotation idea as the re-eval pool.
    const queue = [...activeRows].sort(
      (a, b) => (a.lastChecked ?? 0) - (b.lastChecked ?? 0),
    );
    // Pairs for the HEAD of the queue only (see TRACKER_PAIR_HEAD), capped so
    // the batch cannot eat the row allowance (see TRACKER_PAIRS_BUDGET_MS).
    // Rows past the head are simply the next tick's work: they are NOT counted
    // as pair misses, so a delisted coin can never be dropped off a request it
    // was never part of.
    const head = queue.slice(0, TRACKER_PAIR_HEAD);
    const tokens = head.map((r) => r.token);
    // Published for the scanner's next pair phase (see lastHeadTokens).
    this.lastHeadTokens = tokens;
    // The batch's deadline is measured from the CALL, not from the pass start
    // (`now`): the setup stages above (listing, recap/prune, terminal settle,
    // self-heal) routinely cost 400-700ms, so a deadline derived from the pass
    // start was already spent by the time this line ran — and the client's
    // dispatch guard then refuses to issue the request at all, answering an
    // EMPTY map. Live 2026-09-21 02:18-02:23Z, with the stage clock on:
    // `allow 1220 spend[setup 484 heal 171 pairs 168] pairs 0/6`, while the
    // same six addresses asked directly came back 6/6 with live pools. That is
    // the rotation stall in one line: no pairs → every head row is blamed as a
    // miss → zero rows evaluated, pass after pass, and the same head forever.
    const pairsStart = Date.now();
    const pairsTrips = trips;
    let pairs = new Map<string, import("./dexscreener").PairInfo>();
    try {
      pairs = await this.pairsFor(
        tokens,
        Date.now() + TRACKER_PAIRS_BUDGET_MS,
      );
    } catch (err) {
      // feed down — retry next tick; surface the reason via the heartbeat.
      spent.pairs.ms = Date.now() - pairsStart;
      spent.pairs.trips = trips - pairsTrips;
      return {
        checked: 0,
        alerted: 0,
        note: `pairs-failed:${(err instanceof Error ? err.message : String(err)).slice(0, 80)} ${stageNote()} trips ${trips}`,
        trips,
        undelivered: 0,
        undeliveredTotal: this.undeliveredTotal,
        recoveredUndelivered: this.recoveredUndeliveredTotal,
        pendingUndelivered: this.pendingUndelivered.size,
      };
    }

    spent.pairs.ms = Date.now() - pairsStart;
    spent.pairs.trips = trips - pairsTrips;

    // A batch that resolved NOTHING while the head was non-empty is a FAILED
    // FETCH — a DexScreener 429 backoff, or a deadline the caller had already
    // spent (see above) — and NOT a screen of delisted coins. The row loop
    // cannot tell the difference: every head row becomes a pair miss, and a
    // miss is also the evidence the delete path uses ("unfindable for 2h"), so
    // a stuck feed both stopped the rotation AND armed deletions against live
    // rows (live 2026-09-21: `pairs 0/6 miss 6` on pass after pass while all
    // six head tokens had live pools). Nothing is judged off a request that
    // never answered: the empty batch is reported by name so a stuck feed is
    // visible in /health, and every row is left exactly as it was.
    if (tokens.length > 0 && pairs.size === 0) {
      return {
        checked: 0,
        alerted: 0,
        note: `pairs-empty ${stageNote()} trips ${trips}`,
        trips,
        undelivered: 0,
        undeliveredTotal: this.undeliveredTotal,
        recoveredUndelivered: this.recoveredUndeliveredTotal,
        pendingUndelivered: this.pendingUndelivered.size,
      };
    }

    let checked = 0;
    let alerted = 0;
    let backfilled = 0;
    let pairMiss = 0;
    let claimLost = 0;
    let budgetCut = false;
    /**
     * Cards this pass could not deliver — the send slice was spent, the send
     * timed out, or the call threw. Every one of them rolls the row's
     * announcement bookkeeping back to its pre-send snapshot (see the final
     * check write), so the next tick re-derives the same transition and
     * re-announces it: at-least-once, like the initial-card send. Before
     * that, the reservation simply stood and the card was lost for good.
     */
    let undelivered = 0;
    /** Cards THIS pass re-announced after a previous pass held them back. */
    let recoveredThisPass = 0;
    /** Rows refused because their cards did not fit the pass (no card lost). */
    let sendDeferred = 0;
    /**
     * TERMINAL cards whose send was abandoned this pass. NOT part of
     * `undelivered`: those are rolled back and re-announced, these KEEP their
     * transition (that is the fix) and are counted here so the two different
     * promises stay distinguishable in /health.
     */
    let terminalAbandoned = 0;
    let firstRow = true;
    const rowsStart = Date.now();
    const rowsTrips = trips;
    for (const row of head) {
      // Budget check BETWEEN rows: the claim and the alert reservation for a
      // row both happen after this point, so leaving a row to the next tick
      // can never drop an alert (it is re-claimed and re-evaluated then).
      // The FIRST row is never skipped: when the front stages (recap/prune,
      // self-heal, pair batch) run long, breaking here is what silently
      // stopped all post-push monitoring — the pass reported `ok:0/0` with no
      // note while 28 active rows went unrefreshed (2026-09-17). One row per
      // tick is the floor that keeps the tracker moving no matter what
      // DexScreener or Turso are doing.
      if (!firstRow && Date.now() + TRACKER_ROW_MIN_MS > deadline) {
        budgetCut = true;
        break;
      }
      firstRow = false;
      const pair = pairs.get(row.token);
      if (!pair) {
        // Delisted/unfindable: drop after a grace period so stale rows don't
        // linger. The clock runs from the LAST SUCCESSFUL CHECK, not the
        // push time — the batched feed occasionally omits pairs (flaky
        // shared egress), and a single miss must not delete a live row.
        //
        // That clock is exactly what a RE-ARMED row does not have:
        // rearmPushWatchAlert zeroes `last_checked` so the row goes back to the
        // front of the rotation, and measuring the grace from `pushed_at` then
        // counts a push that is already hours old — so the FIRST miss deletes
        // the row. Live 2026-09-21 00:33Z: a legacy drain row repaired out of
        // the unarmed-clock class vanished that way, one pass after the repair,
        // with its verdict never re-derived (its pool was still sub-floor, so
        // what the repair was re-announcing was simply lost). No check clock
        // means there is no unfindable-for-2h evidence either way, so such a
        // row is left for the next pass to retry: the age prune (pushed_at +
        // window) is still its backstop, and one successful check gives it a
        // real clock again.
        pairMiss += 1;
        const lastSeen = Math.max(row.pushedAt, row.lastChecked);
        if (row.lastChecked > 0 && now - lastSeen > 2 * 3_600_000) {
          trips += 1;
          await this.db.deletePushWatch(row.token);
        }
        continue;
      }
      // Evaluate BEFORE claiming. The rules engine is local (no network, no
      // DB), and knowing whether this row carries cards is what lets the
      // pass refuse a row it cannot finish: every alerting row reserves its
      // state transition before sending and never retries (see
      // reservePushWatchAlert), so starting one without the send slice
      // DROPS its card forever. A refused row is left completely untouched —
      // last_checked included — so the next tick claims it with a fresh
      // budget and its place at the front of the rotation is preserved.
      const evalResult = evaluateWatch(
        row,
        now,
        {
          mcap: pair.marketCap,
          // Comparable-only: a Jupiter/Gecko-sourced number is ~half of
          // DexScreener's for the same pool (see comparableLiquidity) and
          // must not be judged against the $10K floor.
          liquidity: comparableLiquidity(pair),
          chg5m: pair.priceChange.m5,
          vol5m: pair.volume.m5,
          buysH1: pair.txns.h1Buys,
          sellsH1: pair.txns.h1Sells,
        },
        { cooldownMs: cfg.cooldownMin * 60_000 },
      );

      // Backfill pass (see STALE_BACKFILL_MS): a row the tracker has never
      // evaluated (last_mcap is written by every real pass) whose push is
      // already older than the alert cooldown. This is the shape of a
      // recovered tracking outage — evaluate it and write the bookkeeping,
      // but suppress delivery: the drop/run happened while nothing was
      // watching, and 30 such cards at once is noise, not signal.
      const backfill =
        row.lastMcap === null && now - row.pushedAt > STALE_BACKFILL_MS;
      // Send slice this row would get, computed before it is claimed (see
      // TRACKER_SEND_FLOOR_MS / TRACKER_SEND_MIN_MS).
      const sendBudgetEnd = Math.min(
        Date.now() + TRACKER_SEND_CAP_MS,
        deadline + TRACKER_SEND_FLOOR_MS,
      );
      if (!backfill && evalResult.alerts.length > 0) {
        const needMs = Math.min(
          TRACKER_SEND_CAP_MS,
          TRACKER_SEND_MIN_MS * evalResult.alerts.length,
        );
        if (sendBudgetEnd - Date.now() < needMs) {
          sendDeferred += 1;
          budgetCut = true;
          break;
        }
      }
      // The check write's columns, in ONE place: the silent path below binds
      // them into its claim (one round trip), the alerting path writes them
      // after its sends — with `hold` rolling the announcement columns back
      // when a card did not go out (see the final write).
      const checkFields = (hold: boolean) => ({
        peakMcap: evalResult.peakMcap,
        lastLiquidity: comparableLiquidity(pair) ?? row.lastLiquidity,
        lastVol5m: pair.volume.m5,
        // A backfill pass delivers nothing: the counters and the alert clock
        // stay where they were, while the PERSISTENT state markers land — that
        // is what keeps every already-crossed 🚀/w35/dead transition from being
        // re-announced, and what makes the next check report only genuinely
        // new information.
        followupsSent:
          backfill || hold ? row.followupsSent : evalResult.followupsSent,
        lastState: hold ? (row.lastState ?? null) : evalResult.lastState,
        lastAlertAt:
          backfill || hold ? row.lastAlertAt : evalResult.lastAlertAt,
        mcapAtPush: hold ? row.mcapAtPush : evalResult.resetBaselineMcap,
        // Roll the 📈 baseline forward — omitting this made every later holder
        // check re-fire against the stale push-time baseline (BABYCATE
        // 1,000 → 2,441 then 1,000 → 2,458).
        holdersAtPush: hold
          ? (row.holdersAtPush ?? undefined)
          : evalResult.resetBaselineHolders,
        upStages: hold ? row.upStages : evalResult.announcedUpStages,
        deadTroughMcap: hold
          ? (row.deadTroughMcap ?? null)
          : (evalResult.deadTroughMcap ?? null),
        sellDomStreak: hold ? row.sellDomStreak : evalResult.sellDomStreak,
        lastMcap: pair.marketCap,
      });

      // SILENT ROW — nothing to announce (or a backfill, whose cards are
      // deliberately suppressed): the claim and the check write are ONE round
      // trip. The claim's compare-and-swap on last_checked is the same
      // cross-isolate exclusion in one statement, and a lost race still skips
      // the row entirely. This is the pass's throughput: ~90% of the rows a
      // pass touches have nothing to say, and they used to cost two store
      // round trips each out of an allowance that fits only a handful.
      if (backfill || evalResult.alerts.length === 0) {
        trips += 1;
        if (
          !(await this.db.claimPushWatchCheck(
            row.token,
            row.lastChecked,
            now,
            checkFields(false),
          ))
        ) {
          claimLost += 1;
          continue;
        }
        checked += 1;
        if (backfill) backfilled += 1;
        continue;
      }

      // ALERTING ROW — the reservation must land BEFORE the send, so the claim
      // stays a round trip of its own. The loser's snapshot is stale: it would
      // re-fire state-machine transitions (duplicate ⚠️/🚀 cards). Skip silently
      // on a lost race.
      trips += 1;
      if (!(await this.db.claimPushWatch(row.token, row.lastChecked, now))) {
        claimLost += 1;
        continue;
      }
      checked += 1;
      // Authoritative duplicate guard: reserve the state transition
      // BEFORE delivering. The last_checked claim alone cannot stop an
      // isolate that reads between this isolate's claim and its final
      // write — it inherits the claimed stamp but the pre-alert state.
      // Matching on (last_state, last_alert_at) makes exactly one
      // contender's UPDATE win; the loser skips delivery. Skipped entirely
      // on a backfill pass, which sends nothing.
      // Wrapped so the ledger counts the reservation exactly when it runs
      // (the && chain short-circuits when there is nothing to alert).
      const reserveAlert = async (): Promise<boolean> => {
        trips += 1;
        return this.db.reservePushWatchAlert(
          row.token,
          row.lastState ?? null,
          row.lastAlertAt ?? 0,
          evalResult.lastState ?? null,
          evalResult.lastAlertAt,
        );
      };
      if (
        !backfill &&
        evalResult.alerts.length > 0 &&
        !(await reserveAlert())
      ) {
        trips += 1;
        await this.db.updatePushWatchCheck(row.token, {
          peakMcap: evalResult.peakMcap,
          lastLiquidity: comparableLiquidity(pair) ?? row.lastLiquidity,
          lastVol5m: pair.volume.m5,
          followupsSent: evalResult.followupsSent - evalResult.alerts.length,
          lastState: row.lastState ?? null,
          lastAlertAt: row.lastAlertAt ?? 0,
          mcapAtPush: evalResult.resetBaselineMcap,
        holdersAtPush: evalResult.resetBaselineHolders,
          upStages: evalResult.announcedUpStages,
          deadTroughMcap: evalResult.deadTroughMcap ?? null,
          sellDomStreak: evalResult.sellDomStreak,
          lastMcap: pair.marketCap,
        });
        continue;
      }
      // ONE send budget for the whole row, computed before the row was
      // claimed (see the send-ability gate above): a row can carry four
      // stage cards, and a slow Telegram must not spend the ceiling once
      // per card. The counter is per PASS (for the note), so the rollback
      // flag below compares it against this row's starting value — a
      // failed row must not roll back a later row's delivered cards.
      const undeliveredBefore = undelivered;
      let sentCount = 0;
      for (const a of evalResult.alerts) {
        if (backfill) break;
        const sendLeft = sendBudgetEnd - Date.now();
        if (sendLeft <= 0) {
          console.error(
            `[push-watch] send budget spent for ${row.symbol ?? row.token} — ${evalResult.alerts.length - sentCount} card(s) held back for the next tick`,
          );
          undelivered += evalResult.alerts.length - sentCount;
          this.markUndelivered(row.token, evalResult.alerts.length - sentCount);
          break;
        }
        try {
          // The 💧 drain card is TERMINAL: evaluateWatch sets stopTracking on
          // that branch alone, and that branch returns exactly this one alert
          // (the "liq" crash card shares the kind but never stops tracking), so
          // `terminalAlert` identifies it exactly. It takes the initial-card
          // path's THREE-STATE send; every other alert keeps the two-state one,
          // where a rollback is harmless — the same card is re-derived and
          // re-sent on the next pass, which is the point of at-least-once.
          const terminalAlert =
            evalResult.stopTracking && a.kind === "liquidity";
          let sent: { message_id?: unknown } | null = null;
          if (terminalAlert) {
            const outcome = await this.sendTerminalAlert(
              row,
              a.text,
              sendLeft,
              now,
            );
            if (outcome.outcome === "abandoned") {
              // We stopped WAITING, which is not a failure: the card may
              // already be in the chat. The initial card's rule applies
              // verbatim (deferrallog.cardSendDisposition): KEEP the claim, so
              // the terminal transition lands and the card's 停止追蹤 becomes
              // TRUE. Rolling it back here was the live bug (2026-09-20,
              // Lobby): the 💧 card arrived, the row stayed ACTIVE with its
              // cooldown unarmed, and the same card could fire again — a card
              // claiming tracking stopped while the DB said it had not. The
              // unknown delivery is recorded durably instead (see the settle at
              // the top of the pass): proved → nothing more; unproven after the
              // grace → the row is re-armed and the card re-announced, so it is
              // never simply lost.
              console.error(
                `[push-watch] terminal card send abandoned for ${row.symbol ?? row.token} — tracked state KEPT, delivery unconfirmed (recorded for the settle)`,
              );
              terminalAbandoned += 1;
              break;
            }
            if (outcome.outcome === "failed") {
              // Telegram REJECTED it: a FACT, not the absence of one. Fall
              // through to the rollback below like any other undelivered card —
              // nothing reached the chat, so the row keeps being watched and
              // the 💧 card is re-announced next tick.
              throw new Error(
                `terminal-card send rejected for ${row.symbol ?? row.token}`,
              );
            }
            sent = outcome.message as { message_id?: unknown };
          } else {
            sent = (await this.bounded(
              this.bot.api.sendMessage(row.chatId, a.text),
              sendLeft,
              null,
            )) as { message_id?: unknown } | null;
          }
          if (sent === null) {
            // Timed out: the transition stays reserved for the rest of this
            // pass (a concurrent isolate must not re-send it), but the final
            // write below rolls the row's announcement bookkeeping back, so
            // the next tick re-announces it. The send may in fact have
            // landed, so that retry can duplicate — the accepted price of
            // never losing a card (the initial-card send makes the same
            // trade-off).
            console.error(
              `[push-watch] alert send timed out for ${row.symbol ?? row.token} — held back for the next tick (send slice ${Math.max(0, sendBudgetEnd - Date.now())}ms left)`,
            );
            undelivered += 1;
            this.markUndelivered(row.token, 1);
            break;
          }
          alerted += 1;
          sentCount += 1;
          trips += 1; // the delivery audit insert below
          // Audit follow-ups as well: comparing this ring against the
          // initial-card ring distinguishes "the client drops everything"
          // from "only first cards go missing".
          try {
            await this.db.recordPushDelivery({
              chatId: row.chatId,
              token: row.token,
              symbol: row.symbol,
              messageId: Number(
                (sent as { message_id?: unknown }).message_id ?? 0,
              ),
              kind: "followup",
            });
          } catch {
            /* audit is best-effort */
          }
        } catch (err) {
          // A thrown send (Telegram 4xx/5xx, network) is an undelivered
          // card too — it used to be logged and then silently recorded as
          // announced, a third way for a card to vanish.
          undelivered += 1;
          this.markUndelivered(row.token, 1);
          console.error(
            `[push-watch] alert send failed for ${row.symbol ?? row.token} (held back for the next tick):`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // The make-up send: this row's card was held back by an earlier pass
      // (rolled back, never recorded as announced) and is delivered now —
      // the at-least-once promise, counted so it is observable instead of
      // merely argued from the rollback code.
      if (sentCount > 0 && this.pendingUndelivered.delete(row.token)) {
        this.recoveredUndeliveredTotal += 1;
        recoveredThisPass += 1;
      }
      trips += 1;
      // An UNDELIVERED card must not be recorded as announced: the
      // reservation written before the send is rolled back to the
      // pre-send snapshot, so the next tick re-derives the same
      // transition and re-announces it. The measurement fields (peak,
      // liquidity, volume, last mcap) still advance — they describe the
      // coin, not the announcement.
      const holdAnnouncements = undelivered > undeliveredBefore;
      await this.db.updatePushWatchCheck(
        row.token,
        checkFields(holdAnnouncements),
      );
    }
    spent.rows.ms = Date.now() - rowsStart;
    spent.rows.trips = trips - rowsTrips;

    // Holder refresh (Birdeye CU-bounded): oldest-checked first, alive coins only.
    const holdersStart = Date.now();
    const holdersTrips = trips;
    if (this.birdeye && cfg.maxHolderChecksPerTick > 0) {
      const due = activeRows
        .filter(
          (r) =>
            pairs.has(r.token) &&
            (r.holdersCheckedAt === null ||
              now - r.holdersCheckedAt >= cfg.holdersRefreshMin * 60_000),
        )
        .sort((a, b) => (a.holdersCheckedAt ?? 0) - (b.holdersCheckedAt ?? 0))
        .slice(0, cfg.maxHolderChecksPerTick);
      for (const r of due) {
        // Holder counts are a slow-moving card detail; drop the rest of the
        // batch rather than carry the tick past its window. The check reserves
        // the probe's own cap (not just "are we past the deadline?"), and the
        // probe itself is raced — it was one of the two unbounded awaits in
        // the pass.
        if (Date.now() + TRACKER_HOLDER_CAP_MS > deadline) break;
        try {
          const overview = await this.bounded(
            this.birdeye.getTokenOverview(r.token),
            TRACKER_HOLDER_CAP_MS,
            null,
          );
          if (overview && overview.holderCount !== null) {
            trips += 1;
            await this.db.setPushWatchHolders(r.token, overview.holderCount, now);
          }
        } catch (err) {
          console.error(
            "[push-watch] holder refresh failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    spent.holders.ms = Date.now() - holdersStart;
    spent.holders.trips = trips - holdersTrips;

    // Coverage note: present whenever any active row went unchecked OR a
    // stale row was absorbed, so a starved tracker can never again look like
    // a healthy `ok:0/0` in /health — the exact shape that hid the 2026-09-17
    // stop for hours. One line names every skip reason: tokens the batch did
    // not return (miss), cross-isolate claim races (lost), the pass running
    // out of budget before the rest of the rotation (budget-cut), rows
    // whose first observation landed after a tracking gap (backfill), and
    // cards the pass could not deliver (undelivered — rolled back and
    // re-announced next tick, never lost), terminal cards whose send was
    // ABANDONED (kept and settled durably instead of rolled back), and rows
    // re-armed because such a card was never proven delivered.
    // The note is ALWAYS present now: it ends with the pass's round-trip
    // count, the number this merge exists to keep down. (It used to be omitted
    // on a fully-clean pass, which is how a starved tracker looked healthy.)
    const note =
      `rows ${checked}/${activeRows.length} pairs ${pairs.size}/${tokens.length}` +
      ` miss ${pairMiss} lost ${claimLost}${backfilled > 0 ? ` backfill ${backfilled}` : ""}` +
      `${sendDeferred > 0 ? ` defer-send ${sendDeferred}` : ""}` +
      `${undelivered > 0 ? ` undelivered ${undelivered}` : ""}` +
      `${terminalAbandoned > 0 ? ` abandoned ${terminalAbandoned}` : ""}` +
      `${rearmedCards > 0 ? ` rearmed ${rearmedCards}` : ""}` +
      `${recoveredThisPass > 0 ? ` recovered ${recoveredThisPass}` : ""}` +
      `${budgetCut ? " budget-cut" : ""} ${stageNote()} trips ${trips}`;

    return {
      checked,
      alerted,
      note,
      trips,
      undelivered,
      terminalAbandoned,
      terminalAbandonedTotal: this.terminalAbandonedTotal,
      rearmedCards,
      undeliveredTotal: this.undeliveredTotal,
      recoveredUndelivered: this.recoveredUndeliveredTotal,
      pendingUndelivered: this.pendingUndelivered.size,
    };
  }

  /**
   * Deliver ONE TERMINAL alert (the 💧 drain card) with the initial-card path's
   * three-state outcome, and own what each state MEANS here.
   *
   * sent      → the caller audits it and counts it, unchanged.
   * failed    → the caller throws: a rejection proves nothing reached the chat,
   *             so the row is rolled back and the card re-announced.
   * abandoned → we stopped waiting on a request that is still in flight. The
   *             caller KEEPS the terminal transition and the unknown delivery is
   *             recorded durably in the tracker's own ring
   *             (UNCONFIRMED_TERMINAL_STATE_KEY) for the pass-level settle to
   *             resolve: the chain below clears the record the moment the
   *             request settles as DELIVERED, and the settle re-arms the row
   *             (so the card is re-announced) when it never does.
   *
   * The promise is started ONCE, here, so the background chain above watches
   * exactly the request the race gave up on.
   */
  private async sendTerminalAlert(
    row: PushWatchRow,
    text: string,
    sendLeft: number,
    now: number,
  ): Promise<TerminalSendOutcome> {
    const inFlight = this.bot.api.sendMessage(row.chatId, text);
    // `settled` never rejects: a rejection is a FACT ("Telegram said no") while
    // the timeout is the ABSENCE of one, and not conflating the two is the
    // entire fix (see TerminalSendOutcome).
    const settled: Promise<TerminalSendOutcome> = inFlight.then(
      (message) => ({ outcome: "sent" as const, message }),
      () => ({ outcome: "failed" as const }),
    );
    let cutTimer: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<TerminalSendOutcome>((resolve) => {
      cutTimer = setTimeout(
        () => resolve({ outcome: "abandoned" as const }),
        Math.max(0, sendLeft),
      );
    });
    const raced = await Promise.race([settled, abandoned]);
    // Cleared either way: a pending timer would hold the isolate (and the
    // promise the race gave up on) open past this tick.
    if (cutTimer !== undefined) clearTimeout(cutTimer);
    if (raced.outcome !== "abandoned") return raced;
    // One source of truth for the policy itself, so the tracker and the
    // initial-card send cannot drift apart on what "abandoned" means.
    const plan = cardSendDisposition("abandoned");
    this.terminalAbandonedTotal += 1;
    if (plan.recordUnconfirmed) await this.recordAbandonedTerminalCard(row, now);
    if (plan.watchInBackground) {
      // The canary. A card that DOES arrive after the cut must clear its own
      // record: the settle may never re-announce a card that is already in the
      // chat, and the audit entry written here is hard proof Telegram accepted
      // it. Errors are swallowed — this runs after the pass has moved on, the
      // same contract as the initial card's background chain.
      void settled.then(async (late) => {
        if (late.outcome !== "sent") return; // a rejection leaves the record
        try {
          await this.db.recordPushDelivery({
            chatId: row.chatId,
            token: row.token,
            symbol: row.symbol,
            messageId: Number(
              (late.message as { message_id?: unknown })?.message_id ?? 0,
            ),
            kind: "followup",
          });
        } catch {
          /* audit is best-effort */
        }
        await this.clearAbandonedTerminalCard(row.chatId, row.token);
      });
    }
    return raced;
  }

  /**
   * Write (or refresh) one row's unconfirmed terminal-card record.
   *
   * Best-effort on purpose: the caller ALREADY kept the terminal transition
   * (that is the fix), so a failed write costs only the deferred re-announce —
   * the row stays rug, which is the correct state for a drained pool, and the
   * 🏁 recap card reports the verdict when the window closes.
   *
   * Read through a seam rather than by adding a method to the Db interface: the
   * Db doubles the tracker tests drive implement only the reader they need, so
   * a double without the ring reader degrades to "nothing to settle", which is
   * the pre-three-state behaviour and never a crash.
   */
  private async recordAbandonedTerminalCard(
    row: PushWatchRow,
    now: number,
  ): Promise<void> {
    const read = (this.db as Partial<Pick<Db, "getWorkerState">>).getWorkerState;
    const write = (this.db as Partial<Pick<Db, "setWorkerState">>).setWorkerState;
    if (typeof read !== "function" || typeof write !== "function") return;
    try {
      const raw = await read.call(this.db, UNCONFIRMED_TERMINAL_STATE_KEY);
      await write.call(
        this.db,
        UNCONFIRMED_TERMINAL_STATE_KEY,
        addUnconfirmedCardSend(raw, {
          chatId: row.chatId,
          token: row.token,
          at: now,
          symbol: row.symbol ?? null,
        }),
      );
      // Arms the settle's cheap trigger: the next pass knows it has something
      // to settle without reading the ring first.
      this.unconfirmedWrites += 1;
    } catch {
      /* best-effort — the terminal transition is already kept */
    }
  }

  /** Drop one row's record once a late send proved the card was delivered. */
  private async clearAbandonedTerminalCard(
    chatId: string,
    token: string,
  ): Promise<void> {
    const read = (this.db as Partial<Pick<Db, "getWorkerState">>).getWorkerState;
    const write = (this.db as Partial<Pick<Db, "setWorkerState">>).setWorkerState;
    if (typeof read !== "function" || typeof write !== "function") return;
    try {
      const raw = await read.call(this.db, UNCONFIRMED_TERMINAL_STATE_KEY);
      await write.call(
        this.db,
        UNCONFIRMED_TERMINAL_STATE_KEY,
        removeUnconfirmedCardSend(raw, chatId, token),
      );
    } catch {
      /* best-effort — the settle releases it after the grace instead */
    }
  }

  /**
   * Settle the tracker's unconfirmed terminal cards: a 💧 card abandoned by an
   * EARLIER pass — or by an isolate that has since died, which is exactly why
   * the ring is durable — is either proven delivered or, after the grace,
   * re-armed so its row re-announces the card.
   *
   * The rule itself is deferrallog.settleUnconfirmedCardSends (proof keeps the
   * claim, silence releases it after the grace). This owns the durable read,
   * the proof read and the release.
   *
   * Order matters: the RE-ARM lands BEFORE the shrunken ring is persisted. The
   * other way round, a crash in between would drop a record whose card was
   * never proven — a lost card. This way a crash in between re-arms an
   * already-active row, which rearmPushWatchAlert's `last_state = 'rug'` guard
   * makes a no-op. (The initial-card ring documents the same ordering rule for
   * its own release.)
   */
  private async settleUnconfirmedCards(
    now: number,
  ): Promise<{ rearmed: number; trips: number }> {
    // One read while something is pending, plus ONE probe per isolate: a record
    // left by an isolate that died between the send and its audit has no
    // in-memory trace, and the durable ring exists for exactly that. After the
    // first probe, a pass with nothing pending costs no round trip at all.
    if (this.settleProbed && this.unconfirmedWrites === 0) {
      return { rearmed: 0, trips: 0 };
    }
    const stateRead = (this.db as Partial<Pick<Db, "getWorkerState">>)
      .getWorkerState;
    if (typeof stateRead !== "function") return { rearmed: 0, trips: 0 };
    let trips = 0;
    let records: ReturnType<typeof parseUnconfirmedCardSends>;
    try {
      records = parseUnconfirmedCardSends(
        await stateRead.call(this.db, UNCONFIRMED_TERMINAL_STATE_KEY),
      );
      trips += 1;
    } catch {
      // Unreadable: keep the probe armed so the next pass tries again — an
      // unproven card may be waiting on this decision.
      return { rearmed: 0, trips: 0 };
    }
    this.settleProbed = true;
    if (records.length === 0) {
      this.unconfirmedWrites = 0;
      return { rearmed: 0, trips };
    }
    // Proof: the tracker's own `followup` audit entry, written only after
    // Telegram returned a message_id for a card on this row.
    let proven = new Set<string>();
    const auditRead = (this.db as Partial<Pick<Db, "getPushAudit">>).getPushAudit;
    if (typeof auditRead === "function") {
      try {
        proven = new Set(deliveredFollowupTokens(await auditRead.call(this.db)));
        trips += 1;
      } catch {
        // Nothing readable = nothing proven, which only ever means the record
        // waits out its grace (fail-open in the never-miss direction).
      }
    }
    const { release, kept } = settleUnconfirmedCardSends(
      records,
      now,
      UNCONFIRMED_CARD_GRACE_MS,
      proven,
    );
    let rearmed = 0;
    try {
      for (const r of release) {
        trips += 1;
        if (await this.db.rearmPushWatchAlert(r.token)) rearmed += 1;
      }
      if (release.length > 0 || kept.length !== records.length) {
        trips += 1;
        await this.db.setWorkerState(
          UNCONFIRMED_TERMINAL_STATE_KEY,
          serializeUnconfirmedCardSends(kept),
        );
      }
      this.unconfirmedWrites = 0;
    } catch {
      // Best-effort: the ring still holds the record, so the next pass tries
      // again (and a second re-arm of an already-active row is a guarded no-op).
    }
    return { rearmed, trips };
  }
}

/**
 * TERMINAL-ROW HYGIENE (the "Bruce" class).
 *
 * A 💧 drain row is the one terminal transition the tracker produces by
 * CONSUMING an alert, and `push_watch` records it in two columns written at
 * two different moments inside the same pass:
 *
 *   - `last_alert_at` — `reservePushWatchAlert` writes the pass's `now`;
 *   - `last_checked` — `claimPushWatch` writes that same `now`, and then the
 *     completion write re-stamps it with a FRESH `Date.now()`
 *     (Db.updatePushWatchCheck), i.e. AFTER the row's card was delivered.
 *
 * A well-formed drain row therefore has `0 < last_checked - last_alert_at`,
 * the delta being the part of the pass that ran after the reserve — the send.
 * Two shapes break that, and both are provable from the row alone:
 *
 *   - `last_alert_at === last_checked` — the completion write never landed
 *     (the isolate died between the reserve and the flush, the dead-tick
 *     shape). The row is frozen at claim+reserve: its measurements are a pass
 *     stale and the card's delivery is unproven. It cannot happen otherwise,
 *     because the completion stamp is a fresh clock read taken after the send.
 *   - `last_alert_at === 0`, or arbitrarily far behind `last_checked` — no
 *     alert was ever armed behind the transition: an older single-column
 *     writer (`setPushWatchState`, which touches only `last_state`) recorded 💧
 *     semantics it never accounted for. The card may never have been sent
 *     while the row sits silent for good.
 *
 * Third, independent check: the verdict can only be produced by a sub-floor
 * reading (evaluateWatch's liquidity branch), so a stored `last_liquidity` at
 * or above the floor does not support the state it is attached to — the
 * fingerprint of a verdict taken on a leg the floor was never calibrated for
 * (the Jupiter half-value bug) or of a lost completion write.
 */
export type TerminalRowIssue =
  | "unarmed_alert_clock"
  | "lost_completion_write"
  | "measurement_above_floor";

/**
 * Slack for "the pass outlived its own budget". A legitimate delta is the send
 * slice (sub-second, see TRACKER_SEND_CAP_MS) and the whole tick envelope is
 * two orders of magnitude below this, so anything past it is not a send.
 */
const TERMINAL_CLOCK_SLACK_MS = 5 * 60_000;

export function terminalRowIssues(
  row: {
    lastState: string | null;
    lastChecked: number;
    lastAlertAt: number;
    lastLiquidity: number | null;
  },
  opts: { liquidityFloorUsd?: number; clockSlackMs?: number } = {},
): TerminalRowIssue[] {
  // Only "rug" is produced by consuming an alert. "unwatched" (the user's 🔕)
  // and "expired" (window recap) are terminal for another reason and
  // legitimately carry no alert clock.
  if (row.lastState !== "rug") return [];
  const issues: TerminalRowIssue[] = [];
  if (row.lastChecked > 0) {
    const delta = row.lastChecked - row.lastAlertAt;
    const slack = opts.clockSlackMs ?? TERMINAL_CLOCK_SLACK_MS;
    if (row.lastAlertAt <= 0 || delta > slack) {
      issues.push("unarmed_alert_clock");
    } else if (delta === 0) {
      issues.push("lost_completion_write");
    }
  }
  const floor = opts.liquidityFloorUsd ?? LIQ_FLOOR_USD;
  if (row.lastLiquidity !== null && row.lastLiquidity >= floor) {
    issues.push("measurement_above_floor");
  }
  return issues;
}

/**
 * The repair for a diagnosed row. It mirrors the policy the tracker's own
 * settle applies to a cut terminal card (deferrallog.cardSendDisposition +
 * settleUnconfirmedCardSends): the delivery audit is the proof, and proof
 * decides between "the card is in the chat, only the bookkeeping is wrong"
 * (keep the transition, arm the clock — inert, the row is never re-checked)
 * and "the card may be lost, so the row must not sit silent" (re-arm it: the
 * 💧 condition is re-derived and re-announced if it still holds).
 *
 * Only the unarmed-clock class is repairable from the row alone. A lost
 * completion write keeps a transition a real reserve produced, and a
 * measurement that contradicts its own state is a stale number rather than a
 * wrong verdict — both are reported for a human, never rewritten.
 */
export type TerminalRowRepair = "arm_alert_clock" | "re_arm_row" | "none";

export function terminalRowRepair(
  issues: readonly TerminalRowIssue[],
  provedDelivered: boolean,
): TerminalRowRepair {
  if (!issues.includes("unarmed_alert_clock")) return "none";
  return provedDelivered ? "arm_alert_clock" : "re_arm_row";
}
