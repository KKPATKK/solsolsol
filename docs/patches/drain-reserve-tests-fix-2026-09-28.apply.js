#!/usr/bin/env node
/*
 * APPLY (idempotent) — compile fix for drain-reserve-tests-2026-09-28.apply.js.
 * The new test calls await, so its callback must be async.
 *
 * Run: node docs/patches/drain-reserve-tests-fix-2026-09-28.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
const OLD = `  await test("tickprobe: the drain yields what the pass measured, and a flooded queue drains first", () => {`;
const NEW = `  await test("tickprobe: the drain yields what the pass measured, and a flooded queue drains first", async () => {`;

const original = fs.readFileSync(FILE, "utf8");
if (!original.includes(OLD)) {
  console.log(
    original.includes(NEW) ? "= already applied" : "✗ anchor missing",
  );
  process.exit(original.includes(NEW) ? 0 : 1);
}
fs.writeFileSync(FILE, original.replace(OLD, NEW));
console.log("✓ scripts/test-unit.js: the new test is async");
