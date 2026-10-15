#!/usr/bin/env node
/**
 * One-shot re-eval-pool backfill, driven through the DEPLOYED Worker
 * (.github/workflows/backfill-pumpfun.yml runs this).
 *
 * WHY NOT pump.fun ANY MORE (measured 2026-10-15). The one-shot backfill used
 * to scrape pump.fun's launch feed from a GitHub runner
 * (scripts/backfill-pumpfun.mjs, which still exists for a residential egress).
 * That feed now refuses EVERY egress this bot has: `frontend-api.pump.fun`
 * answers the sandbox and the GitHub-hosted runner with a Cloudflare challenge
 * page (HTTP 403, "Just a moment…") and `frontend-api-v2` with
 * `access_denied / rule_id 0.18` — the same edge rule the Worker meets. The old
 * workflow gated on that reachability and then SKIPPED the backfill, so a run
 * that seeded nothing reported success (run 38725742725's log says exactly
 * that). A job whose two outcomes are indistinguishable is worse than no job.
 *
 * THE SOURCE NOW. Birdeye's `new_listing` feed with meme_platform_enabled=true
 * (pump.fun launches included) — the source production already uses, reached
 * the way production reaches it: the deployed Worker calls it and writes the
 * rows through its own D1 binding. src/worker.ts's `/debug/backfill` is that
 * write as an operator route, and scanner.runPeriodicBackfill is the same call
 * on an interval inside the tick. This script is the manual lever on the route:
 * the difference between "seeded now" and "seeded when the interval next fires".
 *
 * WHY A SCRIPT AND NOT A curl IN THE WORKFLOW. Two things a bare curl does not
 * do, and both of them are the failure this change exists to remove:
 *   1. FAIL LOUDLY. `ok:false` (503: Birdeye/db not ready), a 5xx, a challenge
 *      page instead of JSON — each exits non-zero with the answer printed. A
 *      429 is the ONE benign answer (the route's CU cooldown: something just
 *      ran it), and it is reported as such instead of as a seeded run.
 *   2. READ THE ROW BACK. The route's own `sample` mint is re-read through
 *      `/debug/token`, so "ok:true" is confirmed by a row that is actually in
 *      D1 — the pool query's own read shape, not the writer's word for it.
 *
 * NO CREDENTIALS, ON PURPOSE. The route is unauthenticated and the write
 * happens inside the Worker, so this script (and the workflow that runs it)
 * holds no secret at all: nothing to rotate, nothing to leak — the old job
 * needed CLOUDFLARE_API_TOKEN with D1:Edit. The Worker's own hostname is not
 * duplicated here either: it is read from wrangler.toml's CRON_RELAY_URL, and
 * scripts/test-d1-migrate.js pins that (a second copy of a hostname is how a
 * workflow ends up pointing at a Worker that no longer exists).
 *
 * Usage:
 *   node scripts/backfill-pool.mjs [--worker-url URL] [--timeout-ms N]
 *   node scripts/backfill-pool.mjs --check-url   # print the target and stop
 *
 * Env fallbacks (what the workflow passes): WORKER_URL, TIMEOUT_MS.
 * `--check-url` sends nothing — it exists so "which Worker would this run ask?"
 * is answerable (and testable) without spending a call on the route.
 *
 * Exit codes:
 *   0  the route answered ok (`ok:true`) and the sample row read back, or the
 *      route answered its CU cooldown (429) — nothing was asked of D1;
 *   1  the route refused, or the row it claims to have written cannot be read
 *      back (a REPORTED success that did not land);
 *   2  the route could not be asked at all (bad/blank URL, DNS, timeout, an
 *      answer that is not JSON) — the distinction matters because 2 means the
 *      question never reached the Worker.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The route this script drives (src/worker.ts) and its read-back companion. */
const BACKFILL_PATH = "/debug/backfill";
const TOKEN_PATH = "/debug/token";

/** The route walks a 42h window in 6h chunks; measured 10-13s live. */
const DEFAULT_TIMEOUT_MS = 120_000;

const argv = process.argv.slice(2);
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** `say` mirrors scripts/cf-invocations.mjs: log first, run summary second. */
function say(line) {
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, line + "\n");
    } catch {
      /* the log is the primary channel; the summary is a convenience */
    }
  }
}

/**
 * The Worker's own public URL, from wrangler.toml's CRON_RELAY_URL — the one
 * place it is written down. Read from the file rather than imported so this
 * runs with no build step (the workflow does not `npm ci`).
 */
