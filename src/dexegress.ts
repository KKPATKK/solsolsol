/**
 * DEX EGRESS RELAY (2026-11-03) — a SECOND egress path for pair batches the
 * Worker's own egress was refused on.
 *
 * WHY IT EXISTS (measured, not inferred). /debug/dex429 had carried 56K
 * refusals with ~50 an hour live, and every one of them was charged to the
 * SHARED Cloudflare egress IP the Worker happens to sit behind. A zero-cost
 * probe (experiments/dex-egress, 2026-11-03 00:53-00:56Z, cache-busted so every
 * reading was a real origin MISS) measured that the refusal is PER COLO, not
 * per host:
 *
 *   DFW (this Worker's placement)      0/10  200, 5ms, Retry-After 44
 *   LAX (unplaced probe)              10/10  200, 619ms
 *   CDG (weur hint)                   10/10  200, 680ms
 *   ICN (apac hint)                   10/10  200, 718ms
 *   MRS (weur hint, sustained 30s)    30/30  200, 622ms
 *   SJC (wnam hint)                    0/10  200, 5ms, Retry-After 34
 *
 * Same minute, same endpoint, same URLs. So a refused batch can be answered by
 * asking DexScreener from a DIFFERENT data center, and a Durable Object's
 * `locationHint` is the one lever that moves a subrequest's egress without a
 * new host, a key or a paid plan.
 *
 * WHAT IT IS NOT. `locationHint` is BEST EFFORT — the official docs make no
 * promise that the object (or its egress) lands in the hinted region, and the
 * probe watched a `wnam` object answer from SJC once and LAX the next time.
 * The pool on the other side is shared with the rest of Cloudflare's fleet and
 * moves minute to minute (SJC was 0/10 in that same window), so this is a
 * LOTTERY TICKET, not a guarantee: it turns "this tick has no Dex data at all"
 * into "this tick probably has it", which is exactly the business case behind
 * the liquidity floor (gateLiquidityUsd fails OPEN on a Jupiter pair, so a
 * refused Dex lane silently disables the $10K floor — see scanner.ts).
 *
 * COST: one Durable Object request per REFUSED batch — so it follows the
 * episode, not the clock. At the live pair lane's rotation and 180s pair cache
 * (~130 batches/hour reach the wire), a month in which every one of them was
 * refused is ~100K requests against the free plan's 1M, plus the Dex request
 * itself, which is the request the direct path was going to make anyway. No
 * storage, no alarm, no cron: the object is a place to stand.
 *
 * THE OBJECT'S HOME IS STICKY. `locationHint` only applies when the object is
 * first created; after that the object keeps its home data center. That is the
 * point — a stable second egress — and it is also why the caller keeps ONE
 * object per arm (`dex-egress-weur`, `dex-egress-apac`) instead of a fresh
 * name per attempt: a new name would re-roll the location on every retry,
 * which is a different (and harder to read) experiment.
 *
 * The caller only ever reaches this class through the `DEX_EGRESS` binding
 * (see worker.ts dexEgressRelay), so the fetch surface is internal. It still
 * validates its target: an object that will fetch any URL handed to it in a
 * header is an SSRF gadget, and the allowlist is four exact hosts (two
 * services) rather than a pattern.
 */

/**
 * The arms, in the order the caller tries them. Both measured clean while DFW
 * was refusing (see the table above); `weur` first because its sustained
 * 30/30 at 622ms is the best reading this experiment produced.
 */
export const DEX_EGRESS_ARMS = ["weur", "apac"] as const;
export type DexEgressArm = (typeof DEX_EGRESS_ARMS)[number];

/**
 * The object's fetch surface. Any origin works — the object routes on the
 * pathname alone, exactly like TickClock — so the constant keeps the callers
 * from inventing strings.
 */
export const DEX_EGRESS_ORIGIN = "https://dex-egress";
export const DEX_EGRESS_PATH = "/fetch";
/** Absolute URL to fetch. Header, not query: the URL carries commas. */
export const DEX_EGRESS_URL_HEADER = "x-dex-url";
/** What the caller can afford to wait, ms (clamped by dexEgressTimeoutMs). */
export const DEX_EGRESS_TIMEOUT_HEADER = "x-dex-timeout-ms";
/**
 * The caller's own User-Agent, forwarded verbatim. CoinGecko answers 403 to a
 * subrequest without a descriptive one (see GECKO_USER_AGENT in
 * src/geckoterminal.ts), so a relayed gecko call has to carry the same
 * identity as a direct one — a hard-coded relay UA would just move the refusal.
 */
