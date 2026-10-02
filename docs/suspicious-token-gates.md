# Suspicious-token gates: Jupiter's `audit.isSus` + the LP-heavy ratio floor

**2026-09-28.** Written from a single pushed coin that then had its pool sold
empty, and from the 48-token measurement that followed. Two new push gates and
one honesty fix came out of it. This file is the evidence behind their
thresholds — read it before retuning them.

## 1. The case

`Quant (QNT)`, mint `EnQbyi2fgEwjzopWfm4f7v15pW7weZkcrfFQNiBEMXBi`.

| time (UTC) | event |
|---|---|
| 18:00:41 | mint created (Jupiter `createdAt`) |
| 18:00:43 | pool created (`pairCreatedAt`, pump_fun_amm) |
| 18:01:03 | bot sees it (+22s, `discoveredVia jup`) |
| **19:33:53** | **initial card pushed** — age 1h33m, mcap $81,566 |
| 19:35 → 20:27 | ignite → up50 → up100 → **up200** |
| 21:01:50 | ⚠️ `liqwarn` |
| 21:07:50 | 💧 `drain` — the last card; tracking ends |

Ten cards in all. This was **not** a missed detection: the bot announced the
drain in real time, 1h34m after the push. What the case exposed is what the
card knew and nothing acted on.

Live state afterwards: `liquidity.usd 0` on DexScreener (base 0.0028 tokens /
5e-9 SOL — both sides empty), `h1` and `m5` transaction counts 0, Jupiter
`priceChange -100` / `liquidityChange -99.9999999%`, RugCheck creator
`4v5fwW…fxcM` = **holder #1 with 25.08% of supply**, holder #2 at 20.06%.

## 2. What was already in hand at push time

**The vendor flag.** Jupiter Token v2's `/search` response — the SAME call the
card's 🌱 有機度 line already makes (`JupTokensClient.fetchOrganicScore`) —
carries an `audit` block. For this mint:

```json
"audit": {"isSus": true, "mintAuthorityDisabled": true, "freezeAuthorityDisabled": true,
          "topHoldersPercentage": 35.94, "devBalancePercentage": 25.08,
          "devMigrations": 2, "devMints": 16}
```

Jupiter's docs: *"Use `audit.isSus` as an additional signal for suspicious
tokens. `isSus` is only present when a token has been flagged, so check for the
field's presence."* The gate is therefore **presence-only** — absent means "not
flagged", never "verified safe". `devBalancePercentage` agrees with RugCheck's
`topHolders[0]` to the last decimal (25.08), from two independent providers.

**The card itself.** The pushed card printed `🌱 有機度: 0.0（low） | 1h 交易者
50` — 50 traders in an hour and Jupiter's own organic score of zero. Nothing in
the pipeline reads that number.

**The fabricated all-clear.** The same card printed
`🛡 Bundler: 0.0%（未检测到捆绑网络）` while `token_stats.rugcheck_bundler_pct`
was `null` and the live RugCheck report has `insiderNetworks: null` (no insider
analysis at all). `rugcheck.ts` collapsed both "computed 0" and "no answer"
into `null`, and `render.ts` rendered `null` as the reassuring sentence.

## 3. The measurement

Method (reproducible, read-only): the bot's own `/debug/push-audit` ring
(200 rows, 15:44–22:15Z), grouped into its **48 unique tokens**, 13 of which
received a `liqwarn`/`drain` in the window; then per mint Jupiter
`/tokens/v2/search?query=<mint>` for the audit block; then `/debug/token?mint=`
for our own stored `max_liquidity_observed` / `max_mcap_observed`.

| criterion | triggered | of those, drained | false positives |
|---|---|---|---|
| `audit.isSus === true` | 5 | **5** | **0 / 35** |
| `devBalancePercentage ≥ 10` | 5 | 5 | **0 / 35** |
| `liq/mcap ≥ 0.30` (mcap/LP < 3.3x) | 5 | 5 | **0 / 35** (clean max: 0.289) |
| `liq/mcap ≥ 0.50` (mcap/LP < 2.0x) | **4** | **4** | **0 / 35** |
| `devMints ≥ 3` | 22 | 6 | 16 — **red herring** |
| tag `token-2022` | ~90% | — | — **useless** |

Union of the three real signals: `{Betty 0.90, PenguinCat 0.75, FROINK 0.53,
FROINK(2), SP 0.31, QNT 0.70}` — **6 of 6 drained, 0 false positives**, i.e.
46% of the window's liquidity pulls caught for ~12% of its push volume.

Why the *low* ratio is the danger: for a constant-product pool
`LP/mcap = 2 × (tokens in the pool ÷ total supply)`, so `liq/mcap 0.70` means
**~35% of the supply was still sitting in the pool** — the "market cap" was
mostly tokens nobody had bought yet, in a pool whose SOL side the two biggest
wallets could still take. Every push above 2.9x mcap/LP was fine; the four
below 2.0x had their liquidity pulled.

