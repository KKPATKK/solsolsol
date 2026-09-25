# 推送基準帳（Push Baseline Ledger）

> 2026-09-19。為咗回答「7/39 行推送市值超出 band」而做，順手令調參唔再受
> heal / band 變更污染。

## 問題（舊行為）

`push_watch.mcap_at_push` 有**三個 writer**，只有一個係閘門值：

| # | writer | 寫入的值 | 可否同 band 比 |
|---|---|---|---|
| 1 | `scanner.ts` `onPush(c.pair.marketCap)` | 過閘嘅同一個 frozen pair 值 | ✅ |
| 2 | `pushwatch.ts` self-heal 補掛 | **heal 嗰一刻**嘅市值 | ❌（$45K 推、插水後補掛 → $12K baseline） |
| 3 | `pushwatch.ts` 死而復生重置 | 復活嗰一刻嘅 live mcap | ❌ |

再加兩樣：

- band 係 per-chat DB override（live 係 **$60K–$230K**，code default 係
  $40K–$380K），而 `push_watch` 係 26h 滾動窗 → 同一份數據用唔同尺睇會得出
  3/37 或 15/37 兩種「超 band」答案（`chat_settings` 冇 `updated_at`，
  `push_watch` 冇錄當時 band，所以逐行無法還原）。
- `PairInfo.marketCap` 係三個來源混合：DexScreener 流通市值 / Jupiter
  `mcap || fdv` / GeckoTerminal `fdv_usd`。`market_cap_usd` 對 Solana meme 幣
  通常係 null，所以一條腿會攞 FDV —— Tilcayo `$1,591,544` baseline 對
  token 統計 `$341K`（4.67×，典型流通比例）就係 FDV 被當成市值。

## 解決（新行為）

`src/pushledger.ts`（純函數）＋ `worker_state.push_ledger`（同一路徑已有
`push_audit` / `push_deferral` 先例）。每個推送幣一條**不可變**記錄：

- `mcapAtPush`：閘門當時見到嘅值（來源 `initial-send` = 送卡 audit 記錄，
  權威；`watch-row` = 只喺 `push_watch` 第一次見到，可能已被改寫）
- `bandMin` / `bandMax` / `bandAt`：當時生效嘅 band（送入卡 ≤ 6h 內、或 row
  ≤ 5 分鐘內被觀察到才蓋印；否則**唔蓋**，列為 `unbanded`，唔會亂報超 band）
- `rowMcapAtPush` / `baselineMovedAt`：row 現值同記錄值唔一致 → 即係被
  heal / 復活改寫過（原本值永遠保留）

Tracker 嘅 self-heal 亦改成用帳本嘅**真推送值**做 baseline（冇記錄才退回
當前市值），所以之後補掛唔會再污染倍數。

## 點讀

```bash
curl -s https://solana-meme-bot.cool1999k.workers.dev/health \
  | jq '.heartbeat.pushLedger'
```

| 欄位 | 意思 |
|---|---|
| `entries` | 帳本條數（上限 240 條 / 7 日） |
| `authoritative` | 有 audit 權威值嘅條數（其餘為 `watch-row`，可信度較低） |
| `outOfBandCount` / `outOfBand[]` | **well-defined** 超 band 數：只計有 band 印嘅行，並列最多 12 個 token |
| `rewrittenCount` / `rewritten[]` | baseline 被改寫過嘅行，附 `mcapAtPush`（原值）→ `rowMcapAtPush`（現值） |
| `unbanded` | 冇 band 印（推送早於本功能 / 觀察太遲）→ 調參時應排除 |
| `band` | 最新一次觀察到嘅 band |
| `updatedAt` / `ageMs` | 帳本最後變更時間（同步每 5 分鐘一次，無變化唔會寫 row） |

調參只取 `authoritative` 且非 `unbanded` 嘅條數，就唔會再受 band 變更、
heal、復活污染。

## 點證明 self-heal 用嘅係真推送值（2026-09-19 補）

呢一項以前**完全無法觀察**：heal 寫落嘅 row 同正常掛牌一模一樣，而修好之後
佢亦唔會再產生帳本會 flag 嘅 divergence。所以而家有兩層證據：

| 位置 | 睇乜 |
|---|---|
| `/health.heartbeat.heal` | `{enrolled, fromLedger, fromCurrentMcap, lastAt}`（isolate 累計；pre-race heartbeat） |
| `/health.heartbeat.pushLedger.heal` | 同兩個數字，喺 **completion** heartbeat 亦帶（兩個 phase 都讀得到） |
| `/debug/push-audit` | `kind: "heal-ledger"` = 補掛時用咗帳本嘅推送值；`kind: "heal-current"` = 帳本冇記錄，退回當前市值（唯一仍會 unbanded 嘅情況）。每次 heal **一個** entry（唔係每幣一個 —— audit ring 只有 30 格，而帳本要對住佢 reconcile） |

副作用（要知）：`rewrittenCount` 而家主要代表**死而復生重置**，或者「早過帳本嘅幣」嘅 heal —— 因為 heal 已經改用推送值，唔再改寫 baseline。

## 被扣住嘅候選：`stalledTotal`（2026-09-19 補）

「有候選但冇推送」以前**有一半冇入帳**。一張卡被扣住有兩個位置：

| 階段 | 之前有冇計 |
|---|---|
| **claim**：卡片臨送出但冇 send slice（`cardSendDeadline`） | ✅ `deferredTotal` |
| **chain**：candidate 迴圈喺自己嘅 deadline break（`chain deadline reached — deferring N candidate(s)`），連 claim 都未到 | ❌ 只寫 log，冇任何 counter |

所以 `candidates 1, pushed 0` 嘅 tick 可以長期多過 deferral 計數（live 2026-09-19：
118 個 tick 中 33 個，而 deferral 只有 5–6/小時），而 /health 完全睇唔到。

```bash
curl -s https://solana-meme-bot.cool1999k.workers.dev/health \
  | jq '.heartbeat.deferral | {stalledTotal, firstStallAt, lastStallAt, deferredTotal, recoveredTotal, pending}'
```

| 欄位 | 意思 |
|---|---|
| `stalledTotal` | **完成**嘅 tick 結束時「手上有合格幣、但一張卡都冇送出」嘅幣數（累計） |
| `firstStallAt` / `lastStallAt` | 第一次 / 最近一次嘅時間戳 |
| `events[].stalled` | 每個 tick 嘅數字，所以「有幾多個 tick 被扣住」可以由 ring 直接數 |

點計：`max(0, candidates − pushed − cardSendDeferred)`，只計 `pushPhase === "done"`
嘅 tick（被 race 砍斷嘅 tick 只會出 inflight summary，phase 停喺 `send:claim`／
`tracker`，唔會入帳）。減 `cardSendDeferred` 係因為被拒嘅卡已經入 `deferredTotal`，
而**減咗仍然要計**：同一 tick 可以既拒一張卡、又扣住另一張（全部扣就唔計嘅寫法會漏咗後者）。

