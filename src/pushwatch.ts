import type { AppConfig } from "./config";
import type { Db } from "./db";
import type { BirdeyeClient } from "./birdeye";
import { fmtUsd } from "./format";

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

/** Rising-stage thresholds (%) above the push-time mcap → state suffix. */
const RISING_STAGES = [50, 100, 200, 400] as const;
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
/** Holder-growth stages (× push-time holders → state suffix). */
const HOLDER_STAGES = [10, 25, 50] as const;
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
}

export interface WatchAlert {
  kind:
    | "rising"
    | "weak"
    | "dead"
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
  /** New dead-state trough to persist (lower low while silent-watching). */
  deadTroughMcap?: number | null;
  /** New 🩸 streak count to persist. */
  sellDomStreak: number;
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
  // windows with sells outnumbering buys. Fires on the exact Nth streak
  // check — the streak must reset (buys recover) before it can re-arm, so
  // one episode = one alert. Runs OUTSIDE the cooldown gate: the streak
  // itself paces the alerting, and distribution is worth seeing promptly.
  const runupFromPushPct = (peakMcap / Math.max(row.mcapAtPush, 1) - 1) * 100;
  let sellDomStreak = row.sellDomStreak ?? 0;
  if (live.sellsH1 > 0 && live.buysH1 / live.sellsH1 < SELL_DOM_RATIO) {
    sellDomStreak += 1;
  } else {
    sellDomStreak = 0;
  }
  if (
    sellDomStreak === SELL_DOM_STREAK_NEEDED &&
    runupFromPushPct >= SELL_DOM_MIN_RUNUP_PCT
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
    const firedStages = new Set<string>();
    if (lastState?.startsWith("up")) firedStages.add(lastState);
    for (let i = RISING_STAGES.length - 1; i >= 0; i--) {
      const stage = RISING_STAGES[i];
      const state = `up${stage}`;
      if (chgSincePush >= stage && !firedStages.has(state)) {
        const bs =
          live.buysH1 + live.sellsH1 > 0
            ? `${(live.buysH1 / Math.max(live.sellsH1, 1)).toFixed(1)}:1`
            : "—";
        fire(
          "rising",
          `🚀 續漲 ${symbol} | 推送時 ${fmtUsd(row.mcapAtPush)} → ${fmtUsd(live.mcap)} (${pct(chgSincePush)}) | 峰值回撤 ${pct(drawdownFromPeak)} | 5m ${pct(live.chg5m)} | 買賣比 ${bs}(h1)`,
        );
        lastState = state;
        break; // one stage per cooldown window
      }
    }

    // Weak: meaningful runup then ≥35% off the peak.
    const runupPct = (row.peakMcap / Math.max(row.mcapAtPush, 1) - 1) * 100;
    if (
      drawdownFromPeak <= -WEAK_DRAWDOWN_PCT &&
      runupPct >= WEAK_MIN_RUNUP_PCT &&
      lastState !== "weak"
    ) {
      fire(
        "weak",
        `⚠️ 動能轉弱 ${symbol} | 峰值 ${fmtUsd(peakMcap)} → 現 ${fmtUsd(live.mcap)} (${pct(drawdownFromPeak)})`,
      );
      lastState = "weak";
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

    // Holder growth stages (Birdeye).
    if (row.holdersAtPush !== null && row.holdersLast !== null) {
      const growth = (row.holdersLast / Math.max(row.holdersAtPush, 1) - 1) * 100;
      for (let i = HOLDER_STAGES.length - 1; i >= 0; i--) {
        const stage = HOLDER_STAGES[i];
        const state = `hold${stage}`;
        if (growth >= stage && lastState !== state) {
          fire(
            "holders",
            `📈 持倉增長 ${symbol} | ${row.holdersAtPush.toLocaleString()} → ${row.holdersLast.toLocaleString()} (+${growth.toFixed(0)}%)`,
          );
          lastState = state;
          break;
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
    sellDomStreak,
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
    private readonly bot: { api: { sendMessage(chatId: string, text: string): Promise<unknown> } },
    private readonly birdeye: BirdeyeClient | null,
    private readonly config: AppConfig,
    /** Live pair data for ≤30 addresses (the DexScreener client method). */
    private readonly pairsFor: (
      addresses: string[],
    ) => Promise<Map<string, import("./dexscreener").PairInfo>>,
  ) {}

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
   */
  async runTick(): Promise<{
    checked: number;
    alerted: number;
    /** Why nothing was checked (empty in the heartbeat when work happened). */
    note?: string;
  }> {
    const cfg = this.config.pushWatch;
    const now = Date.now();
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
        const missPairs = await this.pairsFor(missing.map((m) => m.token));
        for (const m of missing) {
          const pair = missPairs.get(m.token);
          if (!pair) continue;
          await this.db.upsertPushWatch({
            token: m.token,
            chatId: m.chatId,
            symbol: pair.baseToken.symbol ?? null,
            pushedAt: m.pushedAt,
            mcapAtPush: pair.marketCap,
            liquidityUsd: pair.liquidity.usd ?? null,
          });
        }
      }
    } catch {
      /* healing is best-effort */
    }
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

    // One DexScreener batch covers the whole watch list (≤30 addresses).
    const tokens = activeRows.map((r) => r.token).slice(0, 30);
    let pairs = new Map<string, import("./dexscreener").PairInfo>();
    try {
      pairs = await this.pairsFor(tokens);
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
    for (const row of activeRows) {
      const pair = pairs.get(row.token);
      if (!pair) {
        // Delisted/unfindable: drop after a grace period so stale rows don't
        // linger. The clock runs from the LAST SUCCESSFUL CHECK, not the
        // push time — the batched feed occasionally omits pairs (flaky
        // shared egress), and a single miss must not delete a live row.
        const lastSeen = Math.max(row.pushedAt, row.lastChecked);
        if (now - lastSeen > 2 * 3_600_000) await this.db.deletePushWatch(row.token);
        continue;
      }
      // Cross-isolate claim: only one concurrent tick may alert this row.
      // The loser's snapshot is stale — it would re-fire state-machine
      // transitions (duplicate ⚠️/🚀 cards). Skip silently on lost race.
      if (!(await this.db.claimPushWatch(row.token, row.lastChecked, now)))
        continue;
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

      // Authoritative duplicate guard: reserve the state transition
      // BEFORE delivering. The last_checked claim alone cannot stop an
      // isolate that reads between this isolate's claim and its final
      // write — it inherits the claimed stamp but the pre-alert state.
      // Matching on (last_state, last_alert_at) makes exactly one
      // contender's UPDATE win; the loser skips delivery.
      if (
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
          deadTroughMcap: evalResult.deadTroughMcap ?? null,
          sellDomStreak: evalResult.sellDomStreak,
          lastMcap: pair.marketCap,
        });
        continue;
      }
      for (const a of evalResult.alerts) {
        try {
          await this.bot.api.sendMessage(row.chatId, a.text);
          alerted += 1;
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
        followupsSent: evalResult.followupsSent,
        lastState: evalResult.lastState,
        lastAlertAt: evalResult.lastAlertAt,
        mcapAtPush: evalResult.resetBaselineMcap,
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

    return { checked, alerted };
  }
}
