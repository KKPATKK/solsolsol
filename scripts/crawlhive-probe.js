#!/usr/bin/env node
/*
 * READ-ONLY probe: crawlhive.xyz's public Instant Crawl (`GET /api/scan?q=`)
 * measured against OUR OWN recently pushed coins.
 *
 * WHY THIS EXISTS. docs/push-score-2026-10-12.md §10 establishes that
 * CrawlHive exposes a free, key-less 0–100 verdict for a single mint, and that
 * the only honest way to decide whether to wire it into the push card is to
 * measure it on the coins this bot actually pushes — the WIF sample in that
 * document is a mature token, not a fresh pump.fun launch, and the two cost
 * very different amounts of upstream work on their side. This script is that
 * measurement, kept so it can be re-run (their endpoint is an MVP and may
 * change; the numbers in the doc have a date on them).
 *
 * WHAT IT MEASURES. Client-side, per mint: time to first byte (TTFB), the
 * first crawler log line, and the `result` event — the only event worth
 * reading. The stream is ABORTED at `result`: `done` only follows the (unused)
 * X-buzz offer, and X search is not run for anonymous scans anyway.
 *
 * NO WRITES ANYWHERE. One HTTP read of our own /debug/push-audit for the mint
 * list, then one scan per mint. It never touches Turso and never writes a
 * worker_state row.
 *
 * THE RATE LIMIT IS THEIRS, AND IT IS REAL: `allowScan` in their
 * src/lib/server/scan.ts allows 8 scans per IP per 10 minutes (in-memory), and
 * a Cloudflare Worker's egress IP is shared with strangers, so a refused scan
 * is a normal answer, not a bug. One run therefore stays inside ONE window
 * (PER_WINDOW_MAX) and tells you to wait before the next batch.
 *
 * Run: node scripts/crawlhive-probe.js
 *      node scripts/crawlhive-probe.js --limit 10 --offset 8   (the next batch)
 *      node scripts/crawlhive-probe.js --mints <mint>,<mint>
 *      node scripts/crawlhive-probe.js --worker https://other-worker.example
 */
"use strict";

const DEFAULT_WORKER = "https://solana-meme-bot.cool1999k.workers.dev";
const SCAN_URL = "https://crawlhive.xyz/api/scan";
/** Their per-IP window: 8 scans / 10 minutes (see the header). */
const PER_WINDOW_MAX = 8;
const WINDOW_MS = 10 * 60_000;
/** Abort a scan that has not reached `result` in this long. */
const SCAN_DEADLINE_MS = 60_000;

function parseArgs(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const mintsArg = arg("--mints", "");
  return {
    worker: arg("--worker", process.env.CRON_RELAY_URL || DEFAULT_WORKER),
    limit: Number(arg("--limit", PER_WINDOW_MAX)),
    offset: Number(arg("--offset", 0)),
    gapMs: Number(arg("--gap", 4000)),
    mints: mintsArg
      ? mintsArg
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean)
      : null,
  };
}

/** The `initial` sends in our own delivery ring, newest first. */
async function recentPushes(worker, limit, offset) {
  const res = await fetch(`${worker}/debug/push-audit`);
  if (!res.ok) throw new Error(`/debug/push-audit answered HTTP ${res.status}`);
  const body = await res.json();
  const initials = (body.rows ?? []).filter((r) => r.kind === "initial");
  const end = Math.max(0, initials.length - offset);
  const start = Math.max(0, end - limit);
  return initials.slice(start, end).reverse();
}

/**
 * One measured scan. Reads the SSE body until `type:"result"` and aborts there
 * (`see the header`); every timing is wall-clock from the request, so it is the
 * latency a Worker subrequest would actually pay.
 */
