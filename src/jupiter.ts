import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { TradeConfigSettings } from "./config";
import type { Db } from "./db";

/**
 * Jupiter direct on-chain trading — the replacement for the retired Trojan
 * API. The bot builds a quote, gets a signed swap transaction from Jupiter's
 * Swap API, signs it with the operator's dedicated wallet (base58 secret in
 * BOT_WALLET_PRIVATE_KEY — never logged) and submits it via the Helius RPC.
 *
 * Flow (Jupiter Swap API v1 / Metis — the v6 quote-api.jup.ag endpoints were
 * retired; the current base is api.jup.ag, keyless at 0.5 RPS or with an
 * optional x-api-key header):
 *   1. GET  /swap/v1/quote?inputMint=SOL&outputMint=<token>&amount=<lamports>
 *            &slippageBps=<pct*100>&restrictIntermediateTokens=true
 *            &instructionVersion=V2                 → route quote (Metis)
 *   2. POST /swap/v1/swap { quoteResponse, userPublicKey, wrapAndUnwrapSol,
 *            dynamicComputeUnitLimit, prioritizationFeeLamports }
 *                                                    → { swapTransaction: b64 }
 *   3. deserialize → sign with wallet → serialize → sendTransaction (RPC)
 *
 * Safety rails live in TradeService / tradeDecision (mode, per-coin dedupe,
 * daily cap); the client itself adds a balance pre-check so a buy never
 * burns priority fees on a wallet that cannot afford it.
 */

/** Trade modes: off = disabled, manual = button on push cards, auto = buy on push. */
export type TradeMode = "off" | "manual" | "auto";

/**
 * Resolve the EFFECTIVE trade mode (pure — unit-tested): a Telegram
 * /setmode override stored in the DB wins over the env-config mode; an
 * invalid override value is ignored. Every money-moving path resolves
 * through here so a live /setmode flip applies immediately, and flipping
 * back to the env value (override cleared) restores the env config.
 */
export function resolveTradeMode(
  cfgMode: TradeMode,
  override: string | null,
): TradeMode {
  if (override === "off" || override === "manual" || override === "auto") {
    return override;
  }
  return cfgMode;
}

/** Normalized buy result. */
export interface TradeOrderResult {
  ok: boolean;
  txHash?: string;
  error?: string;
}

/** Whether a buy may proceed for a token right now. */
export interface TradeDecision {
  ok: boolean;
  reason?: string;
}

/**
 * Pure trade-decision gate (unit-tested): a buy only proceeds when every
 * guard passes. Buying is real money — each gate is explicit.
 */
export function tradeDecision(
  cfg: Pick<TradeConfigSettings, "mode" | "maxDailyBuys">,
  state: { alreadyTraded: boolean; todayCount: number },
): TradeDecision {
  if (cfg.mode === "off") return { ok: false, reason: "mode=off（交易未启用）" };
  if (state.alreadyTraded) return { ok: false, reason: "该币已下过单" };
  if (state.todayCount >= cfg.maxDailyBuys) {
    return {
      ok: false,
      reason: `已达每日上限（${state.todayCount}/${cfg.maxDailyBuys}）`,
    };
  }
  return { ok: true };
}

/**
 * Resolve the buy input size in lamports (unit-tested). When balancePct is
 * set (>0) the size is that share of the CURRENT wallet balance, computed
 * live at execution time — so the manual button's size never goes stale and
 * auto mode always spends the same share. Otherwise the fixed amountSol is
 * used. In percentage mode a missing or empty balance is an error: buying
 * blind is never allowed.
 */
export function buyAmountLamports(
  balanceLamports: number | null,
  balancePct: number,
  fixedAmountSol: number,
): { amountLamports: number; source: "balance" | "fixed" } | { error: string } {
  if (balancePct > 0) {
    if (balanceLamports === null) {
      return { error: "无法读取钱包余额，无法按比例下单" };
    }
    if (balanceLamports <= 0) {
      return { error: "钱包余额为 0（请先入金）" };
    }
    return {
      amountLamports: Math.floor(balanceLamports * (balancePct / 100)),
      source: "balance",
    };
  }
  return { amountLamports: Math.floor(fixedAmountSol * 1e9), source: "fixed" };
}

