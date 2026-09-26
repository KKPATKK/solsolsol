#!/usr/bin/env node
/**
 * Deferred-card prune rule (2026-09-26): retire the obligations that can never
 * be paid, so the make-up lane stops spending every slot on them.
 *
 * WHAT THE OPERATOR ASKED. "呢 20 條係永遠追唔返嘅舊欠單 … 可以怎樣清理" — the
 * `deferral.pending` list had been sitting at 20 entries, and the honest first
 * answer ("it does not affect any push") turned out to be wrong on measurement:
 *
 *  - `missingDeferredTokens` (src/deferredmakeup.ts) is OLDEST-FIRST with
 *    DEFERRED_MAKEUP_MAX = 8 per tick, and the live tick read
 *    `feedMakeup.injectedTotal 8 / lastInjected 8` — every make-up slot, every
 *    tick, spent on the 8 oldest entries;
 *  - those 8 were measured (via /debug/token, launch_ms) at 47.6 / 120.2 /
 *    126.2 / 156.4 / 165.1 / 165.3 / 166.6 / 167.0 hours old against the
 *    widest enabled chat's 26 h max age — i.e. 8/8 provably unpushable;
 *  - anything newer therefore never got a slot, including a genuine obligation
 *    measured at 7.7 h (inside the 80 min-26 h card window) sitting last in
 *    the queue.
 *
 * THE RULE (A in the operator's list). An obligation is retired when the facts
 * the tick already has prove no card is possible:
 *
 *  - `too-old`: the coin's age — the SAME `Date.now() - pair.pairCreatedAt`
 *    the per-chat age gate decides on — exceeds the WIDEST enabled chat's
 *    `maxAgeMinutes`, so every chat rejects it. Monotonic: a coin that is too
 *    old stays too old. Retired on the first such observation.
 *  - `no-pair`: no pair data for DEFERRED_PRUNE_ATTEMPTS (3) consecutive
 *    observations. The soft case, because an upstream answer can miss a live
 *    coin for a tick (budget cut, 429, last-good feed reuse); any in-window
 *    observation in between resets the run.
 *  - "too FRESH" is deliberately NOT a retirement: a young coin ages INTO the
 *    window.
 *
 * WHERE IT IS OBSERVED — and why it costs nothing. `Scanner.matchCoins` is the
 * one place every owed coin passes through: the feed's make-up lane injects
 * the oldest 8 into the profiles list, the pool slice carries the in-window
 * ones, and both hand their pairs to that loop (src/scanner.ts builds
 * `scannedProfiles = [...feedOnly, ...poolSlice]` and fetches pairs for all of
 * them). So the hook is one `isDeferredToken` map hit per profile and a pure
 * registry call — no extra request, no extra Turso round trip.
 *
 * WHY THE DURABLE ROW NEEDS A COUNTER TOO. The retirements shrink the registry
 * — and the durable row's `pendingTokens` list is written from that registry,
 * so the shrunken list can only LAND on a tick that writes the row. A tick
 * whose only new fact is a retirement therefore has to keep the write path
 * open: `pruned` is a cursor difference (like deferred/recovered), computed
 * from the scanner's cumulative count against the worker's baseline, and
 * `delta.pruned > 0` is what makes a prune-only tick write. Same cursor
 * discipline, same applied-marker dedupe.
 *
 * THE PROBE. `/debug/deferral` answers both halves from one read-only request:
 * the durable row the fleet shares (pending list + counters + the prune
 * stamps) and THIS isolate's registry — how long each coin has been owed, how
 * many consecutive no-pair misses it has, and what was retired here and why.
 * The acceptance point for the rule lives in the pair: `pending` falling while
 * `prunedTotal` rises.
 *
 * src/scanner.ts, src/worker.ts and scripts/test-unit.js are far past the file
 * tool's edit window, so this is a verify-then-write patch.
 *
 * Run: node docs/patches/deferred-prune-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "src/scanner.ts",
    "the prune rule's two registry entry points are imported",
    lines(
      `import {`,
      `  addDeferredToken,`,
      `  deferredTokenList,`,
      `  dropDeferredToken,`,
      `  isDeferredToken,`,
      `  missingDeferredTokens,`,
      `} from "./deferredmakeup";`,
    ),
    lines(
      `import {`,
      `  addDeferredToken,`,
      `  deferredPrunedTotal,`,
      `  deferredTokenList,`,
      `  dropDeferredToken,`,
      `  isDeferredToken,`,
      `  missingDeferredTokens,`,
      `  noteDeferredCoin,`,
      `} from "./deferredmakeup";`,
    ),
    (src) => src.includes("noteDeferredCoin,"),
  ],
  [
    "src/scanner.ts",
    "the ledger exposes the retirement counter",
    lines(
      `  recover(token: string): boolean {`,
      `    if (!dropDeferredToken(token)) return false;`,
      `    this.recoveredCount += 1;`,
      `    return true;`,
      `  }`,
      ``,
      `  /** Coins deferred and not yet pushed back (visibility into the backlog). */`,
    ),
    lines(
      `  recover(token: string): boolean {`,
      `    if (!dropDeferredToken(token)) return false;`,
      `    this.recoveredCount += 1;`,
      `    return true;`,
      `  }`,
      ``,
      `  /**`,
      `   * Obligations the registry RETIRED as unpayable (see noteDeferredCoin):`,
      `   * the coin aged past every enabled chat's max age, or had no pair data`,
      `   * for DEFERRED_PRUNE_ATTEMPTS consecutive make-up observations.`,
      `   *`,
      `   * Cumulative like \`recovered\`, and the worker folds it into the durable`,
      `   * row on the same cursor discipline (baseline + applied marker). It is`,
      `   * not only telemetry: a tick whose only new fact is a retirement has to`,
      `   * REWRITE that row, because the row is what carries the pending list`,
      `   * this shrank — a recycled isolate re-seeds from it.`,
      `   */`,
      `  get pruned(): number {`,
      `    return deferredPrunedTotal();`,
      `  }`,
      ``,
      `  /** Coins deferred and not yet pushed back (visibility into the backlog). */`,
    ),
    (src) => src.includes("get pruned(): number {"),
  ],
  [
    "src/scanner.ts",
    "the summary carries the cumulative retirements",
    `  /** Coins still waiting for that make-up push (deferred and never pushed). */\n  deferPending?: number;`,
    lines(
      `  /** Coins still waiting for that make-up push (deferred and never pushed). */`,
      `  deferPending?: number;`,
      `  /**`,
      `   * Obligations the registry retired as unpayable (see noteDeferredCoin in`,
      `   * src/deferredmakeup.ts), cumulative per isolate. Published so the durable`,
      `   * row can prove the rule ran fleet-wide and not just on one isolate: the`,
      `   * acceptance point is this rising while \`deferPending\` falls.`,
      `   */`,
      `  deferPruned?: number;`,
    ),
    (src) => src.includes("deferPruned?: number;"),
  ],
  [
    "src/scanner.ts",
    "and publishes it with the other deferral counters",
    lines(
      `      deferRecovered: this.deferredPushes.recovered,`,
      `      deferPending: this.deferredPushes.pendingCount,`,
      `      rejects: [],`,
    ),
    lines(
      `      deferRecovered: this.deferredPushes.recovered,`,
      `      deferPending: this.deferredPushes.pendingCount,`,
      `      deferPruned: this.deferredPushes.pruned,`,
      `      rejects: [],`,
    ),
    (src) => src.includes("deferPruned: this.deferredPushes.pruned,"),
  ],
  [
    "src/scanner.ts",
    "matchCoins judges every owed coin with the gate's own age input",
    lines(
      `    logBudget?: { feedBudgetStart: number; poolStartIdx: number },`,
      `  ): QualifyingCoin[] {`,
      `    const out: QualifyingCoin[] = [];`,
      `    for (let pi = 0; pi < profiles.length; pi++) {`,
      `      const profile = profiles[pi]!;`,
      `      const pair = pairsByToken.get(profile.tokenAddress);`,
      `      if (!pair) continue;`,
    ),
    lines(
      `    logBudget?: { feedBudgetStart: number; poolStartIdx: number },`,
      `  ): QualifyingCoin[] {`,
      `    const out: QualifyingCoin[] = [];`,
      `    // The widest age window across the enabled chats — the bound a deferred`,
      `    // obligation is judged against below. Infinity when there is no chat to`,
      `    // push to: with nobody able to accept the card, no coin is "too old",`,
      `    // and the only retirement left is the no-pair run.`,
      `    const widestMaxAgeMs =`,
      `      chats.length > 0 ? Math.max(...chats.map((c) => c.maxAgeMinutes)) * 60_000 : Infinity;`,
      `    for (let pi = 0; pi < profiles.length; pi++) {`,
      `      const profile = profiles[pi]!;`,
      `      const pair = pairsByToken.get(profile.tokenAddress);`,
      `      // Deferred obligations get their make-up verdict HERE (2026-09-26).`,
      `      // This is the one place every owed coin passes through — the feed's`,
      `      // make-up lane injects the oldest ones into this list, the pool slice`,
      `      // carries the in-window ones, and both hand their pairs to this loop —`,
      `      // so the facts below are the AGE GATE'S OWN input, not a second`,
      `      // opinion: ageMs is the same Date.now() - pair.pairCreatedAt the gate`,
      `      // decides on, and widestMaxAgeMs is the widest enabled chat's limit.`,
      `      // An obligation every chat would reject on age can never produce the`,
      `      // card it is owed, and because the make-up lane is oldest-first,`,
      `      // keeping it spends a slot on EVERY tick: live 2026-09-26, 20 pending`,
      `      // with injectedTotal 8 per tick, the 8 oldest measured 47.6-167.0h`,
      `      // against a 26h widest window, so the lane delivered nothing and`,
      `      // anything newer (a genuine 7.7h obligation, last in the queue) never`,
      `      // got a slot. A coin with NO pair is the soft case and needs the`,
      `      // registry's run-of-misses slack (see noteDeferredCoin).`,
      `      if (isDeferredToken(profile.tokenAddress)) {`,
      `        noteDeferredCoin(profile.tokenAddress, {`,
      `          ageMs: pair ? Date.now() - pair.pairCreatedAt : null,`,
      `          windowMaxAgeMs: widestMaxAgeMs,`,
      `        });`,
      `      }`,
      `      if (!pair) continue;`,
    ),
    (src) => src.includes("noteDeferredCoin(profile.tokenAddress, {"),
  ],
  [
    "src/worker.ts",
    "the probe's registry view is imported",
    `import { feedMakeupView } from "./deferredmakeup";`,
    `import { deferralRegistryView, feedMakeupView } from "./deferredmakeup";`,
    (src) => src.includes("deferralRegistryView, feedMakeupView"),
  ],
  [
    "src/worker.ts",
    "the baseline carries the retirement cursor",
    lines(
      ` * difference, and this field only rides along to keep the delta one shape.`,
      ` */`,
      `let pushDeferralBaseline: { deferred: number; recovered: number; stalled?: number } = {`,
      `  deferred: 0,`,
      `  recovered: 0,`,
      `  stalled: 0,`,
      `};`,
    ),
    lines(
      ` * difference, and this field only rides along to keep the delta one shape.`,
      ` *`,
      ` * \`pruned\` is optional for that same reason, but it IS a cursor difference`,
      ` * (like \`deferred\`/\`recovered\`): the retirements it counts live on the`,
      ` * scanner's registry, which the dead-tick rebuild replaces together with`,
      ` * this baseline — see the reset at both rebuild sites.`,
      ` */`,
      `let pushDeferralBaseline: {`,
      `  deferred: number;`,
      `  recovered: number;`,
      `  stalled?: number;`,
      `  pruned?: number;`,
      `} = {`,
      `  deferred: 0,`,
      `  recovered: 0,`,
      `  stalled: 0,`,
      `  pruned: 0,`,
      `};`,
    ),
    (src) => src.includes("stalled?: number;\n  pruned?: number;"),
  ],
  [
    "src/worker.ts",
    "the dead-tick rebuild resets the new cursor too (first site)",
    `        pushDeferralBaseline = { deferred: 0, recovered: 0 };\n        // Announce the rebuild in the heartbeat, keeping the DEAD tick's \`at\`:\n        // \`now\` would make the cadence gate skip the tick that just rebuilt the\n        // state, and \`rebuiltAt\` is the marker that stops the same death from`,
    `        pushDeferralBaseline = { deferred: 0, recovered: 0, pruned: 0 };\n        // Announce the rebuild in the heartbeat, keeping the DEAD tick's \`at\`:\n        // \`now\` would make the cadence gate skip the tick that just rebuilt the\n        // state, and \`rebuiltAt\` is the marker that stops the same death from`,
    (src) => src.includes("pushDeferralBaseline = { deferred: 0, recovered: 0, pruned: 0 };"),
  ],
  [
    "src/worker.ts",
    "the dead-tick rebuild resets the new cursor too (second site)",
    `      pushDeferralBaseline = { deferred: 0, recovered: 0 };\n    }`,
    `      pushDeferralBaseline = { deferred: 0, recovered: 0, pruned: 0 };\n    }`,
    // The indentation is part of the predicate on purpose: both rebuild sites
    // share the edited text, and the first site's version (8 spaces) must not
    // make this one look done.
    (src) => src.includes("      pushDeferralBaseline = { deferred: 0, recovered: 0, pruned: 0 };\n    }"),
  ],
  [
    "src/worker.ts",
    "the tick's totals carry the scanner's retirement count",
    lines(
      `  const totals = {`,
      `    deferred: summary?.cardSendDeferredTotal ?? 0,`,
      `    recovered: summary?.deferRecovered ?? 0,`,
      `    stalled: stalledCandidatesTotal,`,
      `  };`,
    ),
    lines(
      `  const totals = {`,
      `    deferred: summary?.cardSendDeferredTotal ?? 0,`,
      `    recovered: summary?.deferRecovered ?? 0,`,
      `    stalled: stalledCandidatesTotal,`,
      `    // Retirements are a CURSOR difference like deferred/recovered (the`,
      `    // registry and the baseline above are replaced together by the`,
      `    // dead-tick rebuild), never a pending delta like stalled.`,
      `    pruned: summary?.deferPruned ?? 0,`,
      `  };`,
    ),
    (src) => src.includes("pruned: summary?.deferPruned ?? 0,"),
  ],
  [
    "src/worker.ts",
    "and the delta that reaches the row (this is what a prune-only tick writes)",
    lines(
      `  // The held-back half rides its own pending delta (see stalledUnflushed), and`,
      `  // that is what makes a chain-deferral-only tick persist at all: cursorDelta`,
      `  // is null whenever the scanner's own counters did not move — exactly the`,
      `  // shape this counter exists for. \`totals.stalled\` still travels with every`,
      `  // write as the applied marker, but it is not the amount added.`,
      `  const delta = {`,
      `    deferred: cursorDelta?.deferred ?? 0,`,
      `    recovered: cursorDelta?.recovered ?? 0,`,
      `    stalled: stalledUnflushed,`,
      `  };`,
      `  // \`stale.length > 0\` keeps the write path open for a drop-only tick: the`,
      `  // durable row has to lose those tokens too, or a recycled isolate re-seeds`,
      `  // them from storage (see the seed call site) and pushes the same card again.`,
    ),
    lines(
      `  // The held-back half rides its own pending delta (see stalledUnflushed), and`,
      `  // that is what makes a chain-deferral-only tick persist at all: cursorDelta`,
      `  // is null whenever the scanner's own counters did not move — exactly the`,
      `  // shape this counter exists for. \`totals.stalled\` still travels with every`,
      `  // write as the applied marker, but it is not the amount added. Retirements`,
      `  // (pruned) travel on the CURSOR, like deferred/recovered, because they are`,
      `  // scanner state the dead-tick rebuild resets alongside this baseline.`,
      `  const delta = {`,
      `    deferred: cursorDelta?.deferred ?? 0,`,
      `    recovered: cursorDelta?.recovered ?? 0,`,
      `    stalled: stalledUnflushed,`,
      `    pruned: cursorDelta?.pruned ?? 0,`,
      `  };`,
      `  // \`stale.length > 0\` keeps the write path open for a drop-only tick: the`,
      `  // durable row has to lose those tokens too, or a recycled isolate re-seeds`,
      `  // them from storage (see the seed call site) and pushes the same card again.`,
      `  // A RETIREMENT-only tick rides the same way through its own delta`,
      `  // (\`delta.pruned\`): that is what persists the pending list the prune`,
      `  // shrank, and why a prune with no deferral/recovery/held-back coin still`,
      `  // writes.`,
    ),
    (src) => src.includes("pruned: cursorDelta?.pruned ?? 0,"),
  ],
  [
    "src/worker.ts",
    "the no-op guard keeps that tick writing",
    lines(
      `  if (`,
      `    delta.deferred <= 0 &&`,
      `    delta.recovered <= 0 &&`,
      `    delta.stalled <= 0 &&`,
      `    stale.length === 0`,
      `  ) {`,
    ),
    lines(
      `  if (`,
      `    delta.deferred <= 0 &&`,
      `    delta.recovered <= 0 &&`,
      `    delta.stalled <= 0 &&`,
      `    delta.pruned <= 0 &&`,
      `    stale.length === 0`,
      `  ) {`,
    ),
    (src) => src.includes("delta.pruned <= 0 &&"),
  ],
  [
    "src/worker.ts",
    "and the landing log names the retirements",
    lines(
      '      `[worker] deferral counters persisted: +${delta.deferred} deferred / +${delta.recovered} recovered / +${delta.stalled} held back (totals ${next.deferredTotal}/${next.recoveredTotal}/${next.stalledTotal})`,',
    ),
    lines(
      '      `[worker] deferral counters persisted: +${delta.deferred} deferred / +${delta.recovered} recovered / +${delta.stalled} held back / +${delta.pruned} retired (totals ${next.deferredTotal}/${next.recoveredTotal}/${next.stalledTotal}/${next.prunedTotal})`,',
    ),
    (src) => src.includes("+${delta.pruned} retired"),
  ],
  [
    "src/worker.ts",
    "the /debug/deferral probe",
    lines(
      `    if (url.pathname === "/debug/feed-stats") {`,
      `      try {`,
      `        const rows = await db?.getFeedAttribution();`,
      `        return Response.json({ ok: true, byFeed: rows ?? [] });`,
      `      } catch (err) {`,
      `        return Response.json(`,
      `          { ok: false, error: err instanceof Error ? err.message : String(err) },`,
      `          { status: 500 },`,
      `        );`,
      `      }`,
      `    }`,
    ),
    lines(
      `    if (url.pathname === "/debug/feed-stats") {`,
      `      try {`,
      `        const rows = await db?.getFeedAttribution();`,
      `        return Response.json({ ok: true, byFeed: rows ?? [] });`,
      `      } catch (err) {`,
      `        return Response.json(`,
      `          { ok: false, error: err instanceof Error ? err.message : String(err) },`,
      `          { status: 500 },`,
      `        );`,
      `      }`,
      `    }`,
      `    // Deferred-card ledger probe (2026-09-26). One read-only request answers`,
      `    // both halves of "are the owed cards moving, and why not":`,
      `    //`,
      `    //  - \`durable\`: the row the whole fleet shares — the pending list, the`,
      `    //    cumulative counters (deferred/recovered/stalled/pruned) and the`,
      `    //    prune stamps. Re-read here rather than mirroring the tick's copy, so`,
      `    //    a cold isolate answers with the live row too.`,
      `    //  - \`isolate\`: THIS isolate's registry — how long each owed coin has`,
      `    //    been owed, its consecutive no-pair misses, the window the last`,
      `    //    observation judged against, and the recent retirements with the`,
      `    //    reason and the age each was judged at.`,
      `    //`,
      `    // The acceptance point for the prune rule is the pair: \`pending\` falling`,
      `    // while \`prunedTotal\` rises, with \`lastPruned\` naming each coin.`,
      `    if (url.pathname === "/debug/deferral") {`,
      `      try {`,
      `        const raw = await db?.getWorkerState(PUSH_DEFERRAL_STATE_KEY);`,
      `        return Response.json({`,
      `          ok: true,`,
      `          now: Date.now(),`,
      `          durable: loadPushDeferralSnapshot(raw ?? null),`,
      `          isolate: deferralRegistryView(),`,
      `        });`,
      `      } catch (err) {`,
      `        return Response.json(`,
      `          { ok: false, error: err instanceof Error ? err.message : String(err) },`,
      `          { status: 500 },`,
      `        );`,
      `      }`,
      `    }`,
    ),
    (src) => src.includes('url.pathname === "/debug/deferral"'),
  ],
];

const problems = [];
const out = new Map();
for (const [file, label, oldText, newText, already] of EDITS) {
  const src = out.has(file) ? out.get(file) : read(file);
  if (already(src)) {
    console.log(`skip ${file}: ${label} (already applied)`);
    continue;
  }
  const n = hits(src, oldText);
  if (n !== 1) {
    problems.push(`${file}: ${label} — anchor matched ${n} times (want exactly 1)`);
    continue;
  }
  out.set(file, src.replace(oldText, newText));
  console.log(`ok   ${file}: ${label}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
for (const [file, text] of out) {
  fs.writeFileSync(path.join(root, file), text);
  console.log(`wrote ${file} (${text.length} bytes)`);
}
console.log("\nall anchors applied.");
