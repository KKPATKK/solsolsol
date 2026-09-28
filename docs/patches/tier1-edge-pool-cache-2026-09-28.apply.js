/*
 * Tier 1 item 3 (2026-09-28): stop paying the re-eval pool's Turso read on
 * every cold tick. The snapshot is cached in the colo's edge cache
 * (Cloudflare Cache API), keyed by the SAME rotation slot the DB query uses,
 * so an entry can never answer for a later slot and the worst a stale snapshot
 * can do is re-offer a coin (the push path re-checks isTokenSeen).
 *
 * Also adds Db.poolRotationSlot so the key's slot and the query's slot are one
 * computation instead of two copies of the same expression.
 *
 * Idempotent (a second run reports `=` for every edit).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const dbPath = path.join(ROOT, "src", "db.ts");
const scannerPath = path.join(ROOT, "src", "scanner.ts");

const log = [];
let failed = 0;

function editIn(file, name, from, to, opts = {}) {
  let src = fs.readFileSync(file, "utf8");
  // `uniqueTo`: the replacement text is unique in the file, so its presence
  // means the edit already landed — needed where the ANCHOR survives the edit
  // (the summary field, whose `poolWaitMs?: number;` line stays in place, which
  // is what duplicated the doc block on the first re-run).
  if ((opts.uniqueTo && src.includes(to)) || (src.includes(to) && !src.includes(from))) {
    log.push(["=", `${name} (already applied)`]);
    return;
  }
  const n = src.split(from).length - 1;
  if (n === 0 || (!opts.all && n !== 1)) {
    log.push(["✗", `${name} — anchor found ${n} times`]);
    failed += 1;
    return;
  }
  src = opts.all ? src.split(from).join(to) : src.replace(from, () => to);
  fs.writeFileSync(file, src);
  log.push(["✓", `${name}${n > 1 ? ` (${n} sites)` : ""}`]);
}

// ============================================================ db.ts: the slot
const SLOT_ANCHOR = `      const slot = Math.floor(now / (opts.rotationPeriodMs ?? POOL_ROTATION_PERIOD_MS));`;
const SLOT_NEW = `      const slot = poolRotationSlot(now, opts.rotationPeriodMs);`;

const SLOT_HELPER = `/**
 * The graduated-rotation slot for a clock reading — the ONE computation behind
 * both pool queries AND the edge-cache key that fronts them (2026-09-28).
 *
 * It was two identical inline expressions (getReevalPool and
 * getReevalPoolBatched) until the pool snapshot cache needed the same slot in
 * its URL. A third copy is the kind of drift that turns into "the cache
 * answered for the wrong window", so it lives here now. Callers must pass the
 * same rotationPeriodMs they pass in the query opts — production uses the
 * configured REEVAL_POOL_CACHE_SECONDS, which is also the cache TTL, so each
 * expiry advances to the next slot.
 */
export function poolRotationSlot(
  now: number,
  rotationPeriodMs: number = POOL_ROTATION_PERIOD_MS,
): number {
  return Math.floor(now / rotationPeriodMs);
}

