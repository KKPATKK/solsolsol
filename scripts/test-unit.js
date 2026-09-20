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
const { Db, DEFAULT_SETTINGS, DB_REQUEST_TIMEOUT_MS } = require("../dist/db.js");
const { parseFilterArgs, tradeKeyboard } = require("../dist/bot.js");
const { parseAdminIds, isAdmin, parseSmartMoneyTypes, loadConfig } = require("../dist/config.js");
const { detectSupplyFlow, selectTopAccounts, summarizeSignatures } = require("../dist/helius.js");
const { tradeDecision, resolveTradeMode, parseQuote, parseSendResponse, buyAmountLamports, parseSellCallback, sellAmountRaw, parseModeCallback, nextTradeMode } = require("../dist/jupiter.js");
const { parsePumpCoins } = require("../dist/pumpfun.js");
const { parseNewPools, parseTokenSnapshot, GeckoTerminalClient, parseRetryAfterMs, geckoBackoffMs, geckoFeedStats, GECKO_CACHE_TTL_S, GECKO_RATE_LIMIT_BACKOFF_MS, GECKO_BACKOFF_MAX_MS, GECKO_BACKOFF_HARD_MAX_MS } = require("../dist/geckoterminal.js");
const { parseJupTokens, JupTokensClient } = require("../dist/jupfeeds.js");
const { passesChgGate, DexScreenerClient } = require("../dist/dexscreener.js");
const { evaluateWatch, recapVerdict, recapMessage, PushWatcher, comparableLiquidity } = require("../dist/pushwatch.js");
const { parsePushLedger, mergePushLedger, pushLedgerStats, PUSH_LEDGER_MAX_ENTRIES, ledgerDeliveredTokens } = require("../dist/pushledger.js");
const { syncPushLedger, syncSkipCaptureState, SCAN_FLUSH_RESERVE_MS, FLUSH_ATTEMPT_BOUND_MS } = require("../dist/worker.js");
const { installSkipCapture, skipCaptureSnapshot, takeSkipCaptureDelta, markSkipCaptureSynced, emptySkipCaptureState, mergeSkipCaptureState, parseSkipCaptureState, pruneSkipCounts, resetSkipCapture, SKIP_CAPTURE_MAX_REASONS } = require("../dist/skipcapture.js");
const { mcapRatioBlockReason, newWalletBlockReason, top10MinBlockReason, botUsersBlockReason, flurryBlockReason, slicePoolRotation, cardSendDeadline, cardClaimDeadline, boundClaim, DeferredPushLedger, SCAN_TICK_DEADLINE_MS, CANDIDATE_PUSH_RESERVE_MS } = require("../dist/scanner.js");
const { parseTrending, parseTokenInfo } = require("../dist/gmgn.js");
const { renderAxiomSummaryLine } = require("../dist/render.js");
const { parseAxiomTokenInfo } = require("../dist/axiom.js");
const { parseTokenOverview } = require("../dist/birdeye.js");
const { parseAxiomTrending, AxiomClient } = require("../dist/axiom.js");
const { parseArkhamHolders, isSmartMoneyType } = require("../dist/arkham.js");
const { parseCrimeWalletList, CrimeWalletClient } = require("../dist/crimewallets.js");
const { WalletAnalyzer } = require("../dist/walletanalysis.js");
const { deriveBondingCurvePda, slotActivityFromTransaction, detectBundle, clusterByFunding, linkedWalletCount, scoreRisk, findFundedBy, FlurryAnalyzer } = require("../dist/flurry.js");
const { tradeFingerprint, deadTickBackfillInfo } = require("../dist/worker.js");
const { PUSH_DEFERRAL_RING_MAX, loadPushDeferralSnapshot, parsePushDeferralSnapshot, nextPushDeferralSnapshot, pushDeferralAlreadyApplied, pushDeferralDelta, heldBackCandidates, deliveredDeferredTokens, deliveredCardTokens, duplicateInitialTokens, cardSendDisposition, parseUnconfirmedCardSends, addUnconfirmedCardSend, removeUnconfirmedCardSend, settleUnconfirmedCardSends, serializeUnconfirmedCardSends, UNCONFIRMED_CARD_MAX, UNCONFIRMED_CARD_GRACE_MS } = require("../dist/deferrallog.js");
const { PoolFallbackDb, poolFallbackStats, resetPoolFallbackStats } = require("../dist/poolfallback.js");

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
  // ---------- cross-isolate deferral counters (src/deferrallog.ts) ----------
  //
  // These are the durable half of the scanner's deferral bookkeeping: the
  // counters the user watches on /health.heartbeat.deferral to prove that a
  // card refused by a late tick really is pushed back later ("deferRecovered
  // 第一次上升" / firstRecoveredAt) and to read the refusal RATE across
  // isolates instead of only from whichever isolate answered /health.

  // ---------- flush reserve vs DB transport timeout (src/db.ts + src/worker.ts) ----------
  //
  // Constants-only, placed first because it guards a TUNING relationship the
  // rest of the tick depends on. The completion flush is the tick's last chance
  // to land its row, and it is the one step that runs OUTSIDE scan mode — so its
  // writes are leashed by DB_REQUEST_TIMEOUT_MS, not by SCAN_DB_TIMEOUT_MS. The
  // flush gives its first attempt FLUSH_ATTEMPT_BOUND_MS, then starts a
  // concurrent retry that races whatever is left of SCAN_FLUSH_RESERVE_MS. A
  // request only rejects after the transport hard wall (1.2x the timeout), so a
  // timeout longer than that remaining window means a stalled flush cannot even
  // FAIL in time — the retry races a promise that cannot settle and the tick is
  // dead by construction (the scan ran, the cards went out, the row is lost).
  // Those two numbers sat in exactly that state until 2026-09-20: 6000ms gave a
  // 7.2s hard wall against a 3.3s window. This case keeps it visible.
  await test("flush retry can land: the DB hard wall fits inside the reserve left after the first attempt", () => {
    const retryWindowMs = SCAN_FLUSH_RESERVE_MS - FLUSH_ATTEMPT_BOUND_MS;
    assert.ok(
      DB_REQUEST_TIMEOUT_MS * 1.2 <= retryWindowMs,
      `hard wall ${DB_REQUEST_TIMEOUT_MS * 1.2}ms must fit the ${retryWindowMs}ms retry window`,
    );
    // One whole request must fit the window, else the retry is a no-op even when
    // the database is merely slow rather than hung.
    assert.ok(retryWindowMs >= DB_REQUEST_TIMEOUT_MS);
    // ...and the timeout must stay generous for healthy round trips (live
    // 100-300ms, slowest healthy query measured ~600ms).
    assert.ok(DB_REQUEST_TIMEOUT_MS >= 1_500, "too tight for a healthy Turso round trip");
    // Witness for why the value was lowered: the pre-2026-09-20 setting fails
    // the first assertion, i.e. every stalled flush was unrecoverable.
    assert.ok(6_000 * 1.2 > retryWindowMs, "the old 6s default should violate the window");
  });

  // ---------- card send room (src/scanner.ts) ----------
  //
  // The same arithmetic one layer down, and the fix for the duplicate cards
  // reported live on 2026-09-20. A card's Telegram send only duplicates when it
  // is CUT: Telegram accepts the card, the awaited race expires first, `sendTo`
  // throws `cardSendTimeout`, its catch releases the claim, and the next tick
  // sees the coin as unseen and pushes the same card again. What decides that
  // is the slice the send gets, and the tick's shape makes it exactly
  // `CANDIDATE_PUSH_RESERVE_MS - overhead`: the chain ends at
  // `SCAN_TICK_DEADLINE_MS - reserve`, the send starts `overhead` later
  // (render + trade-mode read + claim round trip), and its deadline is the
  // tick's own internal deadline while the chain runs to its own. Live
  // 2026-09-20: `wallets@2800 flurry@3300 render@3300 send@3542`, i.e. a 658ms
  // slice against measured round trips of 0.62s and 1.23s (/debug/test-push).
  // This case pins the floor so a future retune of the reserve cannot silently
  // put the send back under a real round trip.
  await test("card send room: the push reserve covers a measured Telegram round trip", () => {
    const CARD_SEND_OVERHEAD_MS = 250; // render + claim RTT (live 3300 → 3542)
    const roomMs = CANDIDATE_PUSH_RESERVE_MS - CARD_SEND_OVERHEAD_MS;
    assert.ok(
      roomMs >= 1_200,
      `send room ${roomMs}ms must cover the slowest measured round trip (1230ms)`,
    );
    // The reserve is taken from the chain, so it must still leave one: the
    // candidate chain and its gates share `SCAN_TICK_DEADLINE_MS - reserve`.
    assert.ok(
      SCAN_TICK_DEADLINE_MS - CANDIDATE_PUSH_RESERVE_MS >= 600,
      "the reserve must leave the candidate chain a usable window",
    );
    // Witness for why the value moved: the pre-2026-09-20 setting left the send
    // under the measured round trip, i.e. the cut was structural, not unlucky.
    assert.ok(
      900 - CARD_SEND_OVERHEAD_MS < 1_200,
      "the old 900ms reserve should fail the room check",
    );
  });

  // The runtime half of the same change: a request that never settles must be
  // walled off early enough for the flush's racing retry to still land. Bounded
  // against the OLD wall (6s transport x 1.2 = 7.2s) rather than a tight
  // tolerance, so this pins the regression without going flaky on a slow CI
  // box: a healthy machine measures ~3.0s (2.5s x 1.2).
  await test("a never-settling DB call is walled off inside the flush retry window", async () => {
    const never = () => new Promise(() => {});
    const hangingClient = {
      execute(stmt) {
        if (stmt.args && stmt.args[0] === "anything") return never();
        return Promise.resolve({ rows: [], rowsAffected: 0 });
      },
      async batch(stmts) {
        return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    };
    const db = new Db("libsql://unused", undefined, hangingClient);
    await db.init();
    const t0 = Date.now();
    await assert.rejects(
      db.getWorkerState("anything"),
      /hard wall|never settled/i,
      "a hanging execute must reject via the wall, not hang",
    );
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed >= DB_REQUEST_TIMEOUT_MS,
      `call settled in ${elapsed}ms — earlier than the ${DB_REQUEST_TIMEOUT_MS}ms transport timeout`,
    );
    assert.ok(
      elapsed < 6_000,
      `call settled in ${elapsed}ms — the old 6s wall (7200ms) would leave no retry window`,
    );
  });

  // ---------- deferral duplicate guard (src/deferrallog.ts) ----------
  //
  // The pending list and the push itself are written by the SAME completion
  // flush, so a lost flush leaves a delivered coin still "owed" and the next
  // tick's make-up pass pushes the same card again (live 2026-09-20 00:47Z
  // GROYPER, +2 min; the audit ring carried `initial` for 4 of the 8 tokens
  // still listed as pending). The rule may only ever forget what a delivery
  // ALREADY discharged — the user's hard requirement is that a real miss is
  // never dropped, so the kind whitelist is the safety property under test.
  await test("deliveredDeferredTokens: only audit-proven deliveries are forgotten, never an owed coin", () => {
    const pending = ["AAA", "BBB", "CCC", "DDD", "EEE"];
    const audit = [
      { token: "AAA", kind: "initial" },
      { token: "BBB", kind: "resend" },
      { token: "CCC", kind: "followup" },
      { token: "DDD", kind: "heal-current" },
      { token: "EEE", kind: null },
    ];
    assert.deepEqual(deliveredDeferredTokens(pending, audit), ["AAA", "BBB"]);
    // No audit entry at all for an owed coin -> it stays owed (the never-miss half).
    assert.deepEqual(deliveredDeferredTokens(["ZZZ"], audit), []);
    assert.deepEqual(deliveredDeferredTokens(pending, []), []);
    assert.deepEqual(deliveredDeferredTokens([], audit), []);
    // Duplicates in the pending list are dropped once, order preserved.
    assert.deepEqual(deliveredDeferredTokens(["BBB", "AAA", "BBB"], audit), ["BBB", "AAA"]);
    // Malformed survey rows must never throw — the guard is best-effort.
    assert.deepEqual(
      deliveredDeferredTokens(["AAA", "", null, undefined], [{ token: "AAA", kind: "initial" }]),
      ["AAA"],
    );
    assert.deepEqual(deliveredDeferredTokens(["AAA"], [{ kind: "initial" }, { token: "", kind: "initial" }]), []);
  });

  // The durable half of that proof. The audit RING holds ~30 deliveries of ALL
  // kinds and rolled two of four stale tokens out of its window within 13
  // minutes on 2026-09-20, so the guard reads the push ledger too — where the
  // same `initial` provenance lives for 7 days / 240 pushes. Only
  // `initial-send` counts: a `watch-row` entry says the token is TRACKED, not
  // that a card was delivered, and treating it as proof could forget an
  // obligation the user is still owed.
  await test("ledgerDeliveredTokens: only the audit's initial-send provenance counts, never a watch-row guess", () => {
    const ledger = {
      updatedAt: 0,
      entries: [
        { token: "AAA", source: "initial-send" },
        { token: "BBB", source: "watch-row" },
        { token: "CCC", source: "initial-send" },
        { token: "", source: "initial-send" },
        { source: "initial-send" },
      ],
    };
    assert.deepEqual(ledgerDeliveredTokens(ledger), ["AAA", "CCC"]);
    assert.deepEqual(ledgerDeliveredTokens({ entries: [], updatedAt: 0 }), []);
    assert.deepEqual(
      ledgerDeliveredTokens({ entries: [{ token: "X", source: "watch-row" }], updatedAt: 0 }),
      [],
    );
    // The folded proof feeds the same kind whitelist, so a ledger token really
    // does drop a delivered pending entry — and nothing else does.
    assert.deepEqual(
      deliveredDeferredTokens(["AAA", "ZZZ"], ledgerDeliveredTokens(ledger).map((token) => ({ token, kind: "initial" }))),
      ["AAA"],
    );
  });

  // The third proof source: a `push_watch` row is written by onPush right
  // after a successful push, so it proves delivery durably for a coin whose
  // only delivery record was a `resend` (which the ledger does not keep). A
  // follow-up or a healed baseline still proves nothing about the initial card.
  await test("deliveredDeferredTokens: a durable pushed-row counts, a follow-up still never does", () => {
    assert.deepEqual(
      deliveredDeferredTokens(["AAA", "BBB", "CCC"], [
        { token: "AAA", kind: "pushed-row" },
        { token: "BBB", kind: "followup" },
        { token: "CCC", kind: "heal-current" },
      ]),
      ["AAA"],
    );
  });

  // The duplicate the operator reports by hand (2026-09-20: PONDER 10:48, then
  // 10:57/11:01/11:03/11:08 HKT). Counted from the same ring, but nothing is
  // ever dropped on it — it is the acceptance measure for the scanner-side send
  // fix, so the rule has to distinguish a real duplicate (two `initial` cards)
  // from the tracker's own repeats (resend / followup / heal-current).
  await test("duplicateInitialTokens: two delivered initial cards, never the tracker's own repeats", () => {
    const audit = [
      { token: "AAA", kind: "initial" },
      { token: "AAA", kind: "resend" },
      { token: "AAA", kind: "followup" },
      { token: "AAA", kind: "initial" },
      { token: "BBB", kind: "initial" },
      { token: "CCC", kind: "resend" },
      { token: "CCC", kind: "heal-current" },
      { token: "DDD", kind: "pushed-row" },
      { token: "DDD", kind: "initial" },
    ];
    assert.deepEqual(duplicateInitialTokens(audit), ["AAA"]);
    // One initial card is not a duplicate, however many resends followed it.
    assert.deepEqual(duplicateInitialTokens([{ token: "AAA", kind: "initial" }, { token: "AAA", kind: "resend" }]), []);
    // Three initial cards still report the token once.
    assert.deepEqual(
      duplicateInitialTokens([
        { token: "AAA", kind: "initial" },
        { token: "AAA", kind: "initial" },
        { token: "AAA", kind: "initial" },
      ]),
      ["AAA"],
    );
    assert.deepEqual(duplicateInitialTokens([]), []);
    // Malformed rows must never throw: this runs in the tick tail.
    assert.deepEqual(
      duplicateInitialTokens([{ kind: "initial" }, { token: "", kind: "initial" }, null, undefined]),
      [],
    );
    // A duplicate whose first card has already rolled out of the ring cannot be
    // seen — the count is a window, not a lifetime total (documented limit).
    assert.deepEqual(duplicateInitialTokens([{ token: "ZZZ", kind: "initial" }]), []);
  });

  // The self-heal's resend gate (src/pushwatch.ts) asks the same question from
  // the same rule. This is the one that turned THREE duplicates into five: a
  // card cut by the send deadline is delivered with no audit entry, and the
  // 補發 card writes the token's only entry, kind `resend` — which the old
  // initial-only gate could not see, so every heal pass over the 15-minute
  // grace sent another 補發. Bounded by the widen question: at most one per
  // token, and never zero when there is no proof at all.
  await test("deliveredCardTokens: any delivered card closes the heal-resend gate, and one pass writes the proof that closes it", () => {
    const ringAfterCut = [{ token: "AAA", kind: "followup" }, { token: "BBB", kind: "initial" }];
    assert.deepEqual(deliveredCardTokens(ringAfterCut), ["BBB"]);
    // The 補發 this loop sends writes `resend`: the same token, one pass later,
    // is now proof — so the gate is shut and the coin is only enrolled.
    const afterResend = [...ringAfterCut, { token: "AAA", kind: "resend" }];
    assert.deepEqual(deliveredCardTokens(afterResend), ["BBB", "AAA"]);
    // A token with nothing in the ring stays re-sendable (never-miss half).
    assert.equal(deliveredCardTokens(afterResend).includes("CCC"), false);
    // `heal-ledger`/`heal-current` prove the tracker measured a push, not that
    // a card was delivered, so they must not close the gate.
    assert.deepEqual(
      deliveredCardTokens([{ token: "DDD", kind: "heal-current" }, { token: "EEE", kind: "heal-ledger" }]),
      [],
    );
    // The wider question is a superset of the old one on every ring.
    for (const ring of [ringAfterCut, afterResend]) {
      for (const token of deliveredDeferredTokens(ring.map((r) => r.token), ring)) {
        assert.ok(deliveredCardTokens(ring).includes(token));
      }
    }
    assert.deepEqual(deliveredCardTokens([]), []);
    assert.deepEqual(deliveredCardTokens([{ kind: "initial" }, { token: "", kind: "resend" }, null]), []);
  });

  // ---------- three-state card send: the unconfirmed-delivery ledger ----------
  //
  // The duplicate this closes: `bestEffort(send, deadline, null)` reported
  // "abandoned" as "failed", so the send path deleted the seen_tokens claim and
  // the next tick's re-eval pool pushed the same card again (live 2026-09-20:
  // PONDER five times in eleven minutes). These are the exact rules the pasted
  // send path runs; they are pinned offline because the send itself sits inside
  // runOnce, past the file-sync window, with no fixture to drive it.

  await test("cardSendDisposition: abandoned keeps the claim, only a rejection releases it", () => {
    assert.deepEqual(cardSendDisposition("sent"), {
      audit: true,
      releaseClaim: false,
      watchInBackground: false,
      recordUnconfirmed: false,
      throwFailure: false,
    });
    assert.deepEqual(cardSendDisposition("failed"), {
      audit: false,
      releaseClaim: true,
      watchInBackground: false,
      recordUnconfirmed: false,
      throwFailure: true,
    });
    assert.deepEqual(cardSendDisposition("abandoned"), {
      audit: false,
      releaseClaim: false,
      watchInBackground: true,
      recordUnconfirmed: true,
      throwFailure: false,
    });
    // The never-miss invariants, stated as invariants so a later edit has to
    // argue with them: a card is never both audited and released, and the
    // ambiguous outcome never releases (that release IS the duplicate).
    for (const outcome of ["sent", "failed", "abandoned"]) {
      const d = cardSendDisposition(outcome);
      assert.equal(d.audit && d.releaseClaim, false, `${outcome}: never audit AND release`);
    }
    assert.equal(
      cardSendDisposition("abandoned").releaseClaim,
      false,
      "abandoned must keep the claim — releasing it is what re-pushes the card",
    );
    assert.equal(
      cardSendDisposition("abandoned").throwFailure,
      false,
      "abandoned is not a failure: the caller must not run its failure/retry path",
    );
  });

  await test("unconfirmed ledger: one record per coin, capped, and removable", () => {
    const at = 1_000_000;
    let raw = addUnconfirmedCardSend(null, { chatId: "c1", token: "AAA", at, symbol: "AAA" });
    assert.deepEqual(parseUnconfirmedCardSends(raw), [
      { chatId: "c1", token: "AAA", at, symbol: "AAA" },
    ]);
    // The same coin abandoned twice keeps ONE record with the NEWER stamp: two
    // records would release the same claim twice, and the second release could
    // delete a claim taken by a later, legitimately re-pushed card.
    raw = addUnconfirmedCardSend(raw, { chatId: "c1", token: "AAA", at: at + 5_000, symbol: "AAA" });
    assert.equal(parseUnconfirmedCardSends(raw).length, 1);
    assert.equal(parseUnconfirmedCardSends(raw)[0].at, at + 5_000);
    // Per chat: the same token in another chat is its own obligation.
    raw = addUnconfirmedCardSend(raw, { chatId: "c2", token: "AAA", at });
    assert.equal(parseUnconfirmedCardSends(raw).length, 2);
    assert.deepEqual(parseUnconfirmedCardSends(removeUnconfirmedCardSend(raw, "c1", "AAA")), [
      { chatId: "c2", token: "AAA", at, symbol: null },
    ]);
    // Ring cap: newest kept, and the row stays a small write.
    let ring = null;
    for (let i = 0; i < UNCONFIRMED_CARD_MAX + 5; i++) {
      ring = addUnconfirmedCardSend(ring, { chatId: "c1", token: `T${i}`, at: at + i });
    }
    const list = parseUnconfirmedCardSends(ring);
    assert.equal(list.length, UNCONFIRMED_CARD_MAX);
    assert.equal(list[list.length - 1].token, `T${UNCONFIRMED_CARD_MAX + 4}`);
    assert.equal(serializeUnconfirmedCardSends(list), JSON.stringify(list));
    // Garbage never throws and never invents a record.
    assert.deepEqual(parseUnconfirmedCardSends("{not json"), []);
    assert.deepEqual(
      parseUnconfirmedCardSends('[{"token":"X"},null,{"chatId":"c","token":"Y","at":1}]'),
      [{ chatId: "c", token: "Y", at: 1, symbol: null }],
    );
  });

  await test("settleUnconfirmedCardSends: proof keeps the claim, silence releases it after the grace", () => {
    const at = 1_000_000;
    const records = [
      { chatId: "c1", token: "DELIVERED", at, symbol: null },
      { chatId: "c1", token: "LOST", at, symbol: null },
      { chatId: "c1", token: "FRESH", at: at + 119_000, symbol: null },
    ];
    const settled = settleUnconfirmedCardSends(
      records,
      at + 120_000,
      UNCONFIRMED_CARD_GRACE_MS,
      new Set(["DELIVERED"]),
    );
    // Proof: the card reached the chat → keep the claim, drop the record.
    assert.deepEqual(settled.confirmed.map((r) => r.token), ["DELIVERED"]);
    // Grace elapsed with no proof anywhere → release (the never-miss side).
    assert.deepEqual(settled.release.map((r) => r.token), ["LOST"]);
    // Still inside the grace → wait. Releasing early would re-push a card the
    // in-flight request is about to deliver.
    assert.deepEqual(settled.kept.map((r) => r.token), ["FRESH"]);
    // The grace boundary itself releases; one ms less does not.
    const one = [{ chatId: "c", token: "T", at, symbol: null }];
    assert.equal(
      settleUnconfirmedCardSends(one, at + UNCONFIRMED_CARD_GRACE_MS, UNCONFIRMED_CARD_GRACE_MS, new Set()).release.length,
      1,
    );
    assert.equal(
      settleUnconfirmedCardSends(one, at + UNCONFIRMED_CARD_GRACE_MS - 1, UNCONFIRMED_CARD_GRACE_MS, new Set()).release.length,
      0,
    );
    // The reconcile's common case: no record at all (nothing to read, nothing done).
    assert.deepEqual(settleUnconfirmedCardSends([], at, UNCONFIRMED_CARD_GRACE_MS, new Set()), {
      confirmed: [],
      release: [],
      kept: [],
    });
  });

  // ---------- hand-paste drift guard (out-of-window patches) ----------
  //
  // Three of the four fixes in docs/scan-completion-loss.md § "可直接貼上嘅窗口外
  // patch" sit past the file-sync window, so a human copies them in by hand.
  // The dangerous state is a PARTIAL paste: the three-state send without the
  // worker-side reconcile leaves an abandoned card's claim held forever (a coin
  // whose card truly failed is then never pushed again — the one thing the
  // operator forbids), and the race clamp on its own changes nothing while
  // still costing scans. So: either the behavioural patches are all in the
  // source, or none are. Anything in between fails HERE, with a message that
  // names what is missing, instead of silently shipping a half-applied fix.

  await test("out-of-window patches: pasted all together, or not at all", () => {
    const strip = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\s+/g, "");
    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));
    const scannerSrc = read("src/scanner.ts");
    const workerSrc = read("src/worker.ts");
    const pushwatchSrc = read("src/pushwatch.ts");

    const applied = {
      "patch 1 (race floor clamp)": workerSrc.includes("constscanRaceMs=Math.max(0,Math.min("),
      "patch 2 (three-state send)": scannerSrc.includes("cardSendDisposition(raced.status)"),
      "patch 3 (reconcile function)": workerSrc.includes(
        "asyncfunctionreconcileUnconfirmedCardSends",
      ),
      "patch 3 (reconcile called)": workerSrc.includes("awaitreconcileUnconfirmedCardSends("),
      "patch 3 (reconcile imports)":
        workerSrc.includes("parseUnconfirmedCardSends") &&
        workerSrc.includes("UNCONFIRMED_CARD_GRACE_MS"),
    };
    const done = Object.entries(applied).filter(([, v]) => v);
    if (done.length === 0) {
      // The documented pre-paste state: nothing landed, so there is no drift
      // to guard and nothing to fail. (Everything below is about a HALF-paste.)
      console.log(
        "  ℹ out-of-window behavioural patches not pasted yet — see docs/scan-completion-loss.md",
      );
      return;
    }
    const missing = Object.entries(applied)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    assert.equal(
      missing.length,
      0,
      `partial paste is unsafe — missing: ${missing.join(", ")} (see docs/scan-completion-loss.md)`,
    );
    // All in: the two-state send must be GONE (keeping it would leave two send
    // paths and the old cut→unclaim→re-push generator intact), and the heal
    // gate must honour the record or a delivered-but-abandoned card gets a
    // make-up card mailed on top of it.
    assert.equal(
      scannerSrc.includes("cut.cardSendTimeout=true"),
      false,
      "the two-state cut path must be replaced, not kept alongside the new one",
    );
    assert.equal(
      pushwatchSrc.includes("unconfirmed.has(m.token)"),
      true,
      "the heal gate must honour the unconfirmed-card record",
    );
    console.log("  ℹ out-of-window behavioural patches all present — three-state send is live in source");
  });

  // ---------- out-of-window drift guard: the cron drain hold ----------
  //
  // The writeDrain root fix is split. The queue itself (src/tickprobe.ts) is
  // inside the edit window, but the three pieces that keep the invocation ALIVE
  // for the drain sit ~1750 and ~3965 lines into src/worker.ts, past the
  // file-sync window, so they shipped as docs/patches/write-drain-waituntil.patch
  // (git apply) and are applied in the tree. The dangerous state is a PARTIAL
  // application: with the hold in place
  // but no waitUntil to hold it the drain is still cancelled on return
  // (measured 2026-09-19: `writeDrain` 4 calls / 4 failures = the bookkeeping
  // never landed), and the held promise without the queue change has nothing to
  // retry. Either all three markers are in the source, or none are.

  await test("out-of-window patch: the cron drain is held by waitUntil", () => {
    const strip = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\s+/g, "");
    const workerSrc = strip(
      fs.readFileSync(path.join(__dirname, "..", "src/worker.ts"), "utf8"),
    );
    const applied = {
      "patch A (tickWaitUntil state)": workerSrc.includes("lettickWaitUntil:"),
      "patch B (drain held, not fire-and-forget)":
        workerSrc.includes("constdrained=drainDeferredWrites()") &&
        workerSrc.includes("tickWaitUntil(drained)"),
      "patch C (scheduled takes ctx)":
        workerSrc.includes("tickWaitUntil=(promise)=>ctx.waitUntil(promise)"),
    };
    const done = Object.entries(applied).filter(([, v]) => v);
    if (done.length === 0) {
      console.log(
        "  ℹ writeDrain waitUntil patch missing - apply docs/patches/write-drain-waituntil.patch",
      );
      return;
    }
    const missing = Object.entries(applied)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    assert.equal(
      missing.length,
      0,
      `partial application is unsafe - missing: ${missing.join(", ")} (see docs/patches/write-drain-waituntil.patch)`,
    );
    assert.equal(
      workerSrc.includes("voiddrainDeferredWrites()"),
      false,
      "the fire-and-forget drain must be replaced, not kept alongside the held one",
    );
    console.log("  ℹ writeDrain waitUntil patch present - the cron drain is held");
  });

  // ---------- liquidity provenance: the false 💧 rug on a live pool ----------
  //
  // Measured 2026-09-20 20:16 HKT: a "💧 流動性枯竭 Lobby | LP 僅剩 $7.95K …
  // 停止追蹤" card went out while the pool actually held $17.5–21K. The reading
  // behind it (7950.39) was Jupiter's `liquidity` — a DIFFERENT metric that
  // runs at ~half of DexScreener's pool reserve for the very same pool (10 of
  // 14 recently-checked rows: 0.46–0.58×, within 2% of Jupiter's own number).
  // The tracker is fed by whichever leg answers, so a healthy pool was judged
  // against a $10K floor calibrated on the other metric — and both liquidity
  // rules (absolute floor AND the 45% crash ratio) are wrong across a leg
  // boundary, since one compares two readings that are not the same quantity.

  await test("comparableLiquidity: only DexScreener's metric may face a USD-level rule", () => {
    assert.equal(
      comparableLiquidity({ liquidity: { usd: 17_446 }, feedSource: "dexscreener" }),
      17_446,
    );
    assert.equal(
      comparableLiquidity({ liquidity: { usd: 7_950.39 }, feedSource: "jupiter" }),
      null,
      "Jupiter's ~half metric is UNKNOWN for a USD-level rule, not a drained pool",
    );
    assert.equal(comparableLiquidity({ liquidity: { usd: 10_640 }, feedSource: "gecko" }), null);
    assert.equal(
      comparableLiquidity({ liquidity: { usd: 21_000 } }),
      21_000,
      "untagged (fixtures, synthetic pairs, legacy rows) = DexScreener",
    );
    assert.equal(
      comparableLiquidity({ liquidity: { usd: null }, feedSource: "dexscreener" }),
      null,
      "a genuinely missing reading stays missing",
    );
  });

  await test("push-watch: a Jupiter-sourced reading can neither rug nor crash a live coin", () => {
    const row = (over = {}) => ({
      token: "EGTFrUPym8JnEMAddZjuhBkcSGEGTM75qymxUZgTpump", chatId: "c", symbol: "Lobby",
      pushedAt: 0, mcapAtPush: 100_000, peakMcap: 100_000, lastLiquidity: 19_000,
      holdersAtPush: null, holdersLast: null, holdersCheckedAt: null,
      lastChecked: 0, lastAlertAt: 0, followupsSent: 0, lastState: null,
      ...over,
    });
    const cfg = { cooldownMs: 30 * 60_000 };
    // Flat mcap so no mcap-derived rule can fire: only liquidity can decide.
    const base = { mcap: 100_000, chg5m: 0, buysH1: 0, sellsH1: 0 };
    const jupiterPair = { liquidity: { usd: 7_950.39 }, feedSource: "jupiter" };

    // What the tracker USED to hand the rules: the raw cross-source number.
    // Both halves of the bug, exactly as they fired live.
    const rawFloor = evaluateWatch(row({ lastLiquidity: 19_288 }), 1000, { ...base, liquidity: 7_950.39 }, cfg);
    assert.equal(rawFloor.alerts[0].kind, "liquidity");
    assert.match(rawFloor.alerts[0].text, /流動性枯竭 Lobby/);
    assert.equal(rawFloor.stopTracking, true, "the card claimed 停止追蹤");
    // Above the floor — so the crash ratio is the rule that judges — a leg
    // switch still fabricates a drop (stored 26K DexScreener → 11K Jupiter).
    // (The crash rule sits inside the cooldown block, hence the old lastAlertAt.)
    const rawCrash = evaluateWatch(
      row({ lastLiquidity: 26_000, lastAlertAt: -3_600_000 }),
      1000,
      { ...base, liquidity: 11_000 },
      cfg,
    );
    assert.equal(rawCrash.alerts[0].kind, "liquidity");
    assert.match(rawCrash.alerts[0].text, /流動性驟降 Lobby/, "a -58% 'crash' that never happened");
    // Guarded, the same pair yields no reading at all — so the ratio never runs.
    const guardedCrash = evaluateWatch(
      row({ lastLiquidity: 26_000, lastAlertAt: -3_600_000 }),
      1000,
      { ...base, liquidity: comparableLiquidity({ liquidity: { usd: 11_000 }, feedSource: "jupiter" }) },
      cfg,
    );
    assert.deepEqual(guardedCrash.alerts, []);

    // What it hands them now: the guarded reading (null = unknown) → no rule
    // judges, so no card and no terminal state.
    const out = evaluateWatch(row(), 1000, { ...base, liquidity: comparableLiquidity(jupiterPair) }, cfg);
    assert.deepEqual(out.alerts, []);
    assert.equal(out.stopTracking, false);
    assert.notEqual(out.lastState, "rug");

    // The rule itself is untouched: the SAME low number from the calibrated
    // leg still rugs (a real drain must never be missed).
    const dsPair = { liquidity: { usd: 7_950.39 }, feedSource: "dexscreener" };
    const real = evaluateWatch(row(), 1000, { ...base, liquidity: comparableLiquidity(dsPair) }, cfg);
    assert.equal(real.alerts[0].kind, "liquidity");
    assert.equal(real.stopTracking, true);
  });

  await test("out-of-window patch: liquidity provenance is guarded (docs/patches/liq-source-guard.patch)", () => {
    const strip = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/\s+/g, "");
    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));
    const pushwatchSrc = read("src/pushwatch.ts");
    const applied = {
      "guard (comparableLiquidity)": pushwatchSrc.includes("exportfunctioncomparableLiquidity"),
      "live reading guarded": pushwatchSrc.includes("liquidity:comparableLiquidity(pair),"),
      "both baselines keep the comparable value":
        pushwatchSrc.includes("lastLiquidity:comparableLiquidity(pair)??row.lastLiquidity,"),
      "heal seed guarded": pushwatchSrc.includes("liquidityUsd:comparableLiquidity(pair),"),
      "no raw cross-source baseline left":
        !pushwatchSrc.includes("lastLiquidity:pair.liquidity.usd,") &&
        !pushwatchSrc.includes("liquidityUsd:pair.liquidity.usd"),
    };
    const done = Object.entries(applied).filter(([, v]) => v);
    if (done.length === 0) {
      console.log(
        "  ℹ liquidity provenance guard missing - apply docs/patches/liq-source-guard.patch",
      );
      return;
    }
    const missing = Object.entries(applied)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    assert.equal(
      missing.length,
      0,
      `partial application is unsafe - missing: ${missing.join(", ")} (see docs/patches/liq-source-guard.patch)`,
    );
    // Every leg must declare its metric, or an untagged pair reads as
    // DexScreener and the guard above is bypassed from the producer side.
    assert.equal(read("src/dexscreener.ts").includes('feedSource:"dexscreener"'), true);
    assert.equal(read("src/jupfeeds.ts").includes('feedSource:"jupiter"'), true);
    assert.equal(read("src/scanner.ts").includes('feedSource:"gecko"'), true);
    console.log("  ℹ liquidity provenance guarded - USD-level rules see one metric only");
  });

  // ---------- GeckoTerminal 429: the cache is the fix, the backoff the net ---
  //
  // Measured 2026-09-20: the worker's egress was 429ed on every attempt (three
  // probes, `{"status":"429","title":"Rate Limited"}`) while the same public
  // URLs answered 200 with `cf-cache-status: HIT` from a normal host. The limiter
  // is per-IP and Cloudflare Worker egress is a shared pool, so the fix is to
  // let the colo cache answer the subrequest; the escalating backoff is the
  // fallback for when it cannot.

  await test("GeckoTerminalClient: every call asks for the Cloudflare edge cache", async () => {
    const seen = [];
    const origFetch = global.fetch;
    global.fetch = async (url, init) => {
      seen.push({ url: String(url), cf: init && init.cf });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json", "cf-cache-status": "HIT" },
      });
    };
    try {
      const client = new GeckoTerminalClient({ geckoterminalRequestIntervalMs: 0 });
      await client.fetchNewPools(1);
      assert.equal(seen.length, 1, "one call, one request");
      assert.equal(seen[0].cf?.cacheEverything, true, "the subrequest must join the edge cache");
      assert.equal(seen[0].cf?.cacheTtl, GECKO_CACHE_TTL_S, "for the upstream's own s-maxage window");
      assert.equal(
        seen[0].cf?.cacheTtlByStatus?.["400-599"],
        0,
        "an error response (a 429!) must never be cached",
      );
      assert.ok(
        GECKO_CACHE_TTL_S >= 30 && GECKO_CACHE_TTL_S <= 300,
        "the TTL stays in the upstream's freshness band",
      );
      const stats = client.stats();
      assert.equal(stats.active, true);
      assert.equal(stats.requests, 1);
      assert.equal(stats.ok, 1, "a cached 200 counts as an OK response");
      assert.equal(stats.cacheHits, 1, "and the HIT is counted (this is how the fix is verified live)");
      assert.equal(geckoFeedStats().cacheHits, 1, "the isolate publishes this client's state");
    } finally {
      global.fetch = origFetch;
    }
  });

  await test("GeckoTerminalClient: consecutive 429s escalate the pause; a success resets it", async () => {
    const origFetch = global.fetch;
    let mode = "429";
    global.fetch = async () =>
      mode === "429"
        ? new Response(JSON.stringify({ status: { error_code: 429 } }), { status: 429 })
        : new Response(JSON.stringify({ data: [] }), { status: 200 });
    try {
      const client = new GeckoTerminalClient({ geckoterminalRequestIntervalMs: 0 });
      const t0 = Date.now();
      await client.fetchNewPools(1);
      const first = client.stats();
      assert.equal(first.http429, 1);
      assert.equal(first.consecutive429, 1, "the streak is what drives the escalation");
      assert.ok(
        first.backoffUntil - t0 >= GECKO_RATE_LIMIT_BACKOFF_MS * 0.85,
        `the first window is still the 5-minute base (got ${first.backoffUntil - t0}ms)`,
      );
      // Backed off: neither endpoint may spend a request.
      await client.fetchTrendingPools(20);
      assert.equal(client.stats().requests, 1, "a backed-off call must not spend a request");
      // Expire the window and 429 again: the next window is longer.
      client.rateLimitedUntil = Date.now() - 1;
      await client.fetchNewPools(1);
      const second = client.stats();
      assert.equal(second.consecutive429, 2);
      assert.ok(second.backoffMs > first.backoffMs, "the second 429 doubles the pause");
      assert.ok(
        second.backoffMs <= GECKO_BACKOFF_MAX_MS * 1.1 + 1,
        "and never past the configured ceiling",
      );
      // A success clears the streak, so a later 429 starts from the base again.
      client.rateLimitedUntil = Date.now() - 1;
      mode = "200";
      await client.fetchNewPools(1);
      const healed = client.stats();
      assert.equal(healed.consecutive429, 0);
      assert.equal(healed.backoffMs, 0, "the escalation is retired on recovery");
      assert.ok(healed.lastOkAt > 0);
      assert.equal(healed.ok, 1);
    } finally {
      global.fetch = origFetch;
    }
  });

  await test("geckoBackoffMs / parseRetryAfterMs: Retry-After wins, capped", () => {
    const flat = () => 0.5; // deterministic: no jitter
    assert.equal(geckoBackoffMs(1, null, flat), GECKO_RATE_LIMIT_BACKOFF_MS);
    assert.equal(geckoBackoffMs(2, null, flat), GECKO_RATE_LIMIT_BACKOFF_MS * 2);
    assert.equal(geckoBackoffMs(9, null, flat), GECKO_BACKOFF_MAX_MS, "the doubling stops at the ceiling");
    // An explicit Retry-After wins when it is LONGER, but cannot park the feed
    // past the hard cap; when it is shorter, the escalation still applies (a
    // 429 is a 429 whatever the header says).
    assert.equal(geckoBackoffMs(1, 20 * 60_000, flat), 20 * 60_000);
    assert.equal(geckoBackoffMs(1, 24 * 3600_000, flat), GECKO_BACKOFF_HARD_MAX_MS);
    assert.equal(geckoBackoffMs(3, 1000, flat), GECKO_RATE_LIMIT_BACKOFF_MS * 4);
    const now = Date.UTC(2026, 8, 20, 7, 0, 0);
    assert.equal(parseRetryAfterMs("120", now), 120_000, "delay-seconds form");
    assert.equal(parseRetryAfterMs(new Date(now + 90_000).toUTCString(), now), 90_000, "HTTP-date form");
    assert.equal(parseRetryAfterMs("garbage", now), null);
    assert.equal(parseRetryAfterMs(null, now), null);
    assert.equal(parseRetryAfterMs("0", now), null, "an already-expired answer is not a window");
  });

  await test("pushDeferralDelta: only new increments are persisted; a rebuilt scanner never writes a negative", () => {
    // Nothing new since the last CONFIRMED write -> the flush writes nothing.
    assert.equal(
      pushDeferralDelta({ deferred: 3, recovered: 1 }, { deferred: 3, recovered: 1 }),
      null,
    );
    // Refusals and make-ups in the same tick both count. Held-back candidates
    // are NOT part of this cursor: their amount rides its own pending delta
    // (the rebuild resets this cursor's location but not the counter — see
    // stalledUnflushed in worker.ts), so a chain-deferral-only tick is folded
    // in by nextPushDeferralSnapshot below rather than by this difference.
    assert.deepEqual(
      pushDeferralDelta({ deferred: 3, recovered: 1 }, { deferred: 5, recovered: 2 }),
      { deferred: 2, recovered: 1 },
    );
    // The re-offer after a failed write is the SAME delta (the caller only
    // advances its baseline once the write landed), so a lost write delays
    // the count by a tick instead of dropping it.
    assert.deepEqual(
      pushDeferralDelta({ deferred: 3, recovered: 1 }, { deferred: 5, recovered: 2 }),
      { deferred: 2, recovered: 1 },
    );
    // A wedged-isolate rebuild restarts the scanner's counters at zero; the
    // delta floors to null rather than going negative (the worker also
    // resets its baseline in the rebuild block).
    assert.equal(pushDeferralDelta({ deferred: 5, recovered: 2 }, { deferred: 0, recovered: 0 }), null);
    assert.equal(pushDeferralDelta({ deferred: 5, recovered: 2 }, { deferred: 1, recovered: 2 }), null);
    assert.deepEqual(
      pushDeferralDelta({ deferred: 5, recovered: 2 }, { deferred: 6, recovered: 2 }),
      { deferred: 1, recovered: 0 },
    );
  });

  await test("nextPushDeferralSnapshot: a chain-deferral-only tick is still persisted", () => {
    // The live shape that used to leave no trace in the counters at all: a
    // qualifying coin in hand, no refusal (so no `deferred`), no make-up —
    // the chain simply ran out of tick. Nothing moved on the cursor, yet the
    // row has to record it.
    const row = nextPushDeferralSnapshot(
      null,
      { deferred: 0, recovered: 0, stalled: 2, pending: 2 },
      1_000,
      { owner: "isoA", deferred: 0, recovered: 0, stalled: 2 },
    );
    assert.equal(row.deferredTotal, 0, "not a claim-stage refusal");
    assert.equal(row.recoveredTotal, 0);
    assert.equal(row.stalledTotal, 2, "the held-back coins are accounted");
    assert.equal(row.firstStallAt, 1_000, "and stamped, so the first rise is provable");
    assert.equal(row.lastStallAt, 1_000);
    assert.equal(row.firstDeferredAt, null, "a held-back coin is not a deferral stamp");
    assert.equal(row.events[0].deferred, 0);
    assert.equal(row.events[0].stalled, 2);
    // A later tick that holds none back keeps the totals and leaves the stamp
    // alone (only the events ring moves on).
    const flat = nextPushDeferralSnapshot(
      JSON.stringify(row),
      { deferred: 0, recovered: 0, stalled: 0, pending: 0 },
      2_000,
      { owner: "isoA", deferred: 0, recovered: 0, stalled: 2 },
    );
    assert.equal(flat.stalledTotal, 2);
    assert.equal(flat.lastStallAt, 1_000);
    assert.equal(flat.firstStallAt, 1_000);
  });

  await test("heldBackCandidates: the chain-stage gap a completed tick left behind", () => {
    // The shape that used to vanish: a coin in hand, no card out. The chain
    // broke on its deadline BEFORE the claim stage, so nothing counted it.
    assert.equal(
      heldBackCandidates({ pushPhase: "done", candidates: 1, pushed: 0, cardSendDeferred: 0 }),
      1,
    );
    // Every candidate delivered -> nothing held back.
    assert.equal(
      heldBackCandidates({ pushPhase: "done", candidates: 2, pushed: 2 }),
      0,
    );
    // A claim REFUSAL already has its own counter, so it is not added again…
    assert.equal(
      heldBackCandidates({ pushPhase: "done", candidates: 1, pushed: 0, cardSendDeferred: 1 }),
      0,
      "a refused card is counted as deferred, never twice",
    );
    // …but a tick that refused one card AND held another back still reports
    // the held-back one (the mixed case an all-or-nothing guard would drop).
    assert.equal(
      heldBackCandidates({ pushPhase: "done", candidates: 2, pushed: 0, cardSendDeferred: 1 }),
      1,
    );
    assert.equal(
      heldBackCandidates({ pushPhase: "done", candidates: 3, pushed: 1, cardSendDeferred: 1 }),
      1,
    );
    // Only COMPLETED ticks qualify: a tick the race cut short publishes its
    // inflight summary stamped with the step it died in, and a tick that never
    // scanned has no summary — both are the dead-tick bookkeeping's business.
    assert.equal(heldBackCandidates({ pushPhase: "send:claim", candidates: 1, pushed: 0 }), 0);
    assert.equal(heldBackCandidates({ pushPhase: "tracker", candidates: 1, pushed: 0 }), 0);
    assert.equal(heldBackCandidates({ candidates: 1, pushed: 0 }), 0, "no phase stamp, no claim");
    assert.equal(heldBackCandidates(null), 0);
    // Never negative: counters that disagree (a rebuilt scanner, a summary
    // assembled from a stale copy) must read as "nothing held back".
    assert.equal(heldBackCandidates({ pushPhase: "done", candidates: 1, pushed: 3 }), 0);
    assert.equal(heldBackCandidates({ pushPhase: "done" }), 0);
  });

  await test("nextPushDeferralSnapshot: totals accumulate across ticks, first/last stamps are stable", () => {
    const first = nextPushDeferralSnapshot(
      null,
      { deferred: 2, recovered: 0, pending: 2 },
      1_000,
    );
    assert.equal(first.deferredTotal, 2);
    assert.equal(first.recoveredTotal, 0);
    assert.equal(first.pending, 2, "backlog gauge rides the event");
    assert.equal(first.firstDeferredAt, 1_000);
    assert.equal(first.lastDeferAt, 1_000);
    assert.equal(first.firstRecoveredAt, null, "no make-up push yet");
    assert.deepEqual(first.events, [
      { at: 1_000, deferred: 2, recovered: 0, stalled: 0, pending: 2 },
    ]);
    // Round-trips through the stored row: the next tick folds into it.
    const second = nextPushDeferralSnapshot(
      JSON.stringify(first),
      { deferred: 0, recovered: 1, stalled: 1, pending: 1 },
      2_000,
    );
    assert.equal(second.deferredTotal, 2, "totals accumulate across ticks");
    assert.equal(second.recoveredTotal, 1);
    assert.equal(second.stalledTotal, 1, "held-back coins accumulate too");
    assert.equal(second.firstStallAt, 2_000, "the first held-back stamp is set once");
    assert.equal(second.lastStallAt, 2_000);
    assert.equal(second.firstDeferredAt, 1_000, "the first deferral stamp never moves");
    assert.equal(second.firstRecoveredAt, 2_000, "the first make-up push is stamped once");
    assert.equal(second.lastRecoveredAt, 2_000);
    assert.equal(second.lastDeferAt, 1_000, "a recovery-only tick does not move the deferral stamp");
    assert.equal(second.events.length, 2);
  });

  await test("nextPushDeferralSnapshot: the gauge is the list's length, never the caller's counter", () => {
    // The live shape (2026-09-20): /health published `deferral.pending: 7`
    // next to a five-token list for a whole tick and on every heartbeat after
    // it, because the gauge came from the scanner's scan-time count
    // (`summary.deferPending`, taken BEFORE the duplicate guard trimmed the
    // list) while the list came from the post-guard registry. A caller that
    // hands over a list now gets that list's length as the gauge.
    const held = ["AAA", "BBB", "CCC", "DDD", "EEE"];
    const row = nextPushDeferralSnapshot(
      null,
      { deferred: 0, recovered: 0, stalled: 0, pending: 7 },
      1_000,
      null,
      held,
    );
    assert.equal(row.pending, held.length, "the gauge is the list's length, not the caller's count");
    assert.deepEqual(row.pendingTokens, held);
    assert.equal(row.events[0].pending, held.length, "and the event carries the same number");
    // Duplicates collapse first, so the gauge can never be inflated by one.
    const dupes = nextPushDeferralSnapshot(
      JSON.stringify(row),
      { deferred: 0, recovered: 0, stalled: 0, pending: 5 },
      2_000,
      null,
      ["AAA", "AAA", "BBB"],
    );
    assert.equal(dupes.pending, 2);
    assert.deepEqual(dupes.pendingTokens, ["AAA", "BBB"]);
    // An EMPTY list from a caller that read its store still never wipes it — a
    // lost obligation is a missed card, an extra one is a duplicate, and only
    // one of those is recoverable. The gauge follows the list that is KEPT, so
    // the two stay one fact in this branch too.
    const empty = nextPushDeferralSnapshot(
      JSON.stringify(dupes),
      { deferred: 0, recovered: 0, stalled: 0, pending: 4 },
      3_000,
      null,
      [],
    );
    assert.deepEqual(empty.pendingTokens, ["AAA", "BBB"], "an empty list never wipes the store");
    assert.equal(empty.pending, 2, "and the gauge still matches the list that was kept");
    // No list at all keeps the legacy contract: the caller's count is the gauge.
    const legacy = nextPushDeferralSnapshot(
      JSON.stringify(empty),
      { deferred: 0, recovered: 0, stalled: 0, pending: 3 },
      4_000,
    );
    assert.equal(legacy.pending, 3, "no list → the caller's count stands");
    assert.deepEqual(legacy.pendingTokens, ["AAA", "BBB"], "and the stored list is untouched");
  });

  await test("nextPushDeferralSnapshot: ring capped and TTL-pruned, totals survive both", () => {
    const base = 1_700_000_000_000;
    let raw = null;
    for (let i = 0; i < PUSH_DEFERRAL_RING_MAX + 20; i++) {
      raw = JSON.stringify(
        nextPushDeferralSnapshot(raw, { deferred: 1, recovered: 0, pending: 1 }, base + i * 1_000),
      );
    }
    let snap = parsePushDeferralSnapshot(raw);
    assert.equal(snap.events.length, PUSH_DEFERRAL_RING_MAX, "ring capped at the keep size");
    assert.equal(
      snap.deferredTotal,
      PUSH_DEFERRAL_RING_MAX + 20,
      "totals are not capped by the ring",
    );
    // A week later the old events fall out of the rate window but the
    // cumulative numbers (and the first/last stamps) stay.
    const later = base + 400 * 24 * 3600_000;
    snap = nextPushDeferralSnapshot(raw, { deferred: 1, recovered: 0, pending: 1 }, later);
    assert.equal(snap.events.length, 1, "only the fresh event survives the TTL prune");
    assert.equal(snap.deferredTotal, PUSH_DEFERRAL_RING_MAX + 21, "totals survive pruning");
    assert.equal(snap.firstDeferredAt, base, "the first-ever stamp survives pruning");
  });

  await test("push deferral snapshot: the serialized row stays a small write", () => {
    // Both heartbeats carry this snapshot (claim + completion), and the
    // completion batch has a fixed ~4.5s window inside a tick the cron
    // invocation kills at ~9.6s. Bytes are the one thing buyable there, so a
    // ring raise must not silently eat the flush — 2026-09-20: 60 → 12
    // events, 4.3KB → ~1.1KB of the 12.4KB batch.
    const base = 1_700_000_000_000;
    let raw = null;
    for (let i = 0; i < PUSH_DEFERRAL_RING_MAX + 5; i++) {
      raw = JSON.stringify(
        nextPushDeferralSnapshot(raw, { deferred: 1, recovered: 0, stalled: 0, pending: 2 }, base + i * 1_000),
      );
    }
    const snap = nextPushDeferralSnapshot(
      raw,
      { deferred: 0, recovered: 0, stalled: 0, pending: 2 },
      base + 90_000,
      null,
      ["3n2NJk8vg25at8jvaAzUfEnGZyXqazSqa5U6xyPfCW56", "9UfySjMsSz4tyQR9X2SCgPaWagQL5eYPpw9y9Nr2STNK"],
    );
    const bytes = Buffer.byteLength(JSON.stringify(snap));
    assert.equal(snap.events.length, PUSH_DEFERRAL_RING_MAX, "a full ring is what gets measured");
    assert.ok(bytes < 1_500, `deferral snapshot stays a small write (${bytes}B)`);
  });

  await test("parsePushDeferralSnapshot: missing/corrupt rows degrade to null or zeros, never throw", () => {
    assert.equal(parsePushDeferralSnapshot(null), null);
    assert.equal(parsePushDeferralSnapshot(undefined), null, "a cold isolate has no row");
    assert.equal(parsePushDeferralSnapshot(""), null);
    assert.equal(parsePushDeferralSnapshot("{oops"), null);
    assert.equal(parsePushDeferralSnapshot("[]"), null, "an array is not a snapshot");
    const coerced = parsePushDeferralSnapshot(
      JSON.stringify({
        deferredTotal: "7",
        recoveredTotal: -3,
        pending: "2",
        firstDeferredAt: "5",
        events: [{ at: "5", deferred: 1 }, { nope: 1 }],
      }),
    );
    assert.equal(coerced.deferredTotal, 7, "numeric strings coerce");
    assert.equal(coerced.recoveredTotal, 0, "a negative count clamps to 0");
    assert.equal(coerced.pending, 2);
    assert.equal(coerced.firstDeferredAt, 5);
    assert.equal(coerced.events.length, 1, "an event without a timestamp is dropped");
    assert.equal(coerced.events[0].deferred, 1);
  });

  await test("parsePushDeferralSnapshot: an oversized ring is trimmed on READ, newest kept", () => {
    // The row is only rewritten when a deferral happens, so a row written
    // before the cap was lowered would otherwise keep its full ring in every
    // heartbeat the isolate mirrors (measured live after the 60 → 12 cut).
    const over = PUSH_DEFERRAL_RING_MAX + 30;
    const snap = parsePushDeferralSnapshot(
      JSON.stringify({
        deferredTotal: over,
        pending: 2,
        events: Array.from({ length: over }, (_, i) => ({
          at: 1_700_000_000_000 + i * 1_000,
          deferred: 1,
          recovered: 0,
          stalled: 0,
          pending: 2,
        })),
      }),
    );
    assert.equal(snap.events.length, PUSH_DEFERRAL_RING_MAX, "the reader enforces the same cap");
    assert.equal(
      snap.events[snap.events.length - 1].at,
      1_700_000_000_000 + (over - 1) * 1_000,
      "the newest events are the ones kept",
    );
    assert.equal(snap.deferredTotal, over, "the totals are never touched by the trim");
  });

  await test("loadPushDeferralSnapshot: an unwritten row reads as zeros, not null", () => {
    // The /health mirror must never be null: a reader has to tell "nothing
    // deferred yet" from "the counter channel is missing", and the first rise
    // must show up as 0 -> 1.
    const cold = loadPushDeferralSnapshot(null);
    assert.deepEqual(cold, {
      deferredTotal: 0,
      recoveredTotal: 0,
      stalledTotal: 0,
      firstStallAt: null,
      lastStallAt: null,
      pending: 0,
      pendingTokens: [],
      firstDeferredAt: null,
      lastDeferAt: null,
      firstRecoveredAt: null,
      lastRecoveredAt: null,
      events: [],
      applied: null,
    });
    // A corrupt row degrades the same way (recount from zero) instead of
    // blanking the field on the heartbeat.
    assert.equal(loadPushDeferralSnapshot("{oops").deferredTotal, 0);
    // A real row passes through unchanged.
    const stored = JSON.stringify(
      nextPushDeferralSnapshot(null, { deferred: 2, recovered: 1, pending: 1 }, 5_000),
    );
    const loaded = loadPushDeferralSnapshot(stored);
    assert.equal(loaded.deferredTotal, 2);
    assert.equal(loaded.recoveredTotal, 1);
    assert.equal(loaded.firstRecoveredAt, 5_000, "the milestone stamp survives the load");
    // A row whose gauge disagrees with its own list is mirrored CONSISTENTLY:
    // the mirror derives the gauge, so a row written by an older build (which
    // published the caller's scan-time count) cannot keep republishing the
    // disagreement on every delta-less tick. Live 2026-09-20 02:44Z: that pair
    // was still being served minutes after the write-side fix deployed.
    const legacyRow = JSON.stringify({
      deferredTotal: 90,
      pending: 7,
      pendingTokens: ["AAA", "BBB", "CCC", "DDD", "EEE"],
      events: [],
    });
    assert.equal(loadPushDeferralSnapshot(legacyRow).pending, 5, "the gauge follows the list");
    assert.equal(loadPushDeferralSnapshot(legacyRow).pendingTokens.length, 5);
  });

  await test("pushDeferralAlreadyApplied: only this isolate's own already-persisted totals are recognised", () => {
    const row = nextPushDeferralSnapshot(
      null,
      { deferred: 2, recovered: 0, pending: 2 },
      1_000,
      { owner: "isoA", deferred: 2, recovered: 0 },
    );
    assert.equal(row.applied.owner, "isoA", "the folding isolate is recorded");
    assert.equal(pushDeferralAlreadyApplied(row, "isoA", { deferred: 2, recovered: 0 }), true);
    // Another isolate carrying coincidentally identical counters owns a
    // DIFFERENT delta — its write must not be suppressed as a duplicate.
    assert.equal(pushDeferralAlreadyApplied(row, "isoB", { deferred: 2, recovered: 0 }), false);
    // Same isolate, more counters since -> genuinely new increments.
    assert.equal(pushDeferralAlreadyApplied(row, "isoA", { deferred: 3, recovered: 0 }), false);
    assert.equal(pushDeferralAlreadyApplied(row, "isoA", { deferred: 2, recovered: 1 }), false);
    assert.equal(pushDeferralAlreadyApplied(null, "isoA", { deferred: 2, recovered: 0 }), false);
  });

  await test("a committed-but-response-lost write is ACKed, not added twice", () => {
    // The marker carries all three counters (the production caller always
    // passes them); `stalled` is not part of the CURSOR, but it is part of the
    // identity a re-offer is matched against.
    const totals = { deferred: 2, recovered: 0, stalled: 0 };
    // Tick 1: the flush writes the delta, the row lands...
    const rowAfterCommit = nextPushDeferralSnapshot(
      null,
      { ...totals, pending: 2 },
      1_000,
      { owner: "isoA", ...totals },
    );
    // ...but the caller never learns (hard wall / invocation kill), so its
    // baseline stays put and it re-offers the same delta on tick 2.
    const reoffered = pushDeferralDelta({ deferred: 0, recovered: 0 }, totals);
    assert.deepEqual(reoffered, { deferred: 2, recovered: 0 }, "the delta really is re-offered");
    // The applied marker is what stops the re-offer from inflating the totals:
    // keyed on (isolate, totals), it recognises the earlier commit.
    const raw = JSON.stringify(rowAfterCommit);
    assert.equal(
      pushDeferralAlreadyApplied(parsePushDeferralSnapshot(raw), "isoA", totals),
      true,
      "a blind re-offer would add these again",
    );
    const blind = nextPushDeferralSnapshot(raw, { ...totals, pending: 2 }, 2_000, {
      owner: "isoA",
      ...totals,
    });
    assert.equal(blind.deferredTotal, 4, "without the marker the row would double-count");
  });

  await test("an isolate with no events of its own still mirrors another isolate's row", () => {
    // The cross-isolate staleness this guards against: /health serves whichever
    // isolate wrote the last heartbeat, so a boot-time-only copy would publish
    // zeros (and a null firstRecoveredAt) after another isolate had already
    // recorded the very milestone the counters exist to prove.
    const deferral = nextPushDeferralSnapshot(
      null,
      { deferred: 1, recovered: 0, pending: 1 },
      1_000,
      { owner: "isoB", deferred: 1, recovered: 0 },
    );
    // isoB's own later tick pays the deferred coin back — nothing to do with us.
    const otherIsolate = JSON.stringify(
      nextPushDeferralSnapshot(
        JSON.stringify(deferral),
        { deferred: 0, recovered: 1, pending: 0 },
        2_000,
        { owner: "isoB", deferred: 1, recovered: 1 },
      ),
    );
    const mirrored = loadPushDeferralSnapshot(otherIsolate);
    assert.equal(mirrored.deferredTotal, 1);
    assert.equal(mirrored.recoveredTotal, 1);
    assert.equal(mirrored.firstRecoveredAt, 2_000, "the milestone stamp is visible from any isolate");
    // This isolate has nothing of its own -> no delta to write (a read-only
    // refresh, no row mutation).
    assert.equal(pushDeferralDelta({ deferred: 0, recovered: 0 }, { deferred: 0, recovered: 0 }), null);
  });

  // ---------- re-eval pool coverage (config slot counts) ----------

  // The 2026-09-15 coverage fix sizes the far zone so each of its
  // sub-windows fits under the band's per-visit LIMIT: the live probe showed
  // the far band pinned exactly at 210 rows (its cap) while the near band
  // came back at 413 of 490, i.e. only the far zone re-read the same
  // signal-ordered head every visit. 18-min sweeps give 12 far slots of
  // ~1.6h each; the near zone needs no extra slots because it already fits.
  // The pool read is the one DB call whose failure used to be silent: the
  // scanner races it against a cap and resolves [] on a loss, which is
  // indistinguishable from "the window has no coins" and made the tick
  // early-return and evaluate nothing (2026-09-19: 60-100% of ticks per 10 min
  // while the profiles feed was also empty). These tests pin the replacement:
  // a FAILED read re-serves the last good slice, a genuinely EMPTY read does
  // not, and a failure before any good read still surfaces.
  await test("PoolFallbackDb: a failed pool read re-sweeps the last good slice", async () => {
    const t = tmpDb();
    let fail = false;
    // Delegates to the real local SQLite until `fail` flips, then rejects the
    // way the DB layer's 1.2x hard wall does.
    const flaky = {
      execute: (a) =>
        fail
          ? Promise.reject(new Error("db execute hit the 1440ms hard wall"))
          : t.client.execute(a),
      batch: (a) =>
        fail ? Promise.reject(new Error("db batch hit the hard wall")) : t.client.batch(a),
      close: () => t.client.close(),
    };
    const db = new PoolFallbackDb("file:injected", undefined, flaky);
    await db.init();
    const now = Date.now();
    const seed = async (token, ageMin, mcap, liq) => {
      const launch = now - ageMin * 60_000;
      await t.client.execute({
        sql: `INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, max_mcap_observed, max_liquidity_observed)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [token, launch, 9000, ageMin, launch, mcap, liq],
      });
    };
    // Inside the chat's 80-1560 min window and above every qualify floor.
    await seed("INSIDE1", 100, 120_000, 40_000);
    await seed("INSIDE2", 300, 150_000, 50_000);
    // Aged out of the 30h re-eval span - must never appear either way.
    await seed("TOOOLD", 40 * 60, 120_000, 40_000);
    const opts = {
      sinceMs: now - 30 * 3600_000,
      minLaunchMs: now - (1560 + 180) * 60_000,
      maxLaunchMs: now - (80 - 180) * 60_000,
      windowEntryLaunchMs: now - 80 * 60_000,
      limit: 1000,
      nearSlots: 2,
      farSlots: 12,
      rotationPeriodMs: 90_000,
      minQualifyMcap: 30_000,
      maxQualifyMcap: 500_000,
      minQualifyLiquidity: 5_000,
      seenChatIds: ["chat-1"],
    };
    const first = await db.getReevalPool(opts);
    assert.ok(first.length > 0, "the seeded in-window coins must be found");
    assert.ok(
      first.every((r) => r.token.startsWith("INSIDE")),
      `only in-window coins are eligible, got ${first.map((r) => r.token)}`,
    );
    resetPoolFallbackStats();
    assert.equal(poolFallbackStats().count, 0);

    fail = true;
    const second = await db.getReevalPool(opts);
    assert.deepEqual(
      second.map((r) => r.token),
      first.map((r) => r.token),
      "the fallback must serve the same slice, in the same order",
    );
    assert.equal(poolFallbackStats().count, 1);
    assert.equal(poolFallbackStats().rows, first.length);
    assert.ok(poolFallbackStats().at > 0);

    // A read that comes back genuinely EMPTY is not masked by the fallback.
    fail = false;
    const empty = await db.getReevalPool({
      ...opts,
      minQualifyMcap: 900_000_000,
      maxQualifyMcap: undefined,
    });
    assert.equal(empty.length, 0);
    assert.equal(poolFallbackStats().count, 1, "an empty read must not count as a fallback");

    // Failure with no good read yet (fresh isolate) must still surface.
    const fresh = new PoolFallbackDb("file:injected", undefined, {
      execute: () => Promise.reject(new Error("boom")),
      batch: () => Promise.reject(new Error("boom")),
      close: async () => {},
    });
    resetPoolFallbackStats();
    await assert.rejects(() => fresh.getReevalPool(opts));
    assert.equal(poolFallbackStats().count, 0);
    await t.cleanup();
  });

  // The batched pool read is the QUERY-LAYER half: the same three bands in
  // ONE request instead of three sequential awaits (the measured 352-457ms
  // pool read ≈ 3 x the ~130ms Turso round trip). Because its band split is a
  // copy of getReevalPool's (that region is outside the edit window), this
  // test pins the two to the SAME tokens in the SAME order — drift in either
  // copy fails here rather than silently dropping a band in production.
  await test("getReevalPoolBatched: same bands, one round trip (drift guard)", async () => {
    const t = tmpDb();
    let executes = 0;
    let batches = 0;
    const counting = {
      execute: (a) => {
        executes++;
        return t.client.execute(a);
      },
      batch: (a, m) => {
        batches++;
        return t.client.batch(a, m);
      },
      close: () => t.client.close(),
    };
    const db = new Db("file:injected", undefined, counting);
    await db.init();
    const now = Date.now();
    const seed = async (token, ageMin) => {
      const launch = now - ageMin * 60_000;
      await t.client.execute({
        sql: `INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, max_mcap_observed, max_liquidity_observed)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [token, launch, 10_000, ageMin, launch, 120_000, 40_000],
      });
    };
    // Coins every 10 min across the whole window, NOT one per hand-guessed
    // band: the rotation slot decides where the near/far bands fall, so the
    // first version of this test placed its coins in empty bands and passed
    // vacuously (both paths agreeing on nothing). A dense spread means a wrong
    // boundary in either copy changes the returned set.
    for (let age = 20; age <= 700; age += 10) {
      await seed(`T${String(age).padStart(3, "0")}`, age);
    }
    // 40h old: outside the 30h span, must never appear.
    await seed("AGEDOUT", 40 * 60);
    const opts = {
      sinceMs: now - 30 * 3600_000,
      minLaunchMs: now - (1560 + 180) * 60_000,
      maxLaunchMs: now - (80 - 180) * 60_000,
      windowEntryLaunchMs: now - 80 * 60_000,
      limit: 1000,
      nearSlots: 2,
      farSlots: 12,
      // Huge period -> slot 0 for every call, so both methods see identical
      // bands and the comparison cannot straddle a rotation boundary.
      rotationPeriodMs: 1e12,
      minQualifyMcap: 30_000,
      maxQualifyMcap: 500_000,
      minQualifyLiquidity: 5_000,
      seenChatIds: ["chat-1"],
      now,
    };
    executes = 0;
    batches = 0;
    const perBand = await db.getReevalPool(opts);
    const perBandExecutes = executes;
    assert.equal(batches, 0, "the per-band path must not use batch()");
    assert.ok(perBandExecutes >= 3, `per-band should issue one read per band, saw ${perBandExecutes}`);
    // Non-vacuous: every zone really contributed rows (at rotationPeriodMs 1e12
    // the slot is 1, so the near band falls over ages 275-440 and the far band
    // over 548-657), and the coin outside the 30h span is never evaluated.
    const ages = perBand.map((r) => Number(r.token.slice(1)));
    assert.ok(ages.some((a) => a <= 110), "the hot band contributed rows");
    assert.ok(ages.some((a) => a > 110 && a <= 440), "the near band contributed rows");
    assert.ok(ages.some((a) => a > 440), "the far band contributed rows");
    assert.ok(
      !perBand.some((r) => r.token === "AGEDOUT"),
      "a coin outside the 30h span must never enter the pool",
    );

    executes = 0;
    batches = 0;
    const batched = await db.getReevalPoolBatched(opts);
    assert.equal(batches, 1, "the batched read must be exactly ONE request");
    assert.equal(executes, 0, "the batched read must not fall back to per-band execute() calls");
    assert.deepEqual(
      batched.map((r) => r.token),
      perBand.map((r) => r.token),
      "both paths must return the same coins in the same order",
    );
    // The qualify floor must bite in the batched SQL too (same filters).
    const floored = await db.getReevalPoolBatched({
      ...opts,
      minQualifyMcap: 900_000_000,
      maxQualifyMcap: undefined,
    });
    assert.equal(floored.length, 0, "a qualify floor above every coin must empty the batched pool");
    await t.cleanup();
  });

  // The dead-pool prune (2026-09-19). The pool's liquidity filter used to read
  // `max_liquidity_observed`, a lifetime high-water, so a coin that HAD a pool
  // and lost it stayed in the sweep forever: live, 48 of 49 logged rejects were
  // liquidity failures (~72% of them liquidity 0/null), `agedEval 4` of ~91
  // evaluated coins, and `wildebeest` read $0 against a $242K lifetime peak.
  // The prune now reads the LAST liquidity the scan measured — and a row nobody
  // has measured since the column existed keeps the old behavior (NULL passes),
  // so this cannot prune a coin on a guess.
  await test("pool: a drained pool is pruned on its recent reading, an unmeasured one is not", async () => {
    const t = tmpDb();
    const db = new Db("file:injected", undefined, t.client);
    await db.init();
    const now = Date.now();
    const seed = async (token, ageMin, maxLiq, lastLiq) => {
      const launch = now - ageMin * 60_000;
      await t.client.execute({
        sql: `INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, max_mcap_observed, max_liquidity_observed, last_liquidity_usd)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [token, launch, 10_000, ageMin, launch, 120_000, maxLiq, lastLiq],
      });
    };
    // Same peak for every coin, so ONLY the recent reading decides — and the
    // peak is far above the caller's own liquidity floor, i.e. the old filter
    // would have admitted all four.
    // All four sit in the same band (the hot zone around the window entry) so
    // the rotation cannot be what hides one of them.
    await seed("ALIVE1", 100, 250_000, 25_000);
    await seed("DEAD0", 102, 250_000, 0);
    await seed("DEAD400", 104, 250_000, 400);
    await seed("UNMEASURED", 106, 250_000, null);
    const opts = {
      sinceMs: now - 30 * 3600_000,
      minLaunchMs: now - (1560 + 180) * 60_000,
      maxLaunchMs: now - (80 - 180) * 60_000,
      windowEntryLaunchMs: now - 80 * 60_000,
      limit: 1000,
      nearSlots: 2,
      farSlots: 12,
      rotationPeriodMs: 1e12,
      minQualifyMcap: 30_000,
      maxQualifyMcap: 500_000,
      minQualifyLiquidity: 5_000,
      seenChatIds: ["chat-1"],
      now,
    };
    const tokens = (await db.getReevalPoolBatched(opts)).map((r) => r.token);
    assert.ok(tokens.includes("ALIVE1"), "a live pool stays in the sweep");
    assert.ok(
      tokens.includes("UNMEASURED"),
      "a coin with no recent reading keeps the old high-water-only behavior",
    );
    assert.ok(
      !tokens.includes("DEAD0"),
      "a drained pool ($0) leaves the sweep instead of being re-checked every rotation",
    );
    assert.ok(!tokens.includes("DEAD400"), "dust below the dead-pool floor is pruned too");

    // The write that feeds the prune: one call, one statement, per-coin values.
    const updated = await db.recordObservedLiquidity([
      { token: "ALIVE1", liquidityUsd: 0 },
      { token: "UNMEASURED", liquidityUsd: 12_000 },
    ]);
    assert.equal(updated, 2, "both coins are written");
    const after = (await db.getReevalPoolBatched(opts)).map((r) => r.token);
    assert.ok(
      !after.includes("ALIVE1"),
      "the coin whose pool just drained is pruned on the very next read",
    );
    assert.ok(after.includes("UNMEASURED"), "a measured, live pool stays");
    assert.equal(
      await db.recordObservedLiquidity([]),
      0,
      "an empty batch is a no-op (no round trip on a tick that fetched nothing)",
    );
    await t.cleanup();
  });

  // Axiom kill switch (AXIOM_ENABLED, default on). Off must mean the Worker
  // never builds the Axiom client: the session costs one /token-info call per
  // final candidate and fires a "session dead" admin alert once it expires,
  // and neither the trending switch nor the bot-users floor covers both.
  await test("loadConfig: AXIOM_ENABLED=0 disables Axiom, default stays on", () => {
    assert.equal(loadConfig({}).axiomEnabled, true);
    assert.equal(loadConfig({ AXIOM_ENABLED: "1" }).axiomEnabled, true);
    assert.equal(loadConfig({ AXIOM_ENABLED: "0" }).axiomEnabled, false);
    // Switching off must not silently retune what comes back on revival:
    // the bot-users floor and the feed size keep their documented defaults
    // (wrangler.toml sets AXIOM_TRENDING_LIMIT=0 explicitly while disabled),
    // and the Worker is still not allowed to be a refresher.
    const off = loadConfig({ AXIOM_ENABLED: "0" });
    assert.equal(off.axiomMinBotUsers, 90);
    assert.equal(off.axiomTrendingLimit, 20);
    assert.equal(off.axiomExternalRefresh, false);
  });

  // If these numbers drift, the far zone silently starves again (its oldest
  // coins never read) — the bug this test prevents.
  await test("loadConfig: 3/18-min sweeps give a full-coverage far zone", () => {
    const c = loadConfig({
      REEVAL_NEAR_SWEEP_MIN: "3",
      REEVAL_FAR_SWEEP_MIN: "18",
      REEVAL_POOL_CACHE_SECONDS: "90",
    });
    assert.equal(c.reevalPoolCacheMs, 90_000);
    assert.equal(c.reevalNearSlots, 2);
    assert.equal(c.reevalFarSlots, 12);
    // Slots × cache TTL is the advertised full-sweep cadence.
    assert.equal((c.reevalNearSlots * c.reevalPoolCacheMs) / 60_000, 3);
    assert.equal((c.reevalFarSlots * c.reevalPoolCacheMs) / 60_000, 18);
    // A far sub-window must stay under the far band LIMIT (210 rows at the
    // 1000-row pool) for the sweep to actually cover the zone.
    const farZoneHours = 26 - 6.8;
    const rowsPerFarSlot = farZoneHours / c.reevalFarSlots;
    assert.ok(
      rowsPerFarSlot <= 2.5,
      `far sub-window ${rowsPerFarSlot.toFixed(2)}h is too wide to fit under the band LIMIT`,
    );
    // Legacy 9-min value still maps to the old 6 slots.
    assert.equal(
      loadConfig({
        REEVAL_NEAR_SWEEP_MIN: "3",
        REEVAL_FAR_SWEEP_MIN: "9",
        REEVAL_POOL_CACHE_SECONDS: "90",
      }).reevalFarSlots,
      6,
    );
  });

  // ---------- scanner.ts re-eval pool rotation slice ----------

  await test("DexScreenerClient: concurrent pair batches stay throttled and all resolve", async () => {
    // The pipelined fetch must never fire two actual requests closer than
    // the throttle interval apart, even with 2 workers pulling batches.
    const starts = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 30)); // fake network latency
      return new Response(JSON.stringify({ pairs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      const cfg = loadConfig({ DEX_REQUEST_INTERVAL_MS: "80" });
      const dex = new DexScreenerClient(cfg);
      // 90 fresh addresses = 3 batches; the workers pipeline them.
      const addrs = Array.from({ length: 90 }, (_, i) => `MINT${i}`.padEnd(44, "x"));
      const t0 = Date.now();
      const pairs = await dex.fetchPairsForTokens(addrs);
      const elapsed = Date.now() - t0;
      assert.equal(pairs.size, 0); // empty responses parse to no pairs
      assert.equal(starts.length, 3, "all 3 batches dispatched");
      // Actual request starts must be spaced ≥ interval − small jitter.
      for (let i = 1; i < starts.length; i++) {
        assert.ok(
          starts[i] - starts[i - 1] >= 70,
          `request starts ${i - 1}->${i} only ${starts[i] - starts[i - 1]}ms apart (< 70ms)`,
        );
      }
      // Pipelining sanity: 3 batches × (spacing 80 + latency 30) would be
      // ~270ms+ sequential (plus retry sleeps on failure paths); with
      // latency/spacing overlap the total must stay well under that —
      // generous bound to keep the test deterministic under CI load.
      assert.ok(elapsed < 900, `3 batches took ${elapsed}ms — pipelining not effective`);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("DexScreenerClient: a 429 is observable and arms the cache-only backoff", async () => {
    // The pair path retries with a deadline, so a budgeted 429 comes back as
    // a `null` response instead of a throw — the batch loop's own /429/ check
    // never ran and a rate-limited tick was indistinguishable from an empty
    // one. The status is now recorded in getJson (the only place it is
    // visible), which is what getStats() and the /health dex block report.
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("rate limited", { status: 429 });
    };
    const episodes = [];
    try {
      const cfg = loadConfig({
        DEX_REQUEST_INTERVAL_MS: "0",
        REEVAL_POOL_CACHE_SECONDS: "90",
      });
      const dex = new DexScreenerClient(cfg, {
        onBatch429: (at) => episodes.push(at),
      });
      assert.equal(dex.getStats().http429, 0, "starts with no 429s");
      assert.equal(dex.getStats().intervalMs, 0, "spacing comes from config");

      const addrs = Array.from({ length: 30 }, (_, i) => `MINT${i}`.padEnd(44, "x"));
      const pairs = await dex.fetchPairsForTokens(addrs);
      assert.equal(pairs.size, 0, "a limited batch contributes no pairs");

      const stats = dex.getStats();
      assert.ok(stats.http429 >= 1, `http429 should count the 429 (got ${stats.http429})`);
      assert.ok(stats.last429At !== null, "last429At is set");
      assert.ok(stats.blockedForMs > 0, "the cache-only backoff is armed");
      // One notify per episode, not per retry attempt / batch.
      assert.equal(episodes.length, 1, `one hook per episode (got ${episodes.length})`);

      // While the backoff is armed the next tick must not touch the wire at
      // all — that is the whole point of arming it from getJson.
      const before = calls;
      await dex.fetchPairsForTokens(addrs);
      assert.equal(calls, before, "blocked calls serve cache only (no requests)");
      assert.equal(episodes.length, 1, "no duplicate episode notify while blocked");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  await test("Scanner.abort publishes the in-flight summary so timeout rows carry diagnostics", async () => {
    // Before the 2026-09-12 fix a tripped 12s race flushed summary:null —
    // no feedsMs, no pool, no phase counts — because runOnce only publishes
    // diag in its finally (after it settles). abort() must republish the
    // in-flight diag object immediately.
    const { Scanner } = require("../dist/scanner.js");
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const cfg = loadConfig({});
      const scanner = new Scanner(db, { api: { sendMessage: async () => ({}) } }, new DexScreenerClient(cfg), cfg, null, null, null);
      assert.equal(scanner.lastSummary, null);
      // Abort with no scan ever started: must not fabricate a summary.
      scanner.abort();
      assert.equal(scanner.lastSummary, null, "no in-flight scan → no summary published");
      // Simulate the in-flight diag registration + abort publication path:
      // register an object as the scanner would at runOnce start, then
      // abort(). The published object must be the same instance (mutations
      // by the still-running scan are visible in the flushed heartbeat).
      const diag = { profiles: 3, pool: 42, candidates: 0, pushed: 0 };
      scanner.lastSummary = null;
      // Reach the private field via a controlled reflection (test-only).
      Object.defineProperty(scanner, "inflightSummary", { value: diag, configurable: true });
      scanner.abort();
      assert.equal(scanner.lastSummary, diag, "abort republishes the in-flight diag");
      assert.ok(scanner.lastSummary === diag, "same instance — live mutations visible");
    } finally {
      await t.cleanup();
    }
  });

  await test("Scanner: a race-cut tick flushes the candidate-chain step it was inside", async () => {
    // The chain is the tick's longest serial section (eleven awaited upstream
    // steps) and the thing the worker's race cuts, but a cut tick only
    // reported `candidates 1, pushed 0`. markPhase stamps the in-flight diag
    // — the SAME object abort() republishes — so the flushed row names the
    // step and the tick-relative ms it started at.
    const { Scanner } = require("../dist/scanner.js");
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const cfg = loadConfig({});
      const scanner = new Scanner(db, { api: { sendMessage: async () => ({}) } }, new DexScreenerClient(cfg), cfg, null, null, null);
      const diag = { profiles: 0, pool: 0, candidates: 1, pushed: 0, evalMs: undefined };
      Object.defineProperty(scanner, "inflightSummary", { value: diag, configurable: true });
      scanner.markPhase(diag, "flurry", Date.now() - 1500);
      scanner.abort();
      assert.equal(
        scanner.lastSummary.pushPhase,
        "flurry",
        "the cut tick must name the chain step it died in",
      );
      assert.ok(
        scanner.lastSummary.pushPhaseMs >= 1400,
        `phase age must be tick-relative (got ${scanner.lastSummary.pushPhaseMs})`,
      );
    } finally {
      await t.cleanup();
    }
  });

  await test("Scanner: the tracker's pair lookup reuses the tick's pairs and falls back to Jupiter", async () => {
    // The tracked coins are PUSHED coins, which the re-eval pool query
    // excludes, so the tracker's batch is a second request — and when
    // DexScreener is 429-blocked that request returns an empty map and the
    // whole pass evaluates zero rows (live: `rows 0/30 pairs 0/6 miss 6` in
    // 36ms). The pass must reuse what the scan already fetched and take the
    // same Jupiter fallback the front pair phase takes.
    const { Scanner } = require("../dist/scanner.js");
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const cfg = loadConfig({});
      const dex = new DexScreenerClient(cfg);
      let wire = 0;
      dex.fetchPairsForTokens = async () => {
        wire += 1;
        return new Map(); // the 429 shape: resolves immediately, empty
      };
      const jupiter = {
        fetchTokenDataBatch: async (addrs) =>
          new Map(addrs.map((a) => [a, { marketCap: 1000, liquidity: { usd: 5000 } }])),
      };
      const scanner = new Scanner(
        db, { api: { sendMessage: async () => ({}) } }, dex, cfg,
        null, null, null, null, null, null, jupiter,
      );
      scanner.lastPairs = new Map([["AAA", { marketCap: 1 }]]);
      const out = await scanner.pairsForTracker(["AAA", "BBB"], Date.now() + 800);
      assert.equal(out.get("AAA").marketCap, 1, "the tick's own pair data wins (no wire call)");
      assert.equal(wire, 1, "only the tokens the tick does not have hit DexScreener");
      assert.ok(out.has("BBB"), "the Jupiter fallback supplies the blocked tokens");
      // A deadline-less call must not go to Jupiter (it would be unbounded).
      const noDeadline = await scanner.pairsForTracker(["CCC"]);
      assert.ok(!noDeadline.has("CCC"), "no deadline → no unbounded fallback leg");
    } finally {
      await t.cleanup();
    }
  });

  await test("Scanner: the front pair phase also fetches the post-push tracker's rotation head", async () => {
    const { Scanner } = require("../dist/scanner.js");
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const cfg = loadConfig({});
      const dex = new DexScreenerClient(cfg);
      // runOnce skips outright with no enabled chat — and a skipped scan
      // never reaches the pair phase this test is about.
      await db.saveChatSettings({
        chatId: "chat-on", minLiquidityUsd: 0, minVolume24hUsd: 0,
        minMarketCapUsd: 0, maxMarketCapUsd: 10_000_000,
        minAgeMinutes: 0, maxAgeMinutes: 100_000,
        min5mVolUsd: 0, min1hVolUsd: 0, min5mChgPct: 0, min1hChgPct: 0,
        enabled: true,
      });
      dex.fetchLatestSolanaProfiles = async () => [{ tokenAddress: "FEEDCOIN1" }];
      let asked = null;
      dex.fetchPairsForTokens = async (addrs) => {
        asked = addrs.slice();
        return new Map(addrs.map((a) => [a, { marketCap: 1000, liquidity: { usd: 5000 } }]));
      };
      const scanner = new Scanner(
        db, { api: { sendMessage: async () => ({}) } }, dex, cfg, null, null, null,
      );
      scanner.pushWatcher = {
        headTokens: () => ["TRACKEDTOKEN"],
        runTick: async () => ({ checked: 0, alerted: 0, trips: 0 }),
        onPush: async () => {},
      };
      await scanner.runOnce();
      assert.ok(asked, "the pair phase ran");
      assert.ok(asked.includes("FEEDCOIN1"), "the feed coin is still fetched");
      assert.ok(
        asked.includes("TRACKEDTOKEN"),
        `the tracker's rotation head must ride along (got ${JSON.stringify(asked)})`,
      );
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

  await test("parseTokenSnapshot: FDV and summed reserve are the usable numbers", () => {
    // Verified against the live API on a tracked XCAT pool (2026-09-18):
    // market_cap_usd comes back null for Solana memecoins, fdv_usd is the
    // value that works, and total_reserve_in_usd is the reserve summed over
    // the token's pools.
    const real = {
      data: {
        attributes: {
          address: "XCAT",
          price_usd: "0.0001338104648",
          fdv_usd: "133810.464817828",
          market_cap_usd: null,
          total_reserve_in_usd: "15992.629169660797",
        },
      },
    };
    const snap = parseTokenSnapshot(real);
    assert.equal(snap.priceUsd, 0.0001338104648);
    assert.equal(snap.reserveUsd, 15992.629169660797);
    // The Solana-memecoin shape: no circulating market cap, so the FDV stands
    // in for the tracker's valuation AND says so (fdvUsedAsMcap) instead of
    // being indistinguishable from a market cap.
    assert.equal(snap.marketCapUsd, null);
    assert.equal(snap.fdvOnlyUsd, 133810.464817828);
    assert.equal(snap.fdvUsd, 133810.464817828);
    assert.equal(snap.fdvUsedAsMcap, true);
    // market_cap_usd is the fallback when fdv is absent.
    const mc = { data: { attributes: { market_cap_usd: 5000, price_usd: "1" } } };
    assert.equal(parseTokenSnapshot(mc).fdvUsd, 5000);
    assert.equal(parseTokenSnapshot(mc).fdvUsedAsMcap, false);
    // Both present: the market cap is what the tracker uses, FDV stays its own
    // quantity (the 2026-09-19 audit found a $1.59M FDV recorded as the push
    // price of a coin whose market cap never passed ~$341K).
    const both = {
      data: { attributes: { price_usd: "1", market_cap_usd: 341_000, fdv_usd: 1_591_544 } },
    };
    const b = parseTokenSnapshot(both);
    assert.equal(b.marketCapUsd, 341_000);
    assert.equal(b.fdvOnlyUsd, 1_591_544);
    assert.equal(b.fdvUsd, 341_000, "the tracker's valuation is the market cap when the API has one");
    assert.equal(b.fdvUsedAsMcap, false);
    // Nothing usable → null, so callers treat it as "not found" and the
    // tracker counts a pair miss instead of evaluating on invented numbers.
    assert.equal(parseTokenSnapshot({ data: { attributes: { name: "x" } } }), null);
    assert.equal(parseTokenSnapshot(null), null);
    assert.equal(parseTokenSnapshot({ data: {} }), null);
    assert.equal(parseTokenSnapshot({ data: { attributes: { price_usd: "0" } } }), null);
  });

  await test("worker: syncPushLedger reconciles the audit ring + rows into the durable ledger", async () => {
    // End-to-end against a real SQLite database, because the whole point is
    // that this view outlives the mutable `push_watch` column: the audit ring
    // carries the push-time value (last ~30 deliveries) and the row carries
    // whatever a heal/resurrection wrote later.
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const now = Date.now();
      await db.saveChatSettings({
        chatId: "c", ...DEFAULT_SETTINGS,
        minMarketCapUsd: 40_000, maxMarketCapUsd: 380_000, enabled: true,
      });
      // A clean push: the row and the audit entry agree.
      await db.upsertPushWatch({
        token: "PUSH1", chatId: "c", symbol: "PUSH1",
        pushedAt: now - 60_000, mcapAtPush: 67_056, liquidityUsd: 50_000,
      });
      await db.recordPushDelivery({
        chatId: "c", token: "PUSH1", symbol: "PUSH1",
        messageId: 1, mcapAtPush: 67_056, kind: "initial",
      });
      // The polluted shape: pushed at $45K, healed hours later at $12K.
      await db.upsertPushWatch({
        token: "HEALED", chatId: "c", symbol: "HEALED",
        pushedAt: now - 3_600_000, mcapAtPush: 12_000, liquidityUsd: 5_000,
      });
      await db.recordPushDelivery({
        chatId: "c", token: "HEALED", symbol: "HEALED",
        messageId: 2, mcapAtPush: 45_000, kind: "initial",
      });
      await syncPushLedger(now, db);
      const stored = await db.getWorkerState("push_ledger");
      const ledger = parsePushLedger(stored);
      assert.equal(ledger.entries.length, 2);
      const clean = ledger.entries.find((e) => e.token === "PUSH1");
      assert.equal(clean.source, "initial-send");
      assert.equal(clean.mcapAtPush, 67_056);
      assert.equal(clean.bandMin, 40_000, "the band in force is stamped next to the push value");
      assert.equal(clean.bandMax, 380_000);
      const healed = ledger.entries.find((e) => e.token === "HEALED");
      assert.equal(healed.mcapAtPush, 45_000, "the audit value survives as the push baseline");
      assert.equal(healed.rowMcapAtPush, 12_000, "the rewritten baseline is recorded, not lost");
      const stats = pushLedgerStats(ledger, now);
      assert.equal(stats.entries, 2);
      assert.equal(stats.rewrittenCount, 1);
      assert.equal(stats.outOfBandCount, 0);
      assert.deepEqual(stats.band, { min: 40_000, max: 380_000 });
      // Idempotent: a second pass with nothing new must not rewrite the row.
      await syncPushLedger(now + 1_000, db);
      assert.equal(await db.getWorkerState("push_ledger"), stored);
    } finally {
      await t.cleanup();
    }
  });

  await test("pushWatchHeal: a heal says which baseline it used — durably and on /health", async () => {
    // The observable item 2 was missing. A heal's enrollment is invisible: the
    // row it writes looks exactly like a normally enrolled push, and after the
    // 2026-09-19 fix it no longer produces the divergence the ledger flags. So
    // each pass leaves ONE "heal-ledger" / "heal-current" entry in the delivery
    // audit ring (readable at /debug/push-audit) and the counters it reports on
    // /health.heartbeat.heal say how the heals split between the ledger's
    // push-time value and the documented fallback.
    const {
      PushWatcher: PW,
      pushWatchHealStats: healStats,
      resetPushWatchHealStats: resetHeal,
    } = require("../dist/pushwatch.js");
    resetHeal();
    const mint = "HEALOBS";
    const pushedAt = Date.now() - 3_600_000;
    const enrolled = [];
    const audits = [];
    const pair = {
      chainId: "solana", url: "", pairAddress: `p-${mint}`,
      baseToken: { address: mint, name: mint, symbol: mint },
      priceUsd: "0.001", marketCap: 12_000,
      volume: { h24: 1_000_000, h1: 20_000, m5: 1_000 },
      priceChange: { m5: 1, h1: 5 },
      txns: { m5Buys: 10, m5Sells: 8, h1Buys: 100, h1Sells: 80 },
      liquidity: { usd: 50_000 }, pairCreatedAt: pushedAt,
    };
    const pairsFor = async (addrs) => new Map(addrs.map((a) => [a, pair]));
    const ledgerRow = JSON.stringify({
      entries: [{
        token: mint, pushedAt, mcapAtPush: 45_000,
        bandMin: 60_000, bandMax: 230_000, bandAt: pushedAt,
        source: "initial-send", firstSeenAt: pushedAt,
      }],
      updatedAt: Date.now(),
    });
    const mk = (ledgerValue, token) => new PW(
      {
        listPushWatch: async () => [],
        prunePushWatch: async () => 0,
        findUntrackedPushes: async () => [{ token, chatId: "c", pushedAt }],
        markRecapClaimed: async () => false,
        markRecapClaimedMany: async (list) => list.map(() => false),
        getInitialPushAuditTokens: async () => new Set([token]),
        getWorkerState: async () => ledgerValue,
        upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },
        recordPushDelivery: async (entry) => { audits.push(entry); },
        claimPushWatch: async () => true,
        reservePushWatchAlert: async () => true,
        updatePushWatchCheck: async () => {},
        deletePushWatch: async () => {},
        setPushWatchHolders: async () => {},
      },
      { api: { sendMessage: async () => ({ message_id: 1 }) } },
      null, loadConfig({}), pairsFor, null,
    );
    await mk(ledgerRow, mint).runTick();
    await mk(null, "HEALOBS2").runTick();
    assert.equal(enrolled[0].mcapAtPush, 45_000, "ledger entry → push-time value");
    assert.equal(enrolled[1].mcapAtPush, 12_000, "no ledger entry → current value");
    assert.equal(audits.length, 2, "one entry per heal pass, not per coin");
    assert.equal(audits[0].kind, "heal-ledger");
    assert.equal(audits[0].token, mint);
    assert.equal(audits[0].mcapAtPush, 45_000, "the entry names the baseline it seeded");
    assert.equal(audits[1].kind, "heal-current");
    const heal = healStats();
    assert.equal(heal.enrolled, 2);
    assert.equal(heal.fromLedger, 1);
    assert.equal(heal.fromCurrentMcap, 1);
    assert.ok(heal.lastAt > 0, "the heal is stamped");
    resetHeal();
  });

  // ---------- early-return capture (src/skipcapture.ts) ----------
  //
  // The scanner records why a tick returned early ("empty-feed-and-pool",
  // "no-chats-enabled", "previous-scan-still-running") and then nulls the field
  // in the SAME tick, so every heartbeat and scan_history row read `skip: null`
  // — including the ticks where the sweep had stopped evaluating anything.
  // These tests pin the capture that makes the reason reach a reader.

  await test("skipCapture: a reason survives the clear that used to erase it", () => {
    resetSkipCapture();
    const scanner = { lastSkip: null };
    const now = 1_800_000_000_000;
    installSkipCapture(scanner, () => now);
    // The live sequence: a writer records the reason, then runOnce's finally
    // nulls the field before the worker's completion flush can read it.
    scanner.lastSkip = "empty-feed-and-pool";
    assert.equal(skipCaptureSnapshot().reason, "empty-feed-and-pool");
    assert.equal(skipCaptureSnapshot().at, now);
    scanner.lastSkip = null;
    assert.equal(scanner.lastSkip, null, "the field still behaves exactly as the scanner expects");
    assert.equal(
      skipCaptureSnapshot().reason,
      "empty-feed-and-pool",
      "the reason outlives the clear that made it unreadable",
    );
  });

  await test("skipCapture: the nulling write is not counted as a skip", () => {
    resetSkipCapture();
    const scanner = { lastSkip: null };
    installSkipCapture(scanner, () => 1);
    assert.equal(skipCaptureSnapshot(), null, "nothing recorded yet");
    scanner.lastSkip = "no-chats-enabled";
    scanner.lastSkip = null;
    scanner.lastSkip = "empty-feed-and-pool";
    scanner.lastSkip = null;
    const view = skipCaptureSnapshot();
    assert.equal(view.total, 2, "only real reasons count");
    assert.deepEqual(view.counts, { "no-chats-enabled": 1, "empty-feed-and-pool": 1 });
  });

  await test("skipCapture: the delta is re-offered until a write confirms it", () => {
    resetSkipCapture();
    const scanner = { lastSkip: null };
    installSkipCapture(scanner, () => 42);
    assert.equal(takeSkipCaptureDelta(), null, "nothing recorded, nothing to persist");
    scanner.lastSkip = "no-chats-enabled";
    scanner.lastSkip = "empty-feed-and-pool";
    scanner.lastSkip = "empty-feed-and-pool";
    const delta = takeSkipCaptureDelta();
    assert.equal(delta.total, 3);
    assert.deepEqual(delta.counts, { "no-chats-enabled": 1, "empty-feed-and-pool": 2 });
    assert.equal(delta.reason, "empty-feed-and-pool");
    assert.equal(delta.at, 42);
    // A failed write must not lose the share it was carrying.
    assert.equal(takeSkipCaptureDelta().total, 3);
    markSkipCaptureSynced();
    assert.equal(takeSkipCaptureDelta(), null, "and never twice after one that landed");
    // A re-created scanner restarts the interval instead of going negative.
    installSkipCapture(scanner, () => 43);
    assert.equal(takeSkipCaptureDelta(), null);
    scanner.lastSkip = "empty-feed-and-pool";
    assert.equal(takeSkipCaptureDelta().total, 1);
  });

  await test("skipCapture: durable state merges, spans isolates, and parses garbage tolerantly", () => {
    const now = 1_800_000_000_000;
    const s1 = mergeSkipCaptureState(
      emptySkipCaptureState(),
      { total: 2, counts: { "empty-feed-and-pool": 2 }, reason: "empty-feed-and-pool", at: now - 1 },
      now,
    );
    assert.equal(s1.total, 2);
    assert.equal(s1.firstAt, now);
    const s2 = mergeSkipCaptureState(
      s1,
      { total: 1, counts: { "no-chats-enabled": 1 }, reason: "no-chats-enabled", at: now + 60_000 },
      now + 60_000,
    );
    assert.equal(s2.total, 3);
    assert.equal(s2.firstAt, now, "firstAt is stamped once");
    assert.equal(s2.lastAt, now + 60_000);
    assert.equal(s2.counts["empty-feed-and-pool"], 2);
    assert.equal(s2.lastReason, "no-chats-enabled");
    assert.equal(s2.lastReasonAt, now + 60_000);
    assert.deepEqual(parseSkipCaptureState(JSON.stringify(s2)), s2);
    // Corrupt / legacy shapes degrade instead of throwing on the tick path.
    assert.equal(parseSkipCaptureState("not json").total, 0);
    assert.equal(parseSkipCaptureState(null).total, 0);
    assert.deepEqual(parseSkipCaptureState('{"counts":{"x":-3,"y":"2"}}').counts, { y: 2 });
    // Bounded key set: a stray dynamic reason cannot grow the row forever.
    const wide = {};
    for (let i = 0; i < SKIP_CAPTURE_MAX_REASONS + 4; i++) wide[`r${i}`] = i;
    assert.equal(Object.keys(pruneSkipCounts(wide)).length, SKIP_CAPTURE_MAX_REASONS);
  });

  await test("worker: syncSkipCaptureState accumulates reasons across isolates", async () => {
    const t = tmpDb();
    const t0 = Date.now();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      resetSkipCapture();
      // Isolate 1: the sweep returned early twice (the wiped observation
      // window that made "how often does this happen" unanswerable).
      const scanner = { lastSkip: null };
      installSkipCapture(scanner, () => t0);
      scanner.lastSkip = "empty-feed-and-pool";
      scanner.lastSkip = "empty-feed-and-pool";
      await syncSkipCaptureState(t0, db);
      const first = parseSkipCaptureState(await db.getWorkerState("skip_capture"));
      assert.equal(first.total, 2);
      assert.equal(first.counts["empty-feed-and-pool"], 2);
      assert.equal(first.firstAt, t0);
      // A pass with nothing new must not rewrite the row.
      const stored = await db.getWorkerState("skip_capture");
      await syncSkipCaptureState(t0 + 1_000, db);
      assert.equal(await db.getWorkerState("skip_capture"), stored);
      // Isolate 2 (a fresh install is the recycle path): its share ADDS on top.
      const scanner2 = { lastSkip: null };
      installSkipCapture(scanner2, () => t0 + 120_000);
      scanner2.lastSkip = "no-chats-enabled";
      await syncSkipCaptureState(t0 + 120_000, db);
      const second = parseSkipCaptureState(await db.getWorkerState("skip_capture"));
      assert.equal(second.total, 3);
      assert.equal(second.counts["empty-feed-and-pool"], 2, "the earlier isolate's share survives");
      assert.equal(second.counts["no-chats-enabled"], 1);
      assert.equal(second.firstAt, t0, "firstAt spans isolates");
      assert.equal(second.lastAt, t0 + 120_000);
      assert.equal(second.lastReason, "no-chats-enabled");
    } finally {
      await t.cleanup();
      resetSkipCapture();
    }
  });

  // ---------- push-baseline ledger (src/pushledger.ts) ----------

  await test("pushLedger: the audit ring's push-time mcap is authoritative and carries the band", () => {
    const now = 1_800_000_000_000;
    const l1 = mergePushLedger(parsePushLedger(null), {
      audit: [{ token: "A", at: now - 60_000, mcapAtPush: 67_056, kind: "initial" }],
      rows: [{ token: "A", pushedAt: now - 60_000, mcapAtPush: 67_056 }],
      band: { min: 60_000, max: 230_000 },
      now,
    });
    assert.equal(l1.entries.length, 1);
    assert.equal(l1.entries[0].source, "initial-send");
    assert.equal(l1.entries[0].mcapAtPush, 67_056);
    assert.equal(l1.entries[0].bandMin, 60_000);
    assert.equal(l1.entries[0].bandMax, 230_000);
    const stats = pushLedgerStats(l1, now);
    assert.equal(stats.authoritative, 1);
    assert.equal(stats.unbanded, 0);
    assert.equal(stats.outOfBand.length, 0, "a push inside the band in force is never reported as out of band");
    // Follow-up cards ride the same audit ring — they are not push baselines.
    const l2 = mergePushLedger(l1, {
      audit: [{ token: "ZZZ", at: now, mcapAtPush: 999_999, kind: "followup" }],
      rows: [],
      band: { min: 60_000, max: 230_000 },
      now,
    });
    assert.equal(l2.entries.length, 1, "a followup audit entry must not create a push entry");
  });

  await test("pushLedger: a rewritten baseline (heal / resurrection) is flagged without losing the gate value", () => {
    const now = 1_800_000_000_000;
    const pushed = mergePushLedger(parsePushLedger(null), {
      audit: [{ token: "TIL", at: now - 7_200_000, mcapAtPush: 341_000, kind: "initial" }],
      rows: [],
      band: { min: 60_000, max: 230_000 },
      now,
    });
    // Hours later the row carries a different baseline — the live shape that
    // produced this ledger ($12K baseline on a $45K push; an FDV-shaped $1.59M
    // on a coin whose market cap never passed $341K).
    const later = mergePushLedger(pushed, {
      audit: [],
      rows: [{ token: "TIL", pushedAt: now - 7_200_000, mcapAtPush: 1_591_544 }],
      band: null,
      now: now + 3_600_000,
    });
    const entry = later.entries[0];
    assert.equal(entry.mcapAtPush, 341_000, "the value the gate saw is immutable once recorded");
    assert.equal(entry.rowMcapAtPush, 1_591_544);
    assert.ok(entry.baselineMovedAt > 0, "the divergence is stamped");
    const stats = pushLedgerStats(later, now + 3_600_000);
    assert.equal(stats.rewritten.length, 1);
    assert.equal(stats.rewritten[0].rowMcapAtPush, 1_591_544);
    // A row that agrees again (re-pushed) clears the stale flag.
    const healed = mergePushLedger(later, {
      audit: [],
      rows: [{ token: "TIL", pushedAt: now - 7_200_000, mcapAtPush: 341_000 }],
      band: null,
      now: now + 3_700_000,
    });
    assert.equal(healed.entries[0].rowMcapAtPush, undefined);
  });

  await test("pushLedger: out-of-band is only claimed when the band in force is known", () => {
    const now = 1_800_000_000_000;
    // No band snapshot anywhere: unclassified, never guessed at.
    const untagged = mergePushLedger(parsePushLedger(null), {
      audit: [],
      rows: [{ token: "B", pushedAt: now, mcapAtPush: 1_000 }],
      band: null,
      now,
    });
    assert.equal(pushLedgerStats(untagged, now).outOfBand.length, 0);
    assert.equal(pushLedgerStats(untagged, now).unbanded, 1);
    // The same token arrives in the audit ring with a band: classifiable, and
    // the band snapshot is filled in on the provenance upgrade.
    const tagged = mergePushLedger(untagged, {
      audit: [{ token: "B", at: now, mcapAtPush: 1_000, kind: "initial" }],
      rows: [],
      band: { min: 60_000, max: 230_000 },
      now: now + 1,
    });
    const stats = pushLedgerStats(tagged, now);
    assert.equal(stats.unbanded, 0);
    assert.equal(stats.outOfBand.length, 1);
    assert.equal(stats.outOfBand[0].bandMin, 60_000);
  });

  await test("pushLedger: bounded retention and tolerant parse", () => {
    const now = 1_800_000_000_000;
    // Past the TTL: dropped (every tracking window is long over).
    const stale = mergePushLedger(parsePushLedger(null), {
      audit: [{ token: "OLD", at: now - 8 * 24 * 3_600_000, mcapAtPush: 100_000, kind: "initial" }],
      rows: [],
      band: null,
      now,
    });
    assert.equal(stale.entries.length, 0);
    // Ring cap: the newest PUSH_LEDGER_MAX_ENTRIES entries win.
    const many = [];
    for (let i = 0; i < 300; i++) {
      many.push({ token: `T${i}`, at: now - i * 1_000, mcapAtPush: 100_000, kind: "initial" });
    }
    const capped = mergePushLedger(parsePushLedger(null), {
      audit: many,
      rows: [],
      band: null,
      now,
    });
    assert.equal(capped.entries.length, PUSH_LEDGER_MAX_ENTRIES);
    assert.equal(capped.entries[0].token, "T0", "newest push first");
    // Corrupt / legacy shapes degrade instead of throwing on the tick path.
    assert.equal(parsePushLedger("not json").entries.length, 0);
    assert.equal(parsePushLedger(null).entries.length, 0);
    assert.equal(parsePushLedger('{"entries":[{"token":"X"}]}').entries.length, 0);
    assert.equal(
      parsePushLedger('{"entries":[{"token":"X","mcapAtPush":"100"}]}').entries[0].mcapAtPush,
      100,
    );
  });

  await test("PushWatcher self-heal: the ledger's push-time mcap is the baseline, not the coin's current value", async () => {
    // 2026-09-19 shape: a coin pushed at $45K dumped to $12K and its row was
    // lost (isolate died between the card send and the enrollment). The old
    // heal seeded the CURRENT $12K, which is how rows ended up with a "push
    // mcap" below the $40K floor and polluted every calibration reading.
    const mint = "HEALEDMINT";
    const pushedAt = Date.now() - 3_600_000;
    const enrolled = [];
    const pair = (token) => ({
      chainId: "solana", url: "", pairAddress: `p-${token}`,
      baseToken: { address: token, name: token, symbol: token },
      priceUsd: "0.001", marketCap: 12_000,
      volume: { h24: 1_000_000, h1: 20_000, m5: 1_000 },
      priceChange: { m5: 1, h1: 5 },
      txns: { m5Buys: 10, m5Sells: 8, h1Buys: 100, h1Sells: 80 },
      liquidity: { usd: 50_000 }, pairCreatedAt: pushedAt,
    });
    const pairsFor = async (addrs) => new Map(addrs.map((a) => [a, pair(a)]));
    const ledgerRow = JSON.stringify({
      entries: [{
        token: mint, pushedAt, mcapAtPush: 45_000,
        bandMin: 40_000, bandMax: 380_000, bandAt: pushedAt,
        source: "initial-send", firstSeenAt: pushedAt,
      }],
      updatedAt: Date.now(),
    });
    const fakeDb = (ledgerValue, tokens) => ({
      listPushWatch: async () => [],
      prunePushWatch: async () => 0,
      findUntrackedPushes: async () => tokens.map((t) => ({ token: t, chatId: "c", pushedAt })),
      markRecapClaimed: async () => false,
      markRecapClaimedMany: async (list) => list.map(() => false),
      getInitialPushAuditTokens: async () => new Set(tokens),
      getWorkerState: async () => ledgerValue,
      upsertPushWatchMany: async (rows) => { enrolled.push(...rows); },
      claimPushWatch: async () => true,
      reservePushWatchAlert: async () => true,
      updatePushWatchCheck: async () => {},
      deletePushWatch: async () => {},
      setPushWatchHolders: async () => {},
    });
    const bot = { api: { sendMessage: async () => ({ message_id: 1 }) } };
    const pw = new PushWatcher(
      fakeDb(ledgerRow, [mint]), bot, null, loadConfig({}), pairsFor, null,
    );
    await pw.runTick();
    assert.equal(enrolled.length, 1, "the missed push must be enrolled");
    assert.equal(
      enrolled[0].mcapAtPush,
      45_000,
      "baseline = the gate value recorded at push time, not the current $12K",
    );
    // A push older than the ledger keeps the documented fallback (current
    // mcap), which is the one case that stays unbanded and excludable.
    const pw2 = new PushWatcher(
      fakeDb(null, ["NOENTRY"]), bot, null, loadConfig({}), pairsFor, null,
    );
    await pw2.runTick();
    assert.equal(enrolled[1].mcapAtPush, 12_000, "no ledger entry → current value");
  });

  await test("Scanner: the tracker's pair lookup falls back to GeckoTerminal when DexScreener and Jupiter are empty", async () => {
    // The shape that left the tracker blind: DexScreener batched endpoint
    // 429-blocked (empty map) and Jupiter's search not indexing the pushed
    // memecoin. GeckoTerminal is free and keyless, so it is the third source.
    const { Scanner } = require("../dist/scanner.js");
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const cfg = loadConfig({});
      const dex = new DexScreenerClient(cfg);
      dex.fetchPairsForTokens = async () => new Map();
      const gecko = {
        fetchTokenSnapshot: async (mint) =>
          mint === "XCAT"
            ? { priceUsd: 0.0001, fdvUsd: 133810, reserveUsd: 15992 }
            : null,
      };
      const scanner = new Scanner(
        db, { api: { sendMessage: async () => ({}) } }, dex, cfg,
        null, null, null, null, null, gecko, null,
      );
      const out = await scanner.pairsForTracker(["XCAT", "GONE"], Date.now() + 800);
      assert.equal(out.get("XCAT").marketCap, 133810, "FDV stands in for the market cap");
      assert.equal(out.get("XCAT").liquidity.usd, 15992, "summed reserve stands in for liquidity");
      assert.equal(
        out.get("XCAT").volume.m5,
        0,
        "the 5m tape is NOT in this payload — it must stay zero, not be invented",
      );
      assert.equal(out.get("XCAT").priceChange.m5, 0);
      assert.ok(!out.has("GONE"), "a token GeckoTerminal does not know is still a miss");
      // Deadline-less calls never reach out (the leg would be unbounded).
      const noDeadline = await scanner.pairsForTracker(["XCAT"]);
      assert.ok(!noDeadline.has("XCAT"));
    } finally {
      await t.cleanup();
    }
  });

  await test("Scanner: a hanging pool DB read is cut by POOL_FETCH_BUDGET_MS and the scan degrades to feed-only", async () => {
    // The libsql client can hang in internal retries (the same hang the
    // worker's flush-retry guard exists for). The pool read is raced against
    // POOL_FETCH_BUDGET_MS; expiry must NOT wedge runOnce — it degrades to
    // feed-only evaluation and the scan still settles.
    const { Scanner } = require("../dist/scanner.js");
    const t = tmpDb();
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      // DexScreener feed: return an empty profile list so the scan proceeds
      // straight to the (hung) pool read.
      return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // Hang forever on getReevalPool — simulating the wedged libsql client.
      db.getReevalPool = () => new Promise(() => {});
      const cfg = loadConfig({});
      const scanner = new Scanner(db, { api: { sendMessage: async () => ({}) } }, new DexScreenerClient(cfg), cfg, null, null, null);
      const t0 = Date.now();
      await scanner.runOnce();
      const elapsed = Date.now() - t0;
      // runOnce must settle well within the tick budget: feed deadline (4.5s)
      // + pool budget (4s) + slack. A wedged scan would never resolve.
      assert.ok(elapsed < 12_000, `runOnce took ${elapsed}ms — pool read not budgeted`);
      // The settle path always publishes the diag (possibly zeroed) — the
      // degraded tick's feed-only shape: empty feed, pool read never landed.
      assert.ok(scanner.lastSummary, "diag published on settle");
      assert.equal(scanner.lastSummary.profiles, 0, "mocked feed returned nothing");
      assert.equal(scanner.lastSummary.pool, 0, "hung pool read degraded the scan to feed-only");
    } finally {
      globalThis.fetch = origFetch;
      await t.cleanup();
    }
  });

  await test("Scanner.bestEffort: a hung chain step resolves with its fallback at the chain deadline", async () => {
    // The 2026-09-16 zero-push shape: the candidate chain awaits ~11 live
    // calls SERIALLY (RugCheck, crime checkToken, Axiom, Birdeye ×2, GMGN,
    // Arkham, Jupiter organic, wallet analysis, Flurry), so a single hung
    // upstream held the tick past the worker's race window and the coin —
    // already through every gate — was never pushed (`candidates: 1,
    // pushed: 0` on every such tick). bestEffort must (a) never fire a call
    // when the deadline has already passed and (b) resolve with the caller's
    // fallback when the call outlives the deadline, so the chain always
    // reaches renderMessage + sendMessage.
    const { Scanner } = require("../dist/scanner.js");
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const cfg = loadConfig({});
      const scanner = new Scanner(db, { api: { sendMessage: async () => ({}) } }, new DexScreenerClient(cfg), cfg, null, null, null);
      // (a) No usable time left → the network call must not even start.
      let fired = false;
      const skipped = await scanner.bestEffort(
        () => {
          fired = true;
          return Promise.resolve("live");
        },
        Date.now() - 1,
        "fallback",
      );
      assert.equal(skipped, "fallback");
      assert.equal(fired, false, "a step with no time left must not fire its call");
      // (b) Hung upstream → fallback AT the deadline, not when it settles.
      const t0 = Date.now();
      const hung = await scanner.bestEffort(() => new Promise(() => {}), Date.now() + 60, "fallback");
      assert.equal(hung, "fallback", "hung step degrades to the caller's fallback");
      assert.ok(Date.now() - t0 < 1_000, `waited ${Date.now() - t0}ms — not clamped to the deadline`);
      // (c) A step that lands in time still returns its own value.
      assert.equal(
        await scanner.bestEffort(() => Promise.resolve("live"), Date.now() + 500, "fallback"),
        "live",
      );
      // (d) Not applicable (feature disabled / no pair address) → fallback.
      assert.equal(await scanner.bestEffort(null, Date.now() + 500, "fallback"), "fallback");
      // (e) A rejection arriving AFTER the race settled is absorbed, so a
      // slow upstream cannot surface as an unhandled rejection.
      const late = await scanner.bestEffort(
        () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 80)),
        Date.now() + 25,
        "fallback",
      );
      assert.equal(late, "fallback");
      await new Promise((r) => setTimeout(r, 120)); // let the late rejection land
      // (f) A THROWING step degrades exactly like a timeout. The card-only
      // display batch dispatches five bestEffort slots into ONE Promise.all
      // (2026-09-17: the 🌱 有機度 line was starved by the serial chain), so a
      // rejection must never escape — one flaky upstream would otherwise
      // blank every line of the card.
      assert.equal(
        await scanner.bestEffort(
          () => Promise.reject(new Error("upstream 502")),
          Date.now() + 500,
          "fallback",
        ),
        "fallback",
      );
    } finally {
      await t.cleanup();
    }
  });

  await test("Db: a libsql client that retries forever hits the hard wall and settles", async () => {
    // Dead-tick fix 2026-09-13: the libsql HTTP client retries internally
    // when the transport fetch aborts, so a request's promise can outlive
    // DB_REQUEST_TIMEOUT_MS. The client-level Proxy wall must settle the
    // CALLER'S promise shortly after the timeout instead of hanging forever
    // (the shape that killed completion flushes and produced 60-93s dead
    // ticks). Simulate with an injected client whose execute() never
    // settles; the wall timer does the settling.
    const { Db } = require("../dist/db.js");
    const never = () => new Promise(() => {});
    // Hang ONLY the probe statement; every other call (init DDL, telemetry)
    // resolves instantly so setup is fast.
    const hangingClient = {
      execute(stmt) {
        if (stmt.args && stmt.args[0] === "anything") return never();
        return Promise.resolve({ rows: [], rowsAffected: 0 });
      },
      async batch(stmts) {
        return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    };
    const db = new Db("libsql://unused", undefined, hangingClient);
    await db.init();
    const t0 = Date.now();
    await assert.rejects(
      db.getWorkerState("anything"),
      /hard wall|never settled/i,
      "hanging execute must reject via the wall, not hang",
    );
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed < 12_000,
      `call settled in ${elapsed}ms — the wall must fire near DB_REQUEST_TIMEOUT_MS*1.2`,
    );
  });

  await test("Db: a fast client passes through the Proxy wall untouched", async () => {
    const { Db } = require("../dist/db.js");
    const calls = [];
    const fastClient = {
      async execute(stmt) {
        calls.push(stmt.sql);
        return { rows: [{ value: "v1" }], rowsAffected: 0 };
      },
      async batch(stmts) {
        calls.push(...stmts.map((s) => s.sql));
        return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    };
    const db = new Db("libsql://unused", undefined, fastClient);
    await db.init();
    assert.equal(await db.getWorkerState("k"), "v1");
    assert.ok(calls.length >= 1, "execute reached the underlying client");
  });

  await test("Db: a scan runs under the short tick cap and reports its round-trip cost", async () => {
    // 2026-09-17 tick fix: the scan's round trips were the last unbounded
    // await in the tick — DB_REQUEST_TIMEOUT_MS (6s, +1.2x hard wall) outlives
    // the whole 4.2s ladder, so one stalled call killed a tick that already
    // had a candidate in hand (live: died at 5000ms with feedsMs/poolMs/pairs
    // published but no evalMs, which is written after the candidate loop).
    // enterScanMode() must shorten BOTH the transport signal and the wall for
    // the duration of the scan, and report the time the round trips took.
    const { Db, SCAN_DB_TIMEOUT_MS } = require("../dist/db.js");
    assert.ok(
      SCAN_DB_TIMEOUT_MS > 0 && SCAN_DB_TIMEOUT_MS <= 2_000,
      "the scan cap must sit well inside the tick, not at the 6s flush cap",
    );
    const hangingClient = {
      execute(stmt) {
        // Hang only the probe statement; init DDL and reads resolve fast.
        if (stmt.args && stmt.args[0] === "hang") return new Promise(() => {});
        return Promise.resolve({ rows: [{ value: "v1" }], rowsAffected: 0 });
      },
      async batch(stmts) {
        return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    };
    const db = new Db("libsql://unused", undefined, hangingClient);
    await db.init();
    db.enterScanMode();
    const t0 = Date.now();
    await assert.rejects(
      db.getWorkerState("hang"),
      /hard wall|never settled/i,
      "a stalled scan round trip must reject via the short wall",
    );
    const elapsed = Date.now() - t0;
    assert.ok(
      elapsed < SCAN_DB_TIMEOUT_MS * 2 && elapsed < 3_000,
      `scan call settled in ${elapsed}ms — must be near SCAN_DB_TIMEOUT_MS (${SCAN_DB_TIMEOUT_MS}ms), not the 6s flush cap`,
    );
    const cost = db.exitScanMode();
    assert.ok(
      cost >= SCAN_DB_TIMEOUT_MS,
      `exitScanMode must report the round trip's wall time (got ${cost}ms)`,
    );
    // Leaving scan mode restores the normal client: the same read works.
    assert.equal(await db.getWorkerState("fine"), "v1");
  });

  await test("Db.persistScanCompletion: heartbeat-only flush skips the prune-check read", async () => {
    // Dead-tick fix 2026-09-13: history=null (timeout/skip ticks) must
    // return right after the batch — the prune-check read after it was an
    // unraced await on the wall-clock-critical flush path.
    const { Db } = require("../dist/db.js");
    const seen = [];
    const client = {
      async execute(stmt) {
        seen.push(stmt.sql);
        return { rows: [], rowsAffected: 1 };
      },
      async batch(stmts) {
        seen.push("BATCH:" + stmts.length);
        return stmts.map(() => ({ rows: [], rowsAffected: 1 }));
      },
    };
    const db = new Db("libsql://unused", undefined, client);
    await db.init();
    seen.length = 0; // drop init()'s own statements
    await db.persistScanCompletion(
      JSON.stringify({ at: Date.now(), ok: false, phase: "done" }),
      null,
      "lock-value",
    );
    assert.ok(
      seen.some((s) => s.startsWith("BATCH:")),
      "flush batch still ran",
    );
    assert.equal(
      seen.filter((s) => s.includes("history_last_prune")).length,
      0,
      "no prune-check read on a heartbeat-only flush",
    );
  });

  await test("slicePoolRotation: small pool taken whole, cursor resets", () => {
    const items = ["a", "b", "c"];
    const r1 = slicePoolRotation(items, 2, 120);
    assert.deepEqual(r1.slice, ["a", "b", "c"]);
    assert.equal(r1.nextCursor, 0);
  });

  await test("slicePoolRotation: successive windows cover every item exactly once per sweep", () => {
    // 409 pool coins, 120/tick → 4 ticks (120+120+120+49). This is the
    // zero-push fix: every coin must be re-checked at least once per sweep.
    const items = Array.from({ length: 409 }, (_, i) => i);
    const seen = new Map();
    let cursor = 0;
    for (let tick = 0; tick < 4; tick++) {
      const { slice, nextCursor } = slicePoolRotation(items, cursor, 120);
      for (const item of slice) seen.set(item, (seen.get(item) ?? 0) + 1);
      cursor = nextCursor;
    }
    assert.equal(seen.size, 409, "every pool coin evaluated within one sweep");
    assert.ok([...seen.values()].every((n) => n === 1), "no duplicates within a sweep");
    // The tail window (49 < 120) resets the cursor: tick 5 starts a fresh
    // sweep from the top instead of wrapping over just-covered items.
    assert.equal(cursor, 0);
    const { slice } = slicePoolRotation(items, cursor, 120);
    assert.deepEqual(slice, items.slice(0, 120));
  });

  await test("slicePoolRotation: full window at the end takes only the tail, no wrap-back", () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    // 10 items, max 5: cursor 5 → [5..9] tail, cursor resets to 0 (the old
    // wrap-back version returned [5..9, 0..4] — a whole duplicate sweep).
    const r = slicePoolRotation(items, 5, 5);
    assert.deepEqual(r.slice, [5, 6, 7, 8, 9]);
    assert.equal(r.nextCursor, 0);
    // Mid-window keeps order: cursor 8, max 5 → tail [8, 9] only.
    const r2 = slicePoolRotation(items, 8, 5);
    assert.deepEqual(r2.slice, [8, 9]);
    assert.equal(r2.nextCursor, 0);
    // A wildly out-of-range cursor is normalized by the modulo, not a crash
    // (7 of 10 with max 5 → tail [7..9]; 3 items < max is valid tail behavior).
    const r3 = slicePoolRotation(items, 10_007, 5);
    assert.deepEqual(r3.slice, [7, 8, 9]);
    assert.equal(r3.nextCursor, 0);
  });

  await test("cardSendDeadline: a healthy send keeps the internal deadline, a late one is refused", () => {
    const t0 = 1_000_000;
    // Healthy: unchanged from the pre-fix behaviour — the send still runs to
    // the tick's own internal deadline (4.2s), because the floor is only a
    // minimum slice, not a cap.
    assert.equal(cardSendDeadline(t0, t0 + 2_000), t0 + 4_200);
    assert.equal(cardSendDeadline(t0, t0 + 3_000), t0 + 4_200);
    // Late but still usable: clamped by the tail, not by `now + floor`.
    assert.equal(cardSendDeadline(t0, t0 + 4_000), t0 + 4_400);
    // The live 2026-09-18 03:44:18Z shape — the send started 4309ms in while
    // that tick's race window was 4742ms. The old `max(tickDeadline, now +
    // 600)` granted it until 4909ms, past the window, and the tick died at
    // 5000ms with the second candidate unsent; now it is refused instead.
    assert.equal(cardSendDeadline(t0, t0 + 4_309), null);
    // Boundary: exactly the minimum slice is still attempted, one ms more is
    // not (the card is deferred, not dropped).
    assert.equal(cardSendDeadline(t0, t0 + 4_150), t0 + 4_400);
    assert.equal(cardSendDeadline(t0, t0 + 4_151), null);
    // A tick already past the tail can never start one.
    assert.equal(cardSendDeadline(t0, t0 + 9_000), null);
  });

  await test("cardClaimDeadline: the claim needs room for itself AND the send", () => {
    const t0 = 1_000_000;
    // Healthy chain: the claim gets its own 400ms slice.
    assert.equal(cardClaimDeadline(t0, t0 + 2_000), t0 + 2_400);
    // Late but affordable: 700ms of tail still covers 400 (claim) + 250
    // (least send).
    assert.equal(cardClaimDeadline(t0, t0 + 3_500), t0 + 3_900);
    // Boundary: exactly 650ms of tail, one ms less is refused.
    assert.equal(cardClaimDeadline(t0, t0 + 3_550), t0 + 3_950);
    assert.equal(cardClaimDeadline(t0, t0 + 3_551), null);
    // The live shape this exists for (2026-09-18 04:32:18Z): the chain
    // reached the claim at 3.79s with 608ms of tail left, the claim's own
    // cap is 1200ms, and the tick died at 5000ms with `pushPhase
    // send:claim`. It is now deferred before anything is written.
    assert.equal(cardClaimDeadline(t0, t0 + 3_792), null);
    // Past the send tail as well.
    assert.equal(cardClaimDeadline(t0, t0 + 4_200), null);
    assert.equal(cardClaimDeadline(t0, t0 + 9_000), null);
  });

  await test("boundClaim: a claim that answers inside its slice is used as-is", async () => {
    let releases = 0;
    const release = async () => {
      releases += 1;
    };
    assert.equal(await boundClaim(Promise.resolve(true), 50, release), true);
    assert.equal(
      await boundClaim(Promise.resolve(false), 50, release),
      false,
      "a lost CAS is false, and must not be reported as a deferral",
    );
    assert.equal(releases, 0, "nothing is released when the claim answered");
  });

  await test("boundClaim: a claim that misses its slice defers and releases its row", async () => {
    // The live shape this exists for (2026-09-18 04:32:18Z): the chain
    // reached the claim with less tail left than the claim's own cap. The
    // tick must move on, and the claim that lands late must not orphan the
    // coin (an INSERT OR IGNORE row no later tick can win against).
    let settled = false;
    let releases = 0;
    // The gap between the slice (20ms) and the claim's own answer (150ms)
    // is wide on purpose: the assertion is about ORDERING, so a loaded CI
    // runner firing its timers late cannot turn this into a flake.
    const late = new Promise((resolve) =>
      setTimeout(() => {
        settled = true;
        resolve(true);
      }, 150),
    );
    const r = await boundClaim(late, 20, async () => {
      releases += 1;
    });
    assert.equal(r, null, "a claim that missed its slice defers the card");
    assert.equal(settled, false, "it returned at the slice, not when the call settled");
    assert.equal(releases, 0, "nothing may be released while the claim is in flight");
    await new Promise((res) => setTimeout(res, 250));
    assert.equal(settled, true);
    assert.equal(releases, 1, "the abandoned claim releases its row exactly once");
  });

  await test("boundClaim: a claim that throws also defers and releases", async () => {
    let releases = 0;
    const failing = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("libsql aborted")), 150),
    );
    const r = await boundClaim(failing, 20, async () => {
      releases += 1;
    });
    assert.equal(r, null, "an unconfirmed claim is never treated as won");
    await new Promise((res) => setTimeout(res, 250));
    assert.equal(releases, 1);
  });

  await test("boundClaim: a claim that never answers still frees the tick", async () => {
    let releases = 0;
    const r = await boundClaim(new Promise(() => {}), 20, async () => {
      releases += 1;
    });
    // Only the slice can produce a value from a promise that never settles,
    // so returning at all is the assertion (no wall-clock bound to flake).
    assert.equal(r, null, "a hung DB call must not hold the tick");
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(releases, 0, "nothing settled, so there is nothing to release");
  });

  await test("DeferredPushLedger: a deferred coin is counted as recovered when it is pushed later", () => {
    // A deferred card writes NOTHING (no claim, no audit, no failure record),
    // so "the re-eval pool pushes it back next tick" was only ever argued from
    // the code path. The ledger is what makes it countable — and observable in
    // /health once the cumulative counters ride the summary.
    const led = new DeferredPushLedger(3);
    assert.equal(led.recovered, 0, "nothing recovered before anything was deferred");
    led.defer("A", 1);
    led.defer("A", 2); // same coin deferred again in a later tick: one slot
    assert.equal(led.pendingCount, 1);
    assert.equal(led.recover("A"), true, "the push IS the make-up send");
    assert.equal(led.recovered, 1);
    assert.equal(led.pendingCount, 0, "and the coin leaves the backlog");
    assert.equal(led.recover("A"), false, "a second push is not a recovery");
    assert.equal(led.recovered, 1);
    // Bounded: a deferred coin that never comes back must not grow the set.
    led.defer("B", 3);
    led.defer("C", 4);
    led.defer("D", 5);
    assert.equal(led.pendingCount, 3, "at the cap nothing is dropped yet");
    led.defer("E", 6);
    assert.equal(led.pendingCount, 3, "the cap holds");
    assert.equal(led.recover("B"), false, "the oldest entry is the one evicted");
    assert.equal(led.recover("E"), true, "the newest one is still tracked");
    led.defer("", 7);
    assert.equal(led.pendingCount, 2, "a token-less deferral is never recorded");
  });

  // ---------- scanner.ts push gates ----------

  await test("botUsersBlockReason: dead pools blocked below the floor, healthy pass", () => {
    // Junk pool shape (calibration: liked coins had 140+, junk sat < 90).
    assert.match(botUsersBlockReason(37, 90), /37 < 90/);
    // Just under the line blocks; exactly at the line passes (strict <).
    assert.match(botUsersBlockReason(89, 90), /89/);
    assert.equal(botUsersBlockReason(90, 90), null);
    // Healthy pools pass.
    assert.equal(botUsersBlockReason(140, 90), null);
    assert.equal(botUsersBlockReason(1200, 90), null);
    // Missing data never judges (session down / no pair address).
    assert.equal(botUsersBlockReason(null, 90), null);
    assert.equal(botUsersBlockReason(NaN, 90), null);
    // Disabled.
    assert.equal(botUsersBlockReason(5, 0), null);
  });

  await test("renderAxiomSummaryLine: operator format, red flags, fallbacks", () => {
    // Live Burpcoin sample — exact operator-specified layout.
    const burp = renderAxiomSummaryLine(
      parseAxiomTokenInfo({
        numHolders: 836,
        numBotUsers: 237,
        top10HoldersPercent: 26.346290048605002,
        devHoldsPercent: 0,
        insidersHoldPercent: 22.10801488094056,
        bundlersHoldPercent: 0.06457287556194331,
        snipersHoldPercent: 0,
        dexPaid: true,
        totalPairFeesPaid: 184.28299824532502,
      }),
    );
    assert.equal(
      burp,
      "Top 10 26.3% | 持有人 836 | Pro 237 | Dev 0% | 🔴內部 22.1% | 捆綁 0.1% | 狙擊 0% | 已付Dex | Creator 已收 184.3 SOL",
    );
    // Red-flag thresholds: 內部 ≥15 / 捆綁 ≥13 / 狙擊 ≥5.
    const flagged = renderAxiomSummaryLine(
      parseAxiomTokenInfo({
        numHolders: 100,
        numBotUsers: 50,
        top10HoldersPercent: 30,
        devHoldsPercent: 1.2,
        insidersHoldPercent: 15,
        bundlersHoldPercent: 13,
        snipersHoldPercent: 5.2,
        dexPaid: false,
      }),
    );
    assert.ok(flagged.includes("🔴內部 15%"));
    assert.ok(flagged.includes("🔴捆綁 13%"));
    assert.ok(flagged.includes("🔴狙擊 5.2%"));
    assert.ok(flagged.includes("未付Dex"));
    assert.ok(!flagged.includes("Creator"), "absent fees field renders no segment");
    // Just below the lines stays unflagged (strict >=).
    const clean = renderAxiomSummaryLine(
      parseAxiomTokenInfo({
        numHolders: 100,
        numBotUsers: 90,
        top10HoldersPercent: 10,
        insidersHoldPercent: 14.9,
        bundlersHoldPercent: 12.9,
        snipersHoldPercent: 4.9,
      }),
    );
    assert.ok(!clean.includes("🔴"));
    // Missing data hides the whole line → card falls back to legacy lines.
    assert.equal(renderAxiomSummaryLine(null), null);
    assert.equal(
      renderAxiomSummaryLine(parseAxiomTokenInfo({ dexPaid: true })),
      null,
      "identity fields absent → null",
    );
  });

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

  // ---------- worker liveness/heartbeat DB helpers (2026-09-03 changes) ----------

  await test("bumpScheduledTick: batched counter + tick ring (cap 90, corruption-safe)", async () => {
    const t = tmpDb();
    try {
      // The worker constructs a fresh Db and calls bumpScheduledTick BEFORE
      // init on a schema that already exists (created by an earlier init on
      // a previous deploy). Mirror that: init once, then bump via a second
      // Db instance on the same file.
      const boot = new Db(t.p, undefined, t.client);
      await boot.init();
      const db = new Db(t.p, undefined, t.client);
      await db.bumpScheduledTick();
      let row = (
        await t.client.execute("SELECT value FROM worker_state WHERE key = 'scheduled_tick_total'")
      ).rows[0];
      assert.equal(String(row.value), "1");
      row = (await t.client.execute("SELECT value FROM worker_state WHERE key = 'scheduled_tick_at'")).rows[0];
      const at = Number(row.value);
      assert.ok(Math.abs(Date.now() - at) < 30_000, "scheduled_tick_at is recent");
      let ring = JSON.parse(
        String((await t.client.execute("SELECT value FROM worker_state WHERE key = 'scheduled_tick_ring'")).rows[0].value),
      );
      assert.equal(ring.length, 1);
      assert.equal(ring[0], at);

      // Accumulates across calls.
      await db.bumpScheduledTick();
      row = (await t.client.execute("SELECT value FROM worker_state WHERE key = 'scheduled_tick_total'")).rows[0];
      assert.equal(String(row.value), "2");
      ring = JSON.parse(
        String((await t.client.execute("SELECT value FROM worker_state WHERE key = 'scheduled_tick_ring'")).rows[0].value),
      );
      assert.equal(ring.length, 2);
      assert.equal(ring[1] > ring[0], true, "ring is ordered oldest -> newest");
    } finally {
      await t.cleanup();
    }
  });

  await test("bumpScheduledTick: ring caps at 90 and survives a corrupted ring", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // Corrupted ring value must reset, not crash.
      await t.client.execute(
        "INSERT INTO worker_state (key, value) VALUES ('scheduled_tick_ring', 'not-json') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      await db.bumpScheduledTick();
      let ring = JSON.parse(
        String((await t.client.execute("SELECT value FROM worker_state WHERE key = 'scheduled_tick_ring'")).rows[0].value),
      );
      assert.equal(ring.length, 1);
      // 95 pre-seeded entries + 1 bump -> capped at the newest 90.
      const old = Array.from({ length: 95 }, (_, i) => 1_000_000 + i);
      await t.client.execute(
        "INSERT INTO worker_state (key, value) VALUES ('scheduled_tick_ring', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [JSON.stringify(old)],
      );
      await db.bumpScheduledTick();
      ring = JSON.parse(
        String((await t.client.execute("SELECT value FROM worker_state WHERE key = 'scheduled_tick_ring'")).rows[0].value),
      );
      assert.equal(ring.length, 90, "ring capped at 90");
      assert.equal(ring[89] > 1_000_094, true, "newest entry appended, oldest dropped");
    } finally {
      await t.cleanup();
    }
  });

  await test("persistScanCompletion: heartbeat + history in one call; null history = heartbeat only", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const at = Date.now();
      const hb = JSON.stringify({ at, ok: false, phase: "done", ms: 22139 });
      await db.persistScanCompletion(hb, {
        at,
        ok: false,
        ms: 22139,
        err: "tick exceeded 22000ms budget",
        profiles: 12,
        pool: 447,
        candidates: 0,
        pushed: 0,
      });
      const hbRow = (await t.client.execute("SELECT value FROM worker_state WHERE key = 'scan_heartbeat'")).rows[0];
      assert.equal(String(hbRow.value), hb, "heartbeat persisted verbatim");
      let hist = (await t.client.execute("SELECT * FROM scan_history")).rows;
      assert.equal(hist.length, 1);
      assert.equal(Number(hist[0].at), at);
      assert.equal(hist[0].ok, 0, "ok mapped to 0 for false");
      assert.equal(Number(hist[0].pool), 447);
      assert.equal(String(hist[0].err), "tick exceeded 22000ms budget");
      // null history -> heartbeat-only write, no extra row.
      await db.persistScanCompletion(JSON.stringify({ at: at + 1, ok: true, phase: "scanning" }), null);
      hist = (await t.client.execute("SELECT * FROM scan_history")).rows;
      assert.equal(hist.length, 1, "no history row for null history");
    } finally {
      await t.cleanup();
    }
  });

  await test("getScanHistory: newest-first with mapped fields and limit", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // Realistic timestamps: persistScanCompletion's first-call prune check
      // deletes rows older than 30 days, so synthetic epoch-1000 rows would
      // be pruned before the assertions run.
      const now = Date.now();
      await db.persistScanCompletion("x", { at: now, ok: true, ms: 10, err: null, profiles: 1, pool: 2, candidates: 3, pushed: 4 });
      await db.persistScanCompletion("x", { at: now + 1, ok: false, ms: 20, err: "boom", profiles: 5, pool: 6, candidates: 7, pushed: 8 });
      const rows = await db.getScanHistory(10);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].at, now + 1, "newest first");
      assert.equal(rows[0].ok, false);
      assert.equal(rows[0].err, "boom");
      assert.equal(rows[1].at, now);
      assert.equal(rows[1].ok, true);
      assert.equal(rows[1].profiles, 1);
      // Respects the limit.
      const limited = await db.getScanHistory(1);
      assert.equal(limited.length, 1);
      assert.equal(limited[0].at, now + 1);
    } finally {
      await t.cleanup();
    }
  });

  // ---------- dead-tick backfill (worker.ts deadTickBackfillInfo) ----------

  await test("deadTickBackfillInfo: stale phase=scanning heartbeat → backfill row, done/fresh/null → none", () => {
    const now = 1_000_000;
    const stale = 45_000;
    // Stale scanning heartbeat (a tick died before its completion flush).
    assert.deepEqual(
      deadTickBackfillInfo(JSON.stringify({ at: now - 120_000, ok: true, phase: "scanning" }), now, stale),
      { at: now - 120_000, ms: 120_000 },
    );
    // Fresh scanning heartbeat — a scan is still legitimately running.
    assert.equal(
      deadTickBackfillInfo(JSON.stringify({ at: now - 10_000, ok: true, phase: "scanning" }), now, stale),
      null,
    );
    // Exactly at the boundary IS stale (only younger-than-stale is excluded
    // — a 45s-old scan cannot be legitimately running under a 16s budget).
    assert.deepEqual(
      deadTickBackfillInfo(JSON.stringify({ at: now - stale, ok: true, phase: "scanning" }), now, stale),
      { at: now - stale, ms: stale },
    );
    // Done heartbeat — the completion flush landed, its row already exists.
    assert.equal(
      deadTickBackfillInfo(JSON.stringify({ at: now - 300_000, ok: true, phase: "done" }), now, stale),
      null,
    );
    // No heartbeat / missing phase / missing at / garbage JSON → never backfill.
    assert.equal(deadTickBackfillInfo(null, now, stale), null);
    assert.equal(deadTickBackfillInfo("", now, stale), null);
    assert.equal(deadTickBackfillInfo("not json", now, stale), null);
    assert.equal(deadTickBackfillInfo(JSON.stringify({ at: now - 120_000 }), now, stale), null);
    assert.equal(deadTickBackfillInfo(JSON.stringify({ phase: "scanning" }), now, stale), null);
  });

  await test("claimScanLock: dead-tick backfill row rides the winning claim batch; losers never duplicate", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // A dead predecessor left a stale scanning heartbeat; the next tick
      // builds the backfill entry from it and passes it into the claim.
      const deadAt = Date.now() - 120_000;
      await db.setWorkerState(
        "scan_heartbeat",
        JSON.stringify({ at: deadAt, ok: true, phase: "scanning" }),
      );
      const entry = {
        at: deadAt,
        ok: false,
        ms: 120_000,
        err: "previous tick died before its completion flush (backfilled by next tick)",
        profiles: null,
        pool: null,
        candidates: null,
        pushed: null,
      };
      const winner = await db.claimScanLock("ownerA", Date.now(), 55_000, "{}", entry);
      assert.ok(winner, "first claim wins");
      let rows = await db.getScanHistory(10);
      assert.equal(rows.length, 1, "backfill row landed inside the claim batch");
      assert.equal(rows[0].at, deadAt, "row carries the dead tick's start time");
      assert.equal(rows[0].ok, false);
      assert.match(rows[0].err ?? "", /backfilled/);
      assert.equal(rows[0].profiles, null, "dead tick's feed counters are unknown");
      // A racing loser computed the SAME entry from the same stale heartbeat
      // (read before the winner's claim overwrote it). Its claim batch also
      // executes — the lock-value EXISTS guard must stop its INSERT.
      const loser = await db.claimScanLock("ownerB", Date.now() + 1_000, 55_000, "{}", entry);
      assert.equal(loser, null, "live lock blocks the loser");
      rows = await db.getScanHistory(10);
      assert.equal(rows.length, 1, "loser's claim batch inserted no duplicate");
      // Without an entry, the claim batch inserts no history row at all.
      await db.releaseScanLock(winner);
      const plain = await db.claimScanLock("ownerC", Date.now() + 2_000, 55_000, "{}");
      assert.ok(plain, "claim without entry still wins");
      rows = await db.getScanHistory(10);
      assert.equal(rows.length, 1, "no entry → no extra row");
    } finally {
      await t.cleanup();
    }
  });

  await test("claimScanLock: exclusive claim, stale takeover, exact-value release", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const now = 1_000_000;
      // First claim wins and hands back the exact release value.
      const a = await db.claimScanLock("ownerA", now, 55_000);
      assert.ok(a !== null, "first claim wins");
      // Second isolate while the first is live → denied (even with a longer TTL).
      assert.equal(await db.claimScanLock("ownerB", now + 1_000, 55_000), null);
      assert.equal(await db.claimScanLock("ownerB", now + 2_000, 120_000), null);
      // Owner release (exact value) frees the lock for the next claim.
      await db.releaseScanLock(a);
      const b = await db.claimScanLock("ownerB", now + 3_000, 55_000);
      assert.ok(b !== null, "claim after release wins");
      // A dead holder (TTL elapsed) is CAS-taken over.
      await db.releaseScanLock(b);
      const c = await db.claimScanLock("ownerC", now, 1_000);
      assert.ok(c !== null, "short-TTL claim wins");
      const d = await db.claimScanLock("ownerD", now + 2_000, 55_000);
      assert.ok(d !== null, "stale claim taken over after TTL");
      // Releasing with the OLD value must not clear the new owner's lock.
      await db.releaseScanLock(c);
      assert.equal(
        await db.claimScanLock("ownerE", now + 3_000, 55_000),
        null,
        "old-value release is a no-op",
      );
      // The real owner's release clears it.
      await db.releaseScanLock(d);
      assert.ok(
        (await db.claimScanLock("ownerE", now + 4_000, 55_000)) !== null,
        "real owner release frees the lock",
      );
    } finally {
      await t.cleanup();
    }
  });

  await test("claimScanLock: batched heartbeat goes out with the winning claim only; completion batch releases", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const now = 2_000_000;
      const hb = JSON.stringify({ at: now, ok: true, phase: "scanning", ms: null, err: null, skip: null });
      const a = await db.claimScanLock("ownerA", now, 55_000, hb);
      assert.ok(a !== null, "first claim wins");
      assert.equal(await db.getWorkerState("scan_heartbeat"), hb, "winner heartbeat written in the same batch");
      // A losing claimant is denied the lock, but its batched heartbeat
      // stamp is equivalent (a scan is running that second — the winner's),
      // so liveness stays fresh either way.
      const hbLose = JSON.stringify({ at: now + 1, ok: true, phase: "scanning", ms: null, err: null, skip: null });
      assert.equal(await db.claimScanLock("ownerB", now + 1, 55_000, hbLose), null);
      const hbAfter = await db.getWorkerState("scan_heartbeat");
      assert.ok(hbAfter !== null && JSON.parse(hbAfter).phase === "scanning", "liveness heartbeat stays fresh");
      // The completion-flush batch (heartbeat done + history + lock delete)
      // releases the lock in the same round trip.
      await db.persistScanCompletion(
        JSON.stringify({ at: now + 10, ok: true, phase: "done", ms: 10, err: null, skip: null }),
        { at: now + 10, ok: true, ms: 10, err: null, profiles: 1, pool: 1, candidates: 0, pushed: 0 },
        a,
      );
      assert.equal(await db.getWorkerState("scan_lock"), null, "completion batch released the lock");
      assert.ok(
        (await db.claimScanLock("ownerB", now + 20, 55_000)) !== null,
        "lock free after batch release",
      );
    } finally {
      await t.cleanup();
    }
  });

  await test("DEFAULT_SETTINGS match the operator's filter spec", () => {
    assert.equal(DEFAULT_SETTINGS.minMarketCapUsd, 40000);
    assert.equal(DEFAULT_SETTINGS.maxMarketCapUsd, 380000);
    assert.equal(DEFAULT_SETTINGS.minAgeMinutes, 80);
    assert.equal(DEFAULT_SETTINGS.maxAgeMinutes, 1560); // settings_v6 widened 21h -> 26h
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
      assert.equal(d.maxAgeMinutes, 1560);
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
      // settings_v6 (runs right after v2 in the same init) widens 1260 -> 1560.
      assert.equal(s.maxAgeMinutes, 1560);
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
      // FAR_CORPSE 5M: a pump-and-dump peak far above the ceiling — its
      // huge max_mcap_observed would rank it FIRST under the signal
      // ordering, permanently occupying band LIMITs (the 2026-09-10
      // starvation audit), so the ceiling prune must drop it.
      const now = 50 * 300e3;
      await seed("HOT", now - 6 * H, 0, null);
      await seed("FAR_HIGH", now - 25 * H, 0, 35000);
      await seed("FAR_LOW", now - 25 * H, 0, 3000);
      await seed("FAR_NULL", now - 25 * H, 0, null);
      await seed("FAR_CORPSE", now - 25 * H, 0, 5_000_000);

      const pool = await db.getReevalPool({
        sinceMs: now - 42 * H,
        minLaunchMs: now - (2400 + 180) * M,
        maxLaunchMs: now - (360 - 180) * M,
        windowEntryLaunchMs: now - 360 * M,
        limit: 1000,
        minQualifyMcap: 20000,
        maxQualifyMcap: 760000,
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
      assert.ok(
        !tokens.includes("FAR_CORPSE"),
        "coin whose peak far exceeded the ceiling is dropped from the pool",
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

  await test("getReevalPool: liquidity floor prune drops dead-liquidity corpses from every band", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const H = 3600e3;
      const M = 60e3;
      const seed = async (token, ageH, mcapObserved, liqObserved) => {
        await t.client.execute({
          sql: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, birdeye_1m_vol, rugcheck_bundler_pct, rugcheck_top10_pct, birdeye_pro_traders, birdeye_sniper_pct, min_mcap_observed, max_mcap_observed, max_liquidity_observed) VALUES (?, ?, 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)",
          args: [
            token,
            nowSeed - ageH * H,
            0,
            nowSeed - ageH * H,
            mcapObserved,
            liqObserved,
          ],
        });
      };
      // Fix a deterministic now BEFORE seeding (seed reads it).
      const nowSeed = 50 * 300e3;
      const now = nowSeed;
      // The 2026-09-10 starvation shape: corpses with huge peak mcap inside
      // the qualifying band but $0–$15 LP — they pass the mcap floor/ceiling
      // prunes and rank FIRST under the signal ordering, so they occupied
      // every band LIMIT (~215/330 evaluated coins/tick failing the
      // liquidity gate). The liquidity floor prune must drop them.
      await seed("LIVE_COIN", 25, 150000, 25000); // healthy in-band coin
      await seed("CORPSE_ZERO_LIQ", 25, 495642, 0.69); // ZenoCoin shape
      await seed("CORPSE_TINY_LIQ", 25, 162733, 15.59); // MANATEE shape
      await seed("NULL_LIQ", 25, 150000, null); // never seen with pair data → kept
      // Hot zone corpse: evaluated EVERY scan — the prune must apply there too.
      await seed("HOT_CORPSE", 6, 120000, 2.0);

      const pool = await db.getReevalPool({
        sinceMs: now - 42 * H,
        minLaunchMs: now - (2400 + 180) * M,
        maxLaunchMs: now - (360 - 180) * M,
        windowEntryLaunchMs: now - 360 * M,
        limit: 1000,
        minQualifyMcap: 20000,
        maxQualifyMcap: 760000,
        minQualifyLiquidity: 6000, // 0.6 × the $10K chat gate
        now,
      });
      const tokens = pool.map((x) => x.token);
      assert.ok(tokens.includes("LIVE_COIN"), "healthy in-band coin is kept");
      assert.ok(
        tokens.includes("NULL_LIQ"),
        "coin never seen with pair data (NULL liquidity) is kept",
      );
      assert.ok(
        !tokens.includes("CORPSE_ZERO_LIQ"),
        "mcap $495K over $0.69 LP corpse is dropped despite passing the mcap band",
      );
      assert.ok(
        !tokens.includes("CORPSE_TINY_LIQ"),
        "mcap $162K over $15 LP corpse is dropped",
      );
      assert.ok(
        !tokens.includes("HOT_CORPSE"),
        "hot-zone corpse is pruned too (the every-scan band)",
      );
      // Without the floor (legacy callers / tests) corpses stay — the prune
      // is opt-in via minQualifyLiquidity, like the mcap prunes.
      const poolNoFloor = await db.getReevalPool({
        sinceMs: now - 42 * H,
        minLaunchMs: now - (2400 + 180) * M,
        maxLaunchMs: now - (360 - 180) * M,
        windowEntryLaunchMs: now - 360 * M,
        limit: 1000,
        minQualifyMcap: 20000,
        maxQualifyMcap: 760000,
        now,
      });
      assert.ok(
        poolNoFloor.map((x) => x.token).includes("CORPSE_ZERO_LIQ"),
        "no liquidity floor configured → corpse kept (opt-in prune)",
      );
    } finally {
      await t.cleanup();
    }
  });

  await test("updateTokenMaxMcaps: raises peak mcap AND liquidity in one batch", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const H = 3600e3;
      const now = 50 * 300e3;
      const seed = async (token) => {
        await t.client.execute({
          sql: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, max_mcap_observed, max_liquidity_observed) VALUES (?, ?, 0, ?, ?, ?, ?)",
          args: [token, now - 6 * H, 0, now - 6 * H, 100000, 5000],
        });
      };
      await seed("RAISE_BOTH");
      await seed("NO_REGRESS");
      await seed("ZERO_REGRESS");
      // NULL liquidity: the row was never seen with pair data — the first
      // $0 LP reading must still be recorded (it is the corpse signal the
      // pool prune keys on).
      await t.client.execute({
        sql: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, max_mcap_observed, max_liquidity_observed) VALUES ('FIRST_ZERO', ?, 0, ?, ?, 100000, NULL)",
        args: [now - 6 * H, 0, now - 6 * H],
      });

      await db.updateTokenMaxMcaps([
        { token: "RAISE_BOTH", mcapUsd: 200000, liquidityUsd: 12000 }, // both up
        { token: "NO_REGRESS", mcapUsd: 50000, liquidityUsd: 1000 }, // both lower → kept
        { token: "ZERO_REGRESS", mcapUsd: 100000, liquidityUsd: 0 }, // mcap equal; $0 never lowers $5K
        { token: "FIRST_ZERO", mcapUsd: 100000, liquidityUsd: 0 }, // NULL → 0 recorded
      ]);

      const stats = await db.getTokenStatsMany(["RAISE_BOTH", "NO_REGRESS", "ZERO_REGRESS", "FIRST_ZERO"]);
      const raise = stats.get("RAISE_BOTH");
      assert.equal(raise.maxMcapObserved, 200000);
      assert.equal(raise.maxLiquidityObserved, 12000);
      const noRegress = stats.get("NO_REGRESS");
      assert.equal(noRegress.maxMcapObserved, 100000, "mcap never regresses");
      assert.equal(noRegress.maxLiquidityObserved, 5000, "liquidity never regresses");
      const zeroRegress = stats.get("ZERO_REGRESS");
      assert.equal(zeroRegress.maxMcapObserved, 100000);
      assert.equal(
        zeroRegress.maxLiquidityObserved,
        5000,
        "a $0 reading never lowers a stored peak (monotonic like mcap)",
      );
      const firstZero = stats.get("FIRST_ZERO");
      assert.equal(firstZero.maxMcapObserved, 100000);
      assert.equal(
        firstZero.maxLiquidityObserved,
        0,
        "the first $0 LP reading IS recorded on a NULL row (corpse signal)",
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
      tradersWindow: "1h",
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
    assert.equal(r.tradersWindow, "1h");
  });

  await test("fetchOrganicScore: trader count falls back 1h → 6h → 24h", async () => {
    const mint = "5BoYu1xSzX68h8p6HCJzgvggSCcM7JovP3J1ZLPJpump";
    const make = (entry) =>
      new JupTokensClient(
        { jupiterRequestIntervalMs: 0 },
        async () => new Response(JSON.stringify([{ id: mint, ...entry }]), { status: 200 }),
      );
    // The ARMY push-time shape: stats1h exists but OMITS numTraders
    // entirely (zero trades in the trailing hour); 6h has the count.
    const r6 = await make({ organicScore: 1, stats1h: { volumeChange: -100 }, stats6h: { numTraders: 13 } }).fetchOrganicScore(mint);
    assert.equal(r6.tradersH1, 13);
    assert.equal(r6.tradersWindow, "6h");
    // No 6h either → 24h.
    const r24 = await make({ stats24h: { numTraders: 60 } }).fetchOrganicScore(mint);
    assert.equal(r24.tradersH1, 60);
    assert.equal(r24.tradersWindow, "24h");
    // No trader data in any window → count nulls but a present score still renders.
    const rNone = await make({ organicScore: 5 }).fetchOrganicScore(mint);
    assert.equal(rNone.tradersH1, null);
    assert.equal(rNone.tradersWindow, null);
    assert.equal(rNone.score, 5);
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

  // ---------- post-push tracker pass (row floor + coverage note) ----------
  //
  // 2026-09-17 live shape: 33 push_watch rows, 28 of them ACTIVE, every tick
  // reporting `pushWatch: "ok:0/0"` — and not one row carrying a tracker
  // write. The pass's mandatory stages (recap/prune, self-heal scan, one
  // DexScreener batch for the watched tokens) cost more than the whole 500ms
  // budget, so the row loop hit its first budget check already past the
  // deadline, broke immediately and returned `checked: 0` with NO note —
  // indistinguishable from a tick with nothing to watch, i.e. post-push
  // monitoring had stopped while looking healthy. These tests pin the two
  // guarantees that close that hole.

  // Fixture shaped like db.listPushWatch's row mapping.
  const watchRow = (token, over = {}) => {
    const pushedAt = Date.now() - 30 * 60_000;
    return {
      token, chatId: "c", symbol: token, pushedAt,
      mcapAtPush: 100_000, peakMcap: 100_000, lastLiquidity: 50_000,
      lastVol5m: 1_000, deadTroughMcap: null, holdersAtPush: null,
      holdersLast: null, holdersCheckedAt: null, sellDomStreak: 0,
      lastMcap: null, lastChecked: pushedAt, lastAlertAt: 0,
      followupsSent: 0, lastState: null, upStages: null,
      ...over,
    };
  };
  // Flat live pair: no rising/weak/ignition/liquidity alert can fire, so the
  // tests observe the pass's bookkeeping instead of its alerting.
  const watchPair = (token) => ({
    chainId: "solana", url: "", pairAddress: `p-${token}`,
    baseToken: { address: token, name: token, symbol: token },
    priceUsd: "0.001", marketCap: 100_000,
    volume: { h24: 1_000_000, h1: 20_000, m5: 1_000 },
    priceChange: { m5: 1, h1: 5 },
    txns: { m5Buys: 10, m5Sells: 8, h1Buys: 100, h1Sells: 80 },
    liquidity: { usd: 50_000 }, pairCreatedAt: Date.now() - 3 * 3_600_000,
  });
  const watchDb = (rows, updated) => ({
    listPushWatch: async () => rows,
    prunePushWatch: async () => 0,
    findUntrackedPushes: async () => [],
    markRecapClaimed: async () => false,
    markRecapClaimedMany: async (tokens) => tokens.map(() => false),
    getInitialPushAuditTokens: async () => new Set(),
    upsertPushWatchMany: async () => {},
    claimPushWatch: async () => true,
    reservePushWatchAlert: async () => true,
    updatePushWatchCheck: async (token, v) => { updated.push([token, v]); },
    deletePushWatch: async () => {},
    setPushWatchHolders: async () => {},
  });
  const watchBot = { api: { sendMessage: async () => ({ message_id: 1 }) } };

  await test("PushWatcher: the row loop always evaluates a row, even when the pair batch ate the budget", async () => {
    const rows = [watchRow("AAA"), watchRow("BBB")];
    const updated = [];
    const deadlines = [];
    const pairsFor = async (addrs, deadlineMs) => {
      deadlines.push(deadlineMs);
      await new Promise((r) => setTimeout(r, 250));
      return new Map(addrs.map((a) => [a, watchPair(a)]));
    };
    const pw = new PushWatcher(
      watchDb(rows, updated), watchBot, null, loadConfig({}), pairsFor, null,
    );
    // 100ms budget against a 250ms batch: the pass is past its deadline
    // before the loop even starts — the live shape. The first row must run.
    const out = await pw.runTick(Date.now() + 100);
    assert.equal(out.checked, 1, "one row must be evaluated however late the pass is");
    assert.equal(updated.length, 1);
    assert.match(String(out.note), /budget-cut/);
    assert.equal(
      typeof deadlines[0],
      "number",
      "the batch gets a caller deadline so it cannot overrun the pass",
    );
  });

  await test("PushWatcher: tokens the pair batch did not return are reported, not silently skipped", async () => {
    const rows = [watchRow("AAA"), watchRow("BBB")];
    const updated = [];
    const pw = new PushWatcher(
      watchDb(rows, updated), watchBot, null, loadConfig({}),
      async () => new Map(), null,
    );
    const out = await pw.runTick();
    assert.equal(out.checked, 0);
    assert.equal(updated.length, 0);
    // The old code returned no note at all here — the silent-starve shape.
    assert.match(String(out.note), /rows 0\/2/);
    assert.match(String(out.note), /miss 2/);
  });

  await test("PushWatcher: a card that cannot be sent leaves its row untouched", async () => {
    // The reservation happens BEFORE the send and is never retried, so a row
    // started without the send slice loses its card for good (live 2026-09-18
    // 02:58Z and 03:00Z: `dropped 1` on two consecutive passes). The pass must
    // refuse such a row outright — no claim, no write — so the next tick
    // delivers the card with a fresh budget. The reachable trigger is the
    // failed-listing fallback below: it re-reads the table AFTER the pass's
    // last deadline check, so a slow re-listing is what carries the pass past
    // its budget without it noticing.
    const rows = [watchRow("MOON", { mcapAtPush: 50_000 })];
    const updated = [];
    let sends = 0;
    let listCalls = 0;
    const db = watchDb(rows, updated);
    db.listPushWatch = async () => {
      listCalls += 1;
      if (listCalls === 1) throw new Error("listing failed");
      await new Promise((r) => setTimeout(r, 250)); // the fallback re-read
      return rows;
    };
    const pw = new PushWatcher(
      db,
      { api: { sendMessage: async () => { sends += 1; return { message_id: 1 }; } } },
      null,
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const out = await pw.runTick(Date.now() + 100);
    assert.equal(sends, 0, "nothing may be sent without the slice to send it");
    assert.equal(out.checked, 0, "the row is not claimed");
    assert.equal(updated.length, 0, "and nothing is written — the row keeps its state");
    assert.match(String(out.note), /defer-send 1/);
    assert.match(String(out.note), /budget-cut/);
    assert.equal(out.alerted, 0);
  });

  await test("PushWatcher: the pair batch covers only the rows the pass can actually reach", async () => {
    // Ten tracked coins, one DexScreener request. Asking for all of them spent
    // the pass's only mandatory call on addresses the loop never evaluates —
    // and a slow batch then made every row a pair miss, so the pass did
    // nothing at all (`pairs 0/30 miss 30`, live 2026-09-18).
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push(watchRow(`T${i}`));
    const updated = [];
    const asked = [];
    const pairsFor = async (addrs) => {
      asked.push(addrs.length);
      return new Map([["T0", watchPair("T0")]]);
    };
    const pw = new PushWatcher(
      watchDb(rows, updated), watchBot, null, loadConfig({}), pairsFor, null,
    );
    const out = await pw.runTick();
    assert.equal(asked.length, 1);
    assert.ok(asked[0] <= 6, `batch asked for ${asked[0]} addresses, expected the queue head`);
    assert.equal(out.checked, 1, "the row that did resolve a pair is evaluated");
    assert.match(String(out.note), /rows 1\/10/);
    assert.match(String(out.note), /pairs 1\/6/);
    // Only the rows the batch COVERED may be counted as misses — a coin can
    // never be judged delisted off a request it was not part of.
    assert.match(String(out.note), /miss 5/);
    assert.ok(
      !/miss 10/.test(String(out.note)),
      `rows outside the batch must not be reported as misses: ${out.note}`,
    );
  });

  await test("PushWatcher: a row that starts after the deadline sends inside the pass tail", async () => {
    // The first row runs even when the pass has no budget left (the progress
    // floor), so its send slice — not the whole per-row cap — is what bounds
    // the tick: the old 1000ms cap let a candidate tick finish at 4857ms of a
    // ~4840ms race window and lose its flush entirely. A send that misses
    // the slice is now ROLLED BACK rather than recorded as announced, so
    // the card is re-announced next tick instead of vanishing.
    const rows = [watchRow("MOON", { mcapAtPush: 50_000 })];
    const updated = [];
    let sends = 0;
    const hangingBot = {
      api: {
        sendMessage: () => {
          sends += 1;
          return new Promise(() => {}); // never answers
        },
      },
    };
    const pw = new PushWatcher(
      watchDb(rows, updated),
      hangingBot,
      null,
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const t0 = Date.now();
    const out = await pw.runTick(Date.now() + 60);
    const elapsed = Date.now() - t0;
    assert.equal(sends, 1, "the alert is attempted exactly once");
    assert.equal(out.alerted, 0, "a send that misses the slice is not counted as delivered");
    assert.match(
      String(out.note),
      /undelivered 1/,
      "the undelivered card is reported, not hidden",
    );
    assert.ok(
      elapsed < 900,
      `a late row must finish inside the pass tail, took ${elapsed}ms`,
    );
    assert.equal(updated.length, 1, "the row's bookkeeping still lands");
    // The rollback: the transition this card carried stays unannounced, so
    // the next tick re-derives it and sends the card. Before this the
    // reservation simply stood and the card was lost for good.
    const [, written] = updated[0];
    assert.equal(written.followupsSent, rows[0].followupsSent, "not counted as sent");
    assert.equal(written.lastAlertAt, rows[0].lastAlertAt, "the alert clock is rolled back");
    assert.equal(written.lastState, rows[0].lastState, "and so is the state");
    assert.equal(written.upStages, rows[0].upStages, "and the announced rocket stage");
    assert.equal(written.lastMcap, 100_000, "while the measurements still advance");
  });

  await test("PushWatcher: a DELIVERED alert still records its transition", async () => {
    // The rollback must be conditional — if a delivered card left its
    // transition unannounced, the same card would be re-sent every tick.
    const rows = [watchRow("MOON", { mcapAtPush: 50_000 })];
    const updated = [];
    const pw = new PushWatcher(
      watchDb(rows, updated),
      watchBot,
      null,
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const out = await pw.runTick(Date.now() + 5_000);
    assert.equal(out.alerted, 1, "the rising alert is delivered");
    assert.doesNotMatch(String(out.note), /undelivered/);
    const [, written] = updated[0];
    assert.equal(written.followupsSent, 1, "the delivered card is counted");
    assert.ok(written.lastAlertAt > 0, "and the alert clock advances");
  });

  await test("PushWatcher: one failed row does not roll back a later row", async () => {
    // The undelivered counter is per PASS (it feeds the note), so the
    // rollback flag must be per ROW: comparing the pass total would roll
    // back every row after the first failure — re-sending cards that were
    // already delivered. Row A's send throws, row B's succeeds.
    const rows = [
      watchRow("AAA", { mcapAtPush: 50_000 }),
      watchRow("BBB", { mcapAtPush: 50_000 }),
    ];
    const updated = [];
    let calls = 0;
    const flakyBot = {
      api: {
        sendMessage: async () => {
          calls += 1;
          if (calls === 1) throw new Error("Telegram 500");
          return { message_id: 7 };
        },
      },
    };
    const pw = new PushWatcher(
      watchDb(rows, updated),
      flakyBot,
      null,
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const out = await pw.runTick(Date.now() + 5_000);
    assert.equal(updated.length, 2, "both rows were evaluated");
    assert.match(String(out.note), /undelivered 1/);
    assert.equal(out.alerted, 1, "only the delivered card counts");
    const [, first] = updated[0];
    const [, second] = updated[1];
    assert.equal(first.followupsSent, 0, "the failed row is rolled back");
    assert.equal(first.lastAlertAt, rows[0].lastAlertAt);
    assert.equal(second.followupsSent, 1, "the delivered row is NOT");
    assert.ok(second.lastAlertAt > 0);
  });

  await test("PushWatcher: a held-back card is re-announced on the next pass (at-least-once, counted)", async () => {
    // The rollback exists so an undelivered card is re-derived next tick — but
    // nothing recorded whether that actually happened: the pass note showed the
    // loss and the next tick's note overwrote it. Two passes on ONE watcher:
    // the first times out (held back), the second delivers the same card.
    const rows = [watchRow("MOON", { mcapAtPush: 50_000 })];
    const updated = [];
    let hang = true;
    const bot = {
      api: {
        sendMessage: () =>
          hang
            ? new Promise(() => {}) // never answers: the send misses its slice
            : Promise.resolve({ message_id: 9 }),
      },
    };
    const pw = new PushWatcher(
      watchDb(rows, updated),
      bot,
      null,
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const first = await pw.runTick(Date.now() + 60);
    assert.equal(first.undelivered, 1, "the pass reports the held-back card");
    assert.equal(first.undeliveredTotal, 1);
    assert.equal(first.recoveredUndelivered, 0, "nothing delivered yet");
    assert.equal(first.pendingUndelivered, 1, "the coin waits for its make-up send");
    hang = false;
    const second = await pw.runTick(Date.now() + 5_000);
    assert.equal(second.alerted, 1, "the held-back card is delivered on the next pass");
    assert.equal(second.recoveredUndelivered, 1, "and counted as recovered");
    assert.equal(second.undeliveredTotal, 1, "no new loss in the second pass");
    assert.equal(second.pendingUndelivered, 0, "the backlog clears");
    assert.match(String(second.note), /recovered 1/, "the note names the recovery");
    assert.doesNotMatch(String(second.note), /undelivered/, "and not the old loss");
  });

  await test("PushWatcher: the rotation head is published for the scanner's next pair phase", async () => {
    // Tracked coins are PUSHED coins, which the re-eval pool query excludes —
    // so unless the scanner fetches them alongside the pool, the tracker's own
    // batch is the only request that ever asks for them and a rate-limited
    // DexScreener leaves the pass with no prices at all.
    const rows = [];
    for (let i = 0; i < 8; i++) {
      rows.push(watchRow(`T${i}`, { lastChecked: Date.now() - (8 - i) * 60_000 }));
    }
    const updated = [];
    const pw = new PushWatcher(
      watchDb(rows, updated), watchBot, null, loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])), null,
    );
    assert.deepEqual(pw.headTokens(), [], "nothing published before the first pass");
    await pw.runTick();
    const head = pw.headTokens();
    assert.ok(head.length > 0 && head.length <= 6, `head size ${head.length}`);
    assert.equal(head[0], "T0", "least-recently-checked first, i.e. the rotation order");
  });

  await test("PushWatcher: a recovered tracking gap absorbs state silently instead of firing a stale burst", async () => {
    // The pass's delivery is suppressed for a row the tracker has NEVER
    // evaluated (last_mcap still null) whose push is older than the alert
    // cooldown: that is exactly what every tracked coin looks like when the
    // tracker was starved. Bookkeeping must still land, so the next check
    // reports only new information and the window's recap still tells the
    // story.
    const rows = [watchRow("AAA", { pushedAt: Date.now() - 3 * 3_600_000 })];
    const updated = [];
    let sent = 0;
    const pw = new PushWatcher(
      watchDb(rows, updated),
      { api: { sendMessage: async () => { sent += 1; return { message_id: 1 }; } } },
      null,
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, { ...watchPair(a), marketCap: 200_000 }])),
      null,
    );
    const out = await pw.runTick();
    assert.equal(out.checked, 1);
    assert.equal(sent, 0, "a stale first observation must not deliver cards");
    assert.match(String(out.note), /backfill 1/);
    const written = updated[0][1];
    assert.equal(written.lastMcap, 200_000, "the observation is still recorded");
    assert.equal(written.lastState, "up100", "already-crossed stages are marked as absorbed");
    assert.equal(written.followupsSent, 0, "suppressed alerts are not counted as delivered");
    assert.equal(written.lastAlertAt, 0, "the alert clock is left alone");
    // Only the highest crossed stage is marked (one stage per check), so
    // no 🚀 card can be re-announced when tracking resumes.
    assert.equal(written.upStages, "up100");
  });

  await test("PushWatcher: one listing per tick, recap claims batched, no no-op prune, trips reported", async () => {
    // 2026-09-17 round-trip merge: the pass read push_watch TWICE per tick
    // (recap pass + row loop), claimed every expiring row with its own request,
    // and always ran the prune even when it provably deleted nothing. On a
    // pass budget of ~1s those round trips are what starves the rotation, so
    // the mocks count every call and the pass must report the same number.
    const window = loadConfig({}).pushWatch.windowHours * 3_600_000;
    const rows = [
      watchRow("OLD", { pushedAt: Date.now() - window - 60_000 }),
      watchRow("AAA"),
    ];
    const calls = { list: 0, prune: 0, claims: [], total: 0, updated: [] };
    const db = {
      listPushWatch: async () => { calls.list += 1; calls.total += 1; return rows; },
      prunePushWatch: async () => { calls.prune += 1; calls.total += 1; return 1; },
      markRecapClaimedMany: async (tokens) => {
        calls.claims.push(tokens);
        calls.total += 1;
        return tokens.map(() => true);
      },
      findUntrackedPushes: async () => { calls.total += 1; return []; },
      claimPushWatch: async () => { calls.total += 1; return true; },
      reservePushWatchAlert: async () => { calls.total += 1; return true; },
      updatePushWatchCheck: async (token, v) => {
        calls.total += 1;
        calls.updated.push([token, v]);
      },
      deletePushWatch: async () => { calls.total += 1; },
      setPushWatchHolders: async () => { calls.total += 1; },
    };
    let cards = 0;
    const pw = new PushWatcher(
      db,
      { api: { sendMessage: async () => { cards += 1; return { message_id: 1 }; } } },
      null,
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const out = await pw.runTick();
    assert.equal(calls.list, 1, "push_watch must be read ONCE per tick (recap + loop share it)");
    assert.equal(calls.claims.length, 1, "recap claims for N rows must ride in ONE batch");
    assert.deepEqual(calls.claims[0], ["OLD"], "only the expiring row is claimed");
    assert.equal(cards, 1, "the expiring row still gets its recap card");
    assert.equal(calls.prune, 1, "a row past the window still triggers the prune");
    assert.deepEqual(
      calls.updated.map(([t]) => t), ["AAA"],
      "a recapped row must never be evaluated again (the prune removes it)",
    );
    assert.equal(out.trips, calls.total, "the reported round trips are the ones actually made");
    assert.match(String(out.note), /trips \d+/, "the coverage note names the round-trip count");
  });

  await test("PushWatcher: the prune is skipped when it provably deletes nothing", async () => {
    // Same merge: the prune is `DELETE ... WHERE pushed_at < cutoff`, so with a
    // COMPLETE listing (fewer rows than the limit, nothing outside the
    // snapshot) that holds no past-window row it cannot match anything — one
    // saved round trip on the common tick.
    const rows = [watchRow("AAA")];
    const calls = { list: 0, prune: 0, total: 0 };
    const db = {
      listPushWatch: async () => { calls.list += 1; calls.total += 1; return rows; },
      prunePushWatch: async () => { calls.prune += 1; calls.total += 1; return 0; },
      markRecapClaimedMany: async (tokens) => { calls.total += 1; return tokens.map(() => true); },
      findUntrackedPushes: async () => { calls.total += 1; return []; },
      claimPushWatch: async () => { calls.total += 1; return true; },
      reservePushWatchAlert: async () => { calls.total += 1; return true; },
      updatePushWatchCheck: async () => { calls.total += 1; },
      deletePushWatch: async () => { calls.total += 1; },
      setPushWatchHolders: async () => { calls.total += 1; },
    };
    const pw = new PushWatcher(
      db, watchBot, null, loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const out = await pw.runTick();
    assert.equal(calls.prune, 0, "a no-op prune must not spend a round trip");
    assert.equal(calls.list, 1);
    assert.equal(out.checked, 1);
    assert.equal(out.trips, calls.total);
  });

  await test("PushWatcher: a hanging alert send is capped instead of carrying the pass", async () => {
    // The two network stages were awaited with NOTHING bounding them, and a
    // budget check only runs BETWEEN stages — so one slow Telegram response
    // held the pass open regardless of its budget (live: trackerMs 1962
    // against a 1000ms budget). The send now races TRACKER_SEND_CAP_MS and a
    // miss is treated exactly like a failed send (logged, never retried — the
    // transition was reserved before the send, so a retry would risk the
    // duplicate card that guard exists to prevent).
    const rows = [watchRow("AAA", { mcapAtPush: 10_000, peakMcap: 10_000 })];
    const updated = [];
    let sends = 0;
    const pw = new PushWatcher(
      watchDb(rows, updated),
      { api: { sendMessage: async () => { sends += 1; return new Promise(() => {}); } } },
      null,
      loadConfig({}),
      // 10x the push mcap: four 🚀 stages want to fire — a hanging Telegram
      // must not spend the cap once per card.
      async (addrs) => new Map(addrs.map((a) => [a, { ...watchPair(a), marketCap: 100_000 }])),
      null,
    );
    const t0 = Date.now();
    const out = await pw.runTick();
    const elapsed = Date.now() - t0;
    assert.equal(sends, 1, "only ONE card is attempted — the budget is per row, not per card");
    assert.equal(out.alerted, 0, "a hanging send delivers nothing");
    assert.equal(out.checked, 1, "the row's bookkeeping still lands");
    assert.equal(updated.length, 1, "the pass finishes the row it started");
    assert.ok(elapsed < 2_500, `the pass must return near the send cap, took ${elapsed}ms`);
  });

  await test("PushWatcher: a hanging Birdeye holder probe is capped and skipped", async () => {
    // The holder probe is purely additive (nothing is reserved before it and
    // holders_checked_at is only written on success), so a miss costs nothing
    // and is retried next tick — it must never hold the pass open.
    const rows = [watchRow("AAA")];
    const updated = [];
    let probes = 0;
    const pw = new PushWatcher(
      watchDb(rows, updated),
      watchBot,
      { getTokenOverview: async () => { probes += 1; return new Promise(() => {}); } },
      loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    const t0 = Date.now();
    const out = await pw.runTick();
    const elapsed = Date.now() - t0;
    assert.equal(probes, 1, "the probe is attempted once");
    assert.equal(out.checked, 1);
    assert.ok(elapsed < 2_000, `the pass must return near the holder cap, took ${elapsed}ms`);
  });

  await test("PushWatcher: a row is only started when its own cost still fits the pass", async () => {
    // The loop used to ask only "am I past the deadline?", so it started a row
    // it could not finish and the pass overran by a whole row.
    // TRACKER_ROW_RESERVE_MS is checked before the claim: a row that cannot
    // finish is left to the next tick, where it is re-claimed (nothing lost).
    const rows = [watchRow("AAA"), watchRow("BBB")];
    const claims = [];
    const updated = [];
    const db = {
      ...watchDb(rows, updated),
      claimPushWatch: async (token) => {
        claims.push(token);
        await new Promise((r) => setTimeout(r, 700));
        return true;
      },
    };
    const pw = new PushWatcher(
      db, watchBot, null, loadConfig({}),
      async (addrs) => new Map(addrs.map((a) => [a, watchPair(a)])),
      null,
    );
    // 1500ms budget: row 1 burns ~700ms, leaving 800ms — under the 900ms row
    // reserve, so row 2 must not start.
    const out = await pw.runTick(Date.now() + 1_500);
    assert.equal(out.checked, 1, "only the row whose cost fits is started");
    assert.deepEqual(claims, ["AAA"], "the second row waits for the next tick");
    assert.match(String(out.note), /budget-cut/);
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

  await test("WalletAnalyzer: deadline clamps the profiling budget (dead-tick regression)", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const config = loadConfig({});
      const slowHelius = {
        // Each profile call takes ~150ms (simulating the throttle-paced RPC
        // walk that produced the 2026-09-13 dead ticks when unclamped).
        getWalletProfile: async () => {
          await new Promise((r) => setTimeout(r, 150));
          return { firstTxMs: 1_800_000_000_000, txCount: 1, capped: false, createCount: 0 };
        },
      };
      const crime = {
        hit: false, creatorHit: false, holderHits: [], checkedHolders: 0,
        loaded: true,
        holders: Array.from({ length: 12 }, (_, i) => ({
          address: `a${i}`, owner: `WALLET${i}`, rank: i + 1, uiAmount: 1,
        })),
      };
      const analyzer = new WalletAnalyzer(config, db, slowHelius);
      const startedAt = Date.now();
      // Deadline = now + 500ms: far less than the 8s configured budget. The
      // clamp must cut the walk to ~3 wallets instead of running all 12
      // (1.8s unclamped), so the host tick keeps flush margin.
      const r = await analyzer.analyze({
        token: "TDL",
        creator: null,
        holders: crime.holders,
        crime,
        deadline: Date.now() + 500,
      });
      const elapsed = Date.now() - startedAt;
      assert.equal(r.truncated, true, "clamped walk must report truncation");
      assert.ok(elapsed < 1500, `clamped walk took ${elapsed}ms - must stop near the deadline`);
      // Sanity: the walk actually profiled someone before the clamp cut it.
      assert.ok(r.holders.checked >= 1, "clamp must not skip profiling entirely");
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

    // Streak 4+ stays silent while inside the pace window — one card per hour.
    const firedAt = 3600_000 + 120_000;
    const r4 = evaluateWatch(
      row({ sellDomStreak: 3, lastAlertAt: firedAt }),
      firedAt + 60_000,
      live(),
      cfg,
    );
    assert.equal(r4.alerts.length, 0);
    assert.equal(r4.sellDomStreak, 4);

    // Paced episodes are deferred, not dropped: streak keeps counting, and
    // once the pace window opens the next sell-dominant check delivers.
    const r5 = evaluateWatch(
      row({ sellDomStreak: 4, lastAlertAt: firedAt }),
      firedAt + 3_600_000,
      live(),
      cfg,
    );
    assert.equal(r5.alerts.length, 1);
    assert.equal(r5.alerts[0].kind, "sell-pressure");

    // Rapid re-arm (streak reset by a single buy tick, then back to 3) is
    // still paced: no second near-identical card within the window.
    const r6 = evaluateWatch(
      row({ sellDomStreak: 2, lastAlertAt: firedAt }),
      firedAt + 10 * 60_000,
      live(),
      cfg,
    );
    assert.equal(r6.alerts.length, 0);
    assert.equal(r6.sellDomStreak, 3);
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

  await test("push delivery audit ring records message_id and caps at 30", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // Two deliveries recorded like sendTo does after sendMessage succeeds.
      await db.recordPushDelivery({ chatId: "c1", token: "XSTMINT", symbol: "XST", messageId: 111, mcapAtPush: 153000 });
      await db.recordPushDelivery({ chatId: "c1", token: "GLITCHMINT", symbol: "GLITCH", messageId: 222, mcapAtPush: 194242 });
      let audit = await db.getPushAudit();
      assert.equal(audit.length, 2);
      assert.equal(audit[0].messageId, 111);
      assert.equal(audit[1].messageId, 222);
      assert.equal(audit[1].symbol, "GLITCH");
      // Ring cap: oldest entries fall off, newest survive.
      for (let i = 0; i < 35; i++) {
        await db.recordPushDelivery({ chatId: "c1", token: `M${i}`, symbol: null, messageId: i });
      }
      audit = await db.getPushAudit();
      assert.equal(audit.length, 30);
      assert.equal(audit[audit.length - 1].token, "M34");
      assert.ok(!audit.some((r) => r.token === "XSTMINT"), "oldest entry evicted");
    } finally { t.cleanup(); }
  });

  await test("evaluateWatch: divergence fires once per activation, re-arms on recovery", async () => {
    const mkRow = (over) => ({
      token: "T", chatId: "c", symbol: "JEFFERY", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 70_000, lastLiquidity: 20_000,
      deadTroughMcap: null, holdersCheckedAt: null,
      holdersAtPush: 1000, holdersLast: 850,
      lastChecked: 0, lastAlertAt: -3600_000, followupsSent: 0,
      lastState: null, sellDomStreak: 0, lastMcap: null,
      lastVol5m: null, upStages: null,
      ...over,
    });
    const cfg = { cooldownMs: 0 };
    // +30% price on a -15% holder base (the JEFFERY shape).
    const live = () => ({ mcap: 65_000, liquidity: 19_000, chg5m: 3, vol5m: 5_000, buysH1: 90, sellsH1: 80 });

    // Fires once and persists the div mark.
    const d1 = evaluateWatch(mkRow(), 1000, live(), cfg);
    const div1 = d1.alerts.find((a) => a.kind === "divergence");
    assert.ok(div1 && /⚡ 籌碼集中/.test(div1.text));
    assert.ok(d1.announcedUpStages?.includes("div"));

    // A 📈/🚀 wiping lastState must NOT re-fire it.
    const d2 = evaluateWatch(
      mkRow({ upStages: d1.announcedUpStages, lastState: "hold" }),
      2000, live(), cfg,
    );
    assert.ok(!d2.alerts.some((a) => a.kind === "divergence"), "same activation must not re-fire");

    // Holders stop shrinking → mark clears…
    const rec = evaluateWatch(
      mkRow({ upStages: d1.announcedUpStages, lastState: null }),
      3000, { ...live(), mcap: 65_000 }, cfg,
    );
    assert.ok(!rec.announcedUpStages?.includes("div"));

    // …and a fresh shrinkage re-arms the signal.
    const d3 = evaluateWatch(
      mkRow({ upStages: rec.announcedUpStages ?? undefined, lastState: null }),
      4000, live(), cfg,
    );
    assert.equal(d3.alerts.filter((a) => a.kind === "divergence").length, 1);

    // Below thresholds: +20% gain → silent even with shrinking holders.
    const quiet = evaluateWatch(
      mkRow(), 5000, { ...live(), mcap: 60_000 }, cfg,
    );
    assert.ok(!quiet.alerts.some((a) => a.kind === "divergence"));
  });

  await test("evaluateWatch: weak depth memory survives state wipes; escalates once; re-arms on recovery", async () => {
    const mkRow = (over) => ({
      token: "T", chatId: "c", symbol: "BABYCATE", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 90_000, lastLiquidity: 20_000,
      deadTroughMcap: null, holdersCheckedAt: null,
      holdersAtPush: null, holdersLast: null,
      lastChecked: 0, lastAlertAt: -3600_000, followupsSent: 0,
      lastState: null, sellDomStreak: 0, lastMcap: null,
      lastVol5m: null, upStages: "up100,up50",
      ...over,
    });
    const cfg = { cooldownMs: 0 };
    const live = (mcap) => ({ mcap, liquidity: 19_000, chg5m: -5, vol5m: 5_000, buysH1: 40, sellsH1: 90 });

    // First weak at -37% fires and persists the w35 mark.
    const w1 = evaluateWatch(mkRow(), 1000, live(56_700), cfg);
    assert.equal(w1.alerts.filter((a) => a.kind === "weak").length, 1);
    assert.ok(w1.announcedUpStages?.includes("w35"));

    // The BABYCATE bug: a 📈 wiped lastState ("hold") one cooldown later,
    // drawdown barely deeper (-39%) — must stay SILENT now.
    const w2 = evaluateWatch(
      mkRow({ upStages: w1.announcedUpStages, lastState: "hold" }),
      2000, live(54_900), cfg,
    );
    assert.ok(!w2.alerts.some((a) => a.kind === "weak"), "same depth must not re-fire");

    // Escalation past -45% fires exactly once more (w45).
    const w3 = evaluateWatch(
      mkRow({ upStages: w1.announcedUpStages, lastState: "weak" }),
      3000, live(48_600), cfg,
    );
    assert.equal(w3.alerts.filter((a) => a.kind === "weak").length, 1);
    assert.ok(w3.announcedUpStages?.includes("w45"));

    // Real recovery above -25% clears the marks…
    const rec = evaluateWatch(
      mkRow({ upStages: w3.announcedUpStages, lastState: "hold" }),
      4000, live(80_000), cfg,
    );
    assert.ok(!rec.announcedUpStages?.includes("w35"));
    // …so a re-deepening leg warns again.
    const w4 = evaluateWatch(
      mkRow({ upStages: rec.announcedUpStages, lastState: "hold" }),
      5000, live(56_700), cfg,
    );
    assert.equal(w4.alerts.filter((a) => a.kind === "weak").length, 1);
  });

  await test("hasInitialPushAudit: only initial-kind entries qualify for the token", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      // Followups and resends do NOT prove the first card was delivered.
      await db.recordPushDelivery({ chatId: "c1", token: "HM1", symbol: "H", messageId: 1, kind: "followup" });
      assert.equal(await db.hasInitialPushAudit("HM1"), false);
      // An initial entry does — even with other tokens interleaved.
      await db.recordPushDelivery({ chatId: "c1", token: "HM2", symbol: "G", messageId: 2, kind: "initial" });
      await db.recordPushDelivery({ chatId: "c1", token: "HM1", symbol: "H", messageId: 3, kind: "resend" });
      assert.equal(await db.hasInitialPushAudit("HM2"), true);
      assert.equal(await db.hasInitialPushAudit("HM1"), false);
      assert.equal(await db.hasInitialPushAudit("UNKNOWN"), false);
    } finally { t.cleanup(); }
  });

  await test("evaluateWatch: up-stage memory survives weak wipes; card names next milestone", async () => {
    // Helpers mirror the holder-baseline test above.
    const mkRow = (over) => ({
      token: "T", chatId: "c", symbol: "JEFFERY", pushedAt: 0,
      mcapAtPush: 50_000, peakMcap: 60_000, lastLiquidity: 12_000,
      deadTroughMcap: null, holdersCheckedAt: null,
      holdersAtPush: null, holdersLast: null,
      lastChecked: 0, lastAlertAt: -3600_000, followupsSent: 0,
      lastState: null, sellDomStreak: 0, lastMcap: null,
      lastVol5m: null, upStages: null,
      ...over,
    });
    const cfg = { cooldownMs: 1800_000 };
    const live = () => ({ mcap: 105_000, liquidity: 19_000, chg5m: 2, vol5m: 5_000, buysH1: 90, sellsH1: 80 });

    // The reported bug: ⚠️ wiped lastState ("weak") while up100 had already
    // been announced — the old code re-fired 🚀 up100 (third card in 1h).
    const e1 = evaluateWatch(mkRow({ upStages: "up100,up50", lastState: "weak" }), 1000, live(), cfg);
    assert.ok(!e1.alerts.some((a) => a.kind === "rising"), "same stage must not re-fire");

    // A genuinely new milestone fires ONCE and carries forward-looking info.
    const e2 = evaluateWatch(
      mkRow({ mcapAtPush: 50_000, upStages: "up100,up50", lastState: "up100" }),
      1000, { ...live(), mcap: 155_000 }, cfg, // +210% crosses the 200 stage
    );
    const rising = e2.alerts.find((a) => a.kind === "rising");
    assert.ok(rising, "new stage up200 fires");
    assert.match(rising.text, /下一關 \+400%/);
    assert.equal(e2.announcedUpStages, "up100,up200,up50");

    // Legacy rows recover their memory from lastState. A lower un-announced
    // stage may fire ONCE during migration (up50 never announced), then the
    // full set persists so it can never repeat.
    const e3 = evaluateWatch(mkRow({ lastState: "up100", upStages: null }), 1000, live(), cfg);
    const mig = e3.alerts.find((a) => a.kind === "rising");
    assert.ok(mig, "one-time backfill of the unannounced up50 stage");
    assert.match(mig.text, /下一關 \+100%/);
    assert.equal(e3.announcedUpStages, "up100,up50");
    const e3b = evaluateWatch(
      mkRow({ lastState: "up100", upStages: e3.announcedUpStages }),
      1000 + 1900_000, live(), cfg,
    );
    assert.ok(!e3b.alerts.some((a) => a.kind === "rising"), "memory now complete — silent");

    // Top stage reached: card says so, nothing left to announce.
    const e4 = evaluateWatch(
      mkRow({ upStages: "up200,up50,up100", lastState: "up200" }),
      1000, { ...live(), mcap: 260_000 }, cfg,
    );
    const top = e4.alerts.find((a) => a.kind === "rising");
    assert.ok(top && /已達最高里程碑/.test(top.text));
    assert.equal(e4.announcedUpStages, "up100,up200,up400,up50");
  });

  await test("updatePushWatchCheck: rolling holder baseline overwrites and preserves", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      await db.upsertPushWatch({ token: "ROLLMINT", chatId: "c1", symbol: "ROLL", pushedAt: Date.now(), mcapAtPush: 100000, liquidityUsd: 20000 });
      // 📈 fired: baseline rolls forward to holdersLast (the BABYCATE fix —
      // this write was previously missing from the delivered-alert branch).
      await db.updatePushWatchCheck("ROLLMINT", {
        peakMcap: 100000, lastLiquidity: 20000, followupsSent: 1,
        lastState: "hold", lastAlertAt: Date.now(), mcapAtPush: null,
        holdersAtPush: 2441, sellDomStreak: 0, lastMcap: 99000,
      });
      let row = (await db.listPushWatch(5)).find((r) => r.token === "ROLLMINT");
      assert.equal(row.holdersAtPush, 2441, "baseline must roll forward");
      // No 📈 this tick: undefined → COALESCE keeps the rolled baseline.
      await db.updatePushWatchCheck("ROLLMINT", {
        peakMcap: 101000, lastLiquidity: 20000, followupsSent: 1,
        lastState: "up50", lastAlertAt: Date.now(), mcapAtPush: null,
        holdersAtPush: null, sellDomStreak: 0, lastMcap: 99500, // no 📈 this tick
      });
      row = (await db.listPushWatch(5)).find((r) => r.token === "ROLLMINT");
      assert.equal(row.holdersAtPush, 2441, "baseline must survive non-holder ticks");
    } finally { t.cleanup(); }
  });

  await test("listPushWatch: active rows claim slots before terminal tombstones", async () => {
    const t = tmpDb();
    try {
      const db = new Db(t.p, undefined, t.client);
      await db.init();
      const now = Date.now();
      // 25 NEWER rug tombstones + 10 OLDER active rows: the old LIMIT by
      // pushed_at alone would evict the actives; ordering must protect them.
      for (let i = 0; i < 25; i++) {
        await db.upsertPushWatch({ token: `RUG${i}`, chatId: "c1", symbol: `R${i}`, pushedAt: now - i * 1000, mcapAtPush: 100000, liquidityUsd: 20000 });
        await db.setPushWatchState(`RUG${i}`, "rug");
      }
      for (let i = 0; i < 10; i++) {
        await db.upsertPushWatch({ token: `ACT${i}`, chatId: "c1", symbol: `A${i}`, pushedAt: now - 60_000 - i * 1000, mcapAtPush: 100000, liquidityUsd: 20000 });
      }
      const rows = await db.listPushWatch(30);
      const missingActive = [];
      for (let i = 0; i < 10; i++) if (!rows.some((r) => r.token === `ACT${i}`)) missingActive.push(`ACT${i}`);
      assert.equal(missingActive.length, 0, `active rows evicted: ${missingActive.join(",")}`);
      // Tombstones fill only the leftover slots (20 of the 25 newest).
      assert.equal(rows.filter((r) => r.lastState === "rug").length, 20);
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

  await test("top10MinBlockReason: cartel-locked shape blocked above pctMax", () => {
    // Cartel holding >90% of supply -> retail only provides exit liquidity.
    assert.match(
      top10MinBlockReason(95.5, 10, 90),
      /95\.5% > 90%/,
    );
    assert.match(top10MinBlockReason(90.1, 10, 90), /90\.1%/);
    // Exactly at the line passes (strict >).
    assert.equal(top10MinBlockReason(90.0, 10, 90), null);
    // Healthy band between the two lines passes.
    assert.equal(top10MinBlockReason(50, 10, 90), null);
    // pctMax 0 disables only the ceiling side; floor still active.
    assert.equal(top10MinBlockReason(95.5, 10, 0), null);
    // Missing data never judges even with both bounds set.
    assert.equal(top10MinBlockReason(null, 10, 90), null);
  });

  // ---------- Flurry launch forensics (deploy-slot bundle + lineage) ----------

  await test("deriveBondingCurvePda: matches the live create_v2 vector", () => {
    assert.equal(
      deriveBondingCurvePda("9dtmpyqK6gokJLVWrqPnhw6bq1kXGDJsuCoMtWQUpump"),
      "Dan7TVQLS8qS2BBt5z5bm7r9FKf149Xs33XACfUP6UPX",
    );
  });

  await test("detectBundle: 4+ wallets with 15%+ supply in the deploy slot is a bundle", () => {
    const slot = 300_000_000;
    const activity = [1, 2, 3, 4].map((i) => ({
      wallet: `Buyer${i}`,
      slot,
      supplyPct: 5,
    }));
    const report = detectBundle(slot, activity);
    assert.equal(report.bundled, true);
    assert.equal(report.deploySlotWallets, 4);
    assert.equal(report.deploySlotSupplyPct, 20);
  });

  await test("detectBundle: 3 wallets or <15% supply passes; thresholds tunable", () => {
    const slot = 300_000_000;
    // 3 wallets even at high supply → not a bundle (default floor is 4).
    assert.equal(
      detectBundle(slot, [1, 2, 3].map((i) => ({ wallet: `B${i}`, slot, supplyPct: 10 }))).bundled,
      false,
    );
    // 4 wallets but only 10% supply → not a bundle.
    assert.equal(
      detectBundle(slot, [1, 2, 3, 4].map((i) => ({ wallet: `B${i}`, slot, supplyPct: 2.5 }))).bundled,
      false,
    );
    // Outside-slot buys never count toward the bundle.
    const outside = [1, 2, 3, 4].map((i) => ({ wallet: `B${i}`, slot: slot + 1, supplyPct: 6 }));
    assert.equal(detectBundle(slot, outside).bundled, false);
    // Stricter operator thresholds apply.
    assert.equal(
      detectBundle(slot, [1, 2, 3, 4].map((i) => ({ wallet: `B${i}`, slot, supplyPct: 5 })), {
        minWallets: 6,
        minSupplyPct: 30,
      }).bundled,
      false,
    );
  });

  await test("slotActivityFromTransaction: balance deltas → supply pct, sellers/errors excluded", () => {
    const total = 1_000_000_000n; // 1e9 raw base units (6 decimals, display 1000)
    const mint = "MINT";
    const tx = {
      slot: 42,
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 0, mint, uiTokenAmount: { amount: "0" } },
          { accountIndex: 1, mint, uiTokenAmount: { amount: "100000000" } },
        ],
        postTokenBalances: [
          { accountIndex: 0, mint, owner: "BuyerA", uiTokenAmount: { amount: "50000000" } },
          { accountIndex: 1, mint, owner: "SellerB", uiTokenAmount: { amount: "20000000" } },
        ],
      },
    };
    const activity = slotActivityFromTransaction(tx, mint, total);
    // BuyerA acquired 5% of supply; SellerB's delta is negative → excluded.
    assert.equal(activity.length, 1);
    assert.equal(activity[0].wallet, "BuyerA");
    assert.equal(activity[0].supplyPct, 5);
    // Errored transactions yield nothing.
    assert.deepEqual(
      slotActivityFromTransaction({ ...tx, meta: { ...tx.meta, err: "InstructionError" } }, mint, total),
      [],
    );
  });

  await test("clusterByFunding / linkedWalletCount: shared funder detected, none = clean", () => {
    const activity = [
      { wallet: "W1", slot: 1, supplyPct: 5, fundedBy: "FunderA" },
      { wallet: "W2", slot: 1, supplyPct: 5, fundedBy: "FunderA" },
      { wallet: "W3", slot: 1, supplyPct: 5, fundedBy: "FunderA" },
      { wallet: "W4", slot: 1, supplyPct: 5, fundedBy: "FunderB" },
      { wallet: "W5", slot: 1, supplyPct: 5 },
    ];
    const clusters = clusterByFunding(activity);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].funder, "FunderA");
    assert.deepEqual(clusters[0].wallets, ["W1", "W2", "W3"]);
    assert.equal(linkedWalletCount(clusters), 3);
    // No shared funding → no clusters.
    assert.deepEqual(clusterByFunding([{ wallet: "X", slot: 1, supplyPct: 5 }]), []);
    assert.equal(linkedWalletCount([]), 0);
  });

  await test("scoreRisk: bundling dominates the tier; clean deploys stay low", () => {
    assert.equal(scoreRisk({ bundled: true, firstBlockSupplyPct: 40, linkedWallets: 8, deployerPriorRugs: 0, devHoldsPct: 0 }).tier, "CRITICAL");
    assert.equal(scoreRisk({ bundled: true, firstBlockSupplyPct: 20, linkedWallets: 3, deployerPriorRugs: 0, devHoldsPct: 0 }).tier, "HIGH");
    assert.equal(scoreRisk({ bundled: false, firstBlockSupplyPct: 25, linkedWallets: 6, deployerPriorRugs: 0, devHoldsPct: 0 }).tier, "MODERATE");
    assert.equal(scoreRisk({ bundled: false, firstBlockSupplyPct: 5, linkedWallets: 0, deployerPriorRugs: 0, devHoldsPct: 0 }).tier, "LOW");
  });

  await test("flurryBlockReason: bundled report blocks, clean/null pass (fail-open)", () => {
    assert.match(
      flurryBlockReason({ bundled: true, deploySlotWallets: 6, deploySlotSupplyPct: 31.5, linkedWallets: 4, clusterSize: 4, score: 7, tier: "CRITICAL" }),
      /6個錢包在創建同一slot買入 31\.5%供應/,
    );
    assert.match(
      flurryBlockReason({ bundled: true, deploySlotWallets: 6, deploySlotSupplyPct: 31.5, linkedWallets: 4, clusterSize: 4, score: 7, tier: "CRITICAL" }),
      /同資金來源/,
    );
    assert.equal(
      flurryBlockReason({ bundled: false, deploySlotWallets: 2, deploySlotSupplyPct: 8, linkedWallets: 0, clusterSize: 0, score: 0, tier: "LOW" }),
      null,
    );
    // Fail-open: no report (non-pump mint / RPC error / budget) never judges.
    assert.equal(flurryBlockReason(null), null);
  });

  await test("findFundedBy: inbound SOL matched to a funder; no funding → null", async () => {
    const transport = {
      async getSignatures(address) {
        if (address === "Buyer") {
          return [
            { signature: "sig-buy", err: null },
            { signature: "sig-fund", err: null },
          ];
        }
        return [];
      },
      async getParsedTransaction(sig) {
        if (sig === "sig-buy") {
          return {
            slot: 10,
            meta: {
              err: null,
              preBalances: [1000000, 50000000, 0],
              postBalances: [900000, 49999000, 1000000],
            },
            transaction: { message: { accountKeys: ["Buyer", "Other", "Funder"] } },
          };
        }
        if (sig === "sig-fund") {
          return {
            slot: 5,
            meta: {
              err: null,
              preBalances: [0, 1000000, 50000000],
              postBalances: [1000000, 999900, 49000000],
            },
            transaction: { message: { accountKeys: ["Buyer", "Mint", "Funder"] } },
          };
        }
        return null;
      },
    };
    // sig-fund: Buyer received 1 SOL from Funder (their balance dropped by the
    // same amount) — newest-first scan finds it on the first tx it checks.
    assert.equal(await findFundedBy(transport, "Buyer"), "Funder");
    // A wallet with no inbound transfers resolves to null.
    assert.equal(await findFundedBy(transport, "NoHistory"), null);
  });

  await test("FlurryAnalyzer: bundled launch detected end-to-end, verdict cached (0 repeat RPC)", async () => {
    const mint = "9dtmpyqK6gokJLVWrqPnhw6bq1kXGDJsuCoMtWQUpump";
    const deploySlot = 500;
    const fakeHelius = {
      rpcCount: 0,
      async getSignatures(address, limit) {
        this.rpcCount++;
        return [1, 2, 3, 4].map((i) => ({
          signature: `sig-${i}`,
          slot: deploySlot,
          err: null,
        }));
      },
      async getParsedTransaction(sig) {
        this.rpcCount++;
        return {
          slot: deploySlot,
          meta: {
            err: null,
            preBalances: [0, 1000000],
            postBalances: [1000000, 0],
            preTokenBalances: [
              { accountIndex: 0, mint, uiTokenAmount: { amount: "0" } },
            ],
            postTokenBalances: [
              {
                accountIndex: 0,
                mint,
                owner: `Wallet${sig}`,
                uiTokenAmount: { amount: "50000000" },
              },
            ],
          },
          transaction: { message: { accountKeys: [`Wallet${sig}`, "FunderX"] } },
        };
      },
      async getTokenSupply() {
        this.rpcCount++;
        return { value: { amount: "1000000000" } }; // 1e9 raw
      },
    };
    const analyzer = new FlurryAnalyzer(loadConfig({}), fakeHelius);
    const first = await analyzer.analyze(mint, Date.now() + 60_000);
    assert.equal(first.status, "report");
    if (first.status === "report") {
      assert.equal(first.report.bundled, true);
      assert.equal(first.report.deploySlotWallets, 4);
      assert.equal(first.report.deploySlotSupplyPct, 20);
      // 4 distinct wallets, each funded from the same tx pattern → one cluster
      // of 4, all sharing the fake "Funder" from the parsed tx.
      assert.equal(first.report.linkedWallets, 4);
      assert.equal(first.report.clusterSize, 4);
    }
    const callsAfterFirst = fakeHelius.rpcCount;
    // Second call within the TTL is served from cache — zero new RPC.
    const second = await analyzer.analyze(mint, Date.now() + 60_000);
    assert.equal(second.status, "report");
    assert.equal(fakeHelius.rpcCount, callsAfterFirst);
    const stats = analyzer.stats();
    assert.equal(stats.cacheHits, 1);
    assert.ok(stats.rpcCalls >= 1);
  });

  await test("FlurryAnalyzer: non-pump mint fail-opens and negative-caches", async () => {
    const mint = "9dtmpyqK6gokJLVWrqPnhw6bq1kXGDJsuCoMtWQUpump";
    const fakeHelius = {
      rpcCount: 0,
      async getSignatures() {
        this.rpcCount++;
        return []; // no curve history → not a pump.fun launch
      },
      async getParsedTransaction() {
        return null;
      },
      async getTokenSupply() {
        return null;
      },
    };
    const analyzer = new FlurryAnalyzer(loadConfig({}), fakeHelius);
    assert.equal((await analyzer.analyze(mint, Date.now() + 60_000)).status, "skip");
    const calls = fakeHelius.rpcCount;
    // Negative cache: the second sweep costs 0 RPC too.
    assert.equal((await analyzer.analyze(mint, Date.now() + 60_000)).status, "skip");
    assert.equal(fakeHelius.rpcCount, calls);
  });

  await test("FlurryAnalyzer: disabled config skips without touching the RPC", async () => {
    const fakeHelius = {
      rpcCount: 0,
      async getSignatures() {
        this.rpcCount++;
        return [{ signature: "s", slot: 1, err: null }];
      },
      async getParsedTransaction() {
        return null;
      },
      async getTokenSupply() {
        return null;
      },
    };
    const analyzer = new FlurryAnalyzer(
      loadConfig({ FLURRY_ENABLED: "0" }),
      fakeHelius,
    );
    assert.equal((await analyzer.analyze("9dtmpyqK6gokJLVWrqPnhw6bq1kXGDJsuCoMtWQUpump", Date.now() + 60_000)).status, "skip");
    assert.equal(fakeHelius.rpcCount, 0);
  });

  await test("FlurryAnalyzer: short remainder (~3s) still RUNS - the old full-budget guard deferred on every tick (silently disabled)", async () => {
    const mint = "9dtmpyqK6gokJLVWrqPnhw6bq1kXGDJsuCoMtWQUpump";
    const fakeHelius = {
      rpcCount: 0,
      async getSignatures() {
        this.rpcCount++;
        return [
          { signature: "sig-a", slot: 500, err: null },
          { signature: "sig-b", slot: 500, err: null },
          { signature: "sig-c", slot: 500, err: null },
          { signature: "sig-d", slot: 500, err: null },
        ];
      },
      async getParsedTransaction(sig) {
        this.rpcCount++;
        return {
          slot: 500,
          meta: {
            err: null,
            preBalances: [0, 1000000],
            postBalances: [1000000, 0],
            preTokenBalances: [
              { accountIndex: 0, mint, uiTokenAmount: { amount: "0" } },
            ],
            postTokenBalances: [
              {
                accountIndex: 0,
                mint,
                owner: `Wallet${sig}`,
                uiTokenAmount: { amount: "50000000" },
              },
            ],
          },
          transaction: { message: { accountKeys: [`Wallet${sig}`, "FunderX"] } },
        };
      },
      async getTokenSupply() {
        this.rpcCount++;
        return { value: { amount: "1000000000" } };
      },
    };
    const analyzer = new FlurryAnalyzer(loadConfig({ FLURRY_BUDGET_MS: "8000" }), fakeHelius);
    // Simulates the real candidate-phase shape: only ~3s left on the tick
    // deadline. The old guard required the whole 8s budget -> always skip.
    const out = await analyzer.analyze(mint, Date.now() + 3_000);
    assert.equal(out.status, "report", "short-remainder analysis must run, not defer");
    if (out.status === "report") assert.equal(out.report.bundled, true);
  });

  await test("FlurryAnalyzer: near-zero remainder still defers (fail-open floor)", async () => {
    const fakeHelius = {
      rpcCount: 0,
      async getSignatures() {
        this.rpcCount++;
        return [];
      },
      async getParsedTransaction() {
        return null;
      },
      async getTokenSupply() {
        return null;
      },
    };
    const analyzer = new FlurryAnalyzer(loadConfig({ FLURRY_BUDGET_MS: "8000" }), fakeHelius);
    const out = await analyzer.analyze("9dtmpyqK6gokJLVWrqPnhw6bq1kXGDJsuCoMtWQUpump", Date.now() + 500);
    assert.equal(out.status, "skip");
    assert.equal(fakeHelius.rpcCount, 0, "floor below 2.5s must not start any RPC");
  });

  await test("FlurryAnalyzer: clamp to the tick deadline defers WITHOUT negative-caching (retry next tick)", async () => {
    const mint = "9dtmpyqK6gokJLVWrqPnhw6bq1kXGDJsuCoMtWQUpump";
    let release;
    const gate = new Promise((r) => (release = r));
    const fakeHelius = {
      rpcCount: 0,
      async getSignatures() {
        this.rpcCount++;
        await gate; // hangs past the clamped hard deadline
        return [];
      },
      async getParsedTransaction() {
        return null;
      },
      async getTokenSupply() {
        return null;
      },
    };
    const analyzer = new FlurryAnalyzer(loadConfig({ FLURRY_BUDGET_MS: "8000" }), fakeHelius);
    const deadline = Date.now() + 3_000; // clamp target
    const p = analyzer.analyze(mint, deadline);
    setTimeout(release, 3_500); // unblock the mock only after the clamp fired
    const out = await p;
    assert.equal(out.status, "skip");
    // The clamp trip must NOT poison the cache - prove by retrying with a
    // fresh deadline: it must re-issue RPC (no negative-cache skip).
    const retry = await analyzer.analyze(mint, Date.now() + 60_000);
    assert.equal(retry.status, "skip", "non-pump empty history -> skip verdict");
    assert.ok(fakeHelius.rpcCount >= 2, "retry must re-issue RPC (no negative cache) - got " + fakeHelius.rpcCount);
  });

  await test("loadConfig: flurry defaults and env overrides", () => {
    const def = loadConfig({}).flurry;
    assert.equal(def.enabled, true);
    assert.equal(def.blockBundles, true);
    assert.equal(def.minWallets, 4);
    assert.equal(def.minSupplyPct, 15);
    assert.equal(def.maxWallets, 12);
    assert.equal(def.cacheMs, 30 * 60_000);
    assert.equal(def.budgetMs, 15_000);
    const over = loadConfig({
      FLURRY_ENABLED: "false",
      FLURRY_BLOCK_BUNDLES: "false",
      FLURRY_MIN_WALLETS: "6",
      FLURRY_MIN_SUPPLY_PCT: "30",
      FLURRY_MAX_WALLETS: "20",
      FLURRY_CACHE_MS: "120000",
      FLURRY_BUDGET_MS: "8000",
    }).flurry;
    assert.equal(over.enabled, false);
    assert.equal(over.blockBundles, false);
    assert.equal(over.minWallets, 6);
    assert.equal(over.minSupplyPct, 30);
    assert.equal(over.maxWallets, 20);
    assert.equal(over.cacheMs, 120_000);
    assert.equal(over.budgetMs, 8_000);
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
