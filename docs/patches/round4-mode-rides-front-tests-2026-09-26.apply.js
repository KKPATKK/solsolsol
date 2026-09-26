#!/usr/bin/env node
/**
 * Round 4 test updates (2026-09-26): the trade-mode override rides the
 * tick-front batch.
 *
 * ONE edit, in scripts/test-unit.js: a new out-of-window guard for the merge
 * itself. The two anchors that make it verifiable live in files past the file
 * tool's edit window (src/worker.ts: WEDGE_READ_KEYS + frontModeOverrideRead +
 * the onTickStart hook + the /health merge; src/db.ts: parseTradeModeOverride),
 * so the guard asserts BOTH halves:
 *
 *   - the behaviour that can be imported (WEDGE_READ_KEYS carries the row;
 *     parseTradeModeOverride is the one validation rule), and
 *   - the source shape that cannot (the tick primes from the front read BEFORE
 *     the prefetch, a null ride never primes and does not read, and /health no
 *     longer pays a second round trip for the row it just read).
 *
 * scripts/test-tick-path.js gets the behavioural half of the ride (primed /
 * null / stale / junk / ordering) in the same round, as a plain edit there.
 *
 * Run: node docs/patches/round4-mode-rides-front-tests-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

// Built from JSON.stringify so the anchor's `\n` is the SOURCE's escape
// (backslash + n), not a real newline — a hand-typed literal here is how the
// count of `=` drifts and the anchor silently stops matching.
const NEW_GUARD = `  console.log(${JSON.stringify("\n===== UNIT TESTS =====")});`;

const ROUND4_GUARD = lines(
  `  // ---------- round 4: the trade-mode override rides the tick-front batch ---`,
  `  //`,
  `  // The labelled census named two candidates and three live ticks separated`,
  `  // them: \`getWorkerState:trade_mode_override\` was 1 call / 86-117ms on EVERY`,
  `  // tick (modeRead reads 1 reuses 0), while \`getWorkerState:scan_heartbeat\``,
  `  // read 0 on those same ticks — its consumers already share ONE statement`,
  `  // (WEDGE_READ_KEYS) and only the diagnostic/fallback paths ever read it`,
  `  // alone. So the merge is the mode row: the key joins the statement the tick`,
  `  // front already sends, the tick's prefetch is primed from that read (reads`,
  `  // 0), and the validation the single-row read always applied becomes one`,
  `  // shared parser for every reader of the row.`,
  `  await test("out-of-window patch: the trade-mode override rides the tick-front batch (docs/patches/round4-mode-rides-front-2026-09-26.apply.js)", () => {`,
  `    const strip = (text) =>`,
  `      text`,
  `        .replace(/\\\\/\\\\*[\\\\s\\\\S]*?\\\\*\\\\//g, "")`,
  `        .replace(/\\\\/\\\\/[^\\\\n]*/g, "")`,
  `        .replace(/\\\\s+/g, "");`,
  `    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));`,
  `    const workerSrc = read("src/worker.ts");`,
  `    const dbSrc = read("src/db.ts");`,
  `    const { WEDGE_READ_KEYS } = require("../dist/worker.js");`,
  `    const { parseTradeModeOverride } = require("../dist/db.js");`,
  `    const applied = {`,
  `      "the front's statement carries the mode row (the ride exists)":`,
  `        Array.isArray(WEDGE_READ_KEYS) &&`,
  `        WEDGE_READ_KEYS.includes("trade_mode_override") &&`,
  `        WEDGE_READ_KEYS.includes("scan_heartbeat") &&`,
  `        WEDGE_READ_KEYS.includes(TICK_PROGRESS_KEY),`,
  `      "one validation rule, shared by every reader of that row":`,
  `        parseTradeModeOverride("off") === "off" &&`,
  `        parseTradeModeOverride("manual") === "manual" &&`,
  `        parseTradeModeOverride("auto") === "auto" &&`,
  `        parseTradeModeOverride("nonsense") === null &&`,
  `        parseTradeModeOverride("") === null &&`,
  `        parseTradeModeOverride(null) === null &&`,
  `        parseTradeModeOverride(undefined) === null,`,
  `      "worker (the tick primes from the front read BEFORE the prefetch)":`,
  `        workerSrc.includes("constride=frontModeOverrideRead();") &&`,
  `        workerSrc.includes("if(ride!==null)trade?.primeModeOverride(ride.raw,ride.at);") &&`,
  `        workerSrc.indexOf("frontModeOverrideRead()") <`,
  `          workerSrc.indexOf("trade?.prefetchMode()"),`,
  `      "worker (no READING never primes: the miss is null, not an empty value)":`,
  `        workerSrc.includes("if(seen===null||seen.map===null)returnnull;") &&`,
  `        workerSrc.includes("if(Date.now()-seen.at>HEARTBEAT_REUSE_MS)returnnull;"),`,
  `      "worker (/health reads that row in its own batch, never a second time)":`,
  `        workerSrc.includes('"scan_heartbeat",TICK_PROGRESS_KEY,"trade_mode_override",') &&`,
  `        workerSrc.includes("tradeModeOverride=parseTradeModeOverride(modeRaw);") &&`,
  `        !workerSrc.includes("getTradeModeOverride"),`,
  `    };`,
  `    const done = Object.entries(applied).filter(([, v]) => v);`,
  `    if (done.length === 0) {`,
  `      console.log(`,
  `        "  \\\\u2139 the tick-front mode ride is missing - apply docs/patches/round4-mode-rides-front-2026-09-26.apply.js",`,
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
    "the round-4 out-of-window guard lands in front of the summary",
    NEW_GUARD,
    ROUND4_GUARD,
    (src) => src.includes("round 4: the trade-mode override rides the tick-front batch"),
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
