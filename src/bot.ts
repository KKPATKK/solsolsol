import { Bot, type Context } from "grammy";
import { isAdmin } from "./config";
import { DEFAULT_SETTINGS, type Db } from "./db";
import { fmtUsd, parseNumber } from "./format";
import type { SupplyFlowResult } from "./helius";
import type { TradeService } from "./jupiter";

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
    "`/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%>` — 设置筛选条件",
    "`/flow <合约地址>` — 手动检查某币的链上供应流（多钱包喂给同一接收者再卖出）",
    "`/trade` — 查看 Jupiter 自动买入设置",
    "`/setmode <manual|auto|off>` — 切换交易模式（仅管理员）",
    "`/status` — 查看当前条件",
    "`/on` — 开启推送",
    "`/off` — 关闭推送",
    "`/help` — 帮助",
    "",
    "默认条件: 市值 $40K–$300K，上线 360–2400 分钟，5m 量 ≥ $6,000，5m 涨幅 ≥ 30%",
    "例子: `/filter 40000 300000 360 2400 6000 30`",
  ].join("\n");
}

const DB_MISSING_REPLY =
  "⛔ 数据库未配置（缺少 TURSO_DATABASE_URL / TURSO_AUTH_TOKEN），暂时无法保存条件。配置后重启即可使用全部功能。";

/**
 * Parsed /filter arguments (pure — unit-tested). The bundler and top-10
 * holder filters were removed, so /filter takes exactly 6 arguments.
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
    }
  | { ok: false; error: string };

export function parseFilterArgs(parts: string[]): ParsedFilter {
  const USAGE =
    "用法: `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%>`\n例如: `/filter 40000 300000 360 2400 6000 30`";
  if (parts.length !== 6) {
    return { ok: false, error: USAGE };
  }
  const minMarketCapUsd = parseNumber(parts[0]);
  const maxMarketCapUsd = parseNumber(parts[1]);
  const minAgeMinutes = parseNumber(parts[2]);
  const maxAgeMinutes = parseNumber(parts[3]);
  const min5mVolUsd = parseNumber(parts[4]);
  const min5mChgPct = parseNumber(parts[5]);
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
    maxMarketCapUsd < minMarketCapUsd ||
    maxAgeMinutes < minAgeMinutes
  ) {
    return {
      ok: false,
      error:
        "参数无效。请用数字且保证 最高市值 ≥ 最低市值、最长上线 ≥ 最短上线: `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%>`",
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
  };
}

/** Result of a manual on-chain supply-flow check (see /flow). */
export interface FlowCheckResult {
  ok: boolean;
  /** Human-readable failure reason (ok:false). */
  error?: string;
  symbol?: string;
  marketCapUsd?: number;
  ageMin?: number;
  /** Wall-clock ms of the check itself (excluding Telegram). */
  ms?: number;
  /** True when a fresh verdict was reused from the DB cache (no re-spend). */
  cached?: boolean;
  /** True when the bot has already pushed this coin to some chat. */
  pushed?: boolean;
  /** First-push time (epoch ms) when pushed is true. */
  pushedAt?: number;
  result?: SupplyFlowResult;
}

/** Base58 mint address (32–44 chars, no 0/O/I/l). */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * createBot accepts a nullable database: without it the bot still runs
 * (welcome/help work), but settings-related commands degrade gracefully.
 * `flowAnalyzer` (optional) enables /flow — a manual on-chain supply-flow
 * check for any mint, run with the production Helius key.
 */
