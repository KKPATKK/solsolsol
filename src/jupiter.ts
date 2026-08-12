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
 * Flow (Jupiter v6 Swap API):
 *   1. GET  /v6/quote?inputMint=SOL&outputMint=<token>&amount=<lamports>
 *            &slippageBps=<pct*100>                  → quoteResponse
 *   2. POST /v6/swap { quoteResponse, userPublicKey, wrapAndUnwrapSol,
 *            dynamicComputeUnitLimit, prioritizationFeeLamports }
 *                                                    → { swapTransaction: b64 }
 *   3. deserialize → sign with wallet → serialize → sendTransaction (RPC)
 *
 * Safety rails live in TradeService / tradeDecision (mode, per-coin dedupe,
 * daily cap); the client itself adds a balance pre-check so a buy never
 * burns priority fees on a wallet that cannot afford it.
 */

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

/** SOL mint on Solana (the input side of every buy). */
const SOL_MINT = "So11111111111111111111111111111111111111112";
/** USDC mint — used by verify() for a read-only quote sanity check. */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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
): Promise<T> {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
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
    const params = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint,
      amount: String(Math.floor(inputLamports)),
      slippageBps: String(Math.floor(slippageBps)),
      onlyDirectRoutes: "false",
    });
    try {
      const raw = await jsonFetch<unknown>(
        `${this.cfg.jupiterApiBase}/v6/quote?${params.toString()}`,
        this.cfg.timeoutMs,
      );
      return parseQuote(raw);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Full buy: balance pre-check → quote → swap tx → sign → send. Returns the
   * on-chain signature. Balance check + quote are read-only; the spend only
   * happens at the final RPC send.
   */
  async buy(token: string, amountSol: number): Promise<TradeOrderResult> {
    try {
      const amountLamports = Math.floor(amountSol * 1e9);
      const feeLamports = Math.floor(this.cfg.priorityFeeSol * 1e9);

      // Balance pre-check: input + priority fee + ~0.005 SOL for tx rent/fees.
      const balance = await this.getSolBalanceLamports();
      if (balance !== null && balance < amountLamports + feeLamports + 5_000_000) {
        return {
          ok: false,
          error: `钱包余额不足（${(balance / 1e9).toFixed(4)} SOL，需 ${amountSol + this.cfg.priorityFeeSol + 0.005} SOL）`,
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

      const swap = await jsonFetch<{ swapTransaction?: string }>(
        `${this.cfg.jupiterApiBase}/v6/swap`,
        this.cfg.timeoutMs,
        {
          quoteResponse: quote.quote,
          userPublicKey: this.walletPublicKey,
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: feeLamports,
        },
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

  get mode(): TradeConfigSettings["mode"] {
    return this.cfg.mode;
  }

  get amountSol(): number {
    return this.cfg.amountSol;
  }

  /** Whether a buy is allowed for this token right now. */
  async shouldBuy(token: string): Promise<TradeDecision> {
    const [alreadyTraded, todayCount] = await Promise.all([
      this.db.hasTraded(token),
      this.db.countTradesSince(Date.now() - 24 * 3600_000),
    ]);
    return tradeDecision(this.cfg, { alreadyTraded, todayCount });
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

  /** Read-only verification (no money moves): wallet + balance + quote. */
  async verify(): Promise<{
    ok: boolean;
    mode: string;
    wallet?: string;
    balanceSol?: number;
    quoteOk?: boolean;
    error?: string;
  }> {
    const v = await this.client.verify();
    return {
      ok: v.ok,
      mode: this.cfg.mode,
      wallet: v.wallet,
      balanceSol: v.balanceSol,
      quoteOk: v.quoteOk,
      error: v.error,
    };
  }

  /** Read-only status for /trade and /health. */
  async status(): Promise<{
    mode: string;
    wallet?: string;
    amountSol: number;
    slippagePct: number;
    maxDailyBuys: number;
    todayCount: number;
  }> {
    const todayCount = await this.db.countTradesSince(Date.now() - 24 * 3600_000);
    let wallet: string | undefined;
    try {
      wallet = this.client.walletPublicKey;
    } catch {
      // wallet secret missing → wallet stays undefined
    }
    return {
      mode: this.cfg.mode,
      wallet,
      amountSol: this.cfg.amountSol,
      slippagePct: this.cfg.slippagePct,
      maxDailyBuys: this.cfg.maxDailyBuys,
      todayCount,
    };
  }
}
