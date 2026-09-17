import type { AppConfig } from "./config";
import type { Db } from "./db";
import type { BirdeyeClient } from "./birdeye";
import { fmtUsd } from "./format";
import { tradeKeyboard } from "./bot";

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
 * Wall-clock slice the post-push tracker pass may use INSIDE one scan tick.
 * The tracker is awaited by the scanner in its front-phase window (right
 * after the discovery feeds, before the re-eval pool read and the pair
 * fetch), so an unbounded pass starves everything behind it — 2026-09-12
 * live: trackerMs 4556 on a slow-Turso tick, after which that tick's pool
 * slice was never evaluated (timeout row, agedEval 0). Its alerts are
 * hour-scale follow-ups while the qualifying momentum windows are minutes
 * long, so a clamped remainder simply runs on the next tick (rows are
 * re-claimed then and nothing is lost — see the checks in runTick).
 *
 * 2026-09-17 (zero-row fix): 500 → 1000. At 500ms the pass had NO usable
 * row allowance at all: its mandatory stages (recap/prune, the self-heal
 * scan, one DexScreener batch for the watched tokens, then the row loop)
 * come to ~550–700ms on a healthy tick, so the loop hit its first budget
 * check already past the deadline, broke immediately, and returned
 * `checked:0, alerted:0` with no note — indistinguishable in /health from a
 * tick with nothing to watch. Live proof: 33 tracked rows, 28 of them
 * ACTIVE, `pushWatch: "ok:0/0"` on every tick, and not one row carrying a
 * tracker write (peak/lastMcap/lastVol5m all still at their insert values)
 * — post-push monitoring had stopped entirely while looking healthy. The
 * budget now covers the batch (TRACKER_PAIRS_BUDGET_MS) PLUS ≥400ms of row
 * work, and the loop never skips its first row, so progress per tick is
 * structurally guaranteed instead of depending on how fast DexScreener
 * answered. Sized as the tracker's SHARE of the scanner's front-phase
 * window (feed 600 + tracker 1000 + pool read 600 + pair fetch 1250 against
 * the 2600ms front window and the 4.2s internal deadline): the front phases
 * individually clamp to that window, so an oversubscribed worst case only
 * shortens the LATER phases — the gate/push reserve is untouched, and a
 * healthy tick (feeds ~450ms, tracker ~700ms, pool ~150ms) never comes
 * close.
 */
const TRACKER_TICK_BUDGET_MS = 1_000;
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
 * Service wrapper: owns the per-tick refresh loop and the Telegram delivery.
 * All network/db work is best-effort — a tracker failure must never affect
 * the scan or a push.
 */
