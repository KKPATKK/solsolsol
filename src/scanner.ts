import type { Bot } from "grammy";
import { tradeKeyboard } from "./bot";
import type { BirdeyeClient } from "./birdeye";
import type { AppConfig } from "./config";
import type { Db, TokenStats } from "./db";
import { DexScreenerClient, type PairInfo, type TokenProfile } from "./dexscreener";
import { fmtUsd } from "./format";
import type { HeliusClient, SupplyFlowResult } from "./helius";
import type { RugcheckClient } from "./rugcheck";
import type { TradeService } from "./jupiter";
import { pumpfunDiscoveryLimit, type PumpFunClient } from "./pumpfun";
import type { GeckoTerminalClient } from "./geckoterminal";
import type { MeteoraClient } from "./meteora";
import type { GmgnClient, GmgnTokenInfo } from "./gmgn";
import type { AxiomClient, AxiomTokenInfo, AxiomTrendingToken } from "./axiom";
import { parseAxiomTokenInfo } from "./axiom";
import type { ArkhamClient, ArkhamTokenHolders } from "./arkham";
import type { CrimeCheckResult, CrimeWalletClient } from "./crimewallets";
import { trendBandFromChats, type JupTokensClient } from "./jupfeeds";
import { renderMessage } from "./render";
import { WalletAnalyzer } from "./walletanalysis";
import { PushWatcher, liquidityIsComparable } from "./pushwatch";
import { FlurryAnalyzer, type FlurryOutcome, type FlurryReport } from "./flurry";
import {
  addDeferredToken,
  deferredTokenList,
  dropDeferredToken,
  isDeferredToken,
  missingDeferredTokens,
} from "./deferredmakeup";


/** Re-fetch RugCheck reports older than this to pick up late bundler detection. */
const RUGCHECK_REFRESH_MS = 15 * 60_000;
/**
 * Min gap between Axiom refresh attempts. Refreshing mints a new access
 * token server-side; when Axiom's trending shards are genuinely down the
 * 5xx trigger would otherwise refresh once per scan (60s). A 5-min cooldown
 * bounds that to a handful of refreshes per outage.
 */
const AXIOM_REFRESH_COOLDOWN_MS = 5 * 60_000;
/** Trending feed TTL cache — caps upstream Axiom calls at one per 3 min
 * across scan ticks (was once per 60s tick; rate-limit insurance). */
const AXIOM_TREND_CACHE_TTL_MS = 3 * 60_000;
let axiomTrendCache: { at: number; items: AxiomTrendingToken[] } | null = null;
/** Min gap between "Axiom session dead" admin alerts (6h — one nudge per half-day, not per scan). */
const AXIOM_SESSION_ALERT_GAP_MS = 6 * 3600_000;
/**
 * After an on-chain (Helius) or Birdeye lookup comes back empty/failed, do
 * not re-query the same token for this long. Every RPC retry costs credits on
 * the Helius free tier, and empty results (data not indexed yet) are not
 * cached in the DB, so without this a waiting coin would hammer the endpoint
 * on every scan.
 */
const DATA_NEGATIVE_CACHE_MS = 5 * 60_000;
/**
 * Max wall-clock time for one scan pass. A hung/slow upstream call must not
 * wedge the scanner forever: the Worker isolate keeps module state between
 * ticks, so a scan that never resolves (e.g. killed by Cloudflare's ~30s
 * invocation limit mid-flight) would make every later tick skip and the bot
 * go silent. Released well before that wall-clock limit.
 */
const SCAN_TIMEOUT_MS = 25_000;
/**
 * Hard wall-clock deadline for one scan pass, enforced inside runOnce (well
 * before SCAN_TIMEOUT_MS releases the lock). Candidate processing is the
 * expensive part — the Helius opening-volume enumeration alone can burn up
 * to WINDOW_ENUM_BUDGET_MS (16s) per coin — so once the deadline is hit,
 * remaining candidates are deferred to the next tick (they stay in the
 * re-evaluation pool, nothing is lost). Keeps every tick comfortably inside
 * the worker's 26s heartbeat budget and Cloudflare's ~30s wall clock.
 *
 * 2026-09-13: 20s → 11s. The worker's race cuts the scan at 12s MINUS
 * pre-race spend (typically ~1-2s), i.e. ~10-11s of tick time — an 11s
 * internal deadline now matches the race instead of running 8-9s PAST it:
 * every internal phase and analyzer now stops at the same wall the worker
 * enforces, instead of grinding as a zombie while the flush waits (zombie
 * work overlapping the flush was the residual dead-tick shape).
 * SIDE EFFECT (deliberate): Flurry's budget guard defers when
 * `deadline - now < cfg.budgetMs` (15s). Under the 20s deadline it started
 * at ~15.5s remaining and NEVER ran — the last anti-rug gate has been
 * silently disabled since the 12s race era. At 11s it still never fits —
 * FLURRY_BUDGET_MS is cut to 8s (wrangler.toml) so it fits whenever ≥8s
 * remain (post-feed ticks with a fast pool read) and the gate is live
 * again, bounded well inside the race.
 *
 * 2026-09-15: 11s → 5s, tracking the worker's new envelope (see
 * SCAN_TICK_BUDGET_MS / SCAN_FLUSH_RESERVE_MS there): the race now cuts the
 * scan at ~5.6s so the completion flush always starts ~6s into the tick,
 * and the internal deadline sits just under it (5s) so every phase stops
 * on its own terms at a boundary — a full summary, no zombie tail — instead
 * of being frozen by the invocation kill mid-await. Every phase budget
 * below was scaled to the same window; the rotation slice + re-eval pool
 * absorb the shorter scan (latency, not coverage).
 *
 * 2026-09-16: 5s → 4.2s, and — the actual fix — the front phases are now
 * capped so their SUM fits the front window (see SCAN_GATE_RESERVE_MS),
 * instead of each phase holding a cap that was sized in the 12s-race era.
 * Live evidence for why: the caps were FEED 1800 + POOL 2200 + PAIRS 1500 =
 * 5500ms, i.e. LARGER than this 5s deadline (and larger than the worker's
 * ~6s race), so on any tick where the upstreams were slow enough for every
 * phase to ride its cap, the gate/push phase started AFTER the deadline:
 * the candidate loop's first check (`Date.now() > tickDeadline`) broke
 * immediately and the tick ended with `candidates: 1, pushed: 0`. The
 * 2026-09-16 06:2x–06:35Z history is exactly that shape — every tick
 * `scan exceeded its ~5964ms race window … candidates 1, pushed 0`, and
 * from 06:36Z every tick died before its completion flush. A tick that
 * discovers candidates but never reaches the gates cannot push, which is
 * the zero-push stretch this fixes.
 *
 * The value itself must stay UNDER the worker's race window, not merely
 * near it: the race is `SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS -
 * preRace` ≈ 4.5s at the current numbers, and a deadline above that is
 * useless — the race freezes the scan mid-await before any deadline-clamped
 * analyzer (supply flow, wallet analysis, Flurry) ever sees its own clamps,
 * so the gate chain is cut half-done and the coin is never pushed. A live
 * /debug/tick with the deadline at 4.6s did exactly that: race 4515ms fired
 * first, `candidates: 1, pushed: 0`. 4.2s leaves ~300ms of margin for the
 * widest pre-race spend, so every gate returns on its own terms and the
 * push still lands inside the race.
 *
 * 2026-09-16 (later): the deadline alone was NOT enough — a tick that found
 * a candidate still pushed nothing, because the gate chain below the
 * deadline is SERIAL and unclamped (~11 live calls whose client timeouts sum
 * far past the tick). Every step now races its own chain deadline (see
 * CANDIDATE_PUSH_RESERVE_MS / bestEffort), so the coin that cleared its
 * gates always reaches the send.
 */
export const SCAN_TICK_DEADLINE_MS = 4_200;
/**
 * Wall-clock slice of the tick RESERVED for the gate/push phase — the ONLY
 * phase that can actually push a coin. The three front phases (discovery
 * feeds, re-eval pool read, DexScreener pair fetch) get the window
 * `SCAN_TICK_DEADLINE_MS - SCAN_GATE_RESERVE_MS` between them, and each of
 * their budgets is clamped to it, so their SUM can never consume the tick
 * again (the 2026-09-16 zero-push root cause: 1800 + 2200 + 1500 = 5500ms of
 * caps against a 4.2s deadline). Front-phase caps are ≥ their healthy-case
 * need, so a healthy tick is unchanged — the reserve only becomes real
 * when an upstream is slow, and then it buys the gates/push the time the
 * starved tick used to lose. The re-eval pool absorbs anything the shorter
 * front phases defer: a coin left unfetched is re-read on its next rotation
 * slot, a feed coin discovered a tick later is not lost (the 3h
 * pre-qualification margin covers its window entry).
 */
const SCAN_GATE_RESERVE_MS = 1_600;
/**
 * Slice of the scan deadline kept free for FINISHING the tick: the summary
 * build plus the worker's completion flush must still land inside the race
 * window. The post-push tracker pass is NOT part of the scan any more (see
 * Scanner.runTrackerPass) — it runs in the worker's tail, after this flush —
 * so what this reserve protects is the summary and the completion write
 * itself, which is the one write a tick can never lose.
 */
const SCAN_FINISH_RESERVE_MS = 600;
/** The front phases' shared window (feeds + pool read + pair fetch). */
const FRONT_PHASE_WINDOW_MS = SCAN_TICK_DEADLINE_MS - SCAN_GATE_RESERVE_MS;
/**
 * Slice of the gate reserve RESERVED for actually DELIVERING the card once a
 * coin has cleared its gates: claim + Telegram sendMessage + delivery audit +
 * push-watcher seed (+ the auto-mode buy). Everything in the candidate chain
 * races `chainDeadline` (= SCAN_TICK_DEADLINE_MS - this) so no slow upstream
 * can leave the tick without the seconds the send itself needs.
 *
 * Why this exists (2026-09-16, live on /debug/scan-history): ticks that DID
 * find a candidate never pushed one — every one of them was frozen at the
 * worker's ~4.8s race window with `candidates: 1, pushed: 0`, because the
 * chain AWAITS ~11 live calls serially (RugCheck, crime checkToken, Axiom,
 * Birdeye ×2, GMGN, Arkham, Jupiter organic, wallet analysis, Flurry, trade
 * mode) and no individual client timeout is aware of the tick. Capping the
 * front phases (SCAN_GATE_RESERVE_MS) was not enough: the reserve is consumed
 * by the chain itself. Whatever has not answered by the deadline now degrades
 * to the same "未分析 / —" the card renders on an upstream failure, and the
 * coin — already through every real gate — still gets pushed.
 *
 * 2026-09-20 (900 → 1500): the reserve was short by the one measurement that
 * decides this number — what a Telegram sendMessage round trip costs from this
 * Worker. Live /debug/test-push timings: 0.62s and 1.23s (the /health baseline
 * in the same window was 1.12-1.21s, so most of it is isolate start plus
 * Telegram itself); the doc's "room ≈ R − 220" model (send deadline 4200 −
 * chain end 3300 − the fixed ~242ms of render + claim + trade-mode read) gave
 * the send 658ms of that. A card whose send ran longer was CUT at the
 * deadline, and a cut send is the duplicate generator: Telegram may already
 * have accepted the card, `sendTo` throws `cardSendTimeout`, its catch
 * releases the claim, the next tick sees the coin as unseen and pushes the
 * SAME card again. Measured live 2026-09-20 10:48-11:08 HKT: GROYPER and
 * PONDER each arrived 4-5 times, on ticks whose phases were exactly this
 * shape — `wallets@2800 flurry@3300 render@3300 send@3542`.
 *
 * At 1500 the chain ends at 2700ms, so the send slice becomes
 * `chain 2700 + 242 overhead` → send start ~2942 against a 4200 deadline,
 * i.e. ~1258ms — at or above the slowest measured round trip. The await then
 * normally completes INSIDE the slice, `sent` is non-null, the claim is kept
 * and the delivery audit is written: the one outcome that cannot duplicate.
 * A tick that still cannot afford the slice DEFERS instead (cardClaimDeadline
 * / cardSendDeadline return null, nothing is written, no claim is taken, the
 * coin keeps its make-up priority in the re-eval pool), so this trades
 * duplicates for push LATENCY, never for a lost push — and a duplicate card
 * is worse than a late one, because the second card reads as a fresh
 * opportunity the operator may act on twice.
 *
 * What it costs, honestly (all fail-open, all measured by the heartbeat):
 *  - the whole post-discovery chain gets 600ms instead of 1.2s, so the
 *    CARD-ONLY decor batch (Birdeye holder/pro-trader, GMGN, Arkham, Jupiter
 *    organic) mostly misses its deadline and renders as "—", and the slow
 *    gate walks (wallet analysis, Flurry) lose the tail they were already
 *    spending without finishing (the live stamp above shows the wallet walk
 *    burning 2800→3300 straight to its deadline). Those clients cache per
 *    mint, so a warm/cached judgment still lands and a re-sweep still
 *    decorates. CANDIDATE_GATE_TAIL_MS is deliberately NOT retuned: the gate
 *    window is `chainDeadline − enrichDeadline` = the tail, so leaving it at
 *    500 keeps the gates' window SHAPE identical while the numbers above
 *    shift earlier.
 *  - a chain that STARTS late (front phases riding their FRONT_PHASE_WINDOW_MS
 *    cap) can now reach the loop's `Date.now() > chainDeadline` guard before it
 *    processes a candidate, which defers that candidate to the next tick. Same
 *    trade every budget cut here has always made: the coin keeps its re-eval
 *    slot and its deferral make-up priority, so it costs a minute of latency,
 *    never coverage.
 *  - the trailing tracker + summary also finish earlier, which hands the
 *    difference back to the worker's completion flush — the same slack the
 *    dead-tick work in docs/scan-completion-loss.md is trying to buy.
 * If card decoration ever matters more than a duplicate, this is the single
 * constant to lower again; `cardSend.cut` (heartbeat) counts the cuts it
 * removes and `/health.deferral.pending` counts the deferrals it adds.
 */
export const CANDIDATE_PUSH_RESERVE_MS = 1_500;
/**
 * Preferred slice for the initial-card Telegram send (see the send in
 * sendTo). The send is the LAST step of the push path and the only one that
 * was never bounded: the reserve above is time kept for it, not a cap on
 * it, so a slow Telegram held the tick open past the worker's race window
 * and the whole tick lost its completion flush. The new push-phase marker
 * caught it live (2026-09-18 02:52:18Z: `pushPhase: send:telegram`, tick
 * 5000ms of a 4792ms race window, `candidates 1, pushed 0`). The slice is
 * clamped by CARD_SEND_TAIL_MS below, and a send that misses it is treated
 * as a delivery failure — its claim is released and the coin stays in the
 * re-eval pool, so the next tick retries it.
 *
 * NOTE (2026-09-19, later): the floor used to be UNDER the claim gate's
 * requirement (CARD_CLAIM_BUDGET_MS + CARD_SEND_MIN_MS), which left the tick
 * holding ~850ms of unused tail while late sends were started with whatever
 * crumbs were left.
 *
 * 2026-09-20 (duplicate cards, GROYPER/PONDER x5 in one afternoon): the tick
 * spends every deadline it is given (`wallets@2800` = its enrich deadline,
 * `flurry@3300` = the chain deadline, `render@3300`, `send@3542`), so a card's
 * send was started 658ms before the 4200ms deadline while a Telegram
 * sendMessage round trip from this Worker measures 0.6-1.2s — the await was
 * cut, the claim released, and the next tick pushed the same card again.
 *
 * Raising THIS value (to ~900, with CARD_SEND_MIN_MS to ~700 so a claimed card
 * always has 400 + 700 = 1100ms) is the direct fix and is still NOT possible
 * from here: the boundaries it produces are pinned by assertions in
 * scripts/test-unit.js (cardSendDeadline at 4150/4151ms, cardClaimDeadline at
 * 3550/3551ms, both derived from this value and CARD_SEND_MIN_MS), and those
 * assertions sit at byte ~100K of that file, past the file-sync window (this
 * session measured the window: edits land up to ~line 1190 of a file and fail
 * past ~1240). Raising the floor would turn CI red with no way to update them.
 *
 * So the same outcome was bought from CANDIDATE_PUSH_RESERVE_MS instead (see
 * there: 900 → 1500), which moves the chain deadline instead of the send
 * floor: the send now STARTS ~2942ms with ~1258ms of slice, so it finishes
 * inside its deadline and the claim is never released for a delivered card.
 * This constant keeps its old meaning (the least slice a send may be given);
 * `cardSend.cut` in the heartbeat (src/tickprobe.ts) counts any that are still
 * cut, so the effect stays measurable.
 */
const CARD_SEND_FLOOR_MS = 600;
/**
 * Hard tail for the initial-card send: it may never be allowed to run past
 * `startedAt + SCAN_TICK_DEADLINE_MS + 200`, and it is only STARTED while at
 * least CARD_SEND_MIN_MS of that tail is still left.
 *
 * Why, with the live number (2026-09-18 03:44:18Z): the floor above was
 * applied as `max(tickDeadline, now + 600)`, which is not a bound at all
 * once the chain runs late — a send starting at 4.31s was granted until
 * 4.91s, while that tick's race window was 4742ms, so the tick still died at
 * 5000ms with `pushPhase send:telegram` and the second candidate unsent. A
 * cap the tick cannot reach is not a cap. The tail sits ~340ms inside the
 * smallest race window observed so far (4742ms), leaving room for the
 * summary build and the worker's completion flush.
 */
const CARD_SEND_TAIL_MS = SCAN_TICK_DEADLINE_MS + 200;
/**
 * The tracker pass's durable coverage write is AWAITED, not raced (see
 * persistPassNote). The bound that used to sit here — 400ms, then 900ms
 * (2026-09-21) — is gone, and this comment is what is left of it: raising the
 * number did not fix the shape, because the shape was the bug.
 *
 * A race that resolves at its bound ABANDONS the write, and an abandoned
 * promise is CANCELLED the moment the invocation ends. Below the live round
 * trip that cancels every write (the 400ms episode above); above it, it still
 * cancels all of them as soon as Turso is slower than the bound — measured
 * 2026-09-22 18:09-18:28Z: the /health note froze for 19 minutes while the
 * same passes kept landing ROW writes, because those are awaited. What the
 * bound was protecting against — a hung write carrying the tick past its
 * deadline — is bounded lower down instead: every Db call runs under
 * wrapClientWithHardWall, and the tick's other tail write (the deferral
 * counter sync) is awaited on the same contract.
 */
/**
 * Least send slice worth starting. Below it the card is DEFERRED rather than
 * attempted: a deferral writes NOTHING (no claim, no audit, no failure record)
 * and the re-eval pool plus the deferred registry re-push the coin next tick,
 * while a send that cannot finish is the duplicate generator — Telegram
 * accepts the card, the await is cut, the claim is released, and the next tick
 * sends the same card again.
 *
 * 2026-09-20: this is the other half of the pair described at
 * CARD_SEND_FLOOR_MS above — the raise to ~700 (which also raises the CLAIM
 * gate to CARD_CLAIM_BUDGET_MS + this, so a claimed card always has 1100ms for
 * its claim plus its send) is blocked for the same reason and in the same
 * place: `cardSendDeadline(t0, t0 + 4150) === t0 + 4400` and
 * `cardClaimDeadline(t0, t0 + 3551) === null` in scripts/test-unit.js pin this
 * value's effect, and those assertions are past the file-sync window. The
 * duplicate fix therefore landed one level up, in CANDIDATE_PUSH_RESERVE_MS
 * (900 → 1500), which gives the send the room this constant exists to protect
 * without moving the pinned boundaries.
 */
const CARD_SEND_MIN_MS = 250;

/**
 * Slice the push claim (claimTokenPush) may have, and the room the tick must
 * have left before it is even attempted. The claim is a Turso round trip whose
 * own cap (SCAN_DB_TIMEOUT_MS = 1200ms, hard wall 1.44s with libsql's
 * post-abort retry) is LARGER than the tail a late chain leaves, so it became
 * the next step a candidate tick died on once the send was bounded: live
 * 2026-09-18 04:32:18Z and 04:33:18Z, both `pushPhase send:claim` (stamped at
 * 3.79s) cut at 5000ms of a 4728/4751ms race window, with only 608ms of tail
 * left for a step allowed to run for 1.2s. 400ms is a healthy insert plus
 * slack — deliberately smaller than the client's own cap, because a claim
 * that misses this slice is DEFERRED (the coin keeps its place in the re-eval
 * pool, nothing is written) rather than allowed to hold the tick open.
 */
const CARD_CLAIM_BUDGET_MS = 400;

/**
 * Deadline for the initial-card Telegram send, or `null` when the tick has
 * no slice left to start one (the card is deferred, never released as a
 * failure). Pure so the boundary is unit-testable: the send itself lives in
 * a closure inside runOnce, which has no offline fixture.
 *
 * The slice is `max(now + floor, tickDeadline)` clamped by the tail, so a
 * healthy send gets EXACTLY what it got before this existed (until the
 * tick's internal deadline) — the cap only becomes real for a chain that
 * runs past it, which is the case that used to kill the tick.
 */
export function cardSendDeadline(
  startedAt: number,
  now: number,
): number | null {
  const deadline = Math.min(
    Math.max(now + CARD_SEND_FLOOR_MS, startedAt + SCAN_TICK_DEADLINE_MS),
    startedAt + CARD_SEND_TAIL_MS,
  );
  return deadline - now < CARD_SEND_MIN_MS ? null : deadline;
}

/**
 * Deadline for the push CLAIM, or `null` when the tick has no room for the
 * claim plus the minimum send slice — in which case the coin is deferred
 * before anything is written. Same contract as cardSendDeadline (pure, so the
 * boundary is unit-testable), and the reason the claim can no longer be the
 * step a late tick dies on.
 */
export function cardClaimDeadline(
  startedAt: number,
  now: number,
): number | null {
  const send = cardSendDeadline(startedAt, now);
  if (send === null) return null;
  if (send - now < CARD_CLAIM_BUDGET_MS + CARD_SEND_MIN_MS) return null;
  return now + CARD_CLAIM_BUDGET_MS;
}

/**
 * Race a push claim against the slice the tick can give it. Returns `true`
 * (this isolate won the coin), `false` (another isolate already owns it), or
 * `null` (the claim did not answer, or threw, inside the slice — the caller
 * defers the card).
 *
 * The promise is kept and the row is RELEASED on `null`: the claim is an
 * INSERT OR IGNORE, so a row that lands after we stopped waiting is permanent
 * — it is the only insert that can win that coin, every later tick's claim
 * loses against it, and the coin could never be pushed at all. Releasing on
 * either settle outcome is safe because deleting a row that never landed is a
 * no-op.
 *
 * Exported (and therefore unit-tested) because its only caller sits inside
 * runOnce, which has no offline qualifying-coin fixture.
 */
export function boundClaim(
  claim: Promise<boolean>,
  timeoutMs: number,
  release: () => Promise<unknown>,
): Promise<boolean | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
  });
  return Promise.race([
    claim.then(
      (won) => won,
      () => null,
    ),
    expired,
  ])
    .then((won) => {
      if (won !== null) return won;
      void claim
        .then(
          () => release(),
          () => release(),
        )
        .catch(() => {
          /* cleanup is best-effort */
        });
      return null;
    })
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
}

/**
 * Cross-tick ledger of coins a late tick REFUSED to push (see
 * cardClaimDeadline / cardSendDeadline) and whether the re-eval pool then
 * pushed them.
 *
 * The deferral is deliberately invisible in storage — nothing is claimed,
 * nothing is written, and the coin keeps its place in the pool — which is why
 * "the coin really does come back next tick" could not be observed before
 * this: a tick that deferred a card and the tick that finally pushed it were
 * unrelated summaries. `recovered` rising is that proof, live.
 *
 * Bounded: a deferred coin that never returns (the market moved, the pool
 * pruned it) must not grow the set forever, so the oldest entry is evicted at
 * the cap. Pure and exported so the accounting is unit-testable — its caller
 * sits inside runOnce, which has no offline qualifying-coin fixture.
 *
 * The state itself lives in deferredmakeup.ts, because the obligation is also
 * read by the discovery feed (dexscreener.ts) — the one list a tick always
 * evaluates — and that module cannot import this one. It is the same registry
 * read twice, never a copy: the feed pulls in every pending token the pool's
 * rotation missed, which is what makes the make-up send happen on the NEXT
 * tick instead of whenever the coin's band comes around (see the module).
 */

/** Pending deferred-card identities for the worker's post-flush persistence. */
export function deferredPushTokens(): string[] {
  return deferredTokenList();
}

