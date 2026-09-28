/*
 * Follow-up to tier1-overlap-2026-09-28.apply.js: `poolMs` must keep measuring
 * the pool READ's own duration.
 *
 * As first written, the join measured `Date.now() - poolReadStartedAt` AFTER
 * `await poolRead` — but by then the read has usually already settled, so what
 * was recorded was the whole dispatch → join window (i.e. the feed phase):
 * live 2026-09-28T10:09Z read `poolMs 773` with `feedsMs 773` and
 * `poolWaitMs 0`, which is the feed phase wearing the pool's name. Timing the
 * promise itself is what the field always meant.
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const p = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(p, "utf8");
const out = [];
let failed = 0;

function edit(name, from, to) {
  if (src.includes(to) && !src.includes(from)) {
    out.push(["=", `${name} (already applied)`]);
    return;
  }
  const n = src.split(from).length - 1;
  if (n !== 1) {
    out.push(["✗", `${name} — anchor found ${n} times`]);
    failed += 1;
    return;
  }
  src = src.replace(from, () => to);
  out.push(["✓", name]);
}

edit(
  "timer: poolReadMs declared",
  `      const poolReadStartedAt = Date.now();
      const poolRead = this.fetchFeedCapped(`,
  `      const poolReadStartedAt = Date.now();
      let poolReadMs = 0;
      const poolRead = this.fetchFeedCapped(`,
);

edit(
  "timer: the promise is timed, not the await",
  `          }),
        [],
        poolDeadline,
      );
      // token_stats grows with pump.fun discovery (100+ new coins per scan):`,
  `          }),
        [],
        poolDeadline,
      ).then((stats) => {
        // Time the PROMISE, not the await: by the time the tick joins, the
        // read has usually settled already, so reading the clock at the join
        // would measure the whole dispatch → join window (the feed phase)
        // under the pool's name.
        poolReadMs = Date.now() - poolReadStartedAt;
        return stats;
      });
      // token_stats grows with pump.fun discovery (100+ new coins per scan):`,
);

edit(
  "timer: the join reports it",
  `      diag.poolMs = Date.now() - poolReadStartedAt;
`,
  `      diag.poolMs = poolReadMs;
`,
);

for (const [m, n] of out) console.log(`${m} ${n}`);
if (failed === 0 && !src.includes("diag.poolMs = poolReadMs;")) {
  console.log("✗ refused to write: the join does not report poolReadMs");
  process.exit(1);
}
if (failed === 0) fs.writeFileSync(p, src);
else console.log("✗ refused to write: an anchor failed");
process.exit(failed === 0 ? 0 : 1);
