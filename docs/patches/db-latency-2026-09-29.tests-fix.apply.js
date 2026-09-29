/*
 * Fix for the probe invariant test (2026-09-29): the assertion must inspect the
 * module's CODE, not its prose — src/dblatency.ts is supposed to explain the
 * invariant ("the probe never names seen_tokens"), which means its comments do
 * contain the word. Stripping comments is what makes the pin mean "no statement
 * in this module touches the push-identity table".
 *
 *   node docs/patches/db-latency-2026-09-29.tests-fix.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(file, "utf8");

if (src.includes("probeCode")) {
  console.log("already applied — scripts/test-unit.js untouched");
  process.exit(0);
}

const old = `    const probe = read("src/dblatency.ts");
    assert.ok(!probe.includes("seen_tokens"), "a diagnostic must not be able to claim a coin");`;
const neu = `    // Comments are stripped on purpose: the module is SUPPOSED to document
    // this invariant, so only the executable text may not name the table.
    const probeCode = read("src/dblatency.ts")
      .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")
      .split("\\n")
      .map((l) => l.replace(/\\/\\/.*$/, ""))
      .join("\\n");
    assert.ok(!probeCode.includes("seen_tokens"), "a diagnostic must not be able to claim a coin");`;

const parts = src.split(old);
if (parts.length !== 2) {
  console.error(`ANCHOR MISS (${parts.length - 1} matches)`);
  process.exit(1);
}
fs.writeFileSync(file, parts.join(neu));
console.log("wrote scripts/test-unit.js");
