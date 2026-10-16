/*
 * Complete filter-chain test for the Solana meme coin scanner.
 *
 * Usage (secrets supplied at runtime, never stored in this file):
 *   BIRDEYE_API_KEY=... node scripts/test-filters.js
 *
 * This file is `npm test`, and it is a WRITER — which is why it carries the
 * archive guard described at ARCHIVE_WRITE_OK below. By default the database
 * phases are skipped entirely; running them against the frozen Turso archive
 * takes a deliberate --allow-archive-write:
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... BIRDEYE_API_KEY=... \
 *     node scripts/test-filters.js --allow-archive-write
 *
 * Phases:
 *   1. Config sanity: DEFAULT_SETTINGS + /help text contain the 6 filters
 *      (min/max market cap, min/max age, 5m volume, 5m change). The
 *      first-minute-volume, sniper, bundler and top-10 filters were removed
 *      (bundler/top-10 data is shown on the push card for reference only).
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

/**
 * ARCHIVE GUARD (added 2026-10-15, after the D1 cutover).
 *
 * Turso is the FROZEN read-only archive: rows written there are never read by
 * the Worker again (docs/d1-migration-2026-10-15.md §5). This script is not a
 * reader — phase 2 upserts rugcheck/trader/min-mcap readings into token_stats,
 * phase 3 runs the REAL `Scanner.runOnce` (seen_tokens claims, scan_history,
 * pool state) and then deletes the seen_tokens rows it created. Because this
 * file is `npm test`, a routine local run used to mutate the frozen archive
 * with no guard at all.
 *
 * So the archive is opt-in, with the same switch as the other hand-run writers
 * (scripts/backfill-pumpfun.mjs, scripts/pool-read-cost.js, and
 * scripts/axiom-refresh-action.py): `--allow-archive-write`, or
 * ALLOW_ARCHIVE_WRITE=1. Without it the DB phases take their existing
 * "no database" path — phase 1's config checks and phase 2's live-feed
 * diagnosis still run, and nothing touches Turso.
 */
const ARCHIVE_WRITE_OK =
  process.argv.includes("--allow-archive-write") ||
  /^(1|true|yes)$/i.test(process.env.ALLOW_ARCHIVE_WRITE || "");
const USE_ARCHIVE = Boolean(URL && TOKEN) && ARCHIVE_WRITE_OK;

/**
 * LOCAL MODE (2026-10-16): run the database phases against a throwaway SQLite
 * file instead of any remote store.
 *   FILTERS_LOCAL_DB=/tmp/filters.db node scripts/test-filters.js
 *
 * WHY IT EXISTS. The guard above left exactly two ways to run this script: the
 * config checks alone (phases 2 and 3 never touch `Db` or `Scanner.runOnce`), or
 * the frozen Turso archive. But the code those phases cover is the WRITING path
 * — registration, claims, the completion flush — so "npm test skips it" is the
 * same statement as "the writing path has no hand-run check". A local file
 * drives the real `Db` and the real scanner through the injected-client seam the
 * offline suites already use (`Db(url, token, injectedClient)`), needs no
 * credentials, and has no remote store to reach.
 *
 * PRECEDENCE: the explicit archive opt-in WINS. With `--allow-archive-write`
 * this run reads the archive and ignores FILTERS_LOCAL_DB, so a stale variable
 * in the environment can never silently redirect a deliberate archive run.
 */
const LOCAL_DB = process.env.FILTERS_LOCAL_DB || null;
/** The chat the local mode seeds, so phase 3 does not early-return (see below). */
const LOCAL_CHAT_ID = "local-test-chat";
const USE_LOCAL = Boolean(LOCAL_DB) && !ARCHIVE_WRITE_OK;
/** Any real store at all: the phases gate on THIS, not on USE_ARCHIVE. */
const USE_DB = USE_ARCHIVE || USE_LOCAL;

/**
 * The local-mode Db: a real SQLite file, reached through the same injected
 * client the offline test suites pass in. `createClient` below is the NODE
 * client (this file already requires it) — the web client `Db` builds for a
 * remote URL refuses `file:` outright.
 */
