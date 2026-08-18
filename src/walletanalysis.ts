import type { AppConfig } from "./config";
import type { CrimeCheckResult, ResolvedHolder } from "./crimewallets";
import type { Db } from "./db";
import type { HeliusClient, WalletProfile } from "./helius";

/**
 * Wallet analysis for pushed coins — the "who are the wallets behind this
 * coin" layer on top of the crime-wallet blocklist:
 *
 *   A. Creator 深度分析: the creator wallet's age (oldest signature), activity
 *      (signature count) and how many pump.fun tokens it recently created
 *      (a "create..." memo count — serial-launcher detection).
 *   B. Top 持有者深度分析: how many of the top holder OWNER wallets are brand
 *      new (first signature younger than the new-wallet threshold) and
 *      whether the creator is itself a top holder.
 *   C. 跨幣 holder 聚類: the top-holder snapshot of every pushed coin is
 *      stored in pushed_holders; a wallet that keeps appearing across pushed
 *      coins is a coordinated-activity signal — the exact pattern the
 *      crimewallets list is built around, but detected from OUR pushes, so
 *      it surfaces wallets that are not (yet) on any list.
 *
 * Cost control (this user cares): the holder list itself is REUSED from the
 * crime-wallet check (CrimeCheckResult.holders — zero extra RPC). Each
 * unique wallet then costs ONE Helius call (getSignaturesForAddress), cached
 * per wallet for an hour and negative-cached on failure, and the per-coin
 * wallet count is capped. Everything is best-effort with a hard budget: a
 * slow RPC truncates the analysis, it never blocks or delays the push.
 */

/** How long a failed wallet profile is remembered (skip re-fetch). */
const FAIL_CACHE_MS = 5 * 60_000;
/** Prune pushed_holders at most this often (rows are tiny anyway). */
const PRUNE_INTERVAL_MS = 6 * 3600_000;

/** Creator-wallet analysis (feature A). */
export interface CreatorAnalysis {
  /** Raw wallet profile (null when the profile fetch failed). */
  profile: WalletProfile | null;
  /** Wallet age in hours (from the oldest signature). */
  ageHours: number | null;
  /** Serial-launcher flag: createCount >= configured threshold. */
  serialLauncher: boolean;
  /** pump.fun create count in the sampled window. */
  createCount: number;
  /** Whether this creator was already on the crime-wallet list. */
  crimeHit: boolean;
  /** Distinct pushed coins this creator wallet connects to (incl. current). */
  clusterCoins: number;
}

/** Top-holder analysis (feature B). */
export interface HolderAnalysis {
  /** How many top-holder owners were profiled. */
  checked: number;
  /** Owners whose first signature is younger than the new-wallet threshold. */
  newWallets: number;
  /** The new-wallet threshold in hours (for the card label). */
  newAgeHours: number;
  /** Rank (1-based) of the creator among top holders, when it is one. */
  creatorRank: number | null;
  /** Distinct holder wallets that hit the crime list. */
  crimeHits: number;
  /** Wallets connected to >= clusterMinCoins pushed coins (feature C). */
  cluster: Array<{ owner: string; coins: number; isCreator: boolean }>;
}

/** Result of one coin's wallet analysis (rendered on the push card). */
export interface WalletAnalysisResult {
  ok: boolean;
  skippedReason: "disabled" | "no-wallets" | null;
  creator: CreatorAnalysis | null;
  holders: HolderAnalysis;
  /** True when the per-coin budget expired mid-profiling (partial data). */
  truncated: boolean;
  /** Wall-clock ms of the analysis. */
  ms: number;
}

export interface WalletAnalyzeInput {
  token: string;
  /** Creator wallet from the RugCheck report (may be null). */
  creator: string | null;
  /** Resolved top holder owners from the crime check (reused, no extra RPC). */
  holders: ResolvedHolder[];
  /** The crime check result (for crimeHit flags). */
  crime: CrimeCheckResult;
  /** Override for deterministic tests; defaults to Date.now(). */
  now?: number;
}

export class WalletAnalyzer {
  private readonly enabled: boolean;
  private readonly maxWallets: number;
  private readonly profileCacheMs: number;
  private readonly budgetMs: number;
  private readonly creatorMinCreates: number;
  private readonly newWalletAgeHours: number;
  private readonly clusterMinCoins: number;
  private readonly clusterWindowMs: number;
  /** wallet -> cached profile (TTL-bounded, see profileCacheMs). */
  private readonly profileCache = new Map<string, { at: number; profile: WalletProfile }>();
  /** Wallets whose profile fetch failed (skip re-fetch for FAIL_CACHE_MS). */
  private readonly profileFailAt = new Map<string, number>();

