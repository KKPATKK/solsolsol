#!/usr/bin/env node
/**
 * （a）1m K 線 定（b）第二個價格來源？—— 兩條路嘅結論，同免費嗰半嘅落地。
 *
 * THE QUESTION (operator, 2026-09-25): 「哪條路是可行的：(a) 用 1m K 線重建
 * 兩次檢查之間嘅價格路徑（盲窗都可以講出佢觸及過邊幾關同咩價位），或者
 * (b) 提高覆蓋率（第二個價格來源頂 DexScreener 429）？」
 *
 * (b) 已經喺 repo 內：tracker 嘅 pair 有三條腿（`Scanner.pairsForTracker`：
 * 本 tick 嘅 `lastPairs` → DexScreener → Jupiter `fetchTokenDataBatch` →
 * GeckoTerminal `fetchTokenSnapshot`），front pair phase 亦一樣有 Jupiter
 * fallback。2026-09-18 實測嗰次 429 就係 Jupiter 腿撐住 130/130 pairs
 * （見 docs/wrangler.toml DEX_REQUEST_INTERVAL_MS 註釋同
 * docs/gecko-429.md）。即係 (b) 冇嘢可以再建，除非有第三個來源覆蓋「三個
 * 都唔識」嘅幣 —— 而呢個 population 冇量到過。
 *
 * (a) 嘅 K 線形式付唔起：`BIRDEYE_CU_PRICES.ohlcv = 35` CU/次，而 free tier
 * 係 30_000 CU/月（卡片路徑單獨已經可以食光，見 docs/round-trips.md §4.4.2／
 * §4.5.1）。要覆蓋每個 gap 就要 31 rows × 1440 = ~44_640 次/日 = ~1.56M CU/日
 * ⇒ 一日燒 52 個月嘅 free tier；subrequest 側同樣死：+1 次/row/check = +30 個
 * subrequest/pass，而一個 invocation 只有 50，tick 本身已經用 10–16 個。
 *
 * 所以呢一刀做 (a) 嘅免費半：樣本**自己嘅** `priceChange.m5` 已經講咗 5 分鐘前
 * 個價喺邊（mcap = 價 × 固定 supply，所以 `mcap / (1 + m5/100)`），而佢喺
 * 「上次檢查 > 5 分鐘前」時就係盲窗內嘅一點 —— 零 CU、零 subrequest、零新來源。
 * 卡片於是把「一次檢查內跨越 +50%/+100%/+200%」升級成「…（距上次檢查 12 分鐘；
 * 5 分鐘前 $220.43K＝+55%：+50% 已跨過）」：邊幾關喺盲窗嘅前半已經跨過，唔再
 * 靠讀者猜。K 線先答得到嘅（盲窗內急升急回、樣本從未見過嘅一關）繼續留白，
 * 呢個係免費讀數嘅老實邊界。
 *
 * WHAT: `blindWindowPoint()`（純函數，有測試）＋ `risingCardTail()` 第三個
 * 參數。空窗（gap ≤ 5 分鐘）、未檢查過（`lastChecked 0`）、`m5 ≤ 0`（Gecko 腿冇
 * 呢個欄位）一律回 null ⇒ 正常一分鐘一次嘅檢查讀數**逐字不變**。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

// ── src/pushwatch.ts ───────────────────────────────────────────────────────
const SRC = "src/pushwatch.ts";
const SRC_MARKER = "const blind = blindWindowPoint({";
const SRC_ANCHOR = lines(
  "      const crossed = newlyCrossedStages(stage, firedStages);",
  "      fire(",
);
const SRC_REPLACEMENT = lines(
  "      const crossed = newlyCrossedStages(stage, firedStages);",
  "      // The sample's own 5-minute reach, when the previous check is further",
  "      // back than that (see blindWindowPoint): the only free reading of the",
  "      // window between two checks. Computed per crossing rather than per pass",
  "      // — the gap is a property of THIS row at THIS moment, and it is null",
  "      // for the ordinary once-a-minute check.",
  "      const blind = blindWindowPoint({",
  "        mcap: live.mcap,",
  "        chg5m: live.chg5m,",
  "        baseMcap: row.mcapAtPush,",
  "        gapMs: row.lastChecked > 0 ? now - row.lastChecked : 0,",
  "      });",
  "      fire(",
);
/** The tail call takes the reading (the only other change in the ladder). */
const TAIL_ANCHOR = "          risingCardTail(crossed, nextStage),";
const TAIL_REPLACEMENT = "          risingCardTail(crossed, nextStage, blind),";

