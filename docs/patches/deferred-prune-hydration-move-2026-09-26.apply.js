#!/usr/bin/env node
/**
 * Deferred-prune hydration move (2026-09-26): the "has this isolate read the
 * row?" gate moves out of src/scanner.ts and into the module that owns the
 * registry, and the seed path becomes one hydration call.
 *
 * WHY (same day as the seed guard it finishes). The seed guard's second half
 * pinned readiness on a `deferredRegistryLive` flag declared in scanner.ts and
 * flipped by `Scanner.seedDeferredTokens`. That put the fact in the wrong
 * place, and the suite said so in three ways:
 *
 *  * the flag is REGISTRY state, not scanner state — the registry lives in
 *    src/deferredmakeup.ts (shared with the discovery feed), and a scanner
 *    rebuilt mid-isolate left a second, staler answer behind;
 *  * `deferredPushTokens()` answered `undefined` for a caller that had only
 *    ever built a `DeferredPushLedger` (the tail tests do exactly that), so
 *    three tests that publish through the tail went red — and, because a
 *    failing assertion skips the shared-registry cleanup below it, the third
 *    failure cascaded into the ledger test;
 *  * the gate could not be exercised where it is decided. It now can:
 *    `hydrateDeferredTokens()` sets the flag, EMPTY ROW INCLUDED, and
 *    `deferredPushTokens()` reads it beside the tokens it is about.
 *
 * Net shape: deferredmakeup.ts owns {registry, retire memory, hydration flag,
 * gated deferredPushTokens}; scanner.ts hydrates by calling it and publishes
 * nothing of its own; the worker imports the gated reader from the registry's
 * module. Run: node docs/patches/deferred-prune-hydration-move-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const DOC_ANCHOR =
  "`docs/patches/deferred-prune-cursor-fix-2026-09-26.apply.js`（deferredmakeup.ts / deferrallog.ts 用普通 edit）。";
const DOC_NOTE = lines(
  "",
  "落線紀錄（同日下午，readiness 由 scanner 搬返 registry 自己嗰個 module）：`docs/patches/deferred-prune-hydration-move-2026-09-26.apply.js`。",
  "`deferredPushTokens()` 而家同 registry 一齊住喺 `src/deferredmakeup.ts`，而 `hydrateDeferredTokens()` 係唯一 seed 路徑 ——",
  "因為「呢個 isolate 讀過 row 未」係 registry 自己嘅事實：擺喺 scanner 度，一個 mid-isolate rebuilt 嘅 scanner 會留低兩個答案。",
  "副作用係好事：條 gate 而家有行為測試（未 hydrate → `undefined`；hydrate 一個空 row → `[]`；退場嘅 token 連 hydrate 都唔收），",
  "而 wiring guard 唔使再靠 scanner 嘅 flag 字串。三條尾段測試亦改為經 `hydrateDeferredTokens()` 建 registry —— 生產本來就係嗰條路。",
  "",
);

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "src/scanner.ts",
    "the seed path is one hydration call into the registry's own module",
    lines(
      `  /** Hydrate durable deferred-card obligations when an isolate is recycled. */`,
      `  seedDeferredTokens(tokens: string[]): void {`,
      `    for (const token of tokens.slice(-500)) {`,
      `      if (typeof token === "string" && token.length > 0) {`,
      `        this.deferredPushes.seed(token, Date.now());`,
      `      }`,
      `    }`,
      `    // Hydrated: this isolate's registry now has an opinion (see`,
      `    // deferredPushTokens). Set even when the row was EMPTY — "the row says`,
      `    // nothing is owed" is exactly the authoritative answer the write path`,
      `    // needs on the tick that retires the last obligation.`,
      `    deferredRegistryLive = true;`,
      `  }`,
    ),
    lines(
      `  /**`,
      `   * Hydrate durable deferred-card obligations when an isolate is recycled`,
      `   * (see hydrateDeferredTokens). This is also what makes the registry fit`,
      `   * to stand in for the row it was read from — EMPTY ROW INCLUDED, which`,
      `   * is the answer the write path needs on the tick that retires the last`,
      `   * obligation.`,
      `   */`,
      `  seedDeferredTokens(tokens: string[]): void {`,
      `    hydrateDeferredTokens(tokens, Date.now());`,
      `  }`,
    ),
    (src) => src.includes("hydrateDeferredTokens(tokens, Date.now());"),
  ],
  [
    "src/worker.ts",
    "the gated reader is imported from the registry's module",
    lines(
      `import { Scanner, deferredPushTokens, forgetDeferredTokens } from "./scanner";`,
      `import { deferralRegistryView, feedMakeupView } from "./deferredmakeup";`,
    ),
    lines(
      `import { Scanner, forgetDeferredTokens } from "./scanner";`,
      `import { deferralRegistryView, deferredPushTokens, feedMakeupView } from "./deferredmakeup";`,
    ),
    (src) =>
      src.includes(
        `import { deferralRegistryView, deferredPushTokens, feedMakeupView } from "./deferredmakeup";`,
      ),
  ],
  [
    "src/worker.ts",
    "…and the cold-init comment points at it",
    lines(
      `        // Hydrate durable deferred-card identities before the first scan in`,
      `        // this isolate; counters alone cannot guarantee a make-up push. Gated`,
      `        // on the row having been READ: seeding also marks the registry`,
      `        // authoritative for the tick-tail write (see`,
      `        // scanner.deferredPushTokens), and an isolate that never read this`,
      `        // row must not be able to clear it.`,
    ),
    lines(
      `        // Hydrate durable deferred-card identities before the first scan in`,
      `        // this isolate; counters alone cannot guarantee a make-up push. Gated`,
      `        // on the row having been READ: hydrating ALSO marks the registry`,
      `        // authoritative for the tick-tail write (see deferredPushTokens in`,
      `        // the registry's own module), and an isolate that never read this`,
      `        // row must not be able to clear it.`,
    ),
    (src) => src.includes("hydrating ALSO marks the registry"),
  ],
  [
    "scripts/test-unit.js",
    "the suite imports the hydration path at the top, like it imports the ledger",
    lines(
      `const { mcapRatioBlockReason, newWalletBlockReason, top10MinBlockReason, botUsersBlockReason, flurryBlockReason, gateLiquidityUsd, slicePoolRotation, cardSendDeadline, cardClaimDeadline, boundClaim, DeferredPushLedger, SCAN_TICK_DEADLINE_MS, CANDIDATE_PUSH_RESERVE_MS } = require("../dist/scanner.js");`,
    ),
    lines(
      `const { mcapRatioBlockReason, newWalletBlockReason, top10MinBlockReason, botUsersBlockReason, flurryBlockReason, gateLiquidityUsd, slicePoolRotation, cardSendDeadline, cardClaimDeadline, boundClaim, DeferredPushLedger, SCAN_TICK_DEADLINE_MS, CANDIDATE_PUSH_RESERVE_MS } = require("../dist/scanner.js");`,
      `const { hydrateDeferredTokens } = require("../dist/deferredmakeup.js");`,
    ),
    (src) => src.includes('const { hydrateDeferredTokens } = require("../dist/deferredmakeup.js");'),
  ],
  [
    "scripts/test-unit.js",
    "the tail tests hydrate the registry the way a tick does",
    lines(
      `      // The coin still owed is in the SHARED registry, as it is in production`,
      `      // (the tail's own refreshMirror seeds it from the row it just read), and`,
      `      // any delta this process accumulated earlier is drained — so the`,
      `      // round-trip count below is the tail's own.`,
      `      new DeferredPushLedger().defer("OWED1", now - 60_000);`,
    ),
    lines(
      `      // The coin still owed is hydrated into the SHARED registry from the row`,
      `      // this tick just read — production's own seed path (see`,
      `      // hydrateDeferredTokens), and what makes the registry fit to publish at`,
      `      // all. Any delta this process accumulated earlier is drained, so the`,
      `      // round-trip count below is the tail's own.`,
      `      hydrateDeferredTokens(["OWED1"], now - 60_000);`,
    ),
    (src) => src.includes(`hydrateDeferredTokens(["OWED1"], now - 60_000);`),
  ],
  [
    "scripts/test-unit.js",
    "…in the rejected-batch test too",
    lines(
      `      // The coin still owed rides the SHARED registry here too: without it`,
      `      // the delta write has no list to publish and keeps the old one (see`,
      `      // nextPushDeferralSnapshot), which would hide the guard's drop.`,
      `      new DeferredPushLedger().defer("OWED1", now - 60_000);`,
    ),
    lines(
      `      // The coin still owed is hydrated from the row here too: without a`,
      `      // registry that has READ it the delta write has no list to publish and`,
      `      // keeps the old one (see nextPushDeferralSnapshot), which would hide`,
      `      // the guard's drop.`,
      `      hydrateDeferredTokens(["OWED1"], now - 60_000);`,
    ),
    (src) =>
      src.includes(
        lines(
          `      // The coin still owed is hydrated from the row here too: without a`,
          `      // registry that has READ it the delta write has no list to publish and`,
        ),
      ),
  ],
  [
    "scripts/test-unit.js",
    "the gate has its own behavioural test (it is no longer a scanner flag)",
    lines(
      `    dm.dropDeferredToken("ZOMBIE2");`,
      `    dm.resetDeferredRegistry();`,
      `  });`,
    ),
    lines(
      `    dm.dropDeferredToken("ZOMBIE2");`,
      ``,
      `    // …and the write-side half of the gate: the registry may only stand in`,
      `    // for a row it has READ (see deferredPushTokens / hydrateDeferredTokens).`,
      `    // Until then its emptiness is ignorance, so the answer is NO LIST rather`,
      `    // than an empty one — while a hydrated empty list is the authoritative`,
      `    // "nothing is owed" the last retirement wave needs to be able to write.`,
      `    assert.equal(dm.deferralRegistryView(2_000).hydrated, false);`,
      `    assert.equal(dm.deferredPushTokens(), undefined, "an unread row is not this registry's to publish");`,
      `    dm.addDeferredToken("ZOMBIE3", 1_000);`,
      `    assert.equal(`,
      `      dm.noteDeferredCoin("ZOMBIE3", { ageMs: OLD, windowMaxAgeMs: WINDOW }, 2_000),`,
      `      true,`,
      `      "(a fresh zombie: the ZOMBIE2 memory was already aged out above ON PURPOSE)",`,
      `    );`,
      `    dm.hydrateDeferredTokens(["LIVE", "ZOMBIE3", "ROW_EXTRA"], 2_000, dm.DEFERRED_REGISTRY_MAX, 2_500);`,
      `    assert.deepEqual(`,
      `      dm.deferredPushTokens(),`,
      `      ["LIVE", "FRESH", "ROW_EXTRA"],`,
      `      "hydration MERGES the row in — and still refuses a coin just retired",`,
      `    );`,
      `    assert.equal(dm.deferralRegistryView(2_500).hydrated, true, "the isolate now has an opinion");`,
      `    dm.dropDeferredToken("LIVE");`,
      `    dm.dropDeferredToken("FRESH");`,
      `    dm.dropDeferredToken("ROW_EXTRA");`,
      `    assert.deepEqual(dm.deferredPushTokens(), [], "a hydrated empty list IS the answer \\"nothing is owed\\"");`,
      `    dm.resetDeferredRegistry();`,
      `    assert.equal(`,
      `      dm.deferredPushTokens(),`,
      `      undefined,`,
      `      "reset returns the registry to un-read (no suite inherits the flag)",`,
      `    );`,
      `  });`,
    ),
    (src) =>
      src.includes(
        `"reset returns the registry to un-read (no suite inherits the flag)"`,
      ),
  ],
  [
    "scripts/test-unit.js",
    "…and the gate test's first shape is corrected on the way (see the note)",
    // The entry above first wrote ZOMBIE2 into the hydrate assertion, which
    // reads well but is WRONG: the seed-guard assertions just before it age
    // ZOMBIE2's retire memory out ON PURPOSE (that is what they prove), so the
    // hydrate legitimately readmits it and the assertion fails with
    // ["LIVE","FRESH","ZOMBIE2","ROW_EXTRA"]. The gate test therefore retires
    // its own fresh coin (ZOMBIE3) and hydrates against that one. This entry
    // only exists for a tree that already ran the earlier shape.
    lines(
      `    dm.hydrateDeferredTokens(["LIVE", "ZOMBIE2", "ROW_EXTRA"], 2_000, dm.DEFERRED_REGISTRY_MAX, 2_500);`,
      `    assert.deepEqual(`,
      `      dm.deferredPushTokens(),`,
      `      ["LIVE", "FRESH", "ROW_EXTRA"],`,
      `      "hydration MERGES the row in — and still refuses the coin just retired",`,
      `    );`,
    ),
    lines(
      `    dm.addDeferredToken("ZOMBIE3", 1_000);`,
      `    assert.equal(`,
      `      dm.noteDeferredCoin("ZOMBIE3", { ageMs: OLD, windowMaxAgeMs: WINDOW }, 2_000),`,
      `      true,`,
      `      "(a fresh zombie: the ZOMBIE2 memory was already aged out above ON PURPOSE)",`,
      `    );`,
      `    dm.hydrateDeferredTokens(["LIVE", "ZOMBIE3", "ROW_EXTRA"], 2_000, dm.DEFERRED_REGISTRY_MAX, 2_500);`,
      `    assert.deepEqual(`,
      `      dm.deferredPushTokens(),`,
      `      ["LIVE", "FRESH", "ROW_EXTRA"],`,
      `      "hydration MERGES the row in — and still refuses a coin just retired",`,
      `    );`,
    ),
    (src) => src.includes(`dm.hydrateDeferredTokens(["LIVE", "ZOMBIE3", "ROW_EXTRA"]`),
  ],
  [
    "scripts/test-unit.js",
    "the wiring guard pins the move, not a scanner flag",
    lines(
      `      "the rule's slack is published with the module":`,
      `        dm.DEFERRED_PRUNE_ATTEMPTS === 3 &&`,
      `        dm.DEFERRED_RETIRE_MEMORY_MS > 0 &&`,
      `        typeof dm.noteDeferredCoin === "function" &&`,
      `        typeof dm.seedDeferredToken === "function",`,
      `      "scanner (a seed may not undo a retirement; only a real deferral re-admits)":`,
      `        scannerSrc.includes(`,
      `          "seed(token:string,at:number):void{seedDeferredToken(token,at,this.maxEntries);}",`,
      `        ) &&`,
      `        scannerSrc.includes("this.deferredPushes.seed(token,Date.now());") &&`,
      `        scannerSrc.includes("deferredRegistryLive=true;") &&`,
      `        scannerSrc.includes(`,
      `          "returndeferredRegistryLive?deferredTokenList():undefined;",`,
      `        ),`,
      `      "worker (the cold-init seed is gated on the row having been READ)":`,
      `        workerSrc.includes(`,
      `          "if(pushDeferralSnapshot){scanner.seedDeferredTokens(pushDeferralSnapshot.pendingTokens);}",`,
      `        ),`,
    ),
    lines(
      `      "the rule's slack is published with the module":`,
      `        dm.DEFERRED_PRUNE_ATTEMPTS === 3 &&`,
      `        dm.DEFERRED_RETIRE_MEMORY_MS > 0 &&`,
      `        typeof dm.noteDeferredCoin === "function" &&`,
      `        typeof dm.seedDeferredToken === "function",`,
      `      "deferredmakeup (the registry owns its own readiness, and a retirement survives a hydrate)":`,
      `        dmSrc.includes("letregistryHydrated=false;") &&`,
      `        dmSrc.includes("registryHydrated=true;") &&`,
      `        dmSrc.includes(`,
      `          "returnregistryHydrated?deferredTokenList():undefined;",`,
      `        ) &&`,
      `        typeof dm.hydrateDeferredTokens === "function" &&`,
      `        typeof dm.deferredPushTokens === "function",`,
      `      "scanner (it hydrates through that one path and keeps no flag of its own)":`,
      `        scannerSrc.includes("hydrateDeferredTokens(tokens,Date.now());") &&`,
      `        !scannerSrc.includes("deferredRegistryLive"),`,
      `      "worker (the cold-init seed is gated on the row having been READ)":`,
      `        workerSrc.includes(`,
      `          "if(pushDeferralSnapshot){scanner.seedDeferredTokens(pushDeferralSnapshot.pendingTokens);}",`,
      `        ) &&`,
      `        workerSrc.includes(`,
      `          'import{deferralRegistryView,deferredPushTokens,feedMakeupView}from"./deferredmakeup";',`,
      `        ),`,
    ),
    (src) => src.includes("the registry owns its own readiness"),
  ],
  [
    "scripts/test-unit.js",
    "the guard reads the registry's module too",
    lines(
      `    const logSrc = read("src/deferrallog.ts");`,
      `    const dm = require(path.join(__dirname, "..", "dist", "deferredmakeup.js"));`,
    ),
    lines(
      `    const logSrc = read("src/deferrallog.ts");`,
      `    const dmSrc = read("src/deferredmakeup.ts");`,
      `    const dm = require(path.join(__dirname, "..", "dist", "deferredmakeup.js"));`,
    ),
    (src) => src.includes(`const dmSrc = read("src/deferredmakeup.ts");`),
  ],
  [
    "scripts/test-deferred-priority.js",
    "the same gated reader, hydrated the way a tick hydrates it",
    lines(
      `const { DeferredPushLedger, deferredPushTokens, slicePoolRotation } = require("../dist/scanner.js");`,
    ),
    lines(
      `const { DeferredPushLedger, slicePoolRotation } = require("../dist/scanner.js");`,
    ),
    (src) =>
      src.includes(
        `const { DeferredPushLedger, slicePoolRotation } = require("../dist/scanner.js");`,
      ),
  ],
  [
    "scripts/test-deferred-priority.js",
    "…imported beside the registry it reads",
    lines(
      `const {`,
      `  isDeferredToken,`,
      `  missingDeferredTokens,`,
      `  DEFERRED_MAKEUP_MAX,`,
      `  feedMakeupView,`,
      `  resetFeedMakeup,`,
      `} = require("../dist/deferredmakeup.js");`,
    ),
    lines(
      `const {`,
      `  deferredPushTokens,`,
      `  hydrateDeferredTokens,`,
      `  isDeferredToken,`,
      `  missingDeferredTokens,`,
      `  DEFERRED_MAKEUP_MAX,`,
      `  feedMakeupView,`,
      `  resetFeedMakeup,`,
      `} = require("../dist/deferredmakeup.js");`,
    ),
    (src) => src.includes(`  hydrateDeferredTokens,\n  isDeferredToken,`),
  ],
  [
    "scripts/test-deferred-priority.js",
    "hydrate before the first publish-shaped read",
    lines(
      `// ---------- the shared registry: one list, bounded, oldest first ----------`,
      `const reg = new DeferredPushLedger();`,
    ),
    lines(
      `// ---------- the shared registry: one list, bounded, oldest first ----------`,
      `// …and it is only fit to stand in for the durable row once a tick has READ`,
      `// that row into it (see deferredPushTokens): the write path must be able to`,
      `// tell "nothing is owed" (an authoritative list, empty included) from "no`,
      `// list at all". The suite hydrates the way Scanner.seedDeferredTokens does.`,
      `hydrateDeferredTokens([], 0);`,
      `const reg = new DeferredPushLedger();`,
    ),
    (src) => src.includes(`hydrateDeferredTokens([], 0);`),
  ],
  [
    "docs/round-trips.md",
    "§4.27 records where the readiness gate ended up",
    DOC_ANCHOR,
    DOC_ANCHOR + "\n" + DOC_NOTE,
    (src) => src.includes("readiness 由 scanner 搬返 registry"),
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
