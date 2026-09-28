/**
 * Revision 4: finishes what rev3 claimed.
 *
 * rev3's first and fourth swaps used the text THEY WERE REMOVING as their
 * "already applied" marker, so both reported success and did nothing: the
 * closure kept its re-arm (the copy that can discard a delivery — the flaw the
 * unit suite found) and `MIN` was never defined. This script does both edits
 * with explicit, unambiguous logic and verifies the result before writing.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SCANNER = path.join(ROOT, "src", "scanner.ts");
const TESTS = path.join(ROOT, "scripts", "test-unit.js");
let ok = true;

// --- 1. remove the CLOSURE copy, keep the .then copy ----------------------
const CALL = "              const geckoRetryAt = await this.rearmGeckoDiscovery(Date.now());\n";
const GUARD = "              if (geckoRetryAt !== null) diag.geoRetryAt = geckoRetryAt;\n";
{
  let src = fs.readFileSync(SCANNER, "utf8");
  const first = src.indexOf(CALL);
  const second = first === -1 ? -1 : src.indexOf(CALL, first + 1);
  if (first === -1) {
    console.log("✗ 1/2 scanner: the re-arm call is gone entirely");
    ok = false;
  } else if (second === -1) {
    console.log("= 1/2 scanner: only the delivery-handler copy remains (already applied)");
  } else {
    // Walk back over the contiguous comment lines that introduce it.
    let start = first;
    for (;;) {
      const prevEnd = start - 1; // the newline before `start`
      const prevStart = src.lastIndexOf("\n", prevEnd - 1) + 1;
      const line = src.slice(prevStart, prevEnd);
      if (!line.trim().startsWith("//")) break;
      start = prevStart;
    }
    // The guard that belongs to the FIRST (closure) copy, not the later one:
    // searching from `second` would swallow the whole delivery handler.
    const end = src.indexOf(GUARD, first) + GUARD.length;
    if (end <= GUARD.length) {
      console.log("✗ 1/2 scanner: could not locate the guard line");
      ok = false;
    } else {
      const before = src.slice(0, start);
      const after = src.slice(end);
      const next = before + after;
      if (next.split(CALL).length - 1 !== 1) {
        console.log("✗ 1/2 scanner: expected exactly one re-arm call afterwards");
        ok = false;
      } else {
        fs.writeFileSync(SCANNER, next);
        console.log(`✓ 1/2 scanner: closure copy removed (${end - start} chars)`);
      }
    }
  }
}

// --- 2. define MIN in the stamp test --------------------------------------
{
  const src = fs.readFileSync(TESTS, "utf8");
  const anchor = "    const I = 5 * MIN; // GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS = 300";
  if (src.includes("    const MIN = 60_000;\n" + anchor)) {
    console.log("= 2/2 test: MIN defined (already applied)");
  } else if (!src.includes(anchor)) {
    console.log("✗ 2/2 test: the interval line was not found");
    ok = false;
  } else {
    fs.writeFileSync(TESTS, src.replace(anchor, "    const MIN = 60_000;\n" + anchor));
    console.log("✓ 2/2 test: MIN defined");
  }
}

if (!ok) process.exit(1);
console.log("\nrevision 4 applied");
