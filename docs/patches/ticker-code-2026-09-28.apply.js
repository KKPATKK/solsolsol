#!/usr/bin/env node
/**
 * Ticker as a copyable code span (2026-09-28) — installer / verifier.
 *
 * WHAT THIS DOES, and why it replaces the button version:
 *   - the operator refused the per-card copy BUTTON (2026-09-28): one more row
 *     of buttons under every follow-up card is not worth a tap;
 *   - a Telegram message BODY has no tap target, so the copyable thing is the
 *     ticker as an HTML `code` entity — one long-press selects it whole;
 *   - therefore: the copy-button helpers and their three wires are REMOVED, and
 *     `withCopyableTicker` + HTML parse mode are wired on the same three sends.
 *
 * Idempotent: re-running prints "=" for everything already in place and exits 0.
 * Self-verifying: every edit checks its anchors first and the file after, and a
 * missing/ambiguous anchor prints "✗" and exits 1 WITHOUT touching the file.
 *
 * Usage: node docs/patches/ticker-code-2026-09-28.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const pushPath = path.join(root, "src", "pushwatch.ts");
const testPath = path.join(root, "scripts", "test-unit.js");

let failed = 0;
const report = (mark, name, detail) => {
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
  if (mark === "✗") failed += 1;
};

// ---------------------------------------------------------------------------
// The new helper block, replacing the copy-button helpers.
// ---------------------------------------------------------------------------
const NEW_HELPERS = [
  "/**",
  " * The coin's ticker inside a card body, as a `<code>` span.",
  " *",
  " * WHY code AND NOT A BUTTON: a Telegram message body is INERT text — there is",
  " * no tap target inside it — so the only way to make the ticker copyable is to",
  " * change what it IS. A `code` entity renders as a monospace chip that ONE",
  " * long-press selects whole (and copies) instead of dragging a selection across",
  " * the line around it, which is the trade the operator chose (2026-09-28). The",
  " * single-tap alternative is an inline-keyboard button carrying the Bot API's",
  " * copy-text payload; it was removed on purpose, because it cost a row of",
  " * buttons under EVERY follow-up card.",
  " *",
  " * WHERE the span goes: the FIRST occurrence of the ticker, which by",
  " * construction is the card's header (`🚀 續漲 REGULARS | …`, `🏁 結案報告",
  " * REGULARS | …`) — every builder names `symbol` there and nowhere else, so this",
  " * needs no per-card knowledge. A body that does NOT carry the ticker (a",
  " * rewrite, or a row with no symbol) is returned untouched rather than",
  " * mis-marked: degrading to no chip is the quiet failure, and pasting the wrong",
  " * text is the loud one.",
  " *",
  " * HTML mode is what carries a body entity at all, so every caller sends in it —",
  " * and that mode reads `&`, `<` and `>` as MARKUP. The whole body is therefore",
  " * escaped here, not just the span: the builders write plain text, and the 💧",
  " * drain card's `（< $9.00K，連續 2 次檢查）` proves a bare `<` reaches a live",
  " * card. Unescaped it is either swallowed as a broken tag or rejected outright",
  " * (cannot parse entities), and a rejected body costs the FOLLOW-UP, not just",
  " * the formatting. Escaping on the one path every card body takes is what keeps",
  " * that from depending on each future edit to a builder.",
  " */",
  "export function withCopyableTicker(",
  "  text: string,",
  "  symbol: string | null | undefined,",
  "): string {",
  "  const escaped = escapeHtml(text);",
  "  const ticker = escapeHtml((symbol ?? \"\").trim());",
  "  if (ticker.length === 0) return escaped;",
  "  const at = escaped.indexOf(ticker);",
  "  if (at < 0) return escaped;",
  "  return `${escaped.slice(0, at)}<code>${ticker}</code>${escaped.slice(at + ticker.length)}`;",
  "}",
  "",
  "/** The three characters Telegram's HTML mode treats as markup. */",
  "function escapeHtml(text: string): string {",
  "  return text",
  "    .replace(/&/g, \"&amp;\")",
  "    .replace(/</g, \"&lt;\")",
  "    .replace(/>/g, \"&gt;\");",
  "}",
].join("\n");

