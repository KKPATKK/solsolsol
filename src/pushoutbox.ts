/*
 * Durable card-send outbox — the retry the scan tick no longer pays for
 * (2026-10-18, docs/round-trips.md §4.70).
 *
 * WHY IT EXISTS. The push loop used to retry a transient Telegram failure
 * INSIDE the tick that found the card: `sleep(1200)` and a second `sendTo`.
 * That retry is a second 0.6–1.2s Telegram round trip (the measured
 * `/debug/test-push` range) inside an envelope the card already races, and it
 * dies with the isolate — a tick killed between the two sends retried nothing
 * and left the coin to the re-eval pool's rotation (3 min near zone, 18 min
 * far), which is how a card turns into a late card or no card at all. This
 * module turns the same retry into ONE durable D1 row (`push_outbox`) that the
 * tracker cron drains once a minute: the tick pays one insert instead of a
 * second send, and the retry survives the tick that failed.
 *
 * WHAT IT IS NOT. Not a delivery pipeline: the card is sent by the SAME
 * grammY client, from the SAME Worker, with the SAME claims and the SAME
 * delivery audit as an inline send. The only thing that moved is WHO waits
 * for Telegram (the cron invocation, which nobody is counting the milliseconds
 * of) and WHERE the retry is remembered (a D1 row, not a promise).
 *
 * THE POLICY, as one table (every row is a pure function below, so the four
 * outcomes are asserted rather than described):
 *
 *   delivery audit already proves this token | drop the row, send nothing
 *   a previous attempt failed transiently    | retry, up to MAX_ATTEMPTS
 *   Telegram rejected the card (4xx)         | drop the row (the re-eval pool
 *                                            | still owns the coin)
 *   attempts / TTL exhausted                 | drop the row
 *
 * CLAIM DISCIPLINE. The drain CLAIMS the token before each attempt
 * (`claimTokenPush`) and releases it on any failure, exactly like the send
 * path: the claim is the mutex between this drain, the scan's own push and
 * the chat-aware re-eval pool, so two senders cannot produce two cards. A row
 * found with its claim held by somebody else is backed off, never touched.
 * The duplicate window is therefore the one the in-tick retry already had:
 * Telegram accepted a card whose response (and audit) was lost — any retry
 * of any kind re-sends it. The audit check ahead of every attempt is what
 * keeps that window narrow, not what closes it.
 *
 * WHY NOT CLOUDFLARE QUEUES (measured 2026-10-18, docs/queues-card-send-
 * 2026-10-18.md): one delivery = 3 operations, at-least-once with retries and
 * no FIFO, and the default consumer batch wait is 5s — for ~350 cards/day on
 * one chat, a queue buys latency and duplicate risk where this outbox buys the
 * same durability with the claim/audit rules the bot already has.
 */

/**
 * Sends one obligation may make, ever (the tick's own failed attempt is
 * attempt 0 — this is what the CRON drain may spend): one immediate retry on
 * the next drain, one more a minute later, and one last two minutes after
 * that. Three is calibrated on the transient class the in-tick retry served
 * (429 / 5xx / network, see describePushError): a second or two of Telegram
 * trouble is fixed by the first retry, and anything still failing three times
 * over four minutes is an outage the re-eval pool should own — the card is
 * stale by then anyway.
 */
export const PUSH_OUTBOX_MAX_ATTEMPTS = 3;

/**
 * Lifetime of an obligation, measured from its enqueue. Ten minutes: long
 * enough to outlast an upstream/Telegram stall several times the drain's own
 * minute, short enough that a card nobody could deliver stops competing with
 * the fresh cards the re-eval pool will offer for the same coin. A row past
 * either bound is dropped (never unclaimed by force — see the drain: only a
 * claim THIS attempt took is ever released).
 */
export const PUSH_OUTBOX_TTL_MS = 10 * 60_000;

/**
 * Delay before attempt N+1, indexed by the attempt just FAILED. Attempt 0
 * (the first send) is due the moment the row lands, so the next drain owns it.
 * The steps are bounded by the drain's own cadence (the tracker cron runs
 * every minute) — a 30s step would be rounded up anyway.
 */
export const PUSH_OUTBOX_RETRY_DELAY_MS = [0, 60_000, 120_000] as const;

/**
 * Rows one drain may take. Three is a burst bound, not a throughput one: the
 * live volume is ~350 cards/day (0.24/minute) and the transient class a
 * fraction of that, so a due backlog of more than three means something else
 * broke (Telegram down) — and the rows left behind keep their order for the
 * next minute instead of spending the pass's budget.
 */
export const PUSH_OUTBOX_DRAIN_MAX = 3;

/**
 * Cap on ONE outbox send. The old in-tick retry had whatever the tick's send
 * slice had (~1.2s); a cron invocation has minutes, but a hung Telegram must
 * not hold the tracker pass, so each send races this cap AND the drain's own
 * deadline. A send that misses both is an UNKNOWN delivery, treated exactly
 * like a transient failure (the cargo-culted "at-least-once" in the policy
 * table above): retry if there is budget, drop the claim either way.
 */
export const PUSH_OUTBOX_SEND_CAP_MS = 5_000;

/**
 * The drain's share of the tracker invocation. The pass keeps its own
 * `TRACKER_PASS_BUDGET_MS` (5s), so this is the slice in front of it — a
 * retried CARD is worth more than a pass row, but neither may starve the
 * other.
 */
export const PUSH_OUTBOX_DRAIN_BUDGET_MS = 4_000;

