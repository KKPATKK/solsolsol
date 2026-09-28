/**
 * Adds B1's tests to scripts/test-unit.js (idempotent, marker-guarded).
 * The test bodies live in …-2026-09-28.tests.txt and are read literally: they
 * contain `/\s+/` and backticked strings, and passing those through a JS
 * template literal is what corrupted this file once before.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const TARGET = path.join(ROOT, "scripts", "test-unit.js");
const tests = fs.readFileSync(
  path.join(__dirname, "gecko-429-retry-2026-09-28.tests.txt"),
  "utf8",
);

let src = fs.readFileSync(TARGET, "utf8");
const original = src;
let ok = true;

function unique(needle) {
  const found = src.split(needle).length - 1;
  if (found !== 1) throw new Error(`anchor occurs ${found}x: ${JSON.stringify(needle.slice(0, 64))}`);
}

function edit(label, marker, anchor, build) {
  if (src.includes(marker)) {
    console.log(`= ${label} (already applied)`);
    return;
  }
  try {
    unique(anchor);
  } catch (err) {
    console.log(`✗ ${label}: ${err.message}`);
    ok = false;
    return;
  }
  src = src.replace(anchor, build(anchor));
  console.log(`✓ ${label}`);
}

// --- 1. the new constant in the geckoterminal import list ------------------
edit(
  "1/2 import GECKO_KEYED_429_BACKOFF_MS",
  "GECKO_KEYED_429_BACKOFF_MS",
  "GECKO_BACKOFF_HARD_MAX_MS } = require(\"../dist/geckoterminal.js\");",
  (a) => "GECKO_KEYED_429_BACKOFF_MS, " + a,
);

// --- 2. the new tests, after the geckoBackoffMs test ----------------------
edit(
  "2/2 B1 tests",
  "geckoDiscoveryRetryStamp: a refusal is charged the pause",
  "    assert.equal(parseRetryAfterMs(\"0\", now), null, \"an already-expired answer is not a window\");\n  });\n",
  (a) => a + tests,
);

if (!ok) {
  console.error("\nFAILED — scripts/test-unit.js left untouched.");
  process.exit(1);
}
if (src === original) console.log("\nno change (already applied)");
else {
  fs.writeFileSync(TARGET, src);
  console.log("\nscripts/test-unit.js written");
}