**限制（要知）**：呢個係 chain 階段 deferral 嘅**下界**。summary 分唔開「chain break」同
「每個已開啟 chat 都已經收過呢個幣」（seen-check 直接 skip，冇 counter）；兩者都係
「手上有幣、冇送卡」。所以讀嘅時候同 `deferredTotal` 一齊睇：兩者相加就係每次
到咗 push 階段嘅 tick 嘅 `candidates − pushed`。

## 卡片點解送唔出：`summary.phases` / `modeRead` / `feedMakeup`（2026-09-19 補）

`candidates 1, pushed 0` 以前**講唔出**時間去邊。scanner 每個階段都有 stamp，但
只留**最後一個**（`pushPhase` / `pushPhaseMs`），而完成路徑會用 `done` 蓋咗它，
所以一張被扣嘅卡同一張成功嘅卡由外面睇一模一樣。現在每 tick 喺
`/health.heartbeat.summary` 帶三組：

| 欄位 | 意思 |
|---|---|
| `phases[]` | **整條** tick 嘅階段時間線（最新 12 個，`{phase, ms}`）——被扣嘅卡最後一個 stamp 就係用完鐘嘅一步，`ms` 就係同 claim 窗口（3550ms）嘅距離 |
| `modeRead` | trade-mode 讀取：`{reads, reuses, timeouts, lastReadMs, cachedAgeMs}`。`reuses` 上升 = 卡尾嗰個讀取已經唔收錢 |
| `feedMakeup` | feed 真相：`{feedRequests, lastRawProfiles, emptyFeedTotal, lastEmptyFeedAt, failedTotal, lastFailedAt, injectedTotal, lastInjected}`（`failedTotal` = fetch 冇回應／超時，見下文第三補） |

**改咗乜（第 1 點）**：`effectiveMode()` 以前喺 render／claim 之前**無界**讀 Turso，
即係坐响嗰 400ms claim slice 中間。現在 worker 喺**tick 開始**就 prefetch（`onTickStart`），
卡尾嗰個 call 係 cache hit；每個讀取亦硬性界限 250ms（超時就用 env mode —— 同原本嘅
fail-safe 一樣，唔會用未證實嘅 mode）。成本：**跨 isolate** 嘅 `/setmode` 最多 15 秒生效
（同一個 isolate 即時，`setModeOverride` 會寫穿 cache）。

**改咗乜（第 2 點）**：`profiles 0` 嘅 tick 以前刻意**唔注入** make-up（為咗保留
`profiles: 0` 呢個故障訊號），代價係冷啟動 isolate 嗰幾個 tick 冇補推機會
（118 tick 中 7 個，其中 5 個喺 deploy 後 2 分鐘內）。現在**照注入**，訊號搬到
`feedMakeup.lastRawProfiles`（0 = 一樣嘅意思）同 `emptyFeedTotal`（跨 tick 累計）。

> **⚠️ 更正（2026-09-19，同日稍後）**：上面「冷啟動、feed 回空」嘅因果**估錯**。
> Live 追查發現嗰啲 `profiles 0` tick 係 **429 → fetch 根本冇回應**，注入點（喺
> dex fetch 成功路徑內）被完全繞過 —— `emptyFeedTotal` 一直係 0 就係證據。
> 詳見下節；`061f4f6` 呢個修正本身冇錯（空 feed 亦應該注入），但佢解唔到 prof0。

## 卡片點解送唔出：DB 寫入批次搬出 tick（2026-09-19 再補）

**量到嘅事實**：pair budget 由 1250 → 1000ms 之後，`evalMs` 仍然 2.0–3.7s，
`cand>0 & pushed=0` 照樣出現。即係前段貴嘅唔係 pair fetch，而係 pair fetch 同 gates
之間其餘嘅 Turso round trip。

**改咗乜**：tick probe 加咗一個 DB seam（`src/tickprobe.ts`）——

| DB 動作 | 之前 | 現在 |
|---|---|---|
| `getTokenStatsMany`（gates 要讀） | tick 內 await | **照舊** await，只係計時 |
| `recordTokenStatsMany`（登記） | 喺 pair fetch 之後、gates 之前 await | 交返已 resolve 嘅 promise，真呼叫入 FIFO queue |
| `updateTokenMaxMcaps`（max mcap raise） | 同樣位置，順序喺登記之後 | 入同一條 queue（順序保留） |

worker 喺 tick 完結時 `void drainDeferredWrites()`（**唔** await）——即係兩個寫入嘅
round trip 完全離開 tick。Scanner 側冇改一行：佢嘅 in-memory map 照舊有數據，
`dbDegraded: "stats-write"` 呢個訊號改由 drain 用 `writeDrain.failures` 報。

**睇 live**：

```bash
curl -s .../health | jq '.heartbeat.summary | {dbSteps, writeDrain}'
curl -s .../health | jq '.heartbeat.summary | {phases, candidates, pushed, cardSendDeferred}'
```

- `dbSteps.<method> = {calls, ms}`：累計每步真實成本（deferred 寫入係喺 drain 時量）
- `writeDrain = {calls, ms, at, failures, totals}`：`ms` 係 drain 本身用幾耐，`at` 係最後
  一次**真正** drain 嘅時間；空 drain 係 `calls: 0` 但保留 `at`（分得清「冇嘢做」同「從未 drain」）
- 成功嘅簽名：`phases` 最後幾個 stamp 由 `deferred`／`send:claim` 變成有 `send:telegram`，
  之後照有 `tracker`／`done`，而 `cardSendDeferredTotal` 停止上升

**要老實講**：

1. Claim 窗口**仍然係 3550ms**（`CARD_SEND_FLOOR_MS = 600` < 650 = claim + 最少 send）。
   呢個 boundary 由 `scripts/test-unit.js` 一個 assertion 釘死（`cardClaimDeadline(t0, t0 + 3_551)`
   必須係 null），而嗰個位置喺檔案編輯窗口外 —— 所以今次改嘅係**延遲**（把寫入搬走），
   唔係放寬 boundary。
2. Deferred 寫入係 fire-and-forget：isolate 若喺 drain 落地前被回收，同一批呼叫會留到
   **下一個 tick** 嘅 drain（FIFO、順序保留、呼叫本身 idempotent）。代價係登記／
   max mcap 可能遲一個 tick —— scanner 嘅 read guard 本來就接受「一個 tick 冇登記」。

## 卡片點解送唔出：feed lane 嘅自我預算（2026-09-19 第三補）

**量到嘅事實**：deploy 之後 40 個 tick 之中 **9 個（23%）`profiles 0`**，而且嗰啲 tick
係**全部 feed 都 0**（`pump/geo/geoTrend/jup/gmgn/axiom` 全 0），`feedRequests` 冇升，
`emptyFeedTotal` 保持 0 —— 即係 `noteProfileFeed()` 由頭到尾冇被叫過。

**根因**：`fetchLatestSolanaProfiles()` 嗰個 `getJson("/token-profiles/latest/v1")`
**冇傳 deadline**，所以一食 429（共用 egress：單一 isolate `http429 12`）就係 3 次嘗試
連 2s+4s backoff ≈ 6s；而 scanner 嗰邊 `fetchFeedCapped` 600ms 就 race 出 `[]`
（`scanner.ts:1633-1643`）→ 遲到嘅結果（連 make-up）**一律丟掉**。時間戳直接對得上：

