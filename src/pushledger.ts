/**
 * Durable push-baseline ledger (2026-09-19).
 *
 * WHY THIS EXISTS
 * `push_watch.mcap_at_push` has THREE writers and only one of them is the
 * gate value:
 *   1. the push itself (scanner `onPush(c.pair.marketCap)` — the value the
 *      band let through, the ONLY kind comparable to the filter band),
 *   2. the tracker's self-heal enrollment (`pushwatch.ts` seeds it from the
 *      coin's CURRENT mcap, hours after the push — a $45K push healed after a
 *      dump carries a $12K baseline),
 *   3. the dead-resurrection reset (`pushwatch.ts` resets it to the recovery
 *      mcap).
 * Combined with a filter band that operators retune by hand (and a 26h
 * rolling window that keeps rows pushed under the OLD band), the ledger was
 * full of rows whose "push mcap" was nowhere near any band — 7/39 rows in the
 * 2026-09-19 audit. Calibrating on that data was meaningless.
 *
 * WHAT THIS MODULE PROVIDES
 * For every pushed token it keeps ONE immutable record of the push-time mcap
 * and the band that was in force, so "was this push inside the band?" becomes
 * a well-defined question that survives band changes, heals and redeploys. It
 * also records when a row's stored baseline diverges from that record, which
 * is exactly how a heal/resurrection rewrite shows up.
 *
 * SOURCES (both are read, never written, by the reconciler)
 *   - the delivery audit ring (`push_audit`): an entry is written right after
 *     a first card is accepted by Telegram, carrying the same `c.pair.marketCap`
 *     the gate saw. Authoritative, but the ring only holds the last 30
 *     deliveries (~6h) — copying it into this ledger is what makes the value
 *     survive.
 *   - the live `push_watch` listing: has the baseline the row carries NOW,
 *     which is what detects a rewrite. A row that was never audited (older
 *     than the ring) is recorded as `watch-row` provenance — usable, but it
 *     may already have been rewritten before this ledger ever saw it.
 *
 * Everything here is pure: no I/O, no clock of its own, no throwing. The
 * worker owns the persistence (one `worker_state` row, the same pattern
 * `push_deferral` and `push_audit` already use).
 */

/** `worker_state` row holding the ledger (JSON), shared across isolates. */
export const PUSH_LEDGER_STATE_KEY = "push_ledger";
/** Ring cap: 240 pushes covers many days at the current push rate. */
export const PUSH_LEDGER_MAX_ENTRIES = 240;
/**
 * How many offending tokens the heartbeat view lists by name. The counters are
 * always complete; the names are capped because the ledger can hold 240
 * entries and the heartbeat is a small `worker_state` row read on every
 * /health ping.
 */
export const PUSH_LEDGER_REPORT_MAX = 12;
/**
 * How old a push may be for the band sampled NOW to be trusted as "the band in
 * force at push time".
 *
 * An audited push is discovered within one reconcile pass of the delivery
 * (minutes), and the audit ring reaches back ~6h, so 6h is a generous bound for
 * that source. A row first seen in `push_watch` with no audit entry is older
 * than the ring, and stamping today's band on it would recreate exactly the
 * false "out of band" reading this ledger exists to remove — so that case is
 * only trusted for a few minutes (a fresh push whose audit write was lost).
 * Anything else is recorded as UNBANDED, which the view reports honestly
 * instead of guessing.
 */
export const PUSH_LEDGER_AUDIT_BAND_TRUST_MS = 6 * 3_600_000;
export const PUSH_LEDGER_WATCH_BAND_TRUST_MS = 5 * 60_000;
/** Entries older than this are dropped (they are past every tracking window). */
export const PUSH_LEDGER_TTL_MS = 7 * 24 * 3_600_000;

export interface PushLedgerEntry {
  token: string;
  /** Original push time (ms). */
  pushedAt: number;
  /**
   * The mcap the gate saw when the coin was pushed. Immutable once recorded
   * from an authoritative source: a later divergence is evidence of a
   * heal/resurrection rewrite, not a correction of this value.
   */
  mcapAtPush: number;
  /** Filter band in force when this entry was recorded (null = unknown). */
  bandMin: number | null;
  bandMax: number | null;
  /** When `bandMin`/`bandMax` were sampled (bands get retuned by hand). */
  bandAt?: number;
  /**
   * `initial-send` = taken from the delivery audit of the scan that pushed it
   * (authoritative). `watch-row` = the first time this ledger saw the token
   * was in `push_watch`, so a heal may already have rewritten it.
   */
  source: "initial-send" | "watch-row";
  /** When this entry was first written. */
  firstSeenAt: number;
  /** Latest baseline the live row carries, when it differs from `mcapAtPush`. */
  rowMcapAtPush?: number;
  /** When that divergence was first observed (a rewritten baseline). */
  baselineMovedAt?: number;
}

export interface PushLedger {
  entries: PushLedgerEntry[];
  updatedAt: number;
}

