#!/usr/bin/env node
/**
 * Post-deploy reading for cron-gate-rides-init: `gate` 189ms -> 0 on cron
 * ticks, with the arrival ring still per-minute (deploy cc2fdba, run
 * 35970820168). Also flags the counter-vs-ring rate as an open question
 * instead of claiming it away.
 *
 * Same discipline: exactly one match per replacement, or nothing is written.
 */
const fs = require("fs");

const DOC = "docs/scan-completion-loss.md";

const L = (...lines) => lines.join("\n");

const OLD = L(
  "- ✅ **已改（`cron-gate-rides-init`，未上線）**：`ensureInitialized` 嗰**一次**讀而家帶埋",
  "  cron-arrival 兩個 key（`scheduled_tick_total` / `scheduled_tick_ring`），所以 cadence gate",
  "  正常情況**唔使讀**（`cronGateLoad` 回傳空 list）。仍然係**一個** subrequest（三個 key 同一句",
  "  SQL），但收回 **~190ms** 前置 wall clock。`lastCronKeysRead` 係 `null`（讀超時）時 gate 自己",
  "  讀返 —— 唔會將「超時」當成「ring 係空」，否則 claim batch 會寫一條 ring 落去而丟咗歷史。",
  "  **上線後要讀**：cron tick 嘅 `preTick.steps.gate` 由 189ms 落到 **~0**（同 `bump 0` 一樣），",
  "  而 `scheduled_tick_at` / `scheduled_tick_ring` 照樣每分鐘前進。",
);

const NEW = L(
  "- ✅ **已做（`cron-gate-rides-init`，`cc2fdba` → Deploy Worker run 35970820168 success，~07:41Z 落線）**：",
  "  `ensureInitialized` 嗰**一次**讀而家帶埋 cron-arrival 兩個 key（`scheduled_tick_total` /",
  "  `scheduled_tick_ring`），所以 cadence gate 正常情況**唔使讀**（`cronGateLoad` 回傳空 list）。",
  "  仍然係**一個** subrequest（三個 key 同一句 SQL），但收回 gate 嗰次接觸。",
  "  `lastCronKeysRead` 係 `null`（讀超時）時 gate 自己讀返 —— 唔會將「超時」當成「ring 係空」，",
  "  否則 claim batch 會寫一條 ring 落去而丟咗歷史。",
  "",
  "  **落線讀數（2026-09-24 07:42:34Z 同 07:43:34Z，兩個連續 cron tick）**：",
  "",
  "  | tick（Z） | bump | init | **gate** | claim | preStartMs | preRaceMs | raceMs |",
  "  |---|---|---|---|---|---|---|---|",
  "  | 07:42:34 | 0 | 389 | **0** | 244 | 389 | 244 | 4756 |",
  "  | 07:43:34 | 0 | 216 | **0** | 228 | 216 | 228 | 4772 |",
  "  | （改前，07:11:34Z） | 0 | 187 | 189 | 245 | **376** | 245 | 4755 |",
  "",
  "  即 `gate` 由 **189ms → 0**、前置由 **376ms → 216–389ms**（init 而家包埋嗰兩個 key，所以佢自己",
  "  嗰個數冇變差），cron tick 嘅 DB 接觸由**兩次變一次**。而書簿冇壞：",
  "  `tickRing` **90 條、每分鐘一條**（07:44:34／07:45:34／…／07:48:34）、`scheduledTickAt` 每分鐘",
  "  前進、`gaps []`、`scheduledArrivalUnaccounted false` —— 即係我加嘅「超時唔當 ring 空」守衛",
  "  冇被觸發，ring 亦**冇**被重設成一條。",
  "",
  "  ⚠️ **一個未解嘅旁證（唔係今次改動引起）**：`scheduledTickTotal` 06:47:34Z → 07:48:34Z 只",
  "  **+33**（≈0.54／分鐘），但 `tickRing` 同一段係**每分鐘一條**（90 條 = 90 分鐘）。兩者都係同一批",
  "  4 句 statements 寫落（`scheduledTickStatements`），而 `db.ts:1545+` 嗰條 legacy raw-client path",
  "  亦一樣會 increment —— 即係「counter 慢過 ring」呢個形狀對唔上任何已知寫入路徑。落線後",
  "  07:44→07:48 四分鐘係 +4（= 1.0／分鐘，正常）。所以暫時只可以話：**counter 唔應該再用嚟當",
  "  「cron 投遞率」嘅代理**，要追就要抽一段更長嘅同 counter／ring 對照。",
  "- **仍未做**：`claim` 嗰個 round trip（live 191–279ms，抖動時 1.1–1.2s）—— 前置仲有 ~0.25s。",
);

const text = fs.readFileSync(DOC, "utf8");
const first = text.indexOf(OLD);
if (first < 0) {
  console.error("MISS      doc: the merge's post-deploy reading");
  process.exit(1);
}
if (text.indexOf(OLD, first + 1) >= 0) {
  console.error("AMBIGUOUS doc: the merge's post-deploy reading");
  process.exit(1);
}
fs.writeFileSync(DOC, text.slice(0, first) + NEW + text.slice(first + OLD.length));
console.log("ok        doc: the merge's post-deploy reading");
console.log(`wrote ${DOC}`);
