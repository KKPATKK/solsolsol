/**
 * Launch forensics — ported from FLURRY (慌 TERMINAL),
 * github.com/NerdHerderDani/flurry (Apache-2.0, © NerdHerderDani).
 *
 * Ports (trimmed to what this bot gates on):
 *   - deriveBondingCurvePda          from src/lib/rpc/pumpfun/pda.ts
 *   - slotActivityFromTransaction    from src/lib/rpc/pumpfun/decode.ts
 *   - detectBundle                   from packages/forensics/src/bundle.ts
 *   - clusterByFunding / linkedWalletCount  from packages/forensics/src/cluster.ts
 *   - scoreRisk                      from packages/forensics/src/risk.ts
 *   - findFundedBy / attachFundingLineage   from src/lib/rpc/pumpfun/lineage.ts + forensics.ts
 *
 * Not ported: the UI, the AI dossier, deployer-history counting
 * (countDeployerPriorLaunches — the scanner's wallet analysis already covers
 * creator history) and the RugCheck cross-check (the scanner has its own).
 *
 * Integration stance (agreed with the operator): the bundle gate runs as the
 * LAST gate before a push — only on coins that passed every other gate — so
 * its Helius spend tracks coins about to be pushed (~5-12 calls/coin typical,
 * negligible against the free tier). Fail-open everywhere: non-pump mints,
 * RPC errors, and budget exhaustion all pass without blocking, and every
 * verdict is cached per mint so re-sweeps cost 0 RPC.
 */
import { PublicKey } from "@solana/web3.js";
import type { AppConfig } from "./config";
import type { HeliusClient, ParsedTx } from "./helius";

const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const BONDING_CURVE_SEED = "bonding-curve";

/** Verdict cache cap (oldest entries dropped when exceeded). */
const CACHE_MAX = 200;
/** How long a negative result (non-pump mint / failure) is remembered. */
const NEGATIVE_CACHE_MS = 5 * 60_000;
/** Max in-slot transactions decoded per coin (create + same-slot buys). */
const MAX_IN_SLOT_TXS = 8;
/** Max deploy-slot signatures fetched from the curve account. */
const CURVE_SIG_LIMIT = 50;

/** Verified against a live create_v2 tx (Flurry's pda.test.ts vector). */
export function deriveBondingCurvePda(mint: string): string {
  const [pda] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(BONDING_CURVE_SEED), new PublicKey(mint).toBytes()],
    new PublicKey(PUMP_FUN_PROGRAM_ID),
  );
  return pda.toBase58();
}

/** A wallet's token acquisition in/around the deploy slot. */
export interface SlotActivity {
  wallet: string;
  /** Solana slot of the transaction. */
  slot: number;
  /** Share of total supply acquired in this transaction (0-100). */
  supplyPct: number;
  /** One-hop funding source (resolved by attachFundingLineage). */
  fundedBy?: string;
}

/**
 * Slot activity from token-balance deltas rather than decoding individual
 * buy-instruction variants — the RPC already parses balance changes, and that
 * signal is invariant across whichever trade instruction the swap used.
 */
export function slotActivityFromTransaction(
  tx: Pick<ParsedTx, "slot" | "meta">,
  mint: string,
  tokenTotalSupply: bigint,
): SlotActivity[] {
  const meta = tx.meta;
  if (!meta || meta.err) return [];
  const pre = new Map<number, bigint>();
  for (const b of meta.preTokenBalances ?? []) {
    if (b.mint === mint) pre.set(b.accountIndex, BigInt(b.uiTokenAmount.amount));
  }
  const out: SlotActivity[] = [];
  for (const b of meta.postTokenBalances ?? []) {
    if (b.mint !== mint || !b.owner) continue;
    const before = pre.get(b.accountIndex) ?? 0n;
    const after = BigInt(b.uiTokenAmount.amount);
    const delta = after - before;
    if (delta <= 0n || tokenTotalSupply <= 0n) continue;
    const supplyPct = Math.min(100, Number((delta * 10000n) / tokenTotalSupply) / 100);
    out.push({ wallet: b.owner, slot: tx.slot ?? 0, supplyPct });
  }
  return out;
}

