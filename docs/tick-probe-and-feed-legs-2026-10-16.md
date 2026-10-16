# 2026-10-16（二）：pair 探測唔再等 queue 嘅 gap ＋ feed 相位逐條腿讀數

前提：`docs/tick-pair-phase-2026-10-16.md` §8 已經落實——fleet block 令
`poolLegMs.pairs` 由 1,202–1,693ms 落到 **0ms**（7/10 tick），`scan_history.ms`
p50 2,942 → 1,648。剩低兩個形狀：**探測 tick 仍然 2,773–3,658ms**（§8.3 講明
「`poolLegMs.pairs` 986–1,190ms，係 §6 嘅下一個槓桿」），同 **`feedsMs`
666–1,343ms 冇得拆**（§6 第 2 條：要 per-leg 讀數先決定砍邊條）。

今次做嘅係呢兩件，冇第三件。

## 0. 結論

| # | 做咗咩 | 為咩 | 代價 |
|---|---|---|---|
| 1 | **探測請求唔再喺 tick 臨界路徑上等 queue 嘅 dispatch gap**：slot 遠過
`PAIR_PROBE_INLINE_WAIT_MS = 400ms` 嘅探測，交畀 invocation 嘅 `waitUntil`
（`DexScreenerHooks.holdForTick`），pair 相位即刻回佢嘅 cache hits | 探測係 refused
egress 之下**唯一**嘅 pair request，佢嘅資料本來就由 Jupiter 補底（實測 0–26 / ~200
條），但每個探測 tick 都要 tick 企喺度等 ~1.2s 嘅 `intervalMs` gap 去攞一個已知答案
| 拒絕嘅**記錄**遲一個 tick 先喺 /health 見到（block 照樣重新武裝）；健康嘅
egress（唔係探測、slot 近）逐個 byte 一樣 |
| 3 | **feed 相位逐條腿讀數**：`ScanSummary.feedLegMs`（每條腿自己嘅
dispatch→settle 時間，12 條腿之一）+ `feedJoinMs`（fan-out join 等幾久），同時
上 `/debug/tick-legs` 每行 | `feedsMs` 係一個數；tick 剩返嘅 2.3–3.2s 裏面
666–1,343ms 喺呢個相位，「砍邊條」之前要先有數睇 | 0 個新 request、0 個新 round
trip、0 條新 column——讀數搭住 tick 本身已經寫嘅 heartbeat／ring row |

## 1. 探測（probe）：點解係純 latency，冇產品代價

**形狀**：fleet block 生效之後，一個 refusal episode 嘅 pair request 係「每 90s 全隊
一次探測」（§8 實測 `blockedForMs 25,405–89,364` 而 `pairFleetRefusedAgeMs`
32,416–97,603 非 null）。冇 block 嘅 tick 讀 `poolLegMs.pairs 0`；**探測 tick 讀
986–1,190ms**——嗰 1.2s 唔係 request 嘅時間，係 `AdaptiveSpacing` 升到上限之後
queue 嘅 **dispatch 間距**：lane 為咗問「你仲拒絕我嗎？」而企喺隊列度等。

**做法**（`src/dexscreener.ts`）：

- `probeDue()`：pair lane 由上次 **serve** 之後有冇再被拒（自己嘅
  `pairRefusedAt` 或 row 上嘅 `fleetPairRefusedAt`）——即係「下一次嘗試係探測」係
  一個**讀數**，唔係第二個 timer。serve 過嘅 lane 永遠唔係探測，所以健康嘅一日
  完全唔會入呢條路。
- `fetchPairsForTokens` 嘅批次 loop 拆出 `dispatchBatches(endAt, signal)`，inline
  同延後兩條路**跑同一個 loop**（pacing、429 反應、drop 記帳、cache 寫入只有一份
  實作）。
