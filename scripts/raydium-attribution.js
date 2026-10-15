#!/usr/bin/env node
/*
 * READ-ONLY. The Raydium LaunchLab feed's acceptance reading: the first push
 * attributed to it, and the evidence that the attribution and the cross-feed
 * dedupe are right.
 *
 * WHY A SCRIPT AND NOT /debug/feed-stats. That route answers the same
 * attribution table but through the durable 5-minute debug cache
 * (DEBUG_SCAN_CACHE_TTL_MS), so the transition this file exists to catch can
 * sit invisible for up to five minutes, and it reports counts only — not WHICH
 * mint crossed. Two SELECTs here read the live rows instead.
 *
 * WHAT THE ROWS MEAN.
 *  - token_stats.discovered_via is written ONCE, by INSERT OR IGNORE. One mint
 *    therefore has exactly ONE owning feed: the dedupe is single-owner by
 *    construction, whatever the tick decided the label was.
 *  - WHICH feed that is comes from scanner.ts's `discoveredVia` map. It is
 *    built in feedProfiles order (dex, pump, raydium, gecko, … meteora) and
 *    `new Map(entries)` keeps the LAST duplicate key, so the list must be fed
 *    in REVERSE for the highest-priority leg to own a mint several legs
 *    carried in the same tick. From 0e59b51 (2026-08-22) to the 2026-10-13 fix
 *    it was passed as written, and the label went to the LOWEST-priority leg
 *    that carried the mint: measured then, of the 1,505 pump.fun launches
 *    registered in the previous hour, 1,373 were owned by `jup` against the
 *    pump leg's 132 (all-time 40,869 vs 4,499). The `label-share` readings
 *    below are how that is still checked: a non-pump feed owning most `%pump`
 *    mints — pump.fun launches by vanity address, which no other launchpad can
 *    mint — is the inversion, so `label-share-last-hour` is the after-deploy
 *    acceptance for the fix (it must move to the pump leg, over the first hour
 *    the fixed code runs).
 *  - seen_tokens has PK (chat_id, token): ONE row per chat is one card. A
 *    second card for the same mint and chat cannot exist, so a per-chat count
 *    above 1 is the duplicate-card reading (there is only one chat today).
 * So the acceptance pair is: a seen_tokens row joined to a token_stats row
 * whose discovered_via = 'raydium' (attribution), with exactly one claim for
 * that chat (dedupe) — and the feed table's `pushed` for raydium moving by
 * exactly that claim while no other feed's moves for it.
 *
 * Run: node scripts/raydium-attribution.js
 *          one-shot: the attribution table, the raydium cohort, and every
 *          raydium-attributed push so far (oldest first — [] means none yet).
 *      node scripts/raydium-attribution.js --watch [--minutes N] [--every S]
 *          poll until the FIRST raydium-attributed push appears, then print it
 *          with its dedupe checks. Defaults: N=3 minutes, S=20s. Bounded on
 *          purpose — this is meant to be run in short windows (a terminal that
 *          is killed at its timeout leaves nothing behind), not as a daemon.
 *      node scripts/raydium-attribution.js --window-min 5
 *          the same one-shot with the recent label split narrowed to the last
 *          five minutes — the reading to take just after a deploy on the
 *          attribution path, when the hour-long window still holds pre-fix
 *          rows.
 *      node scripts/raydium-attribution.js --jup-holes [--hours 24] [--gap-min 4]
 *          the MARGINAL DISCOVERY reading: how many mints the raydium leg
 *          caught that the jup leg demonstrably did not. jup's 429 backoff is a
 *          private per-isolate field (JUP_RATE_LIMIT_BACKOFF_MS = 5 min in
 *          src/jupfeeds.ts) and is written NOWHERE durable, so the outage is
 *          read from the DATA: jup's /recent window is ~50s and it serves a
 *          launch seconds after birth, so an outage leaves a ~5-minute hole in
 *          jup-owned BIRTH times while the other legs keep registering. Inside
 *          such a hole jup carried nothing for that tick, so a raydium-owned
 *          mint born there is provably the raydium leg's own catch (the
 *          priority tie that normally hides the loser cannot apply). See the
 *          JUP-HOLE note above `jupHoles` for the full argument and its limits.
 *
 *      node scripts/raydium-attribution.js --overlap
 *          the cross-feed dedupe, measured live: fetch the same LaunchLab page
 *          the tick reads and look every mint up in token_stats. A mint the
 *          page carries that is ALREADY owned by another feed (dex/pump/…) is
 *          the dedupe working — one mint, one owner — while a mint under
 *          `raydium` is the leg's own earlier sighting and an absent mint is
 *          net-new (the next tick's registration). Which leg owns a shared mint
 *          is the merge order's decision, not "first to the mint" (see the
 *          LABEL_SHARE note), so read the overlap counts as "deduped once, by
 *          this leg" rather than as a claim about who saw it first.
 *
 *          It also prints the TIMING half of the same question, because
 *          ownership alone cannot separate "the page had it and another leg got
 *          there first" from "the page did not serve it yet": for every page
 *          mint already in token_stats, `first_seen_at - launch_ms` is the
 *          OWNING leg's own sighting latency (launch_ms is the birth time that
 *          leg wrote — Jupiter's createdAt for a jup row, the page's createAt
 *          for a raydium one), and "page age" is how long ago that mint was
 *          created as of this read. The `birthDelta` line is the clock check
 *          that makes those two numbers comparable: launch_ms minus the page's
 *          own createAt, across the whole page. Measured 2026-10-14: of the
 *          page's newest 100 mints 85 were owned by `jup`, registered a median
 *          15s after birth, and the page's own head row was 6-11 minutes old
 *          and did not advance — i.e. the jup leg sees a LaunchLab launch in
 *          the first half-minute of its life and the page serves it minutes
 *          later.
 *
 *      node scripts/raydium-attribution.js --archive
 *          read the Turso ARCHIVE on purpose, with `source:` saying so; use it
 *          to reproduce a reading taken before the cutover.
 *
 * WHERE THE ROWS COME FROM (2026-10-15). The Worker's store moved from Turso
 * to D1 in the 2026-10-15 cutover (docs/d1-migration-2026-10-15.md): D1 is the
 * live store, and Turso is a READ-ONLY ARCHIVE whose newest row is the cutover.
 * This file used to read Turso unconditionally, which was right before the
 * cutover and silently wrong after it — measured 2026-10-15, a run still
 * answered plausibly, and the frozen data gave itself away only in the shape of
 * the numbers (the hourly birth counts collapse from ~1,400 to single digits at
 * the 09:00Z cutover hour, and the cohort's `last_at` was the cutover minute).
 *
 * So the default is D1, reached the way the migration and the backfill reach it:
 * the same `scripts/d1-rest.js` REST binding handed to src/d1.ts's own
 * `createD1Transport`, so this file runs the SQL production runs (one adapter,
 * one set of rules — including D1's 100-bound-parameter ceiling, which the
 * `--overlap` IN-list is chunked against below). The database is named by
 * `D1_DATABASE_ID`, or resolved BY NAME (`D1_DATABASE_NAME`, default
 * "solana-meme-bot") with one read-only list call — this script never creates a
 * database and never writes a row. The archive stays reachable when no
 * Cloudflare credentials are present, and `--archive` forces it.
 *
 * EVERY RUN PRINTS ITS SOURCE (`source: D1 <uuid>` / `source: Turso archive
 * …`), because the two are indistinguishable otherwise: the same tables come
 * out of either, and only one of them is current.
 */

