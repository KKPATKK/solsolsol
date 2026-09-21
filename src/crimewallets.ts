import type { AppConfig } from "./config";
import type { Db } from "./db";
import type { HeliusClient } from "./helius";

/**
 * Crime-wallet blocklist client — the community list from
 * github.com/solguala/crimewallets ("Axiom/Husher Crime Wallet List"):
 * ~4.8K Solana wallets identified from aged-wallet sale listings, i.e.
 * wallets likely used to make bundled launches or coordinated activity look
 * organic. The scanner checks each pushed coin's creator wallet (free via
 * RugCheck) and its top holder OWNER wallets (Helius) against this list.
 *
 * Per the list's own README, a match is a WARNING signal — never proof — so
 * the default mode is display-only (a flag line on the push card). Setting
 * CRIME_WALLETS_BLOCK=true turns a hit into a push blocker.
 *
 * The list is fetched from a one-address-per-line text file (default the
 * mirror's `raw format.txt`) and re-fetched at most once per refreshMs.
 *
 * 2026-09-21 — the TTL is FLEET-wide now, not per isolate. The worker
 * persists the refresh time and the parsed list in worker_state, and a
 * recycled isolate HYDRATES from that copy (two worker_state reads) instead
 * of re-downloading and re-persisting the whole ~216KB file. This is not an
 * optimization, it is a correctness fix: the isolate recycling rate on the
 * cron deployment is high enough that nearly EVERY tick is some isolate's
 * first tick (measured live: the persisted stamp advanced every 25-45s, i.e.
 * one cold tick after another), and a cold tick used to block on the GitHub
 * fetch + re-persist (2.8-3.6s at /debug/crime-wallets?refresh=1) BEFORE the
 * scan's feed phase — which has only 900ms (FEED_DEADLINE_MS). The scanner's
 * `fetchFeedCapped` short-circuits under 250ms of remaining window, so the
 * DexScreener profiles feed was never even DISPATCHED on those ticks:
 * /debug/tick showed `profiles 0`, `feedsMs 0`, `feedRequests 0` while the
 * scan still evaluated the pool. The persisted stamp as the TTL also stops
 * the 216KB re-persist per cold isolate (once per refreshMs per fleet now).
 *
 * A failed fetch keeps the previous list and records lastError — the scan
 * path never blocks on this.
 */

/** Valid base58 Solana address (32–44 chars, no 0/O/I/l). */
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Pure parser for the one-address-per-line blocklist format (exported for
 * offline unit tests). Tolerates CRLF, blank lines and `#` comments; drops
 * anything that is not a valid base58 address and dedupes.
 */
