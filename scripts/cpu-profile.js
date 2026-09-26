/*
 * Where the tick's CPU actually goes.
 *
 * WHY THIS EXISTS: Cloudflare's own analytics names the limit that kills this
 * Worker — `exceededResources` with cpuTime pinned at exactly 10,000us, the
 * Workers Free ceiling, while the same minutes' surviving invocations report
 * 13,000-187,000us (see .github/workflows/cf-invocations.yml). What the
 * platform cannot say is WHICH PART of the tick spends it: there is no
 * phase dimension, and the Worker's own telemetry publishes wall-clock only
 * (feedsMs / poolMs / evalMs / pushPhaseMs), which cannot separate a phase
 * that is slow from a phase that is busy.
 *
 * So the split is measured here instead, off-platform, with:
 *   - the real upstream payloads (fetched live, same endpoints),
 *   - the repo's real parse/map functions from dist/,
 *   - the real re-eval pool read against the production Turso database.
 *
 * `process.cpuUsage()` counts the CPU the PROCESS burned, so a phase measured
 * with it separates "waiting on the network" from "working". Node and workerd
 * are both V8, so the SHARES transfer even though the absolute numbers do not:
 * a phase that is 4% of the CPU here is not the phase to optimise, whatever
 * its wall clock says.
 *
 * READ-ONLY BY CONSTRUCTION, and it has to STAY that way — the reason the
 * numbers below can be taken against the production database at all. Every
 * database call here is a read: `Db.init` (idempotent CREATE ... IF NOT
 * EXISTS plus the batched pragma column probe), `getWorkerState(s)`,
 * `Db.getReevalPool` (three banded SELECTs — the pool gates that WOULD write
 * ride the caller's front batch, and this script passes no front) and one
 * hand-built pragma batch. The feed fetches are plain GETs to public
 * endpoints. Nothing here touches worker_state, so no rotation slot, prune
 * stamp or counter can move because this ran. A "measure the old path" leg
 * that re-attempted the per-column ALTERs was considered and REJECTED for
 * exactly this reason: it would have made a write attempt part of a script
 * whose value is that it can run against production.
 *
 * Run: node scripts/cpu-profile.js      (needs the .env.local Turso creds)
 */
"use strict";

const { loadConfig } = require("../dist/config.js");
const { Db, COLUMN_PROBE_TABLES } = require("../dist/db.js");
const { parseJupTrendTokens } = require("../dist/jupfeeds.js");
const { parseNewPools } = require("../dist/geckoterminal.js");
const { parseMeteoraPools } = require("../dist/meteora.js");
const { parsePumpCoins } = require("../dist/pumpfun.js");

const RE_EVAL_WINDOW_MS = 43 * 3600_000;
const RE_EVAL_AGE_MARGIN_MIN = 30;

/** One row of the report: a phase, its bytes, its wall clock and its CPU. */
const rows = [];

/**
 * `process.cpuUsage(prev)` returns the DELTA since prev; calling it with no
 * argument returns the process's running total. The parameter has to be
 * forwarded here — a wrapper that drops it silently turns every phase reading
 * into a cumulative one, which is exactly the bug this comment exists to keep
 * from coming back.
 */
function cpuNow(prev) {
  return prev === undefined ? process.cpuUsage() : process.cpuUsage(prev);
}

/**
 * Time one phase. `work` may be sync or async; awaiting inside is fine because
 * cpuUsage() only counts CPU, so the await itself is free and the number that
 * comes back is the phase's own work. `bytes` is the payload size in front of
 * it, so the report can show CPU per KB — the shape a Worker budget is spent in.
 */
async function phase(label, bytes, work) {
  const wall0 = Date.now();
  const cpu0 = cpuNow();
  let note = "";
  try {
    const result = await work();
    if (typeof result === "string") note = result;
  } catch (err) {
    note = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
  }
  record(label, bytes, wall0, cpu0, note);
}

