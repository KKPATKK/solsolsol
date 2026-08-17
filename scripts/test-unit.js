/*
 * Offline unit tests — no network, no secrets. Run with `npm run test:unit`
 * (after `npm run build`). Db tests run against a real local SQLite via the
 * libsql `file:` transport (injected client), so the SQL/migration/query
 * logic is exercised exactly as it runs in production.
 */
const assert = require("node:assert/strict");
const { createClient } = require("@libsql/client");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Db, DEFAULT_SETTINGS } = require("../dist/db.js");
const { parseFilterArgs } = require("../dist/bot.js");
const { parseAdminIds, isAdmin, parseSmartMoneyTypes } = require("../dist/config.js");
const { detectSupplyFlow, selectTopAccounts } = require("../dist/helius.js");
const { tradeDecision, resolveTradeMode, parseQuote, parseSendResponse, buyAmountLamports, parseSellCallback, sellAmountRaw, parseModeCallback, nextTradeMode } = require("../dist/jupiter.js");
const { parsePumpCoins } = require("../dist/pumpfun.js");
const { parseNewPools, GeckoTerminalClient } = require("../dist/geckoterminal.js");
const { parseTrending, parseTokenInfo } = require("../dist/gmgn.js");
const { parseTokenOverview } = require("../dist/birdeye.js");
const { parseAxiomTrending, AxiomClient } = require("../dist/axiom.js");
const { parseArkhamHolders, isSmartMoneyType } = require("../dist/arkham.js");
const { tradeFingerprint } = require("../dist/worker.js");

let passed = 0;
let failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ ${name}: ${err.message}`);
  }
}

function tmpDb() {
  const p = path.join(os.tmpdir(), `unit-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const client = createClient({ url: `file:${p}` });
  return { p, client, cleanup: async () => { await client.close(); try { fs.unlinkSync(p); } catch {} } };
}

