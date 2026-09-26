#!/usr/bin/env node
/**
 * The 🌱 有機度 line, missing again (2026-09-26): move the card-only display
 * batch IN FRONT of the RugCheck await.
 *
 * DIAGNOSIS. The line is a slot in the card-only display batch
 * (`displayBatch`), opened behind the RugCheck await and walled at
 * `enrichDeadline` = tick start + 2200ms (`SCAN_TICK_DEADLINE_MS 4200 −
 * CANDIDATE_PUSH_RESERVE_MS 1500 − CANDIDATE_GATE_TAIL_MS 500`). RugCheck's
 * `getReport` is a LIVE HTTP call on every tick — its freshness map is
 * per-isolate (`rugcheckFetchedAt`), so a recycled isolate re-fetches — which
 * put the dispatch at ~2.0-3.0s (live phase stamps: `seen` lands at 1.8-2.1s,
 * the RugCheck await follows) against a wall at +2.2s. `bestEffort` returns its
 * fallback the moment `deadline - now <= 0`, so every slot in the batch died
 * before it started. Upstream was verified healthy: all five of the day's
 * pushes (MuseXT 03:27, MAX 03:22, LESTER 03:07, DDOS 03:06, D/ACC 02:44) have
 * an `organicScore` (55-68, label medium) from a normal host.
 *
 * THE FIX IS A MOVE, not a new call: same three slots, same `enrichDeadline`,
 * only the overlap changes. Dispatching in front of the RugCheck call hands the
 * batch that call's ~0.2-0.8s — the difference between "no data" and "no
 * window" — and leaves the chain's total wall time unchanged (the batch is
 * awaited where it always was, after the Axiom step).
 *
 * Placement note: the batch stays AFTER the supply-flow gate (a flagged coin
 * continues before any display call is opened, so the batch can never be
 * wasted on a coin that will not push) and AFTER the seen-check (same reason).
 * While SUPPLY_FLOW_ENABLED is false that gate is an instant return, so this is
 * as early as the loop's own entry for every candidate that can produce a card.
 *
 * src/scanner.ts and scripts/test-unit.js are both far past the file tool's
 * edit window, so this is a verify-then-write patch.
 *
 * Run: node docs/patches/organic-dispatch-before-rugcheck-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const OLD_BLOCK = lines(
  `        // Card-only display batch, dispatched HERE — concurrently with the`,
  `        // crime check and the Axiom token-info that follow — instead of being`,
  `        // awaited one call at a time later in the chain. Two measured`,
  `        // reasons:`,
  `        //  - Serially the batch cost the SUM of its upstream round trips`,
  `        //    (~1-2.5s) while racing a single shared deadline, so whatever sat`,
  `        //    at the back of the queue started with an empty window and`,
  `        //    silently dropped off the card. Live report 2026-09-17: the`,
  `        //    Jupiter 🌱 有機度 / 1h 交易者 line stopped appearing (upstream`,
  `        //    verified healthy — the Jupiter search endpoint still returns`,
  `        //    organicScore for the same mints).`,
  `        //  - Starting it here gives the batch the chain's whole remaining`,
  `        //    window AND overlaps it with two other awaits, so the chain's`,
  `        //    total wall time drops and the gate tail below (wallet analysis,`,
  `        //    top-10 band, Flurry) starts earlier — better for the push path`,
  `        //    too.`,
  `        // Same calls, same count, same deadline: only the overlap changes.`,
  `        // Nothing in the batch gates anything — GMGN's wash-trading flag is`,
  `        // judged where the batch is awaited, and each slot that misses its`,
  `        // deadline degrades to exactly the value the old code used.`,
  `        //`,
  `        // 2026-09-25 (§4.17): the batch used to hold FIVE slots, two of them`,
  `        // Birdeye's paid card lines — \`resolveTraderData\``,
  `        // (/defi/v2/tokens/top_traders) and \`resolveHolderCount\``,
  `        // (/defi/token_overview, 20 CU). Both numbers already ride the FREE`,
  `        // Axiom summary line when it resolves, and both lines were`,
  `        // display-only (that endpoint's own numbers feed no gate — the sniper`,
  `        // FILTER was removed long ago), so the pair was pure cost: §4.14`,
  `        // measured the card path as ≥60% of a 46K CU/month run rate against a`,
  `        // 30K free tier. They are gone, endpoints included — see`,
  `        // docs/round-trips.md §4.17 for the arithmetic and for exactly what the`,
  `        // card loses. Be plain about that last part: AXIOM_ENABLED is 0 (since`,
  `        // 2026-09-19), so the Axiom line does NOT resolve today and no card`,
  `        // prints 狙擊 / 持有人 any more. The pair comes back for free the day`,
  `        // Axiom is revived; the saving is real either way.`,
  `        const jupiterOrganic = this.jupiter;`,
  `        this.markPhase(diag, "enrich-dispatch", startedAt);`,
  `        const displayBatch = Promise.all([`,
  `          this.bestEffort(`,
  `            () => this.resolveGmgnInfo(coin),`,
  `            enrichDeadline,`,
  `            null,`,
  `          ),`,
  `          this.bestEffort(`,
  `            () => this.resolveArkhamInfo(coin),`,
  `            enrichDeadline,`,
  `            null,`,
  `          ),`,
  `          this.bestEffort(`,
  `            jupiterOrganic`,
  `              ? () => jupiterOrganic.fetchOrganicScore(coin.stats.token)`,
  `              : null,`,
  `            enrichDeadline,`,
  `            null,`,
  `          ),`,
  `        ]);`,
);

const NEW_BLOCK = lines(
  `        // Card-only display batch, dispatched in FRONT of the RugCheck await`,
  `        // (2026-09-26) — concurrently with the RugCheck / crime / Axiom calls`,
  `        // that follow — instead of being awaited one call at a time later in`,
  `        // the chain. The measured reasons, in the order they were found:`,
  `        //  - Serially the batch cost the SUM of its upstream round trips`,
  `        //    (~1-2.5s) while racing a single shared deadline, so whatever sat`,
  `        //    at the back of the queue started with an empty window and`,
  `        //    silently dropped off the card. Live report 2026-09-17: the`,
  `        //    Jupiter 🌱 有機度 / 1h 交易者 line stopped appearing (upstream`,
  `        //    verified healthy — the Jupiter search endpoint still returns`,
  `        //    organicScore for the same mints).`,
  `        //  - 2026-09-26, the SAME line missing again: the dispatch had slid`,
  `        //    BEHIND the RugCheck await, and that await is a live HTTP call on`,
  `        //    every tick (its freshness map is per-isolate), so the batch was`,
  `        //    being opened at ~2.0-3.0s against its own wall at +2.2s`,
  `        //    (enrichDeadline). \`bestEffort\` returns its fallback the moment`,
  `        //    the deadline has passed — every slot died before it started. The`,
  `        //    day's five pushes were checked against a normal host: ALL had an`,
  `        //    organicScore (55-68, label medium), so the data existed and the`,
  `        //    window did not. Opening the batch in front of the RugCheck call`,
  `        //    hands it that call's ~0.2-0.8s — the difference between "no`,
  `        //    data" and "no window".`,
  `        //  - Starting it here still overlaps it with the waits that follow, so`,
  `        //    the chain's total wall time is unchanged: same calls, same count,`,
  `        //    same deadline (enrichDeadline), only the overlap changes.`,
  `        // The batch stays AFTER the supply-flow gate and AFTER the seen-check:`,
  `        // a coin that will not push must never leave three opened calls behind`,
  `        // it (while SUPPLY_FLOW_ENABLED is false the gate is an instant`,
  `        // return, so this is the loop's own entry for every card-producing`,
  `        // candidate).`,
  `        // Nothing in the batch gates anything — GMGN's wash-trading flag is`,
  `        // judged where the batch is awaited, and each slot that misses its`,
  `        // deadline degrades to exactly the value the old code used.`,
  `        //`,
  `        // 2026-09-25 (§4.17): the batch used to hold FIVE slots, two of them`,
  `        // Birdeye's paid card lines — \`resolveTraderData\``,
  `        // (/defi/v2/tokens/top_traders) and \`resolveHolderCount\``,
  `        // (/defi/token_overview, 20 CU). Both numbers already ride the FREE`,
  `        // Axiom summary line when it resolves, and both lines were`,
  `        // display-only (that endpoint's own numbers feed no gate — the sniper`,
  `        // FILTER was removed long ago), so the pair was pure cost: §4.14`,
  `        // measured the card path as ≥60% of a 46K CU/month run rate against a`,
  `        // 30K free tier. They are gone, endpoints included — see`,
  `        // docs/round-trips.md §4.17 for the arithmetic and for exactly what the`,
  `        // card loses. Be plain about that last part: AXIOM_ENABLED is 0 (since`,
  `        // 2026-09-19), so the Axiom line does NOT resolve today and no card`,
  `        // prints 狙擊 / 持有人 any more. The pair comes back for free the day`,
  `        // Axiom is revived; the saving is real either way.`,
  `        const jupiterOrganic = this.jupiter;`,
  `        this.markPhase(diag, "enrich-dispatch", startedAt);`,
  `        const displayBatch = Promise.all([`,
  `          this.bestEffort(`,
  `            () => this.resolveGmgnInfo(coin),`,
  `            enrichDeadline,`,
  `            null,`,
  `          ),`,
  `          this.bestEffort(`,
  `            () => this.resolveArkhamInfo(coin),`,
  `            enrichDeadline,`,
  `            null,`,
  `          ),`,
  `          this.bestEffort(`,
  `            jupiterOrganic`,
  `              ? () => jupiterOrganic.fetchOrganicScore(coin.stats.token)`,
  `              : null,`,
  `            enrichDeadline,`,
  `            null,`,
  `          ),`,
  `        ]);`,
);

const NEW_GUARD = `  console.log("\\n===== UNIT TESTS =====");`;

const NEW_TEST = lines(
  `  // ---------- the card-only batch is dispatched IN FRONT of RugCheck ----------`,
  `  //`,
  `  // 2026-09-26: the 🌱 有機度 line went missing again (the 2026-09-17 complaint,`,
  `  // same line). The data was there — all five of the day's pushes had an`,
  `  // organicScore (55-68) from a normal host — but the batch's dispatch had slid`,
  `  // BEHIND the RugCheck await, which is a live HTTP call on every tick (its`,
  `  // freshness map is per-isolate). A dispatch at ~2.0-3.0s against a wall at`,
  `  // +2.2s made \`bestEffort\` return its fallback the moment the deadline had`,
  `  // passed: every slot died before it started. The fix is a MOVE — same calls,`,
  `  // same deadline, only the overlap changes — and scanner.ts is far past the`,
  `  // file tool's edit window, so the order is pinned on the source.`,
  `  await test("out-of-window patch: the card-only display batch is dispatched in FRONT of RugCheck (docs/patches/organic-dispatch-before-rugcheck-2026-09-26.apply.js)", () => {`,
  `    const strip = (text) =>`,
  `      text`,
  `        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")`,
  `        .replace(/\\/\\/[^\\n]*/g, "")`,
  `        .replace(/\\s+/g, "");`,
  `    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));`,
  `    const scannerSrc = read("src/scanner.ts");`,
  `    const before = (a, b) => {`,
  `      const ia = scannerSrc.indexOf(a);`,
  `      const ib = scannerSrc.indexOf(b);`,
  `      return ia >= 0 && ib >= 0 && ia < ib;`,
  `    };`,
  `    const applied = {`,
  `      "scanner (the batch is opened before the RugCheck call, not after it)":`,
  `        before(`,
  `          'constjupiterOrganic=this.jupiter;this.markPhase(diag,"enrich-dispatch",startedAt);',`,
  `          'this.markPhase(diag,"rugcheck",startedAt);',`,
  `        ) &&`,
  `        before('construgcheck=awaitthis.bestEffort(', "const[gmgn,arkham,organic]=awaitdisplayBatch;") &&`,
  `        !before(`,
  `          'construgcheck=awaitthis.bestEffort(',`,
  `          'constjupiterOrganic=this.jupiter;this.markPhase(diag,"enrich-dispatch",startedAt);',`,
  `        ),`,
  `      "scanner (the batch itself is unchanged: three slots, one shared deadline)":`,
  `        scannerSrc.includes("constdisplayBatch=Promise.all([") &&`,
  `        scannerSrc.includes("()=>this.resolveGmgnInfo(coin),") &&`,
  `        scannerSrc.includes("()=>this.resolveArkhamInfo(coin),") &&`,
  `        scannerSrc.includes("?()=>jupiterOrganic.fetchOrganicScore(coin.stats.token):null,") &&`,
  `        scannerSrc.includes("const[gmgn,arkham,organic]=awaitdisplayBatch;"),`,
  `      "scanner (the batch still rides AFTER the supply-flow gate and the seen-check)":`,
  `        before(`,
  `          'if(flow.status==="flagged"){',`,
  `          'constjupiterOrganic=this.jupiter;this.markPhase(diag,"enrich-dispatch",startedAt);',`,
  `        ) &&`,
  `        before(`,
  `          "if(unseen.length===0)continue;",`,
  `          'constjupiterOrganic=this.jupiter;this.markPhase(diag,"enrich-dispatch",startedAt);',`,
  `        ),`,
  `    };`,
  `    const done = Object.entries(applied).filter(([, v]) => v);`,
  `    if (done.length === 0) {`,
  `      console.log(`,
  `        "  \\u2139 the organic-dispatch move is missing - apply docs/patches/organic-dispatch-before-rugcheck-2026-09-26.apply.js",`,
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
    "src/scanner.ts",
    "the batch's old dispatch point (behind the RugCheck await) goes away",
    OLD_BLOCK,
    ``,
    (src) => !src.includes(`        const jupiterOrganic = this.jupiter;\n        this.markPhase(diag, "enrich-dispatch", startedAt);\n        const displayBatch = Promise.all([\n          this.bestEffort(\n            () => this.resolveGmgnInfo(coin),\n            enrichDeadline,\n            null,\n          ),`),
  ],
  [
    "src/scanner.ts",
    "and it is re-opened in front of the RugCheck step",
    lines(
      `        // Bundler + top-10 holder share is resolved for the message card but`,
      `        // no longer filters — those filters were removed, so coins push even`,
    ),
    lines(
      NEW_BLOCK,
      `        // Bundler + top-10 holder share is resolved for the message card but`,
      `        // no longer filters — those filters were removed, so coins push even`,
    ),
    (src) =>
      src.includes(
        `        // Card-only display batch, dispatched in FRONT of the RugCheck await`,
      ),
  ],
  [
    "scripts/test-unit.js",
    "the move gets its order guard",
    NEW_GUARD,
    NEW_TEST,
    (src) => src.includes("dispatched IN FRONT of RugCheck"),
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
