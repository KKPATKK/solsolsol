#!/usr/bin/env node
/**
 * The no-cut-mark half of the cut-card dedupe (2026-09-24).
 *
 * The engine rule itself (proofIsCurrent + the `dedupedAt` field on WatchAlert)
 * and its doc comments were applied through the file tool; this script carries
 * the two pieces that live past that tool's window — the row loop in
 * src/pushwatch.ts (~line 2900) and the tests in scripts/test-unit.js (~10k
 * lines) — so the whole change is reproducible in one place.
 *
 * WHY THE LOOP HALF MATTERS: suppressing a card the chat already has only holds
 * if the decision outlives a rollback. A pass that holds a row back writes the
 * PRE-pass marks plus one mark per attempted card (`addCutMarks`), NOT the
 * engine's CSV — so a suppressed card with no mark to carry would be re-derived
 * next pass, and once the proof left its window it would be SENT: the duplicate,
 * just later. `dedupedAt` is what the loop carries for that card.
 *
 * Same discipline as every other record script here: verify each anchor matches
 * EXACTLY ONCE, write nothing unless all do, stay re-runnable.
 *
 * Run: node docs/patches/cut-card-proof-no-mark.apply.js
 */
const fs = require("fs");
const path = require("path");

const lines = (...xs) => xs.join("\n");

// ------------------------------------------------------------ pushwatch.ts ---
const PW = path.join(__dirname, "..", "..", "src", "pushwatch.ts");
const PW_ANCHOR = lines(
  "          // Carry the proof's mark forward unchanged (see `attempts`): the",
  "          // rollback below re-derives this transition, and only the",
  "          // mark-plus-proof pair keeps it from being announced again.",
  "          const prior = priorMarks.get(a.sig);",
  "          if (prior !== undefined) attempts.push({ sig: a.sig, at: prior });",
  "          continue;",
);
const PW_NEXT = lines(
  "          // Carry the proof's mark forward unchanged (see `attempts`): the",
  "          // rollback below re-derives this transition, and only the",
  "          // mark-plus-proof pair keeps it from being announced again.",
  "          //",
  "          // A card the NO-MARK rule suppressed has no carried mark to reuse, so",
  "          // the proof's own stamp becomes one (`dedupedAt`): that is the write",
  "          // the marks back half of that rule, and it is what makes the",
  "          // suppression survive a rollback instead of decaying into a late",
  "          // duplicate once the proof leaves its window.",
  "          const carryAt = priorMarks.get(a.sig) ?? a.dedupedAt;",
  "          if (carryAt !== undefined) attempts.push({ sig: a.sig, at: carryAt });",
  "          continue;",
);

// ----------------------------------------------------------- test-unit.js ----
const TESTS = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
const TEST_ANCHOR = lines(
  '      "only the card that never landed is re-sent",',
  "    );",
  "  });",
  "",
);