export function parseCrimeWalletList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split("\n")) {
    const addr = rawLine.trim();
    if (!addr || addr.startsWith("#")) continue;
    if (!ADDR_RE.test(addr)) continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

/**
 * In-memory TTL for the per-token holder-owner verdict (2 Helius RPC calls
 * each). A partially-seen coin (retried until every chat receives it)
 * reuses the cached verdict instead of re-spending credits on every tick.
 */
const HOLDER_CACHE_MS = 10 * 60_000;
/**
 * Skip re-lookup for a token whose holder fetch came back empty/failed —
 * same semantics as the scanner's 5-min negative cache, kept local to this
 * client so the scan path never hammers Helius on an unresolvable coin.
 */
const HOLDER_NEGATIVE_CACHE_MS = 5 * 60_000;

/**
 * One resolved top-holder account of a coin: the token account from
 * getTokenLargestAccounts mapped back to its OWNER wallet. The crime check
 * fetches these anyway (2 RPC calls), so the wallet analyzer reuses them
 * instead of spending a second round of credits on the same data.
 */
export interface ResolvedHolder {
  /** Token account address (getTokenLargestAccounts). */
  address: string;
  /** Owner wallet (getAccountOwners). */
  owner: string;
  /** 1-based size rank (1 = largest). */
  rank: number;
  /** UI amount held. */
  uiAmount: number;
}

/**
 * Outcome of a coin's crime-wallet check, rendered on the push card (and
 * used by the scanner when CRIME_WALLETS_BLOCK is on). `loaded: false`
 * means the list had not been fetched yet in this isolate — the check was
 * skipped, NOT a clean pass.
 */
export interface CrimeCheckResult {
  hit: boolean;
  creatorHit: boolean;
  /** Top-holder owner wallets that matched the list. */
  holderHits: string[];
  /** How many top-holder owners were actually checked. */
  checkedHolders: number;
  /** False when the list hasn't loaded yet (check skipped). */
  loaded: boolean;
  /**
   * Resolved top holder accounts (owner wallets), in size order — empty
   * when holder checking is off or unavailable. Downstream wallet analysis
   * (creator/holder profiles, cross-coin clustering) reuses this list.
   */
  holders: ResolvedHolder[];
}

/** Snapshot of the loaded list (surfaced via /health and /debug). */
export interface CrimeWalletStatus {
  size: number;
  /**
   * The list's own refresh stamp (fleet-wide, from worker_state when this
   * isolate hydrated it) — NOT "when this isolate booted". A cold isolate
   * that hydrates a fresh copy reports the previous refresh's time and
   * issues no request; see refreshIfStale.
   */
  loadedAt: number | null;
  lastError: string | null;
  refreshMs: number;
  /** How this isolate got the list: `null` = not loaded yet. */
  loadedFrom: "network" | "persisted" | null;
}

/** Default raw-list URL (crimewallets mirror `raw format.txt`). */
export const DEFAULT_CRIME_WALLETS_URL =
  "https://raw.githubusercontent.com/ashantilagos/crimewallets/main/raw%20format.txt";

/** worker_state key holding the last successfully-parsed list (newline-joined). */
const PERSISTED_LIST_KEY = "crime_wallets_list";
/**
 * worker_state key holding WHEN that list was fetched (epoch ms). Written
 * AFTER the list itself (see refreshIfStale): the stamp certifies the copy,
 * so it must never land before the copy it describes.
 */
const PERSISTED_AT_KEY = "crime_wallets_updated_at";

export class CrimeWalletClient {
  private wallets = new Set<string>();
  private loadedAt: number | null = null;
  private lastError: string | null = null;
  /** See CrimeWalletStatus.loadedFrom. */
  private loadedFrom: "network" | "persisted" | null = null;
  private readonly url: string;
  private readonly refreshMs: number;
  private readonly timeoutMs: number;
  private readonly fetcher: (url: string) => Promise<Response>;
  /** Per-token holder-owner verdicts (TTL-bounded, see HOLDER_CACHE_MS). */
  private readonly holderCache = new Map<
    string,
    { at: number; hits: string[]; checked: number; holders: ResolvedHolder[] }
  >();
  /** When a token's holder fetch last came back empty/failed. */
  private readonly holderFailAt = new Map<string, number>();

  constructor(
    config: AppConfig,
    /** Optional Db — only used to persist the refresh time for /health. */
    private readonly db: Db | null = null,
    /** Injectable fetch for tests (defaults to global fetch). */
    fetcher?: (url: string) => Promise<Response>,
  ) {
    const c = config.crimeWallets;
    this.url = c.url;
    this.refreshMs = c.refreshMs;
    this.timeoutMs = c.timeoutMs;
    this.fetcher =
      fetcher ??
      ((u) =>
        fetch(u, {
          // Bound the fetch so a slow GitHub response can never stall a scan
          // tick: at most one (bounded) refresh per isolate per refreshMs.
          signal: AbortSignal.timeout(this.timeoutMs),
        }));
  }

  /** Whether the list has been loaded at least once in this isolate. */
  get loaded(): boolean {
    return this.loadedAt !== null;
  }

  /** How many addresses are currently in the list. */
  get size(): number {
    return this.wallets.size;
  }

  get status(): CrimeWalletStatus {
    return {
      size: this.wallets.size,
      loadedAt: this.loadedAt,
      lastError: this.lastError,
      refreshMs: this.refreshMs,
      loadedFrom: this.loadedFrom,
    };
  }

  /** Exact membership test against the loaded list. */
  has(address: string): boolean {
    return this.wallets.has(address);
  }

  /**
   * Re-fetch the list when the copy on hand is stale (or `force`).
   * Non-throwing: a fetch failure keeps the previous list and records
   * lastError, so the scanner can call this every tick without any risk to
   * the scan. Returns the outcome for the /debug endpoint.
   *
   * Three steps, cheapest first (2026-09-21, see the header note):
   *   1. a loaded copy inside refreshMs is a no-op — most ticks, warm or
   *      cold, end here;
   *   2. a COLD isolate hydrates the persisted copy + stamp (two reads) and
   *      ends here when that stamp is still inside refreshMs — the fleet's
   *      last refresh, not a 216KB download that would blow the tick's feed
   *      window;
   *   3. otherwise (no copy anywhere, a stamp past refreshMs, or `force`)
   *      the network is the answer, exactly as before.
   */
  async refreshIfStale(force = false): Promise<{ ok: boolean; size: number }> {
    if (!force && this.loadedAt !== null && Date.now() - this.loadedAt < this.refreshMs) {
      return { ok: true, size: this.wallets.size };
    }
    if (!force && !this.loaded && (await this.hydrateFromPersisted())) {
      return { ok: true, size: this.wallets.size };
    }
    try {
      const res = await this.fetcher(this.url);
      if (!res.ok) throw new Error(`crimewallets HTTP ${res.status}`);
      const text = await res.text();
      const parsed = parseCrimeWalletList(text);
      if (parsed.length === 0) {
        throw new Error("crimewallets list empty or unparseable");
      }
      this.wallets = new Set(parsed);
      this.loadedAt = Date.now();
      this.loadedFrom = "network";
      this.lastError = null;
      try {
        // Persist the parsed list itself so a future upstream disappearance
        // (the original solguala repo went 404 on 2026-08-21) degrades to a
        // stale-but-working blocklist instead of an empty one — and so the
        // rest of the fleet (which recycles constantly) can hydrate it
        // instead of re-downloading it. LIST FIRST, stamp second: the stamp
        // is what a cold isolate trusts to skip the network, so a partial
        // failure must leave a stamp that is older than the copy it names.
        await this.db?.setWorkerState(PERSISTED_LIST_KEY, parsed.join("\n"));
        await this.db?.setWorkerState(PERSISTED_AT_KEY, String(this.loadedAt));
      } catch (err) {
        console.error(
          "[crimewallets] refresh-time persist failed:",
          err instanceof Error ? err.message : err,
        );
      }
      return { ok: true, size: this.wallets.size };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[crimewallets] refresh failed: ${this.lastError}`);
      // Fallback: hydrate from the last persisted copy so a dead upstream
      // leaves us with a stale list rather than no list at all.
      if (!this.loaded && this.db) {
        try {
          const saved = await this.db.getWorkerState(PERSISTED_LIST_KEY);
          if (saved) {
            const parsed = parseCrimeWalletList(saved);
            if (parsed.length > 0) {
              this.wallets = new Set(parsed);
              this.loadedAt = Date.now();
              this.loadedFrom = "persisted";
              console.error(
                `[crimewallets] hydrated ${parsed.length} wallets from persisted copy (upstream unavailable)`,
              );
              return { ok: true, size: this.wallets.size };
            }
          }
        } catch (dbErr) {
          console.error(
            "[crimewallets] persisted-list fallback failed:",
            dbErr instanceof Error ? dbErr.message : dbErr,
          );
        }
      }
      return { ok: false, size: this.wallets.size };
    }
  }

  /**
   * Cold-isolate fast path: take the fleet's persisted list (and its refresh
   * stamp) instead of the network. Returns true only when the persisted copy
   * is inside refreshMs — i.e. when hydrating it ANSWERS the staleness
   * question, which is what lets the caller skip the fetch entirely.
   *
   * A stale (or unstamped) copy still lands in memory — the tick gets a
   * usable blocklist for its crime checks — but returns false so the caller
   * refreshes over the network; `loadedAt` carries the persisted stamp (or
   * exactly refreshMs of imaginary age when there is none), so the honesty
   * of the age survives into /health instead of reading as "loaded now".
   *
   * Never throws: a DB failure/absence returns false and the caller falls
   * back to the network path, which is the pre-2026-09-21 behaviour.
   */
  private async hydrateFromPersisted(): Promise<boolean> {
    if (!this.db) return false;
    try {
      const [saved, stampRaw] = await Promise.all([
        this.db.getWorkerState(PERSISTED_LIST_KEY),
        this.db.getWorkerState(PERSISTED_AT_KEY),
      ]);
      if (!saved) return false;
      const parsed = parseCrimeWalletList(saved);
      if (parsed.length === 0) return false;
      const stamp = stampRaw ? Number(stampRaw) : 0;
      const at = Number.isFinite(stamp) && stamp > 0 ? stamp : 0;
      const fresh = at > 0 && Date.now() - at < this.refreshMs;
      this.wallets = new Set(parsed);
      this.loadedAt = fresh ? at : Date.now() - this.refreshMs;
      this.loadedFrom = "persisted";
      console.log(
        `[crimewallets] hydrated ${parsed.length} wallets from persisted copy (stamp ${
          fresh ? "fresh" : "stale"
        }, age ${Math.round((Date.now() - this.loadedAt) / 1000)}s)`,
      );
      return fresh;
    } catch (err) {
      console.error(
        "[crimewallets] persisted-copy hydrate failed:",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /** Whether a holder lookup for this token should be skipped (5-min backoff). */
  private holderNegativeCached(token: string): boolean {
    const at = this.holderFailAt.get(token);
    if (at === undefined) return false;
    if (Date.now() - at < HOLDER_NEGATIVE_CACHE_MS) return true;
    this.holderFailAt.delete(token); // prune stale entries
    return false;
  }

  /**
   * Check a coin's associated wallets against the list:
   *   1. creator (already resolved from the RugCheck report — free),
   *   2. top holder OWNER wallets (Helius getTokenLargestAccounts +
   *      getMultipleAccounts — 2 RPC calls, only when `helius` is provided
   *      and holder checking is enabled; verdicts cached in-memory per
   *      token so retry ticks don't re-spend credits).
   * A match is a WARNING (the list's own README says so) — the caller
   * decides whether to flag the card or block the push. Never throws:
   * holder-lookup failures negative-cache the token and return a no-hit
   * result, so a Helius outage degrades the check, never the scan.
   */
  async checkToken(
    token: string,
    creator: string | null,
    helius: HeliusClient | null,
    opts: { checkHolders: boolean; holderTopN: number },
  ): Promise<CrimeCheckResult> {
    if (!this.loaded) {
      return {
        hit: false,
        creatorHit: false,
        holderHits: [],
        checkedHolders: 0,
        loaded: false,
        holders: [],
      };
    }
    const creatorHit = creator !== null && this.has(creator);
    let holderHits: string[] = [];
    let checkedHolders = 0;
    let holders: ResolvedHolder[] = [];
    // A creator hit already flags/blocks the coin — skip the holder RPC
    // spend (the card reason is unambiguous either way).
    if (opts.checkHolders && helius && !creatorHit) {
      const cached = this.holderCache.get(token);
      if (cached && Date.now() - cached.at < HOLDER_CACHE_MS) {
        holderHits = cached.hits;
        checkedHolders = cached.checked;
        holders = cached.holders;
      } else if (!this.holderNegativeCached(token)) {
        try {
          const largest = await helius.getTokenLargestAccounts(token);
          if (largest && largest.length > 0) {
            const owners = await helius.getAccountOwners(
              largest.slice(0, opts.holderTopN).map((a) => a.address),
            );
            const resolved: ResolvedHolder[] = [];
            largest.slice(0, opts.holderTopN).forEach((a, i) => {
              const owner = owners.get(a.address);
              if (!owner) return;
              resolved.push({
                address: a.address,
                owner,
                rank: i + 1,
                uiAmount: Number(a.uiAmount ?? 0),
              });
              checkedHolders++;
              if (this.has(owner)) holderHits.push(owner);
            });
            holders = resolved;
            this.holderCache.set(token, {
              at: Date.now(),
              hits: holderHits,
              checked: checkedHolders,
              holders,
            });
          } else {
            this.holderFailAt.set(token, Date.now());
          }
        } catch (err) {
          this.holderFailAt.set(token, Date.now());
          console.error(
            `[crimewallets] holder lookup failed for ${token}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }
    return {
      hit: creatorHit || holderHits.length > 0,
      creatorHit,
      holderHits,
      checkedHolders,
      loaded: true,
      holders,
    };
  }
}
