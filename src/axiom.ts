import type { AppConfig } from "./config";

/**
 * Axiom Trade (axiom.trade) client — discovery feed + token metadata for the
 * Solana meme-coin scanner.
 *
 * Auth model (reverse-engineered from the AxiomTradeAPI-py SDK):
 * - login-password-v2 (api6) → otpJwtToken (also emails an OTP code)
 * - login-otp (api10) with the OTP code → Set-Cookie auth-access-token +
 *   auth-refresh-token
 * - refresh-access-token (api9) with auth-refresh-token → new
 *   auth-access-token
 * - new-trending-v2 (api3/6/9/10 fallback) with auth-access-token cookie →
 *   trending tokens
 *
 * The access token must be persisted externally (worker_state in Turso) —
 * this client only consumes it. Login itself is interactive (needs the OTP
 * code the user receives by email), so it is driven via /debug/axiom-login,
 * not from the scan path.
 */

const LOGIN_HOST = "api6.axiom.trade";
const OTP_HOST = "api10.axiom.trade";
const REFRESH_HOST = "api9.axiom.trade";
const TRENDING_HOSTS = ["api3.axiom.trade", "api6.axiom.trade", "api9.axiom.trade", "api10.axiom.trade"];

const BASE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://axiom.trade",
  Referer: "https://axiom.trade/",
  Connection: "keep-alive",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AxiomTrendingToken {
  address: string;
  symbol: string;
  name: string;
  pairAddress: string | null;
  createdAtMs: number | null;
  marketCapUsd: number | null;
  priceUsd: number | null;
  volumeUsd: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  holderCount: number | null;
  top10HoldersPct: number | null;
  sniperCount: number | null;
  insiderPct: number | null;
  bundlePct: number | null;
  developerHoldingPct: number | null;
  buyCount: number | null;
  sellCount: number | null;
  makerCount: number | null;
  creator: string | null;
  isMigrated: boolean | null;
  completionPercent: number | null;
  /** Raw row kept for diagnostics / future fields. */
  raw: unknown;
}

/** Response shape of POST /login-password-v2. */
export interface AxiomLoginStep1 {
  otpJwtToken: string | null;
  raw: unknown;
}

/** Response of POST /login-otp (tokens come via Set-Cookie). */
export interface AxiomLoginStep2 {
  accessToken: string | null;
  refreshToken: string | null;
  raw: unknown;
}

