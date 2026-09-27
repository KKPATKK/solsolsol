#!/usr/bin/env node
/*
 * Out-of-window patch (2026-09-27): the tracker pass gets its OWN invocation.
 *
 * WHY (live 2026-09-27T01:31-01:57Z, on the deployed claim+reservation merge):
 * the pass is the LAST stage of the scan tick, so it is the residual claimant
 * of Workers Free's 50 subrequests (38 usable) — and the tick's front + scan +
 * flush spend 18-39 of them before the pass is offered anything. Measured:
 * `tickProgress {stage: "postscan", subreqs: 39}` with the pass then reading
 * `ok:0/0 deferred:subreq-budget trips 0` (its entry gate, no row touched),
 * and `defer-send 6 subreq-cut 6` on the thin ticks — every alerting row
 * refused at TRACKER_SUBREQ_RESERVE. The refusals tracked the SUBREQUEST
 * counter, not the clock and not Turso's latency (`db 110ms` refused 10 rows,
 * `db 3421ms` refused 6, no sampled pass ever said `budget-cut`), and a card
 * costs ~4-5 subrequests, so a claimant holding single digits delivers 0-1
 * cards a minute however cheap a card gets.
 *
 * WHAT THIS CHANGES
 *  - wrangler.toml gains a second `[triggers].crons` expression, the tracker
 *    pass's own delivery (worker.TRACKER_CRON, matched character for character
 *    — Cloudflare hands over the exact configured string).
 *  - worker.scheduled routes that delivery to runTrackerInvocation: init, then
 *    ONE pass with the full budget and the invocation's whole window. No scan
 *    lock, no cadence gate, no scan heartbeat, no cron-arrival bookkeeping.
 *  - The scan tick keeps a FALLBACK pass, taken only when the durable pass row
 *    is older than TRACKER_PASS_FALLBACK_FRESH_MS, read for FREE from its own
 *    scan front (SCAN_FRONT_GATE_KEYS) — so a trigger the platform stops
 *    delivering (which this Worker has already lived through, see
 *    docs/uptime-monitor.md) costs the pass cadence, never the cards.
 *  - The pass row records WHO ran the pass (`via`), so the healthy shape and
 *    the fallback are both readable from /health.
 *
 * Run: node docs/patches/tracker-own-invocation-2026-09-27.apply.js
 * Idempotent: each edit reports "already applied" instead of rewriting.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");

/** One edit: a unique anchor, its replacement, and a check on the result. */
const EDITS = [];
function edit(name, file, find, replace, verify) {
  EDITS.push({ name, file, find, replace, verify });
}

const WORKER = "src/worker.ts";
const SCANNER = "src/scanner.ts";
const PUSHWATCH = "src/pushwatch.ts";
const DB = "src/db.ts";
const TESTS = "scripts/test-unit.js";

// ---------------------------------------------------------------- worker.ts

