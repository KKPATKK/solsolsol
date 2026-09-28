/*
 * One-off repair, 2026-09-28: the tests apply script wrote its replacement
 * block through a JS TEMPLATE LITERAL, which ate the backslashes in the
 * `strip()` helper's regex literals (`\/` -> `/`, `\s` -> `s`, `[^\n]` -> a
 * real newline), turning scripts/test-unit.js into a syntax error.
 *
 * The correct block lives in the sibling
 * gecko-key-launch-chain-tests-2026-09-28.block.txt (written literally, so
 * nothing is escaped on the way in), and the apply script now READS it rather
 * than embedding it. This script splices it over the broken region.
 *
 * Usage: node docs/patches/gecko-key-launch-chain-tests-2026-09-28.repair.js
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const target = path.join(root, "scripts", "test-unit.js");
const block = fs.readFileSync(
  path.join(__dirname, "gecko-key-launch-chain-tests-2026-09-28.block.txt"),
  "utf8",
);

const START = '  await test("Scanner: pump.fun fetches every tick and Meteora yields to a gecko tick", async () => {';
const TAIL_ANCHOR = '"the deploy must be able to write the CoinGecko key as a Worker secret",';
// The tell-tale of the corruption — refusing to splice over anything else.
const BROKEN_TELL = "//*[sS]*?*//";

let text = fs.readFileSync(target, "utf8");

if (text.includes(BROKEN_TELL)) {
  const start = text.indexOf(START);
  if (start === -1) {
    console.log("\u2717 the broken block's first test was not found");
    process.exit(1);
  }
  const tail = text.indexOf(TAIL_ANCHOR, start);
  if (tail === -1) {
    console.log("\u2717 the broken block's last test was not found");
    process.exit(1);
  }
  const end = tail + text.slice(tail).indexOf("\n  });\n") + "\n  });\n".length;
  text = text.slice(0, start) + block + text.slice(end);
  fs.writeFileSync(target, text);
  console.log("\u2713 spliced the corrected block over the corrupted region");
} else if (text.includes(START) && text.includes("geckoDiscoveryDue(now - 299_000")) {
  console.log("= already repaired (or never corrupted)");
} else {
  console.log("\u2717 neither the corruption nor the repaired block was found — inspect by hand");
  process.exit(1);
}
