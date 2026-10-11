/*
 * Offline tests — no network, no secrets. Run with `npm run test:unit` (after
 * `npm run build`), which chains this file with the rest.
 *
 * THE THREE-STATE CARD SEND (2026-10-11). The send used to be two-state:
 * `bestEffort(send, deadline, null)` returned either Telegram's message or
 * `null`, and `null` was read as "not delivered" — so a card that was already
 * on its way to Telegram had its `seen_tokens` claim deleted and the next tick
 * pushed the same coin again. Live 2026-10-11: ALON arrived three times, the
 * two extra cards with NO audit row at all (msgIds 11467/11468 in the gap
 * before the recorded 11469).
 *
 * The fix has three pieces, and the rule-level half (cardSendDisposition,
 * addUnconfirmedCardSend, settleUnconfirmedCardSends) is pinned in
 * scripts/test-unit.js. These are the pieces that rule was never wired to:
 *   1. the scanner's send path — an ABANDONED send keeps its claim and records
 *      the unknown delivery durably (never unclaims);
 *   2. the worker's tick tail — that record is settled from the proofs the tail
 *      already reads: proof keeps the claim, silence past the grace releases it;
 *   3. the heartbeat — `pending` / `releasedTotal`, so a withheld card and a
 *      release without proof are readable in /health instead of only in the
 *      operator's chat.
 *
 * The end-to-end case drives a REAL tick (one candidate, one enabled chat, a
 * send that never answers) so the cut branch, the durable record and the claim
 * are all asserted through the code the worker actually runs.
 */
const assert = require("node:assert/strict");
const { createClient } = require("@libsql/client");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Db } = require("../dist/db.js");
const { Scanner } = require("../dist/scanner.js");
const { DexScreenerClient } = require("../dist/dexscreener.js");
const { loadConfig } = require("../dist/config.js");
const {
  parseUnconfirmedCardSends,
  serializeUnconfirmedCardSends,
  UNCONFIRMED_CARD_STATE_KEY,
} = require("../dist/deferrallog.js");
const { noteUnconfirmedCards, unconfirmedCardsView } = require("../dist/tickprobe.js");

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
    `unconfirmed-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

/**
 * Gate settings that let a fixture coin qualify (every gate zero, so only the
 * chain runs) — the shape the chain-floor cases in
 * scripts/test-deferred-priority.js use.
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
function cutPair(mint) {
  return {
    chainId: "solana",
    url: `https://dexscreener.com/solana/${mint}P`,
    pairAddress: `${mint}P`,
    baseToken: { address: mint, name: "Cut Coin", symbol: "CUT" },
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
function stubCutFeed(mint) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ chainId: "solana", tokenAddress: mint, symbol: "CUT" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
}

