#!/usr/bin/env node
/**
 * Two things the 14:54:56Z reading settled: reserve the spend the counter
 * cannot see, and stop needing a write to keep the note that explains it.
 *
 * PART 1 — the headroom (the measurement)
 *
 * The live occurrence, verbatim, with the diagnostic that 0b03f4b added:
 *
 *     err:Too many subrequests by single Worker invocation. To configure this
 *     limit, refer to https://… [rows subreq 12]
 *
 * `subreq 12` is the counter's opinion AT the throw, and the refused call is
 * inside its own count (countSubreq runs before the request is issued), so the
 * counter had seen 38 when the platform stopped at 50. Roughly twelve
 * subrequests were spent through a seam this wrapper does not cover. The gates
 * did not misfire: at 12 unspent, the row gate (≤6) and the stage gates (<3)
 * were correct to say there was room.
 *
 * Ruled out first, so this is a reserve and not a theory: not a transport that
 * bypasses fetch — the deployed bundle has no WebSocket at all (dist/worker.js)
 * and Turso goes through @libsql/client/web over https, so the db closure
 * resolves the wrapped global like everything else; not a stale reading (the
 * note was seconds old and the row beside it read `running`); not a mistuned
 * placement (the death is in `rows`, which the entry gate guards by design
 * against a different case).
 *
 * So the gap is real and its SHAPE is still unknown. Rather than guess at the
 * shape, reserve the size of it: `subreqRemaining` — the number the pass spends
 * against — now hands out the counted headroom MINUS twelve. That is the
 * conservative direction: a tick that spends only inside what the counter can
 * see cannot overrun what it cannot see, and the cost of being wrong is a pass
 * that defers a tick early and is retried, never a lost write.
 *
 * One constant, moved by measurement. Every occurrence now carries its own
 * number (the note above), so the next one re-sizes it without any new
 * instrumentation.
 *
 * PART 2 — the note that could not be kept
 *
 * The same reading arrived in `/debug/tick`'s summary while `/health`'s durable
 * `pushWatchPass` row still read `running`. That is not a bug in the write:
 * `persistPassNote` swallows its own failure by design, and at the moment the
 * runtime is at the wall, the write's own `fetch` is the call that gets
 * refused. So the best diagnostic the system produces was the one it could not
 * keep — and it was kept only on whichever isolate served the debug request.
 *
 * The fix costs nothing and is already in the design: the scanner's `pushWatchNote`
 * is the field the NEXT scan copies into its own summary, and the scan's
 * heartbeat write is one the tick makes anyway. Publishing there first means the
 * diagnostic becomes durable one tick later, from a write that was always going
 * to happen — instead of depending on a write that cannot happen at all.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  // ------------------------------------------------------------- subreqs.ts --
  {
    file: "src/subreqs.ts",
    what: "the measured reserve for the spend the counter cannot see",
    marker: "export const SUBREQ_UNSEEN_ALLOWANCE = 12;",
    anchor: lines("export const SUBREQ_BUDGET_FREE = 50;"),
    replacement: lines(
      "export const SUBREQ_BUDGET_FREE = 50;",
      "/**",
      " * Subrequests this counter CANNOT see, reserved out of every reading.",
      " *",
      " * WHY, measured (2026-09-24): the live occurrence at 14:54:56Z read",
      " *",
      " *     err:Too many subrequests by single Worker invocation … [rows subreq 12]",
      " *",
      " * — the pass's own diagnostic (PushWatcher.passDiag) reporting 12 still",
      " * unspent at the moment the runtime refused the invocation. The refused call",
      " * is inside that count, because countSubreq runs before the request is",
      " * issued, so the counter had seen 38 when the platform stopped at 50: about",
      " * twelve subrequests went out through a seam this wrapper does not cover.",
      " * The gates were not at fault — at 12 unspent the row gate (≤6) and the",
      " * stage gates (<3) correctly read that there was room.",
      " *",
      " * RULED OUT before reserving anything, so this is a size, not a theory: no",
      " * transport bypasses fetch in the Worker (the deployed bundle contains no",
      " * WebSocket at all, and Turso goes through @libsql/client/web over https, so",
      " * the db closure resolves this same wrapped global); the reading was not",
      " * stale (seconds old, with the durable row beside it still reading",
      " * `running`); and the placement was not wrong (the death is in `rows`,",
      " * which the entry gate guards against a different case on purpose).",
      " *",
      " * WHAT IS STILL UNKNOWN is the SHAPE of the gap, not its size. Reserving it",
      " * is the conservative direction: a tick that spends only inside what the",
      " * counter can see cannot overrun what it cannot see, and being wrong costs",
      " * a pass that defers a tick early and is retried — never a lost write.",
      " *",
      " * ONE constant, moved by measurement: every occurrence now reports its own",
      " * number in the err note, so the next one re-sizes this without any further",
      " * instrumentation.",
      " */",
      "export const SUBREQ_UNSEEN_ALLOWANCE = 12;",
    ),
  },
  {
    file: "src/subreqs.ts",
    what: "the view publishes both the platform fact and the ceiling actually spent against",
    marker: "unseenAllowance: number;",
    anchor: lines(
      "export interface SubreqView {",
      "  /** The allowance every window is spent against (SUBREQ_BUDGET_FREE). */",
      "  budget: number;",
    ),
    replacement: lines(
      "export interface SubreqView {",
      "  /** The allowance every window is spent against (SUBREQ_BUDGET_FREE). */",
      "  budget: number;",
      "  /**",
      "   * Subrequests the counter cannot see (SUBREQ_UNSEEN_ALLOWANCE), reserved",
      "   * out of every reading.",
      "   */",
      "  unseenAllowance: number;",
      "  /**",
      "   * `budget - unseenAllowance`: the ceiling a tick may actually spend",
      "   * against. Published beside `budget` so the reservation is visible in",
      "   * /health rather than buried in the arithmetic — a reader comparing a",
      "   * window's `total` against 50 would otherwise be reading against a number",
      "   * the tick never spends to.",
      "   */",
      "  usable: number;",
    ),
  },
  {
    file: "src/subreqs.ts",
    what: "subreqView fills the two new readings",
    marker: "unseenAllowance: SUBREQ_UNSEEN_ALLOWANCE,",
    anchor: lines(
      "  return {",
      "    budget: SUBREQ_BUDGET_FREE,",
      "    current: flat(current),",
    ),
    replacement: lines(
      "  return {",
      "    budget: SUBREQ_BUDGET_FREE,",
      "    unseenAllowance: SUBREQ_UNSEEN_ALLOWANCE,",
      "    usable: Math.max(0, SUBREQ_BUDGET_FREE - SUBREQ_UNSEEN_ALLOWANCE),",
      "    current: flat(current),",
    ),
  },
  {
    file: "src/subreqs.ts",
    what: "subreqRemaining hands out spendable room, not the raw headroom",
    marker: "return Math.max(0, budget - SUBREQ_UNSEEN_ALLOWANCE - current.total);",
    anchor: lines(
      "export function subreqRemaining(budget: number = SUBREQ_BUDGET_FREE): number {",
      "  if (!Number.isFinite(budget)) return Number.POSITIVE_INFINITY;",
      "  return Math.max(0, budget - current.total);",
      "}",
    ),
    replacement: lines(
      "export function subreqRemaining(budget: number = SUBREQ_BUDGET_FREE): number {",
      "  if (!Number.isFinite(budget)) return Number.POSITIVE_INFINITY;",
      "  return Math.max(0, budget - SUBREQ_UNSEEN_ALLOWANCE - current.total);",
      "}",
    ),
  },
  {
    file: "src/subreqs.ts",
    what: "and the reader is told what the number now means",
    // A fragment of the text the replacement WRITES. An earlier version used the
    // anchor line itself as the marker, and since that line is already in the file
    // the patch reported `already` and never wrote the paragraph.
    marker: " * SPENDABLE, not raw: the unseen reserve (SUBREQ_UNSEEN_ALLOWANCE, sized from",
    anchor: lines(
      " * half — what a LATE stage of a tick must consult BEFORE it starts a spend",
    ),
    replacement: lines(
      " * half — what a LATE stage of a tick must consult BEFORE it starts a spend",
      " *",
      " * SPENDABLE, not raw: the unseen reserve (SUBREQ_UNSEEN_ALLOWANCE, sized from",
      " * the live 14:54:56Z `rows subreq 12` occurrence) comes off first, because a",
      " * caller acting on this number is deciding whether it can afford a round",
      " * trip, and the round trips the counter cannot see are real ones. A window",
      " * that has counted nothing reports the usable ceiling, so a caller ahead of",
      " * its first fetch sees room rather than a false zero.",
    ),
  },

  // -------------------------------------------------------------- scanner.ts --
  {
    file: "src/scanner.ts",
    what: "the err note is published to the field the NEXT tick persists",
    marker: "this.pushWatchNote = errNote;",
    anchor: lines(
      "      const errNote = `err:${msg.slice(0, 120)}${diag ? ` [${diag}]` : \"\"}`;",
      "      if (this.lastSummary) {",
      "        this.lastSummary.pushWatch = errNote;",
      "      }",
    ),
    replacement: lines(
      "      const errNote = `err:${msg.slice(0, 120)}${diag ? ` [${diag}]` : \"\"}`;",
      "      // PUBLISH TO MEMORY FIRST, then try the row. Why (2026-09-24, measured):",
      "      // the 14:54:56Z occurrence surfaced in /debug/tick's summary while",
      "      // /health's durable `pushWatchPass` row still read `running` — not a bug",
      "      // in the write, but the write being unaffordable: persistPassNote swallows",
      "      // its own failure by design, and at the wall the note's own `fetch` is",
      "      // the call that gets refused. So the best diagnostic the system produced",
      "      // was the one it could not keep, and only on the isolate that served the",
      "      // request that happened to ask.",
      "      //",
      "      // `pushWatchNote` is the field the NEXT scan copies into its own summary,",
      "      // and the scan's heartbeat write is one the tick makes anyway — so the",
      "      // note becomes durable one tick later from a write that was always going",
      "      // to happen, instead of depending on one that cannot. The row write is",
      "      // still attempted, so the common case stays immediate.",
      "      this.pushWatchNote = errNote;",
      "      if (this.lastSummary) {",
      "        this.lastSummary.pushWatch = errNote;",
      "      }",
    ),
  },

  // ------------------------------------------------------- scripts/test-unit --
  {
    file: "scripts/test-unit.js",
    what: "the suite imports the probe it is now testing",
    // The reserve test called `subreqRemaining()` bare, but the suite's single
    // destructured import at the top never listed it — the local require in the
    // test only pulled SUBREQ_UNSEEN_ALLOWANCE. Import it where every other
    // subreqs symbol is imported rather than shadowing it inside one test.
    marker: "markSubreqPhase, subreqRemaining, subreqView,",
    anchor: lines(
      "const { beginSubreqWindow, countSubreq, markSubreqPhase, subreqView, resetSubreqWindows, SUBREQ_BUDGET_FREE, SUBREQ_PHASE_RING, SUBREQ_RECENT_WINDOWS, SUBREQ_HOST_RING, SUBREQ_OTHER_HOST } = require(\"../dist/subreqs.js\");",
    ),
    replacement: lines(
      "const { beginSubreqWindow, countSubreq, markSubreqPhase, subreqRemaining, subreqView, resetSubreqWindows, SUBREQ_BUDGET_FREE, SUBREQ_PHASE_RING, SUBREQ_RECENT_WINDOWS, SUBREQ_HOST_RING, SUBREQ_OTHER_HOST } = require(\"../dist/subreqs.js\");",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the reserve is in the reading, and the reading says so",
    marker: "subreqs: the unseen reserve comes off every reading",
    anchor: lines(
      '  await test("subreqs: a phase point is the running total at that stamp", async () => {',
    ),
    replacement: lines(
      '  await test("subreqs: the unseen reserve comes off every reading", () => {',
      '    // Sized from the one measurement that exists (2026-09-24 14:54:56Z):',
      '    // `err:Too many subrequests … [rows subreq 12]` means the counter had seen',
      '    // 38 when the platform stopped at 50, so ~12 went out uncounted. The',
      '    // pass spends against what is LEFT after that reserve, never the raw',
      '    // headroom — a tick that spends only inside what the counter can see',
      '    // cannot overrun what it cannot see.',
      '    const { SUBREQ_UNSEEN_ALLOWANCE } = require("../dist/subreqs.js");',
      '    assert.equal(SUBREQ_UNSEEN_ALLOWANCE, 12, "the measured gap, as one movable constant");',
      '    resetSubreqWindows();',
      '    beginSubreqWindow(1_000);',
      '    const view = subreqView();',
      '    assert.equal(view.budget, 50, "the platform fact is still published as-is");',
      '    assert.equal(view.unseenAllowance, 12, "and so is the reserve, so the arithmetic is auditable");',
      '    assert.equal(view.usable, 38, "the ceiling a tick actually spends against");',
      '    assert.equal(',
      '      subreqRemaining(),',
      '      38,',
      '      "a fresh window reports the USABLE ceiling, not 50 — a caller must not believe it has 12 more than it does",',
      '    );',
      '    for (let i = 0; i < 30; i += 1) countSubreq();',
      '    assert.equal(subreqRemaining(), 8, "spendable room falls with the counted calls");',
      '    // The exact tick that died: 38 counted, 12 the counter still believed were',
      '    // free. With the reserve it is 0, which is what the row and stage gates',
      '    // needed to see.',
      '    for (let i = 30; i < 38; i += 1) countSubreq();',
      '    assert.equal(subreqView().current.total, 38, "the counted total is unchanged — only the ceiling moved");',
      '    assert.equal(subreqRemaining(), 0, "so the pass would have been refused before it could overrun");',
      '    resetSubreqWindows();',
      '  });',
      '',
      '  await test("subreqs: a phase point is the running total at that stamp", async () => {',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the err note survives an invocation that cannot afford to write it",
    marker: "the err note is durable from the next tick's own write",
    anchor: lines(
      '  await test("PushWatcher: passDiag is silent before any pass has run", () => {',
    ),
    replacement: lines(
      '  await test("Scanner.runTrackerPass: the err note is durable from the next tick\'s own write", async () => {',
      '    // The live shape (2026-09-24 14:54:56Z): the diagnostic reached',
      '    // /debug/tick\'s summary while /health\'s `pushWatchPass` row still read',
      '    // `running`, because at the wall the note\'s own fetch is the call the',
      '    // runtime refuses. So the note has to be published to the field the NEXT',
      '    // scan copies into its summary — a write the tick makes anyway — rather',
      '    // than depending on the one it cannot make.',
      '    const { Scanner } = require("../dist/scanner.js");',
      '    const cfg = loadConfig({});',
      '    let rowWrites = 0;',
      '    const scanner = new Scanner(',
      '      { setWorkerState: async () => { rowWrites += 1; } },',
      '      { api: { sendMessage: async () => ({}) } }, null, cfg, null, null, null,',
      '    );',
      '    scanner.pushWatcher = {',
      '      headTokens: () => [],',
      '      onPush: async () => {},',
      '      passDiag: () => "rows subreq 0",',
      '      runTick: async () => {',
      '        throw new Error("Too many subrequests by single Worker invocation");',
      '      },',
      '    };',
      '    scanner.lastSummary = {};',
      '    const note = await scanner.runTrackerPass(Date.now() + 2_500);',
      '    assert.equal(note, null);',
      '    assert.equal(',
      '      scanner.pushWatchNote,',
      '      "err:Too many subrequests by single Worker invocation [rows subreq 0]",',
      '      "published to the field the next tick persists — the guarantee does not depend on a write",',
      '    );',
      '    assert.equal(rowWrites, 2, "the row is still attempted immediately (running stamp + the note), so the common case stays instant");',
      '',
      '    // And the same note survives a database that refuses the write entirely,',
      '    // which is the shape the live occurrence had.',
      '    const offline = new Scanner(',
      '      { setWorkerState: async () => { throw new Error("Too many subrequests"); } },',
      '      { api: { sendMessage: async () => ({}) } }, null, cfg, null, null, null,',
      '    );',
      '    offline.pushWatcher = scanner.pushWatcher;',
      '    offline.lastSummary = {};',
      '    const failed = await offline.runTrackerPass(Date.now() + 2_500);',
      '    assert.equal(failed, null, "a refused write does not turn a pass failure into a tick failure");',
      '    assert.match(String(offline.pushWatchNote), /\\[rows subreq 0\\]$/, "and the diagnostic is still carried");',
      '  });',
      '',
      '  await test("PushWatcher: passDiag is silent before any pass has run", () => {',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the drift guard for the reserve and the carry",
    marker: "partial paste of docs/patches/tracker-subreq-headroom.apply.js",
    anchor: lines('  console.log("\\n===== UNIT TESTS =====");'),
    replacement: lines(
      '  await test("out-of-window patch: the subrequest reserve and the note\'s carry land together (docs/patches/tracker-subreq-headroom.apply.js)", () => {',
      '    const strip = (text) =>',
      '      text',
      '        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")',
      '        .replace(/\\/\\/[^\\n]*/g, "")',
      '        .replace(/\\s+/g, "");',
      '    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));',
      '    const subreqsSrc = read("src/subreqs.ts");',
      '    const scannerSrc = read("src/scanner.ts");',
      '    const applied = {',
      '      "subreqs (the reserve is one constant)":',
      '        subreqsSrc.includes("exportconstSUBREQ_UNSEEN_ALLOWANCE=12;"),',
      '      "subreqs (it comes off the spendable number)":',
      '        subreqsSrc.includes("returnMath.max(0,budget-SUBREQ_UNSEEN_ALLOWANCE-current.total);"),',
      '      "subreqs (the view publishes both)":',
      '        subreqsSrc.includes("unseenAllowance:SUBREQ_UNSEEN_ALLOWANCE,") &&',
      '        subreqsSrc.includes("usable:Math.max(0,SUBREQ_BUDGET_FREE-SUBREQ_UNSEEN_ALLOWANCE),"),',
      '      "subreqs (the raw headroom is gone)":',
      '        !subreqsSrc.includes("returnMath.max(0,budget-current.total);"),',
      '      "scanner (the note is published to memory)":',
      '        scannerSrc.includes("this.pushWatchNote=errNote;"),',
      '      "scanner (and still published to the summary)":',
      '        scannerSrc.includes("this.lastSummary.pushWatch=errNote;"),',
      '    };',
      '    const done = Object.entries(applied).filter(([, v]) => v);',
      '    if (done.length === 0) {',
      '      console.log(',
      '        "  ℹ subrequest reserve missing - apply docs/patches/tracker-subreq-headroom.apply.js",',
      '      );',
      '      return;',
      '    }',
      '    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);',
      '    // Half of this is the worst of both: a reserve with no way to see it, or',
      '    // a carried note whose reserve still lets the pass overrun.',
      '    assert.equal(',
      '      missing.length,',
      '      0,',
      '      `partial paste of docs/patches/tracker-subreq-headroom.apply.js — missing: ${missing.join(", ")}`,',
      '    );',
      '  });',
      '',
      '  console.log("\\n===== UNIT TESTS =====");',
    ),
  },
];

let failed = false;
for (const patch of PATCHES) {
  const text = fs.readFileSync(patch.file, "utf8");
  if (text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const unmet = (patch.needs ?? []).filter((need) => !text.includes(need));
  if (unmet.length > 0) {
    console.error(`NEEDS     ${patch.file}: ${patch.what} — missing ${unmet.join(", ")}`);
    failed = true;
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
  fs.writeFileSync(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchors above");
  process.exit(1);
}
console.log("\nall patches applied");
