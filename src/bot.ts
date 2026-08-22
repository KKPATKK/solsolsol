import { Bot, type Context } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { isAdmin } from "./config";
import { DEFAULT_SETTINGS, type Db } from "./db";
import { fmtUsd, parseNumber } from "./format";
import type { SupplyFlowResult } from "./helius";
import {
  nextTradeMode,
  parseModeCallback,
  parseSellCallback,
  type SellFraction,
  type TradeMode,
} from "./jupiter";
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
    "`/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%>` — 设置筛选条件（另有可选 1h涨幅/流动性/1h量 参数）",
    "`/flow <合约地址>` — 手动检查某币的链上供应流（多钱包喂给同一接收者再卖出）",
    "`/trade` — 查看 Jupiter 自动买入设置",
    "`/setmode <manual|auto|off>` — 切换交易模式（仅管理员）",
    "`/sell <合约地址> <half|all>` — 卖出持仓（一半或全部，仅管理员）",
    "`/status` — 查看当前条件",
    "`/on` — 开启推送",
    "`/off` — 关闭推送",
    "`/help` — 帮助",
    "",
    "默认条件: 市值 $40K–$300K，上线 300–1680 分钟，5m 量 ≥ $6,000，5m 涨幅 ≥ 30%",
    "例子: `/filter 40000 300000 300 1680 6000 30`",
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
      /** Optional 7th /filter arg — the compound gate's 1h leg (default 40). */
      min1hChgPct: number;
      /** Optional 8th /filter arg — the liquidity floor in USD (default
       * DEFAULT_SETTINGS.minLiquidityUsd). Blocks LP-pulled soft-rugs. */
      minLiquidityUsd: number;
      /** Optional 9th /filter arg — the 1h volume floor in USD (default
       * DEFAULT_SETTINGS.min1hVolUsd). Requires sustained interest, not a
       * single 5m print. 0 disables. */
      min1hVolUsd: number;
    }
  | { ok: false; error: string };

