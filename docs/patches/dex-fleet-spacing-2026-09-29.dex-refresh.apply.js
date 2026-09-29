/*
 * Third anchored patch for the FLEET-WIDE DexScreener spacing row (2026-09-29):
 * refresh the summary's whole `dex` block after the adoption.
 *
 * WHY IT EXISTS. The page's `dex:` snapshot is built at the top of runOnce, and
 * the fleet row is adopted later — from the front read, which has to go after
 * that build. Writing only the two fleet fields into the existing snapshot left
 * a block whose halves came from different moments, and the live sample after
 * the deploy read exactly that shape: `spacingFleetSteps 3` next to
 * `intervalMs 250 / spacingSteps 0` on a tick that had just inherited three
 * raises. Both of those are true statements about different moments; together
 * they are a reading nobody can check, which is the one thing this row exists
 * to make possible.
 *
 * Run: node docs/patches/dex-fleet-spacing-2026-09-29.dex-refresh.apply.js
 */
const fs = require("fs");
const path = require("path");

function patch(rel, edits) {
  const file = path.join(__dirname, "..", "..", rel);
  let src = fs.readFileSync(file, "utf8");
  let applied = 0;
  let skipped = 0;
  for (const [label, anchor, replacement] of edits) {
    if (src.includes(replacement)) {
      skipped++;
      console.log(`  -- ${label} (already applied)`);
      continue;
    }
    if (!src.includes(anchor)) throw new Error(`[${label}] anchor not found`);
    src = src.split(anchor).join(replacement);
    applied++;
    console.log(`  ok ${label}`);
  }
  fs.writeFileSync(file, src);
  console.log(`${rel}: ${applied} applied, ${skipped} already present`);
}

patch("src/scanner.ts", [
  [
    "refresh the whole dex block after the adopt",
    `      if (diag.dex) {
        diag.dex.spacingFleetSteps = fleetSpacing.steps;
        diag.dex.spacingFleetAgeMs = fleetSpacing.ageMs;
      }`,
    `      // Refreshed WHOLE, not just the two fleet fields: the adoption moves
      // \`intervalMs\`/\`spacingSteps\` as well, and the page's \`dex:\` snapshot is
      // built above the front read — so writing the fleet reading into it alone
      // left a block whose halves came from different moments. The live sample
      // right after this shipped read \`spacingFleetSteps 3\` beside
      // \`intervalMs 250 / spacingSteps 0\` on a tick that had just inherited
      // three raises: both halves true, together uncheckable. getStats() is a
      // read of local state, so the refresh costs nothing.
      diag.dex = this.dex.getStats();`,
  ],
  [
    "drop the now-unused adopt return value",
    `      const fleetSpacing = this.dex.adoptDurableSpacing(
        front.gates.get(DEX_SPACING_STATE_KEY) ?? null,
      );`,
    `      // The return value is deliberately dropped: what the row carried is
      // published by the getStats() refresh just below, and a second copy of it
      // here is the drift this whole patch is about.
      this.dex.adoptDurableSpacing(front.gates.get(DEX_SPACING_STATE_KEY) ?? null);`,
  ],
  [
    "reword the dropped-return note",
    `      // here is the drift this whole patch is about.`,
    `      // here is the drift that refresh exists to prevent.`,
  ],
]);

patch("scripts/test-unit.js", [
  [
    "pin the whole-block refresh",
    `    assert.ok(
      scannerSrc.includes("diag.dex.spacingFleetSteps = fleetSpacing.steps"),
      "the fleet reading must be published, or a raise crossing an isolate is invisible",
    );
    assert.ok(scannerSrc.includes("diag.dex.spacingFleetAgeMs = fleetSpacing.ageMs"));`,
    `    // The WHOLE dex block is refreshed after the adoption, not just the two
    // fleet fields: the block is snapshotted above the front read, so a partial
    // write leaves a summary whose fleet reading disagrees with the live one
    // beside it (measured on the first live sample after this shipped:
    // \`spacingFleetSteps 3\` beside \`intervalMs 250 / spacingSteps 0\`).
    const refresh = scannerSrc.indexOf("diag.dex = this.dex.getStats();");
    assert.ok(refresh > adopt, "the dex block must be refreshed after the adoption");
    assert.equal(
      (scannerSrc.match(/diag\\.dex = this\\.dex\\.getStats\\(\\)/g) || []).length,
      1,
      "exactly one refresh site",
    );`,
  ],
]);
