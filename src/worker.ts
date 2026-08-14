import { webhookCallback, type Bot } from "grammy";
import { BirdeyeClient } from "./birdeye";
import { createBot, type FlowCheckResult } from "./bot";
import { loadConfig, type AppConfig } from "./config";
import { Db } from "./db";
import { DexScreenerClient } from "./dexscreener";
import { HeliusClient, type SupplyFlowResult } from "./helius";
import { RugcheckClient } from "./rugcheck";
import { Scanner } from "./scanner";
import { JupiterClient, TradeService } from "./jupiter";
import { PumpFunClient } from "./pumpfun";

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

// --- Module-scoped state (warm-isolate lifetime) ---
let db: Db | null = null;
let scanner: Scanner | null = null;
let bot: Bot | null = null;
let webhook: ((req: Request) => Promise<Response>) | null = null;
let dex: DexScreenerClient | null = null;
let helius: HeliusClient | null = null;
let trade: TradeService | null = null;
let cfg: AppConfig | null = null;
/** Cooldown for the /debug/flow endpoint: re-analysis of the same mint is
 * expensive (~150–300 Helius credits), so throttle manual triggers. */
const FLOW_DEBUG_COOLDOWN_MS = 30_000;
const flowDebugLastRunAt = new Map<string, number>();
/** Cooldown for the /debug/tick endpoint (manual scan trigger). */
const TICK_DEBUG_COOLDOWN_MS = 25_000;
let tickDebugLastRunAt = 0;
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
// Whether the BOT_WALLET_PRIVATE_KEY secret reached the Worker (presence only).
let tradeConfigured = false;
// Whether the JUPITER_API_KEY secret reached the Worker (presence only —
// requests then carry the x-api-key header for higher rate limits).
let jupiterKeyed = false;

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
 * at the ~30s wall-clock limit; if a slow scan crosses that, runScan's
 * finally (which writes the heartbeat) never runs and the scan looks dead
 * from the outside. Racing the scan against this budget — well under the
 * wall clock — guarantees the heartbeat is written every tick, with a
 * timeout flag, so a slow scan is visible instead of silent.
 */
const SCAN_TICK_BUDGET_MS = 26_000;

async function ensureInitialized(env: Env): Promise<void> {
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
    tradeConfigured = Boolean(config.trade.walletSecret);
    jupiterKeyed = Boolean(config.trade.jupiterApiKey);

    if (config.tursoUrl) {
      try {
        db = new Db(config.tursoUrl, config.tursoAuthToken);
        await db.init();
        dbReady = true;
        console.log("[worker] Turso ready");
      } catch (err) {
        initError = err instanceof Error ? err.message : String(err);
        console.error("[worker] Turso init failed:", initError);
      }
    } else {
      console.warn("[worker] TURSO_DATABASE_URL missing — persistence disabled");
    }

    dex = new DexScreenerClient(config);

    if (config.telegramBotToken) {
      let birdeye: BirdeyeClient | null = null;
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
        );
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

async function runScan(): Promise<void> {
  if (!scanner) return;
  const startedAt = Date.now();
  let timedOut = false;
  try {
    // Race the scan against the tick budget. runOnce never rejects (it
    // catches its own errors), so the first to settle wins; on timeout the
    // background scan keeps going until Cloudflare kills it, and the seq
    // guard in Scanner prevents it from clobbering the next tick's state.
    await Promise.race([
      scanner.runOnce(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, SCAN_TICK_BUDGET_MS);
      }),
    ]);
    lastScanOk = !timedOut;
    lastScanError = timedOut
      ? `tick exceeded ${SCAN_TICK_BUDGET_MS}ms budget`
      : null;
    if (timedOut) {
      console.error(`[worker] scan exceeded ${SCAN_TICK_BUDGET_MS}ms — heartbeat written with timeout flag`);
    }
  } catch (err) {
    lastScanOk = false;
    lastScanError = err instanceof Error ? err.message : String(err);
    console.error("[worker] scheduled scan failed:", lastScanError);
  } finally {
    lastScanMs = Date.now() - startedAt;
    lastScanAt = Date.now();
    scanCount++;
    const summary = scanner?.lastSummary ?? null;
    // Persist the heartbeat so any isolate (e.g. the one serving /health)
    // can observe scanner liveness via the shared database.
    try {
      await db?.setWorkerState(
        "scan_heartbeat",
        JSON.stringify({
          at: lastScanAt,
          ok: lastScanOk,
          count: scanCount,
          ms: lastScanMs,
          err: lastScanError,
          summary,
        }),
      );
    } catch (err) {
      console.error("[worker] heartbeat write failed:", err);
    }
    // Permanent per-tick history row (queryable for gap analysis later).
    try {
      await db?.recordScanHistory({
        at: lastScanAt,
        ok: lastScanOk,
        ms: lastScanMs,
        err: lastScanError,
        profiles: summary?.profiles ?? null,
        pool: summary?.pool ?? null,
        candidates: summary?.candidates ?? null,
        pushed: summary?.pushed ?? null,
      });
    } catch (err) {
      console.error("[worker] history write failed:", err);
    }
  }
}