// ---------------------------------------------------------------------------
// The three send-site rewires (old -> new), exact source text.
// ---------------------------------------------------------------------------
const SEND_EDITS = [
  {
    name: "alert send (generic follow-up card)",
    old: [
      "            const inFlight = this.bot.api.sendMessage(row.chatId, a.text, {",
      "              reply_markup: copySymbolKeyboard(row.symbol, row.token),",
      "            });",
    ].join("\n"),
    neu: [
      "            const inFlight = this.bot.api.sendMessage(",
      "              row.chatId,",
      "              withCopyableTicker(a.text, row.symbol),",
      "              { parse_mode: \"HTML\" },",
      "            );",
    ].join("\n"),
    marker: "withCopyableTicker(a.text, row.symbol)",
  },
  {
    name: "terminal 💧 send (keeps its resume row)",
    old: [
      "    const inFlight = this.bot.api.sendMessage(row.chatId, text, {",
      "      reply_markup: {",
      "        // The name row sits ABOVE the one that undoes the card (see",
      "        // symbolCopyRow): every follow-up offers the coin's name, and this is",
      "        // the only card that also needs its 🔁 恢復追蹤 action.",
      "        inline_keyboard: [",
      "          symbolCopyRow(row.symbol, row.token),",
      "          ...resumeTrackingKeyboard(row.token).inline_keyboard,",
      "        ],",
      "      },",
      "    });",
    ].join("\n"),
    neu: [
      "    const inFlight = this.bot.api.sendMessage(",
      "      row.chatId,",
      "      withCopyableTicker(text, row.symbol),",
      "      {",
      "        // HTML is what carries the <code> span around the ticker (see",
      "        // withCopyableTicker) — every follow-up send asks for it.",
      "        parse_mode: \"HTML\",",
      "        // The keyboard rides the terminal card only (see",
      "        // resumeTrackingKeyboard): every other follow-up card re-derives",
      "        // itself on the next pass, so the user has nothing to undo.",
      "        reply_markup: resumeTrackingKeyboard(row.token),",
      "      },",
      "    );",
    ].join("\n"),
    marker: "withCopyableTicker(text, row.symbol)",
  },
  {
    name: "terminal 💧 send (comment tidy)",
    old: [
      "      {",
      "        // HTML is what carries the <code> span around the ticker (see",
      "        // withCopyableTicker) — every follow-up send asks for it.",
      '        parse_mode: "HTML",',
      "        // The keyboard rides the terminal card only (see",
      "        // resumeTrackingKeyboard): every other follow-up card re-derives",
      "        // itself on the next pass, so the user has nothing to undo.",
      "        reply_markup: resumeTrackingKeyboard(row.token),",
      "      },",
    ].join("\n"),
    neu: [
      "      {",
      "        // HTML is what carries the <code> span around the ticker (see",
      "        // withCopyableTicker) — every follow-up send asks for it, and this",
      "        // card's 🔁 恢復追蹤 row is untouched by it.",
      '        parse_mode: "HTML",',
      "        reply_markup: resumeTrackingKeyboard(row.token),",
      "      },",
    ].join("\n"),
    marker: "card's 🔁 恢復追蹤 row is untouched by it.",
  },
  {
    name: "bot api shape (parse_mode)",
    old: [
      "      sendMessage(",
      "        chatId: string,",
      "        text: string,",
      "        opts?: { reply_markup?: unknown },",
      "      ): Promise<unknown>;",
    ].join("\n"),
    neu: [
      "      sendMessage(",
      "        chatId: string,",
      "        text: string,",
      "        /**",
      "         * `parse_mode` joined this shape when the follow-up cards started",
      "         * sending HTML (see withCopyableTicker): the card body carries a",
      "         * <code> span around the ticker, and Telegram only reads an entity",
      "         * when the body is declared as HTML.",
      "         */",
      "        opts?: {",
      "          reply_markup?: unknown;",
      '          parse_mode?: "HTML" | "MarkdownV2" | "Markdown";',
      "        },",
      "      ): Promise<unknown>;",
    ].join("\n"),
    marker: 'parse_mode?: "HTML" | "MarkdownV2" | "Markdown";',
  },
  {
    name: "🏁 recap send",
    old: [
      "          const recapCard: Promise<unknown> = this.bot.api.sendMessage(",
      "            expiring[i].chatId,",
      "            recapMessage(expiring[i]),",
      "            {",
      "              reply_markup: copySymbolKeyboard(",
      "                expiring[i].symbol,",
      "                expiring[i].token,",
      "              ),",
      "            },",
      "          );",
    ].join("\n"),
    neu: [
      "          const recapCard: Promise<unknown> = this.bot.api.sendMessage(",
      "            expiring[i].chatId,",
      "            // The ticker the card PRINTS is the one to mark, so the fallback",
      "            // here mirrors recapMessage's own header (symbol, else the mint",
      "            // prefix) instead of guessing with a name the card never wrote.",
      "            withCopyableTicker(",
      "              recapMessage(expiring[i]),",
      "              expiring[i].symbol ?? expiring[i].token.slice(0, 6),",
      "            ),",
      "            { parse_mode: \"HTML\" },",
      "          );",
    ].join("\n"),
    marker: "recapMessage(expiring[i]),",
  },
];

