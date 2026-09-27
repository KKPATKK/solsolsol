// Verify-then-write: an owed coin always logs its blocking gate (src/scanner.ts).
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

// (A) The reject entry says which coin is an unpaid debt.
patch(
  "RejectionEntry.owed",
  `export interface RejectionEntry {
  symbol: string;
  ageMin: number;
  mcapUsd: number;
  vol5Usd: number;
  chgPct: number;
  reason: string;
}`,
  `export interface RejectionEntry {
  symbol: string;
  ageMin: number;
  mcapUsd: number;
  vol5Usd: number;
  chgPct: number;
  reason: string;
  /**
   * True when this coin is an UNPAID deferred-card obligation (a coin the bot
   * owes somebody a card) rather than one of the feed's own discoveries.
   *
   * Marked because the two are otherwise indistinguishable in the list, and
   * the debt is the entry an operator actually reads the log for: it is the
   * only rejection that explains a standing obligation instead of a missed
   * card (see logBudget — owed coins are also exempt from the feed's slot
   * budget, for the reason recorded there).
   */
  owed?: boolean;
}`,
);

// (B) Hoist the owed check: the note and the log budget must agree on ONE
// reading of "this coin is owed".
patch(
  "owed hoist",
  `      if (isDeferredToken(profile.tokenAddress)) {
        this.deferredPushes.noteCoinAge(
          profile.tokenAddress,
          pair ? Date.now() - pair.pairCreatedAt : null,
          widestMaxAgeMs,
        );
      }`,
  `      // Read ONCE: the make-up verdict below and the reject-log budget further
      // down must not be able to disagree about whether this coin is owed.
      const owed = isDeferredToken(profile.tokenAddress);
      if (owed) {
        this.deferredPushes.noteCoinAge(
          profile.tokenAddress,
          pair ? Date.now() - pair.pairCreatedAt : null,
          widestMaxAgeMs,
        );
      }`,
);

// (C) The owed coin logs even past the feed budget, and says so.
patch(
  "reject budget exempts owed",
  `      const reject = (reason: string) => {
        if (rejects.length >= REJECT_LOG_MAX) return;
        // Pool coins always log (up to the cap); feed coins may occupy only
        // the first feedBudgetStart slots — the leftover after the pool
        // slice's guaranteed share — so the feed's fresh bonding-curve coins
        // cannot flood the list before any pool coin is logged.
        if (
          logBudget &&
          pi < logBudget.poolStartIdx &&
          rejects.length >= logBudget.feedBudgetStart
        )
          return;
        rejects.push({
          symbol: pair.baseToken.symbol || profile.symbol || "?",
          ageMin: Math.round(ageMs / 60_000),
          mcapUsd: Math.round(pair.marketCap),
          vol5Usd: Math.round(pair.volume.m5),
          chgPct: Math.round(pair.priceChange.m5 * 10) / 10,
          reason,
        });
      };`,
  `      const reject = (reason: string) => {
        if (rejects.length >= REJECT_LOG_MAX) return;
        // Pool coins always log (up to the cap); feed coins may occupy only
        // the first feedBudgetStart slots — the leftover after the pool
        // slice's guaranteed share — so the feed's fresh bonding-curve coins
        // cannot flood the list before any pool coin is logged.
        //
        // AN OWED COIN ALWAYS LOGS TOO (2026-09-27), for the same reason plus
        // one of its own: the make-up lane appends the deferred tokens to the
        // END of the feed list (src/dexscreener.ts), which is exactly the
        // region the budget cuts. Measured live that day: one obligation held
        // for 95 minutes with \`deferObserved 1\` every tick, \`seen_tokens\` and
        // \`push_audit\` empty (never claimed, never delivered) and NO way to
        // say which gate was refusing it — the debt was healthy, the reading
        // was blind. A debt is also bounded by the make-up lane itself
        // (DEFERRED_MAKEUP_MAX coins injected per tick), so the worst case
        // here is 8 slots out of REJECT_LOG_MAX.
        if (
          logBudget &&
          !owed &&
          pi < logBudget.poolStartIdx &&
          rejects.length >= logBudget.feedBudgetStart
        )
          return;
        rejects.push({
          symbol: pair.baseToken.symbol || profile.symbol || "?",
          ageMin: Math.round(ageMs / 60_000),
          mcapUsd: Math.round(pair.marketCap),
          vol5Usd: Math.round(pair.volume.m5),
          chgPct: Math.round(pair.priceChange.m5 * 10) / 10,
          reason,
          ...(owed ? { owed: true } : {}),
        });
      };`,
);

// (D) The budget's own doc comment names the third class.
patch(
  "logBudget doc",
  `     * Reject-log budget split (see rejectBudgetBeforeEval at the call site):
     * \`poolStartIdx\` marks where the pool slice begins inside \`profiles\`, and
     * feed coins may log only into the first \`feedBudgetStart\` slots (the
     * leftover after the pool's guaranteed share) — otherwise the feed's
     * fresh bonding-curve coins (all "流动性 ~$0") flood the bounded list
     * before any pool coin is logged and zero-push stretches look
     * unexplained on /health.`,
  `     * Reject-log budget split (see rejectBudgetBeforeEval at the call site):
     * \`poolStartIdx\` marks where the pool slice begins inside \`profiles\`, and
     * feed coins may log only into the first \`feedBudgetStart\` slots (the
     * leftover after the pool's guaranteed share) — otherwise the feed's
     * fresh bonding-curve coins (all "流动性 ~$0") flood the bounded list
     * before any pool coin is logged and zero-push stretches look
     * unexplained on /health.
     *
     * Three classes, not two (2026-09-27): pool coins and OWED coins always
     * log; only the feed's own discoveries are budgeted. An owed coin carries
     * \`owed: true\` so the reason it is still owed is readable at a glance
     * instead of only inferable from the counters.`,
);

// (E) The budget comment's number had drifted from the constant.
patch(
  "REJECT_LOG_MAX number",
  `      // REJECT_LOG_MAX (50) is smaller than feed+slice (~90+ coins/tick), so`,
  `      // REJECT_LOG_MAX (20) is smaller than feed+slice (~90+ coins/tick), so`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
