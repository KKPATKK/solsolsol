import type { TrojanConfigSettings } from "./config";
import type { Db } from "./db";

/**
 * Trojan (trojan.app / trojan.com) private trading API integration.
 *
 * Auth: `X-API-Key` header with a key obtained from @TrojanOnSolBot in
 * Telegram (send /api) or the Trojan terminal settings. The API executes
 * trades with the wallet linked to that key — no private keys ever touch
 * this codebase.
 *
 * Documented endpoints (Swagger at api.trojan.app/docs historically):
 *   GET /wallet   — linked wallet (read-only; used to verify a key safely)
 *   POST /buy     — { token, amount (SOL), slippage, priorityFee }
 *   POST /sell, GET /positions, POST /limit, POST /dca, POST /snipe
 *
 * The public docs domain has moved over time, so the base URL is
 * configurable (TROJAN_API_BASE) and responses are parsed defensively —
 * field names have differed across versions. ALWAYS verify with the
 * read-only /debug/trade endpoint before enabling any real-money mode.
 */

/** Normalized buy result from Trojan's API. */
export interface TrojanOrderResult {
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
  cfg: Pick<TrojanConfigSettings, "mode" | "maxDailyBuys">,
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
 * Normalize Trojan's buy response into a stable shape (unit-tested). The API
 * has returned different field names across versions; accept the common ones
 * and surface the raw payload for debugging.
 */
export function parseBuyResponse(raw: unknown): TrojanOrderResult {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: `响应格式异常: ${String(raw)}` };
  }
  const obj = raw as Record<string, unknown>;
  const data = (obj.data ?? obj.result ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = data[key] ?? obj[key];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return undefined;
  };
  const txHash = pick("txHash", "signature", "txId", "hash");
  const success =
    obj.success === true ||
    obj.ok === true ||
    obj.status === "success" ||
    obj.status === "ok" ||
    data.success === true ||
    data.status === "success";
  if (success || txHash) {
    return txHash ? { ok: true, txHash } : { ok: true };
  }
  const error =
    pick("error", "message") ??
    (typeof obj.error === "string" ? obj.error : undefined) ??
    "未知错误";
  return { ok: false, error };
}

/** Raw JSON transport to the Trojan API (thin, no business logic). */
export class TrojanClient {
  constructor(private readonly cfg: TrojanConfigSettings) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    if (!this.cfg.apiKey) throw new Error("TROJAN_API_KEY 未配置");
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.cfg.apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Trojan API ${path} → HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Read-only wallet check — the safe way to verify a key before any buy. */
  async getWallet(): Promise<{
    ok: boolean;
    wallet?: string;
    error?: string;
    raw?: unknown;
  }> {
    try {
      const raw = await this.request<Record<string, unknown>>("/wallet");
      const data = (raw?.data ?? raw) as Record<string, unknown>;
      const wallet =
        typeof data.address === "string"
          ? data.address
          : typeof data.wallet === "string"
            ? data.wallet
            : typeof data.walletAddress === "string"
              ? data.walletAddress
              : undefined;
      return { ok: true, wallet, raw };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Execute a market buy of `amountSol` SOL worth of `token`. */
  async buy(token: string, amountSol: number): Promise<TrojanOrderResult> {
    try {
      const raw = await this.request<unknown>("/buy", {
        token,
        amount: amountSol,
        slippage: this.cfg.slippagePct,
        priorityFee: this.cfg.priorityFeeSol,
      });
      const parsed = parseBuyResponse(raw);
      if (!parsed.ok) {
        console.error(
          "[trojan] buy rejected:",
          JSON.stringify(raw)?.slice(0, 500) ?? String(raw),
        );
      }
      return parsed;
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
    private readonly cfg: TrojanConfigSettings,
    private readonly client: TrojanClient,
    private readonly db: Db,
  ) {}

  get mode(): TrojanConfigSettings["mode"] {
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
   * Trojan result.
   */
  async executeBuy(
    token: string,
    chatId: string,
    opts?: { manual?: boolean },
  ): Promise<{ decision: TradeDecision; result?: TrojanOrderResult }> {
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

  /** Read-only verification (no money moves): key + linked wallet. */
  async verify(): Promise<{
    ok: boolean;
    mode: string;
    wallet?: string;
    error?: string;
  }> {
    const w = await this.client.getWallet();
    return { ok: w.ok, mode: this.cfg.mode, wallet: w.wallet, error: w.error };
  }

  /** Read-only status for /trade and /health. */
  async status(): Promise<{
    mode: string;
    amountSol: number;
    slippagePct: number;
    maxDailyBuys: number;
    todayCount: number;
  }> {
    const todayCount = await this.db.countTradesSince(Date.now() - 24 * 3600_000);
    return {
      mode: this.cfg.mode,
      amountSol: this.cfg.amountSol,
      slippagePct: this.cfg.slippagePct,
      maxDailyBuys: this.cfg.maxDailyBuys,
      todayCount,
    };
  }
}
