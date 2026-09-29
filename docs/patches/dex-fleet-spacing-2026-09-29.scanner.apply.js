/*
 * Anchored patch for the FLEET-WIDE DexScreener spacing row (2026-09-29) — the
 * scanner.ts half. Same reason as the maintenance-cron script beside it:
 * `str_replace` silently fails to match on this file, so the edits are anchored
 * here instead. Every edit is guarded: a replacement already present is
 * skipped, a missing anchor throws, so re-running the script is safe and a
 * partial application can never pass silently.
 *
 * The other half lives in src/dexscreener.ts (the row's key, its parse/decay
 * helpers and the client's adopt/write pair) and src/db.ts (the key joins
 * SCAN_FRONT_GATE_KEYS); both are plain edits there.
 *
 * Run: node docs/patches/dex-fleet-spacing-2026-09-29.scanner.apply.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(FILE, "utf8");

let applied = 0;
let skipped = 0;
function edit(label, anchor, replacement) {
  if (src.includes(replacement)) {
    skipped++;
    console.log(`  -- ${label} (already applied)`);
    return;
  }
  if (!src.includes(anchor)) throw new Error(`[${label}] anchor not found`);
  src = src.split(anchor).join(replacement);
  applied++;
  console.log(`  ok ${label}`);
}

edit(
  "import DEX_SPACING_STATE_KEY",
  `  DEX_LIST_CACHE_MISSES_KEY,
  type PairInfo,`,
  `  DEX_LIST_CACHE_MISSES_KEY,
  DEX_SPACING_STATE_KEY,
  type PairInfo,`,
);

edit(
  "ScanSummary.dex fleet fields",
  `    /** Raises in force since the last full recovery — 0 = running at base. */
    spacingSteps: number;
    http429: number;`,
  `    /** Raises in force since the last full recovery — 0 = running at base. */
    spacingSteps: number;
    /** The FLEET spacing row as this tick read it, after decay (see
     * DEX_SPACING_STATE_KEY). 0 with a null age means there was no row at all,
     * so the raises in \`spacingSteps\` are this isolate's own; a non-zero
     * value here is a raise that crossed an isolate boundary. */
    spacingFleetSteps: number;
    /** Age of that row when it was read, or null when there was none. */
    spacingFleetAgeMs: number | null;
    http429: number;`,
);

edit(
  "adopt the fleet row at the front read",
  `      this.peerPassRow = front.gates.get(TRACKER_PASS_STATE_KEY) ?? null;`,
  `      this.peerPassRow = front.gates.get(TRACKER_PASS_STATE_KEY) ?? null;
      // THE FLEET'S 429 MEMORY (see DEX_SPACING_STATE_KEY): the raises an
      // earlier isolate already earned from the shared egress IP's refusals,
      // adopted onto this isolate's spacing. Same slot as the row above and for
      // the same reason — it rides the front's ONE read, so it costs no round
      // trip — and RAISE-ONLY, because the profiles fetch was dispatched above
      // this await, so a refusal that landed in the meantime is this isolate's
      // own and fresher evidence (see AdaptiveSpacing.adoptSteps). Written back
      // on the front's ONE write, from the scan's \`finally\` below.
      const fleetSpacing = this.dex.adoptDurableSpacing(
        front.gates.get(DEX_SPACING_STATE_KEY) ?? null,
      );
      if (diag.dex) {
        diag.dex.spacingFleetSteps = fleetSpacing.steps;
        diag.dex.spacingFleetAgeMs = fleetSpacing.ageMs;
      }`,
);

edit(
  "queue the fleet row on the front write",
  `    } finally {
      // A path that left the scan early (a subrequest floor cut, a stop check,
      // an empty pool) still owes the front's queued bookkeeping — the normal
      // path already landed it right after the pool phase, so this is a no-op
      // then (see flushScanFront).
      await this.flushScanFront();`,
  `    } finally {
      // THE FLEET SPACING ROW (see DEX_SPACING_STATE_KEY) is queued HERE, on the
      // write the front already owes. The slot is the point: this is past every
      // DexScreener leg of the tick (the profiles and boosts feeds above, the
      // pair fetches in the candidate phase), so the count it carries is the one
      // this tick actually earned — and it is in the \`finally\`, so the
      // early-return paths that still spent requests (a subrequest-floor cut, a
      // stop check) record it too. NULL on a tick whose count did not move,
      // which is nearly every tick: a healthy fleet never re-writes the row.
      const spacingOut = this.dex.durableSpacingWrite();
      if (spacingOut !== null) {
        await this.stampFront(DEX_SPACING_STATE_KEY, JSON.stringify(spacingOut));
      }
      // A path that left the scan early (a subrequest floor cut, a stop check,
      // an empty pool) still owes the front's queued bookkeeping — the normal
      // path already landed it right after the pool phase, so this is a no-op
      // then (see flushScanFront).
      await this.flushScanFront();`,
);

fs.writeFileSync(FILE, src);
console.log(`scanner.ts: ${applied} applied, ${skipped} already present`);