function workerUrlFromWranglerToml() {
  const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
  const match = toml.match(/^\s*CRON_RELAY_URL\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(
      "wrangler.toml has no CRON_RELAY_URL — pass --worker-url (or WORKER_URL) instead",
    );
  }
  return match[1];
}

function resolveUrl() {
  const explicit = flag("--worker-url") || process.env.WORKER_URL || "";
  if (explicit) return explicit.replace(/\/+$/, "");
  return workerUrlFromWranglerToml().replace(/\/+$/, "");
}

function resolveTimeout() {
  const raw = flag("--timeout-ms") || process.env.TIMEOUT_MS || "";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// `--check-url` answers "which Worker would this run ask?" without asking it,
// so the URL resolution above (wrangler.toml by default, no copy of the
// hostname here) can be exercised on its own — see the test suite's assertion
// that it prints the SAME URL wrangler.toml declares.
if (argv.includes("--check-url")) {
  try {
    console.log(resolveUrl());
    process.exit(0);
  } catch (err) {
    console.error(`could not resolve the Worker URL: ${err.message}`);
    process.exit(2);
  }
}

/** One GET, answered as `{status, text, json|null}` — never throws on shape. */
async function get(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

async function main() {
  let base;
  try {
    base = resolveUrl();
  } catch (err) {
    say(`could not resolve the Worker URL: ${err.message}`);
    process.exit(2);
  }
  if (!/^https?:\/\//.test(base)) {
    say(`--worker-url must be an http(s) URL (got "${base}")`);
    process.exit(2);
  }
  const timeoutMs = resolveTimeout();
  say(`Worker: ${base} → ${BACKFILL_PATH} (timeout ${Math.round(timeoutMs / 1000)}s)`);

  let res;
  try {
    res = await get(`${base}${BACKFILL_PATH}`, timeoutMs);
  } catch (err) {
    say(`could not ask the Worker: ${err.message}`);
    process.exit(2);
  }

  // The CU cooldown is the one benign refusal: the route is minute-costed
  // (~280 CU per call) and something already ran it. Nothing was seeded by
  // THIS run, and nothing needed to be.
  if (res.status === 429) {
    say(`cooldown — the route is CU-bounded and was just run (HTTP 429)`);
    say(`  ${res.text.slice(0, 400)}`);
    say("nothing seeded by this run; re-run after the cooldown if rows are still missing");
    process.exit(0);
  }

  if (res.status !== 200 || res.json?.ok !== true) {
    say(`the backfill route refused: HTTP ${res.status}`);
    say(`  ${res.text.slice(0, 800) || "(empty body)"}`);
    say(
      "a refusal is NOT a seeded run: 503 means Birdeye/the database is not ready for " +
        "this Worker, 5xx means the write itself failed, and a challenge page means the " +
        "request never reached the Worker at all",
    );
    process.exit(res.json ? 1 : 2);
  }

  const { fetched, seeded, chunkCount, ms } = res.json;
  say(`seeded: fetched ${fetched} new_listing rows in ${chunkCount} chunks, seeded ${seeded} (${ms}ms)`);

  // Read the row back through the pool's own read shape. `ok:true` from the
  // writer plus a null row would mean the seed's INSERT never landed — exactly
  // the class of silent success this script exists to catch.
  const mint = res.json.sample?.[0]?.address;
  if (!mint) {
    say("the route answered ok but named no sample mint — nothing to read back");
    process.exit(1);
  }
  let read;
  try {
    read = await get(`${base}${TOKEN_PATH}?mint=${encodeURIComponent(mint)}`, timeoutMs);
  } catch (err) {
    say(`could not read the sample row back: ${err.message}`);
    process.exit(2);
  }
  const stats = read.json?.stats ?? null;
  if (read.status !== 200 || read.json?.ok !== true || !stats) {
    say(`read-back FAILED for ${mint}: HTTP ${read.status} ${read.text.slice(0, 300)}`);
    say("the route reported a seed the pool cannot see — treat the run as not landed");
    process.exit(1);
  }
  say(
    `read back ${mint}: first_seen_at ${stats.firstSeenAt}` +
      (stats.launchMs ? ` (launch ${stats.launchMs})` : ""),
  );
  say("OK — the pool holds the seeded row");
}

main().catch((err) => {
  say(`backfill-pool failed: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
