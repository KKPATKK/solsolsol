# Why pushes fell from ~27/day to ~12/day (2026-10-25)

Read-only audit; the only change is `worker.observedLiquidityUsd`'s
certainly-drained exception (below).

## The reading

`/debug/pushes` (the bot's own push record) and `scan_history` agree:

| day | pushes | candidates | pool rows/tick |
| --- | --- | --- | --- |
| 10-16 | 37 | 1,180 | 1,130 |
| 10-17 | 30 | 1,374 | 1,170 |
| 10-18 | 23 | 1,000 | 1,150 |
| 10-19 | 31 | 1,166 | 1,250 |
| 10-20 | 22 | 1,241 | 1,290 |
| 10-21 | 19 | 963 | 1,320 |
| 10-22 | 10 | 1,311 | 577 |
| 10-23 | 17 | 1,209 | 439 |
| 10-24 | 13 | 1,364 | 525 |
| 10-25 (00:00–02:00Z) | 1 | 59 | 522 |

Mean 10-16..10-21 = 27/day, 10-22..10-24 = 13.3/day. Discovery did not fall
(candidates went UP); the conversion from candidate to card did (2.4% → 1.0%),
which is a gate story, not a feed story.

## What the gates are judging

`/debug/tick` (2026-10-25T02:0xZ), one full tick:

```
pool 522  poolSliced 150
lanes hot 38 near 150 far 140 filler 20   served hot 27 near 65 far 40 filler 18
agedEval 1          <- of ~180 coins evaluated, ONE reached the age gate
fails mcap 114  chg 1  age 3  other 206
rejects:  流动性 $0.348105 < $10K  (×~18 of 20 logged)
          流動性 $46.77 < $10K
          市值 $8.43K < $60K
```

So the slice is not short of coins; it is full of *drained pools*. `agedEval 1`
is the whole disease: the 150-row window is spent on coins that can no longer
be pushed, so a live coin is rarely judged at all.

## Why a band full of corpses was possible

Two filters are supposed to keep the re-eval pool to coins that still have a
pool:

- `db.DEAD_POOL_CLAUSE` (live liquidity below `DEAD_LIQUIDITY_USD = $1,000`, or
  three sweeps with no reading at all) — the 2026-09-19 fix for exactly this
  shape;
- the mcap / liquidity floors, which read the **lifetime peaks**
  (`max_mcap_observed`, `max_liquidity_observed`).

The second cannot evict a coin that peaked and then drained — by construction
it is a high-water mark. The first is the one that can, and it reads
`last_liquidity_usd`, written only by `worker.observedLiquidityUsd`.

That helper refuses non-DexScreener legs on purpose (`liquidityIsComparable`):
Jupiter's `liquidity` is 0.46–0.58x DexScreener's for the same pool, and writing
it would push a live coin under the floor — a permanent eviction.

The guard's premise is that the DexScreener leg usually answers. It does not
any more:

```
/health   dex_429_total 40,394     lastStatus "HTTP-429"
tick_legs pairs 324  pairsJup 318  <- ~98% of every pair map is the fallback
token_stats  last_liquidity_usd NULL 63,725 / 65,423   (97.4%)
/debug/pool  deadMarked 314        <- the prune fires almost never
             poolQueryCount 359    against eligibleInWindow 56,429

and the tick's own funnel (`fails other 206, mcap 114, agedEval 1`) is a filter
rejecting emptied pools, not a filter choosing between coins.
```

So since the 429 storm began, `deadMarked` has been effectively zero, corpses
have accumulated, and the 150-row slice is mostly them. The pump.fun feed
resuming its full ~30–50 new coins/min on 2026-10-23 19:00Z (11,758 rows on
10-23, 47,789 on 10-24 against 10–40/day before) added 53k never-measured rows
to the same pool, and the 2026-10-22 slice change guaranteed the filler lane
(never-measured coins) 18 of the 150 slots — which is why the second half of
the month is worse than the first.

## The fix

`worker.observedLiquidityUsd` now records a non-DexScreener reading **only when
it says the pool is empty** — at or under `scanner.DRAINED_POOL_LIQUIDITY_USD`
($500), the same threshold `gateLiquidityUsd` already trusts on the Jupiter leg.

- It is a verdict, not a level: $500 on Jupiter is at most ~$1,100 on
  DexScreener, an order of magnitude under the $10K chat floor and under the
  pool's own $6,400 prune, so it cannot evict a coin that could have been
  pushed.
- It restores `DEAD_POOL_CLAUSE` — the band drains itself over one rotation
  instead of growing forever.
- Peak-based floors are untouched; levels from other legs still never reach
  the column (a live coin's Jupiter reading is still refused).

The write carries an **evidence gate**: the drained-only verdict applies only
where `max_mcap_observed IS NOT NULL`, i.e. a row the band admitted on a real
peak. A row with no mcap history is inside its six-hour never-measured grace
(`POOL_MCAP_EVIDENCE_GRACE_MS`) — a launch curve with no buys yet, where a
`流动性 ~$0` reading is normal (the same reading the feed's fresh coins always
give) — and evicting it there would lose the coin permanently: the feed never
re-offers it and its age gate has not even opened. One sweep later the row has
its own peak and the verdict can judge it. The gate is one extra `AND` in
`Db.recordObservedLiquidity`, and it costs no extra round trip (same batch).

## What to watch after the deploy

- `/debug/pool` `deadMarked` should climb from 314 into the thousands within a
  rotation, and `poolQueryCount` should settle at the *live* cohort.
- `/debug/tick` `agedEval` should move off 1, and `fails.other` (liquidity)
  should stop dominating `fails.mcap`.
- `/debug/pushes` daily count should climb back toward the 10-21 baseline
  (~19–27/day); the 429 storm is a separate, upstream problem (pairs still come
  from the Jupiter fallback, so `dex`-lane pushes stay thin).