export interface PushLedgerObservation {
  /** Delivery-audit entries (`push_audit`), any order. */
  audit: Array<{
    token: string;
    at: number;
    mcapAtPush?: number | null;
    kind?: string | null;
  }>;
  /** Live `push_watch` rows (the baseline each row carries now). */
  rows: Array<{ token: string; pushedAt: number; mcapAtPush: number }>;
  /** Filter band to record for pushes seen in this pass (null = unknown). */
  band: { min: number | null; max: number | null } | null;
  now: number;
}

export function emptyPushLedger(): PushLedger {
  return { entries: [], updatedAt: 0 };
}

/** Tolerant parse: a corrupt or pre-schema row degrades to "no entries". */
export function parsePushLedger(raw: string | null | undefined): PushLedger {
  if (!raw) return emptyPushLedger();
  try {
    const parsed = JSON.parse(raw) as Partial<PushLedger> | null;
    const list = Array.isArray(parsed?.entries) ? parsed!.entries : [];
    const entries: PushLedgerEntry[] = [];
    for (const e of list as unknown as Array<Record<string, unknown>>) {
      const token = typeof e?.token === "string" ? e.token : null;
      const mcap = numOrNull(e?.mcapAtPush);
      if (!token || mcap === null) continue;
      const pushedAt = numOrNull(e?.pushedAt) ?? 0;
      entries.push({
        token,
        pushedAt,
        mcapAtPush: mcap,
        bandMin: numOrNull(e?.bandMin),
        bandMax: numOrNull(e?.bandMax),
        bandAt: numOrNull(e?.bandAt) ?? undefined,
        source: e?.source === "initial-send" ? "initial-send" : "watch-row",
        firstSeenAt: numOrNull(e?.firstSeenAt) ?? pushedAt,
        rowMcapAtPush: numOrNull(e?.rowMcapAtPush) ?? undefined,
        baselineMovedAt: numOrNull(e?.baselineMovedAt) ?? undefined,
      });
    }
    return {
      entries,
      updatedAt: numOrNull(parsed?.updatedAt) ?? 0,
    };
  } catch {
    return emptyPushLedger();
  }
}

/**
 * Fold one pass of observations into the ledger. Pure: the caller persists the
 * returned value. An authoritative audit entry always wins for `mcapAtPush`;
 * a live row that disagrees with it is recorded as a MOVED baseline (the
 * heal/resurrection rewrite this ledger exists to expose).
 */
export function mergePushLedger(
  ledger: PushLedger,
  obs: PushLedgerObservation,
): PushLedger {
  const byToken = new Map<string, PushLedgerEntry>();
  for (const e of ledger.entries) byToken.set(e.token, e);
  const bandAt = obs.band ? obs.now : undefined;

  // 1) Authoritative first: the audit entry from the scan that pushed.
  for (const a of obs.audit) {
    const mcap = numOrNull(a.mcapAtPush);
    if (!a.token || mcap === null) continue;
    // Follow-up cards ride the same ring; only the initial card carries the
    // push-time value.
    if (a.kind !== undefined && a.kind !== null && a.kind !== "initial") continue;
    const at = numOrNull(a.at) ?? obs.now;
    const prev = byToken.get(a.token);
    const trustBand =
      obs.band !== null && obs.now - at <= PUSH_LEDGER_AUDIT_BAND_TRUST_MS;
    if (!prev) {
      byToken.set(a.token, {
        token: a.token,
        pushedAt: at,
        mcapAtPush: mcap,
        bandMin: trustBand ? obs.band!.min : null,
        bandMax: trustBand ? obs.band!.max : null,
        bandAt: trustBand ? bandAt : undefined,
        source: "initial-send",
        firstSeenAt: obs.now,
      });
      continue;
    }
    // Upgrade provenance: a watch-row guess must yield to the audit's value.
    if (prev.source === "watch-row") {
      const fillBand = prev.bandMin === null && trustBand;
      byToken.set(a.token, {
        ...prev,
        pushedAt: prev.pushedAt || at,
        mcapAtPush: mcap,
        source: "initial-send",
        // An audited value is what makes this token comparable to a band, so
        // fill the snapshot when the earlier sighting had none and the audit
        // entry is recent enough for "now" to stand for push time.
        bandMin: fillBand ? obs.band!.min : prev.bandMin,
        bandMax: fillBand ? obs.band!.max : prev.bandMax,
        bandAt: fillBand ? bandAt : prev.bandAt,
      });
    }
  }

  // 2) Then the live rows: create unknowns, and stamp any divergence.
  for (const row of obs.rows) {
    if (!row.token) continue;
    const mcap = numOrNull(row.mcapAtPush);
    if (mcap === null) continue;
    const prev = byToken.get(row.token);
    if (!prev) {
      const pushedAt = numOrNull(row.pushedAt) ?? obs.now;
      const trustBand =
        obs.band !== null &&
        obs.now - pushedAt <= PUSH_LEDGER_WATCH_BAND_TRUST_MS;
      byToken.set(row.token, {
        token: row.token,
        pushedAt,
        mcapAtPush: mcap,
        bandMin: trustBand ? obs.band!.min : null,
        bandMax: trustBand ? obs.band!.max : null,
        bandAt: trustBand ? bandAt : undefined,
        source: "watch-row",
        firstSeenAt: obs.now,
      });
      continue;
    }
    // The rewrite detector. A row's baseline disagreeing with the recorded
    // push value means a heal (or a resurrection) replaced it — keep BOTH so
    // the record of what the gate actually saw is never lost.
    if (Math.abs(mcap - prev.mcapAtPush) > 1e-6) {
      byToken.set(row.token, {
        ...prev,
        rowMcapAtPush: mcap,
        baselineMovedAt: prev.baselineMovedAt ?? obs.now,
      });
    } else if (prev.rowMcapAtPush !== undefined) {
      // The row agrees again (e.g. it was re-pushed): drop the stale flag.
      const { rowMcapAtPush: _m, baselineMovedAt: _b, ...rest } = prev;
      byToken.set(row.token, rest);
    }
  }

  const entries = prunePushLedger([...byToken.values()], obs.now);
  // A pass that changed nothing must not rewrite the durable row, and must not
  // advance `updatedAt`: this runs on a worker where writes are the scarce
  // resource, and a stable stamp is what makes "unchanged since X" readable in
  // the heartbeat (`ageMs`).
  const unchanged = JSON.stringify(entries) === JSON.stringify(ledger.entries);
  return { entries, updatedAt: unchanged ? ledger.updatedAt : obs.now };
}

