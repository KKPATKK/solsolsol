#!/usr/bin/env node
/**
 * Paid-plan budget (2026-09-28) — installer / verifier.
 *
 * WHAT THIS DOES. The account moved to Workers Paid, so the two budgets this
 * Worker was built against are wrong in opposite directions:
 *
 *   1. subrequests: the counter still reserves the FREE allowance of 50, so the
 *      scan drops optional legs and the tracker pass refuses alerting rows to
 *      keep a tail inside an allowance the plan no longer has. → SUBREQ_BUDGET
 *      becomes 1_000 (the free 50 stays as the historical reference).
 *   2. the tick envelope: every cut of SCAN_TICK_BUDGET_MS (22s → 9.5s) was
 *      bought against the FREE 10ms CPU wall, which killed a ~33ms tick. Paid
 *      is 30s of CPU, so the constraint that remains is the cron minute. →
 *      SCAN_TICK_BUDGET_MS becomes 20_000, the scan's own deadline follows it
 *      (4_200 → 8_000), and the scan lease is re-sized to outlive the envelope
 *      (15_000 → 30_000).
 *
 * Idempotent: re-running prints "=" for everything already in place, exit 0.
 * Self-verifying: a missing or ambiguous anchor prints "✗" and exits 1 WITHOUT
 * writing anything.
 *
 * Usage: node docs/patches/paid-budget-2026-09-28.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const SUBREQ_PATH = path.join(root, "src", "subreqs.ts");
const WORKER_PATH = path.join(root, "src", "worker.ts");
const SCANNER_PATH = path.join(root, "src", "scanner.ts");
const TEST_PATH = path.join(root, "scripts", "test-unit.js");

let failed = 0;
const report = (mark, name, detail) => {
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
  if (mark === "✗") failed += 1;
};

// ---------------------------------------------------------------------------
// Edit table: [file, name, already-applied marker, old text, new text].
// ---------------------------------------------------------------------------
const NEW_BUDGET_DOC = [
  "/**",
  " * The runtime's per-invocation subrequest allowance on the plan this Worker",
  " * runs on. Pinned here because every reading this counter produces is only",
  " * meaningful against it, and because the number is a platform fact rather",
  " * than a tuning knob: exceeding it throws mid-tick, wherever the next call",
  " * happens to be.",
  " *",
  " * 2026-09-28: the account moved to Workers Paid, whose allowance is 1,000 —",
  " * twenty times the Free plan this bot was built on. Nothing else about the",
  " * counter changes: the gates that spend against it (SCAN_SUBREQ_FLOOR,",
  " * TRACKER_SUBREQ_FLOOR/_RESERVE, TRACKER_PASS_SUBREQ_RESERVE, CHAIN_SUBREQ_FLOOR)",
  " * are ABSOLUTE reserves sized for a 50-subrequest invocation, so on this",
  " * budget they stop binding — the scan no longer stands down its optional legs",
  " * and the tracker pass no longer refuses alerting rows to keep a tail intact.",
  " * They are deliberately left at their sizes rather than re-scaled: a reserve",
  " * that cannot bind costs nothing, while re-scaling them would re-arm exactly",
  " * the refusals the wider allowance exists to remove.",
  " */",
  "export const SUBREQ_BUDGET = 1_000;",
  "/**",
  " * The Workers Free allowance (50) this counter was designed against. Kept as",
  " * the REFERENCE for every reading taken before 2026-09-28: /health and the",
  " * /debug pages quote raw window totals, and those totals were measured",
  " * against this number, not against the current one.",
  " */",
  "export const SUBREQ_BUDGET_FREE = 50;",
].join("\n");

const OLD_BUDGET_DOC = [
  "/**",
  " * The runtime's per-invocation subrequest allowance on Workers Free. Pinned",
  " * here because every reading this counter produces is only meaningful against",
  " * it, and because the number is a platform fact rather than a tuning knob:",
  " * exceeding it throws mid-tick, wherever the next call happens to be.",
  " */",
  "export const SUBREQ_BUDGET_FREE = 50;",
].join("\n");