```text
dex.http429 last429At 13:26:10.250   ← 同一分鐘嘅 tick 13:26 就係 prof0
              last429At 13:31:09.915   ← 13:31 亦係 prof0
```

gecko／jup 各自有 5 分鐘 backoff，所以嗰啲 tick 係「所有 feed 一齊 0」，亦解釋咗
prof0 呈 5 分鐘週期（13:01/13:06/13:11/13:16/13:21/13:26/13:31）。

**改咗乜**（全部喺 `src/dexscreener.ts`，因為 scanner 嗰個呼叫點喺編輯窗口外）：

| 之前 | 現在 |
|---|---|
| profiles fetch 無 deadline，429 → ~6s 重試 | `PROFILE_FEED_SELF_BUDGET_MS = 320`：**只封頂重試鏈**（attempt 2/3），first attempt 不變 |
| retry backoff 固定 sleep 2s／4s | sleep 被 deadline 封頂（`Math.min(attempt * 2000, left)`）；無 deadline 嘅呼叫維持原狀 |
| fetch 失敗 → `return []`（make-up 一齊冇） | fetch 失敗 → **照 append make-up** |
| 故障只剩 `profiles: 0` | 新增 `failedTotal` / `lastFailedAt`：**「冇回應」同「回空」分開計** |

為什麼只封頂重試鏈、而唔係整個 call 加 race（曾經咁做過，live 推翻）：改動後第一個 429 tick
即時驗到 `profiles 5, feedsMs 320, failedTotal 1`，但同時見到 **`feedsMs 320` 意味著一個健康
但慢嘅上游（320–600ms）會被自己嘅 race 截斷，拿真 feed（18 幣）換 5 個 make-up**。
所以 race 拿掉，只保留「重試鏈唔可以喺窗內磨 6 秒」：正常快照一様等 scanner 嘅 600ms，
而 429 因為 attempt 1 快速失敗 + backoff 被封頂，會喺 ~320ms 返回 null → 照帶 make-up 回來，
**仍然贏 600ms race**。

`noteProfileFeed(raw, injected, at, failed)`：`emptyFeedTotal` 只在**真係回空**（`!failed && raw === 0`）
才加，`failedTotal` 只計失敗／超時。舊嘅 `profiles: 0` 訊號 = `rawProfiles 0` + 兩個 counter 之和，
所以故障一樣讀得到，但 backlog 唔再陪葬。

**睇 live**：

```bash
curl -s .../health | jq '.heartbeat.summary | {profiles, feedMakeup}'
# 429 tick 嘅預期簽名：profiles 5（= make-up），lastRawProfiles 0，failedTotal ↑，emptyFeedTotal 唔動
```

**第一個 live 證據（deploy 13:41:45 之後）**：

```text
13:44:10  prof 24   raw 18 + make-up 5   feedRequests 2
13:46:10  prof  5   raw  0 + make-up 5   failedTotal 1  lastFailedAt 13:46:07.910  ← 改動前呢個 tick 係 0
13:47:11  prof 23   raw 18 + make-up 5   failedTotal 仍然係 1（同一次故障唔會重複計）
```

**最終版（deploy 13:49:39 之後，只封頂重試鏈）**：

```text
13:56:09  prof 5   feedsMs 320   failedTotal 1   lastFailedAt 13:56:08.122
          emptyFeedTotal 0   feeds 全部 0   ← 重試鏈喺 320ms 退場，make-up 趕及喺 600ms race 之前交貨
```

同一個窗（13:49–13:57，7 個 tick）有以下結果，順便回答之前「`cand 1 / push 0`」個問題：

```text
13:52:10  prof 22  cand 0  pushed 0
13:53:12  prof 22  cand 1  pushed 1   ← 卡喺 3438ms 入 claim（< 3550ms gate），send:telegram→track→autobuy→done
13:54:10  prof 22  cand 0  pushed 0
13:55:10  prof 22  cand 0  pushed 0
13:56:09  prof  5  cand 0  pushed 0   ← make-up-only tick
13:50:14  prof  0  ← 冷啟 isolate 第一個 tick（見「要老實講」第 2 點）
13:51:13  prof  0  ← 同上，第二個 tick
```

`cardSendDeferred 0`、`cardSendDeferredTotal 0`、`deferredTotal` 冇升，`writeDrain` 喺 tick 之後
落地（166ms），`pushedTotal 233 → 234`。

- 主要量度點：**prof0 比率**（改動前 23%）同 `feedRequests / tick`

**要老實講**：

1. 上游**完全冇回應**（hang、唔係 429）嘅 tick 仍然會兩者皆失：scanner 嘅 600ms race
   會拿走 `[]`，make-up 一齊冇。要連呢個都救，就要喺呼叫點（`scanner.ts:1792`，编辑窗口外）
   把剩餘 feed budget 傳入。今次修好嘅係「重試鏈自己喺窗內磨完 6 秒」呢個可量度嘅成因。
2. 若 scanner 自己喺 `fetchFeedCapped` 之前就跳過（`remaining <= 250`），client 由頭到尾
   冇被呼叫 —— 呢種 tick（cold start 最常見）仍然絕對冇 feed、冇 make-up。
3. 320ms 係由量度導出（重試 × 2 ≤ 600ms window；tick 到 feed 之前約 140ms），不是定理。
   副作用：429 tick 嘅 scan_history row 由 `profiles 0` 變成 `profiles 5`，
   而 `lastSkip = empty-feed-and-pool` 喺嗰啲 tick 唔會再出現。

## 追蹤池長期 0 候選：死池 prune（2026-09-19 第四補）

**症狀**：pool 240–336、`candidates` 長期 0。**唔係 age 窗口**：

```text
reject log 49 筆 → 48 筆係流動性（其中大部分 `流动性 —` = 0/null）
fails: other 72（流動性 + 市值/流動性比）| mcap 8 | chg 4 | age 1
agedEval 4     ← 每 tick ~91 個被評估的幣之中，只有 4 個行到動能閘
```

**根因**：pool 嘅流動性 pre-filter 讀 `max_liquidity_observed` —— 一個只升唔跌嘅
終身高位（`updateTokenMaxMcaps` raise-only），所以「曾經有池、之後抽乾」嘅幣永遠
通過 prune。實測（DexScreener 現值 vs scanner 記錄）：

| symbol | scanner 峰值 liq | 現時 liq |
|---|---|---|
| `wildebeest` | 242,572 | **0** |
| `CASH` | 43,735 | 2,323 |
| `upcoin` | 25,953 | 3,586 |

（11 個樣本中 3 個；同 reject log 嘅 ~98% 對得上。）順帶排除嘅假設：
`fetchPairsForTokens` 嘅「first pair wins」唔係問題 —— DexScreener 本身按深度排序，
11 個幣每一個嘅 first pair 都係最深池、冇 null。

**改咗乜**：

| 位置 | 變更 |
|---|---|
| `db.ts` | 新欄位 `token_stats.last_liquidity_usd`（`addColumnIfMissing`，idempotent） |
| `db.ts` | `DEAD_POOL_CLAUSE` = `(last_liquidity_usd IS NULL OR last_liquidity_usd >= 1000)`，加入 `getReevalPoolBatched` |
| `db.ts` | 新 method `recordObservedLiquidity(rows)`：每 120 幣一個 `UPDATE … CASE`（一次 round trip） |
| `worker.ts` | 包住 `dex.fetchPairsForTokens` 收集本 tick 真實觀察到嘅流動性，tick 後（喺 deferred-write drain 之後）fire-and-forget 寫入 |

