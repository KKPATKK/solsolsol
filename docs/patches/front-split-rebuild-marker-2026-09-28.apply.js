#!/usr/bin/env node
/*
 * Apply: A (the whole FRONT SPLIT on the durable record + in the race-window
 * err) and C (carry the rebuild marker through the CLAIM heartbeat).
 *
 * WHY A SCRIPT AND NOT AN EDITOR (2026-09-28): str_replace's snapshot of
 * src/worker.ts is stale — every anchor below was verified to exist on disk
 * (grep) while str_replace reported "not found". Anchored + idempotent, the
 * same discipline the other docs/patches/*.apply.js scripts use: a `marker`
 * that exists ONLY after the edit lands, so a second run reports "=" instead
 * of doubling anything.
 *
 * Idempotent + self-verifying: prints ✓ (applied), = (already there), ✗ (the
 * anchor is missing — the file has moved on) and exits non-zero on any ✗.
 *
 * Run: node docs/patches/front-split-rebuild-marker-2026-09-28.apply.js
 */

"use strict";

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "src", "worker.ts");

const EDITS = [
  // ---------------------------------------------------------------- A -----
  {
    name: "A1 frontSplitNote + preStartSplitNote (pure formatters)",
    marker: "export function frontSplitNote(",
    from: "/** Latest pre-scan split, module state like every other per-isolate counter. */",
    to: `/**
 * The handler's pre-scan steps in one line (see PreTickSteps).
 *
 * \`rest\` is the part of the window the NAMED steps do not account for, printed
 * for the same reason the front split below prints its own remainder: a big
 * \`rest\` is work nobody measured, and a big \`init\` is the cold rebuild that
 * pays it (see deadTickRebuildDecision). Pure and exported so the arithmetic is
 * pinned by a test rather than by this comment.
 */
export function preStartSplitNote(
  entryAt: number,
  startedAt: number,
  steps: PreTickSteps,
): string {
  const total = entryAt > 0 && startedAt >= entryAt ? startedAt - entryAt : 0;
  const named = steps.bump + steps.init + steps.gate + steps.outage;
  return (
    \`preStart \${total}ms [bump \${steps.bump} init \${steps.init} \` +
    \`gate \${steps.gate} outage \${steps.outage} rest \${Math.max(0, total - named)}]\`
  );
}

/**
 * The FRONT SPLIT in one line (see PreTickView): handler entry -> race start,
 * named part by part, with each half's remainder named too.
 *
 * WHY IT EXISTS (2026-09-28, live). The race-window error used to print only
 * \`preRace 4320ms = json 0 + claim 1440\` — a third of the number a reader opens
 * it for. The other 2880ms (the cold \`init\` above all) had to be reconstructed
 * by subtraction, and could not be reconstructed AT ALL for a tick that died
 * before the race: its only durable stamp is the admission record, which rides
 * the claim, and at that moment \`preRaceMs\` does not exist yet. So the split is
 * published in TWO places — whole, in the race-window error, and as far as it
 * is known, on every durable stamp (see TickProgressRecord.front).
 *
 * \`front = preStart + preRace\` is the whole envelope the scan's race window is
 * granted inside (see scanRaceWindowMs), so the two things a reader needs are
 * the total and which named step owns it.
 */
export function frontSplitNote(v: PreTickView | null | undefined): string {
  if (!v || v.preStartMs === null || v.preRaceMs === null) return "front n/a";
  const preStart = v.preStartMs;
  const preRace = v.preRaceMs;
  const rest = Math.max(0, preRace - v.steps.json - v.steps.claim);
  return (
    \`front \${preStart + preRace}ms = \` +
    \`\${preStartSplitNote(v.at, v.at + preStart, v.steps)} + \` +
    \`preRace \${preRace}ms [json \${v.steps.json} claim \${v.steps.claim} rest \${rest}]\`
  );
}

/** Latest pre-scan split, module state like every other per-isolate counter. */`,
  },
  {
    name: "A2 TickProgressRecord.front (durable front split)",
    marker: "  front: string | null;",
    from: `  /** The front split (\`preTick.preRaceMs\`) — the cold-front reading. */
  preRaceMs: number;
  /** Subrequests counted so far in the invocation (see src/subreqs.ts). */`,
    to: `  /** The front split (\`preTick.preRaceMs\`) — the cold-front reading. */
  preRaceMs: number;
  /**
   * The front split as far as it was KNOWN when this stamp was written (see
   * preStartSplitNote / frontSplitNote) — a durable STRING because this row is
   * the only witness a killed tick leaves.
   *
   * Two shapes, and the shape is part of the reading: at the ADMISSION stamp
   * (which rides the claim) the pre-race phase is still running, so the value
   * is the \`preStart\` half alone — enough to name a cold \`init\`; every stamp
   * from the race onwards carries the whole \`front = preStart + preRace\` line.
   */
  front: string | null;
  /** Subrequests counted so far in the invocation (see src/subreqs.ts). */`,
  },
  {
    name: "A3 TICK_PROGRESS_FRONT_MAX + raise TICK_PROGRESS_ERR_MAX",
    marker: "TICK_PROGRESS_FRONT_MAX",
    from: `/** How much of a failure reason the record keeps (it is read, not parsed). */
export const TICK_PROGRESS_ERR_MAX = 160;`,
    to: `/**
 * How much of a failure reason the record keeps (it is read, not parsed).
 *
 * RAISED 160 -> 320 (2026-09-28): the race-window error now carries the whole
 * front split (~190 chars), and the number a reader opens that message for is
 * the remainder at its END — a 160-char cap cut off exactly the reading the
 * message was extended to provide.
 */
export const TICK_PROGRESS_ERR_MAX = 320;
/**
 * How much of the front split the record keeps. Sized for the longest line the
 * two formatters can produce (the whole front, every step named 0-99999), so a
 * stamp never reports a split with its tail cut off.
 */
export const TICK_PROGRESS_FRONT_MAX = 220;`,
  },
  {
    name: "A4 TickProgressFields.front",
    marker: "  front?: string | null;",
    from: `  scanMs: number;
  preRaceMs: number;
  subreqs: number;
  cut: boolean;
  err: string | null;
}

/** Build one. Time is taken here so \`t\`/\`ms\` can never disagree. */`,
    to: `  scanMs: number;
  preRaceMs: number;
  /** The front split so far (see TickProgressRecord.front); null = not known. */
  front?: string | null;
  subreqs: number;
  cut: boolean;
  err: string | null;
}

/** Build one. Time is taken here so \`t\`/\`ms\` can never disagree. */`,
  },
  {
    name: "A5 tickProgressRecord writes the split",
    marker: "    front: fields.front ? String(fields.front)",
    from: `    preRaceMs: whole(fields.preRaceMs),
    subreqs: whole(fields.subreqs),`,
    to: `    preRaceMs: whole(fields.preRaceMs),
    front: fields.front ? String(fields.front).slice(0, TICK_PROGRESS_FRONT_MAX) : null,
    subreqs: whole(fields.subreqs),`,
  },
  {
    name: "A6 parseTickProgress reads the split back",
    marker: '    front: typeof rec.front === "string" ? rec.front : null,',
    from: `    preRaceMs: num(rec.preRaceMs),
    subreqs: num(rec.subreqs),`,
    to: `    preRaceMs: num(rec.preRaceMs),
    front: typeof rec.front === "string" ? rec.front : null,
    subreqs: num(rec.subreqs),`,
  },
  {
    // ANCHOR WIDENED (2026-09-28). The first apply inserted the push AND the
    // comment block above it; a killed mutation run then removed only the push
    // line, while the comment block stayed — so the original two-line anchor no
    // longer matched and this edit kept reporting "anchor NOT FOUND" even
    // though the only missing piece was one line. Pinned against the tail that
    // is on disk. Marker is the line itself, so a re-run reports "=".
    name: "A7 tickProgressNote prints the split before cut/err",
    marker: "  if (rec.front) bits.push(rec.front);",
    from: `  // err copy is placed last).
  if (rec.cut) bits.push("cut");`,
    to: `  // err copy is placed last).
  if (rec.front) bits.push(rec.front);
  if (rec.cut) bits.push("cut");`,
  },
  {
    name: "A8 admission stamp carries the preStart half",
    marker: "      front: preStartSplitNote(preTickEntryAt, startedAt, preTick.steps),",
    from: `      preRaceMs: 0,
      subreqs: subreqView().current.total,
      cut: false,
      err: null,
    });`,
    to: `      preRaceMs: 0,
      // The pre-race phase is still RUNNING here (this stamp rides the claim),
      // so the split is the handler half alone: \`preStart\` with \`init\` named.
      // That is the reading a stretch needs for a tick killed between the claim
      // and the race, whose only durable stamp is this one.
      front: preStartSplitNote(preTickEntryAt, startedAt, preTick.steps),
      subreqs: subreqView().current.total,
      cut: false,
      err: null,
    });`,
  },
  {
    name: "A9 phase stamps carry the whole front split",
    marker: `          front: frontSplitNote(preTick),
          subreqs: subreqView().current.total,
          cut: false,`,
    from: `          payloadBytes: 0,
          scanMs: 0,
          preRaceMs: preTick?.preRaceMs ?? 0,
          subreqs: subreqView().current.total,
          cut: false,
          err: null,
        });`,
    to: `          payloadBytes: 0,
          scanMs: 0,
          preRaceMs: preTick?.preRaceMs ?? 0,
          front: frontSplitNote(preTick),
          subreqs: subreqView().current.total,
          cut: false,
          err: null,
        });`,
  },
  {
    name: "A10 postscan record carries the whole front split",
    marker: `          front: frontSplitNote(preTick),
          subreqs: subreqView().current.total,
          cut: timedOut,`,
    from: `          scanMs: flushedMs,
          preRaceMs: preTick?.preRaceMs ?? 0,
          subreqs: subreqView().current.total,
          cut: timedOut,`,
    to: `          scanMs: flushedMs,
          preRaceMs: preTick?.preRaceMs ?? 0,
          front: frontSplitNote(preTick),
          subreqs: subreqView().current.total,
          cut: timedOut,`,
  },
  {
    name: "A11 race-window err prints the whole front split",
    marker: "${frontSplitNote(preTick)})",
    from: "        ? `scan exceeded its ${scanRaceMs}ms race window (tick budget ${SCAN_TICK_BUDGET_MS}ms, flush reserve ${SCAN_FLUSH_RESERVE_MS}ms, preRace ${preTick.preRaceMs}ms = json ${preTick.steps.json} + claim ${preTick.steps.claim})`",
    to: "        ? `scan exceeded its ${scanRaceMs}ms race window (tick budget ${SCAN_TICK_BUDGET_MS}ms, flush reserve ${SCAN_FLUSH_RESERVE_MS}ms, ${frontSplitNote(preTick)})`",
  },
  // ---------------------------------------------------------------- C -----
  {
    name: "C1 rebuildMarker module state",
    marker: "let rebuildMarker: number | null = null;",
    from: `export function heartbeatRebuiltAt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const hb = JSON.parse(raw) as { rebuiltAt?: unknown } | null;
    const n = Number(hb?.rebuiltAt ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}`,
    to: `export function heartbeatRebuiltAt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  try {
    const hb = JSON.parse(raw) as { rebuiltAt?: unknown } | null;
    const n = Number(hb?.rebuiltAt ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * The rebuild marker THIS tick's claim heartbeat must republish (see
 * deadTickRebuildDecision).
 *
 * WHY IT IS MODULE STATE AND NOT A LOCAL (2026-09-28, live). The recovery used
 * to announce itself ONLY in its own heartbeat row, and the claim that follows
 * in the same tick — the row every later tick actually reads — did not carry
 * the marker. So the recovering tick's own \`phase: scanning\` heartbeat (stale
 * by construction, because a stretching tick never flushes) read as ANOTHER
 * death, and every later tick of the same stretch rebuilt again: a cold re-init
 * (new PoolFallbackDb + db.init() + the boot reads) on the one tick whose whole
 * problem is that its front is too expensive. Measured live 2026-09-28
 * 03:17-03:38Z: \`rebuiltAt\` re-appearing at 03:31:04.95 in the middle of a
 * 21-minute stretch, with \`init-no-scanner\` recorded at 03:39:13.21 — an
 * invocation that reached the end of a bounded init with no scanner at all.
 *
 * Set in ensureInitialized's recovery block BEFORE runScan builds the claim:
 * a rebuild sets it now, a tick whose predecessor is still dead CARRIES the
 * published one (the death has already been answered), and a tick whose
 * predecessor is healthy CLEARS it (the stretch is over, so a later death earns
 * a fresh rebuild). null = no rebuild is in force.
 */
let rebuildMarker: number | null = null;`,
  },
  {
    name: "C2 recovery computes deadNow + the marker to carry",
    marker: `      rebuildMarker =
        verdict.rebuild ? now : deadNow !== null`,
    from: `      const verdict = deadTickRebuildDecision(prevRaw, now, BACKFILL_STALE_MS);
      if (verdict.rebuild) {`,
    to: `      // Is the predecessor PROVEN dead (see deadTickBackfillInfo)? Asked ONCE
      // here, because two consumers in this block need the same answer: the
      // recovery verdict, and the no-completion stretch below.
      const deadNow = prevRaw ? deadTickBackfillInfo(prevRaw, now, BACKFILL_STALE_MS) : null;
      const verdict = deadTickRebuildDecision(prevRaw, now, BACKFILL_STALE_MS);
      // What the claim below must republish (see rebuildMarker). Three cases,
      // and the distinction is the whole point of the fix:
      //   - this tick rebuilt       -> a NEW marker, now;
      //   - predecessor still dead  -> CARRY the published one: this death has
      //                                already been answered and the stretch
      //                                is still running, so rebuilding again
      //                                would pay a cold boot per tick;
      //   - predecessor healthy     -> CLEAR it: the stretch is over.
      rebuildMarker =
        verdict.rebuild ? now : deadNow !== null ? heartbeatRebuiltAt(prevRaw) : null;
      if (verdict.rebuild) {`,
  },
  {
    name: "C3 the stretch block reuses deadNow",
    marker: "      if (deadNow) {",
    from: `      const dead = prevRaw ? deadTickBackfillInfo(prevRaw, now, BACKFILL_STALE_MS) : null;
      if (dead) {`,
    to: `      if (deadNow) {`,
  },
  {
    name: "C4 the stretch call uses deadNow",
    marker: "trackNoCompletionStretch(deadNow.at, now)",
    from: "          trackNoCompletionStretch(dead.at, now),",
    to: "          trackNoCompletionStretch(deadNow.at, now),",
  },
  {
    name: "C5 the claim heartbeat republishes the marker",
    marker: "    rebuiltAt: rebuildMarker,",
    from: `    ok: true,
    phase: "scanning",
    ms: null,`,
    to: `    ok: true,
    phase: "scanning",
    // The rebuild marker this tick inherited or set (see rebuildMarker). It
    // MUST ride the claim and not only the rebuild's own announce write: the
    // claim is the row every later tick reads, so a marker that lives only in
    // the announce is erased the moment the recovering tick wins its claim —
    // and that tick's own stale heartbeat then reads as another death on every
    // later tick, rebuilding forever while never scanning, which is the exact
    // failure the marker exists to prevent.
    rebuiltAt: rebuildMarker,
    ms: null,`,
  },
];

function main() {
  const src = fs.readFileSync(FILE, "utf8");
  let out = src;
  let failures = 0;
  let applied = 0;

  for (const edit of EDITS) {
    if (out.includes(edit.marker)) {
      console.log(`  = ${edit.name}`);
      continue;
    }
    const first = out.indexOf(edit.from);
    if (first === -1) {
      console.log(`  ✗ ${edit.name} — anchor NOT FOUND`);
      failures += 1;
      continue;
    }
    if (out.indexOf(edit.from, first + 1) !== -1) {
      console.log(`  ✗ ${edit.name} — anchor is not unique`);
      failures += 1;
      continue;
    }
    out = out.slice(0, first) + edit.to + out.slice(first + edit.from.length);
    applied += 1;
    console.log(`  ✓ ${edit.name}`);
  }

  if (out !== src) {
    if (failures === 0) fs.writeFileSync(FILE, out);
    else {
      console.log("  (not written: an anchor failed, so the file is unchanged)");
      process.exit(1);
    }
  }
  console.log(
    `\n${failures === 0 ? "OK" : "FAILED"} — ${applied} applied, ` +
      `${EDITS.length - applied - failures} already present, ${failures} failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
