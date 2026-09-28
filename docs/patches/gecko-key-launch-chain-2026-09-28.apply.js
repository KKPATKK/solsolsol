/*
 * 2026-09-28 — the GeckoTerminal key + the launch-slot chain + the pool's
 * liquidity prune ratio.
 *
 * WHY THIS FILE EXISTS: `str_replace` answers "not found" for large parts of
 * src/scanner.ts (a stale snapshot, the same failure docs/patches documented
 * for src/pushwatch.ts and src/worker.ts), while the bytes on disk are exactly
 * what a reader sees. So the edits are applied here instead, with every anchor
 * checked for existence AND uniqueness, and the whole thing is idempotent —
 * a second run must print `=` for every row and change nothing.
 *
 * WHAT IT DOES (see docs/gecko-key-launch-chain-2026-09-28.md for the why):
 *   1. scanner: POOL_LIQUIDITY_PRUNE_RATIO (0.8) is the pool query's
 *      minQualifyLiquidity, and geckoDiscoveryDue() is the pure cadence rule.
 *   2. scanner: the launch-slot chain is re-shaped — pump.fun always on,
 *      gecko gated to one fetch per discovery interval, Meteora as gecko's
 *      cover.
 *   3. wrangler.toml + scripts/cpu-profile.js + .github/workflows/deploy.yml:
 *      the knobs and the secret that make the above true in production.
 *
 * Usage: node docs/patches/gecko-key-launch-chain-2026-09-28.apply.js
 */

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
let failures = 0;

/**
 * Apply `edits` to one file. Each edit is { name, old, new, done }:
 *   - `done` is a marker that proves the edit already landed (idempotence),
 *   - `old` must appear EXACTLY once (a second anchor is a refusal, not a
 *     guess — every one of these strings is a decision, not a coincidence).
 */
function applyTo(rel, edits) {
  const abs = path.join(root, rel);
  let text = fs.readFileSync(abs, "utf8");
  let changed = false;
  for (const e of edits) {
    if (e.done && text.includes(e.done)) {
      console.log(`= ${rel} :: ${e.name} (already applied)`);
      continue;
    }
    const first = text.indexOf(e.old);
    if (first === -1) {
      console.log(`\u2717 ${rel} :: ${e.name} — anchor not found`);
      failures++;
      continue;
    }
    if (text.indexOf(e.old, first + 1) !== -1) {
      console.log(`\u2717 ${rel} :: ${e.name} — anchor is not unique`);
      failures++;
      continue;
    }
    text = text.slice(0, first) + e.new + text.slice(first + e.old.length);
    changed = true;
    console.log(`\u2713 ${rel} :: ${e.name}`);
  }
  if (changed) fs.writeFileSync(abs, text);
}

// ---------------------------------------------------------------- scanner.ts

const SCANNER_RATIO_HELPER = `const RE_EVAL_PER_TICK_MAX = 90;

/**
 * The liquidity floor the re-eval pool prunes on, as a fraction of the widest
 * enabled chat's liquidity gate (\`minQualifyLiquidity\` in the pool query).
 *
 * 0.6 → 0.8 (2026-09-28). The prune is one-way and permanent — a coin dropped
 * here can never be pushed — which is why it sits BELOW the gate itself, and
 * why the raise is only safe in one direction: a coin whose peak liquidity
 * never reached 0.8 × the floor could never have passed the gate it is pruned
 * against, so no coin that could have been pushed is lost, while the dust that
 * occupied every band's LIMIT (measured 2026-09-10: ~215 of ~330 judged
 * coins/tick failed the liquidity gate) is dropped a little further out of the
 * sweep. Exported so a test pins the ratio instead of copying it.
 */
export const POOL_LIQUIDITY_PRUNE_RATIO = 0.8;

/**
 * Whether the launch slot's GeckoTerminal new-pools leg may spend a fetch this
 * tick (pure — unit-tested). \`intervalMs\` is
 * AppConfig.geckoterminalDiscoveryIntervalMs, 0 = no gate.
 *
 * FAIL-OPEN on every reading it cannot trust, the same discipline the push
 * gates keep for missing data: an absent row (a fresh deploy, a brand-new
 * key), a non-numeric row, or a stamp in the FUTURE (clock skew, or a row
 * written by an isolate whose clock ran ahead) all say DUE. The cost of that is
 * one extra fetch; the cost of the other direction is a discovery leg that
 * silently stops for the length of the skew.
 */
export function geckoDiscoveryDue(
  lastAttemptMs: number,
  nowMs: number,
  intervalMs: number,
): boolean {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return true;
  if (!Number.isFinite(lastAttemptMs) || lastAttemptMs <= 0) return true;
  const age = nowMs - lastAttemptMs;
  if (age < 0) return true;
  return age >= intervalMs;
}`;

