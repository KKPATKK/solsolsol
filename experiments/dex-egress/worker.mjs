/*
 * DEX EGRESS PROBE — a throwaway Worker, deployed only for the experiment.
 *
 *   GET /healthz                              -> "ok" (no auth)
 *   GET /probe?arm=direct&run=<id>            -> this Worker's own egress
 *   GET /probe?arm=wnam|weur|apac&run=<id>    -> a Durable Object created
 *                                                with that locationHint;
 *                                                its subrequests egress from
 *                                                wherever the object landed
 *
 * Each probe answers with the egress IP + colo (read from Cloudflare's own
 * cdn-cgi/trace, fetched from the SAME context that then calls Dex) and the
 * Dex status/ms. `run` is part of the object name on purpose: locationHint
 * only applies the FIRST time an object is created, so every probe session
 * needs fresh objects or it would measure the previous session's location.
 *
 * AUTH: requires `Authorization: Bearer $PROBE_TOKEN`. With no secret set the
 * Worker refuses everything (fail closed) — it must never become an open
 * DexScreener relay.
 *
 * CACHE: Dex's API sits behind Cloudflare, so a repeated batch is served at
 * 5-8ms with `cf-cache-status: HIT` and never touches the rate-limit bucket.
 * `&bust=1` appends a throwaway query param so every probe is a real MISS;
 * use it whenever the question is "is this egress pool 429-bucketed?", not
 * "is this batch cached?".
 */

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const DEX_TOKENS_URL = "https://api.dexscreener.com/latest/dex/tokens/";
const HINTS = ["wnam", "weur", "apac"];

// Five blue-chip mints: enough to exercise the real endpoint, cheap enough
// that a 15-probe arm cannot meaningfully burn the shared IP's budget.
const DEFAULT_MINTS = [
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", // JUP
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
].join(",");

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Egress IP + colo, as seen by Cloudflare from inside this context. */
async function readTrace() {
  try {
    const res = await fetch(TRACE_URL, { cf: { cacheTtl: 0 } });
    const text = await res.text();
    const map = Object.fromEntries(
      text
        .trim()
        .split("\n")
        .map((line) => {
          const i = line.indexOf("=");
          return i < 0 ? [line, ""] : [line.slice(0, i), line.slice(i + 1)];
        }),
    );
    return { traceHttp: res.status, colo: map.colo ?? null, ip: map.ip ?? null, loc: map.loc ?? null };
  } catch (err) {
    return { traceHttp: 0, colo: null, ip: null, loc: null, traceError: String(err) };
  }
}

/** One real DexScreener call. No cf.cacheEverything: we want Dex's own answer. */
async function probeDex(mints, bust) {
  const started = Date.now();
  // A unique query param defeats Dex's edge cache key, so a MISS reaches the
  // layer that rate-limits. Dex ignores unknown params on this route.
  const url = DEX_TOKENS_URL + mints + (bust ? `?probe=${Date.now()}-${Math.random().toString(36).slice(2)}` : "");
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "solana-meme-bot-egress-probe/1.0" },
    });
    const body = await res.text();
    let pairs = null;
    try {
      const parsed = JSON.parse(body);
      pairs = Array.isArray(parsed.pairs) ? parsed.pairs.length : null;
    } catch {
      pairs = null;
    }
    return {
      status: res.status,
      busted: Boolean(bust),
      ms: Date.now() - started,
      ray: res.headers.get("cf-ray"),
      cache: res.headers.get("cf-cache-status"),
      retryAfter: res.headers.get("retry-after"),
      pairs,
      bodyHead: body.slice(0, 120),
    };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, error: String(err) };
  }
}

export class EgressProbe {
  async fetch(request) {
    const url = new URL(request.url);
    const mints = url.searchParams.get("mints") || DEFAULT_MINTS;
    const bust = url.searchParams.get("bust") === "1";
    const [trace, dex] = await Promise.all([readTrace(), probeDex(mints, bust)]);
    return json({
      arm: url.searchParams.get("arm"),
      run: url.searchParams.get("run"),
      ...trace,
      ...dex,
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");

    if (!env.PROBE_TOKEN) return json({ error: "PROBE_TOKEN is not set — refusing to run" }, 500);
    if (request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) {
      return json({ error: "unauthorized" }, 401);
    }
    if (url.pathname !== "/probe") return json({ error: "not found" }, 404);

    const arm = url.searchParams.get("arm") || "direct";
    const run = url.searchParams.get("run") || "0";
    const mints = url.searchParams.get("mints") || DEFAULT_MINTS;
    const bust = url.searchParams.get("bust") === "1";

    if (arm === "direct") {
      const [trace, dex] = await Promise.all([readTrace(), probeDex(mints, bust)]);
      return json({ arm, run, ...trace, ...dex });
    }
    if (!HINTS.includes(arm)) {
      return json({ error: `arm must be "direct" or one of ${HINTS.join(", ")}` }, 400);
    }

    // Fresh object name per session: the hint is only honoured on creation.
    const id = env.EGRESS.idFromName(`${arm}-${run}`);
    const stub = env.EGRESS.get(id, { locationHint: arm });
    const qs = new URLSearchParams({ arm, run, mints });
    if (bust) qs.set("bust", "1");
    return stub.fetch(`https://probe.internal/probe?${qs}`);
  },
};