/** Bounded retention: newest pushes win, nothing older than the TTL stays. */
export function prunePushLedger(
  entries: PushLedgerEntry[],
  now: number,
): PushLedgerEntry[] {
  return entries
    .filter((e) => now - e.pushedAt <= PUSH_LEDGER_TTL_MS)
    .sort((a, b) => b.pushedAt - a.pushedAt)
    .slice(0, PUSH_LEDGER_MAX_ENTRIES);
}

/** A row is out of band only when BOTH the band and the push value are known. */
export function isOutOfBand(entry: PushLedgerEntry): boolean {
  if (entry.bandMin === null || entry.bandMax === null) return false;
  return entry.mcapAtPush < entry.bandMin || entry.mcapAtPush > entry.bandMax;
}

/**
 * The calibration view: which pushes were actually inside the band that was in
 * force, and which rows' baselines were rewritten afterwards. Rows without a
 * band snapshot are counted as `unbanded` rather than guessed at.
 */
export function pushLedgerStats(ledger: PushLedger, now: number): {
  entries: number;
  authoritative: number;
  unbanded: number;
  outOfBandCount: number;
  outOfBand: Array<{ token: string; mcapAtPush: number; bandMin: number; bandMax: number }>;
  rewrittenCount: number;
  rewritten: Array<{
    token: string;
    pushedAt: number;
    mcapAtPush: number;
    rowMcapAtPush: number;
    baselineMovedAt: number;
  }>;
  band: { min: number | null; max: number | null };
  updatedAt: number;
  ageMs: number;
} {
  const outOfBand: Array<{ token: string; mcapAtPush: number; bandMin: number; bandMax: number }> = [];
  const rewritten: Array<{
    token: string;
    pushedAt: number;
    mcapAtPush: number;
    rowMcapAtPush: number;
    baselineMovedAt: number;
  }> = [];
  let authoritative = 0;
  let unbanded = 0;
  // The band is a single per-deployment value in practice (one chat); report
  // the newest snapshot rather than pretending older snapshots still apply.
  let newestBandAt = -1;
  let band: { min: number | null; max: number | null } = { min: null, max: null };
  for (const e of ledger.entries) {
    if (e.source === "initial-send") authoritative += 1;
    if (e.bandMin === null || e.bandMax === null) unbanded += 1;
    else if ((e.bandAt ?? 0) >= newestBandAt) {
      newestBandAt = e.bandAt ?? 0;
      band = { min: e.bandMin, max: e.bandMax };
    }
    if (e.rowMcapAtPush !== undefined && e.baselineMovedAt !== undefined) {
      rewritten.push({
        token: e.token,
        pushedAt: e.pushedAt,
        mcapAtPush: e.mcapAtPush,
        rowMcapAtPush: e.rowMcapAtPush,
        baselineMovedAt: e.baselineMovedAt,
      });
    }
    if (isOutOfBand(e)) {
      outOfBand.push({
        token: e.token,
        mcapAtPush: e.mcapAtPush,
        bandMin: e.bandMin!,
        bandMax: e.bandMax!,
      });
    }
  }
  return {
    entries: ledger.entries.length,
    authoritative,
    unbanded,
    outOfBandCount: outOfBand.length,
    outOfBand: outOfBand.slice(0, PUSH_LEDGER_REPORT_MAX),
    rewrittenCount: rewritten.length,
    rewritten: rewritten.slice(0, PUSH_LEDGER_REPORT_MAX),
    band,
    updatedAt: ledger.updatedAt,
    ageMs: ledger.updatedAt > 0 ? Math.max(0, now - ledger.updatedAt) : -1,
  };
}

/** Lookup used by the tracker's self-heal (see pushwatch.ts). */
export function findLedgerEntry(
  ledger: PushLedger,
  token: string,
): PushLedgerEntry | null {
  return ledger.entries.find((e) => e.token === token) ?? null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