const TICK_ADDENDUM = [
  " *",
  " * RAISED 9_500 → 20_000 on 2026-09-28, with the account on Workers Paid.",
  " * Every cut documented above was bought against the Free plan's 10ms CPU wall:",
  " * the kill that seemed to move between ~9.6s and ~24s WAS that wall landing",
  " * mid-invocation rather than a wall-clock limit (docs/cpu-10ms-root-cause.md —",
  " * dead invocations pin at exactly cpuTime 10,000us). This tick measures ~33ms",
  " * of CPU: ~3x the Free wall and ~1/900th of the paid 30s, so on this plan the",
  " * only constraint left is the cron minute itself, and 20s of it leaves the",
  " * next tick ~40s of clear air while the flush reserve (unchanged) still starts",
  " * the completion write ~15.5s in. What keeps a HEALTHY tick short is the",
  " * scan's own deadline (SCAN_TICK_DEADLINE_MS); this number now only decides",
  " * how much of a SLOW tick may finish instead of being cut.",
  " */",
  "export const SCAN_TICK_BUDGET_MS = 20_000;",
].join("\n");

const LOCK_ADDENDUM = [
  " *",
  " * 2026-09-28 (15_000 → 30_000): the tick envelope went to 20s on Workers Paid",
  " * (see SCAN_TICK_BUDGET_MS), so the lease has to outlive it again — 1.5x the",
  " * honest envelope is the ratio this constant was last sized at. A dead holder",
  " * still frees the lease long inside the external monitor's rescue gate, which",
  " * needs max(120s, 2 x SCAN_INTERVAL_SECONDS) of silence before it will scan.",
  " */",
  "const SCAN_LOCK_TTL_MS = 30_000;",
].join("\n");

const SCAN_DEADLINE_ADDENDUM = [
  " *",
  " * 2026-09-28 (4_200 → 8_000): the worker's envelope went to 20s on Workers",
  " * Paid (see SCAN_TICK_BUDGET_MS), so this deadline no longer races a 10ms CPU",
  " * wall — it races the race window, which is now ~15.5s. 8_000 keeps ~7.5s of",
  " * margin against it and, with SCAN_GATE_RESERVE_MS unchanged, widens the front",
  " * window to 6_400ms: the front caps' worst case (FEED_DEADLINE_MS 900 +",
  " * POOL_FETCH_BUDGET_MS 1_600 + PAIRS_FETCH_BUDGET_MS 1_000 = 3_500) now fits",
  " * inside it with room to spare, where the 2_600ms window could leave the pair",
  " * phase as little as 100ms once the feeds and the pool read rode their own",
  " * caps. The gate chain — the only phase that can push a coin — is the",
  " * beneficiary: it keeps its 1_600ms reserve and gains the front phases' slack.",
  " */",
  "export const SCAN_TICK_DEADLINE_MS = 8_000;",
].join("\n");