/**
 * Outage detection: when a scheduled tick fires and the previous scan
 * finished more than OUTAGE_ALERT_GAP_MS ago, the scanner was down or
 * stuck. Alert each enabled chat once per episode (cooldown-bounded).
 */
async function checkOutageAndAlert(): Promise<void> {
  if (!db || !bot) return;
  const raw = await db.getWorkerState("scan_heartbeat");
  if (!raw) return; // first ever run — no history yet
  let hb: { at?: number };
  try {
    hb = JSON.parse(raw);
  } catch {
    return;
  }
  const lastScanAt = typeof hb.at === "number" ? hb.at : 0;
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ensureInitialized(env);
    const url = new URL(request.url);

    // UptimeRobot target: distinguishes "worker up" from "scanner working".
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
        tradeConfigured,
        jupiterKeyed,
        tradeMode: effectiveTradeMode,
        tradeModeOverride,
        adminConfigured: (cfg?.adminIds.length ?? 0) > 0,
        initError,
        lastScanMs,
        lastScanError,
        scheduledTicks,
        scanRunning,
        heartbeat,
        lastScanGapMs,
        summary: scanner?.lastSummary ?? null,
        now: new Date().toISOString(),
      });
    }

    // Manual scan trigger — forces one scanner pass immediately. This is
    // the escape hatch when cron delivery fails AND the diagnostic that
    // distinguishes "cron not firing" from "scan path broken": if the scan
    // completes here, the pipeline is healthy and the cron trigger is the
    // problem. runOnce is re-entrant safe (skips when a scan is already
    // running) and budget-guarded, so a hung upstream never wedges the
    // request — the whole call is raced against a 25s cap, matching the
    // scheduled tick budget.
    if (url.pathname === "/debug/tick") {
      const sinceLast = Date.now() - tickDebugLastRunAt;
      if (sinceLast < TICK_DEBUG_COOLDOWN_MS) {
        return Response.json(
          {
            ok: false,
            error: "cooldown — runOnce is minute-budgeted, wait a bit",
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
      const timedOut = await Promise.race([
        scanner.runOnce().then(() => false),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(true), TICK_DEBUG_COOLDOWN_MS),
        ),
      ]);
      return Response.json({
        ok: !timedOut,
        ms: Date.now() - t0,
        timedOut,
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

    // Telegram webhook (grammY registers commands on this bot instance).
    if (webhook) {
      return webhook(request);
    }
    return new Response("Solana Meme Coin Scanner worker", { status: 200 });
  },

  async scheduled(_event: ScheduledEventLike, env: Env): Promise<void> {
    scheduledTicks++;
    await ensureInitialized(env);
    if (!scanner) return;
    // Detect missed ticks (previous scan finished too long ago) and alert.
    try {
      await checkOutageAndAlert();
    } catch (err) {
      console.error("[worker] outage check failed:", err);
    }
    scanRunning = true;
    try {
      await runScan();
    } finally {
      scanRunning = false;
    }
  },
};
