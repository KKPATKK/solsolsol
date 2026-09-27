#!/usr/bin/env node
/*
 * READ-ONLY acceptance reader for the 2026-09-27 "scan trigger" round.
 *
 * WHAT IT ANSWERS. Two questions the round was shipped to fix, both taken from
 * Turso directly (never through /health or /debug/*, which are Worker
 * invocations that would pay the front read and, worse, could run a rescue scan
 * with the counters this script is measuring):
 *
 *   1. WHO ran the scans — the durable per-trigger counters
 *      (scan_trigger_cron/_http/_manual, incremented in the completion batch)
 *      plus the `via` stamp the flush leaves in scan_heartbeat. Run it twice to
 *      read the deltas.
 *   2. WHETHER the old loop is gone — every scan_history completion matched
 *      against the cron-arrival ring (scheduled_tick_ring): a completion no
 *      arrival can explain is the fallback's, and the measured window before
 *      the change had 26 of 76.
 *
 * THE WINDOW IS THE RING'S OWN, because that is the only span where arrivals
 * exist to match against (SCHEDULED_TICK_RING_MAX = 90 entries ≈ 90 minutes).
 * A completion older than the oldest arrival is reported as unmatched ONLY when
 * it is inside a window whose arrivals are complete — hence the two windows:
 * [ring[0], DEPLOY_AT) = the old build, [DEPLOY_AT, now] = the new one.
 *
 * READ-ONLY BY CONSTRUCTION: one SELECT of the worker_state rows, one SELECT of
 * scan_history. No write, no counter, no window.
 *
 * Run: node docs/patches/scan-trigger-verify-2026-09-27.read.js ISO_DEPLOY_AT
 */

const { loadConfig } = require("../../dist/config.js");
const { Db, parseScheduledTickRing } = require("../../dist/db.js");

const iso = (ms) => new Date(ms).toISOString().slice(11, 19);
const sel = (arr, from, to) => arr.filter((t) => t >= from && (to === null || t < to));

/**
 * A cron-driven completion lands AFTER its arrival (dispatch + front + scan);
 * measured suites show 0-50s. So a completion with no arrival in the 50s before
 * it is not cron's — which is exactly what the durable counters can confirm
 * after the change (`http` stays flat while these completions appear).
 */
const HOLD_MS = 50_000;

function gaps(list) {
  const out = [];
  for (let i = 1; i < list.length; i += 1) out.push(list[i] - list[i - 1]);
  return out;
}

function describe(name, list) {
  if (list.length < 2) {
    console.log(`  ${name}: ${list.length} entr${list.length === 1 ? "y" : "ies"}`);
    return;
  }
  const g = gaps(list).sort((a, b) => a - b);
  const p = (q) => g[Math.min(g.length - 1, Math.floor(g.length * q))];
  console.log(
    `  ${name}: ${list.length} entries, gaps min ${(g[0] / 1000).toFixed(1)}s ` +
      `p50 ${(p(0.5) / 1000).toFixed(1)}s p90 ${(p(0.9) / 1000).toFixed(1)}s ` +
      `max ${(g[g.length - 1] / 1000).toFixed(1)}s`,
  );
}

function report(label, arrivals, completions) {
  console.log(`--- ${label} ---`);
  describe("cron arrivals", arrivals);
  describe("completions  ", completions);
  if (completions.length === 0) return;
  const unexplained = completions.filter(
    (c) => !arrivals.some((a) => a <= c && c - a <= HOLD_MS),
  );
  console.log(
    `  completions no arrival can explain: ${unexplained.length}/${completions.length}` +
      (unexplained.length ? `\n    ${unexplained.map(iso).join(", ")}` : ""),
  );
  const holes = gaps(completions).filter((g) => g >= 90_000);
  console.log(
    `  gaps >= 90s: ${holes.length}${
      holes.length ? ` (${holes.map((g) => `${(g / 1000).toFixed(0)}s`).join(", ")})` : ""
    }`,
  );
}

async function main() {
  const deployAt = process.argv[2] ? Date.parse(process.argv[2]) : null;
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();

  const now = Date.now();
  const states = await db.getWorkerStates([
    "scan_trigger_cron",
    "scan_trigger_http",
    "scan_trigger_manual",
    "scan_trigger_last_at",
    "scheduled_tick_total",
    "scheduled_tick_ring",
    "scan_heartbeat",
  ]);
  const num = (k) => {
    const v = states.get(k);
    return v === undefined ? null : Number(v);
  };
  console.log(`now ${new Date(now).toISOString()}`);
  console.log(
    `counters: cron ${num("scan_trigger_cron")}  http ${num("scan_trigger_http")}  ` +
      `manual ${num("scan_trigger_manual")}  last_counted ${
        states.get("scan_trigger_last_at") ? iso(Number(states.get("scan_trigger_last_at"))) : "-"
      }  |  scheduled_tick_total ${num("scheduled_tick_total")}`,
  );
  let hb = null;
  try {
    hb = JSON.parse(states.get("scan_heartbeat") ?? "null");
  } catch {
    hb = null;
  }
  if (hb) {
    console.log(
      `heartbeat: at ${iso(hb.at)} phase ${hb.phase} via ${hb.via ?? "-"} ` +
        `scanTriggers ${JSON.stringify(hb.scanTriggers ?? null)}`,
    );
  }

  const ring = parseScheduledTickRing(states.get("scheduled_tick_ring") ?? null);
  const hist = (await db.getScanHistory(240)).map((r) => r.at).sort((a, b) => a - b);
  const ringFrom = ring.length ? ring[0] : now - 30 * 60_000;
  console.log(
    `ring covers ${iso(ringFrom)} → ${iso(ring[ring.length - 1] ?? ringFrom)} ` +
      `(${ring.length} arrivals); history has ${hist.length} completions`,
  );

  if (deployAt) {
    report(
      `OLD build (until deploy ${new Date(deployAt).toISOString()})`,
      sel(ring, ringFrom, deployAt),
      sel(hist, ringFrom, deployAt),
    );
    report(`NEW build (since deploy)`, sel(ring, deployAt, null), sel(hist, deployAt, null));
  } else {
    report("whole ring window", ring, sel(hist, ringFrom, null));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("verify failed:", err?.message ?? err);
  process.exit(1);
});
