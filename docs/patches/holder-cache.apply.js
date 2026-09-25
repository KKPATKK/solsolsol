#!/usr/bin/env node
/**
 * 卡片側持有人數：由「每次 enrich 都買一次 token_overview」變成「一個 durable
 * 讀數，TTL 內重用」。
 *
 * THE QUESTION (operator, 2026-09-25, follow-up to §4.14)：
 * 「唔收窄 gap 係因為卡片側食咗 ≥60% CU；要收窄就要令卡片側唔再每次 enrich 都買
 * 一次 token_overview（durable holder cache 或者 GMGN 免費 holder_count）。」
 *
 * WHY A CACHE AND NOT GMGN：GMGN 嘅 `holder_count` 係另一把尺（換源＝換卡面數字），
 * 而且佢個 edge 以 IP 級 429 封咗 Worker 嘅共用 egress（2026-09-24 實測
 * `requests 9 / http429 9 / consecutive429 9 / lastStatus 429`，leg 已關）。
 * Durable cache 保住同一個數字、同一個來源，只係唔再重複買。
 *
 * WHY A SCRIPT：`src/db.ts` 同 `src/scanner.ts` 嘅目標 hunk 都超出檔案編輯窗口
 * （~48-60KB 之後 str_replace 逐字一樣都唔會 match），所以同 repo 其他窗口外改動
 * 一樣，用 apply script。
 *
 * MARKERS 用完整多行字串，唔用單一 identifier：`holder_count_at` 呢類字串喺
 * CREATE TABLE 已經存在（呢個 patch 嘅頭兩個 hunk 已經落地），用佢做 marker 會
 * 誤報 "already" 而靜靜跳過 —— 呢個就係 birdeye-cu-split-fix1 踩過嘅坑。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

// ── src/db.ts ──────────────────────────────────────────────────────────────
const D = "src/db.ts";

const COL_ANCHOR = '    await this.addColumnIfMissing("token_stats", "discovered_via", "TEXT");';
const COL_MARKER = '    await this.addColumnIfMissing("token_stats", "holder_count_at", "INTEGER");';
/**
 * ONE source for the wording, shared by the two hunks that can land it (§4.15's
 * card-path-only comment vs the version naming both writers), so an applied tree
 * and a fresh one cannot drift apart.
 */