`1000` 係「池已經冇了」嘅門檻（0 或幾百美元），**刻意遠低於**聊天閘嘅 $10K：目的係
踢走「冇池」嘅屍體，唔係代替閘去篩「池細但仲有」嘅幣。NULL 仍然放行 —— 從來未量度過嘅
row 保持舊行為（唔會靠估去 prune）。永久排除嘅代價同 mcap/峰值流動性 prune 一樣（紀錄在案）。

**睇 live**：`pool` 數字應該首次持續跌（屍體出 pool）；`agedEval` 相對升；reject log 裡
`流动性 —` 佔比跌；1–2 個 tick 之後 DexScreener 嘅 last reading 就會寫入。

**要老實講**：

1. 每 tick 多一次寫入（~115 行、1 個 statement），喺 tick 之後 fire-and-forget，唔喺 critical path。
2. 如果 isolate 喺 tick 同 drain 之間死，嗰批 reading 會留到下一個成功 tick 才寫（值會舊 ≤2 min）。
3. 永久排除嘅風險：一個被 prune 嘅幣唔會再被 pool 評估（自然也就唔會更新 reading），但
   **feed 仍然可以把它帶回來** —— 任何重新有熱度嘅幣都會出現喺 trending/discovery feed，
   而 feed 路徑唔經 pool query，所以「復活」唔會被永久封死。
4. `queryReevalBand`（per-band fallback，`db.ts:2338`）未加 clause —— 佢喺檔案編輯窗口外。
   生產路徑係 `getReevalPoolBatched`（`poolfallback.ts` 先試佢），所以只有「batched 讀失敗」
   嘅 tick 會暫時放行屍體。可貼上嘅 patch：把 `const clauses: string[] = [];`（`queryReevalBand` 內）
   改成 `const clauses: string[] = [DEAD_POOL_CLAUSE];`。
5. 另一個間接阻礙：`rejectBudgetBeforeEval = 50 − min(poolSlice, 50) = 0`（`scanner.ts:2276`）令
   feed／make-up 幣嘅拒絕理由完全冇名額睇到（所以 5 個 pending 幣從來冇出現喺 reject log）。

## 完全 hang 嘅上游：make-up 一齊冇（2026-09-19 第五補）

**症狀**：上游**完全 hang**（唔係 429、唔係 5xx，純粹唔覆）嗰陣，`profiles 0` 而且
make-up 一樣冇 —— 即係本來要救嘅 deferred coin 冇被評估。今日 13:56 嗰個唔屬此類：
佢行「重試鏈到期」路徑（已救回），hang 嘅仍然係舊行為。

**根因**：兩個長度對唔上。scanner 只等 `FEED_DEADLINE_MS` = 600ms
（`fetchFeedCapped` 用 `Promise.race`，輸咗就保留自己嘅 `[]`），而 `getJson` 嘅 abort
下限係 `Math.max(1_000, …)` —— **1000ms > 600ms**。所以 attempt 1 永遠未 abort，
race 先到；**而 make-up 係喺 `fetchLatestSolanaProfiles` 入面、fetch settle 之後才砌嘅**，
所以 promise 被 race 丟棄 = make-up 一齊丟，`noteProfileFeed` 亦一次都冇叫過
（`failedTotal` 因此唔會升）。

**改咗乜**（全部喺 `dexscreener.ts`）：

| 位置 | 變更 |
|---|---|
| `getJson` | abort 唔再用 1000ms 下限：有 deadline 就用 `clamp(remaining)`，冇 deadline 維持 15s |
| `fetchLatestSolanaProfiles` | deadline 由「重試鏈」升級成「整個 call，attempt 1 在內」，所以 hang 會喺 budget 內自我放棄，make-up 照樣砌返 |

**睇 live**：hang tick 嘅簽名 = `profiles` 5（= make-up）、`lastRawProfiles 0`、
`failedTotal` ↑、`emptyFeedTotal` 唔動 —— 同 429 tick 一樣嘅形狀。

**要老實講**：

1. `PROFILE_FEED_SELF_BUDGET_MS = 320` **係量度導出，唔係定理**：佢成立係因為正常 tick
   到 feed 前約 140ms（600 − 140 ≈ 460ms 剩）。真正約束係 `budget + make-up < 窗內剩餘`。
2. 所以仲有一條窄缺口：front phases 若用多過 ~280ms 才到 feed，剩返嘅窗細過 320ms，
   race 又會贏（make-up 再次冇）。補法要喺 call site 傳入剩餘窗，即 `scanner.ts:1792`
   —— 喺檔案編輯窗口外，見下面「仍未落地」嘅可貼上 patch。
3. 測試備註：hang case 係第一個「只會靠 timer settle」嘅 case，而
   `AbortSignal.timeout()` 嘅 timer 係 unref'd，所以測試要自己 `setTimeout` 撐住
   event loop，否則 process 直接 exit 0（無 output）睇落好似 hang。
4. 呢個修復**唔會**令 `profiles 0` 消失：hang tick 照樣報 `profiles` = make-up 條數。
   要分開「答空」同「唔答」仍然係睇 `rawProfiles` / `emptyFeedTotal` / `failedTotal`。

## feed 被 `remaining <= 250` 提早跳過：make-up 一樣冇（2026-09-19 第六補）

**症狀**：`prof=0`。兩個上游路徑（答空 / 唔答）現在都會注入 make-up，所以修復後
`prof=0` 只剩兩個可能：

- **(a)** feed 答空 **而且** 該 isolate 嘅 deferral registry 係空（剛 boot、durable snapshot 未載入）；
- **(b)** feed 根本冇被叫過 —— `fetchFeedCapped` 嘅 `if (remaining <= 250) return empty;`。

**實測 2026-09-19 15:07:12**：心跳（跨 isolate、Turso 持久）`deferral.pending = 5`
（15:06:43–15:09:15 五次取樣都係 5），而該 tick `prof=0` **且** `pool=222`：

- 若行 (a)，pending 5 → make-up 注入 → `prof` 應該係 5；
- `pool=222 > 0` 證明掃描過到 feed 段之後（唔係 `shouldStopEarly` 提早 return）。

→ 所以係 **(b)**：feed 窗口剩 ≤250ms，feed 從未被叫，make-up 也就冇了。

**機制**：`feedDeadline = startedAt + FEED_DEADLINE_MS (600)`，即係由 tick 開始到 feed
之間用多過 **350ms** 就會跳過。該段做嘅係 `listEnabledChats()`（DB）+ 
`crimeWallets.refreshIfStale()`（TTL 6h，但**冷 isolate / 到期嗰次**會真拉一次
~4.8K address 清單，上限 `CRIME_WALLETS_FETCH_TIMEOUT_MS` 預設 **8000ms**）。

