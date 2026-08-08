import { Bot, type Context } from "grammy";
import { DEFAULT_SETTINGS, type Db } from "./db";
import { fmtUsd, parseNumber } from "./format";

function formatInterval(seconds: number): string {
  return seconds % 60 === 0 ? `每 ${seconds / 60} 分钟` : `每 ${seconds} 秒`;
}

function buildUsage(scanIntervalSeconds: number): string {
  return [
    "🤖 *Solana Meme Coin Scanner*",
    "",
    `${formatInterval(scanIntervalSeconds)}扫描一次 Solana 新上线的 meme coin，符合条件的自动推送到这里。`,
    "",
    "*命令*",
    "`/filter <最低市值> <最短上线分钟> <最低5m量USD> <最低5m涨幅%> [首分钟量USD] [Bundler%] [Top10%] [Sniper%]` — 设置筛选条件",
    "`/status` — 查看当前条件",
    "`/on` — 开启推送",
    "`/off` — 关闭推送",
    "`/help` — 帮助",
    "",
    "默认条件: 市值 ≥ $7,800，上线 ≥ 6.3 分钟，5m 量 ≥ $1,800，5m 涨幅 ≥ 18%，开盘量 < $10,000，Bundler < 24%，Top10 持仓 < 27%，Sniper 買入 < 5%（佔供應）",
    "例子: `/filter 10000 10 3000 25 8000 20 25 5`",
  ].join("\n");
}

const DB_MISSING_REPLY =
  "⛔ 数据库未配置（缺少 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN），暂时无法保存条件。配置后重启即可使用全部功能。";

/**
 * createBot accepts a nullable database: without it the bot still runs
 * (welcome/help work), but settings-related commands degrade gracefully.
 */
