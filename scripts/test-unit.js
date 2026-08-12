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
const { detectSupplyFlow, selectTopAccounts } = require("../dist/helius.js");
const { tradeDecision, parseBuyResponse } = require("../dist/trojan.js");

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
    assert.equal(DEFAULT_SETTINGS.minAgeMinutes, 360);
    assert.equal(DEFAULT_SETTINGS.maxAgeMinutes, 2400);
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
      assert.equal(d.minAgeMinutes, 360);
      assert.equal(d.maxAgeMinutes, 2400);
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
      assert.equal(s.minAgeMinutes, 360);
      assert.equal(s.maxAgeMinutes, 2400);
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

  await test("getReevalPool respects window, ordering, seen-exclusion and limit", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const now = Date.now();
      const H = 3600e3;
      const M = 60e3;
      const seed = async (token, firstSeenAt, ageMin, seen = false) => {
        await t.client.execute({
          sql: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed) VALUES (?, ?, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
          args: [token, firstSeenAt, ageMin],
        });
        if (seen) {
          await t.client.execute({
            sql: "INSERT INTO seen_tokens (chat_id, token, first_seen_at) VALUES ('chat-x', ?, ?)",
            args: [token, now],
          });
        }
      };
      // A: launch 6.5h ago — inside window, closest to entry (0.5h)
      await seed("A", now - 6 * H, 30);
      // C: launch 3h20m ago — just before entry, within the 180m margin
      await seed("C", now - 3 * H - 10 * M, 10);
      // B: launch 21h ago — inside window, farther (15h)
      await seed("B", now - 20 * H, 60);
      // F: launch 30h ago — inside window, farthest (24h)
      await seed("F", now - 10 * H, 20 * 60);
      // E: launch 10h ago but already pushed → excluded
      await seed("E", now - 8 * H, 2 * 60, true);
      // D: first seen 50h ago → dropped by sinceMs (42h)
      await seed("D", now - 50 * H, 60);

      const pool = await db.getReevalPool({
        sinceMs: now - 42 * H,
        minLaunchMs: now - (2400 + 180) * M,
        maxLaunchMs: now - (360 - 180) * M,
        windowEntryLaunchMs: now - 360 * M,
        limit: 3,
      });
      assert.deepEqual(
        pool.map((s) => s.token),
        ["A", "C", "B"], // nearest-to-window-entry first; E and D excluded
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

  await test("parseBuyResponse normalizes Trojan buy responses", () => {
    // Common documented shape: { success, txHash }
    const a = parseBuyResponse({ success: true, txHash: "SIG1" });
    assert.deepEqual(a, { ok: true, txHash: "SIG1" });
    // data.signature variant
    const b = parseBuyResponse({ status: "success", data: { signature: "SIG2" } });
    assert.deepEqual(b, { ok: true, txHash: "SIG2" });
    // success with no hash is still ok
    assert.deepEqual(parseBuyResponse({ success: true }), { ok: true });
    // explicit failure surfaces the message
    const c = parseBuyResponse({ error: "insufficient balance" });
    assert.equal(c.ok, false);
    assert.equal(c.error, "insufficient balance");
    // wrapped failure (data.message)
    const d = parseBuyResponse({ data: { message: "token not found" } });
    assert.equal(d.ok, false);
    assert.equal(d.error, "token not found");
    // junk
    assert.equal(parseBuyResponse(null).ok, false);
    assert.equal(parseBuyResponse("nope").ok, false);
    assert.equal(parseBuyResponse(42).ok, false);
  });

  // ---------- bot.ts ----------

  await test("parseFilterArgs accepts the 6-arg form", () => {
    const r = parseFilterArgs(["40000", "300000", "360", "2400", "6000", "30"]);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.minMarketCapUsd, 40000);
      assert.equal(r.maxMarketCapUsd, 300000);
      assert.equal(r.minAgeMinutes, 360);
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
