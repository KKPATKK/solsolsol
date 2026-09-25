#!/usr/bin/env node
/**
 * 卡片側刪走兩條付費線（Sniper / Holders）——連 endpoint 嘅卡側 caller 一齊刪。
 *
 * THE QUESTION (operator, 2026-09-25)：「唔要卡片 holders 行同 Sniper 行，可以省幾多 CU？」
 * 答案：兩條線嘅 endpoint 直接歸零 —— 而卡面唔會差，因為嗰兩個數（持有人 / 狙擊）
 * 已經由 **免費** Axiom summary 行印（renderAxiomSummaryLine）。
 *
 * WHY A SCRIPT：`src/scanner.ts`（3560/3805/4403 行）、`src/db.ts`（4153 行）、
 * `scripts/test-unit.js`（11591 行）嘅目標 hunk 全部超出檔案編輯窗口（~1240 行之後
 * str_replace 逐字一樣都唔會 match），所以同 repo 其他窗口外改動一樣用 apply script。
 *
 * MARKERS 用完整多行字串 / 唯一的區間頭尾，唔用單一 identifier：`holder_count` 呢類
 * 字串喺 CREATE TABLE 同 mapping 已經存在，用佢做 marker 會誤報 "already" 而靜靜跳過。
 *
 * 呢個 patch 之前已經由 file tool 落咗嘅（唔喺呢度）：
 *   - src/render.ts：`sniperLine`/`holdersLine` 同兩個參數
 *   - src/db.ts：TokenStats.holderCount 嘅註解、setPushWatchHoldersMany 嘅 token_stats 半
 *   - src/birdeye.ts：holderCountCacheHit 嘅 tombstone
 *   - src/config.ts / wrangler.toml：BIRDEYE_HOLDER_CACHE_MIN 同 birdeyeHolderCacheMs
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

// ── src/scanner.ts ─────────────────────────────────────────────────────────
const S = "src/scanner.ts";

const S_IMPORT_MARKER = 'import type { BirdeyeClient } from "./birdeye";';
const S_IMPORT_ANCHOR = 'import { holderCountCacheHit, type BirdeyeClient } from "./birdeye";';

// 區間刪除：displayBatch 頭兩個 slot（trader + holders），保留 GMGN 起嘅三個。
const S_BATCH_START = lines(
  "          this.bestEffort(",
  "            () => this.resolveTraderData(coin),",
);
const S_BATCH_KEEP = lines(
  "          this.bestEffort(",
  "            () => this.resolveGmgnInfo(coin),",
);
const S_BATCH_DONE = lines(
  "        const displayBatch = Promise.all([",
  "          this.bestEffort(",
  "            () => this.resolveGmgnInfo(coin),",
);

const S_COUNT_MARKER =
  "        //    (§4.17 dropped two of the five: see the note at the end of this";
const S_COUNT_ANCHOR =
  "        //  - Serially the batch cost the SUM of five upstream round trips";
const S_COUNT_REPLACEMENT = lines(
  "        //  - Serially the batch cost the SUM of three upstream round trips",
  "        //    (§4.17 dropped two of the five: see the note at the end of this",
  "        //    comment)",
);

const S_PLAIN_MARKER =
  "        //  - Serially the batch cost the SUM of its upstream round trips";
const S_NOTE_MARKER =
  "        // 2026-09-25 (§4.17): the batch used to hold FIVE slots, two of them";
const S_NOTE_ANCHOR = "        // deadline degrades to exactly the value the old code used.";
const S_NOTE_REPLACEMENT = lines(
  S_NOTE_ANCHOR,
  "        //",
  "        // 2026-09-25 (§4.17): the batch used to hold FIVE slots, two of them",
  "        // Birdeye's paid card lines — `resolveTraderData`",
  "        // (/defi/v2/tokens/top_traders) and `resolveHolderCount`",
  "        // (/defi/token_overview, 20 CU). Both numbers already ride the FREE",
  "        // Axiom summary line when it resolves, and both lines were",
  "        // display-only (that endpoint's own numbers feed no gate — the sniper",
  "        // FILTER was removed long ago), so the pair was pure cost: §4.14",
  "        // measured the card path as ≥60% of a 46K CU/month run rate against a",
  "        // 30K free tier. They are gone, endpoints included — see",
  "        // docs/round-trips.md §4.17 for the arithmetic and for exactly what",
  "        // the card loses when the Axiom session is down.",
);

const S_DISHONEST_LINE = lines(
  "        // 30K free tier. They are gone, endpoints included — see",
  "        // docs/round-trips.md §4.17 for the arithmetic and for exactly what",
  "        // the card loses when the Axiom session is down.",
);
const S_HONEST_MARKER =
  "        // card loses. Be plain about that last part: AXIOM_ENABLED is 0";
const S_HONEST_LINE = lines(
  "        // 30K free tier. They are gone, endpoints included — see",
  "        // docs/round-trips.md §4.17 for the arithmetic and for exactly what the",
  "        // card loses. Be plain about that last part: AXIOM_ENABLED is 0 (since",
  "        // 2026-09-19), so the Axiom line does NOT resolve today and no card",
  "        // prints 狙擊 / 持有人 any more. The pair comes back for free the day",
  "        // Axiom is revived; the saving is real either way.",
);

const S_AWAIT_MARKER = "        const [gmgn, arkham, organic] = await displayBatch;";
const S_AWAIT_ANCHOR = lines(
  "        // Await the display batch dispatched above (it has been running",
  "        // concurrently with the crime check and the Axiom token-info), then",
  "        // judge the one thing in it that can block a push. Trader data is",
  "        // display-only (the sniper filter was removed): a coin pushes even",
  "        // when the data is not ready and the card shows 未检测/—.",
  "        this.markPhase(diag, \"enrich-await\", startedAt);",
  "        const [trader, holders, gmgn, arkham, organic] = await displayBatch;",
);
const S_AWAIT_REPLACEMENT = lines(
  "        // Await the display batch dispatched above (it has been running",
  "        // concurrently with the crime check and the Axiom token-info), then",
  "        // judge the one thing in it that can block a push. Every slot left is",
  "        // display-only, so a coin pushes even when one is missing and the card",
  "        // simply omits its line (§4.17 — the two Birdeye slots, and with them",
  "        // their lines, were removed outright).",
  "        this.markPhase(diag, \"enrich-await\", startedAt);",
  "        const [gmgn, arkham, organic] = await displayBatch;",
);

const S_CALL_MARKER = lines(
  "        const message = renderMessage(",
  "          coin,",
  "          rugcheck.bundlerPct,",
  "          rugcheck.top10Pct,",
  '          flow.status === "clean",',
);
const S_CALL_ANCHOR = lines(
  "        const message = renderMessage(",
  "          coin,",
  "          rugcheck.bundlerPct,",
  "          rugcheck.top10Pct,",
  "          trader.sniperPct,",
  '          flow.status === "clean",',
  "          holders.holderCount,",
  "          rugcheck.creator,",
);
const S_CALL_REPLACEMENT = lines(
  S_CALL_MARKER,
  "          rugcheck.creator,",
);

// 兩個 resolver 由 doc comment 一直刪到 `Re-eval pool` 之前。
const S_RES_START =
  "  /** Pro-trader count + sniper buy share: cached → single Birdeye fetch → unknown. */";
