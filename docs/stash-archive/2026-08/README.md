# Stash archive — August 2026

Three `git stash` entries that sat in one developer workspace, archived here on
**2026-10-12** so they are durable and visible on GitHub.

## Why they are stored as patches, not as branches with the code applied

A stash is local-only. All three lived in the single `refs/stash` reflog of one
workspace: no branch, local or remote, contained any of the three commits, and
nothing had ever been pushed. A re-clone of the workspace, or one
`git stash clear`, would have destroyed them — including `src/poolfees.ts`,
a 91-line module that exists nowhere else.

They are **not** archived as applied branches because none of them still applies
to the current line: their bases are 448–477 commits behind, the files they touch
have drifted by 31K–40K lines since, and every one of them conflicts. Re-applying
one today is a rewrite, not a `git stash pop`. The patches below preserve the
**exact** content for reference, and each one still applies cleanly to its **own**
old base commit if you ever want the code back verbatim.

## Contents

| Patch | Stash | Created (UTC) | Base commit | Size |
|---|---|---|---|---|
| `01-pool-fees-gate-axiom-probe.patch` | `stash@{0}` `624da56` | 2026-08-24 10:36:26 | `05e1bd7` | 340 lines |
| `01-pool-fees-gate-axiom-probe.untracked.patch` | same (untracked part) | ″ | ″ | 97 lines |
| `02-smart-money-pro-absence.patch` | `stash@{1}` `ff58565` | 2026-08-22 12:33:19 | `27e9377` | 318 lines |
| `03-insider-burst-launcher.patch` | `stash@{2}` `9891676` | 2026-08-22 08:48:59 | `1edf310` | 544 lines |

Stash subjects as recorded at the time:

- `stash@{0}` — "On main: pool-fees gate + axiom probe (pending accuracy verification)"
- `stash@{1}` — "On main: smart-money card line + pro-absence tracker alert"
- `stash@{2}` — "On main: insider-concentration + burst-launcher gates (removed per request)"

## 01 — Raydium pool-fees gate + axiom probe

- New module **`src/poolfees.ts`** (91 lines, the `.untracked.patch`): `PoolFeesClient`
  reads Raydium API v3 (`api-v3.raydium.io`) accumulated LP fees per pool, `dayUsd`
  and `weekUsd`. Coverage is Raydium-only; missing data never judges a coin.
- `poolFeeBlockReason(...)` — a quality gate: high accrued fees = real trading;
  "market cap with near-zero fees" = stale or wash-traded chart.
- Card line for the reading, wired through `src/index.ts`
  (`import { PoolFeesClient } from "./poolfees"`, `new PoolFeesClient(config)`).
- New var: `POOL_FEE_MCAP_RATIO_MIN = "0.0005"`; new config field `poolFeeMcapRatioMin`.
- Files: `scripts/test-unit.js`, `src/config.ts`, `src/index.ts`, `src/render.ts`,
  `src/scanner.ts`, `src/worker.ts`, `wrangler.toml` (+ new `src/poolfees.ts`).
- Subject says "pending accuracy verification" — the gate was never validated against
  real pushes, so treat the threshold as uncalibrated.

## 02 — Smart-money card line + PRO-absence tracker alert

- `proAbsenceAlert(...)` in `src/pushwatch.ts`: the tracker's delayed recheck that
  alerts when the "Pro Traders" the card showed never materialised.
- Card line in `src/render.ts`: `🧠 聰明錢: N（24h smart_trader）`, from Birdeye
  `smart_trader` tags (`proTraders`), bundler/dev excluded. Display-only at push
  time (pros arrive late) — the actionable half is the tracker alert.
- New DB column `pros_checked_at` (`src/db.ts`, `CREATE TABLE` change) — the file
  that makes resurrection hardest, because the schema has since moved through
  `schema_alter_v2`.
- New vars: `PUSH_WATCH_PRO_CHECK_MIN = "45"`, `PUSH_WATCH_PRO_GAIN_PCT = "30"`;
  new config fields `proCheckDelayMin`, `proGainAlertPct`.