/** Durable view key — `/health.pushOutbox`, written by the drain itself. */
export const PUSH_OUTBOX_STATE_KEY = "push_outbox_view";

/** One due row, as `push_outbox` stores it (see the DDL in src/db.ts). */
export interface PushOutboxRow {
  chatId: string;
  token: string;
  symbol: string | null;
  /**
   * The card's rendered message, verbatim. The tick that found the coin owns
   * the render (pair, gates, Axiom/Birdeye lines) and none of it is
   * reconstructible from a token address, so the outbox carries the artifact
   * instead of the inputs. It is what makes the retry card identical to the
   * one the tick tried to send — the same reason the in-tick retry re-used
   * `message` rather than re-rendering.
   */
  message: string;
  /** `reply_markup` JSON (inline_keyboard), or null for a card without buttons. */
  keyboard: string | null;
  mcap: number | null;
  liquidity: number | null;
  /** The pinned pool the card was based on (see pushwatch.pinnablePoolAddress). */
  pool: string | null;
  /** `PushAuditOrganic` JSON — what the card's 🌱 line was judged on. */
  organic: string | null;
  attempts: number;
  nextAt: number;
  expiresAt: number;
  createdAt: number;
  lastError: string | null;
}

/** The fields the tick hands the outbox when it enqueues a failed card. */
export interface PushOutboxEnqueue {
  chatId: string;
  token: string;
  symbol: string | null;
  message: string;
  keyboard: string | null;
  mcap: number | null;
  liquidity: number | null;
  pool: string | null;
  organic: string | null;
  /** Why the first send failed (`describePushError(...).line`). */
  error: string | null;
  createdAt: number;
}

/** What the pre-claim decision left for a row. */
export type PushOutboxPreClaim = "drop-delivered" | "give-up" | "attempt";

/**
 * True when a row has spent its attempt or time budget. Checked BEFORE the
 * claim, so an exhausted row is never a reason to hold a token's claim.
 */
export function pushOutboxExhausted(row: PushOutboxRow, now: number): boolean {
  return row.attempts >= PUSH_OUTBOX_MAX_ATTEMPTS || now >= row.expiresAt;
}

/**
 * The decision in front of a claim, as a pure function of the row, the clock
 * and whether the delivery audit already proves the card left the Worker.
 *
 * The audit wins over everything: a row whose token has an `initial` audit
 * entry is a card that DID deliver (a late settle, a re-eval push that won
 * the race) and re-sending it is exactly the duplicate this outbox exists to
 * avoid. Commented as prose because the three outcomes are the whole policy —
 * see the module header's table.
 */
export function pushOutboxPreClaim(
  row: PushOutboxRow,
  now: number,
  hasAudit: boolean,
): PushOutboxPreClaim {
  if (hasAudit) return "drop-delivered";
  if (pushOutboxExhausted(row, now)) return "give-up";
  return "attempt";
}

/** Attempt N+1's delay, clamped to the last step. */
export function pushOutboxRetryDelayMs(attempts: number): number {
  const list = PUSH_OUTBOX_RETRY_DELAY_MS;
  return list[Math.min(Math.max(0, attempts), list.length - 1)];
}

/** What one failed (or claim-blocked) attempt leaves behind. */
export interface PushOutboxNext {
  attempts: number;
  nextAt: number;
  /** false = drop the row; the re-eval pool owns the coin from here. */
  retry: boolean;
}

/**
 * Bookkeeping after a failed attempt. A permanent rejection (Telegram 4xx)
 * never retries — a refusal that will not fix itself in a second will not fix
 * itself in a minute either, and retrying it would only burn the drain's
 * budget; the re-eval pool keeps the coin for the moment the condition
 * clears (bot added to the group, chat unblocked). A transient failure
 * retries until the attempt or TTL budget is spent.
 */
export function pushOutboxAfterFailure(
  row: PushOutboxRow,
  now: number,
  transient: boolean,
): PushOutboxNext {
  const attempts = row.attempts + 1;
  if (!transient) return { attempts, nextAt: now, retry: false };
  if (attempts >= PUSH_OUTBOX_MAX_ATTEMPTS || now >= row.expiresAt) {
    return { attempts, nextAt: now, retry: false };
  }
  return { attempts, nextAt: now + pushOutboxRetryDelayMs(attempts), retry: true };
}

/**
 * What ONE drain did, as `/health.pushOutbox` serves it. Every count is
 * per-drain (not cumulative): the durable row is overwritten by the next
 * drain, so the page answers "what did the last drain do" — which is the
 * question the counters exist for (a stack of cumulative numbers on an
 * isolate that recycles reads as a frozen retry path).
 */
export interface PushOutboxDrainView {
  /** When the drain started (ms epoch). */
  at: number;
  /** How long it took. */
  ms: number;
  /** Rows due at the start of this drain. */
  due: number;
  /** Rows still in the table after it. */
  pending: number;
  /** Cards delivered by this drain (audit written, claim kept). */
  sent: number;
  /** Rows backed off for a later attempt (transient failure). */
  retried: number;
  /** Rows dropped after Telegram rejected the card (4xx). */
  rejected: number;
  /** Rows dropped after the attempt/TTL budget ran out. */
  gaveUp: number;
  /** Rows backed off because another sender held the token's claim. */
  deferred: number;
  /** Rows dropped because the delivery audit already proved them. */
  delivered: number;
  /** Which invocation drained it (cron-pass today; the field is generic). */
  via: string;
}