const S_RES_KEEP = lines("  /**", "   * Re-eval pool with an in-memory TTL cache");
const S_RES_TOMBSTONE = lines(
  "  /**",
  "   * §4.17 (2026-09-25): `resolveTraderData` (Birdeye /defi/v2/tokens/",
  "   * top_traders) and `resolveHolderCount` (Birdeye /defi/token_overview,",
  "   * 20 CU) lived here. Both fed card lines that the free Axiom summary line",
  "   * already prints (狙擊 / 持有人), so the pair — and the §4.15 durable",
  "   * holder cache whose only reader was `resolveHolderCount` — was removed to",
  "   * stop buying them. Deleted rather than kept behind a switch on purpose: a",
  "   * dormant copy of a paid call is how a card path silently re-acquires a CU",
  "   * bill. The endpoints stay where they are genuinely used — `getTokenOverview`",
  "   * by the tracker's holder probe and /debug/birdeye-overview, `getTraderInfo`",
  "   * by scripts/test-filters.js. See docs/round-trips.md §4.17.",
  "   */",
);

// ── src/db.ts ──────────────────────────────────────────────────────────────
const D = "src/db.ts";

const D_HOLDER_COUNT_START = lines(
  "  /**",
  "   * Remember the holder count the card path just bought",
);
const D_HOLDER_COUNT_KEEP =
  "  async updateTokenMinMcap(token: string, minMcap: number): Promise<void> {";

const D_COL_MARKER = "    // Holder-count cache columns (2026-09-25): the last count BOUGHT from";
const D_COL_ANCHOR = lines(
  "    // Durable holder-count cache (2026-09-25): the last count BOUGHT from",
  "    // Birdeye's token_overview, plus when it was read. Both buyers of a",
  "    // coin's reading write it — the card path (whose enrich batch the same",
  "    // coin re-enters on every tick it is neither pushed nor rejected, buying",
  "    // the same 20 CU request over and over) and the tracker's holder probe (a",
  "    // coin is tracked moments after it was pushed, i.e. right after the card",
  "    // path paid for that very reading). These two columns let either one",
  "    // reuse the reading for BIRDEYE_HOLDER_CACHE_MIN instead (see",
  "    // docs/round-trips.md §4.15 / §4.16). They ride the pool read",
  "    // (`SELECT *`), so a cache hit costs no round trip of its own.",
  "    // Unconditional — idempotent.",
);
const D_COL_REPLACEMENT = lines(
  "    // Holder-count cache columns (2026-09-25): the last count BOUGHT from",
  "    // Birdeye's token_overview and when it was read. §4.15/§4.16 added them",
  "    // for a SHARED cache (the card's enrich and the tracker's holder probe",
  "    // both wrote it, reused inside BIRDEYE_HOLDER_CACHE_MIN); §4.17 retired",
  "    // BOTH ends together with the card's holders line, so nothing reads or",
  "    // writes them today. The columns stay declared — a stale row must not",
  "    // become a schema question — and the tracker keeps its own reading in",
  "    // `push_watch`. Unconditional — idempotent.",
);