export const DEX_EGRESS_UA_HEADER = "x-dex-ua";
/** Echoed on the response: the colo that actually answered (diagnostic). */
export const DEX_EGRESS_COLO_HEADER = "x-dex-relay-colo";
/**
 * The hosts this object may fetch. See the SSRF note above.
 *
 * TWO SERVICES SINCE 2026-11-05: DexScreener was the first (pair batches
 * refused by this Worker's colo, ~50/hour), and GeckoTerminal/CoinGecko joined
 * with the same measured shape — `/debug/gecko-key` showed EVERY variant
 * (configured demo key, keyless, pro parameter) answering 429 from the
 * Worker's egress while the mirror hosts answered 200 from a clean one. The
 * allowlist stays exact-host: this is the security boundary, not a suggestion.
 */
export const DEX_EGRESS_TARGET_HOSTS = [
  "api.dexscreener.com",
  "api.geckoterminal.com",
  "api.coingecko.com",
  "pro-api.coingecko.com",
] as const;
/**
 * Ceiling for one relay attempt. The probe measured 512-737ms per real MISS
 * through a relayed object, so this is ~3x headroom: a colo slow enough to
 * exceed it is a colo the caller is better off not waiting for (it has its own
 * caller deadline, and the next tick will ask again).
 */
export const DEX_EGRESS_MAX_TIMEOUT_MS = 2_500;
export const DEX_EGRESS_MIN_TIMEOUT_MS = 500;

/**
 * The one URL this object will fetch, or null. Pure and exported for the unit
 * test: the allowlist is the security boundary, so it is asserted rather than
 * assumed. Rejects anything that is not exactly one of
 * DEX_EGRESS_TARGET_HOSTS over https — another scheme, another host, a port,
 * or embedded credentials.
 */
export function dexEgressTarget(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!(DEX_EGRESS_TARGET_HOSTS as readonly string[]).includes(url.host)) {
    return null;
  }
  if (url.username !== "" || url.password !== "") return null;
  return url.toString();
}

/**
 * The caller's budget, clamped. A missing or junk header reads as the ceiling
 * rather than as "no timeout": an object with no bound is worse than a slow
 * answer, because the caller's invocation is what pays for it.
 */
export function dexEgressTimeoutMs(raw: string | null | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEX_EGRESS_MAX_TIMEOUT_MS;
  return Math.min(
    DEX_EGRESS_MAX_TIMEOUT_MS,
    Math.max(DEX_EGRESS_MIN_TIMEOUT_MS, Math.round(n)),
  );
}

/**
 * The relay. Stateless on purpose: no storage, no alarm, no in-memory state to
 * be evicted — its whole value is WHERE it runs. Exported under the name
 * wrangler.toml's `[[durable_objects.bindings]] class_name` uses, so the class
 * name is a contract and must not be renamed without that file.
 */
export class DexEgressRelay {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const target = dexEgressTarget(request.headers.get(DEX_EGRESS_URL_HEADER));
    if (target === null) return new Response("Unsupported target", { status: 400 });
    const timeoutMs = dexEgressTimeoutMs(
      request.headers.get(DEX_EGRESS_TIMEOUT_HEADER),
    );
    // The object's OWN colo, when the runtime exposes it — the reading that
    // says whether the location hint actually landed where it was asked to.
    const colo =
      (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? "";
    // Forwarded, not invented: an upstream that gates on identity sees the
    // same one it would have seen on a direct call (see DEX_EGRESS_UA_HEADER).
    const userAgent = request.headers.get(DEX_EGRESS_UA_HEADER);
    try {
      const upstream = await fetch(target, {
        headers: {
          accept: "application/json",
          ...(userAgent !== null && userAgent !== ""
            ? { "user-agent": userAgent.slice(0, 200) }
            : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Only the headers the caller's own accounting reads travel back:
      // content-type for the body, age/date for PairInfo.contentAt (the
      // content timestamp survives the hop instead of being re-stamped as
      // "received now"), cache status for /health, retry-after for the arm
      // cooldown. Forwarding the whole header set would carry another colo's
      // hop-by-hop and encoding decisions across a body that is already being
      // re-streamed.
      const headers = new Headers({
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      for (const name of ["age", "date", "cf-cache-status", "retry-after"]) {
        const value = upstream.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      if (colo !== "") headers.set(DEX_EGRESS_COLO_HEADER, colo);
      return new Response(upstream.body, {
        status: upstream.status,
        headers,
      });
    } catch (err) {
      // A transport/timeout failure is a FAILED ARM to the caller, never a
      // refusal: it says nothing about DexScreener's pool, so the caller cools
      // this arm briefly and moves on (worker.ts dexEgressRelay).
      return new Response(
        err instanceof Error ? err.message : "relay failed",
        { status: 502 },
      );
    }
  }
}