/**
 * Forget deferred-card obligations that were ALREADY DELIVERED (2026-09-20
 * duplicate fix; the rule lives in deferrallog.deliveredDeferredTokens).
 *
 * Why the drop has to exist next to the seed: seeding only ever ADDS to the
 * shared registry, so a token that was pushed by a tick whose completion write
 * never landed would be re-seeded from the durable pending list on every later
 * tick and pushed again — the duplicate card the user sees. Dropping it here is
 * safe by construction: the caller passes only tokens the delivery audit ring
 * proves Telegram accepted, and the coin keeps its place in the re-eval pool
 * either way (a deferral is deliberately invisible in storage), so a coin the
 * user is genuinely still owed is never forgotten — it just loses its forced
 * make-up priority, which is exactly right.
 */
export function forgetDeferredTokens(tokens: readonly string[]): number {
  let forgotten = 0;
  for (const token of tokens) {
    if (typeof token !== "string" || token.length === 0) continue;
    if (dropDeferredToken(token)) forgotten += 1;
  }
  return forgotten;
}

export class DeferredPushLedger {
  private recoveredCount = 0;

  constructor(private readonly maxEntries = 500) {}

  /** Record that `token` was refused a card (idempotent per token). */
  defer(token: string, at: number): void {
    addDeferredToken(token, at, this.maxEntries);
  }

  /**
   * Record a successful push: returns true when this token had been deferred
   * (so this push IS the make-up send the deferral promised).
   */
  recover(token: string): boolean {
    if (!dropDeferredToken(token)) return false;
    this.recoveredCount += 1;
    return true;
  }

  /** Coins deferred and not yet pushed back (visibility into the backlog). */
  get pendingCount(): number {
    return deferredTokenList().length;
  }

  /**
   * Pending tokens in oldest-first order. This is exposed for diagnostics and
   * for the bounded priority path that keeps deferred tokens ahead of normal
   * rotation when they are present in the pool slice (see slicePoolRotation)
   * and for the feed make-up pass that pulls in the ones that are not.
   */
  pendingTokens(): string[] {
    return deferredTokenList();
  }

  /** Deferrals that were followed by a real push — the at-least-once proof. */
  get recovered(): number {
    return this.recoveredCount;
  }
}

/**
 * Per-token GeckoTerminal lookups the post-push tracker may make in one
 * pass (see pairsForTracker). Two is one tick's worth of rows plus slack:
 * the client's throttle spaces every Gecko call by
 * geckoterminalRequestIntervalMs (1s by default, shared with the discovery
 * feeds that ran earlier in this same tick), so each lookup can wait most
 * of the tracker's pair budget before its request even starts.
 */
const TRACKER_GECKO_LOOKUPS = 2;
/**
 * Slice of the chain kept for the gates that run LAST (wallet analysis, the
 * top-10 band, Flurry deploy-slot forensics) so the CARD-ONLY enrichments in
 * the middle of the chain (Birdeye trader/overview, GMGN, Arkham, Jupiter
 * organic) cannot spend the whole window on decoration and leave a real gate
 * unjudged. Those four race this earlier deadline; when it passes they render
 * as "—" and the gates still get their turn.
 */
const CANDIDATE_GATE_TAIL_MS = 500;
/**
 * Minimum remaining tick time that makes a supply-flow analysis worth
 * STARTING (~2 Helius round trips). The configured budget (default 15s)
 * cannot be used as the guard: it is larger than the whole scan deadline
 * (~4.2s), so `remaining < cfg.budgetMs` was true on every coin since the
 * 12s-race era — the gate returned "hold" 100% of the time, i.e. it was
 * silently dead and every card showed 未分析. Same floor-not-budget shape as
 * flurry.ts FLURRY_MIN_START_MS.
 */
const SUPPLY_FLOW_MIN_START_MS = 1_200;
/**
 * Cap on how long one Flurry analyze() may wait inside the tick (see the
 * call site). analyze() races its RPCs against the deadline it is given, so
 * a hung Helius call otherwise holds the tick for the full remainder -
 * including the seconds the completion flush needs to land before
 * Cloudflare's invocation kill (2026-09-13 dead-tick shape: candidates on
 * 12s-timeout ticks while the flush never landed). 1.5s bounds the
 * worst-case wait inside the 5s deadline while still allowing the analysis
 * to start whenever ~2s of usable time remains (FLURRY_BUDGET_MS is 2s in
 * wrangler.toml, so the gate stays live on ticks with a fast feed phase).
 */
const FLURRY_ANALYZE_CAP_MS = 1_500;
/**
 * Wall-clock cap for the discovery-feed phase (feeds run sequentially, each
 * best-effort). Evidence 2026-09-07 ~18:30Z: timeout rows pinned at ms≈11.1s
 * carried profiles=0 pool=0 cand=0 — the feed phase alone consumed the whole
 * tick (slow/empty DexScreener profiles + gecko 429 backoff) and pool
 * evaluation plus candidates never ran, so ZERO ticks completed. The cap is
 * enforced two ways: each feed is skipped outright once the deadline has
 * passed, and each in-flight fetch is raced against the remaining feed
 * budget (a hanging upstream call resolves empty at the deadline instead of
 * starving the core scan). The core phases — pool eval, candidates, pushes —
 * always get the remainder of the tick.
 *
 * 2026-09-11: 5500 → 4500. The pool-slice rollback ladder (300 → 180 →
 * 120/tick) stopped converting ticks into completions — 14:00–15:47Z history
 * is ~85% budget rows (12.1–12.9s) even over a 94-coin pool, with only OK
 * ticks 7.9–9.2s: the residual tick cost is the feed phase itself, which
 * under the geo/GMGN 429 backoffs + Axiom 502 outage stretches to the full
 * 5.5s cap every tick (the deadline shapes the minimum, not the maximum).
 * Cutting the cap to 4.5s yields ~1s of guaranteed evalMs headroom on EVERY
 * tick, independent of upstream health; discovery loss is a later
 * registration (feed coins still enter via the re-eval pool), never a lost
 * coin. Restore to 5500 when the geo feeds recover (a full day of green
 * ticks at 4500 with feedsMs well under the cap is the evidence).
 *
 * 2026-09-12 (parallel fan-out): the feed chain ran SEQUENTIALLY — dex →
 * gecko ×2 → gmgn → axiom → jup ×2 — so each feed's throttle spacing
 * (gecko 1000ms, jupiter 500ms) + latency stacked and feedsMs rode the
 * 4500ms cap on every observed tick (15+ live samples: 3846–4394ms), even
 * with all upstreams healthy. The independent GETs now dispatch
 * CONCURRENTLY: worst case is max(feed) not sum(feed), returning ~3s per
 * tick to the pool evaluation + gates (the phases that actually qualify
 * coins). Cap stays 4500 — it now bounds only genuinely hung feeds.
 *
 * 2026-09-15: 4500 → 2400 with the rest of the tick ladder (see
 * SCAN_TICK_DEADLINE_MS). The fan-out already returns ~3s in the healthy
 * case, so the visible discovery loss is limited to the 429-backoff
 * stretches; leaving feeds 2.4s of the ~5.6s race is what keeps pool eval
 * + gates (the phases that qualify coins) funded on every tick.
 *
 * 2026-09-15 (later): 2400 → 1800. The coverage audit showed the binding
 * constraint on QUALIFYING coins is not discovery but evaluation: 13,724
 * never-pushed coins were eligible in the age window while a tick only got
 * through ~120 of them, and the feed's own coins are overwhelmingly the
 * sub-$10K-liquidity dust the pool prunes. Feeds now take 1.8s and the
 * pair fetch (PAIRS_FETCH_BUDGET_MS, same day) 2.0s so BOTH fit inside the
 * ~5.6s race and the gates still run at the end of the tick. A feed coin
 * discovered a tick later is not lost — it enters the pool and the 3h
 * pre-qualification margin covers its window entry.
 *
 * 2026-09-16: 1800 → 700, clamped to the front window (see
 * SCAN_GATE_RESERVE_MS). The fan-out runs CONCURRENTLY and its healthy-case
 * cost is the slowest single feed (DexScreener profiles, ~200–400ms), so
 * 700ms covers a healthy tick; what the smaller cap changes is the bad
 * tick, where the feeds used to hold 1.8s of a 5s tick and hand the gates
 * nothing. Discovery is the cheapest phase to defer: a feed coin enters
 * the pool and is evaluated on a later sweep, and feed coins are
 * overwhelmingly the sub-$10K-liquidity dust the pool prunes anyway (see
 * the RE_EVAL_PER_TICK_MAX notes).
 *
 * 2026-09-19: 600 → 900. Live evidence says part of the remaining
 * `profiles: 0` population is not "called and empty" but "never called":
 * `fetchFeedCapped` returns `empty` WITHOUT dispatching when the remaining
 * feed budget is under the 250ms make-up floor, so any tick whose pre-feed
 * steps (listEnabledChats + the crime-wallet refresh + the DB work ahead of
 * the feed) spend more than 350ms of the 600ms deadline loses the whole
 * feed. The signature is unmistakable in the history: `profiles: 0` WITH a
 * non-zero `pool` (so the scan continued past the feed phase) while the
 * cross-isolate heartbeat reports `deferral.pending > 0` — a feed that was
 * called would have injected the make-up lane on BOTH the failure and the
 * empty answer and reported pending, not 0 (15:07:12Z: prof 0, pool 222,
 * pending 5). Measured 11/120 ticks (9%) over 13:19–15:18Z, including a
 * 5-minute-spaced run (13:21/13:26/13:31/13:36/13:41Z) that is NOT
 * explained by the post-deploy cold isolates and is still unaccounted for.
 *
 * 900 moves the skip threshold to "pre-feed > 650ms", i.e. covers every
 * pre-feed cost measured so far except the cold isolate's ~4.8K-address
 * crime-list fetch (8s cap, first tick after a deploy). Accepted cost, and
 * it is real: the front window's unallocated slack over the pool read drops
 * 400 → 100ms (900 + POOL_FETCH_BUDGET_MS 1600 = 2500 < FRONT_PHASE_WINDOW_MS
 * 2600), and EVERY feed in the concurrent fan-out now races up to 900ms
 * instead of 600. On a bad tick that is 300ms less for the pair fetch (whose
 * own PAIRS_FETCH_BUDGET_MS is NOT clamped to the front window) and for the
 * candidate chain. The trade is deliberate: a feed coin discovered a tick
 * later is not lost (it enters the re-eval pool), whereas a skipped feed
 * loses that minute's discovery outright, and the make-up lane is skipped
 * with it. The actual fix for the skip path is passing the make-up list as
 * `empty` at the profiles call site (the call site sits past this tool's
 * edit window; the patch is recorded in docs/push-baseline-ledger.md).
 *
 * 2026-09-21 — both halves of that skip path are now closed, after the hour
 * of `profiles 0` ticks that made the cost of leaving it open concrete. The
 * measured cause was the PRE-FEED steps, not the feed: the enabled-chats read
 * plus a cold isolate's crime-wallet load (2.8-3.6s live) sat between tick
 * start and the fan-out, and the persisted crime-list stamp showed a cold
 * tick every 25-45s — so the window was nearly always gone before the fan-out
 * was reached. /debug/tick named it exactly: `profiles 0`, `feedsMs 0`,
 * `feedRequests 0` (the client was never called) while the pool still
 * evaluated 72-146 coins. Hence:
 *   1. the profiles fetch is STARTED at tick start, before those steps, and
 *      awaited where its result is used — it gets the whole window this
 *      constant sizes, whatever the pre-feed steps cost (`preFeedMs`);
 *   2. the call site passes the pending make-up coins as `fetchFeedCapped`'s
 *      `empty`, so a tick whose call is short-circuited or raced away still
 *      evaluates the deferred lane instead of nothing — with
 *      `profilesSettled: false` saying that is what happened.
 */
const FEED_DEADLINE_MS = 900;
/**
 * Wall-clock cap for the re-eval pool DB read and the token_stats prune
 * (both race against this deadline; see the call sites). Evidence
 * 2026-09-12 09:23–09:41Z: dead-tick clusters with no completion row at
 * all — the libsql client can hang in internal quota/5xx retries (the same
 * hang the worker's flush-retry guard exists for), and an unbounded DB
 * await wedges runOnce past the ~30s wall clock: abort() publishes the
 * in-flight summary but the completion flush shares the wedged client and
 * never lands. Racing these reads converts the wedge into a normal
 * (diagnosable) timeout row whenever the client recovers, and keeps the
 * scanner's phase budget honest when it doesn't.
 *
 * 2026-09-15: 4000 → 2200 with the tick ladder (see SCAN_TICK_DEADLINE_MS):
 * the pool read plus the slice's pair fetches must fit the ~5.6s race
 * alongside the feeds, and a pool read that needs more than 2.2s is the
 * hang this race exists to convert into a timeout (the slice defers, the
 * pool row survives, the next tick re-reads it).
 *
 * 2026-09-16: 2200 → 800, clamped to the front window (see
 * SCAN_GATE_RESERVE_MS). Most ticks are a pool-cache hit (the 90s TTL), so
 * the typical cost is ~0; the cap only bites on the TTL-expiry tick or when
 * Turso is slow, and 800ms is the point where the read has either landed or
 * is the hang this race exists to convert into a fast, diagnosable miss.
 * What it must NOT do is hold 2.2s while the pair phase and the gates wait
 * behind it — the shape that produced candidate-starved timeout rows.
 *
 * 2026-09-16 (later): 800 → 600, same gate-window funding: the pool read is
 * a cache hit (90s TTL) on most ticks, so the cap only bites on the
 * TTL-expiry tick or a slow Turso — and on those a fast, diagnosable miss
 * (slice deferred to the next rotation slot) beats a pool that spent the
 * candidate's gate window.
 *
 * 2026-09-19: 600 → 1400. The 600 ceiling rested on "most ticks are a cache
 * hit, so the cap only bites on the TTL-expiry tick". Live numbers say the
 * opposite: cron ticks land on freshly recycled isolates (the isolate that
 * answered /health reported dex cacheSize 0, i.e. no warm state), so the 90s
 * pool cache is COLD and the read genuinely happens nearly every tick.
 * Measured over 12 real scans (/debug/tick + heartbeat summary): 178, 230,
 * 352, 388, 442, 445, 448, 449, 457, 457, 544ms — the read sits at 59–91%
 * of a 600ms cap, so any Turso wobble crosses it. When it does,
 * fetchFeedCapped resolves the `[]` fallback; if the DexScreener profiles
 * feed is ALSO empty (429-backoff ticks: http429 1 with blockedForMs ≈ 32s),
 * the tick takes the `empty-feed-and-pool` early return and evaluates
 * NOTHING while still reporting ok:true — and the finally below nulls
 * lastSkip, so /health cannot say why (the only trace is profiles=0/pool=0,
 * which is what the 2026-09-19 06:14–06:57Z history shows for 60–100% of
 * ticks per 10 min: the pool sweep was effectively stopped for stretches).
 * 1600 is sized just ABOVE the fastest failure the DB layer can raise:
 * SCAN_DB_TIMEOUT_MS (1200) is only the TRANSPORT signal, and
 * wrapClientWithHardWall races every call against 1.2x it (= 1440ms) because
 * the libsql client retries internally after an abort. Keeping this cap below
 * that wall meant the scanner's silent `[]` could still win the race, which is
 * the whole failure this raise exists to remove; above it, a failed read
 * arrives as an ERROR and can be answered with the last good pool (see
 * src/poolfallback.ts) instead of costing the tick. The worst case still fits
 * the front window (FEED_DEADLINE_MS 900 + 1600 = 2500 < FRONT_PHASE_WINDOW_MS
 * 2600), so it cannot eat the 1600ms gate reserve the way the retired 2200 did.
 */
const POOL_FETCH_BUDGET_MS = 1_600;
/**
 * How long a first-seen token stays eligible for re-evaluation. Must cover
 * the qualifying age window (max 28h) plus a registration margin — the
 * operator runs 30h (28h + 2h slack): coins age into the window while
 * sitting in the pool, since the DexScreener profiles feed only ever
 * contains young tokens.
 */
const RE_EVAL_WINDOW_MS = 30 * 60 * 60_000;
/**
 * In-memory TTL for the re-eval pool query, from config.reevalPoolCacheMs
 * (REEVAL_POOL_CACHE_SECONDS, default 180 = 3 min). The pool only changes
 * when new coins are recorded, coins are pushed, or the age window slides —
 * nothing that happens between two 60s scans. The query is index-bounded
 * (see Db.getReevalPool: a launch_ms band scan over a few thousand rows
 * instead of the ~400K-row full scan it used to do — the dominant Turso
 * rows-read consumer, alerted 2026-08-16), so this cache cuts the remaining
 * cost to ~1/3 of a per-scan run at the default 3-min TTL. Stale coins are
 * harmless: the push path re-checks isTokenSeen from the DB before sending,
 * and newly discovered feed coins are evaluated via feedProfiles anyway. A
 * coin that ages into the window while the cache is live is pushed at the
 * next cache expiry, at most reevalPoolCacheMs later (the 3h
 * pre-qualification margin keeps most coins already pooled by then).
 */
/**
 * Margin (minutes) around the qualifying age window: the pool also holds
 * coins that will enter the window within 3h, so they are pushed the moment
 * they qualify instead of being picked up only after a later scan.
 */
const RE_EVAL_AGE_MARGIN_MIN = 180;
/**
 * Max re-eval-pool coins whose pair data is fetched per tick (the live feed
 * is always included on top). The pair fetch is the scan's dominant cost —
 * ~30 addresses per DexScreener batch inside a 10s internal budget — and
 * once the pool passed ~300 coins (10K+ eligible in the age window,
 * observed 2026-09-05) the fetch consumed the whole 15s tick budget: the
 * worker's abort then fired at the next phase boundary and NO coin was ever
 * evaluated (agedEval 0, empty rejects, zero pushes since 2026-09-03).
 * Slicing the pool into a rotating per-tick window bounds the fetch to ~4
 * batches and hands the budget back to the gates. The slice advances by its
 * own length every tick and wraps, so every pool coin is still re-checked
 * once per full sweep (≈ pool/80 ticks ≈ 6 min at 480 coins — still inside
 * the 3/9-min rotation bands); the SQL rotation bands underneath are
 * untouched. A coin crossing a momentum gate is caught within one sweep
 * instead of same-tick — the price of finishing scans at all.
 *
 * 2026-09-08: 120 → 80. Live phase timings post-Jupiter-pacing-fix showed
 * feedsMs 3.8s (was 5.4s) but evalMs GREW to ~2.9s — the freed feed budget
 * went into evaluating the full 120-coin slice, so ticks still landed at
 * ~11.2s and ~2/3 still tripped the 11s budget (13 ok / 25 T/O per 40).
 * 80/tick cuts evalMs ~1s (each slice coin costs one DexScreener batch
 * slot) while the sweep still covers every coin within the rotation bands.
 *
 * 2026-09-09: 80 → 70. After GeckoTerminal recovered (geo + geoTrend ≈ 40
 * more feed coins/tick) and the pool grew to ~540–595 rows, ~half of ticks
 * tripped even the raised 12s budget by only 100–300ms (12.2–12.8s) — the
 * tick cost is bimodal (~9.5s vs ~12.3s) with the slow tail set by pool
 * slice size × DexScreener batch latency. 70/tick shaves ~1s off evalMs,
 * converting the marginal ticks into completions; the sweep stretches from
 * ~7 to ~8 minutes, well inside the 6/18-min rotation bands, and the hot
 * zone (latency-critical near-entry coins) is re-evaluated EVERY scan
 * regardless of the slice size.
 *
 * 2026-09-09 (later): 70 → 60. The geo feeds stayed healthy and the pool
 * grew to ~710–875 rows: 6 of 12 ticks tripped the 12s budget (12.1–12.3s),
 * 4 in a row. The 0.6× pre-filter prunes the bottom of the pool but not
 * enough at this size. 60/tick shaves another ~0.5–1s off evalMs; the sweep
 * stretches to ~12 min (still inside the 6/18-min rotation bands, and the
 * hot zone is evaluated every scan regardless).
 *
 * 2026-09-10: 60 → 90, paired with the maxQualifyMcap ceiling prune. The
 * 9/10 audit showed the signal ordering let pump-and-dump corpses (NVDA/
 * HOOD/LAPTOP — liquidity $0, peaks in the millions) permanently occupy
 * the band LIMITs; capping the pool at 2× the mcap ceiling removes them,
 * so the same tick budget now evaluates live coins. The freed budget buys
 * back the slice: 90/tick ≈ 1 extra batch (+0.7–1s), validated stepwise
 * (green ticks → 120 next).
 *
 * 2026-09-10 (later): 120 → 180, paired with pipelined batch fetching in
 * DexScreenerClient (2 concurrent batch workers over the shared throttle —
 * each batch's network latency now overlaps the next batch's 350ms spacing
 * instead of stacking behind it; dispatch rate unchanged, so 429 exposure
 * is identical). Sequential fetching was the binding constraint, not the
 * budget: 6 batches (180 coins) cost ~2.7s pipelined vs ~4.6s sequential.
 * Full sweep at the ~730-row pool: ~6 ticks (~6 min). Same rollback rule:
 * budget rows re-appearing in scan-history → drop one step.
 *
 * 2026-09-10 (validated): 180 → 300. Two live /health ticks post-deploy
 * measured total scan cost ~6s (feedsMs 3.7s + evalMs 2.1–2.4s) against the
 * 20s tick budget / 12s target with zero budget trips — the pipelined
 * batches left ~6s of headroom, which buys back the requested ~300/tick
 * sweep volume (10 DexScreener batches ≈ ~4.5s pipelined). Full sweep at
 * the ~710–755-row pool: ~3 ticks. Watch scan-history for budget rows as
 * before; the pool's dominant rejection is now the liquidity gate
 * (dead-liquidity corpses, see the REJECT_LOG trace), so extra slice depth
 * mostly raises the chance a live coin is inside the evaluated window.
 *
 * 2026-09-10 (post-mortem): the zero-push stretch since 09-06 was NOT slice
 * starvation — live /health showed ~215 of ~330 evaluated coins/tick failing
 * the liquidity gate (LAPTOP/NEMOTRON/Ggwiz/ZenoCoin: mcap $100K–$500K over
 * $0–$15 LP). These corpses survive the mcap floor/ceiling prunes (their
 * peak mcap is inside/below the band) and their huge max_mcap_observed
 * ranks them FIRST in every rotation band under the signal ordering, so the
 * 300-coin slice re-checked the same dead tape every sweep. Fix: track peak
 * liquidity per coin (max_liquidity_observed) and prune pool coins whose
 * peak liquidity never reached 0.6× the widest chat's liquidity floor —
 * the same pre-qualification semantics as the mcap prunes.
 *
 * 2026-09-11: 300 → 180 (the documented rollback rule: budget rows
 * re-appearing in scan-history → drop one step). Live evidence: 5 of the
 * last 12 ticks tripped the 12s budget (12.1–12.8s) plus 2 dead ticks,
 * while GeckoTerminal and GMGN re-entered 429 backoff — their per-feed
 * backoff retries stretch feedsMs back toward the 5.5s cap, so the
 * 10-batch (300-coin) eval phase no longer fits behind it. 180/tick ≈ 4
 * pipelined batches (−1.5–2s evalMs) converts the marginal ticks back into
 * completions; at the current ~285-row pool the full sweep still finishes
 * in ~2 ticks. Raise back one step only after a full day of zero budget
 * rows with the geo feeds healthy again.
 *
 * 2026-09-11 (later): 180 → 120. The 180 deploy (09:47Z) did NOT clear the
 * budget rows: 14:00–15:06Z history shows the bimodal pattern unchanged
 * (~85% of ticks at 12.1–12.9s, OK ticks 8–9.4s) — including ticks over a
 * tiny 94-coin pool, proving slice size alone wasn't the binding cost; the
 * 429/502-stretched feed phase (geo + GMGN backoffs, Axiom 502 outage) ate
 * the headroom the rollback assumed. One more step down buys ~1s of evalMs
 * back until the upstream feeds recover. Sweep at the ~240-row pool: ~2
 * ticks; hot zone still evaluated every scan.
 *
 * 2026-09-15: 120 → 150, sized by the PAIR PHASE, not by the pool. The 120
 * cap had become the binding constraint (ticks reported pool 323–489 with
 * poolSliced 120 while poolMs spent only ~1.5s of its allowance, so most of
 * every returned pool was never looked at), but the phase that caps the
 * slice is the pair fetch: DexScreener batches are 30 addresses and every
 * request start is spaced by the shared throttle (DEX_REQUEST_INTERVAL_MS,
 * 350ms), so N batches cost N × spacing and 150 + the feed's ~20 coins is
 * 6 batches ≈ 2.1s — the most that fits the ~5.3s race alongside the feed,
 * pool and push-watch phases while still leaving the gate/push phase its
 * ~1s. Measured: a 300-coin slice (11 batches ≈ 3.9s) pushed the tick past
 * the race, so the abort landed BEFORE the gates and the whole fetch was
 * discarded as `agedEval 0` — the exact waste this number now avoids.
 * Raise it only together with a way to fetch more per second (smaller
 * throttle spacing, or a batch cache that is warmer than 3 min); the pair
 * cache already serves repeat coins for free, and coins left over stay in
 * the pool and are re-read on the next slot.
 *
 * 2026-09-15 (later): 150 → 160, sized to the new dispatch spacing. The
 * throttle went 350 → 250ms (DEX_REQUEST_INTERVAL_MS), which fits ~6 batches
 * inside the same 1.5s pairs cap instead of ~5; 160 slice + the feed's ~20
 * coins = 180 addresses = exactly 6 batches of 30, so every requested address
 * is now actually fetched instead of the last 20 being silently dropped past
 * the deadline. Same rule as above: this number moves only with the fetch
 * rate, and the pair cache keeps serving repeat coins for free on top.
 *
 * 2026-09-19: 130 → 90, sized by the PUSH PATH's deadline for the first time.
 * Every other entry here traded breadth for finishing the tick at all; this one
 * trades it for the CARD. The front phases (feeds ~460 + pool ~540 + pair fetch
 * ~1250, then the gates over ~150 coins) were ending at 3.2-3.4s, and the
 * candidate chain then needs ~250-600ms before it can take the claim — whose
 * gate closes at 3550ms (see cardClaimDeadline / CARD_CLAIM_BUDGET_MS). Live
 * over the two hours before this change: 45 of the last 111 ticks found a
 * candidate and EVERY one of them failed to push (`cand>0 & pushed=0` = 45/45,
 * cardSendDeferredTotal climbing ~20/hour), while the held-back counter stayed
 * low — the chain was reaching the claim and arriving late. The slice and the
 * pair budget are the two knobs that buy that time back, and they are one
 * number in practice: 90 + the feed's ~24 = 114 addresses = 4 batches of 30 at
 * the 250ms spacing, i.e. the pair fetch now finishes in ~1s instead of riding
 * its 1250ms cap, and the gates run over ~40 fewer coins. Cost: the pool sweep
 * stretches by ~1.4× (it is bounded by the rotation bands, not by this number —
 * the hot zone is still evaluated every scan and a deferred coin still rides
 * the feed). Raise it back only with a way to fetch more per second, and only
 * after the delivery rate is healthy again.
 */
