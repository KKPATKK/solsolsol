/**
 * Workers Analytics Engine's per-tick data point (2026-10-17).
 *
 * WHY THIS EXISTS. `tick_legs` answers "what happened in the last 72 hours"
 * and is a D1 write per tick; D1 rows-written is the one resource this account
 * is actually close to (60% of 50M/month, docs/efficiency-2026-10-16.md §2).
 * Analytics Engine is a separate, included allowance (10M points/month) with a
 * SQL API, so the same tick can be charted for 30+ days without adding a D1
 * row or a query. This file is deliberately a PURE builder — the Worker hands
 * its result to `writeDataPoint`, and the unit test pins the shape without a
 * Cloudflare account.
 *
 * WHAT A POINT CARRIES. One index (`scan`) keeps the dataset queryable as a
 * series; the blobs name the trigger/outcome and any skip/cut reason; the
 * doubles are the per-tick and per-leg numbers an operator reads first. The
 * field set is capped by Analytics Engine (20 blobs, 20 doubles), so the list
 * is the ten tick counters plus the five feed legs that actually run — adding
 * a field means replacing one, not appending forever.
 */

/** The slice of the Analytics Engine binding this module needs. */
export interface AnalyticsEngineSink {
  writeDataPoint(point: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

/**
 * One row's worth of the scan summary this builder reads. Every counter is
 * optional because a cut/shed tick publishes fewer of them than a completed
 * one — the builder treats a missing field as 0 (not measured), the same
 * direction the tick_legs row takes with NULL.
 */
export interface ScanMetricSummary {
  profiles?: number;
  pool?: number;
  pairs?: number;
  pairsJup?: number;
  jup?: number;
  pump?: number;
  meteora?: number;
  raydium?: number;
  geo?: number;
  boosts?: number;
  candidates?: number;
  pushed?: number;
  feedLegMs?: Partial<Record<string, number>>;
}

export interface ScanMetricInput {
  via: string;
  ok: boolean;
  err: string | null;
  skip: string | null;
  ms: number;
  summary: ScanMetricSummary | null;
}

/** The single index value every point shares — the dataset is scan_metrics. */
export const SCAN_METRIC_INDEX = "scan";

/**
 * The feed legs worth a double each. The roster the tick actually runs; the
 * gated legs (geo/geoTrend/boosts) are represented by their COUNTS in the tick
 * block, not by a per-leg ms, because a leg that did not run has no wall time
 * and 0 would read as "instant" rather than "not attempted".
 */
const FEED_LEG_FIELDS = ["profiles", "jup", "pump", "meteora", "raydium"] as const;

/** Error text is capped so a pathological stack cannot crowd out the numbers. */
const MAX_ERR_CHARS = 120;

export function buildScanDataPoint(input: ScanMetricInput): {
  indexes: string[];
  blobs: string[];
  doubles: number[];
} {
  const s = input.summary;
  const legs = s?.feedLegMs ?? {};
  const doubles: number[] = [
    input.ms,
    s?.profiles ?? 0,
    s?.pool ?? 0,
    s?.pairs ?? 0,
    s?.pairsJup ?? 0,
    s?.jup ?? 0,
    s?.pump ?? 0,
    s?.meteora ?? 0,
    s?.raydium ?? 0,
    s?.geo ?? 0,
    s?.boosts ?? 0,
    s?.candidates ?? 0,
    s?.pushed ?? 0,
  ];
  for (const leg of FEED_LEG_FIELDS) {
    const ms = legs[leg];
    doubles.push(typeof ms === "number" && Number.isFinite(ms) ? ms : 0);
  }
  return {
    indexes: [SCAN_METRIC_INDEX],
    blobs: [
      input.via,
      input.ok ? "ok" : "fail",
      (input.err ?? "").slice(0, MAX_ERR_CHARS),
      input.skip ?? "",
    ],
    doubles,
  };
}