const SCANNER_SUMMARY_DOCS_OLD = `  /**
   * True when that pump.fun batch came from the GECKO FALLBACK slot (gecko's
   * new_pools was paused, so the launch feed filled it — see
   * pumpfunDiscoveryLimit). Distinguishes "gecko is down and pump.fun is
   * carrying the launch slot" from "pump.fun ran as its own always-on feed".
   */
  pumpFallback?: boolean;
  /**
   * Meteora Data API discovery feed size this scan (METEORA_FALLBACK_LIMIT,
   * 0 when disabled/unconfigured). This layer only ever runs as the launch
   * slot's LAST resort — gecko's new_pools AND pump.fun both delivered nothing
   * — so a non-zero count is itself the proof that the two layers ahead of it
   * failed (see src/meteora.ts).
   */
  meteora: number;
  /** GeckoTerminal new-pools feed size this scan (0 when blocked/unconfigured). */
  geo: number;`;

const SCANNER_SUMMARY_DOCS_NEW = `  /**
   * True when that pump.fun batch came from the GECKO FALLBACK slot (see
   * pumpfunDiscoveryLimit). LEGACY as of 2026-09-28: production runs
   * PUMPFUN_PROFILE_LIMIT=20, i.e. the always-on branch, so this flag is only
   * ever set by a configuration that still routes gecko through the pump
   * fallback (always-on limit 0 + a fallback size > 0).
   */
  pumpFallback?: boolean;
  /**
   * Meteora Data API discovery feed size this scan (METEORA_FALLBACK_LIMIT,
   * 0 when disabled/unconfigured). Since 2026-09-28 this layer is GECKO'S
   * COVER, so a non-zero count is the proof that gecko delivered nothing this
   * tick — either because the cadence gate held it back (see \`geoDue\`) or
   * because the fetch it was allowed came back empty or refused. See the
   * launch-slot chain in src/scanner.ts.
   */
  meteora: number;
  /**
   * GeckoTerminal new-pools feed size this scan (0 when blocked, held back by
   * the cadence, or unconfigured). Read together with \`geoDue\`: \`geo 0\` with
   * \`geoDue false\` is the cadence doing its job, \`geo 0\` with \`geoDue true\` is
   * a fetch that came back with nothing.
   */
  geo: number;
  /**
   * Whether the new-pools cadence gate allowed a fetch on this tick
   * (GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS + Db.GECKO_DISCOVERY_AT_KEY).
   * false = the tick was inside the window, so the leg cost nothing at all.
   */
  geoDue?: boolean;`;

const SCANNER_CHAIN_OLD = `      // LAUNCH-SLOT FALLBACK CHAIN: gecko's new_pools is the primary keyless
      // launch feed, and a tick where it delivers nothing would leave the
      // brand-new-coin slot empty — so two more keyless sources stand behind
      // it, in measured order of freshness (both measured from the WORKER's own
      // egress, the only placement that counts — see /debug/pool-source):
      //
      //   1. pump.fun v3 /coins      — newest coin ~2s old, one request
      //   2. Meteora DAMM v2 /pools  — newest pool ~32s old, sorted server-side
      //      by pool_created_at (see src/meteora.ts — Raydium and Orca cannot
      //      answer "newest pools" at all: neither exposes a creation order)
      //
      // A layer awaits the one before it and returns the moment that layer
      // delivered, so a healthy gecko tick pays NOTHING, a tick pump.fun fills
      // never reaches Meteora, and only a tick where every layer ahead came
      // back empty walks the whole chain. The wait sits INSIDE the feed window
      // (fetchFeedCapped's floor): a layer that starts with no window left
      // returns [] without dispatching, so a hung layer cannot drag the chain
      // past the deadline.`;

const SCANNER_CHAIN_NEW = `      // THE LAUNCH SLOT (2026-09-28): three keyless non-DexScreener sources, and
      // the shape BETWEEN them changed the day gecko got a key. Before, gecko's
      // new_pools was the primary and the other two stood behind it as
      // fallbacks, because that leg was called every tick and was usually
      // 429ed. A key moves the limiter off the shared egress IP and onto the
      // key — QUOTA-bound (10K calls/month on the demo plan) rather than
      // rate-bound — so gecko became a 5-MINUTE leg behind
      // Db.GECKO_DISCOVERY_AT_KEY, and the other two are no longer a fallback
      // chain behind it:
      //
      //   pump.fun v3 /coins      ALWAYS ON (PUMPFUN_PROFILE_LIMIT = 20): one
      //                           paginated batch per tick, newest coin ~2s
      //                           old. The one source whose freshness makes a
      //                           per-tick cadence worth its cost.
      //   gecko new_pools         ONE FETCH PER DISCOVERY INTERVAL (~5 min).
      //                           Quota-bound, and freshness does not matter to
      //                           it: a launch pool is only judged once it ages
      //                           into the 30h qualifying window, so a coin
      //                           registered 5 minutes late is judged on the
      //                           same tick.
      //   Meteora DAMM v2 /pools  GECKO'S COVER: fetched on every tick gecko
      //                           delivered nothing — the four in five its
      //                           cadence holds back, plus a due tick whose
      //                           fetch came back empty or refused. Newest pool
      //                           ~32s old, sorted server-side by
      //                           pool_created_at (see src/meteora.ts — Raydium
      //                           and Orca cannot answer "newest pools" at all:
      //                           neither exposes a creation order).
      //
      // All three ride the same feed fan-out and are bounded by the feed window
      // (fetchFeedCapped's floor): a leg that starts with no window left
      // returns [] without dispatching, so a hung upstream cannot drag the
      // phase past the deadline. Meteora awaits the gecko JOB before deciding,
      // and a SKIPPED gecko tick leaves that job null — i.e. it dispatches
      // immediately instead of waiting for a request nobody made.`;