edit(
  "worker: TRACKER_CRON + isTrackerCron + the fallback window",
  WORKER,
  "export const TRACKER_PASS_SUBREQ_RESERVE = 12;",
  `export const TRACKER_PASS_SUBREQ_RESERVE = 12;
/**
 * The tracker pass's OWN cron delivery — the second \`[triggers].crons\`
 * expression in wrangler.toml, and the one thing that gives the pass a
 * 50-subrequest invocation of its own.
 *
 * WHY A SEPARATE INVOCATION (live 2026-09-27T01:31-01:57Z, measured against
 * the deployed claim+reservation merge): the pass shares the scan tick's
 * allowance as its LAST stage, so it never sees more than what the tick has
 * left — and the tick's front + scan + flush spend 18-39 of the 38 usable
 * subrequests before the pass is offered anything (\`heartbeat.subreqs.usable
 * 38\`; \`tickProgress {stage: "postscan", subreqs: 39}\`). The stage split then
 * shows the pass paying for it by name: \`ok:0/0 deferred:subreq-budget trips
 * 0\` on the fat ticks (its entry gate, not one row touched), and
 * \`defer-send 6 subreq-cut 6\` on the thin ones — every alerting row refused at
 * TRACKER_SUBREQ_RESERVE after the pass had already spent its slice. The
 * refusal count tracked the SUBREQUEST counter, not the clock and not Turso's
 * latency: \`db 110ms\` refused 10 rows while \`db 3421ms\` refused 6, and no
 * sampled pass ever said \`budget-cut\`.
 *
 * A card costs the counter ~4-5 subrequests (the claim+reservation batch, the
 * Telegram send, the delivery-audit read AND its write, the final check
 * write), so a residual claimant holding single digits delivers 0-1 cards a
 * minute however cheap one card gets — which is exactly the \`alerted 0\`-\`1\`
 * every sampled pass read. In its own invocation the pass pays init plus its
 * own work and nothing else: the scan stops lending it anything, and the same
 * pass meets the same rotation with ~30 subrequests in hand instead of ~6.
 *
 * \`event.cron\` carries the trigger's expression CHARACTER FOR CHARACTER (see
 * Cloudflare's scheduled-handler docs), so the comparison below is exact — and
 * with two triggers configured, a string this constant does not match is a
 * scan tick, never a silently dropped delivery (see runTrackerInvocation's
 * fallback note).
 */
export const TRACKER_CRON = "*/1 * * * *";
/**
 * Pure: is this scheduled delivery the tracker pass's own invocation?
 *
 * Trims only the OUTSIDE of the string: the platform matches its configured
 * expression exactly, so an expression that differs inside (\`*/1  *  *  *  *\`)
 * is a trigger this Worker does not claim — and defaulting those to the pass
 * would hand a stranger's delivery the pass's budget while the scan tick's
 * own routing silently stopped matching.
 */
export function isTrackerCron(cron: string | null | undefined): boolean {
  return typeof cron === "string" && cron.trim() === TRACKER_CRON;
}
/**
 * How stale the durable pass row has to be before the SCAN TICK runs the pass
 * itself (the fallback, see runTrackerInvocation).
 *
 * WHY IT EXISTS AT ALL: the platform has silently stopped delivering cron
 * events to this Worker before (docs/uptime-monitor.md, and the community
 * reports it links), and a pass nobody runs is the one failure the tracker
 * cannot report on its own — the row would simply stop moving. The pass's own
 * delivery is therefore an OWNER, not a requirement: the tick takes over
 * whenever the row is older than this.
 *
 * WHY 2 MINUTES: the healthy shape is the pass delivery writing the row every
 * ~60s, and the tick reads the row from its own scan FRONT
 * (SCAN_FRONT_GATE_KEYS, read ~3-5s into the tick, i.e. up to one full minute
 * older than the pass delivery's newest write). 120s is that minute plus the
 * whole cron period, so a late tick still yields — and a dead delivery costs a
 * pass roughly every 3 minutes, which is the fallback's degraded cadence, not
 * a stop. Measured against the live readings this replaces: a pass that runs
 * every 3 minutes while the trigger is down still covers the 30-row rotation
 * (the very passes that read \`rows 24-30/30\`), whereas 0-1 cards a minute was
 * the shape that made the split necessary.
 */
export const TRACKER_PASS_FALLBACK_FRESH_MS = 120_000;`,
  (src) => src.includes("export const TRACKER_CRON = \"*/1 * * * *\";"),
);

edit(
  "worker: the pass's own delivery runs init + ONE pass, and measures nothing else",
  WORKER,
  `async function runScan(
  prevHeartbeatRawArg?: string | null,`,
  `/**
 * The tracker pass's own invocation (see TRACKER_CRON and wrangler.toml).
 *
 * WHAT IT DOES: init, then ONE pass with the full TRACKER_PASS_BUDGET_MS and
 * the invocation's whole subrequest window to itself. Nothing else — no scan
 * lock, no cadence gate, no scan heartbeat, no cron-arrival bookkeeping, and
 * none of the tick tail's telemetry (the scan tick still owns all of that, and
 * still runs every minute). The point of the split is that this delivery
 * spends its 38 usable subrequests on the rotation instead of lending the
 * scan's leftovers to it: measured live, the tick's pass ran on 0-6 of them
 * (\`ok:0/0 deferred:subreq-budget\`, \`defer-send N subreq-cut N\`).
 *
 * WHY THE PASS STILL HAS A FALLBACK: this trigger's expression is new, and
 * this platform has silently stopped delivering cron events to this Worker
 * before (docs/uptime-monitor.md). The pass's durable row IS the ownership
 * clock — a scan tick runs the pass itself once that row is older than
 * TRACKER_PASS_FALLBACK_FRESH_MS (see Scanner.runTrackerPass) — so the worst
 * case is the pass cadence, never a card that nobody announces. For the same
 * reason a failure here is only logged: the next delivery (this one or a tick)
 * picks the pass up, and the row keeps saying when it last really ran.
 */
async function runTrackerInvocation(env: Env): Promise<void> {
  const initAt = Date.now();
  await recoveryAwait(ensureInitialized(env), FRONT_INIT_BOUND_MS, "init");
  preTick.steps.init = Date.now() - initAt;
  // No scanner = init failed or was cut. Nothing to record: this delivery is
  // not a scan arrival, and the pass row is what says whether a pass ran.
  if (!scanner) return;
  // The tick's waitUntil hand-off, for the same reason the tick passes it (see
  // pushwatch.holdForTick): a CUT card's delivery proof is an un-awaited promise
  // created at the pass's tail, and an un-awaited promise is cancelled the
  // moment the handler returns.
  const hold = tickWaitUntil;
  try {
    await scanner.runTrackerPass(
      Date.now() + TRACKER_PASS_BUDGET_MS,
      hold ? (p: Promise<unknown>) => hold(p) : undefined,
      subreqRemaining,
      { via: "cron-pass" },
    );
  } catch (err) {
    // A pass can also be killed mid-flight (no catch ever runs), which is why
    // the pulse rides every heartbeat — see the tick path's own report.
    console.error(
      "[worker] tracker delivery pass failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function runScan(
  prevHeartbeatRawArg?: string | null,`,
  (src) => src.includes("async function runTrackerInvocation(env: Env): Promise<void> {"),
);

