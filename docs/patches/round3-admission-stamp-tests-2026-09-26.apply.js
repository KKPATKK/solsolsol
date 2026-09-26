#!/usr/bin/env node
/**
 * Round 3 test updates (2026-09-26): the admission stamp rides the claim.
 *
 * TWO edits, both in scripts/test-unit.js:
 *
 * 1. The `tick-progress-record.apply.js` guard pinned the ladder's first stamp
 *    as `notePhase("scan")`. Round 3 removed that call on purpose (the stamp
 *    rides the claim batch now), so the sub-assertion is re-pointed at the
 *    successor shape: the record is BUILT before the claim and handed to it,
 *    while the scanner hook's wiring/unwiring is still pinned.
 *
 * 2. A new out-of-window guard for the round-3 merge itself: the guarded
 *    `tick_progress` statement in Db.claimScanLock (all three arms), the worker
 *    call site, and the note's `preRace n/a`. Both source files are far past
 *    the file tool's edit window, so the shape is asserted on the source.
 *
 * Run: node docs/patches/round3-admission-stamp-tests-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const NEW_GUARD = `  console.log("\\n===== UNIT TESTS =====");`;

const ROUND3_GUARD = lines(
  `  // ---------- round 3: the admission stamp rides the scan-lock claim ----------`,
  `  //`,
  `  // Measured live 2026-09-26 (labelled census): the phase ladder's five stamps`,
  `  // were the single largest DB item in a ~21-request tick — and the FIRST of`,
  `  // them ("this tick was admitted, the scan not yet entered") is exactly what`,
  `  // the claim batch already writes (its heartbeat carries the same at and the`,
  `  // same phase). So the stamp rides the claim, GUARDED by the claim's own lock`,
  `  // value — the same EXISTS idiom as the batch's dead-tick row — so a tick`,
  `  // that lost the lease cannot stamp a phase it never reached. Both source`,
  `  // files are far past the file tool's edit window, so the shape is asserted`,
  `  // on the source, the way every other out-of-window patch here is.`,
  `  await test("out-of-window patch: the admission stamp rides the scan-lock claim (docs/patches/round3-admission-stamp-2026-09-26.apply.js)", () => {`,
  `    const strip = (text) =>`,
  `      text`,
  `        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")`,
  `        .replace(/\\/\\/[^\\n]*/g, "")`,
  `        .replace(/\\s+/g, "");`,
  `    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));`,
  `    const workerSrc = read("src/worker.ts");`,
  `    const dbSrc = read("src/db.ts");`,
  `    const count = (hay, needle) => hay.split(needle).length - 1;`,
  `    const applied = {`,
  `      "db (the parameter, documented at the claim)":`,
  `        dbSrc.includes("tickProgressJson?:string|null,"),`,
  `      "db (the statement is guarded by THIS claim's own lock value)":`,
  `        dbSrc.includes("SELECT'tick_progress',?") &&`,
  `        dbSrc.includes(`,
  `          "WHEREEXISTS(SELECT1FROMworker_stateWHEREkey='scan_lock'ANDvalue=?)",`,
  `        ) &&`,
  `        dbSrc.includes("args:[tickProgressJson,value],"),`,
  `      "db (it rides the batch, and every arm that can carry extra statements takes it)":`,
  `        dbSrc.includes("historyStmt,progressStmt,...cronStatements,") &&`,
  `        count(`,
  `          dbSrc,`,
  `          "if(heartbeatStmt||historyStmt||progressStmt||cronStatements.length>0){",`,
  `        ) === 2 &&`,
  `        dbSrc.includes(`,
  `          "if(won&&(heartbeatStmt||historyStmt||progressStmt||cronStatements.length>0)){",`,
  `        ) &&`,
  `        dbSrc.includes("[heartbeatStmt,historyStmt,progressStmt,...cronStatements]"),`,
  `      "worker (the claim carries the admission record)":`,
  `        workerSrc.includes("constadmissionRecord=tickProgressRecord({") &&`,
  `        workerSrc.includes("cronTick??null,admissionRecord,"),`,
  `      "worker (the ladder no longer queues an admission stamp)":`,
  `        !workerSrc.includes('notePhase("scan")'),`,
  `      "worker (an unmeasured pre-race split reads n/a, not 0ms)":`,
  `        workerSrc.includes("preRace\${rec.preRaceMs>0?"),`,
  `    };`,
  `    const done = Object.entries(applied).filter(([, v]) => v);`,
  `    if (done.length === 0) {`,
  `      console.log(`,
  `        "  \\u2139 the round-3 admission-stamp merge is missing - apply docs/patches/round3-admission-stamp-2026-09-26.apply.js",`,
  `      );`,
  `      return;`,
  `    }`,
  `    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);`,
  `    assert.deepEqual(missing, [], \`half-applied: \${missing.join(", ")}\`);`,
  `  });`,
  ``,
  NEW_GUARD,
);

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "scripts/test-unit.js",
    "the tick-progress-record guard: the admission stamp rides the claim now",
    lines(
      `      "worker (the tick queues its first stamp before the scan and unwires the hook after it)":`,
      `        workerSrc.includes('notePhase("scan")') &&`,
      `        workerSrc.includes("scanner.onTickPhase=notePhase;") &&`,
      `        workerSrc.includes("scanner.onTickPhase=null;"),`,
    ),
    lines(
      `      // ROUND 3 (2026-09-26): the admission stamp no longer queues in the`,
      `      // ladder — it rides the claim batch (Db.claimScanLock's`,
      `      // tickProgressJson), which is what made it free. The hook's wiring and`,
      `      // unwiring are still pinned here: the phases INSIDE the scan must`,
      `      // still be stamped, and the hook must still be unwired after the race.`,
      `      "worker (the admission stamp rides the claim, and the scanner hook is unwired after the race)":`,
      `        workerSrc.includes("constadmissionRecord=tickProgressRecord({") &&`,
      `        workerSrc.includes("cronTick??null,admissionRecord,") &&`,
      `        workerSrc.includes("scanner.onTickPhase=notePhase;") &&`,
      `        workerSrc.includes("scanner.onTickPhase=null;"),`,
    ),
    (src) => src.includes("the admission stamp rides the claim, and the scanner hook"),
  ],
  [
    "scripts/test-unit.js",
    "the round-3 out-of-window guard lands in front of the summary",
    NEW_GUARD,
    ROUND3_GUARD,
    (src) => src.includes("round 3: the admission stamp rides the scan-lock claim"),
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
