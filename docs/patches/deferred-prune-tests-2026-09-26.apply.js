#!/usr/bin/env node
/**
 * Deferred-prune tests (2026-09-26): the rule's behaviour, the durable
 * retirement cursor, and the out-of-window wiring guard.
 *
 * Three layers, in the order the failure would hurt:
 *
 *  1. BEHAVIOUR (dist/deferredmakeup.js, offline): an obligation whose coin
 *     every enabled chat would reject on age is retired on the first
 *     observation; a live (or too-fresh) one is kept; the no-pair case needs a
 *     run of DEFERRED_PRUNE_ATTEMPTS misses and any reachable observation
 *     resets that run; a token the registry does not hold is never touched.
 *     The probe view is asserted with it, because that is what the operator
 *     will read.
 *  2. THE DURABLE CURSOR (dist/deferrallog.js): retirements accumulate, stamp
 *     first/last once, ride the `applied` marker, and a legacy row reads
 *     0/null — INCLUDING the dedupe edge that matters: a marker written
 *     before the counter existed must never ACK a live retirement delta.
 *     The delta's null test is what keeps a prune-only tick writing the row
 *     (that write is what persists the shrunken pending list).
 *  3. THE WIRING (source, out-of-window): scanner.ts observes the coin with
 *     the gate's own age input at the widest enabled window and BEFORE the
 *     `if (!pair) continue;` that would skip the no-pair case; the ledger and
 *     the summary carry the cursor; worker.ts folds it into totals → delta →
 *     the no-op guard; and /debug/deferral publishes both halves.
 *
 * scripts/test-unit.js is far past the file tool's edit window, so this is a
 * verify-then-write patch.
 *
 * Run: node docs/patches/deferred-prune-tests-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const NEW_GUARD = `  console.log("\\n===== UNIT TESTS =====");`;

const NEW_TEST = lines(
  `  // ---------- an obligation that can never be paid is RETIRED ----------------`,
  `  //`,
  `  // 2026-09-26, from the operator's "呢 20 條係永遠追唔返嘅舊欠單 … 可以怎樣清`,
  `  // 理". The measured shape: \`deferral.pending\` pinned at 20 while every tick`,
  `  // injected 8 make-up coins (\`feedMakeup.injectedTotal 8\`), the 8 oldest`,
  `  // measured (launch_ms via /debug/token) at 47.6/120.2/126.2/156.4/165.1/`,
  `  // 165.3/166.6/167.0 h against the widest enabled chat's 26 h max age — and`,
  `  // because missingDeferredTokens is OLDEST-FIRST, those 8 spent every slot`,
  `  // while a genuine 7.7 h obligation sat last in the queue and never got one.`,
  `  //`,
  `  // The rule retires an obligation when the AGE GATE ITSELF would reject the`,
  `  // coin in every chat (the registry is handed the same facts the gate decides`,
  `  // on), with a three-observation run for the soft "no pair data" case. It can`,
  `  // only ever REMOVE an obligation: a coin the user is still owed keeps its`,
  `  // place in the re-evaluation pool, so the worst case is a lost make-up`,
  `  // priority, never a lost card.`,
  `  await test("deferredmakeup: an unpayable obligation is retired, a live one is kept", () => {`,
  `    const dm = require(path.join(__dirname, "..", "dist", "deferredmakeup.js"));`,
  `    dm.resetDeferredRegistry();`,
  `    const WINDOW = 1560 * 60_000; // the live widest chat: 26h`,
  `    const OLD = 167 * 3600_000; // the measured zombie: 6.9 days`,
  ``,
  `    // A coin no enabled chat could accept: retired on the FIRST observation.`,
  `    dm.addDeferredToken("ZOMBIE", 1_000);`,
  `    assert.equal(dm.isDeferredToken("ZOMBIE"), true);`,
  `    assert.equal(`,
  `      dm.noteDeferredCoin("ZOMBIE", { ageMs: OLD, windowMaxAgeMs: WINDOW }, 2_000),`,
  `      true,`,
  `      "too old for every chat → retired immediately",`,
  `    );`,
  `    assert.equal(dm.isDeferredToken("ZOMBIE"), false, "and it leaves the queue");`,
  `    assert.equal(dm.deferredPrunedTotal(), 1);`,
  `    assert.equal(dm.deferredTokenList().length, 0, "so the next entry gets the make-up slot");`,
  ``,
  `    // In-window and too-FRESH are both live: a young coin ages INTO the window,`,
  `    // so "too fresh" is never a retirement.`,
  `    dm.addDeferredToken("LIVE", 1_000);`,
  `    dm.addDeferredToken("FRESH", 1_000);`,
  `    assert.equal(`,
  `      dm.noteDeferredCoin("LIVE", { ageMs: 7.7 * 3600_000, windowMaxAgeMs: WINDOW }, 2_000),`,
  `      false,`,
  `    );`,
  `    assert.equal(`,
  `      dm.noteDeferredCoin("FRESH", { ageMs: 10 * 60_000, windowMaxAgeMs: WINDOW }, 2_000),`,
  `      false,`,
  `      "too fresh is NOT a retirement",`,
  `    );`,
  `    assert.equal(dm.deferredTokenList().length, 2);`,
  ``,
  `    // The soft case: no pair data needs a RUN of misses, and any reachable`,
  `    // observation in between resets it (a live coin can miss one batch to a`,
  `    // budget cut, a 429 or a last-good feed reuse).`,
  `    dm.addDeferredToken("GONE", 1_000);`,
  `    const miss = () =>`,
  `      dm.noteDeferredCoin("GONE", { ageMs: null, windowMaxAgeMs: WINDOW }, 2_000);`,
  `    assert.equal(miss(), false, "1st miss: an upstream answer can miss a live coin");`,
  `    assert.equal(miss(), false, "2nd miss: still slack");`,
  `    assert.equal(`,
  `      dm.noteDeferredCoin("GONE", { ageMs: 3600_000, windowMaxAgeMs: WINDOW }, 2_000),`,
  `      false,`,
  `      "a reachable observation resets the run",`,
  `    );`,
  `    assert.equal(miss(), false);`,
  `    assert.equal(miss(), false);`,
  `    assert.equal(miss(), true, "3 consecutive misses → retired");`,
  `    assert.equal(dm.isDeferredToken("GONE"), false);`,
  ``,
  `    // The rule only touches obligations it holds, and a repeated deferral does`,
  `    // not reset the misses (a re-deferral says the tick ran out of budget, not`,
  `    // that the pair came back).`,
  `    assert.equal(`,
  `      dm.noteDeferredCoin("NEVER-DEFERRED", { ageMs: OLD, windowMaxAgeMs: WINDOW }, 3_000),`,
  `      false,`,
  `    );`,
  `    dm.addDeferredToken("GONE", 9_999);`,
  `    assert.equal(dm.isDeferredToken("GONE"), false, "a retired token is not re-admitted by defer()");`,
  `    assert.equal(dm.deferredPrunedTotal(), 2);`,
  ``,
  `    // The probe view carries what the durable row cannot: owed time, misses,`,
  `    // the window the last observation judged against, and why each coin went.`,
  `    const view = dm.deferralRegistryView(1_000 + 60_000);`,
  `    assert.deepEqual(`,
  `      view.pending.map((p) => [p.token, p.misses]),`,
  `      [`,
  `        ["LIVE", 0],`,
  `        ["FRESH", 0],`,
  `      ],`,
  `    );`,
  `    assert.equal(view.pending[0].owedMin, 1, "owed since it was first recorded");`,
  `    assert.equal(view.pendingCount, 2);`,
  `    assert.equal(view.attempts, dm.DEFERRED_PRUNE_ATTEMPTS);`,
  `    assert.equal(dm.DEFERRED_PRUNE_ATTEMPTS, 3, "the published slack is the rule's");`,
  `    assert.equal(view.windowMaxAgeMin, 1560);`,
  `    assert.deepEqual(`,
  `      view.lastPruned.map((p) => [p.token, p.reason]),`,
  `      [`,
  `        ["ZOMBIE", "too-old"],`,
  `        ["GONE", "no-pair"],`,
  `      ],`,
  `    );`,
  `    assert.equal(view.lastPruned[0].ageMin, 167 * 60, "and the age it was judged at");`,
  `    assert.equal(view.firstPruneAt, 2_000);`,
  `    assert.equal(view.lastPruneAt, 2_000);`,
  `    dm.resetDeferredRegistry();`,
  `  });`,
  ``,
  `  await test("push deferral snapshot: retirements accumulate, stamp, and survive a legacy row", () => {`,
  `    // The delta is a cursor difference like deferred/recovered — and its null`,
  `    // test is what lets a RETIREMENT-only tick write the row, which is what`,
  `    // persists the pending list the prune shrank (a recycled isolate re-seeds`,
  `    // from that row).`,
  `    assert.equal(`,
  `      pushDeferralDelta(`,
  `        { deferred: 0, recovered: 0 },`,
  `        { deferred: 0, recovered: 0, pruned: 0 },`,
  `      ),`,
  `      null,`,
  `    );`,
  `    assert.deepEqual(`,
  `      pushDeferralDelta(`,
  `        { deferred: 5, recovered: 2, pruned: 1 },`,
  `        { deferred: 5, recovered: 2, pruned: 4 },`,
  `      ),`,
  `      { deferred: 0, recovered: 0, pruned: 3 },`,
  `      "a prune-only tick still offers a delta",`,
  `    );`,
  `    // A row written before the counter existed reads 0/null, never NaN.`,
  `    const legacy = parsePushDeferralSnapshot(`,
  `      JSON.stringify({ deferredTotal: 3, recoveredTotal: 1, pendingTokens: ["AAA"] }),`,
  `    );`,
  `    assert.equal(legacy.prunedTotal, 0);`,
  `    assert.equal(legacy.firstPruneAt, null);`,
  `    assert.equal(legacy.lastPruneAt, null);`,
  `    // Folding a retirement in: the total accumulates, the first stamp is set`,
  `    // once, and the list it shrank to rides the same write.`,
  `    const first = nextPushDeferralSnapshot(`,
  `      JSON.stringify(legacy),`,
  `      { deferred: 0, recovered: 0, stalled: 0, pending: 1, pruned: 2 },`,
  `      5_000,`,
  `      { owner: "isoA", deferred: 3, recovered: 1, stalled: 0, pruned: 2 },`,
  `      ["LIVE"],`,
  `    );`,
  `    assert.equal(first.prunedTotal, 2);`,
  `    assert.equal(first.firstPruneAt, 5_000);`,
  `    assert.equal(first.lastPruneAt, 5_000);`,
  `    assert.equal(first.pending, 1);`,
  `    assert.deepEqual(first.pendingTokens, ["LIVE"]);`,
  `    assert.equal(first.applied.pruned, 2, "the marker carries it, so a lost write cannot double-count");`,
  `    const second = nextPushDeferralSnapshot(`,
  `      JSON.stringify(first),`,
  `      { deferred: 0, recovered: 0, stalled: 0, pending: 1, pruned: 1 },`,
  `      6_000,`,
  `      { owner: "isoA", deferred: 3, recovered: 1, stalled: 0, pruned: 3 },`,
  `      ["LIVE"],`,
  `    );`,
  `    assert.equal(second.prunedTotal, 3);`,
  `    assert.equal(second.firstPruneAt, 5_000, "the first stamp never moves");`,
  `    assert.equal(second.lastPruneAt, 6_000);`,
  `    // The dedupe edge that matters: a marker written before this counter`,
  `    // existed must not ACK a delta whose retirements are still un-written.`,
  `    assert.equal(`,
  `      pushDeferralAlreadyApplied(`,
  `        { applied: { owner: "isoA", deferred: 3, recovered: 1, stalled: 0 } },`,
  `        "isoA",`,
  `        { deferred: 3, recovered: 1, stalled: 0, pruned: 3 },`,
  `      ),`,
  `      false,`,
  `      "legacy marker + a live retirement delta → re-offer, never ACK",`,
  `    );`,
  `    assert.equal(`,
  `      pushDeferralAlreadyApplied(`,
  `        { applied: { owner: "isoA", deferred: 3, recovered: 1, stalled: 0, pruned: 3 } },`,
  `        "isoA",`,
  `        { deferred: 3, recovered: 1, stalled: 0, pruned: 3 },`,
  `      ),`,
  `      true,`,
  `    );`,
  `  });`,
  ``,
  `  // ---------- the prune rule is wired, and the probe answers for it ----------`,
  `  //`,
  `  // src/scanner.ts, src/worker.ts and this file are all past the file tool's`,
  `  // edit window, so the wiring is pinned on the source: the observation uses`,
  `  // the GATE'S OWN age input at the widest enabled window and sits before the`,
  `  // no-pair skip; the retirement cursor reaches the durable row exactly the way`,
  `  // deferred/recovered do; and /debug/deferral publishes both halves.`,
  `  await test("out-of-window patch: unpayable obligations are retired and the probe answers (docs/patches/deferred-prune-2026-09-26.apply.js)", () => {`,
  `    // Whitespace-only squash, regex-free (see the round-4 guard for why: a`,
  `    // half-escaped regex in a patch script is how a strip starts matching`,
  `    // nothing at all).`,
  `    const WS = new Set([9, 10, 13, 32]);`,
  `    const strip = (text) => [...text].filter((ch) => !WS.has(ch.charCodeAt(0))).join("");`,
  `    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));`,
  `    const count = (hay, needle) => hay.split(needle).length - 1;`,
  `    const scannerSrc = read("src/scanner.ts");`,
  `    const workerSrc = read("src/worker.ts");`,
  `    const dm = require(path.join(__dirname, "..", "dist", "deferredmakeup.js"));`,
  `    const hookAt = scannerSrc.indexOf("noteDeferredCoin(profile.tokenAddress,{");`,
  `    const skipAt = scannerSrc.indexOf("if(!pair)continue;", hookAt);`,
  `    const applied = {`,
  `      "scanner (the observation judges with the gate's own age input, at the widest window)":`,
  `        scannerSrc.includes(`,
  `          "constwidestMaxAgeMs=chats.length>0?Math.max(...chats.map((c)=>c.maxAgeMinutes))*60_000:Infinity;",`,
  `        ) &&`,
  `        scannerSrc.includes(`,
  `          "ageMs:pair?Date.now()-pair.pairCreatedAt:null,windowMaxAgeMs:widestMaxAgeMs,",`,
  `        ) &&`,
  `        hookAt >= 0 &&`,
  `        skipAt > hookAt &&`,
  `        scannerSrc.includes("if(isDeferredToken(profile.tokenAddress)){"),`,
  `      "scanner (the ledger and the summary carry the cursor)":`,
  `        scannerSrc.includes("getpruned():number{returndeferredPrunedTotal();}") &&`,
  `        scannerSrc.includes("deferPruned?:number;") &&`,
  `        scannerSrc.includes("deferPruned:this.deferredPushes.pruned,"),`,
  `      "worker (totals → delta → the no-op guard: a prune-only tick writes the row)":`,
  `        workerSrc.includes("pruned:summary?.deferPruned??0,") &&`,
  `        workerSrc.includes("pruned:cursorDelta?.pruned??0,") &&`,
  `        workerSrc.includes("delta.pruned<=0&&") &&`,
  `        count(workerSrc, "pushDeferralBaseline={deferred:0,recovered:0,pruned:0};") === 2,`,
  `      "worker (/debug/deferral publishes both halves)":`,
  `        workerSrc.includes('url.pathname==="/debug/deferral"') &&`,
  `        workerSrc.includes("durable:loadPushDeferralSnapshot(raw??null),") &&`,
  `        workerSrc.includes("isolate:deferralRegistryView(),"),`,
  `      "the rule's slack is published with the module":`,
  `        dm.DEFERRED_PRUNE_ATTEMPTS === 3 && typeof dm.noteDeferredCoin === "function",`,
  `    };`,
  `    const done = Object.entries(applied).filter(([, v]) => v);`,
  `    if (done.length === 0) {`,
  `      console.log(`,
  `        "  \\u2139 the deferred-prune rule is missing - apply docs/patches/deferred-prune-2026-09-26.apply.js",`,
  `      );`,
  `      return;`,
  `    }`,
  `    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);`,
  `    assert.deepEqual(missing, [], \`half-applied: \${missing.join(", ")}\`);`,
  `  });`,
  ``,
);

const EDITS = [
  [
    "scripts/test-unit.js",
    "the prune rule, its durable cursor and its wiring get their tests",
    NEW_GUARD,
    NEW_TEST + NEW_GUARD,
    (src) => src.includes("an unpayable obligation is retired, a live one is kept"),
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