edit(
  "worker: scheduled routes the pass's delivery before any scan bookkeeping",
  WORKER,
  `  async scheduled(
    _event: ScheduledEventLike,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    // Keep the invocation open for the tick's deferred writes (see
    // tickWaitUntil): a fire-and-forget drain is cancelled when the handler
    // returns — the 100%-failure shape measured above.
    beginPreTick(Date.now());
    tickWaitUntil = (promise) => ctx.waitUntil(promise);
    scheduledTicks++;`,
  `  async scheduled(
    event: ScheduledEventLike,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<void> {
    // Keep the invocation open for the tick's deferred writes (see
    // tickWaitUntil): a fire-and-forget drain is cancelled when the handler
    // returns — the 100%-failure shape measured above. The tracker's own
    // delivery enters through this same prologue on purpose: a pass needs a
    // subrequest window of its own (beginSubreqWindow, see src/subreqs.ts) and
    // the waitUntil that keeps a CUT card's delivery proof alive, and neither
    // of those is scan-specific.
    beginPreTick(Date.now());
    tickWaitUntil = (promise) => ctx.waitUntil(promise);
    // THE TRACKER'S OWN DELIVERY (see TRACKER_CRON): the pass, and nothing
    // else. It returns BEFORE scheduledTicks, the cron-arrival stamp and the
    // cadence gate, because all three count SCAN arrivals — the injected
    // cadence gate and the outage check both compare them, so a delivery that
    // never scans must not move them. This delivery's own liveness is the pass
    // row it writes (see runTrackerInvocation, and the tick's fallback).
    if (isTrackerCron(event.cron)) {
      await runTrackerInvocation(env);
      return;
    }
    scheduledTicks++;`,
  (src) => src.includes("if (isTrackerCron(event.cron)) {"),
);

edit(
  "worker: the tick's pass call carries the fallback window and its `via`",
  WORKER,
  `            subreqRemaining,
          );
          // The pass returned: its rotation ran, so the last failure is history.`,
  `            subreqRemaining,
            // FALLBACK ONLY (see TRACKER_CRON and runTrackerInvocation): this
            // tick runs a pass of its own only when the pass's OWN delivery has
            // not written the durable row inside this window. In the healthy
            // shape that row is seconds old here, so the pass stands down and
            // the tick keeps every subrequest it has for the scan — and if the
            // second cron expression ever stops being delivered, this same call
            // takes the rotation over within two minutes, so the cards never
            // depend on the new trigger.
            {
              peerPassFreshMs: TRACKER_PASS_FALLBACK_FRESH_MS,
              via: "tick",
            },
          );
          // The pass returned: its rotation ran, so the last failure is history.`,
  (src) => src.includes("peerPassFreshMs: TRACKER_PASS_FALLBACK_FRESH_MS,"),
);

// --------------------------------------------------------------- scanner.ts

edit(
  "scanner: the pass row's owner helpers come in from pushwatch",
  SCANNER,
  `import { PushWatcher, liquidityIsComparable } from "./pushwatch";`,
  `import {
  PushWatcher,
  TRACKER_PASS_STATE_KEY,
  liquidityIsComparable,
  notePeerPassYield,
  passRowAgeMs,
} from "./pushwatch";`,
  (src) => src.includes("  passRowAgeMs,\n} from \"./pushwatch\";"),
);