// ── src/worker.ts ──────────────────────────────────────────────────────────
// /debug/test-push builds a mock card to prove the Telegram send path; it is the
// second (and last) caller of renderMessage.
const W = "src/worker.ts";
const W_MARKER =
  "      // §4.17: the card takes no sniper/holder value any more — those two";
const W_ANCHOR = lines(
  "      const message = renderMessage(",
  "        mockCoin,",
  "        null,",
  "        null,",
  "        null,",
  "        true,",
  "        null,",
  "        null,",
  "        null,",
  "        null,",
  '        { hit: false, creatorHit: false, holderHits: [], checkedHolders: 0, loaded: false, holders: [] },',
);
const W_REPLACEMENT = lines(
  "      // §4.17: the card takes no sniper/holder value any more — those two",
  "      // Birdeye-bought lines are gone (the free Axiom line prints both).",
  "      const message = renderMessage(",
  "        mockCoin,",
  "        null,",
  "        null,",
  "        true,",
  "        null,",
  "        null,",
  "        null,",
  '        { hit: false, creatorHit: false, holderHits: [], checkedHolders: 0, loaded: false, holders: [] },',
);

// ── scripts/test-unit.js ───────────────────────────────────────────────────
const T = "scripts/test-unit.js";
const T_START =
  "  // ---------- the card side stops re-buying its holder count (birdeye + db) ----------";