const RE_EVAL_PER_TICK_MAX = 90;

/**
 * Pure rotation-slice over the pool-only token list (exported for offline
 * unit tests). Returns the ≤ maxPerTick window starting at `cursor` plus the
 * next cursor; pools at or below maxPerTick are taken whole with the cursor
 * reset. A full window that would run past the end takes only the remaining
 * tail and resets the cursor — the next tick starts a fresh sweep from the
 * top instead of wrapping back over items it just covered. Successive calls
 * with the returned cursor cover every item exactly once per sweep — no
 * gaps, no duplicates.
 */
export function slicePoolRotation<T>(
  items: T[],
  cursor: number,
  maxPerTick: number,
): { slice: T[]; nextCursor: number } {
  // A deferred initial card is a make-up obligation. When its token is still
  // present in the normal pool, move it ahead of the rotating window so a
  // busy pool cannot make it wait for another sweep. The stronger case — the
  // coin fell out of the query entirely, so this list never sees it — is
  // handled by the feed make-up pass (see deferredmakeup.ts), which pulls it
  // back through the one list the tick always evaluates.
  const priority = items.filter((item) => {
    const token = (item as { tokenAddress?: unknown }).tokenAddress;
    return typeof token === "string" && isDeferredToken(token);
  });
  const ordinary = items.filter((item) => !priority.includes(item));
  const ordered = priority.length > 0 ? [...priority, ...ordinary] : items;
  if (ordered.length <= maxPerTick) return { slice: ordered, nextCursor: 0 };
  const start = cursor % ordered.length;
  const end = start + maxPerTick;
  if (end <= ordered.length) {
    return { slice: ordered.slice(start, end), nextCursor: end % ordered.length };
  }
  return { slice: ordered.slice(start), nextCursor: 0 };
}

/** One qualifying coin, prepared for a specific chat. */
export interface QualifyingCoin {
  chatId: string;
  profile: TokenProfile;
  pair: PairInfo;
  stats: TokenStats;
}

/**
 * Why a single coin was rejected for one chat (surfaced via /health so the
 * operator can see exactly which filter blocked which coin). Only the coin's
 * first failing gate is recorded, and the list is bounded to keep the
 * heartbeat JSON small.
 */
export interface RejectionEntry {
  symbol: string;
  ageMin: number;
  mcapUsd: number;
  vol5Usd: number;
  chgPct: number;
  reason: string;
}

/** Rejection reasons from the last completed scan (surfaced via /health). */
export interface ScanSummary {
  profiles: number;
  /** pump.fun discovery feed size this scan (0 when blocked/unconfigured). */
  pump: number;
  /**
   * True when that pump.fun batch came from the GECKO FALLBACK slot (gecko's
   * new_pools was paused, so the launch feed filled it — see
   * pumpfunDiscoveryLimit). Distinguishes "gecko is down and pump.fun is
   * carrying the launch slot" from "pump.fun ran as its own always-on feed".
   */
  pumpFallback?: boolean;
  /**
   * Meteora Data API discovery feed size this scan (METEORA_FALLBACK_LIMIT,
   * 0 when disabled/unconfigured). This layer only ever runs as the launch
   * slot's LAST resort — gecko's new_pools AND pump.fun both delivered nothing
   * — so a non-zero count is itself the proof that the two layers ahead of it
   * failed (see src/meteora.ts).
   */
  meteora: number;
  /** GeckoTerminal new-pools feed size this scan (0 when blocked/unconfigured). */
  geo: number;
  /** GeckoTerminal trending-pools feed size this scan (momentum, 0 when disabled). */
  geoTrend: number;
  /** Jupiter recent-launchpad feed size this scan (0 when disabled/blocked). */
  jup: number;
  /** Jupiter trending feed size this scan (0 when disabled/blocked). */
  jupTrend: number;
  /** GMGN trending feed size this scan (0 when disabled/blocked). */
  gmgn: number;
  /** Axiom Trade trending feed size this scan (0 when disabled/not logged in). */
  axiom: number;
  /** Arkham smart-money enrichments this scan (0 when no key configured). */
  arkham: number;
  /** Jupiter organic-score card enrichments this scan (0 = the 🌱 有機度 line
   * had no data). Counted so a line that vanishes from the card is visible in
   * /health instead of only being noticed on the card itself. */
  organic: number;
  /** Coins whose creator/top-holder wallets matched the crime-wallet list. */
  crime: number;
  /** Coins that got a wallet analysis (creator/holder/cluster enrichment). */
  walletAnalysis: number;
  /** Birdeye periodic backfill: coins seeded into the re-eval pool this run. */
  backfill: number;
  pool: number;
  /** Wall-clock ms spent in the discovery-feed phase (profiles → backfill). */
  feedsMs?: number;
  /**
   * Wall-clock ms from tick start to the start of the feed fan-out. The
   * profiles call only dispatches while the tick's 900ms feed window
   * (FEED_DEADLINE_MS) still has its floor left, so this is the number that
   * decides whether the tick discovers anything: measured live 2026-09-21,
   * the `profiles 0` ticks are exactly the ones where the pre-feed steps (the
   * enabled-chats read plus the cold isolate's crime-wallet load) had already
   * spent past 650ms of that window.
   */
  preFeedMs?: number;
  /**
   * Whether the profiles call ANSWERED inside the feed window. False means
   * this tick evaluated the make-up fallback instead (see the profiles call
   * site) — read the two together: `settled: false` with a non-zero
   * `profiles` means that number is the deferred lane, not the feed.
   */
  profilesSettled?: boolean;
  /** Wall-clock ms spent on the post-push tracker pass. */
  trackerMs?: number;
  /** Wall-clock ms for the re-eval pool query + rotation slice. */
  poolMs?: number;
  /** Wall-clock ms for matching + candidate gate evaluation. */
  evalMs?: number;
  /**
   * Per-DB-method timing the tick probe measured this isolate (calls + total
   * ms; see tickprobe.ts). `getTokenStatsMany` is the registration read, which
   * sits between the pair fetch and the gates; the two writes are the tick's
   * post-gate persistence. Cumulative, so the averages are readable live.
   */
  dbSteps?: Record<string, { calls: number; ms: number }>;
  /**
   * The write batch the tick probe kept OFF the scan's critical path: how many
   * calls waited, how long the worker's drain took, and the failures it saw
   * (see tickprobe.ts). The scanner's own writes are no longer awaited inside
   * the tick, so this is where their cost and their health are visible.
   */
  writeDrain?: {
    calls: number;
    ms: number;
    at: number;
    failures: number;
    totals: { calls: number; ms: number; failures: number };
  } | null;
  /**
   * Wall-clock ms the scan spent in tick-scoped Turso round trips (see
   * Db.enterScanMode / SCAN_DB_TIMEOUT_MS). The ladder's biggest UN-RACED
   * cost: the eval region only has ~3.3s of the 4.2s deadline, so this is
   * the number to read when a tick dies at the race window with candidates
   * it never pushed (2026-09-17 08:38:30Z shape).
   */
  dbMs?: number;
  /**
   * Which tick-critical DB step degraded this tick (`stats-read`), or
   * undefined when all of them answered. Present so a fast-failing round
   * trip is visible in /health instead of only in the console.
   */
  dbDegraded?: string;
  /** Pool coins actually evaluated this tick (rotation slice of `pool`,
   * see RE_EVAL_PER_TICK_MAX). Undefined on pre-fix summaries. */
  poolSliced?: number;
  /** Evaluations that passed the age gate (age ≥ min) this scan — proves
   * in-window coins are actually being evaluated, not silently skipped. */
  agedEval: number;
  candidates: number;
  pushed: number;
  /** Post-push tracker pass result: "ok:<checked>/<alerted>" or "err:<msg>". */
  pushWatch?: string;
  /**
   * WHICH step of the candidate chain the tick was inside when its summary
   * was published (see Scanner.markPhase). The chain is the tick's longest
   * serial section — eleven awaited steps, each a live upstream call — and
   * it is what the worker's race actually cuts, but a cut tick used to flush
   * `candidates 1, pushed 0` and nothing else, so the step that ate the
   * budget was invisible (2026-09-18: two candidate ticks raced out at 4.79s
   * and 5.0s with evalMs never written). Values: seen | flow | rugcheck |
   * enrich-dispatch | crime | axiom | enrich-await | wallets | flurry |
   * render | send:claim | send:telegram | send:track | send:autobuy |
   * tracker | done | deferred.
   */
  pushPhase?: string;
  /** Tick-relative ms when pushPhase was STAMPED (i.e. the step started). */
  pushPhaseMs?: number;
  /**
   * Initial cards this tick REFUSED to start because no send slice was left
   * before the race window (see cardSendDeadline). The coin is untouched —
   * no claim, no delivery audit, no failure record — and the re-eval pool
   * re-pushes it on the next tick, so a deferral is a one-minute delay,
   * never a loss. Present so a late tick's "candidates 1, pushed 0" can be
   * told apart from a real gate rejection.
   */
  cardSendDeferred?: number;
  /**
   * Cumulative deferrals since the isolate started (the same shape the
   * worker's dex429Total uses). `cardSendDeferred` above only survives in
   * /health until the next tick publishes its own summary, so a deferral
   * could never be counted across ticks nor correlated with the push that
   * eventually paid it back. See DeferredPushLedger.
   */
  cardSendDeferredTotal?: number;
  /**
   * Deferred cards the re-eval pool has since pushed: when this rises, "a
   * deferred coin really is pushed back on a later tick" is proven live
   * rather than only argued from the code path.
   */
  deferRecovered?: number;
  /** Coins still waiting for that make-up push (deferred and never pushed). */
  deferPending?: number;
  /**
   * Cumulative tracker cards a pass could not deliver (PushWatcher's
   * `undelivered`): the per-pass note only reports the pass it happened in,
   * so the fleet-wide rate was invisible across ticks.
   */
  pushWatchUndeliveredTotal?: number;
  /** Of those, the ones a later pass re-announced — the tracker's at-least-once proof. */
  pushWatchRecovered?: number;
  /** Pool+feed coins with live DexScreener pair data this scan (vs pool count). */
  pairs?: number;
  fails: {
    mcap: number;
    chg: number;
    age: number;
    /** Supply-flow (rug/distribution) pattern detected on-chain. */
    flow: number;
    /** Creator / top-holder wallet matched the crime-wallet blocklist. */
    crime: number;
    /** Deploy-slot bundle detected (Flurry forensics, last gate). */
    flurry: number;
    other: number;
  };
  /** Flurry forensics verdicts produced this scan (0 when disabled). */
  flurryAnalyzed: number;
  /** Flurry Helius RPC calls made (cumulative across scans — spend watch). */
  flurryRpcCalls: number;
  /** Flurry cache hits (verdicts reused without RPC). */
  flurryCacheHits: number;
  /**
   * DexScreener rate-limit telemetry (DexScreenerClient.getStats), the
   * monitor for the DEX_REQUEST_INTERVAL_MS dispatch spacing: `intervalMs`
   * is the live spacing, `http429` the 429 responses this isolate's client
   * has seen since boot (retry attempts included — a batch retries 3×), and
   * `blockedForMs` the cache-only backoff still to run (>0 = the shared
   * egress IP is limiting the endpoint right now, so every tick is serving
   * pair-cache hits only), and `cacheSize` how many fresh pair rows are
   * served for free instead of refetched. Carried
   * on the summary because that is what reaches Turso with the heartbeat —
   * so the numbers are readable from any isolate, not just the one that
   * scanned. Sampling it after a spacing change is the whole 429 check.
   */
  dex?: {
    intervalMs: number;
    http429: number;
    last429At: number | null;
    blockedForMs: number;
    cacheSize: number;
  };
  /** Per-coin rejection trace for the last scan (bounded). */
  rejects: RejectionEntry[];
}

/**
 * Cap on per-coin rejection entries kept in the scan summary/heartbeat. It is
 * purely a LOG budget: every coin counted here was already rejected by a gate
 * above, so this changes what /health can explain, never what the scan
 * evaluates — the feed/pool split at the call site only decides WHICH
 * rejections occupy the slots.
 *
 * 2026-09-20: 50 → 20. Measured: 50 entries serialize to 5.0KB, 40% of the
 * 12.4KB completion batch the tick writes twice (claim + flush). The flush has
 * a fixed ~4.5s window inside a tick the cron invocation kills at ~9.6s, so
 * BYTES are the one thing still buyable there, and 20 entries keep the
 * dominant reasons visible (the feed's sub-$10K dust + the pool's gate
 * failures) at ~2KB.
 */
const REJECT_LOG_MAX = 20;

/**
 * Market-cap-to-liquidity sanity gate (Nudaeng lesson, 2026-08-22: pushed at
 * $297K mcap over just $16K of LP — an 18x valuation/depth ratio; the price
 * runs on a sliver of liquidity, so it is trivially wickable and positions
 * are nearly un-exitable). Returns a reject reason when mcap exceeds
 * liquidity × ratioMax, else null. ratioMax <= 0 disables the gate; zero or
 * missing liquidity never reaches here (the min-liquidity floor rejects it
 * first).
 *
 * Calibrated on push history (mcap@push ÷ LP): healthy pushes measured
 * 2.3–6.4x (BLC/MAPLE/DOTE/CONK); the failures measured 18x (Nudaeng) and
 * 27.9x (BAOJIN — which then rugged to $2K LP). Default 10 splits the
 * clusters with headroom on both sides.
 */
/**
 * Deploy-slot bundle gate (Flurry forensics, ported from
 * github.com/NerdHerderDani/flurry): a coin is rejected when N distinct
 * wallets acquired >= minSupplyPct of the supply in the exact slot the
 * token was created — the classic Jito-bundle / same-block-spam shape.
 * Fail-open: a null report (non-pump mint, RPC error, budget exceeded)
 * never judges.
 */
export function flurryBlockReason(report: FlurryReport | null): string | null {
  if (!report?.bundled) return null;
  const lineage =
    report.linkedWallets > 0
      ? `, ${report.linkedWallets}個錢包同資金來源`
      : "";
  return `Launch 捆綁: ${report.deploySlotWallets}個錢包在創建同一slot買入 ${report.deploySlotSupplyPct}%供應${lineage}（Jito bundle 特徵）`;
}

export function mcapRatioBlockReason(
  marketCap: number,
  liquidityUsd: number,
  ratioMax: number,
): string | null {
  if (!(ratioMax > 0)) return null;
  if (!(marketCap > 0) || !(liquidityUsd > 0)) return null;
  const ratio = marketCap / liquidityUsd;
  return ratio > ratioMax
    ? `市值/LP 比率 ${ratio.toFixed(1)}x > ${ratioMax}x（估值遠超池深：價格可操縱、難以出場）`
    : null;
}
/**
 * The liquidity reading a USD-level rule HERE may judge, or null when the pair
 * did not come from the leg those rules are calibrated on.
 *
 * `liquidity.usd` is DexScreener's POOL reserve, but a pair answered by the
 * Jupiter or GeckoTerminal leg carries a different metric of the same pool —
 * roughly half for Jupiter (measured 2026-09-20: 10 of 14 tracked rows matched
 * Jupiter's own number to within 2% while sitting at 0.46–0.58x DexScreener's;
 * see docs/liquidity-provenance.md). The push gate's floor and the mcap/LP
 * ratio below are ABSOLUTE USD rules, so judging them with another leg's
 * number makes this gate about twice as strict on that leg's tick and holds a
 * healthy coin out of its age window.
 *
 * null = UNJUDGED, not $0: the same fail-open discipline every other gate
 * uses for missing data. The coin keeps its place in the re-eval pool and the
 * next DexScreener-served tick judges it normally, so the cost is a delayed
 * push, never a wrong one. A COMPARABLE leg with no reading still counts as
 * $0 depth — a drained pool reports 0 and must keep failing the floor.
 */
export function gateLiquidityUsd(pair: {
  liquidity: { usd: number | null };
  feedSource?: "dexscreener" | "jupiter" | "gecko";
}): number | null {
  if (!liquidityIsComparable(pair)) return null;
  return pair.liquidity.usd ?? 0;
}

/**
 * Insider self-pump detector: when nearly all profiled top holders are
 * brand-new wallets (first on-chain activity younger than the analyzer's
 * new-wallet threshold), the float is concentrated in one syndicate that
 * will distribute onto followers. Needs enough wallets profiled for a
 * verdict; ratioMax 0 disables.
 */
export function newWalletBlockReason(
  checked: number,
  newWallets: number,
  ratioMax: number,
  minChecked: number,
): string | null {
  if (!(ratioMax > 0)) return null;
  if (checked < minChecked) return null;
  const ratio = newWallets / checked;
  return ratio > ratioMax
    ? `新錢包集中 ${newWallets}/${checked} > ${Math.round(ratioMax * 100)}%（top holders 幾乎全是新錢包：關聯盤自拉形態）`
    : null;
}

/**
 * Top-10 holder concentration gate (LP-excluded, RugCheck). Two-sided:
 * below pctMin (the MCGA shape — 2.2%) there is no committed holder base
 * and price is pure churn; above pctMax the supply is cartel-locked and
 * retail only provides exit liquidity. null top10 (data missing) never
 * judges; pctMin/pctMax 0 disables that side.
 */
