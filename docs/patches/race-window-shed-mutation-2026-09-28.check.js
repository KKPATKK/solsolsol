#!/usr/bin/env node
/*
 * Mutation check for the race-window shed floor (2026-09-28).
 *
 * WHY: a guard whose test passes for the wrong reason is worse than no guard.
 * Each mutation below breaks ONE thing the change promises, and the check
 * asserts the committed test suite FAILS — then restores the file byte-for-byte
 * from a backup and verifies the restore.
 *
 * WHERE EACH MUTATION LIVES:
 *   M1, M2 mutate dist/worker.js (the built pure rule) and are caught by
 *   scripts/test-tick-path.js — no rebuild, because the rule is a pure export.
 *   M3, M4 mutate src/worker.ts and are caught by the SOURCE PINS in
 *   scripts/test-unit.js, which read the .ts on disk — also no rebuild.
 *   Nothing here can leave a mutated tree behind: every step restores in a
 *   finally, and the restore is byte-compared before the script continues.
 *
 * Run: node docs/patches/race-window-shed-mutation-2026-09-28.check.js [M1 M2 M3 M4]
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");
const DIST = path.join(root, "dist", "worker.js");
const SRC = path.join(root, "src", "worker.ts");
const UNIT = path.join(root, "scripts", "test-unit.js");
const TICK = path.join(root, "scripts", "test-tick-path.js");
const BACKUP_DIR = path.join(__dirname, ".race-shed-mutation-backup");

const MUTATIONS = {
  M1: {
    file: DIST,
    suite: TICK,
    what: "the boundary moves: `<` becomes `<=` (a window AT the floor is shed too)",
    // CommonJS emit: the constant is read through `exports.`, so the dist
    // anchors carry that prefix while the src ones below do not.
    from: "return grantedRaceMs < exports.SCAN_RACE_MIN_USEFUL_MS",
    to: "return grantedRaceMs <= exports.SCAN_RACE_MIN_USEFUL_MS",
  },
  M2: {
    file: DIST,
    suite: TICK,
    what: "the floor is disabled: SCAN_RACE_MIN_USEFUL_MS = 0 (nothing is ever shed)",
    from: "exports.SCAN_RACE_MIN_USEFUL_MS = 1_500;",
    to: "exports.SCAN_RACE_MIN_USEFUL_MS = 0;",
  },
  M3: {
    file: SRC,
    suite: UNIT,
    what: "the call site stops zeroing: the unusable window is spent anyway",
    from: "const scanRaceMs = raceShedReason ? 0 : grantedRaceMs;",
    to: "const scanRaceMs = grantedRaceMs;",
  },
  M4: {
    file: SRC,
    suite: UNIT,
    what: "the reason stops being recorded (a shed reads as a plain timeout)",
    from: "      if (raceShedReason) noteSkipReason(raceShedReason);\n",
    to: "",
  },
};

const only = process.argv.slice(2);
const names = only.length ? only : Object.keys(MUTATIONS);

fs.mkdirSync(BACKUP_DIR, { recursive: true });

/** Did the suite FAIL (i.e. did the mutation get caught)? */
function suiteFailed(suite) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [suite], { encoding: "utf8" });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const summary = out.match(/(\d+) passed, (\d+) failed/);
  const failedCount = summary ? Number(summary[2]) : null;
  const failed = res.status !== 0 || (failedCount !== null && failedCount > 0);
  return { failed, secs, status: res.status, failedCount, out };
}

let ok = true;
for (const name of names) {
  const m = MUTATIONS[name];
  if (!m) {
    console.log(`✗ ${name} — no such mutation`);
    ok = false;
    continue;
  }
  const label = path.relative(root, m.file);
  const backup = path.join(BACKUP_DIR, path.basename(m.file));
  const before = fs.readFileSync(m.file, "utf8");
  fs.writeFileSync(backup, before);

  let verdict;
  try {
    const at = before.indexOf(m.from);
    if (at < 0) {
      verdict = "INVALID — the anchor is not in the file";
      ok = false;
    } else if (before.indexOf(m.from, at + 1) >= 0) {
      verdict = "INVALID — the anchor is not unique";
      ok = false;
    } else {
      fs.writeFileSync(
        m.file,
        before.slice(0, at) + m.to + before.slice(at + m.from.length),
      );
      const run = suiteFailed(m.suite);
      const suiteName = path.basename(m.suite);
      verdict = run.failed
        ? `CAUGHT by ${suiteName} in ${run.secs}s` +
          (run.failedCount !== null ? ` (${run.failedCount} failing)` : ` (exit ${run.status})`)
        : `SURVIVED — ${suiteName} still passes (exit ${run.status}) after ${run.secs}s`;
      if (!run.failed) ok = false;
    }
  } finally {
    fs.writeFileSync(m.file, before);
    if (fs.readFileSync(m.file, "utf8") !== before) {
      console.log(`✗ ${name} — RESTORE FAILED for ${label}`);
      process.exit(2);
    }
  }
  console.log(`${verdict.startsWith("CAUGHT") ? "✓" : "✗"} ${name}: ${m.what}\n    ${verdict}`);
}

fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
console.log(ok ? "done — every mutation was caught" : "FAILED — see ✗ above");
process.exit(ok ? 0 : 1);
