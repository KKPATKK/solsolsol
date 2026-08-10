import type { AppConfig } from "./config";

/**
 * On-chain first-minute volume for pump.fun-era Solana tokens, computed
 * without Birdeye (whose OHLCV endpoint cost 35 CU per call — the biggest
 * consumer of the free-tier credit budget).
 *
 * The "opening volume" is, on-chain, the SOL that moved through the token's
 * launch market during [pairCreatedAt, pairCreatedAt + 60s). We compute that
 * with plain Solana JSON-RPC (~1 credit per call on Helius' free plan):
 *
 *   1. Identify the launch market for the mint:
 *      - fast path: the DexScreener pair address itself (bonding curve or
 *        PumpSwap pool). Its signature history must overlap the launch
 *        window, which doubles as the identity check — a wrongly associated
 *        address has signatures elsewhere in time and is rejected.
 *      - fallback: the bonding curve found via the mint's create transaction
 *        (the account owned by the pump.fun program with a BondingCurve
 *        discriminator, or the closed account at the curve's fixed position
 *        once the token has graduated).
 *   2. The opening window is anchored to the market's own earliest chain
 *      signature (paged back past busy history) rather than DexScreener's
 *      pairCreatedAt, which on fresh pump pairs can precede on-chain
 *      activity by minutes. DexScreener's time still bounds the identity
 *      check: an account whose history starts long before it is not this
 *      token's launch market.
 *   3. For transactions in the opening window [t0, t0 + 60s), sum the SOL that
 *      moved into/out of that account: native lamport balance deltas (bonding
 *      curve) and/or WSOL token-balance deltas (AMM pools hold SOL as SPL).
 *      This is layout-independent — no event decoding — and works even for
 *      accounts that have since been closed (ledger balances persist).
 *   4. Convert SOL → USD using the DexScreener pair (priceUsd / priceNative),
 *      falling back to a cached GeckoTerminal SOL price.

 * Cost: ~10-14 RPC calls per coin, once per coin (result cached in the DB).
 * Every failure mode falls back gracefully: non-pump tokens, graduated
 * markets whose history is unreachable, and RPC outages all return null, and
 * the scanner then uses its existing free proxy (DexScreener m5) instead —
 * exactly the previous behavior, minus the Birdeye credit spend.
 *
 * Without HELIUS_API_KEY the client uses the public Solana RPC, which
 * rate-limits datacenter IPs — fine for local testing, throttled in
 * production where the proxy value is used until a key is added.
 */

