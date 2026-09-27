// Verify-then-write: pins for the owed-reject rule (scripts/test-unit.js).
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

// (A) The old pin asserted the un-hoisted `if (isDeferredToken(...))` shape; the
// owed reading is now a const so the verdict and the log budget share it.
patch(
  "hoist pin",
  `        hookAt >= 0 &&
        skipAt > hookAt &&
        scannerSrc.includes("if(isDeferredToken(profile.tokenAddress)){"),
      "scanner (the ledger and the summary carry the cursor)":`,
  `        hookAt >= 0 &&
        skipAt > hookAt &&
        // 2026-09-27: the owed reading became a const so the make-up verdict
        // and the reject-log budget cannot disagree about it — and it is read
        // ONCE (the count below).
        scannerSrc.includes("constowed=isDeferredToken(profile.tokenAddress);") &&
        scannerSrc.includes("if(owed){") &&
        count(scannerSrc, "isDeferredToken(profile.tokenAddress)") === 1,
      "scanner (the ledger and the summary carry the cursor)":`,
);

// (B) The new rule's own pin: an owed coin always logs, is marked, and is
// reserved a share of the cap.
patch(
  "owed-reject pin",
  `      "scanner (the ledger and the summary carry the cursor)":`,
  `      "scanner (an owed coin's blocking gate always logs, with a reserved slot)":
        // The exemption that makes the log reachable for the make-up lane's
        // coins (its entries ride the END of the feed list)…
        scannerSrc.includes(
          "if(logBudget&&!owed&&pi<logBudget.poolStartIdx&&rejects.length>=logBudget.feedBudgetStart)return;",
        ) &&
        // …the marker that makes the entry self-explanatory…
        scannerSrc.includes("...(owed?{owed:true}:{}),") &&
        // …and the reserve, without which the hard cap cuts it anyway.
        scannerSrc.includes(
          "constpoolShare=Math.min(poolSlice.length,REJECT_LOG_MAX);",
        ) &&
        scannerSrc.includes(
          "constowedShare=Math.max(0,Math.min(DEFERRED_MAKEUP_MAX,this.deferredPushes.pendingCount,REJECT_LOG_MAX-poolShare,),);",
        ) &&
        scannerSrc.includes(
          "constrejectBudgetBeforeEval=REJECT_LOG_MAX-poolShare-owedShare;",
        ),
      "scanner (the ledger and the summary carry the cursor)":`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
