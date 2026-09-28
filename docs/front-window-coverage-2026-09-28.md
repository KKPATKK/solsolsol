# Spending the paid tick window on coverage (2026-09-28)

Follow-up to `docs/patches/paid-budget-2026-09-28.apply.js`. That change spent the
Workers Paid plan's budgets (30s CPU, 1,000 subrequests) on *not dying*: the tick
budget went 9,500 → 20,000ms and the scan deadline 4,200 → 8,000ms. It left every
front-phase cap at its free-plan value, so the tick had a 6,400ms front window
(`SCAN_TICK_DEADLINE_MS` 8,000 − `SCAN_GATE_RESERVE_MS` 1,600) with caps summing
to 3,500ms. This change spends the difference, measures what it bought, and takes
back the one lever the measurement rejected.

## What changed

| constant | before | after | why |
|---|---|---|---|
| `FEED_DEADLINE_MS` (scanner.ts) | 900 | **1,600** | ceiling for a slow fan-out, not a spend |
| `POOL_FETCH_BUDGET_MS` (scanner.ts) | 1,600 | **2,400** | stays above the DB layer's 1,440ms hard wall |
| `PAIRS_FETCH_BUDGET_MS` (dexscreener.ts) | 1,000 | **2,000** | the one cap that was genuinely binding (below) |
| `SCAN_PROFILE_LIMIT` (wrangler.toml + config.ts clamp) | 100 | **200** | headroom only — the feed carries ~20–30 rows |
| `RE_EVAL_PER_TICK_MAX` (scanner.ts) | 90 | **90** | raised to 180, measured, reverted (below) |

Front caps now sum to **6,000ms of the 6,400ms window** (1,600 + 2,400 + 2,000).
`SCAN_PROFILE_LIMIT` is honest headroom: neither 100 nor 200 binds, because the
`/token-profiles/latest/v1` page carries ~20–30 Solana rows per tick.

## Measurement 1: the caps are ceilings, not spends

| reading | before the change | after |
|---|---|---|
| `feedsMs` | 677–780ms | 678–780ms |
| `poolMs` | 159–518ms | 181–576ms |
| `jup` / `jupTrend` / `boosts` | 20 / 10–13 / 17 | 20 / 8–13 / 17 |

Identical. Raising a cap cannot slow a healthy tick — each phase ends when its
work is done — so the wider ceilings only change the ticks where an upstream is
slow enough to have been cut, which is exactly when they matter.

The exception was `PAIRS_FETCH_BUDGET_MS`: at 90 + the feed's ~22 addresses the
request is ~112 addresses = 4 batches of 30, and at the 250ms dispatch spacing
the fourth batch cannot START before ~750ms and then has to answer — i.e. right
at the 1,000ms cap, which is why the live reading was **`pairs` 83 of ~112**.
With 2,000ms (8 slots = 240 addresses) the fetch comes back with **`pairs` 116**:

| `pairs` (coins with pair data) | before | after |
|---|---|---|
| `/debug/tick` | **83** | **116** |

That is ~33 coins per tick that were being requested, dropped past the cap, and
never judged.

## Measurement 2: the doubled rotation slice bought no candidates

The idea was that a bigger slice = more coins judged = more candidates. It was
run live for 20 minutes with `RE_EVAL_PER_TICK_MAX` = 180, then reverted:

| reading | slice 90 (09:11–09:14Z) | slice 180 (09:20–09:28Z) |
|---|---|---|
| `poolSliced` | 90 | 180 |
| `agedEval` | 6–7 | **7** |
| `candidates` | 0–1 | **0** |
| `evalMs` | 968–1,082 | 1,987–2,109 |
| heartbeat ms | 1,780–2,539 | 3,400–3,737 |
| `fails.other` | 119–162 | 148–200 |

The extra 90 judgments land in `fails.other` — the liquidity and 24h-volume
gates. The pool read is dominated by coins whose liquidity has already collapsed
below the gate, and an old coin dies on that FIRST gate, before the age check and
before the momentum gates. In-window coins are already served every scan by the
SQL rotation bands (the hot zone), which is why `agedEval` does not move with
this constant at all: the wider slice bought judgments of dust, not candidates,
and cost ~1s of CPU and ~1.2s of tick wall clock per tick. Reverted to 90.

## Where the measurement points next

Per-tick candidates are bounded by the pool's **coin mix**, not by the tick
window. `/debug/pool` reports **16.8K** never-pushed coins eligible in the age
window while one tick reads ~240–500 of them and only ~7 of the ~200 it judges
reach the age + momentum gates. The levers denominated in that gap are the
liquidity prune (`minQualifyLiquidity`), the rotation band limits, and
`RE_EVAL_POOL_SIZE` — each of which should be moved with a measurement like the
one above, not by widening this slice again.

The delivered state after the revert (09:33–09:36Z, cron ticks):

```
poolSliced 90   pairs 116   agedEval 7   candidates 0-1   pushed 0
evalMs 1,048-1,727   poolMs 181-576   feedsMs 678-780
heartbeat ms 2,370-3,138   deadTickStreak 0   dex http429 0   budgetDrops 0
```

Local: `npm run typecheck` clean, `npm run test:unit` **393 + 6 + 5 + 9 + 4 + 13
passed, 0 failed**. Deploys: run `36402664966` → version `23aa3fd5-b013-4120-b612-612fe2c9cecd`
(the raise), run `36404141789` → version `e1cf8dac-7233-4bec-9388-0fba7415977a`
(the revert).

## Patches

- `docs/patches/front-window-coverage-2026-09-28.apply.js` — the raises.
- `docs/patches/pool-slice-measurement-revert-2026-09-28.apply.js` — run after it:
  reverts the slice, corrects the notes the raises left, and restores two comment
  lines the first patch's opening edit ate (it replaced its own anchor text).

Both are idempotent (`=` on a second run) and verify-then-write (they abort with a
non-zero exit if any anchor is missing or ambiguous).
