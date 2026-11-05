import type { TokenProfile } from "./dexscreener";

/**
 * PUMPPORTAL LAUNCH FEED (2026-11-05) — the replacement for pump.fun's
 * frontend API, which answers 403 (Cloudflare managed challenge) on both hosts
 * from this Worker's egress and cannot be fixed from here (the refusal is
 * below the request: headers, Origin/Referer, a proxy and a Durable Object
 * relay were all tried — see docs/ and the pump.fun entry in the repo notes).
 *
 * PumpPortal publishes the SAME events pump.fun's own frontend consumes, over
 * a free WebSocket (`subscribeNewToken`, no key). It has no HTTP "recent
 * tokens" endpoint — the stream is live only, no history — so the socket has
 * to be held open BETWEEN ticks. A Worker invocation cannot do that; a
 * Durable Object can, and this file is that object plus the reader the scanner
 * uses.
 *
 * SHAPE: the object holds one outbound WebSocket and a bounded in-memory ring
 * of the newest creates. `/tokens?limit=N` returns the ring newest-first; a
 * tick that finds it empty (first tick of a cold object, or a portal outage)
 * falls back to the old HTTP feed, which is still wired (src/pumpfun.ts).
 *
 * WHY NO STORAGE, NO ALARM: the ring is a discovery cache, not state. If the
 * object is evicted, the next tick reconnects and the ring refills within
 * seconds; persisting every message would turn a free feed into ~1M storage
 * writes a month for data that is stale in minutes. Reconnection is driven by
 * the tick itself (every ~30s), with a short backoff so a portal outage costs
 * one connect attempt a minute rather than one per tick.
 *
 * COST, measured arithmetic rather than a guess: an object holding an
 * outbound socket stays resident, and Durable Object duration is billed at
 * 128MB while resident. 30 days × 24h × 0.128GB = 331,776 GB-s against the
 * Paid plan's included 400,000 GB-s — i.e. this one feed consumes ~83% of the
 * DO duration allowance. That is the price of continuous coverage; the
 * alternative (connect during a tick) would see ~2 seconds of a stream that
 * emits continuously and would miss essentially every token.
 */

/** The stream endpoint. `api-key` is optional for `subscribeNewToken`. */
export const PUMPPORTAL_WS_URL = "wss://pumpportal.fun/api/data";
/** The object's own origin/paths (any origin works — it routes on the path). */
export const PUMPPORTAL_ORIGIN = "https://pumpportal";
export const PUMPPORTAL_TOKENS_PATH = "/tokens";
export const PUMPPORTAL_STATUS_PATH = "/status";
/** The one object name the reader and the debug route use. */
export const PUMPPORTAL_FEED_NAME = "pump-portal-feed";
/** Newest creates kept in the ring. ~500 covers 10+ minutes at live rates. */
export const PUMPPORTAL_RING_MAX = 500;
/** The subscription frame, sent once the socket is accepted. */
export const PUMPPORTAL_SUBSCRIBE = JSON.stringify({
  method: "subscribeNewToken",
});
/** Descriptive identity, same reason as the HTTP client's USER_AGENT. */
const USER_AGENT =
  "solana-meme-bot/1.0 (+https://github.com/KKPATKK/solsolsol)";
/** Ceiling for one connect handshake (the tick must not wait forever). */
const CONNECT_TIMEOUT_MS = 5_000;
/** Reconnect backoff after a failure: 5s, doubling to 5 min. */
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 300_000;

/** One create, as the reader hands it to the scanner. */
export interface PumpPortalToken {
  tokenAddress: string;
  name?: string;
  symbol?: string;
  /** Receipt time, ms. The stream carries no created timestamp. */
  at: number;
}

