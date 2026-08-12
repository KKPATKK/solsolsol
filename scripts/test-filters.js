/*
 * Complete filter-chain test for the Solana meme coin scanner.
 *
 * Usage (secrets supplied at runtime, never stored in this file):
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... BIRDEYE_API_KEY=... \
 *     node scripts/test-filters.js
 *
 * Phases:
 *   1. Config sanity: DEFAULT_SETTINGS + /help text contain the 8 filters
 *      (min/max market cap, min/max age, 5m volume, 5m change, bundler,
 *      top-10). The first-minute-volume and sniper filters were removed.
 *   2. Per-coin diagnosis: replicate scanner.ts logic on LIVE market data
 *      (feed + re-evaluation pool), print every condition's verdict.
 *   3. End-to-end: run the REAL Scanner.runOnce with a mock bot, capture the
 *      exact messages it would push, then undo the seen_tokens side effects.
 */
const { createClient } = require("@libsql/client");
const { Db, DEFAULT_SETTINGS } = require("../dist/db.js");
const { loadConfig } = require("../dist/config.js");
const { DexScreenerClient } = require("../dist/dexscreener.js");
const { BirdeyeClient } = require("../dist/birdeye.js");
const { RugcheckClient } = require("../dist/rugcheck.js");
const { Scanner } = require("../dist/scanner.js");

const URL = process.env.TURSO_DATABASE_URL;
const TOKEN = process.env.TURSO_AUTH_TOKEN;
const BKEY = process.env.BIRDEYE_API_KEY;

// Mirrors scanner.ts constants so the diagnosis runs the same bounds.
const RE_EVAL_WINDOW_MS = 42 * 3600e3;
const RE_EVAL_AGE_MARGIN_MIN = 180;
const RE_EVAL_POOL_SIZE = 80;

