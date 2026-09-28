/**
 * One-shot edit script for src/scanner.ts (2026-09-28).
 *
 * Why a script: the direct file-edit path does not persist changes to this
 * file's regions (the same staleness scanner.ts's own comments call out for
 * resolveAxiomBotUsers). This applies each edit with an EXACT-ONE-OCCURRENCE
 * assertion and refuses to write if any anchor is missing or ambiguous, so a
 * silent partial patch is impossible.
 *
 * Edits:
 *  1. ScanSummary.fails gains `liqRatio` and `sus` (own counters, because the
 *     two sides of the mcap/LP band are tuned independently).
 *  2. the fail counters' initialiser gains the same two keys.
 *  3. mcapRatioBlockReason becomes TWO-SIDED (ratioMin), mirroring
 *     top10MinBlockReason — the LP-heavy shape is the low side.
 *  4. jupSusBlockReason (new export) — Jupiter audit.isSus as a gate reason.
 *  5. the ratio call site passes the floor and routes the counter.
 *  6. the Jupiter suspicion gate, awaited after the display batch and before
 *     the wallet analysis / Flurry legs.
 *
 * Usage: node docs/patches/sus-liqratio-gates-2026-09-28.apply.js
 *
 * STATUS: applied to src/scanner.ts, then corrected by the .repair.js beside
 * this file (duplicate gate block + a TS18047 on liquidityUsd). Edits 4 and 5
 * below are SUPERSEDED by that repair — on the current tree their anchors are
 * gone and this script REFUSES rather than guessing, which is the intended
 * behaviour. It is kept as the audit trail of the edit, not as a replay tool.
 *
 * Idempotency (fixed after the duplicate): judged on the REPLACEMENT being
 * present exactly once, because every replacement here is anchor+addition and
 * the old anchor-absence test re-inserted the block on a second run.
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(FILE, "utf8");
const before = src;

const edits = [
  {
    name: "1. fails counters (interface)",
    anchor: `    /** Deploy-slot bundle detected (Flurry forensics, last gate). */
    flurry: number;
    other: number;
  };`,
    replacement: `    /** Deploy-slot bundle detected (Flurry forensics, last gate). */
    flurry: number;
    /**
     * LP-heavy shape: mcap/LP below MCAP_LIQ_RATIO_MIN (the pool still holds
     * a quarter or more of the supply). Counted apart from the gate's HIGH
     * side so the floor the operator tunes against has its own reading.
     */
    liqRatio: number;
    /** Jupiter's own suspicion flag (audit.isSus) blocked the push. */
    sus: number;
    other: number;
  };`,
  },
  {
    name: "2. fails counters (initialiser)",
    anchor: `        flurry: 0,
        other: 0,
      },`,
    replacement: `        flurry: 0,
        liqRatio: 0,
        sus: 0,
        other: 0,
      },`,
  },
  {
    name: "3. mcapRatioBlockReason two-sided",
    anchor: `export function mcapRatioBlockReason(
  marketCap: number,
  liquidityUsd: number,
  ratioMax: number,
): string | null {
  if (!(ratioMax > 0)) return null;
  if (!(marketCap > 0) || !(liquidityUsd > 0)) return null;
  const ratio = marketCap / liquidityUsd;
  return ratio > ratioMax
    ? \`市值/LP 比率 \${ratio.toFixed(1)}x > \${ratioMax}x（估值遠超池深：價格可操縱、難以出場）\`
    : null;
}`,
    replacement: `export function mcapRatioBlockReason(
  marketCap: number,
  liquidityUsd: number,
  ratioMax: number,
  ratioMin = 0,
): string | null {
  if (!(marketCap > 0) || !(liquidityUsd > 0)) return null;
  const ratio = marketCap / liquidityUsd;
  if (ratioMax > 0 && ratio > ratioMax) {
    return \`市值/LP 比率 \${ratio.toFixed(1)}x > \${ratioMax}x（估值遠超池深：價格可操縱、難以出場）\`;
  }
  // The OTHER side of the band (2026-09-28, MCAP_LIQ_RATIO_MIN). For a
  // constant-product pool the two sides are the same quantity read from
  // opposite ends: LP/mcap = 2 × (tokens in the pool ÷ total supply), so a
  // LOW mcap/LP means the supply is still (mostly) unsold INSIDE the pool and
  // its SOL side is the exit one or two wallets can take.
  //
  // Why a LOW ratio is the danger, from the ring that found it: on 2026-09-28
  // the pushed QNT (LP/mcap 0.70 = ~35% of supply still pooled, dev + one
  // wallet holding 45%) had its pool sold empty within 1h34m; across the
  // 48-token push ring the shape separated cleanly — the four pushes below
  // 2.0x all had their liquidity pulled, none of the 35 above 2.9x did. See
  // docs/suspicious-token-gates.md.
  if (ratioMin > 0 && ratio < ratioMin) {
    const poolSupplyPct = Math.round(100 / (2 * ratio));
    return \`市值/LP 比率 \${ratio.toFixed(1)}x < \${ratioMin}x（LP/市值 \${(1 / ratio).toFixed(2)}：池內仍壓住約 \${poolSupplyPct}% 供應，價格只是未賣出的存量）\`;
  }
  return null;
}

/**
 * Jupiter suspicion-flag gate (Jupiter Token v2 \`audit.isSus\`).
 *
 * Presence-only by Jupiter's own documentation ("isSus is only present when a
 * token has been flagged"), so the flag means "flagged"; its absence is NOT a
 * clean bill of health and must never be judged either way. The caller
 * therefore only ever hands this a boolean — a missing reading stays false
 * (fail-open, the same stance every other gate takes on missing data).
 *
 * Calibrated on the 2026-09-28 push ring (48 tokens / 13 liquidity pulls in
 * 6.5h, read from the bot's own audit ring): all 5 flagged coins had their
 * liquidity pulled and NONE of the 35 unflagged did — no false positive was
 * observed, so the gate costs recall (5 of 13 pulls caught), not precision.
 * Worth stating plainly: the flag is Jupiter's and its latency is unknown, so
 * a fast rug can still be pushed before it appears, and the measurement is the
 * flag's value NOW (no snapshot is stored at push time).
 *
 * \`devBalancePct\` is carried into the reason only — it is not a gate.
 */
export function jupSusBlockReason(
  sus: boolean,
  devBalancePct: number | null,
): string | null {
  if (!sus) return null;
  const dev =
    devBalancePct !== null && Number.isFinite(devBalancePct)
      ? \`，dev 持倉 \${devBalancePct.toFixed(1)}%\`
      : "";
  return \`Jupiter 標記可疑（audit.isSus\${dev}）\`;
}`,
  },
  {
    name: "4. ratio call site passes the floor",
    // NOTE: superseded by the .repair.js guard, which wraps this whole block
    // in `if (liquidityUsd !== null)`. Kept verbatim so this script stays
    // replayable on a pristine checkout; on a repaired tree edit 4 reports
    // "anchor NOT FOUND" and the script refuses — run it only on the original.
    anchor: `        const ratioReason =
          liquidityUsd === null
            ? null
            : mcapRatioBlockReason(
                pair.marketCap,
                liquidityUsd,
                this.config.mcapLiqRatioMax,
              );`,
    replacement: `        const ratioReason =
          liquidityUsd === null
            ? null
            : mcapRatioBlockReason(
                pair.marketCap,
                liquidityUsd,
                this.config.mcapLiqRatioMax,
                this.config.mcapLiqRatioMin,
              );`,
  },
  {
    name: "5. ratio counter routing",
    anchor: `        if (ratioReason) {
          fails.other++;
          reject(ratioReason);
          continue;
        }`,
    replacement: `        if (ratioReason) {
          // Route the counter to the side that fired. The decision itself
          // stays the helper's (one source of truth); this extra division only
          // picks the reading, because the two floors are tuned independently —
          // the HIGH side is the Nudaeng shape this gate has always had, the
          // LOW side is the LP-heavy shape added 2026-09-28.
          if (
            this.config.mcapLiqRatioMin > 0 &&
            pair.marketCap / liquidityUsd < this.config.mcapLiqRatioMin
          ) {
            fails.liqRatio++;
          } else {
            fails.other++;
          }
          reject(ratioReason);
          continue;
        }`,
  },
  {
    name: "6. organic-slot contract note",
    anchor: `        // be counted as "this tick had one".`,
    replacement: `        // be counted as "this tick had one". The Jupiter SUSPICION gate
        // below is the one reader that does await that slot (see its note);
        // the slot, not this line, still owns the counter.`,
  },
  {
    name: "7. Jupiter suspicion gate",
    anchor: `          this.addReject(diag, coin, "GMGN 標記為 wash trading");
          console.log(
            \`[scanner] blocked \${coin.profile.symbol ?? coin.pair.baseToken.symbol} (GMGN wash-trading flag)\`,
          );
          continue;
        }`,
    replacement: `          this.addReject(diag, coin, "GMGN 標記為 wash trading");
          console.log(
            \`[scanner] blocked \${coin.profile.symbol ?? coin.pair.baseToken.symbol} (GMGN wash-trading flag)\`,
          );
          continue;
        }
        // Jupiter suspicion gate (audit.isSus) — the only vendor-supplied
        // suspicion flag this bot has, and FREE: it rides the payload the 🌱
        // 有機度 slot above already fetched for the card, so this gate adds no
        // request, no key and no provider. Absent flag = not flagged = pass
        // (Jupiter sets the field only when it has flagged the token).
        //
        // It AWAITS that slot, which is a deliberate change to a slot whose
        // contract was strictly display-only: the flag is a reason NOT to
        // push, so it has to be read BEFORE the send. The wait is bounded by
        // chainDeadline (never the push reserve) and the call was dispatched in
        // front of RugCheck, so the whole serial chain behind it (RugCheck +
        // crime + Axiom + the display batch) has already given it its window; a
        // slot that still misses degrades to null and the coin pushes, which is
        // the fail-open every other gate uses.
        //
        // Sited before the wallet analysis and the Flurry gate on purpose: a
        // flagged coin then saves the chain's two most expensive legs.
        const susReading = this.config.jupSusBlock
          ? await this.bestEffort(() => organicSlot, chainDeadline, null)
          : null;
        const susReason = jupSusBlockReason(
          susReading?.sus ?? false,
          susReading?.devBalancePct ?? null,
        );
        if (susReason) {
          diag.fails.sus++;
          this.addReject(diag, coin, susReason);
          console.log(
            \`[scanner] blocked \${coin.profile.symbol ?? coin.pair.baseToken.symbol} (Jupiter audit.isSus)\`,
          );
          continue;
        }`,
  },
];

