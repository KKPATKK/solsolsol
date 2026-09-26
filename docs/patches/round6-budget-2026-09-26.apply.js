#!/usr/bin/env node
/*
 * Round 6 — the two live readings of 2026-09-26T21:40Z:
 *
 *   ① `profiles: 2` on 52 of the last 120 ticks (43%), each one a DexScreener
 *      429 on the shared egress IP. The client already serves its last good
 *      list on a failed fetch (PROFILE_FEED_REUSE_MS), but that list lived in
 *      instance state and the isolate is recycled every tick, so the lane only
 *      ever helped a warm tick. This makes it durable — seeded from the front
 *      READ, journaled on the front WRITE, zero new round trips.
 *
 *   ② `rows 8/30 … subreq-cut 22 defer-send 22`: 22 alerting rows refused
 *      every pass while their rows aged in hours (oldest 126 minutes). The
 *      scan held back 9 subrequests for the pass, which pays for the door and
 *      the tail but not for a card; and the pass's own maintenance (heal,
 *      baseline repair) spent its first trips before the rotation.
 *
 * Verify-then-write: every anchor is asserted to occur exactly once (or to be
 * already applied), and a file with a failing anchor is NOT written.
 *
 * Run: node docs/patches/round6-budget-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
/** Join lines — keeps the TS blocks readable without template-literal traps. */
const j = (...lines) => lines.join("\n");

let failures = 0;

function patch(file, edits) {
  const p = path.join(root, file);
  const src = fs.readFileSync(p, "utf8");
  let out = src;
  let touched = 0;
  let fileFailed = 0;
  for (const e of edits) {
    const count = out.split(e.old).length - 1;
    if (count === 0 && e.marker !== undefined && out.includes(e.marker)) {
      console.log(`= ${file}: ${e.name} (already applied)`);
      continue;
    }
    if (count !== 1) {
      console.error(
        `✗ ${file}: ${e.name} — anchor found ${count} times (need exactly 1)`,
      );
      failures += 1;
      fileFailed += 1;
      continue;
    }
    out = out.replace(e.old, e.new);
    touched += 1;
    console.log(`✓ ${file}: ${e.name}`);
  }
  if (fileFailed > 0) {
    console.error(`✗ ${file}: NOT written (${fileFailed} anchor(s) failed)`);
    return;
  }
  if (touched > 0) {
    fs.writeFileSync(p, out);
    console.log(`→ ${file} written`);
  }
}

// ---------------------------------------------------------------- scanner.ts
patch("src/scanner.ts", [
  {
    name: "profile-feed journal stamp field",
    old: j("  private scanFront: ScanFront | null = null;", ""),
    marker: "private profileFeedStampedAt",
    new: j(
      "  private scanFront: ScanFront | null = null;",
      "  /**",
      "   * The `at` stamp of the last-good profile list this tick already put in the",
      "   * durable journal (see DEX_PROFILES_LAST_KEY /",
      "   * DexScreenerClient.lastGoodProfilesSnapshot). Seeded from the front read,",
      "   * so a REUSED list — which carries the stamp the row already has — never",
      "   * re-writes itself, and only a fetch that actually produced a newer list",
      "   * does.",
      "   */",
      "  private profileFeedStampedAt: number | null = null;",
      "",
    ),
  },
  {
    name: "seed the reuse lane from the front read",
    old: j(
      "      const front = await this.db.readScanFront(SCAN_FRONT_GATE_KEYS);",
      "      this.scanFront = front;",
      "      const chats = front.chats;",
    ),
    marker: "seedLastGoodProfiles(",
    new: j(
      "      const front = await this.db.readScanFront(SCAN_FRONT_GATE_KEYS);",
      "      this.scanFront = front;",
      "      // The last-good profile list rides that same read (see",
      "      // DEX_PROFILES_LAST_KEY): seeding it HERE is what lets a 429 tick reuse",
      "      // a minutes-old list instead of the make-up coins alone, and this is the",
      "      // earliest point in the tick that already has the row in hand. The stamp",
      "      // is kept beside the seed so a reused list never re-writes itself.",
      "      this.dex.seedLastGoodProfiles(",
      "        parseProfileFeedSnapshot(front.gates.get(DEX_PROFILES_LAST_KEY) ?? null),",
      "      );",
      "      this.profileFeedStampedAt = this.dex.lastGoodProfilesSnapshot()?.at ?? null;",
      "      const chats = front.chats;",
    ),
  },
  {
    name: "journal the list next to the ledger journal",
    old: j(
      "      await this.stampListCacheDelta();",
      "      // ...and the front's ONE write (see Db.writeScanFront): the launch_ms",
    ),
    marker: "stampProfileFeedSnapshot();",
    new: j(
      "      await this.stampListCacheDelta();",
      "      // The list the NEXT 429 tick falls back on, journaled beside it (see",
      "      // DEX_PROFILES_LAST_KEY): a REPLACE, and only when this tick's fetch",
      "      // produced a list newer than the one the front read carried.",
      "      await this.stampProfileFeedSnapshot();",
      "      // ...and the front's ONE write (see Db.writeScanFront): the launch_ms",
    ),
  },
  {
    name: "stampProfileFeedSnapshot method",
    old: j(
      "  /**",
      "   * Why the last runOnce returned without a summary (early-return reason),",
    ),
    marker: "async stampProfileFeedSnapshot()",
    new: j(
      "  /**",
      "   * Journal the last-good PROFILE LIST (see DEX_PROFILES_LAST_KEY), so the",
      "   * reuse lane survives the isolate that fetched it: the tick that reads it",
      "   * back is usually a different isolate, and the 429 ring runs at 17-20 an",
      "   * hour. A REPLACE, not an accumulator — the row is a snapshot — and the",
      "   * write only goes out when this tick's list is NEWER than the stamp the",
      "   * front read carried, so a reused list does not re-write itself.",
      "   *",
      "   * Best-effort like the ledger journal: a failed write is superseded by the",
      "   * next successful fetch, and telemetry may never break the scan.",
      "   */",
      "  async stampProfileFeedSnapshot(): Promise<void> {",
      "    const snap = this.dex.lastGoodProfilesSnapshot();",
      "    if (snap === null || snap.at === this.profileFeedStampedAt) return;",
      "    try {",
      "      await this.stampFront(DEX_PROFILES_LAST_KEY, JSON.stringify(snap), false);",
      "      this.profileFeedStampedAt = snap.at;",
      "    } catch (err) {",
      '      console.warn("[scanner] profile-feed snapshot write failed:", err);',
      "    }",
      "  }",
      "",
      "  /**",
      "   * Why the last runOnce returned without a summary (early-return reason),",
    ),
  },
]);

