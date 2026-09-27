#!/usr/bin/env node
/*
 * READ-ONLY: is the deferred token_stats bookkeeping actually landing?
 *
 * WHY: `recordTokenStatsMany` and `updateTokenMaxMcaps` are DEFERRED (queued in
 * module memory, drained in the invocation tail). If the drain is starved, the
 * rows/columns stay stale — and because both writes decide "is this new / is
 * this a raise?" from the STORED value, a stale column makes the same token get
 * re-queued every tick. This probe measures the lag on coins we know existed:
 * the push audit ring.
 *
 * For each recent push: does the token_stats row exist, and is the stored
 * max_mcap_observed at least the mcap the card was sent at? A stored max BELOW
 * a mcap the coin actually reached means the raise never landed.
 *
 * READ-ONLY: SELECTs of worker_state + token_stats.
 *
 * Run: node docs/patches/token-stats-lag-read-2026-09-27.read.js [n]
 */

const { loadConfig } = require("../../dist/config.js");
const { Db } = require("../../dist/db.js");

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : "-");

async function main() {
  const n = Number(process.argv[2] ?? 12);
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();

  const auditRaw = await db.getWorkerState("push_audit");
  let audit = [];
  try {
    const parsed = JSON.parse(auditRaw ?? "[]");
    if (Array.isArray(parsed)) audit = parsed;
  } catch {
    audit = [];
  }
  const recent = audit.slice(-n);
  console.log(`now ${new Date().toISOString()}  audit ring ${audit.length} entries, last ${recent.length}`);
  if (recent.length === 0) {
    console.log("no pushes to check");
    process.exit(0);
  }

  const tokens = recent.map((e) => String(e.token));
  const stats = await db.getTokenStatsMany(tokens);

  let missing = 0;
  let belowPush = 0;
  console.log(`\n${"pushed".padEnd(9)} ${"kind".padEnd(9)} ${"mcapAtPush".padStart(12)}  ${"row".padEnd(9)} ${"maxMcap".padStart(12)} ${"maxLiq".padStart(12)}  verdict`);
  for (const e of recent) {
    const s = stats.get(String(e.token)) ?? null;
    const maxMcap = s ? s.maxMcapObserved : null;
    const maxLiq = s ? s.maxLiquidityObserved : null;
    const pushedMc = Number(e.mcapAtPush ?? 0);
    let verdict = "ok";
    if (!s) {
      verdict = "ROW MISSING";
      missing += 1;
    } else if (pushedMc > 0 && (maxMcap === null || maxMcap === undefined || maxMcap < pushedMc)) {
      verdict = "max BELOW push";
      belowPush += 1;
    }
    console.log(
      `${iso(e.at).padEnd(9)} ${String(e.kind ?? "-").padEnd(9)} ${String(pushedMc || "-").padStart(12)}  ` +
        `${(s ? "yes" : "NO").padEnd(9)} ${String(maxMcap ?? "-").padStart(12)} ${String(maxLiq ?? "-").padStart(12)}  ${verdict}`,
    );
  }
  console.log(`\nrows missing: ${missing}/${recent.length}   stored max below the pushed mcap: ${belowPush}/${recent.length}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("read failed:", err?.message ?? err);
  process.exit(1);
});