/** SOL mint on Solana (the input side of every buy, output of every sell). */
const SOL_MINT = "So11111111111111111111111111111111111111112";
/** USDC mint — used by verify() for a read-only quote sanity check. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Standard SPL-Token program (pump.fun tokens use this). */
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** Token-2022 program — queried too so newer tokens are still sellable. */
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Sell fraction on the 🛒 card buttons / /sell command. */
export type SellFraction = "half" | "all";

/**
 * Parse a `sell:<half|all>:<mint>` callback payload (pure — unit-tested).
 * Returns null for anything else (buy:…, junk, malformed mint).
 */
export function parseSellCallback(
  data: string,
): { mode: SellFraction; token: string } | null {
  if (!data.startsWith("sell:")) return null;
  const parts = data.split(":");
  if (parts.length !== 3) return null;
  if (parts[1] !== "half" && parts[1] !== "all") return null;
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(parts[2])) return null;
  return { mode: parts[1], token: parts[2] };
}

/**
 * Token amount (raw units, incl. decimals) to sell for a fraction of the
 * held balance (pure — unit-tested): all = everything, half = floor(raw/2).
 */
export function sellAmountRaw(raw: bigint, mode: SellFraction): bigint {
  if (mode === "all") return raw;
  return raw / 2n;
}

/** Next mode in the card mode-button cycle: manual → auto → off → manual. */
export function nextTradeMode(mode: TradeMode): TradeMode {
  if (mode === "manual") return "auto";
  if (mode === "auto") return "off";
  return "manual";
}

/**
 * Parse a `mode:<toggle|apply|cancel>[:<mode>]:<mint>` callback payload
 * (pure — unit-tested). Returns null for buy/sell callbacks and junk.
 */
export function parseModeCallback(
  data: string,
): { action: "toggle" | "apply" | "cancel"; token: string; mode?: TradeMode } | null {
  if (!data.startsWith("mode:")) return null;
  const parts = data.split(":");
  const token = parts[parts.length - 1];
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)) return null;
  if (parts.length === 3 && parts[1] === "toggle") {
    return { action: "toggle", token };
  }
  if (parts.length === 3 && parts[1] === "cancel") {
    return { action: "cancel", token };
  }
  if (
    parts.length === 4 &&
    parts[1] === "apply" &&
    (parts[2] === "manual" || parts[2] === "auto" || parts[2] === "off")
  ) {
    return { action: "apply", token, mode: parts[2] };
  }
  return null;
}

/**
 * Normalize a Jupiter /v6/quote response (unit-tested). Accepts the
 * documented shape defensively and always surfaces the raw payload.
 */
export function parseQuote(raw: unknown): { ok: boolean; quote?: unknown; error?: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: `quote 响应格式异常: ${String(raw)}` };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.quoteResponse && typeof obj.quoteResponse === "object") {
    return { ok: true, quote: obj.quoteResponse };
  }
  if (obj.outAmount !== undefined && typeof obj === "object") {
    // Some responses return the route directly.
    return { ok: true, quote: obj };
  }
  const error =
    typeof obj.error === "string"
      ? obj.error
      : typeof obj.message === "string"
        ? obj.message
        : "无可用路由（该币可能仍处于 bonding curve 或流动性不足）";
  return { ok: false, error };
}

/**
 * Normalize the RPC sendTransaction response (unit-tested). JSON-RPC
 * success returns { result: <signature> }; failure returns { error }.
 */
export function parseSendResponse(raw: unknown): TradeOrderResult {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: `RPC 响应格式异常: ${String(raw)}` };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.result === "string" && obj.result.length > 0) {
    return { ok: true, txHash: obj.result };
  }
  const err = obj.error as Record<string, unknown> | undefined;
  const message =
    typeof err?.message === "string"
      ? err.message
      : typeof obj.error === "string"
        ? obj.error
        : "RPC 发送失败（未知错误）";
  return { ok: false, error: message };
}

/**
 * Thin HTTP helper with a hard timeout (AbortSignal.timeout) so a hung
 * quote/swap/RPC call can never wedge the scanner tick.
 */