"use strict";

const { createClient } = require("@libsql/client");
const d1Rest = require("./d1-rest.js");

/** The same aggregate /debug/feed-stats serves, without its TTL cache. */
const ATTRIBUTION = `SELECT COALESCE(t.discovered_via, 'legacy') AS feed,
       COUNT(*) AS coins,
       COUNT(DISTINCT s.token) AS pushed
  FROM token_stats t
  LEFT JOIN seen_tokens s ON s.token = t.token
 GROUP BY feed
 ORDER BY pushed DESC, coins DESC`;

/** The cohort the raydium leg has registered (findings, not yet pushes). */
const COHORT = `SELECT COUNT(*) AS coins,
       datetime(MIN(first_seen_at)/1000,'unixepoch') AS first_at,
       datetime(MAX(first_seen_at)/1000,'unixepoch') AS last_at
  FROM token_stats WHERE discovered_via = 'raydium'`;

/**
 * How close the cohort has come to the chat's mcap floor, from the stored
 * readings alone: `max_mcap_observed` is the high-water mark the pool/eval
 * legs have raised so far (NULL until a pair was ever served for the mint, so
 * NULL here means "no pair yet", not "$0"). This is the reading that tells a
 * feed producing candidates apart from one whose mints die before the band.
 */
const COHORT_QUALITY = `SELECT ROUND(MAX(max_mcap_observed)) AS best_mcap_seen,
       SUM(CASE WHEN max_mcap_observed >= ? THEN 1 ELSE 0 END) AS at_or_above_floor,
       SUM(CASE WHEN max_mcap_observed IS NULL THEN 1 ELSE 0 END) AS never_priced,
       ROUND(AVG(first_seen_age_min),1) AS avg_age_at_discovery_min
  FROM token_stats WHERE discovered_via = 'raydium'`;

/**
 * The catch: every push whose attribution is raydium, oldest first. LIMIT 1 is
 * the first one; the extra rows show whether it stayed alone (a steady leg) or
 * became a trickle, which is the reading that separates "the leg works" from
 * "the leg fired once".
 */
const RAYDIUM_PUSHES = `SELECT datetime(s.first_seen_at/1000,'unixepoch') AS pushed_at,
       s.chat_id, s.token,
       datetime(t.first_seen_at/1000,'unixepoch') AS discovered_at,
       t.discovered_via, t.launch_ms, t.first_seen_age_min,
       t.min_mcap_observed, t.max_mcap_observed
  FROM seen_tokens s JOIN token_stats t ON t.token = s.token
 WHERE t.discovered_via = 'raydium'
 ORDER BY s.first_seen_at`;