// ── scripts/test-unit.js ───────────────────────────────────────────────────
const TEST = "scripts/test-unit.js";
const REQ_ANCHOR = "TRACKER_PAIR_HEAD, risingCardTail, newlyCrossedStages, baseMarkFor, revivedBaseline, trackerPassPulse }";
const REQ_REPLACEMENT = "TRACKER_PAIR_HEAD, risingCardTail, newlyCrossedStages, blindWindowPoint, BLIND_WINDOW_MS, baseMarkFor, revivedBaseline, trackerPassPulse }";
const TEST_ANCHOR =
  '  await test("evaluateWatch: weak, dead stops tracking, liquidity crash, holder growth", () => {';

const TEST_BLOCK = lines(
  '  await test("blindWindowPoint: only a window longer than its own 5-minute reach is read", () => {',
  "    // The point exists only when the previous check is further back than the",
  "    // sample's own m5 reach: a row checked a minute ago already sampled",
  "    // everything newer than the point, so naming it would tell the reader",
  "    // nothing the card's own `5m` field does not.",
  "    assert.equal(",
  "      blindWindowPoint({ mcap: 476_120, chg5m: 116, baseMcap: 142_440, gapMs: 60_000 }),",
  "      null,",
  '      "a once-a-minute check has no window to describe",',
  "    );",
  "    assert.equal(BLIND_WINDOW_MS, 5 * 60_000);",
  "    assert.equal(",
  "      blindWindowPoint({ mcap: 476_120, chg5m: 116, baseMcap: 142_440, gapMs: 0 }),",
  "      null,",
  '      "a row that was never checked has no gap to describe",',
  "    );",
  "    // m5 <= 0 is NOT \"flat\": the GeckoTerminal leg carries 0 for a field it",
  "    // does not publish (see Scanner.pairsForTracker), and a level derived from",
  '    // a number that means "no reading" is exactly what this repo refuses to',
  "    // put on a card.",
  "    assert.equal(",
  "      blindWindowPoint({ mcap: 476_120, chg5m: 0, baseMcap: 142_440, gapMs: 12 * 60_000 }),",
  "      null,",
  '      "a zero m5 is a missing reading, not a flat tape",',
  "    );",
  "    assert.equal(",
  "      blindWindowPoint({ mcap: 476_120, chg5m: -20, baseMcap: 142_440, gapMs: 12 * 60_000 }),",
  "      null,",
  '      "a falling 5m cannot describe a climb",',
  "    );",
  "    assert.equal(",
  "      blindWindowPoint({ mcap: 476_120, chg5m: 116, baseMcap: 0, gapMs: 12 * 60_000 }),",
  "      null,",
  '      "no usable base, no % to report",',
  "    );",
  "    // The ALCHEMY shape, to the dollar: `推送時 $142.44K → $476.12K (+234%)`",
  "    // with `5m +116%` puts the price at 476_120 / 2.16 = $220_426, i.e. +54.8%",
  "    // from the push-time base — the +50% band, five minutes early.",
  "    const p = blindWindowPoint({",
  "      mcap: 476_120,",
  "      chg5m: 116,",
  "      baseMcap: 142_440,",
  "      gapMs: 12.4 * 60_000,",
  "    });",
  "    assert.ok(p, \"the ALCHEMY shape is readable\");",
  "    assert.ok(Math.abs(p.mcapAt5m - 220_426) < 2, `mcap 5m ago ≈ $220.43K (got ${p.mcapAt5m})`);",
  "    assert.ok(p.pctAt5m > 54 && p.pctAt5m < 56, `and ≈ +55% from base (got ${p.pctAt5m})`);",
  "    assert.equal(p.gapMs, 12.4 * 60_000);",
  "  });",
  "",
  '  await test("risingCardTail: a blind window\'s own point dates the bands it swallowed", () => {',
  "    // ALCHEMY: +50/+100/+200 crossed while nothing sampled the row. The +50%",
  "    // band is provably EARLY — the price was already +54.8% five minutes",
  "    // before the sample — so the card dates it instead of leaving the reader",
  "    // to guess whether all three bands happened inside the last minute.",
  "    const blind = { gapMs: 12.4 * 60_000, mcapAt5m: 220_426, pctAt5m: 54.8 };",
  "    const text = risingCardTail([50, 100, 200], 400, blind);",
  "    assert.match(text, /一次檢查內跨越 \\+50%\\/\\+100%\\/\\+200%/);",
  "    assert.match(text, /距上次檢查 12 分鐘/);",
  "    assert.match(text, /5 分鐘前 \\$220\\.43K＝\\+55%/);",
  "    assert.match(text, /\\+50% 已跨過/);",
  "    assert.match(text, /下一關 \\+400%/);",
  "    // A point BELOW every swallowed band is the opposite reading: the whole",
  "    // climb is inside the sample's own five minutes.",
  "    const fresh = risingCardTail([50, 100, 200], 400, {",
  "      gapMs: 12.4 * 60_000,",
  "      mcapAt5m: 150_000,",
  "      pctAt5m: 5.3,",
  "    });",
  "    assert.match(fresh, /整段爬升都喺最近 5 分鐘內/);",
  "    assert.doesNotMatch(fresh, /已跨過/);",
  "    // And with no reading at all the tail is byte-for-byte what it was (that",
  "    // is the ordinary once-a-minute check, and the pinned strings above).",
  "    assert.equal(risingCardTail([50, 100], 200), \" | 一次檢查內跨越 +50%/+100% | 下一關 +200%\");",
  "  });",
  "",
  '  await test("evaluateWatch: a blind window\'s own point rides the card that swallowed the bands", () => {',
  "    // The two halves meet here: the ladder fires outside the pacing gate (see",
  "    // the test above) and the WINDOW is what the card now also reports. Live",
  "    // 2026-09-25 ALCHEMY: one card at +234% naming +50/+100/+200, with the",
  "    // row un-evaluated for 24 of the previous minutes.",
  "    const row = (over = {}) => ({",
  '      token: "T", chatId: "c", symbol: "ALCHEMY", pushedAt: 0,',
  "      mcapAtPush: 142_440, peakMcap: 142_440, lastLiquidity: 30_000,",
  "      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,",
  "      lastChecked: 0, lastAlertAt: 0, followupsSent: 0, lastState: null,",
  "      ...over,",
  "    });",
  "    const live = (mcap, chg5m) => ({ mcap, liquidity: 30_000, chg5m, buysH1: 200, sellsH1: 100 });",
  "    const cfg = { cooldownMs: 30 * 60_000 };",
  "    const now = 10_000_000;",
  "",
  "    // A warning card fired a minute ago (the row is paced for another 29",
  "    // minutes) AND the previous check is 12 minutes back.",
  "    const blind = evaluateWatch(",
  "      row({ lastChecked: now - 12.4 * 60_000, lastAlertAt: now - 60_000 }),",
  "      now,",
  "      live(476_120, 116),",
  "      cfg,",
  "    );",
  "    assert.equal(blind.alerts.length, 1);",
  '    assert.equal(blind.alerts[0].sig, "up200", "the highest crossed band is the card");',
  "    assert.match(blind.alerts[0].text, /距上次檢查 12 分鐘/);",
  "    assert.match(blind.alerts[0].text, /5 分鐘前 \\$220\\.43K＝\\+55%/);",
  "    assert.match(blind.alerts[0].text, /一次檢查內跨越 \\+50%\\/\\+100%\\/\\+200%/);",
  "",
  "    // The SAME evaluation on time (a 60s gap) must read exactly as before:",
  "    // the point is not new information, so it is not claimed.",
  "    const timely = evaluateWatch(",
  "      row({ lastChecked: now - 60_000, lastAlertAt: now - 60_000 }),",
  "      now,",
  "      live(476_120, 116),",
  "      cfg,",
  "    );",
  "    assert.equal(timely.alerts.length, 1);",
  "    assert.match(timely.alerts[0].text, /一次檢查內跨越 \\+50%\\/\\+100%\\/\\+200%/);",
  "    assert.doesNotMatch(timely.alerts[0].text, /距上次檢查/);",
  "    assert.doesNotMatch(timely.alerts[0].text, /5 分鐘前/);",
  "  });",
  "",
  TEST_ANCHOR,
);

