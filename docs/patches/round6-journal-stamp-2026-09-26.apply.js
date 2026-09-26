#!/usr/bin/env node
/*
 * Round 6 follow-up: the journal stamp is the ROW's, never the client's list.
 *
 * WHY (live, 2026-09-26T22:44-22:50Z): the profiles fetch is dispatched ABOVE
 * the front read (see profilesCall), so a fast answer — an edge-cache HIT, and
 * any 200 that beats Turso's ~100ms round trip — has already written
 * DexScreenerClient.lastGoodProfiles by the time the front read returns.
 * Deriving `profileFeedStampedAt` from the CLIENT therefore stamped this tick's
 * own fresh list, and `stampProfileFeedSnapshot` skipped the write as if the
 * row already carried it. Measured: four successful ticks and nine minutes
 * after the deploy — with the scan rows reading `profiles 28` and
 * `dex_list_cache_last: HIT` — `dex_profiles_last` was still absent, i.e. the
 * last-good list crossed no isolate boundary and the ~43% of ticks whose fetch
 * is refused still fell back to the make-up lane alone.
 *
 * From the ROW the rule holds on both sides of that race: an absent row
 * journals, and a list this tick merely REUSES (seeded, same stamp) is skipped
 * by stamp instead of re-written.
 *
 * Run: node docs/patches/round6-journal-stamp-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(p, "utf8");

/** One verify-then-write replacement: exactly one anchor, or nothing at all. */
const apply = (label, old, next, marker) => {
  if (src.includes(marker)) {
    console.log(`= scanner.ts: ${label} already applied`);
    return;
  }
  const count = src.split(old).length - 1;
  if (count !== 1) {
    console.error(`✗ scanner.ts: ${label} anchor found ${count} times (need exactly 1)`);
    process.exit(1);
  }
  src = src.replace(old, next);
  console.log(`✓ scanner.ts: ${label} patched`);
};

// ---- 1. the field's own contract ------------------------------------------
apply(
  "profileFeedStampedAt doc",
  j(
    "  /**",
    "   * The `at` stamp of the last-good profile list this tick already put in the",
    "   * durable journal (see DEX_PROFILES_LAST_KEY /",
    "   * DexScreenerClient.lastGoodProfilesSnapshot). Seeded from the front read,",
    "   * so a REUSED list — which carries the stamp the row already has — never",
    "   * re-writes itself, and only a fetch that actually produced a newer list",
    "   * does.",
    "   */",
  ),
  j(
    "  /**",
    "   * The `at` stamp the durable journal already carries for the last-good",
    "   * profile list (see DEX_PROFILES_LAST_KEY /",
    "   * DexScreenerClient.lastGoodProfilesSnapshot). A REUSED list keeps that same",
    "   * stamp, so it never re-writes itself, while a fetch that produced a newer",
    "   * list does. It is the ROW's stamp, never the client's live list: the",
    "   * profiles fetch is dispatched BEFORE the front read that carries the row, so",
    "   * a fast answer — an edge-cache HIT, and every 200 that beats Turso's ~100ms",
    "   * — is already in the client here, and reading the stamp off it marked this",
    "   * tick's own fresh list as journaled (see the seed's call site).",
    "   */",
  ),
  "It is the ROW's stamp, never the client's live list",
);

// ---- 2. the seed's stamp ---------------------------------------------------
apply(
  "seed derives the stamp from the row",
  j(
    "      this.dex.seedLastGoodProfiles(",
    "        parseProfileFeedSnapshot(front.gates.get(DEX_PROFILES_LAST_KEY) ?? null),",
    "      );",
    "      this.profileFeedStampedAt = this.dex.lastGoodProfilesSnapshot()?.at ?? null;",
  ),
  j(
    "      // The stamp comes from the ROW, never from the client's live list (live",
    "      // bug, 2026-09-26T22:44-22:50Z): because the profiles fetch is dispatched",
    "      // above this read, a fetch that answers EARLY has already written",
    "      // lastGoodProfiles by the time this line runs, so taking the stamp from",
    "      // the client looked exactly like \"this list is already journaled\" and",
    "      // stampProfileFeedSnapshot skipped the write. Four successful ticks and",
    "      // nine minutes after the deploy, `dex_profiles_last` was still absent",
    "      // while the scan rows read `profiles 28` — the list crossed no isolate",
    "      // boundary, so the ~43% of ticks whose fetch is refused kept falling back",
    "      // to the make-up lane alone. From the ROW the rule holds on both sides of",
    "      // the race: an absent row journals, and a row this tick merely reuses is",
    "      // skipped by stamp instead of re-written.",
    "      const profileFeedRow = parseProfileFeedSnapshot(",
    "        front.gates.get(DEX_PROFILES_LAST_KEY) ?? null,",
    "      );",
    "      this.dex.seedLastGoodProfiles(profileFeedRow);",
    "      this.profileFeedStampedAt = profileFeedRow?.at ?? null;",
  ),
  "this.profileFeedStampedAt = profileFeedRow?.at ?? null",
);

fs.writeFileSync(p, src);
console.log("node docs/patches/round6-journal-stamp-2026-09-26.apply.js — done");