export class PushWatcher {
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
     * Coverage/skip reason. Present whenever work was skipped — including
     * `rows 0/28 …` for a pass that evaluated nothing (previously omitted
     * exactly in the starvation case).
     */
    note?: string;
  }> {
    const cfg = this.config.pushWatch;
    const now = Date.now();
    const budgetMs =
      typeof deadlineMs === "number" && Number.isFinite(deadlineMs)
        ? Math.max(0, Math.min(TRACKER_TICK_BUDGET_MS, deadlineMs - now))
        : TRACKER_TICK_BUDGET_MS;
    const deadline = now + budgetMs;
    const past = () => Date.now() > deadline;
    const deferred = { checked: 0, alerted: 0, note: "deferred:tick-budget" };
    // Case-closed recaps: every coin leaving the window gets ONE summary
    // card before the bulk prune deletes it. Best-effort send — a failed
    // delivery must never keep a dead row alive forever.
    const windowCutoff = now - cfg.windowHours * 3_600_000;
    try {
      const allRows = await this.db.listPushWatch(cfg.maxTracked);
      for (const r of allRows.filter(
        (x) => x.pushedAt < windowCutoff && x.lastState !== "unwatched",
      )) {
        try {
          // Claim first: overlapping ticks (deploy soft-switch) must not
          // deliver the same 🏁 card twice. Unwatched rows never claim.
          if (!(await this.db.markRecapClaimed(r.token))) continue;
          await this.bot.api.sendMessage(r.chatId, recapMessage(r));
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* listing failed — the prune below still runs */
    }
    await this.db.prunePushWatch(windowCutoff);
    // Budget gate BETWEEN stages: the recap/prune above is idempotent (a
    // recap claims its row as it sends), so bailing here costs only latency —
    // the remaining stages run on the next tick with fresh rows.
    if (past()) return deferred;
    // Heal missed enrollments: pushes recorded in seen_tokens but absent
    // from push_watch (an old pre-tracker isolate handled that scan, or the
    // process died between the push and the upsert). Seeded with the CURRENT
    // mcap as baseline — follow-ups measure from tracking start, not from
    // the original push moment. Extra DexScreener call only when something
    // is actually missing; a no-pair coin retries on the next tick.
    try {
      const missing = await this.db.findUntrackedPushes(
        now - cfg.windowHours * 3_600_000,
        10,
      );
      if (missing.length > 0) {
        const missPairs = await this.pairsFor(
          missing.map((m) => m.token),
          now + TRACKER_PAIRS_BUDGET_MS,
        );
        for (const m of missing) {
          const pair = missPairs.get(m.token);
          if (!pair) continue;
          // A RECENTLY-claimed coin with no initial-card audit entry means
          // the sending isolate died between claim and send (deploy
          // eviction — XST/GLITCH/Félicette/RING): the card never reached
          // Telegram, so re-send it instead of silently enrolling tracking
          // for a push nobody saw. Older unaudited pushes predate the audit
          // ring and were delivered normally — keep silent enrollment.
          const recentClaim = now - m.pushedAt <= FIRST_CARD_RESEND_GRACE_MS;
          let resent = false;
          if (recentClaim && !(await this.db.hasInitialPushAudit(m.token))) {
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
              const sent = await this.bot.api.sendMessage(m.chatId,
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
                      await this.tradeMode(),
                      { modeSwitch: this.hasTrade(), unwatch: true },
                    ),
                  },
                },
              );
              resent = true;
              try {
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
          await this.db.upsertPushWatch({
            token: m.token,
            chatId: m.chatId,
            symbol: pair.baseToken.symbol ?? null,
            pushedAt: m.pushedAt,
            mcapAtPush: pair.marketCap,
            liquidityUsd: pair.liquidity.usd ?? null,
          });
          if (resent) continue; // fresh card just went out — skip holder seed noise
        }
      }
    } catch {
      /* healing is best-effort */
    }
    if (past()) return deferred;
    const rows = await this.db.listPushWatch(cfg.maxTracked);
    // Only rug (drained LP) rows are terminal: kept so the self-heal does
    // not re-enroll them, and skipped here. Dead rows stay ACTIVE but the
    // rules engine keeps them silent until a resurrection.
    const activeRows = rows.filter(
      (r) => r.lastState !== "rug" && r.lastState !== "unwatched",
    );
    if (activeRows.length === 0)
      return {
        checked: 0,
        alerted: 0,
        note: rows.length === 0 ? "no-rows" : "all-terminal",
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
    // One DexScreener batch covers the whole watch list (≤30 addresses) —
    // capped so it cannot eat the row allowance (see TRACKER_PAIRS_BUDGET_MS).
    const tokens = queue.map((r) => r.token).slice(0, 30);
    let pairs = new Map<string, import("./dexscreener").PairInfo>();
    try {
      pairs = await this.pairsFor(tokens, now + TRACKER_PAIRS_BUDGET_MS);
    } catch (err) {
      // feed down — retry next tick; surface the reason via the heartbeat.
      return {
        checked: 0,
        alerted: 0,
        note: `pairs-failed:${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`,
      };
    }

    let checked = 0;
    let alerted = 0;
    let backfilled = 0;
    let pairMiss = 0;
    let claimLost = 0;
    let budgetCut = false;
    let firstRow = true;
    for (const row of queue) {
      // Budget check BETWEEN rows: the claim and the alert reservation for a
      // row both happen after this point, so leaving a row to the next tick
      // can never drop an alert (it is re-claimed and re-evaluated then).
      // The FIRST row is never skipped: when the front stages (recap/prune,
      // self-heal, pair batch) run long, breaking here is what silently
      // stopped all post-push monitoring — the pass reported `ok:0/0` with no
      // note while 28 active rows went unrefreshed (2026-09-17). One row per
      // tick is the floor that keeps the tracker moving no matter what
      // DexScreener or Turso are doing.
      if (!firstRow && past()) {
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
        pairMiss += 1;
        const lastSeen = Math.max(row.pushedAt, row.lastChecked);
        if (now - lastSeen > 2 * 3_600_000) await this.db.deletePushWatch(row.token);
        continue;
      }
      // Cross-isolate claim: only one concurrent tick may alert this row.
      // The loser's snapshot is stale — it would re-fire state-machine
      // transitions (duplicate ⚠️/🚀 cards). Skip silently on lost race.
      if (!(await this.db.claimPushWatch(row.token, row.lastChecked, now))) {
        claimLost += 1;
        continue;
      }
      checked += 1;
      const evalResult = evaluateWatch(
        row,
        now,
        {
          mcap: pair.marketCap,
          liquidity: pair.liquidity.usd,
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
      if (backfill) backfilled += 1;
      // Authoritative duplicate guard: reserve the state transition
      // BEFORE delivering. The last_checked claim alone cannot stop an
      // isolate that reads between this isolate's claim and its final
      // write — it inherits the claimed stamp but the pre-alert state.
      // Matching on (last_state, last_alert_at) makes exactly one
      // contender's UPDATE win; the loser skips delivery. Skipped entirely
      // on a backfill pass, which sends nothing.
      if (
        !backfill &&
        evalResult.alerts.length > 0 &&
        !(await this.db.reservePushWatchAlert(
          row.token,
          row.lastState ?? null,
          row.lastAlertAt ?? 0,
          evalResult.lastState ?? null,
          evalResult.lastAlertAt,
        ))
      ) {
        await this.db.updatePushWatchCheck(row.token, {
          peakMcap: evalResult.peakMcap,
          lastLiquidity: pair.liquidity.usd,
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
      for (const a of evalResult.alerts) {
        if (backfill) break;
        try {
          const sent = await this.bot.api.sendMessage(row.chatId, a.text);
          alerted += 1;
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
          console.error(
            `[push-watch] alert send failed for ${row.symbol ?? row.token}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      await this.db.updatePushWatchCheck(row.token, {
        peakMcap: evalResult.peakMcap,
        lastLiquidity: pair.liquidity.usd,
        lastVol5m: pair.volume.m5,
        // A backfill pass delivers nothing: the counters and the alert clock
        // stay where they were, while the PERSISTENT state markers land —
        // that is what keeps every already-crossed 🚀/w35/dead transition
        // from being re-announced, and what makes the next check report only
        // genuinely new information.
        followupsSent: backfill ? row.followupsSent : evalResult.followupsSent,
        lastState: evalResult.lastState,
        lastAlertAt: backfill ? row.lastAlertAt : evalResult.lastAlertAt,
        mcapAtPush: evalResult.resetBaselineMcap,
        // Roll the 📈 baseline forward — omitting this made every later
        // holder check re-fire against the stale push-time baseline
        // (BABYCATE 1,000 → 2,441 then 1,000 → 2,458).
        holdersAtPush: evalResult.resetBaselineHolders,
        upStages: evalResult.announcedUpStages,
        deadTroughMcap: evalResult.deadTroughMcap ?? null,
        sellDomStreak: evalResult.sellDomStreak,
        lastMcap: pair.marketCap,
      });
    }

    // Holder refresh (Birdeye CU-bounded): oldest-checked first, alive coins only.
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
        // batch rather than carry the tick past its front-phase window.
        if (past()) break;
        try {
          const overview = await this.birdeye.getTokenOverview(r.token);
          if (overview.holderCount !== null) {
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

    // Coverage note: present whenever any active row went unchecked OR a
    // stale row was absorbed, so a starved tracker can never again look like
    // a healthy `ok:0/0` in /health — the exact shape that hid the 2026-09-17
    // stop for hours. One line names every skip reason: tokens the batch did
    // not return (miss), cross-isolate claim races (lost), the pass running
    // out of budget before the rest of the rotation (budget-cut), and rows
    // whose first observation landed after a tracking gap (backfill).
    const skipped = activeRows.length - checked;
    const note =
      skipped <= 0 && backfilled === 0
        ? undefined
        : `rows ${checked}/${activeRows.length} pairs ${pairs.size}/${tokens.length}` +
          ` miss ${pairMiss} lost ${claimLost}${backfilled > 0 ? ` backfill ${backfilled}` : ""}` +
          `${budgetCut ? " budget-cut" : ""}`;

    return { checked, alerted, note };
  }
}