/**
 * Parse one WebSocket frame into a create event (pure — unit-testable).
 *
 * The pump.fun create event carries `{ mint, name, symbol, txType: "create",
 * ... }`. Frames the object does not care about (subscription acks, trade
 * events it never subscribed to, malformed JSON) return null. `txType` is
 * checked only when present: LetsBonk creates on the same stream have been
 * observed without it, and the only subscription this object holds is
 * `subscribeNewToken`, so a mint is sufficient evidence.
 */
export function parsePumpPortalCreate(raw: unknown): PumpPortalToken | null {
  let body: unknown = raw;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const msg = body as Record<string, unknown>;
  if (typeof msg.txType === "string" && msg.txType !== "create") return null;
  const mint = typeof msg.mint === "string" ? msg.mint.trim() : "";
  if (mint === "") return null;
  return {
    tokenAddress: mint,
    name: typeof msg.name === "string" ? msg.name : undefined,
    symbol: typeof msg.symbol === "string" ? msg.symbol : undefined,
    at: Date.now(),
  };
}

/** The minimal outbound-socket surface this object uses (Workers' WebSocket). */
interface SocketLike {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ): void;
}

interface FeedStats {
  connected: boolean;
  connects: number;
  messages: number;
  ignored: number;
  failures: number;
  ring: number;
  lastMessageAt: number;
  lastConnectAt: number;
  lastError: string;
}

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.max(Math.trunc(n), 1), PUMPPORTAL_RING_MAX);
}

/**
 * The Durable Object. Exported from src/worker.ts under this exact name —
 * wrangler.toml's `class_name` is the contract.
 */
export class PumpPortalFeed {
  private ring: PumpPortalToken[] = [];
  private socket: SocketLike | null = null;
  private connecting: Promise<void> | null = null;
  private nextConnectAt = 0;
  private consecutiveFailures = 0;
  private statsState: FeedStats = {
    connected: false,
    connects: 0,
    messages: 0,
    ignored: 0,
    failures: 0,
    ring: 0,
    lastMessageAt: 0,
    lastConnectAt: 0,
    lastError: "",
  };

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === PUMPPORTAL_STATUS_PATH) {
      await this.ensureSocket();
      return this.json({ ok: true, ...this.stats() });
    }
    if (url.pathname !== PUMPPORTAL_TOKENS_PATH) {
      return new Response("Not Found", { status: 404 });
    }
    await this.ensureSocket();
    const limit = clampLimit(url.searchParams.get("limit"));
    return this.json({
      ok: true,
      tokens: this.ring.slice(-limit).reverse(),
      stats: this.stats(),
    });
  }

  private json(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }

  private stats(): FeedStats {
    return { ...this.statsState, connected: this.socket !== null, ring: this.ring.length };
  }

  /**
   * Open the socket if it is not open. Never throws: a failed handshake is a
   * reading on /status and the tick falls back to the HTTP feed.
   */
  private ensureSocket(): Promise<void> {
    if (this.socket !== null) return Promise.resolve();
    if (this.connecting !== null) return this.connecting;
    if (Date.now() < this.nextConnectAt) return Promise.resolve();
    this.connecting = this.connect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    let socket: SocketLike | null = null;
    try {
      // Bounded handshake, but the timer is CLEARED the moment the 101 comes
      // back: aborting a fetch that has already upgraded could tear down the
      // socket this object exists to hold. AbortSignal.timeout cannot be
      // cancelled, which is why this is a manual controller.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(PUMPPORTAL_WS_URL, {
          headers: { Upgrade: "websocket", "User-Agent": USER_AGENT },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      socket =
        (res as unknown as { webSocket?: SocketLike }).webSocket ?? null;
      if (res.status !== 101 || socket === null) {
        this.statsState.failures += 1;
        this.statsState.lastError = `HTTP ${res.status}`;
        this.armReconnect();
        void res.body?.cancel().catch(() => undefined);
        return;
      }
      socket.accept();
      this.socket = socket;
      this.statsState.connects += 1;
      this.statsState.lastConnectAt = Date.now();
      this.statsState.lastError = "";
      socket.addEventListener("message", (event) => this.onMessage(event.data));
      socket.addEventListener("close", () => this.onClose());
      socket.addEventListener("error", () => this.onClose());
      socket.send(PUMPPORTAL_SUBSCRIBE);
      this.consecutiveFailures = 0;
    } catch (err) {
      if (socket !== null) {
        try {
          socket.close();
        } catch {
          // already closed
        }
      }
      this.socket = null;
      this.statsState.failures += 1;
      this.statsState.lastError = err instanceof Error ? err.message : "connect failed";
      this.armReconnect();
    }
  }

  private onClose(): void {
    this.socket = null;
    this.armReconnect();
  }

  private armReconnect(): void {
    this.consecutiveFailures += 1;
    this.nextConnectAt =
      Date.now() +
      Math.min(
        RECONNECT_MAX_MS,
        RECONNECT_BASE_MS * 2 ** Math.min(this.consecutiveFailures - 1, 6),
      );
  }

  private onMessage(data: unknown): void {
    const token = parsePumpPortalCreate(data);
    if (token === null) {
      this.statsState.ignored += 1;
      // A subscription ack is not an error; count it once, not per frame.
      return;
    }
    this.statsState.messages += 1;
    this.statsState.lastMessageAt = Date.now();
    // The stream can repeat a mint around a reconnect; the ring is newest-first
    // history for a buyer, so one entry per mint is the contract.
    if (this.ring.some((t) => t.tokenAddress === token.tokenAddress)) return;
    this.ring.push(token);
    if (this.ring.length > PUMPPORTAL_RING_MAX) {
      this.ring.splice(0, this.ring.length - PUMPPORTAL_RING_MAX);
    }
  }
}

