/**
 * Revision 2 of the B1 patch (see …-2026-09-28.apply.js), run AFTER it.
 *
 * WHAT IT CHANGES AND WHY: v1 asked the client "when could the next call reach
 * a USABLE host?", which treated a healthy alternate host as "not now" — and in
 * the live keyed configuration the alternate is an unpaused probe that 401s, so
 * v1 would have re-armed nothing and B1 would have been a no-op in production.
 * v2 keys the retry on the PRIMARY's pause alone and clamps it to the existing
 * interval, which is both simpler and the only version that cannot regress the
 * keyless path (its pause is the interval, so the clamp returns the cadence
 * unchanged).
 *
 * Idempotent and exact: each anchor is the literal text the first script wrote
 * (read from its own .txt block), so a second run prints "=" and never doubles.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const block = (name) =>
  fs.readFileSync(path.join(__dirname, `gecko-429-retry-2026-09-28.${name}.txt`), "utf8");

let ok = true;

function swap(file, label, marker, oldText, newText) {
  const target = path.join(ROOT, file);
  let src = fs.readFileSync(target, "utf8");
  if (src.includes(marker)) {
    console.log(`= ${label} (already revised)`);
    return;
  }
  if (!src.includes(oldText)) {
    console.log(`✗ ${label}: v1 anchor not found`);
    ok = false;
    return;
  }
  fs.writeFileSync(target, src.replace(oldText, newText));
  console.log(`✓ ${label}`);
}

swap(
  "src/scanner.ts",
  "1/3 helper: pause-end rule with the interval clamp",
  "  const retryAt = Math.min(pauseEndMs, nowMs + intervalMs);",
  block("a"),
  block("a2"),
);

swap(
  "src/scanner.ts",
  "2/3 method: read pauseEndsAt, return the aimed epoch",
  "const pauseEnd = this.gecko.pauseEndsAt(now);",
  block("c"),
  block("c2"),
);

swap(
  "src/geckoterminal.ts",
  "3/3 client: nextUsableAt -> pauseEndsAt",
  "pauseEndsAt(now = Date.now()): number {",
  block("e"),
  block("f"),
);

if (!ok) process.exit(1);
console.log("\nrevision 2 applied");
