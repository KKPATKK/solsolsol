#!/usr/bin/env node
/**
 * Corrections found while VERIFYING tick-progress-record.apply.js — the layer
 * that turns "the patch applied" into "the patch reads right".
 *
 * 1. THE GUARD'S SECOND NEEDLE. The drift test asserts the ORDER of two
 *    stripped fragments: the pre-flush stamp must precede the flush call it
 *    describes. The needle was written `constflushCompletion=()=>{`, but this
 *    patch keeps the flush's two-line arrow form (`const flushCompletion = ()`
 *    then `db?.persistScanCompletion(`), so the stripped text reads
 *    `constflushCompletion=()=>db?.persistScanCompletion(` and the needle never
 *    matched. The guard then failed on a correctly patched tree, which is the
 *    one failure mode a drift guard must not have. (docs/…apply.js already
 *    carries the corrected needle for a clean run; this entry fixes the copy
 *    that landed, and its marker makes it a no-op when that is already true.)
 *
 * 2. WHICH DIRECTION OF MISMATCH MEANS WHAT. The note compares the record's
 *    `at` (the dead tick's startedAt) with the death being backfilled. Both
 *    directions were collapsed into `prog other`, and only one of them is even
 *    possible:
 *
 *      - rec.at < deadAt — the NORMAL shape of a death that never reached its
 *        own pre-flush stamp: the row simply still holds whatever the tick
 *        before it wrote. That is the SAME reading as an absent record, so it is
 *        reported as `prog none` WITH the reason, instead of a bare "other" that
 *        contradicts the doc (which defines `prog none` as "died before the
 *        pre-flush point").
 *      - rec.at > deadAt — cannot come from a death this successor is
 *        backfilling (the successor writes its own stamp only at the very end of
 *        its own tick). Kept as `prog other`: named, never assumed away.
 *
 *    A record is also keyed by `at`, so there is nothing to clear and no window
 *    in which a stale row can be credited to a new death.
 *
 * 3. THE TESTS for both directions, since the first version only pinned one.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  {
    file: "scripts/test-unit.js",
    what: "the order needle matches the flush call it is ordering against",
    marker: "constflushCompletion=()=>db?.persistScanCompletion(",
    anchor:
      "        before('noteProgress(late?\"postscan-late\":\"postscan\")', \"constflushCompletion=()=>{\"),",
    replacement:
      "        before('noteProgress(late?\"postscan-late\":\"postscan\")', \"constflushCompletion=()=>db?.persistScanCompletion(\"),",
  },
  {
    file: "src/worker.ts",
    what: "an earlier tick's stamp is the `prog none` reading, not a bare `other`",
    marker: "const none = (why: string) =>",
    anchor: lines(
      '  const none = " [prog none: died before the pre-flush record, or its own write was lost]";',
      "  const rec = parseTickProgress(raw);",
      "  if (!rec) return none.slice(0, limit);",
      "  if (rec.at !== deadAt) return ` [prog other (at ${rec.at} ≠ ${deadAt})]`.slice(0, limit);",
    ),
    replacement: lines(
      "  const none = (why: string) => ` [prog none: ${why}]`.slice(0, limit);",
      "  const rec = parseTickProgress(raw);",
      '  if (!rec) return none("died before the pre-flush record, or its own write was lost");',
      "  if (rec.at !== deadAt) {",
      "    // The record is keyed by the tick's startedAt, so an EARLIER stamp is not",
      "    // this tick's evidence at all — it means the dead tick never reached its",
      "    // own pre-flush point, which is the `prog none` reading and is reported",
      "    // with the reason instead of a bare \"none\". A NEWER stamp cannot come",
      "    // from a death this successor is backfilling (the successor stamps only at",
      "    // the end of its OWN tick), so it is named as what it is, not assumed",
      "    // away.",
      "    return rec.at < deadAt",
      "      ? none(`the row still holds an earlier tick's stamp (at ${rec.at})`)",
      "      : ` [prog other (at ${rec.at} ≠ ${deadAt})]`.slice(0, limit);",
      "  }",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "and both mismatch directions are pinned by a test",
    marker: "assert.match(later, /prog other/",
    anchor: lines(
      "    const other = tickProgressNote(rec, at + 60_000);",
      '    assert.match(other, /prog other/, "another tick\'s record is never credited");',
    ),
    replacement: lines(
      "    // A record from ANOTHER tick is never credited to this death, and the two",
      "    // directions mean different things: an EARLIER stamp is the normal shape of",
      "    // a death that never reached its own stamp (the same reading as an absent",
      "    // record), while a NEWER one cannot come from this death at all.",
      "    const later = tickProgressNote(rec, at - 60_000);",
      '    assert.match(later, /prog other/, "a stamp NEWER than the death is named, not assumed");',
      "    const earlier = tickProgressNote(rec, at + 60_000);",
      '    assert.match(earlier, /prog none/, "an earlier tick\'s stamp means this tick never stamped");',
      "    assert.match(earlier, /earlier tick's stamp/);",
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
  console.error("\nrefusing to leave the tree half-patched — fix the anchor above");
  process.exit(1);
}
console.log("\nall patches applied");