## 4. What shipped

| change | where | knob |
|---|---|---|
| Reject `audit.isSus === true` | `scanner.jupSusBlockReason`, awaited after the display batch and **before** the wallet/Flurry legs so a flagged coin saves those two legs | `JUP_SUS_BLOCK` (default true) |
| Reject `mcap/LP < MCAP_LIQ_RATIO_MIN` — the band's low side, `top10MinBlockReason`'s shape | `scanner.mcapRatioBlockReason(…, ratioMin)`, called through `gateLiquidityUsd` like its ceiling | `MCAP_LIQ_RATIO_MIN = "2"` (= liq/mcap ≥ 0.50 blocks), 0 = off |
| Reject `organicScore < ORGANIC_MIN_SCORE` | `scanner.organicMinBlockReason`, read from the **same awaited reading** `jupSusBlockReason` uses (one await, two judgements) and sited with it, before the wallet/Flurry legs | `ORGANIC_MIN_SCORE = "55"` (60 until 2026-10-01), 0 = off |
| Missing bundler reading prints `—（未检测）`, a real 0% keeps `0.0%（未检测到捆绑网络）` | `rugcheck.ts` (real-0 vs no-answer) + `render.ts` (three states) | — |

The two Jupiter judgements share ONE callable since 2026-10-01
(`scanner.jupiterGateVerdict`) and are applied TWICE — at the early site above,
and again immediately before the card is built, from the same late-bound box the
card reads. The second call is §7; the first is what saves the wallet/Flurry
legs.

Observability: `fails.sus`, `fails.organic` and `fails.liqRatio` in
`/health.heartbeat.summary`, split so each floor can be tuned from live numbers
(the low side alone — the high side keeps counting into `fails.other`), plus
the reject ring in `/debug/tick` carrying the reason text and numbers.

## 5. Limits — read these before trusting the above

- **No push-time snapshot exists.** The audit readings were taken hours later.
  `devMints` only grows and a balance can move, so a flagged-now token was not
  necessarily flagged-then. The one pre-push reading this file can *prove* is
  the 🌱 有機度 0.0 on the card itself.
- **n = 5 flagged, 13 pulls, 6.5 hours.** Perfect separation on five coins is
  not a law, and the 0.30 threshold I first proposed was fitted to this sample
  (the clean maximum was 0.289). The shipped floor is 2.0x mcap/LP, which is
  the operator's own choice and sits further out than the fitted one.
- **Precision is what was measured, not recall.** The gate cannot catch the
  ~54% of pulls that carry none of these signals.
- **Jupiter's latency is unknown.** A rug that completes before the flag is
  computed can still be pushed; the bot's own tracker remains the last line
  (this case got its 💧 card).
- **`liq/mcap` is a DexScreener-leg number** and inherits the provenance guard
  (`gateLiquidityUsd`): a Jupiter/Gecko-sourced pair (~half the same pool) is
  left unjudged rather than compared against a different metric.
- **`ORGANIC_MIN_SCORE` is the operator's number, not this file's.** The
  measurement below pointed at a floor, but the threshold itself was never
  calibrated here, so `fails.organic` (not this document) is what the floor
  should be judged by. Fail-open is the shipped contract: a token Jupiter carries no
  score for — field absent, never a genuine 0 — still pushes, as does a reading
  that missed its deadline. Note the section-5 drift caveat above applies to it
  too: the score is read at push time, not snapshotted.
  What §3 did measure: of the 13 in-window liquidity pulls, all 5 that carried
  score 0 were drained, but 0 can also just mean "too new", which is why this
  file declined to ship a floor on its own.
- Not measured, and deliberately not shipped: `devBalancePercentage` as a gate
  of its own (it matched `isSus` exactly in this sample, so it adds nothing yet).

## 6. The falsifiable next step

Re-run §3's method on a fresh ring (a week of pushes is ~200 tokens) and check
the two claims this file makes: `isSus` still has no false positive, and the
pushes between 2.0x and 2.9x behave like the clean cohort. If any push below
2.0x turns out healthy, the floor is too strict and `MCAP_LIQ_RATIO_MIN` is the
single number to raise.

## 7. 2026-10-01: the late-bound reading could be PRINTED without being judged (JANE)

