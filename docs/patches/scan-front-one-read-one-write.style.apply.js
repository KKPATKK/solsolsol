#!/usr/bin/env node
/**
 * `scan-front-one-read-one-write.apply.js` 嘅一個排版收尾：`stampFront` 同下一個
 * member 之間漏咗一行空行（Vly file tool 改唔到 src/scanner.ts，所以照舊用 apply
 * script）。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const FILE = "src/scanner.ts";

const ANCHOR = lines(
  "    await this.db.setWorkerState(key, value);",
  "  }",
  "  /**",
  "   * Why the last runOnce returned without a summary (early-return reason),",
);

const REPLACEMENT = lines(
  "    await this.db.setWorkerState(key, value);",
  "  }",
  "",
  "  /**",
  "   * Why the last runOnce returned without a summary (early-return reason),",
);

const MARKER = lines("    await this.db.setWorkerState(key, value);", "  }", "", "  /**");

const text = fs.readFileSync(FILE, "utf8");
if (text.includes(MARKER)) {
  console.log("already   src/scanner.ts: the blank line is there");
  console.log("\nall patches applied (0 file(s) written)");
  process.exit(0);
}
const at = text.indexOf(ANCHOR);
if (at < 0) {
  console.error("MISS      src/scanner.ts: the blank line is there");
  process.exit(1);
}
if (text.indexOf(ANCHOR, at + 1) >= 0) {
  console.error("AMBIGUOUS src/scanner.ts: the blank line is there");
  process.exit(1);
}
fs.writeFileSync(FILE, text.replace(ANCHOR, REPLACEMENT));
console.log("ok        src/scanner.ts: the blank line is there");
console.log("\nall patches applied (1 file(s) written)");
