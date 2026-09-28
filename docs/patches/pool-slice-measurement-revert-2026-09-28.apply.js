#!/usr/bin/env node
/**
 * pool-slice-measurement-revert-2026-09-28.apply.js
 *
 * Records the OUTCOME of the coverage raise in
 * docs/patches/front-window-coverage-2026-09-28.apply.js and takes back the one
 * lever that the measurement rejected.
 *
 * Kept (they are ceilings, so a healthy tick is unchanged):
 *   FEED_DEADLINE_MS 900 -> 1_600, POOL_FETCH_BUDGET_MS 1_600 -> 2_400,
 *   PAIRS_FETCH_BUDGET_MS 1_000 -> 2_000, SCAN_PROFILE_LIMIT 100 -> 200.
 *
 * Reverted (measured as pure cost):
 *   RE_EVAL_PER_TICK_MAX 180 -> 90.
 *
 * What was measured, 20 minutes either side of the deploy (live /health +
 * /debug/tick; the slice went 90 -> 180 and back):
 *
 *   reading            slice 90 (09:11-09:14Z)   slice 180 (09:20-09:28Z)
 *   poolSliced         90                        180
 *   agedEval           6-7                       7
 *   candidates         0-1                       0
 *   evalMs             968-1_082                 1_987-2_109
 *   heartbeat ms       1_780-2_539               3_400-3_737
 *   fails.other        119-162                   148-200
 *
 * Doubling the slice doubled the coins JUDGED and changed nothing about the
 * coins that mattered. The extra judgments land in `fails.other` (the liquidity
 * / 24h-volume gates), because the pool read is dominated by coins whose
 * liquidity has already collapsed: they die on the first gate, before the age
 * check and the momentum gates, so widening the window buys dust, not
 * candidates. In-window coins are already served every scan by the SQL rotation
 * bands (the hot zone), which is why agedEval does not move with this constant.
 *
 * The caps stay because a cap is a ceiling, not a spend: measured feedsMs
 * (756-780ms) and poolMs (129-405ms) are IDENTICAL before and after, so the
 * wider ceilings cost nothing on a healthy tick and only change the ticks where
 * an upstream is slow enough to be cut. PAIRS_FETCH_BUDGET_MS is the one that
 * was genuinely binding (`pairs` 83 of ~112 requested while the phase rode its
 * 1,000ms cap).
 *
 * Idempotent, span-based (locates the note block by its marker and cuts to the
 * constant), so a replay can never half-apply it.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const SCANNER = path.join(__dirname, "..", "..", "src", "scanner.ts");
const WRANGLER = path.join(__dirname, "..", "..", "wrangler.toml");

const NEW_SLICE_NOTE =
  " * 2026-09-28 (90 \u2192 180: TRIED, MEASURED, REVERTED to 90). The reasoning for the\n" +
  " * raise was sound on paper \u2014 the paid plan removed the 3550ms claim gate that\n" +
  " * forced the 2026-09-19 cut, the chain deadline is 6_500ms now, and the pair\n" +
  " * window was doubled to feed a bigger slice \u2014 and it was run live for 20\n" +
  " * minutes. The measurement says this constant is NOT what bounds coins-per-tick:\n" +
  " *\n" +
  " *   reading          slice 90 (09:11\u201309:14Z)   slice 180 (09:20\u201309:28Z)\n" +
  " *   poolSliced       90                        180\n" +
  " *   agedEval         6\u20137                       7\n" +
  " *   candidates       0\u20131                       0\n" +
  " *   evalMs           968\u20131_082                 1_987\u20132_109\n" +
  " *   heartbeat ms     1_780\u20132_539               3_400\u20133_737\n" +
  " *   fails.other      119\u2013162                   148\u2013200\n" +
  " *\n" +
  " * The extra 90 judgments land almost entirely in `fails.other` \u2014 the liquidity\n" +
  " * and 24h-volume gates. The pool read is dominated by coins whose liquidity has\n" +
  " * already collapsed below the gate, and an old coin dies on that FIRST gate,\n" +
  " * before the age check and before the momentum gates. In-window coins are\n" +
  " * already served every scan by the SQL rotation bands (the hot zone), which is\n" +
  " * why agedEval does not move with this number: the wider slice buys judgments of\n" +
  " * dust, not candidates, and pays ~1s of CPU per tick (evalMs) plus ~1.2s of tick\n" +
  " * wall clock for them. Reverted \u2014 the constant is back at 90.\n" +
  " *\n" +
  " * Where this measurement points instead is the pool's COIN MIX, not the window:\n" +
  " * /debug/pool reports 16.8K never-pushed coins eligible in the age window while\n" +
  " * one tick reads ~350\u2013520 of them and only ~7 of the ~200 it judges reach the\n" +
  " * age + momentum gates. The liquidity prune (minQualifyLiquidity), the band\n" +
  " * limits and RE_EVAL_POOL_SIZE are the levers denominated in that gap \u2014 move\n" +
  " * one of them with a measurement like this one, not this slice again.\n" +
  " */\n" +
  "const RE_EVAL_PER_TICK_MAX = 90;";

