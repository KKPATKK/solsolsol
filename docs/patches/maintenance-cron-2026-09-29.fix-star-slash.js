/*
 * The cron expressions written inside `/** ... *\/` doc comments contain the
 * two-character sequence that TERMINATES a block comment, so the comment ended
 * early and the remainder was parsed as code (TS1228/TS1434 in worker.ts).
 * Comments now name the period instead of spelling the expression; the
 * expressions themselves stay, quoted, in the constants.
 *
 * Run: node docs/patches/maintenance-cron-2026-09-29.fix-star-slash.js
 */
const fs = require("fs");
const path = require("path");

const EDITS = [
  {
    file: "src/scanner.ts",
    from: ` * The trigger fires every 5 minutes (worker.MAINTENANCE_CRON, "*/5 * * * *"),`,
    to: ` * The trigger fires every 5 minutes (worker.MAINTENANCE_CRON, the
 * five-minute expression spelled in wrangler.toml),`,
  },
  {
    file: "src/worker.ts",
    from: " * WHY `*/5` AND NOT EVERY MINUTE: neither job wants a per-minute cadence (the",
    to: " * WHY A FIVE-MINUTE PERIOD AND NOT EVERY MINUTE: neither job wants a per-minute\n * cadence (the",
  },
];

for (const e of EDITS) {
  const file = path.join(__dirname, "..", "..", e.file);
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(e.to)) {
    console.log(`  -- ${e.file} (already fixed)`);
    continue;
  }
  if (!src.includes(e.from)) throw new Error(`[${e.file}] anchor not found`);
  src = src.replace(e.from, e.to);
  fs.writeFileSync(file, src);
  console.log(`  ok ${e.file}`);
}