const SCANNER_GECKO_OLD = `      let geckoProfiles: TokenProfile[] = [];
      if (this.shouldStopEarly()) {
        await Promise.all(feedJobs);
        return;
      }
      if (this.gecko) {
        const geckoPromise = this.fetchFeedCapped(`;

const SCANNER_GECKO_NEW = `      let geckoProfiles: TokenProfile[] = [];
      if (this.shouldStopEarly()) {
        await Promise.all(feedJobs);
        return;
      }
      // The CADENCE GATE (see geckoterminalDiscoveryIntervalMs and
      // Db.GECKO_DISCOVERY_AT_KEY): a keyed new-pools leg is quota-bound, so it
      // is fetched at most once per window across the WHOLE fleet. The row rides
      // the front's single read above and its single write below, so the gate
      // costs no round trip of its own. A skipped tick deliberately leaves
      // \`geckoJob\` null and \`diag.geo\` 0 — exactly the reading the Meteora
      // layer below is built to cover.
      const geckoLastAt = Number(front.gates.get(GECKO_DISCOVERY_AT_KEY) ?? 0);
      const geckoDue =
        this.gecko !== null &&
        geckoDiscoveryDue(
          geckoLastAt,
          Date.now(),
          this.config.geckoterminalDiscoveryIntervalMs,
        );
      diag.geoDue = geckoDue;
      if (this.gecko && geckoDue) {
        // Stamped at DISPATCH, not on success: the window bounds how often the
        // key is SPENT, and an attempt that fails (429, refusal, a window cut)
        // may still have been billed — retrying every tick until one succeeds
        // is the exact spend the window exists to stop. The ticks it is not
        // retried on are covered by pump.fun and Meteora.
        await this.stampFront(GECKO_DISCOVERY_AT_KEY, String(Date.now()));
        const geckoPromise = this.fetchFeedCapped(`;

const SCANNER_PUMP_OLD = `      let pumpProfiles: TokenProfile[] = [];
      let pumpJob: Promise<void> | null = null;
      const pumpAlwaysLimit = this.config.pumpfunProfileLimit;
      const pumpFallbackLimit = this.config.pumpfunFallbackLimit;
      if (this.pumpfun && (pumpAlwaysLimit > 0 || pumpFallbackLimit > 0)) {
        const pumpPromise = (async () => {
          if (pumpAlwaysLimit <= 0) {`;

const SCANNER_PUMP_NEW = `      let pumpProfiles: TokenProfile[] = [];
      const pumpAlwaysLimit = this.config.pumpfunProfileLimit;
      const pumpFallbackLimit = this.config.pumpfunFallbackLimit;
      if (this.pumpfun && (pumpAlwaysLimit > 0 || pumpFallbackLimit > 0)) {
        const pumpPromise = (async () => {
          // The legacy shape, kept for a configuration that leaves the
          // always-on limit at 0: only then is pump.fun a fallback for gecko,
          // and only then does a chain order exist at all. Production
          // (PUMPFUN_PROFILE_LIMIT = 20) never enters this branch — it fetches
          // on every tick, in parallel with every other feed.
          if (pumpAlwaysLimit <= 0) {`;

const SCANNER_METEORA_OLD = `      // Meteora DAMM v2 — the chain's LAST resort (see src/meteora.ts). Reached
      // only when gecko AND pump.fun both delivered nothing, which is exactly
      // the case this layer exists for: pump.fun blocks datacenter IPs on and
      // off, and an independent provider is what keeps the slot filled when it
      // does. Sized by METEORA_FALLBACK_LIMIT (0 = off).
      let meteoraProfiles: TokenProfile[] = [];
      if (this.meteora && this.config.meteoraFallbackLimit > 0 && !dropOptionalLeg("meteora")) {
        feedJobs.push(
          (async () => {
            if (pumpJob !== null) await pumpJob;
            // An EARLIER layer filling the slot stops the chain. Testing
            // \`diag.pump\` alone is not enough: when gecko delivered, the pump
            // layer returns from its skip branch WITHOUT setting \`diag.pump\`,
            // so this layer would go to the network on a tick gecko covered.
            if (diag.geo > 0 || diag.pump > 0) return;`;

