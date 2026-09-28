#!/usr/bin/env node
/**
 * Bind the EXACT measured ranges into the code comments, and keep the quoted
 * provenance true to how the numbers were taken.
 *
 * Two production runs of scripts/pool-mcap-floor.js (3 slots, then 4 slots)
 * gave dropped-per-sweep = 4, 6, 4, 5, 5, 6, 8 (mean 5.4) and a NULL share of
 * 86-89%. The first pass quoted only the 3-slot run (4-6 rows, 89%), which
 * understates both and credits the reading to the wrong sample.
 *
 * Anchored + marker-guarded + idempotent: each sub is independent, so earlier
 * ones report "=" on a re-run while new ones still apply.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
let failures = 0;

function sub(label, anchor, replacement, marker) {
  const target = path.join(root, "src", "scanner.ts");
  const src = fs.readFileSync(target, "utf8");
  if (src.includes(marker)) {
    console.log(`= ${label} (already applied)`);
    return;
  }
  const hits = src.split(anchor).length - 1;
  if (hits !== 1) {
    console.error(`✗ ${label} — anchor hits = ${hits} (want 1)`);
    failures += 1;
    return;
  }
  fs.writeFileSync(target, src.replace(anchor, () => replacement));
  console.log(`✓ ${label}`);
}

sub(
  "the constant's measured range",
  ` * the raise stops re-measuring 4-6 rows per sweep — 0.5-0.7% of the ~734 rows
 * the pool returns — every one of them peaking at 61-79% of the gate, and the
 * net pool falls by ~4 rows because a band's freed LIMIT backfills from the
 * same window.`,
  ` * the raise stops re-measuring 4-8 rows per sweep (mean 5.4 over the seven
 * slots sampled) out of the 600-730 the pool returns — 0.5-1% — every one of
 * them peaking at 61-79% of the gate; the net pool falls by 3-6 rows, because a
 * band's freed LIMIT backfills 1-2 rows from the same window.`,
  "mean 5.4 over the seven",
);

sub(
  "the NULL share",
  ` * ratio: 89% of the rows the pool returns have NO peak mcap at all, and NULL is`,
  ` * ratio: 86-89% of the rows the pool returns have NO peak mcap at all, and`,
  "86-89% of the rows the pool returns have NO peak mcap at all, and",
);

sub(
  "the inline note's range",
  `        // above got, measured at 4-6 rows per sweep (0.5-0.7% of the pool).`,
  `        // above got, measured at 4-8 rows per sweep (0.5-1% of the pool).`,
  "measured at 4-8 rows per sweep (0.5-1% of the pool)",
);

sub(
  "the quoted provenance",
  ` * (scripts/pool-mcap-floor.js, 3 rotation slots, wrangler [vars] overlaid):`,
  ` * (scripts/pool-mcap-floor.js: two runs, 3 + 4 rotation slots, with
 * wrangler [vars] overlaid so the bands are production's):`,
  "two runs, 3 + 4 rotation slots",
);

sub(
  "the overlong NULL line",
  ` * ratio: 86-89% of the rows the pool returns have NO peak mcap at all, and NULL is
 * KEPT (fail-open), so no ratio reaches them — 0.5 through 0.9 moves the pool
 * by ten rows.`,
  ` * ratio: 86-89% of the rows the pool returns have NO peak mcap at all, and
 * NULL is KEPT (fail-open), so no ratio reaches them — 0.5 through 0.9 moves
 * the whole pool by ten rows.`,
  "NULL is KEPT (fail-open), so no ratio reaches them — 0.5 through 0.9 moves",
);

console.log(failures === 0 ? "\nall ranges applied" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
