// Verify-then-write: the coalescing test must PIN first-wins, not just tokens.
// Found by mutation 2026-09-27: absorbFirstWins → second-wins still left the
// register call's token list ["A","B"], so the token-only assertion could not
// see the mutation. The record itself (first_seen_at is the pool's age signal)
// is what the rule is about, so the mock now keeps the records and the
// assertion reads them.
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
  "mock keeps the records",
  `      recordTokenStatsMany: async (records) => {
        calls.push({ name: "register", tokens: records.map((r) => r.token) });
      },`,
  `      recordTokenStatsMany: async (records) => {
        // The RECORDS matter, not just the tokens: first-wins is a claim about
        // which sight of a token survives (first_seen_at is the pool's age).
        calls.push({ name: "register", tokens: records.map((r) => r.token), records });
      },`,
);

patch(
  "the assertion reads the kept record",
  `    assert.deepEqual(
      calls,
      [
        { name: "register", tokens: ["A", "B"] },
        {
          name: "raise",
          records: [{ token: "A", mcapUsd: 9, liquidityUsd: 1000 }],
        },
      ],
      "registration lands first and keeps the FIRST sight; the raise keeps the MAX on both columns (a finite liquidity survives a record without one)",
    );`,
  `    assert.deepEqual(
      calls,
      [
        {
          name: "register",
          tokens: ["A", "B"],
          records: [
            { token: "A", firstSeenAt: 100 },
            { token: "B", firstSeenAt: 100 },
          ],
        },
        {
          name: "raise",
          records: [{ token: "A", mcapUsd: 9, liquidityUsd: 1000 }],
        },
      ],
      "registration lands first and keeps the FIRST sight (A's firstSeenAt stays 100, not the second tick's 900); the raise keeps the MAX on both columns (a finite liquidity survives a record without one)",
    );`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE}`);
}