const SCANNER_METEORA_NEW = `      // Meteora DAMM v2 — GECKO'S COVER (see src/meteora.ts). It is an
      // independent provider precisely for the ticks gecko's 5-minute cadence
      // holds back, and for a due tick whose fetch came back empty or refused:
      // the DEX-side launch slot stays filled either way, while pump.fun covers
      // pump.fun launches of its own accord (it is an ALWAYS-ON feed now, so it
      // neither gates nor is gated by this layer — see the chain comment above).
      // Sized by METEORA_FALLBACK_LIMIT (0 = off).
      let meteoraProfiles: TokenProfile[] = [];
      if (this.meteora && this.config.meteoraFallbackLimit > 0 && !dropOptionalLeg("meteora")) {
        feedJobs.push(
          (async () => {
            if (geckoJob !== null) await geckoJob;
            // A gecko tick that DELIVERED stops the chain — no reason to pay
            // for a second DEX launch list. Do not read \`diag.geo\` before the
            // await above: on a tick whose gecko fetch is still in flight it is
            // the not-yet-decided 0.
            if (diag.geo > 0) return;`;

applyTo("src/scanner.ts", [
  {
    name: "POOL_LIQUIDITY_PRUNE_RATIO + geckoDiscoveryDue",
    old: "const RE_EVAL_PER_TICK_MAX = 90;",
    new: SCANNER_RATIO_HELPER,
    done: "export const POOL_LIQUIDITY_PRUNE_RATIO = 0.8;",
  },
  {
    name: "pool query: liquidity prune comment + ratio",
    old: `        // Liquidity floor prune: drop coins whose peak liquidity never
        // reached 0.6× the widest chat's liquidity gate. Dead-liquidity`,
    new: `        // Liquidity floor prune: drop coins whose peak liquidity never
        // reached POOL_LIQUIDITY_PRUNE_RATIO (0.8 since 2026-09-28, up from
        // 0.6) × the widest chat's liquidity gate. Dead-liquidity`,
    done: "reached POOL_LIQUIDITY_PRUNE_RATIO (0.8 since 2026-09-28",
  },
  {
    name: "pool query: minQualifyLiquidity uses the ratio",
    old: "        minQualifyLiquidity: poolMinLiquidityUsd * 0.6,",
    new: `        minQualifyLiquidity:
          poolMinLiquidityUsd * POOL_LIQUIDITY_PRUNE_RATIO,`,
    done: "poolMinLiquidityUsd * POOL_LIQUIDITY_PRUNE_RATIO,",
  },
  {
    name: "observed-liquidity note: 0.6 → the constant",
    old: "        // pool's `minQualifyLiquidity` prune (0.6 × the widest chat's floor,",
    new: "        // pool's `minQualifyLiquidity` prune (POOL_LIQUIDITY_PRUNE_RATIO,",
    done: "prune (POOL_LIQUIDITY_PRUNE_RATIO,",
  },
  {
    name: "ScanSummary: meteora/geo docs + geoDue",
    old: SCANNER_SUMMARY_DOCS_OLD,
    new: SCANNER_SUMMARY_DOCS_NEW,
    done: "geoDue?: boolean;",
  },
  {
    name: "launch-slot chain comment",
    old: SCANNER_CHAIN_OLD,
    new: SCANNER_CHAIN_NEW,
    done: "THE LAUNCH SLOT (2026-09-28)",
  },
  {
    name: "gecko cadence gate + stamp",
    old: SCANNER_GECKO_OLD,
    new: SCANNER_GECKO_NEW,
    done: "const geckoDue =",
  },
  {
    name: "pump.fun always-on comment",
    old: SCANNER_PUMP_OLD,
    new: SCANNER_PUMP_NEW,
    done: "The legacy shape, kept for a configuration",
  },
  {
    name: "pump job: drop the now-unread variable",
    old: `        pumpJob = pumpPromise;
        feedJobs.push(pumpPromise);`,
    new: `        // Pushed straight onto the fan-out: nothing downstream waits on a
        // pump job any more (Meteora waits on the GECKO job — see below).
        feedJobs.push(pumpPromise);`,
    done: "nothing downstream waits on a",
  },
  {
    name: "Meteora becomes gecko's cover",
    old: SCANNER_METEORA_OLD,
    new: SCANNER_METEORA_NEW,
    done: "Meteora DAMM v2 — GECKO'S COVER",
  },
]);

