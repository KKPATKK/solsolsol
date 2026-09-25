#!/usr/bin/env node
/**
 * §4.12 之後，三個「單 key sync」（`syncPushLedger` / `syncSkipCaptureState` /
 * `syncBirdeyeCu`）已經**冇生產 caller**：tail 直接呼叫三個 pure planner。佢哋
 * 留低係做測試 seam（同之前一樣 exported），但開頭嘅 doc 仍然寫「called off the
 * pre-race path under a throttle and a race bound」——會令人以為每個 tick 都會
 * 跑。呢個 script 幫三段 doc 各加一句，講清楚生產路徑係 tail。
 *
 * Semantics 同其他 apply script 一樣（marker = 已應用，anchor 唯一，refuse
 * half-patched，重跑 `0 file(s) written`）。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  {
    file: "src/worker.ts",
    what: "syncPushLedger's doc says who calls it now",
    marker: "No production caller any more",
    anchor: lines(
      " * The WRITE is skipped when nothing changed (the common case), so a steady",
      " * tick costs three reads and no write. Called off the pre-race path under a",
      " * throttle and a race bound: telemetry may never extend the invocation, and a",
      " * pass that is bounded away is simply re-offered on the next tick it is due.",
      " */",
      "export async function syncPushLedger(",
    ),
    replacement: lines(
      " * The WRITE is skipped when nothing changed, and the pass itself is off the",
      " * tick's own path: telemetry may never extend the invocation, and a pass that",
      " * is bounded away is simply re-offered on the next tick it is due.",
      " *",
      " * No production caller any more: the tick tail calls this file's PLANNER (see",
      " * planPushLedgerSync / planSkipCaptureSync / planBirdeyeCuSync) inside its one",
      " * read + one write, and this single-key form survives as that planner's test",
      " * seam (scripts/test-unit.js) — the shape it had before §4.12 grouped the tail.",
      " */",
      "export async function syncPushLedger(",
    ),
  },
  {
    file: "src/worker.ts",
    what: "same for syncSkipCaptureState",
    marker: "No production caller any more: the tick tail calls this file's PLANNER (see\n * planSkipCaptureSync",
    anchor: lines(
      " * Same shape as the deferral/ledger syncs: the READ is unconditional (a",
      " * recycled isolate must republish the fleet total rather than its own zero) and",
      " * the persist baseline advances only after a write that actually landed, so a",
      " * failed write re-offers its delta instead of dropping it.",
      " */",
      "export async function syncSkipCaptureState(",
    ),
    replacement: lines(
      " * Same shape as the deferral/ledger syncs: the READ is unconditional (a",
      " * recycled isolate must republish the fleet total rather than its own zero) and",
      " * the persist baseline advances only after a write that actually landed, so a",
      " * failed write re-offers its delta instead of dropping it.",
      " *",
      " * No production caller any more: the tick tail calls this file's PLANNER (see",
      " * planSkipCaptureSync) inside its one read + one write, and this single-key",
      " * form survives as that planner's test seam (scripts/test-unit.js).",
      " */",
      "export async function syncSkipCaptureState(",
    ),
  },
  {
    file: "src/worker.ts",
    what: "and for syncBirdeyeCu",
    marker: "No production caller any more: the tick tail calls planBirdeyeCuSync inside",
    anchor: lines(
      " * Persist this isolate's Birdeye CU delta (see the ledger above). Same",
      " * discipline as the push-ledger and skip-capture syncs: the READ is",
      " * unconditional, and the in-memory delta is only cleared after a write that",
      " * actually landed, so a failed write re-offers it instead of dropping it.",
      " */",
      "export async function syncBirdeyeCu(",
    ),
    replacement: lines(
      " * Persist this isolate's Birdeye CU delta (see the ledger above). Same",
      " * discipline as the push-ledger and skip-capture syncs: the READ is",
      " * unconditional, and the in-memory delta is only cleared after a write that",
      " * actually landed, so a failed write re-offers it instead of dropping it.",
      " *",
      " * No production caller any more: the tick tail calls planBirdeyeCuSync inside",
      " * its one read + one write, and this single-key form survives as that",
      " * planner's test seam (scripts/test-unit.js).",
      " */",
      "export async function syncBirdeyeCu(",
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
