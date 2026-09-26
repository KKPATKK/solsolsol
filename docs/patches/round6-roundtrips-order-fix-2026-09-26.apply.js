#!/usr/bin/env node
/*
 * Order fix: §4.35 was spliced inside §4.34's closing paragraph.
 *
 * §4.35's anchor was the first two lines of §4.34's 「② 嘅 live 讀數」paragraph,
 * so its three remaining lines stayed at the end of the file — and §4.36 then
 * landed between them too. Put them back under their own paragraph, ahead of
 * §4.35, and take them off the tail.
 *
 * Run: node docs/patches/round6-roundtrips-order-fix-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "round-trips.md");
let src = fs.readFileSync(p, "utf8");

const tail = j(
  "即係 slice 13 之後**每個 pass 出到 0–1 張卡**（之前 0 張），`heal-yield` 標籤同 `repair … fixed0` 都見到 = 新 build 真係行緊；",
  "但 19–26 行仍然帶卡被拒（backlog 遠大於一個 pass 清得完嘅量），所以下一條槓桿（claim＋reserve 合併，4 → 3／卡）",
  "照舊係真正嘅吞吐修法。",
);

// ---- 1. off the tail (the stray copy is the last thing in the file) --------
if (!src.endsWith(tail + "\n")) {
  console.log("= round-trips.md: no stray tail block at the end — nothing to fix");
  process.exit(0);
}
const tailCount = src.split(tail).length - 1;
src = src.slice(0, src.length - tail.length - 1);

// ---- 2. home: directly under the paragraph it belongs to ------------------- 
const paraHead = j(
  "`ok:11/0 rows 11/30 … subreq-cut 19`（22:58:13Z）；deploy 前同一形狀係 `ok:9/0 rows 9/30 … subreq-cut 21`。",
  "",
  "### §4.35 seed 個 race 收口",
);
const headCount = src.split(paraHead).length - 1;
if (headCount !== 1) {
  console.error(`✗ §4.34/§4.35 seam found ${headCount} times (need exactly 1) — refusing`);
  process.exit(1);
}
src = src.replace(
  paraHead,
  j(
    "`ok:11/0 rows 11/30 … subreq-cut 19`（22:58:13Z）；deploy 前同一形狀係 `ok:9/0 rows 9/30 … subreq-cut 21`。",
    tail,
    "",
    "### §4.35 seed 個 race 收口",
  ),
);

const after = src.split(tail).length - 1;
if (after !== 1) {
  console.error(`✗ after the move the block appears ${after} times (need exactly 1) — refusing`);
  process.exit(1);
}
fs.writeFileSync(p, src);
console.log(
  `✓ round-trips.md: §4.34's closing lines are back under their own paragraph (stray copies removed: ${tailCount})`,
);
