import http from "node:http";
import { BirdeyeClient } from "./birdeye";
import { createBot } from "./bot";
import { loadConfig } from "./config";
import { Db } from "./db";
import { DexScreenerClient } from "./dexscreener";
import { RugcheckClient } from "./rugcheck";
import { Scanner } from "./scanner";

const config = loadConfig();

function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
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
        console.log("[birdeye] BIRDEYE_API_KEY not set — using DexScreener proxy for opening volume");
      }
      const scanner = new Scanner(
        db,
        bot,
        new DexScreenerClient(config),
        config,
        birdeye,
        new RugcheckClient(config),
      );

      // First scan right away, then on the configured interval.
      void scanner.runOnce().catch((err) => {
        console.error("[scanner] initial run failed:", err);
      });
      const timer = setInterval(() => {
        void scanner.runOnce();
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
