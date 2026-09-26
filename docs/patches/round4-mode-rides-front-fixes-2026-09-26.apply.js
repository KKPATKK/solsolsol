#!/usr/bin/env node
/**
 * Round 4 follow-up (2026-09-26): the test guard's strip must not be a regex
 * written through a patch script.
 *
 * WHAT WENT WRONG. The guard added by
 * docs/patches/round4-mode-rides-front-tests-2026-09-26.apply.js built its
 * comment/whitespace strip with regex literals inside a template literal;
 * the backslashes came out DOUBLED in the target file, so the first literal
 * read `/\\/` (an escaped backslash, then the closing slash) and the rest of
 * the line was parsed as flags — `SyntaxError: Invalid regular expression
 * flags` before a single test ran.
 *
 * THE FIX, in two parts:
 *   1. The strip becomes REGEX-FREE: a character-code whitespace squash, which
 *      has no backslashes to double in the first place. Comments are no longer
 *      stripped, so the one assertion that needed that (`worker.ts` no longer
 *      names the single-row read) now reads the raw source — which is why
 *   2. the two comments that literally spelled `Db.getTradeModeOverride` are
 *      reworded. They describe the same thing without the identifier, so the
 *      assertion stays meaningful (the CALL is what must be gone).
 *
 * Both anchors are built from String.fromCharCode(92) rather than typed, so
 * this script cannot repeat the very mistake it exists to fix.
 *
 * Run: node docs/patches/round4-mode-rides-front-fixes-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** One backslash, and the pair the broken block carries. */
const BS = String.fromCharCode(92);
const BSD = BS + BS;

/** The broken strip, exactly as the earlier patch wrote it into the file. */
const BROKEN_STRIP = lines(
  `    const strip = (text) =>`,
  `      text`,
  `        .replace(/` + BSD + `/` + BSD + `*[` + BSD + `s` + BSD + `S]*?` + BSD + `*` + BSD + `//g, "")`,
  `        .replace(/` + BSD + `/` + BSD + `/[^` + BSD + `n]*/g, "")`,
  `        .replace(/` + BSD + `s+/g, "");`,
);

/** The regex-free squash that replaces it. */
const FIXED_STRIP = lines(
  `    // Whitespace-only squash, and deliberately REGEX-FREE: this block is`,
  `    // itself written by a patch script, and a half-escaped regex in one of`,
  `    // those is how a strip silently starts matching nothing — or fails to`,
  `    // compile at all, which is exactly what round 4's first cut did.`,
  `    // Comments are NOT stripped, so the assertion about /health's read below`,
  `    // runs against the raw source (and the comments it reads say the same`,
  `    // thing without spelling the identifier).`,
  `    const WS = new Set([9, 10, 13, 32]);`,
  `    const strip = (text) =>`,
  `      [...text].filter((ch) => !WS.has(ch.charCodeAt(0))).join("");`,
);

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "scripts/test-unit.js",
    "the guard's strip is regex-free (no escapes to double)",
    BROKEN_STRIP,
    FIXED_STRIP,
    (src) => src.includes("const WS = new Set([9, 10, 13, 32]);"),
  ],
  [
    "src/worker.ts",
    "the /health comment stops spelling the identifier the guard asserts is gone",
    `      // to read it a SECOND time (Db.getTradeModeOverride) for a value this`,
    `      // to read it a SECOND time (the single-row read) for a value this`,
    (src) => src.includes("to read it a SECOND time (the single-row read)"),
  ],
  [
    "src/worker.ts",
    "and so does the effective-mode comment",
    `      // (parseTradeModeOverride — the rule Db.getTradeModeOverride applies),`,
    `      // (parseTradeModeOverride — the rule the single-row read applies),`,
    (src) => src.includes("the rule the single-row read applies),"),
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