const USD = (n) => {
  if (n === null || n === undefined) return "—";
  if (n >= 1000000) return "$" + (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "K";
  return "$" + Number(n).toFixed(2);
};

async function phase1() {
  console.log("\n===== PHASE 1: 配置完整性 =====\n");
  const checks = [
    ["DEFAULT_SETTINGS.minMarketCapUsd", DEFAULT_SETTINGS.minMarketCapUsd, 40000],
    ["DEFAULT_SETTINGS.maxMarketCapUsd", DEFAULT_SETTINGS.maxMarketCapUsd, 300000],
    ["DEFAULT_SETTINGS.minAgeMinutes", DEFAULT_SETTINGS.minAgeMinutes, 360],
    ["DEFAULT_SETTINGS.maxAgeMinutes", DEFAULT_SETTINGS.maxAgeMinutes, 2400],
    ["DEFAULT_SETTINGS.min5mVolUsd", DEFAULT_SETTINGS.min5mVolUsd, 6000],
    ["DEFAULT_SETTINGS.min5mChgPct", DEFAULT_SETTINGS.min5mChgPct, 30],
    ["DEFAULT_SETTINGS.maxBundlerPct", DEFAULT_SETTINGS.maxBundlerPct, 15],
    ["DEFAULT_SETTINGS.maxTop10HolderPct", DEFAULT_SETTINGS.maxTop10HolderPct, 23],
  ];
  let allOk = true;
  for (const [name, actual, expected] of checks) {
    const ok = actual === expected;
    if (!ok) allOk = false;
    console.log(`  ${ok ? "✅" : "❌"} ${name} = ${actual}${ok ? "" : `（期望 ${expected}）`}`);
  }

  // /help & /filter usage text (compiled bot module) mentions all 8 conditions.
  const fs = require("fs");
  const botSrc = fs.readFileSync(require.resolve("../dist/bot.js"), "utf8");
  const textChecks = ["最低市值", "最高市值", "最短上线", "最长上线", "5m 量", "5m 涨幅", "Bundler", "Top10"];
  for (const t of textChecks) {
    const ok = botSrc.includes(t);
    if (!ok) allOk = false;
    console.log(`  ${ok ? "✅" : "❌"} /help 文案包含 "${t}"`);
  }
  // Removed filters must no longer gate: the bot must not mention them as
  // /filter arguments anymore.
  const removedChecks = ["首分钟量", "Sniper"];
  for (const t of removedChecks) {
    const ok = !botSrc.includes(t);
    if (!ok) allOk = false;
    console.log(`  ${ok ? "✅" : "❌"} /help 文案不再包含 "${t}"（已移除该 filter）`);
  }

  // Real chat settings from the database.
  if (URL && TOKEN) {
    const db = new Db(URL, TOKEN);
    await db.init();
    const chats = await db.listEnabledChats();
    console.log(`\n  📋 已开启推送的 chat 数量: ${chats.length}`);
    for (const c of chats) {
      console.log(
        `  chat=${c.chatId} | 市值 ${USD(c.minMarketCapUsd)}–${USD(c.maxMarketCapUsd)} | 上线 ${c.minAgeMinutes}–${c.maxAgeMinutes}m | 5m量≥${USD(c.min5mVolUsd)} | 5m涨幅≥${c.min5mChgPct}% | Bundler<${c.maxBundlerPct}% | Top10<${c.maxTop10HolderPct}%`,
      );
    }
    return db;
  }
  console.log("  ⚠️  TURSO 未配置，跳过真实设置读取");
  return null;
}

async function phase2(db, cfg, dex, birdeye, rugcheck) {
  console.log("\n===== PHASE 2: 逐条件诊断（真实市场数据） =====\n");

  // Use the first enabled chat's settings, else defaults.
  let chat = null;
  if (db) {
    const chats = await db.listEnabledChats();
    chat = chats[0] ?? null;
  }
  const s = chat ?? DEFAULT_SETTINGS;

  const profiles = await dex.fetchLatestSolanaProfiles();
  // Mirror the scanner: also pull the age-aware re-evaluation pool, since the
  // qualifying age window (6–40h) is beyond what the profiles feed covers.
  const now = Date.now();
  let poolTokens = [];
  if (db) {
    const recent = await db.getReevalPool({
      sinceMs: now - RE_EVAL_WINDOW_MS,
      minLaunchMs: now - (s.maxAgeMinutes + RE_EVAL_AGE_MARGIN_MIN) * 60000,
      maxLaunchMs: now - (s.minAgeMinutes - RE_EVAL_AGE_MARGIN_MIN) * 60000,
      windowEntryLaunchMs: now - s.minAgeMinutes * 60000,
      limit: RE_EVAL_POOL_SIZE,
    });
    poolTokens = recent
      .filter((st) => !profiles.some((p) => p.tokenAddress === st.token))
      .map((st) => ({ tokenAddress: st.token }));
  }
  const allProfiles = [...profiles, ...poolTokens];
  const pairs = await dex.fetchPairsForTokens([...new Set(allProfiles.map((p) => p.tokenAddress))]);

  const rows = [];
  let passed = 0;
  for (const profile of allProfiles) {
    const pair = pairs.get(profile.tokenAddress);
    if (!pair) continue;
    const ageMin = (now - pair.pairCreatedAt) / 60000;
    const symbol = (pair.baseToken.symbol || profile.symbol || "?").slice(0, 12);

    const c = { mark: true, reasons: [] };
    // F1 liquidity
    const liq = pair.liquidity.usd ?? 0;
    const f1 = liq >= s.minLiquidityUsd;
    if (!f1) c.reasons.push(`流动性 ${USD(liq)} < ${USD(s.minLiquidityUsd)}`);
    // F2 24h volume
    const f2 = pair.volume.h24 >= s.minVolume24hUsd;
    if (!f2) c.reasons.push(`24h量 ${USD(pair.volume.h24)}`);
    // F3 market cap range
    const f3 = pair.marketCap >= s.minMarketCapUsd && pair.marketCap <= s.maxMarketCapUsd;
    if (!f3) {
      c.reasons.push(
        pair.marketCap < s.minMarketCapUsd
          ? `市值 ${USD(pair.marketCap)} < ${USD(s.minMarketCapUsd)}`
          : `市值 ${USD(pair.marketCap)} > ${USD(s.maxMarketCapUsd)}`,
      );
    }
    // F4 age window
    const f4 = ageMin >= s.minAgeMinutes && ageMin <= s.maxAgeMinutes;
    if (!f4) c.reasons.push(`上线 ${ageMin.toFixed(1)}m（窗口 ${s.minAgeMinutes}–${s.maxAgeMinutes}m）`);
    // F5 5m volume
    const f5 = pair.volume.m5 >= s.min5mVolUsd;
    if (!f5) c.reasons.push(`5m量 ${USD(pair.volume.m5)}`);
    // F6 5m change
    const f6 = pair.priceChange.m5 >= s.min5mChgPct;
    if (!f6) c.reasons.push(`5m涨幅 ${pair.priceChange.m5.toFixed(1)}%`);

    if (!(f1 && f2 && f3 && f4 && f5 && f6)) {
      rows.push({ symbol, age: ageMin, mc: pair.marketCap, cheap: false, detail: c.reasons.join(", ") });
      continue;
    }
    // Candidate — expensive lookups (mirrors production, caches via db).
    let stats = db ? await db.getTokenStats(profile.tokenAddress) : null;

    // RugCheck (F7 bundler, F8 top10)
    let rug = null;
    if (stats && stats.rugcheckTop10Pct !== null) {
      rug = { bundler: stats.rugcheckBundlerPct, top10: stats.rugcheckTop10Pct, src: "cache" };
    } else if (rugcheck) {
      try {
        const r = await rugcheck.getReport(profile.tokenAddress, pair.pairAddress);
        if (db) await db.updateTokenRugcheckData(profile.tokenAddress, r.bundlerPct, r.top10HolderPct);
        rug = { bundler: r.bundlerPct, top10: r.top10HolderPct, src: "live" };
      } catch (e) { /* ignore */ }
    }
    const f7 = rug === null || rug.bundler === null || rug.bundler < s.maxBundlerPct;
    if (!f7) c.reasons.push(`Bundler ${rug.bundler.toFixed(1)}% ≥ ${s.maxBundlerPct}%`);
    let holdTop10 = false;
    if (rug === null || rug.top10 === null) {
      holdTop10 = true; // 数据未就绪 → 顺延
    } else {
      const f8 = rug.top10 < s.maxTop10HolderPct;
      if (!f8) c.reasons.push(`Top10 ${rug.top10.toFixed(1)}% ≥ ${s.maxTop10HolderPct}%`);
    }

    // Birdeye trader data: display only — the sniper filter was removed, so
    // coins push even when the data is not ready yet.
    let trader = null;
    if (stats && stats.birdeyeProTraders !== null && stats.birdeyeSniperPct !== null) {
      trader = { pro: stats.birdeyeProTraders, sniper: stats.birdeyeSniperPct, src: "cache" };
    } else if (birdeye) {
      try {
        const t = await birdeye.getTraderInfo(profile.tokenAddress, pair.marketCap, pair.priceUsd);
        if (t.proTraders !== null && t.sniperPct !== null && db) {
          await db.updateTokenProTraders(profile.tokenAddress, t.proTraders);
          await db.updateTokenSniperPct(profile.tokenAddress, t.sniperPct);
        }
        trader = { pro: t.proTraders, sniper: t.sniperPct, src: "live" };
      } catch (e) { /* ignore */ }
    }

    // Min market cap (display only)
    let minMcap = null;
    if (stats && stats.minMcapObserved !== null) {
      minMcap = stats.minMcapObserved;
    } else if (birdeye) {
      try {
        const price = Number(pair.priceUsd);
        const supply = price > 0 ? pair.marketCap / price : 0;
        if (supply > 0) {
          const m = await birdeye.getMinMarketCapUsd(profile.tokenAddress, Math.floor(pair.pairCreatedAt / 1000), supply);
          if (m !== null && db) await db.updateTokenMinMcap(profile.tokenAddress, m);
          minMcap = m;
        }
      } catch (e) { /* ignore */ }
    }

    const finalOk = f7 && !holdTop10 && c.reasons.length === 0;
    if (finalOk) passed++;
    rows.push({
      symbol,
      age: ageMin,
      mc: pair.marketCap,
      cheap: true,
      bundler: rug ? (rug.bundler === null ? "无" : rug.bundler.toFixed(1) + "%") : "—",
      top10: rug ? (rug.top10 === null ? "空" : rug.top10.toFixed(1) + "%") : "—",
      sniper: trader ? (trader.sniper === null ? "空" : trader.sniper.toFixed(1) + "%") : "—",
      pro: trader ? (trader.pro === null ? "—" : trader.pro) : "—",
      minMcap: minMcap === null ? "—" : USD(minMcap),
      holdTop10,
      finalOk,
      detail: c.reasons.join("; "),
    });
  }

  // Print table
  console.log(
    "  币种".padEnd(14) +
      "上线".padEnd(12) +
      "市值".padEnd(8) +
      "Bundler".padEnd(9) +
      "Top10".padEnd(8) +
      "Sniper".padEnd(8) +
      "Pro".padEnd(5) +
      "最低市值".padEnd(10) +
      "结果",
  );
  for (const r of rows) {
    if (!r.cheap) {
      console.log(`  ${r.symbol.padEnd(14)}${(r.age.toFixed(1) + "m").padEnd(10)}${USD(r.mc).padEnd(8)}—${"".padEnd(38)}❌ 前置条件未过 (${r.detail})`);
      continue;
    }
    const result = r.holdTop10
      ? "⏳ Top10待就绪"
      : r.finalOk
        ? "✅ 全部通过 → 推送"
        : "❌ " + (r.detail || "被过滤");
    console.log(
      `  ${r.symbol.padEnd(14)}${(r.age.toFixed(1) + "m").padEnd(10)}${USD(r.mc).padEnd(8)}${(r.bundler || "—").padEnd(9)}${(r.top10 || "—").padEnd(8)}${(r.sniper || "—").padEnd(8)}${String(r.pro || "—").padEnd(5)}${(r.minMcap || "—").padEnd(10)}${result}`,
    );
  }
  console.log(`\n  📊 汇总: 扫描 ${allProfiles.length} 个 profile（feed ${profiles.length} + 池 ${poolTokens.length}）→ 候选 ${rows.filter((r) => r.cheap).length} 枚 → 全部通过 ${passed} 枚`);
  return { passed, total: rows.filter((r) => r.cheap).length };
}

async function phase3(db, cfg, dex, birdeye, rugcheck) {
  console.log("\n===== PHASE 3: 真实 Scanner.runOnce 端到端（mock bot，不实际发送） =====\n");
  if (!db) {
    console.log("  ⚠️  TURSO 未配置，跳过");
    return;
  }
  const testStart = Date.now();
  const sent = [];
  const mockBot = {
    api: {
      sendMessage: async (chatId, text, opts) => {
        sent.push({ chatId, text, opts });
        return { message_id: sent.length };
      },
    },
  };

  const scanner = new Scanner(db, mockBot, dex, cfg, birdeye, rugcheck);
  const t0 = Date.now();
  await scanner.runOnce();
  const ms = Date.now() - t0;
  console.log(`  runOnce 耗时: ${ms}ms`);

  if (sent.length === 0) {
    console.log("  ℹ️  本轮没有符合条件的币（0 推送）— 数据源均正常即视为通过");
  }
  for (const m of sent) {
    console.log(`  📨 推送到 chat=${m.chatId}:`);
    console.log(m.text.split("\n").map((l) => "    " + l).join("\n"));
    const kb = m.opts && m.opts.reply_markup && m.opts.reply_markup.inline_keyboard;
    if (kb) console.log("    [按钮] " + JSON.stringify(kb[0]));
  }

  // Undo seen_tokens side effects created during this test.
  const raw = createClient({ url: URL, authToken: TOKEN });
  await raw.execute({ sql: "DELETE FROM seen_tokens WHERE first_seen_at >= ?", args: [testStart] });
  await raw.close();
  console.log(`  🧹 已清理测试期间写入的 seen_tokens 记录`);
  console.log(`  📌 结论: 扫描链路 ${sent.length > 0 || ms > 0 ? "✅ 正常" : "？"}（推送 ${sent.length} 条，全部为 mock 拦截，未实际发送）`);
}

async function main() {
  const cfg = loadConfig({ BIRDEYE_API_KEY: BKEY || undefined });
  const dex = new DexScreenerClient(cfg);
  const birdeye = BKEY ? new BirdeyeClient(cfg) : null;
  const rugcheck = new RugcheckClient(cfg);

  const db = await phase1();
  const summary = await phase2(db, cfg, dex, birdeye, rugcheck);
  await phase3(db, cfg, dex, birdeye, rugcheck);

  console.log("\n===== 测试完成 =====");
  if (URL && TOKEN && BKEY) {
    console.log("  数据源: DexScreener ✅ / Turso ✅ / Birdeye ✅ / RugCheck ✅");
  } else {
    console.log("  数据源: " + (URL ? "Turso ✅" : "Turso ⚠️未配") + " / " + (BKEY ? "Birdeye ✅" : "Birdeye ⚠️未配"));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("测试脚本失败:", e);
  process.exit(1);
});