const EDITS = [
  {
    file: SUBREQ_PATH,
    name: "subreqs: SUBREQ_BUDGET = 1000 (free 50 kept as reference)",
    marker: "export const SUBREQ_BUDGET = 1_000;",
    old: OLD_BUDGET_DOC,
    neu: NEW_BUDGET_DOC,
  },
  {
    file: SUBREQ_PATH,
    name: "subreqs: the published view spends against the plan budget",
    marker: "    budget: SUBREQ_BUDGET,",
    old: [
      "  /** The allowance every window is spent against (SUBREQ_BUDGET_FREE). */",
      "  budget: number;",
    ].join("\n"),
    neu: [
      "  /** The allowance every window is spent against (SUBREQ_BUDGET). */",
      "  budget: number;",
    ].join("\n"),
  },
  {
    file: SUBREQ_PATH,
    name: "subreqs: the usable reading names the plan budget",
    marker: "window's `total` against the budget would otherwise be",
    old: [
      "   * window's `total` against 50 would otherwise be reading against a number",
      "   * the tick never spends to.",
    ].join("\n"),
    neu: [
      "   * window's `total` against the budget would otherwise be reading against a",
      "   * number the tick never spends to.",
    ].join("\n"),
  },
  {
    file: SUBREQ_PATH,
    name: "subreqs: subreqView() computes budget/usable from the plan budget",
    marker: "    usable: Math.max(0, SUBREQ_BUDGET - SUBREQ_UNSEEN_ALLOWANCE),",
    old: [
      "    budget: SUBREQ_BUDGET_FREE,",
      "    unseenAllowance: SUBREQ_UNSEEN_ALLOWANCE,",
      "    usable: Math.max(0, SUBREQ_BUDGET_FREE - SUBREQ_UNSEEN_ALLOWANCE),",
    ].join("\n"),
    neu: [
      "    budget: SUBREQ_BUDGET,",
      "    unseenAllowance: SUBREQ_UNSEEN_ALLOWANCE,",
      "    usable: Math.max(0, SUBREQ_BUDGET - SUBREQ_UNSEEN_ALLOWANCE),",
    ].join("\n"),
  },
  {
    file: SUBREQ_PATH,
    name: "subreqs: subreqRemaining() defaults to the plan budget",
    marker: "export function subreqRemaining(budget: number = SUBREQ_BUDGET): number {",
    old: "export function subreqRemaining(budget: number = SUBREQ_BUDGET_FREE): number {",
    neu: "export function subreqRemaining(budget: number = SUBREQ_BUDGET): number {",
  },
  {
    file: SUBREQ_PATH,
    name: "subreqs: subreqRemaining's doc names the plan budget",
    marker: " * spends against SUBREQ_BUDGET, which is a platform fact.",
    old: " * spends against SUBREQ_BUDGET_FREE, which is a platform fact.",
    neu: " * spends against SUBREQ_BUDGET, which is a platform fact.",
  },
  {
    file: WORKER_PATH,
    name: "worker: SCAN_TICK_BUDGET_MS 9_500 → 20_000 (paid envelope)",
    marker: "export const SCAN_TICK_BUDGET_MS = 20_000;",
    old: [
      " * the tail that was already going unused. Never widen this number to make",
      " * room for a new tail stage — the tail IS what is left after the flush.",
      " */",
      "export const SCAN_TICK_BUDGET_MS = 9_500;",
    ].join("\n"),
    neu: [
      " * the tail that was already going unused. Never widen this number to make",
      " * room for a new tail stage — the tail IS what is left after the flush.",
      TICK_ADDENDUM,
    ].join("\n"),
  },
  {
    file: WORKER_PATH,
    name: "worker: SCAN_LOCK_TTL_MS 15_000 → 30_000 (outlives the envelope)",
    marker: "const SCAN_LOCK_TTL_MS = 30_000;",
    old: [
      " * cron period (the previous fix in this file — the takeover branch below —",
      " * then re-claims it and the scan proceeds).",
      " */",
      "const SCAN_LOCK_TTL_MS = 15_000;",
    ].join("\n"),
    neu: [
      " * cron period (the previous fix in this file — the takeover branch below —",
      " * then re-claims it and the scan proceeds).",
      LOCK_ADDENDUM,
    ].join("\n"),
  },
  {
    file: SCANNER_PATH,
    name: "scanner: SCAN_TICK_DEADLINE_MS 4_200 → 8_000 (follows the envelope)",
    marker: "export const SCAN_TICK_DEADLINE_MS = 8_000;",
    old: [
      " * gates always reaches the send.",
      " */",
      "export const SCAN_TICK_DEADLINE_MS = 4_200;",
    ].join("\n"),
    neu: [
      " * gates always reaches the send.",
      SCAN_DEADLINE_ADDENDUM,
    ].join("\n"),
  },
  {
    file: TEST_PATH,
    name: "tests: the plan budget is the pinned platform fact",
    marker: "assert.equal(SUBREQ_BUDGET, 1_000);",
    old: [
      "    // 50 subrequests per invocation is Workers Free's documented cap and the",
      "    // number every reading in /health.heartbeat.subreqs is spent against; the",
      "    // runtime's throw is what kills a tick before its completion flush.",
      "    assert.equal(SUBREQ_BUDGET_FREE, 50);",
    ].join("\n"),
    neu: [
      "    // 1,000 subrequests per invocation is the Workers Paid allowance the",
      "    // Worker runs on since 2026-09-28, and the number every reading in",
      "    // /health.heartbeat.subreqs is spent against; the runtime's throw is what",
      "    // kills a tick before its completion flush, and at this size what a tick",
      "    // drops is decided by the scan's own floors rather than by the platform.",
      "    assert.equal(SUBREQ_BUDGET, 1_000);",
      "    // 50 is Workers Free's documented cap, kept as the reference every reading",
      "    // taken before that date was measured against.",
      "    assert.equal(SUBREQ_BUDGET_FREE, 50);",
    ].join("\n"),
  },
  {
    file: TEST_PATH,
    name: "tests: the probe pin names the plan budget",
    marker: '"exportfunctionsubreqRemaining(budget:number=SUBREQ_BUDGET):number{"',
    old: '        "exportfunctionsubreqRemaining(budget:number=SUBREQ_BUDGET_FREE):number{",',
    neu: '        "exportfunctionsubreqRemaining(budget:number=SUBREQ_BUDGET):number{",',
  },
  {
    file: TEST_PATH,
    name: "tests: the view pin names the plan budget",
    marker: 'subreqsSrc.includes("usable:Math.max(0,SUBREQ_BUDGET-SUBREQ_UNSEEN_ALLOWANCE),")',
    old: '        subreqsSrc.includes("usable:Math.max(0,SUBREQ_BUDGET_FREE-SUBREQ_UNSEEN_ALLOWANCE),"),',
    neu: '        subreqsSrc.includes("usable:Math.max(0,SUBREQ_BUDGET-SUBREQ_UNSEEN_ALLOWANCE),"),',
  },
  {
    file: TEST_PATH,
    name: "tests: the unseen-reserve test reads the plan budget",
    marker: "assert.equal(view.budget, SUBREQ_BUDGET, \"the platform fact is still published as-is\");",
    old: [
      "    assert.equal(view.budget, 50, \"the platform fact is still published as-is\");",
      "    assert.equal(view.unseenAllowance, 12, \"and so is the reserve, so the arithmetic is auditable\");",
      "    assert.equal(view.usable, 38, \"the ceiling a tick actually spends against\");",
    ].join("\n"),
    neu: [
      "    assert.equal(view.budget, SUBREQ_BUDGET, \"the platform fact is still published as-is\");",
      "    assert.equal(view.unseenAllowance, 12, \"and so is the reserve, so the arithmetic is auditable\");",
      "    assert.equal(",
      "      view.usable,",
      "      SUBREQ_BUDGET - SUBREQ_UNSEEN_ALLOWANCE,",
      "      \"the ceiling a tick actually spends against\",",
      "    );",
    ].join("\n"),
  },
  {
    file: TEST_PATH,
    name: "tests: the spendable-room test reads the plan budget",
    marker: "SUBREQ_BUDGET - SUBREQ_UNSEEN_ALLOWANCE - 30,",
    old: [
      "    assert.equal(",
      "      subreqRemaining(),",
      "      38,",
      "      \"a fresh window reports the USABLE ceiling, not 50 — a caller must not believe it has 12 more than it does\",",
      "    );",
      "    for (let i = 0; i < 30; i += 1) countSubreq();",
      "    assert.equal(subreqRemaining(), 8, \"spendable room falls with the counted calls\");",
    ].join("\n"),
    neu: [
      "    assert.equal(",
      "      subreqRemaining(),",
      "      SUBREQ_BUDGET - SUBREQ_UNSEEN_ALLOWANCE,",
      "      \"a fresh window reports the USABLE ceiling, not the raw budget — a caller must not believe it has 12 more than it does\",",
      "    );",
      "    for (let i = 0; i < 30; i += 1) countSubreq();",
      "    assert.equal(",
      "      subreqRemaining(),",
      "      SUBREQ_BUDGET - SUBREQ_UNSEEN_ALLOWANCE - 30,",
      "      \"spendable room falls with the counted calls\",",
      "    );",
    ].join("\n"),
  },
  {
    file: TEST_PATH,
    name: "tests: the exhausted-window test keeps the free reading as arithmetic",
    marker: "assert.equal(SUBREQ_BUDGET_FREE - SUBREQ_UNSEEN_ALLOWANCE - 38, 0);",
    old: [
      "    assert.equal(subreqRemaining(), 0, \"so the pass would have been refused before it could overrun\");",
    ].join("\n"),
    neu: [
      "    assert.equal(",
      "      subreqRemaining(),",
      "      SUBREQ_BUDGET - SUBREQ_UNSEEN_ALLOWANCE - 38,",
      "      \"so the pass is nowhere near a refusal on the plan budget\",",
      "    );",
      "    // The reading the reserve was SIZED from, kept as arithmetic: on the free",
      "    // allowance the same 38 counted calls left exactly 0, which is what the",
      "    // row and stage gates needed to see. On the paid allowance they leave 950.",
      "    assert.equal(SUBREQ_BUDGET_FREE - SUBREQ_UNSEEN_ALLOWANCE - 38, 0);",
      "    assert.equal(SUBREQ_BUDGET - SUBREQ_UNSEEN_ALLOWANCE - 38, 950);",
    ].join("\n"),
  },
  {
    file: TEST_PATH,
    name: "tests: the send-deadline boundaries follow the scan deadline",
    marker: "const tail = t0 + SCAN_TICK_DEADLINE_MS + 200;",
    old: [
      "    const t0 = 1_000_000;",
      "    // Healthy: unchanged from the pre-fix behaviour — the send still runs to",
      "    // the tick's own internal deadline (4.2s), because the floor is only a",
      "    // minimum slice, not a cap.",
      "    assert.equal(cardSendDeadline(t0, t0 + 2_000), t0 + 4_200);",
      "    assert.equal(cardSendDeadline(t0, t0 + 3_000), t0 + 4_200);",
      "    // Late but still usable: clamped by the tail, not by `now + floor`.",
      "    assert.equal(cardSendDeadline(t0, t0 + 4_000), t0 + 4_400);",
      "    // The live 2026-09-18 03:44:18Z shape — the send started 4309ms in while",
      "    // that tick's race window was 4742ms. The old `max(tickDeadline, now +",
      "    // 600)` granted it until 4909ms, past the window, and the tick died at",
      "    // 5000ms with the second candidate unsent; now it is refused instead.",
      "    assert.equal(cardSendDeadline(t0, t0 + 4_309), null);",
      "    // Boundary: exactly the minimum slice is still attempted, one ms more is",
      "    // not (the card is deferred, not dropped).",
      "    assert.equal(cardSendDeadline(t0, t0 + 4_150), t0 + 4_400);",
      "    assert.equal(cardSendDeadline(t0, t0 + 4_151), null);",
      "    // A tick already past the tail can never start one.",
      "    assert.equal(cardSendDeadline(t0, t0 + 9_000), null);",
    ].join("\n"),
    neu: [
      "    const t0 = 1_000_000;",
      "    // CARD_SEND_TAIL_MS is SCAN_TICK_DEADLINE_MS + 200 (scanner.ts): a send may",
      "    // run 200ms past the tick's internal deadline and no further. Both numbers",
      "    // are read off the constant here rather than copied, so the 2026-09-28",
      "    // raise to 8_000 moves this test with it instead of breaking it.",
      "    const tail = t0 + SCAN_TICK_DEADLINE_MS + 200;",
      "    // Healthy: unchanged from the pre-fix behaviour — the send still runs to",
      "    // the tick's own internal deadline, because the floor is only a minimum",
      "    // slice, not a cap.",
      "    assert.equal(cardSendDeadline(t0, t0 + 2_000), t0 + SCAN_TICK_DEADLINE_MS);",
      "    assert.equal(cardSendDeadline(t0, t0 + 3_000), t0 + SCAN_TICK_DEADLINE_MS);",
      "    // Late but still usable: clamped by the tail, not by `now + floor`.",
      "    assert.equal(cardSendDeadline(t0, tail - 400), tail);",
      "    // The live 2026-09-18 03:44:18Z shape — the send started 4309ms in while",
      "    // that tick's race window was 4742ms: the old `max(tickDeadline, now +",
      "    // 600)` granted it until 4909ms, past the window, and the tick died at",
      "    // 5000ms with the second candidate unsent. Under the free envelope",
      "    // (deadline 4_200, tail 4_400) it was refused — 91ms of slice left — and",
      "    // under the paid one the same start is inside the deadline.",
      "    assert.equal(cardSendDeadline(t0, t0 + 4_309), t0 + SCAN_TICK_DEADLINE_MS);",
      "    // Boundary: exactly the minimum slice is still attempted, one ms more is",
      "    // not (the card is deferred, not dropped).",
      "    assert.equal(cardSendDeadline(t0, tail - 250), tail);",
      "    assert.equal(cardSendDeadline(t0, tail - 249), null);",
      "    // A tick already past the tail can never start one.",
      "    assert.equal(cardSendDeadline(t0, t0 + 9_000), null);",
      "    assert.equal(cardSendDeadline(t0, tail + 1), null);",
    ].join("\n"),
  },
  {
    file: TEST_PATH,
    name: "tests: the claim-deadline boundaries follow the scan deadline",
    marker: "assert.equal(cardClaimDeadline(t0, t0 + 3_792), t0 + 4_192);",
    old: [
      "    assert.equal(cardClaimDeadline(t0, t0 + 3_550), t0 + 3_950);",
      "    assert.equal(cardClaimDeadline(t0, t0 + 3_551), null);",
      "    // The live shape this exists for (2026-09-18 04:32:18Z): the chain",
      "    // reached the claim at 3.79s with 608ms of tail left, the claim's own",
      "    // cap is 1200ms, and the tick died at 5000ms with `pushPhase",
      "    // send:claim`. It is now deferred before anything is written.",
      "    assert.equal(cardClaimDeadline(t0, t0 + 3_792), null);",
      "    // Past the send tail as well.",
      "    assert.equal(cardClaimDeadline(t0, t0 + 4_200), null);",
    ].join("\n"),
    neu: [
      "    // Same 200ms tail as the send pair above, read off the constant.",
      "    const tail = t0 + SCAN_TICK_DEADLINE_MS + 200;",
      "    // Boundary: exactly 650ms of tail, one ms less is refused.",
      "    assert.equal(cardClaimDeadline(t0, tail - 850), tail - 850 + 400);",
      "    assert.equal(cardClaimDeadline(t0, tail - 849), null);",
      "    // The live shape this exists for (2026-09-18 04:32:18Z): the chain",
      "    // reached the claim at 3.79s with 608ms of tail left, the claim's own",
      "    // cap is 1200ms, and the tick died at 5000ms with `pushPhase",
      "    // send:claim`. The free envelope refused that start (608 < 650 + 400);",
      "    // the paid one leaves it room, so the refusal now lives only in the",
      "    // send tail's last 850ms.",
      "    assert.equal(cardClaimDeadline(t0, t0 + 3_792), t0 + 4_192);",
    ].join("\n"),
  },
  // LAST on purpose: this is the fix-up for the one line above that was written
  // in the relative form and double-counted t0. It runs after that edit in both
  // directions — on a tree the block was already installed into, the block's
  // marker matches (no-op) and this repairs the line; on a fresh checkout the
  // block lands with the correct line and this reports "=".
  {
    file: TEST_PATH,
    name: "tests: the claim boundary is expressed in absolute ms",
    marker: "assert.equal(cardClaimDeadline(t0, tail - 850), tail - 850 + 400);",
    old: "    assert.equal(cardClaimDeadline(t0, tail - 850), t0 + (tail - 850) + 400);",
    neu: "    assert.equal(cardClaimDeadline(t0, tail - 850), tail - 850 + 400);",
  },
];