`;

(function insertSlotHelper() {
  let src = fs.readFileSync(dbPath, "utf8");
  if (src.includes("export function poolRotationSlot(")) {
    log.push(["=", "db: poolRotationSlot helper (already applied)"]);
    return;
  }
  const anchor = `export class Db {`;
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    log.push(["✗", `db: poolRotationSlot helper — anchor found ${n} times`]);
    failed += 1;
    return;
  }
  src = src.replace(anchor, () => SLOT_HELPER + anchor);
  fs.writeFileSync(dbPath, src);
  log.push(["✓", "db: poolRotationSlot helper"]);
})();
editIn(dbPath, "db: both slot computations use the helper", SLOT_ANCHOR, SLOT_NEW, {
  all: true,
});

// ====================================== scanner.ts: the edge-cache module block
const CACHE_BLOCK = `/**
 * The re-eval pool's EDGE cache — Cloudflare's Cache API (caches.default) —
 * which is what makes one pool read serve the whole colo instead of one
 * isolate.
 *
 * WHY (2026-09-28): the read is a Turso round trip of 230-770ms (live
 * dbSteps.getReevalPool) and the in-memory query cache below only covers the
 * isolate that made it. Isolates are recycled constantly here, so most cron
 * ticks were cold and paid the read in full. Keyed by rotation slot, the
 * snapshot is shared: the read happens about once per slot per colo.
 *
 * WHAT IS CACHED: one rotation slot's pool QUERY RESULT and nothing else — no
 * seen-state, no gate decisions. A stale snapshot cannot double-push, because
 * the push path re-checks isTokenSeen (exactly the "candidates 1 / pushed 0"
 * dedupe the tick already reports) and every gate is re-evaluated from live
 * pair data; the worst case is re-offering a coin pushed seconds ago.
 *
 * THE KEY IS THE CORRECTNESS BOUNDARY, NOT THE TTL: the URL carries the
 * rotation slot, so an entry can never answer for a later slot. The TTL only
 * decides how long an unreferenced entry lingers, and it is derived from the
 * same configured period as the in-memory cache so the two expire together.
 *
 * Failure is safe and is never silent: a runtime without the Cache API (the
 * Node container entry) leaves the DB read exactly as it was, and a cache
 * error is counted and logged rather than thrown — see poolCache on the
 * summary, where misses (DB reads) climbing with hits flat is the reading that
 * says the cache is not working.
 */
export const POOL_EDGE_CACHE_URL = "https://reeval-pool.internal/";
/**
 * Floor for the snapshot's Cache-Control max-age. It is normally the
 * configured pool-cache period (90s in production); the floor only matters if
 * that is configured below a minute, where an early expiry costs one DB read
 * and nothing else.
 */
export const POOL_EDGE_CACHE_MIN_TTL_S = 60;

/**
 * The slice of the Cache API this cache uses. Declared locally, like the
 * clients' Cloudflare fetch options, because the repo compiles against
 * @types/node and not @cloudflare/workers-types: caches exists in the Worker
 * runtime, not in the Node types.
 */
interface PoolEdgeCache {
  match(request: Request): Promise<Response | null>;
  put(request: Request, response: Response): Promise<void>;
}

/** The colo cache, or null where the runtime has none (the Node entry). */
export function poolEdgeCache(): PoolEdgeCache | null {
  const runtime = globalThis as { caches?: { default?: PoolEdgeCache } };
  return runtime.caches?.default ?? null;
}

/**
 * FNV-1a (32-bit) of the query fingerprint — the snapshot key's discriminator.
 * A cache key needs to be stable and short, not cryptographic.
 */
export function poolKeyHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The STABLE half of a pool query, as a key fragment.
 *
 * Every bound in this query is expressed as an offset from the tick's clock,
 * so the absolute values drift every tick while the query they describe does
 * not: a fingerprint over the absolutes would miss every tick and cache
 * nothing. Only a chat-settings (or config) change moves what this covers.
 * seenChatIds is SORTED because the SQL IN-list does not care about order and
 * the front read does not guarantee one.
 */
export function poolQueryFingerprint(
  opts: {
    seenChatIds?: string[];
    sinceMs: number;
    minLaunchMs: number;
    maxLaunchMs: number;
    windowEntryLaunchMs: number;
    limit: number;
    nearSlots?: number;
    farSlots?: number;
    minQualifyMcap?: number;
    maxQualifyMcap?: number;
    minQualifyLiquidity?: number;
  },
  now: number,
): string {
  const relative = [
    now - opts.sinceMs,
    now - opts.minLaunchMs,
    now - opts.maxLaunchMs,
    now - opts.windowEntryLaunchMs,
  ].join(",");
  const gates = [
    opts.limit,
    opts.nearSlots ?? "",
    opts.farSlots ?? "",
    opts.minQualifyMcap ?? "",
    opts.maxQualifyMcap ?? "",
    opts.minQualifyLiquidity ?? "",
  ].join(",");
  const ids = [...(opts.seenChatIds ?? [])].sort().join("+");
  return poolKeyHash(ids + "|" + relative + "|" + gates);
}

/**
 * Edge-cache counters, per isolate (the cache itself is colo-wide, so a hit
 * here may be a snapshot another isolate put). Published on the tick summary
 * as poolCache.
 */
const poolCacheCounters = {
  /** Answered by this isolate's in-memory query cache. */
  memory: 0,
  /** Answered by the colo edge cache: work the DB did not do. */
  hits: 0,
  /** Not cached anywhere: the DB read ran (and seeded the cache). */
  misses: 0,
  /** Snapshots this isolate wrote to the edge cache. */
  puts: 0,
  /** Cache calls that threw. Never fatal — the DB read answers instead. */
  errors: 0,
};

export function poolCacheView(): typeof poolCacheCounters & {
  available: boolean;
} {
  return { available: poolEdgeCache() !== null, ...poolCacheCounters };
}
`;

(function insertCacheBlock() {
  let src = fs.readFileSync(scannerPath, "utf8");
  if (src.includes("export const POOL_EDGE_CACHE_URL")) {
    log.push(["=", "scanner: edge-cache module block (already applied)"]);
    return;
  }
  const anchor = `const POOL_FETCH_BUDGET_MS = 2_400;\n`;
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    log.push(["✗", `scanner: edge-cache module block — anchor found ${n} times`]);
    failed += 1;
    return;
  }
  src = src.replace(anchor, () => anchor + CACHE_BLOCK);
  fs.writeFileSync(scannerPath, src);
  log.push(["✓", "scanner: edge-cache module block"]);
})();

// =========================================================== scanner.ts: import
editIn(
  scannerPath,
  "scanner: import poolRotationSlot",
  `import {
  DEX_PROFILES_LAST_KEY,
  SCAN_FRONT_GATE_KEYS,
  type Db,`,
  `import {
  DEX_PROFILES_LAST_KEY,
  SCAN_FRONT_GATE_KEYS,
  poolRotationSlot,
  type Db,`,
);

// ================================================== scanner.ts: summary field
editIn(
  scannerPath,
  "scanner: summary.poolCache",
  `  poolWaitMs?: number;
`,
  `  poolWaitMs?: number;
  /**
   * Edge-cache ledger for the re-eval pool snapshot (see POOL_EDGE_CACHE_URL):
   * hits is work Turso did not do, misses is the read that then seeded the
   * cache, memory is the in-memory query cache answering first (the snapshot
   * was never consulted). available: false means this runtime has no Cache API
   * at all (the Node container entry), not that the cache is broken.
   */
  poolCache?: ReturnType<typeof poolCacheView>;
`,
  { uniqueTo: true },
);

// =============================== scanner.ts: read through the cache when cached
const OLD_READ = `    if (this.reevalPoolCache && now - this.reevalPoolCache.at < this.config.reevalPoolCacheMs) {
      return this.reevalPoolCache.stats;
    }
    const stats = await this.db.getReevalPool(opts);
    this.reevalPoolCache = { at: now, stats };
    return stats;
  }`;
const NEW_READ = `    if (this.reevalPoolCache && now - this.reevalPoolCache.at < this.config.reevalPoolCacheMs) {
      poolCacheCounters.memory += 1;
      return this.reevalPoolCache.stats;
    }
    // Colo-wide snapshot first (2026-09-28): a cold isolate — which is most
    // cron ticks — used to pay this read in full even though another isolate
    // had just made it for the same rotation slot.
    const key = this.poolSnapshotKey(now, opts);
    if (key) {
      const shared = await this.poolSnapshotFromEdge(key);
      if (shared) {
        this.reevalPoolCache = { at: now, stats: shared };
        return shared;
      }
    }
    poolCacheCounters.misses += 1;
    const stats = await this.db.getReevalPool(opts);
    this.reevalPoolCache = { at: now, stats };
    if (key) this.poolSnapshotToEdge(key, stats, this.config.reevalPoolCacheMs);
    return stats;
  }

  /**
   * The edge-cache URL for this query, or null when the runtime has no Cache
   * API. The rotation SLOT is in the path, so an entry can never answer for a
   * later slot — and it is the same slot the query itself uses, because the
   * dispatch passes the tick's clock in the opts (Db.poolRotationSlot reads
   * it).
   */
  private poolSnapshotKey(
    now: number,
    opts: Parameters<Db["getReevalPool"]>[0],
  ): string | null {
    if (!poolEdgeCache()) return null;
    const slot = poolRotationSlot(now, opts.rotationPeriodMs);
    const fp = poolQueryFingerprint(opts, now);
    return POOL_EDGE_CACHE_URL + slot + "/" + fp;
  }

  /**
   * One snapshot, or null. Never throws: a runtime without the Cache API, a
   * malformed entry and a failed call all fall through to the DB read, which
   * is the behavior this cache is an optimization of.
   */
  private async poolSnapshotFromEdge(key: string): Promise<TokenStats[] | null> {
    const cache = poolEdgeCache();
    if (!cache) return null;
    try {
      const hit = await cache.match(new Request(key));
      if (!hit) return null;
      const stats = (await hit.json()) as TokenStats[];
      if (!Array.isArray(stats)) return null;
      poolCacheCounters.hits += 1;
      return stats;
    } catch (err) {
      poolCacheCounters.errors += 1;
      console.error(
        "[scanner] pool snapshot cache read failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Write the slot's snapshot. Not awaited: the tick has real work to do and
   * the put is local to the colo, so the promise is handed to the runtime with
   * its own error handler (an unhandled rejection would be a worker-level
   * error). A put that never lands costs the next cold isolate one DB read.
   */
  private poolSnapshotToEdge(
    key: string,
    stats: TokenStats[],
    ttlMs: number,
  ): void {
    const cache = poolEdgeCache();
    if (!cache) return;
    const ttlS = Math.max(POOL_EDGE_CACHE_MIN_TTL_S, Math.round(ttlMs / 1000));
    const fail = (err: unknown) => {
      poolCacheCounters.errors += 1;
      console.error(
        "[scanner] pool snapshot cache write failed:",
        err instanceof Error ? err.message : err,
      );
    };
    try {
      cache
        .put(
          new Request(key),
          new Response(JSON.stringify(stats), {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "max-age=" + ttlS,
            },
          }),
        )
        .then(() => {
          poolCacheCounters.puts += 1;
        })
        .catch(fail);
    } catch (err) {
      fail(err);
    }
  }`;
editIn(scannerPath, "scanner: getReevalPoolCached reads through the cache", OLD_READ, NEW_READ);

// ======================= scanner.ts: the DB's slot follows the key's clock
editIn(
  scannerPath,
  "scanner: the dispatch pins the query clock",
  `            : this.getReevalPoolCached(poolNow, {
        sinceMs: poolNow - RE_EVAL_WINDOW_MS,`,
  `            : this.getReevalPoolCached(poolNow, {
        // Pinned so the query's rotation slot IS the key's slot: the DB
        // defaults to Date.now(), and a tick landing on a slot boundary could
        // otherwise key a slot-N entry with slot-N+1's rows.
        now: poolNow,
        sinceMs: poolNow - RE_EVAL_WINDOW_MS,`,
);

// ========================================== scanner.ts: publish the counters
editIn(
  scannerPath,
  "scanner: the join publishes poolCache",
  `      diag.poolMs = poolReadMs;
`,
  `      diag.poolMs = poolReadMs;
      diag.poolCache = poolCacheView();
`,
  { uniqueTo: true },
);

for (const [m, n] of log) console.log(`${m} ${n}`);
if (failed === 0) {
  const db = fs.readFileSync(dbPath, "utf8");
  const sc = fs.readFileSync(scannerPath, "utf8");
  const complete =
    db.includes("export function poolRotationSlot(") &&
    db.includes("const slot = poolRotationSlot(now, opts.rotationPeriodMs);") &&
    sc.includes("export const POOL_EDGE_CACHE_URL") &&
    sc.includes("await this.poolSnapshotFromEdge(key)") &&
    sc.includes("diag.poolCache = poolCacheView();");
  if (!complete) {
    console.log("✗ refused: the parts are not all in place");
    process.exit(1);
  }
} else {
  console.log("✗ an anchor failed");
}
console.log(`\n${failed === 0 ? "OK" : "FAILED"} (${log.length} steps)`);
process.exit(failed === 0 ? 0 : 1);