**量度**：120 tick 窗口（13:19–15:18）內 `prof=0` 有 **11 個（9%）**，另有 16 個係
`prof=5`（make-up-only）——後者就係修復前本應係 `prof=0` 嘅 tick。

**未解嘅觀察（重要）**：`prof=0` 有一串係**每 5 分鐘一次**：
`13:21:10, 13:26:10, 13:31:10, 13:36:10, 13:41:10`（全部 :10），
另外幾個緊貼 deploy（13:50+13:51 / 13:58 / 14:31 / 15:07）。
後者可歸於冷 isolate 首次 crime 拉清單；但**前者 5 分鐘週期對唔上任何已知 TTL**
（crime refresh 6h、gecko 429 backoff 5min 但嗰個係 feed 本身）。
未 instrument 之前**唔應該猜**，所以本次冇改任何常數。

**代價比 make-up 更大**：跳過係**整個 feed** 唔叫 —— 該 tick 唔止冇 make-up，連嗰分鐘嘅
discovery（最多 100 個新 profile）都一齊冇，只剩 pool。

**為乜今次改唔到**：兩個站點都喺編輯窗口外（實測 exact-match apply 全部唔中）：

| 站點 | 位置 | 內容 |
|---|---|---|
| `fetchFeedCapped` 跳過 | `scanner.ts:1639`（~79.9KB） | `if (remaining <= 250) return empty;` |
| 呼叫點 | `scanner.ts:1792`（~85KB） | `fetchFeedCapped(..., [], feedDeadline)` |

**可貼上嘅 patch（一行修好三條路）**：唔需要改跳過行 —— 只要把 make-up 清單當
`empty` 傳入，跳過同 race-timeout 兩條路就自動帶住 make-up（race-timeout 本來就會丟掉
遲到嘅 body，所以只賺不賠）：

```ts
// scanner.ts:1792
const profiles = await this.fetchFeedCapped(
  () => this.dex.fetchLatestSolanaProfiles(feedDeadline),
  missingDeferredTokens([]).map((tokenAddress) => ({ tokenAddress })),
  feedDeadline,
)
```

`missingDeferredTokens` 要加落 `scanner.ts` 頂部 `./deferredmakeup` 嘅 import（~1.5KB，窗口內）；
但單獨加會變死 import，所以留返同呼叫點一齊改。
（同下面第 4 項嘅 `windowDeadline` 係兩件獨立事，兩個可以一齊貼。）

**已採用（2026-09-19）**：`FEED_DEADLINE_MS` 600 → 900（`scanner.ts`，~25KB，窗口內）。
跳過門檻由「pre-feed > 350ms」變「> 650ms」，即除咗冷啟動 isolate 嗰次 ~4.8K 清單
fetch（8s 上限）之外，實測到嘅 pre-feed 成本全部覆蓋。
成本（真實、唔修飾）：front window 未分配餘裕 400ms → 100ms（900 + 池 1600 = 2500 < 2600，
仍然唔會食 gate reserve），**而且**其他 feed 嘅 race 上限一齊由 600 → 900ms；壞 tick 上
pair fetch（自己嘅 `PAIRS_FETCH_BUDGET_MS` 冇 clamp 入 front window）同 candidate chain 各少 300ms。

**要分清楚換咗啲乜**：feed 係「遲一 tick 亦唔會失」嘅一相（feed coin 會入 pool 等下個 sweep），
而跳過係**直接冇咗嗰分鐘嘅 discovery，連 make-up lane 一齊冇** —— 所以用 300ms 尾延遲
買返成分鐘覆蓋率係賺。**但唔係免費**：壞 tick 上池評估/閘門少 300ms，即係候選送出嘅
餘裕收窄，所以要一齊盯 `cand>0 && push=0` 嘅比率有冇變差。

**量度點（deploy 後）**：
- 主：`scan-history` 嘅 `prof=0` 比率（改前 13:19–15:18Z 係 11/120 = 9%）。預期跌。
- 交叉核對（唔可以單睇 `profiles`）：`rawProfiles` / `emptyFeedTotal` / `failedTotal`
  三者 —— 跳過係唯一「三者都 0 而 prof=0」嘅路徑。
- 反效果訊號：`cand>0 && push=0` 比率同上唔好升；`deferral.pending` 唔好長期積。
- 仍然未解釋：13:21/13:26/13:31/13:36/13:41Z 嗰串**每 5 分鐘一次**嘅 `prof=0`
  （全部 :10）對唔上任何已知 TTL（crime 6h），未 instrument 到就唔當佢係同一成因。

## 仍未落地（可選，非必需）

本 repo 大檔嘅檔案編輯只能觸及大約頭 45–55KB，以下 hunk 喺窗口外。
（2026-09-19 更正：「單行仍可」係**錯**嘅 —— 喺 `scanner.ts:1792`（~85KB）試過一條
完全吻合嘅單行 patch，一樣 apply 唔到。所以窗口係按 byte offset 計，唔係按行數。）
但要講清楚：**以下幾個都已經唔再係修正，只係補記錄**：

- **第 3 個（Gecko 腿）嘅「值」已經 live 修正**：`geckoterminal.ts` 嘅相容欄位
  係 `fdvUsd: marketCapUsd ?? fdvOnlyUsd`，而 `scanner.ts:1496` 讀嘅正是
  `snap.fdvUsd` —— 即 tracker 條 Gecko 腿已經優先市場市值，FDV 只做 fallback，
  `fdvUsedAsMcap` 標住 fallback 情況。剩低嘅只係把 `mcapFromFdv` 顯式傳入
  `PairInfo`（令帳本可以標「呢個 baseline 其實係 FDV」），純標記。
- **第 1、2 個已經被帳本取代**：`source` / band 印 / 推送值已經喺
  `worker_state.push_ledger` 逐幣記錄，heal 亦已經讀佢。`push_watch` 加欄位只
  對「早過帳本嘅幣」有幫助。

原本嘅 patch 清單（留低備用）：

1. **`push_watch` 欄位**（`db.ts`）：喺 `CREATE TABLE push_watch` 加
   `baseline_source TEXT, band_min REAL, band_max REAL, mcap_is_fdv INTEGER
   NOT NULL DEFAULT 0`；喺無條件 ALTER 區加同名 `addColumnIfMissing`；`upsertPushWatchMany`
   寫入、`listPushWatch` 讀出、`updatePushWatchCheck` 用 `COALESCE` 更新。
2. **`seen_tokens.push_mcap`**（`db.ts` + `scanner.ts`）：`claimTokenPush`
   加 `push?: { mcapAtPush; bandMin; bandMax; isFdv }` 並寫入
   `push_mcap/push_band_min/push_band_max/push_fdv`；`findUntrackedPushes`
   讀返。`scanner.ts` 嘅 `sendTo` 呼叫處傳入
   `{ mcapAtPush: c.pair.marketCap, bandMin: chat.minMarketCapUsd, bandMax: chat.maxMarketCapUsd, isFdv: c.pair.mcapFromFdv === true }`。
