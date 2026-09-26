#!/usr/bin/env node
/*
 * Round 6, the test/docs half:
 *   - two PushWatcher tests for the maintenance-yield gate (thin slice defers
 *     the heal, not the rotation; a healthy slice still heals);
 *   - `scripts/test-dex-last-profiles.js` wired into test:unit;
 *   - docs/round-trips.md §4.33 (what the two live readings were, what changed,
 *     and what the fix does NOT do).
 *
 * Verify-then-write, same discipline as round6-budget: an anchor that is not
 * found exactly once leaves that file unwritten.
 *
 * Run: node docs/patches/round6-tests-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const j = (...lines) => lines.join("\n");

let failures = 0;

function patch(file, edits) {
  const p = path.join(root, file);
  const src = fs.readFileSync(p, "utf8");
  let out = src;
  let touched = 0;
  let fileFailed = 0;
  for (const e of edits) {
    const count = out.split(e.old).length - 1;
    if (count === 0 && e.marker !== undefined && out.includes(e.marker)) {
      console.log(`= ${file}: ${e.name} (already applied)`);
      continue;
    }
    if (count !== 1) {
      console.error(
        `✗ ${file}: ${e.name} — anchor found ${count} times (need exactly 1)`,
      );
      failures += 1;
      fileFailed += 1;
      continue;
    }
    out = out.replace(e.old, e.new);
    touched += 1;
    console.log(`✓ ${file}: ${e.name}`);
  }
  if (fileFailed > 0) {
    console.error(`✗ ${file}: NOT written (${fileFailed} anchor(s) failed)`);
    return;
  }
  if (touched > 0) {
    fs.writeFileSync(p, out);
    console.log(`→ ${file} written`);
  }
}

patch("scripts/test-unit.js", [
  {
    name: "maintenance-yield tests",
    old: j(
      '    assert.equal(reads.listings, 1, "the setup ran — so this is the between-stage gate, not the door");',
      '    assert.equal(out.checked, 0, "and the row loop was never entered");',
      "  });",
    ),
    marker: "defers the HEAL, not the rotation",
    new: j(
      '    assert.equal(reads.listings, 1, "the setup ran — so this is the between-stage gate, not the door");',
      '    assert.equal(out.checked, 0, "and the row loop was never entered");',
      "  });",
      "",
      "  // The maintenance stages yield to the ROTATION (2026-09-26, live): the pass",
      "  // runs LAST on the shared 50-subrequest allowance, and the live readings",
      "  // (`rows 8/30 … subreq-cut 22 defer-send 22`, the oldest row 126 minutes)",
      "  // showed the heal and the repair taking their trips before the row loop had",
      "  // any. A refused alert is re-derived next tick but its row ages in HOURS,",
      "  // while the heal is a backstop the same listing re-offers on the next pass:",
      "  // so below the maintenance floor the heal stands down — and says so.",
      '  await test("PushWatcher: a thin slice defers the HEAL, not the rotation", async () => {',
      "    const db = termDb([termRow()]);",
      "    let healReads = 0;",
      "    db.findUntrackedPushesAndLedger = async () => {",
      "      healReads += 1;",
      "      return { missing: [], ledgerRaw: null };",
      "    };",
      '    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      "    // 8 left: above the tail reserve (6), so the rotation can still pay for a",
      "    // card — below the maintenance floor (10), so the heal must not spend it.",
      "    const out = await pw.runTick(Date.now() + 5_000, undefined, () => 8);",
      '    assert.equal(healReads, 0, "the heal never read — the rotation\'s slice stayed intact");',
      '    assert.match(String(out.note), /heal-yield/, "and the note names WHY it stood down");',
      '    assert.equal(out.checked, 1, "the rotation still ran");',
      '    assert.equal(out.alerted, 1, "and the card the pass exists for went out");',
      "  });",
      "",
      '  await test("PushWatcher: a healthy slice still heals", async () => {',
      "    const db = termDb([termRow()]);",
      "    let healReads = 0;",
      "    db.findUntrackedPushesAndLedger = async () => {",
      "      healReads += 1;",
      "      return { missing: [], ledgerRaw: null };",
      "    };",
      '    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      "    const out = await pw.runTick(Date.now() + 5_000, undefined, () => 50);",
      '    assert.equal(healReads, 1, "a slice with room runs the heal exactly once");',
      '    assert.doesNotMatch(String(out.note), /heal-yield/, "and the note does not claim a yield");',
      "  });",
    ),
  },
]);

patch("package.json", [
  {
    name: "wire test-dex-last-profiles into test:unit",
    old: ' && node scripts/test-usd-formatter.js",',
    marker: "test-dex-last-profiles.js",
    new: ' && node scripts/test-usd-formatter.js && node scripts/test-dex-last-profiles.js",',
  },
]);

patch("docs/round-trips.md", [
  {
    name: "§4.33 record",
    old: j(
      "落線紀錄：`src/format.ts`（formatter cache）、`scripts/cpu-profile.js`（`eval:` 量測腿）、`scripts/test-usd-formatter.js`。",
      "",
    ),
    marker: "§4.33 兩個 live 讀數",
    new: j(
      "落線紀錄：`src/format.ts`（formatter cache）、`scripts/cpu-profile.js`（`eval:` 量測腿）、`scripts/test-usd-formatter.js`。",
      "",
      "### §4.33 兩個 live 讀數嘅修法：profiles 429 嘅 43% tick ＋ 追蹤 pass 嘅 22 卡積壓（2026-09-26）",
      "",
      "**① `profiles: 2` 唔係「feed 靜」，係被 429 拒。** 2026-09-26T21:40Z 嘅 scan ring：近 120 條有 **52 條（43%）讀 `profiles: 2`**，",
      "而嗰 52 條嘅時間戳同 `dex429` ring **一對一**（例：429 @21:38:01 → tick @21:38:03 `profiles=2`）。2 就係 make-up lane 嘅大細",
      "（`deferPending 2`），即係嗰啲 tick 嘅 DexScreener profiles 拉取被拒，只剩 make-up 幣。",
      "client **本身已經有**呢個修法（失敗 fetch 用 `lastGoodProfiles`，窗 10 分鐘，見 `PROFILE_FEED_REUSE_MS`），",
      "但嗰個 list 係 instance state，而 isolate 每個 tick 換 ⇒ 只有罕有嘅暖 tick 受惠。",
      "",
      "**修法：將條 lane 由 isolate 記憶搬去 durable row（零新 round trip）。** 個 list 騎上 tick 本身已經出嘅 front read",
      "（`readScanFront` 嗰句 `IN (...)` 加一個 key，見 `DEX_PROFILES_LAST_KEY`）seed 入 client；成功 fetch 之後，",
      "騎同一個 front write（`writeScanFront`，同 `dex_list_cache_*` 同一個 batch）用 **REPLACE** 寫返。stamp 係 fetch 嘅 `at`，",
      "所以**被 reuse 嘅 list 唔會再寫自己**（scanner 以 stamp 比對）。窗口、`settled`、make-up 語意**一律不變** ——",
      "只係「邊個 isolate 記得個 list」變咗。",
      "",
      "**② `rows 8/30 … subreq-cut 22 defer-send 22`：22 張卡被拒，行齡 126 分鐘。** 代碼只會喺真係有卡（`alerts.length > 0`）時行到嗰個閘，",
      "所以 22 = 有 22 行帶卡；被拒嘅行**原封不動、留在隊頭**（設計：下 tick 重新推導），但每個 tick 都唔夠額度 ⇒ 佢哋永遠輪唔到。",
      "行齡分佈完全對得上：**11 行 >60 分鐘、最大 126 分鐘**（16:30 嗰次檢查最大 13.7 分鐘）。兩個原因、兩個修法：",
      "",
      "| 原因 | 修法 |",
      "|---|---|",
      "| scan 為 pass 留嘅 slice = **9**（entry 3 ＋ tail 6）—— 夠開門同收尾，**唔夠出卡**（一張卡 = claim＋reserve＋send＋final write = 4） | `TRACKER_PASS_SUBREQ_RESERVE` **9 → 13**（新常數 `TRACKER_ALERT_PATH_SUBREQ = 4` 做算術）。scan 嘅 optional legs／chain 早 4 個 subrequest 讓路 |",
      "| pass 自己嘅**維護階段（heal／baseline repair）先花咗 trips**，先輪到 rotation | 新 `TRACKER_MAINTENANCE_SUBREQ_FLOOR = RESERVE(6) ＋ ALERT_PATH(4)`：額度低過佢，heal（連 proof read／補發）同 repair 直接讓路，note 出 **`heal-yield`**（唔再靜靜雞） |",
      "",
      "**要老實講嘅：** 呢兩刀係將「永遠 0 張」變返「每 tick 1–2 張」（22 張約 10–20 分鐘清完、行齡上限由無界變 ~10–20 分鐘），",
      "**唔係**即刻清空：一張卡要 4 個 subrequest，而 38 個可用額度要養成個 scan。下一條槓桿係 **claim＋reserve 合併**",
      "（同一 batch 兩句、reserve 加 `last_checked = now` 守衛；4 → 3／卡，即 +33% 吞吐），要獨立一輪做＋過 duplicate-card 審查。",
      "",
      "**驗證：** 新 `scripts/test-dex-last-profiles.js`（8 條，已入 `npm run test:unit`）＋ `scripts/test-unit.js` 新增 2 條",
      "（薄額度時 heal 讓路、rotation 照出卡；健康額度時 heal 照跑）。守衛驗過會咬：突變 `dist` 令 `seedLastGoodProfiles` 變 no-op ⇒ 2 條 fail。",
      "",
      "落線紀錄：`src/dexscreener.ts`（`ProfileFeedSnapshot`／`parseProfileFeedSnapshot`／seed＋snapshot API）、`src/db.ts`（`DEX_PROFILES_LAST_KEY` 入 `SCAN_FRONT_GATE_KEYS`）、",
      "`src/scanner.ts`（front read seed ＋ front write journal）、`src/worker.ts`（slice 9 → 13）、`src/pushwatch.ts`（維護讓路）、`scripts/test-dex-last-profiles.js`（新）、`scripts/test-unit.js`。",
      "",
    ),
  },
]);

if (failures > 0) {
  console.error(`\n${failures} edit(s) failed — see the lines above.`);
  process.exit(1);
}
console.log("\nround 6 tests/docs applied.");