- 探測而 `nextSlotAt() - now > 400ms`（`PAIR_PROBE_INLINE_WAIT_MS`，＝基礎間距
  250ms 加 margin）→ 交畀 `hooks.holdForTick`（worker 側就係 tick 嘅
  `tickWaitUntil`），caller 即刻回 `result`（cache hits）。**冇 hook 嘅 caller
  （Node container、ad-hoc call、測試）乜都唔變**——冇人保住個 promise 就唔應該
  開佢。
- 延後嘅 loop 用**同一個** `PAIRS_FETCH_BUDGET_MS`，亦特意**唔帶** caller 嘅
  abort signal：caller 就快 return，佢個 abort 係「相位完咗」，唔係「唔要探測」。

**為何係純 latency**：

- 資料：探測拿到嘅 pair 照樣寫入 in-memory cache（下一輪嘅 rotation 食得到）；
  今個 tick 嘅 gates 本來就唔靠佢——嗰 0–26 條由 Jupiter 補底補齊
  （`pairsJup == pairs`）。
- 拒絕：照樣 `note429(batchLane)` → block 重新武裝、spacing 再升、`/health`
  計數器照動。分別只係**呢一刻**喺 `waitUntil` 度發生，唔喺 tick 嘅臨界路徑。
- 健康 egress：`probeDue false`（serve 過）或 slot 近（400ms 內）→ 完全唔入 defer
  分支。測試釘住兩邊：`a lane that served is never a probe`。

## 2. feed 相位：逐條腿（`feedLegMs` / `feedJoinMs`）

- `feedLegMs`：每條腿**由 promise 建立到 settle** 嘅 wall time，兩邊結果都記
  （delivery 同 refusal 都係要睇嘅形狀）。十二條腿：
  `profiles / gecko / pump / raydium / meteora / geoTrend / boosts / gmgn / axiom /
  jup / jupTrend / backfill`（`export type FeedLeg`）。
- **腿係重疊嘅**：呢個唔係 `feedsMs` 嘅分割，係每條腿自己嘅成本。相位嘅
  **serial** 部分係 `profiles`（tick 等佢 settle 先 dispatch 其餘），所以佢個數
  同時係「其餘腿幾遲才開始」。
- `feedJoinMs`：`await Promise.all(feedJobs)` 嗰一刻嘅等待——每個 fan-out 腿都已經
  in flight，所以佢係「fan-out 仲剩幾多」。同 `feedLegMs` 最闊嗰條比較：接近就係
  完全重疊；細就係啲腿早就 settle 咗。
- `backfill` 跑喺 join **之後**（序列），但佢喺 `feedsMs` 之內，所以照量；冇
  Birdeye client／腿被關嘅 tick **唔會**記 0（「冇跑」唔等於「跑到即刻」）。gecko、
  boosts 呢啲 `dropOptionalLeg` 唔畀跑嘅腿，一樣係 absent。
- 冇新 request、冇新 round trip、冇新 column：讀數搭住 tick 本身已經寫嘅
  heartbeat（`heartbeat.summary.feedLegMs`）同 `/debug/tick-legs` 每行
  （`feedLegMs` / `feedJoinMs`；慢 tick 嗰條 durable row 係 JSON，所以連
  `worker_state.tick_leg_slow` 都有）。

## 3. 測試（`npm run test:unit`，main suite 545 → 548 passed / 0 failed）

- `DexScreenerClient: a refusal PROBE is dispatched off the pair phase, not waited
  on`：隊列熱（一個唔會被 retry 嘅 4xx 佔咗最近一個 slot）＋ row 上一個**過期**嘅
  `pairRefusedAt`（90s block 已過，而且冇 serve 過）→ 第二個 call 讀
  `probeDue true`、`blockedForMs 0`；探測嗰次 call **等 < 300ms**（本來要等 ~600ms
  嘅 gap）、`calls` 冇加、`held` 有 1 個、`probeDeferrals 1`、
  `lastProbeDeferredAt` 有值；之後 poll 到 `calls 2`，證明**被抱住嘅探測真係出街**，
  而且佢嘅 429 令 `blockedForMs > 0`。同一測試釘住 **wiring**：worker 真係喺
  `new DexScreenerClient(` 隔籬畀 `holdForTick`，而且係 `tickWaitUntil(promise)`。