edit(
  "scanner: TrackerPassRunOptions names the two owners",
  SCANNER,
  "export class Scanner {",
  `/**
 * How a tracker pass was started (see Scanner.runTrackerPass, and
 * worker.TRACKER_CRON for the two owners).
 */
export interface TrackerPassRunOptions {
  /**
   * The ownership window, in ms: a caller that SHARES the minute with the
   * pass's own cron delivery passes it here, and then stands down when the
   * durable pass row (captured from this tick's scan front, see peerPassRow)
   * is younger than it. The pass's own delivery passes nothing and owns the
   * minute outright.
   */
  peerPassFreshMs?: number;
  /**
   * Where this pass came from, recorded in the row. Omitted by a caller that
   * does not say (every test), which keeps the row's shape unchanged.
   */
  via?: "cron-pass" | "tick";
}

export class Scanner {`,
  (src) => src.includes("export interface TrackerPassRunOptions {"),
);

edit(
  "scanner: peerPassRow keeps the pass row THIS tick's front read",
  SCANNER,
  "  private scanFront: ScanFront | null = null;",
  `  private scanFront: ScanFront | null = null;
  /**
   * The tracker pass's row as THIS tick's front read it (see
   * SCAN_FRONT_GATE_KEYS, which carries it for free — one IN-list either way).
   *
   * WHY ITS OWN FIELD, and not scanFront: the front is cleared at the end of
   * the scan on purpose ("a later tick must never read a stale gate"), and the
   * pass runs AFTER the scan. This one outlives that clear for exactly as long
   * as the pass needs — it is overwritten by the next tick's front read, and it
   * is the ONLY thing the fallback pass consults, so a tick that never scanned
   * (standalone Scanner, a test) reads null and runs the pass, which is the
   * pre-split behaviour.
   */
  private peerPassRow: string | null = null;`,
  (src) => src.includes("private peerPassRow: string | null = null;"),
);

edit(
  "scanner: runTrackerPass takes the options and yields to a fresh peer",
  SCANNER,
  `  async runTrackerPass(
    deadlineMs: number,
    keepAlive?: (promise: Promise<unknown>) => void,
    subreqLeft?: () => number,
  ): Promise<string | null> {
    if (!this.pushWatcher) return null;
    const startedAt = Date.now();`,
  `  async runTrackerPass(
    deadlineMs: number,
    keepAlive?: (promise: Promise<unknown>) => void,
    subreqLeft?: () => number,
    options?: TrackerPassRunOptions,
  ): Promise<string | null> {
    if (!this.pushWatcher) return null;
    const startedAt = Date.now();
    // THE OWNERSHIP WINDOW (see worker.TRACKER_CRON and its
    // TRACKER_PASS_FALLBACK_FRESH_MS): the pass has its own cron delivery now,
    // and a scan tick that shares the minute with it stands down when a pass
    // ran inside the window. The reading is THIS tick's front row, so the
    // decision costs no round trip — and, in the healthy shape, halting here is
    // what lets the tick spend its whole subrequest budget on the scan the way
    // it did before the pass existed.
    const peerPassFreshMs = options?.peerPassFreshMs ?? 0;
    if (peerPassFreshMs > 0) {
      const ageMs = passRowAgeMs(this.peerPassRow, startedAt);
      if (ageMs !== null && ageMs < peerPassFreshMs) {
        const note = \`yield:peer-pass \${Math.round(ageMs / 1000)}s\`;
        // Published, never persisted: the pass row's stamp IS the ownership
        // clock, so a yield that re-wrote it would keep the fallback asleep
        // forever — a dead trigger could then never be noticed, which is the
        // one failure the split must not introduce (see passRowAgeMs, which
        // also refuses to count a "skip" row for the same reason).
        this.pushWatchNote = note;
        if (this.lastSummary) {
          this.lastSummary.pushWatch = note;
          this.lastSummary.trackerMs = Date.now() - startedAt;
        }
        notePeerPassYield(startedAt, ageMs);
        return note;
      }
    }`,
  (src) => src.includes("const peerPassFreshMs = options?.peerPassFreshMs ?? 0;"),
);

