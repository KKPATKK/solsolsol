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
| `feedMakeup` | feed 真相：`{feedRequests, lastRawProfiles, emptyFeedTotal, lastEmptyFeedAt, injectedTotal, lastInjected}` |

**改咗乜（第 1 點）**：`effectiveMode()` 以前喺 render／claim 之前**無界**讀 Turso，
即係坐响嗰 400ms claim slice 中間。現在 worker 喺**tick 開始**就 prefetch（`onTickStart`），
卡尾嗰個 call 係 cache hit；每個讀取亦硬性界限 250ms（超時就用 env mode —— 同原本嘅
fail-safe 一樣，唔會用未證實嘅 mode）。成本：**跨 isolate** 嘅 `/setmode` 最多 15 秒生效
（同一個 isolate 即時，`setModeOverride` 會寫穿 cache）。

**改咗乜（第 2 點）**：`profiles 0` 嘅 tick 以前刻意**唔注入** make-up（為咗保留
`profiles: 0` 呢個故障訊號），代價係冷啟動 isolate 嗰幾個 tick 冇補推機會
（118 tick 中 7 個，其中 5 個喺 deploy 後 2 分鐘內）。現在**照注入**，訊號搬到
`feedMakeup.lastRawProfiles`（0 = 一樣嘅意思）同 `emptyFeedTotal`（跨 tick 累計）。

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

## 仍未落地（可選，非必需）

本 repo 大檔嘅**多行**檔案編輯只能觸及大約頭 45–55KB（單行仍可），以下三個
hunk 喺窗口外。但要講清楚：**三個都已經唔再係修正，只係補記錄**：

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

`PairInfo.fdvUsd` / `mcapFromFdv`（`dexscreener.ts`、`jupfeeds.ts`）已經就位，
等上面第 3 步一貼就即刻有值。