// Two stale comments the first pass left behind: the geckoJob placement note
// still called the chain a "fallback chain (gecko → pump.fun → Meteora)", and
// the feed header still called the leg free/no-key.
applyTo("src/scanner.ts", [
  {
    name: "geckoJob placement note: the chain is no longer a fallback chain",
    old: `      // The launch-slot fallback CHAIN (gecko → pump.fun → Meteora) is built
      // after the gecko job BELOW, and that placement is load-bearing: each
      // layer awaits the promise of the layer before it, and a layer placed
      // above its producer reads \`null\` — an async IIFE runs synchronously up
      // to its first await, so \`if (geckoJob !== null) await geckoJob\` in a
      // block that precedes the gecko job is ALWAYS false. Measured 2026-09-21:
      // that is how the previous "gecko fallback" silently became an always-on
      // feed (\`pump 20\` + \`pumpFallback true\` on ticks where gecko was healthy
      // too, and gecko's own \`geo 0\` never gated anything). geckoJob lives here
      // only so the gecko block below can hand its promise over.`,
    new: `      // Meteora's decision reads the gecko JOB, so the gecko job has to be
      // declared BEFORE its producer — and that placement is load-bearing: an
      // async IIFE runs synchronously up to its first await, so \`if (geckoJob
      // !== null) await geckoJob\` in a block that precedes the gecko job is
      // ALWAYS false. Measured 2026-09-21: that is how the previous "gecko
      // fallback" silently became an always-on feed (\`pump 20\` + \`pumpFallback
      // true\` on ticks where gecko was healthy too, and gecko's own \`geo 0\`
      // never gated anything). geckoJob lives here only so the gecko block
      // below can hand its promise over, and stays NULL on a tick the cadence
      // gate skips — which is how Meteora learns it may dispatch immediately.`,
    done: "Meteora learns it may dispatch immediately.",
  },
  {
    name: "gecko feed header: the leg is keyed and 5-minute now",
    old: `      // GeckoTerminal new-pools feed — the free (no-key) discovery source
      // covering every Solana DEX incl. pump.fun graduates, replacing the
      // CU-expensive Birdeye new_listing for live discovery. Pools are
      // registered by their pool_created_at (≈ graduation time, matching
      // how DexScreener pairs age coins), so they enter the re-eval pool
      // and are evaluated once they reach the qualifying age window.`,
    new: `      // GeckoTerminal new-pools feed — the discovery source covering every
      // Solana DEX incl. pump.fun graduates, replacing the CU-expensive
      // Birdeye new_listing for live discovery. Pools are registered by their
      // pool_created_at (≈ graduation time, matching how DexScreener pairs age
      // coins), so they enter the re-eval pool and are evaluated once they
      // reach the qualifying age window. Since 2026-09-28 it is a KEYED leg
      // (CoinGecko key) and therefore a 5-MINUTE one — see the cadence gate
      // below — and both halves of what it does are idempotent (the mint
      // dedupe and the pool registration), so registering a coin minutes late
      // costs it nothing.`,
    done: "Since 2026-09-28 it is a KEYED leg",
  },
]);

// Follow-up on the first pass: the stamp belongs INSIDE the capped fetch, not
// at the gate. fetchFeedCapped refuses to call its closure when the feed window
// has nothing left, and a tick that never reached the network must not burn the
// 5-minute window — that would cost discovery time for a request nobody made.
applyTo("src/scanner.ts", [
  {
    name: "stamp the gecko window only when the fetch is actually dispatched",
    old: `      if (this.gecko && geckoDue) {
        // Stamped at DISPATCH, not on success: the window bounds how often the
        // key is SPENT, and an attempt that fails (429, refusal, a window cut)
        // may still have been billed — retrying every tick until one succeeds
        // is the exact spend the window exists to stop. The ticks it is not
        // retried on are covered by pump.fun and Meteora.
        await this.stampFront(GECKO_DISCOVERY_AT_KEY, String(Date.now()));
        const geckoPromise = this.fetchFeedCapped(
            async () => {
              const pools = [];`,
    new: `      if (this.gecko && geckoDue) {
        const geckoPromise = this.fetchFeedCapped(
            async () => {
              // Stamped HERE rather than at the gate above: fetchFeedCapped
              // refuses to call this closure when the feed window has nothing
              // left, and a tick that never reached the network must not burn
              // the window — that would cost five minutes of discovery for a
              // request nobody made. Stamped at DISPATCH rather than on success
              // for the opposite reason: an attempt that fails (429, a refusal)
              // may still have been billed, and retrying it every tick until
              // one succeeds is exactly the spend the window exists to stop.
              // The ticks it is not retried on are covered by pump.fun and
              // Meteora.
              await this.stampFront(GECKO_DISCOVERY_AT_KEY, String(Date.now()));
              const pools = [];`,
    done: "Stamped HERE rather than at the gate above",
  },
]);