/**
 * Run `work` `times` times and keep EVERY reading.
 *
 * One sample cannot tell a per-call cost from a one-time one, and the first
 * call in a process pays for things no tick pays for (module init, the TLS
 * handshake). Repeating is what makes the difference visible: a phase whose
 * FIRST number is large and whose later numbers are small is a cold-start
 * artifact, and the Worker's own cold start is a separate budget line.
 */
async function phaseRepeat(label, bytes, times, work) {
  for (let i = 1; i <= times; i++) {
    const wall0 = Date.now();
    const cpu0 = cpuNow();
    let note = "";
    try {
      const result = await work(i);
      if (typeof result === "string") note = result;
    } catch (err) {
      note = `FAILED: ${err instanceof Error ? err.message : String(err)}`;
    }
    record(`${label} #${i}`, bytes, wall0, cpu0, note);
  }
}

function record(label, bytes, wall0, cpu0, note) {
  // cpuUsage(prev) is the DELTA since prev — passing it here is what makes
  // each row a phase reading rather than the process's running total.
  const cpu = cpuNow(cpu0);
  rows.push({
    label,
    bytes,
    wallMs: Date.now() - wall0,
    cpuMs: (cpu.user + cpu.system) / 1000,
    note,
  });
}

/**
 * Values in a libsql /v2/pipeline reply.
 *
 * The real shape, printed rather than guessed (2026-09-26):
 *   {"results":[{"type":"ok","response":{"type":"execute","result":{
 *      "cols":[{"name":"name","decltype":null}],
 *      "rows":[[{"type":"text","value":"chat_id"}], ...]}}}]}
 * i.e. rows are positional JSON ARRAYS with no row marker, and the column's
 * name appears once in `cols` per statement — never once per row. Two earlier
 * versions of this counter were wrong for exactly those reasons (one counted
 * `"name"` and reported 2 per statement, the next counted a `"type":"row"`
 * marker that does not exist). What a one-column SELECT returns is one
 * tagged `text` value per row, so that is what is counted.
 */
function countPipelineRows(body) {
  return (body.match(/\{\s*"type"\s*:\s*"text"/g) ?? []).length;
}

/** Bytes of a response body without keeping it: the parse is measured separately. */
async function fetchText(url) {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "cpu-profile/1.0" },
  });
  const text = await res.text();
  return { text, status: res.status };
}

/** Wall+CPU of a pure JS function over an already-fetched body. */
async function parsePhase(label, text, fn) {
  await phase(label, Buffer.byteLength(text), async () => {
    const parsed = JSON.parse(text);
    const out = fn(parsed);
    const n = Array.isArray(out) ? out.length : "?";
    return `${n} items`;
  });
}

