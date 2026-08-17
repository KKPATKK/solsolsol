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
import { GeckoTerminalClient } from "./geckoterminal";
import { GmgnClient } from "./gmgn";
import { AxiomClient } from "./axiom";
import { ArkhamClient } from "./arkham";

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

// --- Module-scoped state (warm-isolate lifetime) ---
let db: Db | null = null;
let scanner: Scanner | null = null;
let bot: Bot | null = null;
let webhook: ((req: Request) => Promise<Response>) | null = null;
let dex: DexScreenerClient | null = null;
let helius: HeliusClient | null = null;
let birdeye: BirdeyeClient | null = null;
let gmgn: GmgnClient | null = null;
let axiom: AxiomClient | null = null;
let arkham: ArkhamClient | null = null;
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
// primary driver; 120s keeps the fallback from double-scanning during
// healthy cron delivery while still self-healing within 2 minutes if cron
// stops (observed 2026-08-14: cron dead for 24h+, fallback kept the bot
// alive).
const SCAN_TRIGGER_INTERVAL_MS = 120_000;
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
// Whether AXIOM_EMAIL/PASSWORD reached the Worker (presence only).
let axiomConfigured = false;
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
    gmgnConfigured = Boolean(config.gmgnApiKey);
    arkhamConfigured = Boolean(config.arkhamApiKey);
    // Axiom is configured when there are login credentials OR already
    // persisted tokens (Google/SSO accounts have no password — they get
    // tokens via /debug/axiom-tokens, which is re-checked after DB init).
    axiomConfigured = Boolean(config.axiomEmail && config.axiomPassword);
    tradeConfigured = Boolean(config.trade.walletSecret);
    jupiterKeyed = Boolean(config.trade.jupiterApiKey);      if (config.tursoUrl) {
        try {
          db = new Db(config.tursoUrl, config.tursoAuthToken);
          await db.init();
          dbReady = true;
          console.log("[worker] Turso ready");
          // A Google/SSO Axiom account has no password — its tokens are
          // persisted by /debug/axiom-tokens, so the feed is "configured"
          // whenever a stored access token exists too.
          const storedAxiomToken = await db?.getWorkerState("axiom_access_token");
          if (storedAxiomToken) axiomConfigured = true;
        } catch (err) {
          initError = err instanceof Error ? err.message : String(err);
          console.error("[worker] Turso init failed:", initError);
        }
      } else {
      console.warn("[worker] TURSO_DATABASE_URL missing — persistence disabled");
    }

    dex = new DexScreenerClient(config);

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
      if (config.gmgnApiKey) {
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
      // The client is created whenever the feed is enabled — credentials are
      // optional (Google/SSO accounts provide tokens via /debug/axiom-tokens
      // instead of a password; the client's login methods guard on that).
      if (config.axiomTrendingLimit > 0) {
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
      if (config.arkhamApiKey) {
        try {
          arkham = new ArkhamClient(config);
        } catch (err) {
          console.warn(
            "[worker] Arkham client not ready:",
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
          // GeckoTerminal new-pools discovery — free (no key), covers every
          // Solana DEX incl. pump.fun graduates (best-effort — blocked or
          // degraded feeds return [] and the scan continues on the others).
          new GeckoTerminalClient(config),
          // GMGN OpenAPI — candidate enrichment (smart money / wash-trading)
          // + trending discovery feed (null when no key configured).
          gmgn,
          // Axiom Trade trending — login-based momentum feed (null when no
          // credentials configured).
          axiom,
          // Arkham Intelligence — smart-money holder attribution (null when
          // no ARKHAM_API_KEY configured). Card-only enrichment.
          arkham,
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
          skip: scanner?.lastSkip ?? null,
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
async function maybeRunScanIfStale(): Promise<void> {
  if (!scanner) return;
  const now = Date.now();
  if (now - lastScanTriggerAt < SCAN_TRIGGER_INTERVAL_MS) return;
  lastScanTriggerAt = now;
  // Dedupe against a healthy cron: skip when a scan already completed
  // recently (the heartbeat is written at scan completion). The fallback
  // exists to rescue a DEAD cron, not to double the scan rate — every extra
  // scan doubles the Turso rows-read and the upstream API pressure (which
  // is what triggers the gecko 429s). When cron delivers, this makes the
  // effective cadence exactly the configured 60s instead of ~1.5x it.
  try {
    const raw = await db?.getWorkerState("scan_heartbeat");
    const at = raw ? ((JSON.parse(raw) as { at?: number } | null)?.at ?? 0) : 0;
    if (typeof at === "number" && now - at < SCAN_TRIGGER_INTERVAL_MS) return;
  } catch {
    // heartbeat unreadable — fail open and run the fallback scan
  }
  try {
    await runScan();
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
    ctx.waitUntil(maybeRunScanIfStale());
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
      // Cross-isolate cron diagnostics: the scheduled handler persists a
      // running total + last event time to Turso, so any isolate serving
      // /health can prove whether the Cron Trigger is actually delivering.
      let scheduledTickTotal: number | null = null;
      let scheduledTickAt: number | null = null;
      let enabledChats: number | null = null;
      let tokenStatsCount: number | null = null;
      let pushedTotal: number | null = null;
      try {
        const rawTotal = await db?.getWorkerState("scheduled_tick_total");
        const rawAt = await db?.getWorkerState("scheduled_tick_at");
        scheduledTickTotal = rawTotal ? parseInt(rawTotal, 10) || 0 : null;
        scheduledTickAt = rawAt ? parseInt(rawAt, 10) || 0 : null;
        enabledChats = (await db?.listEnabledChats())?.length ?? null;
        tokenStatsCount = (await db?.countTokenStats()) ?? null;
        pushedTotal = (await db?.countSeenTokens()) ?? null;
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
        axiomConfigured,
        tradeConfigured,
        jupiterKeyed,
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
        lastSkip: scanner?.lastSkip ?? null,
        scanRunning,
        heartbeat,
        lastScanGapMs,
        summary: scanner?.lastSummary ?? null,
        now: new Date().toISOString(),
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

    // Push history — read-only distribution of seen_tokens for diagnosing
    // "why is push volume low" (all pushes ever, grouped by day, oldest 20).
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

    // Manual scan trigger — runs the exact scheduled-path wrapper (runScan:
    // scan + heartbeat + scan_history), so it is both the diagnostic that
    // distinguishes "cron not firing" from "scan path broken" and the manual
    // recovery lever. runOnce is re-entrant safe and budget-guarded; runScan
    // races the scan against the 26s tick budget and never rejects.
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
      await runScan();
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
      const hist = await probe.getPoolHistogram(now);
      let poolQueryBuckets: Record<string, number> | null = null;
      let poolQueryCount = 0;
      try {
        const chats = await probe.listEnabledChats();
        const minAge = Math.min(...chats.map((c) => c.minAgeMinutes));
        const maxAge = Math.max(...chats.map((c) => c.maxAgeMinutes));
        const minMcap = Math.min(...chats.map((c) => c.minMarketCapUsd));
        const pool = await probe.getReevalPool({
          sinceMs: now - 42 * 3600_000,
          minLaunchMs: now - (maxAge + 180) * 60_000,
          maxLaunchMs: now - (minAge - 180) * 60_000,
          windowEntryLaunchMs: now - minAge * 60_000,
          limit: 1000,
          // Mirror the scanner's configured tiered rotation (near slots
          // swept every ~10 min, far slots every ~45 min, plus the
          // pre-qualification filter) so the probe's age histogram matches
          // what production actually evaluates.
          nearSlots: cfg?.reevalNearSlots ?? 2,
          farSlots: cfg?.reevalFarSlots ?? 9,
          minQualifyMcap: minMcap / 2,
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

  async scheduled(_event: ScheduledEventLike, env: Env): Promise<void> {
    scheduledTicks++;
    // Record the cron event BEFORE init, with a raw client: a slow/failed
    // init (Turso degraded) otherwise kills the scheduled event inside the
    // ~30s wall clock before the counter was written, making cron look dead
    // from /health even though the trigger fires (observed 2026-08-14:
    // post-init counter stayed null while HTTP-driven scans ran fine). This
    // is the cross-isolate proof that scheduled events arrive at all.
    try {
      if (env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN) {
        const probe = new Db(env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN);
        await probe.bumpScheduledTick();
      }
    } catch (err) {
      console.error("[worker] pre-init cron counter failed:", err);
    }
    await ensureInitialized(env);
    if (!scanner) return;
    // Cadence gate: the cron trigger fires every minute; SCAN_INTERVAL_SECONDS
    // (default 60s) lets the operator slow the scan (e.g. 90s — every other
    // tick, halving upstream API pressure and Turso rows-read). Skip the
    // scan when one completed recently; the DB heartbeat is the
    // cross-isolate source of truth (an in-memory timestamp can't gate
    // another isolate's cron delivery). The HTTP-driven fallback
    // (maybeRunScanIfStale) still rescues a dead cron within 2 min.
    const scanGapMs = Math.max(60_000, (cfg?.scanIntervalSeconds ?? 60) * 1000);
    try {
      const raw = await db?.getWorkerState("scan_heartbeat");
      const at = raw
        ? ((JSON.parse(raw) as { at?: number } | null)?.at ?? 0)
        : 0;
      if (typeof at === "number" && at > 0 && Date.now() - at < scanGapMs) {
        console.log(
          `[worker] cron tick skipped — last scan ${Math.round((Date.now() - at) / 1000)}s ago (< ${Math.round(scanGapMs / 1000)}s)`,
        );
        return;
      }
    } catch {
      // heartbeat unreadable — fail open and run the scan
    }
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
