/*
 * Anchored patch adding the unit tests for the 2026-09-29 changes:
 *   - DexScreener adaptive dispatch spacing (src/dexscreener.ts)
 *   - the maintenance cron split (src/{scanner,worker,db,subreqs}.ts)
 *
 * Run: node docs/patches/maintenance-cron-2026-09-29.tests.apply.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(FILE, "utf8");
const before = src;

let applied = 0;
function edit(label, anchor, replacement) {
  if (src.includes(replacement)) {
    console.log(`  -- ${label} (already applied)`);
    return;
  }
  if (!src.includes(anchor)) throw new Error(`[${label}] anchor not found`);
  src = src.replace(anchor, replacement);
  applied++;
  console.log(`  ok ${label}`);
}

edit(
  "adaptive spacing tests (beside the 429 test)",
  `      assert.equal(calls, before, "blocked calls serve cache only (no requests)");
      assert.equal(episodes.length, 1, "no duplicate episode notify while blocked");
    } finally {
      globalThis.fetch = origFetch;
    }
  });`,
  `      assert.equal(calls, before, "blocked calls serve cache only (no requests)");
      assert.equal(episodes.length, 1, "no duplicate episode notify while blocked");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("AdaptiveSpacing: a refusal widens the dispatch spacing, a healthy streak walks it back", () => {
    // The spacing was one config constant and the only reaction to a 429 was
    // a 90s cache-only block, so the queue walked straight back into the same
    // refusal the moment the block expired (live: dex.http429 ~11/hour with
    // the IP never actually slowing down). See AdaptiveSpacing.
    const {
      AdaptiveSpacing,
      DEX_ADAPTIVE_MAX_MS,
      DEX_ADAPTIVE_GROWTH,
      DEX_ADAPTIVE_RECOVER_SUCCESSES,
    } = require("../dist/dexscreener.js");
    const s = new AdaptiveSpacing(250);
    assert.equal(s.currentMs, 250, "starts at the configured base");
    assert.equal(s.growthSteps, 0, "and reads as untouched");
    s.noteRefused();
    assert.equal(s.currentMs, 400, "one refusal buys 150ms of room (250 x 1.6)");
    assert.equal(s.growthSteps, 1);
    for (let i = 0; i < 10; i++) s.noteRefused();
    assert.equal(s.currentMs, DEX_ADAPTIVE_MAX_MS, "the ceiling is a ceiling");
    // A served response ALONE must not relax it: the expiry of the cache-only
    // block is exactly when the queue is hottest, so one answer is the shape a
    // re-triggered episode has.
    for (let i = 0; i < DEX_ADAPTIVE_RECOVER_SUCCESSES - 1; i++) s.noteServed();
    assert.equal(
      s.currentMs,
      DEX_ADAPTIVE_MAX_MS,
      "one short of the streak relaxes nothing",
    );
    s.noteServed();
    assert.equal(
      s.currentMs,
      Math.round(DEX_ADAPTIVE_MAX_MS / DEX_ADAPTIVE_GROWTH),
      "the streak buys one step back",
    );
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < DEX_ADAPTIVE_RECOVER_SUCCESSES; j++) s.noteServed();
    }
    assert.equal(s.currentMs, 250, "a recovered client lands exactly on the base");
    assert.equal(s.growthSteps, 0, "with no residual steps");
    assert.equal(s.baseMs, 250);
    // A caller that asked for no spacing asked for no spacing: adaptation must
    // never invent a request rate nobody measured.
    const off = new AdaptiveSpacing(0);
    off.noteRefused();
    off.noteRefused();
    assert.equal(off.currentMs, 0, "0 stays 0 under refusals");
    off.noteServed();
    assert.equal(off.currentMs, 0, "and under successes");
  });

  await test("DexScreenerClient: a 429 raises the LIVE spacing above the configured base", async () => {
    const { DexScreenerClient } = require("../dist/dexscreener.js");
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("rate limited", { status: 429 });
    try {
      const cfg = loadConfig({
        DEX_REQUEST_INTERVAL_MS: "250",
        REEVAL_POOL_CACHE_SECONDS: "90",
      });
      const dex = new DexScreenerClient(cfg, {});
      assert.equal(dex.getStats().intervalMs, 250, "healthy = the configured spacing");
      assert.equal(dex.getStats().configuredIntervalMs, 250);
      assert.equal(dex.getStats().spacingSteps, 0);
      const addrs = Array.from({ length: 30 }, (_, i) => \`MINT\${i}\`.padEnd(44, "x"));
      await dex.fetchPairsForTokens(addrs);
      const stats = dex.getStats();
      assert.ok(
        stats.intervalMs > stats.configuredIntervalMs,
        \`a 429 must widen the live spacing (got \${stats.intervalMs})\`,
      );
      assert.ok(stats.spacingSteps >= 1, "and count the raise");
      assert.equal(
        stats.configuredIntervalMs,
        250,
        "the base is untouched — it is what a recovery returns to",
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });`,
);

edit(
  "maintenance cron tests (after the TRACKER_CRON test)",
  `    assert.equal(TRACKER_PASS_FALLBACK_FRESH_MS, 120_000);
  });`,
  `    assert.equal(TRACKER_PASS_FALLBACK_FRESH_MS, 120_000);
  });

  await test("MAINTENANCE_CRON: the maintenance delivery is routed, configured and never a scan", () => {
    const { isMaintenanceCron, isTrackerCron, MAINTENANCE_CRON } =
      require("../dist/worker.js");
    const {
      MAINTENANCE_PASS_STATE_KEY,
      MAINTENANCE_PASS_FALLBACK_FRESH_MS,
      parseMaintenanceStamp,
      maintenancePassAgeMs,
      maintenancePassFresh,
    } = require("../dist/scanner.js");
    assert.equal(MAINTENANCE_CRON, "*/5 * * * *");
    assert.equal(isMaintenanceCron(MAINTENANCE_CRON), true);
    assert.equal(isMaintenanceCron(" */5 * * * * "), true, "outside whitespace is trimmed");
    assert.equal(isMaintenanceCron("* * * * *"), false, "the scan trigger is not this delivery");
    assert.equal(
      isMaintenanceCron("*/5  *  *  *  *"),
      false,
      "an expression that differs INSIDE is not this trigger: the platform matches character for character",
    );
    assert.equal(isMaintenanceCron(undefined), false);
    assert.equal(isMaintenanceCron(null), false);
    assert.equal(
      isTrackerCron(MAINTENANCE_CRON),
      false,
      "the two deliveries must never collide — a collision would hand the pass the maintenance budget",
    );
    // Configured, not just declared: the platform hands over the string it was
    // given, so a constant wrangler.toml does not carry is a delivery that
    // never fires.
    const toml = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8");
    const block = /^\\[triggers\\][\\s\\S]*?^crons\\s*=\\s*\\[([^\\]]*)\\]/m.exec(toml);
    assert.ok(block, "wrangler.toml must carry a [triggers].crons list");
    const list = block[1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0);
    assert.ok(list.includes(MAINTENANCE_CRON), \`must be configured: \${MAINTENANCE_CRON}\`);
    assert.ok(list.includes("* * * * *"), "the scan tick keeps its own expression");
    assert.equal(list[0], "* * * * *", "the FIRST expression stays the scan tick");

    // The pure helpers. The reading has to be fail-open toward RUNNING the
    // legs: an absent or unreadable row means the tick does the work itself,
    // never that the work is skipped.
    const now = 1_790_000_000_000;
    assert.equal(MAINTENANCE_PASS_STATE_KEY, "maintenance_pass_at");
    assert.equal(MAINTENANCE_PASS_FALLBACK_FRESH_MS, 11 * 60_000);
    assert.deepEqual(
      parseMaintenanceStamp(JSON.stringify({ at: now, backfill: 3, crime: true })),
      { at: now, backfill: 3, crime: true },
    );
    assert.deepEqual(
      parseMaintenanceStamp(String(now)),
      { at: now, backfill: 0, crime: false },
      "a bare epoch-ms row still answers how old it is",
    );
    assert.equal(parseMaintenanceStamp(null), null);
    assert.equal(parseMaintenanceStamp(""), null);
    assert.equal(parseMaintenanceStamp("not json"), null);
    assert.equal(parseMaintenanceStamp(JSON.stringify({ backfill: 3 })), null, "no at = not a stamp");
    assert.equal(parseMaintenanceStamp(JSON.stringify({ at: 0 })), null, "at 0 is not a stamp");
    assert.equal(maintenancePassAgeMs(JSON.stringify({ at: now - 1_000 }), now), 1_000);
    assert.equal(
      maintenancePassAgeMs(String(now + 5_000), now),
      0,
      "a stamp from the future reads as 0, never negative — clock skew must not read as a dead trigger",
    );
    assert.equal(maintenancePassAgeMs(null, now), null);
    assert.equal(maintenancePassFresh(null, now, 660_000), false, "no row = the tick runs the legs");
    assert.equal(maintenancePassFresh("garbage", now, 660_000), false);
    assert.equal(maintenancePassFresh(JSON.stringify({ at: now - 1_000 }), now, 660_000), true);
    assert.equal(
      maintenancePassFresh(JSON.stringify({ at: now - 660_000 }), now, 660_000),
      false,
      "the window is exclusive: at exactly freshMs the tick takes the legs back",
    );
    assert.equal(
      maintenancePassFresh(JSON.stringify({ at: now + 60_000 }), now, 660_000),
      true,
      "clock skew must not double-run the legs",
    );
    assert.equal(
      maintenancePassFresh(JSON.stringify({ at: now }), now, 0),
      false,
      "a disabled window means the tick owns the legs",
    );
  });

  await test("maintenance split wiring: the tick yields its two legs and the worker routes the delivery", () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
    const scannerSrc = read("src/scanner.ts");
    const workerSrc = read("src/worker.ts");
    const dbSrc = read("src/db.ts");
    // The two side-effect legs are gated on the ownership reading ...
    assert.ok(
      scannerSrc.includes(
        'if (!maintFresh && this.crimeWallets && !dropOptionalLeg("crime-refresh"))',
      ),
      "the crime-wallet refresh yields to the maintenance invocation",
    );
    assert.ok(
      scannerSrc.includes('if (!maintFresh && !(backfillArmed && dropOptionalLeg("backfill")))'),
      "the Birdeye backfill yields to the maintenance invocation",
    );
    // ... which rides the front's ONE read and is published, so a skipped
    // backfill can never be mistaken for an upstream outage.
    assert.ok(
      scannerSrc.includes("front.gates.get(MAINTENANCE_PASS_STATE_KEY)"),
      "the ownership reading costs no round trip",
    );
    assert.ok(scannerSrc.includes("diag.maintFresh = maintFresh"));
    assert.ok(scannerSrc.includes("diag.maintAgeMs ="));
    // The GeckoTerminal leg deliberately STAYS in the tick: its pools are that
    // minute's candidate list, not a side effect. Pin the decision so a later
    // refactor has to argue with a test.
    assert.ok(
      !scannerSrc.includes('dropOptionalLeg("gecko'),
      "gecko discovery must not be dropped/moved along with the side-effect legs",
    );
    // The routing returns BEFORE the scan's arrival bookkeeping — the arrival
    // counters and the cadence gate both compare SCAN arrivals.
    const route = workerSrc.indexOf("isMaintenanceCron(event.cron)) {");
    const arrivals = workerSrc.indexOf("scheduledTicks++;");
    assert.ok(route > 0, "the scheduled handler must route the maintenance delivery");
    assert.ok(arrivals > 0, "the scan bookkeeping anchor must exist");
    assert.ok(
      route < arrivals,
      "the maintenance delivery must return before scheduledTicks++",
    );
    assert.ok(
      workerSrc.includes("async function runMaintenanceInvocation"),
      "and the invocation itself must exist",
    );
    // The row rides the front read (no extra request), spelled as a literal
    // there because db.ts cannot import scanner.ts.
    assert.ok(
      dbSrc.includes('"maintenance_pass_at"'),
      "the maintenance row must ride db.SCAN_FRONT_GATE_KEYS",
    );
  });`,
);

fs.writeFileSync(FILE, src);
console.log(`\ntest-unit.js: ${applied} applied, ${src.length - before.length} bytes added`);