const COL_COMMENT = lines(
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
const COL_REPLACEMENT = lines(
  COL_ANCHOR,
  COL_COMMENT,
  '    await this.addColumnIfMissing("token_stats", "holder_count", "INTEGER");',
  '    await this.addColumnIfMissing("token_stats", "holder_count_at", "INTEGER");',
);

// The §4.15 comment said only the card path bought this reading (§4.16 added the
// tracker's holder probe as a second writer). COL_FIX_ANCHOR is that old text.
const COL_FIX_MARKER = "    // docs/round-trips.md §4.15 / §4.16). They ride the pool read";
const COL_FIX_ANCHOR = lines(
  "    // Durable holder-count cache (2026-09-25): the count the card path last",
  "    // bought from Birdeye's token_overview, plus when it read it. The card",
  "    // path re-enters the enrich batch for the same coin on every tick it is",
  "    // neither pushed nor rejected, and each entry used to buy the same 20 CU",
  "    // request over and over; these two columns let a re-entry reuse the",
  "    // reading for BIRDEYE_HOLDER_CACHE_MIN instead (see",
  "    // docs/round-trips.md §4.15). They ride the pool read (`SELECT *`), so a",
  "    // cache hit costs no round trip of its own. Unconditional — idempotent.",
);
const COL_FIX_REPLACEMENT = COL_COMMENT;

const ROW_ANCHOR = lines(
  "    const proTraders = row.birdeye_pro_traders;",
  "    const sniperPct = row.birdeye_sniper_pct;",
  "    const minMcap = row.min_mcap_observed;",
);
const ROW_MARKER = "    const holderCountAt = row.holder_count_at;";
const ROW_REPLACEMENT = lines(
  "    const proTraders = row.birdeye_pro_traders;",
  "    const sniperPct = row.birdeye_sniper_pct;",
  "    const holderCount = row.holder_count;",
  "    const holderCountAt = row.holder_count_at;",
  "    const minMcap = row.min_mcap_observed;",
);

const MAP_ANCHOR = lines(
  "      birdeyeSniperPct:",
  "        sniperPct === null || sniperPct === undefined ? null : Number(sniperPct),",
  "      minMcapObserved:",
);
// `holderCountAt:` alone is NOT a marker — the local const above introduces the
// same word. The mapping's own shape is.
const MAP_MARKER = lines(
  "      holderCountAt:",
  "        holderCountAt === null || holderCountAt === undefined",
  "          ? null",
  "          : Number(holderCountAt),",
);
const MAP_REPLACEMENT = lines(
  "      birdeyeSniperPct:",
  "        sniperPct === null || sniperPct === undefined ? null : Number(sniperPct),",
  "      holderCount:",
  "        holderCount === null || holderCount === undefined",
  "          ? null",
  "          : Number(holderCount),",
  "      holderCountAt:",
  "        holderCountAt === null || holderCountAt === undefined",
  "          ? null",
  "          : Number(holderCountAt),",
  "      minMcapObserved:",
);

const UPDATE_ANCHOR = lines(
  "  async updateTokenSniperPct(token: string, sniperPct: number): Promise<void> {",
  "    await this.get().execute({",
  '      sql: "UPDATE token_stats SET birdeye_sniper_pct = ? WHERE token = ?",',
  "      args: [sniperPct, token],",
  "    });",
  "  }",
);
const UPDATE_MARKER =
  "  async updateTokenHolderCount(\n    token: string,\n    holderCount: number,\n    at: number,\n  ): Promise<void> {";
const UPDATE_REPLACEMENT = lines(
  UPDATE_ANCHOR,
  "",
  "  /**",
  "   * Remember the holder count the card path just bought (see TokenStats.",
  "   * holderCount), so the same coin's next enrichment can reuse it inside",
  "   * BIRDEYE_HOLDER_CACHE_MIN instead of paying another 20 CU for it.",
  "   *",
  "   * ONE round trip, and only after a request that actually returned a count —",
  "   * a cache miss with no write behind it would re-buy on the very next tick.",
  "   * The caller (Scanner.resolveHolderCount) treats a failed write as a lost",
  "   * cache entry, never as a lost reading: an extra request later is cheap, a",
  "   * card that shows \"—\" because the bookkeeping threw is not.",
  "   */",
  "  async updateTokenHolderCount(",
  "    token: string,",
  "    holderCount: number,",
  "    at: number,",
  "  ): Promise<void> {",
  "    await this.get().execute({",
  '      sql: "UPDATE token_stats SET holder_count = ?, holder_count_at = ? WHERE token = ?",',
  "      args: [holderCount, at, token],",
  "    });",
  "  }",
);

// ── src/scanner.ts ─────────────────────────────────────────────────────────
const S = "src/scanner.ts";
const SCAN_ANCHOR = lines(
  "  /**",
  "   * Holder count (Birdeye token overview) — the card's holders line.",
  "   * Best-effort with the same 5-min negative cache: a failure degrades to",
  '   * "—" on the card, never blocks or slows the push. Only fetched for',
  "   * qualifying candidates, so the 20 CU/request cost is negligible at the",
  "   * current push volume.",
  "   */",
  "  private async resolveHolderCount(coin: QualifyingCoin): Promise<{",
  "    holderCount: number | null;",
  "  }> {",
  "    const mint = coin.pair.baseToken.address;",
  "    if (!this.birdeye || this.dataNegativeCached(mint)) {",
  "      return { holderCount: null };",
  "    }",
  "    try {",
  "      const info = await this.birdeye.getTokenOverview(mint);",
  "      if (info.holderCount === null) {",
  "        // No holder data back — back off instead of re-querying the same",
  "        // coin on every scan.",
  "        this.dataFailedAt.set(mint, Date.now());",
  "      } else {",
  "        this.dataFailedAt.delete(mint);",
  "      }",
  "      return { holderCount: info.holderCount };",
);
const SCAN_MARKER = lines(
  "      holderCountCacheHit(",
  "        stats.holderCount ?? null,",
);
const SCAN_REPLACEMENT = lines(
  "  /**",
  "   * Holder count (Birdeye token overview) — the card's holders line.",
  "   * Best-effort with the same 5-min negative cache: a failure degrades to",
  '   * "—" on the card, never blocks or slows the push.',
  "   *",
  "   * The reading is cached DURABLY (see BIRDEYE_HOLDER_CACHE_MIN /",
  "   * docs/round-trips.md §4.15). §4.14 measured this call as the card path's",
  "   * whole CU bill — and this method is not called once per card, it is called",
  "   * once per ENRICH: the same coin re-enters the batch on every tick it is",
  "   * neither pushed nor finally rejected (a deferred card send, a gate that",
  "   * flips back), and each entry used to buy the same 20 CU reading again.",
  "   * A fresh coin has no cached reading, so the number a card FIRST shows is",
  "   * always a live one; only a coin still hopping in and out of the batch",
  "   * reuses its reading, and only for `birdeyeHolderCacheMs`.",
  "   */",
  "  private async resolveHolderCount(coin: QualifyingCoin): Promise<{",
  "    holderCount: number | null;",
  "  }> {",
  "    const stats = coin.stats;",
  "    const mint = coin.pair.baseToken.address;",
  "    // `stats` came back with the pool read (`SELECT *`), so a cache hit costs",
  "    // no request, no CU and no round trip at all.",
  "    if (",
  "      holderCountCacheHit(",
  "        stats.holderCount ?? null,",
  "        stats.holderCountAt ?? null,",
  "        Date.now(),",
  "        this.config.birdeyeHolderCacheMs,",
  "      )",
  "    ) {",
  "      return { holderCount: stats.holderCount ?? null };",
  "    }",
  "    if (!this.birdeye || this.dataNegativeCached(mint)) {",
  "      return { holderCount: null };",
  "    }",
  "    try {",
  "      const info = await this.birdeye.getTokenOverview(mint);",
  "      if (info.holderCount === null) {",
  "        // No holder data back — back off instead of re-querying the same",
  "        // coin on every scan.",
  "        this.dataFailedAt.set(mint, Date.now());",
  "      } else {",
  "        this.dataFailedAt.delete(mint);",
  "        // Persist the reading so the NEXT enrichment can reuse it. The write",
  "        // goes by `stats.token` — the token_stats primary key, i.e. the same",
  "        // mint `mint` names — so it lands on the row that carries the cache.",
  "        // A failed write is a lost cache entry, never a lost reading: the",
  "        // count in hand is what the card shows either way.",
  "        try {",
  "          const at = Date.now();",
  "          await this.db.updateTokenHolderCount(stats.token, info.holderCount, at);",
  "          stats.holderCount = info.holderCount;",
  "          stats.holderCountAt = at;",
  "        } catch (err) {",
  "          console.error(",
  "            `[scanner] Birdeye holder cache write failed for ${mint}:`,",
  "            err instanceof Error ? err.message : err,",
  "          );",
  "        }",
  "      }",
  "      return { holderCount: info.holderCount };",
);

// ── scripts/test-unit.js ───────────────────────────────────────────────────
const T = "scripts/test-unit.js";
const T_INSERT_ANCHOR = "  // ---------- Subrequest counter (src/subreqs.ts) ----------";
const T_MARKER = 'await test("birdeye: the holder cache reuses a reading inside its TTL and never invents one"';
const T_TESTS = lines(
  "  // ---------- the card side stops re-buying its holder count (birdeye + db) ----------",
  "  //",
  "  // §4.14's measurement: the card path (`resolveHolderCount` → one",
  "  // /defi/token_overview, 20 CU) was ≥60% of a 46K CU/month run rate while the",
  "  // holder probe was ≤21-36% — which is why the probe gap could not be narrowed",
  "  // before this. The repeat is not per card, it is per ENRICH: the same coin",
  "  // re-enters the enrich batch on every tick it is neither pushed nor finally",
  "  // rejected (a card send deferred by the tick cut, a gate that rejects this",
  "  // tick and passes the next), and each entry used to buy the same reading",
  "  // again. The rule is a durable per-coin reading (token_stats.holder_count /",
  "  // holder_count_at) reused for BIRDEYE_HOLDER_CACHE_MIN.",
  '  await test("birdeye: the holder cache reuses a reading inside its TTL and never invents one", () => {',
  "    const now = 1_000_000_000;",
  "    const ttl = 30 * 60_000;",
  '    assert.equal(holderCountCacheHit(622, now - ttl + 1, now, ttl), true, "one ms inside the window");',
  "    // The boundary is a MISS: an expired reading must be re-bought, never kept",
  "    // for one more tick by an off-by-one.",
  '    assert.equal(holderCountCacheHit(622, now - ttl, now, ttl), false, "the TTL is exclusive");',
  '    assert.equal(holderCountCacheHit(622, now + 5_000, now, ttl), true, "clock skew never expires a fresh reading");',
  '    assert.equal(holderCountCacheHit(622, now - 1, now, 0), false, "0 = the knob off: always read");',
  "    // UNKNOWN is not a reading: a row nobody has read must not be reused as if",
  "    // it were one, and 0 on the stamp is the 'never written' sentinel rather",
  "    // than 1970 (the rule healthAgeMs follows for the frozen readings).",
  '    assert.equal(holderCountCacheHit(null, now - 1, now, ttl), false, "no count = no hit");',
  '    assert.equal(holderCountCacheHit(622, null, now, ttl), false, "no stamp = no hit");',
  '    assert.equal(holderCountCacheHit(622, 0, now, ttl), false, "0 is never-written, not the epoch");',
  "  });",
  "",
  '  await test("db: the holder cache is ONE write, and a coin nobody read stays unknown", async () => {',
  "    const t = tmpDb();",
  "    const at = Date.UTC(2026, 8, 25, 9, 30, 0);",
  "    try {",
  "      const db = new Db(t.p, undefined, t.client);",
  "      await db.init();",
  "      await db.recordTokenStatsMany([",
  "        {",
  '          token: "HOLDER1",',
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
  "      // A fresh database carries both columns from CREATE TABLE, so this needs",
  "      // no ALTER — and a coin nobody has read reports UNKNOWN, not 0 holders:",
  "      // an invented 0 would be a claim the card never earned.",
  '      const cold = await db.getTokenStats("HOLDER1");',
  "      assert.equal(cold.holderCount, null);",
  "      assert.equal(cold.holderCountAt, null);",
  "      let executes = 0;",
  "      const counting = {",
  "        execute: (a) => {",
  "          executes += 1;",
  "          return t.client.execute(a);",
  "        },",
  "        batch: (a, m) => t.client.batch(a, m),",
  "        close: () => t.client.close(),",
  "      };",
  "      const cdb = new Db(t.p, undefined, counting);",
  "      await cdb.init();",
  "      executes = 0;",
  '      await cdb.updateTokenHolderCount("HOLDER1", 622, at);',
  '      assert.equal(executes, 1, "the count and its stamp land in ONE write");',
  '      const warm = await cdb.getTokenStats("HOLDER1");',
  "      assert.equal(warm.holderCount, 622);",
  '      assert.equal(warm.holderCountAt, at, "the stamp is the reading\'s own, not now()");',
  "      // A later reading overwrites the old one (this is a cache, not a log).",
  '      await cdb.updateTokenHolderCount("HOLDER1", 651, at + 60_000);',
  '      const next = await cdb.getTokenStats("HOLDER1");',
  "      assert.equal(next.holderCount, 651);",
  "      assert.equal(next.holderCountAt, at + 60_000);",
  "    } finally {",
  "      await t.cleanup();",
  "    }",
  "  });",
  "",
  '  await test("out-of-window patch: the card path reads the holder cache BEFORE it buys (docs/patches/holder-cache.apply.js)", () => {',
  "    const strip = (text) =>",
  "      text",
  '        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")',
  '        .replace(/\\/\\/[^\\n]*/g, "")',
  '        .replace(/\\s+/g, "");',
  '    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));',
  '    const scannerSrc = read("src/scanner.ts");',
  '    const dbSrc = read("src/db.ts");',
  '    const testSrc = read("scripts/test-unit.js");',
  "    const before = (hay, a, b) => {",
  "      const ia = hay.indexOf(a);",
  "      const ib = hay.indexOf(b);",
  "      return ia >= 0 && ib >= 0 && ia < ib;",
  "    };",
  "    const applied = {",
  '      "scanner (the cache decision runs BEFORE the getTokenOverview call)":',
  "        before(",
  "          scannerSrc,",
  '          "holderCountCacheHit(stats.holderCount??null,stats.holderCountAt??null,Date.now(),this.config.birdeyeHolderCacheMs,",',
  '          "constinfo=awaitthis.birdeye.getTokenOverview(mint);",',
  "        ),",
  '      "scanner (a hit returns the cached count, and only a FETCHED one is written back)":',
  '        scannerSrc.includes("return{holderCount:stats.holderCount??null};") &&',
  '        scannerSrc.includes("awaitthis.db.updateTokenHolderCount(stats.token,info.holderCount,at);"),',
  "      // A type-only import would compile and then crash on the first cache hit",
  "      // (holderCountCacheHit would be undefined) — the one half-paste of this",
  "      // seam the compiler cannot catch.",
  '      "scanner (holderCountCacheHit is a VALUE import, not a type import)":',
  '        scannerSrc.includes(\'import{holderCountCacheHit,typeBirdeyeClient}from"./birdeye";\'),',
  '      "db (both columns are declared, read and written)":',
  '        dbSrc.includes("asyncupdateTokenHolderCount(") &&',
  '        dbSrc.includes("holderCountAt:holderCountAt===null||holderCountAt===undefined?null:Number(holderCountAt),") &&',
  '        dbSrc.includes(\'awaitthis.addColumnIfMissing("token_stats","holder_count_at","INTEGER");\'),',
  '      "tests (this guard)": testSrc.includes("holderCountCacheHit(622,now-ttl,now,ttl)"),',
  "    };",
  "    const done = Object.entries(applied).filter(([, v]) => v);",
  "    if (done.length === 0) {",
  "      console.log(",
  '        "  \\u2139 the holder-cache patch is missing - apply docs/patches/holder-cache.apply.js",',
  "      );",
  "      return;",
  "    }",
  "    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);",
  '    assert.deepEqual(missing, [], `half-applied: ${missing.join(", ")}`);',
  "  });",
  "",
);

// ── docs/round-trips.md ────────────────────────────────────────────────────
const R = "docs/round-trips.md";
const R_HEADING = "## 4.15 卡片側嘅持有人數：由「每次 enrich 都買」變成「一個 durable 讀數」（2026-09-25）";
const R_SECTION = lines(
  "",
  "---",
  "",
  R_HEADING,
  "",
  "Operator 嘅決定（§4.14 §3.4 嘅下一步）：**要收窄 gap，先要卡片側唔再每次 enrich 都買一次",
  "`token_overview`。** 兩個方向之中揀咗 **durable holder cache**，唔用 GMGN 免費 `holder_count`。",
  "",
  "### 1. 點解係 cache 而唔係 GMGN",
  "",
  "* GMGN 個 `holder_count` 係**另一把尺**（換源＝換卡面數字，正正係 §4.14 §3.4 講嘅「要明講嘅決定」）；",
  "* 而且佢個 edge 以 IP 級 429 封咗 Worker 嘅共用 egress（2026-09-24 實測 `requests 9 / http429 9 /",
  "  consecutive429 9 / lastStatus 429`，leg 已經關咗），即係呢條路今日**行唔通**。",
  "",
  "Cache 保住同一個數字、同一個來源、同一個 metric，只係唔再重複買。",
  "",
  "### 2. 慳喺邊：重複唔係「每張卡」，係「每次 enrich」",
  "",
  "`resolveHolderCount` 唔係每次發卡叫一次 —— 係每次 **enrich** 叫一次，而同一個幣會重入 enrich：",
  "",
  "* 卡片送出被 tick cut 延後（deferral）→ 下一個 tick 再 enrich；",
  "* 某個 gate 今個 tick 拒、下個 tick 放（mcap/vol 喺邊界浮動）→ 再 enrich。",
  "",
  "`isTokenSeen` 只喺**成功送出之後**才寫，所以呢條路冇 dedupe：每次重入都係 20 CU",
  "（`getJson` 逐個 attempt 收費，失敗重試最多 3 次 = 60 CU）。基線係 §4.14：46K CU/月，",
  "卡片側 ≥60%。",
  "",
  "### 3. 做咗嘅：`token_stats.holder_count` / `holder_count_at` ＋ TTL",
  "",
  "* 兩條新 column。CREATE TABLE 有（fresh DB 唔使 ALTER），legacy DB 由 `addColumnIfMissing` 補",
  "  （idempotent，同 `max_mcap_observed` 一條路）。讀側係 `SELECT *`，所以兩條 column **順便帶返嚟**",
  "  ⇒ **cache hit = 0 request、0 CU、0 round trip**。",
  "* `holderCountCacheHit()`（`src/birdeye.ts`，exported 做測試）：",
  "  * 界線係 miss（TTL exclusive）—— 過期一定要重新買，唔可以靠 off-by-one 多食一個 tick；",
  "  * `ttlMs <= 0` = 關（＝ pre-2026-09-25 行為，逃生門）；",
  "  * `cachedAt <= 0` = 「從未寫過」嘅 sentinel，唔係 1970（同 `healthAgeMs` 同一條規矩）；",
  "  * `null` count = 冇讀數，唔會當 0（發明一個 0 = 卡面聲稱 0 個持有人）。",
  "* 寫入：**只有真正拿到 count 才寫**（一次 UPDATE，`stats.token` = token_stats PK）。寫入失敗",
  "  ＝失去一個 cache entry，**唔會**失去個讀數（卡照出嗰個數），下一次再買返。",
  "* 新 dial `BIRDEYE_HOLDER_CACHE_MIN = 30`（code default 30，0 = 關）。",
  "* **新幣完全唔受影響**：第一次 enrich 冇 cache，所以卡第一次出嘅數字永遠係即時買嘅。TTL 只決定",
  "  「一個仲喺 enrich 出入緊嘅幣」幾久重買一次 —— 最壞 30 分鐘一次（≈2 次/鐘），而 deferral 每 tick",
  "  重試嘅話本來係 ≈60 次/鐘。",
  "",
  "### 4. 落線點驗",
  "",
  "1. `byEndpoint.month.tokenOverview.calls` 對 `pushes`（`/debug/pushes`）：本來 `calls ≫ pushes`",
  "   （enrich 重入），之後應該收窄到 ≈「每個（coin, 30 分鐘窗）一次」。呢個就係本次改動嘅收據。",
  "2. 有值嘅 row：`holder_count_at` 係讀取時間（唔係 0），而且 re-enrich 喺 TTL 內**唔會**改動佢。",
  "3. 卡面持有人數唔會跌到 `—`（第一次一定 live）。",
  "4. 回退驗證：`BIRDEYE_HOLDER_CACHE_MIN = 0` 要即時回復舊行為（唔使 redeploy code，wrangler.toml",
  "   改完再 deploy 即可）。",
  "",
  "### 5. 咁 gap 呢？（刻意唔喺呢一刀改）",
  "",
  "* 卡片側落返之後先計得準：以 §4.14 嘅數，卡片側 ≥60%（≈28K/月）係最大變數，cache 之後跌幾多",
  "  要睇上面 #1 嘅 calls 對數。",
  "* gap 60 → 30 = probe 480 → 960 CU/日（**+14.4K/月**）；60 → 20 = **+28.8K/月**。",
  "* 所以次序係：deploy → 睇 calls/pushes 比 → 才決定 gap。收窄 gap 會改卡面數字嘅刷新率（每行",
  "  ~31 小時 → ~15 小時），係一個要明講嘅 dial 決定，唔應該夾埋喺「令卡片側唔再重複買」呢一刀。",
  "",
  "**測試**（`scripts/test-unit.js`）：`birdeye: the holder cache reuses a reading inside its TTL and never",
  "invents one`（界線係 miss、時鐘偏差、`0` = 關、`null`/`0` 唔算讀數）＋ `db: the holder cache is ONE write,",
  "and a coin nobody read stays unknown`（真 DB：fresh schema 帶兩條 column、未讀過 = null 唔係 0、",
  "一次 write、覆寫舊讀數）＋ `out-of-window patch: the card path reads the holder cache BEFORE it buys`",
  "（順序、`holderCountCacheHit` 必須係 value import 唔可以變 type import、半貼即紅）。",
);

// ── the probe shares the same reading (a second test-unit.js hunk) ──────────
const T2_MARKER = 'await test("db: the tracker\'s holder probe shares its reading with the card path, in ONE write"';
const T2_TESTS = lines(
  "  // The other writer: the tracker's holder probe (Db.setPushWatchHoldersMany).",
  "  //",
  "  // A coin is tracked moments after it was pushed, and the card path bought its",
  "  // token_overview at push time — so the probe's first pass for that row used to",
  "  // buy the same reading again. The probe now writes the reading into the same",
  "  // durable cache (token_stats.holder_count / holder_count_at) that the card",
  "  // path reads, IN THE SAME request as the row's own field, so the two can",
  "  // never disagree about what was read and the round trip count is unchanged.",
  '  await test("db: the tracker\'s holder probe shares its reading with the card path, in ONE write", async () => {',
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
  '      const before = (await db.listPushWatch())[0];',
  '      assert.equal(before.holdersLast, null, "the row carries no reading yet");',
  "      let writes = 0;",
  "      const counting = {",
  "        execute: (a) => t.client.execute(a),",
  '        batch: (a, m) => { if (m === "write") writes += 1; return t.client.batch(a, m); },',
  "        close: () => t.client.close(),",
  "      };",
  "      const cdb = new Db(t.p, undefined, counting);",
  "      await cdb.init();",
  "      writes = 0;",
  '      await cdb.setPushWatchHoldersMany([{ token: "SHARED1", holders: 700, at }]);',
  '      assert.equal(writes, 1, "the row and the shared cache land in ONE write");',
  '      const probed = (await cdb.listPushWatch())[0];',
  "      assert.equal(probed.holdersLast, 700);",
  "      assert.equal(probed.holdersCheckedAt, at);",
  '      assert.equal(probed.holdersAtPush, 700, "the first probe still seeds the rolling baseline");',
  "      // The same row the card path reads (Scanner.resolveHolderCount): the",
  "      // probe's reading is now what a card-side re-enrich reuses.",
  '      const shared = await cdb.getTokenStats("SHARED1");',
  "      assert.equal(shared.holderCount, 700);",
  "      assert.equal(shared.holderCountAt, at);",
  "      assert.equal(",
  "        holderCountCacheHit(shared.holderCount, shared.holderCountAt, at + 60_000, 30 * 60_000),",
  "        true,",
  '        "a card-side enrich a minute later reuses it instead of buying",',
  "      );",
  "      // A refused REQUEST wrote neither — which is why the two share one",
  "      // batch: the row's field and the shared cache cannot disagree.",
  "      const down = new Db(t.p, undefined, {",
  "        execute: (a) => t.client.execute(a),",
  "        batch: (a, m) => {",
  '          if (m === "write" && a.some((s) => String(s.sql).includes("UPDATE push_watch"))) {',
  '            throw new Error("write down");',
  "          }",
  "          return t.client.batch(a, m);",
  "        },",
  "        close: () => t.client.close(),",
  "      });",
  "      await down.init();",
  "      await down",
  '        .setPushWatchHoldersMany([{ token: "SHARED1", holders: 999, at: at + 60_000 }])',
  '        .then(() => assert.fail("the refused batch is supposed to reject"), () => {});',
  '      const after = (await db.listPushWatch())[0];',
  '      assert.equal(after.holdersLast, 700, "the row is untouched by the refused batch");',
  "      assert.equal(after.holdersCheckedAt, at);",
  '      const sharedAfter = await db.getTokenStats("SHARED1");',
  '      assert.equal(sharedAfter.holderCount, 700, "and so is the shared cache — they cannot disagree");',
  "      assert.equal(sharedAfter.holderCountAt, at);",
  "      // A later probe overwrites BOTH halves, in one write again.",
  '      await cdb.setPushWatchHoldersMany([{ token: "SHARED1", holders: 744, at: at + 30 * 60_000 }]);',
  '      const grown = await db.getTokenStats("SHARED1");',
  "      assert.equal(grown.holderCount, 744);",
  "      assert.equal(grown.holderCountAt, at + 30 * 60_000);",
  "    } finally {",
  "      await t.cleanup();",
  "    }",
  "  });",
  "",
);

// ── docs/round-trips.md §4.16 ──────────────────────────────────────────────
const R2_HEADING = "## 4.16 Tracker probe 同卡片側共用同一個持有人讀數（2026-09-25）";
const R2_SECTION = lines(
  "",
  "---",
  "",
  R2_HEADING,
  "",
  "Operator 要求：probe 嘅持有人數都寫入 §4.15 嗰個 durable cache，令 probe 同卡片側共用同一個讀數。",
  "",
  "### 1. 兩個買家，同一個幣",
  "",
  "`/defi/token_overview`（20 CU）喺 repo 只有兩個買家：",
  "",
  "* 卡片側 `Scanner.resolveHolderCount`（§4.15 加咗 cache）；",
  "* tracker probe（`PushWatcher` 嘅 holder stage，每個 pass 一個、隔 `PUSH_WATCH_HOLDER_MIN_GAP_MIN`）。",
  "",
  "而一個幣係**被推嘅下一秒就被追蹤**：`push_watch` 第一行嘅 `holders_checked_at` 係 NULL，所以下一個",
  "pass 就會 probe 佢 —— 即係同一個讀數啱啱先買完，轉頭又買多次。呢個就係今次接埋嘅窿。",
  "",
  "### 2. 做咗嘅",
  "",
  "* `Db.setPushWatchHoldersMany`（probe 嘅唯一寫入點，一個 batch ＝ 一個 round trip）除咗寫 push_watch",
  "  嘅 `holders_last` / `holders_checked_at` / `holders_at_push`，再加 N 條",
  "  `UPDATE token_stats SET holder_count, holder_count_at`。",
  "* **特登同一個 batch**：row 自己個數同共用 cache 唔可能對唔上（一個 rejected request 兩邊都冇寫），",
  "  而 trips 數目完全不變（`spent.holders.trips`）。",
  "* 卡片側唔使改：`resolveHolderCount` 已經讀 token_stats（§4.15）。",
  "",
  "### 3. 買到咗幾多（誠實量度）",
  "",
  "唔係大錢，講清楚：",
  "",
  "* probe 一 pass 一個、gap 60 分鐘 ⇒ 上限 24 次/日 ＝ 480 CU/日（§4.14）；",
  "* 主要受益位係「一個新幣被推之後嗰個 pass」：40–52 卡/月 ⇒ **800–1040 CU/月**；",
  "* 其餘情況係「同一個幣喺 30 分鐘窗內有人買過」—— 例如第二個 chat 嘅卡被 defer 之後重試。",
  "",
  "所以呢一刀買到嘅係**一致性**（兩邊講同一個數）＋一個細但實嘅 CU 位，唔係第二個 28K。",
  "",
  "### 4. 刻意冇做：probe 讀 cache",
  "",
  "即係「probe 見到 cache 新鮮就唔買」。慳嘅係上面 §3 嗰 800–1040 CU/月，但代價係：",
  "",
  "* probe note 要加一個新 counter（唔係 probe 就唔可以報 `probe1`）—— 即係改 `probe/miss/cut` 嘅讀數",
  "  格式，而呢個 repo 對「讀數唔准講大話」嘅要求高過 20 CU；",
  "* 若果 TTL 大過 tracker 嘅持有人刷新窗，probe 就會永遠唔買，tracker 嘅持有人數會**凍結**",
  "  （退化唔明顯，但係真嘅）；",
  "* 要安全就要多一條規則：只喺 `cachedAt > 該行自己嘅 holders_checked_at` 時重用（即「別人已經讀過，",
  "  而且比我手上嘅新」），咁 probe 就永遠唔會令自己嗰行變舊。",
  "",
  "呢個係一個獨立、要明講嘅改動，應該配自己嘅 note counter，所以留返下一步。",
  "",
  "### 5. 落線點驗",
  "",
  "1. 一個新 push 之後嘅第一個 tracker pass：`probe` 照舊（probe 冇變），而 `token_stats.holder_count_at`",
  "   會等於 probe 嗰個 `at`。",
  "2. `spent.holders.trips` 唔應該上升（同一個 batch 多咗 N 條 statement，但 request 冇多）。",
  "3. 反向：如果第二個 chat 嘅卡被 defer，佢下一次 enrich 唔應該再買（`tokenOverview.calls` 冇升，而卡面",
  "   持有人數仍然有值）。",
  "4. 一致性：同一個幣，`push_watch.holders_last` 同 `token_stats.holder_count` 喺 probe 之後應該逐字一樣。",
  "",
  "**測試**（`scripts/test-unit.js`）：`db: the tracker's holder probe shares its reading with the card path,",
  "in ONE write`（真 DB：一次 write 同時落 push_watch 同 token_stats；`holders_at_push` 由第一次 probe seed；",
  "卡片側 `holderCountCacheHit` 對 probe 嗰個讀數為 true；rejected batch 兩邊都冇寫；之後嘅 probe 覆寫兩邊）。",
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

patch(D, COL_MARKER, COL_ANCHOR, COL_REPLACEMENT, "the two cache columns exist");
// §4.16 made the probe a SECOND writer of these columns, so the comment above
// them must name both. Two separate hunks because the trees differ: a fresh run
// gets the new wording from COL_REPLACEMENT (so COL_FIX_MARKER is already there
// and this reports "already"), while the tree §4.15 landed on carries the
// card-path-only version and gets rewritten here.
patch(D, COL_FIX_MARKER, COL_FIX_ANCHOR, COL_FIX_REPLACEMENT, "the comment names both writers");
patch(D, ROW_MARKER, ROW_ANCHOR, ROW_REPLACEMENT, "the row reader sees them");
patch(D, MAP_MARKER, MAP_ANCHOR, MAP_REPLACEMENT, "and maps them onto TokenStats");
patch(D, UPDATE_MARKER, UPDATE_ANCHOR, UPDATE_REPLACEMENT, "the one-write cache stamp exists");
// NOTE: Db.setPushWatchHoldersMany (the probe's write, which now also lands the
// SHARED cache in the same batch) sits INSIDE the file-tool's edit window, so
// it is a normal edit rather than a hunk here — see the tracker's holder stage
// and docs/round-trips.md §4.16.
patch(S, SCAN_MARKER, SCAN_ANCHOR, SCAN_REPLACEMENT, "the card path reads the cache before buying");

// Two test blocks, both inserted at the same anchor (one after the other), so
// each is applied to the CURRENT buffer rather than to the file on disk.
for (const [marker, block, what] of [
  [T_MARKER, T_TESTS, "the cases are added"],
  [T2_MARKER, T2_TESTS, "the shared-reading case is added"],
]) {
  const live = bufferOf(T);
  if (live.includes(marker)) {
    console.log(`already   ${T}: ${what}`);
    continue;
  }
  if (once(live, T_INSERT_ANCHOR) !== 1) {
    console.error(`MISS/AMBIGUOUS ${T}: ${what}`);
    failed = true;
    continue;
  }
  buffers.set(T, live.replace(T_INSERT_ANCHOR, block + T_INSERT_ANCHOR));
  console.log(`ok        ${T}: ${what}`);
}

{
  const text = bufferOf(R);
  let live = text;
  for (const [heading, section, what] of [
    [R_HEADING, R_SECTION, "the change is documented"],
    [R2_HEADING, R2_SECTION, "the shared reading is documented"],
  ]) {
    if (live.includes(heading)) {
      console.log(`already   ${R}: ${what}`);
      continue;
    }
    live = `${live.trimEnd()}\n${section}\n`;
    buffers.set(R, live);
    console.log(`ok        ${R}: ${what}`);
  }
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