// src/worker.ts wires the same clients, so its two comments about the launch
// slot have to say the same thing as the scanner's (or the next reader learns
// the old chain from the construction site).
applyTo("src/worker.ts", [
  {
    name: "pump.fun + gecko constructor comments",
    old: `          // pump.fun discovery widens coverage beyond the DexScreener
          // profiles feed (best-effort — blocked/degraded feeds return []).
          new PumpFunClient(config),
          // GeckoTerminal new-pools discovery — free (no key), covers every
          // Solana DEX incl. pump.fun graduates (best-effort — blocked or
          // degraded feeds return [] and the scan continues on the others).
          new GeckoTerminalClient(config),`,
    new: `          // pump.fun discovery — the launch slot's ALWAYS-ON feed since
          // 2026-09-28 (PUMPFUN_PROFILE_LIMIT=20), on every tick; best-effort,
          // a blocked/degraded feed returns [].
          new PumpFunClient(config),
          // GeckoTerminal new-pools discovery — keyed (COINGECKO_API_KEY) and
          // therefore a 5-MINUTE leg, covers every Solana DEX incl. pump.fun
          // graduates; best-effort — blocked or degraded feeds return [] and
          // the scan continues on the others (see the cadence gate + the
          // launch-slot chain in src/scanner.ts).
          new GeckoTerminalClient(config),`,
    done: "the launch slot's ALWAYS-ON feed since",
  },
  {
    name: "Meteora constructor comment",
    old: `          // Meteora Data API newest-pools discovery — the launch slot's third
          // and last keyless source (best-effort; reached only when gecko's
          // new_pools AND pump.fun both came back empty — see src/meteora.ts).
          new MeteoraClient(config),`,
    new: `          // Meteora Data API newest-pools discovery — GECKO'S COVER since
          // 2026-09-28: reached on every tick gecko's 5-minute cadence holds
          // back, and on a due tick whose fetch came back empty or refused
          // (best-effort; see src/meteora.ts).
          new MeteoraClient(config),`,
    done: "GECKO'S COVER since",
  },
]);

// ------------------------------------------------------------- wrangler.toml