- `the probe deferral is opt-in, and a lane that served is never a probe`：冇
  `holdForTick` → 同一個探測形狀**照樣 inline 等 gap**（`waited >= 400`、
  `calls 2`、`probeDeferrals 0`、`lastProbeDeferredAt null`）；lane serve 過之後
  （同樣有 row 上嘅舊拒絕、同樣有 hook）→ `probeDue false`、**兩輪都正常出貨**
  （各 30 條）、`held` 空、`probeDeferrals 0`。
- `feed legs: every discovery leg reports its own wall time, and the join reports
  its wait`：一次真 scan（profiles 30ms、pump 120ms）讀
  `feedLegMs.profiles >= 20`、`feedLegMs.pump >= 100`，而 keys 恰好係
  `["profiles","pump"]`（其餘腿冇 client／size 0），`feedLegMs.backfill` 係
  `undefined`；`feedJoinMs >= 90`（跟 fan-out 嗰條腿，唔係 serial 嗰條）。第二次
  scan（profiles 150ms、pump 0ms）反過來：`feedLegMs.profiles >= 140` 而
  `feedJoinMs < 60`——兩個讀數係唔同嘅量。roster 同 wrapping 亦喺 source 釘住
  （`this.feedLeg(` 出現次數 ＝ `FeedLeg` 嘅腿數）。
- `scripts/test-tick-legs.js`：ring row 帶 `feedLegMs`（深拷貝，之後改 summary
  唔會改到已記錄嘅 tick）同 `feedJoinMs`；冇 summary 嘅 cut tick 記 `null`
  而唔係空 map。

## 4. 驗收（deploy 之後讀呢幾個位）

1. `heartbeat.summary.feedLegMs` 有值；`/debug/tick-legs` 每行有
   `feedLegMs` / `feedJoinMs`（慢 tick 亦喺 `worker_state.tick_leg_slow`）。
   讀法：最闊嗰條腿 ＝ 相位嘅長杆；`feedJoinMs` 接近佢 ＝ fan-out 完全重疊；
   `profiles` 大而 `feedJoinMs` 細 ＝ 其餘腿係「等咗先開」而唔係「跑得慢」。
   **呢一步係落閘前嘅數**：砍邊條要有兩三日嘅 `feedLegMs` 分佈先講。
2. 探測 tick 嘅 `poolLegMs.pairs` 由 986–1,190ms 落到 **≈0**，`evalMs` 跟住落到
   ≈ `pairs-jup`；`/debug/tick` 見 `probeDeferrals` ≥ 1（累計）、
   `lastProbeDeferredAt` 有值。
3. Block 照樣武裝：下一個 tick `blockedForMs > 0`、`pairFleetRefusedAgeMs` 非
   null、`intervalMs` 冇跌返落 250。
4. tick 冇斷：`ok 1`、`deadTickStreak 0`、`writeDrainError null`、冇 `cut`；
   `scan_history.ms` 嘅**探測 tick** 由 2,773–3,658ms 落到 1,6xx–2,4xx（繼承 block
   嘅 tick 唔應該變）。
5. coverage 冇跌：`pairs` 仍然 ~200（`pairsJup == pairs`）、`pairsMissing` 唔升、
   `pushed`／`fails` 分佈同改前一致。

## 5. 限制（唔可以當過）

- 探測嘅拒絕**會遲一個 tick** 先反映喺 /health 嘅 block 讀數（deferral 喺
  `waitUntil` 度完成），同 fleet block 本身嘅節奏（「全隊每 90s 一次」）一致；
  即係話「探測」呢個動作冇消失，只係唔再佔 tick 嘅時間。