async function jsonFetch<T>(
  url: string,
  timeoutMs: number,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Jupiter/RPC ${url.slice(0, 80)} → HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

/** Jupiter quote + swap + sign + send client (self-custodial). */
export class JupiterClient {
  constructor(private readonly cfg: TradeConfigSettings) {}

  /** The trading wallet's public key (base58) — safe to log. */
  get walletPublicKey(): string {
    return this.keypair().publicKey.toBase58();
  }

  private keypair(): Keypair {
    if (!this.cfg.walletSecret) throw new Error("BOT_WALLET_PRIVATE_KEY 未配置");
    return Keypair.fromSecretKey(bs58.decode(this.cfg.walletSecret));
  }

  private rpcUrl(): string {
    if (this.cfg.rpcUrl) return this.cfg.rpcUrl;
    return "https://api.mainnet-beta.solana.com";
  }

  /** Optional x-api-key header — unlocks higher rate limits on the new
   * developer platform; keyless still works at 0.5 RPS. */
  private apiHeaders(): Record<string, string> {
    return this.cfg.jupiterApiKey ? { "x-api-key": this.cfg.jupiterApiKey } : {};
  }

  /** Read-only SOL balance in lamports (null when the RPC is unreachable). */
  async getSolBalanceLamports(): Promise<number | null> {
    try {
      const res = await jsonFetch<{
        result?: { value?: number };
        error?: { message?: string };
      }>(
        this.rpcUrl(),
        this.cfg.timeoutMs,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getBalance",
          params: [this.walletPublicKey],
        },
      );
      const lamports = res.result?.value;
      return typeof lamports === "number" ? lamports : null;
    } catch (err) {
      console.error("[jupiter] balance check failed:", err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Read-only quote for one route (no wallet, no signing, no spend). */
  async getQuote(
    outputMint: string,
    inputLamports: number,
    slippageBps: number,
  ): Promise<{ ok: boolean; quote?: unknown; error?: string }> {
    return this.getQuoteRaw(SOL_MINT, outputMint, inputLamports, slippageBps);
  }

  /** Quote for an arbitrary input→output pair (buys: SOL→token, sells: token→SOL). */
  private async getQuoteRaw(
    inputMint: string,
    outputMint: string,
    amountRaw: number | bigint,
    slippageBps: number,
  ): Promise<{ ok: boolean; quote?: unknown; error?: string }> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amountRaw),
      slippageBps: String(Math.floor(slippageBps)),
      restrictIntermediateTokens: "true",
      instructionVersion: "V2",
    });
    try {
      const raw = await jsonFetch<unknown>(
        `${this.cfg.jupiterApiBase}/swap/v1/quote?${params.toString()}`,
        this.cfg.timeoutMs,
        undefined,
        this.apiHeaders(),
      );
      return parseQuote(raw);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Read-only: the wallet's raw balance of a token (both SPL and Token-2022
   * programs), plus its decimals/ui amount. null when the RPC is unreachable
   * or the wallet has no account for the mint.
   */
  async getTokenBalance(
    mint: string,
  ): Promise<{ raw: bigint; uiAmount: number; decimals: number } | null> {
    try {
      let raw = 0n;
      let decimals = 0;
      let uiAmount = 0;
      for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
        const res = await jsonFetch<{
          result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number; uiAmount?: number } } } } } }> };
        }>(
          this.rpcUrl(),
          this.cfg.timeoutMs,
          {
            jsonrpc: "2.0",
            id: 1,
            method: "getTokenAccountsByOwner",
            params: [
              this.walletPublicKey,
              { programId: program },
              { encoding: "jsonParsed" },
            ],
          },
        );
        for (const acc of res.result?.value ?? []) {
          const info = acc.account?.data?.parsed?.info;
          if (!info || info.mint !== mint) continue;
          const amt = info.tokenAmount?.amount;
          if (amt === undefined || amt === null) continue;
          raw += BigInt(amt);
          decimals = info.tokenAmount?.decimals ?? 0;
          uiAmount += info.tokenAmount?.uiAmount ?? 0;
        }
      }
      if (raw <= 0n) return null;
      return { raw, uiAmount, decimals };
    } catch (err) {
      console.error(
        "[jupiter] token balance check failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Full buy: balance pre-check → quote → swap tx → sign → send. Returns the
   * on-chain signature. Balance check + quote are read-only; the spend only
   * happens at the final RPC send.
   */
  async buy(token: string, amountSol: number): Promise<TradeOrderResult> {
    try {
      const feeLamports = Math.floor(this.cfg.priorityFeeSol * 1e9);

      // Read the live balance once: used for amount sizing (percentage mode)
      // AND the pre-check. Percentage sizing happens here so the amount is
      // always fresh at execution time, never stale from the button label.
      const balance = await this.getSolBalanceLamports();
      const sized = buyAmountLamports(balance, this.cfg.buyBalancePct, amountSol);
      if ("error" in sized) {
        return { ok: false, error: sized.error };
      }
      const amountLamports = sized.amountLamports;
      // Balance pre-check: input + priority fee + ~0.005 SOL for tx rent/fees.
      if (balance !== null && balance < amountLamports + feeLamports + 5_000_000) {
        return {
          ok: false,
          error: `钱包余额不足（${(balance / 1e9).toFixed(4)} SOL，需 ${((amountLamports + feeLamports + 5_000_000) / 1e9).toFixed(4)} SOL）`,
        };
      }

      const quote = await this.getQuote(
        token,
        amountLamports,
        Math.round(this.cfg.slippagePct * 100),
      );
      if (!quote.ok || !quote.quote) {
        return { ok: false, error: quote.error ?? "无可用路由" };
      }

      return this.signAndSend(quote.quote as Record<string, unknown>);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Full sell: read the held token balance → size by fraction (all/half) →
   * quote (token→SOL) → swap tx → sign → send. Sells are exits, so they only
   * need enough SOL for the priority fee + tx fees — never more.
   */
  async sell(
    token: string,
    fraction: SellFraction,
  ): Promise<TradeOrderResult & { amountUi?: number }> {
    try {
      const balance = await this.getTokenBalance(token);
      if (!balance) {
        return { ok: false, error: "钱包没有该币持仓（可能未持有或 RPC 查询失败）" };
      }
      const amountRaw = sellAmountRaw(balance.raw, fraction);
      if (amountRaw <= 0n) {
        return { ok: false, error: "持仓不足，无法卖出" };
      }
      const amountUi = Number(amountRaw) / 10 ** balance.decimals;

      // Fee pre-check: a sell costs SOL for priority fee + tx rent; an empty
      // wallet would burn the priority fee on a simulation failure.
      const feeLamports = Math.floor(this.cfg.priorityFeeSol * 1e9);
      const sol = await this.getSolBalanceLamports();
      if (sol !== null && sol < feeLamports + 5_000_000) {
        return {
          ok: false,
          error: `钱包 SOL 不足支付交易费（${(sol / 1e9).toFixed(4)} SOL）`,
        };
      }

      const quote = await this.getQuoteRaw(
        token,
        SOL_MINT,
        amountRaw,
        Math.round(this.cfg.slippagePct * 100),
      );
      if (!quote.ok || !quote.quote) {
        return { ok: false, error: quote.error ?? "无可用路由" };
      }

      const result = await this.signAndSend(quote.quote as Record<string, unknown>);
      return { ...result, amountUi };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Shared tail of buy/sell: ask Jupiter for the swap transaction for a
   * quote, sign it with the trading wallet, and send it via the RPC.
   */
  private async signAndSend(quote: Record<string, unknown>): Promise<TradeOrderResult> {
    try {
      const feeLamports = Math.floor(this.cfg.priorityFeeSol * 1e9);

      const swap = await jsonFetch<{ swapTransaction?: string }>(
        `${this.cfg.jupiterApiBase}/swap/v1/swap`,
        this.cfg.timeoutMs,
        {
          quoteResponse: quote.quote,
          userPublicKey: this.walletPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          // New-platform fee shape: cap the priority fee at the configured lamports.
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: {
              priorityLevel: "veryHigh",
              maxLamports: feeLamports,
            },
          },
        },
        this.apiHeaders(),
      );
      if (!swap.swapTransaction) {
        return { ok: false, error: "Jupiter 未返回 swap 交易（可能是该币不可交易或参数错误）" };
      }

      const tx = VersionedTransaction.deserialize(
        Buffer.from(swap.swapTransaction, "base64"),
      );
      tx.sign([this.keypair()]);
      const signedBase64 = Buffer.from(tx.serialize()).toString("base64");

      const sent = await jsonFetch<{ result?: string; error?: { message?: string } }>(
        this.rpcUrl(),
        this.cfg.timeoutMs,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "sendTransaction",
          params: [
            signedBase64,
            { encoding: "base64", preflightCommitment: "confirmed" },
          ],
        },
      );
      return parseSendResponse(sent);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Read-only verification (no money moves): wallet pubkey + SOL balance +
   * a tiny SOL→USDC quote to prove the full Jupiter path works.
   */
  async verify(): Promise<{
    ok: boolean;
    wallet?: string;
    balanceSol?: number;
    quoteOk?: boolean;
    error?: string;
  }> {
    try {
      const wallet = this.walletPublicKey;
      const balance = await this.getSolBalanceLamports();
      const quote = await this.getQuote(USDC_MINT, 1_000_000, 100);
      return {
        ok: quote.ok,
        wallet,
        balanceSol: balance === null ? undefined : balance / 1e9,
        quoteOk: quote.ok,
        error: quote.ok ? undefined : quote.error,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * How long one trade-mode override read may be REUSED, and the hard cap on
 * the read itself.
 *
 * WHY (live 2026-09-19): `effectiveMode()` is awaited in the candidate chain
 * immediately before the card is rendered and claimed (src/scanner.ts), i.e.
 * inside the ~400ms slice the tick reserves for pushing the card
 * (CARD_CLAIM_BUDGET_MS). An unbounded Turso round trip there is what turns a
 * qualifying coin into a DEFERRED card ("no slice left for the claim plus the
 * send") instead of a delivery: 10 of 13 consecutive ticks ended
 * `candidates 1, pushed 0` with `cardSendDeferredTotal` climbing once a
 * minute, while the same public counters showed the chain REACHING the claim
 * (the held-back counter stayed flat) — the tick was not short of candidates,
 * it was short of clock. The read is moved off that tail by the prefetch
 * below: the worker kicks it off at the tick's start, so the chain's call
 * 3-4s later is a cache hit.
 *
 * What reuse costs: staleness. A `/setmode` flip made in ANOTHER isolate is
 * honoured within this window; the isolate that handled the command updates
 * its own copy immediately (setModeOverride). Fifteen seconds covers any tick
 * (the scan deadline is 4.2s) plus the post-push tracker pass, and the mode is
 * an operator gesture rather than a per-tick input.
 */
const MODE_OVERRIDE_TTL_MS = 15_000;
/**
 * Hard cap on one override read. Past it the read is treated as unanswered —
 * the env mode answers instead, which is exactly the fail-safe the read had
 * before (see effectiveMode): never act on a mode that could not be verified.
 */
const MODE_OVERRIDE_READ_BOUND_MS = 250;

/**
 * High-level trade service shared by the scanner (auto mode), the bot
 * (manual-mode button + /trade status) and /debug/trade. Every money-moving
 * path funnels through executeBuy, the single place that records trade_log
 * rows (UNIQUE(token) ⇒ one buy per coin, guaranteed at the DB layer too).
 */
export class TradeService {
  constructor(
    private readonly cfg: TradeConfigSettings,
    private readonly client: JupiterClient,
    private readonly db: Db,
  ) {}

  /** Last answered override read, reusable for MODE_OVERRIDE_TTL_MS. */
  private modeOverride: { at: number; value: string | null } | null = null;
  /** The read in flight, so a prefetch and a caller share one round trip. */
  private modeReadInFlight: Promise<boolean> | null = null;
  /** Observability (the same numbers the heartbeat publishes per tick). */
  private modeReads = 0;
  private modeReadReuses = 0;
  private modeReadTimeouts = 0;
  private lastModeReadMs = 0;

  /**
   * Start the override read off the critical path: the worker calls this at the
   * beginning of every scan tick, so the chain's late `effectiveMode()` — the
   * one standing between a qualifying coin and its claim — is served from the
   * cache. Cheap and idempotent: a fresh cache is a no-op, and a read already
   * in flight is not duplicated.
   */
  prefetchMode(): void {
    if (this.modeOverride && Date.now() - this.modeOverride.at < MODE_OVERRIDE_TTL_MS) {
      return;
    }
    void this.readOverrideOnce();
  }

  /**
   * One bounded override read. Resolves to whether it ANSWERED: a failure or a
   * read past MODE_OVERRIDE_READ_BOUND_MS leaves the cache untouched and says
   * so, so the caller can fall back to the env mode instead of inventing a
   * value (or reusing one that may no longer be true).
   */
  private readOverrideOnce(): Promise<boolean> {
    if (this.modeReadInFlight) return this.modeReadInFlight;
    const startedAt = Date.now();
    this.modeReads += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cut = new Promise<{ cut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ cut: true }), MODE_OVERRIDE_READ_BOUND_MS);
    });
    const read: Promise<{ value: string | null } | { cut: true }> = this.db
      .getTradeModeOverride()
      .then(
        (value) => ({ value }),
        (err) => {
          console.error(
            "[trade] override read failed — using env mode:",
            err instanceof Error ? err.message : err,
          );
          return { cut: true as const };
        },
      );
    this.modeReadInFlight = Promise.race([read, cut])
      .then((out) => {
        this.lastModeReadMs = Date.now() - startedAt;
        if ("cut" in out) {
          this.modeReadTimeouts += 1;
          return false;
        }
        this.modeOverride = { at: Date.now(), value: out.value };
        return true;
      })
      .finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        this.modeReadInFlight = null;
      });
    return this.modeReadInFlight;
  }

  /**
   * Effective trade mode: the Telegram /setmode override (worker_state) when
   * set, otherwise the env-config mode.
   *
   * The override is read at most once per MODE_OVERRIDE_TTL_MS window (the
   * worker prefetches it at each tick's start) and each read is bounded — see
   * the constants above for why the per-call DB read this replaced was itself
   * the bug. A read that fails or overruns falls back to the env config
   * (fail-safe: never act on a mode we could not verify).
   */
  async effectiveMode(): Promise<TradeMode> {
    const cached = this.modeOverride;
    if (cached && Date.now() - cached.at < MODE_OVERRIDE_TTL_MS) {
      this.modeReadReuses += 1;
      return resolveTradeMode(this.cfg.mode, cached.value);
    }
    const answered = await this.readOverrideOnce();
    return resolveTradeMode(this.cfg.mode, answered ? (this.modeOverride?.value ?? null) : null);
  }

  /**
   * The mode lookup's own telemetry, published per tick on the scan summary
   * (see the worker's runOnce wrapper): `reuses` rising next to `reads` is the
   * proof that the tail call stopped paying for a round trip.
   */
  modeStats(): {
    reads: number;
    reuses: number;
    timeouts: number;
    lastReadMs: number;
    cachedAgeMs: number | null;
  } {
    return {
      reads: this.modeReads,
      reuses: this.modeReadReuses,
      timeouts: this.modeReadTimeouts,
      lastReadMs: this.lastModeReadMs,
      cachedAgeMs: this.modeOverride ? Date.now() - this.modeOverride.at : null,
    };
  }

  /**
   * Persist (or clear, when null) the Telegram trade-mode override. The cache
   * is written through so the isolate that handled the command applies it
   * immediately instead of at the next prefetch (other isolates pick it up
   * within MODE_OVERRIDE_TTL_MS).
   */
  async setModeOverride(mode: TradeMode | null): Promise<void> {
    await this.db.setTradeModeOverride(mode);
    this.modeOverride = { at: Date.now(), value: mode };
  }

  get mode(): TradeConfigSettings["mode"] {
    return this.cfg.mode;
  }

  get amountSol(): number {
    return this.cfg.amountSol;
  }

  /** Human label for the buy size — "80% 餘額" (balance mode) or "0.01 SOL". */
  get buySizeLabel(): string {
    return this.cfg.buyBalancePct > 0
      ? `${this.cfg.buyBalancePct}% 餘額`
      : `${this.cfg.amountSol} SOL`;
  }

  /** Whether a buy is allowed for this token right now. */
  async shouldBuy(token: string): Promise<TradeDecision> {
    const [alreadyTraded, todayCount, mode] = await Promise.all([
      this.db.hasTraded(token),
      this.db.countTradesSince(Date.now() - 24 * 3600_000),
      this.effectiveMode(),
    ]);
    return tradeDecision(
      { mode, maxDailyBuys: this.cfg.maxDailyBuys },
      { alreadyTraded, todayCount },
    );
  }

  /**
   * Execute and record a buy. Callers must have checked shouldBuy first
   * (executeBuy re-checks as a guard, so a manual tap can be handed
   * straight to it). Returns the decision and, when it proceeded, the
   * on-chain result.
   */
  async executeBuy(
    token: string,
    chatId: string,
    opts?: { manual?: boolean },
  ): Promise<{ decision: TradeDecision; result?: TradeOrderResult }> {
    const decision = await this.shouldBuy(token);
    if (!decision.ok) return { decision };
    const result = await this.client.buy(token, this.cfg.amountSol);
    try {
      await this.db.recordTrade({
        token,
        chatId,
        mode: opts?.manual ? "manual" : "auto",
        status: result.ok ? "success" : "failed",
        txHash: result.txHash ?? null,
        amountSol: this.cfg.amountSol,
        slippagePct: this.cfg.slippagePct,
        error: result.error ?? null,
      });
    } catch (err) {
      console.error("[trade] failed to record trade log:", err);
    }
    return { decision, result };
  }

  /**
   * Sell a share of the wallet's holdings in a token (half/all) and record
   * the attempt in sell_log. Blocked when the effective mode is off (the
   * same "nothing moves" guarantee as buys); no per-coin cap — you can only
   * sell what you hold. Manual button taps and /sell both funnel here.
   */
  async sell(
    token: string,
    fraction: SellFraction,
    chatId: string,
  ): Promise<{ ok: boolean; result?: TradeOrderResult & { amountUi?: number }; reason?: string }> {
    const mode = await this.effectiveMode();
    if (mode === "off") {
      return { ok: false, reason: "mode=off（交易未启用）" };
    }
    const result = await this.client.sell(token, fraction);
    try {
      await this.db.recordSell({
        token,
        chatId,
        mode: fraction,
        status: result.ok ? "success" : "failed",
        txHash: result.txHash ?? null,
        amountToken: result.amountUi ?? null,
        error: result.error ?? null,
      });
    } catch (err) {
      console.error("[trade] failed to record sell log:", err);
    }
    return { ok: result.ok, result };
  }

  /** Read-only verification (no money moves): wallet + balance + quote. */
  async verify(): Promise<{
    ok: boolean;
    mode: string;
    wallet?: string;
    balanceSol?: number;
    quoteOk?: boolean;
    error?: string;
    buyBalancePct: number;
    buySizeLabel: string;
  }> {
    const v = await this.client.verify();
    return {
      ok: v.ok,
      mode: await this.effectiveMode(),
      wallet: v.wallet,
      balanceSol: v.balanceSol,
      quoteOk: v.quoteOk,
      error: v.error,
      buyBalancePct: this.cfg.buyBalancePct,
      buySizeLabel: this.buySizeLabel,
    };
  }

  /** Read-only status for /trade and /health. */
  async status(): Promise<{
    mode: string;
    overrideActive: boolean;
    wallet?: string;
    amountSol: number;
    buyBalancePct: number;
    buySizeLabel: string;
    slippagePct: number;
    maxDailyBuys: number;
    todayCount: number;
  }> {
    const [todayCount, mode] = await Promise.all([
      this.db.countTradesSince(Date.now() - 24 * 3600_000),
      this.effectiveMode(),
    ]);
    let wallet: string | undefined;
    try {
      wallet = this.client.walletPublicKey;
    } catch {
      // wallet secret missing → wallet stays undefined
    }
    return {
      mode,
      overrideActive: mode !== this.cfg.mode,
      wallet,
      amountSol: this.cfg.amountSol,
      buyBalancePct: this.cfg.buyBalancePct,
      buySizeLabel: this.buySizeLabel,
      slippagePct: this.cfg.slippagePct,
      maxDailyBuys: this.cfg.maxDailyBuys,
      todayCount,
    };
  }
}
