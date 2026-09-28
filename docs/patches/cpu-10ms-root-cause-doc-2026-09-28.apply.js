#!/usr/bin/env node
/**
 * 2026-09-28 — record the REAL root cause of the dead-tick stretches.
 *
 * Three idempotent edits, all anchored on strings that only exist once the
 * edit has been applied, so re-running reports "=" and changes nothing:
 *
 *   1. docs/round-trips.md            += §4.46 (the CPU-10 ms proof)
 *   2. docs/round-trips.md            += a supersede pointer under §4.45
 *   3. docs/scan-completion-loss.md   += OVERTURNED banner under §2026-09-23
 *   4. docs/scan-completion-loss.md   += §2026-09-28 (the correction)
 *
 * WHY THE BANNER IS INSERTED RATHER THAN THE SECTION REWRITTEN: §2026-09-23 is
 * the standing explanation every later section cites by name, and its
 * description of WHY the loss is unobservable is still correct. Superseding it
 * in place would break those references, so it is marked and left readable.
 *
 * Run: node docs/patches/cpu-10ms-root-cause-doc-2026-09-28.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const DIR = __dirname;
const RT = path.join(DIR, "..", "round-trips.md");
const SCL = path.join(DIR, "..", "scan-completion-loss.md");

const RT_FRAGMENT = path.join(DIR, "round-trips-4.46-2026-09-28.md");
const SCL_FRAGMENT = path.join(DIR, "scan-completion-loss-cpu-10ms-2026-09-28.md");
const BANNER = path.join(DIR, "scan-completion-loss-overturn-banner-2026-09-28.md");
const RT_BANNER = path.join(DIR, "round-trips-4.45-overturn-banner-2026-09-28.md");

const RT_MARKER = "## 4.46 真死因";
const SCL_TAIL_MARKER = "## 2026-09-28：真死因";
const BANNER_MARKER = "OVERTURNED";
// Headings a banner must sit under, matched on a short PREFIX so a punctuation
// edit in the rest of the line cannot silently skip the insert.
const SCL_HEADING = "## 2026-09-23：";
const RT_HEADING = "## 4.45 死亡之後嗰個 tick：";

let ok = true;
const report = (mark, msg) => {
  console.log(`${mark} ${msg}`);
  if (mark === "✗") ok = false;
};

/** Append a fragment at the end of a file (idempotent via `marker`). */
function appendFragment(file, fragment, marker, label) {
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(marker)) {
    report("=", `${label}: already present (${marker})`);
    return;
  }
  const add = fs.readFileSync(fragment, "utf8").replace(/^\s*\n/, "");
  const next = text.replace(/\s*$/, "\n\n") + add.replace(/\s*$/, "\n");
  fs.writeFileSync(file, next);
  report("✓", `${label}: appended (${next.split("\n").length} lines now)`);
}

/** Insert a banner directly under a heading (idempotent via `marker`). */
function insertUnderHeading(file, heading, fragment, marker, label) {
  const text = fs.readFileSync(file, "utf8");
  if (text.includes(marker)) {
    report("=", `${label}: already present`);
    return;
  }
  const at = text.indexOf("\n" + heading);
  if (at < 0) {
    report("✗", `${label}: heading "${heading}" not found`);
    return;
  }
  // End of the heading LINE (the newline that terminates it), so the banner
  // lands between the heading and the paragraph it introduces.
  const lineEnd = text.indexOf("\n", at + 1);
  const banner = fs.readFileSync(fragment, "utf8").replace(/\s*$/, "\n");
  fs.writeFileSync(
    file,
    text.slice(0, lineEnd) + "\n\n" + banner + text.slice(lineEnd + 1),
  );
  report("✓", `${label}: banner inserted under the heading`);
}

appendFragment(RT, RT_FRAGMENT, RT_MARKER, "round-trips.md §4.46");
insertUnderHeading(
  RT,
  RT_HEADING,
  RT_BANNER,
  "本節（同 §4.45a）嘅死因框架已經被 §4.46 推翻",
  "round-trips.md §4.45",
);
insertUnderHeading(
  SCL,
  SCL_HEADING,
  BANNER,
  BANNER_MARKER,
  "scan-completion-loss.md §2026-09-23",
);
appendFragment(SCL, SCL_FRAGMENT, SCL_TAIL_MARKER, "scan-completion-loss.md §2026-09-28");

console.log(ok ? "done" : "FAILED — see ✗ above");
process.exit(ok ? 0 : 1);