async function main() {
  const config = loadConfig(process.env);
  const db = new Db(config.tursoUrl, config.tursoAuthToken);
  // `init()` is the same idempotent-DDL batch a cold isolate runs on its first
  // request (18 `CREATE ... IF NOT EXISTS`, one round trip, no data change) and
  // Db.get() refuses to serve a read before it. Calling it here is therefore
  // exactly as invasive as one ordinary tick, and it is what keeps the pool
  // read below on the REAL code path instead of a hand-copied SELECT.

  // Twice: the first call pays whatever is one-time in the process (undici's
  // first TLS, the SQL strings being compiled once), and a tick on a cold
  // isolate is the only place that cost would land anyway. The SECOND call is
  // now the interesting one: since
  // docs/patches/round5-schema-ddl-gate-2026-09-26.apply.js the DDL batch is
  // behind a fingerprint, so #2 is what a recycled isolate actually pays —
  // compare it against #1 to see the gate working.
  await phaseRepeat("front: db.init (cold isolate DDL)", 0, 2, async () => {
    await db.init();
    return "18 DDL statements";
  });

  // THE COLUMN PROBE (2026-09-26). The other half of init's schema work, and
  // the only part of either change that speaks DIFFERENT SQL to the server:
  // one batched pragma read replacing ~12 ALTER attempts (the old
  // addColumnIfMissing asked one column at a time and read "duplicate column
  // name" as the answer). Measured against the production database because a
  // local `file:` client passing is not evidence that Turso's HTTP protocol
  // accepts a bound argument inside a table-valued pragma — if it does not,
  // the read throws, the cache degrades to the old per-column path, and this
  // row is where that shows up (rows 0 / a FAILED note) rather than in
  // production.
  //
  // Sent over the RAW pipeline rather than through the client on purpose: the
  // question is whether TURSO accepts a bound argument inside a table-valued
  // pragma, and going through the client would answer a slightly different one
  // ("does libsql's encoder plus Turso accept it") while hiding the raw reply
  // that says which. db.get() is private and stays untouched.
  await phase("db: column probe (1 raw pipeline, 3 tables)", 0, async () => {
    const httpBase = config.tursoUrl.replace(/^libsql:/, "https:");
    const res = await fetch(`${httpBase}/v2/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.tursoAuthToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requests: COLUMN_PROBE_TABLES.map((table) => ({
          type: "execute",
          // The pipeline's `Value` is an internally tagged enum, so a bare
          // JSON string is rejected: `invalid type: string "chat_settings",
          // expected internally tagged enum Value`. The libsql client encodes
          // this for you, which is exactly why this leg exists — it fails ONCE
          // here, loudly, instead of in production.
          stmt: {
            sql: "SELECT name FROM pragma_table_info(?)",
            args: [{ type: "text", value: table }],
          },
        })),
      }),
    });
    const body = await res.text();
    // ROWS, not `"name"`: the pipeline reply carries the column NAME in its
    // per-request `cols` metadata, so counting that string counts requests
    // (twice over) rather than the columns the pragma found — the mistake this
    // comment exists to stop being made again. A row is the structural marker.
    const columns = countPipelineRows(body);
    if (columns === 0 || /"error"/.test(body)) {
      throw new Error(
        `Turso did not answer the pragma (${columns} row(s), http ` +
          `${res.status}) — the probe would fall back to a round trip per ` +
          `column, see readColumnNames in src/db.ts: ${body.slice(0, 160)}`,
      );
    }
    return `${columns} columns, ${body.length} B`;
  });

  // The CONTROL for the leg above, and it is not optional: a bound argument in
  // a table-valued pragma is a narrower shape than the same pragma given a
  // LITERAL, and this schema's answer must be the full column list, not merely
  // "no error". A bound probe that returns too FEW columns is the quiet
  // failure — every missing column becomes an ALTER attempt again, so the
  // round trips come back with nothing to show for it. Counted the same way
  // (the literal's own reply, over the same wire) so the two numbers are
  // directly comparable: they must MATCH.
  await phase("db: pragma, literal arg (control)", 0, async () => {
    const httpBase = config.tursoUrl.replace(/^libsql:/, "https:");
    const res = await fetch(`${httpBase}/v2/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.tursoAuthToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requests: COLUMN_PROBE_TABLES.map((table) => ({
          type: "execute",
          stmt: {
            sql: `SELECT name FROM pragma_table_info('${table}')`,
            args: [],
          },
        })),
      }),
    });
    const body = await res.text();
    const columns = countPipelineRows(body);
    if (columns === 0) {
      throw new Error(`the literal form found nothing either: ${body.slice(0, 160)}`);
    }
    return `${columns} columns (compare with the row above)`;
  });

  // The per-CALL overhead of a libsql round trip, which is what a tick pays
  // 15-20 times (gate reads, claim, pool, token_stats, seen_tokens, deferral
  // sync, the tracker pass's own trips, the flush). A single row makes the
  // row cost vanish, so whatever is left is the fixed price of a round trip —
  // and if that number is milliseconds rather than microseconds, the COUNT of
  // round trips is a bigger CPU lever than anything inside them.
  await phaseRepeat("db: 1 round trip, 1 row (getWorkerState)", 0, 5, async () => {
    const v = await db.getWorkerState("scan_wedge");
    return v === null ? "null (absent)" : `${String(v).length} B`;
  });
  await phaseRepeat(
    "db: 1 round trip, 6 keys (getWorkerStates)",
    0,
    5,
    async () => {
      const m = await db.getWorkerStates([
        "scan_heartbeat",
        "scheduled_tick_total",
        "scheduled_tick_ring",
        "outage_alert_at",
        "tick_progress",
        "scan_wedge",
      ]);
      return `${m.size} keys`;
    },
  );

  // ---------- the feed payloads the tick actually parses ----------
  const dex = "https://api.dexscreener.com";
  const profiles = await fetchText(`${dex}/token-profiles/latest/v1`);
  const boosts = await fetchText(`${dex}/token-boosts/latest/v1`);

  // A 30-address pair batch: the real shape of the tick's pair phase, with the
  // addresses coming from the profiles feed the tick would have used.
  let pairAddrs = [];
  try {
    pairAddrs = JSON.parse(profiles.text)
      .filter((p) => p.chainId === "solana")
      .slice(0, 30)
      .map((p) => p.tokenAddress);
  } catch {
    /* the parse phase below reports a broken body for us */
  }
  const pairs =
    pairAddrs.length > 0
      ? await fetchText(`${dex}/latest/dex/tokens/${pairAddrs.join(",")}`)
      : { text: "[]", status: 0 };

  // The same path the trending leg reads (see JupTokensClient.fetchTrendingTokens).
  const jupTrend = await fetchText(
    "https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100",
  );
  const gecko = await fetchText(
    "https://api.geckoterminal.com/api/v2/networks/solana/new_pools",
  );
  const meteora = await fetchText(
    "https://damm-v2.datapi.meteora.ag/pools?sort_by=pool_created_at:desc&limit=20",
  );
  const pump = await fetchText(
    "https://frontend-api-v3.pump.fun/coins?offset=0&limit=20&sort=created_timestamp&order=DESC",
  );

  // ---------- phase by phase ----------
  await parsePhase("feeds: dex profiles parse", profiles.text, (v) =>
    Array.isArray(v) ? v : [],
  );
  await parsePhase("feeds: dex boosts parse", boosts.text, (v) =>
    Array.isArray(v) ? v : [],
  );
  await parsePhase("feeds: dex pair batch parse", pairs.text, (v) => v.pairs ?? []);
  await parsePhase("feeds: jup trending parse", jupTrend.text, (v) =>
    parseJupTrendTokens(v),
  );
  await parsePhase("feeds: gecko new_pools parse", gecko.text, (v) =>
    parseNewPools(v),
  );
  await parsePhase("feeds: meteora pools parse", meteora.text, (v) =>
    parseMeteoraPools(v),
  );
  await parsePhase("feeds: pump.fun coins parse", pump.text, (v) =>
    parsePumpCoins(v),
  );

  // ---------- the re-eval pool read (production, read-only) ----------
  const chats = await db.listEnabledChats();
  if (chats.length === 0) {
    rows.push({
      label: "pool: SKIPPED (no enabled chats)",
      bytes: 0,
      wallMs: 0,
      cpuMs: 0,
      note: "",
    });
  } else {
    const poolMinAgeMin = Math.min(...chats.map((c) => c.minAgeMinutes));
    const poolMaxAgeMin = Math.max(...chats.map((c) => c.maxAgeMinutes));
    const poolMinMcapUsd = Math.min(...chats.map((c) => c.minMarketCapUsd));
    const poolMaxMcapUsd = Math.max(...chats.map((c) => c.maxMarketCapUsd));
    const poolMinLiquidityUsd = Math.min(...chats.map((c) => c.minLiquidityUsd));
    const now = Date.now();
    const args = {
      sinceMs: now - RE_EVAL_WINDOW_MS,
      minLaunchMs: now - (poolMaxAgeMin + RE_EVAL_AGE_MARGIN_MIN) * 60_000,
      maxLaunchMs: now - (poolMinAgeMin - RE_EVAL_AGE_MARGIN_MIN) * 60_000,
      windowEntryLaunchMs: now - poolMinAgeMin * 60_000,
      limit: config.reevalPoolSize,
      nearSlots: config.reevalNearSlots,
      farSlots: config.reevalFarSlots,
      rotationPeriodMs: config.reevalPoolCacheMs,
      minQualifyMcap: poolMinMcapUsd * 0.6,
      maxQualifyMcap: poolMaxMcapUsd * 2,
      minQualifyLiquidity: poolMinLiquidityUsd * 0.6,
      now,
    };
    // Three readings of the SAME query at the configured size: #1 pays the
    // cold start, #2 and #3 are what a warm tick pays. Wall clock is dominated
    // by the network; the CPU column is the part a Workers budget is spent on.
    await phaseRepeat("pool: getReevalPool (configured size)", 0, 3, async () => {
      const out = await db.getReevalPool(args);
      return `${out.length} rows`;
    });

    // Row-count scaling — the point of the whole exercise. If CPU tracks the
    // row count, the configured pool size IS the CPU knob and it is a single
    // number in wrangler.toml; if CPU stays flat, the cost is per-CALL (client
    // setup, statement planning) and shrinking the slice buys nothing.
    for (const shrunk of [Math.max(20, Math.round(config.reevalPoolSize / 4)), 100]) {
      if (shrunk >= config.reevalPoolSize) continue;
      await phase(`pool: getReevalPool (limit ${shrunk})`, 0, async () => {
        const out = await db.getReevalPool({ ...args, limit: shrunk });
        return `${out.length} rows`;
      });
    }

    // Control: the SAME rows over the SAME libsql HTTP endpoint, bypassing the
    // client's own decoder. libsql speaks a JSON pipeline over HTTP, so this
    // splits "the wire" from "the client": everything the control does (send,
    // receive, JSON.parse) is work the client also has to do, and whatever the
    // two readings differ by is the client's own overhead — the part that
    // cannot be bought back by shrinking the query.
    const httpBase = config.tursoUrl.replace(/^libsql:/, "https:");
    const controlSql =
      "SELECT token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, " +
      "birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, " +
      "birdeye_sniper_pct, min_mcap_observed, max_mcap_observed, supply_flow, " +
      "supply_flow_at, discovered_via FROM token_stats " +
      "ORDER BY max_mcap_observed DESC LIMIT 405";
    await phase("control: raw fetch of 405 pool-shaped rows", 0, async () => {
      const res = await fetch(`${httpBase}/v2/pipeline`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.tursoAuthToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requests: [{ type: "execute", stmt: { sql: controlSql, args: [] } }],
        }),
      });
      return `${(await res.text()).length} B body`;
    });
  }

  // ---------- report ----------
  const totalCpu = rows.reduce((n, r) => n + r.cpuMs, 0);
  const worst = rows.reduce((b, r) => (r.cpuMs > (b?.cpuMs ?? -1) ? r : b), null);

  console.log("");
  console.log("phase                                   bytes      wall ms   cpu ms   cpu/KB");
  console.log("-------------------------------------------------------------------------------");
  for (const r of rows) {
    const kb = r.bytes / 1024;
    console.log(
      `${r.label.padEnd(39)} ${String(r.bytes).padStart(7)}  ` +
        `${String(r.wallMs).padStart(7)}  ${r.cpuMs.toFixed(2).padStart(6)}  ` +
        `${(kb > 0 ? r.cpuMs / kb : 0).toFixed(3).padStart(6)}  ${r.note}`,
    );
  }
  console.log("-------------------------------------------------------------------------------");
  console.log(
    `total measured CPU ${totalCpu.toFixed(2)} ms over ` +
      `${rows.length} phases; biggest single phase: ${worst?.label} ` +
      `(${worst?.cpuMs.toFixed(2)} ms)`,
  );
  console.log("");
  console.log(
    `Workers Free allows 10 ms of CPU per invocation, so compare each row ` +
      `against that, not against the tick's wall clock. Rows whose wall clock ` +
      `is large and CPU small are waiting, not working — no optimisation there ` +
      `saves any budget.`,
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("cpu-profile failed:", err);
    process.exit(1);
  },
);