  constructor(
    config: AppConfig,
    private readonly db: Db | null,
    private readonly helius: HeliusClient | null,
  ) {
    const c = config.walletAnalysis;
    this.enabled = c.enabled;
    this.maxWallets = c.maxWallets;
    this.profileCacheMs = c.profileCacheMs;
    this.budgetMs = c.budgetMs;
    this.creatorMinCreates = c.creatorMinCreates;
    this.newWalletAgeHours = c.newWalletAgeHours;
    this.clusterMinCoins = c.clusterMinCoins;
    this.clusterWindowMs = c.clusterWindowDays * 24 * 3600_000;
  }

  /**
   * One wallet's profile with caches: in-memory TTL hit → zero RPC; a recent
   * failure → skip; otherwise one Helius call (cached on success, negative-
   * cached on failure). Never throws.
   */
  private async profileCached(wallet: string): Promise<WalletProfile | null> {
    const hit = this.profileCache.get(wallet);
    if (hit && Date.now() - hit.at < this.profileCacheMs) return hit.profile;
    const failAt = this.profileFailAt.get(wallet);
    if (failAt !== undefined) {
      if (Date.now() - failAt < FAIL_CACHE_MS) return null;
      this.profileFailAt.delete(wallet);
    }
    if (!this.helius) return null;
    try {
      const profile = await this.helius.getWalletProfile(wallet);
      if (profile === null) {
        this.profileFailAt.set(wallet, Date.now());
        return null;
      }
      this.profileCache.set(wallet, { at: Date.now(), profile });
      return profile;
    } catch (err) {
      this.profileFailAt.set(wallet, Date.now());
      console.error(
        `[wallet] profile lookup failed for ${wallet.slice(0, 8)}…:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Prune pushed_holders at most once per PRUNE_INTERVAL_MS (best-effort). */
  private async pruneIfDue(now: number): Promise<void> {
    if (!this.db) return;
    try {
      const last = await this.db.getWorkerState("pushed_holders_last_prune");
      if (last !== null && now - Number(last) < PRUNE_INTERVAL_MS) return;
      await this.db.prunePushedHolders(now - this.clusterWindowMs);
      await this.db.setWorkerState("pushed_holders_last_prune", String(now));
    } catch (err) {
      console.error(
        "[wallet] pushed_holders prune failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Analyze one pushed coin's wallets. Never throws: every stage is guarded
   * and best-effort, and the RPC profiling is bounded by budgetMs (on expiry
   * the analysis returns partial data flagged `truncated`). The pushed_holders
   * snapshot is written FIRST (DB-only, cheap) so cross-coin clustering sees
   * this coin even when the profiling times out.
   */
  async analyze(input: WalletAnalyzeInput): Promise<WalletAnalysisResult> {
    const now = input.now ?? Date.now();
    const startedAt = Date.now();
    const empty: WalletAnalysisResult = {
      ok: false,
      skippedReason: null,
      creator: null,
      holders: {
        checked: 0,
        newWallets: 0,
        newAgeHours: this.newWalletAgeHours,
        creatorRank: null,
        crimeHits: 0,
        cluster: [],
      },
      truncated: false,
      ms: 0,
    };
    if (!this.enabled) {
      return { ...empty, skippedReason: "disabled" };
    }

    // Unique wallet list: creator first (its profile drives the launcher
    // signal), then holder owners by rank, deduped and capped.
    const wallets: string[] = [];
    const seen = new Set<string>();
    if (input.creator) {
      wallets.push(input.creator);
      seen.add(input.creator);
    }
    for (const h of input.holders) {
      if (wallets.length >= this.maxWallets) break;
      if (!seen.has(h.owner)) {
        seen.add(h.owner);
        wallets.push(h.owner);
      }
    }
    if (wallets.length === 0) {
      return { ...empty, skippedReason: "no-wallets" };
    }

    // Feature C input: one row per owner (creator row rank 0 + holder rows),
    // tagged with creator/crime flags, anchored to this push time.
    const byOwner = new Map<string, ResolvedHolder & { isCreator: boolean }>();
    for (const h of input.holders) {
      byOwner.set(h.owner, { ...h, isCreator: h.owner === input.creator });
    }
    if (input.creator && !byOwner.has(input.creator)) {
      byOwner.set(input.creator, {
        address: "",
        owner: input.creator,
        rank: 0,
        uiAmount: 0,
        isCreator: true,
      });
    }
    const rows = [...byOwner.values()].map((h) => ({
      token: input.token,
      owner: h.owner,
      rank: h.rank,
      uiAmount: Number(h.uiAmount ?? 0),
      isCreator: h.isCreator,
      crimeHit: h.isCreator
        ? input.crime.creatorHit
        : input.crime.holderHits.includes(h.owner),
    }));
    try {
      await this.db?.recordPushedHolders(rows, now);
      await this.pruneIfDue(now);
    } catch (err) {
      console.error(
        "[wallet] pushed_holders snapshot failed:",
        err instanceof Error ? err.message : err,
      );
    }

    // Profile wallets serially against the budget (the Helius throttle
    // serializes the RPC calls anyway; a serial loop with deadline checks
    // gives clean truncation and a partial result).
    const profiles = new Map<string, WalletProfile | null>();
    let truncated = false;
    for (const w of wallets) {
      if (Date.now() - startedAt > this.budgetMs) {
        truncated = true;
        break;
      }
      profiles.set(w, await this.profileCached(w));
    }

    // Feature A: creator profile.
    const creatorProfile = input.creator ? (profiles.get(input.creator) ?? null) : null;
    const creator: CreatorAnalysis | null = input.creator
      ? {
          profile: creatorProfile,
          ageHours:
            creatorProfile?.firstTxMs !== null && creatorProfile?.firstTxMs !== undefined
              ? (now - creatorProfile.firstTxMs) / 3600_000
              : null,
          serialLauncher:
            (creatorProfile?.createCount ?? 0) >= this.creatorMinCreates,
          createCount: creatorProfile?.createCount ?? 0,
          crimeHit: input.crime.creatorHit,
          clusterCoins: 0, // filled after the cluster lookup
        }
      : null;

    // Feature B: holder ages + creator rank.
    const holderOwners = [...new Set(input.holders.map((h) => h.owner))];
    let checked = 0;
    let newWallets = 0;
    for (const w of holderOwners) {
      const p = profiles.get(w);
      if (!p) continue;
      checked++;
      if (
        p.firstTxMs !== null &&
        now - p.firstTxMs < this.newWalletAgeHours * 3600_000
      ) {
        newWallets++;
      }
    }
    const creatorRank =
      input.holders.find((h) => h.owner === input.creator)?.rank ?? null;
    const holders: HolderAnalysis = {
      checked,
      newWallets,
      newAgeHours: this.newWalletAgeHours,
      creatorRank,
      crimeHits: new Set(input.crime.holderHits).size,
      cluster: [],
    };

    // Feature C: cross-coin clustering for every wallet in this coin.
    const cluster: Array<{ owner: string; coins: number; isCreator: boolean }> = [];
    const creatorWallet = input.creator;
    try {
      if (this.db) {
        const found = await this.db.getHolderClusters(
          [...seen],
          now - this.clusterWindowMs,
          this.clusterMinCoins,
        );
        for (const f of found) {
          cluster.push({ owner: f.owner, coins: f.coins, isCreator: f.isCreator });
          if (creator && creatorWallet && f.owner === creatorWallet) {
            creator.clusterCoins = f.coins;
          }
        }
        // The creator row always exists (recorded above), so its raw distinct
        // count is at least 1 even when it is below the cluster threshold.
        if (creator && creatorWallet && creator.clusterCoins === 0) {
          try {
            const self = await this.db.getHolderClusters(
              [creatorWallet],
              now - this.clusterWindowMs,
              1,
            );
            creator.clusterCoins =
              self.find((f) => f.owner === creatorWallet)?.coins ?? 0;
          } catch {
            // telemetry only
          }
        }
      }
    } catch (err) {
      console.error(
        "[wallet] cluster lookup failed:",
        err instanceof Error ? err.message : err,
      );
    }
    holders.cluster = cluster;

    return {
      ok: true,
      skippedReason: null,
      creator,
      holders,
      truncated,
      ms: Date.now() - startedAt,
    };
  }
}