export interface BundleReport {
  bundled: boolean;
  /** wallets that bought in the deploy slot */
  deploySlotWallets: number;
  /** % of supply acquired in the deploy slot */
  deploySlotSupplyPct: number;
}

/**
 * Bundle heuristic: N distinct wallets acquiring supply in the exact deploy
 * slot is the signature of a bundler (Jito-bundle-style atomic buys or
 * same-block spam). Thresholds are deliberately conservative; tune with
 * labeled data. (Flurry packages/forensics/src/bundle.ts.)
 */
export function detectBundle(
  deploySlot: number,
  activity: readonly SlotActivity[],
  opts: { minWallets?: number; minSupplyPct?: number } = {},
): BundleReport {
  const minWallets = opts.minWallets ?? 4;
  const minSupplyPct = opts.minSupplyPct ?? 15;
  const inSlot = activity.filter((a) => a.slot === deploySlot);
  const wallets = new Set(inSlot.map((a) => a.wallet));
  const supplyPct = inSlot.reduce((s, a) => s + a.supplyPct, 0);
  return {
    bundled: wallets.size >= minWallets && supplyPct >= minSupplyPct,
    deploySlotWallets: wallets.size,
    deploySlotSupplyPct: Math.round(supplyPct * 10) / 10,
  };
}

/** Wallets grouped by common funding source (clusters of size >= 2). */
export interface FundingCluster {
  funder: string;
  wallets: string[];
}

/**
 * Groups buyer wallets by common funding source. A single funder feeding
 * multiple "independent" buyers is the linked-wallet signature. Returns
 * clusters of size >= 2, largest first. (Flurry cluster.ts.)
 */
export function clusterByFunding(activity: readonly SlotActivity[]): FundingCluster[] {
  const byFunder = new Map<string, Set<string>>();
  for (const a of activity) {
    if (!a.fundedBy) continue;
    const set = byFunder.get(a.fundedBy) ?? new Set<string>();
    set.add(a.wallet);
    byFunder.set(a.fundedBy, set);
  }
  return [...byFunder.entries()]
    .filter(([, w]) => w.size >= 2)
    .map(([funder, w]) => ({ funder, wallets: [...w].sort() }))
    .sort((a, b) => b.wallets.length - a.wallets.length);
}

/** Total wallets that share funding lineage with at least one other wallet. */
export function linkedWalletCount(clusters: readonly FundingCluster[]): number {
  return clusters.reduce((s, c) => s + c.wallets.length, 0);
}

export type RiskTier = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export interface RiskInput {
  bundled: boolean;
  firstBlockSupplyPct: number;
  linkedWallets: number;
  deployerPriorRugs: number;
  devHoldsPct: number;
}

/**
 * Weighted additive score -> tier. Bundling weighs heaviest, then first-block
 * concentration and deployer rug history. Pure function; the weights are the
 * product's opinion and live here so they are testable and reviewable in one
 * place. (Flurry packages/forensics/src/risk.ts; deployer history is 0 in
 * this bot — the scanner's wallet analysis covers creator history.)
 */
export function scoreRisk(i: RiskInput): { score: number; tier: RiskTier } {
  let s = 0;
  if (i.bundled) s += 4;
  if (i.firstBlockSupplyPct > 30) s += 3;
  else if (i.firstBlockSupplyPct > 15) s += 1;
  if (i.linkedWallets > 5) s += 2;
  if (i.deployerPriorRugs > 2) s += 3;
  else if (i.deployerPriorRugs > 0) s += 1;
  if (i.devHoldsPct > 8) s += 1;
  const tier: RiskTier = s >= 7 ? "CRITICAL" : s >= 4 ? "HIGH" : s >= 2 ? "MODERATE" : "LOW";
  return { score: s, tier };
}

/** RPC seam used by the lineage walk (satisfied by HeliusClient). */
export interface ForensicsTransport {
  getSignatures(address: string, limit: number): Promise<unknown[] | null>;
  getParsedTransaction(sig: string): Promise<ParsedTx | null>;
}

