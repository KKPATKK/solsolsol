#!/usr/bin/env node
/*
 * READ-ONLY subrequest-window reader: what the invocation budget was spent on,
 * per window, including the window of a tick that DIED.
 *
 * WHY (2026-09-28). The lost-completion stretches are read today from the
 * backfill rows' `prog` note, whose `subreqs` field is the count AT THE CLAIM
 * (the admission stamp rides the claim batch — see worker.runScan's
 * admissionRecord), not at the moment the invocation was killed. So the note
 * cannot answer "was it the platform's `Too many subrequests by single Worker
 * invocation`?" — it only says how much the tick had spent ~1s in.
 *
 * The reading that CAN answer it is `heartbeat.subreqs.recent`: the counter is
 * per MODULE, `beginSubreqWindow` at tick entry rolls the window that just
 * finished into `recent`, and the successor's claim heartbeat publishes it
 * (worker.heartbeatJson carries `subreqView()`). A killed invocation publishes
 * nothing itself, so its own last window is readable ONLY from the tick behind
 * it — which is exactly the tick whose row we already read.
 *
 * WHAT TO LOOK FOR. A window with `owner "scan"` whose `total` is at or above
 * the usable ceiling (budget 50 − unseenAllowance 12 = 38) is a tick that spent
 * its whole invocation on the budget; the platform then refuses call 51 and the
 * invocation dies before its completion flush. The host split says WHO spent it
 * (`…turso.io` = DB round trips, `api.dexscreener.com` / `lite-api.jup.ag` =
 * the scan's own front). A window that died with a LOW total and no hot host is
 * the opposite reading: the budget was NOT the cause, and the deaths are some
 * other kill (CPU, a throw, a platform-side recycle) — see the caller's notes.
 *
 * READ-ONLY BY CONSTRUCTION: SELECTs on worker_state only. Never touches
 * /health or /debug/*, which are Worker invocations that would add the very
 * round trips it is trying to count.
 *
 * Run: node docs/patches/subreq-window-read-2026-09-28.read.js [samples=6] [gapSeconds=25]
 */

const { loadConfig } = require("../../dist/config.js");
const { Db } = require("../../dist/db.js");

const KEYS = ["scan_heartbeat", "scan_wedge", "tick_progress"];

/** Usable ceiling (see SUBREQ_BUDGET_FREE − SUBREQ_UNSEEN_ALLOWANCE). */
const USABLE = 38;

const iso = (ms) =>
  ms ? new Date(ms).toISOString().slice(11, 23) : "-";
const parse = (raw) => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};
const hosts = (list) =>
  (list ?? [])
    .map((h) => `${String(h.host).replace(/^.*\./, "")}:${h.count}`)
    .join(" ");

function printWindow(label, w, now) {
  if (!w) {
    console.log(`  ${label}: -`);
    return;
  }
  const hot = w.owner === "scan" && Number(w.total) >= USABLE ? "  <-- AT THE CEILING" : "";
  console.log(
    `  ${label}: owner ${w.owner ?? "-"} total ${w.total} ` +
      `started ${iso(w.at)} (${Math.round((now - Number(w.at || 0)) / 1000)}s ago)${hot}`,
  );
  if (hosts(w.hosts)) console.log(`      hosts: ${hosts(w.hosts)}`);
  if ((w.phases ?? []).length) {
    console.log(
      `      phases: ${w.phases.map((p) => `${p.phase}@${p.total}`).join(" ")}`,
    );
  }
}

async function main() {
  const samples = Number(process.argv[2] ?? 6);
  const gapSeconds = Number(process.argv[3] ?? 25);
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  await db.init();

  for (let i = 1; i <= samples; i += 1) {
    const now = Date.now();
    const st = await db.getWorkerStates(KEYS);
    const hb = parse(st.get("scan_heartbeat"));
    const wedge = parse(st.get("scan_wedge"));
    const prog = parse(st.get("tick_progress"));
    const sub = hb?.subreqs ?? null;

    console.log(`\n=== sample ${i}/${samples} @ ${new Date(now).toISOString()}`);
    if (hb) {
      const age = hb.at ? Math.round((now - hb.at) / 1000) : null;
      console.log(
        `heartbeat: at ${iso(hb.at)} (${age}s ago) via ${hb.via ?? "-"} ` +
          `phase ${hb.phase ?? "-"} ok ${hb.ok} count ${hb.count ?? "-"} ms ${hb.ms ?? "-"}` +
          `${hb.rebuiltAt ? ` rebuiltAt ${iso(hb.rebuiltAt)}` : ""}`,
      );
      if (hb.err) console.log(`  err: ${hb.err}`);
      if (hb.skip) console.log(`  skip: ${hb.skip} at ${iso(hb.skipAt)}`);
    } else {
      console.log("heartbeat: (absent)");
    }
    if (wedge) {
      console.log(
        `wedge: start ${iso(wedge.start)} (age ${Math.round(
          (now - Number(wedge.start)) / 1000,
        )}s) last tickAt ${iso(wedge.tickAt)}`,
      );
    }
    if (prog) {
      console.log(
        `tick_progress: stage ${prog.stage} at ${iso(prog.at)} +${prog.ms}ms ` +
          `subreqs ${prog.subreqs} err ${prog.err ?? "-"}`,
      );
    }
    if (sub) {
      console.log(
        `subreqs: budget ${sub.budget} unseen ${sub.unseenAllowance} usable ${sub.usable} ` +
          `windows ${sub.windows}`,
      );
      printWindow("current", sub.current, now);
      (sub.recent ?? []).forEach((w, idx) => printWindow(`recent[${idx}]`, w, now));
    } else {
      console.log("subreqs: (this heartbeat has none)");
    }

    if (i < samples) await new Promise((r) => setTimeout(r, gapSeconds * 1000));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("read failed:", err?.message ?? err);
  process.exit(1);
});
