/**
 * Cold-row archiving to R2, for the two tables the tick writes and prunes
 * (2026-10-17).
 *
 * WHY THIS EXISTS. `scan_history` keeps 30 days and `tick_legs` 72 hours,
 * and both were pruned by a bare DELETE — so the only copy of "which feed was
 * silent last month" was gone. The $5 plan includes 10GB of R2 and 1M Class A
 * writes a month, and a cold export costs ~3 objects a day, so the archive is
 * effectively free while it turns a 72-hour forensic window into an unlimited
 * one. The rows are written as newline-delimited JSON because that is what
 * DuckDB / `jq` / a shell read without a loader, and because one object per
 * prune batch keeps the Class A count at one.
 *
 * THE ORDER THAT MATTERS: put, THEN delete. A failed put leaves the rows in
 * D1 (the caller skips that table's delete), so a bad R2 day costs storage,
 * never history. The object key is derived from the batch's own `at` range, so
 * a retried prune overwrites the same object instead of duplicating rows.
 *
 * NOT A BINDING BY DEFAULT. `env.ARCHIVE` is added by the deploy workflow only
 * when the account can create/reach the bucket (scripts/r2-bind.js), so a
 * token without R2:Edit leaves this path dormant instead of failing a deploy.
 */

/** The slice of R2's bucket object this module needs (structurally compatible). */
export interface ColdArchive {
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

/**
 * Rows per SELECT/put batch. 2,000 tick_legs rows are ~500KB of NDJSON —
 * comfortably inside one R2 object and one D1 result set, while three passes
 * (the caller's cap) still cover a day of ticks (2,880) after the first
 * 72-hour backlog has drained.
 */
export const COLD_ARCHIVE_BATCH_ROWS = 2_000;

/** Passes per table per prune run — three batches = 6,000 rows. */
export const COLD_ARCHIVE_MAX_PASSES = 3;

/** How long `scan_history` stays queryable in D1 (unchanged from the prune). */
export const COLD_SCAN_HISTORY_RETAIN_MS = 30 * 24 * 3600_000;

/** How long `tick_legs` stays queryable in D1 (unchanged from the prune). */
export const COLD_TICK_LEGS_RETAIN_MS = 72 * 3600_000;

/**
 * The object key for one archived batch:
 * `cold/<table>/<first-day>/<firstAt>-<lastAt>.ndjson`.
 *
 * The day prefix makes a bucket listing readable by date; the range suffix
 * makes the key a function of the BATCH, so a retry after a committed-but-lost
 * response overwrites its own object rather than writing a second copy.
 */
export function coldArchiveKey(table: string, firstAt: number, lastAt: number): string {
  const day = new Date(firstAt).toISOString().slice(0, 10);
  return `cold/${table}/${day}/${firstAt}-${lastAt}.ndjson`;
}

/**
 * One JSON object per line. A trailing newline is emitted because the file is
 * a stream of records, not a JSON array — a reader can `split("\n")` without a
 * special case for the last line.
 */
export function rowsToNdjson(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  let out = "";
  for (const row of rows) out += JSON.stringify(row) + "\n";
  return out;
}
