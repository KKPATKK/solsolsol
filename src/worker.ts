import { webhookCallback } from "grammy";
import { BirdeyeClient } from "./birdeye";
import { createBot } from "./bot";
import { loadConfig } from "./config";
import { Db } from "./db";
import { DexScreenerClient } from "./dexscreener";
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
let lastScanMs: number | null = null;
let lastScanError: string | null = null;
let scheduledTicks = 0;
let scanRunning = false;

async function ensureInitialized(env: Env): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const config = loadConfig(env);

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
      const bot = createBot(config.telegramBotToken, db, config.scanIntervalSeconds);
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

      if (db) {
        scanner = new Scanner(
          db,
          bot,
          new DexScreenerClient(config),
          config,
          birdeye,
          new RugcheckClient(config),
        );
        scannerReady = true;
      }
    }
  })();
  return initPromise;
}

async function runScan(): Promise<void> {
  if (!scanner) return;
  const startedAt = Date.now();
  try {
    await scanner.runOnce();
    lastScanOk = true;
    lastScanError = null;
  } catch (err) {
    lastScanOk = false;
    lastScanError = err instanceof Error ? err.message : String(err);
    console.error("[worker] scheduled scan failed:", lastScanError);
  } finally {
    lastScanMs = Date.now() - startedAt;
    lastScanAt = Date.now();
    scanCount++;
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
          summary: scanner?.lastSummary ?? null,
        }),
      );
    } catch (err) {
      console.error("[worker] heartbeat write failed:", err);
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ensureInitialized(env);
    const url = new URL(request.url);

    // UptimeRobot target: distinguishes "worker up" from "scanner working".
    if (url.pathname === "/health") {
      let heartbeat: unknown = null;
      try {
        const raw = await db?.getWorkerState("scan_heartbeat");
        heartbeat = raw ? JSON.parse(raw) : null;
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
        initError,
        lastScanMs,
        lastScanError,
        scheduledTicks,
        scanRunning,
        heartbeat,
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
    scanRunning = true;
    try {
      await runScan();
    } finally {
      scanRunning = false;
    }
  },
};
