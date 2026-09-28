#!/usr/bin/env node
/*
 * Mutation check for A + C (2026-09-28): does the new test work actually FAIL
 * when the behaviour it describes is broken?
 *
 * Each mutation breaks ONE thing, rebuilds, runs scripts/test-unit.js, and
 * expects a NON-ZERO exit. A mutation that survives is a vacuous test.
 *
 * SELF-HEALING, BY BACKUP (fixed 2026-09-28 after it bit this very run): the
 * first version restored "if the mutated `to` string is on disk", which cannot
 * work for a mutation that DELETES a line (`to: ""`) — and a sandbox-killed run
 * left exactly such a deletion applied, so a later run rebuilt against a
 * half-mutated source and reported nonsense. The source is now copied to
 * BACKUP before the first mutation and restored from it on ANY exit path, and a
 * leftover BACKUP at startup is restored before anything else runs.
 *
 * NOTE the ordering trap this check also exists to avoid: dist/worker.js is what
 * the FORMATTER tests run against, while the WIRING guards read src/worker.ts —
 * so a mutation must be paired with a rebuild or the formatter tests test
 * yesterday's build. Hence the `tsc` in front of every run.
 *
 * Run: node docs/patches/front-split-mutation-2026-09-28.check.js [M1 M2 ...]
 *      (no args = every mutation)
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "src", "worker.ts");
const BACKUP = path.join(__dirname, ".worker.ts.mutation-backup");

const MUTATIONS = [
  {
    id: "M1",
    name: "A: the race-window err goes back to the two-part form (json+claim only)",
    from: "        ? `scan exceeded its ${scanRaceMs}ms race window (tick budget ${SCAN_TICK_BUDGET_MS}ms, flush reserve ${SCAN_FLUSH_RESERVE_MS}ms, ${frontSplitNote(preTick)})`",
    to: "        ? `scan exceeded its ${scanRaceMs}ms race window (tick budget ${SCAN_TICK_BUDGET_MS}ms, flush reserve ${SCAN_FLUSH_RESERVE_MS}ms, preRace ${preTick.preRaceMs}ms = json ${preTick.steps.json} + claim ${preTick.steps.claim})`",
  },
  {
    id: "M2",
    name: "A: the admission stamp stops carrying the preStart half",
    from: "      front: preStartSplitNote(preTickEntryAt, startedAt, preTick.steps),\n",
    to: "",
  },
  {
    id: "M3",
    name: "A: the phase stamps stop carrying the split",
    from: "          front: frontSplitNote(preTick),\n",
    to: "",
  },
  {
    id: "M4",
    name: "A: the successor's note stops printing the split",
    from: "  if (rec.front) bits.push(rec.front);\n",
    to: "",
  },
  {
    id: "M5",
    name: "A: the formatter drops the preStart half out of the front total",
    from: "    `front ${preStart + preRace}ms = ` +",
    to: "    `front ${preRace}ms = ` +",
  },
  {
    // NOTE: DELETING this line is not a valid probe — TickProgressRecord.front
    // is required, so tsc refuses it before any test runs (which is itself the
    // reading: the field cannot go unwritten). Writing a CONSTANT null is the
    // compiling form of the same regression.
    id: "M6",
    name: "A: the record stops persisting the split (writes null instead)",
    from: "    front: fields.front ? String(fields.front).slice(0, TICK_PROGRESS_FRONT_MAX) : null,",
    to: "    front: null,"
  },
  {
    id: "M7",
    name: "C: the claim heartbeat stops republishing the rebuild marker",
    from: "    rebuiltAt: rebuildMarker,\n",
    to: "",
  },
  {
    id: "M8",
    name: "C: the marker rule never CARRIES (drops the carry arm)",
    from: "        verdict.rebuild ? now : deadNow !== null ? heartbeatRebuiltAt(prevRaw) : null;",
    to: "        verdict.rebuild ? now : null;",
  },
  {
    id: "M9",
    name: "C: the marker rule never SETS (always clears)",
    from: "        verdict.rebuild ? now : deadNow !== null ? heartbeatRebuiltAt(prevRaw) : null;",
    to: "        null;",
  },
];

/** Restore from BACKUP if a previous run (or a kill) left one behind. */
function restoreFromBackup() {
  if (!fs.existsSync(BACKUP)) return false;
  fs.copyFileSync(BACKUP, SRC);
  fs.unlinkSync(BACKUP);
  console.log("  (self-heal: src/worker.ts restored from the previous run's backup)\n");
  return true;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 300_000 });
}

function main() {
  restoreFromBackup();

  const wanted = process.argv.slice(2).filter((a) => a.startsWith("M"));
  const list = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS;
  if (list.length === 0) {
    console.log("no matching mutation ids");
    process.exit(1);
  }

  const original = fs.readFileSync(SRC, "utf8");
  fs.writeFileSync(BACKUP, original);
  const results = [];

  try {
    for (const m of list) {
      if (!original.includes(m.from)) {
        results.push({ id: m.id, name: m.name, caught: null, note: "anchor not found" });
        console.log(`  ? ${m.id} ${m.name} — ANCHOR NOT FOUND`);
        continue;
      }
      let caught = null;
      let note = "";
      try {
        fs.writeFileSync(SRC, original.replace(m.from, m.to));
        const build = run("npx", ["tsc"]);
        if (build.status !== 0) {
          note = "mutation did not compile";
          console.log(`  ? ${m.id} ${m.name} — DID NOT COMPILE (invalid probe)`);
        } else {
          const test = run(process.execPath, ["scripts/test-unit.js"]);
          caught = test.status !== 0;
          const tail = String(test.stdout ?? "")
            .split("\n")
            .filter((l) => l.includes("passed"));
          note = tail.length ? tail[tail.length - 1].trim() : `exit ${test.status}`;
          console.log(`  ${caught ? "✅" : "❌"} ${m.id} ${m.name} — ${note}`);
        }
      } finally {
        fs.copyFileSync(BACKUP, SRC);
      }
      results.push({ id: m.id, name: m.name, caught, note });
    }
  } finally {
    // Leave the tree exactly as it was, and rebuilt from the unmutated source.
    fs.copyFileSync(BACKUP, SRC);
  }

  const rebuild = run("npx", ["tsc"]);
  fs.unlinkSync(BACKUP);

  const survived = results.filter((r) => r.caught === false).length;
  const invalid = results.filter((r) => r.caught === null).length;
  console.log(
    `\n${survived === 0 && invalid === 0 ? "OK" : "FAILED"} — ` +
      `${results.length - survived - invalid}/${results.length} caught, ` +
      `${survived} survived, ${invalid} invalid ` +
      `(restored + rebuilt: ${rebuild.status === 0 ? "ok" : "FAILED"})`,
  );
  process.exit(survived === 0 && invalid === 0 && rebuild.status === 0 ? 0 : 1);
}

main();