applyTo("wrangler.toml", [
  {
    name: "COINGECKO_API_KEY: option → the live path",
    old: `# COINGECKO_API_KEY (optional, with COINGECKO_API_PLAN=demo|pro) moves the
# GeckoTerminal/CoinGecko rate limit from the shared Worker egress IP onto the
# key — see docs/gecko-429.md. Measured 2026-09-25: keyless is ~5 req/min per
# source IP and the Worker's shared IP never gets them, so the key is the ONLY
# route back to gecko. It is quota-bound, not rate-bound: the demo plan is
# 100 calls/min + 10K calls/month, and this bot's new_pools leg alone at one
# call per tick is ~43K/month, so a key only pays off with the discovery leg
# throttled to one call per ~5 min (8,640/month) — trending is off below.`,
    new: `# COINGECKO_API_KEY (with COINGECKO_API_PLAN=demo|pro) moves the
# GeckoTerminal/CoinGecko rate limit from the shared Worker egress IP onto the
# key — see docs/gecko-429.md. Measured 2026-09-25: keyless is ~5 req/min per
# source IP and the Worker's shared IP never gets them, so the key is the ONLY
# route back to gecko. It is quota-bound, not rate-bound: the demo plan is
# 100 calls/min + 10K calls/month, and this bot's new_pools leg alone at one
# call per tick is ~43K/month, so a key only pays off with the discovery leg
# throttled to one call per ~5 min (8,640/month). Trending stays off below.
#
# 2026-09-28: a key is CONFIGURED, so this is the live path rather than an
# option. The throttling it needs is now enforced in code —
# GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS below — and the launch slot is
# carried between gecko fetches by pump.fun (always on) and Meteora. The key is
# a Worker SECRET: the deploy workflow writes it from the GitHub Actions secret
# COINGECKO_API_KEY (see .github/workflows/deploy.yml), which is also the only
# place it should ever be typed. A keyless deploy still runs — the leg simply
# stays at \`geo 0\` (summary.geoDue is still true; it is the fetch that comes
# back refused) and the two keyless sources carry the slot.`,
    done: "the live path rather than an",
  },
  {
    name: "PUMPFUN_PROFILE_LIMIT: 0 → 20 (always on)",
    old: `# pump.fun discovery as an ALWAYS-ON feed: DISABLED (0) — the legacy host
# (frontend-api.pump.fun) 530-blocks Worker egress (CF error 1016, origin DNS
# gone since ~2026-08-20), so each tick only burned a doomed request. The v3
# host is alive (measured 2026-09-21: HTTP 200, newest coins ~2s old at
# offset 0), so the feed is now wired as the GECKO FALLBACK below instead of
# running every tick.
#
# NOTE (2026-09-21): this 0 did NOT disable anything until now — loadConfig's
# \`> 0 ? clamp : 100\` turned it into 100, so the "disabled" feed ran at five
# paged requests per tick and the fallback branch below never engaged (live
# \`/debug/tick\` showed \`pump 0\` with no \`pumpFallback\`). 0 now means OFF.
PUMPFUN_PROFILE_LIMIT = "0"`,
    new: `# pump.fun discovery as an ALWAYS-ON feed: ENABLED at 20 (2026-09-28).
#
# History: the legacy host (frontend-api.pump.fun) 530-blocks Worker egress
# (CF error 1016, origin DNS gone since ~2026-08-20), so the feed sat at 0 and
# the v3 host (frontend-api-v3.pump.fun) was wired as gecko's FALLBACK instead
# of an always-on feed. The chain flipped the day gecko got a key (see
# COINGECKO_API_KEY above): gecko's new_pools became a QUOTA-BOUND 5-minute leg
# (GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS below), and the per-tick freshness
# the launch slot actually wants is pump.fun's — ~2s old at offset 0, measured
# from the WORKER's own egress: \`pumpfun-v3 status 200 bytes 39112 count 20
# newestAgeS 2\`. The two no longer gate each other: pump.fun fetches its batch
# on EVERY tick and Meteora covers the ticks gecko's cadence skips.
#
# Cost: one paginated batch (20 coins = 1 request) per tick on the host that
# already serves this feed. 0 = the leg is off again; an UNSET variable keeps
# the historic 100-coin default.
PUMPFUN_PROFILE_LIMIT = "20"`,
    done: 'PUMPFUN_PROFILE_LIMIT = "20"',
  },
  {
    name: "PUMPFUN_FALLBACK_LIMIT: 20 → 0 (legacy, unreachable)",
    old: `# GECKO FALLBACK size: how many pump.fun newest coins to fetch while
# GeckoTerminal's new_pools is PAUSED (429 or a hard refusal — its live state
# since 2026-09-21, which leaves \`geo 0\` and the brand-new-coin slot empty).
# It is a batch size, not a switch: 0 = off, and it costs nothing while gecko is
# healthy. See pumpfunDiscoveryLimit in src/pumpfun.ts.
# ENABLED at 20 (the same batch size as the gecko feed it stands in for) after
# \`/debug/pool-source\` proved the v3 host from the WORKER's own egress on
# 2026-09-21: \`pumpfun-v3 status 200 bytes 39112 count 20 newestAgeS 2\` while
# the legacy host answered 530/CF-1016. Seconds old is fresher than gecko's
# new_pools ever was, and the cost is bounded to gecko's outage.
#
# CHAIN ORDER (src/scanner.ts): gecko new_pools → this feed → METEORA_FALLBACK_LIMIT
# below. Each layer awaits the one before it, so this one is only paid for on a
# tick where gecko delivered nothing, and the Meteora layer only on a tick where
# BOTH of them did.
PUMPFUN_FALLBACK_LIMIT = "20"`,
    new: `# GECKO FALLBACK size — LEGACY as of 2026-09-28, and set to 0 because the
# ALWAYS-ON limit above now covers every tick. It is the "fill gecko's slot"
# branch of pump.fun's feed: a batch size, not a switch (0 = off), paid only on
# a tick where gecko delivered nothing — see pumpfunDiscoveryLimit, which only
# reaches this value while PUMPFUN_PROFILE_LIMIT is 0. With the always-on limit
# at 20 that branch is unreachable, so the old chain (gecko → pump.fun →
# Meteora) is gone: the slot is filled by pump.fun on every tick and by Meteora
# on the ticks gecko's 5-minute cadence skips. Leave this at 0 unless the
# always-on feed is deliberately turned off again.
PUMPFUN_FALLBACK_LIMIT = "0"`,
    done: 'PUMPFUN_FALLBACK_LIMIT = "0"',
  },
  {
    name: "METEORA_FALLBACK_LIMIT: last resort → gecko's cover",
    old: `# Meteora Data API newest-pools feed — the launch slot's LAST keyless source,
# reached only when gecko's new_pools AND pump.fun both delivered nothing (0 =
# off). ENABLED after \`/debug/pool-source\` proved it from the WORKER's own
# egress on 2026-09-21: \`meteora-damm-v2 status 200 count 10 newestAgeS 32\`
# with \`sort_by=pool_created_at:desc\` and both pool sides on every row.
# A DIFFERENT provider, not a second URL for pump.fun — which is the point:
# pump.fun blocks datacenter IPs on and off, and this keeps the slot filled when
# it does. Earlier notes said "Meteora cannot serve a time-ordered pool list at
# all"; that was measured against \`dlmm-api.meteora.ag\`, which now 404s every
# path root-included. Meteora's current hosts (dlmm.datapi.meteora.ag /
# damm-v2.datapi.meteora.ag) do sort by creation time. Raydium and Orca still
# cannot — Raydium's \`sortField\` enum is liquidity/volume/fee/apr (and the
# look-alike \`poolSortField\` is silently ignored), Orca's pools carry no
# creation field. One request when reached. See src/meteora.ts.
METEORA_FALLBACK_LIMIT = "20"`,
    new: `# Meteora Data API newest-pools feed — GECKO'S COVER (2026-09-28), the
# launch slot's second keyless DEX-side source. It is now reached on every tick
# gecko delivered nothing: the four in five that
# GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS holds gecko back, plus a due tick
# whose fetch came back empty or refused. 0 = off. ENABLED at 20 after
# /debug/pool-source proved it from the WORKER's own egress on 2026-09-21:
# \`meteora-damm-v2 status 200 count 10 newestAgeS 32\` with
# \`sort_by=pool_created_at:desc\` and both pool sides on every row.
# A DIFFERENT provider, not a second URL for pump.fun — which is the point:
# pump.fun covers pump.fun launches and blocks datacenter IPs on and off, this
# covers the other DEXes. Earlier notes said "Meteora cannot serve a
# time-ordered pool list at all"; that was measured against
# \`dlmm-api.meteora.ag\`, which now 404s every path root-included. Meteora's
# current hosts (dlmm.datapi.meteora.ag / damm-v2.datapi.meteora.ag) do sort by
# creation time. Raydium and Orca still cannot — Raydium's \`sortField\` enum is
# liquidity/volume/fee/apr (and the look-alike \`poolSortField\` is silently
# ignored), Orca's pools carry no creation field. One request when reached.
# See src/meteora.ts.
METEORA_FALLBACK_LIMIT = "20"
# Minimum spacing between GeckoTerminal new-pools FETCHES, in seconds (code
# default 300 = one fetch per 5 min; 0 = no gate, one per tick). This is the
# cadence the KEYED leg is spent at: the demo plan is 10K calls/month, one call
# per 5 minutes is 8,640/month, and the discovery loss is nil because a launch
# pool is only judged once it ages into the 30h qualifying window. 0 would be
# ~43K/month and would burn the key in a week.
#
# The gate is DURABLE (worker_state \`gecko_discovery_at\`, riding the scan
# front's single read + single write), because this Worker's isolates churn
# every ~30s: a per-isolate window would never elapse and the quota arithmetic
# above would not hold. On a tick the gate skips, \`summary.geoDue\` is false
# and Meteora fills the slot (see the launch-slot chain in src/scanner.ts).
GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS = "300"`,
    done: 'GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS = "300"',
  },
]);

