#!/usr/bin/env node
/**
 * Hold the reservation → final-write span of an alerting row for the tick
 * (docs/duplicate-cards.md §17.5, third bullet).
 *
 * An apply script because src/pushwatch.ts is past the file-tool window (the
 * same reason docs/patches/tracker-pass-batched-consumer.apply.js exists).
 *
 * WHAT WAS OPEN
 * `reservePushWatchAlert` commits the transition BEFORE the send, so between
 * that write and the row's final `updatePushWatchCheck` the row is announced as
 * far as every other isolate can see, with none of the bookkeeping that says
 * so. The watchdog may abandon a pass inside that span (that is what it is
 * for), and an abandoned pass keeps RUNNING — but nothing keeps the ISOLATE
 * alive for it: the instant the handler returns, every promise not handed to
 * `waitUntil` is cancelled. An un-held span therefore ends as a row that is
 * RESERVED BUT UNWRITTEN, which the next pass reads as "already announced" and
 * refuses to re-fire: the silent missing card this subsystem must not have.
 *
 * WHAT IS ADDED
 *  1. `TRACKER_ROW_SPAN_HOLD_MS`, the span's worst case, exported so the suite
 *     can pin the relationship (the same way the flush-retry test pins the
 *     request timeout against the retry window).
 *  2. `PushWatcher.holdRowSpan()`, which hands a promise to the tick's
 *     `waitUntil` and returns the handle that releases it. The hold is BOUNDED
 *     by a timer on purpose: an un-settled promise handed to `waitUntil` would
 *     extend the invocation, which is exactly the stall §17.3 removed, and it
 *     would falsify the watchdog's own premise that every stage is bounded.
 *  3. The hold is created BEFORE the reservation goes out (so that write is
 *     covered too) and released at BOTH of the span's exits — the lost race and
 *     the final write. Every other exit after a won reservation is inside the
 *     alerts loop (`break`) and still reaches the final write, so those two
 *     releases cover the whole span; the timer only ever fires on a path that
 *     already threw.
 */
const fs = require("fs");

const T = "src/pushwatch.ts";
const lines = (...xs) => xs.join("\n");

const cap = "const TRACKER_SEND_CAP_MS = 1_000;";
const capAdd = lines(
  cap,
  "/**",
  " * How long the reservation → final-write span of ONE alerting row may be HELD",
  " * for the tick (see PushWatcher.holdRowSpan and docs/duplicate-cards.md §17.5).",
  " * A row's span is the send window (TRACKER_SEND_CAP_MS) plus the delivery audit",
  " * insert and the final check write, each inside the row leash",
  " * (TRACKER_ROW_LEASH_MS) — the same chain the watchdog's own audit sums, minus",
  " * the claim and the reservation (both of which already landed by then), with",
  " * 1s of slack for timers that fire late.",
  " *",
  " * The hold is bounded ON PURPOSE: it is handed to `waitUntil`, so an",
  " * un-settled promise would extend the invocation — the very stall removed by",
  " * the watchdog — and it would falsify the watchdog's premise that every stage",
  " * of the pass is bounded. The row always reaches its final write (every exit",
  " * after a WON reservation breaks out of the alerts loop and falls through to",
  " * it, and both exits release explicitly), so this timer can only fire on a",
  " * path that already threw, where holding the invocation longer is pure leak.",
  " */",
  "export const TRACKER_ROW_SPAN_HOLD_MS =",
  "  TRACKER_SEND_CAP_MS + 2 * TRACKER_ROW_LEASH_MS + 1_000;",
);

