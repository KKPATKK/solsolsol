/*
 * Anchored patch for the maintenance-cron split (2026-09-29) — the scanner.ts
 * half. The `str_replace` path is stale on this file (a known issue in this
 * repo), so the edits are applied by exact marker, each guarded by an
 * idempotency assertion, and the script refuses to write unless EVERY edit
 * matched exactly once.
 *
 * Run: node docs/patches/maintenance-cron-2026-09-29.apply.js
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(FILE, "utf8");
const before = src;

let applied = 0;
function edit(label, anchor, replacement) {
  if (!src.includes(anchor)) {
    throw new Error(`[${label}] anchor not found`);
  }
  const next = src.split(anchor).join(replacement);
  if (next === src) throw new Error(`[${label}] replacement was a no-op`);
  src = next;
  applied++;
  console.log(`  ok ${label}`);
}

// ---------------------------------------------------------------- 1. dex type
edit(
  "ScanSummary.dex gains the adaptive-spacing readings",
  `  dex?: {
    intervalMs: number;
    http429: number;`,
  `  dex?: {
    intervalMs: number;
    /** The configured base the adaptive spacing returns to (2026-09-29). */
    configuredIntervalMs: number;
    /** Raises in force since the last full recovery — 0 = running at base. */
    spacingSteps: number;
    http429: number;`,
);

// ------------------------------------------------------- 2. maintenance fields
edit(
  "ScanSummary gains the maintenance-ownership readings",
  `  /** Per-coin rejection trace for the last scan (bounded). */
  rejects: RejectionEntry[];`,
  `  /**
   * Whether the MAINTENANCE invocation (see worker.MAINTENANCE_CRON and
   * Scanner.runMaintenanceJobs) owns the interval-gated side-effect legs this
   * tick would otherwise run — the Birdeye backfill and the crime-wallet list
   * refresh. True = the tick deliberately skipped them because a maintenance
   * pass ran inside MAINTENANCE_PASS_FALLBACK_FRESH_MS; false = the tick ran
   * them itself, either because no pass has landed yet or because the trigger
   * has gone quiet. Published so a missing backfill is never read as an
   * upstream outage, and so a DEAD trigger is visible from /health.
   */
  maintFresh?: boolean;
  /** Age of the maintenance pass row in ms, or null when absent/unreadable. */
  maintAgeMs?: number | null;
  /** Per-coin rejection trace for the last scan (bounded). */
  rejects: RejectionEntry[];`,
);

// ------------------------------------------------- 3. constants + pure helpers
edit(
  "maintenance state key, freshness window and pure helpers",
  `/**
 * Whether the launch slot's GeckoTerminal new-pools leg may spend a fetch this
 * tick (pure — unit-tested). \`intervalMs\` is`,
  `/**
 * \`worker_state\` row: the stamp the MAINTENANCE invocation leaves (see
 * worker.MAINTENANCE_CRON and Scanner.runMaintenanceJobs), as JSON.
 *
 * WHY DURABLE AND JSON: the two jobs it owns are interval-gated for OTHER
 * reasons — the Birdeye backfill by CU (\`birdeye_backfill_at\`) and the crime
 * list by a TTL — and both stamps live in their own rows. This row answers a
 * third question neither of them can: "did the trigger deliver, and when?" A
 * tick standing down has to be able to tell "the maintenance invocation owns
 * this leg" from "the trigger is dead", and only its own row can say that —
 * exactly the shape pushwatch.TRACKER_PASS_STATE_KEY has for the pass. It is
 * spelled as a literal in db.SCAN_FRONT_GATE_KEYS (that module cannot import
 * this one), so the tick reads it on the front's ONE read and pays no round
 * trip for the check.
 */
export const MAINTENANCE_PASS_STATE_KEY = "maintenance_pass_at";

/**
 * How stale the maintenance row may be before a scan tick takes the legs back.
 *
 * The trigger fires every 5 minutes (worker.MAINTENANCE_CRON, "*/5 * * * *"),
 * so a healthy row is 0-300s old and the window is TWO periods plus a minute
 * of jitter — the same arithmetic worker.TRACKER_PASS_FALLBACK_FRESH_MS uses
 * for its 1-minute trigger (2 periods + jitter). Missing one delivery must not
 * cost the legs (the backfill is an hourly job and the crime list is a
 * network fetch, so a tick that takes them back is doing planned work, not
 * repairing damage); missing several must not cost them either, which is why
 * the fallback is automatic rather than operator-driven.
 */
export const MAINTENANCE_PASS_FALLBACK_FRESH_MS = 11 * 60_000;

