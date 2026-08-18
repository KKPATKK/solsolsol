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
 * repo's `raw format.txt`), re-fetched at most once per refreshMs per
 * isolate (the in-memory gate; the worker also persists the last refresh
 * time in worker_state for /health diagnostics). A failed fetch keeps the
 * previous list and records lastError — the scan path never blocks on this.
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
  loadedAt: number | null;
  lastError: string | null;
  refreshMs: number;
}

/** Default raw-list URL (solguala/crimewallets `raw format.txt`). */
export const DEFAULT_CRIME_WALLETS_URL =
  "https://raw.githubusercontent.com/solguala/crimewallets/main/raw%20format.txt";

export class CrimeWalletClient {
  private wallets = new Set<string>();
  private loadedAt: number | null = null;
  private lastError: string | null = null;
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
    };
  }

  /** Exact membership test against the loaded list. */
  has(address: string): boolean {
    return this.wallets.has(address);
  }

  /**
   * Re-fetch the list when the in-memory copy is stale (or `force`).
   * Non-throwing: a fetch failure keeps the previous list and records
   * lastError, so the scanner can call this every tick without any risk to
   * the scan. Returns the outcome for the /debug endpoint.
   */
  async refreshIfStale(force = false): Promise<{ ok: boolean; size: number }> {
    if (!force && this.loadedAt !== null && Date.now() - this.loadedAt < this.refreshMs) {
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
      this.lastError = null;
      try {
        await this.db?.setWorkerState("crime_wallets_updated_at", String(this.loadedAt));
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
      return { ok: false, size: this.wallets.size };
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