- `feedLegMs` 係**腿級**讀數：佢答「邊條腿食咗時間」，唔答「腿入面邊個 await」
  （例如 pump 嘅分頁請求、gecko 嘅 page loop 都係一條腿嘅內部）。
- `feedLegMs` 嘅腿係重疊嘅，加起身**唔等於** `feedsMs`（`profiles` 係 serial、
  `backfill` 係 join 之後，fan-out 其餘係並行）。
- gecko 有 cadence gate、boosts 有 cadence gate、Meteora 會等 gecko job：呢啲
  「等決定」嘅時間算落嗰條腿嘅成本（見 `feedLeg` 嘅註釋），即係 gecko 被 gate
  擋咗嘅 tick 唔會有 `feedLegMs.gecko`（absent），但 Meteora 喺 gecko-due 嘅
  tick 會包含等 gecko 嘅時間。
- 呢批改動冇郁任何產品參數（feed size、cadence、gate 門檻、`PAIRS_FETCH_BUDGET_MS`、
  `DEX_REQUEST_INTERVAL_MS` 全部不變）；`PAIR_PROBE_INLINE_WAIT_MS` 只係「幾遠
  嘅 slot 值得延後」嘅門檻，健康嘅 egress 永遠唔會撞到。

## 6. 部署後實測（2026-10-16 01:57:13Z deploy，commit `57ff3dd`）

**Run 38837693022 三個 job 全綠**：`migrate` 25s、`deploy` 1m41s（unit tests 過 →
`Uploaded solana-meme-bot (3.04 sec)` → `Deployed solana-meme-bot triggers
(0.89 sec)` @ 01:57:13Z）、`catchup` 25s。

### 6.1 讀數 3（item 3）：feed 相位逐條腿——上線即見

`/health` 取樣（每次落到邊個 isolate 唔受控；`pairs == pairsJup` 全部呢批樣本都係）：

| tick (UTC) | `ms` | `feedsMs` | `feedJoinMs` | `feedLegMs`（ms） |
|---|---|---|---|---|
| 01:59:02 | 3,789 | 1,009 | 1,009 | boosts 1,009, jupTrend 668, raydium 631, meteora 296, jup 90, pump 86, profiles 12 |
| 02:00:02 | 3,466 | 688 | 688 | jupTrend 688, raydium 407, meteora 310, jup 148, pump 81, profiles 21 |
| 02:02:27 | 3,032 | 862 | 802 | jupTrend 802, raydium 412, meteora 367, pump 133, jup 126, profiles 94 |
| 02:03:33 | 1,869 | 1,057 | 1,057 | gecko 1,057, meteora 1,057, jupTrend 695, raydium 359, jup 176, pump 78, profiles 34 |
| 02:04:00 | 1,984 | 1,195 | 1,195 | boosts 1,195, jupTrend 666, raydium 385, meteora 284, pump 61, jup 36, profiles 9 |

三點：

1. **`feedJoinMs` 每次都等於最闊嗰條腿**（1,009 / 688 / 802 / 1,057 / 1,195）——
   fan-out 完全重疊，相位嘅時間就係最慢嗰條腿，唔係「等咗先開」：`profiles`
   9–94ms，serial 部分唔係樽頸。
2. **長杆已經有數**：`gecko` 1,057（keyed，5 分鐘 cadence）、`boosts` 1,009–1,195
   （cadence）、`jupTrend` 666–802；第二層係 `raydium` 334–412 ＋ `meteora`
   264–367；`jup`/`pump`/`profiles` 36–176。砍邊條要兩三日分佈先講（見 §4 第 1 點）。
3. Ring row 亦帶住：`/debug/tick-legs` 一行樣本 ＝
   `feedLegMs {"profiles":21,"pump":81,"jup":148,"meteora":310,"raydium":407,"jupTrend":688}`
   ＋ `feedJoinMs 688`，而同一個 tick 嘅 `poolLegMs {"pool-read":0,"front-write":57,"pairs":2001,"pairs-jup":592}`。
   `feedLegMs.backfill` 冇出現——maintenance 揀咗嗰步，腿冇跑（absent，唔係 0）✓。