/** The reader the scanner holds — one object, one HTTP hop per tick. */
export interface PumpPortalReader {
  /**
   * Newest `limit` creates, or null when the feed could not be read (binding
   * missing, object unreachable, malformed body). An EMPTY ARRAY is a real
   * answer: the object is connected and has seen nothing yet.
   */
  fetchRecent(limit: number): Promise<TokenProfile[] | null>;
}

interface StubLike {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
interface NamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): StubLike;
}

/**
 * Build the reader out of `env.PUMPPORTAL` (see wrangler.toml). Returns null
 * when the binding is absent, which keeps every deployment that predates it —
 * and the Node entry, which never has one — on the old HTTP path.
 */
export function pumpPortalReader(
  env: Record<string, unknown>,
): PumpPortalReader | null {
  const ns = env.PUMPPORTAL as NamespaceLike | undefined;
  if (
    !ns ||
    typeof ns.idFromName !== "function" ||
    typeof ns.get !== "function"
  ) {
    return null;
  }
  return {
    async fetchRecent(limit: number): Promise<TokenProfile[] | null> {
      try {
        const stub = ns.get(ns.idFromName(PUMPPORTAL_FEED_NAME));
        const res = await stub.fetch(
          `${PUMPPORTAL_ORIGIN}${PUMPPORTAL_TOKENS_PATH}?limit=${clampLimit(
            String(limit),
          )}`,
          { signal: AbortSignal.timeout(4_000) },
        );
        if (!res.ok) return null;
        const body = (await res.json()) as { tokens?: unknown };
        if (!Array.isArray(body.tokens)) return null;
        const out: TokenProfile[] = [];
        for (const item of body.tokens) {
          if (item === null || typeof item !== "object") continue;
          const row = item as Record<string, unknown>;
          const tokenAddress =
            typeof row.tokenAddress === "string" ? row.tokenAddress : "";
          if (tokenAddress === "") continue;
          out.push({
            tokenAddress,
            name: typeof row.name === "string" ? row.name : undefined,
            symbol: typeof row.symbol === "string" ? row.symbol : undefined,
            openTimestamp: typeof row.at === "number" ? row.at : undefined,
          });
        }
        return out;
      } catch {
        return null;
      }
    },
  };
}
