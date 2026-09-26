#!/usr/bin/env node
/**
 * Round 5c, second half (2026-09-26): the /health HANDLER moves onto the one
 * read src/db.ts's readHealthFront now offers.
 *
 * See docs/patches/round5-health-front-2026-09-26.apply.js for why: the page's
 * rows were 2 batched reads plus 4 single-key reads (~6 round trips, ~15-20ms
 * of CPU) on a page an uptime monitor drives once a minute, under the same 10ms
 * Workers Free ceiling that has been killing this Worker's invocations. The
 * rows themselves do not change — only which request carries them.
 *
 * Three things this script is careful about:
 *
 *   - The telemetry counters keep their self-heal. The batched value is served
 *     only when parseTelemetryCounter/telemetryCounterUsable accept it (present
 *     and not negative); otherwise the live COUNT(*) runs exactly as before. The
 *     rule lives in those two exported functions — the single-read path calls
 *     them too — so the batched path cannot invent a second version of it.
 *   - `enabledChats` becomes the COUNT the batch already answered, because the
 *     listing's LENGTH was all /health ever used.
 *   - `pushWatchPass` keeps its declaration where it was and is assigned from
 *     the batch instead: its own round trip is what moves, not the variable.
 *
 * Run: node docs/patches/round5-health-front-wire-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new] */
const EDITS = [
  [
    "src/worker.ts",
    "import the two pure counter helpers",
    lines(
      "import {",
      "  Db,",
      "  parseScheduledTickRing,",
      "  parseTradeModeOverride,",
      "  type ScheduledTickEntry,",
      '} from "./db";',
    ),
    lines(
      "import {",
      "  Db,",
      "  parseScheduledTickRing,",
      "  parseTelemetryCounter,",
      "  parseTradeModeOverride,",
      "  telemetryCounterUsable,",
      "  type ScheduledTickEntry,",
      '} from "./db";',
    ),
  ],
  [
    "src/worker.ts",
    "health: the tracker pass line stops being its own round trip",
    lines(
      "      let pushWatchPass: unknown = null;",
      "      try {",
      '        const rawPass = await db?.getWorkerState("push_watch_pass");',
      "        pushWatchPass = rawPass ? JSON.parse(rawPass) : null;",
      "      } catch {",
      "        pushWatchPass = null;",
      "      }",
    ),
    lines(
      "      // Assigned from the page's ONE batched read below (see",
      "      // Db.readHealthFront): this row used to be a round trip of its own,",
      "      // for a request the front already pays for.",
      "      let pushWatchPass: unknown = null;",
    ),
  ],
  [
    "src/worker.ts",
    "health: the diagnostics batch becomes readHealthFront",
    lines(
      "        const tickState = await db?.getWorkerStates([",
      '          "scheduled_tick_total",',
      '          "scheduled_tick_at",',
      '          "scheduled_arrival_total",',
      '          "scheduled_arrival_at",',
    ),
    lines(
      "        const front = await db?.readHealthFront([",
      '          "scheduled_tick_total",',
      '          "scheduled_tick_at",',
      '          "scheduled_arrival_total",',
      '          "scheduled_arrival_at",',
    ),
  ],
  [
    "src/worker.ts",
    "health: the three rows join the same request, and the listing becomes a count",
    lines(
      "          BIRDEYE_CU_STATE_KEY,",
      "          BIRDEYE_CU_BY_STATE_KEY,",
      "        ]);",
    ),
    lines(
      "          BIRDEYE_CU_STATE_KEY,",
      "          BIRDEYE_CU_BY_STATE_KEY,",
      "          // The tracker pass line and both telemetry counters ride THIS",
      "          // request (2026-09-26): each was a round trip of its own for a row",
      "          // one batch carries for free — see Db.readHealthFront, which also",
      "          // answers the enabled-chats count in the same batch.",
      '          "push_watch_pass",',
      '          "telemetry_token_stats_count",',
      '          "telemetry_seen_tokens_count",',
      "        ]);",
      "        const tickState = front?.states;",
    ),
  ],
  [
    "src/worker.ts",
    "health: assign the pass line from the batch",
    lines(
      "        if (rawDrainError !== null) {",
      "          try {",
      "            writeDrainError = JSON.parse(rawDrainError) as WriteDrainErrorRecord;",
      "          } catch {",
      "            writeDrainError = null;",
      "          }",
      "        }",
    ),
    lines(
      "        if (rawDrainError !== null) {",
      "          try {",
      "            writeDrainError = JSON.parse(rawDrainError) as WriteDrainErrorRecord;",
      "          } catch {",
      "            writeDrainError = null;",
      "          }",
      "        }",
      '        const rawPass = tickState?.get("push_watch_pass") ?? null;',
      "        pushWatchPass = rawPass ? JSON.parse(rawPass) : null;",
    ),
  ],
  [
    "src/worker.ts",
    "health: the counters come from the batch, and the heal keeps its one rule",
    lines(
      "        enabledChats = (await db?.listEnabledChats())?.length ?? null;",
      "        tokenStatsCount = (await db?.countTokenStats()) ?? null;",
      "        pushedTotal = (await db?.countSeenTokens()) ?? null;",
    ),
    lines(
      "        // The count, not the listing: /health only ever used the length of",
      "        // listEnabledChats, so its row mapping was decoded for nothing — the",
      "        // front's second statement answers it with COUNT(*).",
      "        enabledChats = front ? front.enabledChats : null;",
      "        // The counters ride the same batch. The heal path (absent or",
      "        // negative — see parseTelemetryCounter) is the only case that still",
      "        // pays a round trip, and it re-derives the number through the SAME",
      "        // rule the single-row read applies rather than a second copy of it.",
      '        const statsRaw = parseTelemetryCounter(',
      '          tickState?.get("telemetry_token_stats_count"),',
      "        );",
      "        tokenStatsCount = telemetryCounterUsable(statsRaw)",
      "          ? statsRaw",
      "          : ((await db?.countTokenStats()) ?? null);",
      '        const seenRaw = parseTelemetryCounter(',
      '          tickState?.get("telemetry_seen_tokens_count"),',
      "        );",
      "        pushedTotal = telemetryCounterUsable(seenRaw)",
      "          ? seenRaw",
      "          : ((await db?.countSeenTokens()) ?? null);",
    ),
  ],
];

