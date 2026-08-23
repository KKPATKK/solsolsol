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
const { parseFilterArgs, tradeKeyboard } = require("../dist/bot.js");
const { parseAdminIds, isAdmin, parseSmartMoneyTypes, loadConfig } = require("../dist/config.js");
const { detectSupplyFlow, selectTopAccounts, summarizeSignatures } = require("../dist/helius.js");
const { tradeDecision, resolveTradeMode, parseQuote, parseSendResponse, buyAmountLamports, parseSellCallback, sellAmountRaw, parseModeCallback, nextTradeMode } = require("../dist/jupiter.js");
const { parsePumpCoins } = require("../dist/pumpfun.js");
const { parseNewPools, GeckoTerminalClient } = require("../dist/geckoterminal.js");
const { parseJupTokens, JupTokensClient } = require("../dist/jupfeeds.js");
const { passesChgGate } = require("../dist/dexscreener.js");
const { evaluateWatch, recapVerdict, recapMessage } = require("../dist/pushwatch.js");
const { mcapRatioBlockReason, newWalletBlockReason, top10MinBlockReason } = require("../dist/scanner.js");
const { parseTrending, parseTokenInfo } = require("../dist/gmgn.js");
const { parseTokenOverview } = require("../dist/birdeye.js");
const { parseAxiomTrending, AxiomClient } = require("../dist/axiom.js");
const { parseArkhamHolders, isSmartMoneyType } = require("../dist/arkham.js");
const { parseCrimeWalletList, CrimeWalletClient } = require("../dist/crimewallets.js");
const { WalletAnalyzer } = require("../dist/walletanalysis.js");
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
    assert.equal(DEFAULT_SETTINGS.maxMarketCapUsd, 380000);
    assert.equal(DEFAULT_SETTINGS.minAgeMinutes, 80);
    assert.equal(DEFAULT_SETTINGS.maxAgeMinutes, 1260);
    assert.equal(DEFAULT_SETTINGS.min5mVolUsd, 4500);
    assert.equal(DEFAULT_SETTINGS.min5mChgPct, 20);
    // Liquidity floor ships ON ($10K) — zero-liq soft-rugs must never pass.
    assert.equal(DEFAULT_SETTINGS.minLiquidityUsd, 10000);
    // 1h volume floor ships at $15K (path-B leg of the dual-path gate).
    assert.equal(DEFAULT_SETTINGS.min1hVolUsd, 15000);
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
      assert.equal(d.maxMarketCapUsd, 380000);
      assert.equal(d.minAgeMinutes, 80);
      assert.equal(d.maxAgeMinutes, 1260);
      assert.equal(d.min5mVolUsd, 4500);
      assert.equal(d.min5mChgPct, 20);
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
        min1hVolUsd: 999,
        min5mChgPct: 12,
        min1hChgPct: 40,
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
        min1hVolUsd: 999,
        min5mChgPct: 12,
        min1hChgPct: 40,
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
        min1hVolUsd: 20000,
        min5mChgPct: 30,
        min1hChgPct: 40,
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
        min1hVolUsd: 3000,
        min5mChgPct: 5,
        min1hChgPct: 40,
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
      assert.equal(s.maxMarketCapUsd, 380000);
      assert.equal(s.minAgeMinutes, 80);
      assert.equal(s.maxAgeMinutes, 1260);
      assert.equal(s.min5mVolUsd, 4500);
      assert.equal(s.min5mChgPct, 20);
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
        min5mVolUsd: 5, min1hVolUsd: 55, min5mChgPct: 6, min1hChgPct: 40,
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

  await test("getReevalPool: chat-aware seen exclusion keeps coins for chats that missed the push", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const H = 3600e3;
      const M = 60e3;
      const now = 50 * 300e3;
      const seed = async (token, seenChats) => {
        await t.client.execute({
          sql: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed) VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)",
          args: [token, now - 6 * H, 0, now - 6 * H],
        });
        for (const chat of seenChats) {
          await t.client.execute({
            sql: "INSERT INTO seen_tokens (chat_id, token, first_seen_at) VALUES (?, ?, ?)",
            args: [chat, token, now],
          });
        }
      };
      // Same hot zone (age 6h — evaluated every scan): one coin no chat has
      // seen, one pushed to chat-a only (chat-b's delivery failed — the
      // cross-chat inconsistency), one seen by every chat.
      await seed("NONE", []);
      await seed("PARTIAL", ["chat-a"]);
      await seed("FULL", ["chat-a", "chat-b"]);

      const opts = {
        sinceMs: now - 42 * H,
        minLaunchMs: now - (2400 + 180) * M,
        maxLaunchMs: now - (360 - 180) * M,
        windowEntryLaunchMs: now - 360 * M,
        limit: 1000,
        now,
      };

      // Chat-aware (production — the scanner passes the enabled chat ids):
      // a token is excluded only when EVERY enabled chat has already seen it,
      // so the chat that missed a failed push gets a retry.
      const chatAware = (
        await db.getReevalPool({ ...opts, seenChatIds: ["chat-a", "chat-b"] })
      ).map((x) => x.token);
      assert.ok(chatAware.includes("NONE"), "unseen coin stays in the pool");
      assert.ok(
        chatAware.includes("PARTIAL"),
        "coin pushed to one chat but missed by another stays in the pool for a retry",
      );
      assert.ok(
        !chatAware.includes("FULL"),
        "coin seen by every enabled chat is excluded",
      );

      // Legacy (no seenChatIds): any seen row removes the coin — the old
      // token-level behavior that permanently starved the missed chat.
      const legacy = (await db.getReevalPool(opts)).map((x) => x.token);
      assert.ok(legacy.includes("NONE"), "legacy: unseen coin stays");
      assert.ok(
        !legacy.includes("PARTIAL"),
        "legacy: partial push excludes the coin everywhere (the old bug)",
      );
      assert.ok(!legacy.includes("FULL"), "legacy: fully-seen coin excluded");
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

  await test("parseJupTokens maps mints + ISO createdAt, drops non-base58 and dupes", () => {
    const good = "5BoYu1xSzX68h8p6HCJzgvggSCcM7JovP3J1ZLPJpump";
    const out = parseJupTokens([
      {
        id: good,
        name: "Speed Of Light",
        symbol: "SOL",
        createdAt: "2026-08-21T13:43:42Z",
      },
      { id: good }, // dupe
      { id: "short" }, // not base58-length
      { id: 123 },
      null,
      {
        id: "xyS4ySYhwk8LmUgHzDYKP9y4K7QvST5HoMV4iUepump",
        createdAt: "not-a-date",
      },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].tokenAddress, good);
    assert.equal(out[0].openTimestamp, Date.parse("2026-08-21T13:43:42Z"));
    assert.equal(out[1].tokenAddress, "xyS4ySYhwk8LmUgHzDYKP9y4K7QvST5HoMV4iUepump");
    assert.equal(out[1].openTimestamp, undefined); // unparseable date dropped
    assert.deepEqual(parseJupTokens({ nope: true }), []);
    assert.deepEqual(parseJupTokens(null), []);
  });

  await test("JupTokensClient: 429 sets a shared backoff; non-OK degrades to []", async () => {
    const good = "5BoYu1xSzX68h8p6HCJzgvggSCcM7JovP3J1ZLPJpump";
    let calls = 0;
    let status = 200;
    const client = new JupTokensClient(
      { jupiterRequestIntervalMs: 0 },
      async () => {
        calls++;
        return new Response(JSON.stringify([{ id: good }]), { status });
      },
    );
    const ok = await client.fetchRecentTokens(5);
    assert.equal(ok.length, 1);
    // A 429 flips the shared backoff: BOTH feeds return [] without fetching.
    status = 429;
    await client.fetchRecentTokens(5); // this one triggers the backoff
    const before = calls;
    assert.deepEqual(await client.fetchRecentTokens(5), []);
    assert.deepEqual(await client.fetchTrendingTokens(5), []);
    assert.equal(calls, before); // zero network calls while backed off
  });

  await test("fetchOrganicScore: parses score/label/traders; genuine 0 ≠ absent", async () => {
    const mint = "5BoYu1xSzX68h8p6HCJzgvggSCcM7JovP3J1ZLPJpump";
    const body = JSON.stringify([
      {
        id: mint,
        organicScore: 0,
        organicScoreLabel: "low",
        stats1h: { numTraders: 1 },
      },
      { id: "Other11111111111111111111111111111111111111", organicScore: 99 },
    ]);
    const client = new JupTokensClient(
      { jupiterRequestIntervalMs: 0 },
      async () => new Response(body, { status: 200 }),
    );
    // Finds the right entry by id — and a REAL 0 score is reported, not null.
    assert.deepEqual(await client.fetchOrganicScore(mint), {
      score: 0,
      label: "low",
      tradersH1: 1,
    });

    // Absent fields (no organicScore / no stats1h) → nulls, and null result
    // when BOTH are missing (nothing to render).
    const empty = JSON.stringify([{ id: mint }]);
    const c2 = new JupTokensClient(
      { jupiterRequestIntervalMs: 0 },
      async () => new Response(empty, { status: 200 }),
    );
    assert.deepEqual(await c2.fetchOrganicScore(mint), null);

    // Winner-shaped payload (CONK calibration values).
    const winner = JSON.stringify([
      {
        id: mint,
        organicScore: 79.55925990552242,
        organicScoreLabel: "medium",
        stats1h: { numTraders: 224 },
      },
    ]);
    const c3 = new JupTokensClient(
      { jupiterRequestIntervalMs: 0 },
      async () => new Response(winner, { status: 200 }),
    );
    const r = await c3.fetchOrganicScore(mint);
    assert.equal(r.score.toFixed(1), "79.6");
    assert.equal(r.tradersH1, 224);
  });

  await test("passesChgGate: compound 5m OR 1h momentum gate", () => {
    // Hot 5m tape qualifies on its own.
    assert.equal(passesChgGate(25, 10, 20, 40), true);
    // Cool 5m but hot 1h — the pullback-between-spikes case this gate adds.
    assert.equal(passesChgGate(8, 45, 20, 40), true);
    // Both legs cool → rejected.
    assert.equal(passesChgGate(9.2, -5, 20, 40), false);
    // Boundary: >= (not >) on either leg.
    assert.equal(passesChgGate(20, 0, 20, 40), true);
    assert.equal(passesChgGate(0, 40, 20, 40), true);
    assert.equal(passesChgGate(19.9, 39.9, 20, 40), false);
    // Negative values never qualify.
    assert.equal(passesChgGate(-41.2, -10, 20, 40), false);
  });

  await test("evaluateWatch: rising stages fire once each; cooldown suppresses", () => {
    const row = (over = {}) => ({
      token: "T", chatId: "c", symbol: "GOAT", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 50_000, lastLiquidity: 30_000,
      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,
      lastChecked: 0, lastAlertAt: 0, followupsSent: 0, lastState: null,
      ...over,
    });
    const live = (mcap) => ({ mcap, liquidity: 30_000, chg5m: 5, buysH1: 200, sellsH1: 100 });
    const cfg = { cooldownMs: 30 * 60_000 };

    // +60% → up50 fires once (now is 1h after push, cooldown long past).
    const r1 = evaluateWatch(row(), 3600_000, live(80_000), cfg);
    assert.equal(r1.alerts.length, 1);
    assert.equal(r1.alerts[0].kind, "rising");
    assert.match(r1.alerts[0].text, /續漲 GOAT/);
    assert.equal(r1.lastState, "up50");

    // Same stage again within cooldown → no alert, but bookkeeping updates.
    const r2 = evaluateWatch(row({ lastState: "up50", lastAlertAt: 3600_000 }), 3600_000 + 60_000, live(85_000), cfg);
    assert.equal(r2.alerts.length, 0);
    assert.equal(r2.peakMcap, 85_000);

    // Cross +100% after cooldown → up100 fires (not up50 again); the text
    // shows the actual change (+120%), not the threshold.
    const r3 = evaluateWatch(row({ lastState: "up50", lastAlertAt: 3600_000 }), 3600_000 + 3600_000, live(110_000), cfg);
    assert.equal(r3.alerts.length, 1);
    assert.match(r3.alerts[0].text, /續漲 GOAT/);
    assert.match(r3.alerts[0].text, /\+120%/);
    assert.equal(r3.lastState, "up100");
  });

  await test("evaluateWatch: weak, dead stops tracking, liquidity crash, holder growth", () => {
    const row = (over = {}) => ({
      token: "T", chatId: "c", symbol: "X", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 90_000, lastLiquidity: 20_000,
      holdersAtPush: 1000, holdersLast: null, holdersCheckedAt: null,
      lastChecked: 0, lastAlertAt: 0, followupsSent: 0, lastState: null,
      ...over,
    });
    const cfg = { cooldownMs: 0 };

    // -36% off a 1.8x runup → weak fires once.
    const w = evaluateWatch(row(), 1000, { mcap: 57_500, liquidity: 19_000, chg5m: -8, buysH1: 50, sellsH1: 120 }, cfg);
    assert.equal(w.alerts.length, 1);
    assert.equal(w.alerts[0].kind, "weak");
    assert.equal(w.stopTracking, false);

    // -56% off peak → dead fires ONCE; row stays tracked (silent watch) so
    // a V-reversal can still resurrect it.
    const d = evaluateWatch(row(), 1000, { mcap: 39_000, liquidity: 15_000, chg5m: -12, buysH1: 10, sellsH1: 90 }, cfg);
    assert.equal(d.alerts[0].kind, "dead");
    assert.match(d.alerts[0].text, /走死/);
    assert.equal(d.stopTracking, false);

    // Never ran up but dumps straight to -55% vs push → dead still fires.
    const d2 = evaluateWatch(row({ peakMcap: 50_000 }), 1000, { mcap: 22_000, liquidity: 14_000, chg5m: -20, buysH1: 2, sellsH1: 80 }, cfg);
    assert.equal(d2.alerts[0].kind, "dead");
    assert.equal(d2.stopTracking, false);

    // Liquidity collapse >55% → liquidity alert (still above the absolute
    // floor: 30K → 11K is a 63% drop but ≥ $10K, so the rug rule stays quiet).
    const l = evaluateWatch(row({ lastAlertAt: -3600_000, lastLiquidity: 30_000 }), 1000, { mcap: 88_000, liquidity: 11_000, chg5m: 2, buysH1: 90, sellsH1: 80 }, cfg);
    assert.ok(l.alerts.some((a) => a.kind === "liquidity"));

    // Holders +25% since push → hold25 fires (highest crossed stage).
    const h = evaluateWatch(
      row({ holdersLast: 1250, holdersAtPush: 1000, lastAlertAt: -3600_000 }),
      1000,
      { mcap: 88_000, liquidity: 19_000, chg5m: 3, buysH1: 90, sellsH1: 80 },
      cfg,
    );
    const holderAlert = h.alerts.find((a) => a.kind === "holders");
    assert.ok(holderAlert);
    assert.match(holderAlert.text, /\+25%/);
    // Baseline rolls forward so the next card reports incremental growth.
    assert.equal(h.resetBaselineHolders, 1250);
    assert.equal(h.lastState, "hold");
  });

  await test("evaluateWatch: rolling holder baseline kills the 216→340 then 216→341 repeat", () => {
    const row = (over = {}) => ({
      token: "T", chatId: "c", symbol: "ZEC", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 60_000, lastLiquidity: 12_000,
      deadTroughMcap: null,
      holdersCheckedAt: null,
      lastChecked: 0, lastAlertAt: -3600_000, followupsSent: 0,
      lastState: null, sellDomStreak: 0, lastMcap: null,
      lastVol5m: null,
      ...over,
    });
    const cfg = { cooldownMs: 1800_000 };
    const live = (h) => ({ mcap: 55_000, liquidity: 19_000, chg5m: 3, vol5m: 5_000, buysH1: 90, sellsH1: 80 });

    // Step 1: +57% vs push baseline 216 → fires, resets baseline to 340.
    const e1 = evaluateWatch(row({ holdersAtPush: 216, holdersLast: 340 }), 1000, live(), cfg);
    const a1 = e1.alerts.find((a) => a.kind === "holders");
    assert.ok(a1);
    assert.match(a1.text, /216 → 340/);

    // Step 2 (the reported bug): +1 drift vs the NEW baseline, and even with
    // another alert type having wiped lastState — must stay silent.
    const e2 = evaluateWatch(
      row({ holdersAtPush: 340, holdersLast: 341, lastState: "up50" }),
      1000 + 1900_000, live(), cfg,
    );
    assert.ok(!e2.alerts.some((a) => a.kind === "holders"));

    // Step 3: another real leg (+13% vs rolled baseline 340) → fires again
    // with the fresh incremental numbers, not the push-time 216.
    const e3 = evaluateWatch(
      row({ holdersAtPush: 340, holdersLast: 385, lastState: null }),
      1000 + 3800_000, live(), cfg,
    );
    const a3 = e3.alerts.find((a) => a.kind === "holders");
    assert.ok(a3);
    assert.match(a3.text, /340 → 385/);
    assert.equal(e3.resetBaselineHolders, 385);

    // Cooldown still gates: same growth but alert just fired elsewhere.
    const e4 = evaluateWatch(
      row({ holdersAtPush: 340, holdersLast: 385, lastAlertAt: 1000 + 3700_000 }),
      1000 + 3800_000, live(), cfg,
    );
    assert.ok(!e4.alerts.some((a) => a.kind === "holders"));
  });

  await test("evaluateWatch: absolute liquidity floor (drained LP) wins and stops tracking", () => {
    const row = (over = {}) => ({
      token: "T", chatId: "c", symbol: "CatGPT", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 126_000, lastLiquidity: 12_000,
      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,
      lastChecked: 0, lastAlertAt: -3600_000, followupsSent: 0, lastState: "up100",
      ...over,
    });
    const cfg = { cooldownMs: 0 };

    // LP drained to $0 while mcap still shows a fake +152% → rug wins over 🚀.
    const r = evaluateWatch(row(), 1000, { mcap: 126_000, liquidity: 0, chg5m: 0, buysH1: 0, sellsH1: 0 }, cfg);
    assert.equal(r.alerts.length, 1);
    assert.equal(r.alerts[0].kind, "liquidity");
    assert.match(r.alerts[0].text, /流動性枯竭 CatGPT/);
    assert.equal(r.lastState, "rug");
    assert.equal(r.stopTracking, true);

    // Just below the floor with rising mcap — same outcome, no rising alert.
    const r2 = evaluateWatch(row(), 1000, { mcap: 200_000, liquidity: 9_999, chg5m: 30, buysH1: 500, sellsH1: 10 }, cfg);
    assert.equal(r2.alerts[0].kind, "liquidity");
    assert.equal(r2.stopTracking, true);

    // null liquidity (pair without an liq field) must NOT trigger the rule
    // (within cooldown so no other rule can fire either).
    const n = evaluateWatch(row({ lastAlertAt: 900 }), 1000, { mcap: 80_000, liquidity: null, chg5m: 4, buysH1: 20, sellsH1: 15 }, { cooldownMs: 3_600_000 });
    assert.equal(n.alerts.length, 0);
    assert.equal(n.stopTracking, false);

    // Custom floor override works.
    const hi = evaluateWatch(row({ lastLiquidity: 40_000, lastAlertAt: 900 }), 1000, { mcap: 90_000, liquidity: 19_000, chg5m: 2, buysH1: 30, sellsH1: 25 }, { cooldownMs: 3_600_000 });
    assert.equal(hi.alerts.length, 0);
    const custom = evaluateWatch(row({ lastLiquidity: 40_000 }), 1000, { mcap: 90_000, liquidity: 19_000, chg5m: 2, buysH1: 30, sellsH1: 25 }, { cooldownMs: 0, liqFloorUsd: 20_000 });
    assert.equal(custom.alerts[0].kind, "liquidity");
    assert.equal(custom.stopTracking, true);
  });

  await test("evaluateWatch: volume ignition fires once from a dormant tape, never after rising stages", () => {
    const row = (over = {}) => ({
      token: "T", chatId: "c", symbol: "CONK", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 55_000, lastLiquidity: 30_000,
      lastVol5m: 4_000,
      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,
      lastChecked: 0, lastAlertAt: -3600_000, followupsSent: 0, lastState: null,
      ...over,
    });
    const cfg = { cooldownMs: 0 };

    // Dormant (4K) → 60K 5m volume with a mild move → ignition.
    const i1 = evaluateWatch(row(), 1000, { mcap: 55_000, liquidity: 30_000, chg5m: 6, vol5m: 60_000, buysH1: 300, sellsH1: 100 }, cfg);
    assert.equal(i1.alerts.length, 1);
    assert.equal(i1.alerts[0].kind, "ignition");
    assert.match(i1.alerts[0].text, /量能點火 CONK/);
    assert.equal(i1.lastState, "ignite");

    // Tape still hot but the PREVIOUS check was already hot → no repeat.
    const i2 = evaluateWatch(row({ lastState: "ignite" }), 1000, { mcap: 56_000, liquidity: 30_000, chg5m: 3, vol5m: 70_000, buysH1: 300, sellsH1: 120 }, cfg);
    assert.equal(i2.alerts.length, 0);

    // Once +50% is crossed, 🚀 owns the narrative — no ignition noise.
    const i3 = evaluateWatch(row(), 1000, { mcap: 90_000, liquidity: 30_000, chg5m: 10, vol5m: 80_000, buysH1: 400, sellsH1: 100 }, cfg);
    assert.ok(i3.alerts.every((a) => a.kind !== "ignition"));
    assert.ok(i3.alerts.some((a) => a.kind === "rising"));
  });

  await test("evaluateWatch: dead is silent afterwards, then resurrects at trough x1.5", () => {
    const row = (over = {}) => ({
      token: "T", chatId: "c", symbol: "X", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 90_000, lastLiquidity: 20_000,
      lastVol5m: 3_000, deadTroughMcap: 30_000,
      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,
      lastChecked: 0, lastAlertAt: -3600_000, followupsSent: 1, lastState: "dead",
      ...over,
    });
    const cfg = { cooldownMs: 0 };

    // Below trough × 1.5 (45K) after the 💀 → completely silent; a lower
    // low is tracked for the resurrection anchor.
    const s = evaluateWatch(row(), 1000, { mcap: 28_000, liquidity: 20_000, chg5m: 2, vol5m: 3_000, buysH1: 5, sellsH1: 9 }, cfg);
    assert.equal(s.alerts.length, 0);
    assert.equal(s.lastState, "dead");
    assert.equal(s.stopTracking, false);
    assert.equal(s.deadTroughMcap, 28_000);

    // Recovers above trough × 1.5 (30K × 1.5 = 45K) → resurrection.
    const r = evaluateWatch(row(), 1000, { mcap: 46_000, liquidity: 25_000, chg5m: 15, vol5m: 40_000, buysH1: 200, sellsH1: 40 }, cfg);
    assert.equal(r.alerts.length, 1);
    assert.match(r.alerts[0].text, /死而復生 X/);
    assert.match(r.alerts[0].text, /×1\.5/);
    assert.equal(r.resetBaselineMcap, 46_000);
    assert.equal(r.peakMcap, 46_000);
    assert.equal(r.lastState, null);
    assert.equal(r.deadTroughMcap, null);

    // Legacy dead row without a recorded trough falls back to the push
    // baseline × 1.5 (75K) — 52K does NOT resurrect.
    const legacy = evaluateWatch(row({ deadTroughMcap: null }), 1000, { mcap: 52_000, liquidity: 25_000, chg5m: 15, vol5m: 40_000, buysH1: 200, sellsH1: 40 }, cfg);
    assert.equal(legacy.alerts.length, 0);
    assert.equal(legacy.lastState, "dead");

    // Fresh row that never died still fires 💀 normally (once), and the
    // alert names the trough × 1.5 recovery target.
    const f = evaluateWatch(row({ lastState: null, followupsSent: 0, deadTroughMcap: null }), 1000, { mcap: 39_000, liquidity: 20_000, chg5m: -12, vol5m: 2_000, buysH1: 10, sellsH1: 90 }, cfg);
    assert.equal(f.alerts[0].kind, "dead");
    assert.match(f.alerts[0].text, /39\.00K/);
    assert.equal(f.stopTracking, false);
    assert.equal(f.deadTroughMcap, 39_000);
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

  // ---------- crimewallets.ts ----------

  await test("parseCrimeWalletList keeps valid base58, drops comments/CRLF/garbage, dedupes", () => {
    const good1 = "11111111111111111111111111111111";
    const good2 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const text = [
      "# Crime Wallet List",
      good1,
      `  ${good2}  `, // surrounding whitespace trimmed
      "0OIl-not-base58", // invalid chars (0/O/I/l)
      "",
      "short",
      good1, // duplicate
      `${good1}\r`, // CRLF
    ].join("\n");
    const out = parseCrimeWalletList(text);
    assert.equal(out.length, 2);
    assert.ok(out.includes(good1));
    assert.ok(out.includes(good2));
  });

  await test("CrimeWalletClient.checkToken: unloaded list → skipped, zero Helius calls", async () => {
    let rpcCalls = 0;
    const client = new CrimeWalletClient(
      { crimeWallets: { url: "https://x", refreshMs: 1, timeoutMs: 1000 } },
      null,
      async () => {
        throw new Error("must not fetch");
      },
    );
    const result = await client.checkToken(
      "TOKEN",
      "creator-wallet",
      {
        getTokenLargestAccounts: async () => {
          rpcCalls++;
          return [];
        },
        getAccountOwners: async () => new Map(),
      },
      { checkHolders: true, holderTopN: 8 },
    );
    assert.equal(result.loaded, false);
    assert.equal(result.hit, false);
    assert.equal(rpcCalls, 0);
  });

  await test("CrimeWalletClient: persists parsed list and hydrates from it when upstream dies", async () => {
    const good = "11111111111111111111111111111111";
    const good2 = "22222222222222222222222222222222";
    // Minimal Db stub backed by a map.
    const state = new Map();
    const db = {
      async setWorkerState(k, v) {
        state.set(k, v);
      },
      async getWorkerState(k) {
        return state.get(k) ?? null;
      },
    };
    const cfg = { crimeWallets: { url: "https://x", refreshMs: 1, timeoutMs: 1000 } };

    // Isolate 1: healthy upstream — list loads AND is persisted to db.
    const c1 = new CrimeWalletClient(cfg, db, async () => new Response(`${good}\n${good2}\n`, { status: 200 }));
    const r1 = await c1.refreshIfStale(true);
    assert.equal(r1.ok, true);
    assert.equal(r1.size, 2);
    assert.equal(state.get("crime_wallets_list"), `${good}\n${good2}`);

    // Isolate 2: cold start + upstream gone (404) — hydrates from persisted copy.
    let fetchTried = false;
    const c2 = new CrimeWalletClient(cfg, db, async () => {
      fetchTried = true;
      return new Response("gone", { status: 404 });
    });
    const r2 = await c2.refreshIfStale(true);
    assert.equal(fetchTried, true); // still tried upstream first
    assert.equal(r2.ok, true);
    assert.equal(r2.size, 2);
    assert.equal(c2.loaded, true);
    const chk = await c2.checkToken("T", good2, null, { checkHolders: false, holderTopN: 8 });
    assert.equal(chk.loaded, true);
    assert.equal(chk.creatorHit, true);

    // No persisted copy + dead upstream → stays unloaded (previous behavior).
    const emptyDb = {
      async setWorkerState() {},
      async getWorkerState() {
        return null;
      },
    };
    const c3 = new CrimeWalletClient(cfg, emptyDb, async () => new Response("gone", { status: 404 }));
    const r3 = await c3.refreshIfStale(true);
    assert.equal(r3.ok, false);
    assert.equal(c3.loaded, false);
  });

  await test("CrimeWalletClient.checkToken: creator hit flags without spending holder RPCs", async () => {
    const bad = "11111111111111111111111111111111";
    const client = new CrimeWalletClient(
      { crimeWallets: { url: "https://x", refreshMs: 1, timeoutMs: 1000 } },
      null,
      async () => new Response([`${bad}\n`].join(""), { status: 200 }),
    );
    await client.refreshIfStale(true);
    let largestCalls = 0;
    const fakeHelius = {
      getTokenLargestAccounts: async () => {
        largestCalls++;
        return [];
      },
      getAccountOwners: async () => new Map(),
    };
    const r = await client.checkToken("T", bad, fakeHelius, {
      checkHolders: true,
      holderTopN: 8,
    });
    assert.equal(r.loaded, true);
    assert.equal(r.creatorHit, true);
    assert.equal(r.hit, true);
    assert.equal(largestCalls, 0); // creator hit short-circuits the holder RPC spend
  });

  await test("CrimeWalletClient.checkToken: top-holder owner hit via Helius owner map", async () => {
    const bad = "11111111111111111111111111111111";
    const good = "22222222222222222222222222222222";
    const client = new CrimeWalletClient(
      { crimeWallets: { url: "https://x", refreshMs: 1, timeoutMs: 1000 } },
      null,
      async () => new Response([`${bad}\n`].join(""), { status: 200 }),
    );
    await client.refreshIfStale(true);
    const fakeHelius = {
      getTokenLargestAccounts: async () => [
        { address: "acct1", uiAmount: 10, decimals: 6 },
        { address: "acct2", uiAmount: 5, decimals: 6 },
      ],
      getAccountOwners: async (addrs) =>
        new Map(addrs.map((a, i) => [a, i === 0 ? bad : good])),
    };
    const r = await client.checkToken("T", null, fakeHelius, {
      checkHolders: true,
      holderTopN: 8,
    });
    assert.equal(r.loaded, true);
    assert.equal(r.creatorHit, false);
    assert.equal(r.checkedHolders, 2);
    assert.equal(r.holderHits.length, 1);
    assert.equal(r.hit, true);
  });

  await test("CrimeWalletClient.checkToken: holder lookup failure → no hit, no throw", async () => {
    const client = new CrimeWalletClient(
      { crimeWallets: { url: "https://x", refreshMs: 1, timeoutMs: 1000 } },
      null,
      async () => new Response("11111111111111111111111111111111\n", { status: 200 }),
    );
    await client.refreshIfStale(true);
    const fakeHelius = {
      getTokenLargestAccounts: async () => {
        throw new Error("RPC down");
      },
      getAccountOwners: async () => new Map(),
    };
    const r = await client.checkToken("T", null, fakeHelius, {
      checkHolders: true,
      holderTopN: 8,
    });
    assert.equal(r.loaded, true);
    assert.equal(r.hit, false);
    assert.equal(r.checkedHolders, 0);
  });

  await test("CrimeWalletClient.checkToken exposes resolved holders for wallet analysis", async () => {
    const good = "22222222222222222222222222222222";
    const client = new CrimeWalletClient(
      { crimeWallets: { url: "https://x", refreshMs: 1, timeoutMs: 1000 } },
      null,
      async () => new Response("11111111111111111111111111111111\n", { status: 200 }),
    );
    await client.refreshIfStale(true);
    const fakeHelius = {
      getTokenLargestAccounts: async () => [
        { address: "acct1", uiAmount: 10, decimals: 6 },
        { address: "acct2", uiAmount: 5, decimals: 6 },
      ],
      getAccountOwners: async (addrs) => new Map(addrs.map((a) => [a, good])),
    };
    const r = await client.checkToken("T", null, fakeHelius, {
      checkHolders: true,
      holderTopN: 8,
    });
    assert.equal(r.holders.length, 2);
    assert.equal(r.holders[0].owner, good);
    assert.equal(r.holders[0].rank, 1);
    assert.equal(r.holders[1].rank, 2);
    assert.equal(r.holders[0].uiAmount, 10);
    // Creator-hit short-circuit leaves holders empty (no holder RPC spend).
    const r2 = await client.checkToken(
      "T",
      "11111111111111111111111111111111",
      fakeHelius,
      { checkHolders: true, holderTopN: 8 },
    );
    assert.equal(r2.creatorHit, true);
    assert.equal(r2.holders.length, 0);
  });

  // ---------- helius.ts wallet profile ----------

  await test("summarizeSignatures computes age, tx count, create count and cap flag", () => {
    const sigs = [
      { blockTime: 2000, memo: "create:..." },
      { blockTime: 1000, memo: "create:..." },
      { blockTime: 3000, memo: null },
      { blockTime: null, memo: "create:..." }, // untimed sig still counts as a create
    ];
    const r = summarizeSignatures(sigs, true);
    assert.equal(r.firstTxMs, 1000 * 1000);
    assert.equal(r.txCount, 4);
    assert.equal(r.createCount, 3);
    assert.equal(r.capped, false); // exhausted → exact numbers
    // Case-insensitive create memo (pump.fun "Create" mixed case).
    assert.equal(summarizeSignatures([{ blockTime: 1, memo: "Create:xxx" }], true).createCount, 1);
  });

  await test("summarizeSignatures marks capped when the window is cut off", () => {
    const sigs = Array.from({ length: 1000 }, (_, i) => ({ blockTime: i, memo: null }));
    assert.equal(summarizeSignatures(sigs, false).capped, true);
    assert.equal(summarizeSignatures(sigs, true).capped, false);
    assert.equal(summarizeSignatures([], true).firstTxMs, null);
  });

  // ---------- walletanalysis.ts ----------

  await test("db pushed_holders round-trips and cluster queries find repeat wallets", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const now = Date.now();
      const W1 = "11111111111111111111111111111111";
      const W2 = "22222222222222222222222222222222";
      await db.recordPushedHolders(
        [
          { token: "T1", owner: W1, rank: 1, uiAmount: 100, isCreator: true, crimeHit: false },
          { token: "T1", owner: W2, rank: 2, uiAmount: 50, isCreator: false, crimeHit: false },
        ],
        now - 3 * 3600e3, // 3h ago → older than the 2h prune cutoff below
      );
      await db.recordPushedHolders(
        [
          { token: "T2", owner: W1, rank: 1, uiAmount: 200, isCreator: false, crimeHit: true },
          { token: "T2", owner: W2, rank: 2, uiAmount: 60, isCreator: false, crimeHit: false },
        ],
        now,
      );
      // Per-wallet lookup: W1 connects to 2 distinct coins (as creator + holder).
      const c = await db.getHolderClusters([W1, W2], now - 30 * 24 * 3600e3, 2);
      assert.equal(c.length, 2);
      const w1 = c.find((x) => x.owner === W1);
      assert.equal(w1.coins, 2);
      assert.equal(w1.isCreator, true); // MAX(is_creator)
      // Threshold 3 → nothing.
      assert.equal((await db.getHolderClusters([W1, W2], now - 30 * 24 * 3600e3, 3)).length, 0);
      // Global scan (debug endpoint shape).
      const g = await db.getGlobalHolderClusters(now - 30 * 24 * 3600e3, 2);
      assert.equal(g.length, 2);
      assert.equal(g.find((x) => x.owner === W1).crimeHits, 1);
      // Prune wipes rows older than 2h (the T1 rows).
      const deleted = await db.prunePushedHolders(now - 2 * 3600e3);
      assert.ok(deleted >= 2);
      assert.equal((await db.getHolderClusters([W1, W2], now - 30 * 24 * 3600e3, 2)).length, 0);
    } finally {
      await t.cleanup();
    }
  });

  await test("WalletAnalyzer: creator profile + holder ages + clustering end-to-end", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const config = loadConfig({});
      const now = 1_800_000_000_000;
      const CREATOR = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
      const DEV2 = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
      const H1 = "11111111111111111111111111111111";
      const H2 = "22222222222222222222222222222222";
      const fakeHelius = {
        getWalletProfile: async (addr) => {
          if (addr === CREATOR) {
            return { firstTxMs: now - 30 * 3600e3, txCount: 50, capped: false, createCount: 4 };
          }
          if (addr === H1) {
            return { firstTxMs: now - 2 * 3600e3, txCount: 3, capped: false, createCount: 0 };
          }
          return { firstTxMs: now - 100 * 24 * 3600e3, txCount: 200, capped: false, createCount: 0 };
        },
      };
      const analyzer = new WalletAnalyzer(config, db, fakeHelius);
      const crime = {
        hit: false,
        creatorHit: false,
        holderHits: [],
        checkedHolders: 2,
        loaded: true,
        holders: [
          { address: "a1", owner: H1, rank: 1, uiAmount: 10 },
          { address: "a2", owner: H2, rank: 2, uiAmount: 5 },
        ],
      };
      const r = await analyzer.analyze({
        token: "T1",
        creator: CREATOR,
        holders: crime.holders,
        crime,
        now,
      });
      assert.equal(r.ok, true);
      assert.equal(r.creator.createCount, 4);
      assert.equal(r.creator.serialLauncher, true); // 4 >= default 3
      assert.equal(r.creator.ageHours >= 29 && r.creator.ageHours <= 31, true);
      assert.equal(r.holders.checked, 2);
      assert.equal(r.holders.newWallets, 1); // H1 is younger than 24h
      assert.equal(r.holders.creatorRank, null); // creator not among top holders
      // Second coin sharing holder H1 → cluster fires for H1.
      const crime2 = {
        ...crime,
        holders: [{ address: "b1", owner: H1, rank: 1, uiAmount: 20 }],
      };
      const r2 = await analyzer.analyze({
        token: "T2",
        creator: DEV2,
        holders: crime2.holders,
        crime: crime2,
        now: now + 60e3,
      });
      assert.equal(r2.holders.cluster.length, 1);
      assert.equal(r2.holders.cluster[0].owner, H1);
      assert.equal(r2.holders.cluster[0].coins, 2);
      assert.equal(r2.creator.clusterCoins, 1); // creator row counts its own coin
      // Disabled analyzer → skipped, no RPC.
      let rpcCalls = 0;
      const off = new WalletAnalyzer(
        { ...config, walletAnalysis: { ...config.walletAnalysis, enabled: false } },
        db,
        { getWalletProfile: async () => { rpcCalls++; return null; } },
      );
      const r3 = await off.analyze({ token: "T3", creator: CREATOR, holders: [], crime, now });
      assert.equal(r3.skippedReason, "disabled");
      assert.equal(rpcCalls, 0);
    } finally {
      await t.cleanup();
    }
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

  await test("parseFilterArgs rejects wrong argument counts (6 required, optional 1h + liq)", () => {
    assert.equal(parseFilterArgs([]).ok, false);
    assert.equal(parseFilterArgs(["1", "2", "3", "4", "5"]).ok, false);
    // 6 args = valid (1h leg 40, liq floor default); 7 = explicit 1h;
    // 8 = explicit liquidity floor; 9 = explicit 1h volume floor; 10 rejected.
    const six = parseFilterArgs(["40000", "300000", "300", "1680", "4000", "20"]);
    assert.equal(six.ok, true);
    assert.ok(six.ok && six.min1hChgPct === 40);
    assert.ok(six.ok && six.minLiquidityUsd === 10000);
    const seven = parseFilterArgs(["40000", "300000", "300", "1680", "4000", "20", "35"]);
    assert.equal(seven.ok, true);
    assert.ok(seven.ok && seven.min1hChgPct === 35);
    assert.ok(seven.ok && seven.minLiquidityUsd === 10000);
    const eight = parseFilterArgs(["40000", "300000", "300", "1680", "4000", "20", "35", "15000"]);
    assert.equal(eight.ok, true);
    assert.ok(eight.ok && eight.minLiquidityUsd === 15000);
    const zeroLiq = parseFilterArgs(["40000", "300000", "300", "1680", "4000", "20", "40", "0"]);
    assert.equal(zeroLiq.ok, true);
    assert.ok(zeroLiq.ok && zeroLiq.minLiquidityUsd === 0);
    const nine = parseFilterArgs(["40000", "300000", "300", "1680", "4000", "20", "35", "15000", "25000"]);
    assert.equal(nine.ok, true);
    assert.ok(nine.ok && nine.min1hVolUsd === 25000);
    const ten = parseFilterArgs(["40000", "300000", "300", "1680", "4000", "20", "35", "15000", "25000", "9"]);
    assert.equal(ten.ok, false);
    assert.equal(parseFilterArgs(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]).ok, false);
  });

  await test("db findUntrackedPushes returns seen-but-untracked pushes only", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const now = Date.now();
      // Two pushed tokens; one already tracked, one outside the window.
      await db.markTokenSeen("chat-a", "T-TRACKED");
      await db.markTokenSeen("chat-a", "T-MISSING");
      await db.markTokenSeen("chat-a", "T-OLD");
      await db.upsertPushWatch({
        token: "T-TRACKED", chatId: "chat-a", symbol: "A",
        pushedAt: now - 60e3, mcapAtPush: 1, liquidityUsd: null,
      });
      await t.client.execute({
        sql: "UPDATE seen_tokens SET first_seen_at = ? WHERE token = 'T-OLD'",
        args: [now - 48 * 3600e3],
      });
      const missing = await db.findUntrackedPushes(now - 24 * 3600e3, 10);
      assert.deepEqual(missing.map((m) => m.token), ["T-MISSING"]);
      // Seeding it makes the query empty (NOT EXISTS).
      await db.upsertPushWatch({
        token: "T-MISSING", chatId: "chat-a", symbol: null,
        pushedAt: now, mcapAtPush: 5, liquidityUsd: null,
      });
      assert.deepEqual(await db.findUntrackedPushes(now - 24 * 3600e3, 10), []);
    } finally {
      await t.cleanup();
    }
  });

  await test("settings_v4 migration lifts the 0 liquidity floor to the default once", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // Simulate a pre-v4 database: chat created while the floor shipped as 0.
      await t.client.execute("DELETE FROM worker_state WHERE key = 'settings_v4_applied'");
      await t.client.execute("UPDATE chat_settings SET min_liquidity_usd = 0");
      await db.saveChatSettings({
        chatId: "chat-a", minLiquidityUsd: 0, minVolume24hUsd: 0,
        minMarketCapUsd: 40000, maxMarketCapUsd: 300000,
        minAgeMinutes: 180, maxAgeMinutes: 1680, min5mVolUsd: 4000,
        min1hVolUsd: 20000, min5mChgPct: 20, min1hChgPct: 40, enabled: true,
      });
      await t.client.execute("DELETE FROM worker_state WHERE key = 'settings_v4_applied'");
      // Re-open: the migration must run once and only touch 0-valued rows.
      const db2 = new Db(t.p, undefined, t.client);
      await db2.init();
      assert.equal(await db2.getWorkerState("settings_v4_applied"), "1");
      assert.equal((await db2.getChatSettings("chat-a")).minLiquidityUsd, 10000);
      // Custom non-zero values survive a later init untouched.
      await db2.saveChatSettings({
        chatId: "chat-a", minLiquidityUsd: 25000, minVolume24hUsd: 0,
        minMarketCapUsd: 40000, maxMarketCapUsd: 300000,
        minAgeMinutes: 180, maxAgeMinutes: 1680, min5mVolUsd: 4000,
        min1hVolUsd: 20000, min5mChgPct: 20, min1hChgPct: 40, enabled: true,
      });
      const db3 = new Db(t.p, undefined, t.client);
      await db3.init();
      assert.equal((await db3.getChatSettings("chat-a")).minLiquidityUsd, 25000);
    } finally {
      await t.cleanup();
    }
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

  await test("parseFilterArgs: 9th arg is the 1h volume floor (default $15K)", () => {
    // Omitted -> default $15K.
    const dflt = parseFilterArgs(["40000", "300000", "180", "1680", "6000", "30"]);
    assert.equal(dflt.ok, true);
    assert.equal(dflt.min1hVolUsd, 15000);
    // Explicit value passes through.
    const explicit = parseFilterArgs(["40000", "300000", "180", "1680", "6000", "30", "40", "10000", "12000"]);
    assert.equal(explicit.ok, true);
    assert.equal(explicit.min1hVolUsd, 12000);
    // 0 disables the gate.
    const off = parseFilterArgs(["40000", "300000", "180", "1680", "6000", "30", "40", "10000", "0"]);
    assert.equal(off.ok, true);
    assert.equal(off.min1hVolUsd, 0);
    // Negative -> rejected.
    assert.equal(parseFilterArgs(["40000", "300000", "180", "1680", "6000", "30", "40", "10000", "-5"]).ok, false);
  });

  // ---------- 🩸 sell-pressure dominance + 🏁 case-closed recap ----------

  await test("evaluateWatch: 🩸 fires on the 3rd consecutive sell-dominant check, once per episode", () => {
    const row = (over = {}) => ({
      token: "T", chatId: "c", symbol: "PUMP", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 75_000, lastLiquidity: 30_000, // ran up +50%
      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,
      lastChecked: 0, lastAlertAt: 0, followupsSent: 0, lastState: null,
      ...over,
    });
    const live = () => ({ mcap: 60_000, liquidity: 30_000, chg5m: -2, vol5m: 500, buysH1: 100, sellsH1: 200 });
    const cfg = { cooldownMs: 0 };

    const r1 = evaluateWatch(row(), 3600_000, live(), cfg);
    assert.equal(r1.alerts.length, 0);
    assert.equal(r1.sellDomStreak, 1);

    const r2 = evaluateWatch(row({ sellDomStreak: 1 }), 3600_000 + 60_000, live(), cfg);
    assert.equal(r2.alerts.length, 0);
    assert.equal(r2.sellDomStreak, 2);

    const r3 = evaluateWatch(row({ sellDomStreak: 2 }), 3600_000 + 120_000, live(), cfg);
    assert.equal(r3.alerts.length, 1);
    assert.equal(r3.alerts[0].kind, "sell-pressure");
    assert.match(r3.alerts[0].text, /🩸 賣壓主導 PUMP/);
    assert.equal(r3.sellDomStreak, 3);

    // Streak 4+ stays silent — one alert per episode.
    const r4 = evaluateWatch(row({ sellDomStreak: 3 }), 3600_000 + 180_000, live(), cfg);
    assert.equal(r4.alerts.length, 0);
    assert.equal(r4.sellDomStreak, 4);
  });

  await test("evaluateWatch: 🩸 resets on buy recovery and never fires without runup", () => {
    const row = (over = {}) => ({
      token: "T", chatId: "c", symbol: null, pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 50_000, lastLiquidity: 30_000,
      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,
      lastChecked: 0, lastAlertAt: 0, followupsSent: 0, lastState: null,
      ...over,
    });
    const selling = { mcap: 45_000, liquidity: 30_000, chg5m: -3, vol5m: 300, buysH1: 80, sellsH1: 160 };
    const recovering = { ...selling, buysH1: 240, sellsH1: 160 };
    const cfg = { cooldownMs: 0 };

    // Buys recover -> streak resets to 0.
    const r1 = evaluateWatch(row({ sellDomStreak: 2 }), 3600_000, recovering, cfg);
    assert.equal(r1.sellDomStreak, 0);

    // Flat loser (no runup): streak still counts past the threshold but
    // never alerts — its tape is naturally sell-heavy and weak/dead cover it.
    let streak = 0;
    for (let i = 0; i < 5; i++) {
      const r = evaluateWatch(row({ sellDomStreak: streak }), 3600_000 + i * 60_000, selling, cfg);
      streak = r.sellDomStreak;
      assert.equal(r.alerts.filter((a) => a.kind === "sell-pressure").length, 0);
    }
    assert.equal(streak, 5);
  });

  await test("recapVerdict: rug wins, then dead floor, then peak grades", () => {
    assert.match(recapVerdict(50_000, 90_000, 10_000, "rug"), /rug/);
    assert.match(recapVerdict(50_000, 90_000, 20_000, null), /走死/); // final 40% <= 45%
    assert.match(recapVerdict(50_000, 250_000, 60_000, null), /金狗/); // peak x5
    assert.match(recapVerdict(50_000, 120_000, 55_000, "weak"), /強勢/); // peak x2.4
    assert.match(recapVerdict(50_000, 80_000, 52_000, "weak"), /穩漲/); // peak x1.6
    assert.match(recapVerdict(50_000, 55_000, 47_000, null), /橫盤/); // final 94%
    assert.match(recapVerdict(50_000, 55_000, 35_000, "weak"), /回落/); // final 70%
  });

  await test("recapMessage: one card with push->peak->final arc and verdict", () => {
    const msg = recapMessage({
      token: "TOKENXYZ", chatId: "c", symbol: "GOAT", pushedAt: Date.now() - 25 * 3600_000,
      mcapAtPush: 100_000, peakMcap: 220_000, lastLiquidity: 20_000,
      lastVol5m: null, deadTroughMcap: null, holdersAtPush: null,
      holdersLast: null, holdersCheckedAt: null, lastChecked: Date.now(),
      lastAlertAt: 0, followupsSent: 3, lastState: "weak",
      sellDomStreak: 0, lastMcap: 130_000,
    });
    assert.match(msg, /🏁 結案報告 GOAT/);
    assert.match(msg, /峰值 \$220\.00K（最高 \+120%）/);
    assert.match(msg, /終值 \$130\.00K/);
    assert.match(msg, /跟進警報 3 次/);
  });
  // ---------- mcap/liquidity ratio gate (Nudaeng lesson) ----------

  await test("mcapRatioBlockReason: real push-history calibration", () => {
    // The failures — must be blocked (Nudaeng pushed at 18.0x, BAOJIN 27.9x).
    assert.match(mcapRatioBlockReason(297569, 16510, 10), /18\.0x/);
    assert.match(mcapRatioBlockReason(57531, 2059, 10), /27\.9x/);
    // The healthy pushes — must pass untouched (CONK/DOTE/MAPLE/BLC).
    assert.equal(mcapRatioBlockReason(646915, 101054, 10), null); // CONK 6.4x
    assert.equal(mcapRatioBlockReason(151378, 27775, 10), null); // DOTE 5.4x
    assert.equal(mcapRatioBlockReason(122460, 20696, 10), null); // MAPLE 5.9x
    assert.equal(mcapRatioBlockReason(115221, 34329, 10), null); // MAPLE 3.4x
    assert.equal(mcapRatioBlockReason(41288, 17655, 10), null); // BLC 2.3x
    // Boundary: exactly at the limit passes, just over fails.
    assert.equal(mcapRatioBlockReason(100000, 10000, 10), null); // 10.0x == max
    assert.match(mcapRatioBlockReason(100001, 10000, 10), /10\.0x/);
  });

  await test("mcapRatioBlockReason: disabled and degenerate inputs never block", () => {
    assert.equal(mcapRatioBlockReason(297569, 16510, 0), null);
    assert.equal(mcapRatioBlockReason(297569, 16510, -1), null);
    // Zero/missing mcap or liquidity -> not this gate’s call (the liquidity
    // floor rejects those earlier); never divide-by-zero.
    assert.equal(mcapRatioBlockReason(0, 16510, 10), null);
    assert.equal(mcapRatioBlockReason(297569, 0, 10), null);
    assert.equal(mcapRatioBlockReason(NaN, 16510, 10), null);
  });

  await test("loadConfig: MCAP_LIQ_RATIO_MAX default 10, 0 disables, garbage falls back to disabled", () => {
    assert.equal(loadConfig({}).mcapLiqRatioMax, 10);
    assert.equal(loadConfig({ MCAP_LIQ_RATIO_MAX: "12" }).mcapLiqRatioMax, 12);
    assert.equal(loadConfig({ MCAP_LIQ_RATIO_MAX: "0" }).mcapLiqRatioMax, 0);
    assert.equal(loadConfig({ MCAP_LIQ_RATIO_MAX: "-3" }).mcapLiqRatioMax, 0);
    assert.equal(loadConfig({ MCAP_LIQ_RATIO_MAX: "abc" }).mcapLiqRatioMax, 0);
  });
  await test("loadConfig: GMGN_ENABLED master switch defaults on, 0/false disables", () => {
    assert.equal(loadConfig({}).gmgnEnabled, true);
    assert.equal(loadConfig({ GMGN_ENABLED: "1" }).gmgnEnabled, true);
    assert.equal(loadConfig({ GMGN_ENABLED: "0" }).gmgnEnabled, false);
    assert.equal(loadConfig({ GMGN_ENABLED: "false" }).gmgnEnabled, false);
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


  // ---------- unwatch button on push cards ----------
  await test("tradeKeyboard: unwatch opt adds stop-tracking row; absent by default", () => {
    const base = tradeKeyboard("MINT111", "\$1", "off");
    assert.equal(base.some((r) => r.some((b) => b.callback_data === "unwatch:MINT111")), false);
    const withUnwatch = tradeKeyboard("MINT111", "\$1", "manual", { modeSwitch: true, unwatch: true });
    const flat = withUnwatch.flat();
    assert.ok(flat.some((b) => b.text === "🔕 停止追蹤" && b.callback_data === "unwatch:MINT111"));
    assert.ok(flat.some((b) => (b.url || "").includes("MINT111")));
    assert.ok(flat.some((b) => b.callback_data === "mode:toggle:MINT111"));
  });

  // ---------- cross-isolate duplicate-alert guard ----------
  await test("claimPushWatch CAS: exactly one overlapping tick wins", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.upsertPushWatch({
        token: "MINTCLAIM", chatId: "c1", symbol: "CLAIM",
        pushedAt: Date.now(), mcapAtPush: 100000, liquidityUsd: 20000,
      });
      const [row] = await db.listPushWatch(10);
      // Isolate A reads lastChecked=0; isolate B reads the same snapshot.
      // A claims with the expected stamp -> true; B's identical claim loses
      // (last_checked moved) -> false. No double alert.
      const aWon = await db.claimPushWatch("MINTCLAIM", row.lastChecked, 111);
      const bLost = await db.claimPushWatch("MINTCLAIM", row.lastChecked, 222);
      assert.equal(aWon, true);
      assert.equal(bLost, false);
      // Next tick: B re-reads the fresh stamp and wins.
      const [row2] = await db.listPushWatch(10);
      assert.equal(await db.claimPushWatch("MINTCLAIM", row2.lastChecked, 333), true);
      // Wrong expected stamp never claims.
      assert.equal(await db.claimPushWatch("MINTCLAIM", 999, 444), false);
    } finally { t.cleanup(); }
  });

  await test("markRecapClaimed: recap sent once; unwatched rows stay silent", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      for (const [tok, sym] of [["MINTR1","R1"],["MINTR2","R2"]]) {
        await db.upsertPushWatch({
          token: tok, chatId: "c1", symbol: sym,
          pushedAt: Date.now(), mcapAtPush: 100000, liquidityUsd: 20000,
        });
      }
      await db.setPushWatchState("MINTR2", "unwatched");
      // First claim delivers; second claim (overlapping tick) is refused.
      assert.equal(await db.markRecapClaimed("MINTR1"), true);
      assert.equal(await db.markRecapClaimed("MINTR1"), false);
      // Tombstoned coin opted out of follow-ups — no recap either.
      assert.equal(await db.markRecapClaimed("MINTR2"), false);
    } finally { t.cleanup(); }
  });

  // ---------- alert reservation closes the mid-write race ----------
  await test("reservePushWatchAlert: loser reading between claim and write is blocked", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.upsertPushWatch({
        token: "MINTRES", chatId: "c1", symbol: "RES",
        pushedAt: Date.now(), mcapAtPush: 100000, liquidityUsd: 20000,
      });
      const [snap] = await db.listPushWatch(10);
      // Isolate A: claim wins, then reserves the transition BEFORE sending.
      await db.claimPushWatch("MINTRES", snap.lastChecked, 5000);
      const aWon = await db.reservePushWatchAlert(
        "MINTRES", snap.lastState ?? null, snap.lastAlertAt ?? 0, "holder50", 5000,
      );
      assert.equal(aWon, true);
      // Isolate B reads BETWEEN A's claim and A's final write: it sees the
      // claimed last_checked=5000 (its own claim would succeed) but still
      // the pre-alert (state, alertAt). Its reservation must LOSE.
      const bClaimOk = await db.claimPushWatch("MINTRES", 5000, 6000);
      assert.equal(bClaimOk, true, "B inherits A's claimed stamp");
      const bLost = await db.reservePushWatchAlert(
        "MINTRES", snap.lastState ?? null, snap.lastAlertAt ?? 0, "holder50", 5000,
      );
      assert.equal(bLost, false);
      // Same-state alerts (🩸 streak): to == from, but the bumped
      // last_alert_at still latches — second fire from the same snapshot loses.
      const [mid] = await db.listPushWatch(10);
      const s1 = await db.reservePushWatchAlert(
        "MINTRES", "holder50", 5000, "holder50", 7000,
      );
      const s2 = await db.reservePushWatchAlert(
        "MINTRES", "holder50", 5000, "holder50", 8000,
      );
      assert.equal(s1, true);
      assert.equal(s2, false);
      assert.notEqual(mid, undefined);
    } finally { t.cleanup(); }
  });

  // ---------- duplicate push-card guard ----------
  await test("claimTokenPush: overlapping scans deliver the card exactly once", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // Both isolates pass the isTokenSeen check (nothing marked yet), then
      // race to claim. INSERT OR IGNORE lets exactly one win.
      const aWon = await db.claimTokenPush("c1", "TRILLYMINT");
      const bLost = await db.claimTokenPush("c1", "TRILLYMINT");
      assert.equal(aWon, true);
      assert.equal(bLost, false);
      // Different chat is an independent slot (per-chat dedupe preserved).
      assert.equal(await db.claimTokenPush("c2", "TRILLYMINT"), true);
      // Failed delivery releases the claim so a later scan can retry.
      await db.unclaimTokenPush("c1", "TRILLYMINT");
      assert.equal(await db.isTokenSeen("c1", "TRILLYMINT"), false);
      assert.equal(await db.claimTokenPush("c1", "TRILLYMINT"), true);
    } finally { t.cleanup(); }
  });

  // ---------- unwatch tombstone vs self-heal ----------
  await test("setPushWatchState tombstones a row so findUntrackedPushes skips it", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.upsertPushWatch({
        token: "MINTTOMB", chatId: "c1", symbol: "TOMB",
        pushedAt: Date.now(), mcapAtPush: 100000, liquidityUsd: 20000,
      });
      // Plain DELETE is what the self-heal undoes; the tombstone must keep
      // the row present so NOT EXISTS in findUntrackedPushes stays false.
      await db.setPushWatchState("MINTTOMB", "unwatched");
      const rows = await db.listPushWatch(10);
      const row = rows.find((r) => r.token === "MINTTOMB");
      assert.ok(row, "row still present after tombstone");
      assert.equal(row.lastState, "unwatched");
      const missing = await db.findUntrackedPushes(Date.now() - 3600_000, 10);
      assert.equal(missing.some((m) => m.token === "MINTTOMB"), false);
    } finally { t.cleanup(); }
  });

  await test("newWalletBlockReason: Cheems shape blocked, healthy mixes pass", () => {
    // The complaint: 8 profiled top holders, all 8 brand-new → block.
    assert.match(newWalletBlockReason(8, 8, 0.8, 5), /8\/8/);
    // 7/8 fresh also clears the 0.8 line.
    assert.match(newWalletBlockReason(8, 7, 0.8, 5), /7\/8/);
    // Mixed holder bases pass.
    assert.equal(newWalletBlockReason(10, 4, 0.8, 5), null);
    assert.equal(newWalletBlockReason(12, 6, 0.8, 5), null);
    // Boundary: exactly at ratio passes (strict >).
    assert.equal(newWalletBlockReason(5, 4, 0.8, 5), null);
    // Too few wallets profiled — no verdict either way.
    assert.equal(newWalletBlockReason(4, 4, 0.8, 5), null);
    assert.equal(newWalletBlockReason(0, 0, 0.8, 5), null);
    // Disabled.
    assert.equal(newWalletBlockReason(8, 8, 0, 5), null);
  });

  await test("top10MinBlockReason: MCGA shape blocked, healthy concentration passes", () => {
    // The complaint: MCGA pushed with 2.2% top-10 -> block.
    assert.match(top10MinBlockReason(2.2, 10), /2\.2% < 10%/);
    // Below the line blocks; exactly at the line passes (strict <).
    assert.match(top10MinBlockReason(9.9, 10), /9\.9%/);
    assert.equal(top10MinBlockReason(10.0, 10), null);
    // Healthy concentrations pass.
    assert.equal(top10MinBlockReason(18.8, 10), null);
    assert.equal(top10MinBlockReason(32.3, 10), null);
    // Missing data never judges (card shows untested).
    assert.equal(top10MinBlockReason(null, 10), null);
    // Disabled.
    assert.equal(top10MinBlockReason(2.2, 0), null);
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
