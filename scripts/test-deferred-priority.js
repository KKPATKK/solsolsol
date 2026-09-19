const assert = require("node:assert/strict");
const { DeferredPushLedger, slicePoolRotation } = require("../dist/scanner.js");
const { loadPushDeferralSnapshot, nextPushDeferralSnapshot } = require("../dist/deferrallog.js");

const ledger = new DeferredPushLedger();
ledger.defer("PRIORITY", 1);
assert.deepEqual(ledger.pendingTokens(), ["PRIORITY"]);

const result = slicePoolRotation(
  [
    { tokenAddress: "ordinary-1" },
    { tokenAddress: "PRIORITY" },
    { tokenAddress: "ordinary-2" },
  ],
  0,
  2,
);
assert.deepEqual(result.slice.map((item) => item.tokenAddress), ["PRIORITY", "ordinary-1"]);
assert.equal(ledger.recover("PRIORITY"), true);
assert.equal(ledger.pendingCount, 0);

const durable = nextPushDeferralSnapshot(
  null,
  { deferred: 1, recovered: 0, pending: 1 },
  100,
  { owner: "iso-a", deferred: 1, recovered: 0 },
  ["DURABLE_TOKEN"],
);
const reloaded = loadPushDeferralSnapshot(JSON.stringify(durable));
assert.deepEqual(reloaded.pendingTokens, ["DURABLE_TOKEN"]);

console.log("deferred priority: pass");