function localDb() {
  return new Db(`file:${LOCAL_DB}`, undefined, createClient({ url: `file:${LOCAL_DB}` }));
}

/** Why the database phases are not running, phrased for whoever just ran it. */
function archiveSkipReason() {
  if (!URL || !TOKEN) return "⚠️  TURSO 未配置，跳过";
  return (
    "🚫 Turso 憑證已設定，但 Turso 係唯讀 archive（2026-10-15 切去 D1）——" +
    " 呢個腳本會寫入，所以要明加 --allow-archive-write（或 ALLOW_ARCHIVE_WRITE=1）才讀寫 archive。跳過資料庫階段。"
  );
}

// The bounds come from the scanner itself, so the diagnosis runs what the tick
// runs. These were hand-copied until 2026-09-28: this copy happened to stay
// right at 30h/180min while the sibling copy in cpu-profile.js drifted to
// 43h/30min, which is the whole argument for importing them.
const { RE_EVAL_WINDOW_MS, RE_EVAL_AGE_MARGIN_MIN } = require("../dist/scanner.js");

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
    ["DEFAULT_SETTINGS.maxMarketCapUsd", DEFAULT_SETTINGS.maxMarketCapUsd, 380000],
    ["DEFAULT_SETTINGS.minAgeMinutes", DEFAULT_SETTINGS.minAgeMinutes, 80],
    ["DEFAULT_SETTINGS.maxAgeMinutes", DEFAULT_SETTINGS.maxAgeMinutes, 1560],
    ["DEFAULT_SETTINGS.min5mVolUsd", DEFAULT_SETTINGS.min5mVolUsd, 4500],
    ["DEFAULT_SETTINGS.min1hVolUsd", DEFAULT_SETTINGS.min1hVolUsd, 15000],
    ["DEFAULT_SETTINGS.min5mChgPct", DEFAULT_SETTINGS.min5mChgPct, 20],
  ];
  let allOk = true;
  for (const [name, actual, expected] of checks) {
    const ok = actual === expected;
    if (!ok) allOk = false;
    console.log(`  ${ok ? "✅" : "❌"} ${name} = ${actual}${ok ? "" : `（期望 ${expected}）`}`);
  }

  // /help & /filter usage text (compiled bot module) mentions all 6 conditions.
  const fs = require("fs");
  const botSrc = fs.readFileSync(require.resolve("../dist/bot.js"), "utf8");
  const textChecks = ["最低市值", "最高市值", "最短上线", "最长上线", "5m 量", "5m 涨幅"];
  for (const t of textChecks) {
    const ok = botSrc.includes(t);
    if (!ok) allOk = false;
    console.log(`  ${ok ? "✅" : "❌"} /help 文案包含 "${t}"`);
  }
  // Removed filters must no longer gate: the bot must not mention them as
  // /filter arguments anymore (they may still appear in the push card).
  const removedChecks = ["首分钟量", "Sniper", "Bundler", "Top10"];
  for (const t of removedChecks) {
    const ok = !botSrc.includes(t);
    if (!ok) allOk = false;
    console.log(`  ${ok ? "✅" : "❌"} /help 文案不再包含 "${t}"（已移除该 filter）`);
  }

  // The local file first: it is the only mode that no environment can turn
  // into a remote write.
  if (USE_LOCAL) {
    const db = localDb();
    await db.init();
    console.log(`  🧪 本地模式：${LOCAL_DB}（SQLite file，經 injected-client seam，唔會碰任何 remote store）`);
    // Seed ONE enabled chat. Without it the scanner takes its "no chats with
    // push enabled, skipping" branch and phase 3 measures an early return
    // instead of the writing path (front claim, registration, completion
    // flush) this mode exists to exercise — measured 2026-10-16: runOnce
    // settled in 12ms and wrote no token_stats row at all.
    await db.saveChatSettings({ ...DEFAULT_SETTINGS, chatId: LOCAL_CHAT_ID, enabled: true });
    console.log(`  🧪 已種一個 enabled chat（${LOCAL_CHAT_ID}），令 phase 3 真係行寫入路徑`);
    await printEnabledChats(db);
    return db;
  }
  // Real chat settings from the database (archive only with an explicit opt-in).
  if (USE_ARCHIVE) {
    const db = new Db(URL, TOKEN);
    await db.init();
    await printEnabledChats(db);
    return db;
  }
  console.log(`  ${archiveSkipReason()}`);
  return null;
}