**Live:** `I am Jane Doe (JANE)` was pushed with `🌱 有機度: 0.0（low）` on the
card while `fails.organic` stayed 0 — score 0, floor 55, pushed. The reading was
real and current: `/debug/jupiter?organic=<mint>` (the Worker's own egress)
answered `score 0, label low` in 71–144ms, and the same reading is on the card.
The losing tick measured **7_458ms** (the slowest in its neighbourhood; the
`pushed=1` row is in `/debug/scan-history` at 16:35:10Z).

**Root cause — a timing hole, not a config one.** The organic slot is
late-bound: dispatched with the display batch, walled at `tickDeadline` (+8.0s),
and the card is rendered from its box (`organicBox.value`) after the
wallet/Flurry legs. The two gates read a ONE-TIME snapshot of it at the early
site, whose wait is clamped to `chainDeadline` (+6.5s). On that slow tick the
early wait answered `null` — fail-open, which is correct for "no data" — and
the reading landed afterwards, in time for the CARD but too late for the gate.
The number was never wrong; only the moment it was judged was.

**Fix.** `scanner.jupiterGateVerdict` (exported for tests) composes
`jupSusBlockReason` + `organicMinBlockReason`, and `Scanner.jupiterGatesBlocked`
applies it twice: at the early site (unchanged — it is what saves the
wallet/Flurry legs) and again immediately before the card is built, reading the
SAME box the card reads. The render call waits for nothing (a null box still
fails open, so the push reserve is untouched) and a block at the early site
`continue`s the chain, so the counters cannot double-count. Inside the verdict
`JUP_SUS_BLOCK` is now honoured — before this, `false` left the flag judged
anyway whenever the organic floor kept the await alive; the deployed value is
`true`, so nothing changes live, but the knob now matches this file's table.

**Tests.** `jupiterGateVerdict` (pure): the JANE reading blocks whenever it is
read, a score exactly at the floor passes, a null reading / absent score never
judges, sus wins the report when both fire, and `JUP_SUS_BLOCK=false` disarms
sus while the floor keeps judging. Wiring pin: one `fails.organic++` /
`fails.sus++` writer, one slot await, one early call (in front of the wallet
legs) and one render call (in front of `renderMessage`). Mutations, each red on
its own: the verdict's organic branch disabled; `if (config.jupSusBlock)` →
`if (true)`; the render call deleted from the chain.

**Worth watching:** `fails.organic` should now fire on the FIRST low reading
that reaches any card, including the ones that used to slip through on slow
ticks. A push with a below-floor score printed on its card is a regression of
this section.

### §7.1 After deploy (`eb71702` 2026-10-01 17:24:45Z; hardened `89d9f12` 18:08:34Z)

Live, 17:25–17:42Z (12 ticks, `/health` + `/debug/scan-history` +
`/debug/push-audit`): no below-floor push and `fails.organic` still 0 — the
gate has not been exercised yet, because no coin has reached the render with a
low reading. The last INITIAL card is still GG (`17:23:07.781Z`, mcap 71,985,
pushed by the pre-deploy code); the cards sent after the deploy are followups
(Uptober `revive` 17:31:23, SARKA `reclaim` 17:32:02, Meridian 17:40:03), which
ride the tracker/push-watch path and never touch `renderMessage`. JANE itself
is no longer reaching the card either way: `/debug/token` reports
`maxMcapObserved 279091` while its re-evaluations are rejected at the mcap gate
(`市值 — < $60K` in `summary.rejects`), i.e. the coin now dies one gate EARLIER
than the organic floor.

**The verification did find a residual hole in the first cut**, and it is the
same class of bug this section is about: the render judgement was taken before
`await this.trade.effectiveMode()`, while `organicBox` is written from a `.then`
microtask — so a reading that lands during that await would still be printed by
the card unjudged. Hardened: the snapshot
`const organicReading = organicBox.value;` is taken AFTER the last await in
front of the card, and the SAME snapshot is what `renderMessage` receives
(`organicReading`), so judgement and card are literally one read — the window is
now closed rather than merely narrowed. The wiring pin was tightened to say so
(one snapshot; the render call after the trade-mode read; the card built from
`organicReading,`), and its mutations are red on their own: snapshot moved in
front of the await (ordering assert), card back on the raw box (snapshot assert).
This hardening shipped as `89d9f12` (CI run `36904406578` success, completed
18:08:34Z, `headSha` matched), so the PAPU reading below and the `fails.organic 0`
span cover both commits.

The historical patch `docs/patches/organic-late-bound-and-probe-2026-09-26.apply.js`
now accepts either the direct box or the judged snapshot, so re-applying it
cannot silently undo the hardening.

**First initial card after the deploy.** PAPU (`17:55:08Z`, mcap 67,601) is the
first INITIAL card the new code sent, and its reading answers the question the
gate exists to ask: `/debug/jupiter?organic=9qKHgTSAEFffsH1JzhqqjWejZZBvBTWSAH1chz3VQwro`
→ `score 64.6` (`medium`), `sus false`, 141ms — above the 55 floor, so card and
gate agree. With the snapshot in place that agreement is now structural rather
than lucky: a card printing a below-floor `有機度` would have been blocked on
the same read, which is what makes `fails.organic 0` across 17:25–18:12Z
(≈45 ticks, 1 initial card + 6 followups) the acceptance reading.

Still worth watching (unchanged): the first tick where `fails.organic` moves
tells us the render judgement is doing live work; a card that PRINTS a
below-floor `有機度` is the regression to look for.
