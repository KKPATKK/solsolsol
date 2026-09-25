#!/usr/bin/env node
/**
 * 「重置基準」之後，下一張 🚀 卡點解寫『推送時 $325.23K』？應該係 $97.12K 喎。
 *
 * WHAT HAPPENED (2026-09-25, GETF `7T3XGNziCNwgiETftmQPW1Qj47KfVQyvZj7YQjrgE4K7`)
 *   02:57 HKT  `🟢 死而復生 GETF | 從低點 $64.75K 反彈越過 $97.12K（×1.5），重置基準繼續追蹤`
 *   03:38 HKT  `🚀 續漲 GETF | 推送時 $325.23K → $622.35K (+91%) … 下一關 +100%`
 *
 *   張 🟢 卡冇講佢把基準設成幾多。`mcap_at_push` 有三個 writer
 *   (docs/push-baseline-ledger.md)，而復活嗰個寫入嘅係**復活嗰一刻嘅 live mcap**
 *   (`resetBaselineMcap: live.mcap`)，唔係佢啱啱越過嗰個 ×1.5 關口。呢兩者喺
 *   「💀 靜默一段長時間」嘅情形下可以差幾倍：追蹤器下一次睇到 GETF 時價已經係
 *   $325.23K，所以新基準 = $325.23K，而卡只印咗門檻 $97.12K。
 *
 *   即係：$97.12K 係**觸發門檻**，$325.23K 係**復活時實際觀察值**。用門檻做基準
 *   等於替一段冇人睇過嘅行情（$97K → $325K）補發 +541% —— 同 parafactual 嗰個
 *   問題同一類，所以基準維持觀察值，改嘅係**卡片要講清楚**。
 *
 * THE FIX
 *   - 🟢 卡寫明新基準：`…（×1.5），以現價 $325.23K 為新基準繼續追蹤`。
 *   - row 記低嗰個值：`upStages = "base:325230"`（之前係清成 `""`）。
 *   - 🚀 / ⚡ 卡引用基準時，係嗰個 mark 就寫 `復活基準`，唔係就照舊 `推送時`。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const DOC_HEADING = "## 第十二補：復活基準要講出嚟";

const DOC = lines(
  "",
  "---",
  "",
  DOC_HEADING,
  "",
  "Operator 報告（2026-09-25）：02:57 HKT 收到",
  "`🟢 死而復生 GETF | 從低點 $64.75K 反彈越過 $97.12K（×1.5），重置基準繼續追蹤`，",
  "03:38 收到 `🚀 續漲 GETF | 推送時 $325.23K → $622.35K (+91%) … 下一關 +100%`，",
  "問：既然「重置基準」，點解下一張卡寫「推送時 $325.23K」而唔係 $97.12K？",
  "",
  "**答案：張 🟢 卡冇講佢實際把基準設成幾多。** 上表 writer #3 寫入嘅係**復活嗰一刻嘅 live mcap**",
  "（`resetBaselineMcap: live.mcap`），唔係嗰個 ×1.5 關口。追蹤器由 💀 靜默到下一次睇到 GETF 時，",
  "價已經係 $325.23K，所以新基準 = $325.23K，而卡只印咗「越過 $97.12K」。",
  "",
  "即係 $97.12K 係**觸發門檻**、$325.23K 係**復活時實際觀察值**。用門檻做基準會變成替一段",
  "冇人睇過嘅行情（$97K → $325K）補發 +541%，同 parafactual（第十一補）同一類問題，",
  "所以基準維持觀察值 —— 要改嘅係卡片講清楚。",
  "",
  "**修正**（`docs/patches/revive-baseline-named.apply.js`）：",
  "",
  "| 位置 | 之前 | 之後 |",
  "|---|---|---|",
  "| 🟢 卡 | `…（×1.5），重置基準繼續追蹤` | `…（×1.5），以現價 $325.23K 為新基準繼續追蹤` |",
  "| row mark | `up_stages = \"\"` | `up_stages = \"base:325230\"`（復活設過嘅基準值） |",
  "| 🚀 / ⚡ 卡 | `推送時 $X` | 基準係嗰個 mark → `復活基準 $X`；唔係 → 照舊 `推送時 $X` |",
  "",
  "`base:` mark 唔會被 `RISING_STAGES` 當 stage（`newlyCrossedStages` 只認 `up*`）、",
  "唔會被 `addCutMarks` 清走（佢只剝自己嘅 `p:` mark）、`terminalRowIssues` 亦完全唔讀 mark。",
  "比對係**值**而唔係淨係「有冇 mark」：若果之後有另一個 writer 移動過基準（self-heal 由帳本",
  "re-seed 返真推送值），標籤會自動跌返 `推送時` —— 咁樣先至啱。",
);

const PATCHES = [
  // ── src/pushwatch.ts ─────────────────────────────────────────────────────
  {
    file: "src/pushwatch.ts",
    what: "the revival-baseline mark, as pure helpers",
    marker: "export function baseMarkFor(",
    anchor: lines(
      "  const parts: string[] = [];",
      '  if (crossed.length > 1) parts.push(`一次檢查內跨越 +${crossed.join("%/+")}%`);',
      '  parts.push(nextStage !== null ? `下一關 +${nextStage}%` : "已達最高里程碑");',
      '  return ` | ${parts.join(" | ")}`;',
      "}",
    ),
    replacement: lines(
      "  const parts: string[] = [];",
      '  if (crossed.length > 1) parts.push(`一次檢查內跨越 +${crossed.join("%/+")}%`);',
      '  parts.push(nextStage !== null ? `下一關 +${nextStage}%` : "已達最高里程碑");',
      '  return ` | ${parts.join(" | ")}`;',
      "}",
      "",
      "/**",
      " * Persistent mark: the baseline a 🟢 REVIVAL moved the row to (`base:<mcap>`).",
      " *",
      " * The revival resets `mcap_at_push` to the mcap it OBSERVED at that moment —",
      " * the third of that column's three writers, and the only one that is not the",
      " * push-time value (docs/push-baseline-ledger.md). A card that quotes the",
      " * column as 推送時 is therefore lying about every revived row's base, which",
      " * is exactly how GETF came to be quoted at \"推送時 $325.23K\" hours after its",
      " * own 🟢 card had named the ×1.5 floor ($97.12K) as the thing being reset.",
      " * The value goes where the stage marks live, because the revival already owns",
      " * this column (it clears every stage mark: the ladder restarts from the new",
      " * base). `base:` is invisible to every STAGE reader — newlyCrossedStages",
      " * accepts only `up*` — is kept by addCutMarks (which strips only its own",
      " * `p:` marks), and terminalRowIssues reads no marks at all.",
      " */",
      'export const BASE_MARK_PREFIX = "base:";',
      "",
      "/** The mark a revival leaves: the baseline it set, to the dollar. */",
      "export function baseMarkFor(mcap: number): string {",
      "  return `${BASE_MARK_PREFIX}${Math.round(mcap)}`;",
      "}",
      "",
      "/**",
      " * Whether `baseline` is the value a REVIVAL set — i.e. whether a card quoting",
      " * the row's base may still call it 推送時. It may not: that base is the mcap",
      " * observed at the revival, not the mcap the coin was pushed at.",
      " *",
      " * The VALUE is compared, not merely the mark's presence: another writer can",
      " * move the baseline afterwards (the self-heal re-seeds a row from the ledger's",
      " * push-time value), and then 推送時 is the correct label again. A mark left",
      " * over from an earlier push of the same token, whose value no longer matches",
      " * the current base, reads the same way — the fail-quiet direction, where a",
      " * wrong 推送時 needs the two values to collide exactly.",
      " */",
      "export function revivedBaseline(",
      "  marks: Iterable<string>,",
      "  baseline: number,",
      "): boolean {",
      "  const want = String(Math.round(baseline));",
      "  for (const m of marks) {",
      "    if (",
      "      m.startsWith(BASE_MARK_PREFIX) &&",
      "      m.slice(BASE_MARK_PREFIX.length) === want",
      "    ) {",
      "      return true;",
      "    }",
      "  }",
      "  return false;",
      "}",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the 🟢 card names the baseline it sets",
    marker: "以現價 ${fmtUsd(live.mcap)} 為新基準",
    anchor: lines(
      "      fire(",
      '        "rising",',
      "        `🟢 死而復生 ${symbol} | 從低點 ${fmtUsd(row.deadTroughMcap ?? live.mcap)} 反彈越過 ${fmtUsd(target)}（×${RESURRECTION_MULT}），重置基準繼續追蹤`,",
      '        "revive",',
      "      );",
    ),
    replacement: lines(
      "      // Name the base, not just the floor that was crossed: the two are the",
      "      // same number only when the tracker happened to look while the coin sat",
      "      // between them. The reset below writes `live.mcap` (see BASE_MARK_PREFIX),",
      "      // so THAT is the number every later card measures +% from.",
      "      fire(",
      '        "rising",',
      "        `🟢 死而復生 ${symbol} | 從低點 ${fmtUsd(row.deadTroughMcap ?? live.mcap)} 反彈越過 ${fmtUsd(target)}（×${RESURRECTION_MULT}），以現價 ${fmtUsd(live.mcap)} 為新基準繼續追蹤`,",
      '        "revive",',
      "      );",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "and the row remembers where the baseline went",
    marker: "announcedUpStages: baseMarkFor(live.mcap),",
    anchor: lines(
      "        resetBaselineMcap: live.mcap,",
      "        deadTroughMcap: null,",
      "        sellDomStreak: 0,",
      '        announcedUpStages: "",',
    ),
    replacement: lines(
      "        resetBaselineMcap: live.mcap,",
      "        deadTroughMcap: null,",
      "        sellDomStreak: 0,",
      "        // The cleared column is what the stage marks are cleared THROUGH (the",
      "        // ladder restarts from the new base), so the value rides the same",
      "        // write instead of costing a column of its own. See BASE_MARK_PREFIX.",
      "        announcedUpStages: baseMarkFor(live.mcap),",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the cards label the base they quote",
    marker: "const baseLabel = revivedBaseline(firedStages, row.mcapAtPush)",
    anchor: lines(
      "    const firedStages = marks;",
      '    if (lastState?.startsWith("up")) firedStages.add(lastState);',
      '    const preFireStages = [...firedStages].sort().join(",");',
    ),
    replacement: lines(
      "    const firedStages = marks;",
      '    if (lastState?.startsWith("up")) firedStages.add(lastState);',
      '    const preFireStages = [...firedStages].sort().join(",");',
      "    // `mcap_at_push` is the base every % on the cards below is measured from,",
      "    // and it has THREE writers (docs/push-baseline-ledger.md): the scanner's",
      "    // gate value and the self-heal's re-seed from the ledger — both the",
      "    // push-time mcap — plus the revival reset, which is NOT (it is the mcap",
      "    // observed at the revival). Calling all three 推送時 is how a revived row",
      "    // came to be quoted at \"推送時 $325.23K\" hours after its own 🟢 card had",
      "    // named the ×1.5 floor ($97.12K) as the thing being reset — live",
      "    // 2026-09-25, GETF. The revival leaves a `base:` mark, so the label can",
      "    // say which base this is.",
      "    const baseLabel = revivedBaseline(firedStages, row.mcapAtPush)",
      '      ? "復活基準"',
      '      : "推送時";',
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the 🚀 card uses it",
    marker: "`🚀 續漲 ${symbol} | ${baseLabel}",
    anchor: lines(
      "          `🚀 續漲 ${symbol} | 推送時 ${fmtUsd(row.mcapAtPush)} → ${fmtUsd(live.mcap)} (${pct(chgSincePush)}) | 峰值回撤 ${pct(drawdownFromPeak)} | 5m ${pct(live.chg5m)} | 買賣比 ${bs}(h1)` +",
    ),
    replacement: lines(
      "          `🚀 續漲 ${symbol} | ${baseLabel} ${fmtUsd(row.mcapAtPush)} → ${fmtUsd(live.mcap)} (${pct(chgSincePush)}) | 峰值回撤 ${pct(drawdownFromPeak)} | 5m ${pct(live.chg5m)} | 買賣比 ${bs}(h1)` +",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "and so does the ⚡ card",
    marker: "`⚡ 籌碼集中 ${symbol} | 價 ${pct(chgSincePush)}（${baseLabel}",
    anchor: lines(
      "          `⚡ 籌碼集中 ${symbol} | 價 ${pct(chgSincePush)}（推送時 ${fmtUsd(row.mcapAtPush)} → ${fmtUsd(live.mcap)}）| 持倉 ${row.holdersAtPush.toLocaleString()} → ${row.holdersLast.toLocaleString()} (${pct((holderRatio - 1) * 100)})— 價漲人跌：漲幅由越來越少的錢包推動，回撤會又快又深`,",
    ),
    replacement: lines(
      "          `⚡ 籌碼集中 ${symbol} | 價 ${pct(chgSincePush)}（${baseLabel} ${fmtUsd(row.mcapAtPush)} → ${fmtUsd(live.mcap)}）| 持倉 ${row.holdersAtPush.toLocaleString()} → ${row.holdersLast.toLocaleString()} (${pct((holderRatio - 1) * 100)})— 價漲人跌：漲幅由越來越少的錢包推動，回撤會又快又深`,",
    ),
  },
  // ── src/worker.ts ────────────────────────────────────────────────────────
  {
    file: "src/worker.ts",
    what: "the 補發 card can tell the two baselines apart too",
    marker: "  revivedBaseline,\n  terminalRowIssues,",
    anchor: lines(
      "  pushWatchHealStats,",
      "  terminalRowIssues,",
      "  terminalRowRepair,",
      '} from "./pushwatch";',
    ),
    replacement: lines(
      "  pushWatchHealStats,",
      "  revivedBaseline,",
      "  terminalRowIssues,",
      "  terminalRowRepair,",
      '} from "./pushwatch";',
    ),
  },
  {
    file: "src/worker.ts",
    what: "and says so on a revived row",
    marker: "const baseLabel = revivedBaseline(String(row.upStages ?? \"\").split(\",\"), row.mcapAtPush)",
    anchor: lines(
      "      const peakPct =",
      "        row.mcapAtPush > 0 ? (row.peakMcap / row.mcapAtPush - 1) * 100 : null;",
    ),
    replacement: lines(
      "      const peakPct =",
      "        row.mcapAtPush > 0 ? (row.peakMcap / row.mcapAtPush - 1) * 100 : null;",
      "      // This card quotes `mcap_at_push` as 推送時. That column has three",
      "      // writers (docs/push-baseline-ledger.md) and a revival is NOT the",
      "      // push-time value, so a re-delivered card for a revived row must not",
      "      // claim it is (see revivedBaseline).",
      '      const baseLabel = revivedBaseline(String(row.upStages ?? "").split(","), row.mcapAtPush)',
      '        ? "復活基準"',
      '        : "推送時";',
    ),
  },
  {
    file: "src/worker.ts",
    what: "the 💰 line uses it",
    marker: "`💰 市值 ${usd(pair.marketCap)}（${baseLabel}",
    anchor: lines(
      '        `💰 市值 ${usd(pair.marketCap)}（推送時 ${usd(row.mcapAtPush)}${chg === null ? "" : "，" + pctStr(chg)}）\\n` +',
    ),
    replacement: lines(
      '        `💰 市值 ${usd(pair.marketCap)}（${baseLabel} ${usd(row.mcapAtPush)}${chg === null ? "" : "，" + pctStr(chg)}）\\n` +',
    ),
  },
  // ── scripts/test-unit.js ─────────────────────────────────────────────────
  {
    file: "scripts/test-unit.js",
    what: "the new helpers are imported",
    marker: "baseMarkFor, revivedBaseline } = require",
    anchor: lines(
      'const { evaluateWatch, recapVerdict, recapMessage, PushWatcher, comparableLiquidity, liquidityIsComparable, terminalRowIssues, terminalRowRepair, TRACKER_ROW_SPAN_HOLD_MS, TRACKER_PAIR_HEAD, risingCardTail, newlyCrossedStages } = require("../dist/pushwatch.js");',
    ),
    replacement: lines(
      'const { evaluateWatch, recapVerdict, recapMessage, PushWatcher, comparableLiquidity, liquidityIsComparable, terminalRowIssues, terminalRowRepair, TRACKER_ROW_SPAN_HOLD_MS, TRACKER_PAIR_HEAD, risingCardTail, newlyCrossedStages, baseMarkFor, revivedBaseline } = require("../dist/pushwatch.js");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the revival names its baseline and the next card reads it back",
    marker: "以現價 \\$46\\.00K 為新基準",
    anchor: lines(
      "    assert.equal(r.resetBaselineMcap, 46_000);",
      "    assert.equal(r.peakMcap, 46_000);",
      '    assert.equal(r.lastState, null);',
      "    assert.equal(r.deadTroughMcap, null);",
    ),
    replacement: lines(
      "    assert.equal(r.resetBaselineMcap, 46_000);",
      "    assert.equal(r.peakMcap, 46_000);",
      '    assert.equal(r.lastState, null);',
      "    assert.equal(r.deadTroughMcap, null);",
      "",
      "    // The 🟢 card now NAMES the baseline it sets. Without the number the",
      "    // reader has only the ×1.5 floor it crossed ($45.00K here; $97.12K live)",
      "    // and every later card's base looks invented — live 2026-09-25, GETF:",
      "    // revived past $97.12K, next quoted as 推送時 $325.23K, which was the mcap",
      "    // the tracker OBSERVED at the revival, not the level it had crossed.",
      "    assert.match(r.alerts[0].text, /以現價 \\$46\\.00K 為新基準/);",
      '    assert.equal(r.announcedUpStages, baseMarkFor(46_000), "the baseline move is remembered");',
      '    assert.ok(revivedBaseline(String(r.announcedUpStages).split(","), 46_000));',
      '    assert.ok(!revivedBaseline(String(r.announcedUpStages).split(","), 50_000), "and only for the value it actually set");',
      "",
      "    // ... which is what lets the NEXT 🚀 card be honest about its base. The",
      "    // same row, baseline moved to 46K, now read at 100K:",
      "    const afterRevive = evaluateWatch(",
      '      row({ lastState: null, deadTroughMcap: null, mcapAtPush: 46_000, peakMcap: 46_000, lastAlertAt: 1_000, upStages: r.announcedUpStages }),',
      "      2_000,",
      "      { mcap: 100_000, liquidity: 25_000, chg5m: 15, vol5m: 40_000, buysH1: 200, sellsH1: 40 },",
      "      cfg,",
      "    );",
      "    assert.match(afterRevive.alerts[0].text, /復活基準 \\$46\\.00K → \\$100\\.00K/);",
      "    // A row whose baseline was never moved still reads exactly as before.",
      "    const unmoved = evaluateWatch(",
      '      row({ lastState: null, deadTroughMcap: null, mcapAtPush: 50_000, peakMcap: 50_000, lastAlertAt: 1_000 }),',
      "      2_000,",
      "      { mcap: 100_000, liquidity: 25_000, chg5m: 15, vol5m: 40_000, buysH1: 200, sellsH1: 40 },",
      "      cfg,",
      "    );",
      '    assert.match(unmoved.alerts[0].text, /推送時 \\$50\\.00K → \\$100\\.00K/, "an unmoved baseline still reads 推送時");',
    ),
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
  // `marker` = "the text this entry leaves behind is already in the file".
  // `absent` = the mirror image, for an entry whose whole job is to DELETE:
  // already applied when the thing it removes is gone.
  const applied = patch.absent
    ? !text.includes(patch.absent)
    : text.includes(patch.marker);
  if (applied) {
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
  const tableRow = "| 3 | `pushwatch.ts` 死而復生重置 | 復活嗰一刻嘅 live mcap | ❌ |";
  const tableRowNew =
    "| 3 | `pushwatch.ts` 死而復生重置 | 復活嗰一刻嘅 live mcap（🟢 卡而家會寫明，見第十二補） | ❌ |";
  if (text.includes(tableRow)) {
    buffers.set(file, bufferOf(file).replace(tableRow, tableRowNew));
    console.log(`ok        ${file}: writer #3's row points at the card`);
  } else {
    console.log(`already   ${file}: writer #3's row points at the card`);
  }
  const docText = buffers.get(file);
  if (docText.includes(DOC_HEADING)) {
    console.log(`already   ${file}: the revival baseline is documented`);
  } else {
    buffers.set(file, `${docText.trimEnd()}\n${DOC}\n`);
    console.log(`ok        ${file}: the revival baseline is documented`);
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
