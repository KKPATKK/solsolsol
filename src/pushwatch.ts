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
  cardProofKey,
  deliveredCardTokens,
  deliveredFollowupProofs,
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
 * least-recently-checked first, and one pass now covers the WHOLE rotation
 * (TRACKER_PAIR_HEAD = the pool's own 30-row ceiling; it used to advance the
 * queue by a head of ten, three passes deep). Where its time comes FROM has
 * moved twice,
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
 * The measured cost of a full pass (live 2026-09-24 03:29Z) is ~1.4s of it:
 * ~350ms of setup (listing, recap/prune, terminal settle), ~335ms of pair
 * batch (ONE DexScreener request, capped by TRACKER_PAIRS_BUDGET_MS), then ONE
 * store round trip for the WHOLE silent queue (~136ms for ten rows — the
 * batched claim), plus any card sends, which are gated separately by
 * TRACKER_SEND_MIN_MS, not by this number. What the allowance therefore buys
 * is headroom for the ALERTING shape: an alerting row pays its own claim,
 * reservation, send and audit round trips, so a pass that meets several of
 * them is the one that spends this number.
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
// NOTE: 300ms is the expected cost of one silent row (see above); the revive
// floor below is unrelated to it.
/**
 * Ceiling on the room the row loop must leave before it starts another row
 * (see rowReserveMs in runTick).
 *
 * WHY a cap and not a flat reserve: TRACKER_ROW_MIN_MS is the EXPECTED cost of
 * a row at healthy Turso (~50-150ms a trip) and the pass's budget split is
 * priced in it, so a flat leash-sized reserve would cost the healthy pass its
 * last several rows — the wrong trade for the ~90% of rows that have nothing
 * to announce. The loop therefore prices its reserve in the cost THIS pass is
 * actually paying per round trip, floored at TRACKER_ROW_MIN_MS (a healthy
 * pass behaves exactly as before) and capped here at one tick leash: the
 * degraded case, where every call is walled at SCAN_DB_TIMEOUT_MS * 1.2 (1.4s
 * — the pass runs inside the tick's leash, see Db.enterScanMode and
 * Scanner.runTrackerPass).
 *
 * Live witness (2026-09-23 03:10Z, docs/duplicate-cards.md 14.1/14.6): a pass
 * started at 03:10:23Z, checked exactly ONE row and never returned — the note
 * sat at `running` for 55 seconds while the other 29 rows went unchecked and
 * the tick's own tail never ran. The old 300ms check was satisfied by the row
 * that ate the tick, because it asked "may I start?" in healthy-trip units and
 * the row answered in degraded ones.
 */
const TRACKER_ROW_LEASH_MS = 1_500;
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
 * How long the reservation → final-write span of ONE alerting row may be HELD
 * for the tick (see PushWatcher.holdRowSpan and docs/duplicate-cards.md §17.5).
 * A row's span is the send window (TRACKER_SEND_CAP_MS) plus the delivery audit
 * insert and the final check write, each inside the row leash
 * (TRACKER_ROW_LEASH_MS) — the same chain the watchdog's own audit sums, minus
 * the claim and the reservation (both of which already landed by then), with
 * 1s of slack for timers that fire late.
 *
 * The hold is bounded ON PURPOSE: it is handed to `waitUntil`, so an
 * un-settled promise would extend the invocation — the very stall removed by
 * the watchdog — and it would falsify the watchdog's premise that every stage
 * of the pass is bounded. The row always reaches its final write (every exit
 * after a WON reservation breaks out of the alerts loop and falls through to
 * it, and both exits release explicitly), so this timer can only fire on a
 * path that already threw, where holding the invocation longer is pure leak.
 */
export const TRACKER_ROW_SPAN_HOLD_MS =
  TRACKER_SEND_CAP_MS + 2 * TRACKER_ROW_LEASH_MS + 1_000;
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
 *
 * 2026-09-21: 400 → 1_200, measured. Once the rotation was funded (see
 * TRACKER_TICK_BUDGET_MS) this stage became the LARGEST line item of the
 * pass and the only one producing nothing: the live pass note read
 * `holders 1600/0` — four probes (4 × this cap) burning 45% of a 3_560ms
 * pass with ZERO holder counts written — while every `holders_checked_at`
 * row in `push_watch` was 15-20h stale. The endpoint was healthy the whole
 * time (`/debug/birdeye-overview` on live tracked mints: 303 / 305 / 673 /
 * 816 / 907 / 2_870 ms), i.e. 400ms sat below the endpoint's own common
 * latency AND the due list (oldest-check first, misses write nothing) only
 * ever re-offered those same slow rows — so the stage timed out on the same
 * four rows on every pass, forever. 1_200 covered that day's measured range
 * and still respects the row loop: the probe only starts when the whole cap
 * fits inside the pass deadline, so the rotation always runs first.
 *
 * 2026-09-23: 1_200 → 2_400, measured again, because the ENDPOINT itself got
 * slower (the cap was never the problem). The same probe from the worker's own
 * egress against a live tracked mint (EYMBTNraihZkLhjVQhDivPhjAWFgRF1By2zVd8rcNcGz,
 * `/debug/birdeye-overview`) answered 1_008 / 2_368 / 2_525 / 2_281 / 2_451 /
 * 2_272ms — five of six calls above the old cap, where the same probe read
 * 303–907ms for five of six two days earlier. A cap below the endpoint's own
 * median collects the fastest call and throws the rest away: live, every pass
 * read `probe4 miss3` — three Birdeye calls spent, three rows parked for
 * TRACKER_HOLDER_BACKOFF_MS — for ONE count written, while `/health` showed
 * the stage as healthy.
 */
const TRACKER_HOLDER_CAP_MS = 2_400;
/**
 * How long the holder stage is willing to WAIT for the probes it started —
 * which is what decides HOW MANY it may start, because they all queue behind
 * ONE rate gate.
 *
 * Every Birdeye call in the isolate passes through the same throttle
 * (`birdeyeRequestIntervalMs`, 1100ms live — the stage shares it with the
 * scan's own Birdeye use). That gate is NOT a per-call queue: calls that
 * arrived during the same window wake and fire TOGETHER, so the second and
 * every later probe pay the fetch plus ONE gate, not one gate each. Measured
 * 2026-09-23 against the real client with a 300ms stub endpoint — four probes
 * dispatched together settled at 302 / 1_402 / 1_402 / 1_404ms. The old shape
 * gave every probe the bare fetch cap, so those three were reported as MISSES:
 * three Birdeye calls spent, three rows parked for TRACKER_HOLDER_BACKOFF_MS,
 * ONE count written — live `probe4 miss3` on every pass with four due rows.
 * The slice below is exactly what the cap above charges a call — the fetch plus
 * the one gate it may queue behind (2_400 + 1_100) — and is clamped by the pass
 * deadline, so the pass never starts a probe it cannot collect; the rows it
 * cannot reach stay DUE (reported as `cut`, never parked) for the next pass.
 *
 * It is also what makes the probe COUNT honest. Probes dispatched together
 * fire in the same gate window, so N of them cost the same wall clock as one
 * (that is why the old rule could start the whole head) — but each one is a
 * Birdeye subrequest of its own out of the invocation's 50, and the refresh
 * window only needs about one count a minute (29 tracked rows ÷ 30 minutes ≈
 * 0.97 row/min, measured 2026-09-23). So the stage starts ONE probe per pass
 * (see the slot rule at the dispatch): with the gate at 1_100ms and today's
 * 2.3s endpoint, one queued call settles at ~3.5s — the most a ~4.8s pass can
 * wait out — and the rest of the due head keeps its place as `cut`.
 */
const TRACKER_HOLDER_STAGE_MS = 3_500;
/**
 * Park a row whose holder probe MISSED its cap for this long — the stage's
 * negative cache (the same pattern as Scanner's `dataFailedAt`). Without it
 * a slow row keeps its place at the head of the due list (a miss writes
 * nothing, so `holders_checked_at` stays oldest) and re-burns the cap on
 * every pass while the fast rows behind it never get a turn: measured
 * 2026-09-21 as 12 rows pinned at 15-20h staleness with `holders 1600/0`
 * pass after pass. Only MISSES park — a success clears it.
 *
 * 2026-09-23: 10 minutes → 3, DOUBLING per consecutive miss up to
 * TRACKER_HOLDER_PARK_MAX_MS. Three minutes is what "faster coverage" costs
 * when the probe rate is CU-bounded (a probe is billed whether or not its
 * count lands, and the stage keeps a gap of PUSH_WATCH_HOLDER_MIN_GAP_MIN), so
 * a row that misses should not also sit out ten scarce turns. The ladder
 * stops the other failure: a chronically slow row is ALWAYS the oldest
 * `holders_checked_at`, so with a flat park it takes every probe and the 29
 * rows behind it never get a turn — the starvation the flat 10-minute park was
 * introduced to break, one CU budget smaller. 3 → 6 → 12 → 24, capped at 30.
 */
const TRACKER_HOLDER_BACKOFF_MS = 3 * 60_000;
/** Longest a holder row may be parked by the miss ladder above (ms). */
const TRACKER_HOLDER_PARK_MAX_MS = 30 * 60_000;
/** worker_state key holding the last holder-probe stamp (see the CU gate). */
const HOLDER_PROBE_STAMP_KEY = "holder_probe_at";
/**
 * Hard cap on the tracker's OWN DexScreener batch (the pass's one mandatory
 * request, handed to the client as a caller deadline so it stops dispatching
 * past it). Without this cap the batch ran on the client's own
 * PAIRS_FETCH_BUDGET_MS (1250ms) — LONGER than the pass budget — so a slow
 * batch silently consumed the entire pass and left the row loop with
 * nothing (see TRACKER_TICK_BUDGET_MS). A batch that misses the cap is
 * answered as `pairs-empty` (no row judged, nothing deleted — see the guard in
 * runTick) and retried on the next tick, where the pair cache makes the retry
 * cheap.
 *
 * 600 → 1_200 with the whole-pool head (2026-09-24): the batch now asks for
 * TRACKER_PAIR_HEAD = 30 addresses instead of 10, and the client sends them as
 * ONE request (`/latest/dex/tokens/<addresses>` takes 30 per request — see
 * DexScreenerClient.fetchPairsForTokens's 30-address batching), so the extra
 * cost is a larger payload on the SAME round trip rather than three round
 * trips. Measured before the change (live 2026-09-24 03:29Z): the 10-address
 * batch cost 335ms (`pairs 335/0`) inside a pass that spent 1_376ms of a
 * 4_873ms allowance — the headroom was already there and unused. The cap is
 * still well inside the pass, and both the heal's deadline and the row loop's
 * reserve are derived from it, so a batch that stalls yields to the rows
 * instead of holding the pass open.
 */
