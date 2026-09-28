/*
 * Fix-up for tier1-overlap-2026-09-28.apply.js: that script INSERTED the pool
 * read/prune dispatch before the `chats` gate instead of after it, so the
 * block referenced `chats` in its temporal dead zone. This moves the block to
 * directly below the gate (which is where it belongs: a tick with no enabled
 * chats must not dispatch a pool read at all).
 *
 * Anchor-based, marker-guarded, idempotent (a second run reports `=`).
 */
const fs = require("fs");
const path = require("path");

const scannerPath = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(scannerPath, "utf8");

const HEAD = `      // Re-eval pool read + token_stats prune, dispatched HERE`;
const TAIL = `      pruneRun.catch(() => undefined);
`;
const GATE = `      const chats = front.chats;
      if (chats.length === 0) {
        console.log("[scanner] no chats with push enabled, skipping");
        this.lastSkip = "no-chats-enabled";
        return;
      }
`;

const headAt = src.indexOf(HEAD);
const tailAt = src.indexOf(TAIL);
if (headAt < 0 || tailAt < 0 || tailAt < headAt) {
  console.log("✗ anchors not found (head %s, tail %s)", headAt, tailAt);
  process.exit(1);
}
const gateAt = src.indexOf(GATE);
if (gateAt < 0) {
  console.log("✗ chats gate not found");
  process.exit(1);
}

// Body runs to the end of its own line, plus the blank line it carries.
let bodyEnd = tailAt + TAIL.length;
if (src[bodyEnd] === "\n") bodyEnd += 1;
const body = src.slice(headAt, bodyEnd);

if (headAt > gateAt) {
  // Already after the gate: verify it is directly below it.
  const gateEnd = gateAt + GATE.length;
  if (src.slice(gateEnd, headAt).trim() === "") {
    console.log("= dispatch already sits below the chats gate");
    process.exit(0);
  }
  console.log("✗ dispatch is after the gate but not adjacent — refusing to guess");
  process.exit(1);
}

const without = src.slice(0, headAt) + src.slice(bodyEnd);
// Re-locate the gate in the shortened text (its offset may have shifted).
const g2 = without.indexOf(GATE);
if (g2 < 0) {
  console.log("✗ chats gate lost while removing the block — not writing");
  process.exit(1);
}
const insertAt = g2 + GATE.length;
const out = without.slice(0, insertAt) + "\n" + body + without.slice(insertAt);

if (out.split(HEAD).length - 1 !== 1) {
  console.log("✗ expected exactly one dispatch block after the move — not writing");
  process.exit(1);
}
if (out.indexOf(HEAD) < out.indexOf(GATE)) {
  console.log("✗ block still precedes the gate — not writing");
  process.exit(1);
}
fs.writeFileSync(scannerPath, out);
console.log("✓ moved the dispatch below the chats gate");