// ── docs/push-baseline-ledger.md ───────────────────────────────────────────
const DOC = "docs/push-baseline-ledger.md";
const DOC_ANCHOR_LINE = "唯一可以再進一步嘅方向係用 1m K 線重建兩次檢查之間嘅價格路徑（未做）。";
const DOC_ANCHOR_REPLACEMENT =
  "唯一可以再進一步嘅方向係用 1m K 線重建兩次檢查之間嘅價格路徑 —— **2026-09-25 評估完**：\n" +
  "K 線路線付唔起，改為讀樣本自己嘅 5 分鐘點（見第十四補）。";
const DOC_HEADING = "## 第十四補：(a) 1m K 線 定 (b) 第二個價格來源？";

const DOC_SECTION = lines(
  "",
  "---",
  "",
  DOC_HEADING,
  "",
  "Operator 問（2026-09-25）：盲窗要點補 —— **(a)** 用 1m K 線重建兩次檢查之間嘅",
  "價格路徑，定 **(b)** 提高覆蓋率（第二個價格來源頂 DexScreener 429）？",
  "",
  "答案係：**(b) 已經喺 repo 內，唔係一條待建嘅路；(a) 嘅 K 線形式付唔起** ——",
  "兩者都唔係路，但 (a) 有一個免費嘅半邊，呢個 patch 就係做嗰半邊。",
  "",
  "### 1. (b) 已經落地（所以唔係選項）",
  "",
  "Tracker 嘅 pair 一直有三條腿，最後兩條就係為 DexScreener 429 而設：",
  "",
  "| 腿 | 位置 | 服務對象 |",
  "| --- | --- | --- |",
  "| `lastPairs`（本 tick scan 前排已付過嘅批次） | `Scanner.lastPairs` | head 冇變位時**零** HTTP |",
  "| DexScreener `fetchPairsForTokens` | `Scanner.pairsForTracker` | 主來源 |",
  "| Jupiter `fetchTokenDataBatch` | 同上（`missing` 仍未答到時） | 429 期間嘅主力 |",
  "| GeckoTerminal `fetchTokenSnapshot` | 同上（`TRACKER_GECKO_LOOKUPS` 上限） | 前兩條都交白卷時 |",
  "",
  "另外 front pair phase 自己亦有 Jupiter fallback（`pairsByToken.size < addresses.length * 0.5`）。",
  "2026-09-18 嗰次實測（wrangler.toml `DEX_REQUEST_INTERVAL_MS` 註釋、docs/gecko-429.md）：",
  "DexScreener 429 嘅整段窗口都由 Jupiter 腿**撐住 130/130 pairs**。即係「第二個價格來源」",
  "唔止有，係已經證明過。再建第三個來源只能覆蓋「三個都唔識」嘅幣 —— 而呢個 population",
  "冇量到過（`/debug/push-watch` 冇呢個讀數，亦冇卡片因佢而唔推）。",
  "",
  "### 2. (a) 嘅 K 線形式：兩邊預算都爆（算術，唔係感覺）",
  "",
  "* **CU**：`BIRDEYE_CU_PRICES.ohlcv = 35` CU/次（`src/birdeye.ts`），free tier 30_000 CU/**月**；",
  "  而 docs/round-trips.md §4.4.2／§4.5.1 已經記住：**卡片路徑單獨（`token_overview` 20 CU × 40–52",
  "  張/日）就可以食光整個月**。要覆蓋每個 gap：31 條 active row × 1440 次/日 ≈ **44_640 次/日**",
  "  ＝ **~1.56M CU/日** ⇒ 一日燒 **~52 個月**嘅 free tier。就算只做「已吞關卡」嘅行，",
  "  都要先逐行攞 K 線才知道有冇吞 —— 冇一個免費嘅篩。",
  "* **Subrequest**：每 row 每次檢查 +1 → 一個 pass +30（head 30），而一個 invocation 只有",
  "  **50**，tick 本身已經用 **10–16**（`/health.subreqs`）。即係 K 線路線唔止貴，係**爆預算**。",
  "* **覆蓋率亦唔係瓶頸**：31 條 row ÷ head 30 ≈ 每行 **~60s** 一次，即 cron 自己嘅下限；",
  "  所以「兩次檢查之間」嘅盲窗本身只有一分鐘，而 429／`deferred:subreq-budget`／tick 死亡",
  "  先係把它拉長到幾分鐘嘅原因（第十三補 §2）—— 呢個係 tick 預算問題，唔係價格來源問題。",
  "",
  "### 3. 做咗嘅：樣本自己嘅 5 分鐘點（零 CU、零 subrequest）",
  "",
  "`priceChange.m5` 係 DexScreener 自己發佈嘅「5 分鐘前 → 現在」變化；mcap = 價 × 固定",
  "supply，所以 `mcapAt5m = mcap / (1 + m5/100)`。當**上次檢查距今 > 5 分鐘**，呢一點就落在",
  "盲窗之內 —— 即係免費得到盲窗中段嘅一個價格讀數，唔使任何新來源。",
  "",
  "* `blindWindowPoint()`（`src/pushwatch.ts`，純函數）：`gap ≤ 5 分鐘`、未檢查過（`lastChecked 0`）、",
  "  `m5 ≤ 0`（Gecko 腿冇呢個欄位，`0` ＝ 冇讀數，唔係平盤）、base 唔可用 ⇒ 一律 `null`。",
  "* 🚀 卡尾（`risingCardTail` 第三個參數）：吞咗多過一關時，多報一句",
  "  `（距上次檢查 12 分鐘；5 分鐘前 $220.43K＝+55%：+50% 已跨過）` —— 即係話俾讀者知",
  "  邊幾關喺盲窗**前半**已經跨過（`≤ pctAt5m` 嘅關卡），邊幾關係最近 5 分鐘嘅事；若果點數",
  "  低過所有吞咗嘅關卡，就反過來講 `整段爬升都喺最近 5 分鐘內`。",
  "* **唔變嘅保證**：正常一分鐘一次嘅檢查（gap ≤ 5 分鐘）讀數**逐字不變**；冇新 call、冇新來源、",
  "  冇改任何 gate／發卡條件；卡只係把已經有嘅 `5m` 欄位換成一個可讀嘅位置。",
  "",
  "**老實講清界線**：`m5` 係**一點**，唔係一條路徑。盲窗內「急升到某關再完全回落」呢個形狀，",
  "樣本同 `m5` 都捕捉唔到（row 自己嘅 `peak_mcap` 高水位都證明唔到：取樣未見過嘅關卡就係",
  "證明唔到嘅關卡）。要答嗰個形狀就真係要 K 線 —— 而上面嘅算術就係佢付唔起嘅原因。",
  "",
  "### 4. 驗證",
  "",
  "* `test-unit.js` 加 3 條：`blindWindowPoint` 嘅六個 null 出口＋ALCHEMY 形狀（476_120 / 2.16",
  "  ＝ $220_426、+54.8%）；`risingCardTail` 嘅三個分支（已跨過／整段喺 5 分鐘內／冇讀數時逐字",
  "  不變）；`evaluateWatch` 嘅 12 分鐘 gap（卡帶 `距上次檢查 12 分鐘`）同 60 秒 gap（卡**冇**",
  "  `距上次檢查`、冇 `5 分鐘前`）。",
  "* 落線睇：`/health.pushWatchPass.note` 唔應該因呢刀而變；下次出現 `pairs-empty`／",
  "  `deferred:subreq-budget`／tick 死亡之後嘅 🚀 卡，尾段應該帶 `距上次檢查 N 分鐘`，",
  "  而 `N` 對得上嗰個盲窗。",
);

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;
const once = (text, needle) => text.split(needle).length - 1;

