#!/usr/bin/env node
/**
 * The 🌱 有機度 line, third pass (2026-09-26): make its slot LATE-BOUND, and add
 * the probe that tells "no window" from "no data".
 *
 * WHAT THE OPERATOR SAW. roon (msgId 5384, pushed 04:26Z on the deploy that
 * moved the batch in front of RugCheck) still had no organic line. Moving the
 * dispatch earlier was necessary but not sufficient, for two measured reasons:
 *
 *  1. The batch's wall — `enrichDeadline`, tick start + 2200ms
 *     (4200 − PUSH_RESERVE 1500 − GATE_TAIL 500) — is roughly WHERE THE CHAIN
 *     STARTS, not where it can finish: live `seen` stamps land at 1.4-2.5s and
 *     the seen-check itself is a read. A slot opened at 2.0-2.5s against a 2.2s
 *     wall is dead on arrival (`bestEffort` returns its fallback the moment the
 *     deadline has passed).
 *  2. The Jupiter client THROTTLES its own calls 500ms apart
 *     (JUPITER_REQUEST_INTERVAL_MS), shared with the tick's discovery legs and
 *     the pair-fallback, so even a slot that starts in time can be queued
 *     behind another call and answer after the wall.
 *
 * THE FIX. The organic reading is display-only (nothing gates on it), so its
 * slot is no longer awaited by the chain: it is opened with the batch, walled
 * at the TICK deadline (it blocks nobody), and read LATE-BOUND where the card
 * is rendered — same call, same count, same fallback (null → the line is
 * hidden, exactly as today). If it lands before the render, the line appears;
 * the chain's timing never decides it again.
 *
 * THE PROBE. `/debug/jupiter?organic=<mint>` runs `fetchOrganicScore` from the
 * WORKER's own egress and reports the reading + its latency, so the remaining
 * question ("can this egress fetch it at all?") is answerable with one request
 * instead of another push-and-wait cycle.
 *
 * src/scanner.ts, src/worker.ts and scripts/test-unit.js are all far past the
 * file tool's edit window, so this is a verify-then-write patch.
 *
 * Run: node docs/patches/organic-late-bound-and-probe-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const NEW_GUARD = `  console.log("\\n===== UNIT TESTS =====");`;

const NEW_TEST = lines(
  `  // ---------- the 🌱 有機度 slot is late-bound (and the probe that says why) ---`,
  `  //`,
  `  // 2026-09-26, second fix of the day for the same line. Moving the batch in`,
  `  // front of RugCheck was necessary but not sufficient: the batch's wall`,
  `  // (enrichDeadline, tick start + 2.2s) is where the chain usually STARTS`,
  `  // (live \`seen\` stamps: 1.4-2.5s), and the Jupiter client spaces its calls`,
  `  // 500ms apart, so an AWAITED organic call still could not answer in time —`,
  `  // the operator's next push card (roon, msgId 5384) had no line. The reading`,
  `  // is display-only, so the slot is no longer awaited: opened with the batch,`,
  `  // walled at the TICK deadline (it blocks nobody), read late-bound at render.`,
  `  // Same call, same count, same fallback. The worker probe answers the other`,
  `  // half of the question — whether this egress can fetch it at all.`,
  `  await test("out-of-window patch: the organic slot is late-bound, and the worker can be asked directly (docs/patches/organic-late-bound-and-probe-2026-09-26.apply.js)", () => {`,
  `    const strip = (text) =>`,
  `      text`,
  `        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")`,
  `        .replace(/\\/\\/[^\\n]*/g, "")`,
  `        .replace(/\\s+/g, "");`,
  `    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));`,
  `    const scannerSrc = read("src/scanner.ts");`,
  `    const workerSrc = read("src/worker.ts");`,
  `    const applied = {`,
  `      "scanner (the slot rides the batch's dispatch but not its await)":`,
  `        scannerSrc.includes("constorganicSlot=this.bestEffort(") &&`,
  `        scannerSrc.includes(`,
  `          "?()=>jupiterOrganic.fetchOrganicScore(coin.stats.token):null,tickDeadline,null,",`,
  `        ) &&`,
  `        scannerSrc.includes(`,
  `          "voidorganicSlot.then((v)=>{organicBox.value=v;if(v)diag.organic++;});",`,
  `        ),`,
  `      "scanner (the card reads the box, and the awaited batch is two slots)":`,
  `        scannerSrc.includes(`,
  `          "constorganicBox:{value:Awaited<typeoforganicSlot>}={value:null};",`,
  `        ) &&`,
  `        scannerSrc.includes("const[gmgn,arkham]=awaitdisplayBatch;") &&`,
  `        scannerSrc.includes("organicBox.value,"),`,
  `      "worker (the probe asks from the worker's own egress, with its latency)":`,
  `        workerSrc.includes(`,
  `          'constorganicMint=(url.searchParams.get("organic")??"").trim();',`,
  `        ) &&`,
  `        workerSrc.includes(`,
  `          "constreading=awaitclient.fetchOrganicScore(organicMint);",`,
  `        ) &&`,
  `        workerSrc.includes("ms:Date.now()-t0,"),`,
  `    };`,
  `    const done = Object.entries(applied).filter(([, v]) => v);`,
  `    if (done.length === 0) {`,
  `      console.log(`,
  `        "  \\u2139 the late-bound organic slot is missing - apply docs/patches/organic-late-bound-and-probe-2026-09-26.apply.js",`,
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
    "the organic slot leaves the awaited batch and becomes late-bound",
    lines(
      `          this.bestEffort(`,
      `            jupiterOrganic`,
      `              ? () => jupiterOrganic.fetchOrganicScore(coin.stats.token)`,
      `              : null,`,
      `            enrichDeadline,`,
      `            null,`,
      `          ),`,
      `        ]);`,
    ),
    lines(
      `        ]);`,
      `        // The 🌱 有機度 slot is opened WITH the batch but is NOT awaited by it`,
      `        // (2026-09-26): its reading is late-bound to the card below. The`,
      `        // batch's wall (enrichDeadline, tick start + 2.2s) is where the chain`,
      `        // usually STARTS rather than where it can finish — live \`seen\` stamps`,
      `        // land at 1.4-2.5s and the seen-check itself is a read — and the`,
      `        // Jupiter client spaces its own calls 500ms apart, so an AWAITED`,
      `        // organic call was cut before it could answer even after the batch's`,
      `        // dispatch moved in front of RugCheck (operator report: roon, msgId`,
      `        // 5384). Nothing here gates anything — the line is display-only — so`,
      `        // the card reads whatever landed by render time: same call, same`,
      `        // count, same fallback (null → the line is hidden), and no wait added`,
      `        // anywhere. Its wall is the tick deadline because it blocks nobody.`,
      `        const organicSlot = this.bestEffort(`,
      `          jupiterOrganic`,
      `            ? () => jupiterOrganic.fetchOrganicScore(coin.stats.token)`,
      `            : null,`,
      `          tickDeadline,`,
      `          null,`,
      `        );`,
      `        const organicBox: { value: Awaited<typeof organicSlot> } = { value: null };`,
      `        void organicSlot.then((v) => {`,
      `          organicBox.value = v;`,
      `          if (v) diag.organic++;`,
      `        });`,
    ),
    (src) => src.includes("const organicSlot = this.bestEffort("),
  ],
  [
    "src/scanner.ts",
    "the awaited batch is GMGN + Arkham, and the counter moved with the slot",
    lines(
      `        const [gmgn, arkham, organic] = await displayBatch;`,
      `        if (arkham) diag.arkham++;`,
      `        if (organic) diag.organic++;`,
    ),
    lines(
      `        const [gmgn, arkham] = await displayBatch;`,
      `        if (arkham) diag.arkham++;`,
      `        // organic has no counter line here: its late-bound slot (see above)`,
      `        // owns the increment, so a reading that has not landed yet can never`,
      `        // be counted as "this tick had one".`,
    ),
    (src) => src.includes("const [gmgn, arkham] = await displayBatch;"),
  ],
  [
    "src/scanner.ts",
    "the card renders the late-bound box",
    lines(
      `          wallet,`,
      `          organic,`,
      `          axiomInfo,`,
    ),
    lines(
      `          wallet,`,
      `          // The late-bound reading (see organicSlot): whatever landed by the`,
      `          // time this card is built, or null → the line is hidden.`,
      `          organicBox.value,`,
      `          axiomInfo,`,
    ),
    (src) => src.includes("organicBox.value,"),
  ],
  [
    "src/worker.ts",
    "/debug/jupiter gains the organic probe (the worker's own egress)",
    lines(
      `      const client = new JupTokensClient(cfg);`,
      `      const [recent, trending] = await Promise.all([`,
    ),
    lines(
      `      const client = new JupTokensClient(cfg);`,
      `      // ?organic=<mint> — the push card's 🌱 有機度 reading, asked from the`,
      `      // WORKER's own egress (2026-09-26). The card line is display-only and`,
      `      // best-effort, so a missing line has two possible halves: no window in`,
      `      // the tick, or no data from this egress. This answers the second one`,
      `      // with the same call the scanner makes, plus its latency — one request`,
      `      // instead of another push-and-wait cycle.`,
      `      const organicMint = (url.searchParams.get("organic") ?? "").trim();`,
      `      if (organicMint) {`,
      `        const t0 = Date.now();`,
      `        const reading = await client.fetchOrganicScore(organicMint);`,
      `        return Response.json({`,
      `          ok: reading !== null,`,
      `          mint: organicMint,`,
      `          ms: Date.now() - t0,`,
      `          reading,`,
      `        });`,
      `      }`,
      `      const [recent, trending] = await Promise.all([`,
    ),
    (src) => src.includes("const organicMint = (url.searchParams.get(\"organic\")"),
  ],
  [
    "scripts/test-unit.js",
    "the §4.17 birdeye guard follows the batch's new shape",
    lines(
      `      "scanner (the enrich batch is down to the three display-only slots)":`,
      `        scannerSrc.includes("const[gmgn,arkham,organic]=awaitdisplayBatch;") &&`,
    ),
    lines(
      `      "scanner (the enrich batch is down to the display-only slots)":`,
      `        // 2026-09-26: the organic slot is late-bound now (see the organic`,
      `        // guards), so the awaited batch is GMGN + Arkham.`,
      `        scannerSrc.includes("const[gmgn,arkham]=awaitdisplayBatch;") &&`,
    ),
    (src) => src.includes('scannerSrc.includes("const[gmgn,arkham]=awaitdisplayBatch;") &&'),
  ],
  [
    "scripts/test-unit.js",
    "and the organic-dispatch guard follows it too",
    lines(
      `      "scanner (the batch itself is unchanged: three slots, one shared deadline)":`,
      `        scannerSrc.includes("constdisplayBatch=Promise.all([") &&`,
      `        scannerSrc.includes("()=>this.resolveGmgnInfo(coin),") &&`,
      `        scannerSrc.includes("()=>this.resolveArkhamInfo(coin),") &&`,
      `        scannerSrc.includes("?()=>jupiterOrganic.fetchOrganicScore(coin.stats.token):null,") &&`,
      `        scannerSrc.includes("const[gmgn,arkham,organic]=awaitdisplayBatch;"),`,
    ),
    lines(
      `      "scanner (the batch itself is unchanged: GMGN + Arkham on one deadline)":`,
      `        scannerSrc.includes("constdisplayBatch=Promise.all([") &&`,
      `        scannerSrc.includes("()=>this.resolveGmgnInfo(coin),") &&`,
      `        scannerSrc.includes("()=>this.resolveArkhamInfo(coin),") &&`,
      `        scannerSrc.includes("const[gmgn,arkham]=awaitdisplayBatch;"),`,
    ),
    (src) => src.includes("GMGN + Arkham on one deadline"),
  ],
  [
    "scripts/test-unit.js",
    "the dispatch-order guard follows the two-slot await",
    `        before('construgcheck=awaitthis.bestEffort(', "const[gmgn,arkham,organic]=awaitdisplayBatch;") &&`,
    `        before('construgcheck=awaitthis.bestEffort(', "const[gmgn,arkham]=awaitdisplayBatch;") &&`,
    (src) =>
      src.includes(
        `before('construgcheck=awaitthis.bestEffort(', "const[gmgn,arkham]=awaitdisplayBatch;")`,
      ),
  ],
  [
    "scripts/test-unit.js",
    "the late-bound slot and the probe get their guard",
    NEW_GUARD,
    NEW_TEST,
    (src) => src.includes("the organic slot is late-bound, and the worker can be asked directly"),
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