// ----------------------------------------------------------------- worker.ts
patch("src/worker.ts", [
  {
    name: "the tracker slice now funds one card",
    old: j(
      " * THE NUMBER is the pass's own arithmetic (pushwatch.TRACKER_SUBREQ_FLOOR 3",
      " * entry + TRACKER_SUBREQ_RESERVE 6 tail writes = 9), so this names exactly",
      " * what the pass needs to be worth starting rather than a round number.",
      " * `scanSubreqLeft` applies it; the scan's other gating is unchanged.",
      " */",
      "export const TRACKER_PASS_SUBREQ_RESERVE = 9;",
    ),
    marker: "TRACKER_PASS_SUBREQ_RESERVE = 13;",
    new: j(
      " * THE NUMBER is the pass's own arithmetic, and the first version of it was",
      " * short by exactly one CARD: entry (pushwatch.TRACKER_SUBREQ_FLOOR 3) + the",
      " * tail's writes (pushwatch.TRACKER_SUBREQ_RESERVE 6) = 9 lets a pass start",
      " * and close cleanly while every alerting row behind it is refused — live",
      " * 2026-09-26T21:39Z, two consecutive passes read `rows 8/30 … subreq-cut 22",
      " * defer-send 22` while the rotation aged in hours (the oldest row 126",
      " * minutes). One alerting row's path (claim + reservation + send + final",
      " * write, see pushwatch.TRACKER_ALERT_PATH_SUBREQ) is 4 more, so the slice",
      " * is 13: what the pass needs to be worth starting IS a delivered card, not",
      " * just a closed ledger. `scanSubreqLeft` applies it; the scan's other",
      " * gating is unchanged.",
      " */",
      "export const TRACKER_PASS_SUBREQ_RESERVE = 13;",
    ),
  },
]);