// ---------------------------------------------------------------------------
// Test-file edits.
// ---------------------------------------------------------------------------
const REQUIRE_EDIT = {
  name: "test require line",
  old:
    'const { DRAIN_CONFIRM_MARK, resumeTrackingKeyboard, symbolCopyRow, copySymbolKeyboard, COPY_BUTTON_LABEL_MAX, COPY_TEXT_MAX } = require("../dist/pushwatch.js");',
  neu:
    'const { DRAIN_CONFIRM_MARK, resumeTrackingKeyboard, withCopyableTicker } = require("../dist/pushwatch.js");',
};

const TEST_SECTION_START =
  "  // ---------- follow-up cards: tap the name to copy it (src/pushwatch.ts) ----------";
const TEST_SECTION_END =
  '  await test("terminal-row hygiene patch: rules, db method and endpoint land together", () => {';

const NEW_TESTS = [
  "  // ---------- follow-up cards: the ticker is a <code> span you can copy ----------",
  "  //",
  "  // Every follow-up card is read for ONE name — \"🚀 續漲 REGULARS | …\" — and the",
  "  // operator's next move is to paste that ticker into a search box. A message",
  "  // BODY has no tap target, so the affordance is the ENTITY: the ticker goes out",
  "  // as an HTML `code` span, which one long-press selects whole. (The single-tap",
  "  // alternative is an inline-keyboard copy-text button, and it was removed on",
  "  // purpose — 2026-09-28 — because it cost a row of buttons under every card.)",
  '  await test("follow-up cards: the ticker goes out as a code span, and the body is escaped", () => {',
  "    // The header is where every builder names the coin, and it is the FIRST",
  "    // occurrence — so the span lands there and nowhere else.",
  "    assert.equal(",
  '      withCopyableTicker("🚀 續漲 REGULARS | 推送時 $10.00K → $30.00K (+200%)", "REGULARS"),',
  '      "🚀 續漲 <code>REGULARS</code> | 推送時 $10.00K → $30.00K (+200%)",',
  "    );",
  "    // Only the FIRST: a later mention in the body is not turned into a second",
  "    // chip (a card that quoted its own ticker would otherwise get two).",
  "    assert.equal(",
  '      withCopyableTicker("🚀 續漲 X | 峰值回撤 12% — X 仍在", "X"),',
  '      "🚀 續漲 <code>X</code> | 峰值回撤 12% — X 仍在",',
  "    );",
  "    // HTML mode reads &, < and > as markup, and a real card writes `（< $9.00K…`:",
  "    // an unescaped `<` there is a 400 that costs the whole follow-up, not just",
  "    // the formatting. So the WHOLE body is escaped, the span included.",
  "    assert.equal(",
  '      withCopyableTicker("💧 流動性枯竭 Lobby | LP 僅剩 $7.95K（< $9.00K）& 停止追蹤", "Lobby"),',
  '      "💧 流動性枯竭 <code>Lobby</code> | LP 僅剩 $7.95K（&lt; $9.00K）&amp; 停止追蹤",',
  "    );",
  "    // A ticker carrying markup characters is escaped INSIDE the span: the",
  "    // search-and-insert runs on the escaped text, so it can neither double",
  "    // escape nor paste a half-written tag.",
  "    assert.equal(",
  '      withCopyableTicker("🚀 續漲 A<B&C | x", "A<B&C"),',
  '      "🚀 續漲 <code>A&lt;B&amp;C</code> | x",',
  "    );",
  "    // No symbol, a blank one, or a ticker the body does not contain: the body",
  "    // comes back escape-only. No chip is the quiet failure; a mis-placed span",
  "    // would paste the wrong text.",
  '    assert.equal(withCopyableTicker("🏁 結案報告 | 判定：橫盤", null), "🏁 結案報告 | 判定：橫盤");',
  '    assert.equal(withCopyableTicker("🏁 結案報告 | 判定：橫盤", "   "), "🏁 結案報告 | 判定：橫盤");',
  '    assert.equal(withCopyableTicker("🚀 續漲 REGULARS | x", "OTHER"), "🚀 續漲 REGULARS | x");',
  "    // ...and a body with no ticker at all is still escaped, because the",
  "    // escaping is the send's, not the chip's.",
  '    assert.equal(withCopyableTicker("a < b & c", null), "a &lt; b &amp; c");',
  "  });",
  "",
  '  await test("follow-up cards: all three card sends ask for HTML and mark the ticker (source pin)", () => {',
  '    const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");',
  '    const src = read("src/pushwatch.ts");',
  "    // Whitespace-stripped, so what is pinned is the CALL, not the wrapping.",
  "    const flat = src.replace(/\\s+/g, \"\");",
  "    const wanted = {",
  '      "alert card": "withCopyableTicker(a.text,row.symbol)",',
  '      "terminal card (keeps its resume row)": "withCopyableTicker(text,row.symbol)",',
  '      "recap card":',
  '        "withCopyableTicker(recapMessage(expiring[i]),expiring[i].symbol??expiring[i].token.slice(0,6),)",',
  "    };",
  "    const missing = Object.entries(wanted)",
  "      .filter(([, v]) => !flat.includes(v))",
  "      .map(([k]) => k);",
  '    assert.equal(missing.length, 0, `ticker not marked on: ${missing.join(", ")}`);',
  "    // Each of them must ALSO switch that send into HTML mode, or the span",
  "    // prints as literal tags: three sends, three parse modes.",
  "    assert.equal(",
  '      flat.split(\'parse_mode:"HTML"\').length - 1,',
  "      3,",
  '      "every follow-up send asks for HTML mode",',
  "    );",
  "    // The terminal card keeps the ONE keyboard it had before any of this.",
  '    assert.ok(flat.includes("reply_markup:resumeTrackingKeyboard(row.token),"));',
  "    // ...and the per-card copy BUTTON is gone for good: it is what the operator",
  "    // rejected, so its reappearance is a regression rather than a refactor.",
  '    assert.ok(!flat.includes("copy_text"), "the per-card copy button is gone");',
  "  });",
].join("\n");

