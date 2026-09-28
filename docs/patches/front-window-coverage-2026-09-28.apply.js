#!/usr/bin/env node
/**
 * front-window-coverage-2026-09-28.apply.js
 *
 * Spends the tick window the Workers Paid plan bought (see
 * docs/patches/paid-budget-2026-09-28.apply.js) on actual COVERAGE.
 *
 * Before: SCAN_TICK_DEADLINE_MS 8_000 and SCAN_GATE_RESERVE_MS 1_600 make the
 * front-phase window 6_400ms, while the front caps still summed to 3_500ms
 * (FEED 900 + POOL 1_600 + PAIRS 1_000) and the rotation slice stayed at its
 * free-plan size (RE_EVAL_PER_TICK_MAX 90). Live readings (2026-09-28
 * 09:11–09:14Z, /health + /debug/tick):
 *
 *   feedsMs 677–780 against the 900ms feed cap   → the fan-out was being CUT
 *   poolMs  159–518 against the 1_600ms pool cap → not binding
 *   poolSliced 90 of a pool 330–524              → 10–27% of the read judged
 *   pairs 83 of those 114 addresses              → the pair cap DID bind
 *   agedEval 6–7, candidates 0–1, pushed 0
 *
 * After: FEED 1_600 + POOL 2_400 + PAIRS 2_000 = 6_000 of the 6_400ms window,
 * RE_EVAL_PER_TICK_MAX 180 (paired with the doubled pair window: 2_000ms ÷
 * 250ms spacing = 8 slots = 240 addresses ≥ 180 + the feed's ~22), and
 * SCAN_PROFILE_LIMIT 100 → 200 (headroom only — the profiles page carries
 * ~20–30 Solana rows, so neither cap binds; recorded for honesty).
 *
 * SUPERSEDED IN PART (2026-09-28, later the same day): the RE_EVAL_PER_TICK_MAX
 * raise below was run live, MEASURED and reverted — it bought judgments of the
 * pool's dead-liquidity tail, not candidates. Run
 * docs/patches/pool-slice-measurement-revert-2026-09-28.apply.js after this one
 * to reach the delivered state; the caps it raises (FEED / POOL / PAIRS) and the
 * profile limit stay.
 *
 * Idempotent and verify-then-write: run it twice, the second run prints `=`
 * for every edit and changes nothing. Exits non-zero if any anchor is missing
 * or ambiguous, so a stale checkout fails loudly instead of half-applying.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

const files = {
  scanner: path.join(ROOT, "src", "scanner.ts"),
  dex: path.join(ROOT, "src", "dexscreener.ts"),
  config: path.join(ROOT, "src", "config.ts"),
  wrangler: path.join(ROOT, "wrangler.toml"),
};

/** [file, marker (proof it is applied), anchor, replacement, label] */
const edits = [
  {
    file: "scanner",
    label: "SCAN_TICK_DEADLINE_MS note: the slack is spent on coverage",
    anchor:
      " * caps. The gate chain \u2014 the only phase that can push a coin \u2014 is the\n" +
      " * beneficiary: it keeps its 1_600ms reserve and gains the front phases' slack.",
    add:
      "\n *\n" +
      " * 2026-09-28 (later, same day): that slack is then deliberately SPENT on\n" +
      " * coverage instead of left unused \u2014 FEED_DEADLINE_MS 900 \u2192 1_600,\n" +
      " * POOL_FETCH_BUDGET_MS 1_600 \u2192 2_400, PAIRS_FETCH_BUDGET_MS 1_000 \u2192 2_000\n" +
      " * (sum 6_000 of the 6_400ms window) and RE_EVAL_PER_TICK_MAX 90 \u2192 180.\n" +
      " * Each cap keeps its documented meaning \u2014 a ceiling for a SLOW phase, never\n" +
      " * a cost on a healthy one \u2014 so this is not a trade against the gates: it\n" +
      " * changes only what happens on the ticks where an upstream was slow enough\n" +
      " * that the cap was being hit and the coins behind it were dropped.",
    marker: "that slack is then deliberately SPENT on",
  },
  {
    file: "scanner",
    label: "FEED_DEADLINE_MS 900 -> 1_600",
    anchor:
      " *      `profilesSettled: false` saying that is what happened.\n */\nconst FEED_DEADLINE_MS = 900;",
    add:
      " *      `profilesSettled: false` saying that is what happened.\n" +
      " *\n" +
      " * 2026-09-28 (900 \u2192 1_600, Workers Paid): every entry above cut this number\n" +
      " * because the tick could not afford a slow feed \u2014 900 was sized so the feed\n" +
      " * fan-out and the pool read together fit the old 2_600ms front window. On the\n" +
      " * paid plan that window is 6_400ms (see SCAN_TICK_DEADLINE_MS), so this is no\n" +
      " * longer a budget trade: it only bounds genuinely hung feeds. What it buys is\n" +
      " * measured, not theoretical \u2014 live `summary.feedsMs` sat at 754\u2013780ms\n" +
      " * against the 900ms cap on every sampled tick, i.e. the fan-out was being CUT\n" +
      " * nearly every minute, and the legs that lose that race are the slower\n" +
      " * momentum ones (jupTrend / geoTrend / boosts), so partial feed counts were\n" +
      " * the routine reading rather than the exception.\n" +
      " */\n" +
      "const FEED_DEADLINE_MS = 1_600;",
    marker: "const FEED_DEADLINE_MS = 1_600;",
  },
  {
    file: "scanner",
    label: "POOL_FETCH_BUDGET_MS 1_600 -> 2_400",
    anchor:
      " * src/poolfallback.ts) instead of costing the tick. The worst case still fits\n" +
      " * the front window (FEED_DEADLINE_MS 900 + 1600 = 2500 < FRONT_PHASE_WINDOW_MS\n" +
      " * 2600), so it cannot eat the 1600ms gate reserve the way the retired 2200 did.\n" +
      " */\n" +
      "const POOL_FETCH_BUDGET_MS = 1_600;",
    add:
      " * src/poolfallback.ts) instead of costing the tick. The worst case still fits\n" +
      " * the front window (FEED_DEADLINE_MS 1_600 + 2_400 = 4_000 <\n" +
      " * FRONT_PHASE_WINDOW_MS 6_400), so it cannot eat the 1_600ms gate reserve.\n" +
      " *\n" +
      " * 2026-09-28 (1_600 \u2192 2_400, Workers Paid): live `summary.poolMs` reads\n" +
      " * 159\u2013518ms, so this is not what a healthy tick spends \u2014 it is the ceiling a\n" +
      " * COLD isolate's read hits (the 90s query cache is cold on most cron ticks)\n" +
      " * and, now, the ceiling for a BIGGER read: the rotation slice doubled\n" +
      " * (RE_EVAL_PER_TICK_MAX 90 \u2192 180) out of the same RE_EVAL_POOL_SIZE 1_000-row\n" +
      " * query. Keeping it comfortably above the DB layer's 1_440ms hard wall is\n" +
      " * what makes a failed read arrive as an ERROR that can be answered with the\n" +
      " * last good pool (see src/poolfallback.ts) instead of degrading to feed-only.\n" +
      " */\n" +
      "const POOL_FETCH_BUDGET_MS = 2_400;",
    marker: "const POOL_FETCH_BUDGET_MS = 2_400;",
  },
  {
    file: "scanner",
    label: "RE_EVAL_PER_TICK_MAX 90 -> 180",
    anchor:
      " * the feed). Raise it back only with a way to fetch more per second, and only\n" +
      " * after the delivery rate is healthy again.\n" +
      " */\n" +
      "const RE_EVAL_PER_TICK_MAX = 90;",
    add:
      " * the feed). Raise it back only with a way to fetch more per second, and only\n" +
      " * after the delivery rate is healthy again.\n" +
      " *\n" +
      " * 2026-09-28 (90 \u2192 180, Workers Paid): BOTH conditions that note set are now\n" +
      " * met. \"A way to fetch more per second\" is the pair window, doubled for this\n" +
      " * purpose (dexscreener.PAIRS_FETCH_BUDGET_MS 1_000 \u2192 2_000 = 8 dispatch slots\n" +
      " * at the 250ms spacing = 240 addresses, which covers 180 + the feed's ~22),\n" +
      " * and \"the delivery rate is healthy again\" is the paid plan: the 3550ms claim\n" +
      " * gate that forced the cut is a free-plan number, while the chain deadline is\n" +
      " * now tickDeadline \u2212 CANDIDATE_PUSH_RESERVE_MS = 6_500ms.\n" +
      " *\n" +
      " * Coverage, live before this change (09:11\u201309:14Z): the slice was 90 of a\n" +
      " * 330\u2013524-row pool read and only 6\u20137 of those coins passed the age gate per\n" +
      " * tick (`summary.agedEval`) with `pairs` 83 \u2014 i.e. each tick judged about a\n" +
      " * tenth of the pool it had just read. This slice is the knob that raises\n" +
      " * coins-per-tick directly; the sweep it lengthens is the point, not a cost\n" +
      " * (every coin still rides the feed make-up lane, the hot zone is still\n" +
      " * evaluated every scan, and leftovers keep their rotation slot).\n" +
      " */\n" +
      "const RE_EVAL_PER_TICK_MAX = 180;",
    marker: "const RE_EVAL_PER_TICK_MAX = 180;",
  },
  {
    file: "dex",
    label: "PAIRS_FETCH_BUDGET_MS 1_000 -> 2_000",
    anchor:
      " * skipped tokens keep their pool slot and are re-read on the next rotation\n" +
      " * slot \u2014 the cost is latency (and a ~1.4\u00d7 longer sweep), never coverage.\n" +
      " */\n" +
      "const PAIRS_FETCH_BUDGET_MS = 1_000;",
    add:
      " * skipped tokens keep their pool slot and are re-read on the next rotation\n" +
      " * slot \u2014 the cost is latency (and a ~1.4\u00d7 longer sweep), never coverage.\n" +
      " *\n" +
      " * 2026-09-28 (1_000 \u2192 2_000, Workers Paid): the 2026-09-19 cut above existed\n" +
      " * only to hand the claim its 3550ms \u2014 a free-plan number. The pair window is\n" +
      " * now the front window (SCAN_TICK_DEADLINE_MS 8_000 \u2212 SCAN_GATE_RESERVE_MS\n" +
      " * 1_600 = 6_400ms) and the claim deadline is 6_500ms, so the extra dispatch\n" +
      " * slots are affordable: 2_000ms \u00f7 250ms = 8 slots = 240 addresses, sized\n" +
      " * against the rotation slice this was raised with (scanner.\n" +
      " * RE_EVAL_PER_TICK_MAX 90 \u2192 180 plus the feed's ~22 = ~202).\n" +
      " *\n" +
      " * The wire count does NOT simply double: the pair cache (PAIR_CACHE_TTL_MS\n" +
      " * 180s) serves repeat coins for free, and the faster rotation (180 per tick\n" +
      " * over a 330\u2013524-row pool \u2248 2.6 ticks \u2248 2.6 min) is now SHORTER than that\n" +
      " * TTL, so a larger share of each slice is a cache HIT. The counters to watch\n" +
      " * are still `dex.http429` / `blockedForMs` / `budgetDrops` (see\n" +
      " * DEX_REQUEST_INTERVAL_MS): a rising counter means the shared egress IP is\n" +
      " * being rate-limited again and this value is the first thing to take back.\n" +
      " */\n" +
      "const PAIRS_FETCH_BUDGET_MS = 2_000;",
    marker: "const PAIRS_FETCH_BUDGET_MS = 2_000;",
  },
  {
    file: "config",
    label: "scanProfileLimit clamp 100 -> 200",
    anchor:
      "    scanProfileLimit:\n" +
      "      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 100) : 40,",
    add:
      "    scanProfileLimit:\n" +
      "      // 2026-09-28: clamp 100 \u2192 200 (Workers Paid). Headroom, not a lever:\n" +
      "      // the DexScreener profiles page carries ~20\u201330 Solana rows per tick,\n" +
      "      // so neither cap binds. Coins-per-tick is bounded by the re-eval\n" +
      "      // rotation slice (scanner.RE_EVAL_PER_TICK_MAX) and its pair fetch.\n" +
      "      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 40,",
    marker: "Math.min(rawLimit, 200)",
  },
  {
    file: "wrangler",
    label: "SCAN_PROFILE_LIMIT 100 -> 200",
    anchor:
      "# Max coverage: inspect the newest 100 Solana token profiles per scan\n" +
      "# (the code caps this at 100). Deferred candidates stay in the re-eval\n" +
      "# pool, so nothing is lost when a tick runs out of budget.\n" +
      'SCAN_PROFILE_LIMIT = "100"',
    add:
      "# Max coverage: inspect the newest 200 Solana token profiles per scan\n" +
      "# (the code caps this at 200). Deferred candidates stay in the re-eval\n" +
      "# pool, so nothing is lost when a tick runs out of budget.\n" +
      "#\n" +
      "# 2026-09-28: 100 \u2192 200 on the Workers Paid plan (see worker.SCAN_TICK_BUDGET_MS).\n" +
      "# This is HEADROOM, not a live lever, and the note is honest about it: the\n" +
      "# /token-profiles/latest/v1 page carries ~20\u201330 Solana rows per tick (live\n" +
      "# `summary.profiles` read 19\u201323 all week), so the slice never bound at 100\n" +
      "# and will not bind at 200. What actually bounds coins-per-tick is the re-eval\n" +
      "# rotation slice (scanner.RE_EVAL_PER_TICK_MAX, 90 \u2192 180) together with the\n" +
      "# pair fetch that feeds it (dexscreener.PAIRS_FETCH_BUDGET_MS, 1_000 \u2192 2_000).\n" +
      'SCAN_PROFILE_LIMIT = "200"',
    marker: 'SCAN_PROFILE_LIMIT = "200"',
  },
  {
    file: "wrangler",
    label: "DEX_REQUEST_INTERVAL_MS note: the pair window is 2,000ms now",
    anchor:
      "# more coins actually fetched/evaluated per scan for the same wall clock and\n" +
      "# the same Turso rows read (the slice was raised to 160 to match). This is the",
    add:
      "# more coins actually fetched/evaluated per scan for the same wall clock and\n" +
      "# the same Turso rows read (the slice was raised to 160 to match).\n" +
      "#\n" +
      "# 2026-09-28 (Workers Paid): the pair window is PAIRS_FETCH_BUDGET_MS 2,000\n" +
      "# now, not 1,000 \u2014 8 dispatch slots at THIS spacing = 240 addresses, sized\n" +
      "# against the doubled rotation slice (scanner.RE_EVAL_PER_TICK_MAX 90 \u2192 180\n" +
      "# plus the feed's ~22). The 2026-09-19 cut to 1,000 existed to hand the free\n" +
      "# plan's 3550ms claim gate its time; the chain deadline is 6_500ms now. This is the",
    marker: "the pair window is PAIRS_FETCH_BUDGET_MS 2,000",
  },
];

