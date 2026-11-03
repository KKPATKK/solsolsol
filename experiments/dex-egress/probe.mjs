#!/usr/bin/env node
/*
 * Runs the egress experiment against experiments/dex-egress/worker.mjs.
 *
 *   PROBE_URL=https://dex-egress-probe.<subdomain>.workers.dev \
 *   PROBE_TOKEN=<secret> \
 *   node experiments/dex-egress/probe.mjs
 *
 * Knobs: ARMS (default "direct,wnam,weur,apac"), N (default 15),
 * GAP_MS (default 1200), MINTS (comma-separated, default the Worker's five),
 * BUST=1 (defeat Dex's edge cache — the only mode that measures the 429 pool;
 * without it a warm batch answers 5-8ms HITs and proves nothing).
 *
 * Arms run SEQUENTIALLY on purpose: the point is each arm's own 429 rate, and
 * interleaving them would mix three different egress IPs into one rolling
 * window. `--json` prints the raw rows instead of the table.
 */
"use strict";

const BASE = (process.env.PROBE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.PROBE_TOKEN || "";
const ARMS = (process.env.ARMS || "direct,wnam,weur,apac").split(",").map((a) => a.trim()).filter(Boolean);
const N = Number(process.env.N || 15);
const GAP_MS = Number(process.env.GAP_MS || 1200);
const MINTS = process.env.MINTS || "";
const BUST = process.env.BUST === "1";
const AS_JSON = process.argv.includes("--json");

if (!BASE || !TOKEN) {
  console.error("usage: PROBE_URL=https://<worker>.<subdomain>.workers.dev PROBE_TOKEN=<secret> node experiments/dex-egress/probe.mjs");
  process.exit(1);
}
if (!Number.isFinite(N) || N < 1) {
  console.error("N must be a positive number");
  process.exit(1);
}

const RUN = String(Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function once(arm) {
  const qs = new URLSearchParams({ arm, run: RUN });
  if (MINTS) qs.set("mints", MINTS);
  if (BUST) qs.set("bust", "1");
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/probe?${qs}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: `non-JSON: ${text.slice(0, 120)}` };
    }
    return { arm, http: res.status, wallMs: Date.now() - started, ...body };
  } catch (err) {
    return { arm, http: 0, wallMs: Date.now() - started, error: String(err) };
  }
}

function p50(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(arm, rows) {
  const ok = rows.filter((r) => r.status === 200).length;
  const tooMany = rows.filter((r) => r.status === 429).length;
  const other = rows.length - ok - tooMany;
  // Keyed by COLO only. `/cdn-cgi/trace`'s `ip=` is a Cloudflare-internal
  // address that reads the same from every colo, so it cannot identify egress.
  const egress = new Map();
  for (const r of rows) {
    const key = r.colo ?? "?";
    egress.set(key, (egress.get(key) ?? 0) + 1);
  }
  return {
    arm,
    n: rows.length,
    ok,
    tooMany,
    other,
    p50ms: p50(rows.map((r) => r.ms).filter((v) => typeof v === "number")),
    egress: [...egress.entries()].map(([key, count]) => ({ key, count })),
    retryAfter: rows.map((r) => r.retryAfter).filter(Boolean)[0] ?? null,
    bodyHeads: [...new Set(rows.map((r) => r.bodyHead).filter(Boolean))].slice(0, 2),
  };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const results = [];
for (const arm of ARMS) {
  const rows = [];
  for (let i = 0; i < N; i++) {
    const row = await once(arm);
    rows.push(row);
    if (i === 0 && row.http === 401) {
      console.error("401 from the probe Worker: PROBE_TOKEN does not match the deployed secret.");
      process.exit(1);
    }
    if (i < N - 1) await sleep(GAP_MS);
  }
  results.push({ arm, rows, summary: summarize(arm, rows) });
  process.stderr.write(`arm ${arm}: ${rows.filter((r) => r.status === 200).length}/${rows.length} ok\n`);
}

if (AS_JSON) {
  console.log(JSON.stringify({ run: RUN, results }, null, 2));
} else {
  console.log(`\nDex egress probe — run ${RUN}, N=${N}, gap=${GAP_MS}ms, bust=${BUST}\n`);
  console.log(`${pad("arm", 8)}${pad("n", 4)}${pad("200", 5)}${pad("429", 5)}${pad("other", 7)}${pad("p50ms", 7)}egress (colo x count)`);
  for (const { summary: s } of results) {
    const egress = s.egress.map((e) => `${e.key} x${e.count}`).join(", ");
    console.log(`${pad(s.arm, 8)}${pad(s.n, 4)}${pad(s.ok, 5)}${pad(s.tooMany, 5)}${pad(s.other, 7)}${pad(s.p50ms ?? "-", 7)}${egress}`);
  }

  const colos = new Set(results.flatMap((r) => r.summary.egress.map((e) => e.key)));
  const clean = results.filter((r) => r.summary.tooMany === 0 && r.summary.ok > 0);
  const dirty = results.filter((r) => r.summary.tooMany > 0);
  console.log("");
  if (results.length === 1) {
    const s = results[0].summary;
    console.log(`VERDICT: ${s.arm} egressed via ${[...colos].join(", ")} — ${s.ok}/${s.n} ok, ${s.tooMany} 429.`);
  } else if (colos.size === 1) {
    console.log(`VERDICT: every arm landed in ONE colo (${[...colos].join(",")}) — locationHint did not move the egress, so colo choice cannot help this run.`);
  } else if (clean.length > 0 && dirty.length > 0) {
    console.log(`VERDICT: colo-dependent. Clean: ${clean.map((r) => r.arm).join(", ")}. 429: ${dirty.map((r) => `${r.arm} (${r.summary.tooMany}/${r.summary.n})`).join(", ")}.`);
  } else if (clean.length === results.length) {
    console.log("VERDICT: every arm was clean at this volume — the shared bucket recovers between bursts, so this does NOT prove a colo is safe under production rate. Re-run with N=60, GAP_MS=500.");
  } else {
    console.log("VERDICT: every arm was 429-bucketed at this volume — no colo advantage observed.");
  }
  const retry = results.map((r) => r.summary.retryAfter).filter(Boolean)[0];
  if (retry) console.log(`Retry-After seen: ${retry}`);
  if (process.env.SHOW_BODY === "1") {
    for (const { arm, summary: s } of results) {
      if (s.bodyHeads.length) console.log(`\n${arm} body: ${s.bodyHeads.join(" | ")}`);
    }
  }
}
