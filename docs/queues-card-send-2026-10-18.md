# 2026-10-18 Queues 接手卡片發送：有咩好處（量到才講）

> 問題原句：「有什麽好處：Queues 接手卡片發送（1M ops/月，現用 0）」
> 前置同類文件：`docs/do-sqlite-shard-2026-10-18.md`（DO SQLite 分流）、
> `docs/round-trips.md` §4.66（"Queues（卡片發送）— 未做，講明為咩"）。
>
> **呢份文件冇改任何 code、冇加 binding、冇 deploy**——只係量測同逐項核對。

## 0. 結論（先講）

**好處係真嘅，但細；代價係推送路徑嘅延遲同重複語意——今日唔值。**

1. **唯一實在嘅好處**：把 Telegram send 由 tick／tracker pass 嘅時間預算拎出去。
   今日 **348 張卡/日**（≈10.4K/月），send 實測 **0.62–1.23s**；初始卡用
   `CANDIDATE_PUSH_RESERVE_MS = 1,500` 買佢嗰個 slice，follow-up 卡食 tracker pass
   5,000ms budget 嘅 0.6–1.2s。搬去 Queue 之後呢兩個預算唔再付呢筆錢。
   但**今日量唔到損失**：pass 現讀 336ms／15 rows、`alerted 0`，tick 亦冇 cut 記錄
   （`cardSend.cut` 0）——所以今日買到嘅係**保險／headroom，唔係修好任何嘢**。
2. **Queue 唔會減 D1 寫入**（今日真正稀缺：10-17 498,490 rows/day = **29.9%/月**）。
   claim、delivery audit、`push_watch` reserve／rollback 全部照寫，仲要為跨 invocation
   嘅 claim 加 lease／heartbeat —— 有機會**多寫**。Queues 嘅 ops 同 D1 嘅 rows written
   係兩個 meter，唔可以互相抵扣。
3. **「1M ops/月」唔係可轉移嘅節省**：348 張/日 → 10,440 msg/月 → **31,320 ops/月
   = 3.1%**（一個 delivery = 3 ops：write+read+delete）。就算 10× 用量（3,480/日）都只係
   31.5%；Workers Free 嘅 Queues 額度（10K ops/day ≈ 3,333 msg/day）都已經裝得落。
   「現用 0」冇浪費任何嘢。
4. **代價係推送語意**：默認 `max_batch_timeout = 5s`（單張卡要等批）、**冇 FIFO 保證**、
   **at-least-once + 默認 3 次 retry**——最後一項正正係 `docs/duplicate-cards.md`（1,095 行）
   一直喺度防嘅嘢。要安全咁用，consumer 每次 send 前都要查 `push_audit` 嘅 token＋sig proof。
5. **今日 1 個 chat、348 張/日：唔值。** 觸發點係 fan-out（≥10 chats 或 >3.5K sends/日）
   或者 `cut` 由 0 變常態；到時先做，做法見 §5。

## 1. 今日量到嘅讀數（2026-10-18 00:4xZ 現讀）

### 1.1 卡片輸出量

| 來源 | 讀數 | 備註 |
|---|---|---|
| `/debug/push-audit` ring | 200 條 / 13.79h → **348 張/日** | kinds：followup 186（~323/日）、initial 12（~21/日）、resend 1、heal-current 1 |
| `/debug/pushes.byDay`（initial 專用） | 最近 6 日 31/25/29/21/37/30 → ~29/日 | 印 initial 卡，唔含 follow-up |

即係**每日 ~350 個 Telegram `sendMessage`**（≈10.4K/月），全部集中喺
**1 個 chat**（`enabledChats: 1`，`/debug/pushes.byChat` 亦只有 530602939）。

### 1.2 一次 send 嘅成本

| 量 | 讀數 | 出處 |
|---|---|---|
| Telegram 真實往返 | **0.62s / 1.23s** | `/debug/test-push` 實測（`docs/scan-completion-loss.md` 量測表） |
| 初始卡嘅 send slice | `CANDIDATE_PUSH_RESERVE_MS = 1,500`——tick deadline 9,600ms 之内，專門留俾 claim + send + audit 嘅窗口 | `src/scanner.ts` |
| Follow-up 卡嘅 pass budget | `TRACKER_PASS_BUDGET_MS = 5,000` | `src/worker.ts` |
| Pass 現況 | 336ms、15 rows、`alerted 0`、`cut0`、`miss 0` | `/health.pushWatchPass` |
| Tick 現況（今日早上 120-tick ring） | ms p50 **858–934**、`dbMs` 150–288、4–7 D1 call | `/debug/tick-legs`；`select1` p50 36ms |
| Subrequest | 17–18/call，limit 10,000 | `/health.heartbeat.subreqs` |

