/*
 * Fix-up for tier2-feeds-2026-09-28.apply.js: the boosts doc edit's anchor had
 * the wrong line wrap, so only that note was missing (the other four edits
 * landed). Same note, correct anchor.
 *
 * Idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const configPath = path.join(__dirname, "..", "..", "src", "config.ts");
let src = fs.readFileSync(configPath, "utf8");

const FROM = `   * same minute, same host so no new rate-limit bucket). Rows carry no metrics
   * and no timestamps — the age comes from the pair the next batch fetches.
   */
  dexscreenerBoostsLimit: number;`;
const TO = `   * same minute, same host so no new rate-limit bucket). Rows carry no metrics
   * and no timestamps — the age comes from the pair the next batch fetches.
   *
   * 2026-09-28: production runs the upstream's own ceiling
   * (DEXSCREENER_BOOSTS_LIMIT = "30" in wrangler.toml). /token-boosts/latest/v1
   * answers 30 rows, so the previous 20 discarded 10 paid-promotion rows per
   * tick — same host, same single request. The clamp below (30) IS that
   * ceiling: a bigger number is a typo, not a request for more.
   */
  dexscreenerBoostsLimit: number;`;

if (src.includes("production runs the upstream's own ceiling")) {
  console.log("= already applied");
  process.exit(0);
}
const n = src.split(FROM).length - 1;
if (n !== 1) {
  console.log(`✗ anchor found ${n} times`);
  process.exit(1);
}
src = src.replace(FROM, () => TO);
fs.writeFileSync(configPath, src);
console.log("✓ config: the boosts doc records the deployed value");
