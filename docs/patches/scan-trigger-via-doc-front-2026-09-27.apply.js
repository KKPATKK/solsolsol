// Verify-then-write: append item 4 to docs/round-trips.md §4.40 (the skipped
// tick's front cost) and the matching acceptance point.
const fs = require("fs");

const FILE = "docs/round-trips.md";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

const anchor =
  "   ＝ `{cron, http, manual}`（滯後一次完成，同 `deferral` 一樣嘅「上次確認寫入」語意）。\n";

const item4 =
  anchor +
  "4. **一個 skip 咗嘅 tick 照樣付 front —— 呢句係觀察，同 §4.39「削 front」係同一條數。**\n" +
  "   front 係 `WEDGE_READ_KEYS` 嗰**一句** read（14 條 key、1 個 subrequest、live 110-266ms），\n" +
  "   而佢同時係 gate 嘅輸入（`scan_heartbeat`）同死 tick 嘅唯一證人（`tick_progress`）—— 冇得\n" +
  "   「先決定唔掃、再讀」。所以 1 個 subrequest 就係「決定今分鐘掃唔掃」嘅價錢。以前呢筆錢好多係白付：\n" +
  "   ~1/3 嘅 tick 讀完 front 就 skip，而每次 skip 又會引一個 HTTP fallback 真掃描（各自再付一次 front，\n" +
  "   再加 ~21 個 subrequest）。兩個改動一齊令呢個比率塌落 —— gate 30s ⇒ tick 幾乎每次真掃\n" +
  "   （skip 由常態變例外），rescue 120s ⇒ ping 唔再接手。**直接讀數**：\n" +
  "   `scanTriggers.cron ÷ scheduled_tick_total` ＝ cron arrival 之中真正掃到嘅比例（1 − skip 率）。\n";

patch("round-trips §4.40 item 4", anchor, item4);

const accFrom = "3. `/health.heartbeat.via` 喺 done 行應該讀 `\"cron\"`。\n";
const accTo =
  accFrom +
  "4. `scanTriggers.cron ÷ scheduled_tick_total` 應該貼近 1（skip 幾乎冇），而 `scanTriggers.http`\n" +
  "   應該平（rescue 只喺真死 cron 嘅時候動）—— 呢兩個數一齊就係「front 有冇白付」嘅答案。\n";

patch("round-trips §4.40 acceptance 4", accFrom, accTo);

// The old acceptance 4 becomes 5.
patch(
  "round-trips §4.40 acceptance renumber",
  "4. 出卡／defer 讀數不變：",
  "5. 出卡／defer 讀數不變：",
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE} (${patched} edit${patched === 1 ? "" : "s"})`);
} else {
  console.log("nothing to write");
}