const T_KEEP = "  // ---------- Subrequest counter (src/subreqs.ts) ----------";
const T_DONE = "  // ---------- the card path stops buying Birdeye outright (§4.17) ----------";
const T_BLOCK = lines(
  T_DONE,
  "  //",
  "  // 2026-09-25. §4.14 measured the card path as ≥60% of a 46K CU/month Birdeye",
  "  // run rate against a 30K free tier; §4.15/§4.16 tried to make the repeat",
  "  // cheaper (a durable holder cache the tracker's probe could share). The",
  "  // operator then asked the cruder question — is the LINE worth the endpoint at",
  "  // all — and the answer was no: the Axiom summary already prints 狙擊 and",
  "  // 持有人 for free. So both paid card lines are gone, and with them the card",
  "  // path's only callers of the two endpoints. The endpoints themselves stay",
  "  // (the tracker's holder probe and /debug/birdeye-overview still buy",
  "  // token_overview; scripts/test-filters.js still buys top_traders) — what must",
  "  // never come back is a CARD that pays. The guard reads STRIPPED sources, so",
  "  // the tombstones this change leaves behind (which name the removed symbols in",
  "  // comments) cannot satisfy it.",
  '  await test("out-of-window patch: the card stops buying Birdeye (docs/patches/drop-card-birdeye-lines.apply.js)", () => {',
  "    const strip = (text) =>",
  "      text",
  '        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")',
  '        .replace(/\\/\\/[^\\n]*/g, "")',
  '        .replace(/\\s+/g, "");',
  '    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));',
  '    const scannerSrc = read("src/scanner.ts");',
  '    const renderSrc = read("src/render.ts");',
  '    const birdeyeSrc = read("src/birdeye.ts");',
  '    const dbSrc = read("src/db.ts");',
  '    const configSrc = read("src/config.ts");',
  "    const testSrc = strip(fs.readFileSync(__filename, \"utf8\"));",
  "    const applied = {",
  '      "scanner (no card-side caller of either paid endpoint is left)":',
  '        !scannerSrc.includes("resolveTraderData") &&',
  '        !scannerSrc.includes("resolveHolderCount") &&',
  '        !scannerSrc.includes("getTraderInfo(") &&',
  '        !scannerSrc.includes("getTokenOverview("),',
  '      "scanner (and no reader of the §4.15 cache: its import and dial went too)":',
  '        !scannerSrc.includes("holderCountCacheHit") &&',
  '        !scannerSrc.includes("birdeyeHolderCacheMs"),',
  '      "scanner (the enrich batch is down to the three display-only slots)":',
  '        scannerSrc.includes("const[gmgn,arkham,organic]=awaitdisplayBatch;") &&',
  '        scannerSrc.includes("()=>this.resolveGmgnInfo(coin),") &&',
  '        !scannerSrc.includes("proTraders:coin.stats.birdeyeProTraders,"),',
  '      "render (the card has no sniper/holders line left to fill)":',
  '        !renderSrc.includes("sniperLine") &&',
  '        !renderSrc.includes("holdersLine") &&',
  '        !renderSrc.includes("Sniper買入") &&',
  '        !renderSrc.includes("👥Holders:"),',
  '      "render (the signature dropped both values; the group is Bundler/Top10/flow)":',
  '        renderSrc.includes("[bundlerLine,top10Line,flowLine]") &&',
  '        renderSrc.includes("top10Pct:number|null,supplyFlowClean:boolean,creator:string|null,") &&',
  '        !renderSrc.includes("sniperPct:number|null,") &&',
  '        !renderSrc.includes("holderCount:number|null,"),',
  '      "birdeye (the TTL rule is gone; the endpoints are not)":',
  '        !birdeyeSrc.includes("holderCountCacheHit") &&',
  '        birdeyeSrc.includes("asyncgetTokenOverview(") &&',
  '        birdeyeSrc.includes("asyncgetTraderInfo("),',
  '      "db (the cache\'s only writer is gone, the probe\'s own row fields are not)":',
  '        !dbSrc.includes("asyncupdateTokenHolderCount(") &&',
  '        !dbSrc.includes("UPDATEtoken_statsSETholder_count=") &&',
  '        dbSrc.includes("holders_last=?") &&',
  '        dbSrc.includes("holders_at_push=COALESCE(holders_at_push,?)"),',
  '      "config (the dial went with the cache it tuned)":',
  '        !configSrc.includes("birdeyeHolderCacheMs"),',
  '      "tests (this guard)": testSrc.includes("thecardstopsbuyingBirdeye"),',
  "    };",
  "    const done = Object.entries(applied).filter(([, v]) => v);",
  "    if (done.length === 0) {",
  "      console.log(",
  '        "  \\u2139 the card-line removal patch is missing - apply docs/patches/drop-card-birdeye-lines.apply.js",',
  "      );",
  "      return;",
  "    }",
  "    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);",
  '    assert.deepEqual(missing, [], `half-applied: ${missing.join(", ")}`);',
  "  });",
  "",
  "  // The behaviour behind that guard: the probe's batch (the one writer of the",
  "  // per-row holder reading left) is still ONE request and still writes exactly",
  "  // its own row. §4.16's second half — the token_stats statement that carried",
  "  // the probe's count into the card-side cache — must NOT be riding along: its",
  "  // reader is gone, and a statement nobody reads inside a request this method",
  "  // exists to keep at one is pure weight.",
  '  await test("db: the holder probe writes its own row and nothing else, in ONE write", async () => {',
  "    const t = tmpDb();",
  "    const at = Date.UTC(2026, 8, 25, 10, 0, 0);",
  "    try {",
  "      const db = new Db(t.p, undefined, t.client);",
  "      await db.init();",
  "      await db.recordTokenStatsMany([",
  "        {",
  '          token: "SHARED1",',
  "          firstSeenAt: at,",
  "          firstM5Vol: 0,",
  "          firstSeenAgeMin: 200,",
  "          launchMs: at - 200 * 60_000,",
  "          birdeye1mVol: null,",
  "          rugcheckBundlerPct: null,",
  "          rugcheckTop10Pct: null,",
  "          birdeyeProTraders: null,",
  "          birdeyeSniperPct: null,",
  "          minMcapObserved: null,",
  "          supplyFlowJson: null,",
  "          supplyFlowAt: null,",
  '          discoveredVia: "dex",',
  "        },",
  "      ]);",
  "      await t.client.execute({",
  '        sql: "INSERT INTO push_watch (token, chat_id, symbol, pushed_at, mcap_at_push, peak_mcap) VALUES (?, ?, ?, ?, ?, ?)",',
  '        args: ["SHARED1", "c", "S", at, 1000, 1000],',
  "      });",
  "      const before = (await db.listPushWatch())[0];",
  '      assert.equal(before.holdersLast, null, "the row carries no reading yet");',
  "      let writes = 0;",
  "      let statements = 0;",
  "      const counting = {",
  "        execute: (a) => t.client.execute(a),",
  '        batch: (a, m) => { if (m === "write") { writes += 1; statements += a.length; } return t.client.batch(a, m); },',
  "        close: () => t.client.close(),",
  "      };",
  "      const cdb = new Db(t.p, undefined, counting);",
  "      await cdb.init();",
  "      writes = 0;",
  "      statements = 0;",
  '      await cdb.setPushWatchHoldersMany([{ token: "SHARED1", holders: 700, at }]);',
  '      assert.equal(writes, 1, "the probe\'s counts land in ONE request");',
  '      assert.equal(statements, 1, "one UPDATE per probed row — §4.16\'s token_stats statement is gone");',
  '      const probed = (await cdb.listPushWatch())[0];',
  "      assert.equal(probed.holdersLast, 700);",
  "      assert.equal(probed.holdersCheckedAt, at);",
  '      assert.equal(probed.holdersAtPush, 700, "the first probe still seeds the rolling baseline");',
  "      // The §4.15 cache is UNWRITTEN: nothing reads it any more, so the probe",
  "      // must not keep paying for a second statement on its behalf.",
  '      const shared = await cdb.getTokenStats("SHARED1");',
  '      assert.equal(shared.holderCount, null, "the retired cache is not written");',
  "      assert.equal(shared.holderCountAt, null);",
  "      // A later probe moves the row's own field — and the BASELINE (the value",
  "      // the growth alert compares against) is still the first reading.",
  '      await cdb.setPushWatchHoldersMany([{ token: "SHARED1", holders: 744, at: at + 30 * 60_000 }]);',
  "      const grown = (await cdb.listPushWatch())[0];",
  "      assert.equal(grown.holdersLast, 744);",
  '      assert.equal(grown.holdersAtPush, 700, "COALESCE keeps the first reading as the baseline");',
  "    } finally {",
  "      await t.cleanup();",
  "    }",
  "  });",
  "",
);

