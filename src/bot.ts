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
    "`/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%> [Bundler%] [Top10%]` — 设置筛选条件",
    "`/status` — 查看当前条件",
    "`/on` — 开启推送",
    "`/off` — 关闭推送",
    "`/help` — 帮助",
    "",
    "默认条件: 市值 $40K–$300K，上线 360–2400 分钟，5m 量 ≥ $6,000，5m 涨幅 ≥ 30%，Bundler < 15%，Top10 持仓 < 23%",
    "例子: `/filter 40000 300000 360 2400 6000 30 15 23`",
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
    if (parts.length < 6 || parts.length > 8) {
      await ctx.reply(
        "用法: `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%> [Bundler%] [Top10%]`\n例如: `/filter 40000 300000 360 2400 6000 30 15 23`",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const minMarketCap = parseNumber(parts[0]);
    const maxMarketCap = parseNumber(parts[1]);
    const minAge = parseNumber(parts[2]);
    const maxAge = parseNumber(parts[3]);
    const min5mVol = parseNumber(parts[4]);
    const min5mChg = parseNumber(parts[5]);
    const maxBundler = parts[6] !== undefined ? parseNumber(parts[6]) : null;
    const maxTop10 = parts[7] !== undefined ? parseNumber(parts[7]) : null;
    if (
      minMarketCap === null ||
      maxMarketCap === null ||
      minAge === null ||
      maxAge === null ||
      min5mVol === null ||
      min5mChg === null ||
      minMarketCap < 0 ||
      maxMarketCap <= 0 ||
      minAge <= 0 ||
      maxAge <= 0 ||
      min5mVol < 0 ||
      (maxBundler !== null && maxBundler <= 0) ||
      (maxTop10 !== null && maxTop10 <= 0) ||
      maxMarketCap < minMarketCap ||
      maxAge < minAge
    ) {
      await ctx.reply(
        "参数无效。请用数字且保证 最高市值 ≥ 最低市值、最长上线 ≥ 最短上线: `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%> [Bundler%] [Top10%]`",
        { parse_mode: "Markdown" },
      );
      return;
    }

    const existing = await chatDb.getChatSettings(String(chatId));
    await chatDb.saveChatSettings({
      chatId: String(chatId),
      minLiquidityUsd: existing?.minLiquidityUsd ?? DEFAULT_SETTINGS.minLiquidityUsd,
      minVolume24hUsd: existing?.minVolume24hUsd ?? DEFAULT_SETTINGS.minVolume24hUsd,
      minMarketCapUsd: minMarketCap,
      maxMarketCapUsd: maxMarketCap,
      minAgeMinutes: minAge,
      maxAgeMinutes: maxAge,
      min5mVolUsd: min5mVol,
      min5mChgPct: min5mChg,
      maxBundlerPct: maxBundler ?? existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct,
      maxTop10HolderPct:
        maxTop10 ?? existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct,
      enabled: existing?.enabled ?? false,
    });
    await ctx.reply(
      [
        "✅ 筛选条件已保存:",
        `💰 最低市值: ${fmtUsd(minMarketCap)}`,
        `💰 最高市值: ${fmtUsd(maxMarketCap)}`,
        `⏱️ 最短上线: ${minAge} 分钟`,
        `⏱️ 最长上线: ${maxAge} 分钟`,
        `📊 最低 5m 量: ${fmtUsd(min5mVol)}`,
        `⚡ 最低 5m 涨幅: ${min5mChg}%`,
        `🛡 最大 Bundler: ${maxBundler ?? existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct}%`,
        `👥 最大 Top10 持仓: ${maxTop10 ?? existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct}%`,
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
        "还没有设置过筛选条件。用 `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%> [Bundler%] [Top10%]` 设置。",
        { parse_mode: "Markdown" },
      );
      return;
    }
    await ctx.reply(
      [
        "📋 当前条件:",
        `💰 最低市值: ${fmtUsd(settings.minMarketCapUsd)}`,
        `💰 最高市值: ${fmtUsd(settings.maxMarketCapUsd)}`,
        `⏱️ 最短上线: ${settings.minAgeMinutes} 分钟`,
        `⏱️ 最长上线: ${settings.maxAgeMinutes} 分钟`,
        `📊 最低 5m 量: ${fmtUsd(settings.min5mVolUsd)}`,
        `⚡ 最低 5m 涨幅: ${settings.min5mChgPct}%`,
        `🛡 最大 Bundler: ${settings.maxBundlerPct}%`,
        `👥 最大 Top10 持仓: ${settings.maxTop10HolderPct}%`,
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
      minMarketCapUsd: existing?.minMarketCapUsd ?? DEFAULT_SETTINGS.minMarketCapUsd,
      maxMarketCapUsd: existing?.maxMarketCapUsd ?? DEFAULT_SETTINGS.maxMarketCapUsd,
      minAgeMinutes: existing?.minAgeMinutes ?? DEFAULT_SETTINGS.minAgeMinutes,
      maxAgeMinutes: existing?.maxAgeMinutes ?? DEFAULT_SETTINGS.maxAgeMinutes,
      min5mVolUsd: existing?.min5mVolUsd ?? DEFAULT_SETTINGS.min5mVolUsd,
      min5mChgPct: existing?.min5mChgPct ?? DEFAULT_SETTINGS.min5mChgPct,
      maxBundlerPct: existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct,
      maxTop10HolderPct:
        existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct,
      enabled: true,
    });
    await ctx.reply(
      existing
        ? "✅ 推送已开启，开始监控 Solana 新币。"
        : `✅ 推送已开启（默认条件: 市值 $40K–$300K，上线 360–2400 分钟，5m 量 ≥ ${fmtUsd(
            DEFAULT_SETTINGS.min5mVolUsd,
          )}，5m 涨幅 ≥ ${DEFAULT_SETTINGS.min5mChgPct}%，Bundler < ${DEFAULT_SETTINGS.maxBundlerPct}%，Top10 持仓 < ${DEFAULT_SETTINGS.maxTop10HolderPct}%）。用 /filter 自定义条件。`,
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
      minMarketCapUsd: existing?.minMarketCapUsd ?? DEFAULT_SETTINGS.minMarketCapUsd,
      maxMarketCapUsd: existing?.maxMarketCapUsd ?? DEFAULT_SETTINGS.maxMarketCapUsd,
      minAgeMinutes: existing?.minAgeMinutes ?? DEFAULT_SETTINGS.minAgeMinutes,
      maxAgeMinutes: existing?.maxAgeMinutes ?? DEFAULT_SETTINGS.maxAgeMinutes,
      min5mVolUsd: existing?.min5mVolUsd ?? DEFAULT_SETTINGS.min5mVolUsd,
      min5mChgPct: existing?.min5mChgPct ?? DEFAULT_SETTINGS.min5mChgPct,
      maxBundlerPct: existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct,
      maxTop10HolderPct:
        existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct,
      enabled: false,
    });
    await ctx.reply("⛔ 推送已关闭。用 /on 重新开启。");
  });

  return bot;
}