- Distinct from the smart money already in the codebase, which is the Arkham/GMGN
  route (`arkham.smartMoney`); this is the Birdeye/Axiom "Pro Traders" signal.
- Files: `scripts/test-unit.js`, `src/config.ts`, `src/db.ts`, `src/pushwatch.ts`,
  `src/render.ts`, `src/scanner.ts`, `wrangler.toml`.

## 03 — Insider-concentration + burst-launcher gates

- `insiderBlockReason(...)`, `burstLaunchBlockReason(...)` (new gate logic in
  `src/scanner.ts`) and `jupAuditBlockReason(...)` with the `JupAudit` interface
  (`src/jupfeeds.ts`, `src/rugcheck.ts`).
- New vars: `RUGCHECK_BLOCK_BUNDLER_PCT = "20"`, `RUGCHECK_BLOCK_TOP10_PCT = "75"`,
  `RUGCHECK_BURST_WINDOW_HOURS = "24"`, `RUGCHECK_BURST_MAX_TOKENS = "1"`,
  `RUGCHECK_JUP_FALLBACK = "true"`, `JUP_BLOCK_SERIAL_MINTS = "50"`.
- Config fields: `jupBlockSerialMints`, `rugcheckBlockBundlerPct`,
  `rugcheckBlockTop10Pct`, `rugcheckBurstMaxTokens`, `rugcheckBurstWindowHours`,
  `rugcheckJupFallback`.
- The stash subject records that these gates were **removed per request** — the
  archive is for the record, not a revival candidate.
- Files: `scripts/test-unit.js`, `src/config.ts`, `src/jupfeeds.ts`,
  `src/rugcheck.ts`, `src/scanner.ts`, `wrangler.toml`.

## Restoring one

Apply onto its own base commit — that is the only place these patches apply
without conflict:

```sh
git worktree add /tmp/restore 05e1bd7            # the stash's base, from the table
cd /tmp/restore
git apply /path/to/docs/stash-archive/2026-08/01-pool-fees-gate-axiom-probe.patch
git apply /path/to/docs/stash-archive/2026-08/01-pool-fees-gate-axiom-probe.untracked.patch  # 01 only
```

To bring a change forward to current `main` you have to re-implement it against
today's code; these patches are reference material.

## Conflict status against `1fe0956` (2026-10-12)

Trialled by applying each stash in a throwaway worktree at `1fe0956`. All three
conflict; the counts are conflict hunks per file.

| Patch | Conflicting hunks | Files that applied cleanly |
|---|---|---|
| 01 | 13 — `test-unit.js` 2, `config.ts` 2, `render.ts` 2, `scanner.ts` 3, `worker.ts` 3, `wrangler.toml` 1 | `src/index.ts`, and the new `src/poolfees.ts` |
| 02 | 15 — `test-unit.js` 2, `config.ts` 2, `db.ts` 4, `pushwatch.ts` 2, `render.ts` 3, `scanner.ts` 1, `wrangler.toml` 1 | none (all 7 files conflicted) |
| 03 | 5 — `test-unit.js` 2, `config.ts` 1, `scanner.ts` 1, `wrangler.toml` 1 | `src/jupfeeds.ts`, `src/rugcheck.ts` |

Every `wrangler.toml` conflict is the same shape: both sides appended a `[vars]`
block at the same insertion point, so "keep both" resolves it. Every
`test-unit.js` conflict is in the top `require("../dist/*.js")` destructuring.

## Provenance and how this archive was verified

Generated from the stash objects themselves:

```sh
git diff <base> <stash>            # tracked part
git diff <empty-tree> <stash>^3    # untracked part (01 only; it has 3 parents)
```

Fidelity check, run against each stash's own base commit:

- `git apply --check` — clean, no fuzz, all four patches;
- after applying, the written tree hash is **identical** to the stash's tree:
  `1b08529d71f0` (01), `0dad08fa842f` (02), `8e66b8426373` (03);
- `src/poolfees.ts` from the untracked patch is **blob-identical** to
  `stash@{0}^3:src/poolfees.ts` (`4e329e04ff98`).

So the patches are a byte-exact copy of what each stash held, not a paraphrase.