/**
 * One-hop funding lineage: scans a wallet's recent history, newest first, for
 * the most recent inbound SOL transfer and reports whoever's balance dropped
 * by a matching amount in that same transaction. Exactly one hop — no
 * recursive graph walk. (Flurry lineage.ts; limit kept at 10 per operator
 * decision — the funding tx is usually within the first few txs of a
 * deploy-slot buyer's life.)
 */
export async function findFundedBy(
  transport: ForensicsTransport,
  wallet: string,
  limit = 10,
): Promise<string | null> {
  const sigs = (await transport.getSignatures(wallet, limit)) as
    | Array<{ signature: string; err?: unknown }>
    | null;
  if (!sigs) return null;
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await transport.getParsedTransaction(s.signature);
    const pre = tx?.meta?.preBalances;
    const post = tx?.meta?.postBalances;
    if (!tx || !pre || !post) continue;
    const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
      typeof k === "string" ? k : k.pubkey,
    );
    const walletIdx = keys.indexOf(wallet);
    if (walletIdx < 0) continue;
    const received = (post[walletIdx] ?? 0) - (pre[walletIdx] ?? 0);
    if (received <= 0) continue;
    const funderIdx = keys.findIndex(
      (_, i) => i !== walletIdx && (pre[i] ?? 0) - (post[i] ?? 0) >= received,
    );
    if (funderIdx >= 0) return keys[funderIdx] ?? null;
  }
  return null;
}

/**
 * Attach one hop of funding lineage per deploy-slot wallet, capped at
 * maxWallets with bounded concurrency. (Flurry forensics.ts.)
 */
export async function attachFundingLineage(
  transport: ForensicsTransport,
  activity: readonly SlotActivity[],
  opts: { maxWallets?: number; concurrency?: number } = {},
): Promise<SlotActivity[]> {
  const maxWallets = opts.maxWallets ?? 12;
  const concurrency = opts.concurrency ?? 3;
  const distinctWallets = [...new Set(activity.map((a) => a.wallet))].slice(0, maxWallets);
  const fundedByMap = new Map<string, string | null>();

  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= distinctWallets.length) return;
      const wallet = distinctWallets[i];
      if (!wallet) continue;
      fundedByMap.set(wallet, await findFundedBy(transport, wallet));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, distinctWallets.length) }, worker),
  );

  return activity.map((a) => {
    const fundedBy = fundedByMap.get(a.wallet);
    return fundedBy ? { ...a, fundedBy } : a;
  });
}

/** The forensics verdict for one mint (what the gate + card consume). */
export interface FlurryReport {
  bundled: boolean;
  deploySlotWallets: number;
  deploySlotSupplyPct: number;
  /** Wallets sharing a common funding source (0 when none / not resolved). */
  linkedWallets: number;
  /** Size of the largest common-funder cluster (0 when none). */
  clusterSize: number;
  score: number;
  tier: RiskTier;
}

export type FlurryOutcome =
  | { status: "report"; report: FlurryReport }
  | { status: "skip" };

/**
 * Deploy-slot forensics for one mint, fail-open:
 *   - non-pump mints (no curve signature history) -> skip (passes)
 *   - RPC errors / budget exceeded -> skip (passes)
 *   - verdicts cached per mint (30 min); negative results 5 min
 * Budget: bounded by the tick deadline AND a hard per-coin budget.
 */
