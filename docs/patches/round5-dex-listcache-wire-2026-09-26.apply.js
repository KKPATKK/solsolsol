#!/usr/bin/env node
/**
 * Round 5e, second half (2026-09-26): the ledger src/dexscreener.ts now keeps
 * becomes DURABLE — the scanner journals it on the tick's own front write.
 *
 * WHY THE SCANNER: it is the only caller that runs once per tick, owns the
 * tick's single write (flushScanFront) and reports the summary the same window
 * describes. The delta is therefore taken exactly where the summary's `dex:`
 * snapshot is taken, so the durable counters and the page's own reading cover
 * the SAME window (the previous tick's fetches — the one-tick carry the
 * pushWatch note already documents).
 *
 * WHY THE PEEK/CONSUME PAIR AND NOT ONE CALL: the two ADDs and the label are
 * three rows whose writes fail INDEPENDENTLY on the no-front path (a standalone
 * Scanner, where each row is its own request). So each part is committed only
 * after its own write landed (consumeListCacheDelta's second argument):
 *
 *   - a row that failed is re-offered by the next tick (nothing is dropped);
 *   - a row that landed is never written twice (nothing is double counted).
 *
 * The one loss left is named in the code: the QUEUED front write is emptied
 * before its batch (flushScanFront deliberately does not re-offer a rejected
 * batch), so a tick whose front never landed loses its window — the same tick
 * whose summary was lost with it, which is why the ratio stays unbiased.
 *
 * Db.bumpTelemetryCounter becomes public for the no-front ADD path: its SQL is
 * the only ADD in the repo, and inventing a second copy of it beside
 * ScanFrontWrite.add is how two counter rules drift apart.
 *
 * This script CHECKS ITS POST-CONDITIONS ON THE PROSPECTIVE CONTENT, before
 * anything reaches the disk: a post-condition that fails on an already-written
 * file is a report, not a gate.
 *
 * Run: node docs/patches/round5-dex-listcache-wire-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new] */
