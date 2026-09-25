#!/usr/bin/env node
/**
 * 「我只收到最後一張 🚀，冇收過 +200% / +400%」—— 查明同修正。
 *
 * WHAT HAPPENED (2026-09-25 06:49 HKT = 22:49:58Z, parafactual)
 *   `push_watch` row: mcapAtPush 115_199 → peak 921_235, `followupsSent: 8`,
 *   `upStages: up100,up200,up400,up50,w35`, `lastState: up400`, and the audit
 *   ring's only surviving entry for the token is `sig up400 @ 22:49:58`.
 *
 *   NOTHING WAS LOST. `RISING_STAGES = [50, 100, 200, 400]` and the stage
 *   machine fires the HIGHEST crossed-and-unannounced stage, then marks every
 *   stage at or below it (`for (let j = 0; j <= i; j++) firedStages.add(...)`)
 *   — deliberately, because announcing four cards in descending order for one
 *   move was the old POPEYE bug. So a move the tracker only OBSERVES once
 *   produces exactly one card, and the up50/up100/up200 marks in that row are
 *   that one card's own fold, not four lost sends. The coin's ladder was
 *   crossed between two checks: it was under the +50% band (trough 71_254,
 *   below the 115K push) and next seen at +473%.
 *
 *   THE COMPLAINT IS STILL VALID, though, and that is what this patch fixes:
 *   the card said only `已達最高里程碑`, i.e. it reported the top of a ladder it
 *   had quietly swallowed, so a reader could not tell "the +200% notice was
 *   lost" from "there was never a check while the price sat between +100% and
 *   +200%". The card now NAMES the stages it crossed in one check.
 *
 * THE DIAGNOSTIC GAP (why the outside could not have answered this)
 *   The only durable per-card proof is `worker_state.push_audit`, a ring capped
 *   at 30 entries and shared by every chat and every card kind — minutes of
 *   history on a busy day. The deferral ledger is counters plus a pending-token
 *   list, and `followupsSent` is a counter, not a history. So "did coin X get
 *   its +200% card?" was unanswerable hours later BY CONSTRUCTION. This patch
 *   raises the ring to 200 and gives /debug/push-audit `?token=`, `?since=` and
 *   `?limit=`, so the next such question is one request.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const DOC_HEADING = "## 第十一補：一次檢查跨過幾關，張卡要講明";

const DOC = lines(
  "",
  "---",
  "",
  DOC_HEADING,
  "",
  "2026-09-25 06:49 HKT 收到 `🚀 續漲 parafactual | 推送時 $115.2K → $660.58K (+473%) … 已達最高里程碑`，",
  "而之前冇任何 +200% / +400% 通知。查完：**冇漏發**。",
  "",
  "| 讀數 | 值 |",
  "|---|---|",
  "| `mcapAtPush` → `peakMcap` | 115,199 → 921,235 |",
  "| `upStages` | `up50,up100,up200,up400,w35` |",
  "| `lastState` | `up400` |",
  "| audit ring 內該 token 嘅卡 | 只有 `sig up400 @ 22:49:58` |",
  "| `deadTroughMcap` | 71,254（低過推送價） |",
  "",
  "`RISING_STAGES = [50,100,200,400]`，stage machine 發**最高而未公佈**嗰關，然後把 ≤ 該關嘅全部 mark 死",
  "（`for j <= i`）—— 呢個係刻意嘅（舊行為係一次大行情倒序發四張：+400%、+200%、+100%，POPEYE 事件）。",
  "所以**一次檢查內跨過成個梯級，就只會有一張卡**；row 入面嗰三個 up mark 係同一張卡自己 fold 出嚟，唔係三次失蹤。",
  "該幣當時跌到 71K（低於推送價），下一次被睇到就已經係 +473%。",
  "",
  "不過用戶嘅困惑係啱嘅：張卡只寫「已達最高里程碑」，冇講佢吞咗邊幾關，所以讀者分唔清「+200% 漏發」同",
  "「價位停在 +100% 同 +200% 之間嗰段時間根本冇檢查過」。",
  "",
  "**修正**：跨過多過一關時，卡會列出全部關口：`| 一次檢查內跨越 +50%/+100%/+200%/+400% | 已達最高里程碑`。",
  "",
  "**另一個真缺口**（令呢個問題由外面查唔到）：唯一持久嘅逐卡證據係 `push_audit`，一個**上限 30 筆、全 chat 共用**嘅",
  "ring —— 繁忙時只覆蓋幾分鐘；deferral ledger 只有計數同 pending token 名單，`followupsSent` 只係一個數。",
  "改為 200 筆，並為 `/debug/push-audit` 加 `?token=` / `?since=` / `?limit=`，下次一條 request 就答得到。",
);

const PATCHES = [
  // ── src/pushwatch.ts ─────────────────────────────────────────────────────
  {
    file: "src/pushwatch.ts",
    what: "the crossed-stages reading, as pure helpers",
    marker: "export function risingCardTail(",
    anchor: lines("const RISING_STAGES = [50, 100, 200, 400] as const;"),
    replacement: lines(
      "const RISING_STAGES = [50, 100, 200, 400] as const;",
      "",
      "/**",
      " * The stages a card at `stage` is the FIRST announcement for: everything at",
      " * or below it that the row does not carry a mark for yet.",
      " *",
      " * MORE THAN ONE means the move was only OBSERVED once — the tracker never",
      " * saw the price while it sat between those bands — and that is a reading the",
      " * card has to state (see risingCardTail).",
      " */",
      "export function newlyCrossedStages(",
      "  stage: number,",
      "  already: ReadonlySet<string>,",
      "): number[] {",
      "  return RISING_STAGES.filter((s) => s <= stage && !already.has(`up${s}`));",
      "}",
      "",
      "/**",
      " * The 🚀 card's tail. It names EVERY stage this one card swallowed (live",
      " * 2026-09-25 06:49 HKT: parafactual landed as a single up400 card reading",
      " * +473%, with up50/up100/up200 folded in unannounced), then the stage still",
      " * ahead — so a reader can tell \"the +200% notice was lost\" from \"there was",
      " * never a check while the price was between +100% and +200%\". A card that",
      " * crossed exactly one stage reads exactly as it always did.",
      " */",
      "export function risingCardTail(crossed: readonly number[], nextStage: number | null): string {",
      "  const parts: string[] = [];",
      "  if (crossed.length > 1) parts.push(`一次檢查內跨越 +${crossed.join(\"%/+\")}%`);",
      "  parts.push(nextStage !== null ? `下一關 +${nextStage}%` : \"已達最高里程碑\");",
      "  return ` | ${parts.join(\" | \")}`;",
      "}",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "and the card uses them",
    marker: "const crossed = newlyCrossedStages(stage, firedStages);",
    anchor: lines(
      "        const nextStage = i + 1 < RISING_STAGES.length ? RISING_STAGES[i + 1] : null;",
      "        fire(",
      '          "rising",',
      "          `🚀 續漲 ${symbol} | 推送時 ${fmtUsd(row.mcapAtPush)} → ${fmtUsd(live.mcap)} (${pct(chgSincePush)}) | 峰值回撤 ${pct(drawdownFromPeak)} | 5m ${pct(live.chg5m)} | 買賣比 ${bs}(h1)` +",
      "            (nextStage ? ` | 下一關 +${nextStage}%` : \" | 已達最高里程碑\"),",
      "          state,",
      "        );",
    ),
    replacement: lines(
      "        const nextStage = i + 1 < RISING_STAGES.length ? RISING_STAGES[i + 1] : null;",
      "        // Which stages THIS card is the first announcement for. More than one",
      "        // = the ladder was crossed between two checks, and the card says so",
      "        // (see risingCardTail): the mark loop below would otherwise fold them",
      "        // in silently, which reads from the chat as \"the +200% notice was",
      "        // lost\". Live 2026-09-25 06:49 HKT: parafactual was pushed at",
      "        // 115_199, troughed at 71_254, and was next seen at +473%.",
      "        const crossed = newlyCrossedStages(stage, firedStages);",
      "        fire(",
      '          "rising",',
      "          `🚀 續漲 ${symbol} | 推送時 ${fmtUsd(row.mcapAtPush)} → ${fmtUsd(live.mcap)} (${pct(chgSincePush)}) | 峰值回撤 ${pct(drawdownFromPeak)} | 5m ${pct(live.chg5m)} | 買賣比 ${bs}(h1)` +",
      "            risingCardTail(crossed, nextStage),",
      "          state,",
      "        );",
    ),
  },
  // ── src/db.ts ────────────────────────────────────────────────────────────
  {
    file: "src/db.ts",
    what: "the delivery ring holds hours, not minutes",
    // The marker is the FINAL line, not the intermediate `PUSH_AUDIT_MAX` form:
    // the ring reads the cap off the class (`Db.PUSH_AUDIT_MAX`, the entries
    // below), so a tree that already carries the class constant has THIS line
    // and no module-scope binding left to rename — which is exactly how the
    // first form of this entry reported MISS on a tree it had already patched.
    // Anchoring on the original 30-line keeps the entry honest for a tree that
    // never saw the change at all.
    marker: "if (list.length > Db.PUSH_AUDIT_MAX) list = list.slice(-Db.PUSH_AUDIT_MAX);",
    anchor: lines("    if (list.length > 30) list = list.slice(-30);"),
    replacement: lines(
      "    // 200, not 30: this ONE row is shared by every chat and every card kind,",
      "    // so on a busy day a 30-entry ring covered minutes — and the question it",
      "    // exists to answer (\"did coin X get its +200% card an hour ago?\") spans",
      "    // hours. Live 2026-09-25: parafactual's up400 card was the ring's only",
      "    // entry for the token, with its earlier stages long rolled out. The",
      "    // readers that only need INITIAL cards (hasInitialPushAudit /",
      "    // getInitialPushAuditTokens) are strictly better off with a wider window.",
      "    if (list.length > Db.PUSH_AUDIT_MAX) list = list.slice(-Db.PUSH_AUDIT_MAX);",
    ),
  },
  {
    file: "src/db.ts",
    what: "and the cap has a name",
    marker: "export const PUSH_AUDIT_MAX = 200;",
    anchor: lines(
      "  /**",
      "   * Delivery audit ring (worker_state JSON, last N entries): records the",
    ),
    replacement: lines(
      "/**",
      " * Entries kept in the shared delivery ring (see recordPushDelivery).",
      " * Bounded by what a worker_state JSON value can carry comfortably (~30KB)",
      " * and by the hours a \"which of this coin's cards went out?\" question spans.",
      " */",
      "export const PUSH_AUDIT_MAX = 200;",
      "",
      "  /**",
      "   * Delivery audit ring (worker_state JSON, last N entries): records the",
    ),
  },
  // The cap landed INSIDE the class body (the anchor was a method's docstring),
  // where `export const` is illegal — tsc: TS1031. It is a class constant now,
  // declared at the top of the class. The three entries share one marker and so
  // move together (this script validates every entry before writing any).
  {
    file: "src/db.ts",
    what: "the misplaced module export comes back out",
    // A REMOVAL is proven done by the ABSENCE of what it deletes, not by a
    // marker left behind. This entry used to carry the class constant as its
    // `marker` — the very text entry 5 ADDS — so a re-run over a tree that
    // already had that constant read as "already" and skipped the cleanup,
    // leaving the module-scope `export const` inside the class body:
    // `src/db.ts(2455,1): error TS1031`. `absent` is the proof it lacked.
    absent: "export const PUSH_AUDIT_MAX = 200;",
    anchor: lines(
      "/**",
      " * Entries kept in the shared delivery ring (see recordPushDelivery).",
      ' * Bounded by what a worker_state JSON value can carry comfortably (~30KB)',
      ' * and by the hours a "which of this coin\'s cards went out?" question spans.',
      " */",
      "export const PUSH_AUDIT_MAX = 200;",
      "",
      "  /**",
      "   * Delivery audit ring (worker_state JSON, last N entries): records the",
    ),
    replacement: lines(
      "  /**",
      "   * Delivery audit ring (worker_state JSON, last N entries): records the",
    ),
  },
  {
    file: "src/db.ts",
    what: "and is declared at the top of the class",
    marker: "private static readonly PUSH_AUDIT_MAX = 200;",
    anchor: lines("export class Db {"),
    replacement: lines(
      "export class Db {",
      "  /**",
      "   * Entries kept in the shared delivery ring (see recordPushDelivery).",
      "   * Bounded by what a worker_state JSON value can carry comfortably (~30KB)",
      '   * and by the hours a "which of this coin\'s cards went out?" question',
      "   * spans.",
      "   */",
      "  private static readonly PUSH_AUDIT_MAX = 200;",
    ),
  },
  {
    file: "src/db.ts",
    what: "and the ring reads it off the class",
    marker: "Db.PUSH_AUDIT_MAX",
    anchor: lines(
      "    if (list.length > PUSH_AUDIT_MAX) list = list.slice(-PUSH_AUDIT_MAX);",
    ),
    replacement: lines(
      "    if (list.length > Db.PUSH_AUDIT_MAX) list = list.slice(-Db.PUSH_AUDIT_MAX);",
    ),
  },
  // ── src/worker.ts ────────────────────────────────────────────────────────
  {
    file: "src/worker.ts",
    what: "/debug/push-audit answers for one coin",
    marker: 'url.searchParams.get("since")',
    anchor: lines(
      '    if (url.pathname === "/debug/push-audit") {',
      "      const rows = (await db?.getPushAudit()) ?? [];",
      "      return Response.json({ ok: true, count: rows.length, rows });",
      "    }",
    ),
    replacement: lines(
      '    if (url.pathname === "/debug/push-audit") {',
      "      // ?token= (mint or a prefix), ?since= (epoch ms) and ?limit= turn the",
      "      // ring into the ONE answer a \"I never got the +200% notice\" report",
      "      // needs: WHICH of this coin's cards went out, and when. Read whole it",
      "      // was minutes of history shared by every chat — live 2026-09-25,",
      "      // parafactual's up400 card was its only surviving entry (see",
      "      // PUSH_AUDIT_MAX in src/db.ts, raised to 200 by the same change).",
      "      const rows = (await db?.getPushAudit()) ?? [];",
      '      const token = url.searchParams.get("token");',
      '      const since = Number(url.searchParams.get("since") ?? 0) || 0;',
      '      const limit = Number(url.searchParams.get("limit") ?? 0) || 0;',
      "      const matching = rows.filter(",
      "        (r) =>",
      "          (!token || r.token === token || r.token.startsWith(token)) &&",
      "          (since === 0 || r.at >= since),",
      "      );",
      "      return Response.json({",
      "        ok: true,",
      "        count: limit > 0 ? Math.min(limit, matching.length) : matching.length,",
      "        total: rows.length,",
      "        rows: limit > 0 ? matching.slice(-limit) : matching,",
      "      });",
      "    }",
    ),
  },
  // ── scripts/test-unit.js ─────────────────────────────────────────────────
  {
    file: "scripts/test-unit.js",
    what: "the new helpers are imported",
    // The import list was extended with TWO names, so the marker has to span the
    // last one (`risingCardTail } = require` never appears once
    // `newlyCrossedStages` sits between them).
    marker: "newlyCrossedStages } = require",
    anchor: lines(
      'const { evaluateWatch, recapVerdict, recapMessage, PushWatcher, comparableLiquidity, liquidityIsComparable, terminalRowIssues, terminalRowRepair, TRACKER_ROW_SPAN_HOLD_MS, TRACKER_PAIR_HEAD } = require("../dist/pushwatch.js");',
    ),
    replacement: lines(
      'const { evaluateWatch, recapVerdict, recapMessage, PushWatcher, comparableLiquidity, liquidityIsComparable, terminalRowIssues, terminalRowRepair, TRACKER_ROW_SPAN_HOLD_MS, TRACKER_PAIR_HEAD, risingCardTail, newlyCrossedStages } = require("../dist/pushwatch.js");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the crossed-stage card is pinned on the reported coin's shape",
    marker: "THE PARAFACTUAL CASE",
    anchor: lines(
      '    const r3 = evaluateWatch(row({ lastState: "up50", lastAlertAt: 3600_000 }), 3600_000 + 3600_000, live(110_000), cfg);',
      '    assert.equal(r3.alerts.length, 1);',
      '    assert.match(r3.alerts[0].text, /續漲 GOAT/);',
      '    assert.match(r3.alerts[0].text, /\\+120%/);',
      '    assert.equal(r3.lastState, "up100");',
      "  });",
    ),
    replacement: lines(
      '    const r3 = evaluateWatch(row({ lastState: "up50", lastAlertAt: 3600_000 }), 3600_000 + 3600_000, live(110_000), cfg);',
      '    assert.equal(r3.alerts.length, 1);',
      '    assert.match(r3.alerts[0].text, /續漲 GOAT/);',
      '    assert.match(r3.alerts[0].text, /\\+120%/);',
      '    assert.equal(r3.lastState, "up100");',
      "",
      "    // THE PARAFACTUAL CASE (live 2026-09-25 06:49 HKT): pushed at 115_199,",
      "    // troughed at 71_254 (under the push price), and next SEEN at +473% — so",
      "    // the whole ladder was crossed between two checks. ONE card is correct",
      "    // (four cards for one move was the old POPEYE bug), but it has to name",
      "    // what it swallowed, or the +200%/+400% notices read as lost.",
      "    const gap = evaluateWatch(row(), 3600_000, live(286_500), cfg);",
      '    assert.equal(gap.alerts.length, 1, "one card per crossing, however many stages it spans");',
      '    assert.equal(gap.alerts[0].sig, "up400");',
      "    assert.match(",
      "      gap.alerts[0].text,",
      "      /一次檢查內跨越 \\+50%\\/\\+100%\\/\\+200%\\/\\+400%/,",
      '      "the card names every stage it crossed",',
      "    );",
      '    assert.match(gap.alerts[0].text, /已達最高里程碑/);',
      "    // The marks still fold (that is what stops the descending re-announce),",
      "    // and the card is what tells the reader they were crossed together.",
      '    assert.equal(gap.announcedUpStages, "up100,up200,up400,up50");',
      "  });",
      "",
      '  await test("risingCardTail: one stage crossed reads exactly as before; several are named", () => {',
      '    assert.equal(risingCardTail([400], null), " | 已達最高里程碑");',
      '    assert.equal(risingCardTail([100], 200), " | 下一關 +200%");',
      "    assert.equal(",
      "      risingCardTail([50, 100, 200, 400], null),",
      '      " | 一次檢查內跨越 +50%/+100%/+200%/+400% | 已達最高里程碑",',
      "    );",
      '    assert.equal(risingCardTail([50, 100], 200), " | 一次檢查內跨越 +50%/+100% | 下一關 +200%");',
      "    // Only stages the row does NOT already mark are \"crossed\": a marked stage",
      "    // is history, not a swallow.",
      '    assert.deepEqual(newlyCrossedStages(400, new Set(["up50", "up100"])), [200, 400]);',
      '    assert.deepEqual(newlyCrossedStages(200, new Set(["up50", "up100", "up200"])), []);',
      '    assert.deepEqual(newlyCrossedStages(50, new Set(["w35", "up400"])), [50]);',
      "  });",
    ),
  },
  // The existing cap test pinned 30 entries - which is the behaviour this patch
  // deliberately changes, so it moves with it (and says why the window is 200:
  // 30 entries of a row shared by every chat covered minutes).
  {
    file: "scripts/test-unit.js",
    what: "the cap test is renamed to the widened ring",
    marker: "caps at PUSH_AUDIT_MAX (200)",
    anchor: lines(
      '  await test("push delivery audit ring records message_id and caps at 30", async () => {',
    ),
    replacement: lines(
      '  await test("push delivery audit ring records message_id and caps at PUSH_AUDIT_MAX (200)", async () => {',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "and overflows it by more than the old cap",
    marker: "for (let i = 0; i < 205; i++) {",
    anchor: lines(
      "      // Ring cap: oldest entries fall off, newest survive.",
      "      for (let i = 0; i < 35; i++) {",
    ),
    replacement: lines(
      "      // Ring cap: oldest entries fall off, newest survive. 205 pushes past a",
      "      // 200-entry window the way a busy day does.",
      "      for (let i = 0; i < 205; i++) {",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "and expects the wider window",
    marker: 'audit[audit.length - 1].token, "M204"',
    anchor: lines(
      "      assert.equal(audit.length, 30);",
      '      assert.equal(audit[audit.length - 1].token, "M34");',
      '      assert.ok(!audit.some((r) => r.token === "XSTMINT"), "oldest entry evicted");',
    ),
    replacement: lines(
      "      assert.equal(audit.length, 200);",
      '      assert.equal(audit[audit.length - 1].token, "M204");',
      '      assert.ok(!audit.some((r) => r.token === "XSTMINT"), "oldest entry evicted");',
      '      assert.ok(!audit.some((r) => r.token === "GLITCHMINT"), "so is the second");',
      '      assert.equal(audit[0].token, "M5", "the window is the LAST 200, not the first");',
    ),
  },
];

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;
for (const patch of PATCHES) {
  const text = bufferOf(patch.file);
  // `marker` = "the text this entry leaves behind is already in the file".
  // `absent` = the mirror image, for an entry whose whole job is to DELETE:
  // it is already applied when the thing it removes is gone. Without both
  // forms a removal could never be expressed, which is how the tree ended up
  // half-patched (see the entry below).
  const applied = patch.absent
    ? !text.includes(patch.absent)
    : text.includes(patch.marker);
  if (applied) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const at = text.indexOf(patch.anchor);
  if (at < 0) {
    console.error(`MISS      ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  if (text.indexOf(patch.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  buffers.set(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

{
  const file = "docs/push-baseline-ledger.md";
  const text = bufferOf(file);
  if (text.includes(DOC_HEADING)) {
    console.log(`already   ${file}: the crossed-stage card is documented`);
  } else {
    buffers.set(file, `${text.trimEnd()}\n${DOC}`);
    console.log(`ok        ${file}: the crossed-stage card is documented`);
  }
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchor above");
  process.exit(1);
}
let writes = 0;
for (const [file, text] of buffers) {
  if (text === fs.readFileSync(file, "utf8")) continue;
  fs.writeFileSync(file, text);
  writes += 1;
}
console.log(`\nall patches applied (${writes} file(s) written)`);