// ── docs/round-trips.md ────────────────────────────────────────────────────
const R = "docs/round-trips.md";
/**
 * §4.17 first shipped claiming the two numbers "already ride the free Axiom
 * line". That is true only while the Axiom session RESOLVES — and
 * `AXIOM_ENABLED` has been "0" since 2026-09-19 (its refresh endpoint is 418'd
 * by Bot Management; /health reads `axiomConfigured: false`), so
 * `renderAxiomSummaryLine()` returns null on every card and both rows are simply
 * gone. The section's own table and §5 #3 read as if nothing were lost, so the
 * record gets a correction rather than a quiet edit: the marker below is ASCII,
 * which is what makes this block re-runnable.
 */
const R_CORRECTION_MARK = "<!-- 4.17-correction -->";
const R_CORRECTION = lines(
  "",
  R_CORRECTION_MARK,
  "",
  "### 更正（落線後查證，2026-09-25）：Axiom 行今日係熄嘅，卡面真係少咗嘅兩個數",
  "",
  "上面寫「兩條線嘅數字已經由免費嘅 Axiom 行印」——**呢句係指 Axiom 行著嘅時候**，唔係今日。",
  "Axiom 自 **2026-09-19** 起全域關咗：`wrangler.toml` 嘅 `AXIOM_ENABLED = \"0\"`，因為",
  "refresh-token endpoint 被 Cloudflare Bot Management 418 擋死，session 冇法由 Worker 續期。",
  "所以 `/health` 讀到 `axiomConfigured: false`，`renderAxiomSummaryLine()` **每一次都回 `null`**，",
  "卡面一直行嘅係 legacy fallback group。",
  "",
  "即係話：**今日嘅卡片係真係冇咗狙擊同持有人數嘅** —— 唔係顯示 `—`，係整行冇咗。上面 §1 嘅表格",
  "同 §5 第 3 點要照呢點讀（「已經嘅 Axiom 行」＝復活 Axiom 之後先會發生）。",
  "",
  "呢個係今次改動**已知、要明講嘅交易**：卡片側 Birdeye 花費 → 0（≈ −49% 總量），換嚟卡面少兩個",
  "數據點。兩個數會嘅 Axiom 復活（`docs/axiom-refresher.md`）之後自動返嚟，唔使再改 code；",
  "追蹤嘅 `📈 持倉增長` / `⚡ 背離` 警報**不受影響**（佢哋讀 `push_watch` 自己嘅讀數）。",
);
const R_HEADING =
  "## 4.17 卡片側兩條付費線直接刪（Sniper / Holders）：Axiom 免費行已經有嗰兩個數（2026-09-25）";