### 6.2 讀數 1（item 1）：探測唔再等 gap——episode 期間先讀到

部署後嘅窗口係**混合形狀**（egress 喺 deploy 後一分鐘內由「持續被拒」變成「斷續
成功」），所以三個形狀要分開睇：

| 形狀 | 樣本 tick | `poolLegMs.pairs` | `probeDeferrals` | 備註 |
|---|---|---|---|---|
| 繼承活 block | 02:03:33、02:04:00、02:06:04、02:06:43、02:08:20、02:09:25、02:09:57 | 0 | 0 | 舊行為（fleet block）不變，`ms` 1,229–1,980 |
| serve 中（唔係探測） | 01:59:02–02:02:27、02:04:37、02:07:17 | 1,200–2,001 | 0 | `probeDue false`→deferral 唔應該出手，亦冇出手 ✓ |
| **block 過期、未 serve 過（＝真探測）** | 02:05:00、02:08:52 | **0** | **1**（`lastProbeDeferredAt` 有值） | `blockedForMs 0`、183–191 條 `pairs` 全部由 Jupiter 送、`ms` 1,342–1,755 |

- **deferral 真係觸發咗**：`heartbeat.dex.probeDeferrals` 由 0 → **1**，
  `lastProbeDeferredAt` 有值（第一次喺 02:04:25Z 前後）；嗰批 tick 讀
  `poolLegMs.pairs 0` + `blockedForMs 0` + `pairs == pairsJup`（183–191 條）。對比
  §8.2 嘅探測 tick（`pairsLeg` 986–1,190ms、`ms` 2,773–3,658），即係
  **lapsed-block tick 由 986–1,190ms 落到 0ms**（樣本 2 個），而 coverage 冇跌。
- **拒絕照樣學到**：`worker_state.dex_spacing` ＝
  `{"at":"02:07:17.057","steps":4,"pairRefusedAt":"02:07:16.419"}`——02:07:17 嗰個
  tick（`pairsLeg` 1,200、`probeDue` 開始時 false：佢嗰個 isolate serve 過）照樣
  inline 交學費，deferral 唔會 touch 一個 serve 過嘅 lane ✓；而 `pairFleetRefusedAgeMs`
  24,781–159,859 非 null 配本地 `429 0` 嘅 tick 照樣出現，即係 block 仍然跨 isolate。
- **tick 冇斷**：after 窗口 21 行 `scan_history` 全部 `ok 1`、`ms` 1,229–3,789、
  冇 `cut`。

### 6.3 呢批讀數嘅限制

- `probeDeferrals` / `lastProbeDeferredAt` 係 **per isolate**、而且只保留**最新 tick**
  （同 `http429` 一樣）；`scan_history` 8 欄冇佢。所以「deferral 幾次、幾時」係由
  抽樣嘅 `/health` 讀到（0 → 1、`lastDef` 有值），唔係 durable 記錄。
- 樣本細：lapsed-block tick 得 2 個；pre-deploy 對照係 §8.2 嘅 3 個探測 tick。
- after 窗口嘅 egress 由「持續被拒」轉「斷續成功」，所以 `scan_history.ms` 嘅前後
  p50（after 頭 9 個 2,562 vs pre 1,727）**唔可以**當成本次改動嘅效果——serve 中嘅
  tick 本來就會用滿 pair budget（2,000ms，8 個 batch 喺 640–1,200ms spacing 之下）。
  要讀嘅係「lapsed-block tick 嘅 `poolLegMs.pairs`」。
- 如果將來要 durable 記 deferral：ring row 加 `probeDeferrals` / `lastProbeDeferredAt`
  係同 `feedLegMs` 一樣嘅做法（0 個 round trip）——今次冇做，唔喺範圍內。
