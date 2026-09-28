/*
 * Tier 1 items 1+2 (2026-09-28): overlap the re-eval pool read and the
 * token_stats prune with the feed fan-out.
 *
 * The read depends on `chats` (read from the scan front) and on nothing the
 * feeds produce, yet it was awaited AFTER the feed phase (700-900ms), so the
 * tick paid its 300-900ms Turso round trip in series — and the prune paid a
 * second one right after it. Both are now dispatched together (the read needs
 * `chats` and the prune needs nothing else) and joined right where they used
 * to run, so every ordering guarantee downstream (prune stamp before the
 * front's ONE write, cache journaling, the pool slice) is unchanged.
 *
 * The pool opts literal is MOVED VERBATIM out of the old block by this script
 * (extracted from the file, `now` -> `poolNow`) instead of being retyped, so
 * the two cannot drift.
 *
 * Idempotent: a second run reports `=` for every edit and exits 0.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const scannerPath = path.join(ROOT, "src", "scanner.ts");

const edits = [];
function ok(name) {
  edits.push(["✓", name]);
}
function same(name) {
  edits.push(["=", name]);
}
function bad(name, why) {
  edits.push(["✗", `${name} — ${why}`]);
}

function count(src, needle) {
  return src.split(needle).length - 1;
}

function replaceOnce(src, name, needle, replacement) {
  const n = count(src, needle);
  if (n === 0) {
    if (count(src, replacement) > 0) {
      same(`${name} (already applied)`);
      return src;
    }
    bad(name, "anchor not found");
    return null;
  }
  if (n > 1) {
    bad(name, `anchor appears ${n} times`);
    return null;
  }
  ok(name);
  return src.replace(needle, () => replacement);
}

function insertBefore(src, name, needle, addition) {
  return replaceOnce(src, name, needle, addition + needle);
}

let src = fs.readFileSync(scannerPath, "utf8");

const CHATS_ANCHOR = `      const chats = front.chats;
      if (chats.length === 0) {
        console.log("[scanner] no chats with push enabled, skipping");
        this.lastSkip = "no-chats-enabled";
        return;
      }
`;

const POOL_HEAD = `      // Re-evaluation pool: tokens never pushed that are nearing or inside
`;
const POOL_TAIL = `          "[scanner] token_stats prune failed:",
          err instanceof Error ? err.message : err,
        );
      }
`;
const OPTS_OPEN = `            : this.getReevalPoolCached(now, {
`;
const OPTS_CLOSE = `        seenChatIds: chats.map((c) => c.chatId),
          }),
`;

const JOIN_MARK = `      const poolJoinStart = Date.now();`;

function extract(s, name, startMark, endMark) {
  const i = s.indexOf(startMark);
  const j = s.indexOf(endMark);
  if (i < 0 || j < 0 || j < i) {
    bad(name, "anchor not found");
    return null;
  }
  return s.slice(i + startMark.length, j);
}

// ---------------------------------------------------------------- 1. summary
const SUMMARY_ANCHOR = `  /** Wall-clock ms for the re-eval pool query + rotation slice. */
  poolMs?: number;
`;
const SUMMARY_ADD = `  /** Wall-clock ms for the re-eval pool query + rotation slice. */
  poolMs?: number;
  /**
   * Wall-clock ms the tick WAITED at the pool join for the read that was
   * dispatched with the feed fan-out (2026-09-28). The read no longer runs in
   * series after the feeds, so this is the RESIDUAL cost to the tick; read it
   * together with poolMs (the read's own duration): poolWaitMs ≈ 0 means the
   * overlap absorbed the read while the feeds ran, poolWaitMs ≈ poolMs means
   * the read was still settling when the feeds finished and it remains this
   * tick's long pole.
   */
  poolWaitMs?: number;
