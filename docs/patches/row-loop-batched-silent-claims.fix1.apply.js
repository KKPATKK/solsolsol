#!/usr/bin/env node
/**
 * Compile fix for docs/patches/row-loop-batched-silent-claims.apply.js: the
 * queue carries what the ROW knows (token, expected stamp, backfill flag, check
 * fields) while `now` is the pass's constant — so it is bound at the call
 * instead of being duplicated into every queued row. Same discipline: exactly
 * one match or nothing is written.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";

const old = `        won = await this.db.claimPushWatchChecksMany(silentChecks);`;
const next = `        won = await this.db.claimPushWatchChecksMany(
          silentChecks.map((s) => ({
            token: s.token,
            expectedLastChecked: s.expectedLastChecked,
            now,
            v: s.v,
          })),
        );`;

const text = fs.readFileSync(PW, "utf8");
const first = text.indexOf(old);
if (first < 0) {
  console.error("MISS      pw: bind the pass clock at the batch call");
  process.exit(1);
}
if (text.indexOf(old, first + 1) >= 0) {
  console.error("AMBIGUOUS pw: bind the pass clock at the batch call");
  process.exit(1);
}
fs.writeFileSync(PW, text.slice(0, first) + next + text.slice(first + old.length));
console.log("ok        pw: bind the pass clock at the batch call");