// ---------------------------------------------------------------------------
// Apply.
// ---------------------------------------------------------------------------
const files = new Map();
for (const p of [SUBREQ_PATH, WORKER_PATH, SCANNER_PATH, TEST_PATH]) {
  files.set(p, fs.readFileSync(p, "utf8"));
}
const written = files;

for (const edit of EDITS) {
  const src = written.get(edit.file);
  const short = path.relative(root, edit.file);
  if (src.includes(edit.marker)) {
    report("=", `${short}: ${edit.name}`, "already applied");
    continue;
  }
  const hits = src.split(edit.old).length - 1;
  if (hits === 0) {
    report("✗", `${short}: ${edit.name}`, "anchor missing — file not touched");
    continue;
  }
  if (hits > 1) {
    report("✗", `${short}: ${edit.name}`, `anchor ambiguous (${hits} hits) — file not touched`);
    continue;
  }
  written.set(edit.file, src.replace(edit.old, edit.neu));
  report("✓", `${short}: ${edit.name}`);
}

// Post-conditions, read back off the text that would be written.
const subreqs = written.get(SUBREQ_PATH);
const worker = written.get(WORKER_PATH);
const scanner = written.get(SCANNER_PATH);
const tests = written.get(TEST_PATH);
const checks = [
  ["subreqs: plan budget is 1_000", subreqs.includes("export const SUBREQ_BUDGET = 1_000;")],
  ["subreqs: the free 50 is kept as a reference", subreqs.includes("export const SUBREQ_BUDGET_FREE = 50;")],
  ["subreqs: nothing spends against the free constant", !subreqs.includes("budget = SUBREQ_BUDGET_FREE") && !subreqs.includes("budget: SUBREQ_BUDGET_FREE")],
  ["worker: envelope is 20_000", worker.includes("export const SCAN_TICK_BUDGET_MS = 20_000;")],
  ["worker: lease is 30_000", worker.includes("const SCAN_LOCK_TTL_MS = 30_000;")],
  ["scanner: scan deadline is 8_000", scanner.includes("export const SCAN_TICK_DEADLINE_MS = 8_000;")],
  ["tests: the plan budget is pinned", tests.includes("assert.equal(SUBREQ_BUDGET, 1_000);")],
  ["tests: no pin reads the free constant as the spend", !tests.includes("budget:number=SUBREQ_BUDGET_FREE") && !tests.includes("usable:Math.max(0,SUBREQ_BUDGET_FREE")],
];
for (const [name, ok] of checks) report(ok ? "✓" : "✗", name);

// The scanner's arithmetic must still hold: the front window has to fit the
// front caps' worst case (900 + 1600 + 1000 = 3500).
const FRONT_CAP_SUM_MS = 900 + 1_600 + 1_000;
const GATE_RESERVE_MS = 1_600;
const frontWindowMs = 8_000 - GATE_RESERVE_MS;
const env = 20_000 - 4_500 - 8_000;
report(
  frontWindowMs >= FRONT_CAP_SUM_MS ? "✓" : "✗",
  "front window fits the front caps (6_400 >= 3_500)",
);
report(env > 0 ? "✓" : "✗", `race headroom above the scan deadline (${env}ms)`);

if (failed > 0 || checks.some(([, ok]) => !ok)) {
  console.log("\nNOTHING WRITTEN — fix the anchors above and re-run.");
  process.exit(1);
}

for (const [p, text] of files) fs.writeFileSync(p, written.get(p));
console.log("\nWritten: src/subreqs.ts, src/worker.ts, src/scanner.ts, scripts/test-unit.js");
