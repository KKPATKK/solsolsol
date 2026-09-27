// Verify-then-write: §4.41 for the coalescing queue + stale-row retirement.
const fs = require("fs");

const FILE = "docs/round-trips.md";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to) && to.length > 0) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

const SECTION = `
---

## 4.41 Deferred 寫入嘅自我餵養：queue 按 token coalesce ＋ 讀者退休 stale row（2026-09-27）

### 量度（live，2026-09-27 09:49–10:00Z，60s 模式，一切健康）

| 時間 | \`pending\` | \`heldForTracker\` | 本次 calls | \`totals.calls\` | failures |
|---|---|---|---|---|---|
| 09:49:35 | 12 | 12 | 0 | 2 | **0** |
| 09:51:35 | 17 | 17 | 0 | 3 | **0** |
| 09:57:35 | 27 | 27 | 1 | 5 | **0** |
| 10:00:34 | **31** | **31** | 1 | 7 | **0** |

- 增長 **≈ +1.7 條／分鐘**，drain **≈ 0.36 條／分鐘** ⇒ 快 5 倍，而 **\`failures 0\`**、
  冇 durable 錯、冇 entry 被 drop。即係唔關 DB 事：佢只係**永遠冇 room**（每個 entry 都係
  \`heldForTracker\`，見 §4.9 嘅 \`DRAIN_TRACKER_RESERVE = 14\`）。
- 同 §4.9 嗰次係同一條數嘅兩面：當時 drain **食晒** budget（20 條 backlog = 20 個 round trip
  擋喺 pass 前面，撞 3000ms 牆）；加咗上限之後，佢變成**一啲都食唔到**。

### 點解會自己餵自己

兩條 deferred 寫入都由**DB 存住嘅值**決定要唔要寫：

| 寫入 | 判斷 | 未落地時嘅後果 |
|---|---|---|
| \`recordTokenStatsMany\` | \`getTokenStatsMany\` 讀唔到嗰啲當**新幣** | 下一 tick 又當新 ⇒ 再 enqueue |
| \`updateTokenMaxMcaps\` | raise 係同**存住嘅 max** 比 | 下一 tick 又係 raise ⇒ 再 enqueue |

⇒ queue 嘅內容係**同一批 token 嘅重複 entry**，長度無上限（\`while (queue.length > 0)\`，
只有「連續 3 次失敗」才會 drop；starvation 唔算失敗）。

### 修法一：queue 按 token coalesce（\`DeferredBucket\`）

| | 之前 | 之後 |
|---|---|---|
| 一個 queue 單位 | 一次 call（逐字排隊） | 一個 **bucket** = 一個 Db method × 一個 handle |
| 合併規則 | 冇 | 註冊 **first-wins**（\`first_seen_at\` 係池嘅年齡訊號，唔可以俾後嚟嘅 sight 推前）；raises **max-wins**（statement 本身 raise-only，\`max(stored, a, b) ≡ max(stored, max(a, b))\`，0 都算 finite —— 屍體嘅 \$0 LP 就係訊號） |
| 落地次序 | 全體 call order | \`rank\`：註冊（0）**一定**先過 raises（1）——否則 raise 嘅 UPDATE 撲空，high-water 靜靜哋消失 |
| 一次 drain 嘅成本 | backlog 幾長就幾個 round trip | **每個 method 一個**（\`DEFERRED_COALESCE_MAX_PER_CALL = 40\` 個 record 一條 statement；裝唔落嘅留低） |
| 讀數 | \`pending\`（= 條數） | \`pending\` = **owed calls（0–2）**、\`owedTokens\` = **backlog（records）**、\`deferredWriteCount()\` = records |

即係：**backlog 由「幾多個 tick 想要」變成「幾多個 distinct token 未寫」**（有界），
一有 room 就一個 call 追返晒，而重複 entry 呢個增長源頭消失。

### 修法二：stale record 由讀者退休（\`/health\`）

Durable row 只有**寫嗰個 isolate** 會清（\`clearPersistedDrainError\`）⇒ 寫嗰個 isolate 喺
自己復原之前被 recycle，條 row 就永遠企喺度：live 讀到 **2026-09-25 04:09:59Z** 嗰條
（2.2 日前、\`pending 30\`），而後面每一個 drain 都落咗地。\`/health\` 係唯一由**任何** isolate
都睇得到嗰條 row 嘅地方，而且每分鐘被 poll：所以由佢退休自己判為歷史嘅 row ——

- 條件同 \`writeDrainErrorStale\` 用**同一個 predicate**（\`drainErrorIsStale\`），兩者永遠唔會
  對「邊條 row 係歷史」有第二個答案；
- 成本 = **一次事故一次寫**（冇 row 就咩都唔做；**live** 嘅 row 照樣留返俾寫嗰個 isolate 清）；
- 寫入係 \`ctx.waitUntil\`（唔係浮動 promise —— handler 一 return 就會被取消，同 §4.9 嗰個
  100% 失敗嘅形狀一樣）。

### 測試同 mutation

- \`test-unit\`：新測試「the deferred queue coalesces per token」（first-wins、max-wins 兩個
  column、cap 分兩次落地、rank 次序）＋「a drain record is retired once it is history」
  （predicate 邊界 ＋ whitespace-squashed wiring pin）；舊嘅 reserve 測試改成
  calls／records 兩個讀數。
- Mutation：\`absorbFirstWins\` 改 second-wins ⇒ coalescing 測試 fail；\`max\` 改 min ⇒ 同一條
  fail（raise column）；\`rank\` 兩個都 0 ⇒ 次序 pin fail；\`drainErrorIsStale\` 改 \`>=\` ⇒
  邊界 fail；退休嗰句拎走 ⇒ wiring pin fail。

### 驗收（deploy 之後）

1. \`/health.heartbeat.summary.writeDrain\`：\`owedTokens\` 應該係「distinct token 數」而唔係
   單調上升；一有 room（例如 skip 咗 scan 嗰個 tick）就見到 \`calls 1–2\`、\`owedTokens → 0\`。
2. \`pending\` 由兩位數字變成 **0–2**（coalesce 之後佢只數 calls）。
3. 下次有失敗：durable row 多咗 \`owedTokens\`（backlog 嗰個數），而條 row 一過 10 分鐘就會
   由**任何** isolate 嘅 \`/health\` 清走（唔會再見到 2 日前嘅 row）。
`;

const anchor = `**落線紀錄（§4.39）：**`;
if (src.includes("## 4.41 ")) {
  console.log("= §4.41: already applied");
} else if (!src.includes(anchor)) {
  console.log("✗ §4.41: anchor NOT found");
  process.exitCode = 1;
} else if (!src.endsWith("\n")) {
  console.log("✗ §4.41: the file does not end with a newline — refusing to append");
  process.exitCode = 1;
} else {
  src = src + SECTION;
  fs.writeFileSync(FILE, src);
  patched += 1;
  console.log("✓ §4.41: appended");
}

if (patched > 0) {
  console.log(`wrote ${FILE}`);
}
