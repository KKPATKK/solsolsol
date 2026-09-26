#!/usr/bin/env node
/**
 * Deferred-prune seed guard (2026-09-26): stop the tail's re-seed from undoing
 * a retirement inside the same tick, and let an authoritative empty list clear
 * the row.
 *
 * WHAT THE SECOND DEPLOY SHOWED. The same-tick refresh worked (live: `tick
 * deferObserved 9 deferPruned 4`, `durable.prunedTotal 38 → 41`) but `pending`
 * never left 21. The reason is the tail's own ordering: `refreshMirror()` seeds
 * the registry from the durable row (deliberately, BEFORE the write — that seed
 * is what stops a duplicate push on a tick whose write never lands), so the
 * tokens retired moments earlier in `matchCoins` were re-added from the row
 * that had not been written yet — and the write then published them again. A
 * retirement could not survive its own tick.
 *
 * TWO HALVES, one shape:
 *
 *  1. THE REGISTRY REMEMBERS (src/deferredmakeup.ts, already applied): a
 *     retired token is refused by the SEED path for DEFERRED_RETIRE_MEMORY_MS,
 *     while a real `defer()` — which only happens when a card send was refused
 *     after the gates accepted the coin — still readmits it. Past the memory
 *     window the row is allowed to win again: the failure mode is a wasted
 *     observation, never a duplicate card.
 *  2. THE LAST WAVE NEEDS AN EMPTY LIST TO MEAN SOMETHING. On the tick that
 *     retires the final obligation the registry is empty, and the writer's
 *     "never wipe on an empty list" rule (chosen when no caller could tell
 *     "nothing owed" from "never read the row") would keep it forever. So the
 *     readiness is now explicit: `deferredPushTokens()` answers `undefined`
 *     until a scanner in this isolate has hydrated from that very row, and the
 *     writer treats a list — including an empty one — as authoritative.
 *
 * Run: node docs/patches/deferred-prune-seed-guard-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const DOC_ANCHOR = '落線後第一個 bug（同日修）：counter 一定要喺同一 tick refresh。';
const DOC_NOTE = lines(
  '**落線後第二個 bug（同日修）：tick 尾嘅 re-seed 會喺同一 tick 內 undo 退場。** 修好 refresh 之後，live 讀數係',
  '`deferObserved 9 deferPruned 4`、`prunedTotal 38 → 41` —— 規則真係行緊，但 `pending` 企喺 21 唔跌。',
  '原因係 tick 尾嘅次序：`refreshMirror()` 會由 durable row **re-seed** 落 registry（呢個 seed 係刻意放喺寫入之前 ——',
  '佢就係「寫入失敗都唔會重覆推卡」嘅一半），所以 `matchCoins` 啱啱退咗嘅 token 即刻由未更新嘅 row 加返，',
  '而同一 tick 嘅寫入又將佢哋 publish 出去 —— **一個退場捱唔過自己嗰個 tick**。',
  '',
  '兩半，一個形狀：',
  '',
  '1. **registry 會記住**：退場嘅 token 喺 `DEFERRED_RETIRE_MEMORY_MS`（15 分鐘）之內畀 seed 路徑拒收 ——',
  '   但**唔會**擋真正嘅 `defer()`（佢只會喺卡片 send 被拒、而閘門已經放行之後發生，係更新鮮嘅「live」證據）；',
  '   記憶過期之後 row 又可以贏返：失敗模式係「多一次觀測」，唔會係重覆卡。',
  '2. **最後一波需要「空清單」有意義**：退到最後一條嗰 tick registry 係空，而寫入器原本「空清單唔會 wipe」嘅規矩',
  '   （訂立嗰陣冇 caller 分得到「冇欠單」同「未讀過 row」）會令佢永遠清唔到。',
  '   而家 readiness 係明示嘅：`deferredPushTokens()` 喺本 isolate 未 hydrate 過 row 之前答 `undefined`，',
  '   而寫入器將任何**清單（包括空）**當權威 —— 空 = 真係冇欠單。',
  '',
);

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "src/scanner.ts",
    "the seed path is imported",
    lines(
      `  isDeferredToken,`,
      `  missingDeferredTokens,`,
      `  noteDeferredCoin,`,
      `} from "./deferredmakeup";`,
    ),
    lines(
      `  isDeferredToken,`,
      `  missingDeferredTokens,`,
      `  noteDeferredCoin,`,
      `  seedDeferredToken,`,
      `} from "./deferredmakeup";`,
    ),
    (src) => src.includes("  seedDeferredToken,"),
  ],
  [
    "src/scanner.ts",
    "the ledger's seed path is distinct from a real deferral",
    lines(
      `  /** Record that \`token\` was refused a card (idempotent per token). */`,
      `  defer(token: string, at: number): void {`,
      `    addDeferredToken(token, at, this.maxEntries);`,
      `  }`,
    ),
    lines(
      `  /** Record that \`token\` was refused a card (idempotent per token). */`,
      `  defer(token: string, at: number): void {`,
      `    addDeferredToken(token, at, this.maxEntries);`,
      `  }`,
      ``,
      `  /**`,
      `   * Hydrate one obligation from the durable row (see seedDeferredToken): a`,
      `   * re-hydrate, so a coin this isolate has just retired stays retired until`,
      `   * the write that removes it from the row lands. Deliberately NOT what`,
      `   * \`defer\` does: a real deferral means the coin's card was refused after`,
      `   * the gates accepted it, which outranks an earlier retirement.`,
      `   */`,
      `  seed(token: string, at: number): void {`,
      `    seedDeferredToken(token, at, this.maxEntries);`,
      `  }`,
    ),
    (src) => src.includes("seed(token: string, at: number): void {"),
  ],
  [
    "src/scanner.ts",
    "a hydrated registry is what makes its emptiness authoritative",
    lines(
      `/** Pending deferred-card identities for the worker's post-flush persistence. */`,
      `export function deferredPushTokens(): string[] {`,
      `  return deferredTokenList();`,
      `}`,
    ),
    lines(
      `/**`,
      ` * Whether the deferred registry has been hydrated from the durable row in`,
      ` * this isolate (see Scanner.seedDeferredTokens). Until it has, its emptiness`,
      ` * is ignorance, not information.`,
      ` */`,
      `let deferredRegistryLive = false;`,
      ``,
      `/**`,
      ` * Pending deferred-card identities for the worker's post-flush persistence —`,
      ` * or \`undefined\` when no scanner in this isolate has ever hydrated from the`,
      ` * durable row.`,
      ` *`,
      ` * The distinction is what makes an authoritative EMPTY list possible: the`,
      ` * writer clears the stored pending list when a caller hands it one (see`,
      ` * nextPushDeferralSnapshot), which the prune rule's LAST wave needs — while`,
      ` * an isolate that never read the row must say "I have no list", never`,
      ` * "nothing is owed". Live 2026-09-26, before this gate existed: retired`,
      ` * tokens came straight back on the tail's re-seed and the same write`,
      ` * published them again (\`prunedTotal\` rising while \`pending\` stayed 21).`,
      ` */`,
      `export function deferredPushTokens(): string[] | undefined {`,
      `  return deferredRegistryLive ? deferredTokenList() : undefined;`,
      `}`,
    ),
    (src) => src.includes("let deferredRegistryLive = false;"),
  ],
  [
    "src/scanner.ts",
    "and the seed marks it (a re-hydrate, not a deferral)",
    lines(
      `  /** Hydrate durable deferred-card obligations when an isolate is recycled. */`,
      `  seedDeferredTokens(tokens: string[]): void {`,
      `    for (const token of tokens.slice(-500)) {`,
      `      if (typeof token === "string" && token.length > 0) {`,
      `        this.deferredPushes.defer(token, Date.now());`,
      `      }`,
      `    }`,
      `  }`,
    ),
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
    (src) => src.includes("this.deferredPushes.seed(token, Date.now());"),
  ],
  [
    "src/worker.ts",
    "the cold-init seed is gated on the row having been READ",
    lines(
      `        // Hydrate durable deferred-card identities before the first scan in`,
      `        // this isolate; counters alone cannot guarantee a make-up push.`,
      `        scanner.seedDeferredTokens(pushDeferralSnapshot?.pendingTokens ?? []);`,
    ),
    lines(
      `        // Hydrate durable deferred-card identities before the first scan in`,
      `        // this isolate; counters alone cannot guarantee a make-up push. Gated`,
      `        // on the row having been READ: seeding also marks the registry`,
      `        // authoritative for the tick-tail write (see`,
      `        // scanner.deferredPushTokens), and an isolate that never read this`,
      `        // row must not be able to clear it.`,
      `        if (pushDeferralSnapshot) {`,
      `          scanner.seedDeferredTokens(pushDeferralSnapshot.pendingTokens);`,
      `        }`,
    ),
    (src) => src.includes("if (pushDeferralSnapshot) {\n          scanner.seedDeferredTokens(pushDeferralSnapshot.pendingTokens);"),
  ],
  [
    "scripts/test-unit.js",
    "the gauge test pins the authoritative-empty contract",
    lines(
      `    // An EMPTY list from a caller that read its store still never wipes it — a`,
      `    // lost obligation is a missed card, an extra one is a duplicate, and only`,
      `    // one of those is recoverable. The gauge follows the list that is KEPT, so`,
      `    // the two stay one fact in this branch too.`,
      `    const empty = nextPushDeferralSnapshot(`,
      `      JSON.stringify(dupes),`,
      `      { deferred: 0, recovered: 0, stalled: 0, pending: 4 },`,
      `      3_000,`,
      `      null,`,
      `      [],`,
      `    );`,
      `    assert.deepEqual(empty.pendingTokens, ["AAA", "BBB"], "an empty list never wipes the store");`,
      `    assert.equal(empty.pending, 2, "and the gauge still matches the list that was kept");`,
      `    // No list at all keeps the legacy contract: the caller's count is the gauge.`,
      `    const legacy = nextPushDeferralSnapshot(`,
      `      JSON.stringify(empty),`,
      `      { deferred: 0, recovered: 0, stalled: 0, pending: 3 },`,
      `      4_000,`,
      `    );`,
      `    assert.equal(legacy.pending, 3, "no list → the caller's count stands");`,
      `    assert.deepEqual(legacy.pendingTokens, ["AAA", "BBB"], "and the stored list is untouched");`,
    ),
    lines(
      `    // An EMPTY list from a caller that HAS read its store is AUTHORITATIVE`,
      `    // (2026-09-26): "0 owed" is a real answer, and the prune rule needs it —`,
      `    // on the tick that retires the last obligation, keeping the stored list`,
      `    // would leave the row carrying tokens no isolate believes in any more,`,
      `    // re-seeded into every later isolate forever.`,
      `    const cleared = nextPushDeferralSnapshot(`,
      `      JSON.stringify(dupes),`,
      `      { deferred: 0, recovered: 0, stalled: 0, pending: 4 },`,
      `      3_000,`,
      `      null,`,
      `      [],`,
      `    );`,
      `    assert.deepEqual(cleared.pendingTokens, [], "an authoritative empty list clears the store");`,
      `    assert.equal(cleared.pending, 0, "and the gauge is its length");`,
      `    // NO list at all keeps the legacy contract — that caller has NOT read its`,
      `    // store (a cold isolate with no scanner), so it may not clear anything`,
      `    // and the caller's count stands as the gauge.`,
      `    const legacy = nextPushDeferralSnapshot(`,
      `      JSON.stringify(cleared),`,
      `      { deferred: 0, recovered: 0, stalled: 0, pending: 3 },`,
      `      4_000,`,
      `    );`,
      `    assert.equal(legacy.pending, 3, "no list → the caller's count stands");`,
      `    assert.deepEqual(legacy.pendingTokens, [], "and the stored list is untouched");`,
    ),
    (src) => src.includes("an authoritative empty list clears the store"),
  ],
  [
    "scripts/test-unit.js",
    "the registry test pins the seed guard",
    lines(
      `    assert.equal(view.firstPruneAt, 2_000);`,
      `    assert.equal(view.lastPruneAt, 2_000);`,
      `    dm.resetDeferredRegistry();`,
      `  });`,
    ),
    lines(
      `    assert.equal(view.firstPruneAt, 2_000);`,
      `    assert.equal(view.lastPruneAt, 2_000);`,
      `    assert.equal(view.retireMemory, 2, "and it remembers what it retired (see below)");`,
      ``,
      `    // The SEED path may not undo a retirement while the row write is still in`,
      `    // flight (2026-09-26, second bug of that day): the tick tail re-seeds from`,
      `    // the row BEFORE the write that shrinks it, so without this memory a whole`,
      `    // tick's work is undone inside one invocation — live, prunedTotal rose`,
      `    // while pending stayed at 21.`,
      `    dm.addDeferredToken("ZOMBIE2", 1_000);`,
      `    assert.equal(`,
      `      dm.noteDeferredCoin("ZOMBIE2", { ageMs: OLD, windowMaxAgeMs: WINDOW }, 2_000),`,
      `      true,`,
      `    );`,
      `    assert.equal(`,
      `      dm.seedDeferredToken("ZOMBIE2", 1_000, dm.DEFERRED_REGISTRY_MAX, 2_500),`,
      `      false,`,
      `      "a seed of a just-retired coin is refused while the row still lists it",`,
      `    );`,
      `    assert.equal(dm.isDeferredToken("ZOMBIE2"), false);`,
      `    assert.equal(`,
      `      dm.seedDeferredToken(`,
      `        "ZOMBIE2",`,
      `        1_000,`,
      `        dm.DEFERRED_REGISTRY_MAX,`,
      `        2_500 + dm.DEFERRED_RETIRE_MEMORY_MS,`,
      `      ),`,
      `      true,`,
      `      "past the memory window the row may re-seed it (re-observed, re-retired — never a duplicate card)",`,
      `    );`,
      `    dm.dropDeferredToken("ZOMBIE2");`,
      `    dm.resetDeferredRegistry();`,
      `  });`,
    ),
    (src) => src.includes("a seed of a just-retired coin is refused while the row still lists it"),
  ],
  [
    "scripts/test-unit.js",
    "the wiring guard pins both halves",
    lines(
      `    const scannerSrc = read("src/scanner.ts");`,
      `    const workerSrc = read("src/worker.ts");`,
      `    const dm = require(path.join(__dirname, "..", "dist", "deferredmakeup.js"));`,
    ),
    lines(
      `    const scannerSrc = read("src/scanner.ts");`,
      `    const workerSrc = read("src/worker.ts");`,
      `    const logSrc = read("src/deferrallog.ts");`,
      `    const dm = require(path.join(__dirname, "..", "dist", "deferredmakeup.js"));`,
    ),
    (src) => src.includes('const logSrc = read("src/deferrallog.ts");'),
  ],
  [
    "scripts/test-unit.js",
    "…including the seed guard and the authoritative empty list",
    lines(
      `      "the rule's slack is published with the module":`,
      `        dm.DEFERRED_PRUNE_ATTEMPTS === 3 && typeof dm.noteDeferredCoin === "function",`,
    ),
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
      `      "the writer (an authoritative empty list is an answer, not a no-op)":`,
      `        logSrc.includes(`,
      `          "constcatalogued=hasList?[...newSet(pendingTokens)].slice(-500):prev.pendingTokens;",`,
      `        ),`,
    ),
    (src) => src.includes("a seed may not undo a retirement; only a real deferral re-admits"),
  ],
  [
    "docs/round-trips.md",
    "§4.26 records the seed-guard lesson too",
    DOC_ANCHOR,
    DOC_NOTE + DOC_ANCHOR,
    (src) => src.includes("落線後第二個 bug（同日修）：tick 尾嘅 re-seed"),
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
