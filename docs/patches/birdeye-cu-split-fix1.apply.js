#!/usr/bin/env node
/**
 * birdeye-cu-split 嘅第二半：apply script 自己兩個 idempotency marker 太鬆
 * （`birdeyeCuByStats(` 同 `INSERT INTO worker_state"))` 喺檔案內**本來就**
 * 出現 —— 前者係個 helper 嘅定義，後者係另一個測試嘅 stub），所以兩個 hunk
 * 被跳過。呢個 script 補上，內容同原本一模一樣。
 *
 *   1. src/worker.ts：/health 由 tickState 個批次讀兩條 CU row，並輸出
 *      `recentDays` ＋ `byEndpoint`（原本嗰個獨立 `getWorkerState` 讀冇埋）。
 *   2. scripts/test-unit.js：write-down stub 連 batch 都失敗（因為個寫入路徑
 *      已經變成 `setWorkerStatesMany` 一個 batch），否則 rejected write 測試
 *      會以為寫入成功。
 *
 * 另外：本 script 第一版喺 `if (…)` 條件入面留咗一個 trailing comma
 * （`if (a && b,)` 係 syntax error，Node 直接唔起 test-unit.js），所以下面有
 * 一段 repair，把已經寫入嘅壞文字改返好；未來再跑呢個 script 係 no-op。
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const W = "src/worker.ts";
const W_MARKER = "          recentDays: birdeyeCuRecentDays(cuDays),";
const W_ANCHOR = lines(
  "        const rawCu = await db?.getWorkerState(BIRDEYE_CU_STATE_KEY);",
  "        birdeyeCu = {",
  "          ...birdeyeCuStats(parseBirdeyeCuLedger(rawCu ?? null)),",
  "          // This isolate's unpersisted spend is real spend too: the durable",
  "          // row only moves when the throttled sync lands, so the stored",
  "          // total alone under-reads for up to one sync gap.",
  "          pendingCu: birdeyeCuPendingTotal(),",
  "          monthlyMax: cfg?.birdeyeMonthlyCuMax ?? BIRDEYE_MONTHLY_CU_DEFAULT,",
  "        };",
);
const W_REPLACEMENT = lines(
  "        const cuDays = parseBirdeyeCuLedger(",
  "          tickState?.get(BIRDEYE_CU_STATE_KEY) ?? null,",
  "        );",
  "        birdeyeCu = {",
  "          ...birdeyeCuStats(cuDays),",
  "          // This isolate's unpersisted spend is real spend too: the durable",
  "          // row only moves when the throttled sync lands, so the stored",
  "          // total alone under-reads for up to one sync gap.",
  "          pendingCu: birdeyeCuPendingTotal(),",
  "          monthlyMax: cfg?.birdeyeMonthlyCuMax ?? BIRDEYE_MONTHLY_CU_DEFAULT,",
  "          // The month total alone cannot say whether 46K CU of spend is the",
  "          // holder probe, the card path or a debug endpoint — and the probe",
  "          // and the card share `/defi/token_overview`, so only the CALL",
  "          // count (calibratable against Birdeye's own dashboard) plus the",
  "          // pass note's `probe<N>` can separate them.",
  "          recentDays: birdeyeCuRecentDays(cuDays),",
  "          byEndpoint: birdeyeCuByStats(",
  "            parseBirdeyeCuByLedger(tickState?.get(BIRDEYE_CU_BY_STATE_KEY) ?? null),",
  "          ),",
  "        };",
);

const T = "scripts/test-unit.js";
const T_MARKER = "        // The write half now goes through setWorkerStatesMany (one batch for";
const T_ANCHOR = lines(
  "        execute: (a) => {",
  "          if (String(a.sql).includes(\"INSERT INTO worker_state\")) {",
  "            throw new Error(\"write down\");",
  "          }",
  "          return t.client.execute(a);",
  "        },",
  "        batch: (a, m) => t.client.batch(a, m),",
  "        close: () => t.client.close(),",
  "      };",
);
const T_REPLACEMENT = lines(
  "        execute: (a) => {",
  "          if (String(a.sql).includes(\"INSERT INTO worker_state\")) {",
  "            throw new Error(\"write down\");",
  "          }",
  "          return t.client.execute(a);",
  "        },",
  "        // The write half now goes through setWorkerStatesMany (one batch for",
  "        // both CU rows), so \"the write is down\" has to fail the BATCH too —",
  "        // otherwise this stub would let a rejected write land.",
  "        batch: (a, m) => {",
  "          if (",
  "            m === \"write\" &&",
  "            a.some((s) => String(s.sql).includes(\"INSERT INTO worker_state\"))",
  "          ) {",
  "            throw new Error(\"write down\");",
  "          }",
  "          return t.client.batch(a, m);",
  "        },",
  "        close: () => t.client.close(),",
  "      };",
);
// The broken text the first version of this script wrote (trailing comma).
const T_BROKEN = lines(
  "            a.some((s) => String(s.sql).includes(\"INSERT INTO worker_state\")),",
  "          ) {",
);
const T_BROKEN_FIXED = lines(
  "            a.some((s) => String(s.sql).includes(\"INSERT INTO worker_state\"))",
  "          ) {",
);

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;
const once = (text, needle) => text.split(needle).length - 1;

function patch(file, marker, anchor, replacement, what) {
  const text = bufferOf(file);
  if (text.includes(marker)) {
    console.log(`already   ${file}: ${what}`);
    return;
  }
  const at = text.indexOf(anchor);
  if (at < 0) {
    console.error(`MISS      ${file}: ${what}`);
    failed = true;
    return;
  }
  if (once(text, anchor) !== 1) {
    console.error(`AMBIGUOUS ${file}: ${what}`);
    failed = true;
    return;
  }
  buffers.set(file, text.replace(anchor, replacement));
  console.log(`ok        ${file}: ${what}`);
}

patch(W, W_MARKER, W_ANCHOR, W_REPLACEMENT, "/health reads both CU rows from its own batch");
patch(T, T_MARKER, T_ANCHOR, T_REPLACEMENT, "the write-down stub fails the batch too");

// Repair the trailing comma the first version of this hunk left behind.
{
  const text = bufferOf(T);
  if (text.includes(T_BROKEN)) {
    if (once(text, T_BROKEN) !== 1) {
      console.error(`AMBIGUOUS ${T}: the trailing-comma repair`);
      failed = true;
    } else {
      buffers.set(T, text.replace(T_BROKEN, T_BROKEN_FIXED));
      console.log(`ok        ${T}: the trailing comma inside the if condition is gone`);
    }
  } else {
    console.log(`already   ${T}: no trailing comma to repair`);
  }
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