const EDITS = [
  [
    "src/dexscreener.ts",
    "the consume takes the LANDED ack (three rows, three failures)",
    lines(
      "/**",
      " * Commit exactly the delta a LANDED write persisted. The baseline is taken",
      " * from the live ledger rather than from the delta, so an outcome that arrived",
      " * while the write was in flight is deferred to the next delta instead of",
      " * being lost or double counted.",
      " */",
      "export function consumeListCacheDelta(delta: ListCacheDelta): void {",
      "  listCacheBaseline = {",
      "    hits: listCacheLedger.hits,",
      "    misses: listCacheLedger.misses,",
      "  };",
      "  if (delta.status !== null) listCacheLedger.reported = delta.status;",
      "}",
    ),
    lines(
      "/**",
      " * Which rows of a peeked delta actually landed. Absent means NOT landed, so a",
      " * partial write commits only the rows it wrote.",
      " */",
      "export interface ListCacheDeltaLanded {",
      "  hits?: boolean;",
      "  misses?: boolean;",
      "  status?: boolean;",
      "}",
      "",
      "/**",
      " * Commit the parts of a peeked delta whose writes LANDED, and only those: a",
      " * row that failed is re-offered by the next peek, and a row that landed is",
      " * never written twice. The baseline advances by the delta rather than",
      " * jumping to the live ledger, so an outcome that arrived while the write was",
      " * in flight stays part of the NEXT delta instead of being lost or counted",
      " * once for two windows.",
      " *",
      " * The default acks everything, which is the QUEUED case (a front is present:",
      " * the row is on the tick's one write and there is nothing to retry yet).",
      " */",
      "export function consumeListCacheDelta(",
      "  delta: ListCacheDelta,",
      "  landed: ListCacheDeltaLanded = { hits: true, misses: true, status: true },",
      "): void {",
      "  if (landed.hits) listCacheBaseline.hits += delta.hits;",
      "  if (landed.misses) listCacheBaseline.misses += delta.misses;",
      "  if (landed.status && delta.status !== null) {",
      "    listCacheLedger.reported = delta.status;",
      "  }",
      "}",
    ),
  ],
  [
    "src/db.ts",
    "bumpTelemetryCounter: the second caller is the no-front ADD path",
    lines(
      "   * Telemetry only — a failed bump must never fail the write it follows.",
      "   */",
      "  private async bumpTelemetryCounter(",
    ),
    lines(
      "   * Telemetry only — a failed bump must never fail the write it follows.",
      "   *",
      "   * PUBLIC because there is a second ADD path with the same contract:",
      "   * Scanner.stampListCacheDelta writes its counters through this method when",
      "   * the scanner has no front (a standalone Scanner, see Scanner.stampFront).",
      "   * The SQL is inside, so the two paths cannot come to disagree about what an",
      "   * ADD is — and the swallowing above is exactly what that path needs.",
      "   */",
      "  async bumpTelemetryCounter(",
    ),
  ],
  [
    "src/scanner.ts",
    "import the ledger and its durable key names",
    lines(
      'import { DexScreenerClient, type PairInfo, type TokenProfile } from "./dexscreener";',
    ),
    lines(
      "import {",
      "  DexScreenerClient,",
      "  consumeListCacheDelta,",
      "  peekListCacheDelta,",
      "  DEX_LIST_CACHE_HITS_KEY,",
      "  DEX_LIST_CACHE_LAST_KEY,",
      "  DEX_LIST_CACHE_MISSES_KEY,",
      "  type PairInfo,",
      "  type TokenProfile,",
      '} from "./dexscreener";',
    ),
  ],
  [
    "src/scanner.ts",
    "stampFront learns the ADD shape (see ScanFrontWrite.add)",
    lines(
      "  /**",
      "   * Queue one front bookkeeping row on the tick's single write, or write it on",
      "   * its own when there is no front (a standalone Scanner).",
      "   */",
      "  private async stampFront(key: string, value: string): Promise<void> {",
      "    const front = this.scanFront;",
      "    if (front) {",
      "      front.writes.push({ key, value });",
      "      return;",
      "    }",
      "    await this.db.setWorkerState(key, value);",
      "  }",
    ),
    lines(
      "  /**",
      "   * Queue one front bookkeeping row on the tick's single write, or write it on",
      "   * its own when there is no front (a standalone Scanner).",
      "   *",
      "   * `add` is the counter shape (see ScanFrontWrite.add): the row is",
      "   * INCREMENTED instead of replaced. A counted zero is a no-op on both paths,",
      "   * exactly as Db.frontStamp treats it, so the caller does not have to know.",
      "   */",
      "  private async stampFront(",
      "    key: string,",
      "    value: string,",
      "    add = false,",
      "  ): Promise<void> {",
      "    if (add && Number(value) === 0) return;",
      "    const front = this.scanFront;",
      "    if (front) {",
      "      front.writes.push({ key, value, add });",
      "      return;",
      "    }",
      "    if (add) {",
      "      await this.db.bumpTelemetryCounter(key, Number(value));",
      "      return;",
      "    }",
      "    await this.db.setWorkerState(key, value);",
      "  }",
      "",
      "  /**",
      "   * Journal the list-feed edge cache (see src/dexscreener.ts). Called once per",
      "   * scan, immediately before the summary's `dex:` snapshot is taken, so the",
      "   * durable rows and that snapshot describe the same window.",
      "   *",
      "   * Each part is committed only after its own write landed (see",
      "   * consumeListCacheDelta): a row that failed is re-offered by the next tick,",
      "   * and a row that landed is never written twice. The loss that remains is the",
      "   * QUEUED front write itself — flushScanFront empties its buffer before the",
      "   * batch and does not re-offer a rejected one (see the note there) — i.e. the",
      "   * tick whose summary was lost with it, which leaves the ratio unbiased.",
      "   *",
      "   * Telemetry only: a counter may never cost or break the scan.",
      "   */",
      "  async stampListCacheDelta(): Promise<void> {",
      "    const delta = peekListCacheDelta();",
      "    if (delta.hits === 0 && delta.misses === 0 && delta.status === null) return;",
      "    const landed = { hits: false, misses: false, status: false };",
      "    const stamp = async (",
      "      key: string,",
      "      value: string,",
      "      add: boolean,",
      "      part: keyof typeof landed,",
      "    ): Promise<void> => {",
      "      try {",
      "        await this.stampFront(key, value, add);",
      "        landed[part] = true;",
      "      } catch (err) {",
      '        console.warn("[scanner] list-cache counter write failed:", err);',
      "      }",
      "    };",
      "    if (delta.hits > 0) {",
      '      await stamp(DEX_LIST_CACHE_HITS_KEY, String(delta.hits), true, "hits");',
      "    }",
      "    if (delta.misses > 0) {",
      '      await stamp(DEX_LIST_CACHE_MISSES_KEY, String(delta.misses), true, "misses");',
      "    }",
      "    if (delta.status !== null) {",
      '      await stamp(DEX_LIST_CACHE_LAST_KEY, delta.status, false, "status");',
      "    }",
      "    consumeListCacheDelta(delta, landed);",
      "  }",
    ),
  ],
  [
    "src/scanner.ts",
    "the scan reports it where the dex snapshot is taken",
    lines(
      "    const diag: ScanSummary = {",
      "      // Carried from the previous tick's tracker pass, which runs AFTER this",
    ),
    lines(
      "    // The list-feed edge cache is JOURNALED here (see stampListCacheDelta):",
      "    // the client's own counters are isolate memory, so the question they exist",
      "    // to answer — is LIST_FEED_CACHE_TTL_S leaving the entry expired by the",
      "    // time the next tick asks? — could not be answered from /health at all.",
      "    // Same point as the `dex:` snapshot below, so the durable rows and that",
      "    // snapshot cover one window.",
      "    await this.stampListCacheDelta();",
      "    const diag: ScanSummary = {",
      "      // Carried from the previous tick's tracker pass, which runs AFTER this",
    ),
  ],
];