/** A single anchor → replacement, with an idempotency marker. */
function patch(file, marker, anchor, replacement, what) {
  const text = bufferOf(file);
  if (typeof marker === "string" && text.includes(marker)) {
    if (text.includes(replacement)) {
      console.log(`already   ${file}: ${what}`);
      return;
    }
  }
  const at = text.indexOf(anchor);
  if (at < 0) {
    console.error(`MISS      ${file}: ${what}`);
    failed = true;
    return;
  }
  if (once(text, anchor) !== 1) {
    console.error(`AMBIGUOUS ${file}: ${what}`);
    failed = true;
    return;
  }
  buffers.set(file, text.replace(anchor, replacement));
  console.log(`ok        ${file}: ${what}`);
}

patch(SRC, SRC_MARKER, SRC_ANCHOR, SRC_REPLACEMENT, "the ladder reads the sample's own 5-minute point");
patch(SRC, "risingCardTail(crossed, nextStage, blind)", TAIL_ANCHOR, TAIL_REPLACEMENT, "and hands it to the card tail");
patch(TEST, "blindWindowPoint, BLIND_WINDOW_MS", REQ_ANCHOR, REQ_REPLACEMENT, "the new exports are imported");
patch(
  TEST,
  "blindWindowPoint: only a window longer than its own 5-minute reach is read",
  TEST_ANCHOR,
  TEST_BLOCK,
  "the blind-window tests are added",
);
patch(DOC, DOC_ANCHOR_REPLACEMENT, DOC_ANCHOR_LINE, DOC_ANCHOR_REPLACEMENT, "§2 points at the new section");

{
  const text = bufferOf(DOC);
  if (text.includes(DOC_HEADING)) {
    console.log(`already   ${DOC}: the decision is documented`);
  } else {
    buffers.set(DOC, `${text.trimEnd()}\n${DOC_SECTION}\n`);
    console.log(`ok        ${DOC}: the decision is documented`);
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
