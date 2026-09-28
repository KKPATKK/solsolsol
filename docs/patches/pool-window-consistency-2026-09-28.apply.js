#!/usr/bin/env node
/*
 * 2026-09-28 — make the offline instruments read the scanner's own pool window.
 *
 * The tick queries the re-eval pool with RE_EVAL_WINDOW_MS (30h) and
 * RE_EVAL_AGE_MARGIN_MIN (180min). Three scripts query the same production DB
 * by hand and each used to restate those numbers:
 *
 *   scripts/cpu-profile.js   43h / 30min   ← DRIFTED (a wider pool than the tick)
 *   scripts/test-filters.js  30h / 180min  ← right by hand, same risk
 *   scripts/pool-mcap-floor.js 30h / 180min ← mine, right by hand
 *
 * Two of three matching is not a mechanism. This patch exports both constants
 * from src/scanner.ts and makes all three import them (test-filters already
 * requires dist/scanner.js, so this is free).
 *
 * Idempotent: every anchor is checked for uniqueness and the runner prints
 * "=" when a replacement is already in place. Re-run to prove it.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..", "..");

let ok = true;

/** Read a repo-relative file. */
function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/** Replace `oldText` with `newText` once, or report it as already applied. */
function once(rel, oldText, newText) {
  const text = read(rel);
  // Check for the RESULT first: one of the anchors below keeps its own anchor
  // line (the console.log block), so matching on the anchor alone would insert
  // the pinned test a second time.
  if (text.includes(newText) && !text.includes(oldText + newText)) {
    console.log(`= ${rel}: already applied`);
    return;
  }
  const hits = text.split(oldText).length - 1;
  if (hits === 1) {
    fs.writeFileSync(path.join(root, rel), text.split(oldText).join(newText));
    console.log(`\u2713 ${rel}: patched`);
    return;
  }
  if (hits === 0 && text.includes(newText)) {
    console.log(`= ${rel}: already applied`);
    return;
  }
  ok = false;
  console.log(`\u2717 ${rel}: anchor ${hits === 0 ? "not found" : `matched ${hits}x`}`);
}

/* ------------------------------------------------------------------ *
 * src/scanner.ts — export the two window constants
 * ------------------------------------------------------------------ */
once(
  "src/scanner.ts",
  ` * contains young tokens.
 */
const RE_EVAL_WINDOW_MS = 30 * 60 * 60_000;`,
  ` * contains young tokens.
 *
 * Exported so the offline instruments (scripts/cpu-profile.js, test-filters.js,
 * pool-mcap-floor.js) query the tick's pool instead of restating a window:
 * cpu-profile carried 43h/30min until 2026-09-28, i.e. it measured a wider
 * pool than the scanner ever reads.
 */
export const RE_EVAL_WINDOW_MS = 30 * 60 * 60_000;`,
);

once(
  "src/scanner.ts",
  ` * they qualify instead of being picked up only after a later scan.
 */
const RE_EVAL_AGE_MARGIN_MIN = 180;`,
  ` * they qualify instead of being picked up only after a later scan.
 *
 * Exported for the same reason as RE_EVAL_WINDOW_MS: the offline instruments
 * must run the tick's margins, not their own.
 */
export const RE_EVAL_AGE_MARGIN_MIN = 180;`,
);

/* ------------------------------------------------------------------ *
 * scripts/cpu-profile.js — the drifted copy
 * ------------------------------------------------------------------ */
once(
  "scripts/cpu-profile.js",
  `const {
  Scanner,
  POOL_LIQUIDITY_PRUNE_RATIO,
  POOL_MCAP_PRUNE_RATIO,
} = require("../dist/scanner.js");`,
  `const {
  Scanner,
  POOL_LIQUIDITY_PRUNE_RATIO,
  POOL_MCAP_PRUNE_RATIO,
  RE_EVAL_WINDOW_MS,
  RE_EVAL_AGE_MARGIN_MIN,
} = require("../dist/scanner.js");`,
);

once(
  "scripts/cpu-profile.js",
  `const RE_EVAL_WINDOW_MS = 43 * 3600_000;
const RE_EVAL_AGE_MARGIN_MIN = 30;`,
  `// RE_EVAL_WINDOW_MS / RE_EVAL_AGE_MARGIN_MIN come from dist/scanner.js (the
// destructure above). Until 2026-09-28 they were restated here as 43h / 30min,
// which describes a WIDER pool than the tick reads: a 43h sinceMs reaches two
// hours further back, and a 30min margin is tighter at both ends of the age
// band. So this report's pool phase measured a different pool than the scanner
// queries, and the two views could disagree without anyone noticing. There is
// nothing left to keep in sync by hand.`,
);

/* ------------------------------------------------------------------ *
 * scripts/pool-mcap-floor.js — mine, right by hand
 * ------------------------------------------------------------------ */
once(
  "scripts/pool-mcap-floor.js",
  `const {
  POOL_MCAP_PRUNE_RATIO,
  POOL_LIQUIDITY_PRUNE_RATIO,
} = require("../dist/scanner.js");`,
  `const {
  POOL_MCAP_PRUNE_RATIO,
  POOL_LIQUIDITY_PRUNE_RATIO,
  RE_EVAL_WINDOW_MS,
  RE_EVAL_AGE_MARGIN_MIN,
} = require("../dist/scanner.js");`,
);