const SLICE_START = " * 2026-09-28 (90 \u2192 180, Workers Paid): BOTH conditions";
const SLICE_END = "const RE_EVAL_PER_TICK_MAX = 180;";
const SLICE_MARKER = "TRIED, MEASURED, REVERTED to 90";

const edits = [
  {
    file: SCANNER,
    label: "RE_EVAL_PER_TICK_MAX 180 -> 90 (measured as pure cost)",
    marker: SLICE_MARKER,
    apply(text) {
      const from = text.indexOf(SLICE_START);
      const to = text.indexOf(SLICE_END);
      if (from === -1 || to === -1 || to < from) {
        return { error: `slice note span not found (start ${from}, end ${to})` };
      }
      return {
        text:
          text.slice(0, from) +
          NEW_SLICE_NOTE +
          text.slice(to + SLICE_END.length),
      };
    },
  },
  {
    file: SCANNER,
    label: "SCAN_TICK_DEADLINE_MS note: the slice clause is dropped",
    marker: "the rotation slice was doubled",
    anchor:
      " * (sum 6_000 of the 6_400ms window) and RE_EVAL_PER_TICK_MAX 90 \u2192 180.\n" +
      " * Each cap keeps its documented meaning",
    replace:
      " * (sum 6_000 of the 6_400ms window). Each cap keeps its documented meaning",
    second:
      " * that the cap was being hit and the coins behind it were dropped.\n */",
    secondReplace:
      " * that the cap was being hit and the coins behind it were dropped.\n" +
      " *\n" +
      " * 2026-09-28 (measured, same day): the rotation slice was doubled alongside\n" +
      " * these caps and REVERTED \u2014 it bought judgments of the pool's dead-liquidity\n" +
      " * tail, not candidates (see the RE_EVAL_PER_TICK_MAX note for the numbers).\n */",
  },
  {
    file: SCANNER,
    label: "POOL_FETCH_BUDGET_MS note: the slice clause is corrected",
    marker: "the ceiling for the deeper read a bigger rotation slice",
    anchor:
      " * and, now, the ceiling for a BIGGER read: the rotation slice doubled\n" +
      " * (RE_EVAL_PER_TICK_MAX 90 \u2192 180) out of the same RE_EVAL_POOL_SIZE 1_000-row\n" +
      " * query. Keeping it",
    replace:
      " * and the ceiling for the deeper read a bigger rotation slice would need (see\n" +
      " * the RE_EVAL_PER_TICK_MAX note: that slice was doubled experimentally on\n" +
      " * 2026-09-28 and reverted, so this cap is headroom today). Keeping it",
  },
  {
    file: WRANGLER,
    label: "DEX_REQUEST_INTERVAL_MS note: the pair window's real reason",
    marker: "the reason is measured rather than theoretical",
    anchor:
      "# 2026-09-28 (Workers Paid): the pair window is PAIRS_FETCH_BUDGET_MS 2,000\n" +
      "# now, not 1,000 \u2014 8 dispatch slots at THIS spacing = 240 addresses, sized\n" +
      "# against the doubled rotation slice (scanner.RE_EVAL_PER_TICK_MAX 90 \u2192 180\n" +
      "# plus the feed's ~22). The 2026-09-19 cut to 1,000 existed to hand the free\n" +
      "# plan's 3550ms claim gate its time; the chain deadline is 6_500ms now. This is the",
    replace:
      "# 2026-09-28 (Workers Paid): the pair window is PAIRS_FETCH_BUDGET_MS 2,000\n" +
      "# now, not 1,000, and the reason is measured rather than theoretical. The\n" +
      "# request is ~112 addresses (the 90-coin rotation slice plus the feed's ~22)\n" +
      "# = 4 batches of 30, and at this spacing the fourth batch cannot START before\n" +
      "# ~750ms and then has to answer \u2014 which is why the live `pairs` reading was\n" +
      "# 83 of ~112 while the phase rode its 1,000ms cap. 2,000 gives the phase 8\n" +
      "# slots (240 addresses) so the request is fetched WHOLE, and it doubles as\n" +
      "# headroom for the tracker head and for any future slice raise (the 180-coin\n" +
      "# slice was tried on 2026-09-28 and reverted \u2014 see scanner.\n" +
      "# RE_EVAL_PER_TICK_MAX). The 2026-09-19 cut to 1,000 existed to hand the free\n" +
      "# plan's 3550ms claim gate its time; the chain deadline is 6_500ms now. This is the",
  },
  // Fix-ups LAST (they touch text the edits above produce or leave behind).
  {
    file: SCANNER,
    label: "SCAN_TICK_DEADLINE_MS note: restore the two lines an earlier patch ate",
    marker: " * beneficiary: it keeps its 1_600ms reserve and gains the front phases' slack.",
    anchor:
      " * phase as little as 100ms once the feeds and the pool read rode their own\n\n *\n",
    replace:
      " * phase as little as 100ms once the feeds and the pool read rode their own\n" +
      " * caps. The gate chain \u2014 the only phase that can push a coin \u2014 is the\n" +
      " * beneficiary: it keeps its 1_600ms reserve and gains the front phases' slack.\n" +
      " *\n",
  },
  {
    file: SCANNER,
    label: "SCAN_TICK_DEADLINE_MS note: rewrap the paragraph line",
    marker: " * a ceiling for a SLOW phase, never a cost on a healthy one",
    anchor:
      " * (sum 6_000 of the 6_400ms window). Each cap keeps its documented meaning \u2014 a ceiling for a SLOW phase, never\n" +
      " * a cost on a healthy one \u2014 so this is not a trade against the gates: it",
    replace:
      " * (sum 6_000 of the 6_400ms window). Each cap keeps its documented meaning \u2014\n" +
      " * a ceiling for a SLOW phase, never a cost on a healthy one \u2014 so this is not a\n" +
      " * trade against the gates: it",
  },
  {
    file: SCANNER,
    label: "POOL_FETCH_BUDGET_MS note: rewrap the paragraph line",
    marker: " * comfortably above the DB layer's 1_440ms hard wall",
    anchor:
      " * 2026-09-28 and reverted, so this cap is headroom today). Keeping it comfortably above the DB layer's 1_440ms hard wall is\n" +
      " * what makes a failed read arrive as an ERROR",
    replace:
      " * 2026-09-28 and reverted, so this cap is headroom today). Keeping it\n" +
      " * comfortably above the DB layer's 1_440ms hard wall is what makes a failed\n" +
      " * read arrive as an ERROR",
  },
];

