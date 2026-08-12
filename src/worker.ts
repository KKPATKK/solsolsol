import { webhookCallback, type Bot } from "grammy";
import { BirdeyeClient } from "./birdeye";
import { createBot } from "./bot";
import { loadConfig } from "./config";
import { Db } from "./db";
import { DexScreenerClient } from "./dexscreener";
import { HeliusClient } from "./helius";
import { RugcheckClient } from "./rugcheck";
import { Scanner } from "./scanner";

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
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const config = loadConfig(env);
    tursoConfigured = Boolean(config.tursoUrl);
    heliusConfigured = Boolean(config.heliusApiKey);
    birdeyeConfigured = Boolean(config.birdeyeApiKey);

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

    if (config.telegramBotToken) {
      bot = createBot(config.telegramBotToken, db, config.scanIntervalSeconds);
      webhook = webhookCallback(bot, "cloudflare-mod");
      botReady = true;

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

      const helius = new HeliusClient(config);

      if (db) {
        scanner = new Scanner(
          db,
          bot,
          new DexScreenerClient(config),
          config,
          birdeye,
          new RugcheckClient(config),
          helius,
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