async function scanOnce(mint) {
  const started = Date.now();
  const ac = new AbortController();
  const killed = setTimeout(() => ac.abort(), SCAN_DEADLINE_MS);
  const out = {
    mint,
    ttfbMs: null,
    firstLogMs: null,
    resultMs: null,
    logs: 0,
    score: null,
    verdict: null,
    reason: null,
    factors: null,
    error: null,
  };
  try {
    const res = await fetch(`${SCAN_URL}?q=${encodeURIComponent(mint)}`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    out.ttfbMs = Date.now() - started;
    if (!res.ok || !res.body) {
      out.error = `HTTP ${res.status}`;
      return out;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line.slice(6));
        } catch {
          continue; // a split frame cannot happen (we only cut on \n\n), but a
          // non-JSON payload is their business, not a crash of ours
        }
        if (ev.type === "log") {
          out.logs += 1;
          if (out.firstLogMs === null) out.firstLogMs = Date.now() - started;
        } else if (ev.type === "result") {
          out.resultMs = Date.now() - started;
          out.score = ev.result?.score ?? null;
          out.verdict = ev.result?.verdict ?? null;
          out.reason = ev.result?.reason ?? null;
          out.factors = ev.result?.factors ?? null;
          ac.abort();
          break;
        } else if (ev.type === "error") {
          out.error = ev.message ?? "scan error";
          ac.abort();
          break;
        }
      }
      if (out.resultMs !== null || out.error) break;
    }
  } catch (err) {
    // An abort we asked for is not an error; a genuine failure is.
    if (out.resultMs === null) {
      out.error =
        err && err.name === "AbortError"
          ? "timeout (no result inside the deadline)"
          : String((err && err.message) || err);
    }
  } finally {
    clearTimeout(killed);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv);
  let targets;
  if (args.mints) {
    targets = args.mints.map((mint) => ({ token: mint, at: null, symbol: "?" }));
  } else {
    if (args.limit > PER_WINDOW_MAX) {
      console.error(
        `--limit ${args.limit} exceeds CrawlHive's ${PER_WINDOW_MAX} scans / 10 min per IP.\n` +
          `Run ${PER_WINDOW_MAX} now and the rest with --offset ${PER_WINDOW_MAX} after 10 minutes.`,
      );
      process.exit(1);
    }
    targets = await recentPushes(args.worker, args.limit, args.offset);
    if (targets.length === 0) {
      console.error("no `initial` pushes in the delivery ring — nothing to measure");
      process.exit(1);
    }
  }

  console.log(
    `crawlhive probe @ ${new Date().toISOString()} — ${targets.length} mint(s), gap ${args.gapMs}ms`,
  );
  console.log(`${targets.length} request(s) against a ${PER_WINDOW_MAX}/${WINDOW_MS / 60_000}min limit\n`);

  const results = [];
  for (const [i, t] of targets.entries()) {
    if (i > 0) await sleep(args.gapMs);
    const m = t.token;
    const r = await scanOnce(m);
    r.symbol = t.symbol ?? "?";
    r.pushedAt = t.at ? new Date(t.at).toISOString() : null;
    results.push(r);
    const head = `${(r.symbol || "?").padEnd(10)} ${m.slice(0, 6)}…${m.slice(-4)}`;
    if (r.error) {
      console.log(`${head}  ERROR  ${r.error}  (ttfb ${r.ttfbMs}ms)`);
      continue;
    }
    const factors = (r.factors ?? [])
      .map((f) => `${f.label} ${f.impact > 0 ? "+" : ""}${f.impact}`)
      .join(", ");
    console.log(
      `${head}  ttfb ${String(r.ttfbMs).padStart(5)}ms  firstLog ${String(r.firstLogMs).padStart(5)}ms  result ${String(r.resultMs).padStart(5)}ms  logs ${r.logs}` +
        `\n            score ${r.score} ${r.verdict} — ${r.reason}` +
        (factors ? `\n            factors: ${factors}` : ""),
    );
  }

  const ok = results.filter((r) => !r.error);
  if (ok.length > 0) {
    const pct = (xs, p) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
    };
    const ttfbs = ok.map((r) => r.ttfbMs);
    const results_ = ok.map((r) => r.resultMs);
    console.log(
      `\nttfb    p50 ${pct(ttfbs, 50)}ms  max ${Math.max(...ttfbs)}ms` +
        `\nresult  p50 ${pct(results_, 50)}ms  max ${Math.max(...results_)}ms` +
        `\nscores  ${ok.map((r) => `${r.score}${r.verdict ? "/" + r.verdict[0] : ""}`).join(" ")}`,
    );
  }
  console.log(`\nJSON ${JSON.stringify(results)}`);
}

main().catch((err) => {
  console.error("crawlhive probe failed:", (err && err.message) || err);
  process.exit(1);
});
