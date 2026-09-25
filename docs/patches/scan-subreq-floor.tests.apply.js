#!/usr/bin/env node
/**
 * `scan-subreq-floor.apply.js` 嘅測試同文件。
 *
 * 1. `scripts/test-deferred-priority.js` 加一個**真** scanner tick 嘅測試：
 *    有 room 時每個可選腿照跑；到地板時只有可選腿讓路，主腿（DexScreener
 *    profiles / gecko new_pools / Jupiter recent）照跑，而且每個被放棄嘅腿都
 *    有名有姓（`summary.subreqSkip`）；冇 probe 嘅 caller 行為完全不變。
 * 2. `docs/round-trips.md` §4.11：live 量度（subrequest host split）、
 *    「row loop 已經係一個 batch」嘅更正、`summary.dbTickSteps` 新讀數、
 *    scan 側地板嘅細節同下一步。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 0 file(s) written）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const TEST_FN = lines(
  "// ---------- the scan-side subrequest floor (see SCAN_SUBREQ_FLOOR) --------",
  "// The invocation's 50 subrequests are SHARED, and the tracker pass runs LAST:",
  "// it carries its own reserve but it cannot claw back what the scan already",
  "// spent (live 2026-09-25: a cron tick's window read `total 32 | turso 29`).",
  "// The scan is the only phase with optional work, so this drives a real tick",
  "// twice — room, then at the floor — and asserts WHICH legs were asked.",
  "async function subreqFloorTest() {",
  '  const { Db } = require("../dist/db.js");',
  '  const { Scanner, SCAN_SUBREQ_FLOOR } = require("../dist/scanner.js");',
  '  const { createClient } = require("@libsql/client");',
  '  const fs = require("node:fs");',
  '  const os = require("node:os");',
  '  const path = require("node:path");',
  "  const p = path.join(os.tmpdir(), `subreq-floor-${process.pid}-${Date.now()}.db`);",
  '  const client = createClient({ url: `file:${p}` });',
  "  const stubFeed = (body) => {",
  "    globalThis.fetch = async () =>",
  "      new Response(JSON.stringify(body), {",
  '        status: 200,',
  '        headers: { "Content-Type": "application/json" },',
  "      });",
  "  };",
  "  try {",
  "    assert.equal(",
  "      SCAN_SUBREQ_FLOOR,",
  "      12,",
  '      "the floor is the tail\'s arithmetic as one movable constant (pass reserve 6 + grouped telemetry + flush + drain slice)",',
  "    );",
  "    const db = new Db(p, undefined, client);",
  "    await db.init();",
  "    // Every OPTIONAL leg armed (the live worker sets the same vars in",
  "    // wrangler.toml), and the pump.fun fallback off so the launch chain is",
  "    // exactly gecko → meteora in this test.",
  "    const cfg = loadConfig({",
  '      METEORA_FALLBACK_LIMIT: "20",',
  '      GECKOTERMINAL_TRENDING_LIMIT: "20",',
  '      JUPITER_TRENDING_LIMIT: "100",',
  '      PUMPFUN_PROFILE_LIMIT: "0",',
  '      PUMPFUN_FALLBACK_LIMIT: "0",',
  "    });",
  "    await db.saveChatSettings({",
  '      chatId: "chat-floor",',
  "      minLiquidityUsd: 0, minVolume24hUsd: 0, minMarketCapUsd: 0,",
  "      maxMarketCapUsd: 10_000_000, minAgeMinutes: 0, maxAgeMinutes: 100_000,",
  "      min5mVolUsd: 0, min1hVolUsd: 0, min5mChgPct: 0, min1hChgPct: 0,",
  "      enabled: true,",
  "    });",
  "    const dex = new DexScreenerClient(cfg);",
  "    dex.fetchPairsForTokens = async () => new Map();",
  "    // The tick driver: fresh fakes per tick, so the asked-legs list cannot",
  "    // leak between the two runs.",
  "    const runTick = async (probe) => {",
  "      const asked = [];",
  "      const gecko = {",
  '        fetchNewPools: async () => { asked.push("geo"); return []; },',
  '        fetchTrendingPools: async () => { asked.push("geoTrend"); return []; },',
  "      };",
  "      const jupiter = {",
  '        fetchRecentTokens: async () => { asked.push("jup"); return []; },',
  '        fetchTrendingTokens: async () => { asked.push("jupTrend"); return []; },',
  "      };",
  "      const meteora = {",
  '        fetchNewestPools: async () => { asked.push("meteora"); return []; },',
  "      };",
  "      const crimeWallets = {",
  '        refreshIfStale: async () => { asked.push("crime-refresh"); },',
  "      };",
  "      const scanner = new Scanner(",
  "        db, { api: { sendMessage: async () => ({}) } }, dex, cfg,",
  "        null, null, null, null, null,",
  "        gecko, jupiter, null, null, null, crimeWallets, null, null, meteora,",
  "      );",
  "      await scanner.runOnce(probe);",
  "      return { scanner, asked: [...new Set(asked)].sort() };",
  "    };",
  "",
  "    // ROOM: every optional leg is asked, exactly as before this change.",
  '    stubFeed([{ chainId: "solana", tokenAddress: "FLOOR_ROOM", symbol: "R" }]);',
  "    const room = await runTick(() => 30);",
  '    assert.deepEqual(',
  "      room.asked,",
  '      ["crime-refresh", "geo", "geoTrend", "jup", "jupTrend", "meteora"],',
  '      "with room, every optional leg still runs",',
  "    );",
  '    assert.equal(room.scanner.lastSummary.subreqFloor, undefined, "and the summary claims no floor it did not apply");',
  "    assert.equal(room.scanner.lastSummary.subreqSkip, undefined);",
  "",
  "    // THE FLOOR: the optional legs yield, the PRIMARY feeds do not.",
  '    stubFeed([{ chainId: "solana", tokenAddress: "FLOOR_LOW", symbol: "L" }]);',
  "    const low = await runTick(() => SCAN_SUBREQ_FLOOR - 8);",
  '    assert.deepEqual(',
  "      low.asked,",
  '      ["geo", "jup"],',
  '      "the floor yields the optional legs and nothing else — DexScreener profiles, gecko new_pools and Jupiter recent launches still run",',
  "    );",
  "    assert.equal(low.scanner.lastSummary.subreqFloor, SCAN_SUBREQ_FLOOR);",
  '    assert.deepEqual(',
  "      low.scanner.lastSummary.subreqSkip.slice().sort(),",
  '      ["crime-refresh", "geoTrend", "jupTrend", "meteora"],',
  '      "and every dropped leg is NAMED, so a quiet momentum feed cannot be read as an upstream outage",',
  "    );",
  "",
  "    // NO PROBE = no floor: a scanner driven without the worker (every test",
  "    // that predates this, and the local runner) owns no invocation window and",
  "    // must behave exactly as it did before.",
  "    stubFeed([]);",
  "    const unbounded = await runTick(undefined);",
  '    assert.ok(unbounded.asked.includes("meteora"), "an unbounded caller drops nothing at all");',
  "    assert.equal(unbounded.scanner.lastSummary.subreqFloor, undefined);",
  "  } finally {",
  "    await client.close();",
  "    try {",
  "      fs.unlinkSync(p);",
  "    } catch {",
  "      /* best-effort */",
  "    }",
  "  }",
  "}",
  "",
);