/**
 * The dedupe half, for one mint: one claim per chat (a second row is a second
 * card), exactly one attribution owner (a second token_stats row is impossible
 * under the PK, so this catches a wrong join instead), and the same mint seen
 * under any other feed — the direct "was it double-credited" question.
 */
const CLAIMS_FOR = `SELECT chat_id, COUNT(*) AS claims
  FROM seen_tokens WHERE token = ? GROUP BY chat_id`;
const OWNERS_FOR = `SELECT discovered_via, COUNT(*) AS rows
  FROM token_stats WHERE token = ? GROUP BY discovered_via`;

/** One row per (chat, token) is the schema; anything else is a duplicate card. */
const DUPLICATE_CLAIMS = `SELECT token, chat_id, COUNT(*) AS claims
  FROM seen_tokens GROUP BY chat_id, token HAVING COUNT(*) > 1`;

const RAYDIUM_LIST_URL = "https://launch-mint-v1.raydium.io/get/list?sort=new";
const USER_AGENT =
  "solana-meme-bot/1.0 (+https://github.com/KKPATKK/solsolsol)";
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The name the deploy workflow's D1 database carries (see deploy.yml `env`). */
const D1_DATABASE_NAME_FALLBACK = "solana-meme-bot";

/**
 * Most mints one `IN (…)` statement may bind. D1 rejects a statement above 100
 * bound parameters (src/d1.ts's D1_MAX_BOUND_PARAMS), and the LaunchLab page
 * serves exactly its own page size — measured 2026-10-15: 100 rows, i.e. ON the
 * ceiling. Overlap chunks against this so a page that ever grows past 100
 * cannot break the D1 path; on libsql (no such ceiling) the split is a no-op.
 */
const IN_CLAUSE_MAX_PARAMS = 100;

/**
 * Cross-feed priority, as the DATA shows it: every feed's rows, and how many
 * of them are mints whose address ends in `pump` — a pump.fun launch by
 * vanity, which no other launchpad can mint. A feed that owns a large share of
 * them without being the pump.fun leg is the merge order working differently
 * than the comment above `discoveredVia` claims (that one keeps the LAST leg
 * of a shared mint, not the first), so this reading is what makes the label's
 * meaning checkable rather than assumed.
 */
const LABEL_SHARE = `SELECT COALESCE(discovered_via, 'legacy') AS feed,
       COUNT(*) AS coins,
       SUM(CASE WHEN token LIKE '%pump' THEN 1 ELSE 0 END) AS pump_vanity
  FROM token_stats GROUP BY feed ORDER BY coins DESC`;

/**
 * The same split over a recent window (`--window-min`, default 60), where a
 * SAME-TICK steal is visible rather than inferred: the pump.fun leg's own
 * newest-20 page carries every launch from the past hour (measured ~70
 * launches/hour), so a fresh `%pump` mint owned by any other feed was credited
 * by the merge order, not by being first to the mint. The window is a flag
 * because the AFTER-DEPLOY reading wants it short: rows registered since the
 * deploy are the only ones the fix could have written.
 */
const LABEL_SHARE_RECENT = `SELECT COALESCE(discovered_via, 'legacy') AS feed,
       COUNT(*) AS coins,
       SUM(CASE WHEN token LIKE '%pump' THEN 1 ELSE 0 END) AS pump_vanity
  FROM token_stats
 WHERE first_seen_at > (CAST(strftime('%s','now') AS INTEGER) - ?) * 1000
 GROUP BY feed ORDER BY coins DESC`;

/**
 * A jup outage, as the data can see it.
 *
 * JUP-HOLE, the argument. The jup leg's /recent window is ~50s wide (measured
 * 2026-10-14: 30 rows spanning 50s) and it serves a launch a median 15s after
 * birth, so for a NEW LaunchLab/pump.fun launch jup is the highest leg that
 * still catches it in its first half-minute (measured: 85 of the page's newest
 * 100 mints were jup-owned). Its 429 backoff silences the whole leg for 5
 * minutes (JUP_RATE_LIMIT_BACKOFF_MS), and 5 minutes is longer than the 50s
 * window, so every launch born in the first 4min10s of an outage is gone from
 * /recent by the time jup resumes: jup can never own it. The signature the
 * table keeps is therefore a ~5-minute stretch of BIRTH times (launch_ms) with
 * NO jup-owned row at all, while the other legs keep registering — a quiet
 * market fails the second half of that test, which is why `minOther` exists.
 *
 * WHY THE HOLE PROVES THE MARGIN. Outside a hole a raydium-owned mint may or
 * may not also have been carried by jup in the same tick: the priority merge
 * (dex > pump > raydium > … > jup) gives the label to the winner and hides the
 * loser, so "who saw it first" is unreadable. Inside a hole jup carried
 * nothing, so the ambiguity is gone — a raydium-owned mint born there was
 * caught by the raydium leg and not by jup.
 *
 * LIMITS. (1) The backoff is per isolate, so a single isolate's outage leaves a
 * SHALLOW hole (jup rate down, not zero) and this detector — which needs a
 * strict zero — misses it; count the reading as a floor, not a total. (2) A
 * hole is an effect-level inference: it says jup-owned births stopped, not why
 * (a 429 backoff is the only ordinary cause, but a deploy of the jup leg would
 * look identical). (3) token_stats is pruned to the re-eval window, so rows
 * born outside it are already gone; the read is over the retained window only.
 */