// ---------------------------------------------------------------------------
// Apply.
// ---------------------------------------------------------------------------
function editSendSites(src) {
  let out = src;
  for (const edit of SEND_EDITS) {
    if (out.includes(edit.marker)) {
      report("=", edit.name, "already applied");
      continue;
    }
    if (!out.includes(edit.old)) {
      report("✗", edit.name, "anchor missing — file not touched");
      return null;
    }
    if (out.split(edit.old).length - 1 !== 1) {
      report("✗", edit.name, "anchor is ambiguous — file not touched");
      return null;
    }
    out = out.replace(edit.old, edit.neu);
    report("✓", edit.name, "rewired to the code span");
  }
  return out;
}

function editHelpers(src) {
  if (src.includes("export function withCopyableTicker(")) {
    report("=", "copyable-ticker helpers", "already applied");
    return src;
  }
  const startMarker =
    '/**\n * The "tap the name, get the name" row every follow-up card carries.';
  const start = src.indexOf(startMarker);
  if (start < 0) {
    report("✗", "copyable-ticker helpers", "old helper block not found");
    return null;
  }
  const fnStart = src.indexOf("export function copySymbolKeyboard(", start);
  if (fnStart < 0) {
    report("✗", "copyable-ticker helpers", "copySymbolKeyboard not found");
    return null;
  }
  const close = src.indexOf("\n}\n", fnStart);
  if (close < 0) {
    report("✗", "copyable-ticker helpers", "block end not found");
    return null;
  }
  const out = src.slice(0, start) + NEW_HELPERS + "\n" + src.slice(close + 3);
  report("✓", "copyable-ticker helpers", "helpers replaced");
  return out;
}