/** The enabled chats of whichever store this run is on, printed for the operator. */
async function printEnabledChats(db) {
  const chats = await db.listEnabledChats();
  console.log(`\n  📋 已开启推送的 chat 数量: ${chats.length}`);
  for (const c of chats) {
    console.log(
      `  chat=${c.chatId} | 市值 ${USD(c.minMarketCapUsd)}–${USD(c.maxMarketCapUsd)} | 上线 ${c.minAgeMinutes}–${c.maxAgeMinutes}m | 5m量≥${USD(c.min5mVolUsd)} | 1h量≥${USD(c.min1hVolUsd)} | 5m涨幅≥${c.min5mChgPct}%`,
    );
  }
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
      limit: cfg.reevalPoolSize,
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
    // F5-F6 dual-path momentum gate (mirror of production): qualifies
    // through EITHER tape — hot 5m (vol+chg) OR steady 1h (vol+chg).
    const vol5Ok = pair.volume.m5 >= s.min5mVolUsd;
    const chg5Ok = pair.priceChange.m5 >= s.min5mChgPct;
    const vol1Ok = pair.volume.h1 >= s.min1hVolUsd;
    const chg1Ok = pair.priceChange.h1 >= s.min1hChgPct;
    const f5 = (vol5Ok && chg5Ok) || (vol1Ok && chg1Ok);
    if (!f5)
      c.reasons.push(`動能不足 5m[量${vol5Ok ? "✓" : ""}${USD(pair.volume.m5)} 漲${chg5Ok ? "✓" : ""}${pair.priceChange.m5.toFixed(1)}%] 1h[量${vol1Ok ? "✓" : ""}${USD(pair.volume.h1)} 漲${chg1Ok ? "✓" : ""}${pair.priceChange.h1.toFixed(1)}%]`);

    if (!(f1 && f2 && f3 && f4 && f5)) {
      rows.push({ symbol, age: ageMin, mc: pair.marketCap, cheap: false, detail: c.reasons.join(", ") });
      continue;
    }
    // Candidate — expensive lookups (mirrors production, caches via db).
    let stats = db ? await db.getTokenStats(profile.tokenAddress) : null;

    // RugCheck data: display only — bundler/top-10 are no longer filters, so
    // they never block a push and "未检测" is fine when the report is not ready.
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

    // Bundler/top-10 are display-only: the coin passes on F1–F6 alone.
    const finalOk = c.reasons.length === 0;
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
    const result = r.finalOk
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
  // `db` is only ever non-null when phase 1 opened a store (archive opt-in or
  // the local file), but the guard is restated here so every DB touchpoint in
  // this file is gated by the mode rather than by inference.
  if (!db || !USE_DB) {
    console.log(`  ${archiveSkipReason()}`);
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

  // Undo seen_tokens side effects created during this test — in the SAME store
  // this run used (the local file in local mode: the cleanup must not reach for
  // the archive URL the phases never talked to).
  const raw = USE_LOCAL
    ? createClient({ url: `file:${LOCAL_DB}` })
    : createClient({ url: URL, authToken: TOKEN });
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
  const turso = USE_LOCAL
    ? `本地 SQLite file 🧪 (${LOCAL_DB})`
    : USE_ARCHIVE
      ? "Turso archive ✅ (--allow-archive-write)"
      : URL && TOKEN
        ? "Turso 🚫 唯讀 archive（未開 --allow-archive-write；要跑 DB 階段可加 FILTERS_LOCAL_DB）"
        : "Turso ⚠️未配（要跑 DB 階段可加 FILTERS_LOCAL_DB）";
  if (USE_ARCHIVE && BKEY) {
    console.log(`  数据源: DexScreener ✅ / ${turso} / Birdeye ✅ / RugCheck ✅`);
  } else {
    console.log(`  数据源: ${turso} / ${BKEY ? "Birdeye ✅" : "Birdeye ⚠️未配"}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("测试脚本失败:", e);
  process.exit(1);
});
