#!/usr/bin/env node
/**
 * Tracker head-row subrequest gate (2026-09-26): the push-watch pass may no
 * longer START an alerting row's multi-trip chain with only the tail's reserve
 * in hand.
 *
 * WHAT THE TICK READ, live and repeatedly:
 *
 *     pushWatch: "err:Too many subrequests by single Worker invocation … [rows subreq 0]"
 *     pushWatch: "err:Too many subrequests by single Worker invocation … [rows subreq 2]"
 *
 * — the pass dying in its `rows` stage with 0-2 subrequests left on the
 * counter, i.e. at the invocation's real 50 wall. The gates were not
 * mis-tuned: the row loop's SPEND gate (`subreqsLeft() <= TRACKER_SUBREQ_RESERVE`)
 * exempts the loop's FIRST row on purpose — a progress floor so a pass could
 * never refuse its own head (the 2026-09-17 shape it descends from) — and an
 * alerting head row costs claim + reservation + send + two writes. Started at
 * 0-6 left, that chain is refused halfway: the pass loses its note, its tail
 * writes and the rest of its rotation, and the card it was started for is not
 * delivered either. Refusing it instead is free (the row is left untouched, so
 * the next tick re-derives it) and NAMED (`subreq-cut N` / `defer-send N`).
 *
 * WHY THE FLOOR CAN GO: it belongs to MEASUREMENT, and measurement never
 * needed it. A quiet row continues into `silentChecks` BEFORE this gate and is
 * counted in `rows` whatever the counter says, so the head is still evaluated
 * and checked on every pass; only its SPEND is gated.
 *
 * Run: node docs/patches/tracker-head-subreq-gate-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const DOC_ANCHOR =
  "而 wiring guard 唔使再靠 scanner 嘅 flag 字串。三條尾段測試亦改為經 `hydrateDeferredTokens()` 建 registry —— 生產本來就係嗰條路。";
const DOC_NOTE = lines(
  "",
  "### §4.28 追蹤 pass 嘅 head row 唔再豁免 subrequest 閘（2026-09-26）",
  "",
  "live 讀數（`/debug/tick` 連續幾個 tick）：`pushWatch: err:Too many subrequests by single Worker invocation … [rows subreq 0]`、",
  "`[rows subreq 2]` —— pass 喺 `rows` stage 死，counter 嗰刻只剩 0–2（即係 invocation 真係到咗 50 嘅牆）。",
  "成因唔係閘唔夠，而係**第一行豁免**：`subreqShort` 之前係 `rowIndex > 0 && subreqsLeft() <= TRACKER_SUBREQ_RESERVE`（常數 6），",
  "即係 head row 就算得 0–2 剩都可以起一條「claim → 保留 → send → 兩個 write」嘅鏈，中途畀 runtime 拒 ⇒ **整個 pass 掉失**",
  "（佢自己嘅 note、tail writes、剩返嘅 rotation 一齊冇），而張卡最後都冇出。",
  "",
  "改法：閘套用到**每一行**（head 都唔例外），因為嗰個 floor 本來就屬於「量度」而唔係「花費」：",
  "安靜行根本行唔到呢個閘（佢喺 `silentChecks` 分支已經 `continue`），所以頭行照樣畀評估、`last_checked` 照樣入 batch ——",
  "舊註解講嘅「pass 唔可以連自己個 head 都拒」仍然成立，只係唔再包「花費」。alerting 行被拒係免費：row 完全冇動，",
  "下一 tick 由 rotation 最前再衍生一次（最多延遲一個 tick），而 `subreq-cut N` / `defer-send N` 會喺 note 點名 —— 唔會再靜靜死。",
  "",
  "落線紀錄：`docs/patches/tracker-head-subreq-gate-2026-09-26.apply.js`（src/pushwatch.ts ＋ scripts/test-unit.js）。",
  "測試改為兩面：6 剩 → 兩條 alerting 行都拒、一條 backfill 行照量度（`rows 1/3 subreq-cut 2 defer-send 2`）；7 剩 → 頭行照樣出卡。",
);

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "src/pushwatch.ts",
    "the row loop's SPEND gate covers every row, head included",
    lines(
      `    /**`,
      `     * The subrequest gate BETWEEN rows — the second half of the pair with`,
      `     * overBudget. It gates the row's SPEND, never the row itself: a silent`,
      `     * row rides the ONE batched claim the pass was already paying for, and`,
      `     * the loop's FIRST row is exempt outright, the same progress-floor rule`,
      `     * the clock keeps, because a pass that refuses its own head has measured`,
      `     * nothing at all (the 2026-09-17 shape). Only an ALERTING row — claim +`,
      `     * sends + write — consults it, and refusing one is free: the row is left`,
      `     * completely untouched, exactly as the send-slice gate leaves it, so the`,
      `     * next tick re-derives it against a fresh budget.`,
      `     */`,
      `    let rowIndex = 0;`,
      `    for (const row of head) {`,
      `      const subreqShort =`,
      `        rowIndex > 0 && subreqsLeft() <= TRACKER_SUBREQ_RESERVE;`,
      `      rowIndex += 1;`,
    ),
    lines(
      `    /**`,
      `     * The subrequest gate on every row's SPEND — the second half of the pair`,
      `     * with overBudget. It never gates the row itself: a silent row costs`,
      `     * nothing of its own and rides the ONE batched claim the pass was already`,
      `     * paying for. Only an ALERTING row — claim + state reservation + send +`,
      `     * writes — consults it, and refusing one is free: the row is left`,
      `     * completely untouched, exactly as the send-slice gate leaves it, so the`,
      `     * next tick re-derives it against a fresh budget.`,
      `     *`,
      `     * NO HEAD EXEMPTION (2026-09-26, live). The loop's first row used to be`,
      `     * exempt outright — a progress floor, so a pass could never refuse its own`,
      `     * head. What that floor actually bought was a DEATH: /debug/tick read`,
      `     * \`err:Too many subrequests by single Worker invocation … [rows subreq 0]\``,
      `     * and \`[rows subreq 2]\` pass after pass, i.e. an alerting head row was`,
      `     * started with at most the tail's reserve in hand, the runtime refused a`,
      `     * call in the middle of its chain, and the pass lost its note, its tail`,
      `     * writes and the rest of its rotation — while the card it was started for`,
      `     * was not delivered either. The floor belongs to MEASUREMENT, and`,
      `     * measurement never needed it: a quiet row continues into silentChecks`,
      `     * BEFORE this gate and is counted in \`rows\` whatever the counter says, so`,
      `     * the head is still evaluated (and checked, riding the pass's ONE batch)`,
      `     * with nothing in hand — while a refused ALERT is named (\`subreq-cut N\`,`,
      `     * \`defer-send N\`) and re-derived next tick from the front of the`,
      `     * rotation.`,
      `     */`,
      `    for (const row of head) {`,
      `      const subreqShort = subreqsLeft() <= TRACKER_SUBREQ_RESERVE;`,
    ),
    (src) => src.includes("const subreqShort = subreqsLeft() <= TRACKER_SUBREQ_RESERVE;"),
  ],
  [
    "scripts/test-unit.js",
    "the reserve test becomes the every-row contract, with the measurement floor proved",
    lines(
      `  await test("PushWatcher: the row loop keeps the tail's RESERVE, and still runs its first row", async () => {`,
      `    // Two alerting rows, six subrequests left: above TRACKER_SUBREQ_FLOOR (the`,
      `    // rotation can start) and at TRACKER_SUBREQ_RESERVE (nothing may be spent`,
      `    // past it, because the deferral sync and the write drain come next).`,
      `    const db = termDb([termRow(), termRow({ token: "SECOND", symbol: "SECOND" })]);`,
      `    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);`,
      `    const out = await pw.runTick(Date.now() + 5_000, undefined, () => 6);`,
      `    assert.equal(out.checked, 1, "the FIRST row runs regardless — the 2026-09-17 progress floor, on this ceiling too");`,
      `    assert.equal(out.alerted, 1, "and its card still goes out");`,
      `    assert.equal(db.updated.length, 1, "only that row was written");`,
      `    assert.match(String(out.note), /subreq-cut 1/, "the refused row is named in the note");`,
      `    assert.match(String(out.note), /defer-send 1/, "and counted as a card this pass could not deliver");`,
      `    // The loop's own prefix, not \`rows 0/\` anywhere: stageNote()'s \`spend[...]\``,
      `    // carries the row stage's OWN ms/trips as \`rows 0/1\`, so a loose match`,
      `    // would read the stage and not the rotation.`,
      `    assert.match(String(out.note), /^rows 1\\/2 /, "the loop measured its head and refused the rest — never the silent 2026-09-17 \`rows 0/\` shape");`,
      `  });`,
    ),
    lines(
      `  await test("PushWatcher: the row loop keeps the tail's RESERVE on EVERY row — and measurement never needs it", async () => {`,
      `    // Two ALERTING rows and one backfill row, six subrequests left: above`,
      `    // TRACKER_SUBREQ_FLOOR (the rotation may start) and at`,
      `    // TRACKER_SUBREQ_RESERVE (nothing may be SPENT past it — the deferral sync`,
      `    // and the write drain come next).`,
      `    //`,
      `    // The head used to be EXEMPT from this gate — a progress floor. Live`,
      `    // 2026-09-26 that floor was the bug: /debug/tick read`,
      `    // \`err:Too many subrequests … [rows subreq 0]\` pass after pass, because an`,
      `    // alerting head row's chain (claim + reservation + send + two writes) was`,
      `    // started with 0-6 left and refused halfway, taking the pass's tail and the`,
      `    // rest of its rotation with it — and the card never went out anyway.`,
      `    // Measurement is what the floor was for, and measurement still happens: the`,
      `    // backfill row rides the pass's ONE batched claim whatever the counter says.`,
      `    const db = termDb([`,
      `      termRow(),`,
      `      termRow({ token: "SECOND", symbol: "SECOND" }),`,
      `      // No send of its own (a stale-observation backfill), so this row proves`,
      `      // the floor survived the gate change.`,
      `      termRow({`,
      `        token: "QUIET",`,
      `        symbol: "QUIET",`,
      `        pushedAt: Date.now() - 3 * 3_600_000,`,
      `        lastMcap: null,`,
      `        upStages: null,`,
      `      }),`,
      `    ]);`,
      `    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);`,
      `    const out = await pw.runTick(Date.now() + 5_000, undefined, () => 6);`,
      `    assert.equal(out.alerted, 0, "nothing is sent with only the tail's reserve in hand");`,
      `    assert.equal(out.checked, 1, "the backfill row is still measured — the floor the head exemption claimed to keep");`,
      `    assert.equal(db.updated.length, 1, "and only that row was written");`,
      `    assert.match(String(out.note), /subreq-cut 2/, "both refused alerts are named");`,
      `    assert.match(String(out.note), /defer-send 2/, "…and counted as cards this pass could not deliver");`,
      `    // \`rows 1/3\`: one measured of three due. The loop's own prefix, because`,
      `    // stageNote()'s \`spend[rows …]\` carries the stage's OWN ms/trips.`,
      `    assert.match(String(out.note), /^rows 1\\/3 /, "measured, not silently skipped");`,
      `    // ONE subrequest above the reserve: the head's spend is allowed again, so`,
      `    // the gate is a reserve and not a freeze.`,
      `    const db2 = termDb([termRow()]);`,
      `    const pw2 = termWatcher(db2, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);`,
      `    const out2 = await pw2.runTick(Date.now() + 5_000, undefined, () => 7);`,
      `    assert.equal(out2.alerted, 1, "one above the reserve: the head row still gets its card");`,
      `    assert.doesNotMatch(String(out2.note), /subreq-cut/, "and nothing is refused");`,
      `  });`,
    ),
    (src) => src.includes("the row loop keeps the tail's RESERVE on EVERY row"),
  ],
  [
    "scripts/test-unit.js",
    "the thrown-pass test keeps its point: a throw needs a spend the gates CLEARED",
    // The same reading the fix exists for, one test earlier: this case drove the
    // row loop's throw with THREE left, which is exactly the shape the gate now
    // refuses (the live `[rows subreq 3]`-sized attempts that started a chain on
    // the wall's doorstep). The throw therefore has to be provoked with room to
    // spend, and the near-wall reading becomes its own assertion: refused, named,
    // no dead pass.
    lines(
      `    // (b) It dies later, in the row loop.`,
      `    const late = boom("rows");`,
      `    const pwLate = termWatcher(late, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);`,
      `    await assert.rejects(`,
      `      () => pwLate.runTick(Date.now() + 5_000, undefined, () => 3),`,
      `      /Too many subrequests/`,
      `    );`,
      `    assert.equal(pwLate.passDiag(), "rows subreq 3", "the stage tracks the pass, and the number is read at the throw");`,
    ),
    lines(
      `    // (b) It dies later, in the row loop — on a spend the gates CLEARED.`,
      `    // The probe is deliberately ABOVE the tail's reserve: at or below it the`,
      `    // loop now REFUSES an alerting row (see (b')), so a throw can only come`,
      `    // from a chain the gates allowed to start.`,
      `    const late = boom("rows");`,
      `    const pwLate = termWatcher(late, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);`,
      `    await assert.rejects(`,
      `      () => pwLate.runTick(Date.now() + 5_000, undefined, () => 7),`,
      `      /Too many subrequests/`,
      `    );`,
      `    assert.equal(pwLate.passDiag(), "rows subreq 7", "the stage tracks the pass, and the number is read at the throw");`,
      ``,
      `    // (b') The shape the live readings actually produced (2026-09-26:`,
      `    // \`[rows subreq 0]\` / \`[rows subreq 2]\`): three left, an alerting head`,
      `    // row, and a database that WOULD throw on its claim. The reserve refuses`,
      `    // the spend instead — a named defer, never a dead pass.`,
      `    const nearWall = boom("rows");`,
      `    const pwNear = termWatcher(nearWall, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);`,
      `    const nearOut = await pwNear.runTick(Date.now() + 5_000, undefined, () => 3);`,
      `    assert.match(String(nearOut.note), /subreq-cut 1/, "the head's spend is refused BY NAME — the wall shape, defused");`,
      `    assert.equal(nearOut.alerted, 0, "and no card is attempted with the chain's room unaffordable");`,
    ),
    (src) => src.includes("the wall shape, defused"),
  ],
  [
    "scripts/test-unit.js",
    "the wiring guard pins the removed exemption, not the old shape",
    lines(
      `      "pushwatch (the row loop keeps the tail reserve)":`,
      `        pushwatchSrc.includes("rowIndex>0&&subreqsLeft()<=TRACKER_SUBREQ_RESERVE;") &&`,
      `        pushwatchSrc.includes("subreqCut+=1;"),`,
    ),
    lines(
      `      "pushwatch (the row loop keeps the tail reserve on EVERY row — no head exemption)":`,
      `        pushwatchSrc.includes(`,
      `          "constsubreqShort=subreqsLeft()<=TRACKER_SUBREQ_RESERVE;",`,
      `        ) &&`,
      `        !pushwatchSrc.includes("rowIndex") &&`,
      `        pushwatchSrc.includes("subreqCut+=1;"),`,
    ),
    (src) => src.includes("no head exemption)"),
  ],
  [
    "docs/round-trips.md",
    "§4.28 records the reading and the gate change",
    DOC_ANCHOR,
    DOC_ANCHOR + "\n" + DOC_NOTE,
    (src) => src.includes("### §4.28 追蹤 pass 嘅 head row 唔再豁免 subrequest 閘"),
  ],
];

const problems = [];
const out = new Map();
for (const [file, label, oldText, newText, already] of EDITS) {
  const src = out.has(file) ? out.get(file) : read(file);
  if (already(src)) {
    console.log(`skip ${file}: ${label} (already applied)`);
    continue;
  }
  const n = hits(src, oldText);
  if (n !== 1) {
    problems.push(`${file}: ${label} — anchor matched ${n} times (want exactly 1)`);
    continue;
  }
  out.set(file, src.replace(oldText, newText));
  console.log(`ok   ${file}: ${label}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
for (const [file, text] of out) {
  fs.writeFileSync(path.join(root, file), text);
  console.log(`wrote ${file} (${text.length} bytes)`);
}
console.log("\nall anchors applied.");
