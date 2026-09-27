#!/usr/bin/env node
/*
 * APPLY (idempotent): the offline test for the init-boot self-heal.
 *
 * scripts/test-unit.js is past this repo's file-edit window too, so the test
 * lands the same way the worker.ts edit did: an anchored, verify-then-write
 * script that prints ✓ / = / ✗ and is safe to re-run.
 *
 * The test pins what the two new pieces of worker.ts actually do — a REJECTED
 * boot clears its cache (the shape that used to pin an isolate to
 * `scanner === null` for hours), a boot that never settles is dropped by the
 * next tick's staleness verdict, a healthy settle never is, and a late settle
 * of an abandoned boot leaves the live one's age alone.
 *
 * Run: node docs/patches/init-boot-heal-tests-2026-09-27.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "scripts", "test-unit.js");

const ANCHOR = `    assert.ok(scanRescueGapMs(60_000) > scanGateMs(60_000) * 2, "a rescue is never one gate late");
  });
`;

const MARKER = "init boot cache: a REJECTED or HUNG boot stops being cached";

const TEST = `
  await test("${MARKER}", async () => {
    const { cachedInitVerdict, trackInitBoot, INIT_UNSETTLED_MAX_MS } =
      require("../dist/worker.js");
    // The staleness test is the only thing that can free a boot that never
    // settles — no rejection handler can see that shape. Reused while young,
    // dropped past the bound, and never consulted with nothing pending (0 is
    // the "no boot cached" stamp, not an ancient one).
    const t0 = 1_000_000;
    assert.equal(cachedInitVerdict(0, t0), "reuse", "nothing pending = nothing to drop");
    assert.equal(
      cachedInitVerdict(t0, t0 + INIT_UNSETTLED_MAX_MS),
      "reuse",
      "at the bound the boot is still reused",
    );
    assert.equal(
      cachedInitVerdict(t0, t0 + INIT_UNSETTLED_MAX_MS + 1),
      "drop",
      "one ms past it, the tick must rebuild",
    );
    assert.equal(INIT_UNSETTLED_MAX_MS, 60_000, "the bound is the measured-generous one");
    assert.ok(
      INIT_UNSETTLED_MAX_MS > FRONT_INIT_BOUND_MS * 10,
      "a healthy boot (bounded at FRONT_INIT_BOUND_MS in front of a tick) can never look hung",
    );

    // A REJECTED boot: the cache is cleared the moment it rejects, and the
    // reason is reported — this is the shape that used to pin an isolate to
    // \`scanner === null\` for hours, because the reset in the creating call
    // sits after the \`await\` the rejection throws past.
    const rejected = { pendingSince: 0 };
    let rejectBoot;
    const failing = new Promise((_, reject) => {
      rejectBoot = reject;
    });
    const seen = [];
    const current = true;
    trackInitBoot(failing, rejected, {
      isCurrent: () => current,
      onReject: (err) => seen.push(err.message),
    });
    assert.ok(rejected.pendingSince > 0, "the age is stamped where the boot is cached");
    rejectBoot(new Error("createBot: invalid token"));
    await failing.catch(() => {});
    assert.deepEqual(seen, ["createBot: invalid token"], "the reason is reported, never swallowed");
    assert.equal(rejected.pendingSince, 0, "and the boot stops being pending");

    // A boot that SETTLES is not pending either — the normal shape, and the
    // one the staleness test must never touch.
    const settled = { pendingSince: 0 };
    let settledRejects = 0;
    const ok = Promise.resolve();
    trackInitBoot(ok, settled, {
      isCurrent: () => true,
      onReject: () => {
        settledRejects += 1;
      },
    });
    assert.ok(settled.pendingSince > 0, "a fresh boot is pending until it settles");
    await ok;
    assert.equal(settled.pendingSince, 0, "a resolved boot is not pending");
    assert.equal(settledRejects, 0, "and a resolution is not a failure");

    // A LATE settle of an abandoned boot must leave the LIVE boot's age alone:
    // zeroing it would blind the staleness guard to the boot it is waiting for.
    // Its rejection is still reported (a real attempt really failed); the cache
    // itself is left to the call site's own identity test.
    const live = { pendingSince: 0 };
    let lateReject;
    const stale = new Promise((_, reject) => {
      lateReject = reject;
    });
    const lateReasons = [];
    trackInitBoot(stale, live, {
      isCurrent: () => false,
      onReject: (err) => lateReasons.push(err.message),
    });
    live.pendingSince = 7_777; // a newer boot now owns the cache
    lateReject(new Error("late"));
    await stale.catch(() => {});
    assert.equal(live.pendingSince, 7_777, "a late settle does not touch the live boot's age");
    assert.deepEqual(lateReasons, ["late"], "but it is still reported");

    // The wiring in worker.ts itself: the guard must CLEAR the cache (a log
    // alone would leave the wedge in place), and the boot must be tracked with
    // the identity test the case above relies on.
    const workerSrc = fs
      .readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8")
      .replace(/\\s+/g, "");
    assert.ok(
      workerSrc.includes('cachedInitVerdict(initBoot.pendingSince,Date.now())==="drop"'),
      "the cached boot is tested for staleness through the shared verdict",
    );
    assert.ok(
      workerSrc.includes("trackInitBoot(boot,initBoot,{isCurrent:()=>initPromise===boot,"),
      "and it is tracked with the identity test, not a bare rejection handler",
    );
  });
`;

function main() {
  const original = fs.readFileSync(FILE, "utf8");
  if (original.includes(MARKER)) {
    console.log("= test: already applied");
    console.log("\nscripts/test-unit.js already carries the test — nothing written");
    process.exit(0);
  }
  const hits = original.split(ANCHOR).length - 1;
  if (hits !== 1) {
    console.log(`✗ anchor matched ${hits} times (expected 1) — refusing to guess`);
    console.log("\nscripts/test-unit.js left UNCHANGED");
    process.exit(1);
  }
  const out = original.replace(ANCHOR, ANCHOR + TEST);
  fs.writeFileSync(FILE, out);
  const written = fs.readFileSync(FILE, "utf8");
  const n = written.split(MARKER).length - 1;
  console.log(`✓ test: applied (${original.length} -> ${out.length} bytes)`);
  console.log(`  ${n === 1 ? "✓" : "✗"} ${MARKER} x${n}`);
  process.exit(n === 1 ? 0 : 1);
}

main();
