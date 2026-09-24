#!/usr/bin/env node
/**
 * Zero-mcap push-watch baseline guard (2026-09-24).
 *
 * WHY: `push_watch.mcap_at_push` has three writers (see src/pushledger.ts). Two
 * of them are the push itself and the ledger; the third is the tracker's
 * self-heal enrollment, which seeds a coin that was never enrolled at push
 * time (its isolate died between push and enroll). That fallback is the pair's
 * CURRENT market cap — `known?.mcapAtPush ?? pair.marketCap` — and a pair the
 * source carries no price for reports `marketCap: 0`. A 0 baseline is not a
 * missing value, it is a POISONED one: it renders as "推送 $0" on the recap,
 * `chgSincePush` divides against `max(mcapAtPush, 1)`, and the dead-state
 * resurrection floor (`(deadTroughMcap ?? mcapAtPush) * 1.5`) collapses to 0,
 * so any positive reading "revives" the row.
 *
 * Measured live 2026-09-24 (/debug/push-watch): exactly TWO rows carried
 * `mcapAtPush 0` — 💲 (7RQBQ1wqfrsCrAPVdjEuMVTfJuoXAEDgz87XkuuX3y2A, peak
 * $221K) and 玉兔 (BtpekseAAyyaxRsr48JAjoa8BTBozjFNkBY6E9nv2d2V, peak $70.9K) —
 * both enrolled late by the heal (pushed ~03:35Z / ~04:26Z, first follow-up
 * ~09:14Z) after the push baseline had already been lost.
 *
 * WHAT: prefer a positive market cap, fall back to the FDV when that is all
 * the leg had (the substitution the dexscreener leg already records via
 * `mcapFromFdv`), and SKIP the enrollment when neither exists — a pair with no
 * valuation is untrackable, and it re-heals on a later pass once a reading
 * lands.
 *
 * An apply script because src/pushwatch.ts sits past the file-tool window; the
 * anchor must match exactly once or nothing is written.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const FILE = "src/pushwatch.ts";

const ANCHOR = lines(
  "          const known = findLedgerEntry(ledger, m.token);",
  "          const healedMcap = known?.mcapAtPush ?? pair.marketCap;",
  "",
);

const REPLACEMENT = lines(
  "          const known = findLedgerEntry(ledger, m.token);",
  "          // The fallback (a push older than the ledger) is the pair's CURRENT",
  "          // market cap, which is 0 for a pair the source carries no price for",
  "          // — and a 0 baseline poisons every derived number: the recap's",
  '          // "推送 $0", chgSincePush against max(0,1), and a dead-state',
  "          // resurrection floor of 0. Live 2026-09-24: exactly two rows (💲,",
  "          // 玉兔) carried mcap_at_push 0 this way. Prefer a positive market",
  "          // cap, fall back to the FDV when that is all the leg had (the same",
  "          // substitution the dexscreener leg records via `mcapFromFdv`), and",
  "          // SKIP this enrollment when neither exists — a pair with no",
  "          // valuation is untrackable, and it re-heals on a later pass once a",
  "          // reading lands.",
  "          const fallbackMcap =",
  "            Number.isFinite(pair.marketCap) && pair.marketCap > 0",
  "              ? pair.marketCap",
  "              : Number.isFinite(pair.fdvUsd) && (pair.fdvUsd ?? 0) > 0",
  "                ? (pair.fdvUsd as number)",
  "                : 0;",
  "          const healedMcap = known?.mcapAtPush ?? fallbackMcap;",
  "          if (healedMcap <= 0) continue;",
  "",
);

const text = fs.readFileSync(FILE, "utf8");
if (text.includes("fallbackMcap")) {
  console.error("ALREADY   the zero-mcap baseline guard is applied");
  process.exit(1);
}
const at = text.indexOf(ANCHOR);
if (at < 0) {
  console.error(`MISS      ${FILE}: healedMcap baseline anchor`);
  process.exit(1);
}
if (text.indexOf(ANCHOR, at + 1) >= 0) {
  console.error(`AMBIGUOUS ${FILE}: healedMcap baseline anchor`);
  process.exit(1);
}
fs.writeFileSync(FILE, text.replace(ANCHOR, REPLACEMENT));
console.log(`ok        ${FILE}: zero-mcap baseline guard applied`);