// No backticks and no ${ } in this block on purpose: it is spliced in as one
// template literal below.
const TEST_CODE = `
  await test("evaluateWatch: with NO cut mark, a proof from the row's OWN check still refuses the duplicate", () => {
    // The mark is written by the pass that ATTEMPTED the send, so a pass that
    // died before its write (a rollback, a killed isolate) leaves a delivered
    // card unmarked — and the next evaluation re-derives it and sends it. The
    // audit entry dates the delivery, so it answers the same question the mark
    // does, but only about THIS check: a re-armed row's older delivery must
    // never silence a genuinely new card.
    const at = 1_800_000_000_000; // an exact minute boundary: the buckets are clean
    const row = (over = {}) => ({
      token: "T", chatId: "c", symbol: "REK", pushedAt: 0,
      mcapAtPush: 170_000, peakMcap: 240_000, lastLiquidity: 32_000,
      deadTroughMcap: null, holdersAtPush: null, holdersLast: null,
      holdersCheckedAt: null, lastChecked: at, lastAlertAt: 0,
      followupsSent: 0, lastState: null, upStages: null,
      ...over,
    });
    const live = { mcap: 59_000, liquidity: 32_000, chg5m: -2, buysH1: 120, sellsH1: 180 };
    const cfg = { cooldownMs: 30 * 60_000 };
    const cfgProven = (proofAt, key = cardProofKey("T", "dead")) => ({
      ...cfg,
      followupProofAt: new Map([[key, proofAt]]),
    });

    // A proof inside the row's OWN check bucket: announced, not sent, and it
    // carries the proof's stamp so the caller can write the mark back.
    const same = evaluateWatch(row(), at + 60_000, live, cfgProven(at + 30_000));
    assert.equal(same.alerts.length, 1);
    assert.equal(same.alerts[0].sig, "dead");
    assert.equal(same.alerts[0].deduped, true, "the card the chat already has is not sent again");
    assert.equal(same.alerts[0].dedupedAt, at + 30_000, "and it carries the proof's own stamp");
    assert.equal(same.lastState, "dead", "the transition lands instead of being re-derived");

    // The NEXT bucket counts too: a pass that claimed at :59 delivers at :00.
    assert.equal(
      evaluateWatch(row(), at + 60_000, live, cfgProven(at + 90_000)).alerts[0].deduped,
      true,
      "the straddle is the same one-bucket slop the cut-mark rule allows",
    );

    // Older than that is NOT this check's evidence: a re-armed row announces the
    // same transition again, and an old delivery must not silence that card.
    assert.equal(
      evaluateWatch(row(), at + 60_000, live, cfgProven(at + 120_000)).alerts[0].deduped,
      undefined,
      "two buckets on belongs to an earlier check",
    );
    assert.equal(
      evaluateWatch(row(), at + 60_000, live, cfgProven(at - 60_000)).alerts[0].deduped,
      undefined,
      "and so does one from before it",
    );

    // The token-width fallback cannot NAME the card, so it cannot silence one:
    // with no mark to anchor the question, only the exact key counts here.
    assert.equal(
      evaluateWatch(row(), at + 60_000, live, cfgProven(at + 30_000, "T")).alerts[0].deduped,
      undefined,
      "a proof that cannot name the card proves nothing about it",
    );
    // A mark for a DIFFERENT transition is judged on its own sig, and one that
    // is not current does not defer this evaluation either.
    assert.equal(
      evaluateWatch(
        row({ upStages: cutMarkFor("up100", at - 300_000) }),
        at + 60_000,
        live,
        cfgProven(at + 30_000),
      ).alerts[0].deduped,
      true,
      "the dead card is judged on its own proof",
    );
    // Still never-miss: no proof at all and the card goes out.
    assert.equal(evaluateWatch(row(), at + 60_000, live, cfg).alerts[0].deduped, undefined);
  });

  await test("PushWatcher: a delivered card with NO mark is refused, and the rollback writes its mark back", async () => {
    // The end-to-end half: a delivered card whose mark never landed must not be
    // re-sent, AND the suppression has to leave a mark behind — otherwise the
    // next pass, with the proof outside its window, sends the very duplicate
    // the rule just prevented.
    const base = Date.now();
    const popeyeRow = (over = {}) =>
      termRow({
        peakMcap: 400_000, mcapAtPush: 100_000, upStages: null, lastLiquidity: 32_000,
        lastChecked: base, ...over,
      });
    const popeyePair = (token) => ({ ...termPair(token, 32_000), marketCap: 240_000 });
    const mkWatcher = (db, bot) =>
      new PushWatcher(db, bot, null, loadConfig({}), async (addrs) => new Map(addrs.map((a) => [a, popeyePair(a)])), null);

    // The row carries NO marks, but the audit proves the 🚀 card was already
    // delivered inside this very check (its mark write is what went missing),
    // and the ⚠️ sibling's send is REJECTED — so the row is rolled back.
    const db = termDb([popeyeRow()], {
      audit: [{ chatId: "c", token: "LOBBY", kind: "followup", sig: "up100", at: base + 1_000 }],
    });
    const texts1 = [];
    const out1 = await mkWatcher(db, {
      api: {
        sendMessage: async (_chat, text) => {
          texts1.push(text);
          if (text.includes("🚀")) return { message_id: 111 };
          throw new Error("400 Bad Request: chat not found");
        },
      },
    }).runTick(base + 1_500);
    assert.deepEqual(
      texts1.map((t) => (t.includes("🚀") ? "rising" : "weak")),
      ["weak"],
      "the proven 🚀 is not sent; only the card that never landed is",
    );
    assert.equal(out1.deduped, 1, "and the refusal is counted");
    assert.equal(out1.undelivered, 1, "the rejected sibling holds the row back");
    const [, w1] = db.updated[0];
    assert.equal(w1.lastState, null, "so the announcement is rolled back");
    assert.match(
      String(w1.upStages),
      /(^|,)p:up100:/,
      "the suppressed card leaves its mark behind: " + w1.upStages,
    );

    // Next pass: the row carries that mark, and the proof now sits TEN MINUTES
    // after the check it is measured against — outside the no-mark window — so
    // the mark is the only thing that can refuse the repeat. That is the whole
    // point of writing it back.
    const db2 = termDb(
      [popeyeRow({ upStages: w1.upStages, lastChecked: base - 10 * 60_000 })],
      { audit: [{ chatId: "c", token: "LOBBY", kind: "followup", sig: "up100", at: base + 1_000 }] },
    );
    const texts2 = [];
    const out2 = await mkWatcher(db2, {
      api: { sendMessage: async (_chat, text) => { texts2.push(text); return { message_id: 222 }; } },
    }).runTick(base + 1_500);
    assert.equal(out2.deduped, 1, "the written-back mark still refuses it");
    assert.deepEqual(
      texts2.map((t) => (t.includes("🚀") ? "rising" : "weak")),
      ["weak"],
      "and the ⚠️ card is still owed exactly once",
    );
  });
`;