let applied = 0;
let already = 0;
const problems = [];

for (const edit of edits) {
  // Idempotency is judged on the REPLACEMENT, not on the anchor's absence:
  // every replacement here is anchor+addition, so the anchor stays present
  // after the edit. Testing `!src.includes(edit.anchor)` therefore reported
  // "not applied yet" on a second run and inserted the block twice — fixed
  // 2026-09-28 (see the .repair.js beside this file).
  const substituted = src.split(edit.replacement).length - 1;
  if (substituted === 1) {
    already++;
    continue;
  }
  if (substituted > 1) {
    problems.push(`${edit.name}: replacement present ${substituted} times (corrupt)`);
    continue;
  }
  const parts = src.split(edit.anchor);
  if (parts.length === 1) {
    problems.push(`${edit.name}: anchor NOT FOUND`);
    continue;
  }
  if (parts.length > 2) {
    problems.push(`${edit.name}: anchor is AMBIGUOUS (${parts.length - 1} hits)`);
    continue;
  }
  src = parts.join(edit.replacement);
  applied++;
}

if (problems.length > 0) {
  console.error("REFUSING TO WRITE:\n - " + problems.join("\n - "));
  process.exit(1);
}
if (src === before) {
  console.log(`no change needed (already applied: ${already})`);
  process.exit(0);
}
fs.writeFileSync(FILE, src);
console.log(`applied ${applied} edit(s), skipped ${already} already-applied`);
