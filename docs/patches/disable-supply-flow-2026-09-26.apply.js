#!/usr/bin/env node
/**
 * Turn the supply-flow check OFF and take its line off the push card
 * (2026-09-26).
 *
 * WHY: the check's only product is ONE card line (🕸 供應流) inside the legacy
 * enrichment group. With AXIOM_ENABLED = "0" (2026-09-19) the Axiom summary no
 * longer replaces that group, so every card carried the line again — and the
 * check is the card's most expensive part: a Helius analysis (~10 RPC calls:
 * getTokenLargestAccounts + getTokenTransfers, budget-guarded) plus one
 * token_stats write per analyzed coin, re-run per coin every
 * SUPPLY_FLOW_REFRESH_MIN.
 *
 * The switch (SUPPLY_FLOW_ENABLED) already exists and already short-circuits
 * resolveSupplyFlow before any RPC, budget arithmetic or write. What did NOT
 * exist was the DISPLAY half: the disabled check returns "unknown", which the
 * card printed as an idle "🍈 供應流: —（未分析）" on every push. So the card's
 * parameter becomes tri-state (null = disabled = line hidden), the scanner
 * hands null while the check is off, and the line group carries the line only
 * when it exists — the same "no data, no line" stance GMGN / Arkham / crime
 * take.
 *
 * TRADE-OFF, stated plainly: only a CONFIRMED flag ever blocked a push, and
 * that block goes with the check — a coin that would have been blocked now
 * pushes, which is the shape of today's 未分析 cards (best-effort detector,
 * never a gate). The manual /flow command still works: its analyzer is built
 * on demand and costs nothing until it is used.
 *
 * FOUR files, all past/at the file tool's edit window (scripts/test-unit.js is
 * 620KB+): wrangler.toml, src/render.ts, src/scanner.ts, scripts/test-unit.js.
 *
 * Run: node docs/patches/disable-supply-flow-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const NEW_GUARD = `  console.log("\\n===== UNIT TESTS =====");`;

const NEW_TESTS = lines(
  `  // ---------- the 供應流 card line is OFF (SUPPLY_FLOW_ENABLED="false") ----------`,
  `  //`,
  `  // The switch already existed; what these two pin is the DISABLED shape end`,
  `  // to end. The behaviour first: a disabled reading (null) takes the line OFF`,
  `  // the card — it is a card with one fewer line, not a card with an idle`,
  `  // "未分析" line — while the enabled readings keep today's exact wording.`,
  `  await test("render: a disabled supply-flow check takes the line OFF the card", () => {`,
  `    const { renderMessage } = require(path.join(__dirname, "..", "dist", "render.js"));`,
  `    // The /debug/card-preview mock's shape, trimmed to what the card reads.`,
  `    const coin = {`,
  `      chatId: "c",`,
  `      profile: { tokenAddress: "FLOWOFF", name: "Flow Off", symbol: "FLOWOFF" },`,
  `      pair: {`,
  `        chainId: "solana",`,
  `        url: "",`,
  `        pairAddress: "p-FLOWOFF",`,
  `        baseToken: { address: "FLOWOFF", name: "Flow Off", symbol: "FLOWOFF" },`,
  `        priceUsd: "0.0001",`,
  `        marketCap: 132_000,`,
  `        volume: { h24: 100_000, h1: 5_000, m5: 1_000 },`,
  `        priceChange: { m5: 3.2, h1: 5 },`,
  `        liquidity: { usd: 21_000 },`,
  `        pairCreatedAt: Date.now() - 5 * 3_600_000,`,
  `      },`,
  `      stats: { token: "FLOWOFF" },`,
  `    };`,
  `    const crime = {`,
  `      hit: false,`,
  `      creatorHit: false,`,
  `      holderHits: [],`,
  `      checkedHolders: 0,`,
  `      loaded: false,`,
  `      holders: [],`,
  `    };`,
  `    const card = (flow) =>`,
  `      renderMessage(coin, null, null, flow, null, null, null, crime, null, null, null, null);`,
  `    assert.ok(!card(null).includes("供應流"), "disabled → the line is gone");`,
  `    assert.ok(`,
  `      card(false).includes("🕸 供應流: —（未分析）"),`,
  `      "enabled + pending → today's wording, unchanged",`,
  `    );`,
  `    assert.ok(card(true).includes("🕸 供應流: ✅"), "enabled + passed → unchanged");`,
  `  });`,
  ``,
  `  // ...and the wiring: past the file tool's edit window and cross-file, so the`,
  `  // shape is asserted on the source, the way every other out-of-window patch`,
  `  // here is. The toml check reads the RAW file (the switch's own line must`,
  `  // exist — its comment never spells that line out).`,
  `  await test("out-of-window patch: the supply-flow check is off and its line is hidden (docs/patches/disable-supply-flow-2026-09-26.apply.js)", () => {`,
  `    const strip = (text) =>`,
  `      text`,
  `        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")`,
  `        .replace(/\\/\\/[^\\n]*/g, "")`,
  `        .replace(/\\s+/g, "");`,
  `    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));`,
  `    const renderSrc = read("src/render.ts");`,
  `    const scannerSrc = read("src/scanner.ts");`,
  `    const configSrc = read("src/config.ts");`,
  `    const toml = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8");`,
  `    const applied = {`,
  `      "wrangler.toml (the switch is OFF in the deployed vars)":`,
  `        toml.includes('SUPPLY_FLOW_ENABLED = "false"'),`,
  `      "config (the switch still reads the var, and the default is unchanged)":`,
  `        configSrc.includes('enabled:(env.SUPPLY_FLOW_ENABLED??"true")!=="false",'),`,
  `      "render (the reading is tri-state, and null is what hides the line)":`,
  `        renderSrc.includes("supplyFlowClean:boolean|null,") &&`,
  `        renderSrc.includes("constflowLine=supplyFlowClean===null?null:"),`,
  `      "render (the legacy group carries the line only when it exists)":`,
  `        renderSrc.includes("[bundlerLine,top10Line,...(flowLine?[flowLine]:[])]"),`,
  `      "scanner (the card gets null, not false, while the check is off)":`,
  `        scannerSrc.includes('this.config.supplyFlow.enabled?flow.status==="clean":null,'),`,
  `      "scanner (a disabled read returns before any RPC, budget or write)":`,
  `        scannerSrc.includes('if(!cfg.enabled||!this.config.heliusApiKey)return{status:"unknown"};'),`,
  `    };`,
  `    const done = Object.entries(applied).filter(([, v]) => v);`,
  `    if (done.length === 0) {`,
  `      console.log(`,
  `        "  \\u2139 the supply-flow line removal is missing - apply docs/patches/disable-supply-flow-2026-09-26.apply.js",`,
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
    "wrangler.toml",
    "the switch: supply-flow OFF, with the why and the trade-off stated",
    lines(
      `# Supply-flow (rug/distribution) per-coin budget. Two jobs: the upper bound`,
      `# for what the analyzer may spend, and the unit the gate's start guard uses.`,
    ),
    lines(
      `# Supply-flow (rug/distribution) check — OFF as of 2026-09-26.`,
      `#`,
      `# WHY: the check's only product was ONE card line (on the legacy enrichment`,
      `# group), and with AXIOM_ENABLED = "0" (2026-09-19) the Axiom summary no`,
      `# longer replaces that group — so every card carried the line again. The`,
      `# operator does not want it, and the check was the card's most expensive`,
      `# part: a Helius analysis (~10 RPC calls — getTokenLargestAccounts +`,
      `# gTFA out-transfers, budget-guarded to the SUPPLY_FLOW_BUDGET_MS below)`,
      `# plus one token_stats write per analyzed coin, re-run per coin every`,
      `# SUPPLY_FLOW_REFRESH_MIN. With "false" the scanner's resolveSupplyFlow`,
      `# returns "unknown" BEFORE any RPC, budget arithmetic or write, and the`,
      `# call site hands renderMessage null, which HIDES the line — an idle`,
      `# "未分析" line on every push is exactly what this removes.`,
      `#`,
      `# TRADE-OFF, stated plainly: only a CONFIRMED flag ever blocked a push, and`,
      `# that block goes with the check — a coin that would have been blocked now`,
      `# pushes, which is the shape of today's "未分析" cards (the detector was`,
      `# always best-effort, never a gate). The manual /flow command still works`,
      `# (its analyzer is built on demand and costs nothing until used). Restore`,
      `# "true" to bring the check — and the line — back.`,
      `SUPPLY_FLOW_ENABLED = "false"`,
      ``,
      `# Supply-flow (rug/distribution) per-coin budget. Two jobs: the upper bound`,
      `# for what the analyzer may spend, and the unit the gate's start guard uses.`,
    ),
    (src) => src.includes('SUPPLY_FLOW_ENABLED = "false"'),
  ],
  [
    "src/render.ts",
    "the card's flow reading is tri-state: null = disabled = no line",
    lines(
      `  top10Pct: number | null,`,
      `  supplyFlowClean: boolean,`,
      `  creator: string | null,`,
    ),
    lines(
      `  top10Pct: number | null,`,
      `  /**`,
      `   * The supply-flow reading: true = the on-chain check passed, false =`,
      `   * analyzed-not-yet / pending (the card prints 未分析), null = the check is`,
      `   * DISABLED (SUPPLY_FLOW_ENABLED = "false") → the 供應流 line is hidden`,
      `   * entirely, the same "no data, no line" stance GMGN / Arkham / crime take.`,
      `   */`,
      `  supplyFlowClean: boolean | null,`,
      `  creator: string | null,`,
    ),
    (src) => src.includes("supplyFlowClean: boolean | null,"),
  ],
  [
    "src/render.ts",
    "a disabled reading renders no line at all",
    lines(
      `  const flowLine = supplyFlowClean`,
      `    ? "🕸 供應流: ✅ 无集中出货（链上检查通过）"`,
      `    : "🕸 供應流: —（未分析）";`,
    ),
    lines(
      `  const flowLine =`,
      `    supplyFlowClean === null`,
      `      ? null`,
      `      : supplyFlowClean`,
      `        ? "🕸 供應流: ✅ 无集中出货（链上检查通过）"`,
      `        : "🕸 供應流: —（未分析）";`,
    ),
    (src) => src.includes("supplyFlowClean === null"),
  ],
  [
    "src/render.ts",
    "the legacy group carries the line only when it exists",
    lines(
      `  // Axiom summary replaces the five legacy enrichment lines when the`,
      `  // payload resolved; otherwise the card keeps today's exact shape.`,
    ),
    lines(
      `  // Axiom summary replaces the legacy enrichment lines when the payload`,
      `  // resolved; otherwise the card keeps today's shape — minus every line`,
      `  // whose source is disabled (flowLine is null while the check is off).`,
    ),
    (src) => src.includes("minus every line"),
  ],
  [
    "src/render.ts",
    "the group itself drops a null line",
    lines(`      : [bundlerLine, top10Line, flowLine]),`),
    lines(`      : [bundlerLine, top10Line, ...(flowLine ? [flowLine] : [])]),`),
    (src) => src.includes("...(flowLine ? [flowLine] : [])"),
  ],
  [
    "src/scanner.ts",
    "the disabled read is free, and the card is told so",
    lines(
      `        // Supply-flow (rug/distribution) check — run before the expensive`,
      `        // display lookups so a flagged coin never wastes the tick. Only a`,
      `        // confirmed flag blocks the push; a pending/incomplete analysis`,
      `        // (hold/unknown) pushes anyway with the card showing 未分析.`,
      `        this.markPhase(diag, "flow", startedAt);`,
    ),
    lines(
      `        // Supply-flow (rug/distribution) check — run before the expensive`,
      `        // display lookups so a flagged coin never wastes the tick. Only a`,
      `        // confirmed flag blocks the push; a pending/incomplete analysis`,
      `        // (hold/unknown) pushes anyway with the card showing 未分析.`,
      `        // DISABLED (SUPPLY_FLOW_ENABLED = "false", 2026-09-26): the read is`,
      `        // free — resolveSupplyFlow returns "unknown" before any RPC, budget`,
      `        // arithmetic or write — and the card drops the line (the call site`,
      `        // below hands renderMessage null, not false).`,
      `        this.markPhase(diag, "flow", startedAt);`,
    ),
    (src) => src.includes("below hands renderMessage null, not false"),
  ],
  [
    "src/scanner.ts",
    "the card's flow reading is null while the check is off",
    lines(
      `          rugcheck.top10Pct,`,
      `          flow.status === "clean",`,
    ),
    lines(
      `          rugcheck.top10Pct,`,
      `          // null (not false) while the check is disabled: the card HIDES the`,
      `          // 供應流 line instead of printing an idle "未分析" on every push.`,
      `          this.config.supplyFlow.enabled ? flow.status === "clean" : null,`,
    ),
    (src) => src.includes("? flow.status === \"clean\" : null,"),
  ],
  [
    "scripts/test-unit.js",
    "the birdeye-lines guard: the group and the tri-state reading",
    lines(
      `      "render (the signature dropped both values; the group is Bundler/Top10/flow)":`,
      `        renderSrc.includes("[bundlerLine,top10Line,flowLine]") &&`,
      `        renderSrc.includes("top10Pct:number|null,supplyFlowClean:boolean,creator:string|null,") &&`,
      `        !renderSrc.includes("sniperPct:number|null,") &&`,
      `        !renderSrc.includes("holderCount:number|null,"),`,
    ),
    lines(
      `      "render (the signature dropped both values; the group is Bundler/Top10/flow)":`,
      `        renderSrc.includes("[bundlerLine,top10Line,...(flowLine?[flowLine]:[])]") &&`,
      `        renderSrc.includes(`,
      `          "top10Pct:number|null,supplyFlowClean:boolean|null,creator:string|null,",`,
      `        ) &&`,
      `        !renderSrc.includes("sniperPct:number|null,") &&`,
      `        !renderSrc.includes("holderCount:number|null,"),`,
    ),
    (src) => src.includes("supplyFlowClean:boolean|null,creator:string|null,"),
  ],
  [
    "scripts/test-unit.js",
    "the supply-flow removal gets its behaviour test and its shape guard",
    NEW_GUARD,
    NEW_TESTS,
    (src) => src.includes("a disabled supply-flow check takes the line OFF the card"),
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
