/*
 * Anchored patch for the FLEET-WIDE DexScreener spacing row (2026-09-29) — the
 * scripts/test-unit.js half. Same reason as the sibling scanner script:
 * `str_replace` is unreliable on the large source files in this repo, so the
 * edit is anchored instead. Guarded: re-running is a skip, a missing anchor
 * throws.
 *
 * Run: node docs/patches/dex-fleet-spacing-2026-09-29.tests.apply.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(FILE, "utf8");

const ANCHOR = `  await test("boosts dial: off by default, clamped to the 30-row upstream", () => {`;

const BLOCK = `  await test("parseDexSpacingStamp + dexSpacingDecaySteps: the fleet row's parse and decay rules", () => {
    // The row is the ONLY part of the 429 reaction that survives an isolate
    // (isolates churn every ~30s), so its parse rules are load-bearing: a
    // garbage row must read as "no fleet reading", and a \`steps: 0\` row must
    // survive as the record of a recovery — without it the next isolate
    // re-inherits an older, higher row and re-pays the episode.
    const {
      parseDexSpacingStamp,
      dexSpacingDecaySteps,
      DEX_ADAPTIVE_FLEET_DECAY_MS,
      DEX_SPACING_STATE_KEY,
    } = require("../dist/dexscreener.js");
    assert.equal(DEX_SPACING_STATE_KEY, "dex_spacing");
    assert.ok(DEX_ADAPTIVE_FLEET_DECAY_MS > 0, "the decay window must be a real window");

    assert.equal(parseDexSpacingStamp(null), null, "no row");
    assert.equal(parseDexSpacingStamp(undefined), null);
    assert.equal(parseDexSpacingStamp(""), null);
    assert.equal(parseDexSpacingStamp("nonsense"), null, "unreadable");
    assert.equal(parseDexSpacingStamp("[]"), null, "an array is not a row");
    assert.equal(parseDexSpacingStamp('"3"'), null);
    assert.equal(parseDexSpacingStamp('{"at":1000}'), null, "the count is not optional");
    assert.equal(parseDexSpacingStamp('{"steps":1}'), null, "nor is the timestamp");
    assert.equal(parseDexSpacingStamp('{"at":0,"steps":1}'), null, "0 is not a time");
    assert.equal(parseDexSpacingStamp('{"at":1000,"steps":-1}'), null, "negative steps");
    assert.equal(parseDexSpacingStamp('{"at":"1000","steps":1}'), null, "strings do not count");
    assert.deepEqual(
      parseDexSpacingStamp('{"at":1000.7,"steps":2.9}'),
      { at: 1000, steps: 2 },
      "readings are floored, never rounded up into an extra raise",
    );
    assert.deepEqual(
      parseDexSpacingStamp('{"at":1000,"steps":0}'),
      { at: 1000, steps: 0 },
      "a RECOVERY row is a real reading, not an absent one",
    );

    assert.equal(dexSpacingDecaySteps(null, 5_000), 0, "no row = no fleet raise");
    const stamp = { at: 1_000_000, steps: 3 };
    assert.equal(dexSpacingDecaySteps(stamp, 1_000_000), 3, "read the moment it landed");
    assert.equal(
      dexSpacingDecaySteps(stamp, 1_000_000 + DEX_ADAPTIVE_FLEET_DECAY_MS - 1),
      3,
      "a partial window buys nothing",
    );
    assert.equal(dexSpacingDecaySteps(stamp, 1_000_000 + DEX_ADAPTIVE_FLEET_DECAY_MS), 2);
    assert.equal(dexSpacingDecaySteps(stamp, 1_000_000 + 3 * DEX_ADAPTIVE_FLEET_DECAY_MS), 0);
    assert.equal(
      dexSpacingDecaySteps(stamp, 1_000_000 + 10_000 * DEX_ADAPTIVE_FLEET_DECAY_MS),
      0,
      "an old row can never read negative",
    );
    assert.equal(
      dexSpacingDecaySteps(stamp, 999_000),
      3,
      "a future \`at\` (clock skew between isolates) reads as 'it just happened'",
    );
  });

  await test("AdaptiveSpacing.adoptSteps: the fleet's row can only ever RAISE this isolate", () => {
    const { AdaptiveSpacing, DEX_ADAPTIVE_MAX_MS } = require("../dist/dexscreener.js");
    const base = new AdaptiveSpacing(250);
    assert.equal(base.adoptSteps(0), false, "adopting zero moves nothing");
    assert.equal(base.currentMs, 250);
    assert.equal(base.adoptSteps(1), true);
    assert.equal(base.currentMs, 400, "one adopted step is one refusal's worth of spacing");
    // The two layers must agree BY CONSTRUCTION: the same step count has to be
    // the same spacing whether it was earned by refusals or inherited from the
    // row, or "3 steps" would mean two different rates in two isolates.
    const earned = new AdaptiveSpacing(250);
    for (let i = 0; i < 3; i++) earned.noteRefused();
    const inherited = new AdaptiveSpacing(250);
    inherited.adoptSteps(3);
    assert.equal(inherited.currentMs, earned.currentMs, "250 x 1.6^3 either way");
    assert.equal(inherited.growthSteps, earned.growthSteps);
    // Raise-only is what protects a refusal that landed BEFORE the row carrying
    // the fleet reading was even awaited (see the dispatch in runOnce).
    assert.equal(inherited.adoptSteps(1), false, "a stale row never walks it back down");
    assert.equal(inherited.currentMs, earned.currentMs);
    // The ceiling is the live one, and past it there is no further raise to
    // count — so a row asking for more than the ceiling holds must return false
    // the second time rather than claim an inheritance it never got.
    const capped = new AdaptiveSpacing(250);
    capped.adoptSteps(99);
    assert.equal(capped.currentMs, DEX_ADAPTIVE_MAX_MS, "the ceiling is a ceiling");
    assert.equal(capped.adoptSteps(99), false, "and it stops counting raises there");
    // A configuration that asked for no spacing must never inherit one.
    const off = new AdaptiveSpacing(0);
    assert.equal(off.adoptSteps(4), false, "0 stays 0");
    assert.equal(off.currentMs, 0);
    assert.equal(base.baseMs, 250);
  });

  await test("DexScreenerClient: the spacing row crosses the isolate boundary that used to kill the raise", async () => {
    // Live 2026-09-29T00:57Z: the refused isolate read intervalMs 1024 /
    // spacingSteps 3 while the tick two minutes later — a DIFFERENT isolate —
    // read 250 / 0 and walked into the same burst at full rate. This is that
    // pair of isolates, with the row in between.
    const { DexScreenerClient, DEX_ADAPTIVE_FLEET_DECAY_MS } = require("../dist/dexscreener.js");
    const origFetch = globalThis.fetch;
    const addrs = Array.from({ length: 30 }, (_, i) => \`MINT\${i}\`.padEnd(44, "x"));
    try {
      globalThis.fetch = async () => new Response("rate limited", { status: 429 });
      const cfg = loadConfig({
        DEX_REQUEST_INTERVAL_MS: "250",
        REEVAL_POOL_CACHE_SECONDS: "90",
      });
      // Isolate A: refused, so it widens — and now says so.
      const a = new DexScreenerClient(cfg, {});
      assert.equal(a.adoptDurableSpacing(null).raised, false, "no row = nothing to inherit");
      assert.equal(a.getStats().spacingFleetAgeMs, null, "and the age reads as 'never read'");
      await a.fetchPairsForTokens(addrs);
      const widened = a.getStats();
      assert.ok(widened.spacingSteps >= 1, "the refusal widened the queue");
      const row = a.durableSpacingWrite(1_000_000);
      assert.ok(row !== null, "a raise is worth a write even with no row to compare against");
      assert.equal(row.at, 1_000_000, "the timestamp travels with the count");
      assert.equal(row.steps, widened.spacingSteps);
      assert.equal(a.durableSpacingWrite(1_000_001), null, "and it is written once, not every tick");

      // Isolate B: a fresh client, same config, inherits the raise.
      const b = new DexScreenerClient(cfg, {});
      const adopted = b.adoptDurableSpacing(JSON.stringify(row), 1_000_000);
      assert.equal(adopted.raised, true, "the raise crossed the isolate boundary — the whole point");
      assert.equal(adopted.steps, widened.spacingSteps);
      assert.equal(adopted.ageMs, 0);
      const bStats = b.getStats();
      assert.equal(bStats.spacingSteps, widened.spacingSteps);
      assert.equal(bStats.intervalMs, widened.intervalMs, "and so did the spacing itself");
      assert.equal(bStats.spacingFleetSteps, widened.spacingSteps);
      assert.equal(bStats.spacingFleetAgeMs, 0);
      assert.equal(b.durableSpacingWrite(1_000_000), null, "an adopted row is not re-written");

      // Isolate C: two windows later the row has decayed by two steps — it is a
      // memory of the burst, not a permanent rate cut.
      const c = new DexScreenerClient(cfg, {});
      const partial = c.adoptDurableSpacing(
        JSON.stringify(row),
        1_000_000 + 2 * DEX_ADAPTIVE_FLEET_DECAY_MS,
      );
      assert.equal(partial.steps, Math.max(0, widened.spacingSteps - 2));
      assert.equal(c.getStats().spacingFleetAgeMs, 2 * DEX_ADAPTIVE_FLEET_DECAY_MS);

      // Isolate D: long enough after the last refusal, the base is handed back.
      const quietAt = 1_000_000 + (widened.spacingSteps + 5) * DEX_ADAPTIVE_FLEET_DECAY_MS;
      const quiet = new DexScreenerClient(cfg, {});
      const quietRead = quiet.adoptDurableSpacing(JSON.stringify(row), quietAt);
      assert.equal(quietRead.steps, 0, "a row decays all the way back to the base");
      assert.equal(quietRead.raised, false);
      assert.equal(quiet.getStats().intervalMs, 250, "a quiet fleet runs at the configured spacing");
      assert.equal(
        quiet.getStats().spacingFleetAgeMs,
        (widened.spacingSteps + 5) * DEX_ADAPTIVE_FLEET_DECAY_MS,
        "the age is still published when the count is spent",
      );

      // A refusal AFTER the row decayed is recorded against the NEW episode:
      // \`at\` is what a later isolate measures its decay from, so re-writing the
      // count with the old timestamp would decay it twice.
      const d = new DexScreenerClient(cfg, {});
      d.adoptDurableSpacing(JSON.stringify(row), quietAt);
      await d.fetchPairsForTokens(addrs);
      const again = d.durableSpacingWrite(quietAt + 1);
      assert.ok(again !== null, "a fresh refusal is a fresh write");
      assert.equal(again.at, quietAt + 1);
      assert.ok(again.steps >= 1);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("fleet spacing wiring: the row rides the front's one read and one write", () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
    const scannerSrc = read("src/scanner.ts");
    const dbSrc = read("src/db.ts");
    const { DEX_SPACING_STATE_KEY } = require("../dist/dexscreener.js");
    // The row is read off the SAME statement the other gates ride, so the fleet
    // reading costs the tick no round trip of its own.
    assert.ok(
      scannerSrc.includes("front.gates.get(DEX_SPACING_STATE_KEY)"),
      "the fleet row must ride the scan front's ONE read",
    );
    assert.ok(
      dbSrc.includes(\`"\${DEX_SPACING_STATE_KEY}"\`),
      \`db.SCAN_FRONT_GATE_KEYS must carry the literal "\${DEX_SPACING_STATE_KEY}"\`,
    );
    // The adoption follows the front read, and the raise-only rule exists
    // precisely because the profiles fetch was dispatched BEFORE it.
    const frontRead = scannerSrc.indexOf("const front = await frontRead;");
    const adopt = scannerSrc.indexOf("this.dex.adoptDurableSpacing(");
    assert.ok(frontRead > 0, "the front read anchor must exist");
    assert.ok(adopt > frontRead, "the adoption must follow the front read");
    // The write goes on the front write the tick already owes, and is queued
    // BEFORE the flush that carries it (the scan's \`finally\`).
    const writeAt = scannerSrc.indexOf("this.dex.durableSpacingWrite()");
    const lastFlush = scannerSrc.lastIndexOf("await this.flushScanFront();");
    assert.ok(writeAt > 0, "the tick must write its count back");
    assert.ok(writeAt < lastFlush, "and queue it before the flush that carries it");
    assert.ok(
      scannerSrc.includes("diag.dex.spacingFleetSteps = fleetSpacing.steps"),
      "the fleet reading must be published, or a raise crossing an isolate is invisible",
    );
    assert.ok(scannerSrc.includes("diag.dex.spacingFleetAgeMs = fleetSpacing.ageMs"));
    // One writer only: a second write site would be a second round trip on a
    // tick that already has one, and the two could disagree.
    assert.equal(
      (scannerSrc.match(/durableSpacingWrite\\(/g) || []).length,
      1,
      "exactly one write site in the tick",
    );
  });

`;

if (src.includes('await test("parseDexSpacingStamp + dexSpacingDecaySteps')) {
  console.log("  -- tests (already applied)");
} else {
  if (!src.includes(ANCHOR)) throw new Error("[tests] anchor not found");
  src = src.replace(ANCHOR, BLOCK + ANCHOR);
  fs.writeFileSync(FILE, src);
  console.log("  ok tests inserted");
}
