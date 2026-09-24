#!/usr/bin/env node
/**
 * docs/scan-completion-loss.md still lists "fold `bump` into the claim batch"
 * as 未做 — it landed in `bba1312` (2026-09-23 07:40:48Z, "Spend fewer Turso
 * round trips per invocation, on both sides of the race") and is live-verified
 * 2026-09-24. A stale 未做 list is expensive: it is what made "fold the bump"
 * look like open work again.
 *
 * Same discipline: exactly one match per replacement, or nothing is written.
 */
const fs = require("fs");

const DOC = "docs/scan-completion-loss.md";

const L = (...lines) => lines.join("\n");

/** @type {Array<{label: string, old: string, next: string}>} */
const edits = [
  {
    label: "doc: the bump line is no longer the big head",
    old: L(
      "2. **真正嘅大頭唔喺 preRace，而喺 `bump`：564–749ms**（cron counter 寫，用自己一個 raw `Db` client、",
      "   喺 `ensureInitialized` 之前）。加 `init`（~185ms）+ `gate`（~167ms）= handler 前置 **~0.9–1.1s**，",
      "   即係每個 tick 有大約 1.1–1.3s（entry → race）花喺掃描之前。呢截**唔食** race 窗口，但**食**",
      "   invocation 嘅 wall clock —— 即係「died before completion flush」嗰條線。",
    ),
    next: L(
      "2. **真正嘅大頭唔喺 preRace，而喺 `bump`：564–749ms**（cron counter 寫，用自己一個 raw `Db` client、",
      "   喺 `ensureInitialized` 之前）。加 `init`（~185ms）+ `gate`（~167ms）= handler 前置 **~0.9–1.1s**，",
      "   即係每個 tick 有大約 1.1–1.3s（entry → race）花喺掃描之前。呢截**唔食** race 窗口，但**食**",
      "   invocation 嘅 wall clock —— 即係「died before completion flush」嗰條線。",
      "",
      "   > **2026-09-24 更新：呢個大頭已經回收**（`bba1312`）—— 收喺 `bump` 嗰 564–749ms。live 對照",
      "   > 2026-09-24 07:11:34Z 一個真 cron tick：`steps {bump 0, init 187, gate 189, outage 0, json 0,",
      "   > claim 245}`、`preStartMs **376**`、`preRaceMs 245`、`raceMs 4755`。即係前置由 ~0.9–1.1s 落到",
      "   > **~0.38s**。詳見下面「可以減嘅位」。",
    ),
  },
  {
    label: "doc: the bump fold is done, and what is left of the front path",
    old: L(
      "**可以減嘅位（未做，等決定）：**",
      "",
      "- `bump` 用**獨立** client（`new Db` + 一個 round trip，每 tick 一次連線）≈ 0.6–0.75s/tick。改成搭",
      "  claim batch（+0 round trip）可以直接回收大部分 —— 代價係「init 慢／死 tick 之前就冇咗 cron 到場",
      "  證明」嗰個原始保護（當初正是因為 init 慢而把 counter 提早）。而家有讀數：正常 envelope 係",
      "  3.5–5.0s / 9.5s，死喺 claim 之前嘅 tick 屬罕見。",
      "- `init`（~185ms）+ 首 tick 嘅 gate read 可以合併（兩者都係第一次 DB 接觸）。",
    ),
    next: L(
      "**可以減嘅位：**",
      "",
      "- ✅ **已做（`bba1312`，2026-09-23 07:40:48Z）：`bump` 已經搭入 scan-lock 嘅 claim batch。**",
      "  `Db.scheduledTickStatements`（counter 用 SQL `+1`、timestamp／ring 由 caller 嘅 gate read 帶入）",
      "  經 `claimScanLock(…, cronTick)` 一次過落 —— 即係由「每個 tick 一個獨立 raw `Db` client 嘅",
      "  read **同** write」變成 **+0 round trip ＋ 0 subrequest**。`bumpScheduledTickLegacy` 只剩",
      "  「到唔到 claim」嗰幾條 fallback path 用（`!scanner`、cadence-gate skip、輸咗 lease）。",
      "  **live 驗證（2026-09-24 07:11:34Z，一個真 cron tick）**：",
      "  `steps {bump 0, init 187, gate 189, outage 0, json 0, claim 245}`、`preStartMs 376`、",
      "  `preRaceMs 245`、`raceMs 4755` —— 對比上面 09-21 嗰次 `bump 564–749` ＋ `preStartMs 921–1112`，",
      "  **每個 tick 回收咗 ~0.55–0.74s ＋ 1–2 個 subrequest**；同一時間 `scheduled_tick_total` /",
      "  `scheduled_tick_at` 照樣每分鐘前進（`tickAt` 07:09:34 → 07:10:34 → 07:11:34），即係 counter",
      "  冇因為冇咗獨立 write 而唔見 —— 呢個就係當時「等決定」嗰個代價嘅答案：冇付。",
      "  （另一個 HTTP-driven tick，07:10:26，`bump` 一樣係 0：`preStartMs 566`、`claim 279`。）",
      "- **未做**：`init`（~187ms）＋ 首 tick 嘅 gate read（~189ms）可以合併（兩者都係第一次 DB 接觸），",
      "  再加 `claim` 嗰個 round trip（live 191–279ms，抖動時 1.1–1.2s）—— 前置仲有 **~0.38s** 可以收。",
      "- **要留意（唔係 bug）**：`stampScheduledArrival`（§4.5.3）喺冷 isolate／前任冇 return 嗰啲 arrival",
      "  上多付 **1 個 subrequest**（`scheduled_arrival_total` 04:27Z **39** → 06:47Z **94**）。呢個係故意",
      "  買嘅保險：冇佢就分唔開「cron 冇投遞」同「tick 死喺 init」（實測見過 19 分鐘同 2h42m 嘅 ring 洞），",
      "  唔應該為咗慳一個 subrequest 拆走。",
    ),
  },
];

const text = fs.readFileSync(DOC, "utf8");
let out = text;
let failed = false;
for (const e of edits) {
  const first = out.indexOf(e.old);
  if (first < 0) {
    console.error(`MISS      ${e.label}`);
    failed = true;
    continue;
  }
  if (out.indexOf(e.old, first + 1) >= 0) {
    console.error(`AMBIGUOUS ${e.label}`);
    failed = true;
    continue;
  }
  out = out.slice(0, first) + e.next + out.slice(first + e.old.length);
  console.log(`ok        ${e.label}`);
}
if (failed) {
  console.error("nothing written");
  process.exit(1);
}
fs.writeFileSync(DOC, out);
console.log(`wrote ${DOC}`);