/** Extract a cookie value from a Set-Cookie header. */
function cookieValue(setCookieHeader: string | null, name: string): string | null {
  if (!setCookieHeader) return null;
  for (const part of setCookieHeader.split(",")) {
    const [pair] = part.trim().split(";");
    const eq = pair?.indexOf("=");
    if (eq === undefined || eq === null || eq < 0) continue;
    const key = pair!.slice(0, eq).trim();
    if (key === name) return pair!.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Pure parser for the new-trending-v2 payload (exported for offline unit
 * tests). Accepts either a dict with a `tokens`/`data` list, or a bare
 * list. Rows may be objects (named fields) or positional arrays mapped by
 * TRENDING_V2_FIELDS. Defensive — a schema change degrades to [].
 */
export function parseAxiomTrending(payload: unknown): AxiomTrendingToken[] {
  const FIELDS = [
    "pairAddress",
    "tokenAddress",
    "tokenName",
    "tokenTicker",
    "imageUrl",
    "metadataUrl",
    "chainId",
    "exchangeName",
    "exchangeData",
    "createdAt",
    "website",
    "twitter",
    "telegram",
    "discord",
    "link1",
    "link2",
    "isMigrated",
    "creatorAddress",
    "supply",
    "liquiditySol",
    "completionPercent",
    "migrationInfo",
    "txCount",
    "volume",
    "marketCapUsd",
    "buyCount",
    "sellCount",
    "makerCount",
    "liquidityUsd",
    "priceUsd",
    "priceChange5m",
    "priceChange1h",
    "priceChange6h",
    "priceChange24h",
    "holderRatio",
    "top10HoldersPercent",
    "sniperCount",
    "insiderPercentage",
    "bundlePercentage",
    "developerHoldingPercent",
    "buyers",
    "sellers",
    "sparkline",
    "holderCount",
    "signature",
    "slot",
    "quoteLiquidity",
    "baseLiquidity",
    "pairCreatedAt",
    "pairAddressRaw",
    "reserveAddressA",
    "updatedAt",
  ] as const;

  let rows: unknown[] = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (payload && typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    if (Array.isArray(rec.tokens)) rows = rec.tokens;
    else if (Array.isArray(rec.data)) rows = rec.data;
  }
  if (rows.length === 0) return [];

  const out: AxiomTrendingToken[] = [];
  for (const row of rows) {
    if (!row) continue;
    let rec: Record<string, unknown>;
    if (Array.isArray(row)) {
      // Positional array form — map by TRENDING_V2_FIELDS index.
      rec = {};
      for (let i = 0; i < FIELDS.length && i < row.length; i++) {
        rec[FIELDS[i]] = row[i];
      }
    } else if (typeof row === "object") {
      rec = row as Record<string, unknown>;
    } else {
      continue;
    }
    const address = String(rec.tokenAddress ?? rec.address ?? "").trim();
    if (!address) continue;

    const toNum = (v: unknown): number | null => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const toPct = (v: unknown): number | null => {
      const n = toNum(v);
      return n === null ? null : n;
    };

    // Creation time: createdAt / pairCreatedAt — may be ISO string, ms, or s.
    let createdAtMs: number | null = null;
    const createdRaw = rec.createdAt ?? rec.pairCreatedAt;
    if (typeof createdRaw === "string" && createdRaw) {
      const parsed = Date.parse(createdRaw);
      if (Number.isFinite(parsed)) createdAtMs = parsed;
    } else {
      const n = Number(createdRaw);
      if (Number.isFinite(n) && n > 0) {
        createdAtMs = n > 1e12 ? n : n * 1000; // s → ms
      }
    }

    const creatorRaw = rec.creatorAddress;
    const creator =
      typeof creatorRaw === "string" && creatorRaw.trim().length >= 32
        ? creatorRaw.trim()
        : null;

    out.push({
      address,
      symbol: String(rec.tokenTicker ?? rec.symbol ?? "").trim().slice(0, 20),
      name: String(rec.tokenName ?? rec.name ?? "").trim().slice(0, 60),
      pairAddress:
        typeof rec.pairAddress === "string" && rec.pairAddress
          ? rec.pairAddress
          : null,
      createdAtMs,
      marketCapUsd: toNum(rec.marketCapUsd),
      priceUsd: toNum(rec.priceUsd),
      volumeUsd: toNum(rec.volume),
      priceChange5m: toNum(rec.priceChange5m),
      priceChange1h: toNum(rec.priceChange1h),
      priceChange6h: toNum(rec.priceChange6h),
      priceChange24h: toNum(rec.priceChange24h),
      holderCount: toNum(rec.holderCount),
      top10HoldersPct: toPct(rec.top10HoldersPercent),
      sniperCount: toNum(rec.sniperCount),
      insiderPct: toPct(rec.insiderPercentage),
      bundlePct: toPct(rec.bundlePercentage),
      developerHoldingPct: toPct(rec.developerHoldingPercent),
      buyCount: toNum(rec.buyCount),
      sellCount: toNum(rec.sellCount),
      makerCount: toNum(rec.makerCount),
      creator,
      isMigrated: rec.isMigrated === true ? true : rec.isMigrated === false ? false : null,
      completionPercent: toPct(rec.completionPercent),
      raw: row,
    });
  }
  return out;
}

export class AxiomClient {
  private readonly email: string | null;
  private readonly b64Password: string | null;

  constructor(config: AppConfig) {
    // Credentials are OPTIONAL: accounts that log in via Google/SSO have no
    // password, so the client can run in token-only mode (tokens persisted
    // by /debug/axiom-tokens). The password-based login methods below throw
    // when the credentials are missing.
    this.email = config.axiomEmail ?? null;
    // The API expects the password base64-encoded in the request body.
    this.b64Password = config.axiomPassword
      ? b64encode(config.axiomPassword)
      : null;
  }

  private async postJson(
    host: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown; setCookie: string | null }> {
    const res = await fetch(`https://${host}${path}`, {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // non-JSON body — caller checks status
    }
    // Cloudflare Workers: getSetCookie() is the standard accessor.
    let setCookie: string | null = null;
    const list = (res.headers as unknown as {
      getSetCookie?: () => string[];
    }).getSetCookie?.();
    if (Array.isArray(list) && list.length > 0) setCookie = list.join(",");
    else setCookie = res.headers.get("set-cookie");
    return { status: res.status, json, setCookie };
  }

  /**
   * Step 1 of login: submit email+password, receives an OTP JWT and an
   * OTP code is emailed to the user. Returns the JWT for step 2.
   */
  async loginStep1(): Promise<AxiomLoginStep1> {
    if (!this.email || !this.b64Password) {
      throw new Error(
        "AXIOM_EMAIL / AXIOM_PASSWORD not configured — for Google/SSO accounts " +
          "extract the tokens from your browser and use /debug/axiom-tokens instead",
      );
    }
    const { status, json } = await this.postJson(LOGIN_HOST, "/login-password-v2", {
      email: this.email,
      b64Password: this.b64Password,
    });
    if (status !== 200) {
      throw new Error(`Axiom login step1 HTTP ${status}`);
    }
    const rec = (json ?? {}) as Record<string, unknown>;
    const otpJwtToken =
      typeof rec.otpJwtToken === "string" && rec.otpJwtToken
        ? rec.otpJwtToken
        : null;
    return { otpJwtToken, raw: json };
  }

  /**
   * Step 2 of login: submit the emailed OTP code, receive auth tokens via
   * Set-Cookie.
   */
  async loginStep2(otpJwtToken: string, otpCode: string): Promise<AxiomLoginStep2> {
    if (!this.email || !this.b64Password) {
      throw new Error(
        "AXIOM_EMAIL / AXIOM_PASSWORD not configured — for Google/SSO accounts " +
          "extract the tokens from your browser and use /debug/axiom-tokens instead",
      );
    }
    const { status, json, setCookie } = await this.postJson(
      OTP_HOST,
      "/login-otp",
      { code: otpCode, email: this.email, b64Password: this.b64Password },
      { Cookie: `auth-otp-login-token=${otpJwtToken}` },
    );
    if (status !== 200) {
      throw new Error(`Axiom login step2 HTTP ${status}`);
    }
    return {
      accessToken: cookieValue(setCookie, "auth-access-token"),
      refreshToken: cookieValue(setCookie, "auth-refresh-token"),
      raw: json,
    };
  }

  /**
   * Refresh the access token using a stored refresh token. Returns the new
   * access token plus a rotated refresh token when the API issues one (the
   * response may set both cookies or return them in the JSON body).
   */
  async refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string | null;
    refreshToken: string | null;
  }> {
    const { status, json, setCookie } = await this.postJson(
      REFRESH_HOST,
      "/refresh-access-token",
      undefined,
      { Cookie: `auth-refresh-token=${refreshToken}` },
    );
    if (status !== 200) {
      throw new Error(`Axiom refresh HTTP ${status}`);
    }
    const accessFromCookie = cookieValue(setCookie, "auth-access-token");
    const refreshFromCookie = cookieValue(setCookie, "auth-refresh-token");
    const rec = (json ?? {}) as Record<string, unknown>;
    const accessFromBody = rec["auth-access-token"] ?? rec.access_token;
    const refreshFromBody = rec["auth-refresh-token"] ?? rec.refresh_token;
    const accessToken =
      accessFromCookie ??
      (typeof accessFromBody === "string" && accessFromBody
        ? accessFromBody
        : null);
    const refreshResult =
      refreshFromCookie ??
      (typeof refreshFromBody === "string" && refreshFromBody
        ? refreshFromBody
        : null);
    return { accessToken, refreshToken: refreshResult };
  }

  /**
   * Trending tokens. Tries the host list in order (the API is sharded and
   * individual hosts intermittently 502). Requires a valid access token.
   */
  async fetchTrending(
    accessToken: string,
    timePeriod = "1h",
    limit = 30,
  ): Promise<AxiomTrendingToken[]> {
    let lastError: unknown;
    for (const host of TRENDING_HOSTS) {
      try {
        const url = `https://${host}/new-trending-v2?timePeriod=${encodeURIComponent(
          timePeriod,
        )}&v=${Date.now()}`;
        const res = await fetch(url, {
          headers: {
            ...BASE_HEADERS,
            Cookie: `auth-access-token=${accessToken}`,
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 401 || res.status === 403) {
          throw new Error(`Axiom trending auth HTTP ${res.status}`);
        }
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`Axiom trending HTTP ${res.status}`);
        }
        if (!res.ok) {
          throw new Error(`Axiom trending HTTP ${res.status}`);
        }
        const payload: unknown = await res.json();
        const tokens = parseAxiomTrending(payload);
        return tokens.slice(0, limit);
      } catch (err) {
        lastError = err;
        // auth errors are terminal — don't waste the other hosts
        if (err instanceof Error && /auth/.test(err.message)) throw err;
        await sleep(300);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Axiom trending request failed");
  }
}

/**
 * base64 without pulling in a Buffer polyfill dependency — Workers have
 * btoa globally (nodejs_compat is on, so Buffer exists too; btoa is fine
 * for ASCII passwords and avoids any encoding surprises).
 */
function b64encode(s: string): string {
  if (typeof btoa === "function") return btoa(s);
  return Buffer.from(s, "utf8").toString("base64");
}