const holdTail = lines(
  "    try {",
  "      keepAlive(promise);",
  "    } catch {",
  "      // A stale/absent execution context must never break the send loop.",
  "      void promise;",
  "    }",
  "  }",
);
const holdAdd = lines(
  holdTail,
  "",
  "  /**",
  "   * Hold the reservation → final-write span of ONE alerting row for the tick,",
  "   * and return the handle that releases it (see holdForTick for the hand-off",
  "   * itself, and TRACKER_ROW_SPAN_HOLD_MS for the bound).",
  "   *",
  "   * WHY (docs/duplicate-cards.md §17.5, third bullet): the reservation commits",
  "   * the transition BEFORE the send, so until the final write this row is",
  "   * announced as far as every other isolate can see, with none of the",
  "   * bookkeeping that says so. The watchdog exists to abandon exactly this kind",
  "   * of pass, and an abandoned pass keeps running — but nothing keeps the ISOLATE",
  "   * alive for it. Losing that span leaves the row reserved-but-unwritten, which",
  "   * the next pass reads as \"already announced\": a silent missing card (the same",
  "   * outcome as never returning at all, which is what this window is).",
  "   *",
  "   * The returned handle is idempotent (the timer and the explicit release may",
  "   * both fire) and always safe to drop: with no tick connection holdForTick",
  "   * discards the promise, and the timer still releases it.",
  "   */",
  "  private holdRowSpan(holdMs: number): () => void {",
  "    let resolve!: () => void;",
  "    let timer: ReturnType<typeof setTimeout> | undefined;",
  "    let released = false;",
  "    const release = (): void => {",
  "      if (released) return;",
  "      released = true;",
  "      if (timer !== undefined) clearTimeout(timer);",
  "      resolve();",
  "    };",
  "    const held = new Promise<void>((r) => {",
  "      resolve = r;",
  "    });",
  "    timer = setTimeout(release, holdMs);",
  "    this.holdForTick(held);",
  "    return release;",
  "  }",
);

const checked = lines(
  "      checked += 1;",
  "      // Authoritative duplicate guard: reserve the state transition",
);
const checkedAdd = lines(
  "      checked += 1;",
  "      // HOLD THE RESERVATION → FINAL-WRITE SPAN (see holdRowSpan and",
  "      // docs/duplicate-cards.md §17.5): the reservation below commits the",
  "      // transition before the send, and only the final write restores the",
  "      // bookkeeping that says so. Created HERE — before the reservation goes",
  "      // out, so that write is covered too — and released at both of the span's",
  "      // exits: the lost race below, and the final write at the row's end.",
  "      const releaseRowSpan = this.holdRowSpan(TRACKER_ROW_SPAN_HOLD_MS);",
  "      // Authoritative duplicate guard: reserve the state transition",
);

const lostTail = lines(
  "          lastMcap: pair.marketCap,",
  "        });",
  "        continue;",
  "      }",
);
const lostAdd = lines(
  "          lastMcap: pair.marketCap,",
  "        });",
  "        // The race was LOST: nothing was announced, so the span is over at",
  "        // once — release it rather than let the timer hold the invocation.",
  "        releaseRowSpan();",
  "        continue;",
  "      }",
);

const finalWrite = lines(
  "      const holdAnnouncements = undelivered > undeliveredBefore;",
  "      await this.db.updatePushWatchCheck(",
  "        row.token,",
  "        checkFields(holdAnnouncements, attempts),",
  "      );",
  "    }",
);
const finalWriteAdd = lines(
  "      const holdAnnouncements = undelivered > undeliveredBefore;",
  "      await this.db.updatePushWatchCheck(",
  "        row.token,",
  "        checkFields(holdAnnouncements, attempts),",
  "      );",
  "      // The span is closed: the reservation and the bookkeeping that says so",
  "      // are both durable, so an abandoned pass can no longer leave this row",
  "      // reserved-but-unwritten (see holdRowSpan).",
  "      releaseRowSpan();",
  "    }",
);

const edits = [
  ["the send cap", cap, capAdd],
  ["holdForTick", holdTail, holdAdd],
  ["the alerting row's claim", checked, checkedAdd],
  ["the lost reservation", lostTail, lostAdd],
  ["the row's final write", finalWrite, finalWriteAdd],
];

let text = fs.readFileSync(T, "utf8");
if (text.includes("holdRowSpan")) {
  console.error("ALREADY   pushwatch: holdRowSpan");
  process.exit(1);
}
for (const [what, oldString] of edits) {
  const at = text.indexOf(oldString);
  if (at < 0) {
    console.error(`MISS      pushwatch: ${what}`);
    process.exit(1);
  }
  if (text.indexOf(oldString, at + 1) >= 0) {
    console.error(`AMBIGUOUS pushwatch: ${what}`);
    process.exit(1);
  }
}
for (const [, oldString, newString] of edits) {
  text = text.replace(oldString, newString);
}
fs.writeFileSync(T, text);
console.log("ok        pushwatch: the reservation → final-write span is held");
