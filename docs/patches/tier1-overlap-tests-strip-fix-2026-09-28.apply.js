/*
 * Fix-up for tier1-overlap-tests-2026-09-28.apply.js: the inserted block used
 * a `strip` built on the test-local `WS` set, which is not in scope at the
 * insertion point. Replaced with the self-contained comment+whitespace strip
 * the sibling source-pin tests use.
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const testPath = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(testPath, "utf8");

const BAD = `      const strip = (text) =>
        [...text].filter((ch) => !WS.has(ch.charCodeAt(0))).join("");
`;
const GOOD = `      const strip = (text) =>
        text
          .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")
          .replace(/\\/\\/[^\\n]*/g, "")
          .replace(/\\s+/g, "");
`;

if (!src.includes(BAD)) {
  console.log(src.includes("/\\*[\\s\\S]*?\\*/g, \"\")") ? "= already applied" : "✗ target text not found");
  process.exit(src.includes("/\\*[\\s\\S]*?\\*/g, \"\")") ? 0 : 1);
}
src = src.replace(BAD, () => GOOD);
fs.writeFileSync(testPath, src);
console.log("✓ the test-local strip no longer needs WS");
