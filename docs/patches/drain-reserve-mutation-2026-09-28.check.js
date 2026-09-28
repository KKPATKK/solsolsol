#!/usr/bin/env node
/*
 * MUTATION CHECK for docs/patches/drain-reserve-2026-09-28.apply.js.
 *
 * Each mutation breaks ONE rule the new test claims to pin, rebuilds, and runs
 * the suite. The new test MUST fail; anything else means it is not the guard it
 * claims to be. The mutated file is restored byte-for-byte (cmp) afterwards, and
 * the script REFUSES to start unless the tree carries the pristine anchors — so
 * a run killed mid-way can never leave a mutation behind or compound one.
 *
 * Usage:  node docs/patches/drain-reserve-mutation-2026-09-28.check.js <1..6|verify>
 *
 *   1  drop the FORCE rule (a flooded queue never drains ahead of the pass)
 *   2  newest sample instead of the WORST of the recent ones
 *   3  drop the floor clamp (a thin pass licenses a thin yield)
 *   4  believe an impossible reading (the shared counter's broken delta)
 *   5  gate on the flat constant again (the bug this change fixes)
 *   6  stop measuring in the tick path (the seam itself)
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const PROBE = path.join(ROOT, "src", "tickprobe.ts");
const WORKER = path.join(ROOT, "src", "worker.ts");
const TEST = path.join(ROOT, "scripts", "test-unit.js");
const TEST_NAME = "the drain yields what the pass measured";

const MUTATIONS = [
  {
    label: "drop the FORCE rule",
    file: PROBE,
    from: `  if (owed >= DEFERRED_FORCE_DRAIN_RECORDS) return DEFERRED_FORCE_DRAIN_FLOOR;\n`,
    to: ``,
  },
  {
    label: "newest sample instead of the worst",
    file: PROBE,
    from: `  return { worst: Math.max(...trackerPassSpend), samples: trackerPassSpend.length };`,
    to: `  return {\n    worst: trackerPassSpend[trackerPassSpend.length - 1],\n    samples: trackerPassSpend.length,\n  };`,
  },
  {
    label: "drop the floor clamp",
    file: PROBE,
    from: `  return Math.min(
    DRAIN_TRACKER_RESERVE,
    Math.max(DRAIN_TRACKER_RESERVE_MIN, measured.worst),
  );`,
    to: `  return Math.min(DRAIN_TRACKER_RESERVE, measured.worst);`,
  },
  {
    label: "believe an impossible reading",
    file: PROBE,
    from: `  if (subrequests < 0 || subrequests > SUBREQ_USABLE) return;`,
    to: `  if (subrequests < 0 || subrequests > 10_000) return;`,
  },
  {
    label: "gate on the flat constant again",
    file: PROBE,
    from: `      if (subreqLeft() <= reserve) {`,
    to: `      if (subreqLeft() <= DRAIN_TRACKER_RESERVE) {`,
  },
  {
    label: "stop measuring in the tick path",
    file: WORKER,
    from: `          noteTrackerPassSpend(passSubreqBefore - subreqRemaining());\n`,
    to: ``,
  },
];

const PRISTINE = [
  [PROBE, `export function drainTrackerReserve(`],
  [PROBE, `  if (owed >= DEFERRED_FORCE_DRAIN_RECORDS) return DEFERRED_FORCE_DRAIN_FLOOR;`],
  [PROBE, `      if (subreqLeft() <= reserve) {`],
  [PROBE, `  return { worst: Math.max(...trackerPassSpend), samples: trackerPassSpend.length };`],
  [PROBE, `  return Math.min(
    DRAIN_TRACKER_RESERVE,
    Math.max(DRAIN_TRACKER_RESERVE_MIN, measured.worst),
  );`],
  [WORKER, `noteTrackerPassSpend(passSubreqBefore - subreqRemaining());`],
  [TEST, `noteTrackerPassSpend(passSubreqBefore - subreqRemaining())`],
];

const read = (file) => fs.readFileSync(file, "utf8");
const write = (file, text) => fs.writeFileSync(file, text);

/** Run a command and return its combined output — a NON-ZERO exit is a result,
 *  not an exception: the suite is EXPECTED to fail under a mutation. */
function run(cmd, args, timeout) {
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

function assertPristine() {
  for (const [file, needle] of PRISTINE) {
    const text = read(file);
    if (!text.includes(needle)) {
      console.log(`✗ ${path.basename(file)} is MISSING: ${needle}`);
      console.log("  refusing to start (a previous run may have been killed mid-mutation)");
      process.exit(1);
    }
  }
  console.log("✓ pristine anchors present\n");
}

function testVerdict(output) {
  const line = output.split("\n").find((l) => l.includes(TEST_NAME));
  if (!line) return { ok: false, line: `(the new test did not run — total: ${
    (output.match(/\d+ passed, \d+ failed/) ?? ["?"])[0]})` };
  return { ok: line.includes("✅"), line: line.trim() };
}

function main() {
  const arg = process.argv[2] ?? "";
  assertPristine();

  if (arg === "verify") {
    console.log("rebuilding the PRISTINE tree and running the suite…");
    run("npm", ["run", "build"], 600_000);
    const verdict = testVerdict(run("node", ["scripts/test-unit.js"], 600_000));
    console.log(`  ${verdict.ok ? "✅" : "❌"} ${verdict.line}`);
    console.log(verdict.ok ? "\nbaseline is GREEN" : "\n✗ baseline is not green");
    process.exit(verdict.ok ? 0 : 1);
  }

  const index = Number(arg);
  const mutation = MUTATIONS[index - 1];
  if (!mutation) {
    console.log(`usage: <1..${MUTATIONS.length}|verify>`);
    process.exit(1);
  }

  const original = read(mutation.file);
  const restore = () => {
    write(mutation.file, original);
    const back = path.join("/tmp", `${path.basename(mutation.file)}.mut.bak`);
    fs.writeFileSync(back, original);
  };
  process.on("SIGINT", () => { restore(); process.exit(130); });
  process.on("SIGTERM", () => { restore(); process.exit(143); });

  const hits = original.split(mutation.from).length - 1;
  if (hits !== 1) {
    console.log(`✗ mutation ${index}: anchor matched ${hits} times — refusing`);
    process.exit(1);
  }

  console.log(`mutation ${index}: ${mutation.label} (${path.basename(mutation.file)})`);
  write(mutation.file, original.replace(mutation.from, mutation.to));
  const buildOut = run("npm", ["run", "build"], 600_000);
  if (!/\bsrc\/|^$/m.test(buildOut) && buildOut.includes("error TS")) {
    console.log("  build failed (the mutation is not type-clean):");
    console.log(`  ${buildOut.split("\n")[0]}`);
  }
  const output = run("node", ["scripts/test-unit.js"], 600_000);
  const verdict = testVerdict(output);
  const totals = (output.match(/\d+ passed, \d+ failed/) ?? ["(no totals)"])[0];
  console.log(`  ${verdict.line}   [${totals}]`);
  const caught = !verdict.ok;
  console.log(caught ? "  ✅ CAUGHT by the new test" : "  ✗ ESCAPED — the test does not pin this");

  restore();
  const restored = read(mutation.file) === original;
  console.log(`  ${restored ? "✓" : "✗"} ${path.basename(mutation.file)} restored byte-for-byte`);
  run("npm", ["run", "build"], 600_000);
  console.log("  rebuilt from the restored tree");
  process.exit(caught && restored ? 0 : 2);
}

main();
