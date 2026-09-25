#!/usr/bin/env node
/**
 * 路徑 B 嘅收尾：#1 嘅 repair entry 用錯咗 marker。
 *
 * WHAT WENT WRONG
 *   `tracker-pass-pulse.apply.js` 尾二嗰個 repair entry（「and put it after `const now`」）
 *   嘅 marker 係 `const now = Date.now();\n    beginPassPulse(now);` —— 但佢自己嘅
 *   replacement 會插一段兩行註解喺 `const now` 同個 call 中間，所以**應用完之後 marker
 *   永遠唔會再出現**。結果：每重跑一次就多插一個 `beginPassPulse(now);`（marker 讀唔到
 *   ⇒ 當成未應用 ⇒ 再插）。呢個 script 收尾嗰個坑，順便把重複嘅 block 收返一個。
 *
 * Semantics：跑一次收乾淨，之後每次跑都報 `already`（0 file(s) written）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const FILE = "src/pushwatch.ts";
const BLOCK = lines(
  "    // Open the pulse the worker reads (trackerPassPulse) on the same clock the",
  "    // pass itself runs on: it survives a database that cannot take the note.",
  "    beginPassPulse(now);",
);

const before = fs.readFileSync(FILE, "utf8");
let text = before;
let collapsed = 0;
while (text.includes(`${BLOCK}\n${BLOCK}`)) {
  text = text.replace(`${BLOCK}\n${BLOCK}`, BLOCK);
  collapsed += 1;
}

const copies = text.split(BLOCK).length - 1;
if (copies !== 1) {
  console.error(`refusing: ${copies} copies of the pulse block remain (want exactly 1)`);
  process.exit(1);
}
// The call reads `now`, so it MUST sit under the clock it stamps the pulse with —
// the whole reason the first placement failed to compile (TS2448).
if (!text.includes(`const now = Date.now();\n${BLOCK}`)) {
  console.error("refusing: the pulse block is not directly after `const now = Date.now();`");
  process.exit(1);
}

if (text === before) {
  console.log("already   src/pushwatch.ts: the pass opens its pulse exactly once");
  console.log("\nall patches applied (0 file(s) written)");
  process.exit(0);
}
fs.writeFileSync(FILE, text);
console.log(`ok        src/pushwatch.ts: collapsed ${collapsed} duplicate pulse block(s) to 1`);
console.log("\nall patches applied (1 file(s) written)");
