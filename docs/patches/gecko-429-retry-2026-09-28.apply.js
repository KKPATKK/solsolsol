/**
 * Idempotent, marker-guarded patcher for src/scanner.ts — B1 (a refused gecko
 * fetch re-arms the durable discovery gate to the host's own pause instead of
 * costing a whole interval). Written as an apply script because this repo's
 * file-sync snapshots are stale for src/scanner.ts: str_replace reports "not
 * found" for anchors sed shows verbatim.
 *
 * Anchors are asserted UNIQUE before any write, each edit is guarded by its own
 * marker so a second run is a no-op, and the inserted blocks live in .txt files
 * (read literally) so no regex escapes or backticks ever pass through a JS
 * template literal — the corruption this repo already hit once.
 *
 * Usage: node docs/patches/gecko-429-retry-2026-09-28.apply.js
 * Prints ✓ (applied) / = (already present) / ✗ (anchor missing) and exits 1 if
 * any edit failed.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const TARGET = path.join(ROOT, "src", "scanner.ts");
const block = (name) =>
  fs.readFileSync(path.join(__dirname, `gecko-429-retry-2026-09-28.${name}.txt`), "utf8");

let src = fs.readFileSync(TARGET, "utf8");
const original = src;

/** Assert `needle` occurs exactly `n` times, else fail loudly. */
function unique(needle, n = 1) {
  const found = src.split(needle).length - 1;
  if (found !== n) {
    throw new Error(
      `anchor occurs ${found}x (expected ${n}): ${JSON.stringify(needle.slice(0, 60))}`,
    );
  }
}

let ok = true;
function edit(label, marker, anchor, build) {
  if (src.includes(marker)) {
    console.log(`= ${label} (already applied)`);
    return;
  }
  try {
    unique(anchor);
  } catch (err) {
    console.log(`✗ ${label}: ${err.message}`);
    ok = false;
    return;
  }
  src = src.replace(anchor, build(anchor));
  console.log(`✓ ${label}`);
}

// --- 1. the pure retry-stamp helper, after geckoDiscoveryDue --------------
edit(
  "1/4 geckoDiscoveryRetryStamp helper",
  "export function geckoDiscoveryRetryStamp(",
  "  const age = nowMs - lastAttemptMs;\n  if (age < 0) return true;\n  return age >= intervalMs;\n}\n",
  (a) => a + "\n" + block("a"),
);

// --- 2. the ScanSummary field, after geoDue -------------------------------
edit(
  "2/4 ScanSummary.geoRetryAt",
  "  geoRetryAt?: number;",
  "  geoDue?: boolean;\n",
  (a) => a + block("b"),
);

// --- 3. the re-arm method, after stampFront's tail ------------------------
edit(
  "3/4 Scanner.rearmGeckoDiscovery",
  "private async rearmGeckoDiscovery(",
  "    await this.db.setWorkerState(key, value);\n  }\n",
  (a) => a + block("c"),
);

// --- 4. the call site inside the gecko closure ----------------------------
edit(
  "4/4 call site: re-arm after the page loop",
  "await this.rearmGeckoDiscovery(Date.now());",
  "                if (got.length === 0) break;\n              }\n",
  (a) => a + block("d"),
);

if (!ok) {
  console.error("\nFAILED — src/scanner.ts left untouched.");
  process.exit(1);
}
if (src === original) {
  console.log("\nno change (all edits already present)");
} else {
  fs.writeFileSync(TARGET, src);
  console.log("\nsrc/scanner.ts written");
}