const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** Wrapped SOL native mint — AMM pools hold SOL as an SPL token account. */
const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** First 8 bytes of sha256("account:BondingCurve") — verified on-chain. */
const BONDING_CURVE_DISC_HEX = "17b7f83760d8ac60";
const BONDING_CURVE_DISC = (() => {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number.parseInt(BONDING_CURVE_DISC_HEX.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
})();

const SOL_PRICE_CACHE_MS = 5 * 60_000;
const CURVE_CACHE_MAX = 300;
/** After this many consecutive RPC failures, pause lookups for a while. */
const CIRCUIT_BREAK_THRESHOLD = 3;
const CIRCUIT_BREAK_MS = 5 * 60_000;
/**
 * More trades than this in the opening minute means the coin is too hot to
 * enumerate cheaply — treat the volume as unknown (proxy decides) instead of
 * spending 25+ credits fetching the whole window. 50 covers moderately hot
 * coins (~1 tx / 1.2 s) — up to 50 getTransaction calls per coin, cached in
 * the DB afterwards.
 */
const MAX_WINDOW_TRADES = 50;
/** Page limit when hunting back for the launch minute in a busy account. */
const WINDOW_PAGE_LIMIT = 5;
/**
 * Reject a candidate launch market whose chain history starts well before
 * DexScreener's recorded creation time (wrongly associated pair address).
 */
const LAUNCH_ANCHOR_TOLERANCE_S = 15 * 60;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spaces out RPC requests so we stay well under endpoint rate limits. */
class Throttle {
  private lastCallAt = 0;
  constructor(private readonly intervalMs: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const wait = Math.max(0, this.lastCallAt + this.intervalMs - Date.now());
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
    return fn();
  }
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Hex compare against the first N bytes of `bytes`. */
function startsWithHex(bytes: Uint8Array, hex: string): boolean {
  if (bytes.length < hex.length / 2) return false;
  for (let i = 0; i < hex.length; i += 2) {
    const want = Number.parseInt(hex.slice(i, i + 2), 16);
    if (bytes[i / 2] !== want) return false;
  }
  return true;
}

interface TokenBalanceEntry {
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

interface TxLike {
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
    };
  };
  meta?: {
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
    logMessages?: string[];
  };
  blockTime?: number | null;
}

interface SigInfo {
  signature: string;
  blockTime?: number | null;
  memo?: string | null;
}

export interface OpeningVolumeInput {
  /** USD price of 1 base token (from the DexScreener pair). */
  priceUsd?: number | string;
  /** Price of 1 base token in native quote (SOL) — used to derive SOL/USD. */
  priceNative?: number | string;
  /** Pair creation time in ms (Unix epoch) — anchors the opening window. */
  pairCreatedAt: number;
  /** DexScreener pair address — verified as the PumpSwap pool when applicable. */
  pairAddress: string;
}

export class HeliusClient {
  private readonly endpoint: string;
  private readonly throttle: Throttle;
  /** mint -> bonding curve address (verified), bounded in-memory cache. */
  private readonly curveCache = new Map<string, string>();
  private consecutiveErrors = 0;
  private circuitOpenUntil = 0;
  private geckoPrice: { usd: number; at: number } | null = null;

  constructor(config: AppConfig) {
    this.endpoint = config.heliusApiKey
      ? `https://mainnet.helius-rpc.com/?api-key=${config.heliusApiKey}`
      : "https://api.mainnet-beta.solana.com";
    this.throttle = new Throttle(config.heliusRequestIntervalMs);
  }

  private get circuitOpen(): boolean {
    return Date.now() < this.circuitOpenUntil;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T | null> {
    if (this.circuitOpen) return null;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.throttle.run(() =>
          fetch(this.endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: AbortSignal.timeout(12_000),
          }),
        );
        if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
        const body = (await res.json()) as {
          result?: T;
          error?: { message?: string };
        };
        if (body.error) throw new Error(`RPC ${method}: ${body.error.message}`);
        this.consecutiveErrors = 0;
        return body.result ?? null;
      } catch (err) {
        lastErr = err;
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= CIRCUIT_BREAK_THRESHOLD) {
          this.circuitOpenUntil = Date.now() + CIRCUIT_BREAK_MS;
          console.error(
            `[helius] circuit breaker open for ${CIRCUIT_BREAK_MS / 1000}s after repeated RPC failures`,
          );
        }
        if (attempt < 3) await sleep(attempt * 1000);
      }
    }
    console.error(
      "[helius] RPC failed:",
      lastErr instanceof Error ? lastErr.message : String(lastErr),
    );
    return null;
  }

  /**
   * Find the bonding curve account for a pump.fun mint, or null when the mint
   * has no pump.fun curve (e.g. a Token-2022/PumpSwap-only token).
   */
  async findCurveAddress(mint: string): Promise<string | null> {
    const cached = this.curveCache.get(mint);
    if (cached !== undefined) return cached;

    // Page back far enough that the create transaction (which initializes the
    // curve) is reachable — hot tokens easily accumulate 100+ signatures in
    // their first hour, which is exactly when this matters.
    const sigs: SigInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < 3; page++) {
      const batch = await this.rpc<SigInfo[]>("getSignaturesForAddress", [
        mint,
        { limit: 100, ...(before ? { before } : {}) },
      ]);
      if (!batch || batch.length === 0) break;
      sigs.push(...batch);
      if (batch.length < 100) break;
      before = batch[batch.length - 1].signature;
    }
    if (sigs.length === 0) return null;

    // Prefer a create transaction when the memo says so (pump create txs
    // carry a "create..." memo), then fall back to the oldest signatures.
    const createMemo = sigs.find((s) =>
      s.memo?.toLowerCase().startsWith("create"),
    );
    const candidates = createMemo
      ? [createMemo, ...sigs].filter((s) => s !== createMemo)
      : [...sigs];
    const oldest = candidates
      .sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0))
      .slice(0, 3);
    for (const sig of oldest) {
      const tx = await this.rpc<TxLike>("getTransaction", [
        sig.signature,
        { maxSupportedTransactionVersion: 0, encoding: "json" },
      ]);
      if (!tx) continue;
      const curve = await this.findCurveInTx(tx);
      if (curve) {
        if (this.curveCache.size >= CURVE_CACHE_MAX) this.curveCache.clear();
        this.curveCache.set(mint, curve);
        return curve;
      }
    }
    return null;
  }

  /**
   * Scan a pump transaction's account keys for the bonding curve. Prefers a
   * live pump-owned account with the BondingCurve discriminator; falls back
   * to the closed account at the curve's fixed early position (a graduated
   * token's curve is closed, but its historical balance deltas are intact).
   */
  private async findCurveInTx(tx: TxLike): Promise<string | null> {
    const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
      typeof k === "string" ? k : k.pubkey,
    );
    // Cheap gate: the pump program itself is always a key in pump txs.
    if (!keys.includes(PUMP_PROGRAM)) return null;
    const logs = tx.meta?.logMessages ?? [];
    const ranPumpInstruction = logs.some((l) =>
      l.includes("Program log: Instruction:"),
    );
    for (let i = 0; i < Math.min(keys.length, 8); i++) {
      const key = keys[i];
      const info = await this.rpc<{
        value?: { owner?: string; data?: [string, string] } | null;
      }>("getAccountInfo", [key, { encoding: "base64" }]);
      const value = info?.value;
      if (value) {
        if (
          value.owner === PUMP_PROGRAM &&
          value.data?.[0] &&
          startsWithHex(fromBase64(value.data[0]), BONDING_CURVE_DISC_HEX)
        ) {
          return key;
        }
        continue; // live account — not a closed curve
      }
      // Account closed (graduated): only accept the curve's fixed position in
      // a tx that actually ran pump instructions.
      if (ranPumpInstruction && i >= 1 && i <= 4) return key;
    }
    return null;
  }

  /**
   * Exact USD volume traded during the opening minute on the token's launch
   * market (bonding curve or PumpSwap pool). Returns null when it cannot be
   * determined — callers then fall back to the DexScreener proxy.
   *
   * The launch-window anchor doubles as the identity check: an account is the
   * token's launch market iff its own signature history overlaps the launch
   * minute. A wrongly-associated pair address (DexScreener occasionally maps
   * a pump pair to another token's curve) has signatures elsewhere in time
   * and is naturally rejected by the window filter.
   */
  async getFirstMinuteVolumeUsd(
    mint: string,
    input: OpeningVolumeInput,
  ): Promise<number | null> {
    // Cheap pre-guard: never compute before the opening minute could have
    // elapsed on the DexScreener clock. The precise guard lives in
    // computeWindowVolumeLamports, anchored to the chain's own launch time.
    if (Date.now() - input.pairCreatedAt < 75_000) return null;
    const dexCreatedSec = Math.floor(input.pairCreatedAt / 1000);

    // Fast path: the DexScreener pair address. Window-verified, so it works
    // for both the classic curve (owner 6EF8, possibly closed after
    // graduation) and the current-era PumpSwap pool — no program-ID guessing.
    if (input.pairAddress) {
      const solVol = await this.computeWindowVolumeLamports(
        input.pairAddress,
        dexCreatedSec,
      );
      if (solVol !== null) return this.solLamportsToUsd(solVol.lamports, input);
    }

    // Fallback: find the bonding curve via the mint's create transaction
    // (covers tokens whose DexScreener pair address is unusable).
    const curve = await this.findCurveAddress(mint);
    if (curve && curve !== input.pairAddress) {
      const solVol = await this.computeWindowVolumeLamports(curve, dexCreatedSec);
      if (solVol !== null) return this.solLamportsToUsd(solVol.lamports, input);
    }
    return null;
  }

  /**
   * Sum the SOL (in lamports) that moved through `addr` during its opening
   * minute [t0, t0 + 60s), where t0 is the account's own earliest signature
   * (paged back far enough to reach it). Returns { lamports, t0Sec }, or null
   * when the window cannot be determined — callers fall back to the proxy.
   *
   * Native balance deltas (bonding curve) plus WSOL token-balance deltas
   * (PumpSwap pools hold SOL as an SPL token account owned by the pool).
   */
  private async computeWindowVolumeLamports(
    addr: string,
    dexCreatedSec: number,
  ): Promise<{ lamports: number; t0Sec: number } | null> {
    // Page back so busy tokens' launch minute is reachable: a fresh coin can
    // push its earliest signatures beyond the newest-100 page within minutes.
    const sigs: SigInfo[] = [];
    let before: string | undefined;
    let exhausted = false;
    for (let page = 0; page < WINDOW_PAGE_LIMIT; page++) {
      const batch = await this.rpc<SigInfo[]>("getSignaturesForAddress", [
        addr,
        { limit: 100, ...(before ? { before } : {}) },
      ]);
      if (!batch || batch.length === 0) return null;
      sigs.push(...batch);
      if (batch.length < 100) {
        exhausted = true; // reached the account's first signature
        break;
      }
      before = batch[batch.length - 1].signature;
    }

    const timed = sigs.filter(
      (s): s is SigInfo & { blockTime: number } =>
        typeof s.blockTime === "number",
    );
    if (timed.length === 0) return null;
    timed.sort((a, b) => a.blockTime - b.blockTime);
    const t0 = timed[0].blockTime;

    // Identity check: chain activity long before DexScreener's creation time
    // means this address is not the token's launch market.
    if (t0 < dexCreatedSec - LAUNCH_ANCHOR_TOLERANCE_S) return null;
    // Still paging at the cap: if the earliest signature we reached disagrees
    // with DexScreener's clock by a lot, the launch minute is unreachable —
    // don't guess, let the proxy decide.
    if (!exhausted && Math.abs(t0 - dexCreatedSec) > 10 * 60) return null;
    // Never compute a partial opening minute (under-reports, could pass a
    // hot coin through the filter).
    if (Date.now() - t0 * 1000 < 75_000) return null;

    const inWindow = timed.filter(
      (s) => s.blockTime >= t0 && s.blockTime < t0 + 60,
    );
    if (inWindow.length === 0) return null;
    if (inWindow.length > MAX_WINDOW_TRADES) return null; // too hot to enumerate cheaply

    let volLamports = 0;
    for (const sig of inWindow) {
      const tx = await this.rpc<TxLike>("getTransaction", [
        sig.signature,
        { maxSupportedTransactionVersion: 0, encoding: "json" },
      ]);
      if (!tx) continue;

      // Native lamport balance delta on the account itself.
      const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
        typeof k === "string" ? k : k.pubkey,
      );
      const idx = keys.indexOf(addr);
      if (idx >= 0) {
        const pre = tx.meta?.preBalances?.[idx];
        const post = tx.meta?.postBalances?.[idx];
        if (typeof pre === "number" && typeof post === "number") {
          volLamports += Math.abs(post - pre);
        }
      }
      // WSOL token-balance delta on the account's own token account (pools).
      let wsolPre = 0n;
      let wsolPost = 0n;
      for (const e of tx.meta?.preTokenBalances ?? []) {
        if (e.mint === WSOL_MINT && e.owner === addr) {
          wsolPre = BigInt(e.uiTokenAmount?.amount ?? "0");
        }
      }
      for (const e of tx.meta?.postTokenBalances ?? []) {
        if (e.mint === WSOL_MINT && e.owner === addr) {
          wsolPost = BigInt(e.uiTokenAmount?.amount ?? "0");
        }
      }
      const wsolDelta = wsolPre > wsolPost ? wsolPre - wsolPost : wsolPost - wsolPre;
      if (wsolDelta > 0n) volLamports += Number(wsolDelta);
    }
    return volLamports > 0 ? { lamports: volLamports, t0Sec: t0 } : null;
  }

  private async solLamportsToUsd(
    lamports: number,
    input: OpeningVolumeInput,
  ): Promise<number | null> {
    const solUsd = await this.solUsd(input);
    if (solUsd === null) return null;
    return (lamports / 1e9) * solUsd;
  }

  /** SOL/USD from the pair (priceUsd / priceNative), else cached GeckoTerminal. */
  private async solUsd(input: OpeningVolumeInput): Promise<number | null> {
    const usd = Number(input.priceUsd);
    const native = Number(input.priceNative);
    if (
      Number.isFinite(usd) &&
      Number.isFinite(native) &&
      usd > 0 &&
      native > 0
    ) {
      return usd / native;
    }
    return this.geckoSolUsd();
  }

  private async geckoSolUsd(): Promise<number | null> {
    if (this.geckoPrice && Date.now() - this.geckoPrice.at < SOL_PRICE_CACHE_MS) {
      return this.geckoPrice.usd;
    }
    try {
      const res = await fetch(
        "https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/So11111111111111111111111111111111111111112",
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        data?: { attributes?: { token_prices?: Record<string, string> } };
      };
      const price = Number(
        body.data?.attributes?.token_prices?.[
          "So11111111111111111111111111111111111111112"
        ],
      );
      if (!Number.isFinite(price) || price <= 0) return null;
      this.geckoPrice = { usd: price, at: Date.now() };
      return price;
    } catch {
      return null;
    }
  }
}