export function createBot(
  token: string,
  db: Db | null,
  scanIntervalSeconds: number = 300,
  flowAnalyzer?: (mint: string) => Promise<FlowCheckResult>,
  trade?: TradeService,
  adminIds: number[] = [],
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
        "还没有设置过筛选条件。用 `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%>` 设置。",
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
      enabled: true,
    });
    await ctx.reply(
      existing
        ? "✅ 推送已开启，开始监控 Solana 新币。"
        : `✅ 推送已开启（默认条件: 市值 $40K–$300K，上线 360–2400 分钟，5m 量 ≥ ${fmtUsd(
            DEFAULT_SETTINGS.min5mVolUsd,
          )}，5m 涨幅 ≥ ${DEFAULT_SETTINGS.min5mChgPct}%）。用 /filter 自定义条件。`,
    );
  });

  bot.command("flow", async (ctx) => {
    if (!flowAnalyzer) {
      await ctx.reply("🕸 供应流分析未启用（Worker 需要配置 HELIUS_API_KEY）。");
      return;
    }
    const mint = ctx.match.trim();
    if (!MINT_RE.test(mint)) {
      await ctx.reply(
        "用法: `/flow <合约地址>` — 手动检查某币的链上供应流（多钱包喂给同一接收者再卖出）\n" +
          "例如: `/flow Cqs2xNRMCSMDpGzRZ5x225kjM9dhcnTFExiu5Hf6pump`",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const startedAt = Date.now();
    const res = await flowAnalyzer(mint);
    const elapsedMs = Date.now() - startedAt;
    if (!res.ok || !res.result) {
      await ctx.reply(
        `🕸 供应流分析失败（${elapsedMs}ms）: ${res.error ?? "未知错误"}`,
      );
      return;
    }
    const r = res.result;
    const verdict = r.flagged
      ? `⚠️ 检测到集中出货: ${r.feeders} 个持仓钱包喂给同一接收者，累积 ${r.fedPct.toFixed(
          2,
        )}% 供应，该接收者卖出 ${r.sells} 次`
      : r.ok
        ? "✅ 未检测到集中出货（分析完成）"
        : "⏳ 分析未完成（数据不足），请稍后重试";
    const pushedLine = res.pushed
      ? `📤 推送记录: 已被本 bot 推过${res.pushedAt ? `（${new Date(res.pushedAt).toISOString().replace("T", " ").slice(0, 16)} UTC）` : ""}`
      : "📤 推送记录: 未曾推送";
    await ctx.reply(
      [
        `🕸 供应流分析: ${res.symbol ?? mint.slice(0, 12)}`,
        `💰 市值: ${fmtUsd(res.marketCapUsd ?? 0)} | ⏱ 上线: ${res.ageMin ?? "?"} 分钟`,
        verdict,
        pushedLine,
        `⚙️ 分析窗口: ${Math.round(r.windowMs / 3600e3)}h | 耗时: ${res.ms ?? elapsedMs}ms${res.cached ? "（缓存，30 分钟内未重新分析）" : ""}`,
      ].join("\n"),
    );
  });

  bot.command("trade", async (ctx) => {
    if (!trade) {
      await ctx.reply(
        "⚙️ 自动买入未启用（Worker 未配置 BOT_WALLET_PRIVATE_KEY）。\n\n" +
          "启用步骤:\n" +
          "1. 新建一个专用 Solana 钱包（Phantom/Solflare），存入少量 SOL\n" +
          "2. 把钱包私钥（base58）填入 Cloudflare 的 BOT_WALLET_PRIVATE_KEY 变量\n" +
          "3. 设置 TRADE_MODE（manual = 推送卡片加购买按钮 / auto = 自动下单）",
      );
      return;
    }
    const s = await trade.status();
    const modeLine =
      s.mode === "off"
        ? "⛔ 关闭（不会下单）"
        : s.mode === "manual"
          ? "🔘 手动（推送卡片带购买按钮，点击后下单）"
          : "🤖 自动（符合条件的币推送后立即下单）";
    const sourceLine = s.overrideActive
      ? "📌 当前模式由 Telegram `/setmode` 指令设定（覆盖 Cloudflare 的 TRADE_MODE）"
      : "📌 当前模式由 Cloudflare 的 TRADE_MODE 变量设定（可用 `/setmode` 指令覆盖）";
    await ctx.reply(
      [
        "⚙️ Jupiter 自动买入设置:",
        `模式: ${modeLine}`,
        sourceLine,
        `钱包: ${s.wallet ? `\`${s.wallet.slice(0, 8)}…${s.wallet.slice(-6)}\`` : "（未配置）"}`,
        `每笔金额: ${s.buySizeLabel}`,
        `滑点: ${s.slippagePct}%`,
        `每日上限: ${s.todayCount}/${s.maxDailyBuys} 笔（24h 滚动）`,
        "",
        "切换: `/setmode manual|auto|off`（仅管理员）",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  // Live trade-mode switch (admin only): stores a durable override in the DB
  // that takes precedence over the env TRADE_MODE var in every money-moving
  // path (decision gate, buy button, auto trigger) — no redeploy needed.
  bot.command("setmode", async (ctx) => {
    if (!trade) {
      await ctx.reply(
        "⚙️ 交易未启用（Worker 未配置 BOT_WALLET_PRIVATE_KEY），无法切换模式。",
      );
      return;
    }
    if (adminIds.length === 0) {
      await ctx.reply(
        "⛔ 尚未配置管理员（BOT_ADMIN_IDS）。请在 wrangler.toml 设置你的 Telegram user ID（在 @userinfobot 查询），部署后再用 /setmode。",
      );
      return;
    }
    if (!isAdmin(ctx.from?.id, adminIds)) {
      await ctx.reply("⛔ 你不是本 bot 的管理员，无法切换交易模式。");
      return;
    }
    const arg = ctx.match.trim().toLowerCase();
    if (arg !== "manual" && arg !== "auto" && arg !== "off") {
      await ctx.reply(
        "用法: `/setmode manual|auto|off`\n" +
          "- `manual` — 推送卡片带 🛒 买按钮，点击后下单\n" +
          "- `auto` — 符合条件的币推送后立即自动下单\n" +
          "- `off` — 关闭交易（一分钱都不会动）",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const label =
      arg === "off" ? "⛔ 关闭" : arg === "manual" ? "🔘 手动" : "🤖 自动";
    try {
      await trade.setModeOverride(arg);
      await ctx.reply(
        `✅ 交易模式已切换: ${label}\n` +
          `📌 该设定立即生效，并覆盖 Cloudflare 的 TRADE_MODE（用 \`/setmode off\` 或改回 env 后可恢复）。\n` +
          `用 /trade 查看当前状态。`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      await ctx.reply(
        `❌ 切换失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // Manual-mode buy button (callback data `buy:<mint>`). Executes exactly
  // one buy via TradeService; re-checks all gates (off/daily-cap/dedupe).
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data || !data.startsWith("buy:")) return;
    const token = data.slice(4);
    if (!token || !MINT_RE.test(token)) {
      await ctx.answerCallbackQuery({ text: "无效的合约地址" });
      return;
    }
    if (!trade) {
      await ctx.answerCallbackQuery({ text: "交易未启用（缺 BOT_WALLET_PRIVATE_KEY）" });
      return;
    }
    const mode = await trade.effectiveMode();
    if (mode !== "manual") {
      await ctx.answerCallbackQuery({ text: "当前非手动模式，请用 /trade 查看" });
      return;
    }
    // Real-money gate: when admins are configured, only they can tap buy.
    if (adminIds.length > 0 && !isAdmin(ctx.from?.id, adminIds)) {
      await ctx.answerCallbackQuery({ text: "你不是本 bot 的管理员，无法下单" });
      return;
    }
    await ctx.answerCallbackQuery({ text: `下单中 ${trade.buySizeLabel}…` });
    const chatId = String(
      ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id ?? "",
    );
    const { decision, result } = await trade.executeBuy(token, chatId, {
      manual: true,
    });
    const baseText = ctx.callbackQuery.message?.text ?? `🛒 ${token}`;
    const line = result
      ? result.ok
        ? `✅ 已下单 ${trade.buySizeLabel}${result.txHash ? `\n🔗 tx: ${result.txHash}` : ""}`
        : `❌ 下单失败: ${result.error ?? "未知错误"}`
      : `⏭ 未下单: ${decision.reason}`;
    try {
      await ctx.editMessageText(`${baseText}\n\n${line}`);
    } catch {
      await ctx.answerCallbackQuery({ text: line });
    }
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
      enabled: false,
    });
    await ctx.reply("⛔ 推送已关闭。用 /on 重新开启。");
  });

  return bot;
}