// ------------------------------------------------------- scripts/cpu-profile.js

applyTo("scripts/cpu-profile.js", [
  {
    name: "import the pool ratio",
    old: `const { Scanner } = require("../dist/scanner.js");`,
    new: `const { Scanner, POOL_LIQUIDITY_PRUNE_RATIO } = require("../dist/scanner.js");`,
    done: "POOL_LIQUIDITY_PRUNE_RATIO } = require",
  },
  {
    name: "mirror the pool query's liquidity prune",
    old: `      minQualifyLiquidity: poolMinLiquidityUsd * 0.6,`,
    new: `      // The scanner's own constant, so this profile can never measure a
      // pool the tick would not have read (2026-09-28: 0.6 → 0.8).
      minQualifyLiquidity: poolMinLiquidityUsd * POOL_LIQUIDITY_PRUNE_RATIO,`,
    done: "minQualifyLiquidity: poolMinLiquidityUsd * POOL_LIQUIDITY_PRUNE_RATIO,",
  },
]);

// -------------------------------------------------- .github/workflows/deploy.yml

applyTo(".github/workflows/deploy.yml", [
  {
    name: "COINGECKO_API_KEY worker-secret step",
    old: `            echo "::warning::JUPITER_API_KEY not set as a GitHub Actions secret — skipping (keyless 0.5 RPS is fine)"
          fi
`,
    new: `            echo "::warning::JUPITER_API_KEY not set as a GitHub Actions secret — skipping (keyless 0.5 RPS is fine)"
          fi

      # Optional COINGECKO_API_KEY (CoinGecko Demo/Pro key, sent as
      # x-cg-demo-api-key / x-cg-pro-api-key) — the ONLY route back to
      # GeckoTerminal's new_pools, whose keyless quota is shared across
      # Cloudflare's whole egress fleet (see docs/gecko-429.md). With the key
      # configured the discovery leg is quota-bound, so it is gated to one
      # fetch per GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS (wrangler.toml: 5 min
      # = 8,640 calls/month against the demo plan's 10K). Best-effort by
      # design: unset just leaves the leg keyless (\`geo 0\`) with the launch
      # slot carried by pump.fun + Meteora — never block a release on it.
      - name: Set COINGECKO_API_KEY worker secret
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          COINGECKO_API_KEY: \${{ secrets.COINGECKO_API_KEY }}
        run: |
          if [ -n "$COINGECKO_API_KEY" ]; then
            if echo "$COINGECKO_API_KEY" | npx wrangler secret put COINGECKO_API_KEY; then
              echo "::notice::COINGECKO_API_KEY written to Worker secret"
            else
              echo "::warning::COINGECKO_API_KEY secret update failed — continuing keyless (the launch slot is covered by pump.fun + Meteora)"
            fi
          else
            echo "::warning::COINGECKO_API_KEY not set as a GitHub Actions secret — skipping (the gecko discovery leg stays at geo 0)"
          fi
`,
    done: "Set COINGECKO_API_KEY worker secret",
  },
]);

console.log(
  failures === 0
    ? "\n\u2713 all edits applied (re-run to prove idempotence)"
    : `\n\u2717 ${failures} edit(s) failed`,
);
process.exit(failures === 0 ? 0 : 1);
