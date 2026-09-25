#!/usr/bin/env node
/**
 * 路徑 B 嘅另一半：`docs/patches/tracker-pass-pulse.apply.js` 嘅測試同文件。
 *
 * WHAT THIS COVERS
 *   1. `PushWatcher.trackerPassPulse()` —— 一個跑完嘅 pass 會**自己埋單**（doneAt、
 *      stage、checked／alerted／claimLost、note），而讀者拿到嘅係一份 copy。
 *   2. 一個**死喺中途**嘅 pass 會留低一個開住嘅 pulse：`doneAt: null` ＋ 死嗰個
 *      stage。呢個就係 live 2026-09-25 02:56–03:0xZ 嗰 60s+ 冇任何嘢講得出嘅讀數
 *      （durable row 永遠係 `running`，因為 note 就係被拒嗰個寫入）。
 *   3. worker 嗰半（out-of-window：worker.ts 唔入得測試嘅 import graph）——
 *      import、catch 記 `trackerPassFailure`、成功清返、heartbeat 帶兩個 reading。
 *   4. `docs/round-trips.md` §4.10：成因、為何冇證據、修正同埋限制。
 *
 * Semantics同其他 apply script 一樣（`marker` = 已應用嘅證據，`absent` 唔用，anchor
 * 必須唯一，refuse to leave the tree half-patched，重新跑一次要 0 file(s) written）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  // ------------------------------------------------------- docs/round-trips --
  {
    file: "docs/round-trips.md",
    what: "§4.10: the pass's own reading, when the note's write is the one refused",
    marker: "### 4.10 被拒嘅 note",
    anchor: "scan 側先留配額（scanner 現時完全唔讀 `subreqRemaining`）。",
    replacement: lines(
      "scan 側先留配額（scanner 現時完全唔讀 `subreqRemaining`）。",
      "",
      "### 4.10 被拒嘅 note：pass 自己嘅讀數要留在記憶體（2026-09-25）",
      "",
      '**Live（02:56–03:0xZ，第二次同類事件）**：`pushWatchPass {phase:"running", note:"running",',
      "trackerMs:0}` 卡住 60s+（下一個 tick 又開一個新 pass，所以個 record 永遠停在 running），",
      "row 新鮮度 `fresh 0/31 → 1/30`（輪替真係停咗，唔係慢）。但個 tick 本身健康：",
      "`tickProgress {stage postscan, ms 2530, subreqs 10}`、心跳 `done`、`dex http429 0`、",
      "`subreqs current 10–16`；drain 亦冇新失敗（`writeDrainErrorAgeMin 172`）⇒ 唔係 §4.9 嘅",
      "subrequest 撞頂，又唔係 feed —— 最可能係 Turso 3,000ms hard wall 落喺 pass 自己嘅 stage。",
      "",
      "**點解完全冇證據**：pass 開頭寫 `running`、**最後一步**才寫最終 note，所以被殺 = 永遠",
      "`running`；而 pass 內部每個 DB stage 都已經係「失敗就算」（listing、recap claim、",
      "silent batch），失敗只會變成 `claimLost` 一個數字，而嗰個數字只喺最後嗰個 note 度出現",
      "—— 即係喺**寫唔入**嗰個寫入度。",
      "",
      "**修正**（`docs/patches/tracker-pass-pulse.apply.js`）：`trackerPassPulse()`",
      "（pushwatch.ts，module memory，**零 DB 寫入**）記住最後一個 pass 嘅",
      "`{at, doneAt, stage, checked, alerted, claimLost, note}`，喺三個時點更新：pass 開頭、",
      "row loop 之後、pass 結尾。worker 每個 tick 嘅 heartbeat summary 加",
      "`pushWatchLive`（讀數）同 `pushWatchFail`（worker 自己 catch 到嘅 throw，連 message 同",
      "當時嘅讀數）⇒ 一條 `/health` 就答得到「pass 有冇行完（`doneAt`）、停喺邊個 stage、",
      "checked／claimLost 幾多」，即使 DB 嗰刻寫唔入任何嘢。",
      "",
      "**留心兩點**：pulse 喺**下一個** tick 才上 heartbeat（summary 係 pass 之前砌），即係最多",
      "遲一個 tick；而 row loop 嘅計數係 loop **返嚟**才發佈，所以喺 loop 中途被殺嘅 pass 只會報",
      "`stage: rows / doneAt: null / checked: 0` —— 輪替行到幾遠，睇 durable row 嘅 `fresh` 就夠。",
    ),
  },
  // ------------------------------------------------------ scripts/test-unit --
  {
    file: "scripts/test-unit.js",
    what: "the suite imports the pulse it is about to read",
    marker: "revivedBaseline, trackerPassPulse }",
    anchor: 'revivedBaseline } = require("../dist/pushwatch.js");',
    replacement: 'revivedBaseline, trackerPassPulse } = require("../dist/pushwatch.js");',
  },
  {
    file: "scripts/test-unit.js",
    what: "the pulse is read in memory, and a pass that dies leaves it open",
    marker: "the pass publishes its own pulse, without a trip to the note row",
    anchor: '  await test("PushWatcher: passDiag is silent before any pass has run", () => {',
    replacement: lines(
      '  await test("PushWatcher: the pass publishes its own pulse, without a trip to the note row", async () => {',
      "    // WHY (live 2026-09-25 02:56Z): /health's durable pass row read `phase:",
      "    // running` for 60s+ while the rotation stalled (`fresh 0/31 -> 1/30`) and the",
      "    // tick itself was healthy — `postscan 2530ms`, 10 subrequests, no 429s, no new",
      "    // drain error. The row is written at the pass's START and overwritten only at",
      "    // its very END, and every failure INSIDE the pass is already swallowed (the",
      "    // listing, the recap claim and the silent-row batch all fail soft), so during a",
      "    // database episode the one record that could have said what happened is the",
      "    // write that just failed. The pulse is that reading: module memory, no round",
      "    // trip, published on every heartbeat.",
      '    const db = termDb([termRow({ token: "PULSE", symbol: "PULSE" })]);',
      '    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      '    assert.equal(trackerPassPulse(), null, "nothing to read before this isolate has run a pass");',
      "    const out = await pw.runTick(Date.now() + 5_000);",
      "    const live = trackerPassPulse();",
      '    assert.equal(typeof live.at, "number", "the pass is stamped with the clock it ran on");',
      '    assert.equal(typeof live.doneAt, "number", "doneAt is the field that separates a pass which RETURNED from a killed one");',
      '    assert.ok(live.doneAt >= live.at, "and it cannot precede the pass");',
      '    assert.match(live.stage, /^(entry|setup|settle|heal|rows|holders)$/, "the stage is one the pass really names");',
      '    assert.equal(live.note, out.note, "the pulse carries the same note the durable row was handed");',
      '    assert.equal(live.checked, out.checked, "and the counters the note reads back");',
      "    assert.equal(live.alerted, out.alerted);",
      '    assert.equal(live.claimLost, 0, "a healthy claim batch loses nothing");',
      "    // A copy, not the module's own object: the reader is the worker's heartbeat,",
      "    // and no reader may be able to write the next pass's state.",
      "    live.checked = 999;",
      '    assert.equal(trackerPassPulse().checked, out.checked, "reader mutations never reach the pulse");',
      "  });",
      "",
      '  await test("PushWatcher: a pass that DIES leaves its pulse open, naming the stage it died in", async () => {',
      "    // The killed-pass shape: `doneAt` null (it never returned) with the stage it",
      "    // died in — the two readings the durable row cannot give, because the row's",
      "    // `running` stamp is written before the pass does any work and the note is the",
      "    // write the database just refused. The worker's own catch adds the message",
      "    // (pushWatchFail); this half is the pass's account of itself.",
      "    const db = termDb([termRow()]);",
      "    db.claimPushWatch = async () => {",
      '      throw new Error("Too many subrequests by single Worker invocation");',
      "    };",
      '    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      "    await assert.rejects(() => pw.runTick(Date.now() + 5_000), /Too many subrequests/);",
      "    const live = trackerPassPulse();",
      '    assert.equal(live.doneAt, null, "no doneAt: the pass was killed, it did not finish");',
      '    assert.equal(live.stage, "rows", "the stage it died in is the last one the pass named");',
      '    assert.equal(live.note, null, "and the note never landed — which is exactly why the pulse exists");',
      "    // The row counters are published when the LOOP RETURNS, so a death inside the",
      "    // loop honestly reports zero: how far the rotation got is the durable row's own",
      "    // `fresh` count, not this.",
      "    assert.equal(live.checked, 0);",
      "  });",
      "",
      '  await test("PushWatcher: passDiag is silent before any pass has run", () => {',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the worker's half of the pulse is wired end to end",
    marker: "the tracker's pulse survives a refused note write",
    anchor:
      '  await test("out-of-window patch: a thrown pass describes itself (docs/patches/tracker-pass-err-diag.apply.js)", () => {',
    replacement: lines(
      '  await test("out-of-window patch: the tracker\'s pulse survives a refused note write (docs/patches/tracker-pass-pulse.apply.js)", async () => {',
      "    const strip = (text) =>",
      "      text",
      '        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")',
      '        .replace(/\\/\\/[^\\n]*/g, "")',
      '        .replace(/\\s+/g, "");',
      '    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));',
      '    const pushwatchSrc = read("src/pushwatch.ts");',
      '    const workerSrc = read("src/worker.ts");',
      "    const applied = {",
      '      "pushwatch (the pulse exists)": pushwatchSrc.includes("exportfunctiontrackerPassPulse():TrackerPassPulse|null{"),',
      '      "pushwatch (a pass opens its own pulse)": pushwatchSrc.split("beginPassPulse(now);").length - 1 === 1,',
      '      "pushwatch (the row loop reports what it managed)": pushwatchSrc.includes(\'notePassPulse({stage:"rows",checked,alerted,claimLost});spent.rows.ms=Date.now()-rowsStart;\'),',
      '      "pushwatch (and the pass closes it with its note)": pushwatchSrc.includes(\'notePassPulse({doneAt:Date.now(),stage:this.passStage??"done",\'),',
      '      "worker (the pulse is importable)": workerSrc.includes("terminalRowIssues,trackerPassPulse,"),',
      '      "worker (the failure carries the pulse\'s last reading)": workerSrc.includes("live:trackerPassPulse(),"),',
      '      "worker (a returned pass clears the last failure)": workerSrc.includes("trackerPassFailure=null;"),',
      '      "worker (the heartbeat carries both)": workerSrc.includes(',
      '        "view.pushWatchLive=trackerPassPulse();view.pushWatchFail=trackerPassFailure;",',
      "      ),",
      "    };",
      "    const done = Object.entries(applied).filter(([, v]) => v);",
      "    if (done.length === 0) {",
      "      console.log(",
      '        "  ℹ tracker pass pulse missing - apply docs/patches/tracker-pass-pulse.apply.js",',
      "      );",
      "      return;",
      "    }",
      "    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);",
      "    // A half-wired pulse reads as a healthy pass: the heartbeat would publish a",
      "    // reading nobody updates, and the failure record a message with no stage.",
      "    assert.equal(",
      "      missing.length,",
      "      0,",
      '      `partial paste of docs/patches/tracker-pass-pulse.apply.js — missing: ${missing.join(", ")}`,',
      "    );",
      "  });",
      "",
      '  await test("out-of-window patch: a thrown pass describes itself (docs/patches/tracker-pass-err-diag.apply.js)", () => {',
    ),
  },
  // ------------------------------------------- the first run's two blind spots --
  {
    file: "docs/round-trips.md",
    what: "§4.10: the stage is live, not a three-point snapshot",
    marker: "三個時點更新，而 `stage`",
    anchor: lines(
      "`{at, doneAt, stage, checked, alerted, claimLost, note}`，喺三個時點更新：pass 開頭、",
      "row loop 之後、pass 結尾。worker 每個 tick 嘅 heartbeat summary 加",
    ),
    replacement: lines(
      "`{at, doneAt, stage, checked, alerted, claimLost, note}`：pass 開頭、row loop 之後、pass",
      "結尾三個時點更新，而 `stage` 跟住 pass 自己嘅標籤**每個** stage 都更新（所以死喺邊個",
      "stage 一定報得到）。worker 每個 tick 嘅 heartbeat summary 加",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the pulse is compared with the PREVIOUS pass, not with null",
    marker: "whatever was there came from an earlier pass",
    anchor:
      '    assert.equal(trackerPassPulse(), null, "nothing to read before this isolate has run a pass");',
    replacement: lines(
      "    // The suite has run passes before this one, so the pulse is compared with",
      "    // the PREVIOUS pass rather than with null: what matters is that this pass",
      "    // opened its own, not that the module started empty (module state is",
      "    // isolate state, and this file is one isolate).",
      "    const before = trackerPassPulse();",
      '    assert.ok(before === null || typeof before.at === "number", "whatever was there came from an earlier pass");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "and the pass is shown to have replaced it",
    marker: "the pass opens its own pulse instead of amending the last one",
    anchor: lines(
      "    const out = await pw.runTick(Date.now() + 5_000);",
      "    const live = trackerPassPulse();",
    ),
    replacement: lines(
      "    const out = await pw.runTick(Date.now() + 5_000);",
      "    const live = trackerPassPulse();",
      '    assert.ok(before === null || live.at >= before.at, "the pass opens its own pulse instead of amending the last one");',
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
