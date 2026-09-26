#!/usr/bin/env node
/*
 * Round 6 follow-up: the honest caveat on the seed's placement.
 *
 * The profiles fetch is dispatched ABOVE the front read (profilesCall is
 * created before it), so a refusal that lands before the read returns sees no
 * seeded list. That is exactly the pre-change behaviour, never worse — but the
 * comment next to the seed has to say so, or the next reader will assume the
 * seed is guaranteed to be in place before the fetch can refuse.
 *
 * Run: node docs/patches/round6-caveat-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "..", "src", "scanner.ts");
const src = fs.readFileSync(p, "utf8");

const old = j(
  "      // earliest point in the tick that already has the row in hand. The stamp",
  "      // is kept beside the seed so a reused list never re-writes itself.",
);
const next = j(
  "      // earliest point in the tick that already has the row in hand. The stamp",
  "      // is kept beside the seed so a reused list never re-writes itself.",
  "      //",
  "      // One honest caveat: the profiles fetch is dispatched ABOVE this read",
  "      // (see profilesCall), so a refusal that lands before this point returns",
  "      // sees no seed and falls back to the make-up lane — exactly the old",
  "      // behaviour, never worse. Measured, a 429 on the shared egress answers in",
  "      // 200-500ms while the front read settles in ~90-110ms, so the seed wins",
  "      // that race on the common tick.",
);

const already = src.includes("One honest caveat: the profiles fetch is dispatched");
if (already) {
  console.log("= scanner.ts: caveat already present");
  process.exit(0);
}
const count = src.split(old).length - 1;
if (count !== 1) {
  console.error(`✗ scanner.ts: anchor found ${count} times (need exactly 1)`);
  process.exit(1);
}
fs.writeFileSync(p, src.replace(old, next));
console.log("✓ scanner.ts: caveat added");