`;

if (src.includes("  poolWaitMs?: number;")) {
  same("summary: poolWaitMs (already applied)");
} else {
  const out = replaceOnce(src, "summary: poolWaitMs", SUMMARY_ANCHOR, SUMMARY_ADD);
  if (out) src = out;
}

// ------------------------------------------------- 2. early dispatch (1 + 2)
if (src.includes("const poolRead = this.fetchFeedCapped(")) {
  same("early: pool read + prune dispatch (already applied)");
} else if (src.includes(JOIN_MARK)) {
  same("early: pool read + prune dispatch (join already applied)");
} else {
  const optsInner = extract(src, "early: pool opts literal", OPTS_OPEN, OPTS_CLOSE);
  const oldStart = src.indexOf(POOL_HEAD);
  const tailAt = src.indexOf(POOL_TAIL);
  if (optsInner === null) {
    // leave src untouched; the errors below will report it
  } else if (oldStart < 0 || tailAt < 0) {
    bad("old pool block span", "head or tail anchor not found");
  } else {
    const oldEnd = tailAt + POOL_TAIL.length;
    const span = src.slice(oldStart, oldEnd);
    for (const needed of [
      "const poolStart = Date.now();",
      "const poolDeadline = Date.now() + POOL_FETCH_BUDGET_MS;",
      "const recentStats = await this.fetchFeedCapped(",
      "await this.fetchFeedCapped(",
    ]) {
      if (!span.includes(needed)) bad("old pool block span", `missing ${needed}`);
    }
    const opts = optsInner.replace(/\bnow\b/g, "poolNow");
    if (!opts.includes("poolNow - RE_EVAL_WINDOW_MS")) {
      bad("early: pool opts literal", "`now` substitution produced no poolNow span");
    } else {
      const EARLY = `
      // Re-eval pool read + token_stats prune, dispatched HERE — with the feed
      // fan-out rather than after it. The read depends on \`chats\` (read from
      // the front above) and on nothing the feeds produce, yet it used to be
      // awaited once the feed phase had already spent 700–900ms, so the tick
      // paid its 300–900ms Turso round trip in series — and the prune paid
      // another one right behind it. Both are in flight across the feeds now;
      // the tick pays only the RESIDUAL wait at the join below (poolWaitMs).
      //
      // Re-evaluation pool: tokens never pushed that are nearing or inside
      // the qualifying age window. The profiles feed only ever contains young
      // tokens, so without this pool a coin would rotate out of the feed
      // before reaching the minimum age (5h) and be lost forever. Bounds use
      // the widest age window across enabled chats plus a margin, so coins
      // are picked up shortly before they qualify and pushed the moment they
      // do.
      const poolNow = Date.now();
      const poolDeadline = poolNow + POOL_FETCH_BUDGET_MS;
      const poolMinAgeMin = Math.min(...chats.map((c) => c.minAgeMinutes));
      const poolMaxAgeMin = Math.max(...chats.map((c) => c.maxAgeMinutes));
      const poolMinMcapUsd = Math.min(...chats.map((c) => c.minMarketCapUsd));
      const poolMaxMcapUsd = Math.max(...chats.map((c) => c.maxMarketCapUsd));
      const poolMinLiquidityUsd = Math.min(
        ...chats.map((c) => c.minLiquidityUsd),
      );
      const poolReadStartedAt = Date.now();
      const poolRead = this.fetchFeedCapped(
        () =>
          // Dead-tick fix 2026-09-13: a budget-tripped tick used to keep
          // spending its full pool race as zombie work after abort() —
          // starting the completion flush that much later against the
          // wall-clock kill. Skip the read when the tick is already over.
          this.shouldStopEarly()
            ? Promise.resolve([])
            : this.getReevalPoolCached(poolNow, {
${opts}          }),
        [],
        poolDeadline,
      );
      // token_stats grows with pump.fun discovery (100+ new coins per scan):
      // prune rows older than the re-eval window that were never pushed —
      // unreachable by the pool query and only wasting storage. Pushed coins
      // keep their rows so /flow and cached verdicts still work. Dispatched
      // beside the read (independent DB calls) so the tick stops paying its
      // round trip in series too.
      const pruneRun = this.fetchFeedCapped(
        () =>
          this.db.pruneOldTokenStats(poolNow - RE_EVAL_WINDOW_MS, this.scanFront),
        undefined,
        poolDeadline,
      );
      // Both are awaited at the join, which not every early return in between
      // reaches; an unhandled rejection from a promise nobody awaits is a
      // worker-level error, so each gets a no-op handler. This does NOT change
      // what \`await poolRead\` sees — a failed read still throws there.
      poolRead.catch(() => undefined);
      pruneRun.catch(() => undefined);
`;
      // Both edits are applied to the ORIGINAL text in one pass: replace the
      // old span with the join, then insert the dispatch after the chats gate.
      const joined = src.slice(0, oldStart) + "@@JOIN@@" + src.slice(oldEnd);
      src = joined.replace("@@JOIN@@", () => JOIN_TEXT());
      const out = insertBefore(
        src,
        "early: pool read + prune dispatch",
        CHATS_ANCHOR,
        EARLY,
      );
      if (out) src = out;
    }
  }
}

function JOIN_TEXT() {
  return `      // THE JOIN for the pool read and the prune dispatched with the feeds
      // above: what is paid here is only the residual wait (poolWaitMs) — the
      // read itself was already in flight while the feeds ran. \`poolMs\` keeps
      // its old meaning (the read's own dispatch → settle duration), so the
      // two together say whether the overlap worked: poolMs ≈ poolWaitMs means
      // the feeds finished first and the read is still this tick's long pole.
      if (this.shouldStopEarly()) return;
      const poolJoinStart = Date.now();
      const recentStats = await poolRead;
      diag.poolMs = Date.now() - poolReadStartedAt;
      diag.poolWaitMs = Date.now() - poolJoinStart;
      try {
        await pruneRun;
      } catch (err) {
        console.error(
          "[scanner] token_stats prune failed:",
          err instanceof Error ? err.message : err,
        );
      }
`;
}

// ------------------------------------------------- 3. drop the stale poolMs
if (src.includes(JOIN_MARK)) {
  const out = replaceOnce(
    src,
    "slice: drop the old poolMs timer",
    `      diag.poolSliced = poolSlice.length;
      diag.poolMs = Date.now() - poolStart;
`,
    `      diag.poolSliced = poolSlice.length;
`,
  );
  if (out) src = out;
  if (/\bpoolStart\b/.test(src)) {
    bad("poolStart leftover", "`poolStart` still referenced");
  } else {
    ok("poolStart fully retired");
  }
} else {
  bad("slice: drop the old poolMs timer", "join not present");
}

if (src.includes("const pruneRun = this.fetchFeedCapped(") && !src.includes("poolRead.catch(() => undefined);\n      pruneRun.catch")) {
  bad("dispatch pairing", "prune dispatch without its no-op catch");
}

const failed = edits.filter(([m]) => m === "✗").length;
const complete =
  src.includes(JOIN_MARK) && src.includes("const poolRead = this.fetchFeedCapped(");

for (const [mark, name] of edits) console.log(`${mark} ${name}`);
if (failed === 0 && !complete) {
  console.log("✗ refused to write: the dispatch and the join are not both present");
  process.exit(1);
}
if (failed === 0) fs.writeFileSync(scannerPath, src);
else console.log("✗ refused to write: an anchor failed");
console.log(`\n${failed === 0 ? "OK" : "FAILED"} (${edits.length} checks)`);
process.exit(failed === 0 ? 0 : 1);