/**
 * [what, fn(prospective sources)] — evaluated BEFORE writing, so a failed check
 * refuses the whole patch instead of describing it afterwards.
 */
const CHECKS = [
  [
    "the ADD SQL is still the two copies it had (writeScanFront + the bump)",
    ({ db }) => hits(db, "CAST(value AS INTEGER) + excluded.value") === 2,
  ],
  [
    "the bump is reachable from the scanner",
    ({ db }) => db.includes("  async bumpTelemetryCounter("),
  ],
  ["no private bump left", ({ db }) => db.includes("private async bumpTelemetryCounter") === false],
  [
    "the scanner journals exactly once",
    ({ sc }) => hits(sc, "await this.stampListCacheDelta()") === 1,
  ],
  [
    "and it journals BEFORE the summary reads its dex snapshot",
    ({ sc }) =>
      sc.indexOf("await this.stampListCacheDelta();") !== -1 &&
      sc.indexOf("await this.stampListCacheDelta();") < sc.indexOf("dex: this.dex.getStats(),"),
  ],
  ["no stray literal key in the scanner", ({ sc }) => hits(sc, "dex_list_cache_") === 0],
  [
    "one ADD caller in the scanner, and it is the stamp helper",
    ({ sc }) => hits(sc, "this.db.bumpTelemetryCounter(") === 1,
  ],
  [
    "the landed ack is what the scanner commits with",
    ({ sc }) => hits(sc, "consumeListCacheDelta(delta, landed)") === 1,
  ],
  [
    "the ledger's one-arg consume is gone",
    ({ dex }) => dex.includes("export function consumeListCacheDelta(") &&
      dex.includes("landed: ListCacheDeltaLanded"),
  ],
];

// ---------------------------------------------------------------- verify ----
let failed = 0;
const prospective = new Map();
for (const [file, label, old, next] of EDITS) {
  const src = prospective.get(file) ?? read(file);
  const n = hits(src, old);
  if (n !== 1) {
    console.error(`✗ ${file}: ${label} — anchor matched ${n} times, need exactly 1`);
    failed += 1;
    continue;
  }
  if (src.includes(next) && next !== old) {
    console.error(`✗ ${file}: ${label} — already applied`);
    failed += 1;
    continue;
  }
  prospective.set(file, src.replace(old, next));
}

const after = {
  db: prospective.get("src/db.ts") ?? read("src/db.ts"),
  sc: prospective.get("src/scanner.ts") ?? read("src/scanner.ts"),
  dex: prospective.get("src/dexscreener.ts") ?? read("src/dexscreener.ts"),
};
for (const [what, fn] of CHECKS) {
  let ok = false;
  try {
    ok = fn(after);
  } catch (err) {
    console.error(`✗ post-condition threw: ${what}: ${err.message}`);
    failed += 1;
    continue;
  }
  if (!ok) {
    console.error(`✗ post-condition failed: ${what}`);
    failed += 1;
  }
}
if (failed > 0) {
  console.error(`\n${failed} problem(s) — nothing written.`);
  process.exit(1);
}

// ---------------------------------------------------------------- write ----
for (const file of prospective.keys()) {
  fs.writeFileSync(path.join(root, file), prospective.get(file));
}
for (const [file, label] of EDITS) console.log(`✓ ${file}: ${label}`);
console.log("\nall post-conditions hold (checked BEFORE the write).");