3. **Gecko 腿標記 FDV**（`scanner.ts` `pairsForTracker`）：
   ```ts
   if (!snap || (snap.marketCapUsd === null && snap.fdvUsd === null && snap.reserveUsd === null)) continue;
   ...
   marketCap: snap.marketCapUsd ?? snap.fdvUsd ?? 0,
   fdvUsd: snap.fdvUsd,
   mcapFromFdv: snap.marketCapUsd === null && snap.fdvUsd !== null,
   ```
   （`GeckoTokenSnapshot` 已經暴露 `marketCapUsd` / `fdvOnlyUsd` /
   `fdvUsedAsMcap`；價值語意已修正為「優先市場市值」，呢一步只係補標記。）
4. **`scanner.ts:1792` 傳入 feed 剩餘窗**（收窄「完全 hang」窄缺口，見上一節）：

   ```ts
   // 1792 行（單行）
   () => this.dex.fetchLatestSolanaProfiles(feedDeadline),
   ```

   配合 `dexscreener.ts` 嘅 `fetchLatestSolanaProfiles(windowDeadline?: number)`：
   `deadline = Math.min(Date.now() + PROFILE_FEED_SELF_BUDGET_MS,
   windowDeadline - 60)`（60ms 留返俾 make-up 跑，因為 make-up 係同步但 abort 嘅
   rejection 要行幾個 await 才傳返到）。冇參數時行為同現狀一樣，所以
   `scripts/test-filters.js` / `test-deferred-priority.js` 嘅無參數呼叫唔受影響。

`PairInfo.fdvUsd` / `mcapFromFdv`（`dexscreener.ts`、`jupfeeds.ts`）已經就位，
等上面第 3 步一貼就即刻有值。

---

## 死 tick 唔會再卡 28 分鐘：breaker 移到「下一個 tick」（2026-09-19）

**事故（已證實）**：`16:05:07Z → 16:33:07Z`（29 分鐘）`scan_history` **零真掃描**：
23 行全部係 `previous tick died before its completion flush` 嘅 backfill 佔位
（`profiles/pool/candidates/pushed = null`，`ms ≈ 60s` = 到下一 tick 為止嘅 liveness span），
另有 6 分鐘（16:08/16:15/16:19/16:29/16:30/16:32）**連 row 都冇**。

- `tickRing` 15:55–16:44 完整、無 >70s 斷層 → **cron 每分鐘都有 fire**（唔係交付停頓）。
- backfill 行係「贏到 lease 嗰個 tick」騎住 claim batch 寫 → 每分鐘都有人成功 claim + 寫
  heartbeat → **DB 寫得通**（唔係 Turso 硬故障；lock TTL 15s 亦排除餓死）。
- claim 每分鐘重寫 `phase=scanning` heartbeat → cadence gate 繼續放行，而 outage alert 綁
  heartbeat age → **一次都冇響**（`outageAlertAt` 仍係 2026-09-03）。即係 28 分鐘零掃描、
  狀態頁照綠。

**根因唔係觸發，而係「唔會自癒」**：breaker 嘅 streak 增量同重建都喺 `runScan` 嘅 outer
`finally`（`worker.ts:1650` 起）。被 invocation wall clock 終止嘅 tick **唔會執行任何
`finally`** → 死嘅 tick 永遠到唔到重建碼 → streak 一路升（1…23）而 `wedgedStateResets` 由頭
到尾 0，只有 deploy 換 isolate 才斷。

**修正**：重建移到**下一個 tick 最早嘅 hook** —— `ensureInitialized` 顶部（每個 scheduled / HTTP
路徑喺掃描前必經），判定用返 backfill 同一把尺（stale `phase=scanning` heartbeat = 前任未
flush），並抽成純函數 `deadTickRebuildDecision(prevRaw, now, staleMs)`（exported，單元測試喺
`scripts/test-tick-path.js`）：

- `rebuild: true` → 丟掉 module-scoped clients + scanner、`initPromise = null`，**同一個 tick 內**
  inline 重建再照常掃描 → 唔蝕掃描分鐘。
- 回復 tick 重寫 heartbeat，**保留死 tick 嘅 `at`**（寫 `now` 會令 cadence gate 跳過啱啱重建嘅
  呢個 tick）+ 加 `rebuiltAt` 標記（`heartbeatRebuiltAt()` 讀返）。
- 標記係防迴圈關鍵：回復 tick 自己嘅 heartbeat 都係 stale scanning，冇標記就會每 tick 重建成
  永不掃描。
- 讀取有界（`WEDGE_CHECK_BOUND_MS = 1500`，`Promise.race`）：慢 Turso 唔可以令呢個 check 變成
  佢要修嘅嘢本身（超窗嘅 tick）；超時就今個 tick 唔做，下個再試。
- 回復 tick 之後嘅 claim 一樣會 backfill 死 tick 嗰行 → 唔會喺 history 留洞。

**代價（唔修飾）**：

- 每 tick 多 **1 個單行 read**（live ~110ms；冷 isolate 首 tick 因為 `dbReady` gate 係 0）。
  免費做法（streak counter 搭 claim heartbeat 傳）需要 claim/heartbeat 寫入點，嗰啲位喺本
  repo 檔案編輯窗口外（`~60KB`，同今次逼住要搬位置嘅係同一個窗口）。
- 回復門檻係「proven death 即重建」（唔再等連續 2 次）：代價係一次性 kill 之後多一個 re-init，
  對比唔重建嘅代價（28 分鐘零掃描）低幾個數量級。`DEAD_TICK_STREAK_RESET = 2` 只留做
  counter-based 路徑嘅既定門檻。

**未解決（留低記錄）**：

1. **觸發點未證實**（16:05 為何開始死）：信封算術好窄
   （`scanRaceMs = max(2500, 9500 − 4500 − preRace)`，preRace 實測可到 1–4s，而 2500 下限會令
   「budget − flush reserve」失效）→ preRace 一慢就過平台 kill。最一致嘅候選係 Turso latency
   惡化（6 個「連 claim 都冇」嘅分鐘 = 死喺最早嘅 DB round trip）。CF logs 由呢邊觀察唔到
   （`wrangler tail` 要 CF token 而且係長駐程序）。
2. **`deadTickStreak` 仍然係 module-local**（無 publish 點）：`heartbeatDeadStreak` /
   `nextDeadStreak` 已 export + 單元測試，等 claim heartbeat 寫入點可改時即接。
3. **`wedgedStateResets` 係 per-isolate module state**：isolate 回收就清零，`/health` 只睇到
   答你嗰個 isolate → 唔可以事後回溯。
4. **並發競態（罕見）**：cron tick 同一個 HTTP 請求同時入 `ensureInitialized`，兩個都判定
   rebuild；第二個會喺第一個之後再丟一次 scanner，令嗰個 tick 靜靜咁 `runScan` 早退。
   下一個 tick 自動補回，唔會死循環。

**未動嘅舊機制**：`runScan` outer `finally` 嘅舊重建仍然存在（surviving tick 嘅第二道防線），
連 `if (backfillEntry) deadTickStreak++` 一齊 —— 兩者位址喺窗口外改唔到，所以保留原狀。

### 第七補：outage alert 由 heartbeat age 改綁「最後一次完成」

**問題**：`checkOutageAndAlert` 用 `Date.now() - heartbeat.at` 判中斷。但 `scan_heartbeat` 每個 tick
嘅 claim 都重寫，`at` 永遠新鮮（≈60s）→ **有 tick 但零完成** 嗰種中斷，age 永遠過唔到門檻，
2026-09-19 16:05-16:33Z 嗰 28 分鐘係一路報綠（`outageAlertAt` 仍停在 2026-09-03）。