edit(
  "scanner: the front read captures the pass row for the fallback",
  SCANNER,
  `      const front = await frontRead;
      this.scanFront = front;`,
  `      const front = await frontRead;
      this.scanFront = front;
      // The pass's row, for the tick's fallback decision after this scan (see
      // peerPassRow): read from the SAME statement the front's gates ride, so
      // the fallback costs no round trip of its own.
      this.peerPassRow = front.gates.get(TRACKER_PASS_STATE_KEY) ?? null;`,
  (src) => src.includes("this.peerPassRow = front.gates.get(TRACKER_PASS_STATE_KEY) ?? null;"),
);

edit(
  "scanner: the cut note records which owner ran the pass",
  SCANNER,
  `        await this.persistPassNote(cutNote, startedAt, "cut");`,
  `        await this.persistPassNote(cutNote, startedAt, "cut", options?.via);`,
  (src) => src.includes('await this.persistPassNote(cutNote, startedAt, "cut", options?.via);'),
);

edit(
  "scanner: the pass note records which owner ran the pass",
  SCANNER,
  `      await this.persistPassNote(note, startedAt);
      return note;`,
  `      await this.persistPassNote(note, startedAt, "done", options?.via);
      return note;`,
  (src) => src.includes('await this.persistPassNote(note, startedAt, "done", options?.via);'),
);

edit(
  "scanner: the thrown pass's note records which owner ran it",
  SCANNER,
  `      await this.persistPassNote(errNote, startedAt);
      return null;`,
  `      await this.persistPassNote(errNote, startedAt, "done", options?.via);
      return null;`,
  (src) => src.includes('await this.persistPassNote(errNote, startedAt, "done", options?.via);'),
);

edit(
  "scanner: persistPassNote takes (and writes) the owner",
  SCANNER,
  `    phase: "done" | "skip" | "cut" = "done",
  ): Promise<void> {`,
  `    phase: "done" | "skip" | "cut" = "done",
    /**
     * Which invocation this pass came from (see worker.TRACKER_CRON): the
     * tracker's own cron delivery ("cron-pass") or a scan tick ("tick", the
     * fallback). Recorded ONLY when the caller says, so the row of a caller
     * that does not (every test, and any older caller) keeps its exact shape.
     */
    via?: "cron-pass" | "tick",
  ): Promise<void> {`,
  (src) => src.includes("    via?: \"cron-pass\" | \"tick\",\n  ): Promise<void> {"),
);

edit(
  "scanner: the row carries the owner when there is one",
  SCANNER,
  `      await this.db.setWorkerState(
        "push_watch_pass",
        JSON.stringify({
          at: Date.now(),
          note,
          trackerMs: phase === "skip" ? 0 : Date.now() - startedAt,
          phase,
        }),
      );`,
  `      await this.db.setWorkerState(
        "push_watch_pass",
        JSON.stringify({
          at: Date.now(),
          note,
          trackerMs: phase === "skip" ? 0 : Date.now() - startedAt,
          phase,
          // Omitted unless the caller says where the pass came from, so the
          // ownership clock (see passRowAgeMs) never has to parse a field it
          // does not use and the row a test writes stays byte-for-byte the same.
          ...(via ? { via } : {}),
        }),
      );`,
  (src) => src.includes("...(via ? { via } : {}),"),
);

edit(
  "scanner: a tick's skip note says which owner was asked",
  SCANNER,
  "    await this.persistPassNote(`skip:${reason}`, Date.now(), \"skip\");",
  "    await this.persistPassNote(`skip:${reason}`, Date.now(), \"skip\", \"tick\");",
  (src) => src.includes('await this.persistPassNote(`skip:${reason}`, Date.now(), "skip", "tick");'),
);

// ------------------------------------------------------------- pushwatch.ts