once(
  "scripts/pool-mcap-floor.js",
  `// The scanner's own window constants (src/scanner.ts — RE_EVAL_WINDOW_MS and
// RE_EVAL_AGE_MARGIN_MIN; not exported, so restated here).
const RE_EVAL_WINDOW_MS = 30 * 60 * 60_000;
const RE_EVAL_AGE_MARGIN_MIN = 180;`,
  `// The scanner's own window constants, imported (the destructure above) rather
// than restated: src/scanner.ts exports RE_EVAL_WINDOW_MS and
// RE_EVAL_AGE_MARGIN_MIN for exactly this purpose since 2026-09-28.`,
);

/* ------------------------------------------------------------------ *
 * scripts/test-filters.js — right by hand; also stop restating the pool size
 * ------------------------------------------------------------------ */
once(
  "scripts/test-filters.js",
  `// Mirrors scanner.ts constants so the diagnosis runs the same bounds.
const RE_EVAL_WINDOW_MS = 30 * 3600e3;
const RE_EVAL_AGE_MARGIN_MIN = 180;
const RE_EVAL_POOL_SIZE = 40;`,
  `// The bounds come from the scanner itself, so the diagnosis runs what the tick
// runs. These were hand-copied until 2026-09-28: this copy happened to stay
// right at 30h/180min while the sibling copy in cpu-profile.js drifted to
// 43h/30min, which is the whole argument for importing them.
const { RE_EVAL_WINDOW_MS, RE_EVAL_AGE_MARGIN_MIN } = require("../dist/scanner.js");`,
);

once(
  "scripts/test-filters.js",
  `      limit: RE_EVAL_POOL_SIZE,`,
  `      limit: cfg.reevalPoolSize,`,
);

/* ------------------------------------------------------------------ *
 * scripts/test-unit.js — the pin
 * ------------------------------------------------------------------ */
once(
  "scripts/test-unit.js",
  `const { mcapRatioBlockReason, newWalletBlockReason, top10MinBlockReason, botUsersBlockReason, flurryBlockReason, gateLiquidityUsd, slicePoolRotation, cardSendDeadline, cardClaimDeadline, boundClaim, DeferredPushLedger, SCAN_TICK_DEADLINE_MS, CANDIDATE_PUSH_RESERVE_MS, poolKeyHash, poolQueryFingerprint, poolCacheView, poolEdgeCache, POOL_EDGE_CACHE_URL, POOL_EDGE_CACHE_MIN_TTL_S, Scanner } = require("../dist/scanner.js");`,
  `const { mcapRatioBlockReason, newWalletBlockReason, top10MinBlockReason, botUsersBlockReason, flurryBlockReason, gateLiquidityUsd, slicePoolRotation, cardSendDeadline, cardClaimDeadline, boundClaim, DeferredPushLedger, SCAN_TICK_DEADLINE_MS, CANDIDATE_PUSH_RESERVE_MS, poolKeyHash, poolQueryFingerprint, poolCacheView, poolEdgeCache, POOL_EDGE_CACHE_URL, POOL_EDGE_CACHE_MIN_TTL_S, Scanner, RE_EVAL_WINDOW_MS, RE_EVAL_AGE_MARGIN_MIN } = require("../dist/scanner.js");`,
);

const PIN = `  await test(
    "pool window (2026-09-28) — the offline instruments read the scanner's constants instead of restating them",
    () => {
      const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

      // The values themselves: 30h window, 180min margin. If the scanner ever
      // moves them, every instrument follows at once — that is the point.
      assert.equal(RE_EVAL_WINDOW_MS, 30 * 60 * 60_000, "the tick's pool window is 30h");
      assert.equal(RE_EVAL_AGE_MARGIN_MIN, 180, "and its age margin is 180min");

      // The exports exist in the source, not just in the compiled artefact.
      const scannerSrc = read("src/scanner.ts");
      assert.ok(
        scannerSrc.includes("export const RE_EVAL_WINDOW_MS"),
        "scanner.ts exports the window so instruments can import it",
      );
      assert.ok(
        scannerSrc.includes("export const RE_EVAL_AGE_MARGIN_MIN"),
        "and the age margin",
      );

      // ...and no instrument restates them any more. A local const X = ... is
      // the exact shape of the drift this pin prevents: cpu-profile.js measured
      // a wider pool than the tick, silently, for as long as it existed.
      for (const f of [
        "scripts/cpu-profile.js",
        "scripts/test-filters.js",
        "scripts/pool-mcap-floor.js",
      ]) {
        const src = read(f);
        assert.ok(!src.includes("const RE_EVAL_WINDOW_MS ="), f + " has no local window const");
        assert.ok(!src.includes("const RE_EVAL_AGE_MARGIN_MIN ="), f + " has no local margin const");
        assert.ok(src.includes("RE_EVAL_WINDOW_MS"), f + " uses the imported window");
        assert.ok(src.includes("RE_EVAL_AGE_MARGIN_MIN"), f + " uses the imported margin");
        assert.ok(
          src.includes('require("../dist/scanner.js")'),
          f + " imports them from the scanner",
        );
      }

      // The pool size is config, not a scanner constant: test-filters must ask
      // the loaded config rather than pin 40, or an operator who sets
      // REEVAL_POOL_SIZE diagnoses a pool size the tick never uses.
      assert.ok(
        read("scripts/test-filters.js").includes("limit: cfg.reevalPoolSize,"),
        "test-filters sizes its pool query from the config it already loads",
      );
    },
  );

`;

once(
  "scripts/test-unit.js",
  `  console.log("\\n===== UNIT TESTS =====");`,
  PIN + `  console.log("\\n===== UNIT TESTS =====");`,
);

console.log(ok ? "\nall anchors applied" : "\nFAILED — a file is not as expected");
process.exit(ok ? 0 : 1);