const TRACKER_PAIRS_BUDGET_MS = 1_200;
/**
 * Rows the pair batch covers: THE WHOLE ROTATION, not a slice of it.
 *
 * 30 is the tracking pool's own ceiling (cfg.maxTracked, itself hard-capped at
 * 30 in config.ts) and the listing is ordered active-rows-by-last-checked, so
 * the head now IS the rotation queue: ONE pass can evaluate every active row,
 * and the head stops being a second limit on coverage.
 *
 * History. 6 → 10 came with the 5_000ms allowance (2026-09-21), when the row
 * loop fit one or two rows per pass and the head only had to cover the loop's
 * own reach — a smaller head would have capped the rotation at the head size,
 * and asking DexScreener for all 30 addresses spent the pass's one mandatory
 * request on coins that were never evaluated (`pairs 0/30 miss 30`, live
 * 2026-09-18 02:01Z). Both halves of that reasoning expired with the batched
 * silent claims (2026-09-23): a pass now writes the whole head in ONE store
 * round trip and ends well inside its allowance — live 2026-09-24 03:29Z,
 * `ok:10/0 rows 10/29 pairs 10/10 … allow 4873 spend[setup 346/3 heal 214/1
 * pairs 335/0 rows 136/1 holders 0/0 held0 cut4] trips 7 db 1056ms`,
 * trackerMs 1376 — so what stopped a pass at ten rows was the HEAD itself, not
 * the budget and not the store. The rotation was therefore still three passes
 * deep (live age waves of ten rows at 0-30s / 240s / 330s, i.e. a full cycle
 * of 5-8 minutes) while each pass had ~3.4s to spare, and a `pairs-empty` tick
 * (the DexScreener batch that never answers) cost a third of a cycle instead
 * of one tick.
 *
 * The wider batch costs ONE request either way (the client batches by 30 — see
 * DexScreenerClient.fetchPairsForTokens), and rows the loop never reaches are
 * NOT counted as pair misses (pairMiss is incremented inside the loop only), so
 * they are never blamed, never deleted and never blocked from the next pass's
 * head. Side benefit: the holder stage's candidate list is `pairs.has(token)`,
 * so before this change a row outside the head could not be probed at all —
 * now the stalest holder row in the whole pool is always the one the pass's
 * single probe slot can go to.
 */
export const TRACKER_PAIR_HEAD = 30;
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
/**
 * The baseline repair (see the stage in runTick) is attempted ONCE per
 * ISOLATE, which is why the flag lives here next to the other module-scope
 * healer state and not inside the pass.
 *
 * Once is enough by construction: only code from before the heal's own
 * baseline guard could have written a row for it to find (see
 * docs/patches/pushwatch-zero-mcap-baseline.apply.js), so there is no stream
 * of new ones to chase. And once is all the pass can afford — the pass's
 * allowance is 1.2-1.6s against ~110-200ms round trips, and this statement
 * can only find rows on the very first pass after a deploy that carries it.
 * The trade is stated rather than hidden: an isolate whose pool is already
 * clean still pays this ONE round trip, on its first pass, and never again.
 */
let baselineRepairDone = false;

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
 *
 * ONE sub-floor reading no longer terminalizes: the rule requires TWO in a
 * row (see DRAIN_CONFIRM_MARK), because the same reading that means "drained"
 * is also what DexScreener answers for a pool it has not (re)indexed.
 */
export const LIQ_FLOOR_USD = 10_000;
/**
 * The persistent mark that records "one sub-floor reading has been seen" — the
 * first half of the drain rule's two-reading confirmation.
 *
 * WHY A READING IS NOT ENOUGH (2026-09-21). The rule used to terminalize on a
 * single sub-floor reading, and DexScreener answers `liquidity.usd: 0` — not a
 * missing field — for pools it has not (re)indexed. Because a 'rug' row is
 * never re-evaluated and the re-arm path only covers an UNPROVEN CARD SEND
 * (never a wrong reading), one transient zero permanently dropped a live coin.
 * Live shape (ARGUS, 2026-09-21 10:05Z): the card read `LP 僅剩 —（< $10K）`
 * while that row's own stored measurement was $65,179.55 — the audit flagged it
 * as `measurement_above_floor`. (That particular pool WAS drained: DexScreener
 * and GeckoTerminal both reported ~$0 reserves. So the card was right and its
 * single reading was still the wrong way to establish it.)
 *
 * The mark rides the PERSISTENT up_stages column, because the tracker rotates
 * rows across isolates and ticks — no per-process state can count two readings.
 * A reading back above the floor DISARMS it, so an oscillating pool cannot
 * accumulate its way to terminal, and the first sighting announces a ⚠️ card
 * instead of the terminal one, so the 💧 card that follows is never a surprise.
 */
export const DRAIN_CONFIRM_MARK = "liq1";
/**
 * The 💧 card's keyboard — the one button that can undo a terminal row.
 *
 * The drain card is the only card that ENDS tracking, and its evidence is one
 * provider's liquidity number, so the card now carries "🔁 恢復追蹤": the
 * callback re-arms the row (Db.rearmPushWatchAlert, guarded on
 * `last_state = 'rug'` so it can never resurrect a 🔕 tombstone or a
 * window-expired row) and the next pass measures the pool again. At-least-once
 * by design: a pool that really is drained re-announces the ⚠️/💧 pair, which
 * is the honest outcome — the user gets to say "recheck it" without waiting
 * out the 26h window or re-pushing the coin.
 */