// The proof READ gate: it used to require a cut mark on a head row, which is
// what made the new rule dead code on the only rows it is for.
const GATE_ANCHOR = lines(
  "    // Cut-card proof (see CUT_MARK_PREFIX): read ONCE per pass, and ONLY when a",
  "    // row in this rotation head actually carries a cut mark — a pass with",
  "    // nothing cut pays no round trip. The lookups inside the row loop are then",
  "    // free (in memory).",
  "    let followupProofAt: ReadonlyMap<string, number> | undefined;",
  "    if (head.some((r) => parseCutMarks(r.upStages).length > 0)) {",
);
const GATE_NEXT = lines(
  "    // Cut-card proof (see CUT_MARK_PREFIX): read ONCE per pass, and whenever",
  "    // the head can be evaluated at all. It used to be gated on a head row",
  "    // ALREADY carrying a cut mark, which made the no-mark rule (see",
  "    // proofIsCurrent) unreachable by construction: that rule exists for exactly",
  "    // the rows whose mark never landed, so gating the read on a mark meant the",
  "    // proof was only ever consulted where the mark had already answered the",
  "    // same question. One trip per pass, on the passes that can act on it; the",
  "    // lookups inside the row loop stay free (in memory).",
  "    let followupProofAt: ReadonlyMap<string, number> | undefined;",
  "    if (head.length > 0) {",
);

