import http from "node:http";
import { BirdeyeClient } from "./birdeye";
import { createBot } from "./bot";
import { loadConfig } from "./config";
import { Db } from "./db";
import { DexScreenerClient } from "./dexscreener";
import { HeliusClient } from "./helius";
import { RugcheckClient } from "./rugcheck";
import { Scanner } from "./scanner";

const config = loadConfig();

// Process-level guards: transient async failures must not silently kill the
// bot. unhandledRejection is logged and tolerated (grammY/scanner already
// catch most), while uncaughtException logs loudly and exits so the health
// monitor / restart flow can recover deterministically instead of running
// in a corrupted state.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[app] unhandledRejection:",
    reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  );
});
process.on("uncaughtException", (err) => {
  console.error("[app] uncaughtException (exiting):", err.stack ?? err.message);
  process.exit(1);
});

// Last-scan telemetry exposed via /health so external uptime monitors can
// distinguish "process up" from "scanner working".
let lastScanAt: number | null = null;
let lastScanOk = false;
let scanCount = 0;

function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          uptimeSec: Math.round(process.uptime()),
          scanCount,
          lastScanOk,
          lastScanAt: lastScanAt ? new Date(lastScanAt).toISOString() : null,
        }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Solana Meme Coin Scanner bot — see /health");
  });
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`[http] health server listening on 0.0.0.0:${config.port}`);
  });
  return server;
}

async function main(): Promise<void> {
  const server = startHealthServer();

  // Database (Turso) — optional at startup; commands/scanning degrade gracefully.
  let db: Db | null = null;
  console.log(
    `[db] TURSO_DATABASE_URL ${config.tursoUrl ? "set" : "MISSING"}${config.tursoUrl ? ` (len=${config.tursoUrl.length})` : ""}, ` +
      `TURSO_AUTH_TOKEN ${config.tursoAuthToken ? "set" : "MISSING"}${config.tursoAuthToken ? ` (len=${config.tursoAuthToken.length})` : ""}`,
  );
  if (config.tursoUrl) {
    try {
      db = new Db(config.tursoUrl, config.tursoAuthToken);
      await db.init();
      console.log("[db] Turso ready");
    } catch (err) {
      console.error(
        "[db] failed to initialize Turso:",
        err instanceof Error ? err.message : err,
      );
    }
  } else {
    console.warn("[db] TURSO_DATABASE_URL not set — persistence disabled");
  }

  // Telegram bot — needs TELEGRAM_BOT_TOKEN from @BotFather.
  if (config.telegramBotToken) {
    const bot = createBot(config.telegramBotToken, db, config.scanIntervalSeconds);

    // Scanner needs both the bot and the database to run.
    if (db) {
      let birdeye: BirdeyeClient | null = null;
      if (config.birdeyeApiKey) {
        try {
          birdeye = new BirdeyeClient(config);
          console.log("[birdeye] client ready");
        } catch (err) {
          console.warn(
            "[birdeye]",
            err instanceof Error ? err.message : err,
          );
        }
      } else {
        console.log("[birdeye] BIRDEYE_API_KEY not set — trader insights disabled");
      }
      const helius = new HeliusClient(config);
      console.log(
        config.heliusApiKey
          ? "[helius] client ready (on-chain volume)"
          : "[helius] no API key — on-chain volume via public RPC (rate-limited)",
      );
      const scanner = new Scanner(
        db,
        bot,
        new DexScreenerClient(config),
        config,
        birdeye,
        new RugcheckClient(config),
        helius,
      );

      const runScan = async (initial: boolean) => {
        try {
          await scanner.runOnce();
          lastScanOk = true;
        } catch (err) {
          lastScanOk = false;
          console.error(`[scanner] ${initial ? "initial run" : "scan"} failed:`, err);
        } finally {
          lastScanAt = Date.now();
          scanCount++;
        }
      };

      // First scan right away, then on the configured interval.
      void runScan(true);
      const timer = setInterval(() => {
        void runScan(false);
      }, config.scanIntervalSeconds * 1000);
      timer.unref();
    }

    // Long polling blocks until stopped; everything above keeps running.
    await bot.start({
      onStart: () => {
        console.log(
          `[bot] started (long polling, scan every ${config.scanIntervalSeconds}s)`,
        );
      },
    });
  } else {
    console.warn(
      "[bot] TELEGRAM_BOT_TOKEN not configured — bot not started; /health still serves",
    );
  }

  const shutdown = async () => {
    console.log("[app] shutting down");
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("[app] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