export function top10MinBlockReason(
  top10Pct: number | null,
  pctMin: number,
  pctMax = 0,
): string | null {
  if (top10Pct === null || !Number.isFinite(top10Pct)) return null;
  if (pctMin > 0 && top10Pct < pctMin) {
    return `Top10 持倉僅 ${top10Pct.toFixed(1)}% < ${pctMin}%（籌碼過度分散：無堅定持倉基礎，純粹擊鼓傳花）`;
  }
  if (pctMax > 0 && top10Pct > pctMax) {
    return `Top10 持倉高達 ${top10Pct.toFixed(1)}% > ${pctMax}%（籌碼過度集中：供應鎖死在少數錢包，散戶只當出貨對象）`;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Axiom bot-users gate: coins traded by fewer than `min` distinct Axiom bot
 * users are dead/shill pools with no real trader interest (calibrated on
 * live samples — every coin the operator liked had 140+; junk sat below 90).
 * null (endpoint failure, session down, or no pair address) never judges;
 * min 0 disables. One API call per final candidate only.
 */
export function botUsersBlockReason(
  numBotUsers: number | null,
  min: number,
): string | null {
  if (!(min > 0)) return null;
  if (numBotUsers === null || !Number.isFinite(numBotUsers)) return null;
  return numBotUsers < min
    ? `Axiom bot用戶僅 ${Math.round(numBotUsers)} < ${Math.round(min)}（真實交易者太少：殭屍盤/自拉盤）`
    : null;
}

/**
 * Normalized description of a Telegram push failure (grammY ApiError or
 * network error) — code + description for the logs and worker_state, plus
 * whether a same-tick retry is worth it. Transient = 429 (rate limit),
 * 5xx, or a non-HTTP network error (no error_code); permanent 4xx (e.g.
 * 403 bot not a member / 400 bad chat) won't fix themselves within a
 * second, so those are surfaced but not retried in-tick — the chat-aware
 * re-eval pool still re-attempts them on later scans.
 */
interface PushErrorInfo {
  code: number | null;
  description: string;
  transient: boolean;
  line: string;
}

function describePushError(err: unknown): PushErrorInfo {
  const e = err as {
    error_code?: number;
    description?: string;
    message?: string;
  } | null;
  const code = typeof e?.error_code === "number" ? e.error_code : null;
  const description =
    e?.description ?? e?.message ?? (typeof err === "string" ? err : String(err));
  const transient = code === null || code === 429 || code >= 500;
  return {
    code,
    description,
    transient,
    line: code !== null ? `Telegram ${code}: ${description}` : description,
  };
}

export class Scanner {
  /** Hydrate durable deferred-card obligations when an isolate is recycled. */
  seedDeferredTokens(tokens: string[]): void {
    for (const token of tokens.slice(-500)) {
      if (typeof token === "string" && token.length > 0) {
        this.deferredPushes.defer(token, Date.now());
      }
    }
  }

  /** Current deferred-card identities for the durable post-flush ledger. */
  deferredTokens(): string[] {
    return this.deferredPushes.pendingTokens();
  }

  private running = false;
  /** When the current scan started — lets a stale lock be broken by age. */
  private runningSince = 0;
  /**
   * Set by the worker (Scanner.abort) when the tick's race budget trips in
   * runScan. runOnce checks it at every phase boundary and returns early, so
   * a timed-out scan stops issuing new upstream/DB work the moment the
   * completion flush is about to run instead of grinding on as a zombie
   * until Cloudflare kills the isolate (burning quota and competing with
   * the flush). Reset at the start of every runOnce.
   */
  private abortRequested = false;
  /** Monotonic scan id: a timed-out scan must not clobber a newer scan's state. */
  private scanSeq = 0;
  /** Summary of the last completed scan, persisted into the heartbeat. */
  lastSummary: ScanSummary | null = null;
  /**
   * Reference to the runOnce-local diag object while a scan is in flight.
   * Lets abort() publish the partial summary the moment the tick's race
   * budget trips — runOnce only publishes diag in its finally (after it
   * settles), so before this a timed-out scan flushed summary:null and
   * every budget trip was blind: no feedsMs, no pool, no phase timings
   * (2026-09-12: the recurring 12.1–12.2s trip band carried zero
   * diagnostics). Overwritten at every runOnce start, so a stale reference
   * can never be published for the wrong scan; republishing an
   * already-published diag via a late abort() is content-idempotent.
   */
  private inflightSummary: ScanSummary | null = null;
  /**
   * Pair data THIS tick's pair phase already paid for (the DexScreener
   * batch plus its Jupiter fallback). Kept for the post-push tracker pass:
   * the tracked coins are PUSHED coins, which the re-eval pool query
   * excludes, so the tracker's own batch is a second request — and while
   * DexScreener is 429-blocked that request returns an empty map and the
   * whole pass checks zero rows (live 2026-09-18 02:18:20: `rows 0/30
   * pairs 0/6 miss 6 trips 5` in 36ms). Reusing this map costs nothing.
   */
  private lastPairs = new Map<string, PairInfo>();
  /**
   * Cross-tick bookkeeping for deferred initial cards (see
   * DeferredPushLedger): the deferral writes nothing, so this is the only
   * place that can say whether the deferred coin ever came back.
   */
  private readonly deferredPushes = new DeferredPushLedger();
  /** Cumulative initial-card deferrals this isolate has refused. */
  private cardSendDeferredTotal = 0;
  /** Cumulative tracker cards this isolate failed to deliver (from PushWatcher). */
  private pushWatchUndeliveredTotal = 0;
  /**
   * The last tracker pass's note (see runTrackerPass), carried into the NEXT
   * scan's summary: each scan builds a fresh summary object, and the pass runs
   * after the flush, so mutating the finished one published nothing (the live
   * symptom: a pass clearly ran — the row writes followed — while /health kept
   * showing an empty pushWatch).
   */
  private pushWatchNote: string | null = null;
  /** Cards the last pass recovered (its own counter, see runTrackerPass). */
  private pushWatchRecovered = 0;
  /**
   * Why the last runOnce returned without a summary (early-return reason),
   * surfaced via /health so a silently-skipping scanner is diagnosable
   * without Cloudflare log access: "previous-scan-still-running",
   * "no-chats-enabled", "empty-feed-and-pool", or null after a real scan.
   */
  lastSkip: string | null = null;
  /** When each token's RugCheck report was last fetched (in-memory TTL). */
  private readonly rugcheckFetchedAt = new Map<string, number>();
  /** Creator wallet learned from RugCheck reports (static per token). */
  private readonly rugcheckCreator = new Map<string, string>();
  /**
   * When Helius/Birdeye last returned empty/failed for a token, so we can
   * skip re-querying it for a while (in-memory negative cache).
   */
  private readonly dataFailedAt = new Map<string, number>();
  /**
   * Whether the one-time launch_ms backfill migration is complete (see
   * Db.resumeLaunchBackfill). Cached so the per-tick resume call stops as
   * soon as the flag is set — no extra DB reads forever after.
   */
  private launchBackfillDone = false;
  /**
   * Start offset of the current tick's pool rotation slice (see
   * RE_EVAL_PER_TICK_MAX). Advances by the slice length each tick and wraps,
   * so the whole pool is covered in ⌈pool / slice⌉ ticks. Cursor > pool
   * length self-normalizes via the modulo at use.
   */
  private poolSliceCursor = 0;
  /** Post-push tracker (null when disabled or no bot/db — see pushwatch.ts). */
  private readonly pushWatcher: import("./pushwatch").PushWatcher | null;

  constructor(
    private readonly db: Db,
    private readonly bot: Bot,
    private readonly dex: DexScreenerClient,
    private readonly config: AppConfig,
    private readonly birdeye: BirdeyeClient | null,
    private readonly rugcheck: RugcheckClient | null,
    private readonly helius: HeliusClient | null,
    /** Trojan trading (null = trading disabled — no key configured). */
    private readonly trade: TradeService | null = null,
    /**
     * pump.fun discovery (null = disabled) — widens coverage beyond the
     * DexScreener profiles feed, which only lists ~24 Solana coins per scan.
     * Best-effort: failures degrade to the DexScreener-only path.
     */
    private readonly pumpfun: PumpFunClient | null = null,
    /**
     * GeckoTerminal new-pools discovery (null = disabled) — free (no key),
     * datacenter-reachable, covers every Solana DEX incl. pump.fun graduates.
     * Best-effort: failures degrade to the other feeds.
     */
    private readonly gecko: GeckoTerminalClient | null = null,
    /**
     * Jupiter Token v2 discovery (null = disabled) — free no-key feed pair:
     * recent launchpad launches (the pump.fun frontend-api replacement) and
     * 24h trending. Best-effort: failures degrade to the other feeds.
     */
    private readonly jupiter: JupTokensClient | null = null,
    /**
     * GMGN OpenAPI (null = disabled — no key). Two uses: (a) candidate
     * enrichment — smart-money count, wash-trading flag and holders fetched
     * before each push and shown on the card (wash-trading optionally
     * blocks); (b) trending discovery feed (GMGN_TRENDING_LIMIT > 0).
     * Best-effort: failures degrade to the other feeds.
     */
    private readonly gmgn: GmgnClient | null = null,
    /**
     * Axiom Trade trending (null = disabled — no credentials). Momentum
     * feed with sniper/insider/bundle/top10-holder signals in the row data.
     * Login is interactive (OTP email) so the access token is persisted in
     * worker_state by the /debug/axiom-login endpoint; the scanner only
     * refreshes it when expired. Best-effort: failures degrade to the other
     * feeds.
     */
    private readonly axiom: AxiomClient | null = null,
    /**
     * Arkham Intelligence (null = disabled — no key). Card-only enrichment:
     * top-100 holder entity attribution → smart-money count + names shown on
     * the push card. Best-effort: failures degrade to no enrichment.
     */
    private readonly arkham: ArkhamClient | null = null,
    /**
     * Crime-wallet blocklist (null = disabled). Each pushed coin's creator
     * (RugCheck) and top holder owner wallets are checked against the list;
     * a hit is flagged on the card (and optionally blocks the push — see
     * CRIME_WALLETS_BLOCK). Best-effort: an unloaded list degrades to no
     * check, never a blocked scan.
     */
    private readonly crimeWallets: CrimeWalletClient | null = null,
    /**
     * Wallet analysis (null = disabled): creator profile (age + serial-
     * launcher create count), top-holder wallet ages, and cross-coin holder
     * clustering for each pushed coin. Reuses the crime check's resolved
     * holders (no extra RPC for the holder list); each unique wallet costs
     * one cached Helius call. Best-effort with a hard budget — a slow RPC
     * truncates the card enrichment, never the push.
     */
    private readonly walletAnalyzer: WalletAnalyzer | null = null,
    /**
     * Flurry launch forensics (null = disabled): deploy-slot bundle
     * detection + one-hop funding lineage, ported from the Flurry terminal
     * (Apache-2.0). The LAST gate before a push — only coins that passed
     * every other gate are checked, so its Helius spend tracks coins about
     * to be pushed. Fail-open: non-pump mints, RPC errors and budget
     * exhaustion pass without blocking; verdicts cached per mint.
     */
    private readonly flurry: FlurryAnalyzer | null = null,
    /**
     * Meteora Data API newest-pools discovery (null = disabled) — the launch
     * slot's third and last keyless source, behind gecko's new_pools and
     * pump.fun. Best-effort: failures degrade to the feeds ahead of it.
     */
    private readonly meteora: MeteoraClient | null = null,
  ) {
    this.pushWatcher = config.pushWatch.enabled
      ? new PushWatcher(
          this.db,
          this.bot,
          this.birdeye,
          config,
          (addresses: string[], deadlineMs?: number) =>
            this.pairsForTracker(addresses, deadlineMs),
          // Trade service for the heal-resend card's buy/sell/mode buttons
          // (null = trading unconfigured → link + unwatch only).
          this.trade,
        )
      : null;
  }

  /**
   * Race ONE step of the candidate chain against the chain deadline (see
   * CANDIDATE_PUSH_RESERVE_MS). `make` is only invoked when there is time
   * left, so a step that cannot possibly finish never fires its network
   * call, and a step that starts can never hold the chain past the deadline:
   * the race resolves with `fallback` — the exact value its resolver returns
   * on an upstream failure — and the caller renders the same "未分析 / —" it
   * would have shown for missing data. The work itself is not cancelled
   * (every client owns its own timeout); a late settle/rejection is
   * discarded by the race.
   *
   * Without this the chain was serial and unclamped, which is why a tick that
   * found a candidate never pushed one (2026-09-16: `candidates: 1,
   * pushed: 0`, frozen at the worker's ~4.8s race on every such tick).
   */
  private async bestEffort<T>(
    make: (() => Promise<T>) | null,
    deadline: number,
    fallback: T,
  ): Promise<T> {
    if (!make) return fallback;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fallback;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        make(),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(fallback), remaining);
        }),
      ]);
    } catch {
      // A resolver that THREW degrades exactly like one that ran out of
      // time: the caller renders its own fallback. Swallowing it here is
      // what lets the display batch be dispatched as one Promise.all — a
      // rejection would otherwise fail every line of the card over one
      // flaky upstream, and one raised while the caller is still awaiting
      // another step would surface as an unhandled rejection.
      return fallback;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Full /token-info payload for one candidate pair (?pairAddress=) — the
   * bot-users count AND the nine other fields shown on the push card
   * summary line. Best-effort: null on any failure so the gate never
   * judges and the card falls back to the legacy lines. On an auth error,
   * does ONE cooldown-guarded refresh then retries once — same discipline
   * as the trending feed (unconditional refreshes rotate and burn the
   * session). NOTE: supersedes resolveAxiomBotUsers further below, which
   * is now dead code kept only because the file-sync layer cannot edit
   * that region of this file.
   */
  private async resolveAxiomTokenInfo(
    pairAddress: string,
  ): Promise<AxiomTokenInfo | null> {
    if (!this.axiom) return null;
    const call = (accessToken: string, refreshToken?: string) =>
      this.axiom!.fetchTokenInfo(
        accessToken,
        pairAddress,
        "/token-info-v2",
        "pairAddress",
        "",
        undefined,
        refreshToken,
      );
    const storedToken = await this.db.getWorkerState("axiom_access_token");
    if (!storedToken) return null;
    // Send both session cookies like the browser does — some Axiom endpoints
    // validate the full session, not just the access token.
    const sessionRefresh = await this.db.getWorkerState("axiom_refresh_token");
    try {
      const out = await call(storedToken, sessionRefresh ?? undefined);
      this.axiomSessionFailStreak = 0; // session alive — reset the alert latch
      return parseAxiomTokenInfo(out.data);
    } catch (err) {
      // Only a rejected session is worth a refresh; everything else
      // (network blip, 404, parse) just degrades to "no data".
      const msg = err instanceof Error ? err.message : String(err);
      if (!/auth/.test(msg)) return null;
      // Single-writer rule: Axiom rotates the refresh token on every call.
      // In external-refresher mode the GitHub Action is the ONLY writer —
      // a Worker-side refresh here would rotate underneath it and kill
      // both sessions. Just report and wait for the next Action run.
      if (this.config.axiomExternalRefresh) {
        void this.alertAxiomSessionDead();
        return null;
      }
      const now = Date.now();
      if (now - this.lastAxiomRefreshAt < AXIOM_REFRESH_COOLDOWN_MS) {
        return null;
      }
      this.lastAxiomRefreshAt = now;
      const refreshToken = await this.db.getWorkerState("axiom_refresh_token");
      if (!refreshToken) return null;
      try {
        const fresh = await this.axiom!.refreshAccessToken(refreshToken);
        if (!fresh || !fresh.accessToken) {
          void this.alertAxiomSessionDead();
          return null;
        }
        await this.db.setWorkerState("axiom_access_token", fresh.accessToken);
        if (fresh.refreshToken) {
          await this.db.setWorkerState("axiom_refresh_token", fresh.refreshToken);
        }
        const out = await call(fresh.accessToken, fresh.refreshToken ?? refreshToken);
        this.axiomSessionFailStreak = 0;
        return parseAxiomTokenInfo(out.data);
      } catch {
        void this.alertAxiomSessionDead();
        return null;
      }
    }
  }

  /** Consecutive auth+refresh failures — drives the one-shot admin alert. */
  private axiomSessionFailStreak = 0;
  private axiomSessionAlertAt = 0;

  /**
   * When the refresh host-cycling still can't renew the session, the bot
   * degrades to legacy cards silently — the operator would only notice
   * days later. Ping the first admin once per AXIOM_SESSION_ALERT_GAP
   * instead so re-pasting tokens via /debug/axiom-tokens happens same-day.
   */
  private async alertAxiomSessionDead(): Promise<void> {
    this.axiomSessionFailStreak++;
    if (this.axiomSessionFailStreak < 3) return;
    const now = Date.now();
    if (now - this.axiomSessionAlertAt < AXIOM_SESSION_ALERT_GAP_MS) return;
    this.axiomSessionAlertAt = now;
    const admin = this.config.adminIds[0];
    if (!admin || !this.bot) return;
    try {
      await this.bot.api.sendMessage(
        String(admin),
        `⚠️ Axiom session 已死（refresh 被擋）— 推送照常但卡片用緊舊格式、bot-users 閘門暫停。\n修復：瀏覽器登入 axiom.trade → 複製 auth-access-token + auth-refresh-token cookies → 開 /debug/axiom-tokens?access=...&refresh=...`,
      );
    } catch {
      /* best-effort */
    }
  }

  /**
   * TTL-cached trending fetch — the discovery loop calls this every scan
   * tick, but upstream only sees a request at most once per 3 minutes.
   */
  private async fetchTrendingCached(): Promise<AxiomTrendingToken[]> {
    if (axiomTrendCache && Date.now() - axiomTrendCache.at < AXIOM_TREND_CACHE_TTL_MS) {
      return axiomTrendCache.items;
    }
    const items = await this.fetchAxiomTrending();
    if (items.length > 0) {
      axiomTrendCache = { at: Date.now(), items };
    }
    return items;
  }

  /** True while an on-chain/Birdeye retry for this token should be skipped. */
  private dataNegativeCached(token: string): boolean {
    const at = this.dataFailedAt.get(token);
    if (at === undefined) return false;
    if (Date.now() - at < DATA_NEGATIVE_CACHE_MS) return true;
    this.dataFailedAt.delete(token); // prune stale entries
    return false;
  }

  /**
   * Persist a per-chat push failure (worker_state `push_fail_<chatId>`,
   * JSON) so the operator can see exactly why a chat missed pushes without
   * Cloudflare log access — surfaced by /debug/chats. Keeps only the latest
   * failure plus a running count.
   */
  private async recordPushFailure(
    chatId: string,
    token: string,
    info: PushErrorInfo,
  ): Promise<void> {
    try {
      const key = `push_fail_${chatId}`;
      const raw = await this.db.getWorkerState(key);
      let count = 0;
      if (raw) {
        try {
          count = (JSON.parse(raw) as { count?: number }).count ?? 0;
        } catch {
          // corrupt state — start fresh
        }
      }
      await this.db.setWorkerState(
        key,
        JSON.stringify({
          at: Date.now(),
          code: info.code,
          description: info.description.slice(0, 200),
          token: token.slice(0, 12),
          count: count + 1,
        }),
      );
    } catch (err) {
      console.error(
        "[scanner] push-failure record failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Stamp the candidate-chain progress marker (see ScanSummary.pushPhase).
   * diag IS the live inflightSummary object, so whatever step is stamped is
   * exactly what a race-out tick's flushed row reports — the tick's abort()
   * republishes this same object.
   */
  private markPhase(diag: ScanSummary, name: string, startedAt: number): void {
    diag.pushPhase = name;
    diag.pushPhaseMs = Date.now() - startedAt;
  }

  /**
   * ONE post-push tracker pass, run from the WORKER's tick tail rather than
   * inside the scan (see worker.TRACKER_PASS_BUDGET_MS for why it moved).
   *
   * The pass advances the tracked-coin rotation least-recently-checked first,
   * so calling it once per tick with a real allowance is the whole fix for a
   * sweep that took hours: the scan's own leftover was 400-1200ms (one or two
   * rows), while the tick leaves ~4s of its 9.5s budget unused once the
   * completion flush has landed.
   *
   * Best-effort by construction: every stage inside the pass is bounded, the
   * caller only has to bound the wall clock, and the note is published on the
   * LAST summary — /health shows it on the next heartbeat, the same one-tick
   * carry the deferral counters already use.
   *
   * `keepAlive` is the worker's tick-level waitUntil hand-off, passed straight
   * through to the pass so a CUT card's delivery proof — an un-awaited promise
   * created at the pass's tail — is held rather than cancelled with the handler
   * (see pushwatch.holdForTick).
   */
  async runTrackerPass(
    deadlineMs: number,
    keepAlive?: (promise: Promise<unknown>) => void,
  ): Promise<string | null> {
    if (!this.pushWatcher) return null;
    const startedAt = Date.now();
    // Stamp the row RUNNING before the pass's first stage (see
    // persistPassStart). The coverage line below is the pass's LAST write, so a
    // pass that never returns would otherwise leave /health.pushWatchPass
    // frozen while the row writes it DID make kept landing.
    await this.persistPassStart();
    try {
      const pw = await this.pushWatcher.runTick(deadlineMs, keepAlive);
      const note = `ok:${pw.checked}/${pw.alerted}${pw.note ? ` ${pw.note}` : ""}`;
      this.pushWatchNote = note;
      this.pushWatchRecovered = Number(pw.recoveredUndelivered ?? 0);
      // Cumulative tracker telemetry (the pass note itself only reports the
      // pass it happened in — /health shows the latest summary, so a loss
      // vanished with the next tick).
      this.pushWatchUndeliveredTotal = Number(
        pw.undeliveredTotal ?? this.pushWatchUndeliveredTotal,
      );
      if (this.lastSummary) {
        this.lastSummary.pushWatch = note;
        this.lastSummary.pushWatchUndeliveredTotal =
          this.pushWatchUndeliveredTotal;
        this.lastSummary.pushWatchRecovered = Number(
          pw.recoveredUndelivered ?? 0,
        );
        this.lastSummary.trackerMs = Date.now() - startedAt;
      }
      await this.persistPassNote(note, startedAt);
      return note;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[scanner] push-watch tick failed:", msg);
      if (this.lastSummary) {
        this.lastSummary.pushWatch = `err:${msg.slice(0, 140)}`;
      }
      // Persisted like the success path, because "the note stopped moving" is
      // exactly the signal this row exists to carry: a pass that threw leaves
      // no stage split and no rows, and from /health alone that is
      // indistinguishable from a tick that never reached the pass at all
      // (2026-09-21 04:03-04:05Z: fast ticks, no note, no way to tell the two
      // apart without the Cloudflare log the operator cannot read).
      await this.persistPassNote(`err:${msg.slice(0, 140)}`, startedAt);
      return null;
    }
  }

  /**
   * The tracker pass's coverage line, in ONE worker_state row — the durable
   * copy the in-memory carries above cannot give. The in-memory path only
   * reaches /health when the next tick's flush happens to run on THIS isolate,
   * and on 2026-09-21 that was the exception, not the rule: four consecutive
   * /health polls showed no note at all while the pass was demonstrably
   * running, so the stage split that explained the whole rotation stall was
   * unreadable exactly when it mattered (/health.pushWatchPass,
   * /debug/scan-history.pushWatchPass). Awaited and best-effort, never raced:
   * see persistPassNote.
   */
  private async persistPassNote(
    note: string,
    startedAt: number,
    /**
     * "done" = a completed pass; "skip" = a tick that never got one (see
     * noteTrackerSkipped). Written to the row so a reader can tell a pass in
     * flight from a pass that is stuck (see persistPassStart).
     */
    phase: "done" | "skip" = "done",
  ): Promise<void> {
    // AWAITED, not raced. The race this replaces resolved at its bound while the
    // write was still in flight, and an abandoned promise is CANCELLED the
    // moment the invocation ends — so on a slow-Turso stretch every pass lost
    // its note while the pass itself kept checking rows (live 2026-09-22
    // 18:09-18:28Z: rows kept moving, `at` froze for 19 minutes, and `dup-skip`
    // was unverifiable exactly when it mattered). Awaiting is what keeps the
    // invocation open for the write, and the Db call already runs under
    // wrapClientWithHardWall, so this cannot hang the tick — the same contract
    // the deferral-counter sync at the tick's tail relies on.
    try {
      await this.db.setWorkerState(
        "push_watch_pass",
        JSON.stringify({
          at: Date.now(),
          note,
          trackerMs: phase === "done" ? Date.now() - startedAt : 0,
          phase,
        }),
      );
    } catch {
      /* telemetry only */
    }
  }

  /**
   * Stamp the pass RUNNING before its first stage runs.
   *
   * WHY (2026-09-23, measured live): the coverage line is the pass's LAST
   * write, so a pass that does not return left the durable row frozen — and a
   * pass can fail to return without failing to WORK. The row loop checks the
   * budget only BETWEEN rows, and ONE row's chain (pair lookup, claim, alert
   * reservation, send, delivery audit, final check write) is up to five Turso
   * round trips, each walled at 3s outside scan mode. Live shape: the row
   * `SRI` carried `lastChecked 02:45:13Z` (its own writes landed) while
   * `push_watch_pass.at` sat at 02:36:26Z for 11+ minutes — rows moving, note
   * frozen, which is exactly the shape docs/duplicate-cards.md 8.3 told the
   * operator to read around instead of trusting the note.
   *
   * With this stamp the row moves whenever a pass STARTS: `phase:"running"`
   * with a fresh `at` is a pass in flight, a stale `running` is a pass stuck
   * inside one row, and `phase:"skip"` is a tick that never got a pass (see
   * noteTrackerSkipped). A frozen `at` now means the invocation died before
   * the tick's tail at all, which the heartbeat and scan_history already show.
   *
   * Best-effort and awaited exactly like the coverage write below.
   */
  private async persistPassStart(): Promise<void> {
    try {
      await this.db.setWorkerState(
        "push_watch_pass",
        JSON.stringify({
          at: Date.now(),
          note: "running",
          trackerMs: 0,
          phase: "running",
        }),
      );
    } catch {
      /* telemetry only */
    }
  }

  /**
   * Public: publish the tick's tracker status for a tick that had NO budget
   * for a pass (see worker.ts — a cut tick spends its whole envelope before
   * the pass, so the pass never starts).
   *
   * Without this the row simply stopped moving on those ticks (live
   * 2026-09-23 02:37-02:41Z: five consecutive cut ticks of 11500ms each, note
   * frozen at 02:36:26Z, indistinguishable from a lost write). A skipped tick
   * is a real reading, so it is published as one.
   */
  async noteTrackerSkipped(reason: string): Promise<void> {
    await this.persistPassNote(`skip:${reason}`, Date.now(), "skip");
  }

  /**
   * Pair lookup for the post-push tracker pass (see lastPairs): serve what
   * this tick already fetched, ask DexScreener for the rest, then fall back
   * to Jupiter exactly like the front pair phase does — the same rescue for
   * the same 429 episode, which otherwise leaves the pass with no pair data
   * at all and zero rows evaluated.
   *
   * The Jupiter leg is raced against the CALLER's deadline (the tracker's
   * own pair budget), so a slow fallback can never become the unbounded
   * await this pass was rebuilt to eliminate.
   */
  private async pairsForTracker(
    addresses: string[],
    deadlineMs?: number,
  ): Promise<Map<string, PairInfo>> {
    const out = new Map<string, PairInfo>();
    const missing: string[] = [];
    for (const a of addresses) {
      const hit = this.lastPairs.get(a);
      if (hit) out.set(a, hit);
      else missing.push(a);
    }
    if (missing.length === 0) return out;
    try {
      for (const [k, v] of await this.dex.fetchPairsForTokens(missing, deadlineMs)) {
        out.set(k, v);
      }
    } catch {
      /* transient — the Jupiter fallback below may still answer */
    }
    const still = missing.filter((a) => !out.has(a));
    if (still.length > 0 && this.jupiter && typeof deadlineMs === "number") {
      const jup = await this.bestEffort(
        () => this.jupiter!.fetchTokenDataBatch(still),
        deadlineMs,
        new Map<string, PairInfo>(),
      );
      for (const [k, v] of jup) out.set(k, v);
    }
    // THIRD source: GeckoTerminal's per-token snapshot (free, keyless).
    // Reached only when DexScreener AND Jupiter both came back empty for a
    // token — the shape of a DexScreener 429 episode on a pushed memecoin
    // Jupiter does not index, which left the pass evaluating zero rows for
    // the whole backoff window (live 2026-09-18: `rows 0/30 pairs 0/6 miss 1`
    // while the front phase resolved 130/130 through its own fallback).
    //
    // GeckoTerminal reports FDV and summed reserve — the market cap and
    // liquidity every follow-up rule is built on. The intraday fields
    // DexScreener carries (5m volume/change, 1h buy/sell counts) are NOT in
    // this payload, so they are left at zero: the rules that need them
    // (🔥 ignition, 🩸 sell-pressure) then stay quiet on a Gecko-sourced
    // tick instead of judging off fabricated numbers. One caveat is
    // deliberate: the check writes `last_vol_5m` back from the pair, so such
    // a tick lowers that row's ignition baseline — the next DexScreener
    // check can then fire 🔥 one window earlier. That is a card the coin has
    // earned anyway (its 5m volume is genuinely above the threshold).
    //
    // Bounded like the other two legs: at most TRACKER_GECKO_LOOKUPS tokens
    // (the client's own throttle, geckoterminalRequestIntervalMs = 1s by
    // default, can eat the whole tracker budget by itself), each raced
    // against the caller's deadline.
    const geckoMissing = missing.filter((a) => !out.has(a));
    if (
      geckoMissing.length > 0 &&
      this.gecko &&
      typeof deadlineMs === "number"
    ) {
      for (const mint of geckoMissing.slice(0, TRACKER_GECKO_LOOKUPS)) {
        const snap = await this.bestEffort(
          () => this.gecko!.fetchTokenSnapshot(mint),
          deadlineMs,
          null,
        );
        if (!snap || (snap.fdvUsd === null && snap.reserveUsd === null)) continue;
        out.set(mint, {
          chainId: "solana",
          url: "",
          pairAddress: mint,
          baseToken: { address: mint, name: "", symbol: "" },
          priceUsd: String(snap.priceUsd ?? ""),
          marketCap: snap.fdvUsd ?? 0,
          volume: { h24: 0, h1: 0, m5: 0 },
          priceChange: { m5: 0, h1: 0 },
          txns: { m5Buys: 0, m5Sells: 0, h1Buys: 0, h1Sells: 0 },
          liquidity: { usd: snap.reserveUsd },
          // GeckoTerminal reserve is a THIRD liquidity metric (it sums only
          // the pools it indexes, so it under-reports next to DexScreener too):
          // never let a DexScreener-calibrated USD level judge it.
          feedSource: "gecko",
          pairCreatedAt: 0,
        });
      }
    }
    return out;
  }

  /** Worker hook: flag the running scan to stop at its next phase boundary. */
  abort(): void {
    this.abortRequested = true;
    // Publish the in-flight diag snapshot so the tick's completion flush
    // carries phase timings (see inflightSummary). The seq guard in
    // runOnce's finally still rules: a straggler that settles late can
    // never clobber a newer scan's published summary.
    if (this.inflightSummary) this.lastSummary = this.inflightSummary;
  }

  /** True when the worker's race budget tripped; logs once and returns. */
  private shouldStopEarly(): boolean {
    if (!this.abortRequested) return false;
    console.log("[scanner] tick budget tripped — ending scan early");
    return true;
  }

  /**
   * Run one feed fetch capped by the feed deadline (see FEED_DEADLINE_MS).
   * Otherwise races the fetch against the remaining feed budget so a hanging
   * upstream call resolves empty at the deadline instead of starving the core
   * scan. The abandoned promise keeps its race handlers attached, so a late
   * settlement (or rejection) is swallowed — no unhandled-rejection crash.
   *
   * `inFlight` marks a feed whose call was ALREADY started by the caller (the
   * profiles fetch, dispatched at tick start — see FEED_DEADLINE_MS). The
   * 250ms floor below exists to stop the scanner DISPATCHING a request it can
   * no longer use; for a call that is already in flight there is nothing left
   * to save, and the floor would be actively wrong: measured 2026-09-21, the
   * cold-isolate crime-wallet load held the tick for 800ms of the 900ms
   * window, so the floor short-circuited a call that was already 800ms into
   * its own answer — the exact `profiles 0` tick this change removes. With
   * `inFlight`, only the deadline decides: a window already past resolves
   * `empty` (through the same race, so the call keeps running and its
   * bookkeeping still lands) while a window with time left is awaited.
   */
  private async fetchFeedCapped<T>(
    feed: () => Promise<T>,
    empty: T,
    feedDeadline: number,
    inFlight = false,
  ): Promise<T> {
    const remaining = feedDeadline - Date.now();
    if (!inFlight && remaining <= 250) return empty;
    return Promise.race([
      feed(),
      new Promise<T>((resolve) =>
        setTimeout(() => resolve(empty), Math.max(0, remaining)),
      ),
    ]);
  }

  /** Runs one full scan. Safe to call concurrently (overlapping runs are skipped). */
  async runOnce(): Promise<void> {
    if (this.running) {
      // A scan held longer than the budget is wedged: on Workers, the
      // watchdog timer below never fires while the isolate is frozen (it
      // freezes right after the response, before the timer queue runs), so a
      // scan that got frozen mid-await would otherwise block every later
      // tick forever. Break the lock by age so the next wake retries.
      const heldMs = Date.now() - this.runningSince;
      if (heldMs > SCAN_TIMEOUT_MS) {
        console.warn(
          `[scanner] releasing stale scan lock (held ${heldMs}ms) — retrying this tick`,
        );
        this.running = false;
      } else {
        console.log("[scanner] previous scan still running, skipping this tick");
        this.lastSkip = "previous-scan-still-running";
        return;
      }
    }
    const seq = ++this.scanSeq;
    this.running = true;
    this.runningSince = Date.now();
    this.abortRequested = false;
    const startedAt = Date.now();
    const tickDeadline = startedAt + SCAN_TICK_DEADLINE_MS;
    // The front phases (feeds + pool read + pair fetch) must ALL be done by
    // here, so the gate/push phase below always keeps its reserved slice of
    // the tick (see SCAN_GATE_RESERVE_MS). Every front-phase budget is
    // clamped to this, so no combination of them can consume the tick.
    const frontDeadline = startedAt + FRONT_PHASE_WINDOW_MS;
    const feedDeadline = Math.min(startedAt + FEED_DEADLINE_MS, frontDeadline);
    // The profiles fetch is STARTED here — at tick start, before the
    // enabled-chats read and the crime-wallet load below — and awaited where
    // its result is used (see the call site). Its window is `feedDeadline`,
    // i.e. FEED_DEADLINE_MS measured from tick start, and the point of
    // starting it early is that it is already in flight while those pre-feed
    // steps run: they used to run FIRST, and on a cold isolate they spent
    // 2.8-3.6s of the 900ms window, so `fetchFeedCapped` short-circuited and
    // this call was never even dispatched (2026-09-21, see FEED_DEADLINE_MS).
    // Both handlers are attached HERE, so every early return below — no
    // enabled chats, the stop checks — can abandon the promise without an
    // unhandled rejection, and a late settle still reaches the client's own
    // bookkeeping (noteProfileFeed) exactly as it did when the call was made
    // later in the tick.
    const profilesCall = this.dex.fetchLatestSolanaProfiles().then(
      (list) => ({ list, settled: true }),
      (err: unknown) => {
        console.error(
          "[scanner] dexscreener profile feed failed:",
          err instanceof Error ? err.message : err,
        );
        return { list: [] as TokenProfile[], settled: true };
      },
    );
    const diag: ScanSummary = {
      // Carried from the previous tick's tracker pass, which runs AFTER this
      // scan's flush (see runTrackerPass / worker.TRACKER_PASS_BUDGET_MS).
      // /health therefore reads the pass that produced the note one tick
      // behind it — the same one-tick carry the deferral counters use.
      pushWatch: this.pushWatchNote ?? undefined,
      pushWatchUndeliveredTotal: this.pushWatchUndeliveredTotal,
      pushWatchRecovered: this.pushWatchRecovered,
      profiles: 0,
      pump: 0,
      meteora: 0,
      geo: 0,
      geoTrend: 0,
      jup: 0,
      jupTrend: 0,
      gmgn: 0,
      axiom: 0,
      arkham: 0,
      organic: 0,
      crime: 0,
      walletAnalysis: 0,
      backfill: 0,
      pool: 0,
      agedEval: 0,
      candidates: 0,
      pushed: 0,
      fails: {
        mcap: 0,
        chg: 0,
        age: 0,
        flow: 0,
        crime: 0,
        flurry: 0,
        other: 0,
      },
      flurryAnalyzed: 0,
      flurryRpcCalls: 0,
      flurryCacheHits: 0,
      dex: this.dex.getStats(),
      // Per-tick deferral count plus the cumulative ledger: the per-tick
      // value is overwritten by the next tick's summary, the cumulative
      // one is what makes "how often does the tick refuse a card?"
      // answerable across ticks (and deferRecovered rising is the live
      // proof that a deferred coin really is pushed back later).
      cardSendDeferred: 0,
      cardSendDeferredTotal: this.cardSendDeferredTotal,
      deferRecovered: this.deferredPushes.recovered,
      deferPending: this.deferredPushes.pendingCount,
      rejects: [],
    };
    // abort() publishes this snapshot if the tick's race trips mid-scan
    // (see inflightSummary — timeout rows otherwise flush summary:null).
    this.inflightSummary = diag;
    // Tick-scoped DB cap (see Db.enterScanMode / SCAN_DB_TIMEOUT_MS): every
    // round trip this scan makes — front phases, candidate chain, delivery,
    // and the post-push tracker pass, which all live inside the tick — gets
    // SCAN_DB_TIMEOUT_MS instead of the 6s the flush and command handlers
    // need. The scan's own work is fully deadline-budgeted everywhere else;
    // the round trips were the last unbounded await in it, and one stalled
    // call was worth more than the whole tick (they cannot be started from
    // outside the scan: get() gates on this flag).
    this.db.enterScanMode();
    // Watchdog: if the scan outlives its budget, release the lock so the next
    // tick can retry instead of the isolate wedging in a permanent skip loop.
    const watchdog = setTimeout(() => {
      if (seq === this.scanSeq) {
        console.error(
          `[scanner] scan exceeded ${SCAN_TIMEOUT_MS}ms — releasing lock; next tick will retry`,
        );
        this.running = false;
      }
    }, SCAN_TIMEOUT_MS);
    try {
      const chats = await this.db.listEnabledChats();
      if (chats.length === 0) {
        console.log("[scanner] no chats with push enabled, skipping");
        this.lastSkip = "no-chats-enabled";
        return;
      }

      // Crime-wallet blocklist refresh (bounded by an in-memory TTL — a
      // no-op on most ticks; the first scan after a deploy fetches the
      // ~4.8K-address list once). Best-effort: a fetch failure keeps the
      // previous list and records lastError; the scan never waits more than
      // the client's fetch timeout on the very first load.
      if (this.shouldStopEarly()) return;
      if (this.crimeWallets) {
        try {
          await this.crimeWallets.refreshIfStale();
        } catch (err) {
          console.error(
            "[scanner] crime-wallet refresh failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      // DexScreener profile feed. Same best-effort guard as pump.fun and
      // GeckoTerminal below: a rate-limited/5xx feed (shared worker egress
      // IPs get 429'd regularly) must degrade the scan to the re-eval pool
      // instead of aborting it — an unguarded throw here produced ~6s
      // all-zero scans (3 attempts × 2/4s backoff) that skipped the entire
      // pool evaluation (observed 2026-08-16).
      //
      // 2026-09-12: the feeds now fan out CONCURRENTLY. The sequential
      // chain (dex → gecko ×2 → gmgn → axiom → jup ×2 → backfill) rode the
      // FEED_DEADLINE cap on every observed tick (feedsMs 3846-4394ms over
      // 15+ live samples, vs the 4500ms cap) — each feed's throttle spacing
      // (gecko 1000ms, jupiter 500ms) + latency stacked, so the phase
      // consumed its whole budget and left nothing for the eval phase even
      // when every upstream was healthy. Per-feed deadline races are kept
      // (each feed still resolves empty at the shared feedDeadline, so
      // upstream hangs cannot starve the core scan); only the ORDER is
      // changed — worst case is now max(feed) instead of sum(feed),
      // returning ~3s per tick to pool evaluation + candidates. The
      // Birdeye backfill (interval-gated, writes to the DB) is excluded
      // from the fan-out and runs after it so its DB writes never race the
      // feeds.
      if (this.shouldStopEarly()) return;
      const feedsStart = Date.now();
      diag.preFeedMs = feedsStart - startedAt;
      const feedJobs: Array<Promise<void>> = [];
      // The fallback is the make-up lane, not `[]`: the deferred coins are
      // what the feed request exists to carry back into the tick, so a tick
      // that cannot get an answer must not also lose them (see
      // FEED_DEADLINE_MS, and docs/push-baseline-ledger.md for the ticks this
      // used to cost). `settled` keeps the reading honest — a fallback count
      // can never be mistaken for the upstream's answer.
      const profilesOutcome = await this.fetchFeedCapped(
        () => profilesCall,
        {
          list: missingDeferredTokens([]).map((tokenAddress) => ({ tokenAddress })),
          settled: false,
        },
        feedDeadline,
        true,
      );
      const profiles = profilesOutcome.list;
      diag.profilesSettled = profilesOutcome.settled;
      diag.profiles = profiles.length;
      // The launch-slot fallback CHAIN (gecko → pump.fun → Meteora) is built
      // after the gecko job BELOW, and that placement is load-bearing: each
      // layer awaits the promise of the layer before it, and a layer placed
      // above its producer reads `null` — an async IIFE runs synchronously up
      // to its first await, so `if (geckoJob !== null) await geckoJob` in a
      // block that precedes the gecko job is ALWAYS false. Measured 2026-09-21:
      // that is how the previous "gecko fallback" silently became an always-on
      // feed (`pump 20` + `pumpFallback true` on ticks where gecko was healthy
      // too, and gecko's own `geo 0` never gated anything). geckoJob lives here
      // only so the gecko block below can hand its promise over.
      let geckoJob: Promise<void> | null = null;
      // GeckoTerminal new-pools feed — the free (no-key) discovery source
      // covering every Solana DEX incl. pump.fun graduates, replacing the
      // CU-expensive Birdeye new_listing for live discovery. Pools are
      // registered by their pool_created_at (≈ graduation time, matching
      // how DexScreener pairs age coins), so they enter the re-eval pool
      // and are evaluated once they reach the qualifying age window.
      let geckoProfiles: TokenProfile[] = [];
      if (this.shouldStopEarly()) {
        await Promise.all(feedJobs);
        return;
      }
      if (this.gecko) {
        const geckoPromise = this.fetchFeedCapped(
            async () => {
              const pools = [];
              for (
                let page = 1;
                page <= this.config.geckoterminalPoolPages;
                page++
              ) {
                const got = await this.gecko!.fetchNewPools(page);
                pools.push(...got);
                if (got.length === 0) break;
              }
              return pools
                .filter((p) => p.createdAtMs !== null)
                .map((p) => ({
                  tokenAddress: p.tokenAddress,
                  openTimestamp: p.createdAtMs ?? undefined,
                }));
            },
            [],
            feedDeadline,
          )
            .then((p) => {
              geckoProfiles = p;
              diag.geo = p.length;
            })
            .catch((err: unknown) => {
              console.error(
                "[scanner] geckoterminal discovery failed:",
                err instanceof Error ? err.message : err,
              );
            });
        geckoJob = geckoPromise;
        feedJobs.push(geckoPromise);
      }
      // LAUNCH-SLOT FALLBACK CHAIN: gecko's new_pools is the primary keyless
      // launch feed, and a tick where it delivers nothing would leave the
      // brand-new-coin slot empty — so two more keyless sources stand behind
      // it, in measured order of freshness (both measured from the WORKER's own
      // egress, the only placement that counts — see /debug/pool-source):
      //
      //   1. pump.fun v3 /coins      — newest coin ~2s old, one request
      //   2. Meteora DAMM v2 /pools  — newest pool ~32s old, sorted server-side
      //      by pool_created_at (see src/meteora.ts — Raydium and Orca cannot
      //      answer "newest pools" at all: neither exposes a creation order)
      //
      // A layer awaits the one before it and returns the moment that layer
      // delivered, so a healthy gecko tick pays NOTHING, a tick pump.fun fills
      // never reaches Meteora, and only a tick where every layer ahead came
      // back empty walks the whole chain. The wait sits INSIDE the feed window
      // (fetchFeedCapped's floor): a layer that starts with no window left
      // returns [] without dispatching, so a hung layer cannot drag the chain
      // past the deadline.
      let pumpProfiles: TokenProfile[] = [];
      let pumpJob: Promise<void> | null = null;
      const pumpAlwaysLimit = this.config.pumpfunProfileLimit;
      const pumpFallbackLimit = this.config.pumpfunFallbackLimit;
      if (this.pumpfun && (pumpAlwaysLimit > 0 || pumpFallbackLimit > 0)) {
        const pumpPromise = (async () => {
          if (pumpAlwaysLimit <= 0) {
            if (geckoJob !== null) await geckoJob;
            if (diag.geo > 0) return; // gecko delivered — nothing to fill
            diag.pumpFallback = true;
          }
          pumpProfiles = await this.fetchFeedCapped(
            () =>
              this.pumpfun!.fetchNewestCoins(
                pumpfunDiscoveryLimit(this.config, diag.geo > 0),
              ),
            [],
            feedDeadline,
          );
          diag.pump = pumpProfiles.length;
        })().catch((err: unknown) => {
          console.error(
            "[scanner] pump.fun discovery failed:",
            err instanceof Error ? err.message : err,
          );
        });
        pumpJob = pumpPromise;
        feedJobs.push(pumpPromise);
      }
      // Meteora DAMM v2 — the chain's LAST resort (see src/meteora.ts). Reached
      // only when gecko AND pump.fun both delivered nothing, which is exactly
      // the case this layer exists for: pump.fun blocks datacenter IPs on and
      // off, and an independent provider is what keeps the slot filled when it
      // does. Sized by METEORA_FALLBACK_LIMIT (0 = off).
      let meteoraProfiles: TokenProfile[] = [];
      if (this.meteora && this.config.meteoraFallbackLimit > 0) {
        feedJobs.push(
          (async () => {
            if (pumpJob !== null) await pumpJob;
            // An EARLIER layer filling the slot stops the chain. Testing
            // `diag.pump` alone is not enough: when gecko delivered, the pump
            // layer returns from its skip branch WITHOUT setting `diag.pump`,
            // so this layer would go to the network on a tick gecko covered.
            if (diag.geo > 0 || diag.pump > 0) return;
            meteoraProfiles = await this.fetchFeedCapped(
              () =>
                this.meteora!.fetchNewestPools(this.config.meteoraFallbackLimit),
              [],
              feedDeadline,
            );
            diag.meteora = meteoraProfiles.length;
          })().catch((err: unknown) => {
            console.error(
              "[scanner] meteora discovery failed:",
              err instanceof Error ? err.message : err,
            );
          }),
        );
      }
      // GeckoTerminal trending-pools — momentum feed (free, no key), the
      // replacement for GMGN trending (GMGN's edge blocks Cloudflare Worker
      // egress with 429). Sized by GECKOTERMINAL_TRENDING_LIMIT (0 =
      // disabled); best-effort — failures return [] and the scan continues.
      let geoTrendProfiles: TokenProfile[] = [];
      if (this.gecko && this.config.geckoterminalTrendingLimit > 0) {
        feedJobs.push(
          this.fetchFeedCapped(
            async () => {
              const trending = await this.gecko!.fetchTrendingPools(
                this.config.geckoterminalTrendingLimit,
              );
              return trending
                .filter((p) => p.createdAtMs !== null)
                .map((p) => ({
                  tokenAddress: p.tokenAddress,
                  openTimestamp: p.createdAtMs ?? undefined,
                }));
            },
            [],
            feedDeadline,
          )
            .then((p) => {
              geoTrendProfiles = p;
              diag.geoTrend = p.length;
            })
            .catch((err: unknown) => {
              console.error(
                "[scanner] geckoterminal trending discovery failed:",
                err instanceof Error ? err.message : err,
              );
            }),
        );
      }
      // GMGN trending discovery — momentum-ranked candidates with GMGN's
      // smart-money/wash-trading-aware filters already applied server-side
      // (best-effort — failures return [] and the scan continues). Sized by
      // GMGN_TRENDING_LIMIT (0 = disabled).
      let gmgnProfiles: TokenProfile[] = [];
      if (this.gmgn && this.config.gmgnTrendingLimit > 0) {
        feedJobs.push(
          this.fetchFeedCapped(
            async () => {
              const trending = await this.gmgn!.fetchTrending(
                this.config.gmgnTrendingLimit,
              );
              return trending
                .filter((t) => !t.isWashTrading)
                .map((t) => ({
                  tokenAddress: t.address,
                  openTimestamp: t.createdAtMs ?? undefined,
                }));
            },
            [],
            feedDeadline,
          )
            .then((p) => {
              gmgnProfiles = p;
              diag.gmgn = p.length;
            })
            .catch((err: unknown) => {
              console.error(
                "[scanner] gmgn trending discovery failed:",
                err instanceof Error ? err.message : err,
              );
            }),
        );
      }
      // Axiom Trade trending — momentum feed with sniper/insider/bundle/
      // top10-holder signals Axiom computes server-side (no other free feed
      // has them). Needs a logged-in access token (see /debug/axiom-login);
      // the scanner refreshes a stale token via the stored refresh token and
      // silently skips when not logged in. Sized by AXIOM_TRENDING_LIMIT
      // (0 = disabled); best-effort — failures return [] and the scan
      // continues.
      let axiomProfiles: TokenProfile[] = [];
      if (this.axiom && this.config.axiomTrendingLimit > 0) {
        feedJobs.push(
          this.fetchFeedCapped(
            async () => {
              const trending = await this.fetchTrendingCached();
              return trending
                .filter((t) => t.createdAtMs !== null)
                .map((t) => ({
                  tokenAddress: t.address,
                  openTimestamp: t.createdAtMs ?? undefined,
                }));
            },
            [],
            feedDeadline,
          )
            .then((p) => {
              axiomProfiles = p;
              diag.axiom = p.length;
            })
            .catch((err: unknown) => {
              console.error(
                "[scanner] axiom trending discovery failed:",
                err instanceof Error ? err.message : err,
              );
            }),
        );
      }
      // Jupiter Token v2 recent-launches — seconds-old launchpad launches
      // (pump.fun & co.), the free no-key replacement for the blocked
      // pump.fun frontend-api feed (HTTP 530 from Worker egress). Carries
      // createdAt so coins enter the re-eval pool with their true birth
      // time. Sized by JUPITER_RECENT_LIMIT (0 = disabled); best-effort —
      // failures return [] and the scan continues.
      let jupProfiles: TokenProfile[] = [];
      if (this.jupiter && this.config.jupiterRecentLimit > 0) {
        feedJobs.push(
          this.fetchFeedCapped(
            () =>
              this.jupiter!.fetchRecentTokens(this.config.jupiterRecentLimit),
            [],
            feedDeadline,
          )
            .then((p) => {
              jupProfiles = p;
              diag.jup = p.length;
            })
            .catch((err: unknown) => {
              console.error(
                "[scanner] jupiter recent discovery failed:",
                err instanceof Error ? err.message : err,
              );
            }),
        );
      }
      // Jupiter Token v2 trending — momentum feed (free, no key). Mostly
      // older than the qualifying window; kept for early catch of
      // resurging mints. Sized by JUPITER_TRENDING_LIMIT (0 = disabled);
      // best-effort — failures return [] and the scan continues.
      let jupTrendProfiles: TokenProfile[] = [];
      if (this.jupiter && this.config.jupiterTrendLimit > 0) {
        // The page is ranked by 24h organic score, so its HEAD is blue chips
        // and the qualifying band only appears deep in it — measured
        // 2026-09-21: 0 of the top 15 entries fitted an $60K–$230K / 80min–26h
        // window, 8 of the top 100 did. Hence a deep fetch
        // (JUPITER_TRENDING_LIMIT, default 100) plus a band filter at PARSE
        // time: the leg's one subrequest stays one, and the untouched blue
        // chips never reach the pair phase, which is where feed size actually
        // costs (see jupfeeds.parseJupTrendTokens and pairsForTracker).
        const trendBand = trendBandFromChats(chats, RE_EVAL_AGE_MARGIN_MIN);
        feedJobs.push(
          this.fetchFeedCapped(
            () =>
              this.jupiter!.fetchTrendingTokens(
                this.config.jupiterTrendLimit,
                trendBand,
              ),
            [],
            feedDeadline,
          )
            .then((p) => {
              jupTrendProfiles = p;
              diag.jupTrend = p.length;
            })
            .catch((err: unknown) => {
              console.error(
                "[scanner] jupiter trending discovery failed:",
                err instanceof Error ? err.message : err,
              );
            }),
        );
      }
      // Await the fan-out (each job is individually deadline-raced and
      // error-swallowed, so Promise.all here cannot reject and is bounded
      // by the feed deadline). A tripped tick budget lands at the next
      // phase boundary (below) instead of inside the fan-out.
      await Promise.all(feedJobs);
      // Periodic Birdeye backfill — safety net for discovery gaps. Every
      // BIRDEYE_BACKFILL_INTERVAL_MIN the scanner walks back the lookback
      // window of Birdeye's new_listing feed (which includes pump.fun
      // launches) and seeds unseen coins into token_stats. This catches
      // coins created while the monitor paused (GeckoTerminal's newest-pools
      // pages roll past them and they'd never be seen again). CU-bounded: 1
      // request per run. Idempotent (INSERT OR IGNORE); last-run persisted
      // in worker_state so isolates don't re-run it on every recycle.
      if (this.shouldStopEarly()) return;
      try {
        diag.backfill = await this.fetchFeedCapped(
          () => this.runPeriodicBackfill(),
          0,
          feedDeadline,
        );
      } catch (err) {
        console.error(
          "[scanner] periodic backfill failed:",
          err instanceof Error ? err.message : err,
        );
      }
      diag.feedsMs = Date.now() - feedsStart;
      // Dedupe the feeds (mints overlap across all three); the DexScreener
      // entry wins — it carries richer profile data.
      const dexMints = new Set(profiles.map((p) => p.tokenAddress));
      const pumpMints = new Set(pumpProfiles.map((p) => p.tokenAddress));
      const geckoMints = new Set(geckoProfiles.map((p) => p.tokenAddress));
      const meteoraMints = new Set(meteoraProfiles.map((p) => p.tokenAddress));
      const geoTrendMints = new Set(geoTrendProfiles.map((p) => p.tokenAddress));
      const gmgnMints = new Set(gmgnProfiles.map((p) => p.tokenAddress));
      const axiomMints = new Set(axiomProfiles.map((p) => p.tokenAddress));
      const jupMints = new Set(jupProfiles.map((p) => p.tokenAddress));
      const jupTrendMints = new Set(
        jupTrendProfiles.map((p) => p.tokenAddress),
      );
      // Per-mint discovery attribution (see TokenStats.discoveredVia): the
      // merge order below is the priority order — the feed that survives a
      // dedupe filter is the one that found the coin first.
      const discoveredVia = new Map<string, string>([
        ...profiles.map((p) => [p.tokenAddress, "dex"] as const),
        ...pumpProfiles.map((p) => [p.tokenAddress, "pump"] as const),
        ...geckoProfiles.map((p) => [p.tokenAddress, "gecko"] as const),
        ...geoTrendProfiles.map((p) => [p.tokenAddress, "geoTrend"] as const),
        ...gmgnProfiles.map((p) => [p.tokenAddress, "gmgn"] as const),
        ...axiomProfiles.map((p) => [p.tokenAddress, "axiom"] as const),
        ...jupProfiles.map((p) => [p.tokenAddress, "jup"] as const),
        ...jupTrendProfiles.map((p) => [p.tokenAddress, "jupTrend"] as const),
        // Last-resort feed → last place in the attribution order: a mint both
        // Meteora and an earlier feed carry is credited to the earlier one.
        ...meteoraProfiles.map((p) => [p.tokenAddress, "meteora"] as const),
      ]);
      const feedProfiles: TokenProfile[] = [
        ...profiles,
        ...pumpProfiles.filter((p) => !dexMints.has(p.tokenAddress)),
        ...geckoProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) && !pumpMints.has(p.tokenAddress),
        ),
        ...geoTrendProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress),
        ),
        ...gmgnProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress) &&
            !geoTrendMints.has(p.tokenAddress),
        ),
        ...axiomProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress) &&
            !geoTrendMints.has(p.tokenAddress) &&
            !gmgnMints.has(p.tokenAddress),
        ),
        ...jupProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress) &&
            !geoTrendMints.has(p.tokenAddress) &&
            !gmgnMints.has(p.tokenAddress) &&
            !axiomMints.has(p.tokenAddress),
        ),
        ...jupTrendProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress) &&
            !geoTrendMints.has(p.tokenAddress) &&
            !gmgnMints.has(p.tokenAddress) &&
            !axiomMints.has(p.tokenAddress) &&
            !jupMints.has(p.tokenAddress),
        ),
        ...meteoraProfiles.filter(
          (p) =>
            !dexMints.has(p.tokenAddress) &&
            !pumpMints.has(p.tokenAddress) &&
            !geckoMints.has(p.tokenAddress) &&
            !geoTrendMints.has(p.tokenAddress) &&
            !gmgnMints.has(p.tokenAddress) &&
            !axiomMints.has(p.tokenAddress) &&
            !jupMints.has(p.tokenAddress) &&
            !jupTrendMints.has(p.tokenAddress),
        ),
      ];
      const now = Date.now();
      // Resume the one-time launch_ms backfill migration until it finishes
      // (bounded per tick — see Db.resumeLaunchBackfill). While legacy rows
      // still have NULL launch_ms they are invisible to the banded pool query
      // below, so finishing quickly keeps re-eval coverage continuous after a
      // deploy. Best-effort: a failure just retries next tick.
      if (!this.launchBackfillDone) {
        if (this.shouldStopEarly()) return;
        try {
          this.launchBackfillDone = await this.db.resumeLaunchBackfill(4_000);
        } catch (err) {
          console.error(
            "[scanner] launch_ms backfill resume failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      // Re-evaluation pool: tokens never pushed that are nearing or inside
      // the qualifying age window. The profiles feed only ever contains young
      // tokens, so without this pool a coin would rotate out of the feed
      // before reaching the minimum age (5h) and be lost forever. Bounds use
      // the widest age window across enabled chats plus a margin, so coins
      // are picked up shortly before they qualify and pushed the moment they
      // do.
      const poolMinAgeMin = Math.min(...chats.map((c) => c.minAgeMinutes));
      const poolMaxAgeMin = Math.max(...chats.map((c) => c.maxAgeMinutes));
      const poolMinMcapUsd = Math.min(...chats.map((c) => c.minMarketCapUsd));
      const poolMaxMcapUsd = Math.max(...chats.map((c) => c.maxMarketCapUsd));
      const poolMinLiquidityUsd = Math.min(
        ...chats.map((c) => c.minLiquidityUsd),
      );
      if (this.shouldStopEarly()) return;
      const poolStart = Date.now();
      const poolDeadline = Date.now() + POOL_FETCH_BUDGET_MS;
      const recentStats = await this.fetchFeedCapped(
        () =>
// Dead-tick fix 2026-09-13: a budget-tripped tick used to keep
          // spending its full 4s pool race as zombie work after abort() —
          // starting the completion flush that much later against the
          // wall-clock kill. Skip the read when the tick is already over.
          this.shouldStopEarly()
            ? Promise.resolve([])
            : this.getReevalPoolCached(now, {
        sinceMs: now - RE_EVAL_WINDOW_MS,
        minLaunchMs: now - (poolMaxAgeMin + RE_EVAL_AGE_MARGIN_MIN) * 60_000,
        maxLaunchMs: now - (poolMinAgeMin - RE_EVAL_AGE_MARGIN_MIN) * 60_000,
        windowEntryLaunchMs: now - poolMinAgeMin * 60_000,
        limit: this.config.reevalPoolSize,
        // Graduated rotation (see Db.getReevalPool): near slots swept every
        // ~REEVAL_NEAR_SWEEP_MIN, far slots every ~REEVAL_FAR_SWEEP_MIN, hot
        // zone every scan. Bands order by qualification signal and coins
        // repeatedly seen below 60% of the market-cap gate are dropped, so
        // the sweep budget concentrates on coins that can actually qualify.
        // 2026-09-09: 0.5 → 0.6 (half-floor $20K → $24K) — prunes the
        // "$20K–$24K lifelong peak" slice from every band, shortening the
        // full sweep ~5–15% at the same tick budget. Accepted trade-off: a
        // pruned coin stops updating max_mcap_observed, so a $23K-peak coin
        // that later gaps straight past the gate is missed (the lenient 0.5
        // was kept until the pool's growth made sweep latency the binding
        // constraint).
        nearSlots: this.config.reevalNearSlots,
        farSlots: this.config.reevalFarSlots,
        // Rotation period must equal the cache TTL so each expiry advances
        // the slot (see Db.getReevalPool rotationPeriodMs).
        rotationPeriodMs: this.config.reevalPoolCacheMs,
        minQualifyMcap: poolMinMcapUsd * 0.6,
        // Ceiling prune: drop coins whose historical peak already exceeded
        // 2× the widest max-mcap gate. Under the signal ordering their huge
        // max_mcap_observed ranks them first in every band, so pump-and-dump
        // corpses starved live mid-cap coins out of the sweep (2026-09-10
        // audit). Same permanent-exclusion trade-off as the floor prune.
        maxQualifyMcap: poolMaxMcapUsd * 2,
        // Liquidity floor prune: drop coins whose peak liquidity never
        // reached 0.6× the widest chat's liquidity gate. Dead-liquidity
        // corpses (mcap $100K+ over $0–$15 LP) survive the mcap floor/ceiling
        // prunes and rank FIRST in every band under the signal ordering —
        // live evidence 2026-09-10 13:xxZ: ~215 of ~330 evaluated coins/tick
        // failed the liquidity gate (LAPTOP/NEMOTRON/Ggwiz/ZenoCoin…), so
        // the 300-coin slice re-checked the same dead tape every sweep while
        // nothing pushed since 2026-09-06. NULL max_liquidity_observed (not
        // yet seen with pair data) is kept, exactly like the mcap prunes.
        minQualifyLiquidity: poolMinLiquidityUsd * 0.6,
        // Chat-aware seen exclusion: a token is dropped from the pool only
        // when EVERY enabled chat has already received it. Without this a
        // coin pushed to one chat (and marked seen there) vanished from the
        // pool even when another chat's push had just failed, so the missed
        // chat NEVER got a retry — the cross-chat push inconsistency
        // observed between the private chat and the channel.
        seenChatIds: chats.map((c) => c.chatId),
          }),
        [],
        poolDeadline,
      );
      // token_stats grows with pump.fun discovery (100+ new coins per scan):
      // prune rows older than the re-eval window that were never pushed —
      // unreachable by the pool query and only wasting storage. Pushed coins
      // keep their rows so /flow and cached verdicts still work.
      try {
        await this.fetchFeedCapped(
          () => this.db.pruneOldTokenStats(now - RE_EVAL_WINDOW_MS),
          undefined,
          poolDeadline,
        );
      } catch (err) {
        console.error(
          "[scanner] token_stats prune failed:",
          err instanceof Error ? err.message : err,
        );
      }
      if (feedProfiles.length === 0 && recentStats.length === 0) {
        console.log("[scanner] no Solana profiles or re-eval candidates returned");
        this.lastSkip = "empty-feed-and-pool";
        return;
      }
      const poolProfiles: TokenProfile[] = [
        ...feedProfiles,
        ...recentStats
          .filter((s) => !feedProfiles.some((p) => p.tokenAddress === s.token))
          .map((s) => ({ tokenAddress: s.token })),
      ];
      diag.pool = poolProfiles.length;
      // Rotation slice: evaluate at most RE_EVAL_PER_TICK_MAX pool coins per
      // tick (the feed itself is always included). A pool larger than the
      // slice cycles through per-tick windows so every coin is still swept;
      // a smaller pool is taken whole (cursor clamps). Stable order across
      // ticks (the pool query sorts by band then mcap) keeps the window
      // sweep deterministic.
      const feedOnly = poolProfiles.slice(0, feedProfiles.length);
      const poolOnly = poolProfiles.slice(feedProfiles.length);
      const { slice: poolSlice, nextCursor } = slicePoolRotation(
        poolOnly,
        this.poolSliceCursor,
        RE_EVAL_PER_TICK_MAX,
      );
      this.poolSliceCursor = nextCursor;
      diag.poolSliced = poolSlice.length;
      diag.poolMs = Date.now() - poolStart;
      const evalStart = Date.now();
      const scannedProfiles: TokenProfile[] = [...feedOnly, ...poolSlice];
      // REJECT_LOG_MAX (50) is smaller than feed+slice (~90+ coins/tick), so
      // the bounded reject list filled first-come-first-served: the feed's
      // dozens of fresh bonding-curve coins (all "流动性 ~$0") flooded it and
      // the pool coins' rejections never surfaced, making zero-push stretches
      // look unexplained on /health. Reserve the pool slice a guaranteed
      // share: feed coins may log only into the first `feedBudgetStart`
      // slots (the leftover), pool coins log up to the cap.
      const rejectBudgetBeforeEval = REJECT_LOG_MAX - Math.min(
        poolSlice.length,
        REJECT_LOG_MAX,
      );
      // The post-push tracker's queue head rides along with the pool: its
      // coins are PUSHED coins, which the re-eval pool query excludes, so
      // this batch is what keeps them in Scanner.lastPairs — without it the
      // tracker's own request is the only one that ever asks for them and
      // the pair cache stays empty for them (see pairsForTracker). At most
      // TRACKER_PAIR_HEAD extra addresses, so the extra cost is at most one
      // more batch in a phase that already dispatches several.
      const addresses = [
        ...new Set([
          ...scannedProfiles.map((p) => p.tokenAddress),
          ...(this.pushWatcher?.headTokens() ?? []),
        ]),
      ];
      if (this.shouldStopEarly()) return;
      const pairsByToken = await this.dex.fetchPairsForTokens(addresses);
      // Fallback: when DexScreener's batched endpoint is blocked (shared
      // egress 429s — observed 2026-08-22, pairs: 0/550), source the gate
      // data from Jupiter's token API instead. It carries every input the
      // gates need (mcap, liquidity, 5m/1h volume+change, txns, createdAt).
      if (pairsByToken.size < addresses.length * 0.5 && this.jupiter) {
        try {
          const missing = addresses.filter((a) => !pairsByToken.has(a));
          for (const [k, v] of await this.jupiter.fetchTokenDataBatch(missing))
            pairsByToken.set(k, v);
        } catch (err) {
          console.error(
            "[scanner] jupiter pair fallback failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      diag.pairs = pairsByToken.size;
      // Kept for the post-push tracker pass (see lastPairs).
      this.lastPairs = pairsByToken;

      // Capture each token's opening stats the first time we ever see it.
      // One batched lookup for the whole feed, then one batched insert for
      // the new tokens — keeps the tick's Turso round trips to 2 instead of
      // ~2×profiles (per-round-trip latency is the tick's biggest cost when
      // the database is slow, observed ~5s/call). Registration is
      // pair-independent for pump.fun coins: a coin with no DexScreener pair
      // yet (bonding curve not graduated) is still recorded, so it enters
      // the re-eval pool and is evaluated the moment its pair appears. A
      // DexScreener profile with missing pair data is still skipped (it
      // simply re-registers next tick once the pair is fetched).
      const statsByToken = new Map<string, TokenStats>();
      if (this.shouldStopEarly()) return;
      // Tick-critical READ under the scan cap: when it fails fast (a stalled
      // Turso call hits SCAN_DB_TIMEOUT_MS) registration is SKIPPED for this
      // tick rather than degraded, because writing a fresh row for a token we
      // could not look up would reset its firstSeenAt — the pool's age and
      // qualification signal. The feed re-registers it next tick.
      let existingStats: Map<string, TokenStats> | null = null;
      try {
        existingStats = await this.db.getTokenStatsMany(
          feedProfiles.map((p) => p.tokenAddress),
        );
      } catch (err) {
        diag.dbDegraded = "stats-read";
        console.error(
          "[scanner] token stats read failed — skipping registration this tick:",
          err instanceof Error ? err.message : err,
        );
      }
      const newStats: TokenStats[] = [];
      for (const profile of feedProfiles) {
        // Read failed → register nothing: `existingStats` missing means we
        // cannot tell new tokens from known ones (see the guard above).
        if (!existingStats) break;
        const existing = existingStats.get(profile.tokenAddress);
        if (existing) {
          statsByToken.set(profile.tokenAddress, existing);
          continue;
        }
        const pair = pairsByToken.get(profile.tokenAddress);
        // No pair AND no pump.fun launch time → skip (retry next tick).
        if (!pair && profile.openTimestamp === undefined) continue;
        const ageMin = pair
          ? (now - pair.pairCreatedAt) / 60_000
          : profile.openTimestamp !== undefined
            ? (now - profile.openTimestamp) / 60_000
            : 0;
        const stats: TokenStats = {
          token: profile.tokenAddress,
          firstSeenAt: now,
          firstM5Vol: pair?.volume.m5 ?? 0,
          firstSeenAgeMin: ageMin,
          launchMs: pair
            ? pair.pairCreatedAt
            : profile.openTimestamp !== undefined
              ? profile.openTimestamp
              : now,
          birdeye1mVol: null,
          rugcheckBundlerPct: null,
          rugcheckTop10Pct: null,
          birdeyeProTraders: null,
          birdeyeSniperPct: null,
          minMcapObserved: null,
          supplyFlowJson: null,
          supplyFlowAt: null,
          discoveredVia: discoveredVia.get(profile.tokenAddress) ?? null,
        };
        newStats.push(stats);
        statsByToken.set(profile.tokenAddress, stats);
      }
      // Same guard as the read above: without a successful lookup we do not
      // know which tokens are new, so we write nothing (see the comment on
      // getTokenStatsMany). One lost registration tick costs a coin nothing —
      // it re-registers as soon as it appears in a feed again.
      if (newStats.length > 0 && existingStats) {
        try {
          await this.db.recordTokenStatsMany(newStats);
        } catch (err) {
          diag.dbDegraded = "stats-write";
          console.error(
            "[scanner] token stats registration failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }
      // Pool-only tokens (not in the current feed) reuse their cached stats.
      for (const stats of recentStats) {
        if (!statsByToken.has(stats.token)) statsByToken.set(stats.token, stats);
      }

      // ③ Track the highest market cap ever observed for pool candidates.
      // The re-eval pool query pre-filters on it (coins repeatedly seen far
      // below the gate stop consuming sweep budget) and orders rotation
      // bands by it. One batched raise-only UPDATE; the raise list is empty
      // in steady state (only genuine new highs trigger a write).
      const raises: Array<{
        token: string;
        mcapUsd: number;
        liquidityUsd?: number;
      }> = [];
      for (const [token, pair] of pairsByToken) {
        const stats = statsByToken.get(token);
        if (
          !stats ||
          !Number.isFinite(pair.marketCap) ||
          pair.marketCap <= 0
        )
          continue;
        // Comparable-only (see gateLiquidityUsd): this column feeds the re-eval
        // pool's `minQualifyLiquidity` prune (0.6 × the widest chat's floor,
        // DexScreener-calibrated), and the raise is one-way — a Jupiter/Gecko
        // reading is a different metric of the same pool (~half), so feeding it
        // in can only leave the coin's high-water mark short of the truth and
        // let a LIVE coin be pruned out of the pool: a permanent missed push,
        // the one cost worse than the gate's one-tick delay. An unjudgeable leg
        // therefore raises nothing, and the next DexScreener-served sweep of
        // the same coin records it; a comparable leg's reading still lands,
        // 0 included (a corpse's $0 LP is its identifying signal).
        const liquidity: number | undefined = liquidityIsComparable(pair)
          ? (pair.liquidity?.usd ?? 0)
          : undefined;
        const mcapRaise =
          stats.maxMcapObserved === null ||
          stats.maxMcapObserved === undefined ||
          pair.marketCap > stats.maxMcapObserved;
        const liqRaise =
          liquidity !== undefined &&
          (stats.maxLiquidityObserved === null ||
            stats.maxLiquidityObserved === undefined ||
            liquidity > stats.maxLiquidityObserved);
        if (!mcapRaise && !liqRaise) continue;
        raises.push({
          token,
          // No mcap raise → send the stored value so the CASE keeps it
          // (updateTokenMaxMcaps writes both columns unconditionally).
          mcapUsd: mcapRaise
            ? pair.marketCap
            : (stats.maxMcapObserved ?? 0),
          // A finite reading (0 included) whenever the leg is comparable;
          // omitted otherwise, so the liquidity CASE leaves the column alone —
          // the same "missing data never judges" discipline as the gate.
          liquidityUsd: liquidity,
        });
      }
      if (raises.length > 0) {
        try {
          await this.db.updateTokenMaxMcaps(raises);
          for (const r of raises) {
            const s = statsByToken.get(r.token);
            if (!s) continue;
            if (s.maxMcapObserved === null || s.maxMcapObserved === undefined || r.mcapUsd > s.maxMcapObserved)
              s.maxMcapObserved = r.mcapUsd;
            const liq = r.liquidityUsd;
            if (
              liq !== undefined &&
              (s.maxLiquidityObserved === null ||
                s.maxLiquidityObserved === undefined ||
                liq > s.maxLiquidityObserved)
            )
              s.maxLiquidityObserved = liq;
          }
        } catch (err) {
          console.error(
            "[scanner] max mcap tracking update failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      const agedEval = { count: 0 };
      const candidates = this.matchCoins(
        scannedProfiles,
        pairsByToken,
        statsByToken,
        chats,
        diag.fails,
        diag.rejects,
        agedEval,
        // Feed coins log into the leftover slots only — the pool slice has a
        // guaranteed share of the reject list (see rejectBudgetBeforeEval).
        // scannedProfiles = [...feedOnly, ...poolSlice]: the tail is the pool.
        { feedBudgetStart: rejectBudgetBeforeEval, poolStartIdx: feedOnly.length },
      );
      diag.agedEval = agedEval.count;
      diag.candidates = candidates.length;
      let pushed = 0;
      // Group candidates by token: all the expensive per-coin lookups below
      // (supply flow, RugCheck, Birdeye, GMGN, Arkham) are token-level, so
      // they run ONCE per token per tick instead of once per (token, chat)
      // pair — the previous version re-ran every lookup for each chat
      // candidate of the same coin, doubling API spend and burning the tick
      // deadline twice as fast. Pushes still happen per chat, and a push to
      // one chat failing (Telegram error) never blocks the others: the
      // chat-aware re-eval pool keeps the coin around so the missed chat
      // gets a retry on a later scan.
      const groups = new Map<string, QualifyingCoin[]>();
      for (const coin of candidates) {
        const key = coin.profile.tokenAddress;
        const group = groups.get(key);
        if (group) group.push(coin);
        else groups.set(key, [coin]);
      }
      let processedCandidates = 0;
      // Two deadlines for the candidate chain, both derived from the tick's
      // own deadline. `chainDeadline` is the hard wall for EVERYTHING that
      // must happen before the card is sent (see CANDIDATE_PUSH_RESERVE_MS);
      // `enrichDeadline` is the earlier wall used by the CARD-ONLY
      // enrichments, so decoration can never eat the tail gates
      // (CANDIDATE_GATE_TAIL_MS).
      const chainDeadline = tickDeadline - CANDIDATE_PUSH_RESERVE_MS;
      const enrichDeadline = chainDeadline - CANDIDATE_GATE_TAIL_MS;
      for (const group of groups.values()) {
        // Hard tick deadline: each token's expensive lookups (Helius up to
        // 16s + RugCheck + Birdeye) can exceed the remaining budget fast.
        // Defer the rest to the next tick — they stay in the re-evaluation
        // pool, so this only delays a push by a minute, never loses it.
        // Checked against `chainDeadline`, not the tick deadline: below it
        // the chain still has to run AND the card still has to be sent, so
        // starting a coin with less than that left only guaranteed a
        // half-processed coin cut off by the worker's race (2026-09-16:
        // `candidates: 1, pushed: 0` on every such tick).
        if (this.abortRequested || Date.now() > chainDeadline) {
          this.markPhase(diag, "deferred", startedAt);
          console.log(
            `[scanner] chain deadline reached — deferring ${candidates.length - processedCandidates} candidate(s) to next tick`,
          );
          break;
        }
        processedCandidates += group.length;
        // Chats in this group that have not yet received this coin (per-chat
        // dedupe: a coin already pushed to one chat is still pending for the
        // others, e.g. after a failed delivery — this is the fast path that
        // skips the slow lookups when every chat already has it).
        this.markPhase(diag, "seen", startedAt);
        const unseen: QualifyingCoin[] = [];
        for (const coin of group) {
          try {
            if (await this.db.isTokenSeen(coin.chatId, coin.profile.tokenAddress)) {
              continue;
            }
          } catch (err) {
            // Degrade to "not seen": the INSERT OR IGNORE claim inside sendTo
            // is the real duplicate guard, and an unreadable dedupe table must
            // not abort the tick with a candidate already in hand.
            diag.dbDegraded = "seen-read";
            console.error(
              "[scanner] seen-check failed — treating as unseen:",
              err instanceof Error ? err.message : err,
            );
          }
          unseen.push(coin);
        }
        if (unseen.length === 0) continue;
        const coin = unseen[0];
        // Supply-flow (rug/distribution) check — run before the expensive
        // display lookups so a flagged coin never wastes the tick. Only a
        // confirmed flag blocks the push; a pending/incomplete analysis
        // (hold/unknown) pushes anyway with the card showing 未分析.
        this.markPhase(diag, "flow", startedAt);
        const flow = await this.resolveSupplyFlow(coin, chainDeadline);
        if (flow.status === "flagged") {
          diag.fails.flow++;
          this.addReject(
            diag,
            coin,
            `供應集中 ${flow.result.feeders}錢包→1接收者 (${flow.result.fedPct.toFixed(1)}%供應, 賣出${flow.result.sells}次)`,
          );
          console.log(
            `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (supply-flow distribution detected)`,
          );
          continue;
        }
        // Bundler + top-10 holder share is resolved for the message card but
        // no longer filters — those filters were removed, so coins push even
        // when the RugCheck report is not ready yet (the card shows 未检测).
        // From here to the Flurry gate every step is a live network call and
        // they are awaited SERIALLY, so the chain — not the front phases — is
        // what the tick race actually cuts. Each step now races the chain
        // deadline with the exact value its resolver returns when the
        // upstream fails, so a miss degrades the card ("未检测" / "—") and
        // never the push. See bestEffort().
        this.markPhase(diag, "rugcheck", startedAt);
        const rugcheck = await this.bestEffort(
          () => this.resolveRugcheckData(coin),
          chainDeadline,
          {
            // The resolver's own cache, so a deadline miss still renders
            // whatever RugCheck already told us about this coin.
            bundlerPct: coin.stats.rugcheckBundlerPct,
            top10Pct: coin.stats.rugcheckTop10Pct,
            creator: this.rugcheckCreator.get(coin.stats.token) ?? null,
          },
        );
        // Card-only display batch, dispatched HERE — concurrently with the
        // crime check and the Axiom token-info that follow — instead of being
        // awaited one call at a time later in the chain. Two measured
        // reasons:
        //  - Serially the batch cost the SUM of five upstream round trips
        //    (~1-2.5s) while racing a single shared deadline, so whatever sat
        //    at the back of the queue started with an empty window and
        //    silently dropped off the card. Live report 2026-09-17: the
        //    Jupiter 🌱 有機度 / 1h 交易者 line stopped appearing (upstream
        //    verified healthy — the Jupiter search endpoint still returns
        //    organicScore for the same mints).
        //  - Starting it here gives the batch the chain's whole remaining
        //    window AND overlaps it with two other awaits, so the chain's
        //    total wall time drops and the gate tail below (wallet analysis,
        //    top-10 band, Flurry) starts earlier — better for the push path
        //    too.
        // Same calls, same count, same deadline: only the overlap changes.
        // Nothing in the batch gates anything — GMGN's wash-trading flag is
        // judged where the batch is awaited, and each slot that misses its
        // deadline degrades to exactly the value the old code used.
        const jupiterOrganic = this.jupiter;
        this.markPhase(diag, "enrich-dispatch", startedAt);
        const displayBatch = Promise.all([
          this.bestEffort(
            () => this.resolveTraderData(coin),
            enrichDeadline,
            {
              proTraders: coin.stats.birdeyeProTraders,
              sniperPct: coin.stats.birdeyeSniperPct,
            },
          ),
          this.bestEffort(
            () => this.resolveHolderCount(coin),
            enrichDeadline,
            { holderCount: null },
          ),
          this.bestEffort(
            () => this.resolveGmgnInfo(coin),
            enrichDeadline,
            null,
          ),
          this.bestEffort(
            () => this.resolveArkhamInfo(coin),
            enrichDeadline,
            null,
          ),
          this.bestEffort(
            jupiterOrganic
              ? () => jupiterOrganic.fetchOrganicScore(coin.stats.token)
              : null,
            enrichDeadline,
            null,
          ),
        ]);
        // Crime-wallet check: the coin's creator (RugCheck) and top holder
        // owner wallets are matched against the community blocklist. A hit
        // is a warning (flagged on the card) unless CRIME_WALLETS_BLOCK
        // turns it into a push blocker.
        const crimeClient = this.crimeWallets;
        this.markPhase(diag, "crime", startedAt);
        const crime = await this.bestEffort<CrimeCheckResult>(
          crimeClient
            ? () =>
                crimeClient.checkToken(
                  coin.stats.token,
                  rugcheck.creator,
                  this.helius,
                  {
                    checkHolders: this.config.crimeWallets.checkHolders,
                    holderTopN: this.config.crimeWallets.holderTopN,
                  },
                )
            : null,
          chainDeadline,
          {
            // A deadline miss fails OPEN — the same stance this check already
            // ships with (a missing/stale blocklist must never silence the
            // bot). The holder list it would have resolved is simply absent
            // from the wallet analysis below.
            hit: false,
            creatorHit: false,
            holderHits: [],
            checkedHolders: 0,
            loaded: false,
            holders: [],
          },
        );
        if (crime.hit) diag.crime++;
        if (this.config.crimeWallets.block && crime.hit) {
          diag.fails.crime++;
          this.addReject(
            diag,
            coin,
            crime.creatorHit
              ? "Creator 在犯罪錢包名單（crimewallets）"
              : `${crime.holderHits.length} 個持有人錢包在犯罪錢包名單`,
          );
          console.log(
            `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (crime-wallet match)`,
          );
          continue;
        }
        // Axiom token-info — one API call feeds BOTH the bot-users push
        // gate and the card summary line (Top 10 | 持有人 | Pro | Dev | …).
        // Runs FIRST among the enrichments so a gate reject saves the
        // Birdeye/GMGN/Arkham/Jupiter/wallet budget entirely. Missing data
        // (session down, no pair address) never judges and hides the card
        // line instead — a dead session must not silence the bot.
        const axiom = this.axiom;
        const axiomPair = coin.pair.pairAddress;
        this.markPhase(diag, "axiom", startedAt);
        const axiomInfo = await this.bestEffort(
          axiom && axiomPair
            ? () => this.resolveAxiomTokenInfo(axiomPair)
            : null,
          chainDeadline,
          null,
        );
        if (this.config.axiomMinBotUsers > 0) {
          const botReason = botUsersBlockReason(
            axiomInfo?.numBotUsers ?? null,
            this.config.axiomMinBotUsers,
          );
          if (botReason) {
            diag.fails.other++;
            this.addReject(diag, coin, botReason);
            console.log(
              `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (axiom bot-users below floor)`,
            );
            continue;
          }
        }
        // Await the display batch dispatched above (it has been running
        // concurrently with the crime check and the Axiom token-info), then
        // judge the one thing in it that can block a push. Trader data is
        // display-only (the sniper filter was removed): a coin pushes even
        // when the data is not ready and the card shows 未检测/—.
        this.markPhase(diag, "enrich-await", startedAt);
        const [trader, holders, gmgn, arkham, organic] = await displayBatch;
        if (arkham) diag.arkham++;
        if (organic) diag.organic++;
        if (
          this.gmgn &&
          this.config.gmgnBlockWashTrading &&
          gmgn?.isWashTrading === true
        ) {
          diag.fails.other++;
          this.addReject(diag, coin, "GMGN 標記為 wash trading");
          console.log(
            `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (GMGN wash-trading flag)`,
          );
          continue;
        }
        // Wallet analysis — creator profile (age + serial-launcher create
        // count), top-holder wallet ages and cross-coin holder clustering.
        // Runs only for coins that pass every block gate (its pushed_holders
        // rows feed the clustering, so blocked coins must not pollute it).
        // Reuses the crime check's resolved holders (no extra RPC for the
        // holder list itself); each unique wallet costs one cached Helius
        // call inside a hard budget, so a slow RPC degrades the card, never
        // the push.
        const analyzer = this.walletAnalyzer;
        this.markPhase(diag, "wallets", startedAt);
        const wallet = await this.bestEffort(
          analyzer
            ? () =>
                analyzer.analyze({
                  token: coin.stats.token,
                  creator: rugcheck.creator,
                  holders: crime.holders,
                  crime,
                  // Clamp the analyzer's serial-RPC budget to the CHAIN
                  // deadline (not the tick deadline): an unclamped 8s wallet
                  // walk could outlive the tick race on heavy ticks, pushing
                  // the completion flush past Cloudflare's invocation kill
                  // (the dead-tick shape) — and, with the push reserve
                  // subtracted, it would spend the seconds the send needs.
                  deadline: chainDeadline,
                })
            : null,
          chainDeadline,
          null,
        );
        if (wallet?.ok) diag.walletAnalysis++;
        // Insider self-pump gate: top holders almost all brand-new wallets
        // (the Cheems shape — 8/8 fresh). Runs after analysis so the data is
        // already in hand; no extra API cost.
        const newWalletReason = newWalletBlockReason(
          wallet?.holders.checked ?? 0,
          wallet?.holders.newWallets ?? 0,
          this.config.walletNewRatioMax,
          this.config.walletNewMinChecked,
        );
        if (newWalletReason) {
          diag.fails.other++;
          this.addReject(diag, coin, newWalletReason);
          console.log(
            `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (new-wallet concentration)`,
          );
          continue;
        }
        // Dispersed-float gate: LP-excluded top-10 concentration below the
        // configured floor (the MCGA shape — 2.2%). RugCheck data already in
        // hand; no extra API cost.
        // Concentration gate: LP-excluded top-10 must sit in a healthy band —
        // not dispersed (MCGA shape) nor cartel-locked (>90%). RugCheck data
        // already in hand; no extra API cost.
        const top10Reason = top10MinBlockReason(
          rugcheck.top10Pct,
          this.config.top10PctMin,
          this.config.top10PctMax,
        );
        if (top10Reason) {
          diag.fails.other++;
          this.addReject(diag, coin, top10Reason);
          console.log(
            `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (top10 out of band)`,
          );
          continue;
        }
        // Flurry launch forensics — deploy-slot bundle + funding-lineage
        // check. Deliberately the LAST gate: it only runs on coins that
        // passed every other gate (so its Helius spend tracks coins about
        // to be pushed, not all candidates), and a bundled coin blocked
        // here costs one extra envelope before the verdict is cached per
        // mint (0 RPC on re-sweeps). Fail-open: non-pump mints, RPC errors
        // and budget exhaustion all pass without blocking.
        // Deadline is capped to min(tickDeadline, now+FLURRY_ANALYZE_CAP_MS):
        // analyze() waits up to its deadline for a hung RPC (the clamp race),
        // so an unclamped wait could stall the tick for the full remainder
        // and delay the completion flush past the invocation kill.
        const flurryClient = this.flurry;
        this.markPhase(diag, "flurry", startedAt);
        const flurryOut = await this.bestEffort<FlurryOutcome>(
          flurryClient
            ? () =>
                flurryClient.analyze(
                  coin.stats.token,
                  Math.min(chainDeadline, Date.now() + FLURRY_ANALYZE_CAP_MS),
                )
            : null,
          chainDeadline,
          { status: "skip" },
        );
        const flurryReport =
          flurryOut.status === "report" ? flurryOut.report : null;
        if (flurryReport) diag.flurryAnalyzed++;
        if (flurryReport?.bundled && this.config.flurry.blockBundles) {
          diag.fails.flurry++;
          this.addReject(diag, coin, flurryBlockReason(flurryReport)!);
          console.log(
            `[scanner] blocked ${coin.profile.symbol ?? coin.pair.baseToken.symbol} (deploy-slot bundle)`,
          );
          continue;
        }
        // Live trade-mode read (once per token): /setmode flips apply to the
        // very next card. Buy button renders in manual mode; sell buttons in
        // any non-off mode (in auto the coin was already bought — exits are
        // what matter).
        this.markPhase(diag, "render", startedAt);
        const tradeMode = this.trade
          ? await this.trade.effectiveMode()
          : "off";
        const tokenAddress = coin.pair.baseToken.address;
        const message = renderMessage(
          coin,
          rugcheck.bundlerPct,
          rugcheck.top10Pct,
          trader.sniperPct,
          flow.status === "clean",
          holders.holderCount,
          rugcheck.creator,
          gmgn,
          arkham,
          crime,
          wallet,
          organic,
          axiomInfo,
          // null = forensics disabled → line hidden; { report: null } =
          // configured but nothing to report (non-pump mint / skip).
          this.flurry ? { report: flurryReport } : null,
        );
        const sendTo = async (c: QualifyingCoin): Promise<void> => {
          const deferCard = (why: string): void => {
            diag.cardSendDeferred = (diag.cardSendDeferred ?? 0) + 1;
            this.cardSendDeferredTotal += 1;
            diag.cardSendDeferredTotal = this.cardSendDeferredTotal;
            // The coin is re-pushed by a LATER tick's runOnce, so only the
            // cross-tick ledger can show whether that make-up send happened.
            this.deferredPushes.defer(c.profile.tokenAddress, Date.now());
            diag.deferPending = this.deferredPushes.pendingCount;
            console.log(
              `[scanner] initial card deferred (${why}): ${c.profile.symbol ?? c.profile.tokenAddress}`,
            );
          };
          // Atomic claim BEFORE sending: overlapping isolates can both pass
          // the isTokenSeen check-then-act window above, but only one wins
          // this INSERT OR IGNORE — duplicate cards (e.g. double TRILLY)
          // are impossible at the storage layer.
          // A tick with no slice left never reaches the claim: the claim and
          // the delivery audit are both written before the send and neither
          // is retried, so a send that cannot finish loses the card — and
          // holding the tick open past its race window also loses the tick's
          // flush. The room checked here covers the CLAIM as well as the send
          // (see CARD_CLAIM_BUDGET_MS), because the claim is a round trip with
          // a cap larger than a late tick's tail. Deferring touches nothing
          // (no claim, no audit, no failure record) and the re-eval pool
          // re-pushes the coin on the next tick.
          const claimDeadline = cardClaimDeadline(startedAt, Date.now());
          if (claimDeadline === null) {
            deferCard("no slice left for the claim plus the send");
            return;
          }
          this.markPhase(diag, "send:claim", startedAt);
          // Bounded, and self-releasing if abandoned (see boundClaim).
          const claimed = await boundClaim(
            this.db.claimTokenPush(c.chatId, c.profile.tokenAddress),
            claimDeadline - Date.now(),
            () => this.db.unclaimTokenPush(c.chatId, c.profile.tokenAddress),
          );
          if (claimed === null) {
            deferCard("claim exceeded its slice");
            return;
          }
          if (!claimed) {
            return;
          }
          // The claim's round trip comes out of the same slice, so the
          // deadline is re-read after it: a slice that has gone in the
          // meantime gives the claim back instead of burning a zero-length
          // send (and a false delivery-failure record) on it.
          const sendDeadline = cardSendDeadline(startedAt, Date.now());
          if (sendDeadline === null) {
            try {
              await this.db.unclaimTokenPush(c.chatId, c.profile.tokenAddress);
            } catch {
              /* best-effort */
            }
            deferCard("claim round trip used the whole slice");
            return;
          }
          try {
            // Bounded by the card-send tail (see CARD_SEND_TAIL_MS): a
            // null here means the send missed its slice, and the
            // caller's failure path releases the claim so the coin is
            // retried.
            this.markPhase(diag, "send:telegram", startedAt);
            const sent = await this.bestEffort(
              () =>
                this.bot.api.sendMessage(c.chatId, message, {
                  reply_markup: {
                    inline_keyboard: tradeKeyboard(
                      tokenAddress,
                      this.trade ? this.trade.buySizeLabel : "",
                      tradeMode,
                      { modeSwitch: Boolean(this.trade), unwatch: true },
                    ),
                  },
                }),
              sendDeadline,
              null,
            );
            if (sent === null) {
              const cut = new Error(
                `initial-card send exceeded its deadline (card may not have been delivered)`,
              ) as Error & { cardSendTimeout?: boolean };
              // Tagged so the delivery retry below does NOT sleep 1200ms and
              // re-send inside a tick that has already run out of room.
              cut.cardSendTimeout = true;
              throw cut;
            }
            // Delivery audit: Telegram returned a message_id, so the card
            // left us and was accepted. Recording it lets a later "never
            // got the first card" report be answered with hard evidence.
            try {
              await this.db.recordPushDelivery({
                chatId: c.chatId,
                token: c.profile.tokenAddress,
                symbol: c.profile.symbol ?? c.pair.baseToken.symbol ?? null,
                messageId: Number(
                  (sent as { message_id?: unknown }).message_id ?? 0,
                ),
                mcapAtPush: c.pair.marketCap,
                kind: "initial",
              });
            } catch {
              /* audit is best-effort */
            }
          } catch (err) {
            // Release the claim: the caller's failure handling + the
            // chat-aware re-eval pool will retry on a later scan.
            try {
              await this.db.unclaimTokenPush(c.chatId, c.profile.tokenAddress);
            } catch {
              /* best-effort */
            }
            throw err;
          }
          // A deferred coin that reaches the send IS the make-up push the
          // deferral promised (see DeferredPushLedger).
          if (this.deferredPushes.recover(c.profile.tokenAddress)) {
            diag.deferRecovered = this.deferredPushes.recovered;
            diag.deferPending = this.deferredPushes.pendingCount;
          }
          pushed++;
          // Start post-push tracking (🚀/⚠️/💀 follow-ups). Best-effort and
          // deduped by the table's PK — never affects the push itself.
          try {
            this.markPhase(diag, "send:track", startedAt);
            await this.pushWatcher?.onPush(
              c.chatId,
              c.profile.tokenAddress,
              c.profile.symbol ?? c.pair.baseToken.symbol ?? null,
              c.pair.marketCap,
              c.pair.liquidity.usd,
            );
          } catch {
            /* tracking is optional */
          }
          // Auto trading mode: buy immediately after the push. The mode is
          // read live (a /setmode flip applies right away); executeBuy also
          // re-checks the mode gate internally. Dedupe is guaranteed twice
          // over — the coin is already in seen_tokens, and trade_log has
          // UNIQUE(token) — so a slow buy can never double-spend.
          this.markPhase(diag, "send:autobuy", startedAt);
          if (this.trade && (await this.trade.effectiveMode()) === "auto") {
            await this.autoBuy(c);
          }
        };
        this.markPhase(diag, "send", startedAt);
        for (const c of unseen) {
          // Re-check right before sending: a concurrent scan (rare, only
          // when a scan outlives the 1-min cron) could have pushed it
          // meanwhile, or a previous tick's retry may have landed.
          // Failure degrades to "not seen" — the claim inside sendTo is what
          // actually prevents a duplicate card.
          try {
            if (await this.db.isTokenSeen(c.chatId, c.profile.tokenAddress)) {
              continue;
            }
          } catch (err) {
            diag.dbDegraded = "seen-read";
            console.error(
              "[scanner] delivery seen-check failed — treating as unseen:",
              err instanceof Error ? err.message : err,
            );
          }
          const symbol = c.profile.symbol ?? c.pair.baseToken.symbol ?? c.profile.tokenAddress;
          try {
            await sendTo(c);
          } catch (err) {
            // A failed delivery is NOT the end: surface the Telegram error
            // (code + description, recorded per chat for /debug/chats) and
            // retry once on transient failures (429 / 5xx / network). The
            // chat-aware re-eval pool re-pushes the coin to this chat on a
            // later scan either way — never mark it seen on failure.
            const info = describePushError(err);
            await this.recordPushFailure(c.chatId, c.profile.tokenAddress, info);
            console.error(
              `[scanner] failed to push ${symbol} to ${c.chatId}: ${info.line}`,
            );
            // A send cut by the deadline is NOT retried inside this tick:
            // there is no room left by definition, and the 1200ms sleep would
            // only push the completion flush past the race window. The claim
            // was released, so the next tick's re-eval pool re-pushes it.
            if (info.transient && !(err as { cardSendTimeout?: boolean }).cardSendTimeout) {
              await sleep(1200);
              try {
                if (await this.db.isTokenSeen(c.chatId, c.profile.tokenAddress)) {
                  continue;
                }
              } catch (err) {
                diag.dbDegraded = "seen-read";
                console.error(
                  "[scanner] retry seen-check failed — treating as unseen:",
                  err instanceof Error ? err.message : err,
                );
              }
              try {
                await sendTo(c);
              } catch (retryErr) {
                const retryInfo = describePushError(retryErr);
                await this.recordPushFailure(c.chatId, c.profile.tokenAddress, retryInfo);
                console.error(
                  `[scanner] retry failed to push ${symbol} to ${c.chatId}: ${retryInfo.line}`,
                );
              }
            }
          }
        }
      }
      diag.pushed = pushed;
      diag.evalMs = Date.now() - evalStart;
      // The post-push tracker pass USED to run here, last, on whatever the
      // tick had left. It now runs in the worker's tick tail instead (see
      // Scanner.runTrackerPass and worker.TRACKER_PASS_BUDGET_MS): the scan's
      // own phases end at ~3.1s of a ~4.7s race window, so "whatever is left"
      // measured 400-1200ms and the rotation stalled at one row per pass —
      // and once the pass really used that allowance it also pushed the tick
      // past its race window. What the pass still needs from the scan is
      // already here: the pair phase above fetched this isolate's rotation
      // head (see lastHeadTokens), so the pass's own batch is a cache hit.
      console.log(
        `[scanner] scan done in ${Date.now() - startedAt}ms: ${profiles.length} profiles, ${scannedProfiles.length}/${poolProfiles.length} pooled, ${candidates.length} candidates, ${pushed} pushed` +
          (this.birdeye ? "" : " (Birdeye not configured)"),
      );
    } catch (err) {
      console.error(
        "[scanner] scan failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      clearTimeout(watchdog);
      // Ends the tick-scoped cap and yields the round trips' wall time.
      const scanDbMs = this.db.exitScanMode();
      // Only a still-current scan may publish summary/state; a timed-out scan
      // that eventually settles must not clobber a newer scan's results.
      if (seq === this.scanSeq) {
        // Flurry RPC spend is cumulative across ticks (isolate lifetime) —
        // surface it on every heartbeat so actual cost stays observable.
        const fs = this.flurry?.stats();
        diag.flurryRpcCalls = fs?.rpcCalls ?? 0;
        diag.flurryCacheHits = fs?.cacheHits ?? 0;
        diag.dbMs = scanDbMs;
        this.lastSummary = diag;
        this.lastSkip = null;
        this.running = false;
      }
    }
  }

  /**
   * Periodic Birdeye new_listing backfill (see runOnce call site). Returns
   * how many coins were newly seeded, or 0 when the interval hasn't elapsed
   * / Birdeye isn't configured / nothing new was found. Persists the last
   * run in worker_state so every isolate shares one cadence instead of each
   * re-running on recycle (CU protection).
   */
  private async runPeriodicBackfill(): Promise<number> {
    const birdeye = this.birdeye;
    if (!birdeye || !this.config.birdeyeBackfillEnabled) return 0;
    const cfg = this.config;
    const lastRaw = await this.db.getWorkerState("birdeye_backfill_at");
    const lastRunAt = lastRaw ? Number(lastRaw) : 0;
    const now = Date.now();
    if (Number.isFinite(lastRunAt) && now - lastRunAt < cfg.birdeyeBackfillIntervalMs) {
      return 0; // interval not elapsed
    }
    // Walk the lookback window backwards in 6h chunks (time_to must stay
    // within ~3 days). Each chunk returns the newest ~20 listings.
    const windowMs = cfg.birdeyeBackfillLookbackMs;
    const chunkSec = 6 * 3600;
    const toFloor = Math.floor(now / 1000);
    const fromFloor = Math.floor((now - windowMs) / 1000);
    const found: Array<{ address: string; createdAtSec: number | null }> = [];
    const seen = new Set<string>();
    for (let to = toFloor; to > fromFloor; to -= chunkSec) {
      let items: Array<{ address: string; createdAtSec: number | null }> = [];
      try {
        items = await birdeye.fetchNewListings(to, 20);
      } catch (err) {
        console.error(
          "[scanner] periodic backfill new_listing failed:",
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
    if (found.length === 0) {
      // Still mark the run so a permanently-empty feed doesn't re-trigger
      // every scan (and burn CU retrying).
      await this.db.setWorkerState("birdeye_backfill_at", String(now));
      return 0;
    }
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
    await this.db.recordTokenStatsMany(stats);
    await this.db.setWorkerState("birdeye_backfill_at", String(now));
    return stats.length;
  }

  /**
   * Auto-mode buy for a just-pushed coin. Bounded by a hard timeout so a
   * slow Trojan response can never wedge the tick; result is reported to the
   * chat. Errors are logged, never thrown (a failed buy must not fail the
   * scan).
   */
  private async autoBuy(coin: QualifyingCoin): Promise<void> {
    const token = coin.pair.baseToken.address;
    const symbol = coin.pair.baseToken.symbol || coin.profile.symbol || token.slice(0, 8);
    const t0 = Date.now();
    try {
      const outcome = await Promise.race([
        this.trade!.executeBuy(token, coin.chatId),
        new Promise<{
          decision: { ok: false; reason: string };
          result?: undefined;
        }>((resolve) =>
          setTimeout(
            () =>
              resolve({
                decision: { ok: false, reason: "超时（Trojan 无响应）" },
              }),
            this.config.trade.timeoutMs + 3_000,
          ),
        ),
      ]);
      const { decision, result } = outcome;
      const lines = ["🛒 自动买入", `🪙 ${symbol}`];
      if (!decision.ok) {
        lines.push(`⏭ 未下单: ${decision.reason}`);
      } else if (result && result.ok) {
        lines.push(`✅ 成功: ${this.trade!.amountSol} SOL`);
        if (result.txHash) lines.push(`🔗 tx: ${result.txHash}`);
      } else {
        lines.push(`❌ 失败: ${result?.error ?? "未知错误"}`);
      }
      lines.push(`⏱ ${Date.now() - t0}ms`);
      await this.bot.api.sendMessage(coin.chatId, lines.join("\n"));
    } catch (err) {
      console.error(
        `[scanner] auto-buy failed for ${symbol} (${token}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Resolve the coin's opening volume (display-only card field):
   *  1. cached exact value (computed on-chain before that computation was
   *     removed to save Helius credits — already-stored values still show),
   *  2. DexScreener proxy (m5 at first sight, when seen young),
   *  3. unknown → the card shows —（无法测量）.
   * The fresh on-chain computation (~150–250 Helius credits per coin) was
   * removed; Birdeye is also deliberately NOT consulted (its OHLCV endpoint
   * was the main free-tier budget burner).
   */
  /** Bundler + top-10 holder share + creator: cached → single RugCheck fetch → unknown. */
  private async resolveRugcheckData(coin: QualifyingCoin): Promise<{
    bundlerPct: number | null;
    top10Pct: number | null;
    creator: string | null;
  }> {
    const { stats } = coin;
    // Use the cache only while it is fresh. RugCheck keeps refining reports
    // after a token launches (e.g. late bundler detection), so re-fetch stale
    // reports instead of locking in an early "no bundlers" result forever.
    const fetchedAt = this.rugcheckFetchedAt.get(stats.token);
    const fresh =
      fetchedAt !== undefined && Date.now() - fetchedAt < RUGCHECK_REFRESH_MS;
    // Creator is a static token property — keep it in-memory across refetches
    // (the DB stores only the two percentages).
    const knownCreator = this.rugcheckCreator.get(stats.token) ?? null;
    if (stats.rugcheckTop10Pct !== null && fresh) {
      return {
        bundlerPct: stats.rugcheckBundlerPct,
        top10Pct: stats.rugcheckTop10Pct,
        creator: knownCreator,
      };
    }
    if (this.rugcheck) {
      try {
        const report = await this.rugcheck.getReport(
          stats.token,
          coin.pair.pairAddress,
        );
        this.rugcheckFetchedAt.set(stats.token, Date.now());
        if (report.creator) this.rugcheckCreator.set(stats.token, report.creator);
        await this.db.updateTokenRugcheckData(
          stats.token,
          report.bundlerPct,
          report.top10HolderPct,
        );
        stats.rugcheckBundlerPct = report.bundlerPct;
        stats.rugcheckTop10Pct = report.top10HolderPct;
        return {
          bundlerPct: report.bundlerPct,
          top10Pct: report.top10HolderPct,
          creator: report.creator ?? knownCreator,
        };
      } catch (err) {
        console.error(
          `[scanner] RugCheck lookup failed for ${stats.token}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Fetch failed or no client: fall back to whatever is cached rather than
    // treating a known report as unknown.
    if (stats.rugcheckTop10Pct !== null) {
      return {
        bundlerPct: stats.rugcheckBundlerPct,
        top10Pct: stats.rugcheckTop10Pct,
        creator: knownCreator,
      };
    }
    return { bundlerPct: null, top10Pct: null, creator: knownCreator };
  }

  /**
   * On-chain supply-flow (rug/distribution) verdict for a coin:
   *  1. fresh cached result (token_stats.supply_flow, refreshed every
   *     refreshMs),
   *  2. live analysis via Helius (getTokenLargestAccounts + gTFA
   *     out-transfers — ~1-3s, budget-guarded),
   *  3. hold — analysis pending or failed. The coin is NOT blocked: it
   *     pushes anyway with the card showing 未分析 (the detector is
   *     best-effort — only a confirmed flag blocks). The 5-min negative
   *     cache + Helius circuit breaker keep a down endpoint from stalling
   *     the tick.
   * Returns "unknown" when the check is disabled or Helius is not
   * configured — also pushes with the card showing 未分析.
   */
  private async resolveSupplyFlow(
    coin: QualifyingCoin,
    tickDeadline: number,
  ): Promise<
    | { status: "clean"; result: SupplyFlowResult }
    | { status: "flagged"; result: SupplyFlowResult }
    | { status: "hold" }
    | { status: "unknown" }
  > {
    const { stats, pair } = coin;
    const cfg = this.config.supplyFlow;
    if (!cfg.enabled || !this.config.heliusApiKey) return { status: "unknown" };

    // Fresh cache → reuse (avoids re-analyzing the same coin every minute).
    if (stats.supplyFlowJson && stats.supplyFlowAt !== null) {
      try {
        const parsed = JSON.parse(stats.supplyFlowJson) as SupplyFlowResult;
        if (Date.now() - stats.supplyFlowAt < cfg.refreshMs) {
          return parsed.flagged
            ? { status: "flagged", result: parsed }
            : { status: "clean", result: parsed };
        }
      } catch {
        // stale/corrupt cache → re-analyze
      }
    }
    // Recent empty/failed lookups: back off instead of hammering Helius.
    if (this.dataNegativeCached(stats.token)) return { status: "hold" };
    // Budget guard: the analysis makes ~10 RPC calls; only start it when it
    // can finish within the tick deadline, else defer to the next tick.
    // The FLOOR (not cfg.budgetMs — see SUPPLY_FLOW_MIN_START_MS) is what
    // makes the gate actually run at all: against the configured 15s budget
    // and a ~4.2s scan deadline this check was true for every coin, i.e. the
    // gate was silently dead and every card showed 未分析. The hard cap below
    // is clamped to the tick's remaining time, so the analysis can never
    // outlive the wall the worker enforces.
    const flowBudgetMs = Math.min(
      cfg.budgetMs,
      Math.max(0, tickDeadline - Date.now()),
    );
    if (flowBudgetMs < SUPPLY_FLOW_MIN_START_MS) return { status: "hold" };

    try {
      const price = Number(pair.priceUsd);
      const supply = Number.isFinite(price) && price > 0 ? pair.marketCap / price : 0;
      if (supply <= 0) return { status: "hold" };
      const result = await Promise.race([
        this.helius!.analyzeSupplyFlow(stats.token, pair.pairAddress, supply, {
          windowMs: cfg.windowMs,
          minFeeders: cfg.minFeeders,
          minFedPct: cfg.minFedPct,
          minSells: cfg.minSells,
          topAccounts: cfg.topAccounts,
          checkInflow: cfg.checkInflow,
          now: Date.now(),
        }),
        // Hard cap: a slow/stuck gTFA must not wedge the tick — treat as
        // pending and retry next tick (nothing is lost, the coin stays held).
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
                windowMs: cfg.windowMs,
              }),
            flowBudgetMs,
          ),
        ),
      ]);
      if (!result.ok) return { status: "hold" };
      this.dataFailedAt.delete(stats.token);
      const json = JSON.stringify(result);
      await this.db.updateTokenSupplyFlow(stats.token, json);
      stats.supplyFlowJson = json;
      stats.supplyFlowAt = result.analyzedAt;
      return result.flagged
        ? { status: "flagged", result }
        : { status: "clean", result };
    } catch (err) {
      this.dataFailedAt.set(stats.token, Date.now());
      console.error(
        `[scanner] supply-flow lookup failed for ${stats.token}:`,
        err instanceof Error ? err.message : err,
      );
      return { status: "hold" };
    }
  }

  /** Append a post-match rejection to the scan summary (bounded). */
  private addReject(
    diag: ScanSummary,
    coin: QualifyingCoin,
    reason: string,
  ): void {
    if (diag.rejects.length >= REJECT_LOG_MAX) return;
    const pair = coin.pair;
    const ageMs = Date.now() - pair.pairCreatedAt;
    diag.rejects.push({
      symbol: pair.baseToken.symbol || coin.profile.symbol || "?",
      ageMin: Math.round(ageMs / 60_000),
      mcapUsd: Math.round(pair.marketCap),
      vol5Usd: Math.round(pair.volume.m5),
      chgPct: Math.round(pair.priceChange.m5 * 10) / 10,
      reason,
    });
  }

  /** Pro-trader count + sniper buy share: cached → single Birdeye fetch → unknown. */
  private async resolveTraderData(coin: QualifyingCoin): Promise<{
    proTraders: number | null;
    sniperPct: number | null;
  }> {
    const stats = coin.stats;
    // Both metrics come from the same fetch; only trust the cache when both
    // are known, so a partially-fetched result never locks in a null.
    if (stats.birdeyeProTraders !== null && stats.birdeyeSniperPct !== null) {
      return {
        proTraders: stats.birdeyeProTraders,
        sniperPct: stats.birdeyeSniperPct,
      };
    }
    if (this.birdeye && !this.dataNegativeCached(stats.token)) {
      try {
        const info = await this.birdeye.getTraderInfo(
          stats.token,
          coin.pair.marketCap,
          coin.pair.priceUsd,
        );
        if (info.proTraders !== null && info.sniperPct !== null) {
          this.dataFailedAt.delete(stats.token);
          await this.db.updateTokenProTraders(stats.token, info.proTraders);
          await this.db.updateTokenSniperPct(stats.token, info.sniperPct);
          stats.birdeyeProTraders = info.proTraders;
          stats.birdeyeSniperPct = info.sniperPct;
        } else {
          // Trader data not available yet: back off instead of re-querying
          // the same coin on every scan.
          this.dataFailedAt.set(stats.token, Date.now());
        }
        return info;
      } catch (err) {
        this.dataFailedAt.set(stats.token, Date.now());
        console.error(
          `[scanner] Birdeye trader lookup failed for ${stats.token}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { proTraders: null, sniperPct: null };
  }

  /**
   * Holder count (Birdeye token overview) — the card's holders line.
   * Best-effort with the same 5-min negative cache: a failure degrades to
   * "—" on the card, never blocks or slows the push. Only fetched for
   * qualifying candidates, so the 20 CU/request cost is negligible at the
   * current push volume.
   */
  private async resolveHolderCount(coin: QualifyingCoin): Promise<{
    holderCount: number | null;
  }> {
    const mint = coin.pair.baseToken.address;
    if (!this.birdeye || this.dataNegativeCached(mint)) {
      return { holderCount: null };
    }
    try {
      const info = await this.birdeye.getTokenOverview(mint);
      if (info.holderCount === null) {
        // No holder data back — back off instead of re-querying the same
        // coin on every scan.
        this.dataFailedAt.set(mint, Date.now());
      } else {
        this.dataFailedAt.delete(mint);
      }
      return { holderCount: info.holderCount };
    } catch (err) {
      this.dataFailedAt.set(mint, Date.now());
      console.error(
        `[scanner] Birdeye overview lookup failed for ${mint}:`,
        err instanceof Error ? err.message : err,
      );
      return { holderCount: null };
    }
  }

  /**
   * Re-eval pool with an in-memory TTL cache (see config.reevalPoolCacheMs):
   * the query is the scan's dominant Turso rows-read consumer, and its
   * result changes only slowly, so cache hits skip the DB entirely. The
   * cache key is the TTL alone — the since/launch bounds slide with `now`
   * and therefore differ on every call, so comparing them (as the first
   * version did) made the cache NEVER hit and the pool query ran on every
   * scan (a 2-min TTL advertised, 0 achieved). A stale pool is harmless:
   * the push path re-checks isTokenSeen from the DB before sending, and
   * newly discovered feed coins are evaluated via feedProfiles anyway.
   */
  private reevalPoolCache: {
    at: number;
    stats: TokenStats[];
  } | null = null;
  private async getReevalPoolCached(
    now: number,
    opts: {
      sinceMs: number;
      minLaunchMs: number;
      maxLaunchMs: number;
      windowEntryLaunchMs: number;
      limit: number;
      nearSlots?: number;
      farSlots?: number;
      rotationPeriodMs?: number;
      minQualifyMcap?: number;
      maxQualifyMcap?: number;
      minQualifyLiquidity?: number;
      seenChatIds?: string[];
    },
  ): Promise<TokenStats[]> {
    if (this.reevalPoolCache && now - this.reevalPoolCache.at < this.config.reevalPoolCacheMs) {
      return this.reevalPoolCache.stats;
    }
    const stats = await this.db.getReevalPool(opts);
    this.reevalPoolCache = { at: now, stats };
    return stats;
  }

  /**
   * Axiom trending with access-token lifecycle: uses the token persisted by
   * /debug/axiom-tokens (worker_state `axiom_access_token`); on a
   * refreshable failure (auth rejection OR a 5xx from the sharded trending
   * hosts, which is what an invalid/expired token actually produces) it
   * refreshes once via `axiom_refresh_token` and persists whatever comes
   * back (access + rotated refresh). A cooldown prevents hammering the
   * refresh endpoint when the API itself is down. Returns [] when not
   * logged in or when refresh fails (re-login via /debug/axiom-tokens
   * needed). Never throws to the caller — feed failures degrade to the
   * other discovery sources.
   */
  private lastAxiomRefreshAt = 0;
  private async fetchAxiomTrending(): Promise<AxiomTrendingToken[]> {
    const accessToken = await this.db.getWorkerState("axiom_access_token");
    if (!accessToken) return [];
    try {
      return await this.axiom!.fetchTrending(
        accessToken,
        "1h",
        this.config.axiomTrendingLimit,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const authFailure = /auth/i.test(msg);
      // 5xx from every trending host is also refresh-worthy: Axiom's shards
      // answer 502 to an invalid/expired access token (measured 2026-08-16),
      // so a plain 5xx can mean the token died, not the API.
      const refreshable = authFailure || /HTTP 50[0-9]/.test(msg);
      if (!refreshable) {
        // 429 / other: skip this round, keep the token (it's still valid);
        // the next scan retries the same token.
        console.error(
          "[scanner] axiom trending fetch failed (non-refreshable):",
          msg,
        );
        return [];
      }
      const now = Date.now();
      if (now - this.lastAxiomRefreshAt < AXIOM_REFRESH_COOLDOWN_MS) {
        console.error(
          "[scanner] axiom refresh cooldown active — skipping refresh this round:",
          msg,
        );
        return [];
      }
      this.lastAxiomRefreshAt = now;
      const refreshToken = await this.db.getWorkerState("axiom_refresh_token");
      if (!refreshToken) {
        console.error(
          "[scanner] axiom access token rejected and no refresh token — re-login via /debug/axiom-tokens",
        );
        return [];
      }
      try {
        const fresh = await this.axiom!.refreshAccessToken(refreshToken);
        if (!fresh || !fresh.accessToken) {
          console.error(
            "[scanner] axiom refresh returned no token — re-login via /debug/axiom-tokens",
          );
          return [];
        }
        await this.db.setWorkerState("axiom_access_token", fresh.accessToken);
        // Persist a rotated refresh token when the API issues one (the SDK
        // keeps the old one otherwise — both are safe to store).
        if (fresh.refreshToken) {
          await this.db.setWorkerState("axiom_refresh_token", fresh.refreshToken);
        }
        return await this.axiom!.fetchTrending(
          fresh.accessToken,
          "1h",
          this.config.axiomTrendingLimit,
        );
      } catch (refreshErr) {
        console.error(
          "[scanner] axiom token refresh failed — re-login via /debug/axiom-tokens:",
          refreshErr instanceof Error ? refreshErr.message : refreshErr,
        );
        return [];
      }
    }
  }

  /**
   * GMGN enrichment for one candidate: smart money, holders, wash-trading
   * flag. Best-effort — any failure/empty result negative-caches the coin
   * (5 min) and degrades to no enrichment; the push is only blocked when a
   * confirmed wash-trading flag comes back and blocking is enabled.
   */
  /**
   * Axiom bot-users count for one candidate pair (/token-info?pairAddress).
   * Best-effort: null on any failure or missing data so the gate never
   * judges. On an auth error, does ONE cooldown-guarded refresh then
   * retries once — same discipline as the trending feed (unconditional
   * refreshes rotate and burn the session).
   */
  private async resolveAxiomBotUsers(
    pairAddress: string,
  ): Promise<number | null> {
    if (!this.axiom) return null;
    const call = (accessToken: string) =>
      this.axiom!.fetchTokenInfo(
        accessToken,
        pairAddress,
        "/token-info-v2",
        "pairAddress",
      );
    const extract = (data: Record<string, unknown> | null): number | null => {
      const n = Number(data?.numBotUsers);
      return Number.isFinite(n) ? n : null;
    };
    const storedToken = await this.db.getWorkerState("axiom_access_token");
    if (!storedToken) return null;
    try {
      const out = await call(storedToken);
      return extract(out.data);
    } catch (err) {
      // Only a rejected session is worth a refresh; everything else
      // (network blip, 404, parse) just degrades to "no data".
      const msg = err instanceof Error ? err.message : String(err);
      if (!/auth/.test(msg)) return null;
      const now = Date.now();
      if (now - this.lastAxiomRefreshAt < AXIOM_REFRESH_COOLDOWN_MS) {
        return null;
      }
      this.lastAxiomRefreshAt = now;
      const refreshToken = await this.db.getWorkerState("axiom_refresh_token");
      if (!refreshToken) return null;
      try {
        const fresh = await this.axiom!.refreshAccessToken(refreshToken);
        if (!fresh || !fresh.accessToken) return null;
        await this.db.setWorkerState("axiom_access_token", fresh.accessToken);
        if (fresh.refreshToken) {
          await this.db.setWorkerState("axiom_refresh_token", fresh.refreshToken);
        }
        const out = await call(fresh.accessToken);
        return extract(out.data);
      } catch {
        return null;
      }
    }
  }
  private async resolveGmgnInfo(
    coin: QualifyingCoin,
  ): Promise<GmgnTokenInfo | null> {
    if (!this.gmgn) return null;
    const mint = coin.pair.baseToken.address;
    if (this.dataNegativeCached(mint)) return null;
    try {
      const info = await this.gmgn.fetchTokenInfo(mint);
      const empty =
        info === null ||
        (info.smartWallets === null &&
          info.holderCount === null &&
          info.isWashTrading === null);
      if (empty) {
        this.dataFailedAt.set(mint, Date.now());
        return null;
      }
      this.dataFailedAt.delete(mint);
      return info;
    } catch (err) {
      this.dataFailedAt.set(mint, Date.now());
      console.error(
        `[scanner] GMGN lookup failed for ${mint}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Arkham smart-money attribution for one candidate: entity types of the
   * top-100 holders, shown on the card. Best-effort — any failure/empty
   * result negative-caches the coin (5 min) and degrades to no enrichment.
   */
  private async resolveArkhamInfo(
    coin: QualifyingCoin,
  ): Promise<ArkhamTokenHolders | null> {
    if (!this.arkham) return null;
    const mint = coin.pair.baseToken.address;
    if (this.dataNegativeCached(mint)) return null;
    try {
      const holders = await this.arkham.fetchTokenHolders(mint);
      const empty = holders === null || holders.holderCount === 0;
      if (empty) {
        this.dataFailedAt.set(mint, Date.now());
        return null;
      }
      this.dataFailedAt.delete(mint);
      return holders;
    } catch (err) {
      this.dataFailedAt.set(mint, Date.now());
      console.error(
        `[scanner] Arkham lookup failed for ${mint}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  private matchCoins(
    profiles: TokenProfile[],
    pairsByToken: Map<string, PairInfo>,
    statsByToken: Map<string, TokenStats>,
    chats: {
      chatId: string;
      minLiquidityUsd: number;
      minVolume24hUsd: number;
      minMarketCapUsd: number;
      maxMarketCapUsd: number;
      minAgeMinutes: number;
      maxAgeMinutes: number;
      min5mVolUsd: number;
      min1hVolUsd: number;
      min5mChgPct: number;
      min1hChgPct: number;
    }[],
    fails: ScanSummary["fails"],
    rejects: RejectionEntry[],
    agedEval: { count: number },
    /**
     * Reject-log budget split (see rejectBudgetBeforeEval at the call site):
     * `poolStartIdx` marks where the pool slice begins inside `profiles`, and
     * feed coins may log only into the first `feedBudgetStart` slots (the
     * leftover after the pool's guaranteed share) — otherwise the feed's
     * fresh bonding-curve coins (all "流动性 ~$0") flood the bounded list
     * before any pool coin is logged and zero-push stretches look
     * unexplained on /health.
     */
    logBudget?: { feedBudgetStart: number; poolStartIdx: number },
  ): QualifyingCoin[] {
    const out: QualifyingCoin[] = [];
    for (let pi = 0; pi < profiles.length; pi++) {
      const profile = profiles[pi]!;
      const pair = pairsByToken.get(profile.tokenAddress);
      if (!pair) continue;
      const stats = statsByToken.get(profile.tokenAddress);
      if (!stats) continue;
      // Comparable-only (see gateLiquidityUsd): a Jupiter/Gecko pair's number
      // is a different metric of the same pool, so it must not face these
      // absolute USD rules. null = leave both unjudged for this tick.
      const liquidityUsd = gateLiquidityUsd(pair);
      const volume24h = pair.volume.h24;
      const ageMs = Date.now() - pair.pairCreatedAt;
      // Log the coin's first failing gate for this chat (bounded — the feed
      // + pool can be 60+ coins, but 50 entries keep the heartbeat small).
      const reject = (reason: string) => {
        if (rejects.length >= REJECT_LOG_MAX) return;
        // Pool coins always log (up to the cap); feed coins may occupy only
        // the first feedBudgetStart slots — the leftover after the pool
        // slice's guaranteed share — so the feed's fresh bonding-curve coins
        // cannot flood the list before any pool coin is logged.
        if (
          logBudget &&
          pi < logBudget.poolStartIdx &&
          rejects.length >= logBudget.feedBudgetStart
        )
          return;
        rejects.push({
          symbol: pair.baseToken.symbol || profile.symbol || "?",
          ageMin: Math.round(ageMs / 60_000),
          mcapUsd: Math.round(pair.marketCap),
          vol5Usd: Math.round(pair.volume.m5),
          chgPct: Math.round(pair.priceChange.m5 * 10) / 10,
          reason,
        });
      };

      for (const chat of chats) {
        if (liquidityUsd !== null && liquidityUsd < chat.minLiquidityUsd) {
          fails.other++;
          reject(`流动性 ${fmtUsd(liquidityUsd)} < ${fmtUsd(chat.minLiquidityUsd)}`);
          continue;
        }
        if (volume24h < chat.minVolume24hUsd) {
          fails.other++;
          reject(`24h量 ${fmtUsd(volume24h)} < ${fmtUsd(chat.minVolume24hUsd)}`);
          continue;
        }
        if (pair.marketCap < chat.minMarketCapUsd) {
          fails.mcap++;
          reject(`市值 ${fmtUsd(pair.marketCap)} < ${fmtUsd(chat.minMarketCapUsd)}`);
          continue; // too small
        }
        if (pair.marketCap > chat.maxMarketCapUsd) {
          fails.mcap++;
          reject(`市值 ${fmtUsd(pair.marketCap)} > ${fmtUsd(chat.maxMarketCapUsd)}`);
          continue; // too big — mid-cap range only
        }
        // Valuation vs pool depth sanity: a price that ran up far beyond its
        // pooled liquidity is manipulable and nearly un-exitable (see the
        // helper's calibration notes). Global knob, 0 = off.
        // null = the coin came from a leg this ratio cannot judge (see
        // gateLiquidityUsd); stay fail-open rather than block a healthy coin
        // on a number that is a different metric of the same pool.
        const ratioReason =
          liquidityUsd === null
            ? null
            : mcapRatioBlockReason(
                pair.marketCap,
                liquidityUsd,
                this.config.mcapLiqRatioMax,
              );
        if (ratioReason) {
          fails.other++;
          reject(ratioReason);
          continue;
        }
        if (ageMs < chat.minAgeMinutes * 60_000) {
          fails.age++;
          reject(`上線 ${Math.round(ageMs / 60_000)}m < ${chat.minAgeMinutes}m`);
          continue; // too fresh
        }
        if (ageMs > chat.maxAgeMinutes * 60_000) {
          fails.age++;
          reject(`上線 ${Math.round(ageMs / 60_000)}m > ${chat.maxAgeMinutes}m`);
          continue; // too old
        }
        // Reached the age gate in-window (age ≥ min) — count these so /health
        // can prove in-window coins are evaluated each scan, not silently
        // skipped (per-chat count, consistent with the fails counters).
        agedEval.count++;
        // Dual-path momentum gate — a coin qualifies through EITHER tape:
        //   Path A (hot 5m):     5m vol >= floor AND 5m chg >= threshold
        //   Path B (steady 1h):  1h vol >= floor AND 1h chg >= threshold
        // Volume and change must co-qualify on the SAME path: a thin-tape
        // pump (change without volume) and a busy flat tape (volume without
        // change) are both noise.
        const vol5Ok = pair.volume.m5 >= chat.min5mVolUsd;
        const chg5Ok = pair.priceChange.m5 >= chat.min5mChgPct;
        const vol1hOk = pair.volume.h1 >= chat.min1hVolUsd;
        const chg1hOk = pair.priceChange.h1 >= chat.min1hChgPct;
        if (!(vol5Ok && chg5Ok) && !(vol1hOk && chg1hOk)) {
          fails.chg++;
          const mark = (ok: boolean) => (ok ? "✓" : "✗");
          reject(
            `動能不足：5m路徑[量${mark(vol5Ok)} ${fmtUsd(pair.volume.m5)} 漲${mark(chg5Ok)} ${pair.priceChange.m5.toFixed(0)}%] ` +
            `1h路徑[量${mark(vol1hOk)} ${fmtUsd(pair.volume.h1)} 漲${mark(chg1hOk)} ${pair.priceChange.h1.toFixed(0)}%]`,
          );
          continue;
        }
        out.push({
          chatId: chat.chatId,
          profile,
          pair,
          stats,
        });
      }
    }
    return out;
  }
}
