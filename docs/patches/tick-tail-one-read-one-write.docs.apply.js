#!/usr/bin/env node
/**
 * `docs/round-trips.md` §4.12 補一句：新增嘅兩個測試叫乜、驗啲乜。
 * （其他 apply script 一樣嘅 semantics；重跑 `0 file(s) written`。）
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  {
    file: "docs/round-trips.md",
    what: "§4.12 names the two tests",
    marker: "**測試**（`scripts/test-unit.js`）：`worker: the whole tick tail is ONE read and ONE write`",
    anchor: lines(
      "**量度**：`heartbeat.summary.dbTickSteps` 會顯示 `readPostScanTelemetry` 1 call",
      "（以前 `getWorkerState` ×2–3 ＋ `getPushAudit` ＋ `listPushWatch` ＋",
      "`readPostScanTelemetry`）同 `setWorkerStatesMany` ≤1 call（以前最多 3 個",
      "`setWorkerState`）。",
    ),
    replacement: lines(
      "**量度**：`heartbeat.summary.dbTickSteps` 會顯示 `readPostScanTelemetry` 1 call",
      "（以前 `getWorkerState` ×2–3 ＋ `getPushAudit` ＋ `listPushWatch` ＋",
      "`readPostScanTelemetry`）同 `setWorkerStatesMany` ≤1 call（以前最多 3 個",
      "`setWorkerState`）。",
      "",
      "**測試**（`scripts/test-unit.js`）：`worker: the whole tick tail is ONE read and ONE write`",
      "（真 client、數 round trip：2；drop ＋ ledger merge ＋ 寫入同一 batch）同",
      "`worker: a rejected tail batch lands nothing and re-offers the delta`（write 被拒 ⇒",
      "連 shrink 都唔會自己一個落地；retry 原封不動再試、唔會 double count；之後閒嘅 tick",
      "只讀唔寫）。多謝 registry 係 module state：兩個測試自己 seed 自己清（`forgetDeferredTokens`），",
      "唔會影響同一個 process 之後嘅測試。",
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
  if (typeof patch.marker === "string" && text.includes(patch.marker)) {
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
