/*
 * Tests for Tier 2 items 6+7 (2026-09-28): the boosts dial's DEPLOYED value
 * (the upstream's 30-row ceiling) and the recent-launches DEFAULT (30, the
 * number of rows the endpoint returns in the same single request). Both pins
 * exist because the old values (20) silently discarded rows the tick already
 * held — a revert would look like nothing at all on the live counters.
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const testPath = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(testPath, "utf8");

const MARK = "tier 2 (2026-09-28) — the two feeds stop discarding rows they already hold";
if (src.includes(MARK)) {
  console.log("= already applied");
  process.exit(0);
}

const ANCHOR = `  console.log("\\n===== UNIT TESTS =====");`;

const BLOCK = `  await test(
    "tier 2 (2026-09-28) — the two feeds stop discarding rows they already hold",
    () => {
      const toml = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8");
      const jupSrc = fs.readFileSync(path.join(__dirname, "..", "src", "jupfeeds.ts"), "utf8");

      // 7 — boosts: production runs the ceiling, because the request answers
      // 30 rows whatever we ask for.
      assert.ok(
        toml.includes('DEXSCREENER_BOOSTS_LIMIT = "30"'),
        "wrangler.toml runs the boosts leg at the upstream's 30-row ceiling",
      );
      assert.equal(
        loadConfig({ DEXSCREENER_BOOSTS_LIMIT: "30" }).dexscreenerBoostsLimit,
        30,
        "and the config accepts it",
      );
      assert.equal(
        loadConfig({ DEXSCREENER_BOOSTS_LIMIT: "45" }).dexscreenerBoostsLimit,
        30,
        "the clamp is still the ceiling, so a larger value asks for nothing more",
      );

      // 6 — recent launches: the default is the cap the endpoint fills.
      assert.equal(
        loadConfig({}).jupiterRecentLimit,
        30,
        "the default reads the rows /recent already returns (≥30 in one request)",
      );
      assert.equal(
        loadConfig({ JUPITER_RECENT_LIMIT: "20" }).jupiterRecentLimit,
        20,
        "an explicit smaller value is still honored",
      );
      assert.equal(
        loadConfig({ JUPITER_RECENT_LIMIT: "999" }).jupiterRecentLimit,
        100,
        "and the cap still stops at 100",
      );
      assert.equal(
        loadConfig({ JUPITER_RECENT_LIMIT: "0" }).jupiterRecentLimit,
        0,
        "0 still disables the leg",
      );
      // The slice is still client-side: that is WHAT makes the cap free to raise.
      assert.ok(jupSrc.includes("/recent?limit="), "the request still carries the cap");
      assert.ok(jupSrc.includes(".slice("), "and the rows are still sliced to it");
    },
  );

`;

// The stale comment in the boosts test: it claims wrangler ships the leg OFF.
const STALE = `    // The leg ships at DEXSCREENER_BOOSTS_LIMIT = "0" in wrangler.toml: the
    // tick races the scan against a ~5s window and the extra pair batch is
    // ~0.5s, so turning it on is a measurement, not a default.`;
const FRESH = `    // The leg ships DISABLED as a DEFAULT (0), and production turns it on in
    // wrangler.toml — 30, the upstream's own ceiling, since 2026-09-28: the
    // tick races the scan against its window and the extra pair batch costs
    // ~0.5s, so the number is a measurement, not a default.`;

let out = src;
if (out.includes(FRESH)) {
  console.log("= boosts test comment (already applied)");
} else {
  const n = out.split(STALE).length - 1;
  if (n !== 1) {
    console.log(`✗ boosts test comment — anchor found ${n} times`);
    process.exit(1);
  }
  out = out.replace(STALE, () => FRESH);
  console.log("✓ boosts test comment");
}

const at = out.indexOf(ANCHOR);
if (at < 0) {
  console.log("✗ tail anchor not found");
  process.exit(1);
}
out = out.slice(0, at) + BLOCK + out.slice(at);
if (out.split(MARK).length - 1 !== 1) {
  console.log("✗ expected exactly one copy of the new test — not writing");
  process.exit(1);
}
fs.writeFileSync(testPath, out);
console.log("✓ added the tier 2 dial tests");