export class FlurryAnalyzer {
  private readonly cache = new Map<string, { at: number; report: FlurryReport | null }>();
  private analyzed = 0;
  private rpcCalls = 0;
  private cacheHits = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly helius: HeliusClient,
  ) {}

  /** Cumulative counters (surfaced via /health so spend is observable). */
  stats(): { analyzed: number; rpcCalls: number; cacheHits: number } {
    return { analyzed: this.analyzed, rpcCalls: this.rpcCalls, cacheHits: this.cacheHits };
  }

  private setCache(mint: string, report: FlurryReport | null): void {
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(mint, { at: Date.now(), report });
  }

  private neg(mint: string): { status: "skip" } {
    this.setCache(mint, null);
    return { status: "skip" };
  }

  async analyze(mint: string, deadline: number): Promise<FlurryOutcome> {
    const cfg = this.config.flurry;
    if (!cfg.enabled) return { status: "skip" };

    const cached = this.cache.get(mint);
    if (cached) {
      const ttl = cached.report ? cfg.cacheMs : NEGATIVE_CACHE_MS;
      if (Date.now() - cached.at < ttl) {
        if (cached.report) this.cacheHits++;
        return cached.report ? { status: "report", report: cached.report } : { status: "skip" };
      }
      this.cache.delete(mint);
    }

    // Budget guard: only start when the whole analysis can fit in the tick
    // deadline; beyond it, defer (fail-open — the coin stays in the pool).
    if (deadline - Date.now() < cfg.budgetMs) return { status: "skip" };
    const hardDeadline = Date.now() + cfg.budgetMs;
    const expired = (): boolean => Date.now() > hardDeadline;

    // RPC seam counted per call for the /health spend counter.
    const transport: ForensicsTransport = {
      getSignatures: async (address, limit) => {
        this.rpcCalls++;
        return this.helius.getSignatures(address, limit);
      },
      getParsedTransaction: async (sig) => {
        this.rpcCalls++;
        return this.helius.getParsedTransaction(sig);
      },
    };

    try {
      // The bonding-curve PDA is deterministic — its signature history is the
      // create + every curve trade, no account-info walk needed.
      const curve = deriveBondingCurvePda(mint);
      const sigs = await transport.getSignatures(curve, CURVE_SIG_LIMIT) as
        | Array<{ signature: string; slot?: number; err?: unknown }>
        | null;
      if (!sigs || sigs.length === 0) return this.neg(mint); // non-pump mint
      // Deploy slot = slot of the oldest signature on the curve (the create).
      const create = sigs[sigs.length - 1];
      if (typeof create.slot !== "number") return this.neg(mint);

      const supply = await this.helius.getTokenSupply(mint);
      this.rpcCalls++;
      if (!supply) return this.neg(mint);
      const totalSupply = BigInt(supply.value.amount);
      if (totalSupply <= 0n) return this.neg(mint);

      const inSlot = sigs
        .filter((s) => s.slot === create.slot && !s.err)
        .slice(0, MAX_IN_SLOT_TXS);
      const activity: SlotActivity[] = [];
      for (const s of inSlot) {
        if (expired()) return this.neg(mint);
        const tx = await transport.getParsedTransaction(s.signature);
        if (!tx) continue;
        activity.push(...slotActivityFromTransaction(tx, mint, totalSupply));
      }

      const bundle = detectBundle(create.slot, activity, {
        minWallets: cfg.minWallets,
        minSupplyPct: cfg.minSupplyPct,
      });

      // Funding lineage — only meaningful when multiple wallets bought in the
      // deploy slot, so its cost scales with how bundled the launch looks.
      let linkedWallets = 0;
      let clusterSize = 0;
      if (bundle.deploySlotWallets >= 2) {
        if (expired()) return this.neg(mint);
        const withFunding = await attachFundingLineage(transport, activity, {
          maxWallets: cfg.maxWallets,
        });
        const clusters = clusterByFunding(withFunding);
        linkedWallets = linkedWalletCount(clusters);
        clusterSize = clusters.length > 0 ? clusters[0].wallets.length : 0;
      }

      const { score, tier } = scoreRisk({
        bundled: bundle.bundled,
        firstBlockSupplyPct: bundle.deploySlotSupplyPct,
        linkedWallets,
        deployerPriorRugs: 0,
        devHoldsPct: 0,
      });

      const report: FlurryReport = {
        bundled: bundle.bundled,
        deploySlotWallets: bundle.deploySlotWallets,
        deploySlotSupplyPct: bundle.deploySlotSupplyPct,
        linkedWallets,
        clusterSize,
        score,
        tier,
      };
      this.setCache(mint, report);
      this.analyzed++;
      return { status: "report", report };
    } catch (err) {
      console.error(
        "[flurry] analysis failed:",
        err instanceof Error ? err.message : err,
      );
      return this.neg(mint);
    }
  }
}