export function resumeTrackingKeyboard(token: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [[{ text: "🔁 恢復追蹤", callback_data: `resume:${token}` }]],
  };
}
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
const RESURRECTION_MULT = 1.5; // revival floor = trough (or push baseline) x this

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
  /**
   * WHICH TRANSITION this card announces — its identity across a re-derivation.
   * The text cannot serve: it carries live numbers (mcap, %, 5m) and is never
   * byte-identical twice, so it can never answer "is this the card the last
   * attempt already sent?". The sig can, and that question is the whole
   * duplicate fix (see CUT_MARK_PREFIX).
   */
  sig: string;
  /**
   * The delivery audit PROVED this transition is already in the chat (an
   * earlier attempt's send was cut at the deadline and landed anyway). The card
   * is announced — the transition and its counters land with the row's write —
   * but NOT sent again. Live duplicates this removes: 💀 REK 20:39 → 21:02 HKT,
   * 🚀 POPEYE 18:36/18:39/18:43/18:46/18:49 HKT.
   */
  deduped?: boolean;
  /**
   * The audit proof's own stamp when `deduped` came from the NO-MARK rule (see
   * `proofIsCurrent`): the caller writes it back as this card's attempt mark, so
   * a pass that ROLLS THE ROW BACK still has mark+proof to refuse the repeat
   * from. Without it the transition is re-derived, suppressed while the proof
   * sits in its window, and SENT the moment the window moves on — the duplicate,
   * just later.
   */
  dedupedAt?: number;
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
 * CUT-CARD MARK — "an attempt for THIS transition is in flight".
 *
 * The duplicate the operator reports (💀 REK twice 23 minutes apart, 🚀 POPEYE
 * five times in 13 minutes) is not a rules-engine mistake: the transition is
 * derived once and re-derived identically afterwards. It is the SEND that
 * happens twice. A follow-up card is sent with the two-state `bounded(send,
 * slice, null)`, and `null` there means "we stopped WAITING", not "Telegram
 * refused" — the request is still in flight and the card is usually already in
 * the chat. The tracker read that as a failure, rolled the row's announcement
 * bookkeeping back, and the next pass re-derived the same card and sent it
 * again. The audit ring agrees: the cards that repeated have no `followup`
 * entry at all (nothing is audited on the cut path), so the evidence of their
 * delivery was thrown away with them.
 *
 * The fix rides the ONE column that already survives a rollback and is read by
 * every check: the persistent mark CSV (`up_stages`). A send whose outcome is
 * unknown writes `p:<sig>:<minute>` next to the marks, the next evaluation of
 * that row reads it, and — only if the audit ring PROVES THAT CARD (token and
 * sig, at or after that minute) landed — announces the transition without
 * sending it a second time. The mark is not announcement memory: the next check
 * write recomputes the column without it, so it lives exactly one evaluation.
 *
 * TWO REFINEMENTS (2026-09-22, the operator's "can it just never repeat?"):
 *
 *   * The mark set is a LIST of attempts, not one (addCutMarks). A pass
 *     delivers its cards in order and can run out of send slice midway, and the
 *     rollback that follows restores the WHOLE announcement — so the cards that
 *     had just been delivered get re-derived too (the POPEYE shape: five cards
 *     in thirteen minutes). Each of them has its own audit entry, so marking
 *     each of them is what lets the next evaluation refuse each repeat
 *     separately (deferrallog.deliveredFollowupProofs). The row loop still
 *     writes only its cut card's mark; passing it the whole attempt list is the
 *     one-line follow-up that finishes this half (docs/duplicate-cards.md §7.4).
 *   * An attempt that belongs to the row's MOST RECENT check is not re-sent
 *     while its proof is missing. The proof is written by the request's own
 *     settlement, so a slow DB or a proof read that failed makes "no proof"
 *     indistinguishable from "not delivered" — and re-sending on that guess is
 *     exactly the duplicate. Such an attempt instead defers the whole
 *     evaluation by one check (see `attemptIsCurrent`), so the decision waits
 *     for the evidence the next check reads, and the mark keeps the attempt's
 *     own stamp so the wait cannot prolong itself.
 */
const CUT_MARK_PREFIX = "p:";
/**
 * Granularity of the mark's stamp. A minute is far coarser than the send it
 * describes (sub-second) and far finer than any re-announcement gap we care
 * about, and it keeps the mark three characters wide. The bucket is ALSO how an
 * attempt is tied to the check that made it (see `attemptIsCurrent`), and the
 * proof is per card (see deferrallog.deliveredFollowupProofs), so a coarse
 * bucket can no longer let a NEIGHBOUR's delivery stand in for this attempt.
 */
export const CUT_MARK_BUCKET_MS = 60_000;

/** `p:<sig>:<minute>` — the mark one unknown-outcome send leaves behind. */
export function cutMarkFor(sig: string, at: number): string {
  return `${CUT_MARK_PREFIX}${sig}:${Math.floor(at / CUT_MARK_BUCKET_MS)}`;
}

/** Every cut mark in a mark CSV, oldest first. Garbage is skipped. */
export function parseCutMarks(
  csv: string | null | undefined,
): Array<{ sig: string; at: number }> {
  const out: Array<{ sig: string; at: number }> = [];
  for (const m of (csv ?? "").split(",")) {
    if (!m.startsWith(CUT_MARK_PREFIX)) continue;
    const [, sig, bucket] = m.split(":");
    if (!sig || !bucket) continue;
    const n = Number(bucket);
    if (!Number.isFinite(n)) continue;
    out.push({ sig, at: n * CUT_MARK_BUCKET_MS });
  }
  return out;
}

/**
 * The CSV a row is written with while one of its attempts is still open (see
 * CUT_MARK_PREFIX): the marks it already had, plus one mark per attempt the
 * caller hands it — each an unknown-outcome send, delivered or cut mid-flight.
 * Older attempt marks are replaced, because they describe a check that is over;
 * the ones passed in are the current evidence, and the result keeps the
 * column's sorted shape.
 *
 * Each attempt keeps its OWN stamp: for a cut card that is the instant the pass
 * stopped waiting (its proof can only be NEWER than that), and for a delivered
 * one the pass's clock read, which its own audit entry is by construction
 * newer than. Preserving the stamp is also what makes the wait work — a mark
 * re-stamped on every evaluation would tie the attempt to the check that just
 * ran, forever.
 */
export function addCutMarks(
  csv: string | null | undefined,
  attempts: ReadonlyArray<{ sig: string; at: number }>,
): string {
  const kept = (csv ?? "")
    .split(",")
    .filter((m) => m.length > 0 && !m.startsWith(CUT_MARK_PREFIX));
  for (const a of attempts) kept.push(cutMarkFor(a.sig, a.at));
  return kept.sort().join(",");
}

/** One attempt's mark in an otherwise unchanged CSV (see addCutMarks). */
export function addCutMark(
  csv: string | null | undefined,
  sig: string,
  at: number,
): string {
  return addCutMarks(csv, [{ sig, at }]);
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
  cfg: {
    cooldownMs: number;
    liqFloorUsd?: number;
    /**
     * Delivery proof for the attempt marks, keyed per CARD
     * (`deferrallog.cardProofKey(token, sig)`) → the newest `at` the audit ring
     * shows a follow-up card Telegram ACCEPTED for that row AND that
     * transition. Keyed per card, not per token: one row can carry several
     * cards in one pass, and a token-level max lets a delivered neighbour's
     * entry stand in for an attempt that never landed (see
     * deferrallog.deliveredFollowupProofs for why that was a silent miss).
     * Absent = nothing is proven, which for an attempt from the row's most
     * recent check means one check of waiting and then a send — fail-open in the
     * never-miss direction.
     */
    followupProofAt?: ReadonlyMap<string, number>;
  },
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

  // The attempt marks this row's last pass left behind (see CUT_MARK_PREFIX):
  // a send whose outcome was unknown means the card may already be in the chat,
  // and the audit's proof is what turns "may" into a decision. Indexed by the
  // transition they stand for, the NEWEST attempt per transition — a row can
  // carry several (see addCutMarks).
  const attemptMarks = parseCutMarks(row.upStages);
  const attemptAt = new Map<string, number>();
  for (const m of attemptMarks) {
    attemptAt.set(m.sig, Math.max(attemptAt.get(m.sig) ?? 0, m.at));
  }
  /**
   * When the audit ring proves a card for this transition was ACCEPTED, as the
   * newest `at` it carries; 0 = nothing proven.
   *
   * The exact key (token + sig) is asked first, and the token-only key is the
   * fallback for an entry whose writer did not stamp the sig (see
   * deferrallog.deliveredFollowupProofs): that one is coarser — it cannot say
   * WHICH card landed — so it is only consulted when the exact proof is absent.
   */
  const proofFor = (sig: string): number => {
    const proofs = cfg.followupProofAt;
    if (!proofs) return 0;
    const exact = proofs.get(cardProofKey(row.token, sig)) ?? 0;
    return exact > 0 ? exact : (proofs.get(row.token) ?? 0);
  };
  /**
   * The EXACT (token, sig) proof, with NO token-width fallback: 0 when the ring
   * holds none for this card.
   *
   * The fallback above cannot NAME the card it proves, and this value feeds a
   * rule that has no attempt mark to anchor it — so a proof that cannot name the
   * card could silence one that was never sent, the single direction this engine
   * must never take.
   */
  const exactProofFor = (sig: string): number =>
    cfg.followupProofAt?.get(cardProofKey(row.token, sig)) ?? 0;
  /**
   * Whether the audit proves a send for THIS transition landed during the check
   * this pass is making: the proof's own stamp sits in the row's check bucket,
   * or in the bucket right after it.
   *
   * The one-bucket slop is the same straddle `attemptIsCurrent` allows, for the
   * same reason: a pass that claimed at :59 can deliver at :00, one bucket ahead
   * of its own clock. Anything older is NOT this check's evidence — a re-armed
   * row (🔁 resume, a resurrection) can legitimately announce the same transition
   * again later, and an old delivery must never silence that new card.
   */
  const proofIsCurrent = (sig: string): number => {
    const at = exactProofFor(sig);
    if (at <= 0) return 0;
    const proofBucket = Math.floor(at / CUT_MARK_BUCKET_MS);
    const checkBucket = Math.floor(row.lastChecked / CUT_MARK_BUCKET_MS);
    return proofBucket === checkBucket || proofBucket === checkBucket + 1
      ? at
      : 0;
  };
  /**
   * An attempt FROM THE ROW'S MOST RECENT CHECK — its stamp sits in the same
   * minute bucket as `last_checked`, which is the clock the pass that cut it
   * wrote — OR in the bucket right after it.
   *
   * The one-bucket slop is the straddle, not a wider window: the mark carries a
   * minute-TRUNCATED stamp (see cutMarkFor) while `last_checked` is the exact
   * claim of the pass that wrote it, so a pass that claimed at :59 and cut at
   * :00 records the attempt one bucket AHEAD of its own clock. Reading that as
   * "an earlier pass" skipped the wait and re-sent the card while its proof was
   * still in flight — measured at ~10% of cuts (2026-09-23, §7.4). Attempts
   * always POSTDATE their pass's claim, so the only buckets that can hold this
   * row's last attempt are these two; an attempt from an earlier check is two
   * or more buckets behind (a carried-forward dedupe mark included), and is
   * judged normally.
   *
   * This is the whole "how long do we wait?" rule, and it needs no timer: the
   * proof of a cut send is written by the request itself, right after Telegram
   * answers — a moment no pass can wait for (that is what the cut IS). It lands
   * within the request's own latency, but the very next pass may read the ring
   * before it, or fail to read it at all, and both look exactly like "this card
   * never arrived". Waiting that ONE check is the only answer that cannot
   * duplicate: the attempt still belongs to the check the pass just made, and
   * the row is re-checked within a rotation, when the proof is either there
   * (→ announced, no second send) or genuinely absent (→ sent, exactly once: the
   * never-miss direction is a delay, never a loss).
   *
   * The gate is also why a mark with no check clock behind it (last_checked = 0,
   * a hand-written fixture or a row the terminal settle re-armed) is judged
   * normally: there is no recent pass for it to be waiting on.
   */
  const attemptIsCurrent = (m: { at: number }): boolean => {
    const attemptBucket = Math.floor(m.at / CUT_MARK_BUCKET_MS);
    const checkBucket = Math.floor(row.lastChecked / CUT_MARK_BUCKET_MS);
    return attemptBucket === checkBucket || attemptBucket === checkBucket + 1;
  };
  const young = attemptMarks.filter(
    (m) => attemptIsCurrent(m) && proofFor(m.sig) < m.at,
  );
  if (young.length > 0) {
    // DEFER THE WHOLE EVALUATION — announce nothing, send nothing, and write the
    // attempt marks back with THEIR OWN stamps (a fresh stamp would tie the
    // attempt to THIS check and push the wait out forever). The measurements
    // still advance, because they describe the coin and not the announcement.
    //
    // Why the WHOLE row rather than just the card in question: the announcement
    // columns are shared (last_alert_at, followups_sent, the mark CSV), so
    // letting a sibling card land them would land THIS card's transition too —
    // and a transition recorded as announced is one that never gets re-derived,
    // i.e. the card would be lost the moment the attempt really had failed.
    return {
      alerts: [],
      peakMcap,
      followupsSent: row.followupsSent,
      lastState: row.lastState,
      lastAlertAt: row.lastAlertAt,
      stopTracking: false,
      sellDomStreak: row.sellDomStreak ?? 0,
      // The stored trough is the 💀 row's resurrection anchor: a deferral
      // announces nothing, so it must not be dropped by the write either.
      deadTroughMcap: row.deadTroughMcap ?? null,
      announcedUpStages: addCutMarks(row.upStages, young),
    };
  }
  const fire = (kind: WatchAlert["kind"], text: string, sig: string) => {
    // Proof is asked per CARD, so an entry for another transition of the same
    // row can never stand in for this attempt (the token-only fallback aside).
    const at = attemptAt.get(sig);
    // A mark dates the send, so any proof at or after it proves that card
    // landed — whenever it landed, which is why this half needs no bucket.
    const provenAgainstMark = at !== undefined && proofFor(sig) >= at;
    // NO mark, and the audit still proves this transition is already in the
    // chat. The mark is written by the pass that ATTEMPTED the send, so a pass
    // that died before its write — a rollback, a killed isolate — leaves a
    // delivered card unmarked, and re-deriving it here sends the card twice.
    // Only THIS check's proof counts (proofIsCurrent): the same yardstick
    // attemptIsCurrent applies to a mark, extended to the delivered case.
    const provenNow = at === undefined ? proofIsCurrent(sig) : 0;
    const deduped = provenAgainstMark || provenNow > 0;
    // Only ever SET, never `false`: an alert that has nothing to say about the
    // proof should compare equal to one written before this rule existed.
    alerts.push(
      deduped
        ? {
            kind,
            text,
            sig,
            deduped,
            // The suppressed card's own attempt stamp, for the caller to write
            // back as a mark: the rollback below re-derives this transition, and
            // with no mark to carry it would find the proof outside its window
            // and SEND the card (see `dedupedAt`). The marked half needs none —
            // its stamp is already in `priorMarks`.
            ...(provenNow > 0 ? { dedupedAt: provenNow } : {}),
          }
        : { kind, text, sig },
    );
    lastAlertAt = now;
    followupsSent += 1;
  };

  // Liquidity drained outright (LP ≈ 0): the reported mcap is just the last
  // traded price × supply and carries no information. Wins over every other
  // state so we never send 🚀 off a zombie number — and it takes TWO sub-floor
  // readings to terminalize (see DRAIN_CONFIRM_MARK), the first one warning.
  const liqFloor = cfg.liqFloorUsd ?? LIQ_FLOOR_USD;
  const marks = new Set<string>();
  for (const m of (row.upStages ?? "").split(",")) {
    // Cut marks are consumed, not carried: they describe an attempt, and the
    // next check write recomputes this column from `marks`, so a mark that is
    // not re-added here disappears — one attempt, one mark, no staleness that
    // could suppress a LATER, genuinely new transition.
    if (m && !m.startsWith(CUT_MARK_PREFIX)) marks.add(m);
  }
  // undefined = the mark set is unchanged, so the caller leaves the column as
  // it is (the same contract the 🚀 stages use).
  const marksChanged = (): string | undefined => {
    const csv = [...marks].sort().join(",");
    return csv === (row.upStages ?? "").split(",").sort().join(",")
      ? undefined
      : csv;
  };
  if (live.liquidity !== null && live.liquidity < liqFloor) {
    if (!marks.has(DRAIN_CONFIRM_MARK)) {
      // First sighting: warn and remember, but keep watching. The card says
      // exactly what the next reading will decide, so the 💧 card that may
      // follow is announced rather than a surprise.
      marks.add(DRAIN_CONFIRM_MARK);
      fire(
        "liquidity",
        `⚠️ 流動性跌穿地板 ${symbol} | LP 僅剩 ${fmtUsd(live.liquidity)}（< ${fmtUsd(liqFloor)}）— 已記錄第一次讀數，下一次檢查仍低於地板就會停止追蹤（市值數據隨 LP 失真）`,
        "liqwarn",
      );
      return {
        alerts,
        peakMcap,
        followupsSent,
        lastState,
        lastAlertAt,
        stopTracking: false,
        sellDomStreak: row.sellDomStreak ?? 0,
        announcedUpStages: marksChanged(),
      };
    }
    // Second consecutive sub-floor reading: terminal. The row's stored
    // measurement already carries the first $0-ish reading, so a lost
    // completion write can no longer leave the audit's
    // `measurement_above_floor` contradiction behind.
    fire(
      "liquidity",
      `💧 流動性枯竭 ${symbol} | LP 僅剩 ${fmtUsd(live.liquidity)}（< ${fmtUsd(liqFloor)}，連續 2 次檢查），市值數據已失真（LP 被抽乾），停止追蹤`,
      "drain",
    );
    return {
      alerts,
      peakMcap,
      followupsSent,
      lastState: "rug",
      lastAlertAt,
      stopTracking: true,
      sellDomStreak: row.sellDomStreak ?? 0,
      announcedUpStages: marksChanged(),
    };
  }
  // A real reading back above the floor disarms the count, so a LATER dip
  // starts a new pair instead of inheriting this one's. Only a comparable
  // reading may do it: an UNKNOWN one (null — another leg's metric) carries no
  // evidence either way and must not erase what the last real reading said.
  let drainDisarm: string | undefined;
  if (live.liquidity !== null && marks.has(DRAIN_CONFIRM_MARK)) {
    marks.delete(DRAIN_CONFIRM_MARK);
    drainDisarm = marksChanged();
  }

  // Resurrection / silent-watch: once a coin is 💀 it is FULLY silent
  // until it recovers to trough × 1.5 (then a fresh cycle starts). Without
  // this absorption the stale-peak math would keep firing weak/ignition on
  // every bounce below the target.
  if (row.lastState === "dead") {
    // The revival target needs a real BASE, and `deadTroughMcap ?? mcapAtPush`
    // is not one for a row whose trough hit 0 AND whose baseline was never a
    // reading: the product is 0, and `live.mcap >= 0` is true for EVERY
    // reading — another 0 included. That shape is not hypothetical, it is
    // exactly what the heal's old 0-baseline enrollment produced, and the loop
    // it feeds is self-perpetuating: the resurrection below returns
    // `peakMcap: live.mcap` and `resetBaselineMcap: live.mcap`, i.e. a
    // NON-reading written back into both columns, which is what keeps the
    // target at 0 for the next pass.
    //
    // Live 2026-09-24 (玉兔, mcap_at_push 0, followupsSent 9): the row
    // resurrected repeatedly and its $70.9K peak was overwritten with 0 — so
    // the baseline repair could not touch it either, its `peak_mcap > 0`
    // guard being the thing that must never invent a number.
    //
    // A trough of 0 IS a reading (a corpse's $0 LP — see the drain rules
    // below), but it is still not a base, so the baseline is the fallback
    // there: the coin has to regain 1.5 × what it was PUSHED at, not 1.5 ×
    // nothing. When neither is a reading there is no target at all, and the
    // row stays dead and silent — the fail-quiet direction, which is the same
    // "missing data never judges" rule the liquidity guards use.
    const troughBase = row.deadTroughMcap ?? row.mcapAtPush;
    const target =
      (troughBase > 0 ? troughBase : row.mcapAtPush) * RESURRECTION_MULT;
    if (target > 0 && live.mcap >= target) {
      fire(
        "rising",
        `🟢 死而復生 ${symbol} | 從低點 ${fmtUsd(row.deadTroughMcap ?? live.mcap)} 反彈越過 ${fmtUsd(target)}（×${RESURRECTION_MULT}），重置基準繼續追蹤`,
        "revive",
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
      announcedUpStages: drainDisarm,
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
      "dead",
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
      announcedUpStages: drainDisarm,
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
      "sell",
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
        "ignite",
      );
      lastState = "ignite";
    }

    // Rising stages: fire the highest crossed stage not yet announced.
    // Memory lives in the PERSISTENT up_stages column — lastState is shared
    // with ⚠️/🔥 and gets wiped by them, which re-announced the same
    // milestone (three 🚀 JEFFERY cards in one hour). The card also names
    // the NEXT milestone so every card carries forward-looking info.
    // The SAME set the drain confirmation maintains above (it started as a
    // copy of this column), so a disarm written by that rule is never re-added
    // by a stage write here.
    const firedStages = marks;
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
          state,
        );
        // EVERY crossed stage is marked, not just this one. The memory walk
        // used to advance ONE milestone per cooldown window, highest first, so
        // a coin that gapped several stages in one tick (POPEYE: push → +230%)
        // produced a card per window in DESCENDING order — "下一關 +400%", then
        // "+200%", then "+100%" — each reporting the same move. A milestone
        // already sailed past is history, and every card names the next one
        // above it, so announcing the crossing once loses nothing.
        for (let j = 0; j <= i; j++) firedStages.add(`up${RISING_STAGES[j]}`);
        lastState = state;
        break; // one card per crossing, however many stages it spans
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
        weakMark,
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
        "liqcrash",
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
          "hold",
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
          "div",
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
    // A stage change owns the column when one happened; otherwise the drain
    // rule's disarm is the only edit that has to land.
    announcedUpStages: announcedUpStages ?? drainDisarm,
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
   * Rows whose holder probe missed its cap, and when (see
   * TRACKER_HOLDER_BACKOFF_MS). Entries expire as the stage walks them, so
   * the map stays bounded by the watch listing — the only rows the stage
   * ever looks at.
   */
  private readonly holdersFailedAt = new Map<string, number>();
  /**
   * Consecutive misses per parked row (see TRACKER_HOLDER_BACKOFF_MS): the
   * park LENGTH doubles with each one, so a chronically slow row cannot take
   * every probe a CU-bounded rate allows. Cleared by a count, like the park.
   */
  private readonly holderMissStreak = new Map<string, number>();
  /**
   * Epoch ms of the last holder probe (see the CU gate in the holder
   * dispatch). Also carries the DURABLE stamp (worker_state
   * `holder_probe_at`) once it has been read, so a satisfied gap is answered
   * from memory and the read costs one round trip per gap, not per pass.
   */
  private holderProbeAt: number | null = null;
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

  /**
   * The tick's `waitUntil` hand-off, when the caller has one (see runTick).
   *
   * Held on the instance for the duration of a pass rather than threaded
   * through every call site: the two places that need it (a CUT card's late
   * settle and the terminal card's background settle) both sit deep inside
   * the row loop and the send helper, and a pass is serial per isolate.
   */
  private keepAliveForTick: ((promise: Promise<unknown>) => void) | null = null;

  /**
   * Hold a promise this pass CANNOT await.
   *
   * Both callers write the ONLY proof their card's delivery will ever produce
   * (a per-card `followup` audit entry, see deferrallog.cardProofKey), and
   * both are created at the pass's tail — where an un-awaited promise is
   * CANCELLED the instant the handler returns. Live 2026-09-23: 12 `p:` marks,
   * ZERO of them with a proof in the ring, so `deduped` could never become
   * true: `dup-skip` was unreachable and the duplicate it exists to stop went
   * out on the next check instead. Same cancellation the worker's
   * tickWaitUntil was built for (the deferred token_stats writes measured 100%
   * loss without it).
   *
   * Nothing here changes what the pass DECIDES: the rollback, the attempt mark
   * and the re-announce have all already happened. Only the bookkeeping is kept
   * alive, so losing it costs a duplicate, never a miss.
   */
  private holdForTick(promise: Promise<unknown>): void {
    const keepAlive = this.keepAliveForTick;
    if (!keepAlive) {
      void promise;
      return;
    }
    try {
      keepAlive(promise);
    } catch {
      // A stale/absent execution context must never break the send loop.
      void promise;
    }
  }

  /**
   * Hold the reservation → final-write span of ONE alerting row for the tick,
   * and return the handle that releases it (see holdForTick for the hand-off
   * itself, and TRACKER_ROW_SPAN_HOLD_MS for the bound).
   *
   * WHY (docs/duplicate-cards.md §17.5, third bullet): the reservation commits
   * the transition BEFORE the send, so until the final write this row is
   * announced as far as every other isolate can see, with none of the
   * bookkeeping that says so. The watchdog exists to abandon exactly this kind
   * of pass, and an abandoned pass keeps running — but nothing keeps the ISOLATE
   * alive for it. Losing that span leaves the row reserved-but-unwritten, which
   * the next pass reads as "already announced": a silent missing card (the same
   * outcome as never returning at all, which is what this window is).
   *
   * The returned handle is idempotent (the timer and the explicit release may
   * both fire) and always safe to drop: with no tick connection holdForTick
   * discards the promise, and the timer still releases it.
   */
  private holdRowSpan(holdMs: number): () => void {
    let resolve!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const held = new Promise<void>((r) => {
      resolve = r;
    });
    timer = setTimeout(release, holdMs);
    this.holdForTick(held);
    return release;
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
   *
   * `keepAlive` is the tick's `waitUntil` hand-off, when the caller has one
   * (the worker passes `tickWaitUntil`). It exists so the two proof writes
   * this pass cannot wait for — a CUT card's late settle, and the terminal
   * card's background settle — are HELD instead of cancelled with the handler
   * (see holdForTick). Optional: tests and any non-worker caller keep the
   * plain fire-and-forget behaviour.
   */
  /**
   * Park a row whose holder probe missed, DOUBLING the wait per consecutive
   * miss (see TRACKER_HOLDER_BACKOFF_MS): the first miss costs 3 minutes, so a
   * row comes back quickly under a CU-bounded probe rate, while a row that
   * keeps missing — always the oldest `holders_checked_at`, so always at the
   * head of the due list — stops taking every scarce probe from the rows
   * behind it.
   */
  private parkHolderRow(token: string, at: number): void {
    this.holdersFailedAt.set(token, at);
    const streak = Math.min((this.holderMissStreak.get(token) ?? 0) + 1, 8);
    this.holderMissStreak.set(token, streak);
  }

  /** A landed count clears both the park and its ladder. */
  private clearHolderPark(token: string): void {
    this.holdersFailedAt.delete(token);
    this.holderMissStreak.delete(token);
  }

  /** How long this row's next park lasts (see TRACKER_HOLDER_BACKOFF_MS). */
  private holderParkMs(token: string): number {
    const streak = this.holderMissStreak.get(token) ?? 1;
    return Math.min(
      TRACKER_HOLDER_BACKOFF_MS * 2 ** Math.min(streak - 1, 3),
      TRACKER_HOLDER_PARK_MAX_MS,
    );
  }

  async runTick(
    deadlineMs?: number,
    keepAlive?: (promise: Promise<unknown>) => void,
  ): Promise<{
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
    /**
     * Cards NOT sent because the audit proved the same transition already
     * reached the chat (see `dup-skip` in the note and CUT_MARK_PREFIX).
     * Part of `alerted`: the announcement landed, the duplicate did not.
     * Optional: every return that defers BEFORE the row loop attempted no card
     * at all, which is the same reason `terminalAbandoned` is optional here.
     */
    deduped?: number;
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
    // The tick's waitUntil hand-off, when the caller has one (see holdForTick).
    this.keepAliveForTick = keepAlive ?? null;
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
      holders: { ms: 0, trips: 0 }, // Birdeye holder probes (additive; see TRACKER_HOLDER_CAP_MS)
      // Baseline repair (see Db.repairPushWatchBaselines): ONE guarded UPDATE
      // against the whole push_watch table, attempted once per isolate — so it
      // reads as a trip on the first pass after a deploy and 0/0 forever after.
      repair: { ms: 0, trips: 0 },
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
    /**
     * Rows this pass REPAIRED (see the baseline-repair stage). Declared next to
     * the heal counters and BEFORE stageNote(), which reads it: the early
     * returns below call stageNote() too, and a `let` declared further down
     * would put them in its temporal dead zone (the same trap the holder-probe
     * counters document).
     */
    let repairedBaselines = 0;
    // Holder-stage visibility, next to its clock: `holders 1200/1` alone
    // cannot tell "one probe landed" from "four probes timed out and one row
    // is parked", because the trips count only counts a probe that actually
    // WROTE a count (both shapes read 0 on a miss). Same reasoning as the
    // heal's miss/enrolled pair. The clock is the COLLECT: the probes start
    // behind the pair batch and overlap the row loop (see the holder stage), so
    // a small `holders` reading next to `trips 1` is the normal shape.
    // `probe`/`miss` close the last of that ambiguity, live-verified
    // 2026-09-23: `holders 0/0 held0 cut0` reads either way, because a miss
    // writes nothing AND the row it missed was just checked — it leaves the
    // head of the rotation before its park can ever show up as `held`.
    let holdersHeld = 0;
    let holdersCut = 0;
    // Holder-PROBE counters, declared HERE and not next to the dispatch below:
    // stageNote() reads them, and stageNote() is also called by this pass's
    // early returns (the deferrals and the empty-rotation exits), which run
    // BEFORE the dispatch block — a `let` declared down there would put every
    // one of those calls in its temporal dead zone.
    let holderProbeDue = 0;
    /** This pass's probe was refused by the CU gap (see cfg.holderMinGapMin). */
    let holderGateBlocked = false;
    /** A probe started, so the durable CU stamp still has to land (see below). */
    let holderStampPending = false;
    let holderProbeHeld = 0;
    /** Probes this pass actually STARTED (see the dispatch behind the pairs). */
    let holderProbeStarted = 0;
    /** Probes that settled WITHOUT a count: capped, threw, or no holderCount. */
    let holderProbeMisses = 0;
    const stageNote = () =>
      `allow ${budgetMs} spend[setup ${spent.setup.ms}/${spent.setup.trips}` +
      ` heal${healSkipped ? "-skipped" : healCut ? "-cut" : ""}` +
      ` ${spent.heal.ms}/${spent.heal.trips}` +
      ` miss${healMissing} enrolled${healEnrolled}` +
      ` pairs ${spent.pairs.ms}/${spent.pairs.trips}` +
      ` rows ${spent.rows.ms}/${spent.rows.trips}` +
      ` holders ${spent.holders.ms}/${spent.holders.trips}` +
      ` held${holdersHeld} cut${holdersCut}` +
      ` probe${holderProbeStarted} miss${holderProbeMisses}` +
      // Only on the pass that RAN it: the repair is attempted once per
      // isolate, so this is one line on a fresh isolate's first pass and
      // absent forever after — never a permanent `repair 0/0 fixed0`. That is
      // also what makes it a live check that the stage is wired at all, since
      // the healthy reading is `fixed0`: the statement can only find rows left
      // behind by pre-guard code, and there are none to find once it has run.
      `${
        spent.repair.trips > 0
          ? ` repair ${spent.repair.ms}/${spent.repair.trips} fixed${repairedBaselines}`
          : ""
      }` +
      `${holderGateBlocked ? " cu-gate" : ""}]`;
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
      // Claims FIRST, in the SAME batched round trip as the prune that
      // follows them, then the cards: the claim-before-send guarantee is
      // unchanged (a batch is one request, executed in statement order), but N
      // expiring rows plus the bulk DELETE now cost 1 subrequest instead of
      // N+1 — on an invocation whose real budget is Workers Free's 50
      // subrequests (Turso's HTTP transport counts one per statement batch),
      // that is the difference between this stage and a whole tick.
      let won: boolean[] = expiring.map(() => false);
      try {
        const claimed = await this.db.claimRecapsAndPrune(
          expiring.map((r) => r.token),
          windowCutoff,
        );
        won = claimed.won;
        trips += 1;
      } catch {
        /* best-effort: no card without a claim */
      }
      for (let i = 0; i < expiring.length; i++) {
        if (!won[i]) continue;
        try {
          // BOUNDED like every other send in the pass (see bounded): this was
          // the last unbounded await in runTick, and the one that measured
          // live (2026-09-23 04:01:51Z: the note sat at `phase:"running"` for
          // 61 seconds while two ticks died at 78014ms and 62197ms against a
          // healthy 3-4s). Telegram does not reject on a 429 — grammy SLEEPS
          // `retry_after` internally (30-60s is routine for a bot that just
          // burst a handful of cards) — so awaiting it held the whole pass
          // open no matter what budget it had, and the note never reached its
          // `done` write.
          //
          // The request is NOT cancelled, it is HANDED OVER first (see
          // holdForTick): the tick's waitUntil keeps it alive past this pass,
          // so the card still gets its chance to land. The recap is explicitly
          // best-effort (its row is claimed before the send and the prune
          // deletes it either way), so a bound that trips costs a 🏁 summary
          // card at worst — never a follow-up.
          const recapCard: Promise<unknown> = this.bot.api.sendMessage(
            expiring[i].chatId,
            recapMessage(expiring[i]),
          );
          this.holdForTick(recapCard);
          await this.bounded(recapCard, TRACKER_SEND_CAP_MS, undefined);
        } catch {
          /* best-effort */
        }
      }
    }
    // The prune deletes exactly the rows past the window, and whenever a row
    // was claimed above it rode that very batch (claimRecapsAndPrune deletes
    // exactly the rows past the window). This arm is left for the passes with
    // NOTHING to claim — a listing that failed, or an unwatched-only tail —
    // and even then a COMPLETE listing holding no past-window row still skips
    // the round trip outright.
    const listingComplete = snapshot !== null && snapshot.length < cfg.maxTracked;
    const pruneNeeded =
      !listingComplete || (snapshot ?? []).some((r) => r.pushedAt < windowCutoff);
    if (pruneNeeded && expiring.length === 0) {
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
      /**
       * The heal's push-baseline ledger row, read in the SAME batched round
       * trip as the untracked list (see findUntrackedPushesAndLedger): it used
       * to be a SECOND subrequest out of the invocation's 50, paid only once
       * something was missing — which is exactly when the pass is closest to
       * its budget cut.
       */
      let ledgerRaw: string | null = null;
      if (!healSkipped) {
        trips += 1;
        const healRead = await this.db.findUntrackedPushesAndLedger(
          now - cfg.windowHours * 3_600_000,
          PUSH_LEDGER_STATE_KEY,
          10,
        );
        missing = healRead.missing;
        ledgerRaw = healRead.ledgerRaw;
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
        // (read with the untracked list above — ONE round trip for both, see
        // findUntrackedPushesAndLedger)
        const ledger = parsePushLedger(ledgerRaw);
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
          // The fallback (a push older than the ledger) is the pair's CURRENT
          // market cap, which is 0 for a pair the source carries no price for
          // — and a 0 baseline poisons every derived number: the recap's
          // "推送 $0", chgSincePush against max(0,1), and a dead-state
          // resurrection floor of 0. Live 2026-09-24: exactly two rows (💲,
          // 玉兔) carried mcap_at_push 0 this way. Prefer a positive market
          // cap, fall back to the FDV when that is all the leg had (the same
          // substitution the dexscreener leg records via `mcapFromFdv`), and
          // SKIP this enrollment when neither exists — a pair with no
          // valuation is untrackable, and it re-heals on a later pass once a
          // reading lands.
          const fallbackMcap =
            Number.isFinite(pair.marketCap) && pair.marketCap > 0
              ? pair.marketCap
              : Number.isFinite(pair.fdvUsd) && (pair.fdvUsd ?? 0) > 0
                ? (pair.fdvUsd as number)
                : 0;
          const healedMcap = known?.mcapAtPush ?? fallbackMcap;
          if (healedMcap <= 0) continue;
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
    // A stored baseline that is not a READING is not a missing value but a
    // POISONED one (live 2026-09-24: two rows carried mcap_at_push 0 — see
    // docs/patches/pushwatch-zero-mcap-baseline.apply.js for what it poisons).
    // ONE statement repairs them (Db.repairPushWatchBaselines), issued on two
    // triggers that between them cover both shapes the pool can be in:
    //
    //   - `!baselineRepairDone`: once per isolate, and that is the only way to
    //     reach a row the listing cannot SHOW. It is capped at cfg.maxTracked
    //     with active rows first, and the other shape a 0 baseline takes is a
    //     row in the 💧 drain path, which ends up terminal — and terminal rows
    //     sort last. The rotation below cannot see it either: it evaluates
    //     activeRows only.
    //   - `rows`: a 0-baseline row that IS in the listing and carries a real
    //     peak right now. This is what the one-shot alone misses — the
    //     statement's own `peak_mcap > 0` guard needs the reading to exist at
    //     the moment it runs, so an isolate that spent its one shot before the
    //     reading arrived would leave the row poisoned for the rest of its
    //     window. That is not cosmetic while the row is ACTIVE: with a baseline
    //     of 0, chgSincePush divides against max(0, 1), so a phantom
    //     +499,900% can drive the ⚡ divergence card.
    //
    // Both triggers are free once the pool is clean (a boolean and a listing
    // that is already in hand), so the only cost is the statement itself, and
    // it goes out only when one of them says there is something to fix.
    const needsBaselineRepair =
      !baselineRepairDone ||
      rows.some((r) => r.mcapAtPush <= 0 && r.peakMcap > 0);
    if (needsBaselineRepair) {
      baselineRepairDone = true;
      trips += 1;
      spent.repair.trips += 1;
      const repairStarted = Date.now();
      try {
        repairedBaselines = await this.db.repairPushWatchBaselines();
      } catch {
        // Best-effort, like the rest of the pass's bookkeeping: the rows keep
        // their 0 baseline and the NEXT isolate's first pass tries again. The
        // flag stays set on purpose — a database that is down must not turn
        // this into a per-pass cost.
      }
      spent.repair.ms += Date.now() - repairStarted;
    }
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
    // Cut-card proof (see CUT_MARK_PREFIX): read ONCE per pass, and whenever
    // the head can be evaluated at all. It used to be gated on a head row
    // ALREADY carrying a cut mark, which made the no-mark rule (see
    // proofIsCurrent) unreachable by construction: that rule exists for exactly
    // the rows whose mark never landed, so gating the read on a mark meant the
    // proof was only ever consulted where the mark had already answered the
    // same question. One trip per pass, on the passes that can act on it; the
    // lookups inside the row loop stay free (in memory).
    let followupProofAt: ReadonlyMap<string, number> | undefined;
    if (head.length > 0) {
      const auditRead = (this.db as Partial<Pick<Db, "getPushAudit">>)
        .getPushAudit;
      if (typeof auditRead === "function") {
        try {
          followupProofAt = deliveredFollowupProofs(
            await auditRead.call(this.db),
          );
          trips += 1;
        } catch {
          // Nothing proven = the card is re-sent below: fail-open in the
          // never-miss direction, like every other proof read in this pass.
        }
      }
    }
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
     * Cards NOT sent because the delivery audit proved the same transition is
     * already in the chat (see CUT_MARK_PREFIX). Counted apart from `alerted`
     * because they are announcements without a send: the row's transition and
     * counters land with its own write, exactly as if the card had gone out —
     * which it did, one cut send earlier.
     */
    let dupSkipped = 0;
    /**
     * TERMINAL cards whose send was abandoned this pass. NOT part of
     * `undelivered`: those are rolled back and re-announced, these KEEP their
     * transition (that is the fix) and are counted here so the two different
     * promises stay distinguishable in /health.
     */
    let terminalAbandoned = 0;
    /**
     * START the holder probes HERE, behind the pair batch, and COLLECT them
     * after the row loop (see the holder stage below).
     *
     * The stage used to probe at the very END of the pass, under a rule this
     * move does not soften: a probe only starts when its whole
     * TRACKER_HOLDER_CAP_MS fits inside the pass deadline. The row loop always
     * spends that allowance first, so the rule made the stage DEAD — measured
     * 2026-09-23 on every pass of an hour: `holders 0/0 held0 cut4`, four due
     * rows selected and not one of them started, while 35 of the 40 tracked rows
     * carried no `holders_checked_at` at all (oldest stamp 368 minutes — see
     * docs/round-trips.md §4). Starting them one stage earlier buys the probes a
     * turn WITHOUT taking one from the rotation, because the two are not the
     * same kind of time: the probe is I/O-bound HTTP (Birdeye token_overview,
     * 300-900ms live, the reason the cap is 1_200) while the row loop's wall
     * clock is Turso round trips, so probes in flight overlap the rows instead
     * of queueing behind them. Nothing that keeps cards honest moves: every
     * WRITE still happens after the row loop, in the same order as before, and a
     * row gets a count only when its probe PROVED one inside the pass.
     */
    const holderProbeWrites: Array<{
      token: string;
      holders: number;
      at: number;
    }> = [];
    const holderProbePending: Array<Promise<void>> = [];
    /** Tokens whose probe had not answered when the pass moved on (→ parked). */
    const holderProbeUnsettled = new Set<string>();
    {
      const birdeye = this.birdeye;
      if (birdeye && cfg.maxHolderChecksPerTick > 0) {
        // A row that MISSED its probe is parked (see TRACKER_HOLDER_BACKOFF_MS)
        // and dropped BEFORE the slice, so a slow head cannot hold the stage's
        // slots while the rows behind it — the ones that answer inside the cap —
        // wait for turns that never come.
        const parked = (r: PushWatchRow) => {
          const failedAt = this.holdersFailedAt.get(r.token);
          if (failedAt === undefined) return false;
          if (now - failedAt >= this.holderParkMs(r.token)) {
            this.holdersFailedAt.delete(r.token);
            return false;
          }
          return true;
        };
        const holderHead = activeRows
          .filter(
            (r) =>
              pairs.has(r.token) &&
              (r.holdersCheckedAt === null ||
                now - r.holdersCheckedAt >= cfg.holdersRefreshMin * 60_000),
          )
          .sort((a, b) => (a.holdersCheckedAt ?? 0) - (b.holdersCheckedAt ?? 0))
          .slice(0, cfg.maxHolderChecksPerTick);
        const due = holderHead.filter((r) => !parked(r));
        holderProbeHeld = holderHead.length - due.length;
        holderProbeDue = due.length;
        // What a probe costs on top of its fetch: ONE gate (see
        // TRACKER_HOLDER_STAGE_MS for the measured shape — the gate fires the
        // calls that queued behind it together, so extra probes do not stack
        // cost). A probe whose whole cost the stage cannot wait out is started
        // by neither rule below: it would be collected as a miss and parked.
        const intervalMs = Math.max(1, this.config.birdeyeRequestIntervalMs);
        const fetchCapMs = cfg.holderCapMs;
        // What ONE probe is allowed to cost: its fetch plus the single gate it
        // may queue behind — the same quantity the stage's collect waits out
        // (see TRACKER_HOLDER_CAP_MS / TRACKER_HOLDER_STAGE_MS).
        const probeCapMs = fetchCapMs + intervalMs;
        // ONE probe per pass — the rate the refresh window needs, not the whole
        // due head (see TRACKER_HOLDER_STAGE_MS for the measurements: ~1 count a
        // minute keeps a 30-minute window turning on ~30 tracked rows). Every
        // extra probe is another Birdeye subrequest out of the invocation's 50,
        // and the old cap threw 3 of every 4 of them away. The config cap stays
        // the upper bound, so the table can be widened again by changing this
        // rule alone; the rows it cannot reach are reported as `cut` and keep
        // the front of the next pass's due list.
        //
        // CU GATE (see docs/round-trips.md §4.4): a probe is BILLED whether or
        // not its count lands (`/defi/token_overview` = 20 CU, and the free tier
        // is 30K CU a MONTH ≈ 50 calls a DAY for the whole bot), so the stage
        // also keeps a minimum GAP between probes. The stamp rides worker_state
        // so the cap holds across isolates; a satisfied gap is answered from
        // memory, so this read costs one round trip per gap rather than one per
        // pass, and the write (below, after the row loop) one per probe.
        const gapMs = Math.max(0, cfg.holderMinGapMin) * 60_000;
        let cuGateOpen = true;
        if (gapMs > 0) {
          let lastAt = this.holderProbeAt ?? 0;
          if (now - lastAt >= gapMs) {
            try {
              const raw = await this.db.getWorkerState(HOLDER_PROBE_STAMP_KEY);
              trips += 1;
              lastAt = Math.max(lastAt, raw ? Number(raw) || 0 : 0);
              this.holderProbeAt = lastAt;
            } catch {
              /* unreadable → the in-memory stamp still caps THIS isolate */
            }
          }
          cuGateOpen = now - lastAt >= gapMs;
        }
        if (!cuGateOpen) holderGateBlocked = true;
        const holderSlots = cuGateOpen
          ? Math.min(cfg.maxHolderChecksPerTick, 1)
          : 0;
        for (const r of due) {
          // The start condition is UNCHANGED — the whole cap must fit inside
          // the pass deadline — it is simply evaluated where the pass still has
          // its allowance (setup + heal + pairs leave 1.0-3.0s of it).
          if (holderProbeStarted >= holderSlots) break;
          if (Date.now() + fetchCapMs > deadline) break;
          holderProbeStarted += 1;
          holderStampPending = true;
          this.holderProbeAt = now;
          holderProbeUnsettled.add(r.token);
          holderProbePending.push(
            this.bounded(
              birdeye.getTokenOverview(r.token),
              probeCapMs,
              null,
            )
              .then((overview) => {
                holderProbeUnsettled.delete(r.token);
                if (overview && overview.holderCount !== null) {
                  holderProbeWrites.push({
                    token: r.token,
                    holders: overview.holderCount,
                    at: now,
                  });
                  this.clearHolderPark(r.token);
                  return;
                }
                // Only a probe that WROTE a count clears the park: a timeout, a
                // malformed body and a throw all mean "no holder data this
                // time".
                holderProbeMisses += 1;
                this.parkHolderRow(r.token, Date.now());
              })
              .catch((err) => {
                holderProbeUnsettled.delete(r.token);
                holderProbeMisses += 1;
                console.error(
                  "[push-watch] holder refresh failed:",
                  err instanceof Error ? err.message : err,
                );
                this.parkHolderRow(r.token, Date.now());
              }),
          );
        }
      }
    }
    /**
     * Silent rows, QUEUED instead of written one at a time.
     *
     * The loop used to send one `claimPushWatchCheck` per observed row — the CAS
     * that proves this isolate owns the row plus that row's check fields, in one
     * statement. That statement is not the problem; paying it N times is, because
     * the pass's allowance is measured in round trips (live 2026-09-23:
     * `rows 5/30 … spend[rows 1388/5] trips 9`). So the rows are collected here
     * and the whole queue is sent as ONE batched request after the loop (see
     * Db.claimPushWatchChecksMany), where each statement is still the same CAS.
     */
    const silentChecks: Array<{
      token: string;
      expectedLastChecked: number;
      backfill: boolean;
      v: Parameters<Db["claimPushWatchChecksMany"]>[0][number]["v"];
    }> = [];
    const rowsStart = Date.now();
    const rowsTrips = trips;
    /**
     * Milliseconds this pass has been paying per round trip, measured from
     * the loop itself (elapsed / trips made in it) rather than assumed from a
     * healthy Turso. Floored at TRACKER_ROW_MIN_MS so a fast pass keeps the
     * old reserve, and the callers below cap it at one leash.
     */
    const tripMs = (): number =>
      Math.max(
        TRACKER_ROW_MIN_MS,
        (Date.now() - rowsStart) / Math.max(1, trips - rowsTrips),
      );
    /**
     * Room a SPEND needs before it may START — the pairMiss delete, which is
     * the one spend with no send slice of its own to bound it. Refusing it is
     * free: the row stays listed and the next pass re-finds it.
     */
    const rowReserveMs = (): number =>
      Math.min(TRACKER_ROW_LEASH_MS, tripMs());
    for (const row of head) {
      // Budget check BETWEEN rows — but it gates the SPENDS, not the rows. A
      // quiet row costs no round trip of its own (its write rides the ONE
      // batched claim after the loop, see silentChecks), so charging it this
      // pass's clock bought nothing and cost plenty: live 2026-09-24
      // 04:56:13Z the loop spent 3_701ms on three alerting rows' claim/
      // reservation/write trips and then `break`-ed out with `rows 17/30` —
      // thirteen QUIET rows that would have joined the very batch the pass
      // was already paying for went unmeasured, and the next pass paid
      // another batch to pick them up.
      //
      // What is LEFT of the clock check is the pairMiss delete below: a row's
      // only spend with no slice of its own. The alerting path keeps the rule
      // it was built with (its own send slice — see the send gate further
      // down), because that slice is what bounds the pass tail: a live tick
      // finished 4_857ms into a ~4_840ms race window and lost its flush
      // entirely. The 2026-09-17 incident this gate descends from (front
      // stages ate the budget, the loop `break`-ed, 28 rows went unrefreshed
      // while the note read `ok:0/0`) is answered harder than before: no
      // quiet row is ever left behind, and a refused card still says so
      // (`budget-cut` plus `defer-send N`).
      const overBudget = Date.now() + rowReserveMs() > deadline;
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
        // The delete is this branch's ONLY round trip, so it is the only
        // thing the pass's clock has to refuse (see overBudget above).
        // Skipping it is free: the row stays listed, and the next pass
        // re-finds it either way.
        if (!overBudget && row.lastChecked > 0 && now - lastSeen > 2 * 3_600_000) {
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
        { cooldownMs: cfg.cooldownMin * 60_000, followupProofAt },
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
        // `continue`, not `break`: a refused row is left COMPLETELY
        // untouched (no claim, no write — see the alerting path below), so
        // the rest of the rotation is still worth walking — the quiet rows
        // behind it ride the pass's ONE batch for free. Breaking here is what
        // turned a short pass into an unmeasured tail of quiet rows.
        //
        // The send SLICE alone decides (not the loop's clock): in a one-row
        // pool this is still the progress floor's row, and the slice — not the
        // per-row cap — is what bounds the pass tail (see the live tick cited
        // at the top of the loop).
        if (sendBudgetEnd - Date.now() < needMs) {
          sendDeferred += 1;
          budgetCut = true;
          continue;
        }
      }
      // The check write's columns, in ONE place: the silent path below binds
      // them into its claim (one round trip), the alerting path writes them
      // after its sends — with `hold` rolling the announcement columns back
      // when a card did not go out (see the final write).
      const checkFields = (
        hold: boolean,
        attempts: ReadonlyArray<{ sig: string; at: number }> = [],
      ) => ({
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
        // A rollback restores the marks the row had — PLUS one mark per card
        // this pass ATTEMPTED (see CUT_MARK_PREFIX): every one of those sends
        // is still in flight, so each mark is how the next evaluation knows to
        // ask the audit before re-sending that same transition. ALL of them,
        // not just the cut one: a rollback re-derives every card of the row,
        // and a card the audit can prove was delivered must not be announced
        // again merely because a LATER sibling ate the slice (POPEYE).
        upStages: hold
          ? attempts.length > 0
            ? addCutMarks(row.upStages, attempts)
            : row.upStages
          : evalResult.announcedUpStages,
        deadTroughMcap: hold
          ? (row.deadTroughMcap ?? null)
          : (evalResult.deadTroughMcap ?? null),
        sellDomStreak: hold ? row.sellDomStreak : evalResult.sellDomStreak,
        lastMcap: pair.marketCap,
      });

      // SILENT ROW — nothing to announce (or a backfill, whose cards are
      // deliberately suppressed). The row is QUEUED, not written: the whole queue
      // goes out as ONE batched request after the loop (see silentChecks and
      // Db.claimPushWatchChecksMany). This is the pass's throughput — ~90% of the
      // rows a pass touches have nothing to say — and it used to cost one round
      // trip each out of an allowance that fits only a handful, which is why the
      // rotation covered five rows a minute.
      if (backfill || evalResult.alerts.length === 0) {
        silentChecks.push({
          token: row.token,
          expectedLastChecked: row.lastChecked,
          backfill,
          v: checkFields(false),
        });
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
      // HOLD THE RESERVATION → FINAL-WRITE SPAN (see holdRowSpan and
      // docs/duplicate-cards.md §17.5): the reservation below commits the
      // transition before the send, and only the final write restores the
      // bookkeeping that says so. Created HERE — before the reservation goes
      // out, so that write is covered too — and released at both of the span's
      // exits: the lost race below, and the final write at the row's end.
      const releaseRowSpan = this.holdRowSpan(TRACKER_ROW_SPAN_HOLD_MS);
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
        // The race was LOST: nothing was announced, so the span is over at
        // once — release it rather than let the timer hold the invocation.
        releaseRowSpan();
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
      /**
       * Every card this pass ATTEMPTED on this row: the ones it delivered and
       * any whose send the slice cut. Each rides the row's own mark CSV with
       * its OWN stamp (see addCutMarks), so the next evaluation asks the audit
       * per card before re-sending that transition.
       */
      const attempts: Array<{ sig: string; at: number }> = [];
      /**
       * The marks this row already carried, read BEFORE the engine consumes
       * them (evaluateWatch rebuilds the column from its stage marks, so an
       * attempt mark only survives a pass that re-adds it). A card the audit
       * already proves is not attempted again (`a.deduped`, skipped below), so
       * its mark must be carried forward UNCHANGED: re-stamping it with this
       * pass's clock would put the mark after the very proof that justifies
       * the skip and re-open the duplicate the skip exists to prevent.
       */
      const priorMarks = new Map<string, number>();
      for (const m of parseCutMarks(row.upStages)) {
        priorMarks.set(m.sig, Math.max(priorMarks.get(m.sig) ?? 0, m.at));
      }
      for (const a of evalResult.alerts) {
        if (backfill) break;
        // DEDUPE FIRST: a card the audit already proves delivered needs no send
        // slice, and skipping it here keeps it out of the held-back count (so
        // the row's transition lands instead of being rolled back with it). The
        // engine sets the flag only on a mark+proof match, so an unproven card
        // falls straight through to the send below.
        if (a.deduped) {
          dupSkipped += 1;
          alerted += 1;
          sentCount += 1;
          // Carry the proof's mark forward unchanged (see `attempts`): the
          // rollback below re-derives this transition, and only the
          // mark-plus-proof pair keeps it from being announced again.
          //
          // A card the NO-MARK rule suppressed has no carried mark to reuse, so
          // the proof's own stamp becomes one (`dedupedAt`): that is the write
          // the marks back half of that rule, and it is what makes the
          // suppression survive a rollback instead of decaying into a late
          // duplicate once the proof leaves its window.
          const carryAt = priorMarks.get(a.sig) ?? a.dedupedAt;
          if (carryAt !== undefined) attempts.push({ sig: a.sig, at: carryAt });
          continue;
        }
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
          // The attempt's OWN clock read, taken BEFORE the request goes out —
          // the terminal card below included: the audit entry this send writes
          // (right after Telegram answers, or from a cut one's late settle) is
          // by construction newer than this read, so a mark can never postdate
          // its own proof (a mark that did would suppress the card for one
          // check, the silent-miss direction).
          const attemptAt = Date.now();
          if (terminalAlert) {
            const outcome = await this.sendTerminalAlert(
              row,
              a.text,
              sendLeft,
              now,
              a.sig,
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
            // Hold the REQUEST, not just its outcome: a send that misses its
            // slice (the `null` below) is CUT, not failed — the race stops
            // waiting, the request does not, and the card is usually already in
            // the chat. The chain below writes the audit entry that late
            // success deserves, and that entry is the ONLY proof the next pass
            // can use to refuse the duplicate, because the rollback restores
            // this pass's marks and leaves nothing else behind.
            const inFlight = this.bot.api.sendMessage(row.chatId, a.text);
            sent = (await this.bounded(
              inFlight,
              sendLeft,
              null,
            )) as { message_id?: unknown } | null;
            if (sent === null) {
              attempts.push({ sig: a.sig, at: attemptAt });
              // The ONLY proof this request will ever produce — and it must be
              // HELD, not merely started (see holdForTick). This chain is
              // created at the pass's tail, so an un-awaited promise here is
              // cancelled when the handler returns and the cut leaves NO audit
              // entry at all: the live shape measured 2026-09-23 (12 marks, 0
              // proofs), and the reason the dedupe above could never refuse
              // anything.
              const proof = inFlight.then(
                async (late) => {
                  try {
                    await this.db.recordPushDelivery({
                      chatId: row.chatId,
                      token: row.token,
                      symbol: row.symbol,
                      messageId: Number(
                        (late as { message_id?: unknown })?.message_id ?? 0,
                      ),
                      kind: "followup",
                      // The CUT card's identity: this late settle is the only
                      // proof that request ever produces, and the next pass's
                      // mark for this transition has to be able to find it
                      // (see deferrallog.cardProofKey).
                      sig: a.sig,
                    });
                  } catch {
                    /* best-effort — an unproven card is simply re-sent */
                  }
                },
                () => {
                  /* a rejection writes nothing: the card is re-sent */
                },
              );
              this.holdForTick(proof);
            }
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
          attempts.push({ sig: a.sig, at: attemptAt });
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
              sig: a.sig,
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
        checkFields(holdAnnouncements, attempts),
      );
      // The span is closed: the reservation and the bookkeeping that says so
      // are both durable, so an abandoned pass can no longer leave this row
      // reserved-but-unwritten (see holdRowSpan).
      releaseRowSpan();
    }
    // The silent half of the loop, in ONE round trip (see silentChecks). Each
    // statement is the CAS the per-row path sent, and the queue is written even
    // when the loop cut short: those rows were already evaluated, and one trip is
    // cheaper than the single write the first of them would have cost on its own.
    // A rejected batch writes nothing — every queued row stays unclaimed with its
    // place at the front of the rotation, the same state the per-row path reached
    // when its own write failed — and an empty queue costs nothing at all.
    if (silentChecks.length > 0) {
      trips += 1;
      let won: boolean[] = silentChecks.map(() => false);
      try {
        won = await this.db.claimPushWatchChecksMany(
          silentChecks.map((s) => ({
            token: s.token,
            expectedLastChecked: s.expectedLastChecked,
            now,
            v: s.v,
          })),
        );
      } catch (err) {
        console.error(
          "[push-watch] silent-row batch failed:",
          err instanceof Error ? err.message : err,
        );
      }
      silentChecks.forEach((s, i) => {
        if (!won[i]) {
          claimLost += 1;
          return;
        }
        checked += 1;
        if (s.backfill) backfilled += 1;
      });
    }
    spent.rows.ms = Date.now() - rowsStart;
    spent.rows.trips = trips - rowsTrips;

    // The holder probe's CU stamp lands HERE: after the row loop, so a probe
    // never delays the rotation with its bookkeeping, and BEFORE the holder
    // stage, so that stage's own `holders <ms>/<trips>` keeps counting the
    // writes its probes produced. It lands for a MISS too (a miss is a billed
    // Birdeye call, and nothing else records it for the next isolate): one
    // round trip per pass that probed, bounded by the budget it implements,
    // and a failure costs this isolate's memory of the stamp, never a count.
    if (holderStampPending) {
      try {
        trips += 1;
        await this.db.setWorkerState(HOLDER_PROBE_STAMP_KEY, String(now));
      } catch {
        /* telemetry-grade: the in-memory stamp still covers this isolate */
      }
    }

    // Holder refresh (Birdeye CU-bounded): the probes were STARTED behind the
    // pair batch (see there); this stage only WAITS for the stragglers and
    // writes what came back. The clock below therefore measures the COLLECT —
    // the probes themselves overlapped the row loop — while `held` and `cut`
    // keep their meanings: held = rows already parked by an earlier miss, cut =
    // due rows this pass got no count out of (no room to start their probe, or —
    // only when the timers were starved — a probe still in flight).
    const holdersStart = Date.now();
    const holdersTrips = trips;
    if (holderProbePending.length > 0) {
      // No new unbounded await: every probe is already capped by its own
      // fetch plus one gate (see TRACKER_HOLDER_CAP_MS and the dispatch above),
      // and this only decides how long the pass is willing to WAIT for the ones
      // still in flight — the stage slice those caps were sized to fit inside
      // (TRACKER_HOLDER_STAGE_MS).
      await this.bounded(
        Promise.all(holderProbePending),
        Math.max(0, Math.min(TRACKER_HOLDER_STAGE_MS, deadline - Date.now())),
        null,
      );
    }
    // Still in flight means nothing was proven, so the row is parked exactly
    // like a probe that missed its cap (only a SUCCESS clears a park). This is a
    // SAFETY NET rather than a path: the dispatch above only starts a probe
    // whose whole cap fits inside the pass deadline, so the probe's own cap
    // always fires first and the wait below always covers it — unless the event
    // loop starved the timers, which is precisely the case that must not end
    // with a row looking checked when no count ever arrived.
    for (const token of holderProbeUnsettled) {
      this.parkHolderRow(token, Date.now());
    }
    holdersHeld = holderProbeHeld;
    holdersCut = holderProbeDue - holderProbeWrites.length - holderProbeMisses;
    if (holderProbeWrites.length > 0) {
      // The whole stage in ONE round trip (N before this).
      trips += 1;
      try {
        await this.db.setPushWatchHoldersMany(holderProbeWrites);
        for (const w of holderProbeWrites) this.clearHolderPark(w.token);
      } catch (err) {
        console.error(
          "[push-watch] holder batch write failed:",
          err instanceof Error ? err.message : err,
        );
        // A rejected batch wrote NOTHING: park every row it covered, the
        // same state a row whose own write failed used to reach.
        for (const w of holderProbeWrites) {
          this.parkHolderRow(w.token, Date.now());
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
      `${dupSkipped > 0 ? ` dup-skip ${dupSkipped}` : ""}` +
      `${undelivered > 0 ? ` undelivered ${undelivered}` : ""}` +
      `${terminalAbandoned > 0 ? ` abandoned ${terminalAbandoned}` : ""}` +
      `${rearmedCards > 0 ? ` rearmed ${rearmedCards}` : ""}` +
      `${recoveredThisPass > 0 ? ` recovered ${recoveredThisPass}` : ""}` +
      `${budgetCut ? " budget-cut" : ""} ${stageNote()} trips ${trips}`;

    return {
      checked,
      alerted,
      deduped: dupSkipped,
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
    /**
     * The 💧 card's own transition (`drain`). The audit entry its late settle
     * writes has to NAME the card, or it lands on the coarse TOKEN key that a
     * NEIGHBOUR's delivery can satisfy — the silent-miss shape §7.1 names.
     */
    sig: string,
  ): Promise<TerminalSendOutcome> {
    // The keyboard rides the terminal card only (see resumeTrackingKeyboard):
    // every other follow-up card re-derives itself on the next pass, so the
    // user has nothing to undo.
    const inFlight = this.bot.api.sendMessage(row.chatId, text, {
      reply_markup: resumeTrackingKeyboard(row.token),
    });
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
      // HELD for the tick, like the cut path's proof (see holdForTick): this
      // chain is created after the pass has already moved on, so an un-awaited
      // promise is cancelled at the handler's return. Losing it costs the 💧
      // card's own proof — the row is then re-armed into a duplicate.
      const settle = settled.then(async (late) => {
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
            sig,
          });
        } catch {
          /* audit is best-effort */
        }
        await this.clearAbandonedTerminalCard(row.chatId, row.token);
      });
      this.holdForTick(settle);
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
 * A lost completion write is the SAME unproven-send shape, one step further
 * along: the reserve PROVED the transition (both columns in one statement) and
 * the send that followed it is what nobody recorded — exactly the question the
 * abandoned-card settle answers with the delivery audit
 * (deferrallog.cardSendDisposition + settleUnconfirmedCardSends). So the class
 * gets the same policy instead of a human: proved delivered → keep the
 * transition and write the missing completion stamp back
 * (Db.restampTerminalCompletion); unproved → re-arm, because a drain card that
 * may never have arrived must not leave the row silent for good.
 *
 * What is NOT repairable is a measurement that contradicts its own state: a
 * stale number rather than a wrong verdict, reported for a human, never
 * rewritten.
 */
export type TerminalRowRepair =
  | "arm_alert_clock"
  | "restamp_completion"
  | "re_arm_row"
  | "none";

export function terminalRowRepair(
  issues: readonly TerminalRowIssue[],
  provedDelivered: boolean,
): TerminalRowRepair {
  if (issues.includes("unarmed_alert_clock")) {
    return provedDelivered ? "arm_alert_clock" : "re_arm_row";
  }
  if (issues.includes("lost_completion_write")) {
    return provedDelivered ? "restamp_completion" : "re_arm_row";
  }
  return "none";
}
