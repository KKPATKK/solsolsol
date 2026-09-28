/**
 * Revision 5: cosmetics. rev3 spliced the delivery handler in with its own
 * leading indent, so the chain line ended up at 24 spaces instead of 12. Only
 * whitespace changes here (src/scanner.ts is one of the files this repo's
 * Edit/Write snapshots are stale for, hence a script).
 */
const fs = require("fs");
const path = require("path");

const TARGET = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(TARGET, "utf8");

const BAD = "          )\n                        .then(async (p) => {";
const GOOD = "          )\n            .then(async (p) => {";

if (src.includes(GOOD)) {
  console.log("= indentation already correct");
} else if (!src.includes(BAD)) {
  console.error("✗ anchor not found");
  process.exit(1);
} else {
  src = src.replace(BAD, GOOD);
  fs.writeFileSync(TARGET, src);
  console.log("✓ indentation fixed");
}