**改法**：新增 durable row `scan_wedge`，由**後繼 tick**（唯一目擊者）維護，記
`{start: 呢段「零完成」嘅起點, tickAt: 最後一次有人掂過呢行嘅 wall clock}`。`tickAt` 就係**連續性
測試**：只有當「死咗嘅前任」嘅開始時間喺 `tickAt` 嘅容差內（即呢行係佢前一個 tick 寫嘅）才算同一段，
否則重新起一段 —— 所以**舊事件嘅殘留行唔會令一次新死亡睇成好長嘅中斷**，而健康 tick 一次 round trip
都唔使（清理係隱含嘅）。

- 判定：`silentMs = now - start ≥ OUTAGE_ALERT_GAP_MS`（3 分鐘）→ 發 alert。
- 只喺**死 tick** 才讀/寫（每次 1 read + 1 write；健康 tick = 0）→ 呢部分嘅日常成本係零。
- 共用舊 alert 嘅 cooldown row `outage_alert_at`（30 分鐘）⇒ 兩條 alert 唔會為同一 episode 重複發。
  舊 `checkOutageAndAlert` **冇改**（`worker.ts` 1927 行 = **91.6KB**，實測喺窗口外）：佢仲負責
  「連 tick 都冇 claim」嗰種（我嗰條路喺嗰種情況永遠唔會跑）。
- 訊息（同舊 alert 同風格）：`⚠️ 扫描器已连续约 N 分钟没有完成任何一次扫描（最早未完成的一轮开始于 <ISO>）`。

**未落地（窗口外，已實測）**：`scan_wedge` 借落 claim heartbeat 就零額外 round trip，但嗰個寫入點喺
~65KB。同理 `deadTickStreak` 嘅 publish 點。

**驗收點**：`/health` 嘅 `outageAlertAt` 應該喺「有 tick 但零完成 ≥3 分鐘」時更新（舊行為下唔會動）；
GitHub/Telegram 收到嗰句新訊息；`scan_history` 應該見到同期嘅 backfill 行（呢個 alert 只會在真係連續死
tick 時發）。

### 第八補：每 5 分鐘一次嘅 profiles 429（之前診斷錯咗）

**量度（2026-09-19，兩個獨立樣本夾住 17:46:11 嗰個 tick）**：

| tick | prof | feedRequests | lastRawProfiles | failedTotal | http429 | jup | feedsMs |
|---|---|---|---|---|---|---|---|
| 17:45:11（正常） | 24 | 20 | 20 | 4 | 4（last429At 17:41:08） | 20 | 714 |
| **17:46:11（minute%5==1）** | **4** | 21 | **0** | **5** | **4→5（last429At 17:46:08.049）** | 20 | 758 |
| 17:47:11（正常） | 24 | 22 | 20 | 5 | 5（blockedForMs 30428） | 20 | 758 |

- 過去兩小時：**18/18** 個 `minute%5==1` 嘅 tick 都係 `prof=4`（＝只有 make-up），其餘 tick 全部 `prof>5`。
- `failedAt 17:46:08.365` − tick 開始 `17:46:07.691` = **674ms** ＝ 前段 ~354ms ＋ `PROFILE_FEED_SELF_BUDGET_MS` 320ms。
- `jup=20` 同一個 tick ✓ → **唔係** 窗口被搶、唔係 pool rotation 食預算。
- **結論：係 HTTP 429**（`http429` 喺該 tick 內 +1，之後武裝 ~30s backoff），來自共享 CF egress；週期性最可能係該端點嘅 ~5 分鐘配額（我們 1 req/min 剛好踩到窗口邊界）。

**我上次嘅建議係錯嘅**：叫「把 `PROFILE_FEED_SELF_BUDGET_MS` 320 → 700–900」冇用 —— 429 約 350ms 就返；而且 >546ms 會令呢個 call 超過 scanner 嘅 `feedDeadline`（`startedAt + 900`），種族會連 make-up 一齊丟（變返 `prof=0`，比現狀更差）。**改一個常數係解決唔到。**

**改嘅係「嗰分鐘評估咗乜」**（`src/dexscreener.ts`，全部窗口內）：

- 新增 `lastGoodProfiles`（記憶體）＋ `PROFILE_FEED_REUSE_MS = 10 分鐘` ＋ 純函數 `shouldReuseProfileList()`。
- 非空且成功嘅 fetch 永遠贏；失敗（429/404/hang）或答空 → 重評估上一份好名單（10 分鐘內）。
- **故障訊號保持誠實**：`noteProfileFeed()` 仍然收到 **fetch 到嘅長度**（429 時 = 0），所以 `lastRawProfiles` / `failedTotal` / `lastFailedAt` / `emptyFeedTotal` 照舊報上游實情；變嘅只係「呢個 tick 評估乜」。
- 冷 isolate（無 cache）行為不變 → 退化成舊行為（只有 make-up）。

**驗收點**：deploy 後每個 5 分鐘 tick 應該見到 `profiles ≈ 24`（重用 20 ＋ make-up 4）而 `lastRawProfiles 仍 0`、`failedTotal` 仍然每 5 分鐘 +1 —— 即係「上游真係 429，但嗰分鐘唔再盲目」。

**未處理（另計）**：429 本身仍然存在（~12 次/小時）；要壓落去就要降低請求頻率（例如隔一個 tick 抓一次）或者換源 —— 呢個係獨立決定，唔屬第八補。
（呢個係 DexScreener profiles 嘅 429；**GeckoTerminal 自身嘅 429 係另一條線，而且係持續性嘅** —— 見
`docs/gecko-429.md`。）

**Deploy 後首個 5 分鐘 tick（18:11:11，version `dd1c1ec4`）— 重用生效，但揭出第二個損失**：

| tick | prof | feedReq | raw | fail | inj | jup | pool |
|---|---|---|---|---|---|---|---|
| **18:11:11（min%5==1）** | **26** | 4 | **0** | 1 | 16 | **0** | — |
| 18:12:11（正常） | 26 | 5 | 22 | 1 | 20 | 20 | 272 |
| 18:13:11（正常） | 26 | 6 | 22 | 1 | 24 | 20 | 340 |

- `prof 26` ＝ **重用 22 ＋ make-up 4** ✓（同正常 tick 嘅組成一樣）→ 以前呢個 tick 只會評估 4 個 make-up 幣。
- 但同一個 tick **`jup=0`**：profiles call 係 `await` 先嘅，燒盡 320ms budget 之後，fan-out 嘅其餘 feed 只剩 ~226ms，而 `fetchFeedCapped` 嘅 250ms 下限會令**每一個 fan-out feed 直接短路回空**（唔係 Jupiter 自己 throttle 嘅問題）→ 嗰分鐘整個 fan-out 都空。即係 5 分鐘週期嘅實際代價 ＝ profiles 22 幣（已由重用救回）＋ Jupiter 20 幣（未救）。
- 下一補（第九補）就係修呢個 —— **唔需要改 `scanner.ts:1819`**（原本以為要，實際喺 client 層改得到）。

