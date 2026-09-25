#!/usr/bin/env node
/**
 * 「收到續漲通知時已經到了最高里程碑」—— +50/+100/+200 點解從來冇單獨出現過？
 *
 * WHAT HAPPENED (2026-09-25, ALCHEMY; 06:49 HKT same day, parafactual)
 *   23:05:04Z  🩸 賣壓主導 ALCHEMY          ← 最後一張卡（冷卻武裝到 23:35）
 *   23:59:59Z  🚀 續漲 ALCHEMY | 推送時 $142.44K → $476.12K (+234%) |
 *              5m +116% | 下一關 +400%
 *   row：`up_stages = "up50,up100,up200,w35,w45"`、`mcap_at_push` 係真推送值、
 *   `dead_trough_mcap = null`（冇死過）、`followupsSent = 5`。
 *   audit ring 由 23:05 到 23:59 之間，ALCHEMY 一張卡都冇。
 *
 * THE HOLE (two of them, and only one is fixable here)
 *   1. **Pacing 吞咗梯級。** `const cooledDown = now - row.lastAlertAt >= cooldownMs`
 *      開喺 `if (cooledDown) {`，而**整個 🚀 ladder 住喺嗰個 block 入面**。所以：
 *        - 冷卻期內被觀察到嘅新關卡 → 唔發卡，**而且唔寫 mark**；
 *        - 若果之後價位冇再上返嗰一關，嗰個里程碑**永遠唔會公佈**；
 *        - 下一張卡（冷卻過後）就係「最高里程碑」，下面幾關以 `一次檢查內跨越 …` 帶過。
 *      Cooldown 係 *pacing* 規則：防止「可以重複嘅卡」喺窗口內重複。第一次跨關卡
 *      唔係重複 —— 佢嘅 once-only 保證係 **`up_stages` 嗰個持久 mark**（正正就係
 *      取代 `lastState` 記憶、收掉「三張 🚀 JEFFERY 一小時」嗰件工具）。🩸
 *      sell-pressure 卡早就係同一理由行喺 gate 外面（見 `SELL_DOM_PACE_MS` 上面
 *      嗰段註釋），而 🚀 嘅「pace」就係 mark 本身。
 *   2. **取樣下限（60s）＋ 觀察缺口。** tracker 每 tick 為 head 30 行攞一次價
 *      （live `rows 30/30 pairs 30/30`），31 條 active row ⇒ 每行 ~1.03 ticks ≈ 60s。
 *      一次 tick 內跨完嘅梯級，任何 live 取樣都捕捉唔到；而 `pairs-empty`（429）、
 *      `deferred:subreq-budget`、tick 死亡都會令行暫時完全冇被評估。呢個用「一張卡
 *      講明跨咗邊幾關」（第十一補）處理，唔係喺呢個 patch 改得到嘅嘢。
 *
 * NOTE 中途試過一個「memory 單調化」（lastState 係 up100 ⇒ up50 都算 announced）嘅
 * 寫法，佢會令 `evaluateWatch: absolute liquidity floor` 嗰條測試過，但佢同 module
 * 自己嘅 doctrine 相反（`newlyCrossedStages`：凡係 column 冇 mark 嘅關卡都算未
 * 公佈，legacy row 可以一次性補發 —— 見 `up-stage memory survives weak wipes`），
 * 所以收返，改為修正嗰兩條測試自己（佢哋本來靠 cooldown 做靜音器）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const GATE = "  if (cooledDown) {";
const LADDER_FROM = "    // Rising stages: fire the highest crossed stage not yet announced.";
const LADDER_TO = "    // Weak: meaningful runup then ≥35% off the peak.";
const MOVE_MARKER = "  // ── The 🚀 ladder is NOT paced";

const MOVE_COMMENT = lines(
  "  // ── The 🚀 ladder is NOT paced ──────────────────────────────────────────",
  "  // The cooldown below is a PACING rule: it exists so a card that can REPEAT",
  "  // cannot repeat inside the window (the same ⚠️ depth re-arming, an ignition",
  "  // re-firing on every bounce). A first-time 🚀 stage is not a repeat, and its",
  "  // once-only guarantee is the PERSISTENT up_stages mark, not the clock — that",
  "  // mark is exactly what replaced the lastState memory which produced three 🚀",
  "  // JEFFERY cards in an hour. Gating a milestone on the clock therefore bought",
  "  // nothing and cost the thing the row exists to report: a band crossed while",
  "  // the row was still cooling was neither announced NOR marked, so a coin that",
  "  // never traded above that band again never announced it at all — the first",
  "  // card the reader saw named every stage ABOVE it (live 2026-09-25: ALCHEMY",
  "  // `推送時 $142.44K → $476.12K (+234%)` and parafactual +473%, one card each).",
  "  // Same reasoning as the 🩸 card above, which already runs outside this gate;",
  "  // there the streak plus SELL_DOM_PACE_MS keep it quiet, here the mark is",
  "  // enough. Everything else inside the gate below is unchanged.",
  "",
);

const DOC_HEADING = "## 第十三補：梯級唔應該被 pacing 吞";

const DOC = lines(
  "",
  "---",
  "",
  DOC_HEADING,
  "",
  "Operator 報告（2026-09-25）：07:59 HKT 收到",
  "`🚀 續漲 ALCHEMY | 推送時 $142.44K → $476.12K (+234%) | … | 下一關 +400%`，",
  "但之前**冇**收過「死而復生」，亦冇任何低一級嘅「續漲」。06:49 HKT 嘅 parafactual",
  "（`+473%`）同一個形狀。",
  "",
  "**呢個唔係漏發，係兩個獨立嘅洞。**",
  "",
  "### 1. Pacing 吞咗梯級（已修）",
  "",
  "`cooledDown = now - row.lastAlertAt >= cooldownMs`（預設 30 分鐘）開喺",
  "`if (cooledDown) {`，而**整個 🚀 梯級**（`RISING_STAGES = [50,100,200,400]`）就住喺",
  "嗰個 block 入面。結果：冷卻期內被觀察到嘅新關卡**唔發卡、亦唔寫 mark**；",
  "若果價位冇再上返嗰一關，嗰個里程碑**永遠唔會公佈**，而下一張卡（冷卻過後）就係",
  "「最高里程碑」。ALCHEMY 就係咁：`23:05:04Z` 🩸 卡武裝冷卻 → `23:35` 解封，",
  "而 `23:59:59.859Z` 嗰張卡嘅 `crossed` 係 `+50%/+100%/+200%` 三關。",
  "",
  "**但呢兩個洞唔一定係同一個，唔好混為一談。** ALCHEMY 嗰張卡自己報 `5m +116%`，",
  "即係五分鐘前價已經 ≈ +54%（早就跨過 +50% 關）；如果 23:35–23:59 之間任何一次檢查",
  "睇到嗰個價，舊碼會吞（§1），但條 row 好可能**根本冇被評估過**（§2）—— 兩件事都真，",
  "要分開講：呢個 patch 只收得死 §1。",
  "",
  "Cooldown 係 **pacing** 規則：佢防「可以重複嘅卡」喺窗口內重複（同一個 ⚠️ 深度",
  "re-arm、🔥 ignition 每次反彈 re-fire）。第一次跨關卡**唔係重複**，佢嘅 once-only",
  "保證係 **`up_stages` 嗰個持久 mark** —— 正正就係取代 `lastState` 記憶、收掉",
  "「三張 🚀 JEFFERY 一小時」嗰件工具。🩸 sell-pressure 卡早就用同一理由行喺 gate",
  "外面（`SELL_DOM_PACE_MS`）；🚀 嘅 pace 就係 mark 本身。",
  "",
  "**修正**（`docs/patches/bands-not-paced.apply.js`）：梯級搬出 gate，其餘規則",
  "（🔥 ignition、⚠️ weak、持倉、divergence、drain/disarm）一律留在 gate 內。",
  "相對次序不變（梯級同 🔥 互斥：🔥 要求 `chgSincePush < RISING_STAGES[0]`），",
  "`dead` / `revive` 兩條 path 都喺之前 `return`，所以屍體唔會發 🚀。",
  "",
  "### 2. 取樣下限同觀察缺口（未修，講清楚）",
  "",
  "Tracker 每個 tick 為 head 30 行攞一次價（live `rows 30/30 pairs 30/30`），",
  "31 條 active row ⇒ 每行 **~1.03 ticks ≈ 60s**，而 cron 下限本身就係一分鐘。",
  "所以一次檢查之內跨完嘅梯級，**冇**任何 live 取樣捕捉得到；再加 `pairs-empty`",
  "（DexScreener 429）、`deferred:subreq-budget`、tick 死亡，條 row 可以幾分鐘",
  "完全冇被評估。呢類個案仍然係「一張卡講明跨咗邊幾關」（第十一補）——",
  "唯一可以再進一步嘅方向係用 1m K 線重建兩次檢查之間嘅價格路徑（未做）。",
  "",
  "### 驗證",
  "",
  "新測試 `evaluateWatch: a band crossed while the row is paced still fires`：",
  "同一行喺 pacing 之內 `+60%` → 出 `up50` 卡（`下一關 +100%`）；一分鐘後 `+120%`",
  "→ 出 `up100` 卡；同一關再見到（已 mark）→ 0 張；🔥 ignition 喺窗口內仍然 0 張、",
  "窗口過後 1 張。",
  "",
  "Reproduce：一日之內五分鐘嘅爬升（`$165K → $220K → $300K → $400K → $476K`，",
  "每分鐘一次檢查）而家出 `up50`／`up100`／`up200` **三張卡**；同樣嘅爬升若果中間",
  "冇檢查（下一次已經 `+234%`）就照舊一張卡、並寫明 `一次檢查內跨越 +50%/+100%/+200%`。",
);

const PATCHES = [
  // ── scripts/test-unit.js ─────────────────────────────────────────────────
  {
    file: "scripts/test-unit.js",
    what: "the old test says what actually silences a repeat",
    marker: "rising stages fire once each; the mark suppresses, not the clock",
    anchor:
      '  await test("evaluateWatch: rising stages fire once each; cooldown suppresses", () => {',
    replacement:
      '  await test("evaluateWatch: rising stages fire once each; the mark suppresses, not the clock", () => {',
  },
  {
    file: "scripts/test-unit.js",
    what: "and its inline comment stops crediting the clock",
    marker: "Note WHICH thing silences it",
    anchor: lines(
      "    // Same stage again within cooldown → no alert, but bookkeeping updates.",
    ),
    replacement: lines(
      "    // Same stage again while the row is still paced → no alert, but",
      "    // bookkeeping updates. Note WHICH thing silences it: the mark (`up50` is",
      "    // in `lastState` here), not the clock — the clock used to swallow the",
      "    // crossing TOO, which is what the pacing test below pins down.",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "and the pacing hole gets a test of its own",
    marker: "a band crossed while the row is paced still fires",
    anchor: lines(
      '  await test("evaluateWatch: weak, dead stops tracking, liquidity crash, holder growth", () => {',
    ),
    replacement: lines(
      '  await test("evaluateWatch: a band crossed while the row is paced still fires", () => {',
      "    // The cooldown is PACING, not memory. It exists so a card that can REPEAT",
      "    // cannot repeat inside the window; a first-time 🚀 stage is not a repeat,",
      "    // and the PERSISTENT up_stages mark — not the clock — is what keeps it",
      "    // once-only. Gating the ladder on the clock bought nothing and cost the",
      "    // milestone itself: live 2026-09-25 the first ALCHEMY card the operator",
      "    // saw was `推送時 $142.44K → $476.12K (+234%)` with +50/+100/+200 named",
      "    // as crossed, because the bands were crossed while the row was cooling.",
      "    const row = (over = {}) => ({",
      '      token: "T", chatId: "c", symbol: "GOAT", pushedAt: 0,',
      "      mcapAtPush: 50_000, peakMcap: 50_000, lastLiquidity: 30_000,",
      "      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,",
      "      lastChecked: 0, lastAlertAt: 0, followupsSent: 0, lastState: null,",
      "      ...over,",
      "    });",
      "    const live = (mcap) => ({ mcap, liquidity: 30_000, chg5m: 5, buysH1: 200, sellsH1: 100 });",
      "    const cfg = { cooldownMs: 30 * 60_000 };",
      "    const now = 3600_000;",
      "",
      "    // A ⚠️/🩸 card fired a minute ago, so the row is paced for another 29 min.",
      "    const r1 = evaluateWatch(row({ lastAlertAt: now - 60_000 }), now, live(80_000), cfg);",
      '    assert.equal(r1.alerts.length, 1, "a first-time band is announced when it is seen");',
      '    assert.equal(r1.alerts[0].sig, "up50");',
      '    assert.match(r1.alerts[0].text, /下一關 \\+100%/, "and still names the next one");',
      "",
      "    // One check later the +100% band gets its OWN card instead of being folded",
      "    // into a later +200%/+400% card, which is the whole point of the fix.",
      "    const r2 = evaluateWatch(",
      '      row({ lastState: "up50", lastAlertAt: now, upStages: "up50" }),',
      "      now + 60_000,",
      "      live(110_000),",
      "      cfg,",
      "    );",
      "    assert.equal(r2.alerts.length, 1);",
      '    assert.equal(r2.alerts[0].sig, "up100");',
      "",
      "    // The mark, not the clock, keeps it once-only: the same stage seen again",
      "    // while the row is still paced stays silent.",
      "    const r3 = evaluateWatch(",
      '      row({ lastState: "up100", lastAlertAt: now + 60_000, upStages: "up50,up100" }),',
      "      now + 120_000,",
      "      live(112_000),",
      "      cfg,",
      "    );",
      '    assert.equal(r3.alerts.length, 0, "an announced stage does not repeat inside the window");',
      "",
      "    // Everything else in the gate is still paced: a dormant tape printing its",
      "    // first big 5m volume bar inside the window fires nothing …",
      "    const vol = { mcap: 52_000, liquidity: 30_000, chg5m: 5, vol5m: 40_000, buysH1: 200, sellsH1: 100 };",
      "    const ignitionHeld = evaluateWatch(",
      "      row({ lastAlertAt: now - 60_000, lastVol5m: 5_000 }),",
      "      now,",
      "      vol,",
      "      cfg,",
      "    );",
      '    assert.equal(ignitionHeld.alerts.length, 0, "ignition is still paced by the cooldown");',
      "    // … and fires once the window has passed.",
      "    const ignitionDue = evaluateWatch(",
      "      row({ lastAlertAt: now - 31 * 60_000, lastVol5m: 5_000 }),",
      "      now,",
      "      vol,",
      "      cfg,",
      "    );",
      "    assert.equal(ignitionDue.alerts.length, 1);",
      '    assert.equal(ignitionDue.alerts[0].sig, "ignite");',
      "  });",
      "",
      // The anchor line is replaced, not spliced after, so it has to come back:
      // this is the opening line of the test that followed it.
      '  await test("evaluateWatch: weak, dead stops tracking, liquidity crash, holder growth", () => {',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the drain fixtures carry the ladder's memory, now that the clock is gone",
    marker: '      upStages: "up50,up100,up200",',
    anchor: lines(
      "    const row = (over = {}) => ({",
      '      token: "T", chatId: "c", symbol: "CatGPT", pushedAt: 0,',
      "      mcapAtPush: 50_000, peakMcap: 126_000, lastLiquidity: 12_000,",
      "      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,",
      '      lastChecked: 0, lastAlertAt: -3600_000, followupsSent: 0, lastState: "up100",',
      "      ...over,",
      "    });",
    ),
    replacement: lines(
      "    const row = (over = {}) => ({",
      '      token: "T", chatId: "c", symbol: "CatGPT", pushedAt: 0,',
      "      mcapAtPush: 50_000, peakMcap: 126_000, lastLiquidity: 12_000,",
      "      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,",
      '      lastChecked: 0, lastAlertAt: -3600_000, followupsSent: 0, lastState: "up100",',
      "      // The ladder's memory, COMPLETE for a row that peaked at +152% (the",
      "      // same lesson the drain rule teaches: a state column is not a mark).",
      "      // Without it these fixtures report the bands the row never announced —",
      "      // the one-time backfill the JEFFERY test covers — and pick up a 🚀 card",
      "      // that has nothing to do with the 💧/rug question being asked here.",
      '      upStages: "up50,up100,up200",',
      "      ...over,",
      "    });",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the arm joins the row's marks; it does not replace them",
    marker: 'assert.equal(r.announcedUpStages, "liq1,up100,up200,up50"',
    anchor: "    assert.equal(r.announcedUpStages, DRAIN_CONFIRM_MARK);",
    replacement: lines(
      "    // The arm writes the confirm mark TOGETHER with the row's stage marks —",
      "    // one column carries both, which is what keeps a 💧-warning row's ladder",
      "    // memory alive (replacing it would re-announce every band it already",
      "    // announced). It reads as `DRAIN_CONFIRM_MARK` alone only for a row whose",
      "    // column held nothing else.",
      '    assert.equal(r.announcedUpStages, "liq1,up100,up200,up50");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "collapse the blank run the reverted experiment left behind",
    marker:
      'assert.equal(r3.alerts.length, 0, "an announced stage does not repeat inside the window");\n\n    // Everything else in the gate',
    anchor: lines(
      '    assert.equal(r3.alerts.length, 0, "an announced stage does not repeat inside the window");',
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "    // Everything else in the gate is still paced: a dormant tape printing its",
    ),
    replacement: lines(
      '    assert.equal(r3.alerts.length, 0, "an announced stage does not repeat inside the window");',
      "",
      "    // Everything else in the gate is still paced: a dormant tape printing its",
    ),
  },
  // ── docs ─────────────────────────────────────────────────────────────────
  {
    file: "docs/push-baseline-ledger.md",
    what: "the two holes are named apart, not as one cause",
    marker: "但呢兩個洞唔一定係同一個",
    anchor: lines(
      "「最高里程碑」。ALCHEMY 就係咁：`23:05:04Z` 🩸 卡武裝冷卻 → `23:35` 解封，",
      "而 `23:59:59.859Z` 嗰張卡嘅 `crossed` 係 `+50%/+100%/+200%` 三關。",
    ),
    replacement: lines(
      "「最高里程碑」。ALCHEMY 就係咁：`23:05:04Z` 🩸 卡武裝冷卻 → `23:35` 解封，",
      "而 `23:59:59.859Z` 嗰張卡嘅 `crossed` 係 `+50%/+100%/+200%` 三關。",
      "",
      "**但呢兩個洞唔一定係同一個，唔好混為一談。** ALCHEMY 嗰張卡自己報 `5m +116%`，",
      "即係五分鐘前價已經 ≈ +54%（早就跨過 +50% 關）；如果 23:35–23:59 之間任何一次檢查",
      "睇到嗰個價，舊碼會吞（§1），但條 row 好可能**根本冇被評估過**（§2）—— 兩件事都真，",
      "要分開講：呢個 patch 只收得死 §1。",
    ),
  },
];

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;

/**
 * The ladder has to MOVE, so it needs a slice op rather than an anchor pair:
 * cut everything from LADDER_FROM up to (not including) LADDER_TO, dedent it by
 * two spaces, and re-insert it just above the gate with an explanation.
 */
{
  const file = "src/pushwatch.ts";
  const text = bufferOf(file);
  if (text.includes(MOVE_MARKER)) {
    console.log(`already   ${file}: the rising ladder is out of the cooldown gate`);
  } else {
    const occurrences = (hay, needle) => hay.split(needle).length - 1;
    const from = text.indexOf(LADDER_FROM);
    const to = text.indexOf(LADDER_TO);
    const gate = text.indexOf(`\n${GATE}\n`);
    // The gate must come BEFORE the ladder (that is the whole move) and the
    // ladder's two anchors must be in file order.
    if (from < 0 || to < 0 || gate < 0 || to < from || gate > from) {
      console.error(`MISS      ${file}: cannot locate the ladder block / the gate`);
      failed = true;
    } else if (
      occurrences(text, LADDER_FROM) !== 1 ||
      occurrences(text, LADDER_TO) !== 1 ||
      occurrences(text, GATE) !== 1
    ) {
      console.error(`AMBIGUOUS ${file}: ladder block or gate is not unique`);
      failed = true;
    } else {
      const block = text.slice(from, to);
      const dedented = block
        .split("\n")
        .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
        .join("\n");
      const gateAt = text.indexOf(`\n${GATE}\n`) + 1;
      const withoutBlock = text.slice(0, from) + text.slice(to);
      const moved =
        withoutBlock.slice(0, gateAt) +
        `${MOVE_COMMENT}${dedented}` +
        withoutBlock.slice(gateAt);
      buffers.set(file, moved);
      console.log(`ok        ${file}: the rising ladder is out of the cooldown gate`);
    }
  }
}

for (const patch of PATCHES) {
  const text = bufferOf(patch.file);
  // `marker` = "the text this entry leaves behind is already in the file" — the
  // only proof used here, so it must be a string that the FILE really contains
  // once the entry is done (never `undefined`: every file has the word
  // `undefined` in it somewhere, which silently reads as "already applied").
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

{
  const file = "docs/push-baseline-ledger.md";
  const text = bufferOf(file);
  if (text.includes(DOC_HEADING)) {
    console.log(`already   ${file}: the pacing hole is documented`);
  } else {
    buffers.set(file, `${text.trimEnd()}\n${DOC}\n`);
    console.log(`ok        ${file}: the pacing hole is documented`);
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
