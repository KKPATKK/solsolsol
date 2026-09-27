// Verify-then-write: reserve the reject log's owed share (src/scanner.ts).
const fs = require("fs");

const FILE = "src/scanner.ts";
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

// (A) Import the make-up lane's own cap — the reserve has to be bounded by the
// same number the lane is, or it would reserve slots nothing can occupy.
patch(
  "import DEFERRED_MAKEUP_MAX",
  `import {
  addDeferredToken,
  deferredTokenList,
  dropDeferredToken,
  hydrateDeferredTokens,
  isDeferredToken,
  missingDeferredTokens,
  noteDeferredCoin,
} from "./deferredmakeup";`,
  `import {
  addDeferredToken,
  DEFERRED_MAKEUP_MAX,
  deferredTokenList,
  dropDeferredToken,
  hydrateDeferredTokens,
  isDeferredToken,
  missingDeferredTokens,
  noteDeferredCoin,
} from "./deferredmakeup";`,
);

// (B) The reservation itself.
patch(
  "owed share",
  `      // REJECT_LOG_MAX (20) is smaller than feed+slice (~90+ coins/tick), so
      // the bounded reject list filled first-come-first-served: the feed's
      // dozens of fresh bonding-curve coins (all "流动性 ~$0") flooded it and
      // the pool coins' rejections never surfaced, making zero-push stretches
      // look unexplained on /health. Reserve the pool slice a guaranteed
      // share: feed coins may log only into the first \`feedBudgetStart\`
      // slots (the leftover), pool coins log up to the cap.
      const rejectBudgetBeforeEval = REJECT_LOG_MAX - Math.min(
        poolSlice.length,
        REJECT_LOG_MAX,
      );`,
  `      // REJECT_LOG_MAX (20) is smaller than feed+slice (~90+ coins/tick), so
      // the bounded reject list filled first-come-first-served: the feed's
      // dozens of fresh bonding-curve coins (all "流动性 ~$0") flooded it and
      // the pool coins' rejections never surfaced, making zero-push stretches
      // look unexplained on /health. Reserve the pool slice a guaranteed
      // share: feed coins may log only into the first \`feedBudgetStart\`
      // slots (the leftover), pool coins log up to the cap.
      //
      // OWED COINS GET A RESERVE OF THEIR OWN (2026-09-27). Exempting them from
      // the budget is not enough on its own: the log is capped at
      // REJECT_LOG_MAX before anything else, and the make-up lane appends its
      // coins to the END of the feed list — so a busy feed fills all 20 slots
      // first and the debt is cut out again, which is the reading this reserve
      // exists to produce (live that day: pending 1 for 95 minutes, every
      // counter healthy, no way to name the gate). Bounded by the lane's own
      // injection cap so the reserve can never exceed what the lane can
      // actually deliver, and by what the pool's share leaves over so the
      // budget cannot go negative.
      const poolShare = Math.min(poolSlice.length, REJECT_LOG_MAX);
      const owedShare = Math.max(
        0,
        Math.min(
          DEFERRED_MAKEUP_MAX,
          this.deferredPushes.pendingCount,
          REJECT_LOG_MAX - poolShare,
        ),
      );
      const rejectBudgetBeforeEval = REJECT_LOG_MAX - poolShare - owedShare;`,
);

// (C) The budget's doc comment names the reservation.
patch(
  "logBudget doc reserve",
  `     * Three classes, not two (2026-09-27): pool coins and OWED coins always
     * log; only the feed's own discoveries are budgeted. An owed coin carries
     * \`owed: true\` so the reason it is still owed is readable at a glance
     * instead of only inferable from the counters.`,
  `     * Three classes, not two (2026-09-27): pool coins and OWED coins always
     * log; only the feed's own discoveries are budgeted. The owed class also
     * gets a RESERVED share of the cap (see the reserve at the call site), so
     * a busy feed cannot fill every slot before the make-up lane's coins — its
     * tail entries — are evaluated. An owed coin carries \`owed: true\` so the
     * reason it is still owed is readable at a glance instead of only
     * inferable from the counters.`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