async function main() {
  // ---------- db.ts ----------

  await test("db.init creates all tables and is idempotent", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.init(); // second init must not throw (IF NOT EXISTS / guarded migrations)
      const r = await t.client.execute("SELECT name FROM sqlite_master WHERE type = 'table'");
      const names = r.rows.map((row) => row.name);
      for (const table of ["chat_settings", "worker_state", "seen_tokens", "token_stats", "scan_history", "trade_log"]) {
        assert.ok(names.includes(table), `missing table ${table}`);
      }
    } finally {
      await t.cleanup();
    }
  });

  await test("DEFAULT_SETTINGS match the operator's filter spec", () => {
    assert.equal(DEFAULT_SETTINGS.minMarketCapUsd, 40000);
    assert.equal(DEFAULT_SETTINGS.maxMarketCapUsd, 300000);
    assert.equal(DEFAULT_SETTINGS.minAgeMinutes, 300);
    assert.equal(DEFAULT_SETTINGS.maxAgeMinutes, 1680);
    assert.equal(DEFAULT_SETTINGS.min5mVolUsd, 6000);
    assert.equal(DEFAULT_SETTINGS.min5mChgPct, 30);
    // Bundler/top-10 filters were removed — no thresholds in defaults.
    assert.equal("maxBundlerPct" in DEFAULT_SETTINGS, false);
    assert.equal("maxTop10HolderPct" in DEFAULT_SETTINGS, false);
  });

  await test("getChatSettings maps NULL columns to defaults; save round-trips", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // Row with NULL filter columns → mapRow must fall back to defaults.
      await t.client.execute(
        "INSERT INTO chat_settings (chat_id, min_liquidity_usd, min_volume_24h_usd, enabled) VALUES ('chat-defaults', 0, 0, 1)",
      );
      const d = await db.getChatSettings("chat-defaults");
      assert.equal(d.minMarketCapUsd, 40000);
      assert.equal(d.maxMarketCapUsd, 300000);
      assert.equal(d.minAgeMinutes, 300);
      assert.equal(d.maxAgeMinutes, 1680);
      assert.equal(d.min5mVolUsd, 6000);
      assert.equal(d.min5mChgPct, 30);
      assert.equal(d.enabled, true);

      // Full customized round-trip.
      await db.saveChatSettings({
        chatId: "chat-a",
        minLiquidityUsd: 1,
        minVolume24hUsd: 2,
        minMarketCapUsd: 123,
        maxMarketCapUsd: 456,
        minAgeMinutes: 60,
        maxAgeMinutes: 500,
        min5mVolUsd: 789,
        min5mChgPct: 12,
        enabled: true,
      });
      const got = await db.getChatSettings("chat-a");
      assert.deepEqual(got, {
        chatId: "chat-a",
        minLiquidityUsd: 1,
        minVolume24hUsd: 2,
        minMarketCapUsd: 123,
        maxMarketCapUsd: 456,
        minAgeMinutes: 60,
        maxAgeMinutes: 500,
        min5mVolUsd: 789,
        min5mChgPct: 12,
        enabled: true,
      });
    } finally {
      await t.cleanup();
    }
  });

  await test("listAllChats returns every chat incl. disabled; listEnabledChats only enabled", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.saveChatSettings({
        chatId: "chat-on",
        minLiquidityUsd: 0,
        minVolume24hUsd: 0,
        minMarketCapUsd: 40000,
        maxMarketCapUsd: 300000,
        minAgeMinutes: 300,
        maxAgeMinutes: 1680,
        min5mVolUsd: 6000,
        min5mChgPct: 30,
        enabled: true,
      });
      await db.saveChatSettings({
        chatId: "chat-off",
        minLiquidityUsd: 0,
        minVolume24hUsd: 0,
        minMarketCapUsd: 1000,
        maxMarketCapUsd: 50000,
        minAgeMinutes: 60,
        maxAgeMinutes: 720,
        min5mVolUsd: 100,
        min5mChgPct: 5,
        enabled: false,
      });
      const all = await db.listAllChats();
      assert.deepEqual(
        all.map((c) => c.chatId),
        ["chat-off", "chat-on"],
        "all chats returned regardless of push state, ordered by chat_id",
      );
      const on = all.find((c) => c.chatId === "chat-on");
      assert.ok(on, "chat-on present");
      assert.equal(on.maxAgeMinutes, 1680);
      assert.equal(on.enabled, true);
      const off = all.find((c) => c.chatId === "chat-off");
      assert.ok(off, "chat-off present");
      assert.equal(off.maxAgeMinutes, 720);
      assert.equal(off.enabled, false);
      const enabledOnly = await db.listEnabledChats();
      assert.deepEqual(
        enabledOnly.map((c) => c.chatId),
        ["chat-on"],
        "disabled chat excluded from listEnabledChats",
      );
    } finally {
      await t.cleanup();
    }
  });

  await test("settings_v2 migration rewrites legacy rows once, never clobbers later changes", async () => {
    const t = tmpDb();
    try {
      // Pre-create the legacy schema shape with old filter values.
      await t.client.execute(
        `CREATE TABLE chat_settings (
          chat_id TEXT PRIMARY KEY,
          min_liquidity_usd REAL NOT NULL DEFAULT 0,
          min_volume_24h_usd REAL NOT NULL DEFAULT 0,
          min_market_cap_usd REAL NOT NULL DEFAULT 10000,
          max_market_cap_usd REAL NOT NULL DEFAULT 1000000,
          min_age_minutes REAL NOT NULL DEFAULT 6.3,
          max_age_minutes REAL NOT NULL DEFAULT 100000,
          min_5m_vol_usd REAL NOT NULL DEFAULT 1800,
          min_5m_chg_pct REAL NOT NULL DEFAULT 18,
          max_bundler_pct REAL NOT NULL DEFAULT 24,
          max_top10_holder_pct REAL NOT NULL DEFAULT 27,
          enabled INTEGER NOT NULL DEFAULT 0
        )`,
      );
      await t.client.execute(
        "CREATE TABLE worker_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      await t.client.execute(
        "INSERT INTO chat_settings (chat_id, min_market_cap_usd, max_market_cap_usd, min_age_minutes, max_age_minutes, min_5m_vol_usd, min_5m_chg_pct, max_bundler_pct, max_top10_holder_pct, enabled) VALUES ('legacy-chat', 10000, 1000000, 6.3, 100000, 1800, 18, 24, 27, 1)",
      );

      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const s = await db.getChatSettings("legacy-chat");
      assert.equal(s.minMarketCapUsd, 40000);
      assert.equal(s.maxMarketCapUsd, 300000);
      assert.equal(s.minAgeMinutes, 300);
      assert.equal(s.maxAgeMinutes, 1680);
      assert.equal(s.min5mVolUsd, 6000);
      assert.equal(s.min5mChgPct, 30);
      assert.equal(s.enabled, true); // push state untouched by migration
      assert.equal(await db.getWorkerState("settings_v2_applied"), "1");

      // Customize after migration; a fresh init must NOT re-apply defaults.
      await db.saveChatSettings({ ...s, min5mChgPct: 77 });
      const db2 = new Db(t.p, undefined, t.client);
      await db2.init();
      assert.equal((await db2.getChatSettings("legacy-chat")).min5mChgPct, 77);
    } finally {
      await t.cleanup();
    }
  });

  await test("getTokenPushedInfo reports never-pushed and first-push time", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const unknown = await db.getTokenPushedInfo("NEVER");
      assert.deepEqual(unknown, { pushed: false });
      // Two pushes across chats: earliest first_seen_at wins.
      const early = Date.now() - 60_000;
      const late = Date.now();
      await t.client.execute({
        sql: "INSERT INTO seen_tokens (chat_id, token, first_seen_at) VALUES ('chat-b', 'TOK-PUSHED', ?)",
        args: [late],
      });
      await t.client.execute({
        sql: "INSERT INTO seen_tokens (chat_id, token, first_seen_at) VALUES ('chat-a', 'TOK-PUSHED', ?)",
        args: [early],
      });
      const info = await db.getTokenPushedInfo("TOK-PUSHED");
      assert.equal(info.pushed, true);
      assert.equal(info.at, early);
    } finally {
      await t.cleanup();
    }
  });

  await test("listEnabledChats returns only enabled chats", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const mk = (chatId, enabled) => ({
        chatId, minLiquidityUsd: 0, minVolume24hUsd: 0,
        minMarketCapUsd: 1, maxMarketCapUsd: 2, minAgeMinutes: 3, maxAgeMinutes: 4,
        min5mVolUsd: 5, min5mChgPct: 6,
        enabled,
      });
      await db.saveChatSettings(mk("on", true));
      await db.saveChatSettings(mk("off", false));
      const enabled = await db.listEnabledChats();
      assert.deepEqual(enabled.map((c) => c.chatId), ["on"]);
    } finally {
      await t.cleanup();
    }
  });

  await test("getReevalPool: hot zone every scan + tiered near/far rotation", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const H = 3600e3;
      const M = 60e3;
      const seed = async (token, firstSeenAt, ageMin, seen = false, atNow) => {
        await t.client.execute({
          sql: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed) VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
          // launch_ms = first_seen_at - age_min * 60s (same estimate the
          // production migration backfills into legacy rows).
          args: [token, firstSeenAt, ageMin, firstSeenAt - ageMin * 60e3],
        });
        if (seen) {
          await t.client.execute({
            sql: "INSERT INTO seen_tokens (chat_id, token, first_seen_at) VALUES ('chat-x', ?, ?)",
            args: [token, atNow],
          });
        }
      };
      // Pin `now` = 50 × 5 min → slot counter 50. Default tiers: hot zone
      // ages 5h–6.5h (every scan); NEAR zone ages 6.5h–12h in 2 slots (slot
      // 0 = 6.5–9.25h, slot 1 = 9.25–12h, full sweep every 2 scans = 10
      // min); FAR zone ages 12h–43h in 6 slots (slot 2 = 22.3–27.5h, full
      // sweep every 6 scans = 30 min).
      const now = 50 * 300e3;
      // HOT: age 6h — hot zone, evaluated every scan
      await seed("HOT", now - 6 * H, 0);
      // NEAR0 / NEAR1: ages 8h / 11h — near slots 0 / 1
      await seed("NEAR0", now - 8 * H, 0);
      await seed("NEAR1", now - 11 * H, 0);
      // FAR: age 25h — far slot 2 (50 % 6 = 2)
      await seed("FAR", now - 25 * H, 0);
      // YOUNG: age 2.5h — below the hot zone, not evaluated until it ages in
      await seed("YOUNG", now - 150 * M, 0);
      // SEEN: age 10h but already pushed → excluded
      await seed("SEEN", now - 10 * H, 0, true, now);
      // OLD: first seen 50h ago → dropped by sinceMs (30h)
      await seed("OLD", now - 50 * H, 0);

      const opts = (nn) => ({
        sinceMs: now - 42 * H,
        minLaunchMs: now - (2400 + 180) * M,
        maxLaunchMs: now - (360 - 180) * M,
        windowEntryLaunchMs: now - 360 * M,
        limit: 1000,
        now: nn,
      });

      // Scan 0 (slot 50): near slot 0 + far slot 14 active.
      const t0 = (await db.getReevalPool(opts(now))).map((x) => x.token);
      assert.equal(t0[0], "HOT", "hot zone is evaluated first (band order)");
      assert.ok(t0.includes("HOT"), "hot zone coin present");
      assert.ok(t0.includes("NEAR0"), "near slot 0 active at scan 0");
      assert.ok(!t0.includes("NEAR1"), "near slot 1 not active at scan 0");
      assert.ok(t0.includes("FAR"), "far slot 2 active at scan 0");
      assert.ok(!t0.includes("YOUNG"), "too-young coin must not be evaluated");
      assert.ok(!t0.includes("SEEN"), "already-pushed coin excluded");
      assert.ok(!t0.includes("OLD"), "too-old coin dropped by sinceMs");

      // Scan 1 (slot 51): near slot 1 active, far slot 15 active.
      const t1 = (await db.getReevalPool(opts(now + 300e3))).map((x) => x.token);
      assert.ok(t1.includes("HOT"), "hot zone every scan");
      assert.ok(t1.includes("NEAR1"), "near slot 1 active at scan 1");
      assert.ok(!t1.includes("NEAR0"), "near slot 0 not active at scan 1");
      assert.ok(!t1.includes("FAR"), "far slot 3 active at scan 1, not slot 2");

      // Full-sweep properties: NEAR fully covered within 2 scans (10 min),
      // FAR within 6 scans (30 min), hot every scan.
      let hotSeen = 0;
      let near0 = 0;
      let near1 = 0;
      const farScans = [];
      for (let s = 0; s < 18; s++) {
        const pool = await db.getReevalPool(opts(now + s * 300e3));
        const tokens = pool.map((x) => x.token);
        if (tokens.includes("HOT")) hotSeen++;
        if (tokens.includes("NEAR0")) near0++;
        if (tokens.includes("NEAR1")) near1++;
        if (tokens.includes("FAR")) farScans.push(s);
      }
      assert.equal(hotSeen, 18, "hot zone evaluated every scan");
      assert.ok(
        near0 >= 8 && near1 >= 8,
        `near zone fully swept every 2 scans (near0=${near0}, near1=${near1})`,
      );
      assert.deepEqual(
        farScans,
        [0, 6, 12],
        "far coin re-checked exactly once per 30-min sweep (slot 2 active at scans 0, 6, 12)",
      );
    } finally {
      await t.cleanup();
    }
  });

  await test("getReevalPool: pre-filter drops hopeless coins, rotation orders by mcap signal", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const H = 3600e3;
      const M = 60e3;
      const seed = async (token, firstSeenAt, ageMin, mcapObserved) => {
        await t.client.execute({
          sql: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed, max_mcap_observed) VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)",
          args: [
            token,
            firstSeenAt,
            ageMin,
            firstSeenAt - ageMin * 60e3,
            mcapObserved,
          ],
        });
      };
      // Same far slot (age 25h → slot 2 at now=50×5min), differing mcap
      // history: FAR_HIGH 35K (above half-gate), FAR_LOW 3K (hopeless), and
      // FAR_NULL NULL (never seen with pair data yet). Hot coin with NULL.
      const now = 50 * 300e3;
      await seed("HOT", now - 6 * H, 0, null);
      await seed("FAR_HIGH", now - 25 * H, 0, 35000);
      await seed("FAR_LOW", now - 25 * H, 0, 3000);
      await seed("FAR_NULL", now - 25 * H, 0, null);

      const pool = await db.getReevalPool({
        sinceMs: now - 42 * H,
        minLaunchMs: now - (2400 + 180) * M,
        maxLaunchMs: now - (360 - 180) * M,
        windowEntryLaunchMs: now - 360 * M,
        limit: 1000,
        minQualifyMcap: 20000,
        now,
      });
      const tokens = pool.map((x) => x.token);
      assert.ok(tokens.includes("HOT"), "hot zone coin with NULL history is kept");
      assert.ok(
        tokens.includes("FAR_HIGH"),
        "coin above the pre-qualification floor is kept",
      );
      assert.ok(
        tokens.includes("FAR_NULL"),
        "coin with no mcap history yet (NULL) is kept — not yet seen with pair data",
      );
      assert.ok(
        !tokens.includes("FAR_LOW"),
        "coin repeatedly seen far below the gate is dropped from the pool",
      );
      // Rotation bands order by qualification signal: the known-promising
      // coin is ranked before the unknown (NULL) one, so a dense band's
      // LIMIT picks it instead of an arbitrary band-edge coin.
      assert.ok(
        tokens.indexOf("FAR_HIGH") < tokens.indexOf("FAR_NULL"),
        "signal ordering: known high-mcap coin before unknown (NULL)",
      );
    } finally {
      await t.cleanup();
    }
  });

  await test("getTokenStatsMany / recordTokenStatsMany batch and dedupe", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const now = Date.now();
      const mk = (token, m5vol, extra = {}) => ({
        token,
        firstSeenAt: now,
        firstM5Vol: m5vol,
        firstSeenAgeMin: 2,
        launchMs: now - 2 * 60e3,
        birdeye1mVol: null,
        rugcheckBundlerPct: null,
        rugcheckTop10Pct: null,
        birdeyeProTraders: null,
        birdeyeSniperPct: null,
        minMcapObserved: null,
        ...extra,
      });
      await db.recordTokenStatsMany([
        mk("T1", 111),
        mk("T2", 222, { birdeye1mVol: 555, rugcheckBundlerPct: 12.5, rugcheckTop10Pct: 20.1, birdeyeProTraders: 4, birdeyeSniperPct: 1.5, minMcapObserved: 9000 }),
        mk("T1", 999), // duplicate token → INSERT OR IGNORE keeps the first row
      ]);
      const map = await db.getTokenStatsMany(["T1", "T2", "T3"]);
      assert.equal(map.size, 2);
      assert.equal(map.get("T1").firstM5Vol, 111);
      assert.equal(map.get("T2").birdeye1mVol, 555);
      assert.equal(map.get("T2").rugcheckBundlerPct, 12.5);
      assert.equal(map.get("T2").birdeyeProTraders, 4);
      // Empty batch calls are no-ops.
      await db.recordTokenStatsMany([]);
      assert.equal((await db.getTokenStatsMany([])).size, 0);
    } finally {
      await t.cleanup();
    }
  });

  await test("pruneOldTokenStats drops stale unseen rows, keeps pushed", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const old = Date.now() - 60 * 60_000;
      const mk = (token, firstSeenAt) => ({
        token,
        firstSeenAt,
        firstM5Vol: 0,
        firstSeenAgeMin: 0,
        launchMs: firstSeenAt,
        birdeye1mVol: null,
        rugcheckBundlerPct: null,
        rugcheckTop10Pct: null,
        birdeyeProTraders: null,
        birdeyeSniperPct: null,
        minMcapObserved: null,
      });
      await db.recordTokenStatsMany([
        mk("OLD-UNSEEN", old), // older than cutoff, never pushed → pruned
        mk("OLD-PUSHED", old), // older than cutoff but pushed → kept
        mk("NEW-UNSEEN", Date.now()), // fresh → kept
      ]);
      await db.markTokenSeen("chat1", "OLD-PUSHED");
      await db.pruneOldTokenStats(Date.now() - 42 * 60_000);
      const map = await db.getTokenStatsMany(["OLD-UNSEEN", "OLD-PUSHED", "NEW-UNSEEN"]);
      assert.equal(map.has("OLD-UNSEEN"), false);
      assert.equal(map.has("OLD-PUSHED"), true);
      assert.equal(map.has("NEW-UNSEEN"), true);
    } finally {
      await t.cleanup();
    }
  });

  await test("parsePumpCoins maps mints and timestamps, drops junk", () => {
    const out = parsePumpCoins([
      { mint: "MINT1", name: "Alpha", symbol: "ALPHA", created_timestamp: 1710000000000 },
      { mint: "   ", name: "junk" },
      { mint: 123 },
      null,
      { mint: "MINT2", created_timestamp: 0 },
      "string",
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].tokenAddress, "MINT1");
    assert.equal(out[0].name, "Alpha");
    assert.equal(out[0].symbol, "ALPHA");
    assert.equal(out[0].openTimestamp, 1710000000000);
    assert.equal(out[1].tokenAddress, "MINT2");
    assert.equal(out[1].openTimestamp, undefined);
    assert.deepEqual(parsePumpCoins({ not: "array" }), []);
    assert.deepEqual(parsePumpCoins(null), []);
  });

  await test("parseNewPools maps the real GeckoTerminal new_pools shape", () => {
    const out = parseNewPools({
      data: [
        {
          id: "solana_DMSXzfSJErEF1SRfuBedBL8guseidMhG4Dve2fBUxKPC",
          attributes: {
            name: "DOGE2 / SOL",
            pool_created_at: "2026-08-14T03:38:19",
            reserve_in_usd: "2101.61",
            fdv_usd: "2696.17",
          },
          relationships: {
            base_token: { data: { id: "solana_EzghaRncwC5Cy6PXzq81U1dej66qaj1CNmdKJBkKpump" } },
            dex: { data: { id: "pump-fun" } },
          },
        },
        { id: "solana_X", attributes: {}, relationships: {} }, // missing base_token
        { id: "solana_bad", attributes: { pool_created_at: "garbage" }, relationships: { base_token: { data: { id: "solana_short" } } } }, // invalid mint
        null,
        "string",
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].tokenAddress, "EzghaRncwC5Cy6PXzq81U1dej66qaj1CNmdKJBkKpump");
    assert.equal(out[0].createdAtMs, Date.parse("2026-08-14T03:38:19"));
    assert.equal(out[0].dex, "pump-fun");
    assert.equal(out[0].fdvUsd, 2696.17);
    assert.equal(out[0].reserveUsd, 2101.61);
    assert.deepEqual(parseNewPools({ not: "array" }), []);
    assert.deepEqual(parseNewPools(null), []);
  });

  await test("parseNewPools handles the real GeckoTerminal trending_pools shape", () => {
    const out = parseNewPools({
      data: [
        {
          id: "solana_5xYbGqsdE9Znz9PKKPnDk8TDrYx8fXxxwN7kQTbpump",
          type: "pool",
          attributes: {
            name: "TOADLAYER / SOL",
            pool_created_at: "2026-08-15T16:21:21Z",
            volume_usd: { h24: 2340789.63 },
            reserve_in_usd: "4201.61",
            fdv_usd: "5432.17",
          },
          relationships: {
            base_token: { data: { id: "solana_5xYbGqsdE9Znz9PKKPnDk8TDrYx8fXxxwN7kQTbpump" } },
            dex: { data: { id: "pumpswap" } },
          },
        },
      ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].tokenAddress, "5xYbGqsdE9Znz9PKKPnDk8TDrYx8fXxxwN7kQTbpump");
    assert.equal(out[0].createdAtMs, Date.parse("2026-08-15T16:21:21Z"));
    assert.equal(out[0].dex, "pumpswap");
  });

  await test("GeckoTerminalClient backs off all calls for 5 min after a 429", async () => {
    const calls = [];
    const origFetch = global.fetch;
    const okBody = JSON.stringify({ data: [{ id: "solana_5xYbGqsdE9Znz9PKKPnDk8TDrYx8fXxxwN7kQTbpump", type: "pool", attributes: { pool_created_at: "2026-08-15T16:21:21Z" }, relationships: { base_token: { data: { id: "solana_5xYbGqsdE9Znz9PKKPnDk8TDrYx8fXxxwN7kQTbpump" } } } }] });
    global.fetch = async (url) => {
      calls.push(String(url));
      return new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const client = new GeckoTerminalClient({ geckoterminalRequestIntervalMs: 0 });
      // First call 200 → parses fine.
      assert.equal((await client.fetchNewPools(1)).length, 1);
      // Now the API starts rate-limiting (429) → returns [] and sets backoff.
      global.fetch = async (url) => {
        calls.push(String(url));
        return new Response(JSON.stringify({ status: { error_code: 429 } }), { status: 429 });
      };
      assert.equal((await client.fetchTrendingPools(20)).length, 0);
      const callsAfter429 = calls.length;
      // During backoff: no fetch should happen for either endpoint.
      assert.equal((await client.fetchNewPools(1)).length, 0);
      assert.equal((await client.fetchTrendingPools(20)).length, 0);
      assert.equal(calls.length, callsAfter429, "backoff must not hit the API");
      // Expire the backoff window → next call fetches again.
      client.rateLimitedUntil = Date.now() - 1;
      global.fetch = async (url) => {
        calls.push(String(url));
        return new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } });
      };
      assert.equal((await client.fetchNewPools(1)).length, 1);
      assert.equal(calls.length, callsAfter429 + 1, "expired backoff must fetch again");
    } finally {
      global.fetch = origFetch;
    }
  });

  await test("parseTrending maps the GMGN /v1/market/rank shape", () => {
    const out = parseTrending({
      rank: [
        {
          address: "2fEjticD78k5cYfbbBGcBRB2zVZ7eQ5nZgYLm9Wvpump",
          symbol: "DOGE",
          name: "Doge",
          usd_market_cap: 123456,
          liquidity: 50000,
          volume: 250000,
          holder_count: 210,
          smart_degen_count: 4,
          is_wash_trading: false,
          created_timestamp: 1755097200000,
        },
        { address: "Xyz", is_wash_trading: true }, // wash trading + missing fields
        null,
        "string",
      ],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].address, "2fEjticD78k5cYfbbBGcBRB2zVZ7eQ5nZgYLm9Wvpump");
    assert.equal(out[0].marketCap, 123456);
    assert.equal(out[0].smartDegenCount, 4);
    assert.equal(out[0].isWashTrading, false);
    assert.equal(out[0].createdAtMs, 1755097200000);
    assert.equal(out[1].isWashTrading, true);
    assert.deepEqual(parseTrending({ not: "array" }), []);
    assert.deepEqual(parseTrending(null), []);
  });

  await test("parseTokenInfo reads the real GMGN token/info shape (stat + wallet_tags_stat + price)", () => {
    const info = parseTokenInfo({
      holder_count: 1500,
      stat: { degen_call_count: 12 },
      wallet_tags_stat: { smart_wallets: 7 },
      price: { buy_volume_5m: 5000, sell_volume_5m: 2000 },
    });
    assert.ok(info);
    assert.equal(info.smartWallets, 7);
    assert.equal(info.holderCount, 1500);
    assert.equal(info.degenCalls, 12);
    assert.equal(info.buyVolume5m, 5000);
    assert.equal(info.sellVolume5m, 2000);
    assert.equal(parseTokenInfo(null), null);
    assert.equal(parseTokenInfo("x"), null);
  });

  await test("parseTokenOverview reads holder + creator from the Birdeye overview shape", () => {
    const out = parseTokenOverview({
      address: "abc",
      holder: 1531,
      creator: "5x7JhHHQQxxp5yp7xfj1eQvV9Bp7yRRVkP1hMZqNpump",
      price: "0.0001",
    });
    assert.equal(out.holderCount, 1531);
    assert.equal(out.creator, "5x7JhHHQQxxp5yp7xfj1eQvV9Bp7yRRVkP1hMZqNpump");
    // Alternative field names + invalid shapes degrade to nulls.
    assert.deepEqual(parseTokenOverview({ holders: 88, ownerAddress: "5x7JhHHQQxxp5yp7xfj1eQvV9Bp7yRRVkP1hMZqNpump" }), {
      holderCount: 88,
      creator: "5x7JhHHQQxxp5yp7xfj1eQvV9Bp7yRRVkP1hMZqNpump",
    });
    assert.deepEqual(parseTokenOverview({ holder: 0 }), { holderCount: null, creator: null });
    assert.deepEqual(parseTokenOverview({ holder: "abc" }), { holderCount: null, creator: null });
    assert.deepEqual(parseTokenOverview({ holder: 10, creator: "short" }), { holderCount: 10, creator: null });
    assert.deepEqual(parseTokenOverview(null), { holderCount: null, creator: null });
    assert.deepEqual(parseTokenOverview("x"), { holderCount: null, creator: null });
  });

  await test("parseAxiomTrending maps the Axiom new-trending-v2 shape (dict + positional array)", () => {
    const out = parseAxiomTrending({
      tokens: [
        {
          tokenAddress: "2fEjticD78k5cYfbbBGcBRB2zVZ7eQ5nZgYLm9Wvpump",
          tokenTicker: "DOGE",
          tokenName: "Doge",
          marketCapUsd: 123456,
          sniperCount: 4,
          insiderPercentage: 1.2,
          bundlePercentage: 0,
          holderCount: 210,
          createdAt: 1755097200000,
        },
        { tokenAddress: "Xyz" }, // missing fields
        null,
        "string",
      ],
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].address, "2fEjticD78k5cYfbbBGcBRB2zVZ7eQ5nZgYLm9Wvpump");
    assert.equal(out[0].symbol, "DOGE");
    assert.equal(out[0].marketCapUsd, 123456);
    assert.equal(out[0].sniperCount, 4);
    assert.equal(out[0].insiderPct, 1.2);
    assert.equal(out[0].bundlePct, 0);
    assert.equal(out[0].holderCount, 210);
    assert.equal(out[0].createdAtMs, 1755097200000);
    assert.equal(out[1].marketCapUsd, null);
    // Bare-array (positional) form maps by TRENDING_V2_FIELDS index:
    // 0=pairAddress, 1=tokenAddress, 3=tokenTicker, 24=marketCapUsd,
    // 36=sniperCount, 39=developerHoldingPercent.
    const positionalRow = new Array(52).fill(null);
    positionalRow[0] = "pairX";
    positionalRow[1] = "addrY";
    positionalRow[2] = "Name";
    positionalRow[3] = "TICK";
    positionalRow[24] = 5000;
    positionalRow[36] = 9;
    positionalRow[39] = 2.5;
    const positional = parseAxiomTrending([positionalRow]);
    assert.equal(positional.length, 1);
    assert.equal(positional[0].address, "addrY");
    assert.equal(positional[0].symbol, "TICK");
    assert.equal(positional[0].marketCapUsd, 5000);
    assert.equal(positional[0].sniperCount, 9);
    assert.equal(positional[0].developerHoldingPct, 2.5);
    assert.deepEqual(parseAxiomTrending({ not: "array" }), []);
    assert.deepEqual(parseAxiomTrending(null), []);
  });

  // ---------- arkham.ts ----------

  await test("parseArkhamHolders maps the real /token/holders shape (entity types → smart money)", () => {
    const out = parseArkhamHolders({
      token: { identifier: { address: "0x", chain: "solana" }, symbol: "TEST" },
      totalSupply: { solana: 1e9 },
      addressTopHolders: {
        solana: [
          {
            address: {
              address: "walletA",
              arkhamEntity: { id: "wintermute", name: "Wintermute", type: "marketmaker" },
              arkhamLabel: { name: "Hot Wallet" },
            },
            balance: 50000000,
            pctOfCap: 0.05, // 5%
            usd: 12345,
          },
          {
            address: { address: "walletB", arkhamEntity: { id: "binance", name: "Binance", type: "cex" } },
            balance: 30000000,
            pctOfCap: 0.03,
          },
          {
            address: { address: "walletC", arkhamEntity: { id: "whale1", name: null, type: "whale" } },
            balance: 10000000,
            pctOfCap: 0.01,
          },
          {
            address: { address: "walletD" }, // unlabeled — not smart money
            balance: 5000000,
            pctOfCap: 0.005,
          },
        ],
      },
    });
    assert.equal(out.holderCount, 4);
    assert.equal(out.smartMoney.length, 2); // marketmaker + whale (cex excluded)
    assert.equal(out.smartMoney[0].entityName, "Wintermute");
    assert.equal(out.smartMoney[0].entityType, "marketmaker");
    assert.equal(out.smartMoney[0].pctOfCap, 0.05);
    assert.equal(out.smartMoney[1].entityName, null);
    assert.equal(out.topHolders[1].entityType, "cex");
    // Malformed shapes → null; empty holder list → zero-count result (not null).
    assert.equal(parseArkhamHolders(null), null);
    assert.equal(parseArkhamHolders("x"), null);
    assert.equal(parseArkhamHolders({ addressTopHolders: { solana: "nope" } }), null);
    const empty = parseArkhamHolders({ addressTopHolders: { solana: [] } });
    assert.equal(empty.holderCount, 0);
    assert.equal(empty.smartMoney.length, 0);
  });

  await test("isSmartMoneyType is case-insensitive and excludes neutral types", () => {
    const types = new Set(["fund", "whale"]);
    assert.equal(isSmartMoneyType("FUND", types), true);
    assert.equal(isSmartMoneyType("Whale", types), true);
    assert.equal(isSmartMoneyType("cex", types), false);
    assert.equal(isSmartMoneyType(null, types), false);
    assert.equal(isSmartMoneyType(undefined, types), false);
  });

  await test("parseSmartMoneyTypes defaults and parses the comma list", () => {
    assert.equal(parseSmartMoneyTypes(undefined).has("fund"), true);
    assert.equal(parseSmartMoneyTypes("").has("whale"), true);
    const custom = parseSmartMoneyTypes(" Whale, market_maker ,,fund ");
    assert.equal(custom.has("whale"), true);
    assert.equal(custom.has("market_maker"), true);
    assert.equal(custom.has("fund"), true);
    assert.equal(custom.size, 3);
    // Garbage-only input falls back to the defaults.
    assert.equal(parseSmartMoneyTypes("  ,, ").has("investor"), true);
  });

  await test("AxiomClient token-only mode: no credentials OK, login throws, trending uses injected token", async () => {
    // Google/SSO accounts have no password — the client must construct fine
    // without AXIOM_EMAIL/AXIOM_PASSWORD (token-only mode).
    const client = new AxiomClient({});
    let threw = null;
    try {
      await client.loginStep1();
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    assert.ok(threw && /AXIOM_EMAIL/.test(threw), "loginStep1 without credentials must throw");
    // fetchTrending works purely from a stored access token (stub fetch).
    const origFetch = global.fetch;
    let calledUrl = null;
    global.fetch = async (url) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({
          tokens: [
            {
              tokenAddress: "2fEjticD78k5cYfbbBGcBRB2zVZ7eQ5nZgYLm9Wvpump",
              tokenTicker: "DOGE",
              marketCapUsd: 777,
              sniperCount: 2,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    try {
      const items = await client.fetchTrending("fake-access-token", "1h", 5);
      assert.equal(items.length, 1);
      assert.equal(items[0].address, "2fEjticD78k5cYfbbBGcBRB2zVZ7eQ5nZgYLm9Wvpump");
      assert.equal(items[0].marketCapUsd, 777);
      assert.ok(calledUrl.includes("new-trending-v2"), "hits new-trending-v2");
    } finally {
      global.fetch = origFetch;
    }
  });

  await test("trade_log record/hasTraded/countTradesSince round-trips with UNIQUE dedupe", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const base = {
        chatId: "chat-t",
        mode: "auto",
        status: "success",
        amountSol: 0.1,
        slippagePct: 25,
      };
      await db.recordTrade({ ...base, token: "TOK-A", txHash: "sigA", error: null });
      // Same token again (any mode/status) must be ignored — one buy per coin.
      await db.recordTrade({ ...base, token: "TOK-A", status: "failed", txHash: null, error: "dup" });
      await db.recordTrade({ ...base, token: "TOK-B", txHash: null, error: "boom" });
      assert.equal(await db.hasTraded("TOK-A"), true);
      assert.equal(await db.hasTraded("TOK-B"), true);
      assert.equal(await db.hasTraded("TOK-C"), false);
      assert.equal(await db.countTradesSince(Date.now() - 60_000), 2);
      assert.equal(await db.countTradesSince(Date.now() + 60_000), 0);
      const latest = await db.latestTrades(10);
      assert.equal(latest.length, 2);
      assert.equal(latest[0].token, "TOK-B"); // newest first
      assert.equal(latest[1].txHash, "sigA");
    } finally {
      await t.cleanup();
    }
  });

  // ---------- trojan.ts ----------

  await test("tradeDecision gates on mode, dedupe and daily cap", () => {
    const cfg = { mode: "auto", maxDailyBuys: 5 };
    assert.equal(tradeDecision(cfg, { alreadyTraded: false, todayCount: 0 }).ok, true);
    assert.equal(tradeDecision({ mode: "off", maxDailyBuys: 5 }, { alreadyTraded: false, todayCount: 0 }).ok, false);
    assert.equal(tradeDecision(cfg, { alreadyTraded: true, todayCount: 0 }).ok, false);
    assert.equal(tradeDecision(cfg, { alreadyTraded: false, todayCount: 5 }).ok, false);
    assert.equal(tradeDecision(cfg, { alreadyTraded: false, todayCount: 4 }).ok, true);
    assert.equal(tradeDecision(cfg, { alreadyTraded: true, todayCount: 5 }).ok, false);
  });

  await test("parseQuote accepts quoteResponse and surfaces route errors", () => {
    const ok = parseQuote({ quoteResponse: { outAmount: "123" } });
    assert.equal(ok.ok, true);
    assert.equal(ok.quote.outAmount, "123");
    // Direct-route shape (outAmount on the top level) is accepted too.
    const direct = parseQuote({ outAmount: "456" });
    assert.equal(direct.ok, true);
    // No route / explicit error
    assert.equal(parseQuote({ error: "No routes found" }).ok, false);
    assert.equal(parseQuote({}).ok, false);
    assert.equal(parseQuote(null).ok, false);
    assert.equal(parseQuote("nope").ok, false);
  });

  await test("parseQuote accepts the new Metis /swap/v1 shape (routePlan)", () => {
    const metis = parseQuote({
      inputMint: "So11111111111111111111111111111111111111112",
      inAmount: "100000000",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outAmount: "17057460",
      otherAmountThreshold: "16886885",
      swapMode: "ExactIn",
      slippageBps: 100,
      priceImpactPct: "0",
      routePlan: [{ swapInfo: { label: "Meteora DLMM" }, percent: 100 }],
      contextSlot: 299283763,
    });
    assert.equal(metis.ok, true);
    assert.equal(metis.quote.outAmount, "17057460");
  });

  await test("buyAmountLamports sizes by balance pct and falls back to fixed", () => {
    // Balance mode: 80% of a 1.25 SOL balance.
    assert.deepEqual(buyAmountLamports(1_250_000_000, 80, 0.01), {
      amountLamports: 1_000_000_000,
      source: "balance",
    });
    // Fixed mode (pct = 0): the configured amountSol wins.
    assert.deepEqual(buyAmountLamports(5_000_000_000, 0, 0.01), {
      amountLamports: 10_000_000,
      source: "fixed",
    });
    // Percentage mode never buys blind: null balance and empty wallet are errors.
    assert.ok("error" in buyAmountLamports(null, 80, 0.01));
    assert.ok("error" in buyAmountLamports(0, 80, 0.01));
  });

  await test("parseSendResponse normalizes RPC send results", () => {
    const ok = parseSendResponse({ jsonrpc: "2.0", id: 1, result: "SIG1" });
    assert.deepEqual(ok, { ok: true, txHash: "SIG1" });
    const err = parseSendResponse({ jsonrpc: "2.0", id: 1, error: { code: -32002, message: "Transaction simulation failed" } });
    assert.equal(err.ok, false);
    assert.equal(err.error, "Transaction simulation failed");
    assert.equal(parseSendResponse(null).ok, false);
    assert.equal(parseSendResponse({}).ok, false);
  });

  // ---------- config.ts (admin allowlist) ----------

  await test("parseAdminIds parses comma-separated IDs, drops junk", () => {
    assert.deepEqual(parseAdminIds(undefined), []);
    assert.deepEqual(parseAdminIds(""), []);
    assert.deepEqual(parseAdminIds("   "), []);
    assert.deepEqual(parseAdminIds("12345"), [12345]);
    assert.deepEqual(parseAdminIds(" 111 , 222 , 333 "), [111, 222, 333]);
    // Non-numeric and non-positive entries are dropped.
    assert.deepEqual(parseAdminIds("111,abc,-5,0,222"), [111, 222]);
  });

  await test("isAdmin gates users; empty allowlist is fail-closed", () => {
    assert.equal(isAdmin(123, [123, 456]), true);
    assert.equal(isAdmin(999, [123, 456]), false);
    assert.equal(isAdmin(undefined, [123]), false); // no from.id → denied
    assert.equal(isAdmin(123, []), false); // no admins configured → locked
  });

  // ---------- jupiter.ts (trade-mode override) ----------

  await test("resolveTradeMode: override wins, invalid/null fall back to env mode", () => {
    assert.equal(resolveTradeMode("off", "manual"), "manual");
    assert.equal(resolveTradeMode("manual", "auto"), "auto");
    assert.equal(resolveTradeMode("auto", "off"), "off");
    // Invalid stored values are ignored → env mode.
    assert.equal(resolveTradeMode("manual", "hack"), "manual");
    assert.equal(resolveTradeMode("auto", null), "auto");
    assert.equal(resolveTradeMode("off", ""), "off");
  });

  await test("parseSellCallback accepts sell:half|all:<mint> and rejects junk", () => {
    const mint = "Cqs2xNRMCSMDpGzRZ5x225kjM9dhcnTFExiu5Hf6pump";
    assert.deepEqual(parseSellCallback(`sell:half:${mint}`), { mode: "half", token: mint });
    assert.deepEqual(parseSellCallback(`sell:all:${mint}`), { mode: "all", token: mint });
    // Not sell callbacks (buy prefix, wrong arity, bad fraction, bad mint).
    assert.equal(parseSellCallback(`buy:${mint}`), null);
    assert.equal(parseSellCallback(`sell:${mint}`), null);
    assert.equal(parseSellCallback(`sell:half:all:${mint}`), null);
    assert.equal(parseSellCallback(`sell:quarter:${mint}`), null);
    assert.equal(parseSellCallback(`sell:half:SHORT`), null);
  });

  await test("parseModeCallback accepts toggle/apply/cancel and rejects junk", () => {
    const mint = "Cqs2xNRMCSMDpGzRZ5x225kjM9dhcnTFExiu5Hf6pump";
    assert.deepEqual(parseModeCallback(`mode:toggle:${mint}`), { action: "toggle", token: mint });
    assert.deepEqual(parseModeCallback(`mode:cancel:${mint}`), { action: "cancel", token: mint });
    assert.deepEqual(parseModeCallback(`mode:apply:auto:${mint}`), { action: "apply", token: mint, mode: "auto" });
    assert.deepEqual(parseModeCallback(`mode:apply:off:${mint}`), { action: "apply", token: mint, mode: "off" });
    // Not mode callbacks / malformed.
    assert.equal(parseModeCallback(`buy:${mint}`), null);
    assert.equal(parseModeCallback(`sell:half:${mint}`), null);
    assert.equal(parseModeCallback(`mode:toggle`), null); // no token
    assert.equal(parseModeCallback(`mode:apply:ultra:${mint}`), null); // bad mode
    assert.equal(parseModeCallback(`mode:apply:auto`), null);
  });

  await test("nextTradeMode cycles manual → auto → off → manual", () => {
    assert.equal(nextTradeMode("manual"), "auto");
    assert.equal(nextTradeMode("auto"), "off");
    assert.equal(nextTradeMode("off"), "manual");
  });

  await test("sellAmountRaw: all sells everything, half floors at raw/2", () => {
    assert.equal(sellAmountRaw(1_000_000n, "all"), 1_000_000n);
    assert.equal(sellAmountRaw(1_000_001n, "half"), 500_000n); // floor
    assert.equal(sellAmountRaw(1n, "half"), 0n);
    assert.equal(sellAmountRaw(0n, "all"), 0n);
  });

  await test("sell_log records half/all attempts and lists newest first", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.recordSell({
        token: "TOK-S1", chatId: "chat-x", mode: "half", status: "success", txHash: "sig1", amountToken: 500.5, error: null,
      });
      await db.recordSell({
        token: "TOK-S1", chatId: "chat-x", mode: "all", status: "failed", txHash: null, amountToken: null, error: "route not found",
      });
      const sells = await db.latestSells(10);
      assert.equal(sells.length, 2);
      assert.equal(sells[0].token, "TOK-S1"); // newest first
      assert.equal(sells[0].mode, "all");
      assert.equal(sells[0].status, "failed");
      assert.equal(sells[1].mode, "half");
      assert.equal(sells[1].txHash, "sig1");
    } finally {
      await t.cleanup();
    }
  });

  await test("db trade-mode override round-trips, validates and clears", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      assert.equal(await db.getTradeModeOverride(), null); // none set
      await db.setTradeModeOverride("manual");
      assert.equal(await db.getTradeModeOverride(), "manual");
      await db.setTradeModeOverride("auto");
      assert.equal(await db.getTradeModeOverride(), "auto");
      // A stale/hand-edited invalid value is treated as no override.
      await t.client.execute({
        sql: "UPDATE worker_state SET value = 'bogus' WHERE key = 'trade_mode_override'",
        args: [],
      });
      assert.equal(await db.getTradeModeOverride(), null);
      // Clearing removes the row entirely.
      await db.setTradeModeOverride(null);
      assert.equal(await db.getTradeModeOverride(), null);
      assert.equal(
        (await t.client.execute("SELECT COUNT(*) AS n FROM worker_state WHERE key = 'trade_mode_override'")).rows[0].n,
        0,
      );
    } finally {
      await t.cleanup();
    }
  });

  // ---------- worker.ts ----------

  await test("tradeFingerprint detects binding changes without leaking values", () => {
    const base = {
      BOT_WALLET_PRIVATE_KEY: undefined,
      TRADE_MODE: "off",
      TRADE_AMOUNT_SOL: "0.1",
      TRADE_SLIPPAGE_PCT: "25",
      TRADE_PRIORITY_FEE_SOL: "0.001",
      TRADE_MAX_DAILY_BUYS: "5",
      TRADE_TIMEOUT_MS: "15000",
      JUPITER_API_BASE: "https://quote-api.jup.ag",
      BOT_ADMIN_IDS: "",
    };
    const fp1 = tradeFingerprint(base);
    // Adding the wallet secret flips the fingerprint…
    assert.notEqual(
      tradeFingerprint({ ...base, BOT_WALLET_PRIVATE_KEY: "some-secret-value" }),
      fp1,
    );
    // …and so does flipping TRADE_MODE (must take effect without redeploy).
    assert.notEqual(tradeFingerprint({ ...base, TRADE_MODE: "auto" }), fp1);
    // Adding admin IDs also re-initializes the bot (new /setmode allowlist).
    assert.notEqual(tradeFingerprint({ ...base, BOT_ADMIN_IDS: "12345" }), fp1);
    // The secret VALUE never appears in the fingerprint.
    assert.equal(fp1.includes("secret"), false);
    // Stable for identical input.
    assert.equal(tradeFingerprint(base), tradeFingerprint({ ...base }));
  });

  // ---------- bot.ts ----------

  await test("parseFilterArgs accepts the 6-arg form", () => {
    const r = parseFilterArgs(["40000", "300000", "300", "2400", "6000", "30"]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.minMarketCapUsd, 40000);
      assert.equal(r.maxMarketCapUsd, 300000);
      assert.equal(r.minAgeMinutes, 300);
      assert.equal(r.maxAgeMinutes, 2400);
      assert.equal(r.min5mVolUsd, 6000);
      assert.equal(r.min5mChgPct, 30);
    }
  });

  await test("parseFilterArgs accepts thousands separators", () => {
    const r = parseFilterArgs(["40,000", "300,000", "360", "2400", "6,000", "30"]);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.minMarketCapUsd, 40000);
  });

  await test("parseFilterArgs rejects wrong argument counts (bundler/top10 args removed)", () => {
    assert.equal(parseFilterArgs([]).ok, false);
    assert.equal(parseFilterArgs(["1", "2", "3", "4", "5"]).ok, false);
    // 7/8-arg forms (old Bundler/Top10) must now be rejected.
    assert.equal(parseFilterArgs(["1", "2", "3", "4", "5", "6", "7"]).ok, false);
    assert.equal(parseFilterArgs(["1", "2", "3", "4", "5", "6", "7", "8", "9"]).ok, false);
  });

  await test("parseFilterArgs rejects non-numeric, negative and inverted ranges", () => {
    assert.equal(parseFilterArgs(["abc", "300000", "360", "2400", "6000", "30"]).ok, false);
    assert.equal(parseFilterArgs(["-1", "300000", "360", "2400", "6000", "30"]).ok, false);
    assert.equal(parseFilterArgs(["40000", "300000", "-5", "2400", "6000", "30"]).ok, false);
    assert.equal(parseFilterArgs(["300000", "40000", "360", "2400", "6000", "30"]).ok, false); // max < min
    assert.equal(parseFilterArgs(["40000", "300000", "2400", "360", "6000", "30"]).ok, false); // maxAge < minAge
  });

  await test("parseFilterArgs allows min mcap 0 and 5m volume 0 (no minimum)", () => {
    const r = parseFilterArgs(["0", "300000", "360", "2400", "0", "30"]);
    assert.equal(r.ok, true);
  });

  // ---------- supply-flow detector (pure logic, no network) ----------

  const NOW = 1_800_000_000_000;
  const baseDeps = (overrides = {}) => ({
    topAccounts: ["A1", "A2", "A3", "A4"],
    totalSupplyUi: 1000000,
    minFeeders: 3,
    minFedPct: 1,
    minSells: 3,
    windowMs: 12 * 3600e3,
    now: NOW,
    fetchOutTransfers: async () => [],
    ...overrides,
  });

  const out = (from, to, uiAmount, atMs = NOW - 60e3) => ({ from, to, uiAmount, atMs });

  await test("detectSupplyFlow flags 3+ feeders feeding a selling collector", async () => {
    const history = {
      A1: [out("A1", "C1", 8000)],
      A2: [out("A2", "C1", 6000)],
      A3: [out("A3", "C1", 9000)],
      A4: [],
      C1: [out("C1", "POOL", 5000), out("C1", "POOL", 4000), out("C1", "POOL", 3000), out("C1", "POOL", 1000)],
    };
    const r = await detectSupplyFlow(baseDeps({ fetchOutTransfers: async (a) => history[a] ?? [] }));
    assert.equal(r.ok, true);
    assert.equal(r.flagged, true);
    assert.equal(r.feeders, 3);
    assert.equal(r.collector, "C1");
    assert.ok(r.fedPct >= 2.2 && r.fedPct <= 2.4, `fedPct=${r.fedPct}`); // 23000/1e6 = 2.3%
    assert.equal(r.sells, 4);
  });

  await test("detectSupplyFlow ignores below-threshold feeder counts", async () => {
    const history = {
      A1: [out("A1", "C1", 8000)],
      A2: [out("A2", "C1", 6000)],
      A3: [],
      A4: [],
      C1: [out("C1", "POOL", 5000), out("C1", "POOL", 4000), out("C1", "POOL", 3000)],
    };
    const r = await detectSupplyFlow(baseDeps({ fetchOutTransfers: async (a) => history[a] ?? [] }));
    assert.equal(r.flagged, false); // only 2 feeders < minFeeders 3
    assert.equal(r.feeders, 0);
  });

  await test("detectSupplyFlow requires fedPct >= threshold", async () => {
    const history = {
      A1: [out("A1", "C1", 100)],
      A2: [out("A2", "C1", 100)],
      A3: [out("A3", "C1", 100)],
      A4: [],
      C1: [out("C1", "POOL", 100), out("C1", "POOL", 100), out("C1", "POOL", 100)],
    };
    const r = await detectSupplyFlow(baseDeps({ fetchOutTransfers: async (a) => history[a] ?? [] }));
    assert.equal(r.flagged, false); // 300/1e6 = 0.03% < 1%
  });

  await test("detectSupplyFlow requires the collector to be selling", async () => {
    const history = {
      A1: [out("A1", "C1", 8000)],
      A2: [out("A2", "C1", 6000)],
      A3: [out("A3", "C1", 9000)],
      A4: [],
      C1: [], // collector not selling → consolidation without distribution
    };
    const r = await detectSupplyFlow(baseDeps({ fetchOutTransfers: async (a) => history[a] ?? [] }));
    assert.equal(r.flagged, false);
  });

  await test("detectSupplyFlow ignores transfers outside the window", async () => {
    const history = {
      A1: [out("A1", "C1", 8000, NOW - 13 * 3600e3)],
      A2: [out("A2", "C1", 6000, NOW - 13 * 3600e3)],
      A3: [out("A3", "C1", 9000, NOW - 13 * 3600e3)],
      A4: [],
      C1: [out("C1", "POOL", 5000, NOW - 13 * 3600e3), out("C1", "POOL", 4000), out("C1", "POOL", 3000)],
    };
    const r = await detectSupplyFlow(baseDeps({ fetchOutTransfers: async (a) => history[a] ?? [] }));
    assert.equal(r.flagged, false); // all feeds outside the 12h window
  });

  await test("detectSupplyFlow inbound view flags distributed feeders on one top account", async () => {
    // Feeders W1/W2/W3 are NOT top holders — invisible to the outbound view.
    // Inbound view: all three feed the same top account A1, which then sells.
    const outHistory = {
      A1: [out("A1", "POOL", 4000), out("A1", "POOL", 3000), out("A1", "POOL", 2000)],
      A2: [], A3: [], A4: [],
    };
    const inHistory = {
      A1: [out("W1", "A1", 8000), out("W2", "A1", 6000), out("W3", "A1", 9000)],
      A2: [], A3: [], A4: [],
    };
    const r = await detectSupplyFlow(baseDeps({
      fetchOutTransfers: async (a) => outHistory[a] ?? [],
      fetchInTransfers: async (a) => inHistory[a] ?? [],
    }));
    assert.equal(r.ok, true);
    assert.equal(r.flagged, true);
    assert.equal(r.feeders, 3); // W1, W2, W3
    assert.equal(r.collector, "A1");
    assert.ok(r.fedPct >= 2.2 && r.fedPct <= 2.4, `fedPct=${r.fedPct}`); // 23000/1e6
    assert.equal(r.sells, 3);
  });

  await test("detectSupplyFlow inbound view still respects all thresholds", async () => {
    // Only 2 distinct inbound feeders → below minFeeders 3.
    const r1 = await detectSupplyFlow(baseDeps({
      fetchOutTransfers: async (a) => (a === "A1" ? [out("A1", "POOL", 2000), out("A1", "POOL", 2000), out("A1", "POOL", 2000)] : []),
      fetchInTransfers: async (a) => (a === "A1" ? [out("W1", "A1", 8000), out("W2", "A1", 6000)] : []),
    }));
    assert.equal(r1.flagged, false); // only 2 feeders
    // 3 feeders but collector never sells → not distribution.
    const r2 = await detectSupplyFlow(baseDeps({
      fetchOutTransfers: async () => [],
      fetchInTransfers: async (a) => (a === "A1" ? [out("W1", "A1", 8000), out("W2", "A1", 6000), out("W3", "A1", 9000)] : []),
    }));
    assert.equal(r2.flagged, false); // no sells
  });

  await test("detectSupplyFlow excludes LP accounts from feeders and collectors", async () => {
    // Many top holders sell back into the pool — that is normal trading, so
    // the pool must never be treated as a collector.
    const history = {
      A1: [out("A1", "POOL", 8000)],
      A2: [out("A2", "POOL", 6000)],
      A3: [out("A3", "POOL", 9000)],
      A4: [],
      POOL: [out("POOL", "BUYER1", 5000), out("POOL", "BUYER2", 4000), out("POOL", "BUYER3", 3000)],
    };
    const r = await detectSupplyFlow(baseDeps({
      fetchOutTransfers: async (a) => history[a] ?? [],
      excludeAccounts: ["POOL"],
    }));
    assert.equal(r.flagged, false); // POOL excluded as a collector destination
    // Similarly, the pool must not count as an inbound feeder (normal buys).
    const r2 = await detectSupplyFlow(baseDeps({
      fetchOutTransfers: async (a) => (a === "A1" ? [out("A1", "POOL", 2000), out("A1", "POOL", 2000), out("A1", "POOL", 2000)] : []),
      fetchInTransfers: async (a) => (a === "A1" ? [out("POOL", "A1", 8000), out("W2", "A1", 6000), out("W3", "A1", 9000)] : []),
      excludeAccounts: ["POOL"],
    }));
    assert.equal(r2.flagged, false); // POOL source excluded → only 2 real feeders
  });

  await test("detectSupplyFlow without fetchInTransfers keeps outbound-only behavior", async () => {
    // Existing path: no inbound fetches at all → A1 fed by W1/W2/W3 is not
    // flagged because the outbound view never sees those wallets.
    const r = await detectSupplyFlow(baseDeps({
      fetchOutTransfers: async (a) => (a === "A1" ? [out("A1", "POOL", 2000), out("A1", "POOL", 2000), out("A1", "POOL", 2000)] : []),
    }));
    assert.equal(r.flagged, false);
  });

  await test("db updateTokenSupplyFlow round-trips and caches", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.recordTokenStatsMany([{
        token: "T-FLOW",
        firstSeenAt: Date.now(),
        firstM5Vol: 1,
        firstSeenAgeMin: 2,
        launchMs: Date.now() - 2 * 60e3,
        birdeye1mVol: null,
        rugcheckBundlerPct: null,
        rugcheckTop10Pct: null,
        birdeyeProTraders: null,
        birdeyeSniperPct: null,
        minMcapObserved: null,
        supplyFlowJson: null,
        supplyFlowAt: null,
      }]);
      await db.updateTokenSupplyFlow("T-FLOW", JSON.stringify({ flagged: true, feeders: 4, fedPct: 2.5, sells: 6 }));
      const got = await db.getTokenStats("T-FLOW");
      const parsed = JSON.parse(got.supplyFlowJson);
      assert.equal(parsed.flagged, true);
      assert.equal(parsed.feeders, 4);
      assert.ok(got.supplyFlowAt !== null && got.supplyFlowAt > 0);
    } finally {
      await t.cleanup();
    }
  });

  await test("resumeLaunchBackfill backfills NULL launch_ms rows and sets the flag", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init(); // empty DB → the migration completes during init
      // Simulate a mid-migration database: legacy rows (NULL launch_ms)
      // present while the migration flag is unset (as on a database that
      // was seeded before the column existed).
      await t.client.execute(
        "DELETE FROM worker_state WHERE key = 'schema_alter_v2_done'",
      );
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        await t.client.execute({
          sql: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms) VALUES (?, ?, 0, ?, NULL)",
          args: [`T-LEGACY-${i}`, now - i * 3600e3, 60 + i],
        });
      }
      const done = await db.resumeLaunchBackfill(1000);
      assert.equal(done, true);
      assert.equal(await db.getWorkerState("schema_alter_v2_done"), "1");
      // Every legacy row got launch_ms = first_seen_at - age*60s (the same
      // estimate the pre-column query computed inline).
      for (let i = 0; i < 3; i++) {
        const s = await db.getTokenStats(`T-LEGACY-${i}`);
        assert.equal(s.launchMs, now - i * 3600e3 - (60 + i) * 60e3);
      }
      // Once the flag is set the resume is a no-op (returns true immediately).
      assert.equal(await db.resumeLaunchBackfill(1), true);
    } finally {
      await t.cleanup();
    }
  });

  await test("selectTopAccounts excludes pair + LP vault, keeps real holders, respects topN", () => {
    const largest = [
      { address: "VAULT" }, // pool-owned vault (PDA) — must be excluded
      { address: "PAIR" }, // pair address itself — must be excluded
      { address: "HOLDER1" },
      { address: "HOLDER2" },
      { address: "HOLDER3" },
      { address: "HOLDER4" },
    ];
    // Pool with a vault: both pair and vault drop out.
    const picked = selectTopAccounts(largest, "PAIR", [{ pubkey: "VAULT" }], 3);
    assert.deepEqual(picked, ["HOLDER1", "HOLDER2", "HOLDER3"]);
    // No vault info (lookup failed): falls back to pair-only exclusion.
    const fallback = selectTopAccounts(largest, "PAIR", [], 2);
    assert.deepEqual(fallback, ["VAULT", "HOLDER1"]);
    // Vault entries without a pubkey are ignored safely.
    const safe = selectTopAccounts(largest, "PAIR", [{ pubkey: undefined }, {}], 4);
    assert.deepEqual(safe, ["VAULT", "HOLDER1", "HOLDER2", "HOLDER3"]);
  });

  // ---------- summary ----------

  console.log("\n===== UNIT TESTS =====");
  for (const line of results) console.log(line);
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("unit tests failed to run:", err);
  process.exit(1);
});