/** What Scanner.runMaintenanceJobs leaves in MAINTENANCE_PASS_STATE_KEY. */
export interface MaintenancePassStamp {
  /** Epoch ms the pass finished its legs (written just before the stamp). */
  at: number;
  /** Coins the Birdeye backfill seeded this pass (0 = gate/leg not due). */
  backfill: number;
  /** Whether the crime-wallet list answered ok this pass. */
  crime: boolean;
}

/**
 * Parse the maintenance row (pure — unit-tested). Accepts a bare epoch-ms
 * string too, so a row written by a plainer shape still answers "how old is
 * this" instead of reading as absent. Returns null for anything it cannot
 * trust: the caller's fallback direction is to RUN the legs, and that is the
 * safe side (the legs are idempotent and interval-gated).
 */
export function parseMaintenanceStamp(
  raw: string | null | undefined,
): MaintenancePassStamp | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const fromNumber = Number(raw);
  if (Number.isFinite(fromNumber) && fromNumber > 0) {
    return { at: fromNumber, backfill: 0, crime: false };
  }
  try {
    const parsed = JSON.parse(raw) as {
      at?: unknown;
      backfill?: unknown;
      crime?: unknown;
    };
    const at =
      typeof parsed.at === "number" && Number.isFinite(parsed.at) && parsed.at > 0
        ? parsed.at
        : null;
    if (at === null) return null;
    const backfill =
      typeof parsed.backfill === "number" && Number.isFinite(parsed.backfill)
        ? parsed.backfill
        : 0;
    return { at, backfill, crime: parsed.crime === true };
  } catch {
    return null;
  }
}

/**
 * Age of the maintenance row in ms, or null when absent/unreadable. A stamp in
 * the FUTURE reads as 0, never negative: the clock-skew rule passRowAgeMs uses,
 * so an isolate whose clock ran ahead cannot make the row look dead.
 */
export function maintenancePassAgeMs(
  raw: string | null | undefined,
  nowMs: number,
): number | null {
  const stamp = parseMaintenanceStamp(raw);
  if (stamp === null) return null;
  return Math.max(0, nowMs - stamp.at);
}

/**
 * Whether the maintenance invocation owns the interval-gated legs right now
 * (pure — unit-tested). False for an absent row, an unreadable one and a
 * non-positive window — every reading it cannot trust — which makes the tick
 * run the legs itself, exactly as it did before this split existed.
 */
export function maintenancePassFresh(
  raw: string | null | undefined,
  nowMs: number,
  freshMs: number,
): boolean {
  if (!(freshMs > 0)) return false;
  const stamp = parseMaintenanceStamp(raw);
  if (stamp === null) return false;
  const age = nowMs - stamp.at;
  if (age < 0) return true; // clock skew: never double-run the legs
  return age < freshMs;
}

