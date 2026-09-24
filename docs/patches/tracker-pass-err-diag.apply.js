#!/usr/bin/env node
/**
 * A thrown pass must say WHERE it died and what the counter believed.
 *
 * WHY — the live readings that sent me here. Two deployments of the pass's
 * subrequest ceiling (159af44's row gate + 0bf2c3a's entry gate) both landed,
 * both read green in CI, and BOTH left the same note in production:
 *
 *     14:39:57Z  err:Too many subrequests by single Worker invocation
 *     14:40:15Z  err:Too many subrequests by single Worker invocation
 *
 * on invocations whose own counter read 18-27. A 50-call ceiling cannot be hit
 * at 21 counted calls, so either the gates are mistuned or the counter cannot
 * see the spend — and the note could not tell us which, because a throw skips
 * the stage split entirely. The stage and the remaining count are exactly the
 * two readings that separate those cases:
 *
 *   - `subreq 2` (small)  -> the counter AGREED the invocation was full. The
 *     gates are mistuned, and the number says by how much.
 *   - `subreq 29` (large) -> the counter saw room while the runtime refused.
 *     The spend is invisible to the wrapper, and no gate placement can fix
 *     that; the counter is the thing to fix.
 *
 * Without them, the next occurrence is another round of speculation — which is
 * the cost this change pays off.
 *
 * The probe is read at CALL time, not snapshotted: the scanner asks in its
 * `catch`, i.e. immediately after the throw, so the number is the counter's
 * opinion at the throw. A pass with no probe installed (every existing caller
 * and test) reports `subreq n/a` rather than a false number, and a watcher
 * that has never run a pass reports nothing at all — so a `passDiag` on the
 * happy path can never leak a stale stage into a later note.
 *
 * An apply script because src/pushwatch.ts, src/scanner.ts and the tests at the
 * end of scripts/test-unit.js all sit past the file-tool window; every anchor
 * must match exactly once or nothing is written.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  // ----------------------------------------------------------- pushwatch.ts --
  {
    file: "src/pushwatch.ts",
    what: "the pass's stage and probe, held for a throw to be read from",
    marker: "private passStage = \"none\";",
    anchor: lines(
      "  private unconfirmedWrites = 0;",
      "  private settleProbed = false;",
    ),
    replacement: lines(
      "  private unconfirmedWrites = 0;",
      "  private settleProbed = false;",
      "  /**",
      "   * The stage this pass was in when it last moved, and the invocation's",
      "   * subrequest probe, kept so a THROW can describe itself.",
      "   *",
      "   * WHY (2026-09-24): a thrown pass leaves no stage split at all — the note",
      "   * is written by the scanner's catch, past every stage boundary — so the",
      "   * live `err:Too many subrequests by single Worker invocation` readings",
      "   * arrived with nothing but the message, and two of them (14:39:57Z,",
      "   * 14:40:15Z) sat on invocations whose counter read 18-27. Nothing in",
      "   * /health could say which stage died or whether the counter agreed the",
      "   * invocation was full. `passDiag()` is the answer to both.",
      "   */",
      '  private passStage = "none";',
      "  private subreqProbe: (() => number) | null = null;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "passDiag: the stage, and the counter's opinion AT the throw",
    marker: "passDiag(): string | null {",
    anchor: lines(
      "  /** Tokens the last pass put at the front of its rotation queue. */",
      "  headTokens(): string[] {",
    ),
    replacement: lines(
      "  /**",
      "   * What a THROWN pass can say about itself: the stage it was in, and how",
      "   * many subrequests the invocation still had unspent.",
      "   *",
      "   * The probe is called HERE, not snapshotted at each stage: the scanner",
      "   * asks in its `catch`, i.e. straight after the throw, so the number is",
      "   * the counter's opinion at the moment the pass died. A pass with no probe",
      "   * (every caller before 159af44, and every direct test) reports `n/a` rather",
      "   * than a fabricated number, and a watcher that has not run a pass reports",
      "   * `null`, so nothing can leak a stale stage into a later note.",
      "   *",
      "   * `null` is the honest answer for the happy path — a note only ever asks",
      "   * for this after something threw, and by then the stage belongs to the",
      "   * pass that threw.",
      "   */",
      "  passDiag(): string | null {",
      '    if (this.passStage === "none") return null;',
      "    const left = this.subreqProbe === null ? null : this.subreqProbe();",
      '    return `${this.passStage} subreq ${left === null ? "n/a" : left}`;',
      "  }",
      "",
      "  /** Tokens the last pass put at the front of its rotation queue. */",
      "  headTokens(): string[] {",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "the pass opens by naming itself, and installs the probe",
    marker: 'this.passStage = "entry";',
    anchor: lines(
      "    // The tick's waitUntil hand-off, when the caller has one (see holdForTick).",
      "    this.keepAliveForTick = keepAlive ?? null;",
    ),
    replacement: lines(
      "    // The tick's waitUntil hand-off, when the caller has one (see holdForTick).",
      "    this.keepAliveForTick = keepAlive ?? null;",
      "    // Name the pass before it does anything, so a throw in the FIRST read",
      "    // still says `entry` rather than nothing (see passDiag).",
      '    this.passStage = "entry";',
      "    this.subreqProbe = typeof subreqLeft === \"function\" ? subreqLeft : null;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "stage: setup (listing, recap, prune)",
    marker: 'this.passStage = "setup";',
    anchor: lines(
      "    if (outOfBudget()) return deferred;",
      "    // Case-closed recaps: every coin leaving the window gets ONE summary",
    ),
    replacement: lines(
      "    if (outOfBudget()) return deferred;",
      '    this.passStage = "setup";',
      "    // Case-closed recaps: every coin leaving the window gets ONE summary",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "stage: the terminal-card settle",
    marker: 'this.passStage = "settle";',
    anchor: lines(
      "    const settle = await this.settleUnconfirmedCards(now);",
    ),
    replacement: lines(
      '    this.passStage = "settle";',
      "    const settle = await this.settleUnconfirmedCards(now);",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "stage: the self-heal",
    marker: 'this.passStage = "heal";',
    anchor: lines(
      "    const healStart = Date.now();",
      "    const healTrips = trips;",
    ),
    replacement: lines(
      '    this.passStage = "heal";',
      "    const healStart = Date.now();",
      "    const healTrips = trips;",
    ),
  },
  {
    file: "src/pushwatch.ts",
    what: "stage: the rotation (proof read, pair batch, row loop, batch write)",
    marker: 'this.passStage = "rows";',
    anchor: lines("    const rows: PushWatchRow[] ="),
    replacement: lines('    this.passStage = "rows";', "    const rows: PushWatchRow[] ="),
  },
  {
    file: "src/pushwatch.ts",
    what: "stage: the holder refresh",
    marker: 'this.passStage = "holders";',
    anchor: lines(
      "    const holdersStart = Date.now();",
      "    const holdersTrips = trips;",
    ),
    replacement: lines(
      '    this.passStage = "holders";',
      "    const holdersStart = Date.now();",
      "    const holdersTrips = trips;",
    ),
  },

  // -------------------------------------------------------------- scanner.ts --
  {
    file: "src/scanner.ts",
    what: "the err: note carries the stage and the counter's opinion",
    marker: "const errNote = `err:",
    anchor: lines(
      "    } catch (err) {",
      "      this.exitTickDbLeash();",
      "      const msg = err instanceof Error ? err.message : String(err);",
      '      console.error("[scanner] push-watch tick failed:", msg);',
      "      if (this.lastSummary) {",
      "        this.lastSummary.pushWatch = `err:${msg.slice(0, 140)}`;",
      "      }",
    ),
    replacement: lines(
      "    } catch (err) {",
      "      this.exitTickDbLeash();",
      "      const msg = err instanceof Error ? err.message : String(err);",
      '      console.error("[scanner] push-watch tick failed:", msg);',
      "      // WHY the stage and the counter ride the note (2026-09-24): a throw",
      "      // skips every stage boundary, so the note used to carry the message",
      "      // and nothing else. Two live `err:Too many subrequests` readings then",
      "      // sat on invocations whose own counter read 18-27 — which cannot exhaust",
      "      // 50 — and /health could not say whether the gates were mistuned or the",
      "      // counter was blind to the spend. `stage` answers where; `subreq N`",
      "      // answers which: small N means the counter agreed the invocation was",
      "      // full, large N means it saw room while the runtime refused, and no",
      "      // gate placement fixes the second case.",
      "      const diag = this.pushWatcher.passDiag?.() ?? null;",
      "      const errNote = `err:${msg.slice(0, 120)}${diag ? ` [${diag}]` : \"\"}`;",
      "      if (this.lastSummary) {",
      "        this.lastSummary.pushWatch = errNote;",
      "      }",
    ),
  },
  {
    file: "src/scanner.ts",
    what: "the durable note gets the same line, not the bare message",
    marker: "await this.persistPassNote(errNote, startedAt);",
    anchor: lines("      await this.persistPassNote(`err:${msg.slice(0, 140)}`, startedAt);"),
    replacement: lines("      await this.persistPassNote(errNote, startedAt);"),
  },

  // ------------------------------------------------------- scripts/test-unit --
  // Kept as its own step so a tree carrying the first version converges: the
  // first draft asserted the throw surfaced in `setup`, but the setup DELIBERATELY
  // swallows a failed listing (the loop re-reads, so one failed read is not a
  // failed pass), so the throw surfaces at the rows re-read instead. The
  // corrected expectation is a better test anyway — it proves the label ADVANCES
  // with the pass rather than sticking at the first stage it ever set.
  {
    file: "scripts/test-unit.js",
    what: "the stage assertion follows the pass to where the throw really surfaces",
    marker: "the setup swallowed it and the pass died at the rows re-read",
    anchor: lines(
      "    // (a) It dies in the setup, before a single gate could be consulted.",
      "    const early = boom(\"setup\");",
      "    const pwEarly = termWatcher(early, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);",
      "    await assert.rejects(",
      "      () => pwEarly.runTick(Date.now() + 5_000, undefined, () => 29),",
      "      /Too many subrequests/,",
      "      \"the throw still propagates — the gates are a budget, not a catch-all\",",
      "    );",
      "    assert.equal(",
      "      pwEarly.passDiag(),",
      "      \"setup subreq 29\",",
      "      \"and the stage it died in, with the counter still saying 29 were free\",",
      "    );",
    ),
    replacement: lines(
      "    // (a) The LISTING throws. The setup swallows that on purpose — the loop",
      "    // re-reads, so one failed listing is not a failed pass — so the throw",
      "    // surfaces at the rows re-read. That is the better assertion anyway: it",
      "    // proves the label ADVANCES with the pass instead of sticking at the",
      "    // first stage it ever set.",
      "    const early = boom(\"setup\");",
      "    const pwEarly = termWatcher(early, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);",
      "    await assert.rejects(",
      "      () => pwEarly.runTick(Date.now() + 5_000, undefined, () => 29),",
      "      /Too many subrequests/,",
      "      \"the throw still propagates — the gates are a budget, not a catch-all\",",
      "    );",
      "    assert.equal(",
      "      pwEarly.passDiag(),",
      "      \"rows subreq 29\",",
      "      \"the setup swallowed it and the pass died at the rows re-read — the label ADVANCED, and the counter still says 29 were free\",",
      "    );",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the row-loop case needs a row to walk",
    marker: "The row loop only runs when the listing HAS rows",
    // The first draft returned an EMPTY listing for this case, so the loop had
    // nothing to walk, `claimPushWatch` was never called, and the pass COMPLETED
    // — which reads as "the gates swallowed the throw" and proves nothing. The
    // throw has to come from a row the pass actually walks.
    anchor: lines(
      "      } else {",
      "        db.listPushWatch = async () => [];",
      "        db.claimPushWatch = async () => {",
      "          throw new Error(\"Too many subrequests by single Worker invocation\");",
      "        };",
      "      }",
    ),
    replacement: lines(
      "      } else {",
      "        // The row loop only runs when the listing HAS rows, so an empty",
      "        // listing would leave `claimPushWatch` uncalled and the pass would",
      "        // complete without ever hitting the throw.",
      "        db.listPushWatch = async () => [termRow()];",
      "        db.claimPushWatch = async () => {",
      "          throw new Error(\"Too many subrequests by single Worker invocation\");",
      "        };",
      "      }",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "a thrown pass names its stage, and the err note carries it",
    marker: "a thrown pass names the stage it died in",
    anchor: lines(
      '  await test("PushWatcher: a healthy invocation is unbounded by the probe (room reads no gate)", async () => {',
    ),
    replacement: lines(
      '  await test("PushWatcher: a thrown pass names the stage it died in, with the counter\'s opinion", async () => {',
      '    // The reading this exists for: `err:Too many subrequests by single Worker',
      '    // invocation` on invocations whose counter read 18-27, with nothing saying',
      '    // which stage threw. The stage says where; the number says whether the',
      '    // counter agreed the invocation was full — the one reading that separates a',
      '    // mistuned gate from a counter that cannot see the spend.',
      '    const boom = (stage) => {',
      '      const db = termDb([termRow()]);',
      '      if (stage === "setup") {',
      '        db.listPushWatch = async () => {',
      '          throw new Error("Too many subrequests by single Worker invocation");',
      '        };',
      '      } else {',
      '        db.listPushWatch = async () => [];',
      '        db.claimPushWatch = async () => {',
      '          throw new Error("Too many subrequests by single Worker invocation");',
      '        };',
      '      }',
      '      return db;',
      '    };',
      '',
      '    // (a) It dies in the setup, before a single gate could be consulted.',
      '    const early = boom("setup");',
      '    const pwEarly = termWatcher(early, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      '    await assert.rejects(',
      '      () => pwEarly.runTick(Date.now() + 5_000, undefined, () => 29),',
      '      /Too many subrequests/,',
      '      "the throw still propagates — the gates are a budget, not a catch-all",',
      '    );',
      '    assert.equal(',
      '      pwEarly.passDiag(),',
      '      "setup subreq 29",',
      '      "and the stage it died in, with the counter still saying 29 were free",',
      '    );',
      '',
      '    // (b) It dies later, in the row loop.',
      '    const late = boom("rows");',
      '    const pwLate = termWatcher(late, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      '    await assert.rejects(',
      '      () => pwLate.runTick(Date.now() + 5_000, undefined, () => 3),',
      '      /Too many subrequests/',
      '    );',
      '    assert.equal(pwLate.passDiag(), "rows subreq 3", "the stage tracks the pass, and the number is read at the throw");',
      '',
      '    // (c) A pass with no probe installed must not invent a number — this is',
      '    // every caller and every direct test that predates the two ceilings.',
      '    const plain = boom("rows");',
      '    const pwPlain = termWatcher(plain, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      '    await assert.rejects(() => pwPlain.runTick(Date.now() + 5_000));',
      '    assert.equal(pwPlain.passDiag(), "rows subreq n/a", "`n/a`, not a fabricated count");',
      '  });',
      '',
      '  await test("PushWatcher: passDiag is silent before any pass has run", () => {',
      '    const db = termDb([termRow()]);',
      '    const pw = termWatcher(db, { api: { sendMessage: async () => ({ message_id: 1 }) } }, 2_000);',
      '    assert.equal(pw.passDiag(), null, "no stage, nothing to say — a stale label can never reach a note");',
      '  });',
      '',
      '  await test("Scanner.runTrackerPass: the err note carries the stage and the counter\'s opinion", async () => {',
      '    // The scanner half of the same fix: it is the catch that writes the note,',
      '    // so without this the stage and the count exist but never reach /health.',
      '    const { Scanner } = require("../dist/scanner.js");',
      '    const cfg = loadConfig({});',
      '    const scanner = new Scanner(',
      '      {}, { api: { sendMessage: async () => ({}) } }, null, cfg, null, null, null,',
      '    );',
      '    let asked = 0;',
      '    scanner.pushWatcher = {',
      '      headTokens: () => [],',
      '      onPush: async () => {},',
      '      passDiag: () => {',
      '        asked += 1;',
      '        return "rows subreq 4";',
      '      },',
      '      runTick: async () => {',
      '        throw new Error("Too many subrequests by single Worker invocation. To configure this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/");',
      '      },',
      '    };',
      '    scanner.lastSummary = {};',
      '    const note = await scanner.runTrackerPass(Date.now() + 2_500);',
      '    assert.equal(note, null, "a throw still returns null — the note is telemetry, not a result", );',
      '    assert.match(String(scanner.lastSummary.pushWatch), /^err:Too many subrequests/, "the message is still first");',
      '    assert.match(String(scanner.lastSummary.pushWatch), /\\[rows subreq 4\\]$/, "and the stage plus the counter\'s opinion ride along");',
      '    assert.equal(asked, 1, "the watcher is asked exactly once, in the catch");',
      '',
      '    // A watcher that predates passDiag (a bare test double, an old deploy\'s',
      '    // shape) must not turn a pass failure into a second failure.',
      '    scanner.pushWatcher = {',
      '      headTokens: () => [],',
      '      onPush: async () => {},',
      '      runTick: async () => {',
      '        throw new Error("boom");',
      '      },',
      '    };',
      '    const legacy = await scanner.runTrackerPass(Date.now() + 2_500);',
      '    assert.equal(legacy, null);',
      '    assert.equal(scanner.lastSummary.pushWatch, "err:boom", "no diag, no suffix — the old note verbatim");',
      '  });',
      '',
      '  await test("PushWatcher: a healthy invocation is unbounded by the probe (room reads no gate)", async () => {',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the drift guard for the throw diagnostic",
    marker: "partial paste of docs/patches/tracker-pass-err-diag.apply.js",
    anchor: lines('  console.log("\\n===== UNIT TESTS =====");'),
    replacement: lines(
      '  await test("out-of-window patch: a thrown pass describes itself (docs/patches/tracker-pass-err-diag.apply.js)", () => {',
      '    const strip = (text) =>',
      '      text',
      '        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, "")',
      '        .replace(/\\/\\/[^\\n]*/g, "")',
      '        .replace(/\\s+/g, "");',
      '    const read = (p) => strip(fs.readFileSync(path.join(__dirname, "..", p), "utf8"));',
      '    const pushwatchSrc = read("src/pushwatch.ts");',
      '    const scannerSrc = read("src/scanner.ts");',
      '    const applied = {',
      '      "pushwatch (the stage is held)": pushwatchSrc.includes(\'privatepassStage="none";\'),',
      '      "pushwatch (the probe is held)":',
      '        pushwatchSrc.includes("privatesubreqProbe:(()=>number)|null=null;"),',
      '      "pushwatch (the reader asks at call time)":',
      '        pushwatchSrc.includes("constleft=this.subreqProbe===null?null:this.subreqProbe();"),',
      '      "pushwatch (no probe, no number)":',
      '        pushwatchSrc.includes(\'left===null?"n/a":left\'),',
      '      "pushwatch (every stage is named)": ["entry", "setup", "settle", "heal", "rows", "holders"].every((s) =>',
      '        pushwatchSrc.includes(`this.passStage="${s}";`),',
      '      ),',
      '      "scanner (the note asks the watcher)":',
      '        scannerSrc.includes("constdiag=this.pushWatcher.passDiag?.()??null;"),',
      '      "scanner (the durable note is the same line)":',
      '        (scannerSrc.split("awaitthis.persistPassNote(errNote,startedAt);").length - 1) === 1 &&',
      '        !scannerSrc.includes("awaitthis.persistPassNote(`err:${msg.slice(0,140)}`,startedAt);"),',
      '    };',
      '    const done = Object.entries(applied).filter(([, v]) => v);',
      '    if (done.length === 0) {',
      '      console.log(',
      '        "  ℹ pass throw diagnostic missing - apply docs/patches/tracker-pass-err-diag.apply.js",',
      '      );',
      '      return;',
      '    }',
      '    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);',
      '    // Half a diagnostic is the state that costs the most: the stage exists but',
      '    // the note does not carry it, and /health still cannot say which stage died.',
      '    assert.equal(',
      '      missing.length,',
      '      0,',
      '      `partial paste of docs/patches/tracker-pass-err-diag.apply.js — missing: ${missing.join(", ")}`,',
      '    );',
      '  });',
      '',
      '  console.log("\\n===== UNIT TESTS =====");',
    ),
  },
];

let failed = false;
for (const patch of PATCHES) {
  const text = fs.readFileSync(patch.file, "utf8");
  if (text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const unmet = (patch.needs ?? []).filter((need) => !text.includes(need));
  if (unmet.length > 0) {
    console.error(`NEEDS     ${patch.file}: ${patch.what} — missing ${unmet.join(", ")}`);
    failed = true;
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
  fs.writeFileSync(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchors above");
  process.exit(1);
}
console.log("\nall patches applied");