function main() {
  const problems = [];
  const applied = [];
  const files = new Map();
  for (const [file] of EDITS) if (!files.has(file)) files.set(file, read(file));

  for (const [file, label, old, next] of EDITS) {
    const src = files.get(file);
    const count = hits(src, old);
    if (count !== 1) {
      problems.push(`${file}: anchor for "${label}" matched ${count}x (need exactly 1)`);
      continue;
    }
    files.set(file, src.replace(old, next));
    applied.push(`${file}: ${label}`);
  }

  const out = files.get("src/worker.ts");
  for (const needle of [
    "readHealthFront([",
    "const tickState = front?.states;",
    'const rawPass = tickState?.get("push_watch_pass") ?? null;',
    "enabledChats = front ? front.enabledChats : null;",
    "telemetryCounterUsable(statsRaw)",
    "telemetryCounterUsable(seenRaw)",
  ]) {
    if (hits(out, needle) < 1) problems.push(`post-condition failed: missing ${needle}`);
  }
  // The four single-key reads this change exists for must be GONE, or the round
  // trips are still being paid and the change is decoration. Counted as the
  // whole ASSIGNMENT rather than as the call, because the counters keep their
  // call on purpose: the heal path below is the one case that may still spend a
  // round trip, and it is the only remaining caller (exactly one occurrence).
  for (const gone of [
    'await db?.getWorkerState("push_watch_pass")',
    "enabledChats = (await db?.listEnabledChats())?.length ?? null;",
    "tokenStatsCount = (await db?.countTokenStats()) ?? null;",
    "pushedTotal = (await db?.countSeenTokens()) ?? null;",
  ]) {
    if (hits(out, gone) !== 0) problems.push(`still present: ${gone}`);
  }
  for (const heal of ["await db?.countTokenStats()", "await db?.countSeenTokens()"]) {
    if (hits(out, heal) !== 1) {
      problems.push(
        `${heal} should survive as the heal path exactly once, found ` +
          `${hits(out, heal)}`,
      );
    }
  }
  // The heal call must sit inside the unusable branch, not beside it.
  if (hits(out, "telemetryCounterUsable(statsRaw)") !== 1 || hits(out, "telemetryCounterUsable(seenRaw)") !== 1) {
    problems.push("both counters must be gated on telemetryCounterUsable");
  }
  // And /health must still be the only thing reading them from the batch: the
  // keys have to be in the readHealthFront call, not merely imported.
  const call = out.slice(out.indexOf("readHealthFront(["));
  const callBody = call.slice(0, call.indexOf("]);"));
  for (const key of ["push_watch_pass", "telemetry_token_stats_count", "telemetry_seen_tokens_count"]) {
    if (!callBody.includes(`"${key}"`)) {
      problems.push(`the front's key list does not carry ${key}`);
    }
  }

  if (problems.length > 0) {
    console.error("NOT APPLIED — nothing written:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  for (const [file, src] of files) fs.writeFileSync(path.join(root, file), src, "utf8");
  console.log(`applied ${applied.length} edit(s):`);
  for (const a of applied) console.log(`  ✓ ${a}`);
}

main();