export function parseFilterArgs(parts: string[]): ParsedFilter {
  const USAGE =
    "用法: `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%> [最低1h涨幅%] [最低流动性USD] [最低1h量USD]`\n例如（= 当前默认档）: `/filter 40000 380000 80 1260 4500 20 40 10000 15000`\n合格条件 = 二选一路径：**5m路径**（第5参数量 且 第6参数涨幅）或 **1h路径**（1h涨幅 ≥ 第7参数 且 1h量 ≥ 第9参数）。第7参数省略默认 40；第8参数 = 流动性门槛（默认 $10K，0 停用）；第9参数 = 1h量门槛（默认 $15K，0 停用）";
  if (parts.length !== 6 && parts.length !== 7 && parts.length !== 8 && parts.length !== 9) {
    return { ok: false, error: USAGE };
  }
  const minMarketCapUsd = parseNumber(parts[0]);
  const maxMarketCapUsd = parseNumber(parts[1]);
  const minAgeMinutes = parseNumber(parts[2]);
  const maxAgeMinutes = parseNumber(parts[3]);
  const min5mVolUsd = parseNumber(parts[4]);
  const min5mChgPct = parseNumber(parts[5]);
  const min1hChgPct = parts.length >= 7 ? parseNumber(parts[6]) : 40;
  const minLiquidityUsd = parts.length >= 8 ? parseNumber(parts[7]) : DEFAULT_SETTINGS.minLiquidityUsd;
  const min1hVolUsd = parts.length === 9 ? parseNumber(parts[8]) : DEFAULT_SETTINGS.min1hVolUsd;
  if (
    minMarketCapUsd === null ||
    maxMarketCapUsd === null ||
    minAgeMinutes === null ||
    maxAgeMinutes === null ||
    min5mVolUsd === null ||
    min5mChgPct === null ||
    min1hChgPct === null ||
    minLiquidityUsd === null ||
    min1hVolUsd === null ||
    minMarketCapUsd < 0 ||
    maxMarketCapUsd < 0 ||
    minAgeMinutes <= 0 ||
    maxAgeMinutes <= 0 ||
    min5mVolUsd < 0 ||
    min1hVolUsd < 0 ||
    maxMarketCapUsd < minMarketCapUsd ||
    maxAgeMinutes < minAgeMinutes
  ) {
    return {
      ok: false,
      error:
        "参数无效。请用数字且保证 最高市值 ≥ 最低市值、最长上线 ≥ 最短上线: `/filter <最低市值USD> <最高市值USD> <最短上线分钟> <最长上线分钟> <最低5m量USD> <最低5m涨幅%> [最低1h涨幅%] [最低流动性USD] [最低1h量USD]`\n合格 = 5m路径（量+涨幅同达标）或 1h路径（涨幅+量同达标）",
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
    min1hChgPct,
    minLiquidityUsd,
    min1hVolUsd,
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

/** Axiom trade token page (mint address appended) — inline button on cards. */
const AXIOM_BASE_URL = "https://axiom.trade/t/";

/**
 * Inline keyboard for a push card / bought card: the Axiom link plus the
 * trade actions. Buy renders only in manual mode (auto already bought and
 * dedupe blocks a second buy); sell buttons render in any non-off mode —
 * they are exits, useful exactly when the bot auto-bought.
 */
export function tradeKeyboard(
  token: string,
  buySizeLabel: string,
  mode: TradeMode,
  opts: { modeSwitch?: boolean; unwatch?: boolean } = {},
): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [
    [{ text: "🔗 打开 Axiom 页面", url: `${AXIOM_BASE_URL}${token}` }],
  ];
  const actions: InlineKeyboardButton[] = [];
  if (mode === "manual") {
    actions.push({ text: `🛒 買入 ${buySizeLabel}`, callback_data: `buy:${token}` });
  }
  if (mode !== "off") {
    actions.push(
      { text: "📉 賣一半", callback_data: `sell:half:${token}` },
      { text: "📉 全賣", callback_data: `sell:all:${token}` },
    );
  }
  if (actions.length > 0) rows.push(actions);
  // Global trade-mode switch (admin-only tap, two-step confirm) — shown on
  // every card when trading is configured, in every mode (off included, so
  // trading can be switched on straight from a card).
  if (opts.modeSwitch) {
    rows.push([
      { text: `⚙️ 模式: ${mode}`, callback_data: `mode:toggle:${token}` },
    ]);
  }
  // Stop-tracking button (push cards): removes the coin from post-push
  // tracking so 🚀/⚠️/🩸/🏁 follow-ups stop arriving.
  if (opts.unwatch) {
    rows.push([
      { text: "🔕 停止追蹤", callback_data: `unwatch:${token}` },
    ]);
  }
  return rows;
}

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
      minVolume24hUsd: existing?.minVolume24hUsd ?? DEFAULT_SETTINGS.minVolume24hUsd,
      minMarketCapUsd: parsed.minMarketCapUsd,
      maxMarketCapUsd: parsed.maxMarketCapUsd,
      minAgeMinutes: parsed.minAgeMinutes,
      maxAgeMinutes: parsed.maxAgeMinutes,
      min5mVolUsd: parsed.min5mVolUsd,
      min1hVolUsd: parsed.min1hVolUsd,
      min5mChgPct: parsed.min5mChgPct,
      min1hChgPct: parsed.min1hChgPct,
      minLiquidityUsd: parsed.minLiquidityUsd,
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
        `📊 最低 1h 量: ${fmtUsd(parsed.min1hVolUsd)}${parsed.min1hVolUsd === 0 ? "（已停用）" : ""}`,
        `⚡ 合格涨幅: 5m ≥ ${parsed.min5mChgPct}% 或 1h ≥ ${parsed.min1hChgPct}%`,
        `💧 最低流动性: ${fmtUsd(parsed.minLiquidityUsd)}${parsed.minLiquidityUsd === 0 ? "（已停用）" : ""}`,
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
      min1hVolUsd: existing?.min1hVolUsd ?? DEFAULT_SETTINGS.min1hVolUsd,
      min5mChgPct: existing?.min5mChgPct ?? DEFAULT_SETTINGS.min5mChgPct,
      min1hChgPct: existing?.min1hChgPct ?? DEFAULT_SETTINGS.min1hChgPct,
      enabled: true,
    });
    await ctx.reply(
      existing
        ? "✅ 推送已开启，开始监控 Solana 新币。"
        : `✅ 推送已开启（默认条件: 市值 $40K–$300K，上线 300–1680 分钟，5m 量 ≥ ${fmtUsd(
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

  // Buy/sell buttons (callback data `buy:<mint>` / `sell:<half|all>:<mint>`).
  // Every tap re-checks the gates (off mode, admin) before any money moves;
  // edits keep the trade keyboard so the position can be managed in place.
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (
      !data ||
      (!data.startsWith("buy:") &&
        !data.startsWith("sell:") &&
        !data.startsWith("mode:") &&
        !data.startsWith("unwatch:"))
    )
      return;

    // 🔔 unwatch: tombstone the push_watch row — no more follow-up alerts
    // (🚀/⚠️/🩸/🏁) for it. A tombstone (not DELETE) is required because the
    // tracker's self-heal re-enrolls pushed coins missing from the table.
    // Admin-gated like the trade buttons; the card's keyboard is cleared so
    // the tap has a visible effect.
    if (data.startsWith("unwatch:")) {
      const token = data.slice("unwatch:".length);
      if (adminIds.length === 0 || !isAdmin(ctx.from?.id, adminIds)) {
        await ctx.answerCallbackQuery({ text: "你不是本 bot 的管理员，无法操作" });
        return;
      }
      if (!db) {
        await ctx.answerCallbackQuery({ text: "数据库未配置，无法停止追蹤" });
        return;
      }
      await db.setPushWatchState(token, "unwatched");
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.answerCallbackQuery({ text: "🔕 已停止追蹤，不再收到跟進警報" });
      return;
    }

    // ⚙️ mode switch: toggle (asks for confirmation) / apply / cancel. Global
    // action — the token only exists to re-render the right card.
    const modeCb = parseModeCallback(data);
    if (modeCb) {
      if (!trade) {
        await ctx.answerCallbackQuery({ text: "交易未启用（缺 BOT_WALLET_PRIVATE_KEY）" });
        return;
      }
      if (adminIds.length === 0 || !isAdmin(ctx.from?.id, adminIds)) {
        await ctx.answerCallbackQuery({ text: "你不是本 bot 的管理员，无法切换模式" });
        return;
      }
      const token = modeCb.token;
      const currentMode = await trade.effectiveMode();
      const label = trade.buySizeLabel;
      const modeLabel = (m: TradeMode) =>
        m === "auto" ? "🤖 自動" : m === "manual" ? "🔘 手動" : "⛔ 關閉";
      if (modeCb.action === "toggle") {
        const next = nextTradeMode(currentMode);
        const kb = tradeKeyboard(token, label, currentMode, { modeSwitch: true });
        // Replace the mode row with the confirmation pair.
        kb[kb.length - 1] = [
          { text: `✅ 切換到 ${modeLabel(next)}`, callback_data: `mode:apply:${next}:${token}` },
          { text: "❌ 取消", callback_data: `mode:cancel:${token}` },
        ];
        await ctx.answerCallbackQuery({ text: `確認切換到 ${modeLabel(next)}？` });
        await ctx.editMessageReplyMarkup({
          reply_markup: { inline_keyboard: kb },
        });
        return;
      }
      if (modeCb.action === "cancel") {
        await ctx.answerCallbackQuery({ text: "已取消" });
        await ctx.editMessageReplyMarkup({
          reply_markup: {
            inline_keyboard: tradeKeyboard(token, label, currentMode, { modeSwitch: true }),
          },
        });
        return;
      }
      // apply: persist the override and re-render with the new mode.
      const next = modeCb.mode ?? currentMode;
      try {
        await trade.setModeOverride(next);
      } catch (err) {
        await ctx.answerCallbackQuery({
          text: `❌ 切换失败: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      await ctx.editMessageReplyMarkup({
        reply_markup: {
          inline_keyboard: tradeKeyboard(token, label, next, { modeSwitch: true }),
        },
      });
      await ctx.answerCallbackQuery({ text: `✅ 已切換到 ${modeLabel(next)}` });
      return;
    }

    const sell = parseSellCallback(data);
    const token = sell ? sell.token : data.slice(4);
    if (!token || !MINT_RE.test(token)) {
      await ctx.answerCallbackQuery({ text: "无效的合约地址" });
      return;
    }
    if (!trade) {
      await ctx.answerCallbackQuery({ text: "交易未启用（缺 BOT_WALLET_PRIVATE_KEY）" });
      return;
    }
    const mode = await trade.effectiveMode();
    if (mode === "off") {
      await ctx.answerCallbackQuery({ text: "交易模式为关闭（off），请用 /setmode 开启" });
      return;
    }
    // Real-money gate: when admins are configured, only they can tap.
    if (adminIds.length > 0 && !isAdmin(ctx.from?.id, adminIds)) {
      await ctx.answerCallbackQuery({ text: "你不是本 bot 的管理员，无法交易" });
      return;
    }
    const chatId = String(
      ctx.chat?.id ?? ctx.callbackQuery.message?.chat.id ?? "",
    );
    const baseText =
      ctx.callbackQuery.message?.text ?? (sell ? `📉 ${token}` : `🛒 ${token}`);
    const keyboard = tradeKeyboard(token, trade.buySizeLabel, mode, {
      modeSwitch: true,
    });

    if (sell) {
      await ctx.answerCallbackQuery({
        text: `卖出中（${sell.mode === "all" ? "全部" : "一半"}）…`,
      });
      const out = await trade.sell(token, sell.mode, chatId);
      const line =
        out.ok && out.result?.ok
          ? `✅ 已卖出 ${out.result.amountUi !== undefined ? `${out.result.amountUi.toFixed(4)} ` : ""}(${sell.mode === "all" ? "全部" : "一半"})${out.result.txHash ? `\n🔗 tx: ${out.result.txHash}` : ""}`
          : `❌ 卖出失败: ${out.result?.error ?? out.reason ?? "未知错误"}`;
      try {
        await ctx.editMessageText(`${baseText}\n\n${line}`, {
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch {
        await ctx.answerCallbackQuery({ text: line });
      }
      return;
    }

    await ctx.answerCallbackQuery({ text: `下单中 ${trade.buySizeLabel}…` });
    const { decision, result } = await trade.executeBuy(token, chatId, {
      manual: true,
    });
    const line = result
      ? result.ok
        ? `✅ 已下单 ${trade.buySizeLabel}${result.txHash ? `\n🔗 tx: ${result.txHash}` : ""}`
        : `❌ 下单失败: ${result.error ?? "未知错误"}`
      : `⏭ 未下单: ${decision.reason}`;
    try {
      // After a successful buy keep the trade keyboard so the position can
      // be exited right from the card (editMessageText drops it otherwise).
      await ctx.editMessageText(`${baseText}\n\n${line}`, {
        ...(result?.ok ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
    } catch {
      await ctx.answerCallbackQuery({ text: line });
    }
  });

  // Sell by contract address (admin only) — works even when the push card is
  // long gone. `half` sells 50% of the held balance, `all` sells everything.
  bot.command("sell", async (ctx) => {
    if (!trade) {
      await ctx.reply("⚙️ 交易未启用（缺 BOT_WALLET_PRIVATE_KEY），无法卖出。");
      return;
    }
    if (adminIds.length === 0 || !isAdmin(ctx.from?.id, adminIds)) {
      await ctx.reply("⛔ 你不是本 bot 的管理员，无法卖出。");
      return;
    }
    const mode = await trade.effectiveMode();
    if (mode === "off") {
      await ctx.reply("⛔ 交易模式为关闭（off），请先 /setmode manual 或 auto。");
      return;
    }
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const fraction: SellFraction | null =
      parts[1] === "half" || parts[1] === "all" ? parts[1] : null;
    if (parts.length !== 2 || !fraction || !MINT_RE.test(parts[0])) {
      await ctx.reply(
        "用法: `/sell <合约地址> <half|all>`\n" +
          "- `half` — 卖出持仓的一半\n" +
          "- `all` — 卖出全部持仓\n" +
          "例如: `/sell Cqs2xNRMCSMDpGzRZ5x225kjM9dhcnTFExiu5Hf6pump half`",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const token = parts[0];
    const chatId = String(ctx.chat?.id ?? "");
    await ctx.reply(
      `📉 正在卖出 ${token.slice(0, 8)}…（${fraction === "all" ? "全部" : "一半"}）`,
    );
    const out = await trade.sell(token, fraction, chatId);
    if (out.ok && out.result?.ok) {
      await ctx.reply(
        `✅ 已卖出 ${out.result.amountUi !== undefined ? `${out.result.amountUi.toFixed(4)} ` : ""}(${fraction === "all" ? "全部" : "一半"})${out.result.txHash ? `\n🔗 tx: ${out.result.txHash}` : ""}`,
      );
    } else {
      await ctx.reply(
        `❌ 卖出失败: ${out.result?.error ?? out.reason ?? "未知错误"}`,
      );
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
      min1hVolUsd: existing?.min1hVolUsd ?? DEFAULT_SETTINGS.min1hVolUsd,
      min5mChgPct: existing?.min5mChgPct ?? DEFAULT_SETTINGS.min5mChgPct,
      min1hChgPct: existing?.min1hChgPct ?? DEFAULT_SETTINGS.min1hChgPct,
      enabled: false,
    });
    await ctx.reply("⛔ 推送已关闭。用 /on 重新开启。");
  });

  return bot;
}