// ------------------------------------------------------ duplicate-cards.md ---
const DOC = path.join(__dirname, "..", "duplicate-cards.md");
const DOC_ANCHOR = "   cron 到達記錄再次凍結（§4.5 第一項）。";
const DOC_SECTION = lines(
  "",
  "## 十九、第三修：冇 cut mark 都查 proof，但只認「呢一次 check」（2026-09-24）",
  "",
  "仍然開住嘅一條：`fire()` **只喺有 cut mark 時**才查 audit proof。mark 係「attempt 過呢張卡」嘅記錄，",
  "而佢係由**做咗嗰次 send 嘅 pass 自己**寫 —— 所以一個喺寫入之前就死咗嘅 pass（rollback、isolate 被殺）",
  "會留低一張**送達咗但冇 mark** 嘅卡，下一次評估照樣重新推導、然後照送 ⇒ 重複。audit entry 本身就係",
  "時間證據，佢答得到同一個問題。",
  "",
  "* **收窄（唔係放寬）**：冇 cut mark 時**照樣**查 audit ring，但只認**同一個 sig** 嘅 exact proof",
  "  （`cardProofKey(token, sig)`），**唔用** token 級 fallback —— fallback 講唔出邊張卡，而呢條規則",
  "  冇 mark 做錨，用咗就可能壓抑一張**從來冇送過**嘅卡（唯一唔可以接受嘅方向）。",
  "* **同一把尺**：proof 嘅時間戳要落喺 row 自己 `last_checked` 嘅分鐘桶、或者**下一個**桶之內",
  "  （`proofIsCurrent`）—— 同 `attemptIsCurrent` 對 attempt 用嘅規則一模一樣（`:59` claim → `:00` 交付",
  "  嘅 straddle）。更舊嘅唔算：re-armed row（🔁 resume、死而復生）之後可以**合法地**再公告同一個",
  "  transition，舊嘅交付唔應該令新卡靜音。",
  "* **suppress 嘅同時補寫返 mark**：被 suppress 嘅卡帶住 `dedupedAt`（＝proof 自己嘅時間戳）出返去，",
  "  row loop 會將佢寫成該卡嘅 attempt mark。呢個係關鍵嘅另一半：rollback 會**推翻公告**，得 mark＋proof",
  "  一對先擋得住下一次推導。冇咗個 mark，proof 一離開個窗，同一張卡就會被送出去 —— 即係「壓抑一次、",
  "  遲啲補一張重複」，而唔係永遠壓抑。",
  "* **讀 proof 嘅閘要跟住放寬**（同一個 bug 嘅第二半）：proof ring 本來**只喺 head row 已經帶 cut mark",
  "  時**才讀（省一個 trip）。但新規則要處理嘅正正係**冇 mark** 嘅 row ⇒ 照舊閘法呢條規則係**死碼**，",
  "  唯有 mark 已經答過同一條問題嘅地方才讀得到 proof。所以改成「head 有人可以評估就讀」，成本係",
  "  **每次 pass 一個 trip**（老實講：呢個就係呢條修法嘅價錢，換嚟「送達但冇 mark」唔會重複）。",
  "* **測試**（`scripts/test-unit.js`；negative control 驗過：攞走個規則 ⇒ 2 條齊 fail，300 passed／2 failed）：",
  "  * `evaluateWatch`：冇 mark ＋ 同一個 check 桶嘅 proof ⇒ `deduped`、`dedupedAt` ＝ proof 嘅時間戳、",
  "    transition 照落地；proof 喺**下一個**桶（straddle）⇒ 一樣；proof 早兩個桶 ⇒ **照送**；只有 token",
  "    級 proof（冇 sig）⇒ **照送**；另一個 sig 嘅 mark ⇒ 唔影響（各自用自己嗰條）。",
  "  * `PushWatcher`：一張已送達但冇 mark 嘅 🚀 ＋ 一個被拒嘅 ⚠️ sibling ⇒ 🚀 **唔送**、rollback 寫出",
  "    `p:up100:<bucket>`；下一個 pass（row 帶住嗰個 mark、而 proof 已經偏離個窗 10 分鐘）⇒ 仍然擋得住，",
  "    只有 ⚠️ 重送一次。呢條就係「補寫返 mark」嘅端到端證明。",
  "* **落線 script**：`docs/patches/cut-card-proof-no-mark.apply.js`（row loop ＋ proof 讀取閘 ＋ 兩條測試）。",
);

const JOBS = [
  {
    label: "duplicate-cards §十九",
    file: DOC,
    done: "## 十九、第三修",
    anchor: DOC_ANCHOR,
    next: DOC_ANCHOR + "\n" + DOC_SECTION,
  },
  {
    label: "pushwatch row loop carries `dedupedAt`",
    file: PW,
    done: "priorMarks.get(a.sig) ?? a.dedupedAt",
    anchor: PW_ANCHOR,
    next: PW_NEXT,
  },
  {
    label: "pushwatch reads the proof ring whenever the head can be evaluated",
    file: PW,
    done: "if (head.length > 0) {",
    anchor: GATE_ANCHOR,
    next: GATE_NEXT,
  },
  {
    label: "test-unit: the no-mark dedupe tests",
    file: TESTS,
    done: "with NO cut mark, a proof from the row's OWN check still refuses",
    anchor: TEST_ANCHOR,
    next: TEST_ANCHOR + TEST_CODE,
  },
];

let failed = false;
const pending = [];
for (const job of JOBS) {
  const text = fs.readFileSync(job.file, "utf8");
  if (text.includes(job.done)) {
    console.log(`ALREADY   ${job.label}`);
    continue;
  }
  const at = text.indexOf(job.anchor);
  if (at < 0) {
    console.error(`MISS      ${job.label}`);
    failed = true;
    continue;
  }
  if (text.indexOf(job.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${job.label}`);
    failed = true;
    continue;
  }
  pending.push(job);
}
if (failed) process.exit(1);
if (pending.length === 0) {
  console.log("ok        the no-mark dedupe change is already in place");
  process.exit(0);
}

for (const job of pending) {
  const text = fs.readFileSync(job.file, "utf8");
  fs.writeFileSync(job.file, text.replace(job.anchor, job.next));
  console.log(`ok        ${job.label}`);
}
console.log(`ok        ${pending.length} edits written`);