async function main() {
  // ---------- the worker's tick tail settles the record ----------
  // The record a cut send wrote is resolved HERE, out of the proofs the tail
  // already reads (the delivery audit ring, the push ledger, the watch rows).
  // Both endings are asserted through seen_tokens itself: the claim state IS
  // the decision, and it is the one thing the re-eval pool asks about.
  await test("worker: an abandoned card's claim is kept on proof and released on silence", async () => {
    const t = tmpDb();
    const now = Date.now();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // Every read/write that MENTIONS the ring row — so the assertions below
      // are about the ring's own cost, not about whatever telemetry happens to
      // be due on this tail.
      const ring = { reads: 0, writes: 0 };
      const watchRing = (stmts) => {
        for (const s of stmts ?? []) {
          if (!(s.args ?? []).includes(UNCONFIRMED_CARD_STATE_KEY)) continue;
          if (/^\s*select/i.test(String(s.sql ?? ""))) ring.reads += 1;
          else ring.writes += 1;
        }
      };
      const watching = {
        execute: (a) => {
          watchRing([a]);
          return t.client.execute(a);
        },
        batch: (a, m) => {
          watchRing(a);
          return t.client.batch(a, m);
        },
        close: () => t.client.close(),
      };
      const taildb = new Db(t.p, undefined, watching);
      await taildb.init();
      const { syncPushDeferralCounters } = require("../dist/worker.js");
      const tick = (at) =>
        syncPushDeferralCounters(
          { pushPhase: "done", candidates: 0, pushed: 0, cardSendDeferred: 0, deferPending: 0 },
          taildb,
          at,
        );
      // Two abandoned sends of the same age, one of them proven by the very ring
      // the duplicate guard reads anyway.
      await db.claimTokenPush("c", "PROVEN");
      await db.claimTokenPush("c", "SILENT");
      await db.setWorkerState(
        UNCONFIRMED_CARD_STATE_KEY,
        serializeUnconfirmedCardSends([
          { chatId: "c", token: "PROVEN", at: now - 130_000, symbol: "P" },
          { chatId: "c", token: "SILENT", at: now - 130_000, symbol: "S" },
        ]),
      );
      await db.setWorkerState(
        "push_audit",
        JSON.stringify([
          { chatId: "c", token: "PROVEN", symbol: "P", messageId: 9, kind: "initial", at: now - 129_000 },
        ]),
      );
      await db.setWorkerState("push_ledger", '{"entries":[],"updatedAt":0}');
      await db.setWorkerState(
        "push_deferral",
        JSON.stringify({
          deferredTotal: 0,
          recoveredTotal: 0,
          stalledTotal: 0,
          pending: 0,
          pendingTokens: [],
          events: [],
        }),
      );
      await tick(now);
      assert.equal(
        await db.isTokenSeen("c", "PROVEN"),
        true,
        "proof keeps the claim — the card is in the chat, and the settle must not re-push it",
      );
      assert.equal(
        await db.isTokenSeen("c", "SILENT"),
        false,
        "silence past the grace releases it — the coin becomes re-pushable (never miss)",
      );
      assert.deepEqual(
        parseUnconfirmedCardSends(await db.getWorkerState(UNCONFIRMED_CARD_STATE_KEY)),
        [],
        "and both settled records are gone from the durable ring",
      );
      assert.equal(
        ring.reads,
        1,
        "the settle reads the ring out of the tail's ONE readout, never a read of its own",
      );
      assert.equal(ring.writes, 1, "and its shrink rides the tail's ONE write batch");
      // A record INSIDE the grace is left alone: releasing early would re-push a
      // card whose request is still in flight, which is the duplicate again.
      await db.claimTokenPush("c", "FRESH");
      await db.setWorkerState(
        UNCONFIRMED_CARD_STATE_KEY,
        serializeUnconfirmedCardSends([{ chatId: "c", token: "FRESH", at: now, symbol: "F" }]),
      );
      const readsBefore = ring.reads;
      await tick(now + 1_000);
      assert.equal(await db.isTokenSeen("c", "FRESH"), true, "a record inside the grace keeps its claim");
      assert.deepEqual(
        parseUnconfirmedCardSends(await db.getWorkerState(UNCONFIRMED_CARD_STATE_KEY)).map((r) => r.token),
        ["FRESH"],
        "and it waits in the ring for a later tick to settle it",
      );
      assert.equal(ring.reads - readsBefore, 1, "still the tail's own readout — no read of its own");
      assert.equal(ring.writes, 1, "and a tick that settles nothing writes nothing for the ring");
    } finally {
      await t.cleanup();
    }
  });

  // ---------- the heartbeat's view of the ring ----------
  await test("tickprobe: the abandoned-card ledger accumulates releases and republishes the pending count", () => {
    const { noteUnconfirmedCards, unconfirmedCardsView } = require("../dist/tickprobe.js");
    const before = unconfirmedCardsView();
    noteUnconfirmedCards({ pending: 2, releasedNow: 0, tokens: ["A", "B"] }, 1_000);
    assert.equal(unconfirmedCardsView().pending, 2, "pending is OVERWRITTEN — the ring is authoritative");
    assert.equal(
      unconfirmedCardsView().releasedTotal,
      before.releasedTotal,
      "a tick that releases nothing adds nothing to the rate",
    );
    assert.equal(unconfirmedCardsView().releasedAt, before.releasedAt, "and it does not restamp the last release");
    noteUnconfirmedCards({ pending: 1, releasedNow: 1, tokens: ["C"] }, 2_000);
    const view = unconfirmedCardsView();
    assert.equal(view.pending, 1);
    assert.equal(
      view.releasedTotal,
      before.releasedTotal + 1,
      "the release rate ACCUMULATES — a value reset every tick could never be read as a rate",
    );
    assert.equal(view.releasedAt, 2_000, "and the newest release is stamped");
    assert.deepEqual(view.tokens, ["C"], "with the tokens of the last settle");
    // The two halves age differently on purpose: `pending` is the durable ring's
    // size (so every tick republishes it, empty included — a stale reading would
    // outlive the record), while the rate is this isolate's.
    noteUnconfirmedCards({ pending: 0, releasedNow: 0, tokens: [] }, 3_000);
    assert.equal(unconfirmedCardsView().pending, 0, "a settled-to-zero ring must not read as a stale pending");
    assert.equal(
      unconfirmedCardsView().releasedTotal,
      before.releasedTotal + 1,
      "and the rate survives the quiet tick",
    );
    assert.equal(unconfirmedCardsView().releasedAt, 2_000, "as does the stamp of the last release");
    // The published object is a COPY: a heartbeat that mutated it would change
    // what the next reader sees.
    const snap = unconfirmedCardsView();
    snap.tokens.push("MUTATED");
    assert.deepEqual(unconfirmedCardsView().tokens, [], "the view hands out a copy");
    // Clamps: a negative release can never walk the rate down, and the token
    // list is bounded for the /health payload.
    noteUnconfirmedCards({ pending: -5, releasedNow: -1, tokens: ["A", "B", "C", "D"] }, 4_000);
    const clamped = unconfirmedCardsView();
    assert.equal(clamped.pending, 0, "a negative pending is clamped, not published");
    assert.equal(
      clamped.releasedTotal,
      before.releasedTotal + 1,
      "and a negative release cannot walk the rate down",
    );
    assert.deepEqual(clamped.tokens, ["A", "B", "C"], "three tokens, the payload's own bound");
    assert.equal(clamped.releasedAt, 2_000, "a negative release is not a release, so it is not stamped");
  });

  // ---------- the heartbeat channel itself ----------
  await test("tickprobe: the ledger rides EVERY tick's summary, candidate-less ticks included", async () => {
    // Fix 2's wiring, not just its rule: `summary` is the channel the completion
    // heartbeat serializes, and the phase-guarded block below it only runs on a
    // tick that evaluated a candidate. A withheld card is hardest to notice on
    // exactly the quiet ticks, so the view must be published regardless.
    const { installTickProbe, resetTickProbe } = require("../dist/tickprobe.js");
    resetTickProbe();
    const scanner = {
      lastSummary: { candidates: 0, pushed: 0 },
      markPhase() {},
      async runOnce() {},
    };
    installTickProbe(scanner, {});
    try {
      const before = unconfirmedCardsView();
      await scanner.runOnce();
      assert.ok(
        scanner.lastSummary.unconfirmedCards,
        "a candidate-less tick (no phase stamps at all) still publishes the view",
      );
      assert.deepEqual(
        scanner.lastSummary.unconfirmedCards,
        before,
        "and it is the ledger's own reading, not a placeholder",
      );
      noteUnconfirmedCards({ pending: 3, releasedNow: 2, tokens: ["X"] }, 5_000);
      await scanner.runOnce();
      assert.deepEqual(scanner.lastSummary.unconfirmedCards, {
        pending: 3,
        releasedTotal: before.releasedTotal + 2,
        releasedAt: 5_000,
        tokens: ["X"],
      });
    } finally {
      resetTickProbe();
    }
  });

  // ---------- the scanner's send path, end to end ----------
  await test("scanner: a card send abandoned at its deadline keeps the claim; a rejection still releases it", async () => {
    // The cut branch driven FOR REAL: one candidate, one enabled chat, a send
    // that never answers. The clock is skewed INSIDE the send, so the tick's own
    // deadline expires while the request is still in flight — exactly what a
    // slow Telegram round trip does in production, and why this case costs
    // milliseconds instead of the 8s send tail.
    const cfg = loadConfig({});
    const realNow = Date.now;
    const runTick = async (chatId, mint, sendMessage) => {
      const t = tmpDb();
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.saveChatSettings({ chatId, ...ZERO_GATES });
      const dex = new DexScreenerClient(cfg);
      dex.fetchPairsForTokens = async () => new Map([[mint, cutPair(mint)]]);
      stubCutFeed(mint);
      const scanner = new Scanner(db, { api: { sendMessage } }, dex, cfg, null, null, null);
      await scanner.runOnce();
      return { db, scanner, cleanup: t.cleanup };
    };
    // (a) ABANDONED: the request never answers.
    let skew = 0;
    Date.now = () => realNow() + skew;
    try {
      const cut = await runTick("chat-cut", "CUTMINT", () => {
        skew = 60_000;
        return new Promise(() => {});
      });
      try {
        assert.equal(cut.scanner.lastSummary.cardSendAbandoned, 1, "the abandoned send is counted");
        assert.equal(cut.scanner.lastSummary.pushed, 0, "and no card was pushed");
        assert.equal(
          await cut.db.isTokenSeen("chat-cut", "CUTMINT"),
          true,
          "the claim is KEPT — deleting it here is what re-pushed the card on the very next tick",
        );
        const ring = parseUnconfirmedCardSends(await cut.db.getWorkerState(UNCONFIRMED_CARD_STATE_KEY));
        assert.equal(ring.length, 1, "and the unknown delivery is recorded durably, for the tail to settle");
        assert.equal(ring[0].chatId, "chat-cut");
        assert.equal(ring[0].token, "CUTMINT");
        assert.equal(ring[0].symbol, "CUT", "with the symbol, so a release can be read in the log");
        assert.ok(ring[0].at > 0, "and the grace clock of the abandoned send");
        assert.equal(
          (await cut.db.getWorkerState("push_audit")) ?? null,
          null,
          "an abandoned send writes NO audit entry — an entry would mean Telegram accepted a card",
        );
      } finally {
        await cut.cleanup();
      }
    } finally {
      Date.now = realNow;
    }
    // (b) REJECTED: Telegram answered with an error, which is a FACT — the claim
    // goes back so a later scan re-pushes the coin (the never-miss half), and
    // nothing is recorded as unconfirmed.
    const rejected = await runTick("chat-reject", "REJECTMINT", () => {
      const err = new Error("Bad Request: chat not found");
      err.error_code = 400;
      return Promise.reject(err);
    });
    try {
      assert.equal(rejected.scanner.lastSummary.cardSendAbandoned, 0, "a rejection is not an abandoned send");
      assert.equal(rejected.scanner.lastSummary.pushed, 0, "and no card went out");
      assert.equal(
        await rejected.db.isTokenSeen("chat-reject", "REJECTMINT"),
        false,
        "the claim is RELEASED, so a later scan re-pushes the coin",
      );
      assert.deepEqual(
        parseUnconfirmedCardSends(await rejected.db.getWorkerState(UNCONFIRMED_CARD_STATE_KEY)),
        [],
        "and nothing is recorded as unconfirmed",
      );
    } finally {
      await rejected.cleanup();
    }
  });

  await test("scanner: a cut send whose record cannot be written gives the claim back, and the next tick pushes it", async () => {
    // THE FAIL-OPEN HALF (2026-10-11). Holding the claim is only safe while a
    // durable record says the settle owns it: seen_tokens has no prune and no
    // expiry, so a claim with NO record can never be released and the coin would
    // be withheld from that chat FOREVER — a lost card, the one outcome the
    // never-miss rule forbids. So a record that cannot be written gives the
    // claim back instead (at most one duplicate, minutes late).
    const cfg = loadConfig({});
    const realNow = Date.now;
    let skew = 0;
    Date.now = () => realNow() + skew;
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.saveChatSettings({ chatId: "chat-cut", ...ZERO_GATES });
      const dex = new DexScreenerClient(cfg);
      dex.fetchPairsForTokens = async () => new Map([["CUTMINT", cutPair("CUTMINT")]]);
      stubCutFeed("CUTMINT");
      // The record's write fails the way a tick that has run out of room fails
      // it: exactly ONE write cannot land, and it is the ring's.
      const realSetWorkerState = db.setWorkerState.bind(db);
      let ringWrites = 0;
      db.setWorkerState = async (key, value) => {
        if (key === UNCONFIRMED_CARD_STATE_KEY) {
          ringWrites += 1;
          throw new Error("Too many subrequests");
        }
        return realSetWorkerState(key, value);
      };
      const hanging = new Scanner(
        db,
        {
          api: {
            sendMessage: async () => {
              skew = 60_000;
              return new Promise(() => {});
            },
          },
        },
        dex,
        cfg,
        null,
        null,
        null,
      );
      await hanging.runOnce();
      assert.equal(ringWrites, 1, "the record write was attempted");
      assert.equal(hanging.lastSummary.cardSendAbandoned, 1, "the abandoned send is still counted");
      assert.equal(
        await db.isTokenSeen("chat-cut", "CUTMINT"),
        false,
        "the claim is GIVEN BACK — a claim with no record has nothing that could ever release it",
      );
      assert.deepEqual(
        parseUnconfirmedCardSends(await db.getWorkerState(UNCONFIRMED_CARD_STATE_KEY)),
        [],
        "and nothing is recorded as unconfirmed",
      );
      // The point of giving it back: the coin is NOT withheld. The very next
      // tick (clock back to normal, writes healthy) pushes it.
      skew = 0;
      db.setWorkerState = realSetWorkerState;
      const next = new Scanner(
        db,
        { api: { sendMessage: async () => ({ message_id: 4_243 }) } },
        dex,
        cfg,
        null,
        null,
        null,
      );
      await next.runOnce();
      assert.equal(next.lastSummary.pushed, 1, "the released coin is pushed by the next tick");
      assert.equal(await db.isTokenSeen("chat-cut", "CUTMINT"), true, "and that push holds its own claim");
      const audit = await db.getWorkerState("push_audit");
      assert.ok(
        typeof audit === "string" && audit.includes("CUTMINT"),
        "with the delivery audit written — the proof the deferral guard and the heal gate read",
      );
    } finally {
      Date.now = realNow;
      await t.cleanup();
    }
  });

  console.log("\n===== UNCONFIRMED-CARD TESTS =====");
  for (const line of results) console.log(line);
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("unconfirmed-card tests failed to run:", err);
  process.exit(1);
});