### 1.3 D1 現況（同 Queue 無關但係稀缺資源）

- 10-17：**498,490 rows written/day → 29.9%/月**（`scripts/cf-d1-usage.mjs`，今早讀）。
- `writeCensus` 現讀（00:50Z，窗口 91.5min、2,268 rows）：`token_stats` **73.9%**、
  `push_watch` 13.3%、`worker_state` 11.0%、telemetry（`scan_history`+`tick_legs`）1.3%。
- **卡片路徑嘅 D1 寫入唔會因為 Queue 而少**：`claimTokenPush`、`recordPushDelivery`、
  `push_watch` reserve/rollback 全部照舊；consumer 要跨 invocation 釋放 claim，仲要
  lease/heartbeat 狀態。

## 2. Queues 嘅硬事實（2026-10-18 官方文件查證）

1. **計價**：Workers Paid 每月 **1,000,000 operations included + $0.40/M**；
   「In most cases, it takes **3 operations to deliver a message**: 1 write, 1 read, and 1 delete」
   → 1M ops ≈ **333,333 條 message**，唔係 100 萬條。operation = 每 64KB 嘅
   write/read/delete。
   （<https://developers.cloudflare.com/queues/platform/pricing/>）
2. **交付保證**：**at-least-once**（「in rare occasions, may be delivered more than once」）；
   **唔保證 FIFO**（「Queues does not guarantee that messages will be delivered to a consumer
   in the same order in which they are published」）。
   （<https://developers.cloudflare.com/queues/reference/delivery-guarantees/>、
   <https://developers.cloudflare.com/queues/reference/how-queues-works/>）
3. **Retry／DLQ／retention**：默認 **retry 3 次**（上限 100）；冇 DLQ 就「deleted permanently」；
   Workers Paid retention 默認 **4 日**（60s–14 日）。
   （<https://developers.cloudflare.com/queues/configuration/batching-retries/>、
   <https://developers.cloudflare.com/queues/configuration/dead-letter-queues/>）
4. **Batching／延遲**：`max_batch_size` 默認 **10**、`max_batch_timeout` 默認 **5 秒**
   （範圍 0–60s）；「Whichever limit is reached first will trigger the delivery of a batch」。
   **官方冇典型 end-to-end latency 數字，亦冇 SLA**；`max_batch_timeout` 可以 0，
   但官方唔保證「即時」。（<https://developers.cloudflare.com/queues/configuration/batching-retries/>）
5. **Consumer 係一個 Worker invocation**：「Billing for consumers follows the Workers standard
   usage model」，push consumer 最多 250 併發、wall time 15 分鐘；
   `send()` 會計入 Workers 嘅 **6 條 simultaneous connections** 限制。
   （<https://developers.cloudflare.com/queues/configuration/consumer-concurrency/>、
   <https://developers.cloudflare.com/workers/platform/limits/>）
6. **Free plan 都有 Queues**：10,000 ops/day（≈3,333 msg/day）、retention 24h。
   （<https://developers.cloudflare.com/queues/platform/pricing/>）

## 3. 逐項核對：「好處」清單

| # | 聲稱嘅好處 | 量到嘅實況 | 判 |
|---|---|---|---|
| A | 初始卡唔再食 tick 嘅 send slice | ~21 張/日 × ~0.9s ≈ **19s/日**；slice 1,258ms 還返俾 chain（deco）或者縮短 tick。今日 `cardSend.cut` **0**，即係買保險 | 真，但細 |
| B | Follow-up 卡唔再食 pass budget | ~323 張/日 × ~0.9s ≈ **4.9min/日** 嘅 pass budget；pass 現讀 336ms／5,000ms、`cut0` → 今日唔係瓶頸 | 真，但細 |
| C | 重試／backoff／DLQ 取代 tick 內重試 | 今日已有：transient retry（429/5xx/network，1.2s sleep、tick 內一次）、deferral + re-eval 重推、heal-resend、UNCONFIRMED_CARD_GRACE_MS 120s settle。Queue 3 次 retry 更乾淨，但 **at-least-once 會製造新嘅重複來源** | 一半係換，唔係賺 |
| D | Telegram outage 唔再佔住 tick | 今日已經 bound（slice／deadline）＋ abandoned 三態；queue 令 producer 即返，但問題轉移去 consumer（自己嘅 15min wall time、retry） | 真，但細 |
| E | 用返「1M ops/月」閒置額度 | 31.3K ops/月 = **3.1%**；ops 同 D1 rows written 唔互通，亦唔會令其他服務平啲 | **0 價值** |