const DOC_4_9 = lines(
  "scan 側先留配額（scanner 現時完全唔讀 `subreqRemaining`）。",
  "",
  "> **2026-09-25 更正（見 §4.11）**：上面「一行一個 claim/check UPDATE ⇒ 一次 ~30」係",
  "> **舊**事實。`claimPushWatchChecksMany` 已經把靜默行嘅 CAS 全部 pipeline 成**一個**",
  "> HTTP request（libsql 嘅 `batch()` 係一次 `/v2/pipeline`：open stream → execute →",
  "> close），live pass note 讀 `spend[… rows 282/1 …] trips 5` —— 28 行輪替 = **1 個**",
  "> subrequest。所以「30/50 嘅大頭」唔喺 row loop，而係散喺 front／tail 十幾條一次性",
  "> statement 度。量度同下一步見 §4.11。",
);

const DOC_4_11 = lines(
  "`fresh` 就夠。",
  "",
  "---",
  "",
  "## 4.11 一個 tick 嘅 subrequest 到底去咗邊（2026-09-25）＋ scan 側地板",
  "",
  "**量度**（live `/health` → `heartbeat.subreqs`，2026-09-25 03:30–03:50Z）",
  "",
  "| window | total | 去咗邊 |",
  "|---|---|---|",
  "| 有 scan 嘅 tick（最重嗰個） | 32 | turso 29、lite-api 2、api 1 |",
  "| 另一個 tick | 24 | turso 23、api 1 |",
  "| `/health` 自觸發嘅 invocation | 23 | turso 12、dexscreener 6、gecko 2、jup 2、pump 1 |",
  "| 跳過 scan 嘅 tick | 11 / 16 | **全部 turso** |",
  "",
  "**結論一：row loop 已經唔係大頭。** `claimPushWatchChecksMany` 一次 `batch()` = 一個",
  "HTTP request，所以 28 行輪替 = 1 個 subrequest（pass note `rows 282/1`）。一行一個",
  "claim 嘅年代已經過去，§4.9 嗰句已更正。",
  "",
  "**結論二：大頭係「散」。** 一個 tick 嘅 Turso 係 ~20 條**一次性** statement：front",
  "（lock／heartbeat claim／pool／seen／token_stats ×2／counters）＋ completion flush",
  "（`persistScanCompletion` 本身已經係一個 batch）＋ tail（pass 5 個 trip、deferral sync",
  "3–5、grouped telemetry 1 讀 1 寫、drain）。冇一條「30 → 1」可以 cut；要 cut 就係合併",
  "啲一次性 state op —— 即係 §4.6.2 做過嘅同一招（三個 sync 由 6 個 round trip 收成",
  "1 讀 1 寫）。",
  "",
  "**`summary.dbTickSteps`（今次新增）**：逐個 Db method 嘅 calls／ms，**只計呢個 scan",
  "window** 嘅差額（`dbTickStepView()`：37 個 method 計時、**永不 defer**）。`subreqView`",
  "嘅 host split 只講得出「29 個去咗 turso」，呢個講得出係邊幾條。留意同 `phases` 一樣",
  "係一個 tick 之前嘅讀數。",
  "",
  "**scan 側地板 `SCAN_SUBREQ_FLOOR = 12`**：scan 係唯一有可選工作嘅階段，所以由佢讓路。",
  "`subreqRemaining() <= 12` 時放棄：",
  "",
  "| 放棄嘅 leg | 點解可以放棄 |",
  "|---|---|",
  "| `meteora`（最後手段 launch 腿） | 前面有 gecko new_pools ＋ pump.fun；少一次只係少一個 tick 嘅覆蓋 |",
  "| `geoTrend` / `jupTrend`（momentum） | 唔係主要 discovery：池會保留隻幣，有 room 嗰個 tick 再掃 |",
  "| `gmgn` / `axiom` trending | 同上（axiom 仲有 session 讀 = 額外 Turso） |",
  "| `backfill`（Birdeye 定期回補） | 唯一會**寫 DB** 嘅可選腿；interval gate 不變，夠鐘嗰個 tick 補做 |",
  "| `crime-refresh`（黑名單刷新） | 有 TTL 快取；少一次刷新唔改變判斷 |",
  "",
  "**唔會放棄**：DexScreener profiles、gecko new_pools、pump.fun、Jupiter recent 四個**主**",
  "discovery 腿，同埋**卡片 enrichment**（arkham／axiom／gmgn／flurry／wallet）——後者係刻意",
  "嘅：cut 一個付費 call 會改卡片顯示（§4.4.2／§4.5.1），寧願讓 discovery 廣度。每個被放棄",
  "嘅腿都會**點名**落 `summary.subreqSkip`（＋ `summary.subreqFloor`），所以「momentum feed",
  "靜」永遠唔會同「上游出事」混淆。",
  "",
  "**12 呢個數**：tail 需要 pass 嘅 reserve（6）＋ grouped telemetry（1 讀 1 寫）＋ completion",
  "flush（1 batch）＋ drain 嘅 tracker 切片 = 12 個**可見** subrequest —— 同",
  "`DRAIN_TRACKER_RESERVE = 14` 同一套算術，只係寫入側 vs 讀取側。",
  "",
  "**下一步（未做）**：把 tail 嗰幾條一次性 state op（deferral sync 嘅讀／寫、grouped",
  "telemetry）合併成一個讀 ＋ 一個 batch 寫。要保留「duplicate guard 先行」嘅次序同",
  "「landed 之後才清 delta」嘅紀律（§4.9、deferrallog），所以先要 `dbTickSteps` 嘅實數。",
);