const R_SECTION = lines(
  "",
  "---",
  "",
  R_HEADING,
  "",
  "Operator 嘅問題（承接 §4.15 / §4.16）：「**唔要卡片 holders 行同 Sniper 行，可以省幾多 CU？**」",
  "答案：兩條線嘅 endpoint 直接歸零 —— 而呢個係唯一一種**唔會令卡面數字變差**嘅刪法。",
  "",
  "### 1. 為咩刪得：嗰兩個數已經由免費來源印",
  "",
  "| 卡面行 | 來源 | 價 | 刪完之後 |",
  "|---|---|---|---|",
  "| `🎯 Sniper 買入` | Birdeye `/defi/v2/tokens/top_traders`（`getTraderInfo`） | 帳簿記 0 CU（vendor 實價未知，見 §4.14） | 冇咗；`狙擊 0%` 已經喺 Axiom 行 |",
  "| `👥 Holders` | Birdeye `/defi/token_overview`（`getTokenOverview`） | **20 CU／次** | 冇咗；`持有人 356` 已經喺 Axiom 行 |",
  "",
  "`renderAxiomSummaryLine` 喺 Axiom payload 解得開嘅時候**已經**印 `持有人`（`numHolders`）同",
  "`狙擊`（`snipersHoldPercent`），所以刪走嘅係「Axiom 解唔到 → fallback 行」嗰份複製品，",
  "唔係卡面資訊本身。Axiom session 死嗰陣卡片少兩行（唔係顯示 `—`）——同 GMGN / Arkham /",
  "crime 一樣嘅「冇就唔出」立場。",
  "",
  "兩條線都**唔餵任何 gate**（sniper filter 早就拆咗，holder 數一直只係卡面），所以呢一刀嘅",
  "代價完全喺卡面，push 覆蓋率零影響。",
  "",
  "### 2. 其餘 caller（刪完之後仲喺度，所以 endpoint 冇死）",
  "",
  "* `getTokenOverview`：tracker 嘅 holder probe（`pushwatch.ts`，gap 60 分鐘制）＋ `/debug/birdeye-overview`；",
  "* `getTraderInfo`：`scripts/test-filters.js`（手動測試腳本）。",
  "",
  "即係話刪嘅係**卡片側**嘅 caller，唔係 endpoint 本身；probe 同 §4.16 之前一模一樣照跑。",
  "",
  "### 3. 連帶清走嘅死碼",
  "",
  "* `Scanner.resolveTraderData` / `Scanner.resolveHolderCount`（兩個係卡側唯一 caller）；",
  "* `holderCountCacheHit`（`birdeye.ts`）—— §4.15 個 TTL 規則，唯一 reader 就係 `resolveHolderCount`；",
  "* `Db.updateTokenHolderCount`—— §4.15 個 cache 寫入，唯一 caller 亦係 `resolveHolderCount`；",
  "* `Db.setPushWatchHoldersMany` 入面 N 條 `token_stats` statement（§4.16 嘅 shared-cache 寫入）——",
  "  probe 自己嗰行（`holders_at_push` / `holders_last` / `holders_checked_at`）**照寫**，仍然係 1 個 batch；",
  "* `BIRDEYE_HOLDER_CACHE_MIN` 同 `AppConfig.birdeyeHolderCacheMs`——冇 cache 就冇嘢好 tune。",
  "",
  "`token_stats.holder_count` / `holder_count_at` 兩條 column **留返喺 schema**（唔為咗刪一個規則",
  "去刪資料；`CREATE TABLE` 同 `addColumnIfMissing` 都唔動）。§4.15 / §4.16 兩節保留做歷史記錄。",
  "",
  "### 4. CU 算術：為咩非砍 ~49% 不可",
  "",
  "Operator 嘅 Birdeye dashboard：period **2026-09-20 → 10-20**，額度 30,000，**已用 8,470 CU**。",
  "`/health.birdeyeCu` 自己嗰個月 3,160 CU 係 counter 上線（2026-09-23 12:54Z）之後 44.4 小時嘅",
  "讀數 —— 兩個來源都 ≈ **1,700 CU／日**。",
  "",
  "* 剩 21,530 CU ÷ 25 日 ⇒ 上限 **861 CU／日**；",
  "* 照原本速度 ~12.7 日燒完 ⇒ **10 月 7–8 日見底**；",
  "* 整個 period 需要 ~50,800 CU ⇒ **要砍 ~49%**。",
  "",
  "砍喺邊：§4.14 量到卡片側係 ≥60%（≤ ~1,000 CU／日），而嗰 60% 嘅全部就係呢兩條線之一",
  "（`token_overview` 20 CU 係大頭）。所以呢一刀嘅目標係**令卡片側歸零**，剩返嘅只有",
  "probe（≤480 CU／日）、backfill（160 CU／日）同 `/debug/*`。",
  "",
  "### 5. 落線點驗",
  "",
  "1. `/health.birdeyeCu.byEndpoint.month.tokenOverview.calls` **唔應該再跟 pushes 上升** —— 只應該",
  "   跟 `pushWatch`（probe）上升，即 ≈ 1 次／60 分鐘／被追蹤嘅幣。",
  "2. `…byEndpoint.month.topTraders.calls` **停止增長**（= 0）。vendor 嗰邊嘅真價仍然要用 dashboard",
  "   同日 delta ÷ calls 去推 —— 帳簿記 0，唔可以用帳簿證明省幾多。",
  "3. 卡面：Axiom 行照有 `持有人` / `狙擊`；Axiom 解唔到嘅卡少兩行（預期行為）。",
  "4. 追蹤警報 `📈 持倉增長`（+10%）同 `⚡ 背離` **照響** —— 佢哋讀 `push_watch.holders_last` /",
  "   `holders_at_push`，同卡面嗰兩行無關（probe 保留就係為咗呢個）。",
  "5. `/debug/birdeye-overview` 照樣買得到 `token_overview`（probe 路徑未死）。",
  "",
  "### 6. 已知代價",
  "",
  "* Axiom session 死嗰陣卡片少兩行（唔係差數字）；",
  "* `token_stats` 兩條 column 變成純歷史資料；",
  "* CI 只係 typecheck ＋ unit test ＋ deploy，所以 #1 要等落線後至少一個 probe 週期（60 分鐘）",
  "  才睇得到 —— `byEndpoint` 喺新 isolate 打過 Birdeye 之前會係空嘅，唔係 bug。",
  "",
  "**測試**（`scripts/test-unit.js`）：`out-of-window patch: the card stops buying Birdeye`（掃描",
  "stripped 源碼：卡側冇 caller、冇 cache reader、render 冇兩行、batch 只剩三個 slot、endpoint 仍然",
  "存在）＋ `db: the holder probe writes its own row and nothing else, in ONE write`（真 DB：1 個",
  "request、N 條 statement＝每行一條、`holders_at_push` 由第一次 probe seed、token_stats 冇被寫）。",
);

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;
const once = (text, needle) => text.split(needle).length - 1;

