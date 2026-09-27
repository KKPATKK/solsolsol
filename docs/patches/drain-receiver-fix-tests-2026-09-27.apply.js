// Verify-then-write: pin the RECEIVER contract in the coalescing test (live
// 2026-09-27 `TypeError: this.get is not a function` slipped through because
// every fake was `this`-free) and pin the consecutive-failure rule (a landed
// batch resets attempts).
const fs = require("fs");

const FILE = "scripts/test-unit.js";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

patch(
  "the mock lives on the handle and touches `this`",
  `    const calls = [];
    const db = {
      recordTokenStatsMany: async (records) => {
        // The RECORDS matter, not just the tokens: first-wins is a claim about
        // which sight of a token survives (first_seen_at is the pool's age).
        calls.push({ name: "register", tokens: records.map((r) => r.token), records });
      },
      updateTokenMaxMcaps: async (records) => { calls.push({ name: "raise", records }); },
    };`,
  `    // The methods live on the handle and touch \`this\` ON PURPOSE (the real Db
    // methods call \`this.get\`): the drain invokes them later, from runBucket,
    // with no call-site receiver — live 2026-09-27 an unbound call threw
    // \`TypeError: this.get is not a function\` in production while every
    // \`this\`-free fake passed.
    const db = {
      calls: [],
      async recordTokenStatsMany(records) {
        // The RECORDS matter, not just the tokens: first-wins is a claim about
        // which sight of a token survives (first_seen_at is the pool's age).
        this.calls.push({
          name: "register",
          tokens: records.map((r) => r.token),
          records,
        });
      },
      async updateTokenMaxMcaps(records) { this.calls.push({ name: "raise", records }); },
    };
    const calls = db.calls;`,
);

patch(
  "the consecutive-failure rule is pinned",
  `    assert.equal(calls[1].tokens.length, 3, "the next drain takes the remainder");
    assert.equal(second.owedTokens, 0, "and the backlog is empty");

    // LANDING ORDER: a registration must beat the raise for the same token, or`,
  `    assert.equal(calls[1].tokens.length, 3, "the next drain takes the remainder");
    assert.equal(second.owedTokens, 0, "and the backlog is empty");

    // The failure count is for CONSECUTIVE failures (the old per-entry rule):
    // a landed batch resets it, so a bucket that failed twice and recovered
    // must not be DROPPED — the whole backlog and all — by one new failure
    // later.
    resetTickProbe();
    let failsLeft = 2;
    const flaky = {
      async recordTokenStatsMany() {
        if (failsLeft > 0) {
          failsLeft -= 1;
          throw new Error("turso 522");
        }
      },
      async updateTokenMaxMcaps() {},
    };
    const tick3 = async (fn) => {
      const seam = { runOnce: async () => { await fn(); } };
      installTickProbe(seam, { db: flaky, deferWrites: true });
      await seam.runOnce();
    };
    const queueOne = () =>
      tick3(async () => {
        await flaky.recordTokenStatsMany([{ token: "Q", firstSeenAt: 1 }]);
      });
    await queueOne();
    assert.equal((await drainDeferredWrites(() => 50)).failures, 1, "first failure is counted");
    const secondAttempt = await drainDeferredWrites(() => 50);
    assert.equal(secondAttempt.failures, 1, "a second consecutive failure is counted");
    assert.equal(deferredWriteCount(), 1, "and the record is still owed");
    const thirdAttempt = await drainDeferredWrites(() => 50);
    assert.equal(thirdAttempt.failures, 0, "the third attempt lands");
    assert.equal(deferredWriteCount(), 0, "emptying the bucket");
    await queueOne();
    failsLeft = 1;
    const fourthAttempt = await drainDeferredWrites(() => 50);
    assert.equal(fourthAttempt.failures, 1, "a failure AFTER a landed batch starts over");
    assert.equal(
      deferredWriteCount(),
      1,
      "so one new failure does NOT drop the batch — only consecutive failures do",
    );

    // LANDING ORDER: a registration must beat the raise for the same token, or`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE}`);
}
