/*
 * The card-send outbox (2026-10-18, docs/round-trips.md §4.70).
 *
 * WHAT IS PINNED, and why each half matters:
 *   1. The policy table in src/pushoutbox.ts, as pure functions: a delivery
 *      audit beats everything (never re-send a card that delivered), the
 *      attempt/TTL budget ends an obligation, a transient failure backs off and
 *      a permanent rejection does not retry at all.
 *   2. The D1 half: enqueue → due → note/delete, INSERT OR REPLACE semantics
 *      (a later failure replaces the obligation instead of stacking two cards)
 *      and the pending count the /health view publishes.
 *   3. The DRAIN, driven through the real Scanner (a stub bot, a local
 *      database): a delivered card audits/keeps its claim and retires the row;
 *      a transient failure releases the claim and backs off; a 4xx drops the
 *      row; an existing delivery proof retires it without a send; a claim held
 *      by another sender is never touched.
 *   4. The WIRING, pinned on the source because the failure it prevents is
 *      invisible live: the scan must carry no in-tick retry any more (the
 *      `sleep(1200)` path this change replaced) and must enqueue instead, and
 *      the tracker invocation must drain before it runs its pass.
 *
 * Run: node scripts/test-push-outbox.js
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const { Db, parseAuditOrganic } = require("../dist/db.js");
const { Scanner } = require("../dist/scanner.js");
const { DexScreenerClient } = require("../dist/dexscreener.js");
const { loadConfig } = require("../dist/config.js");
const {
  PUSH_OUTBOX_DRAIN_MAX,
  PUSH_OUTBOX_MAX_ATTEMPTS,
  PUSH_OUTBOX_RETRY_DELAY_MS,
  PUSH_OUTBOX_TTL_MS,
  pushOutboxAfterFailure,
  pushOutboxExhausted,
  pushOutboxPreClaim,
  pushOutboxRetryDelayMs,
} = require("../dist/pushoutbox.js");

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
  const p = path.join(
    os.tmpdir(),
    `push-outbox-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const client = createClient({ url: `file:${p}` });
  return {
    p,
    client,
    cleanup: async () => {
      await client.close();
      try {
        fs.unlinkSync(p);
      } catch {}
    },
  };
}

/** A row shaped like the drain reads one, with every field overridable. */
function row(over = {}) {
  const now = 1_700_000_000_000;
  return {
    chatId: "chat-1",
    token: "tok-1",
    symbol: "T1",
    message: "<b>T1</b> card",
    keyboard: null,
    mcap: 70000,
    liquidity: 12000,
    pool: "pool-1",
    organic: null,
    attempts: 0,
    nextAt: now,
    expiresAt: now + PUSH_OUTBOX_TTL_MS,
    createdAt: now,
    lastError: null,
    ...over,
  };
}