function editTests(src) {
  let out = src;
  if (out.includes(REQUIRE_EDIT.neu)) {
    report("=", REQUIRE_EDIT.name, "already applied");
  } else if (out.includes(REQUIRE_EDIT.old)) {
    out = out.replace(REQUIRE_EDIT.old, REQUIRE_EDIT.neu);
    report("✓", REQUIRE_EDIT.name, "now imports withCopyableTicker");
  } else {
    report("✗", REQUIRE_EDIT.name, "anchor missing — file not touched");
    return null;
  }

  if (out.includes("withCopyableTicker(") && !out.includes(TEST_SECTION_START)) {
    report("=", "card-ticker tests", "already applied");
    return out;
  }
  const start = out.indexOf(TEST_SECTION_START);
  const end = out.indexOf(TEST_SECTION_END);
  if (start < 0 || end < 0 || end < start) {
    report("✗", "card-ticker tests", "section markers not found — file not touched");
    return null;
  }
  out = out.slice(0, start) + NEW_TESTS + "\n\n" + out.slice(end);
  report("✓", "card-ticker tests", "button tests replaced by code-span tests");
  return out;
}

let pushSrc = fs.readFileSync(pushPath, "utf8");
let testSrc = fs.readFileSync(testPath, "utf8");

const pushOut = editHelpers(pushSrc);
pushSrc = pushOut === null ? pushSrc : pushOut;
const pushOut2 = pushOut === null ? null : editSendSites(pushSrc);
if (pushOut2 !== null) pushSrc = pushOut2;
const testOut = editTests(testSrc);
if (testOut !== null) testSrc = testOut;

// Post-conditions, checked on the text that would be written.
const checks = [
  ["helpers present", pushSrc.includes("export function withCopyableTicker(")],
  ["button helpers gone", !pushSrc.includes("copySymbolRow") && !pushSrc.includes("copySymbolKeyboard")],
  ["no copy-button payload left", !pushSrc.replace(/\s+/g, "").includes("copy_text")],
  ["three HTML sends", pushSrc.split('parse_mode: "HTML"').length - 1 === 3],
  ["tests import the helper", testSrc.includes("withCopyableTicker")],
  ["old button tests gone", !testSrc.includes("symbolCopyRow")],
];
for (const [name, ok] of checks) report(ok ? "✓" : "✗", name);

const ok =
  failed === 0 &&
  pushOut !== null &&
  pushOut2 !== null &&
  testOut !== null &&
  checks.every(([, v]) => v);
if (!ok) {
  console.log("\nNOTHING WRITTEN — fix the anchors above and re-run.");
  process.exit(1);
}

fs.writeFileSync(pushPath, pushSrc);
fs.writeFileSync(testPath, testSrc);
console.log("\nWritten: src/pushwatch.ts, scripts/test-unit.js");
