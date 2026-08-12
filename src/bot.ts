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
    "默认条件: 市值 $40K–$300K，上线 360–2400 分钟，5m 量 ≥ $6,000，5m 涨幅 ≥ 30%，Bundler ≤ 15%，Top10 持仓 ≤ 23%",
    "例子: `/filter 40000 300000 360 2400 6000 30 15 23`",
  ].join("\n");
}

const DB_MISSING_REPLY =
  "⛔ 数据库未配置（缺少 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN），暂时无法保存条件。配置后重启即可使用全部功能。";

/**
 * Parsed /filter arguments (pure — unit-tested). Bounds are inclusive per
 * the operator's spec ("≤ 15%" means exactly 15% is allowed).
 */
export type ParsedFilter =
  | {
      ok: true;
      minMarketCapUsd: number;
      maxMarketCapUsd: number;
      minAgeMinutes: number;
      maxAgeMinutes: number;
      min5mVolUsd: number;
      min5mChgPct: number;
      /** null = not provided → keep the chat's current value. */
      maxBundlerPct: number | null;
      /** null = not provided → keep the chat's current value. */
      maxTop10HolderPct: number | null;
    }
  | { ok: false; error: string };

export function parseFilterArgs(parts: string[]): ParsedFilter {
  const USAGE =
    "用法: `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%> [Bundler%] [Top10%]`\n例如: `/filter 40000 300000 360 2400 6000 30 15 23`";
  if (parts.length < 6 || parts.length > 8) {
    return { ok: false, error: USAGE };
  }
  const minMarketCapUsd = parseNumber(parts[0]);
  const maxMarketCapUsd = parseNumber(parts[1]);
  const minAgeMinutes = parseNumber(parts[2]);
  const maxAgeMinutes = parseNumber(parts[3]);
  const min5mVolUsd = parseNumber(parts[4]);
  const min5mChgPct = parseNumber(parts[5]);
  const maxBundlerPct = parts[6] !== undefined ? parseNumber(parts[6]) : null;
  const maxTop10HolderPct = parts[7] !== undefined ? parseNumber(parts[7]) : null;
  if (
    minMarketCapUsd === null ||
    maxMarketCapUsd === null ||
    minAgeMinutes === null ||
    maxAgeMinutes === null ||
    min5mVolUsd === null ||
    min5mChgPct === null ||
    minMarketCapUsd < 0 ||
    maxMarketCapUsd < 0 ||
    minAgeMinutes <= 0 ||
    maxAgeMinutes <= 0 ||
    min5mVolUsd < 0 ||
    (maxBundlerPct !== null && maxBundlerPct <= 0) ||
    (maxTop10HolderPct !== null && maxTop10HolderPct <= 0) ||
    maxMarketCapUsd < minMarketCapUsd ||
    maxAgeMinutes < minAgeMinutes
  ) {
    return {
      ok: false,
      error:
        "参数无效。请用数字且保证 最高市值 ≥ 最低市值、最长上线 ≥ 最短上线: `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%> [Bundler%] [Top10%]`",
    };
  }
  return {
    ok: true,
    minMarketCapUsd,
    maxMarketCapUsd,
    minAgeMinutes,
    maxAgeMinutes,
    min5mVolUsd,
    min5mChgPct,
    maxBundlerPct,
    maxTop10HolderPct,
  };
}

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
    const parsed = parseFilterArgs(parts);
    if (!parsed.ok) {
      await ctx.reply(parsed.error, { parse_mode: "Markdown" });
      return;
    }

    const existing = await chatDb.getChatSettings(String(chatId));
    await chatDb.saveChatSettings({
      chatId: String(chatId),
      minLiquidityUsd: existing?.minLiquidityUsd ?? DEFAULT_SETTINGS.minLiquidityUsd,
      minVolume24hUsd: existing?.minVolume24hUsd ?? DEFAULT_SETTINGS.minVolume24hUsd,
      minMarketCapUsd: parsed.minMarketCapUsd,
      maxMarketCapUsd: parsed.maxMarketCapUsd,
      minAgeMinutes: parsed.minAgeMinutes,
      maxAgeMinutes: parsed.maxAgeMinutes,
      min5mVolUsd: parsed.min5mVolUsd,
      min5mChgPct: parsed.min5mChgPct,
      maxBundlerPct: parsed.maxBundlerPct ?? existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct,
      maxTop10HolderPct:
        parsed.maxTop10HolderPct ?? existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct,
      enabled: existing?.enabled ?? false,
    });
    await ctx.reply(
      [
        "✅ 筛选条件已保存:",
        `💰 最低市值: ${fmtUsd(parsed.minMarketCapUsd)}`,
        `💰 最高市值: ${fmtUsd(parsed.maxMarketCapUsd)}`,
        `⏱️ 最短上线: ${parsed.minAgeMinutes} 分钟`,
        `⏱️ 最长上线: ${parsed.maxAgeMinutes} 分钟`,
        `📊 最低 5m 量: ${fmtUsd(parsed.min5mVolUsd)}`,
        `⚡ 最低 5m 涨幅: ${parsed.min5mChgPct}%`,
        `🛡 最大 Bundler: ${parsed.maxBundlerPct ?? existing?.maxBundlerPct ?? DEFAULT_SETTINGS.maxBundlerPct}%`,
        `👥 最大 Top10 持仓: ${parsed.maxTop10HolderPct ?? existing?.maxTop10HolderPct ?? DEFAULT_SETTINGS.maxTop10HolderPct}%`,
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
          )}，5m 涨幅 ≥ ${DEFAULT_SETTINGS.min5mChgPct}%，Bundler ≤ ${DEFAULT_SETTINGS.maxBundlerPct}%，Top10 持仓 ≤ ${DEFAULT_SETTINGS.maxTop10HolderPct}%）。用 /filter 自定义条件。`,
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
