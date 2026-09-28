/*
 * The Tier 2 boosts note claimed "+10 paid-promotion rows per tick". The
 * measurement refuted it: /token-boosts/latest/v1 answers 30 rows ACROSS
 * CHAINS and the client filters to Solana before slicing, so the Solana subset
 * (~17) was already under the old cap of 20 — `boosts 17` before and after.
 * The dial stays at the upstream ceiling because it costs nothing, but the
 * comment must not sell a gain that did not happen.
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const configPath = path.join(ROOT, "src", "config.ts");
const testPath = path.join(ROOT, "scripts", "test-unit.js");
const log = [];
let failed = 0;

function edit(name, file, from, to) {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(to) && !src.includes(from)) {
    log.push(["=", `${name} (already applied)`]);
    return;
  }
  const n = src.split(from).length - 1;
  if (n !== 1) {
    log.push(["✗", `${name} — anchor found ${n} times`]);
    failed += 1;
    return;
  }
  fs.writeFileSync(file, src.replace(from, () => to));
  log.push(["✓", name]);
}

edit(
  "config: the boosts note states what was MEASURED",
  configPath,
  `   * 2026-09-28: production runs the upstream's own ceiling
   * (DEXSCREENER_BOOSTS_LIMIT = "30" in wrangler.toml). /token-boosts/latest/v1
   * answers 30 rows, so the previous 20 discarded 10 paid-promotion rows per
   * tick — same host, same single request. The clamp below (30) IS that
   * ceiling: a bigger number is a typo, not a request for more.
   */`,
  `   * 2026-09-28: production runs the upstream's own ceiling
   * (DEXSCREENER_BOOSTS_LIMIT = "30" in wrangler.toml), and the measurement
   * that came with it is a NEGATIVE result worth keeping: this was raised from
   * 20 expecting +10 rows and the leg still reads 17. /token-boosts/latest/v1
   * answers 30 rows ACROSS CHAINS and the client filters to solana BEFORE it
   * slices, so the Solana subset — the only rows this feed can ever return —
   * was already under 20. The dial stays at the clamp because it costs the same
   * single request either way, but a future reader should not expect a gain
   * from it: the binding constraint here is how many Solana boosts exist, not
   * the number asked for. The clamp below (30) IS the upstream's row ceiling: a
   * bigger number is a typo, not a request for more.
   */`,
);

edit(
  "tests: the boosts pin reads as a negative result",
  testPath,
  `      // 7 — boosts: production runs the ceiling, because the request answers
      // 30 rows whatever we ask for.`,
  `      // 7 — boosts: production runs the upstream's ceiling (30 rows, the
      // clamp). MEASURED 2026-09-28: raising it from 20 changed nothing —
      // \`boosts 17\` before and after — because the upstream's 30 rows are
      // cross-chain and the client filters to solana before slicing, so the
      // Solana subset was already under 20. This pin holds the DEPLOYED value
      // honest; it is not evidence of a gain.`,
);

for (const [m, n] of log) console.log(`${m} ${n}`);
if (failed === 0) {
  const config = fs.readFileSync(configPath, "utf8");
  if (!config.includes("a NEGATIVE result worth keeping")) {
    console.log("✗ refused: the corrected note is not in place");
    process.exit(1);
  }
} else {
  console.log("✗ an anchor failed");
}
process.exit(failed === 0 ? 0 : 1);