export function createBot(
  token: string,
  db: Db | null,
  scanIntervalSeconds: number = 300,
): Bot {
  const bot = new Bot(token);
  const USAGE = buildUsage(scanIntervalSeconds);

  bot.catch((err) => {
    console.error("[bot] error:", err.error);
  });

  const getDb = async (ctx: Context): Promise<Db | null> => {
    if (db) return db;
    await ctx.reply(DB_MISSING_REPLY);
    return null;
  };

  bot.command("start", async (ctx) => {
    await ctx.reply(USAGE, { parse_mode: "Markdown" });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(USAGE, { parse_mode: "Markdown" });
  });

  bot.command("filter", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const chatDb = await getDb(ctx);
    if (!chatDb) return;

    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 4 || parts.length > 8) {
      await ctx.reply(
        "用法: `/filter <最低市值USD> <最短上线分钟> <最低5m量USD> <最低5m涨幅%> [首分钟量USD] [Bundler%] [Top10%] [Sniper%]`\n例如: `/filter 10000 10 3000 25 8000 20 25 5`",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const minMarketCap = parseNumber(parts[0]);
    const minAge = parseNumber(parts[1]);
    const min5mVol = parseNumber(parts[2]);
    const min5mChg = parseNumber(parts[3]);
    const max1mVol = parts[4] !== undefined ? parseNumber(parts[4]) : null;
    const maxBundler = parts[5] !== undefined ? parseNumber(parts[5]) : null;
    const maxTop10 = parts[6] !== undefined ? parseNumber(parts[6]) : null;
    const maxSniper = parts[7] !== undefined ? parseNumber(parts[7]) : null;
    if (
      minMarketCap === null ||
      minAge === null ||
      min5mVol === null ||
      min5mChg === null ||
      minMarketCap < 0 ||
      minAge <= 0 ||
      min5mVol < 0 ||
      (max1mVol !== null && max1mVol <= 0) ||
      (maxBundler !== null && maxBundler <= 0) ||
      (maxTop10 !== null && maxTop10 <= 0) ||
      (maxSniper !== null && maxSniper <= 0)
    ) {
      await ctx.reply(
        "参数无效。请用数字: `/filter <最低市值USD> <最短上线分钟> <最低5m量USD> <最低5m涨幅%> [首分钟量USD] [Bundler%] [Top10%] [Sniper%]`",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const existing = await chatDb.getChatSettings(String(chatId));
    await chatDb.saveChatSettings({
      chatId: String(chatId),
      minLiquidityUsd: existing?.minLiquidityUsd ?? DEFAULT_SETTINGS.minLiquidityUsd,
      minVolume24hUsd: existing?.minVolume24hUsd ?? DEFAULT_SETTINGS.minVolume24hUsd,
      maxAgeMinutes: existing?.maxAgeMinutes ?? DEFAULT_SETTINGS.maxAgeMinutes,
      minMarketCapUsd: minMarketCap,
      minAgeMinutes: minAge,
      min5mVolUsd: min5mVol,
      min5mChgPct: min5mChg,
      max1mVolUsd: max1mVol ?? existing?.max1mVolUsd ?? DEFAULT_SETTINGS.max1mVolUsd,
      maxBundlerPct: maxBundler ?? existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct,
      maxTop10HolderPct:
        maxTop10 ?? existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct,
      maxSniperPct: maxSniper ?? existing?.maxSniperPct ?? DEFAULT_SETTINGS.maxSniperPct,
      enabled: existing?.enabled ?? false,
    });
    await ctx.reply(
      [
        "✅ 筛选条件已保存:",
        `💰 最低市值: ${fmtUsd(minMarketCap)}`,
        `⏱️ 最短上线: ${minAge} 分钟`,
        `📊 最低 5m 量: ${fmtUsd(min5mVol)}`,
        `⚡ 最低 5m 涨幅: ${min5mChg}%`,
        `🌱 最大首分钟量: ${fmtUsd(
          max1mVol ?? existing?.max1mVolUsd ?? DEFAULT_SETTINGS.max1mVolUsd,
        )}`,
        `🛡 最大 Bundler: ${maxBundler ?? existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct}%`,
        `👥 最大 Top10: ${maxTop10 ?? existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct}%`,
        `🎯 最大 Sniper 買入: ${maxSniper ?? existing?.maxSniperPct ?? DEFAULT_SETTINGS.maxSniperPct}%（佔供應）`,
        `推送状态: ${existing?.enabled ?? false ? "已开启" : "已关闭（用 /on 开启）"}`,
      ].join("\n"),
    );
  });

  bot.command("status", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const chatDb = await getDb(ctx);
    if (!chatDb) return;
    const settings = await chatDb.getChatSettings(String(chatId));
    if (!settings) {
      await ctx.reply(
        "还没有设置过筛选条件。用 `/filter <最低流动性USD> <24h成交量USD> <最大上线分钟>` 设置。",
        { parse_mode: "Markdown" },
      );
      return;
    }
    await ctx.reply(
      [
        "📋 当前条件:",
        `💰 最低市值: ${fmtUsd(settings.minMarketCapUsd)}`,
        `⏱️ 最短上线: ${settings.minAgeMinutes} 分钟`,
        `📊 最低 5m 量: ${fmtUsd(settings.min5mVolUsd)}`,
        `⚡ 最低 5m 涨幅: ${settings.min5mChgPct}%`,
        `🌱 最大首分钟量: ${fmtUsd(settings.max1mVolUsd)}`,
        `🛡 最大 Bundler: ${settings.maxBundlerPct}%`,
        `👥 最大 Top10 持仓: ${settings.maxTop10HolderPct}%`,
        `🎯 最大 Sniper 買入: ${settings.maxSniperPct}%（佔供應）`,
        `推送状态: ${settings.enabled ? "✅ 已开启" : "⛔ 已关闭"}`,
      ].join("\n"),
    );
  });

  bot.command("on", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const chatDb = await getDb(ctx);
    if (!chatDb) return;
    const existing = await chatDb.getChatSettings(String(chatId));
    await chatDb.saveChatSettings({
      chatId: String(chatId),
      minLiquidityUsd: existing?.minLiquidityUsd ?? DEFAULT_SETTINGS.minLiquidityUsd,
      minVolume24hUsd: existing?.minVolume24hUsd ?? DEFAULT_SETTINGS.minVolume24hUsd,
      maxAgeMinutes: existing?.maxAgeMinutes ?? DEFAULT_SETTINGS.maxAgeMinutes,
      minMarketCapUsd: existing?.minMarketCapUsd ?? DEFAULT_SETTINGS.minMarketCapUsd,
      minAgeMinutes: existing?.minAgeMinutes ?? DEFAULT_SETTINGS.minAgeMinutes,
      min5mVolUsd: existing?.min5mVolUsd ?? DEFAULT_SETTINGS.min5mVolUsd,
      min5mChgPct: existing?.min5mChgPct ?? DEFAULT_SETTINGS.min5mChgPct,
      max1mVolUsd: existing?.max1mVolUsd ?? DEFAULT_SETTINGS.max1mVolUsd,
      maxBundlerPct: existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct,
      maxTop10HolderPct:
        existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct,
      maxSniperPct: existing?.maxSniperPct ?? DEFAULT_SETTINGS.maxSniperPct,
      enabled: true,
    });
    const base =
      existing?.minMarketCapUsd ?? DEFAULT_SETTINGS.minMarketCapUsd;
    await ctx.reply(
      existing
        ? "✅ 推送已开启，开始监控 Solana 新币。"
        : `✅ 推送已开启（默认条件: 市值 ≥ ${fmtUsd(
            base,
          )}，上线 ≥ ${DEFAULT_SETTINGS.minAgeMinutes} 分钟，5m 量 ≥ ${fmtUsd(
            DEFAULT_SETTINGS.min5mVolUsd,
          )}，5m 涨幅 ≥ ${DEFAULT_SETTINGS.min5mChgPct}%，开盘量 < ${fmtUsd(
            DEFAULT_SETTINGS.max1mVolUsd,
          )}，Bundler < ${DEFAULT_SETTINGS.maxBundlerPct}%，Top10 持仓 < ${DEFAULT_SETTINGS.maxTop10HolderPct}%，Sniper 買入 < ${DEFAULT_SETTINGS.maxSniperPct}%（佔供應））。用 /filter 自定义条件。`,
    );
  });

  bot.command("off", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const chatDb = await getDb(ctx);
    if (!chatDb) return;
    const existing = await chatDb.getChatSettings(String(chatId));
    await chatDb.saveChatSettings({
      chatId: String(chatId),
      minLiquidityUsd: existing?.minLiquidityUsd ?? DEFAULT_SETTINGS.minLiquidityUsd,
      minVolume24hUsd: existing?.minVolume24hUsd ?? DEFAULT_SETTINGS.minVolume24hUsd,
      maxAgeMinutes: existing?.maxAgeMinutes ?? DEFAULT_SETTINGS.maxAgeMinutes,
      minMarketCapUsd: existing?.minMarketCapUsd ?? DEFAULT_SETTINGS.minMarketCapUsd,
      minAgeMinutes: existing?.minAgeMinutes ?? DEFAULT_SETTINGS.minAgeMinutes,
      min5mVolUsd: existing?.min5mVolUsd ?? DEFAULT_SETTINGS.min5mVolUsd,
      min5mChgPct: existing?.min5mChgPct ?? DEFAULT_SETTINGS.min5mChgPct,
      max1mVolUsd: existing?.max1mVolUsd ?? DEFAULT_SETTINGS.max1mVolUsd,
      maxBundlerPct: existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct,
      maxTop10HolderPct:
        existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct,
      maxSniperPct: existing?.maxSniperPct ?? DEFAULT_SETTINGS.maxSniperPct,
      enabled: false,
    });
    await ctx.reply("⛔ 推送已关闭。用 /on 重新开启。");
  });

  return bot;
}
