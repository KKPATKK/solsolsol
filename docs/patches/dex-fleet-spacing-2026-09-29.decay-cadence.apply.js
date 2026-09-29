/*
 * Second anchored patch for the FLEET-WIDE DexScreener spacing row
 * (2026-09-29): pin the decay window against the scan cadence.
 *
 * WHY IT EXISTS. The first cut sized DEX_ADAPTIVE_FLEET_DECAY_MS at 15s against
 * the in-isolate walk-back (6 consecutive 2xx) and shipped inert: the scan is
 * what reads the row and it runs once a minute, so the row a refused tick wrote
 * had decayed to zero before the next tick saw it. Live 2026-09-29T01:24:32Z
 * wrote the row (a 429 landed at 01:24:30) and the 01:25:04Z sample read
 * `spacingFleetSteps 0`. No single-isolate test can see that failure, so the
 * window is pinned against the cadence here.
 *
 * The cadence is read from wrangler.toml, not from loadConfig: the code's own
 * default is 300s (SCAN_INTERVAL_MINUTES x 60), and the deployed cadence is what
 * the row is actually read at — 60s today. If someone raises the interval, this
 * pin fails rather than letting the row silently go inert again.
 *
 * Run: node docs/patches/dex-fleet-spacing-2026-09-29.decay-cadence.apply.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(FILE, "utf8");

const ANCHOR = `    const { DEX_SPACING_STATE_KEY } = require("../dist/dexscreener.js");`;

// The first cut of this pin (kept here so re-running over it repairs it): it
// compared against loadConfig's 300s default and failed on a correct build.
const WRONG = `    const { DEX_SPACING_STATE_KEY, DEX_ADAPTIVE_FLEET_DECAY_MS } =
      require("../dist/dexscreener.js");
    // The decay window MUST be at least one tick, or the row is written and
    // spent before any later tick can read it: measured live 2026-09-29 at the
    // first cut's 15s, where the row from a refused tick read 0 steps 31s later.
    // No single-isolate test can see that failure, so pin it against the
    // cadence the row is actually read at instead.
    assert.ok(
      DEX_ADAPTIVE_FLEET_DECAY_MS >= loadConfig({}).scanIntervalSeconds * 1000,
      "a decay window shorter than the scan cadence makes the row unreadable",
    );`;

const RIGHT = `    const { DEX_SPACING_STATE_KEY, DEX_ADAPTIVE_FLEET_DECAY_MS } =
      require("../dist/dexscreener.js");`;

const PIN = `    // The decay window MUST be at least one scan tick, or the row is written
    // and spent before the next tick can read it. Measured live 2026-09-29 at
    // the first cut's 15s: the row written by a refused tick read 0 steps 31s
    // later, i.e. the whole fleet memory was inert and nothing said so. No
    // single-isolate test can see that, so the window is pinned against the
    // DEPLOYED cadence (wrangler.toml), which is what the row is read at.
    const wranglerToml = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8");
    const cadenceSec = Number((wranglerToml.match(/^SCAN_INTERVAL_SECONDS = "(\\d+)"/m) || [])[1]);
    assert.ok(
      Number.isFinite(cadenceSec) && cadenceSec > 0,
      "wrangler.toml must carry SCAN_INTERVAL_SECONDS for this pin to mean anything",
    );
    assert.ok(
      DEX_ADAPTIVE_FLEET_DECAY_MS >= cadenceSec * 1000,
      \`the fleet spacing window (\${DEX_ADAPTIVE_FLEET_DECAY_MS}ms) must last at least one scan tick (\${cadenceSec}s)\`,
    );`;

if (src.includes(WRONG)) {
  src = src.replace(WRONG, RIGHT + "\n" + PIN);
  fs.writeFileSync(FILE, src);
  console.log("  ok decay cadence pin repaired (loadConfig default -> deployed cadence)");
} else if (src.includes("must last at least one scan tick")) {
  console.log("  -- decay cadence pin (already applied)");
} else {
  if (!src.includes(ANCHOR)) throw new Error("[decay cadence] anchor not found");
  src = src.replace(ANCHOR, RIGHT + "\n" + PIN);
  fs.writeFileSync(FILE, src);
  console.log("  ok decay cadence pin inserted");
}