## 4. 代價同風險

1. **送達延遲（最硬嘅反對理由）**：平均 4 分鐘先有一張卡，`max_batch_size=10` 永遠裝唔滿
   → 默認 `max_batch_timeout=5s` 之下**每張卡最多等 5 秒**先入 consumer。設 0 可以縮短，
   但官方冇 latency 保證，而且多咗 producer write + consumer read + 一個新 invocation。
   今日 inline send 係 ~0.9s；呢隻 bot 嘅產品就係「快」。
2. **冇 FIFO**：同一 token 嘅 `revive`／`dead`／`up50` 可以倒序或並行（consumer 默認自動 scale，
   最多 250 併發）。要保序就要 `max_concurrency: 1` 或者每 chat 一條 queue（account 上限
   10,000 條）。
3. **At-least-once × 重試 = 重複卡**：`sendMessage` timeout 之後 Telegram 可能已經收到；
   queue retry 會再送一次。要安全就要 consumer 每次 send 前查 `push_audit` 嘅
   token＋sig proof（`docs/duplicate-cards.md` 嘅 `cardProofKey`），即係 dedupe 唔會少做，
   只係換咗個地方做。
4. **狀態機跨 invocation**：`boundClaim` 自釋放 + `UNCONFIRMED_CARD_GRACE_MS` settle 今日
   喺同一個 invocation 內完成；搬去 consumer 就要 lease／heartbeat（D1 寫入 +）。
5. **遲到有機度補行**：今日靠 tick 手上嗰條 `organicRead` promise（`appendLateOrganicLine`）；
   consumer 要自己讀，即多一次 Jupiter 呼叫（rate limit 5 req/~10s）。
6. **新增 surface**：producer／consumer／DLQ／retry 設定／alerting；推送路徑係呢隻 bot
   唯一嘅輸出（§4.66 已定調：唔可以同其他改動一齊盲上）。

## 5. 幾時才值得，同屆時嘅做法

**觸發點（任何一個）**：

- **多過一個 chat／fan-out**：≥10 chats 或 >3.5K sends/日（今日 10×）——Queue 真正嘅價值係
  fan-out 同 per-chat rate-limit pacing（Telegram 20 msg/min/group），今日完全用唔着。
- **`cardSend.cut` / pass `cut` 由 0 變常態**（send 開始慢過 slice，即 duplicate 風險浮現）。
- **需要 per-message retry／DLQ 嘅審計要求**。

**屆時嘅最小做法**：

1. Producer 只 `send()`；claim 照舊留喺 D1（`claimTokenPush`）——consumer 唔可以自己發明 claim。
2. Consumer：`max_batch_timeout: 0`、`max_concurrency: 1`（保 per-token 順序）、send 前查
   `push_audit` proof、成功後寫 audit + 釋放 claim；失敗 3 次入 DLQ。
3. 先 flag 一個 chat 試 24h，量 delivery latency p50/p95 同 duplicate count（`/debug/push-audit`
   有 token＋sig，可以 join）。
4. 更便宜嘅替代方案：**D1 outbox row + 現有 cron retry**（`push_audit` 已經係半個 outbox，
   `unconfirmed` ledger 已有 settle 邏輯）——冇 order／latency 倒退，亦唔使新服務。

## 6. 限制（唔可以當過）

- 348 張/日係 `/debug/push-audit` ring 嘅 **200 條窗口（13.79h）**推導，唔係 Cloudflare
  analytics；initial byDay 係另一個窗（~29/日）。
- send 0.62s／1.23s 係 **2026-09 嘅 `/debug/test-push` 讀數**，今日冇重測（唔想為量測而真送卡）。
- Queue 嘅價格／batching／retry 全部係官方文件數字，**未喺呢個帳戶量過**；假設 ops 對應關係
  （3 ops/message、64KB 以下）成立。
- `writeCensus` 係 per-isolate 窗口，唔等於全日；全日 D1 數以 `scripts/cf-d1-usage.mjs` 為準。
