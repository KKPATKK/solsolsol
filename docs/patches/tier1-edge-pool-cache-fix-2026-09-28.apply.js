/*
 * Fix-ups for tier1-edge-pool-cache-2026-09-28.apply.js:
 *
 * 1) Its summary edit used an anchor that SURVIVES the edit (`poolWaitMs?:
 *    number;` stays in place), so a second run duplicated the poolCache doc
 *    block. Two are collapsed back to one here.
 * 2) getReevalPoolCached declares its own opts type, which had no `now`, so the
 *    dispatch's pinned clock (needed for the query's rotation slot to equal the
 *    snapshot key's slot) did not typecheck. It accepts it now and it is passed
 *    straight through to Db.getReevalPool.
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const scannerPath = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(scannerPath, "utf8");
const log = [];
let failed = 0;

const DOC = `  /**
   * Edge-cache ledger for the re-eval pool snapshot (see POOL_EDGE_CACHE_URL):
   * hits is work Turso did not do, misses is the read that then seeded the
   * cache, memory is the in-memory query cache answering first (the snapshot
   * was never consulted). available: false means this runtime has no Cache API
   * at all (the Node container entry), not that the cache is broken.
   */
  poolCache?: ReturnType<typeof poolCacheView>;
`;

const n = src.split(DOC).length - 1;
if (n === 1) {
  log.push(["=", "summary: exactly one poolCache block (already applied)"]);
} else if (n === 0) {
  log.push(["✗", "summary: the poolCache block is missing"]);
  failed += 1;
} else {
  const first = src.indexOf(DOC);
  const rest = src.slice(first + DOC.length).split(DOC).join("");
  src = src.slice(0, first + DOC.length) + rest;
  if (src.split(DOC).length - 1 !== 1) {
    log.push(["✗", "summary: collapsing the duplicates did not leave exactly one"]);
    failed += 1;
  } else {
    log.push(["✓", `summary: collapsed ${n} poolCache blocks to one`]);
  }
}

const OPT_ANCHOR = `    opts: {
      sinceMs: number;
      minLaunchMs: number;
      maxLaunchMs: number;
      windowEntryLaunchMs: number;
      limit: number;
      nearSlots?: number;
      farSlots?: number;
      rotationPeriodMs?: number;
      minQualifyMcap?: number;
      maxQualifyMcap?: number;
      minQualifyLiquidity?: number;
      seenChatIds?: string[];
    },
  ): Promise<TokenStats[]> {`;
const OPT_NEW = `    opts: {
      /**
       * The tick's clock, passed through to the query (Db.getReevalPool reads
       * it instead of calling Date.now()): the query's rotation slot and the
       * edge-cache key's slot MUST be the same number, and two independent
       * clock reads are exactly how they stop being it on a slot boundary.
       */
      now?: number;
      sinceMs: number;
      minLaunchMs: number;
      maxLaunchMs: number;
      windowEntryLaunchMs: number;
      limit: number;
      nearSlots?: number;
      farSlots?: number;
      rotationPeriodMs?: number;
      minQualifyMcap?: number;
      maxQualifyMcap?: number;
      minQualifyLiquidity?: number;
      seenChatIds?: string[];
    },
  ): Promise<TokenStats[]> {`;

if (src.includes("      now?: number;\n      sinceMs: number;")) {
  log.push(["=", "getReevalPoolCached: accepts the pinned clock (already applied)"]);
} else {
  const at = src.split(OPT_ANCHOR).length - 1;
  if (at !== 1) {
    log.push(["✗", `getReevalPoolCached: opts anchor found ${at} times`]);
    failed += 1;
  } else {
    src = src.replace(OPT_ANCHOR, () => OPT_NEW);
    log.push(["✓", "getReevalPoolCached: accepts the pinned clock"]);
  }
}

for (const [m, t] of log) console.log(`${m} ${t}`);
if (failed === 0) fs.writeFileSync(scannerPath, src);
else console.log("✗ refused to write");
process.exit(failed === 0 ? 0 : 1);