function main() {
  const scanner = fs.readFileSync(SCANNER, "utf8");
  const wrangler = fs.readFileSync(WRANGLER, "utf8");
  const source = new Map([
    [SCANNER, scanner],
    [WRANGLER, wrangler],
  ]);

  const problems = [];
  const writes = new Map();
  let changed = 0;
  let already = 0;

  for (const edit of edits) {
    const text = source.get(edit.file);
    if (edit.apply) {
      if (text.includes(edit.marker)) {
        console.log(`  = ${edit.label} (already applied)`);
        already++;
        continue;
      }
      const out = edit.apply(text);
      if (out.error) {
        problems.push(`${edit.label}: ${out.error}`);
        console.log(`  \u2717 ${edit.label}`);
        continue;
      }
      source.set(edit.file, out.text);
      writes.set(edit.file, out.text);
      changed++;
      console.log(`  \u2713 ${edit.label}`);
      continue;
    }
    if (edit.marker && text.includes(edit.marker)) {
      console.log(`  = ${edit.label} (already applied)`);
      already++;
      continue;
    }
    const pairs = [
      [edit.anchor, edit.replace],
      ...(edit.second ? [[edit.second, edit.secondReplace]] : []),
    ];
    let next = text;
    let ok = true;
    for (const [anchor, replace] of pairs) {
      const hits = next.split(anchor).length - 1;
      if (hits !== 1) {
        problems.push(`${edit.label}: anchor found ${hits}x (expected 1)`);
        ok = false;
        break;
      }
      next = next.replace(anchor, replace);
    }
    if (!ok) {
      console.log(`  \u2717 ${edit.label}`);
      continue;
    }
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

  for (const [file, next] of writes) fs.writeFileSync(file, next, "utf8");
  console.log(`\n${changed} edit(s) applied, ${already} already in place.`);

  // Final-state arithmetic: the delivered numbers must still fit and feed.
  const s = fs.readFileSync(SCANNER, "utf8");
  const d = fs.readFileSync(WRANGLER, "utf8");
  const dex = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "dexscreener.ts"),
    "utf8",
  );
  const val = (src, name) => {
    const m = src.match(new RegExp(`(?:const|#)\\s*${name} = ([0-9_]+);`));
    if (!m) throw new Error(`${name} not found`);
    return Number(m[1].replace(/_/g, ""));
  };
  const deadline = val(s, "SCAN_TICK_DEADLINE_MS");
  const gate = val(s, "SCAN_GATE_RESERVE_MS");
  const feed = val(s, "FEED_DEADLINE_MS");
  const pool = val(s, "POOL_FETCH_BUDGET_MS");
  const slice = val(s, "RE_EVAL_PER_TICK_MAX");
  const pairs = val(dex, "PAIRS_FETCH_BUDGET_MS");
  const profileLimit = Number(d.match(/SCAN_PROFILE_LIMIT = "([0-9]+)"/)[1]);
  const window_ = deadline - gate;
  const slots = Math.floor(pairs / 250);
  console.log("\n  delivered:");
  console.log(`    slice ${slice}, profile limit ${profileLimit}`);
  console.log(`    front window ${window_}ms, caps ${feed} + ${pool} + ${pairs} = ${feed + pool + pairs}ms`);
  console.log(`    pair slots ${slots} x 30 = ${slots * 30} addresses for slice ${slice} + feed ~22`);
  if (feed + pool + pairs > window_) {
    console.error("  \u2717 the front caps exceed the front window");
    process.exit(1);
  }
  if (slots * 30 < slice + 22) {
    console.error("  \u2717 the pair window cannot fetch the slice");
    process.exit(1);
  }
  console.log("  \u2713 caps fit the window and the pair window covers the slice whole");
  process.exit(0);
}

main();
