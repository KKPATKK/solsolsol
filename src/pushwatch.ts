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
 *   🔥 ignition       — 5m volume jumps from dormant (< $10K) to ≥ $50K
 *                       before any rising stage (early new-leg warning)
 *   ⚠️ weak           — ≥35% off the post-push peak (only if it had run up)
 *   💀 dead           — ≥55% off peak → fires once, then SILENT watch; if
 *                       mcap recovers to the push baseline the row is
 *                       resurrected with a fresh baseline (V-reversals)
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
 * pattern: 75 min of quiet consolidation, then a 13x volume bar minutes
 * before the god candle). Early-warning only — it never fires once the
 * +50% rising stage has been crossed, where 🚀 alerts take over.
 */
export const IGNITION_VOL_USD = 50_000;
export const IGNITION_DORMANT_USD = 10_000;
/** Holder-growth stages (× push-time holders → state suffix). */
const HOLDER_STAGES = [10, 25, 50] as const;

export interface PushWatchRow {
  token: string;
  chatId: string;
  symbol: string | null;
  pushedAt: number;
  mcapAtPush: number;
  peakMcap: number;
  lastLiquidity: number | null;
  lastVol5m: number | null;
  holdersAtPush: number | null;
  holdersLast: number | null;
  holdersCheckedAt: number | null;
  lastChecked: number;
  lastAlertAt: number;
  followupsSent: number;
  lastState: string | null;
}

export interface WatchAlert {
  kind: "rising" | "weak" | "dead" | "liquidity" | "holders" | "ignition";
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
    };
  }

  // Resurrection first: a 💀-marked coin recovering to its push baseline
  // restarts with a fresh cycle regardless of the now-stale peak (otherwise
  // weak/dead math against the old peak would keep suppressing it).
  if (row.lastState === "dead" && live.mcap >= row.mcapAtPush) {
    fire(
      "rising",
      `🟢 死而復生 ${symbol} | 從 💀 收復推送市值 ${fmtUsd(row.mcapAtPush)} → 現 ${fmtUsd(live.mcap)}，重置基準繼續追蹤`,
    );
    return {
      alerts,
      peakMcap: live.mcap,
      followupsSent,
      lastState: null,
      lastAlertAt,
      stopTracking: false,
      resetBaselineMcap: live.mcap,
    };
  }

  // Dead: ≥55% off the peak. Fires ONCE (the row then stays in silent
  // watch) — deep-flush V-reversals are common, so if the mcap later
  // recovers to the push baseline the resurrection above re-arms it.
  // Peak is always ≥ push mcap, so this also catches never-ran-up dumps.
  if (drawdownFromPeak <= -DEAD_DRAWDOWN_PCT) {
    if (row.lastState !== "dead") {
      fire(
        "dead",
        `💀 走死 ${symbol} | 峰值 ${fmtUsd(peakMcap)} → 現 ${fmtUsd(live.mcap)} (${pct(drawdownFromPeak)})，轉入靜默監控（收復 ${fmtUsd(row.mcapAtPush)} 會再通知）`,
      );
    }
    // Already announced: silent monitoring until recovery or window end.
    return {
      alerts,
      peakMcap,
      followupsSent,
      lastState: "dead",
      lastAlertAt,
      stopTracking: false,
    };
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
  };
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
    await this.db.prunePushWatch(now - cfg.windowHours * 3_600_000);
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
    const activeRows = rows.filter((r) => r.lastState !== "rug");
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
        // Delisted/unfindable: drop after a grace period so stale rows don't linger.
        if (now - row.pushedAt > 2 * 3_600_000) await this.db.deletePushWatch(row.token);
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
