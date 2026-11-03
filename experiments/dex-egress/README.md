# Dex egress / colo experiment (zero cost, throwaway)

## What it answers

Production's DexScreener pair lane 429s at ~50/hour. Every pair call now runs on
the **placed** fetch path (`[placement] region = "gcp:us-south1"` → DFW), so the
whole bot egresses from **one** Cloudflare egress pool. The question this probe
answers: *is another Cloudflare region's egress pool cleaner, and does moving the
request there change the 429 rate at all?*

## What it cannot do (checked against the docs)

- **`cf-placement` is not an input.** Cloudflare *sets* it on responses
  (`remote-LHR` / `local-EWR`); it is a placement diagnostic header. There is no
  `cf` fetch option, header, or config that pins egress. `cf.placement` /
  `[placement]` decides where the **Worker runs**, and the region form maps to
  "the data center with the lowest latency", not a named colo.
- **Regional Services does not cover subrequests.** Its docs say so explicitly,
  so the paid data-localization product is not a lever either.
- **`cf.resolveOverride` only changes the DNS target**, not the egress IP.

Two measurement traps this probe handles explicitly:

- **Dex's API is behind Cloudflare.** A repeated batch comes back in 5–8 ms with
  `cf-cache-status: HIT` and never reaches the rate-limit bucket, so a clean run
  can be pure cache. `BUST=1` appends a throwaway query param and is the only
  mode that answers "is this egress pool 429-bucketed?".
- **`/cdn-cgi/trace`'s `ip=` is not the egress IP.** Every arm reports the same
  Cloudflare-internal address; only `colo=` distinguishes them. The Dex answer
  is the real signal.

The only remaining lever is a **Durable Object `locationHint`**: the object is
created "in a data center selected to minimize latency from the hinted
location", and its subrequests leave from wherever it landed. That is best-effort
(Cloudflare says hints are not a guarantee), which is exactly why this is an
experiment and not a design.

## Files

| file | role |
|---|---|
| `wrangler.toml` | its own Worker (`dex-egress-probe`), never the production one |
| `worker.mjs` | `/probe?arm=direct\|wnam\|weur\|apac` — reads the egress IP/colo from `cdn-cgi/trace`, then calls Dex once |
| `probe.mjs` | runs N probes per arm, sequentially, and prints per-arm 200/429 counts + egress IPs |

`arm=direct` is the control (no Durable Object). The other three create a fresh
DO per run id with that `locationHint`; a new run id is required every session
because the hint is only honoured when the object is first created.

## Deploy (about 1 minute)

```bash
npx wrangler deploy --config experiments/dex-egress/wrangler.toml
# prints https://dex-egress-probe.<your-subdomain>.workers.dev

TOKEN=$(openssl rand -hex 24)
printf '%s' "$TOKEN" > /tmp/dex-egress-token   # never commit it
printf '%s' "$TOKEN" | npx wrangler secret put PROBE_TOKEN \
  --config experiments/dex-egress/wrangler.toml

curl -s https://dex-egress-probe.<your-subdomain>.workers.dev/healthz   # ok
curl -s -o /dev/null -w '%{http_code}\n' \
  https://dex-egress-probe.<your-subdomain>.workers.dev/probe           # 401

# The DFW baseline: same code, placed exactly like production, so its
# `direct` arm measures the pool production actually egresses from.
npx wrangler deploy --config experiments/dex-egress/wrangler.dfw.toml
printf '%s' "$TOKEN" | npx wrangler secret put PROBE_TOKEN \
  --config experiments/dex-egress/wrangler.dfw.toml
```

## Run

```bash
PROBE_URL=https://dex-egress-probe.<your-subdomain>.workers.dev \
PROBE_TOKEN=$(cat /tmp/dex-egress-token) \
BUST=1 node experiments/dex-egress/probe.mjs
```

Defaults: 15 probes per arm, 1.2 s apart, arms `direct,wnam,weur,apac` (~80 s).
Always add `BUST=1` for the 429 question; without it the arms mostly measure
Dex's edge cache.
`SHOW_BODY=1` prints the first 120 bytes of each distinct body (useful to tell a
rate-limit page from a maintenance page). `--json` prints raw rows.

- All four arms clean? That only means the bucket refills between bursts —
  re-run with `N=60 GAP_MS=500` before concluding anything.
- Same IP on all arms? `locationHint` did not move the egress: colo choice buys
  nothing, and the VPS relay is the only route.
- One arm clean on a different IP? Worth a longer run on that arm alone.

## Measured 2026-11-03 (cache-busted, `BUST=1`)

| arm | landed colo | 200 / 429 | p50 |
|---|---|---|---|
| `direct` (unplaced) | LAX | 10 / 0 | 619 ms |
| `direct` (unplaced) | LAX | 8 / 0 | 579 ms |
| `wnam` | SJC | **0 / 10** | 5 ms, `Retry-After: 34` |
| `wnam` (next session) | LAX | 8 / 0 | 512 ms |
| `weur` | CDG | 10 / 0 | 680 ms |
| `weur` (next session) | LIS | 8 / 0 | 567 ms |
| `apac` | ICN | 10 / 0 | 718 ms |
| `apac` (next session) | KIX | 8 / 0 | 737 ms |
| **`dex-egress-probe-dfw` (placed like production)** | **DFW** | **0 / 10** | **5 ms, `Retry-After: 44`** |

The DFW row is the whole answer: production's own placed egress was fully
bucketed at the same minute three other colos answered real MISSes in 512–737 ms.
SJC was bucketed too, so it is **not** "some colos are good" — it is one shared
pool per colo, whose state changes minute to minute (the LAX arm read 7/15 in a
warm-cache run earlier and 10/10 clean once cache-busted).

What this means for the bot: a different colo can get the pair lane out of the
429 **today**, but it is a lottery on a pool shared with every other Worker in
that data center, and `locationHint` is best-effort (it landed `wnam` in SJC,
then LAX; `weur` in CDG, then LIS). It is not a substitute for the relay, which
is the only path with an egress of your own.

Also worth noting: the first, non-busted run read `weur 15/15` at 5–8 ms — that
was Dex's edge cache, not headroom. Without `BUST=1` the numbers look encouraging
and mean nothing.

## Cost

Workers Free + Durable Objects Free: 100K requests/day each; this experiment
spends ~100 requests and a handful of objects. **€0.**

## Delete

```bash
npx wrangler delete --config experiments/dex-egress/wrangler.toml --force
npx wrangler delete --config experiments/dex-egress/wrangler.dfw.toml --force
rm -f /tmp/dex-egress-token
```

Deleting the script removes the probe and its objects; nothing in the production
Worker reads it.
