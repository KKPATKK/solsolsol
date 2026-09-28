#!/usr/bin/env node
/**
 * Put the MEASURED numbers where the next reader looks, and fix one slip.
 *
 *  1. src/db.ts — the liquidity docstring now starts a sentence with "Passes".
 *  2. src/scanner.ts — POOL_MCAP_PRUNE_RATIO's docstring quotes the code-default
 *     gate only, and cites the measurement without its result. The live chat's
 *     gate is $60K, not the $40K default, and the result (4-6 rows/sweep,
 *     0.5-0.7%) belongs in the code, not only in the doc.
 *
 * Anchored + marker-guarded + idempotent: re-running must print "=", not "✓".
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
let failures = 0;

function sub(file, label, anchor, replacement, marker) {
  const target = path.join(root, file);
  const src = fs.readFileSync(target, "utf8");
  if (src.includes(marker)) {
    console.log(`= ${file} :: ${label} (already applied)`);
    return;
  }
  const hits = src.split(anchor).length - 1;
  if (hits !== 1) {
    console.error(`✗ ${file} :: ${label} — anchor hits = ${hits} (want 1)`);
    failures += 1;
    return;
  }
  fs.writeFileSync(target, src.replace(anchor, () => replacement));
  console.log(`✓ ${file} :: ${label}`);
}

sub(
  "src/db.ts",
  "the capitalization slip",
  `     * every band (NULL = never seen with pair data → kept). The scanner
     * Passes POOL_LIQUIDITY_PRUNE_RATIO × the widest chat's`,
  `     * every band (NULL = never seen with pair data → kept). The scanner
     * passes POOL_LIQUIDITY_PRUNE_RATIO × the widest chat's`,
  "The scanner\n     * passes POOL_LIQUIDITY_PRUNE_RATIO",
);

sub(
  "src/scanner.ts",
  "the gate figures in the constant's docstring",
  ` * gate it scales — $40K gate → $32K floor here, $10K gate → $8K there.`,
  ` * gate it scales — $40K gate → $32K floor here, $10K gate → $8K there (the
 * LIVE chat gates $60K, so its floor is $48K; the gate is per-chat, so quote
 * the ratio, not a dollar figure, when the ratio is the thing being changed).`,
  "so its floor is $48K; the gate is per-chat",
);

sub(
  "src/scanner.ts",
  "the measured result in the constant's docstring",
  ` * moves a few percent at a time. Measured on this pool before the raise:
 * scripts/pool-mcap-floor.js.`,
  ` * moves a few percent at a time. MEASURED before the raise, on this pool
 * (scripts/pool-mcap-floor.js, 3 rotation slots, wrangler [vars] overlaid):
 * the raise stops re-measuring 4-6 rows per sweep — 0.5-0.7% of the ~734 rows
 * the pool returns — every one of them peaking at 61-79% of the gate, and the
 * net pool falls by ~4 rows because a band's freed LIMIT backfills from the
 * same window.
 *
 * The same run found what actually spreads this sweep thin, and it is not this
 * ratio: 89% of the rows the pool returns have NO peak mcap at all, and NULL is
 * KEPT (fail-open), so no ratio reaches them — 0.5 through 0.9 moves the pool
 * by ten rows. Backfilling max_mcap_observed at registration, or pruning NULL
 * rows after a grace, is that lever.`,
  "89% of the rows the pool returns have NO peak mcap",
);

sub(
  "src/scanner.ts",
  "the inline note's figures",
  `        // 2026-09-28: 0.6 → 0.8 ($24K → $32K at the default $40K gate) — the
        // same raise the liquidity floor above got. POOL_MCAP_PRUNE_RATIO
        // documents why an mcap drop costs more per coin than a liquidity
        // drop; scripts/pool-mcap-floor.js is the measurement behind it.`,
  `        // 2026-09-28: 0.6 → 0.8 ($24K → $32K at the default $40K gate, $36K
        // → $48K on the live $60K gate) — the same raise the liquidity floor
        // above got, measured at 4-6 rows per sweep (0.5-0.7% of the pool).
        // POOL_MCAP_PRUNE_RATIO carries the full reading, including why the
        // ratio is the wrong lever for what actually spreads this sweep thin.`,
  "$48K on the live $60K gate",
);

console.log(
  failures === 0 ? "\nall notes applied" : `\n${failures} edit(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
