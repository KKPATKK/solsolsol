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
 */

"use strict";

const { createClient } = require("@libsql/client");

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
  const q = await client.execute({
    sql: `SELECT token, discovered_via, first_seen_at FROM token_stats
           WHERE token IN (${mints.map(() => "?").join(",")})`,
    args: mints,
  });
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
  for (const m of mints.slice(0, 12)) {
    const r = owned.get(m);
    console.log(
      `  ${m.slice(0, 6)}…${m.slice(-4)} ${
        r ? `owned by ${r.discovered_via === null ? "legacy" : r.discovered_via}` : "NEW (net-new)"
      }`,
    );
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

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) {
    console.error(
      "TURSO_DATABASE_URL is not set in this shell's environment (.env.local is loaded automatically)",
    );
    process.exit(1);
  }
  const client = createClient({ url, authToken });
  try {
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