const JUP_HOLE_MIN_MS = 4 * 60_000;
const JUP_HOLE_MIN_OTHER = 3;

/**
 * The priority fix's commit time (2026-10-13T23:39:24Z, fe327bc "Feed the
 * attribution map in reverse…"). The era split is load-bearing for THIS
 * reading, because the fix flipped what an owned label MEANS:
 *
 *   - BEFORE it, the map was fed as written, so the LAST duplicate key won and
 *     the label went to the LOWEST-priority carrier. A `raydium` row then meant
 *     "raydium carried it and NO lower leg (…, jup, jupTrend, meteora) did" —
 *     and since a mint's row is written at its FIRST registration, that also
 *     means no earlier tick registered it, i.e. jup never carried it: a
 *     pre-fix raydium row is marginal with respect to jup by construction.
 *   - AFTER it, the first-listed (highest-priority) leg wins, so a `raydium`
 *     row means only that dex and pump missed it — jup may ALSO have carried it
 *     that same tick, and the label hides it. Marginality there has to be
 *     argued from the registration lag (route 2), not from the label alone.
 * The measured switch sits in the 23:00Z hour (jup's birth share 88% → 64% →
 * 15%), consistent with this commit's deploy.
 */
const PRIORITY_FIX_MS = Date.parse("2026-10-13T23:39:24Z");

/**
 * The live cross-feed dedupe reading: the newest LaunchLab mints, and the ONE
 * feed that owns each mint already in token_stats. Anything owned by a feed
 * other than `raydium` is a mint this feed ALSO carries but does not claim —
 * which is the dedupe, not a gap.
 */