edit(
  "pushwatch: passRowAgeMs + notePeerPassYield (the ownership clock's readers)",
  PUSHWATCH,
  `export function runningPassStamp(now = Date.now()): string {
  return JSON.stringify({ at: now, note: "running", trackerMs: 0, phase: "running" });
}`,
  `export function runningPassStamp(now = Date.now()): string {
  return JSON.stringify({ at: now, note: "running", trackerMs: 0, phase: "running" });
}

/**
 * How long ago the durable pass row's stamp was written, or null when the row
 * cannot answer — the reading behind a tick's decision to stand down for the
 * pass's own cron delivery (see worker.TRACKER_PASS_FALLBACK_FRESH_MS).
 *
 * THREE WAYS A ROW DOES NOT ANSWER, all deliberate:
 *  - ABSENT, unparsable or without a usable \`at\`: nobody has run a pass on this
 *    database, so the caller must RUN one. Failing the other way (treating an
 *    unknown row as fresh) is the one shape that can stop every card.
 *  - \`phase: "skip"\`: the row of a tick that ran NO pass (noteTrackerSkipped).
 *    It carries a fresh \`at\`, so counting it would let a run of skipped ticks
 *    hold the ownership window forever while no card was ever announced.
 *  - A stamp from the FUTURE reads 0 (fresh), never negative: \`at\` comes from
 *    another invocation's clock, and a skew must not open the window for a
 *    second pass in the same minute.
 */
export function passRowAgeMs(
  raw: string | null | undefined,
  now: number,
): number | null {
  if (!raw) return null;
  let row: unknown;
  try {
    row = JSON.parse(raw);
  } catch {
    return null;
  }
  if (row === null || typeof row !== "object") return null;
  const rec = row as { at?: unknown; phase?: unknown };
  if (rec.phase === "skip") return null;
  const at = Number(rec.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  return Math.max(0, now - at);
}

/**
 * Publish a pass that YIELDED to a peer: the scan tick's fallback stood down
 * because the pass's own cron delivery had already run one inside the window
 * (see Scanner.runTrackerPass).
 *
 * It starts and closes a pulse of its own rather than leaving the previous
 * pass's pulse standing, so /health's \`pushWatchLive\` answers which of the two
 * owners served this minute. Nothing is written durably — the pass row belongs
 * to the pass that actually ran, and that row is the ownership clock.
 */
export function notePeerPassYield(at: number, ageMs: number): void {
  beginPassPulse(at);
  notePassPulse({
    stage: "peer-pass",
    doneAt: Date.now(),
    note: \`yield:peer-pass \${Math.round(ageMs / 1000)}s\`,
  });
}`,
  (src) => src.includes("export function passRowAgeMs("),
);

edit(
  "pushwatch: the pulse's stage list names the yield",
  PUSHWATCH,
  "  /** The pass's stage name: entry / setup / settle / heal / rows / holders. */",
  "  /**\n   * The pass's stage name: entry / setup / settle / heal / rows / holders —\n   * plus \"peer-pass\", the stage a tick's fallback leaves behind when it stands\n   * down for the pass's own cron delivery (see notePeerPassYield).\n   */",
  (src) => src.includes('plus "peer-pass", the stage a tick\'s fallback leaves behind'),
);

// -------------------------------------------------------------------- db.ts

edit(
  "db: the scan front carries the pass row (free — same IN-list)",
  DB,
  `export const SCAN_FRONT_GATE_KEYS = [
  "schema_alter_v2_done",
  "token_stats_last_prune",
  "birdeye_backfill_at",
  DEX_PROFILES_LAST_KEY,
] as const;`,
  `export const SCAN_FRONT_GATE_KEYS = [
  "schema_alter_v2_done",
  "token_stats_last_prune",
  "birdeye_backfill_at",
  DEX_PROFILES_LAST_KEY,
  // The tracker pass's own row (pushwatch.TRACKER_PASS_STATE_KEY, spelled as
  // the literal because that module imports THIS one). It is READ, not gated
  // on: a tick's fallback pass asks it whether the pass's own cron delivery
  // already ran this minute (see worker.TRACKER_PASS_FALLBACK_FRESH_MS), and
  // riding this statement is what makes that question cost no round trip — the
  // IN-list is one row longer, not one request longer.
  "push_watch_pass",
] as const;`,
  (src) => src.includes('  "push_watch_pass",\n] as const;'),
);

// ------------------------------------------------------------- test-unit.js

edit(
  "tests: the pass call pins cover both owners",
  TESTS,
  `      "worker (the tick supplies the counter)": workerSrc.includes(
        "awaitscanner.runTrackerPass(Date.now()+trackerBudgetMs,holdTick?(p:Promise<unknown>)=>holdTick(p):undefined,subreqRemaining,);",
      ),`,
  `      "worker (the tick supplies the counter, and the fallback window)":
        workerSrc.includes(
          'awaitscanner.runTrackerPass(Date.now()+trackerBudgetMs,holdTick?(p:Promise<unknown>)=>holdTick(p):undefined,subreqRemaining,{peerPassFreshMs:TRACKER_PASS_FALLBACK_FRESH_MS,via:"tick",},);',
        ),
      "worker (the pass's own delivery runs ONE pass on its own budget)":
        workerSrc.includes(
          'awaitscanner.runTrackerPass(Date.now()+TRACKER_PASS_BUDGET_MS,hold?(p:Promise<unknown>)=>hold(p):undefined,subreqRemaining,{via:"cron-pass",},);',
        ),
      "worker (the scheduled handler routes that delivery before any scan bookkeeping)":
        workerSrc.includes(
          "if(isTrackerCron(event.cron)){awaitrunTrackerInvocation(env);return;}",
        ),`,
  (src) => src.includes("the pass's own delivery runs ONE pass on its own budget"),
);