const PATCHES = [
  {
    file: "scripts/test-deferred-priority.js",
    what: "the floor is driven through a real tick, at both water levels",
    marker: "async function subreqFloorTest()",
    anchor: "// ---------- the durable snapshot the worker writes after the flush ----------",
    replacement: lines(TEST_FN, "// ---------- the durable snapshot the worker writes after the flush ----------"),
  },
  {
    file: "scripts/test-deferred-priority.js",
    what: "and it runs with the rest of the suite",
    marker: "  .then(subreqFloorTest)",
    anchor: lines("feedTests()", "  .then(tickMakeupTest)", "  .then(() => {"),
    replacement: lines(
      "feedTests()",
      "  .then(tickMakeupTest)",
      "  .then(subreqFloorTest)",
      "  .then(() => {",
    ),
  },
  {
    file: "docs/round-trips.md",
    what: "§4.9 gets the correction that unblocks the right cut",
    marker: "2026-09-25 更正（見 §4.11）",
    anchor: "scan 側先留配額（scanner 現時完全唔讀 `subreqRemaining`）。",
    replacement: DOC_4_9,
  },
  {
    file: "docs/round-trips.md",
    what: "§4.11: the measurement, the floor, and the next cut",
    marker: "## 4.11 一個 tick 嘅 subrequest 到底去咗邊",
    anchor: "`fresh` 就夠。",
    replacement: DOC_4_11,
  },
];

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;

for (const patch of PATCHES) {
  const text = bufferOf(patch.file);
  if (typeof patch.marker === "string" && text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const at = text.indexOf(patch.anchor);
  if (at < 0) {
    console.error(`MISS      ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  if (text.indexOf(patch.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  buffers.set(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchor above");
  process.exit(1);
}
let writes = 0;
for (const [file, text] of buffers) {
  if (text === fs.readFileSync(file, "utf8")) continue;
  fs.writeFileSync(file, text);
  writes += 1;
}
console.log(`\nall patches applied (${writes} file(s) written)`);