function patch(file, marker, anchor, replacement, what) {
  const text = bufferOf(file);
  if (text.includes(marker)) {
    console.log(`already   ${file}: ${what}`);
    return;
  }
  if (once(text, anchor) !== 1) {
    console.error(`MISS/AMBIGUOUS ${file}: ${what}`);
    failed = true;
    return;
  }
  buffers.set(file, text.replace(anchor, replacement));
  console.log(`ok        ${file}: ${what}`);
}

/**
 * Remove `[start, keep)` and put `replacement` in its place. Long deletions go
 * by RANGE rather than by one exact anchor on purpose: the block between the
 * two markers is exactly what is being deleted, so matching its interior
 * byte-for-byte would add nothing but fragility. `done` is the string that only
 * exists AFTER the cut (`null` = the start marker itself is the tell).
 */
/**
 * A patch whose "applied" state has more than one shape on disk — the fresh
 * tree and a tree an earlier cut of this same script touched. `marker` is the
 * FINAL text; each `[anchor, replacement]` is one way to arrive at it. A tree
 * that already holds the final text reports `already` whichever shape it came
 * from, which is the property a re-runnable script needs.
 */
function patchOne(file, marker, variants, what) {
  const text = bufferOf(file);
  if (text.includes(marker)) {
    console.log(`already   ${file}: ${what}`);
    return;
  }
  for (const [anchor, replacement] of variants) {
    if (once(text, anchor) !== 1) continue;
    buffers.set(file, text.replace(anchor, replacement));
    console.log(`ok        ${file}: ${what}`);
    return;
  }
  console.error(`MISS/AMBIGUOUS ${file}: ${what}`);
  failed = true;
}

function cutRange(file, start, keep, replacement, done, what) {
  const text = bufferOf(file);
  if (done === null ? !text.includes(start) : text.includes(done)) {
    console.log(`already   ${file}: ${what}`);
    return;
  }
  if (once(text, start) !== 1 || once(text, keep) !== 1) {
    console.error(`MISS/AMBIGUOUS ${file}: ${what}`);
    failed = true;
    return;
  }
  const a = text.indexOf(start);
  const b = text.indexOf(keep, a + start.length);
  if (b < 0) {
    console.error(`MISS/AMBIGUOUS ${file}: ${what} (no end marker after the start)`);
    failed = true;
    return;
  }
  buffers.set(file, text.slice(0, a) + replacement + text.slice(b));
  console.log(`ok        ${file}: ${what}`);
}

patch(S, S_IMPORT_MARKER, S_IMPORT_ANCHOR, S_IMPORT_MARKER, "the cache helper import goes with its reader");
cutRange(S, S_BATCH_START, S_BATCH_KEEP, "", null, "the batch stops buying trader + holder data");
patchOne(
  S,
  S_PLAIN_MARKER,
  [
    // A fresh tree: the original line, replaced by the plain one.
    [S_COUNT_ANCHOR, S_PLAIN_MARKER],
    // The tree the FIRST cut of this script left behind: its parenthetical
    // landed INSIDE the sentence it was appended to, and the number is already
    // carried by the note at the end of this comment — so it just goes.
    [S_COUNT_REPLACEMENT, S_PLAIN_MARKER],
  ],
  "the batch comment stops counting what it dropped",
);
patch(S, S_NOTE_MARKER, S_NOTE_ANCHOR, S_NOTE_REPLACEMENT, "and says why the two went");
// The note has to be TRUE today, not just true in principle: AXIOM_ENABLED is 0
// (2026-09-19), so the free Axiom line does not resolve and the two numbers are
// simply gone from the card face. Saying "they already ride the Axiom line"
// without that would read as "nothing was lost".
patch(
  S,
  S_HONEST_MARKER,
  S_DISHONEST_LINE,
  S_HONEST_LINE,
  "the note names the state the card is actually in",
);
patch(S, S_AWAIT_MARKER, S_AWAIT_ANCHOR, S_AWAIT_REPLACEMENT, "the await only destructures what is left");
patch(S, S_CALL_MARKER, S_CALL_ANCHOR, S_CALL_REPLACEMENT, "the card call passes no sniper/holder value");
cutRange(S, S_RES_START, S_RES_KEEP, S_RES_TOMBSTONE, S_RES_TOMBSTONE.split("\n")[1], "both paid resolvers are deleted");
// The cut ends flush against the next member's doc comment (the range started at
// the FIRST of the two removed comments, so the blank line that used to sit
// between the pair went with it). Put the air back.
patchOne(
  S,
  lines("   */", "", "  /**", "   * Re-eval pool with an in-memory TTL cache"),
  [[lines("   */  /**", "   * Re-eval pool with an in-memory TTL cache"), lines("   */", "", "  /**", "   * Re-eval pool with an in-memory TTL cache")]],
  "the tombstone keeps a blank line before the next member (fix2)",
);