/**
 * Whether the launch slot's GeckoTerminal new-pools leg may spend a fetch this
 * tick (pure — unit-tested). \`intervalMs\` is`,
);

// ------------------------------------------------------- 4. the pass itself
edit(
  "Scanner.runMaintenanceJobs",
  `  trackerPassSlice(windowMs: number, slice: number, atMs: number): number {
    return this.peerPassAgeMs(atMs, windowMs) !== null ? 0 : slice;
  }`,
  `  trackerPassSlice(windowMs: number, slice: number, atMs: number): number {
    return this.peerPassAgeMs(atMs, windowMs) !== null ? 0 : slice;
  }

  /**
   * The maintenance invocation's whole job (see worker.MAINTENANCE_CRON):
   * the interval-gated, SIDE-EFFECT-ONLY legs the scan tick used to carry.
   *
   * WHY THESE TWO AND NOTHING ELSE. The three legs the tick's old
   * \`subreqSkip\` list named were the Birdeye backfill, the crime-wallet
   * refresh and the GeckoTerminal discovery fetch. The gecko leg STAYS in the
   * tick on purpose: its pools are not a side effect, they are the tick's
   * candidate list for that minute, and moving the fetch would either lose
   * them or need a durable feed channel the tick then has to read — a bigger
   * change than this one, with its own measurement. The two here are pure
   * writes: the backfill seeds unseen coins into token_stats (INSERT OR
   * IGNORE) and the crime refresh persists the blocklist for the whole fleet to
   * hydrate (see CrimeWalletClient.hydrateFromPersisted). Neither result is
   * consumed by the invocation that produced it, so running them anywhere is
   * equivalent — except that running them HERE stops the tick paying their wall
   * clock inside a front phase that the gates and the push need.
   *
   * Both legs keep their own interval gates, which is what makes moving them
   * safe: this method is called every 5 minutes and almost always does nothing
   * at all (the backfill is hourly, the crime TTL is longer). It still stamps —
   * a no-op pass is exactly the reading \`maintFresh\` needs, and a stamp only
   * on the passes that did work would make a healthy fleet look dead.
   *
   * Bounded by \`deadlineMs\` (the caller's), failures logged never thrown: a
   * failed backfill must not stop the stamp from landing, or a permanently
   * broken upstream would drag the tick's copy of the work back with it.
   */
  async runMaintenanceJobs(
    deadlineMs: number,
  ): Promise<MaintenancePassStamp | null> {
    const startedAt = Date.now();
    const left = (): number => deadlineMs - Date.now();
    let backfill = 0;
    let crime = false;
    // 1. Birdeye periodic backfill. Same shape the tick used: the interval gate
    // rides the leg (runPeriodicBackfill), so this is a cheap no-op on almost
    // every pass. \`fetchFeedCapped\` converts a hung upstream into a 0 instead
    // of a wedged invocation, which matters more here than in the tick: nobody
    // is waiting on this invocation's result.
    if (this.birdeye !== null && this.config.birdeyeBackfillEnabled && left() > 250) {
      try {
        backfill = await this.fetchFeedCapped(
          () => this.runPeriodicBackfill(),
          0,
          deadlineMs,
        );
      } catch (err) {
        console.error(
          "[scanner] maintenance backfill failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    // 2. Crime-wallet blocklist. This is the leg that gains the most from
    // moving: the network fetch persists the parsed list, and every SCAN
    // isolate then hydrates that copy with one read instead of downloading
    // ~4.8K addresses (see CrimeWalletClient.hydrateFromPersisted). One pass
    // every 5 minutes keeps the persisted copy inside its TTL, so the scan's
    // own refresh becomes a cache hit.
    if (this.crimeWallets && left() > 250) {
      try {
        const res = await this.crimeWallets.refreshIfStale();
        crime = res.ok;
      } catch (err) {
        console.error(
          "[scanner] maintenance crime refresh failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    const stamp: MaintenancePassStamp = { at: Date.now(), backfill, crime };
    try {
      // No scanFront in this invocation (runScan never ran), so stampFront
      // writes the row directly — awaited, so the window the tick checks opens
      // the moment this returns.
      await this.stampFront(MAINTENANCE_PASS_STATE_KEY, JSON.stringify(stamp));
    } catch (err) {
      console.error(
        "[scanner] maintenance stamp failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
    console.log(
      \`[scanner] maintenance pass: backfill \${backfill} crime \${
        crime ? "ok" : "skipped"
      } \${Date.now() - startedAt}ms\`,
    );
    return stamp;
  }`,
);

// ----------------------------------------------- 5. the tick's ownership check
edit(
  "the tick reads the maintenance row and publishes it",
  `      const chats = front.chats;
      if (chats.length === 0) {
        console.log("[scanner] no chats with push enabled, skipping");
        this.lastSkip = "no-chats-enabled";
        return;
      }`,
  `      const chats = front.chats;
      if (chats.length === 0) {
        console.log("[scanner] no chats with push enabled, skipping");
        this.lastSkip = "no-chats-enabled";
        return;
      }

      // MAINTENANCE OWNERSHIP (see worker.MAINTENANCE_CRON): the two
      // interval-gated side-effect legs below belong to the maintenance
      // invocation while its row is fresh, and come back to this tick the
      // moment it is not. The row rides the front's ONE read (see
      // db.SCAN_FRONT_GATE_KEYS), so the check costs no round trip — and the
      // reading is published, so "the backfill did not run this hour" can be
      // told apart from "the maintenance trigger stopped firing".
      const maintRaw = front.gates.get(MAINTENANCE_PASS_STATE_KEY) ?? null;
      const maintFresh = maintenancePassFresh(
        maintRaw,
        Date.now(),
        MAINTENANCE_PASS_FALLBACK_FRESH_MS,
      );
      diag.maintFresh = maintFresh;
      diag.maintAgeMs = maintenancePassAgeMs(maintRaw, Date.now());`,
);

// ---------------------------------------------------- 6. crime leg stands down
edit(
  "crime-refresh leg yields to the maintenance invocation",
  `      if (this.crimeWallets && !dropOptionalLeg("crime-refresh")) {`,
  `      if (!maintFresh && this.crimeWallets && !dropOptionalLeg("crime-refresh")) {`,
);

// ------------------------------------------------- 7. backfill leg stands down
edit(
  "backfill leg yields to the maintenance invocation",
  `      if (!(backfillArmed && dropOptionalLeg("backfill"))) {`,
  `      if (!maintFresh && !(backfillArmed && dropOptionalLeg("backfill"))) {`,
);

if (src === before) throw new Error("no edits applied");
fs.writeFileSync(FILE, src);
console.log(`\nscanner.ts: ${applied} edits applied, ${src.length - before.length} bytes added`);
