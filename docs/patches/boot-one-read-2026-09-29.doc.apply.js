/*
 * docs/round-trips.md 4.47 for the 2026-09-29 round-trip change (P0-1/2/3).
 *
 * A script for the same reason the code patches are: the doc file is synced
 * through the Vly Daytona path, and its section headers are CJK — an anchor
 * typed through a non-file tool path can come back byte-different without
 * saying so. The anchor here is pure ASCII (the one filename the last line
 * carries, unique in the file) and the insertion point is LINE-based: the new
 * section lands after that line's terminator, so the file's final sentence is
 * never cut in half.
 *
 * Backticks in the section body are written as \u0060 so this file needs no
 * nesting rules of its own.
 *
 * Idempotent.
 *
 *   node docs/patches/boot-one-read-2026-09-29.doc.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "round-trips.md");
let src = fs.readFileSync(file, "utf8");

if (src.includes("## 4.47 ")) {
  console.log("already applied — docs/round-trips.md untouched");
  process.exit(0);
}

const ANCHOR = "docs/tier2-2026-09-28.md";
const at = src.indexOf(ANCHOR);
if (at < 0 || src.indexOf(ANCHOR, at + 1) !== -1) {
  console.error(
    `ANCHOR MISS (${at < 0 ? 0 : 2}+ matches): ${ANCHOR} — expected the last ` +
      `line's one mention`,
  );
  process.exit(1);
}
const eol = src.indexOf("\n", at);
if (eol < 0) {
  console.error("ANCHOR MISS: no line terminator after the anchor");
  process.exit(1);
}

const Q = "\u0060";
const SECTION = `
---

## 4.47 冷 init 嗰 1.0s 唔係 DDL：recycled isolate 嘅 boot 由 4 個 request 收成 1 個；tracker heal 嘅開場由 4 個收成 1 個（2026-09-29）

### 一、量度：init 到底還幾多

live ${Q}/health${Q}（2026-09-29 05:03Z，**${Q}heartbeat.summary${Q}** —— 頂層嗰個 ${Q}summary${Q}
係 ${Q}null${Q}，真嗰份喺 ${Q}heartbeat.summary${Q} 之下）：

${Q}${Q}${Q}
preTick.steps  { bump 0, init 539, gate 0, outage 0, json 0, claim 523 }
preStartMs 538   preRaceMs 523   raceMs 14977
${Q}${Q}${Q}

同日早前另一個 isolate：${Q}preStart 1006ms [bump 0 init 1008 gate 0 outage 0 rest 0]${Q}。
兩次都係 ${Q}preStart == steps.init${Q} —— **cron tick 個 front，就係 ${Q}init${Q} 本身。**

${Q}scripts/test-schema-gate.js${Q}（改之前）釘死「第二次 init（＝recycled isolate）＝三個 batch 加
最多兩個 execute」，即：

| # | request | 內容 |
|---|---|---|
| 1 | ${Q}batch(1 stmt)${Q} | DDL fingerprint marker |
| 2 | ${Q}batch(9 stmt)${Q} | migration flags |
| 3 | ${Q}batch(3 stmt)${Q} | column probe（${Q}COLUMN_PROBE_TABLES${Q} 嘅 ${Q}pragma_table_info${Q}）|
| 4 | ${Q}execute(1 stmt)${Q} | telemetry seed marker（${Q}getWorkerState${Q}）|

而一個 Turso request 喺呢個 Worker 度要幾多？同一份 ${Q}/health${Q} 嘅累計 ${Q}dbSteps${Q}：

| method | calls | 總 ms | ms/call |
|---|---|---|---|
| ${Q}findUntrackedPushesAndLedger${Q} | 68 | 36,568 | **538** |
| ${Q}readPostScanTelemetry${Q} | 65 | 36,070 | 555 |
| ${Q}claimScanLock${Q} | 67 | 23,976 | 358 |
| ${Q}getWorkerState:push_audit${Q} | 90 | 24,981 | **278** |

⇒ **4 × ~250–280ms ＝ 1.0s**。

**所以 fingerprint gate 冇壞**（佢自己嗰條測試仍然釘住「第二次 init 完全唔跑 DDL」）。gate 慳嘅係
**CPU** —— 4.46 嗰條 Workers Free 10ms 線；剩返喺 wall clock 上面嘅，係佢自己嗰四條腿**各自**付嘅
round trip，而四條都係同一個 boot block 問嘅問題。呢個就係「1.0s 唔係 DDL」嘅完整答案。

### 二、修法（P0-3）：一個 boot read

${Q}Db.init${Q} 嗰四個問題合成**一個 batch**（${Q}docs/patches/boot-one-read-2026-09-29.apply.js${Q}）：
marker、九個 flag、${Q}COLUMN_PROBE_TABLES${Q} 每個表一個 probe、seed marker。libsql 嘅 ${Q}batch${Q}
係**一個 HTTP request**（statements 喺同一條連線上順序跑），所以同一個 row set、同一個次序，而家只付
marker 嗰一下。

每個消費者改讀自己嗰個 slice：

- **flags**：${Q}bootRes.slice(FLAG_INDEX, PROBE_INDEX)${Q}。${Q}MIGRATION_FLAG_KEYS${Q} 抽成一個
  list，statement 同索引由同一份資料推出來（${Q}schema_alter_v4${Q} / ${Q}settings_v5${Q} 曾經互換過
  一次，原本個 comment 就係講嗰次）。
- **column probe**：${Q}columnProbeRows${Q} 帶落 ${Q}readColumnNames()${Q}，所以
  ${Q}addColumnIfMissing${Q} 全部由記憶回答，${Q}ALTER${Q} 一個都唔會試（測試釘住 ${Q}alters === []${Q}）。
- **seed marker**：${Q}bootRes[TELEMETRY_INDEX]${Q}。

**帶 probe 落去嘅條件係「fingerprint 對得上」**：唔對嘅話嗰啲 pragma row 係喺 DDL **之前**讀嘅，用佢哋
填 cache 就會對一個 DDL 啱啱加嘅 column 答「唔存在」—— 正是 ${Q}test-schema-gate.js${Q} 存在嘅原因
（靜靜跳過 migration）。唔對就丟咗個 carry，等 lazy probe 喺 DDL 之後跑。

**唯一仍然分開付嘅路徑**：呢個 batch **失敗**（＝${Q}worker_state${Q} 都未存在嘅數據庫）。嗰條路會喺
DDL 之後重讀 flags —— 即係 pre-2026-09-29 嘅形狀，只得一個數據庫會行。

### 三、修法（P0-1/P0-2）：tracker heal 嘅開場

同一個病，下一段：一個 pass 嘅 heal 開場本來係**四個 request**。

| request | 邊度 |
|---|---|
| untracked list ＋ push ledger | ${Q}findUntrackedPushesAndLedger${Q}（已經係一個 batch）|
| ${Q}push_audit${Q} ring → initial-only set | ${Q}getInitialPushAuditTokens${Q} |
| unconfirmed-card record | ${Q}getWorkerState(UNCONFIRMED_CARD_STATE_KEY)${Q} |
| ${Q}push_audit${Q} ring → 整條 ring | ${Q}getPushAudit${Q} |

第 2 同第 4 行係**同一行 row 讀兩次** —— 同一個 moment、同一串 bytes。live ${Q}dbTickSteps${Q}：
${Q}findUntrackedPushesAndLedger 589${Q}、${Q}getWorkerState:push_audit 289${Q}、
${Q}getPushAudit 289${Q} ＝ **1.17s**。

修法（${Q}docs/patches/heal-front-one-read-2026-09-29.apply.js${Q}）：

- ${Q}findUntrackedPushesAndLedger${Q} 加第四個參數（unconfirmed key）。有傳嘅話，**同一個 batch**
  連 ${Q}push_audit${Q} 同 unconfirmed row 一齊帶返嚟：四條 statement、**一個 request**，
  ${Q}proofsCarried: true${Q} 講明。
- ${Q}readDeliveredTokens${Q} 收到嗰兩行 raw，就用**同一套 parser**（${Q}db.parsePushAuditRing${Q} ＋
  ${Q}db.initialPushAuditTokens${Q} ＋ ${Q}deferrallog.deliveredCardTokens${Q} /
  ${Q}parseUnconfirmedCardSends${Q}）算出兩個 set，${Q}trips 0${Q}。

${Q}proofsCarried${Q} 係明示而唔係「${Q}auditRaw${Q} 唔係 undefined」：Db 係窄 double（heal 嗰批測試）
嗰陣，要明明白白話「row 唔喺呢度」，叫佢自己 ${Q}readDeliveredTokens${Q}。所以呢個改動係**兩邊都
additive** —— 所有現存 fixture 行返舊路，逐 byte 一樣。

**唔動嘅嘢**：row loop 嘅 cut-card 讀、unconfirmed settle 嘅讀，各自喺自己嘅 moment 讀，冇 stale 問題。

### 四、驗收

| 睇 | 改之前（2026-09-29 05:0xZ）| 期望（deploy 之後）|
|---|---|---|
| ${Q}summary.preTick.steps.init${Q} | 539 / 1008ms（＝4 個 request）| **~250–350ms（1 個 request）**，${Q}preStart${Q} 跟跌 |
| ${Q}/debug/scan-history${Q} ${Q}ms${Q} p50（全部）| 3,918ms（120 行，03:25–05:24Z）| 跌，幅度 ＝ init 省落嘅幅度 |
| ${Q}/debug/scan-history${Q} p50（${Q}candidates>0${Q}）| 5,218ms（n=57）| 跌同一幅度 |
| ${Q}/debug/scan-history${Q} p50（${Q}candidates==0${Q}）| 3,311ms（n=63）| 跌同一幅度（冷 tick 受益最直接）|
| CFMIN ${Q}wallMax${Q} p50（10 分鐘桶）| 全窗（09-27T19:37 → 09-29T01:51）**3,841,290us**；尾兩小時 6.1–8.0s | 跌 |
| CFMIN ${Q}subrequests${Q} | p50 45–78／分鐘 | 每個有 missing 嘅 heal pass 少 3 |
| ${Q}budgetDrops${Q} / ${Q}fails.*${Q} / ${Q}chainRejects${Q} | 0 / 現狀 / ${Q}[]${Q} | **必須唔可以回退** |

單元測試：${Q}test-unit.js${Q} 430 → **433**（新三條：wide read 一個 request 同 narrow read 唔帶
proof；${Q}deliveredProofFromRows${Q} 同 seam 路徑逐個 token 相同；一個真 pass 行 carried 路徑而 ring
reader 零次調用）。${Q}test-schema-gate.js${Q} 6 → **7**（新一條釘住 boot batch 嘅**成員**，而唔止係
數量）。${Q}npm run test:unit${Q} 全綠。

### 五、界線（老實講）

- **init 嘅 539 對 1008 兩次讀數唔一致**，我冇逐個 isolate 追。如果 539 嗰個真係只付咗兩個 request，
  咁「四個 request」嘅模型對唔上 —— 但 ${Q}preStart == steps.init${Q} 同「request 數由 4 變 1」兩件事
  係測試釘住嘅，所以**省嘅幅度（1 至 3 個 request）先係待 deploy 量度嘅數**。
- 呢個改動**唔會**令 cold tick 變熱：isolate 一樣會 recycle，只係每次 recycle 便宜咗。
- heal 嗰個 ring 讀**每次 pass 都買**（以前係「有 missing 才買」），但佢騎喺一個本來就要出嘅 request
  上面，所以係 0 成本；代價係嗰個 request 嘅 payload 大 ~20KB。
- **未量**：呢次改動嘅 ${Q}wallMax${Q} 前後對比要 deploy 之後由 CFMIN 抽，本文只記錄咗 baseline。
`;

fs.writeFileSync(file, src.slice(0, eol + 1) + SECTION + src.slice(eol + 1));
console.log(`ok: 4.47 appended after byte ${eol}`);