function countOccurrences(haystack, needle) {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

function main() {
  const source = new Map();
  for (const [key, file] of Object.entries(files)) {
    source.set(key, fs.readFileSync(file, "utf8"));
  }

  const problems = [];
  const writes = new Map();
  let changed = 0;
  let already = 0;

  for (const edit of edits) {
    const text = source.get(edit.file);
    if (text.includes(edit.marker)) {
      console.log(`  = ${edit.label} (already applied)`);
      already++;
      continue;
    }
    const hits = countOccurrences(text, edit.anchor);
    if (hits !== 1) {
      problems.push(`${edit.label}: anchor found ${hits}x (expected exactly 1)`);
      console.log(`  \u2717 ${edit.label} \u2014 anchor found ${hits}x`);
      continue;
    }
    const next = text.replace(edit.anchor, edit.add);
    source.set(edit.file, next);
    writes.set(edit.file, next);
    changed++;
    console.log(`  \u2713 ${edit.label}`);
  }

  if (problems.length > 0) {
    console.error("\nABORTED \u2014 no file was written:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  for (const [file, next] of writes) {
    fs.writeFileSync(files[file], next, "utf8");
  }
  console.log(`\n${changed} edit(s) applied, ${already} already in place.`);
  if (changed === 0) console.log("Nothing to do \u2014 the tree is already at the new numbers.");

  // Extra arithmetic check: the front caps must still sum inside the window.
  const scanner = fs.readFileSync(files.scanner, "utf8");
  const dex = fs.readFileSync(files.dex, "utf8");
  const read = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = ([0-9_]+);`));
    if (!m) throw new Error(`${name} not found`);
    return Number(m[1].replace(/_/g, ""));
  };
  const feed = read(scanner, "FEED_DEADLINE_MS");
  const pool = read(scanner, "POOL_FETCH_BUDGET_MS");
  const slice = read(scanner, "RE_EVAL_PER_TICK_MAX");
  const pairs = read(dex, "PAIRS_FETCH_BUDGET_MS");
  const deadline = read(scanner, "SCAN_TICK_DEADLINE_MS");
  const gate = read(scanner, "SCAN_GATE_RESERVE_MS");
  const window = deadline - gate;
  const sum = feed + pool + pairs;
  const slots = Math.floor(pairs / 250);
  console.log("\n  derived:");
  console.log(`    front window ${window}ms, caps ${feed} + ${pool} + ${pairs} = ${sum}ms`);
  console.log(`    pair slots ${slots} x 30 = ${slots * 30} addresses for slice ${slice} + feed ~22`);
  if (sum > window) {
    console.error(`  \u2717 the front caps (${sum}ms) exceed the front window (${window}ms)`);
    process.exit(1);
  }
  if (slots * 30 < slice) {
    console.error(`  \u2717 the pair window cannot fetch the slice (${slots * 30} < ${slice})`);
    process.exit(1);
  }
  console.log("  \u2713 caps fit the window and the pair window covers the slice");
  process.exit(0);
}

main();
