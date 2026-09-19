/**
 * Batched pool read + last-good fallback (2026-09-19).
 *
 * Why this is a Db subclass in a separate file rather than a few lines inside
 * Db.getReevalPool: that method (and its band helper queryReevalBand) sits past
 * the ~48KB window the file-sync layer can edit in src/db.ts — the same limit
 * already documented at scanner.ts's resolveAxiomTokenInfo note. The Worker is
 * the single place that constructs the Db instance the scanner reads through,
 * so wrapping it there is the smallest seam that changes the production path.
 * Db.getReevalPoolBatched lives in the reachable head of that class and reuses
 * its private row/seen helpers, so only the band split is duplicated (the unit
 * tests pin both copies to the same tokens in the same order).
 *
 * Two failure shapes motivated this:
 *
 * 1. LATENCY. The original pool read issues the hot, near and far band queries
 *    as three sequential awaits — measured 2026-09-19 at 352-457ms per read,
 *    i.e. ~3 × the ~130ms Turso round trip, and the single largest front-phase
 *    cost (dbMs 1.6-2.1s of the tick's 4.2s scan deadline). The batched variant
 *    sends the same three statements in one request.
 *
 * 2. SILENT FAILURE. A failed read used to be indistinguishable from an empty
 *    pool: the scanner races its read against POOL_FETCH_BUDGET_MS and resolves
 *    `[]` when the race is lost, which made the tick take its
 *    `empty-feed-and-pool` early return and evaluate NOTHING while reporting
 *    ok:true (2026-09-19: 60-100% of ticks per 10 min had that shape while the
 *    DexScreener profiles feed was also empty, so the sweep silently stopped
 *    for stretches). With the cap now above the DB layer's own failure point
 *    (the 1.2x hard wall around SCAN_DB_TIMEOUT_MS), a broken read arrives here
 *    as an error instead of an abandoned promise, so answering it with the last
 *    good pool turns "the tick did nothing" into "the sweep re-runs the same
 *    slice". That is safe by construction: coins are re-checked through every
 *    gate and pushed ones are excluded via seen_tokens, so a stale slice can
 *    only cost work, never produce a wrong push.
 *
 * A genuinely empty result is NOT masked: only a thrown read falls back.
 */
import { Db, type TokenStats } from "./db";

/** Counters since this isolate started (mirrored onto /health by the worker). */
let fallbackCount = 0;
let fallbackAt: number | null = null;
let fallbackRows: number | null = null;
let batchedRetries = 0;

/** Read-only view for the heartbeat mirror (same shape style as the deferral counters). */
export function poolFallbackStats(): {
  count: number;
  at: number | null;
  rows: number | null;
  batchedRetries: number;
} {
  return { count: fallbackCount, at: fallbackAt, rows: fallbackRows, batchedRetries };
}

/** Test seam: the counters are module state, so tests need a reset. */
export function resetPoolFallbackStats(): void {
  fallbackCount = 0;
  fallbackAt = null;
  fallbackRows = null;
  batchedRetries = 0;
}

export class PoolFallbackDb extends Db {
  /** Last non-empty pool the DB layer actually returned. */
  private lastGood: TokenStats[] | null = null;

  /** Rows of the last good pool (test/diagnostic only). */
  get lastGoodRows(): number {
    return this.lastGood?.length ?? 0;
  }

  override async getReevalPool(
    opts: Parameters<Db["getReevalPool"]>[0],
  ): Promise<TokenStats[]> {
    let rows: TokenStats[];
    try {
      rows = await super.getReevalPoolBatched(opts);
    } catch (batchErr) {
      // One request instead of three. If the transport rejects the batch the
      // proven per-band path still works, so a batched failure costs latency,
      // not the pool — and it is counted so a systematic rejection shows up.
      batchedRetries++;
      console.warn(
        "[db] batched re-eval pool read failed — retrying per band:",
        batchErr instanceof Error ? batchErr.message : batchErr,
      );
      try {
        rows = await super.getReevalPool(opts);
      } catch (err) {
        if (!this.lastGood) throw err;
        fallbackCount++;
        fallbackAt = Date.now();
        fallbackRows = this.lastGood.length;
        console.warn(
          "[db] re-eval pool read failed — reusing the last good pool:",
          err instanceof Error ? err.message : err,
          `(rows ${this.lastGood.length})`,
        );
        return this.lastGood;
      }
    }
    // Only a real result becomes the fallback: caching an empty read would let
    // one quiet band answer every later failure with nothing.
    if (rows.length > 0) this.lastGood = rows;
    return rows;
  }
}