async function overlap(client) {
  const res = await fetch(RAYDIUM_LIST_URL, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json();
  const rows = (json && json.data && json.data.rows) || [];
  const mints = rows
    .map((r) => (r && typeof r.mint === "string" ? r.mint.trim() : ""))
    .filter((m) => MINT_RE.test(m));
  if (mints.length === 0) {
    console.log(`### overlap: the page carried no usable mints (HTTP ${res.status})`);
    return;
  }
  // One statement per chunk of at most IN_CLAUSE_MAX_PARAMS mints, rows merged
  // in page order — see that constant for why the split exists at all.
  const chunkRows = [];
  for (let i = 0; i < mints.length; i += IN_CLAUSE_MAX_PARAMS) {
    const chunk = mints.slice(i, i + IN_CLAUSE_MAX_PARAMS);
    const part = await client.execute({
      sql: `SELECT token, discovered_via, first_seen_at, launch_ms FROM token_stats
             WHERE token IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
    chunkRows.push(...part.rows);
  }
  const q = { rows: chunkRows };
  const owned = new Map(q.rows.map((r) => [String(r.token), r]));
  const byFeed = {};
  for (const r of q.rows) {
    const feed = r.discovered_via === null ? "legacy" : String(r.discovered_via);
    byFeed[feed] = (byFeed[feed] || 0) + 1;
  }
  console.log("### overlap");
  console.log(
    JSON.stringify({
      page_rows: rows.length,
      page_mints: mints.length,
      known: q.rows.length,
      net_new: mints.length - q.rows.length,
      owners_of_known: byFeed,
      other_feed_owned: Object.entries(byFeed)
        .filter(([f]) => f !== "raydium")
        .reduce((n, [, c]) => n + c, 0),
    }),
  );
  // The timing half: each owning leg's own sighting latency, and how old the
  // mint already is as the page serves it (see the --overlap note at the top).
  const pageBirth = new Map(rows.map((r) => [String(r.mint).trim(), Number(r.createAt)]));
  const lagByOwner = {};
  for (const r of q.rows) {
    if (r.launch_ms === null || r.first_seen_at === null) continue;
    const feed = r.discovered_via === null ? "legacy" : String(r.discovered_via);
    (lagByOwner[feed] = lagByOwner[feed] || []).push(
      (Number(r.first_seen_at) - Number(r.launch_ms)) / 1000,
    );
  }
  const lagSummary = {};
  for (const feed of Object.keys(lagByOwner)) {
    const v = lagByOwner[feed].sort((a, b) => a - b);
    lagSummary[feed] = {
      n: v.length,
      min_s: Math.round(v[0]),
      p50_s: Math.round(v[Math.floor(v.length / 2)]),
      max_s: Math.round(v[v.length - 1]),
    };
  }
  console.log("### overlap registration lag by owner (first_seen_at - launch_ms, s)");
  console.log(JSON.stringify(lagSummary));
  // The clock check, over the WHOLE page rather than the printed sample: the
  // owning leg's launch_ms versus the page's own createAt for the same mint. A
  // ~0 delta is what lets the lag above be read as "who saw it first" instead
  // of "whose feed timestamps the birth differently".
  const deltaByOwner = {};
  for (const r of q.rows) {
    const born = pageBirth.get(String(r.token));
    if (r.launch_ms === null || !Number.isFinite(born)) continue;
    const feed = r.discovered_via === null ? "legacy" : String(r.discovered_via);
    (deltaByOwner[feed] = deltaByOwner[feed] || []).push(
      (Number(r.launch_ms) - born) / 1000,
    );
  }
  const deltaSummary = {};
  for (const feed of Object.keys(deltaByOwner)) {
    const v = deltaByOwner[feed].sort((a, b) => a - b);
    deltaSummary[feed] = {
      n: v.length,
      min_s: Math.round(v[0]),
      p50_s: Math.round(v[Math.floor(v.length / 2)]),
      max_s: Math.round(v[v.length - 1]),
      max_abs_s: Math.round(Math.max(Math.abs(v[0]), Math.abs(v[v.length - 1]))),
    };
  }
  console.log("### overlap birth clock check by owner (launch_ms - page createAt, s)");
  console.log(JSON.stringify(deltaSummary));
  console.log("");
  for (const m of mints.slice(0, 12)) {
    const r = owned.get(m);
    const born = pageBirth.get(m);
    const pageAgeMin = Number.isFinite(born)
      ? Math.round((Date.now() - born) / 60000)
      : null;
    const lagS =
      r && r.launch_ms !== null && r.first_seen_at !== null
        ? Math.round((Number(r.first_seen_at) - Number(r.launch_ms)) / 1000)
        : null;
    // Clock check, and the reason the lag above is comparable across owners:
    // a row's launch_ms IS the page's createAt for a raydium-owned mint and
    // Jupiter's createdAt for a jup-owned one, so a ~0 delta proves both feeds
    // timestamp the same birth. Measured 2026-10-14 over the whole page: p50 0s,
    // worst |delta| 13s (n=100) — small against the 15s+ lags being compared,
    // and the `birth clock check by owner` line above prints it every run.
    const birthDeltaS =
      r && r.launch_ms !== null && Number.isFinite(born)
        ? Math.round((Number(r.launch_ms) - born) / 1000)
        : null;
    console.log(
      `  ${m.slice(0, 6)}…${m.slice(-4)} ${
        r ? `owned by ${r.discovered_via === null ? "legacy" : r.discovered_via}` : "NEW (net-new)"
      }${pageAgeMin === null ? "" : `  page age ${pageAgeMin}min`}${
        lagS === null ? "" : `  registered ${lagS}s after birth`
      }${birthDeltaS === null ? "" : `  birthDelta ${birthDeltaS}s`}`,
    );
  }
  console.log("");
}

/**
 * The marginal-discovery reading (see the JUP-HOLE note above). Returns the
 * holes found and the raydium-owned mints that fall inside them, so the same
 * split can be printed or asserted on.
 */
async function jupHoles(client, hours, gapMs, minOther) {
  // Bound by BIRTH, not by sighting: token_stats keeps pushed rows forever and
  // the pool re-registers old coins, so a recent first_seen_at can carry a
  // launch_ms months old (an outlier birth would otherwise open a fake hole
  // back to 1970). Only births inside the window are the timeline this reads.
  const since = Date.now() - hours * 3600_000;
  const res = await client.execute({
    sql: `SELECT launch_ms, first_seen_at,
                 COALESCE(discovered_via, 'legacy') AS feed
            FROM token_stats
           WHERE launch_ms IS NOT NULL AND launch_ms > ?
           ORDER BY launch_ms`,
    args: [since],
  });
  const rows = res.rows.map((r) => ({
    birth: Number(r.launch_ms),
    seen: Number(r.first_seen_at),
    feed: String(r.feed),
  }));
  const jupBirths = rows.filter((r) => r.feed === "jup").map((r) => r.birth);
  // Gap census: how dense the jup-owned birth stream is, and how long its
  // longest silences are. This is the reading that says whether a 4-minute
  // threshold sits above the leg's ordinary jitter (it must) and whether any
  // outage-scale gap exists at all in the window.
  const gaps = [];
  for (let i = 1; i < jupBirths.length; i++) {
    gaps.push(jupBirths[i] - jupBirths[i - 1]);
  }
  const census = (ms) => gaps.filter((g) => g >= ms).length;
  const holes = [];
  for (let i = 1; i < jupBirths.length; i++) {
    const from = jupBirths[i - 1];
    const to = jupBirths[i];
    if (to - from < gapMs) continue;
    const inside = rows.filter(
      (r) => r.feed !== "jup" && r.birth > from && r.birth < to,
    );
    if (inside.length < minOther) continue;
    const byFeed = {};
    for (const r of inside) byFeed[r.feed] = (byFeed[r.feed] || 0) + 1;
    holes.push({
      from,
      to,
      ms: to - from,
      other_born: inside.length,
      raydium_born: byFeed.raydium || 0,
      by_feed: byFeed,
    });
  }
  // The widest silences, with what filled them — the reading that separates a
  // true outage (jup flat ZERO while other legs register) from a quiet market
  // (nothing registers at all), and that shows partial per-isolate outages as
  // shorter gaps with normal traffic inside.
  const widest = [];
  for (let i = 1; i < jupBirths.length; i++) {
    const from = jupBirths[i - 1];
    const to = jupBirths[i];
    const inside = rows.filter((r) => r.feed !== "jup" && r.birth > from && r.birth < to);
    const byFeed = {};
    for (const r of inside) byFeed[r.feed] = (byFeed[r.feed] || 0) + 1;
    widest.push({ from, to, ms: to - from, other_born: inside.length, by_feed: byFeed });
  }
  widest.sort((a, b) => b.ms - a.ms);
  const raydium = rows.filter((r) => r.feed === "raydium");
  const inHole = raydium.filter((r) =>
    holes.some((h) => r.birth > h.from && r.birth < h.to),
  );
  return {
    rows,
    holes,
    widest: widest.slice(0, 10),
    raydium,
    inHole,
    jupBirths,
    gapStats: {
      n: gaps.length,
      p50_s: gaps.length ? Math.round(gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] / 1000) : null,
      max_s: gaps.length ? Math.round(Math.max(...gaps) / 1000) : null,
      over_60s: census(60_000),
      over_120s: census(120_000),
      over_240s: census(240_000),
    },
  };
}

function printJupHoles({ rows, holes, widest, raydium, inHole, jupBirths, gapStats }, hours) {
  const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  const hourOf = (ms) => new Date(Math.floor(ms / 3600_000) * 3600_000).toISOString().slice(0, 13);
  // Hourly shape: the jup-owned birth rate per hour is what says whether the
  // 24h window is homogeneous — the 2026-10-13 priority fix moved pump.fun
  // launches from jup's column to pump's, so an average over both sides of it
  // describes neither.
  const byHour = new Map();
  for (const r of rows) {
    const h = hourOf(r.birth);
    const b = byHour.get(h) || { born: 0, jup: 0, raydium: 0 };
    b.born += 1;
    if (r.feed === "jup") b.jup += 1;
    if (r.feed === "raydium") b.raydium += 1;
    byHour.set(h, b);
  }
  console.log(`### jup-owned births per hour (UTC)`);
  for (const h of [...byHour.keys()].sort()) {
    const b = byHour.get(h);
    console.log(
      `  ${h}:00  born ${String(b.born).padStart(5)}  jup ${String(b.jup).padStart(5)}` +
        ` (${((b.jup / b.born) * 100).toFixed(0)}%)  raydium ${b.raydium}`,
    );
  }
  const holeMs = holes.reduce((n, h) => n + h.ms, 0);
  console.log(`### jup-holes (window ${hours}h, jup-owned births ${jupBirths.length})`);
  console.log(
    JSON.stringify({
      rows: rows.length,
      holes: holes.length,
      hole_minutes: Math.round(holeMs / 60000),
      // Sanity: normally jup owns the vast majority of new launches, so this
      // share should be high; it is the reading that says a "hole" is unusual.
      jup_share_of_births: +((jupBirths.length / rows.length) * 100).toFixed(1),
    }),
  );
  console.log(`### jup-owned birth-gap census (s)`);
  console.log(JSON.stringify(gapStats));
  for (const w of widest) {
    console.log(
      `  gap ${iso(w.from)} → ${iso(w.to)}  ${(w.ms / 60000).toFixed(1)}min  ` +
        `other-born ${w.other_born}  ${JSON.stringify(w.by_feed)}`,
    );
  }
  for (const h of holes) {
    console.log(
      `  hole ${iso(h.from)} → ${iso(h.to)}  ` +
        `${(h.ms / 60000).toFixed(1)}min  other-born ${h.other_born} ` +
        `(raydium ${h.raydium_born})  ${JSON.stringify(h.by_feed)}`,
    );
  }
  const inHoleOther = holes.reduce((n, h) => n + h.other_born, 0);
  const inHoleRay = holes.reduce((n, h) => n + h.raydium_born, 0);
  console.log("### raydium-marginal, route 1: owned births inside a jup hole");
  console.log(
    JSON.stringify({
      raydium_cohort: raydium.length,
      raydium_in_hole: inHole.length,
      raydium_out_of_hole: raydium.length - inHole.length,
      // The two shares that make the reading mean something: raydium's share of
      // hole births (where jup contributed nothing) against its share of the
      // whole window. A leg earning its slot on the jup-outage case must be
      // visibly over-represented inside the holes.
      raydium_share_in_hole_pct: inHoleOther
        ? +((inHoleRay / inHoleOther) * 100).toFixed(2)
        : null,
      raydium_share_window_pct: +((raydium.length / rows.length) * 100).toFixed(2),
    }),
  );
  // ROUTE 2, at MINT resolution — the sharper question. jup ticks every ~30s
  // and its /recent carries the newest 30 rows (~50s of births, measured), so a
  // healthy jup carries any new launch within ~birth+80s. A raydium-OWNED mint
  // whose registration lag (first_seen_at - launch_ms) exceeds that bound was
  // therefore missed by every jup tick in the interval — jup was silent, or it
  // does not index the mint. Either way it is the raydium leg's own discovery:
  // the priority tie that normally hides whether jup also carried a raydium-
  // owned mint cannot explain a lag past jup's whole window. This catches the
  // PER-ISOLATE backoff that route 1's fleet-wide zero-gap test cannot see.
  const lagAll = raydium
    .map((r) => ({ birth: r.birth, seen: r.seen, s: Math.round((r.seen - r.birth) / 1000) }))
    .filter((r) => Number.isFinite(r.s))
    .sort((a, b) => a.s - b.s);
  // jup's /recent window (~50s of births, measured) plus a tick or two (~30-60s):
  // past this bound a healthy jup has had every chance to carry the mint, so a
  // raydium row with a lag beyond it is a mint jup did NOT catch.
  const MARGINAL_LAG_S = 80;
  const summarize = (rows) => ({
    n: rows.length,
    p50_s: rows.length ? rows[Math.floor(rows.length / 2)].s : null,
    max_s: rows.length ? rows[rows.length - 1].s : null,
    over_80s: rows.filter((r) => r.s > MARGINAL_LAG_S).length,
    over_120s: rows.filter((r) => r.s > 120).length,
    over_300s: rows.filter((r) => r.s > 300).length,
  });
  const pre = lagAll.filter((r) => r.seen < PRIORITY_FIX_MS);
  const post = lagAll.filter((r) => r.seen >= PRIORITY_FIX_MS);
  console.log("### raydium-marginal, route 2: owned mints past jup's catch window");
  console.log(
    JSON.stringify({
      fix_at: new Date(PRIORITY_FIX_MS).toISOString(),
      all: summarize(lagAll),
      // PRE-fix rows are marginal BY CONSTRUCTION (see PRIORITY_FIX_MS), so this
      // half is the label's own answer; the POST-fix half is the lag argument.
      pre_fix: summarize(pre),
      post_fix: summarize(post),
    }),
  );
  for (const r of post.filter((x) => x.s > MARGINAL_LAG_S)) {
    console.log(`  POST-FIX lag ${String(r.s).padStart(4)}s  born ${iso(r.birth)}  seen ${iso(r.seen)}`);
  }
  for (const r of pre.filter((x) => x.s > 300)) {
    console.log(`  pre-fix lag ${String(r.s).padStart(4)}s  born ${iso(r.birth)}  seen ${iso(r.seen)}`);
  }
  console.log("");
}

async function report(client, mcapFloor, windowMin) {
  const say = (name, rows) => {
    console.log(`### ${name}`);
    if (rows.length === 0) console.log("[]");
    for (const row of rows) console.log(JSON.stringify(row));
    console.log("");
  };
  say("attribution", (await client.execute(ATTRIBUTION)).rows);

  const cohort = (await client.execute(COHORT)).rows;
  say("raydium-cohort", cohort);
  say(
    `raydium-cohort-quality (mcap floor ${mcapFloor})`,
    (await client.execute({ sql: COHORT_QUALITY, args: [mcapFloor] })).rows,
  );
  say("label-share", (await client.execute(LABEL_SHARE)).rows);
  say(
    `label-share-last-${windowMin}min`,
    (
      await client.execute({
        sql: LABEL_SHARE_RECENT,
        args: [windowMin * 60],
      })
    ).rows,
  );

  // Must be []: seen_tokens' PK (chat_id, token) is the duplicate-card guard.
  say("duplicate-claims", (await client.execute(DUPLICATE_CLAIMS)).rows);

  const pushes = (await client.execute(RAYDIUM_PUSHES)).rows;
  say(`raydium-pushes (${pushes.length})`, pushes.slice(0, 10));

  for (const p of pushes.slice(0, 3)) {
    console.log(`### first-push evidence: ${String(p.token)}`);
    const claims = (await client.execute({ sql: CLAIMS_FOR, args: [p.token] })).rows;
    const owners = (await client.execute({ sql: OWNERS_FOR, args: [p.token] })).rows;
    console.log(
      JSON.stringify({
        pushed_at: p.pushed_at,
        attributed_via: p.discovered_via,
        claims_per_chat: claims.map((c) => ({
          chatId: c.chat_id,
          claims: Number(c.claims),
        })),
        attribution_owners: owners.map((o) => ({
          feed: o.discovered_via,
          rows: Number(o.rows),
        })),
        // One owner row = the mint was credited exactly once (the dedupe).
        // WHICH leg owns it is the merge order's call — the first-listed leg as
        // of the 2026-10-13 fix, the last one before it (see the LABEL_SHARE
        // note at the top of this file).
        deduped: owners.length === 1,
      }),
    );
    console.log("");
  }
  return pushes;
}

/**
 * The built Worker's D1 transport (src/d1.ts) over the REST binding
 * (scripts/d1-rest.js) — the same pair the migration and the backfill use, so
 * the SQL here is byte-for-byte the SQL production runs. Loaded lazily: a shell
 * that only wants the archive must not need dist/.
 */
async function openD1Read() {
  let d1;
  try {
    d1 = require("../dist/d1.js");
  } catch (err) {
    throw new Error(
      "D1 reads need the built Worker (dist/d1.js) — run `npm run build` first" +
        ` (${err && err.message ? err.message : err})`,
    );
  }
  const api = d1Rest.createD1Rest({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
  });
  // By id when given, else BY NAME with one read-only list call (no create:
  // `scripts/d1-copy.js ensure` is the only thing allowed to make databases).
  const named = process.env.D1_DATABASE_NAME || D1_DATABASE_NAME_FALLBACK;
  const id =
    process.env.D1_DATABASE_ID ||
    (await api.listDatabases()).find((db) => db.name === named)?.uuid ||
    null;
  if (!id) {
    throw new Error(
      `D1_DATABASE_ID is unset and the account has no database named "${named}"`,
    );
  }
  const transport = d1.createD1Transport(d1Rest.createRestBinding(api, id));
  return {
    kind: `D1 ${id}${process.env.D1_DATABASE_ID ? "" : ` (named "${named}")`}`,
    execute: (stmt) => transport.execute(stmt),
    close: () => transport.close(),
  };
}

/** The pre-cutover store, still readable: rows stop at ~2026-10-15T09:33Z. */
function openArchiveRead() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error(
      "no source: set D1_DATABASE_ID (or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN) to read D1," +
        " or TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) to read the frozen archive",
    );
  }
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return {
    kind: "Turso archive (READ-ONLY — frozen at the 2026-10-15 cutover, newest rows ~09:33Z)",
    execute: (stmt) => client.execute(stmt),
    close: () => client.close(),
  };
}

/** See WHERE THE ROWS COME FROM at the top: D1 by default, archive on demand. */
async function openReadTarget(argv) {
  const forcedArchive = argv.includes("--archive");
  const hasCreds = Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN,
  );
  if (!forcedArchive && (process.env.D1_DATABASE_ID || hasCreds)) {
    try {
      return await openD1Read();
    } catch (err) {
      console.error(`D1 read failed: ${err && err.message ? err.message : err}`);
      // An explicit database id is a decision, not a preference: falling back
      // from it to another store is exactly the silent mix-up this guards.
      if (process.env.D1_DATABASE_ID) process.exit(1);
      console.error("falling back to the frozen Turso archive");
    }
  }
  return openArchiveRead();
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (name, def) => {
    const i = argv.indexOf(name);
    const v = i >= 0 ? Number(argv[i + 1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : def;
  };
  const watch = argv.includes("--watch");
  const minutes = flag("--minutes", 3);
  const everyS = flag("--every", 20);
  // The one enabled chat's floor today (read it from /debug/chats); it only
  // labels the cohort-quality reading, nothing else in here depends on it.
  const mcapFloor = flag("--mcap-floor", 60_000);
  // Window for the recent label-share split, in minutes — see LABEL_SHARE_RECENT.
  const windowMin = flag("--window-min", 60);

  const client = await openReadTarget(argv);
  console.log(`source: ${client.kind}`);
  try {
    if (argv.includes("--jup-holes")) {
      const hours = flag("--hours", 24);
      const gapMs = flag("--gap-min", JUP_HOLE_MIN_MS / 60000) * 60_000;
      const minOther = flag("--min-other", JUP_HOLE_MIN_OTHER);
      printJupHoles(await jupHoles(client, hours, gapMs, minOther), hours);
      return;
    }
    if (!watch) {
      await report(client, mcapFloor, windowMin);
      if (argv.includes("--overlap")) await overlap(client);
      return;
    }
    const deadline = Date.now() + minutes * 60_000;
    let polls = 0;
    for (;;) {
      polls += 1;
      const res = await client.execute(
        `${RAYDIUM_PUSHES} LIMIT 1`,
      );
      const row = res.rows[0];
      const stamp = new Date().toISOString();
      if (row) {
        console.log(`CAUGHT after ${polls} polls (${stamp}):`);
        await report(client, mcapFloor, windowMin);
        return;
      }
      const attribution = (await client.execute(ATTRIBUTION)).rows.find(
        (r) => r.feed === "raydium",
      );
      console.log(
        `${stamp} poll ${polls}: no raydium-attributed push yet ` +
          `(cohort coins ${attribution ? attribution.coins : "?"}, ` +
          `pushed ${attribution ? attribution.pushed : "?"})`,
      );
      if (Date.now() >= deadline) {
        console.log(
          `\nnot caught in ${minutes} minute(s) — rerun, or leave it to the next window`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, everyS * 1000));
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(
    "raydium-attribution failed:",
    err && err.message ? err.message : err,
  );
  process.exit(1);
});
