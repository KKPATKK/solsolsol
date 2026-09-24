#!/usr/bin/env node
/**
 * The cron front path's LAST extra DB contact: the cadence gate's own read.
 *
 * ensureInitialized already reads `scan_heartbeat` once per tick and shares it
 * (lastHeartbeatRead / HEARTBEAT_REUSE_MS), so the gate no longer re-reads the
 * HEARTBEAT — but it still pays a round trip of its own for the cron-arrival
 * pair (`scheduled_tick_total` / `scheduled_tick_ring`) that the claim batch
 * needs. Live 2026-09-24 07:11:34Z cron tick:
 *
 *   steps {bump 0, init 187, gate 189, outage 0, json 0, claim 245}
 *   preStartMs 376  preRaceMs 245  raceMs 4755
 *
 * Both are the tick's FIRST DB contact, and both are single-row reads, so the
 * same statement can serve both: init fetches three keys instead of one (one
 * subrequest either way) and the gate reads nothing. Saving: one subrequest out
 * of the invocation's 50, plus ~190ms of the tick's front path — the slice that
 * eats the invocation wall clock (docs/scan-completion-loss.md).
 *
 * `null` in the cache means "not captured" (the read timed out), and the gate
 * then fetches them itself: a timeout must not be read as "the ring is empty",
 * or the claim batch would write a one-entry ring and drop the history.
 *
 * Same discipline: exactly one match per replacement, or nothing is written.
 */
const fs = require("fs");

const WORKER = "src/worker.ts";

const L = (...lines) => lines.join("\n");

/** @type {Array<{label: string, old: string, next: string}>} */
const edits = [
  {
    label: "worker: the cron-keys cache and its reader plan",
    old: "let lastHeartbeatRead: { raw: string | null; at: number } | null = null;",
    next: L(
      "let lastHeartbeatRead: { raw: string | null; at: number } | null = null;",
      "",
      "/**",
      " * The CRON-ARRIVAL keys the cadence gate needs (`scheduled_tick_total` /",
      " * `scheduled_tick_ring`), captured by the SAME statement as the heartbeat",
      " * when that read landed. `null` = not captured (the read timed out), and the",
      " * gate then fetches them itself — the shape every tick used to pay: its own",
      " * round trip, i.e. one more subrequest out of the invocation's 50 plus",
      " * ~190ms of the tick's front path (live 2026-09-24: `init 187 gate 189`).",
      " * Reused within one tick only (HEARTBEAT_REUSE_MS), never across ticks: a",
      " * stale ring would drop arrivals from what the claim batch writes.",
      " */",
      "let lastCronKeysRead: { map: Map<string, string> | null; at: number } | null = null;",
      "",
      "/**",
      " * What ensureInitialized fetches in its one read: the heartbeat (three",
      " * consumers share it) plus the cron-arrival pair the cadence gate needs, so",
      " * a cron tick's front path needs no second read at all.",
      " */",
      "const WEDGE_READ_KEYS = [",
      '  "scan_heartbeat",',
      '  "scheduled_tick_total",',
      '  "scheduled_tick_ring",',
      "];",
      "",
      "/**",
      " * What the cadence gate still has to fetch itself, given what the tick's",
      " * first DB contact already captured. Pure and exported so the merge is",
      " * unit-tested instead of only observed live: an EMPTY list is the merged",
      " * shape — the gate pays NO round trip, which is one subrequest out of the",
      " * invocation's 50 and ~190ms of the tick's front path.",
      " */",
      "export function cronGateLoad(heartbeatFresh: boolean, cronFresh: boolean): string[] {",
      "  const keys: string[] = [];",
      "  if (!heartbeatFresh) keys.push(\"scan_heartbeat\");",
      '  if (!cronFresh) keys.push("scheduled_tick_total", "scheduled_tick_ring");',
      "  return keys;",
      "}",
    ),
  },
  {
    label: "worker: init's one read carries the heartbeat AND the cron keys",
    old: L(
      "      const prevRaw = await Promise.race([",
      '        db.getWorkerState("scan_heartbeat"),',
      "        new Promise<null>((resolve) =>",
      "          setTimeout(() => resolve(null), WEDGE_CHECK_BOUND_MS),",
      "        ),",
      "      ]);",
      "      const now = Date.now();",
    ),
    next: L(
      "      const kb = await Promise.race([",
      "        db.getWorkerStates(WEDGE_READ_KEYS),",
      "        new Promise<null>((resolve) =>",
      "          setTimeout(() => resolve(null), WEDGE_CHECK_BOUND_MS),",
      "        ),",
      "      ]);",
      '      const prevRaw = kb?.get("scan_heartbeat") ?? null;',
      "      const now = Date.now();",
      "      // ...and the SAME statement carries the cron-arrival keys, so a cron",
      "      // tick's front path needs no second read (see lastCronKeysRead /",
      "      // cronGateLoad). `kb` stays null when this read TIMED OUT, and that",
      "      // null is what tells the gate to fetch them itself — a timeout here",
      "      // must not be read as \"the ring is empty\", or the claim batch would",
      "      // write a one-entry ring and drop the history.",
      "      lastCronKeysRead = { map: kb, at: now };",
    ),
  },
  {
    label: "worker: the gate reads nothing when init already fetched its keys",
    old: L(
      "      const keys = [\"scheduled_tick_total\", \"scheduled_tick_ring\"];",
      "      if (cachedHb === undefined) keys.push(\"scan_heartbeat\");",
      "      const kb = await db?.getWorkerStates(keys);",
    ),
    next: L(
      "      const cachedCron =",
      "        lastCronKeysRead !== null &&",
      "        Date.now() - lastCronKeysRead.at <= HEARTBEAT_REUSE_MS",
      "          ? lastCronKeysRead.map",
      "          : null;",
      "      // The plan, pure and unit-tested (see cronGateLoad): with both caches",
      "      // warm — the normal cron shape, because init just paid for all three",
      "      // keys in ONE statement — the gate reads NOTHING. Whatever it still",
      "      // has to fetch is merged OVER the cached rows, so the ring handed to",
      "      // the claim is never the cached half of a mixed pair.",
      "      const keys = cronGateLoad(cachedHb !== undefined, cachedCron !== null);",
      "      let kb: Map<string, string> | null = cachedCron;",
      "      if (keys.length > 0) {",
      "        const fresh = await db?.getWorkerStates(keys);",
      "        kb = kb !== null ? new Map([...kb, ...(fresh ?? [])]) : fresh ?? null;",
      "      }",
    ),
  },
];

const text = fs.readFileSync(WORKER, "utf8");
let out = text;
let failed = false;
for (const e of edits) {
  const first = out.indexOf(e.old);
  if (first < 0) {
    console.error(`MISS      ${e.label}`);
    failed = true;
    continue;
  }
  if (out.indexOf(e.old, first + 1) >= 0) {
    console.error(`AMBIGUOUS ${e.label}`);
    failed = true;
    continue;
  }
  out = out.slice(0, first) + e.next + out.slice(first + e.old.length);
  console.log(`ok        ${e.label}`);
}
if (failed) {
  console.error("nothing written");
  process.exit(1);
}
fs.writeFileSync(WORKER, out);
console.log(`wrote ${WORKER}`);