edit(
  "tests: the pass's own invocation gets its own test block",
  TESTS,
  `  console.log("\\n===== UNIT TESTS =====");`,
  `  await test("passRowAgeMs: a row that cannot answer never holds the ownership window", () => {
    const { passRowAgeMs } = require("../dist/pushwatch.js");
    const now = 1_000_000;
    assert.equal(
      passRowAgeMs(JSON.stringify({ at: now - 5_000, phase: "done" }), now),
      5_000,
    );
    assert.equal(
      passRowAgeMs(JSON.stringify({ at: now - 5_000, phase: "running" }), now),
      5_000,
      "a pass in flight is a peer too — the window is about who owns the minute",
    );
    assert.equal(passRowAgeMs(null, now), null, "no row: nobody has run a pass, so the caller must run one");
    assert.equal(passRowAgeMs("not json", now), null);
    assert.equal(passRowAgeMs("null", now), null);
    assert.equal(passRowAgeMs("5", now), null, "a scalar row is not a pass row");
    assert.equal(
      passRowAgeMs(JSON.stringify({ note: "no clock" }), now),
      null,
      "the clock IS the answer",
    );
    assert.equal(passRowAgeMs(JSON.stringify({ at: 0, phase: "done" }), now), null);
    assert.equal(passRowAgeMs(JSON.stringify({ at: "soon", phase: "done" }), now), null);
    assert.equal(
      passRowAgeMs(JSON.stringify({ at: now - 5_000, phase: "skip" }), now),
      null,
      "a tick that ran NO pass must not hold the window — otherwise a run of skipped ticks keeps the fallback asleep while no card is announced",
    );
    assert.equal(
      passRowAgeMs(JSON.stringify({ at: now + 5_000, phase: "done" }), now),
      0,
      "a stamp from the future reads fresh, never negative — clock skew must not open a second pass in the same minute",
    );
  });

  await test("TRACKER_CRON: the pass's own delivery is routed, and wrangler.toml matches it character for character", () => {
    const { isTrackerCron, TRACKER_CRON, TRACKER_PASS_FALLBACK_FRESH_MS } =
      require("../dist/worker.js");
    assert.equal(TRACKER_CRON, "*/1 * * * *");
    assert.equal(isTrackerCron(TRACKER_CRON), true, "the pass's own delivery routes to the pass");
    assert.equal(isTrackerCron(" */1 * * * * "), true, "outside whitespace is trimmed");
    assert.equal(isTrackerCron("* * * * *"), false, "the scan trigger is NOT the pass's delivery");
    assert.equal(
      isTrackerCron("*/1  *  *  *  *"),
      false,
      "an expression that differs INSIDE is not this trigger: the platform matches character for character",
    );
    assert.equal(isTrackerCron(undefined), false);
    assert.equal(isTrackerCron(null), false);
    // The expression has to be configured, too: the platform hands over the
    // string it was given, so a constant wrangler.toml does not carry is a
    // delivery that never fires (survivable through the fallback, not correct).
    const toml = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8");
    const block = /^\\[triggers\\][\\s\\S]*?^crons\\s*=\\s*\\[([^\\]]*)\\]/m.exec(toml);
    assert.ok(block, "wrangler.toml must carry a [triggers].crons list");
    const list = block[1]
      .split(",")
      .map((s) => s.trim().replace(/^"|"$/g, ""))
      .filter((s) => s.length > 0);
    assert.ok(list.includes("* * * * *"), "the scan tick keeps its own expression");
    assert.ok(
      list.includes(TRACKER_CRON),
      \`the pass's delivery must be configured: \${TRACKER_CRON}\`,
    );
    assert.equal(
      isTrackerCron(list[0]),
      false,
      "the FIRST expression stays the scan tick — the tick's fallback assumes the pass expression is the new one",
    );
    assert.equal(TRACKER_PASS_FALLBACK_FRESH_MS, 120_000);
  });

  await test("Scanner.runTrackerPass: a fresh peer pass in the front makes the tick stand down, and writes nothing", async () => {
    const { Scanner } = require("../dist/scanner.js");
    const cfg = loadConfig({});
    const writes = [];
    const db = {
      setWorkerState: async (key, value) => {
        writes.push({ key, value });
      },
    };
    const scanner = new Scanner(
      db, { api: { sendMessage: async () => ({}) } }, null, cfg, null, null, null,
    );
    let ran = 0;
    scanner.pushWatcher = {
      headTokens: () => [],
      onPush: async () => {},
      runTick: async () => {
        ran += 1;
        return {
          checked: 1, alerted: 0, trips: 1,
          note: "rows 1/30 pairs 1/1 miss 0 lost 0 trips 1",
          undeliveredTotal: 0, recoveredUndelivered: 0,
        };
      },
    };
    scanner.lastSummary = {};
    const startedAt = Date.now();
    // THIS tick's front carried the pass's own cron delivery's row, four
    // seconds old — the healthy shape (see worker.TRACKER_CRON).
    scanner.peerPassRow = JSON.stringify({
      at: startedAt - 4_000,
      note: "ok:30/0 rows 30/30 pairs 30/30 miss 0 lost 0 trips 5 db 690ms",
      trackerMs: 690,
      phase: "done",
      via: "cron-pass",
    });
    const note = await scanner.runTrackerPass(startedAt + 2_500, undefined, undefined, {
      peerPassFreshMs: 120_000,
      via: "tick",
    });
    assert.match(String(note), /^yield:peer-pass 4s\\b/, "the tick says WHY it stood down");
    assert.equal(ran, 0, "a pass already ran this minute — the tick must not run a second one");
    assert.equal(
      writes.length,
      0,
      "and it must not touch the pass row: that stamp IS the ownership clock, so a yield that re-wrote it would keep the fallback asleep forever (a dead trigger could never be noticed)",
    );
    assert.equal(scanner.lastSummary.pushWatch, note, "the yield is published for /health");
    // STALE row = nobody owns this minute: the fallback runs the pass, and the
    // row it writes says which owner served it.
    scanner.peerPassRow = JSON.stringify({
      at: startedAt - 180_000,
      note: "ok:30/0 rows 30/30",
      trackerMs: 600,
      phase: "done",
      via: "cron-pass",
    });
    const fallbackNote = await scanner.runTrackerPass(startedAt + 2_500, undefined, undefined, {
      peerPassFreshMs: 120_000,
      via: "tick",
    });
    assert.equal(ran, 1, "the fallback is one missed delivery away, not a never-again");
    assert.match(String(fallbackNote), /^ok:1\\/0/, "and it is a real pass with a real note");
    assert.equal(writes.length, 1, "the note row is the fallback's ONE write");
    assert.equal(writes[0].key, "push_watch_pass");
    const row = JSON.parse(writes[0].value);
    assert.equal(row.phase, "done");
    assert.equal(row.via, "tick", "the row says which owner ran this pass");
    // NO options at all is the pass's OWN delivery (and every pre-split test):
    // the peer row must not stop it.
    ran = 0;
    writes.length = 0;
    scanner.peerPassRow = JSON.stringify({ at: Date.now() - 1_000, phase: "done" });
    const own = await scanner.runTrackerPass(Date.now() + 2_500, undefined, undefined, {
      via: "cron-pass",
    });
    assert.equal(ran, 1, "the pass's own delivery owns the minute outright");
    assert.match(String(own), /^ok:1\\/0/);
    assert.equal(JSON.parse(writes[0].value).via, "cron-pass");
  });

  console.log("\\n===== UNIT TESTS =====");`,
  (src) => src.includes('await test("TRACKER_CRON: the pass\'s own delivery is routed'),
);

// -------------------------------------------------------------------- apply

let applied = 0;
let skipped = 0;
for (const e of EDITS) {
  const file = path.join(root, e.file);
  const src = fs.readFileSync(file, "utf8");
  if (e.verify(src)) {
    console.log(` = ${e.name} — already applied`);
    skipped += 1;
    continue;
  }
  const count = src.split(e.find).length - 1;
  if (count !== 1) {
    throw new Error(`${e.name}: anchor matched ${count} times in ${e.file} (want exactly 1)`);
  }
  fs.writeFileSync(file, src.replace(e.find, e.replace));
  const back = fs.readFileSync(file, "utf8");
  if (!e.verify(back)) {
    throw new Error(`${e.name}: the write did not verify in ${e.file}`);
  }
  console.log(` ✓ ${e.name} — patched`);
  applied += 1;
}
console.log(`\n${applied} patched, ${skipped} already applied, ${EDITS.length} edits total`);
