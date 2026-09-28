/**
 * Revision 3 of the B1 patch (run after …-2026-09-28.apply.js and …rev2.js).
 *
 * WHY: B1's first placement put the re-arm INSIDE the gecko closure, and the
 * unit suite caught the consequence — a fake client without `pauseEndsAt` made
 * the closure reject, and the rejection discarded pools the tick had already
 * fetched (Meteora was then paid for a delivery that really happened:
 * "gecko delivered — Meteora must not be paid for" failed). A cadence nicety
 * must never be able to cost a delivery, so the re-arm moves into the delivery
 * handler, where the pools are already assigned.
 *
 * Also fixes two defects in the new tests: every other gecko test on this file
 * is local to its own block, so `MIN` had to be defined here; and the wiring pin
 * must not assume the arguments of geckoBackoffMs are comment-free.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const block = (name) =>
  fs.readFileSync(path.join(__dirname, `gecko-429-retry-2026-09-28.${name}.txt`), "utf8");
const p = (f) => path.join(ROOT, f);

let ok = true;

function swap(file, label, marker, oldText, newText) {
  const target = p(file);
  let src = fs.readFileSync(target, "utf8");
  if (src.includes(marker)) {
    console.log(`= ${label} (already applied)`);
    return;
  }
  if (!src.includes(oldText)) {
    console.log(`✗ ${label}: anchor not found`);
    ok = false;
    return;
  }
  fs.writeFileSync(target, src.replace(oldText, newText));
  console.log(`✓ ${label}`);
}

// --- 1. scanner.ts: drop the re-arm from the closure ----------------------
swap(
  "src/scanner.ts",
  "1/4 scanner: re-arm removed from the closure",
  "diag.geoRetryAt = geckoRetryAt;\n              return pools",
  block("d"),
  "",
);

// --- 2. scanner.ts: and into the delivery handler -------------------------
swap(
  "src/scanner.ts",
  "2/4 scanner: re-arm in the .then, awaited",
  ".then(async (p) => {\n              geckoProfiles = p;",
  ".then((p) => {\n              geckoProfiles = p;\n              diag.geo = p.length;\n            })\n",
  block("g"),
);

// --- 3. test-unit: the fake client must model the real surface ------------
swap(
  "scripts/test-unit.js",
  "3/4 test: fake gecko answers pauseEndsAt",
  "pauseEndsAt: () => 0,",
  "      fetchTrendingPools: async () => [],\n      fetchTokenSnapshot: async () => null,\n    };",
  "      fetchTrendingPools: async () => [],\n      fetchTokenSnapshot: async () => null,\n      // The real client's 429-pause surface: the scanner's re-arm reads it, so\n      // the double has to answer it (a refusal arms it; a delivery never does).\n      pauseEndsAt: () => 0,\n    };",
);

// --- 4. test-unit: MIN is block-local in this file ------------------------
swap(
  "scripts/test-unit.js",
  "4/4 test: define MIN in the stamp test",
  "    const I = 5 * MIN; // GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS = 300",
  "    const I = 5 * MIN; // GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS = 300",
  "    const MIN = 60_000;\n    const I = 5 * MIN; // GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS = 300",
);

// --- and the wiring pin's over-specific assertion -------------------------
(function fixPin() {
  const target = p("scripts/test-unit.js");
  let src = fs.readFileSync(target, "utf8");
  const bad =
    '    assert.ok(\n      geckoSrc.includes("this.apiKey!==null,") &&\n        geckoSrc.includes("geckoBackoffMs(this.consecutive429,asked,Math.random,this.apiKey!==null,)"),\n      "the primary\'s 429 must pass keyed-ness through",\n    );\n';
  const good =
    '    // The arguments carry inline comments, so pin the call and the flag\n' +
    '    // SEPARATELY: the whole call is not a contiguous string once whitespace\n' +
    '    // is stripped.\n' +
    '    assert.ok(\n' +
    '      geckoSrc.includes("geckoBackoffMs(this.consecutive429,asked,Math.random,"),\n' +
    '      "the primary\'s 429 arms its pause through the shared ladder",\n' +
    '    );\n' +
    '    assert.ok(\n' +
    '      geckoSrc.includes("this.apiKey!==null,"),\n' +
    '      "and keyed-ness is what moves the base",\n' +
    '    );\n';
  if (src.includes(good)) {
    console.log("= 4b/4 test: wiring pin decoupled (already applied)");
    return;
  }
  if (!src.includes(bad)) {
    console.log("✗ 4b/4 test: the pin assertion was not found");
    ok = false;
    return;
  }
  fs.writeFileSync(target, src.replace(bad, good));
  console.log("✓ 4b/4 test: wiring pin decoupled");
})();

if (!ok) process.exit(1);
console.log("\nrevision 3 applied");