async function main() {
  // ---------- the policy, as pure functions ----------

  await test("constants: attempts 3, delays monotonic, one drain is a burst bound", () => {
    assert.equal(PUSH_OUTBOX_MAX_ATTEMPTS, 3);
    assert.equal(PUSH_OUTBOX_DRAIN_MAX, 3);
    assert.equal(PUSH_OUTBOX_TTL_MS, 600_000);
    assert.equal(PUSH_OUTBOX_RETRY_DELAY_MS.length, PUSH_OUTBOX_MAX_ATTEMPTS);
    for (let i = 1; i < PUSH_OUTBOX_RETRY_DELAY_MS.length; i++) {
      assert.ok(
        PUSH_OUTBOX_RETRY_DELAY_MS[i] > PUSH_OUTBOX_RETRY_DELAY_MS[i - 1],
        "each retry waits longer than the one before it",
      );
    }
    assert.equal(pushOutboxRetryDelayMs(0), 0, "the first send is due immediately");
    assert.equal(pushOutboxRetryDelayMs(1), 60_000);
    assert.equal(pushOutboxRetryDelayMs(99), 120_000, "clamped to the last step");
  });

  await test("pre-claim: the delivery audit beats everything (never re-send a delivered card)", () => {
    const now = 1_700_000_000_000;
    assert.equal(pushOutboxPreClaim(row({ attempts: 5 }), now, true), "drop-delivered");
    assert.equal(pushOutboxPreClaim(row(), now, false), "attempt");
  });

  await test("pre-claim: attempts and TTL both exhaust an obligation", () => {
    const now = 1_700_000_000_000;
    assert.equal(
      pushOutboxPreClaim(row({ attempts: PUSH_OUTBOX_MAX_ATTEMPTS }), now, false),
      "give-up",
    );
    assert.equal(
      pushOutboxPreClaim(row({ expiresAt: now - 1 }), now, false),
      "give-up",
      "TTL expires even with attempts left",
    );
    assert.equal(pushOutboxExhausted(row(), now), false);
  });

  await test("after-failure: transient backs off, permanent does not retry", () => {
    const now = 1_700_000_000_000;
    const first = pushOutboxAfterFailure(row(), now, true);
    assert.deepEqual(first, { attempts: 1, nextAt: now + 60_000, retry: true });

    const permanent = pushOutboxAfterFailure(row(), now, false);
    assert.equal(permanent.retry, false, "a 4xx is not retried");
    assert.equal(permanent.attempts, 1);

    const last = pushOutboxAfterFailure(
      row({ attempts: PUSH_OUTBOX_MAX_ATTEMPTS - 1 }),
      now,
      true,
    );
    assert.equal(last.retry, false, "the third attempt is the last");
    assert.equal(last.attempts, PUSH_OUTBOX_MAX_ATTEMPTS);

    const stale = pushOutboxAfterFailure(row({ expiresAt: now - 1 }), now, true);
    assert.equal(stale.retry, false, "TTL closes a row mid retry chain");
  });

  await test("parseAuditOrganic: round-trips the audit object, malformed is no audit", () => {
    const audit = {
      score: 42.5,
      tradersH1: 120,
      tradersWindow: "1h",
      why: "late",
      waited: true,
    };
    assert.deepEqual(parseAuditOrganic(JSON.stringify(audit)), audit);
    assert.deepEqual(
      parseAuditOrganic(JSON.stringify({ score: null, why: 7, waited: "yes" })),
      { score: null, tradersH1: null, tradersWindow: null, why: null, waited: false },
      "wrong types degrade field by field, never throwing",
    );
    assert.equal(parseAuditOrganic(null), undefined);
    assert.equal(parseAuditOrganic(""), undefined);
    assert.equal(parseAuditOrganic("{not json"), undefined);
  });

  // ---------- the D1 half ----------

  await test("db.init creates push_outbox (and the index its drain orders by)", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const names = (
        await t.client.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
      ).rows.map((r) => r.name);
      assert.ok(names.includes("push_outbox"), "the table must exist after init");
      const idx = (
        await t.client.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
      ).rows.map((r) => r.name);
      assert.ok(idx.includes("idx_push_outbox_next"), "the due query needs its index");
    } finally {
      await t.cleanup();
    }
  });

  await test("enqueue → due: the row is immediately due, whole, and counted pending", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const createdAt = 1_700_000_000_000;
      await db.enqueuePushOutbox({
        chatId: "chat-1",
        token: "tok-1",
        symbol: "T1",
        message: "<b>T1</b> card",
        keyboard: '{"inline_keyboard":[[{"text":"BUY"}]]}',
        mcap: 70000,
        liquidity: 12000,
        pool: "pool-1",
        organic: JSON.stringify({ score: 42.5, tradersH1: 120, tradersWindow: "1h", why: "ok", waited: false }),
        error: "Telegram 500: oops",
        createdAt,
      });
      const due = await db.duePushOutbox(createdAt, PUSH_OUTBOX_DRAIN_MAX);
      assert.equal(due.rows.length, 1);
      assert.equal(due.pending, 1);
      assert.deepEqual(due.rows[0], {
        chatId: "chat-1",
        token: "tok-1",
        symbol: "T1",
        message: "<b>T1</b> card",
        keyboard: '{"inline_keyboard":[[{"text":"BUY"}]]}',
        mcap: 70000,
        liquidity: 12000,
        pool: "pool-1",
        organic: JSON.stringify({ score: 42.5, tradersH1: 120, tradersWindow: "1h", why: "ok", waited: false }),
        attempts: 0,
        nextAt: createdAt,
        expiresAt: createdAt + PUSH_OUTBOX_TTL_MS,
        createdAt,
        lastError: "Telegram 500: oops",
      });
    } finally {
      await t.cleanup();
    }
  });

  await test("enqueue REPLACES a later failure (latest render, attempts reset)", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const first = 1_700_000_000_000;
      const enqueue = (createdAt, message, error) =>
        db.enqueuePushOutbox({
          chatId: "chat-1",
          token: "tok-1",
          symbol: "T1",
          message,
          keyboard: null,
          mcap: 70000,
          liquidity: 12000,
          pool: null,
          organic: null,
          error,
          createdAt,
        });
      await enqueue(first, "first card", "first");
      await db.notePushOutboxAttempt("chat-1", "tok-1", 2, first + 999_999, "retry-1");
      await enqueue(first + 60_000, "second card", "second");
      const due = await db.duePushOutbox(first + 60_000, PUSH_OUTBOX_DRAIN_MAX);
      assert.equal(due.rows.length, 1);
      assert.equal(due.rows[0].message, "second card", "the obligation is the latest render");
      assert.equal(due.rows[0].attempts, 0, "a new failure cycle restarts the budget");
      assert.equal(due.rows[0].lastError, "second");
      assert.equal(due.pending, 1, "replace, not stack");
    } finally {
      await t.cleanup();
    }
  });

  await test("due: respects next_at, note/delete move the row", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const at = 1_700_000_000_000;
      await db.enqueuePushOutbox({
        chatId: "chat-1",
        token: "tok-1",
        symbol: null,
        message: "card",
        keyboard: null,
        mcap: null,
        liquidity: null,
        pool: null,
        organic: null,
        error: null,
        createdAt: at,
      });
      await db.notePushOutboxAttempt("chat-1", "tok-1", 1, at + 60_000, "Telegram 500");
      const now = await db.duePushOutbox(at + 30_000, PUSH_OUTBOX_DRAIN_MAX);
      assert.equal(now.rows.length, 0, "a backed-off row is not due");
      assert.equal(now.pending, 1, "but it is still pending — the reading /health serves");
      const later = await db.duePushOutbox(at + 60_000, PUSH_OUTBOX_DRAIN_MAX);
      assert.equal(later.rows.length, 1);
      assert.equal(later.rows[0].attempts, 1);
      assert.equal(later.rows[0].lastError, "Telegram 500");
      await db.deletePushOutbox("chat-1", "tok-1");
      const gone = await db.duePushOutbox(at + 60_000, PUSH_OUTBOX_DRAIN_MAX);
      assert.equal(gone.rows.length, 0);
      assert.equal(gone.pending, 0);
    } finally {
      await t.cleanup();
    }
  });

  await test("due: oldest first, bounded by the caller's limit", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const at = 1_700_000_000_000;
      for (let i = 0; i < 4; i++) {
        await db.enqueuePushOutbox({
          chatId: "chat-1",
          token: `tok-${i}`,
          symbol: null,
          message: `card ${i}`,
          keyboard: null,
          mcap: null,
          liquidity: null,
          pool: null,
          organic: null,
          error: null,
          createdAt: at + i,
        });
      }
      const due = await db.duePushOutbox(at + 10, 2);
      assert.deepEqual(
        due.rows.map((r) => r.token),
        ["tok-0", "tok-1"],
      );
      assert.equal(due.pending, 4);
    } finally {
      await t.cleanup();
    }
  });

  await test("audit proof is what the drain's first rule reads (initial only)", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.recordPushDelivery({
        chatId: "chat-1",
        token: "tok-1",
        symbol: "T1",
        messageId: 1,
        kind: "initial",
      });
      await db.recordPushDelivery({
        chatId: "chat-1",
        token: "tok-2",
        symbol: "T2",
        messageId: 2,
        kind: "followup",
        sig: "dead",
      });
      const proofs = await db.getInitialPushAuditTokens();
      assert.equal(proofs.has("tok-1"), true);
      assert.equal(proofs.has("tok-2"), false, "a follow-up is not proof of the first card");
    } finally {
      await t.cleanup();
    }
  });

  // ---------- the drain, end to end (real Scanner, stub bot) ----------

  /** One Scanner over a fresh local database; `sendMessage` is the whole bot. */
  async function drainHarness(sendMessage) {
    const t = tmpDb();
    const db = new Db(t.p, undefined, t.client);
    await db.init();
    const cfg = loadConfig({});
    const dex = new DexScreenerClient(cfg);
    const scanner = new Scanner(
      db,
      { api: { sendMessage } },
      dex,
      cfg,
      null,
      null,
      null,
    );
    return { t, db, scanner, cleanup: t.cleanup };
  }

  /** The obligation a failed tick would have written, with every field set. */
  async function enqueueCard(db, createdAt, over = {}) {
    await db.enqueuePushOutbox({
      chatId: "chat-1",
      token: "tok-1",
      symbol: "T1",
      message: "<b>T1</b> the card",
      keyboard: '{"inline_keyboard":[[{"text":"BUY"}]]}',
      mcap: 70000,
      liquidity: 12000,
      pool: "pool-1",
      organic: JSON.stringify({
        score: 42.5,
        tradersH1: 120,
        tradersWindow: "1h",
        why: "ok",
        waited: false,
      }),
      error: "Telegram 500: oops",
      createdAt,
      ...over,
    });
  }

  await test("drain: a delivered card audits, keeps its claim, enrolls and retires the row", async () => {
    const calls = [];
    const h = await drainHarness(async (chatId, message, opts) => {
      calls.push({ chatId, message, opts });
      return { message_id: 4242 };
    });
    try {
      await enqueueCard(h.db, Date.now());
      const view = await h.scanner.drainPushOutbox(Date.now() + 5_000);
      assert.equal(view.sent, 1);
      assert.equal(view.due, 1);
      assert.equal(view.pending, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].chatId, "chat-1");
      assert.equal(calls[0].message, "<b>T1</b> the card", "the retried card is the stored artifact");
      assert.deepEqual(
        calls[0].opts,
        { reply_markup: { inline_keyboard: [[{ text: "BUY" }]] } },
        "and it carries the buttons the failed send built",
      );
      assert.equal(
        await h.db.isTokenSeen("chat-1", "tok-1"),
        true,
        "the claim stays: the card was delivered",
      );
      const proof = await h.db.getInitialPushAuditTokens();
      assert.equal(proof.has("tok-1"), true, "delivery is audited");
      const watch = await h.t.client.execute(
        "SELECT COUNT(*) AS n FROM push_watch WHERE token = 'tok-1'",
      );
      assert.equal(Number(watch.rows[0].n), 1, "the follow-up tracker is enrolled");
      const left = await h.db.duePushOutbox(Date.now() + 10 * 60_000, 5);
      assert.equal(left.pending, 0, "the obligation is retired");
    } finally {
      await h.cleanup();
    }
  });

  await test("drain: a transient failure releases the claim and backs the row off", async () => {
    const h = await drainHarness(async () => {
      const err = new Error("boom");
      err.error_code = 500;
      err.description = "boom";
      throw err;
    });
    try {
      await enqueueCard(h.db, Date.now());
      const view = await h.scanner.drainPushOutbox(Date.now() + 5_000);
      assert.equal(view.retried, 1);
      assert.equal(view.sent, 0);
      assert.equal(
        await h.db.isTokenSeen("chat-1", "tok-1"),
        false,
        "a failed send leaves the coin unseen for BOTH retry owners",
      );
      const due = await h.db.duePushOutbox(Date.now() + 30_000, 5);
      assert.equal(due.rows.length, 0, "the row waits out its backoff");
      assert.equal(due.pending, 1, "but it is still owed");
      const later = await h.db.duePushOutbox(Date.now() + 60_000, 5);
      assert.equal(later.rows.length, 1);
      assert.equal(later.rows[0].attempts, 1);
      assert.match(String(later.rows[0].lastError), /Telegram 500/);
    } finally {
      await h.cleanup();
    }
  });

  await test("drain: a permanent rejection drops the row and does not retry", async () => {
    const h = await drainHarness(async () => {
      const err = new Error("chat not found");
      err.error_code = 400;
      err.description = "Bad Request: chat not found";
      throw err;
    });
    try {
      await enqueueCard(h.db, Date.now());
      const view = await h.scanner.drainPushOutbox(Date.now() + 5_000);
      assert.equal(view.rejected, 1);
      assert.equal(view.retried, 0);
      const left = await h.db.duePushOutbox(Date.now() + 10 * 60_000, 5);
      assert.equal(left.pending, 0, "a 4xx is not retried by the outbox");
      assert.equal(await h.db.isTokenSeen("chat-1", "tok-1"), false, "the pool still owns the coin");
    } finally {
      await h.cleanup();
    }
  });

  await test("drain: an existing delivery proof retires the row WITHOUT a send", async () => {
    let sends = 0;
    const h = await drainHarness(async () => {
      sends++;
      return { message_id: 1 };
    });
    try {
      await enqueueCard(h.db, Date.now());
      await h.db.recordPushDelivery({
        chatId: "chat-1",
        token: "tok-1",
        symbol: "T1",
        messageId: 99,
        kind: "initial",
      });
      const view = await h.scanner.drainPushOutbox(Date.now() + 5_000);
      assert.equal(view.delivered, 1);
      assert.equal(sends, 0, "the card already delivered — re-sending it is the duplicate this outbox exists to avoid");
      const left = await h.db.duePushOutbox(Date.now() + 10 * 60_000, 5);
      assert.equal(left.pending, 0);
    } finally {
      await h.cleanup();
    }
  });

  await test("drain: a claim held by another sender is deferred, never stolen", async () => {
    let sends = 0;
    const h = await drainHarness(async () => {
      sends++;
      return { message_id: 1 };
    });
    try {
      await enqueueCard(h.db, Date.now());
      await h.db.claimTokenPush("chat-1", "tok-1"); // the re-eval pool won the race
      const view = await h.scanner.drainPushOutbox(Date.now() + 5_000);
      assert.equal(view.deferred, 1);
      assert.equal(sends, 0, "the drain must not send under a claim it did not take");
      assert.equal(
        await h.db.isTokenSeen("chat-1", "tok-1"),
        true,
        "and it must not release the other sender's claim either",
      );
      assert.equal((await h.db.duePushOutbox(Date.now() + 10 * 60_000, 5)).pending, 1);
    } finally {
      await h.cleanup();
    }
  });

  await test("drain: an exhausted row is given up with no claim touched and no send", async () => {
    let sends = 0;
    const h = await drainHarness(async () => {
      sends++;
      return { message_id: 1 };
    });
    try {
      await enqueueCard(h.db, Date.now());
      await h.db.notePushOutboxAttempt("chat-1", "tok-1", 3, Date.now(), "Telegram 500");
      const view = await h.scanner.drainPushOutbox(Date.now() + 5_000);
      assert.equal(view.gaveUp, 1);
      assert.equal(sends, 0);
      assert.equal(await h.db.isTokenSeen("chat-1", "tok-1"), false);
      assert.equal((await h.db.duePushOutbox(Date.now() + 10 * 60_000, 5)).pending, 0);
    } finally {
      await h.cleanup();
    }
  });

  await test("drain: a quiet outbox returns null (no view write), a due one does not", async () => {
    const h = await drainHarness(async () => ({ message_id: 1 }));
    try {
      assert.equal(await h.scanner.drainPushOutbox(Date.now() + 5_000), null);
      await enqueueCard(h.db, Date.now());
      const view = await h.scanner.drainPushOutbox(Date.now() + 5_000);
      assert.ok(view, "a non-empty outbox must publish its drain");
      assert.equal(view.via, "cron-pass");
    } finally {
      await h.cleanup();
    }
  });

  // ---------- the tick that fails, end to end ----------

  /**
   * Gate settings that let a fixture coin qualify (every gate zero) — the same
   * shape scripts/test-unconfirmed-cards.js drives its real ticks with.
   */
  const ZERO_GATES = {
    minLiquidityUsd: 0,
    minVolume24hUsd: 0,
    minMarketCapUsd: 0,
    maxMarketCapUsd: 10_000_000,
    minAgeMinutes: 0,
    maxAgeMinutes: 100_000,
    min5mVolUsd: 0,
    min1hVolUsd: 0,
    min5mChgPct: 0,
    min1hChgPct: 0,
    enabled: true,
  };

  /** A pair that passes every gate, for whatever mint the tick is handed. */
  function qualifyingPair(mint) {
    return {
      chainId: "solana",
      url: `https://dexscreener.com/solana/${mint}P`,
      pairAddress: `${mint}P`,
      baseToken: { address: mint, name: "Outbox Coin", symbol: "OUT" },
      priceUsd: "0.001",
      marketCap: 100_000,
      volume: { h24: 500_000, h1: 60_000, m5: 9_000 },
      priceChange: { m5: 40, h1: 60 },
      txns: { m5Buys: 80, m5Sells: 60, h1Buys: 900, h1Sells: 700 },
      liquidity: { usd: 20_000 },
      pairCreatedAt: Date.now() - 60 * 60_000,
    };
  }

  /** The discovery feed: the one coin the tick is about to push. */
  function stubFeed(mint) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify([{ chainId: "solana", tokenAddress: mint, symbol: "OUT" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
  }

  await test("tick: a transient send failure sends ONCE and leaves a durable obligation", async () => {
    const cfg = loadConfig({});
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.saveChatSettings({ chatId: "chat-out", ...ZERO_GATES });
      const dex = new DexScreenerClient(cfg);
      dex.fetchPairsForTokens = async () => new Map([["OUTMINT", qualifyingPair("OUTMINT")]]);
      stubFeed("OUTMINT");
      let sends = 0;
      const scanner = new Scanner(
        db,
        {
          api: {
            sendMessage: async () => {
              sends++;
              const err = new Error("boom");
              err.error_code = 500;
              err.description = "Internal Server Error";
              throw err;
            },
          },
        },
        dex,
        cfg,
        null,
        null,
        null,
      );
      await scanner.runOnce();
      assert.equal(scanner.lastSummary.pushed, 0, "nothing delivered");
      assert.equal(
        sends,
        1,
        "the tick must send ONCE — the old `sleep(1200)` retry is what the outbox replaced",
      );
      const due = await db.duePushOutbox(Date.now(), 5);
      assert.equal(due.rows.length, 1, "the failed card is a durable obligation");
      assert.equal(due.rows[0].chatId, "chat-out");
      assert.equal(due.rows[0].token, "OUTMINT");
      assert.equal(due.rows[0].attempts, 0, "the tick's own failure is attempt 0");
      assert.match(due.rows[0].message, /OUT/, "the rendered card rides the row");
      assert.ok(
        String(due.rows[0].keyboard).includes("inline_keyboard"),
        "with the buttons the failed send built",
      );
      assert.equal(
        await db.isTokenSeen("chat-out", "OUTMINT"),
        false,
        "and the claim is back in play for both retry owners",
      );
    } finally {
      await t.cleanup();
    }
  });

  // ---------- the wiring (source pins, the shape this repo uses) ----------

  await test("scanner: the in-tick retry is gone and the outbox is wired in its place", () => {
    const scannerSrc = fs.readFileSync(
      path.join(__dirname, "..", "src", "scanner.ts"),
      "utf8",
    );
    assert.ok(
      !scannerSrc.includes("await sleep(1200)"),
      "the same-tick retry must not come back — it is the thing the outbox replaced",
    );
    assert.ok(!scannerSrc.includes("function sleep(ms"), "and its helper is gone with it");
    assert.ok(
      scannerSrc.includes("await this.enqueueCardOutbox(c, {"),
      "the transient branch must enqueue the durable retry",
    );
    assert.ok(
      scannerSrc.includes("async drainPushOutbox("),
      "the drain must exist on the scanner",
    );
  });

  await test("worker: the tracker cron drains the outbox and /health serves its view", () => {
    const strip = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\s+/g, "");
    const workerSrc = strip(
      fs.readFileSync(path.join(__dirname, "..", "src", "worker.ts"), "utf8"),
    );
    assert.ok(
      workerSrc.includes("awaitscanner.drainPushOutbox("),
      "runTrackerInvocation must drain before its pass",
    );
    assert.ok(
      workerSrc.includes("db.setWorkerState(PUSH_OUTBOX_STATE_KEY,JSON.stringify(view))"),
      "the drain's view must be persisted for /health",
    );
    assert.ok(
      workerSrc.includes("PUSH_OUTBOX_STATE_KEY,") &&
        workerSrc.includes("pushOutbox,"),
      "the view must ride the health front's read and its payload",
    );
  });

  await test("package.json: this suite is part of test:unit (a dropped file is silent)", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
    );
    assert.ok(
      pkg.scripts["test:unit"].includes("node scripts/test-push-outbox.js"),
      "test:unit must run this file",
    );
  });

  for (const line of results) console.log(line);
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