// -------------------------------------------------------------- pushwatch.ts
patch("src/pushwatch.ts", [
  {
    name: "alert-path and maintenance-floor constants",
    old: j("const TRACKER_SUBREQ_FLOOR = 3;", "const TRACKER_SUBREQ_RESERVE = 6;"),
    marker: "const TRACKER_MAINTENANCE_SUBREQ_FLOOR =",
    new: j(
      "const TRACKER_SUBREQ_FLOOR = 3;",
      "const TRACKER_SUBREQ_RESERVE = 6;",
      "/**",
      " * What ONE alerting row's path spends, and why it is a named number: the",
      " * claim CAS, the reservation, the Telegram send and the row's final write.",
      " * The maintenance floor below is derived from it (and so is",
      " * worker.TRACKER_PASS_SUBREQ_RESERVE), because \"the pass fits\" has to mean",
      " * \"a card fits\", not \"the gates close cleanly\".",
      " */",
      "const TRACKER_ALERT_PATH_SUBREQ = 4;",
      "/**",
      " * The ceiling the pass's MAINTENANCE stages (the heal, the baseline repair)",
      " * yield to BEFORE they may start (2026-09-26, live).",
      " *",
      " * WHY: the pass runs LAST and shares the invocation's 50 subrequests with",
      " * the scan, so the first trips it spends are trips the row loop cannot have.",
      " * Live 2026-09-26T21:39Z: two consecutive passes read `rows 8/30 … subreq-cut",
      " * 22 defer-send 22` — 22 alerting rows refused at the reserve gate after the",
      " * heal and the repair had taken their trips. The costs are not symmetric: a",
      " * refused ALERT is re-derived next tick but its row ages in HOURS (the",
      " * oldest read 126 minutes), while the heal is a backstop whose work the same",
      " * listing re-offers on the next pass. So the rotation is funded first and",
      " * maintenance yields — by NAME, in the coverage note (`heal-yield`), never",
      " * silently.",
      " *",
      " * The number: the tail reserve (TRACKER_SUBREQ_RESERVE) plus ONE alerting",
      " * row's path (TRACKER_ALERT_PATH_SUBREQ) — below it, spending the heal would",
      " * cost the rotation the card the pass exists for.",
      " */",
      "const TRACKER_MAINTENANCE_SUBREQ_FLOOR =",
      "  TRACKER_SUBREQ_RESERVE + TRACKER_ALERT_PATH_SUBREQ;",
    ),
  },
  {
    name: "healYield flag",
    old: "    let healSkipped = false;",
    marker: "let healYield = false;",
    new: j(
      "    let healSkipped = false;",
      "    /**",
      "     * The heal stood down for the ROTATION's slice (see",
      "     * TRACKER_MAINTENANCE_SUBREQ_FLOOR), not for its own clock. Named apart",
      "     * from healSkipped so the note says which ceiling moved it.",
      "     */",
      "    let healYield = false;",
    ),
  },
  {
    name: "heal yields to the rotation before it reads",
    old: "    if (healDeadline - healStart < TRACKER_HEAL_MIN_MS) healSkipped = true;",
    marker: "healYield = true;",
    new: j(
      "    if (healDeadline - healStart < TRACKER_HEAL_MIN_MS) healSkipped = true;",
      "    // The second ceiling (see TRACKER_MAINTENANCE_SUBREQ_FLOOR): when the",
      "    // invocation cannot afford the heal AND an alerting row, the card wins.",
      "    if (subreqsLeft() <= TRACKER_MAINTENANCE_SUBREQ_FLOOR) healYield = true;",
    ),
  },
  {
    name: "heal read guarded by the floor",
    old: "      if (!healSkipped) {",
    marker: "if (!healSkipped && !healYield)",
    new: "      if (!healSkipped && !healYield) {",
  },
  {
    name: "heal's own work (proof reads, resends) guarded too",
    old: "      if (missing.length > 0) {",
    marker: "missing.length > 0 && subreqsLeft()",
    new: "      if (missing.length > 0 && subreqsLeft() > TRACKER_MAINTENANCE_SUBREQ_FLOOR) {",
  },
  {
    name: "the note names the yield",
    old: j('      ` heal${healSkipped ? "-skipped" : healCut ? "-cut" : ""}` +'),
    marker: '"heal-yield"',
    new: j(
      "      ` heal${",
      '        healYield ? "-yield" : healSkipped ? "-skipped" : healCut ? "-cut" : ""',
      "      }` +",
    ),
  },
  {
    name: "baseline repair yields to the rotation",
    old: j("    if (needsBaselineRepair) {", "      baselineRepairDone = true;"),
    marker: "needsBaselineRepair && subreqsLeft()",
    new: j(
      "    // Same ceiling as the heal's (see TRACKER_MAINTENANCE_SUBREQ_FLOOR): a",
      "    // repair the invocation cannot afford is left UNATTEMPTED, so both of its",
      "    // triggers stay true (the one-shot flag is only set when the statement",
      "    // actually goes out) and the next pass retries it.",
      "    if (needsBaselineRepair && subreqsLeft() > TRACKER_MAINTENANCE_SUBREQ_FLOOR) {",
      "      baselineRepairDone = true;",
    ),
  },
]);

if (failures > 0) {
  console.error(`\n${failures} edit(s) failed — see the lines above.`);
  process.exit(1);
}
console.log("\nround 6 applied.");
