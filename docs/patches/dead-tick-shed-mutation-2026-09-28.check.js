#!/usr/bin/env node
/**
 * 2026-09-28 — mutation check for the death-driven drain ceiling.
 *
 * For each mutation: patch src/, rebuild (`npx tsc`), run the test that is
 * supposed to catch it, restore the file byte-for-byte, and say caught/ESCAPED.
 * A mutation that does NOT break a test is the finding, not a pass.
 *
 *   node docs/patches/dead-tick-shed-mutation-2026-09-28.check.js [id ...]
 *
 *   M1  tickprobe: the drain ignores the caller's ceiling (maxCalls -> the
 *       normal constant)                      -> test-unit (shed test)
 *   M2  tickprobe: the shed reason is not published (shed -> null in the view)
 *                                             -> test-unit (shed test)
 *   M3  worker: drainCallCeiling always returns the normal ceiling
 *                                             -> test-tick-path (ceiling rule)
 *   M4  worker: drainShedReason always returns null
 *                                             -> test-tick-path (ceiling rule)
 *   M5  worker: the drain is fired from onTickEnd again (the pre-fix shape, i.e.
 *       before the completion flush)          -> test-unit (flush ordering guard)
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..");
const SRC = {
  tickprobe: path.join(root, "src/tickprobe.ts"),
  worker: path.join(root, "src/worker.ts"),
};

const MUTATIONS = [
  {
    id: "M1",
    what: "tickprobe: the drain ignores the caller's ceiling",
    file: "tickprobe",
    from: "      if (calls >= maxCalls) {",
    to: "      if (calls >= DEFERRED_MAX_CALLS_PER_DRAIN) {",
    test: "scripts/test-unit.js",
  },
  {
    id: "M2",
    what: "tickprobe: the shed reason is not published",
    file: "tickprobe",
    from: "    heldForTracker,\n    reserve,\n    shed,\n    totals: {",
    to: "    heldForTracker,\n    reserve,\n    shed: null,\n    totals: {",
    test: "scripts/test-unit.js",
  },
  {
    id: "M3",
    what: "worker: drainCallCeiling never lowers the ceiling",
    file: "worker",
    from: `  return deadPredecessor
    ? DEFERRED_DEAD_PREDECESSOR_MAX_CALLS
    : DEFERRED_MAX_CALLS_PER_DRAIN;`,
    to: "  return DEFERRED_MAX_CALLS_PER_DRAIN;",
    test: "scripts/test-tick-path.js",
  },
  {
    id: "M4",
    what: "worker: drainShedReason never names the reason",
    file: "worker",
    from: `  return deadPredecessor ? "dead-predecessor" : null;`,
    to: "  return null;",
    test: "scripts/test-tick-path.js",
  },
  {
    id: "M5",
    what: "worker: the drain is fired from onTickEnd again (before the flush)",
    file: "worker",
    from: "            view.pushWatchFail = trackerPassFailure;\n",
    to:
      "            view.pushWatchFail = trackerPassFailure;\n" +
      "            const drained = drainDeferredWrites();\n" +
      "            void drained;\n",
    test: "scripts/test-unit.js",
  },
];

const wanted = process.argv.slice(2);
const picked = wanted.length
  ? MUTATIONS.filter((m) => wanted.includes(m.id))
  : MUTATIONS;

let escaped = 0;
for (const m of picked) {
  const file = SRC[m.file];
  const original = fs.readFileSync(file, "utf8");
  const at = original.indexOf(m.from);
  if (at === -1) {
    console.log(`✗ ${m.id}: anchor not found — mutation not applied (script bug)`);
    escaped += 1;
    continue;
  }
  fs.writeFileSync(file, original.slice(0, at) + m.to + original.slice(at + m.from.length));
  let caught = false;
  let why = "";
  try {
    execFileSync("npx", ["tsc"], { cwd: root, stdio: "pipe" });
  } catch (err) {
    // A mutation that does not type-check is still "caught", but say so: the
    // interesting mutations are the ones the TESTS catch.
    caught = true;
    why = "build failed";
  }
  if (!caught) {
    try {
      execFileSync("node", [m.test], { cwd: root, stdio: "pipe" });
    } catch (err) {
      caught = true;
      const out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      const line = out.split("\n").find((l) => /failed|✗|not equal|AssertionError/.test(l));
      why = (line ?? "test run failed").trim().slice(0, 110);
    }
  }
  fs.writeFileSync(file, original);
  const restored = fs.readFileSync(file, "utf8") === original;
  console.log(
    `${caught ? "✓ caught" : "✗ ESCAPED"}  ${m.id}  ${m.what}\n` +
      `         ${why || "no test failed"}${restored ? "" : "   (!! FILE NOT RESTORED)"}`,
  );
  if (!caught) escaped += 1;
  if (!restored) process.exit(2);
}

console.log(
  escaped === 0
    ? `\nall ${picked.length} mutation(s) caught`
    : `\n${escaped} of ${picked.length} ESCAPED — the tests do not pin that rule`,
);
process.exit(escaped === 0 ? 0 : 1);