### 第九補：令 429 快速讓路，唔再燒盡 feed 窗口

**更正上面嘅推測**：唔係「Jupiter throttle 來不及」，而係 profiles call 返得太遲（+674ms）→ fan-out 只剩 226ms → **低過 `fetchFeedCapped` 嘅 250ms 下限**，所以每個 fan-out feed 連 HTTP 都唔發就回空。所以要修嘅係「profiles call 幾時放手」。

**真正嘅燃燒路徑**（我初時估錯，用 stub 量清楚）：

1. 第 1 次嘗試撞 429（~10ms 就到）→ `note429()` 記錄 + 武裝 90s backoff。
2. 舊嘅 catch 分支 `await sleep(min(attempt*2000, left))` —— `left = 314ms` → **睡足 314ms**（把整個剩餘 budget 睡掉）。
3. 第 2 次嘗試只等 throttle（**default 350ms**，prod 設 250ms）→ 但佢嘅 `AbortSignal` 死線早已經過 → **實際冇發過 request**，直接 abort throw。
4. 總計 ≈ 674ms，全程冇第二个真 request。

**改法（全部喺 `src/dexscreener.ts`，窗口內）**：

- 新增 `RETRY_MIN_ATTEMPT_MS = 250`；`retryHeadroomMs = dexRequestIntervalMs + 250`。
- 不滿 headroom **或**係 429（而 caller 有 deadline）→ `break`：**唔開始一定輸嘅第二次嘗試**，立即 throw 出去（`note429` 已經記錄嗰次 429）。
- 5xx / 網路錯誤仍然保留重試（但同樣要夠 headroom）；unbounded caller（無 deadline）行為不變（2s/4s）。

**本地量度**（同一個 429 stub，改前/改後）：429 `calls=1 took=+26ms`（改前 ~350ms）；500 `calls=1 took=+0ms`；404 `calls=1` ✓。

**代價（講清楚）**：profiles call 嘅 320ms budget 細過 headroom 500ms，所以 5xx 都一樣 fail-fast、冇重試 —— 依賴嘅係（一）每 60s 都會再試、（二）失敗時有第八補嘅 last-good 重用。pair 路徑（1000ms budget）仍然有空間重試，所以冇刪走條路。

**驗收點**：deploy 後嘅 5 分鐘 tick 應該 `jup ≈ 20`（原本 0）而 `profiles 仍 ≈ 26`（重用 20＋make-up）、`lastRawProfiles 仍 0`、`failedTotal` 仍然每 5 分鐘 +1。

**Deploy 後量到（version `170f9838`，warm isolate）**：

| tick | prof | feedReq | raw | fail | lastFailAt | jup | feedsMs |
|---|---|---|---|---|---|---|---|
| 18:30:11（正常） | 21 | 4 | 17 | 0 | — | 20 | 767 |
| **18:31:11（min%5==1）** | **21** | 5 | **0** | **1** | 18:31:07.783 | **20** ✓ | 767 |
| 舊行為 18:11:11（比較） | 26 | 4 | 0 | 1 | 18:11:08 | **0** ✗ | 768 |

- 429 仍然存在（`raw 0`、`failedTotal +1`、時間戳落喺該 tick 內）—— 訊號冇被遮蔽 ✓
- **`jup` 由 0 變返 20** ✓ 即 fan-out 不再短路；tick 長度（`ms 4224`）同正常一樣。
- `prof 21` ＝ 重用 17 ＋ make-up 4 ✓

**今次 verfiy 嘅教訓（也記下）**：deploy 後第一個 5 分鐘 tick（18:26:13）**驗不到** —— 佢係冷 isolate，行嘅係模式 A（`feedReq 0 / feedsMs 0 / prof 0`，前段 cold crime 抓食死窗口），要等 warm isolate 嘅 18:31 才有結論。兩種 5 分鐘病徵唔可以混為一談。

---

## 第十補：跨源流動性 —— 一張假 💧 卡（見 `docs/liquidity-provenance.md`）

2026-09-20 20:16 HKT 嘅「💧 流動性枯竭 Lobby | LP 僅剩 $7.95K（< $10K）… 停止追蹤」係**假警報**：
該池當時 DexScreener 讀 17.5K（用戶睇 ~21K）。tracker 兩條流動性規則（$10K 絕對地板、45% 驟降比）
係用 DexScreener 嘅 `liquidity.usd` 校準，但 pair 可以來自 Jupiter／Gecko 腿，而嗰兩把尺對同一個池
只有大約一半（實測 14 行入面 **10 行**嘅 `lastLiquidity` = Jupiter 值，0.46–0.58× DS，誤差 ≤ 2%）。

修正：`pushwatch.ts` 新增 `comparableLiquidity()`（非 DexScreener 來源一律當「資料不明，唔判斷」）
＋ 三條腿各自標 `PairInfo.feedSource`；深層 hunk 以 `docs/patches/liq-source-guard.patch` 落地。
量度表、代價同驗收點全部喺 `docs/liquidity-provenance.md`。

---

## 第十一補：一次檢查跨過幾關，張卡要講明

2026-09-25 06:49 HKT 收到 `🚀 續漲 parafactual | 推送時 $115.2K → $660.58K (+473%) … 已達最高里程碑`，
而之前冇任何 +200% / +400% 通知。查完：**冇漏發**。

| 讀數 | 值 |
|---|---|
| `mcapAtPush` → `peakMcap` | 115,199 → 921,235 |
| `upStages` | `up50,up100,up200,up400,w35` |
| `lastState` | `up400` |
| audit ring 內該 token 嘅卡 | 只有 `sig up400 @ 22:49:58` |
| `deadTroughMcap` | 71,254（低過推送價） |

`RISING_STAGES = [50,100,200,400]`，stage machine 發**最高而未公佈**嗰關，然後把 ≤ 該關嘅全部 mark 死
（`for j <= i`）—— 呢個係刻意嘅（舊行為係一次大行情倒序發四張：+400%、+200%、+100%，POPEYE 事件）。
所以**一次檢查內跨過成個梯級，就只會有一張卡**；row 入面嗰三個 up mark 係同一張卡自己 fold 出嚟，唔係三次失蹤。
該幣當時跌到 71K（低於推送價），下一次被睇到就已經係 +473%。

不過用戶嘅困惑係啱嘅：張卡只寫「已達最高里程碑」，冇講佢吞咗邊幾關，所以讀者分唔清「+200% 漏發」同
「價位停在 +100% 同 +200% 之間嗰段時間根本冇檢查過」。

**修正**：跨過多過一關時，卡會列出全部關口：`| 一次檢查內跨越 +50%/+100%/+200%/+400% | 已達最高里程碑`。

**另一個真缺口**（令呢個問題由外面查唔到）：唯一持久嘅逐卡證據係 `push_audit`，一個**上限 30 筆、全 chat 共用**嘅
ring —— 繁忙時只覆蓋幾分鐘；deferral ledger 只有計數同 pending token 名單，`followupsSent` 只係一個數。
改為 200 筆，並為 `/debug/push-audit` 加 `?token=` / `?since=` / `?limit=`，下次一條 request 就答得到。