cutRange(D, D_HOLDER_COUNT_START, D_HOLDER_COUNT_KEEP, "", null, "the cache writer is deleted");
patch(D, D_COL_MARKER, D_COL_ANCHOR, D_COL_REPLACEMENT, "the columns' comment names their retirement");

patch(W, W_MARKER, W_ANCHOR, W_REPLACEMENT, "the test-push mock card matches the new signature");

// The harness pulled the TTL helper out of the built birdeye module. The cases
// that used it are gone, so the binding goes: a destructured name that no longer
// exists on the module is `undefined`, which is exactly the kind of quiet rot
// this file's guards exist to catch.
patch(
  T,
  'consumeBirdeyeCuByDay } = require("../dist/birdeye.js");',
  'consumeBirdeyeCuByDay, holderCountCacheHit } = require("../dist/birdeye.js");',
  'consumeBirdeyeCuByDay } = require("../dist/birdeye.js");',
  "the harness stops importing the retired helper",
);

cutRange(T, T_START, T_KEEP, T_BLOCK, T_DONE, "the §4.15/§4.16 cases become the §4.17 guard");
// fix1: the first cut asserted the two values were absent from render.ts by their
// bare names, but `holderCount` is ALSO GMGN's own field name (the 🧠 line reads
// `gmgn.holderCount`) — the stripped SOURCE keeps that one. Read the SIGNATURE
// instead: `: number | null` can only belong to a parameter, never to a field
// the renderer reads off a payload it was handed.
patch(
  T,
  '      "render (the signature dropped both values; the group is Bundler/Top10/flow)":',
  lines(
    '      "render (…and the fallback group is Bundler/Top10/flow only)":',
    '        renderSrc.includes("[bundlerLine,top10Line,flowLine]") &&',
    '        !renderSrc.includes("sniperPct") &&',
    '        !renderSrc.includes("holderCount"),',
  ),
  lines(
    '      "render (the signature dropped both values; the group is Bundler/Top10/flow)":',
    '        renderSrc.includes("[bundlerLine,top10Line,flowLine]") &&',
    '        renderSrc.includes("top10Pct:number|null,supplyFlowClean:boolean,creator:string|null,") &&',
    '        !renderSrc.includes("sniperPct:number|null,") &&',
    '        !renderSrc.includes("holderCount:number|null,"),',
  ),
  "the render check reads the signature, not GMGN's field name (fix1)",
);

{
  const text = bufferOf(R);
  let live = text;
  if (live.includes(R_HEADING)) {
    console.log(`already   ${R}: the removal is documented`);
  } else {
    live = `${live.trimEnd()}\n${R_SECTION}\n`;
    console.log(`ok        ${R}: the removal is documented`);
  }
  // The correction is a SECOND append, not an edit of the section above it: the
  // text it corrects is already on disk on the tree this ran against, and an
  // ASCII marker is the one thing that can be matched without transcribing CJK
  // anchors. It lands inside §4.17 because that section is the file's last one.
  if (live.includes(R_CORRECTION_MARK)) {
    console.log(`already   ${R}: the correction is recorded`);
  } else {
    live = `${live.trimEnd()}\n${R_CORRECTION}\n`;
    console.log(`ok        ${R}: the correction is recorded`);
  }
  buffers.set(R, live);
}

// Two particles in the correction came out as 嘅 where 喺 was meant, which reads
// as a different word. `fixText` is the same contract as `patch` (final text is
// the marker), applied to the buffer the block above just finished building, so
// it converges on a fresh run and on this tree alike.
function fixText(file, from, to, what) {
  const text = bufferOf(file);
  if (text.includes(to)) {
    console.log(`already   ${file}: ${what}`);
    return;
  }
  if (once(text, from) !== 1) {
    console.error(`MISS/AMBIGUOUS ${file}: ${what}`);
    failed = true;
    return;
  }
  buffers.set(file, text.split(from).join(to));
  console.log(`ok        ${file}: ${what}`);
}

fixText(R, "「已經嘅 Axiom 行」", "「已經喺 Axiom 行」", "the correction's first fix-up is readable");
fixText(
  R,
  "數據點。兩個數會嘅 Axiom 復活",
  "數據點。兩個數會喺 Axiom 復活",
  "and so is its last sentence",
);

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
