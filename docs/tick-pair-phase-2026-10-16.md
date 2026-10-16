# 2026-10-16 tick 嘅 2.3–3.2s 用喺邊：pair 相位，同埋「同一個 429 每個 isolate 重複畀一次」

前提：DB 已經唔係成本（`docs/d1-efficiency-2026-10-15.md`；每 tick 嘅
`dbTickSteps` 加總 189–270ms）。呢份文件答下一條：**剩低嘅 2.3–3.2s 係咩**，
同最大嗰件點樣切。

## 0. 結論

| # | 發現（實測） | 代價 | 已做 |
|---|---|---|---|
| 1 | **tick 嘅最大一件係 eval 相位內嘅 pair fetch**：五個 tick 入面四個，`poolLegMs.pairs`（DexScreener 批次腿）1,202–1,693ms + `pairs-jup`（Jupiter 補底）418–635ms = 佔 tick 嘅 60–74%；`feedsMs` 666–1,343ms，`poolMs` 0–98ms，`dbTickSteps` 77–190ms | 一個 3,125–3,816ms tick 入面 ~2.0–2.3s | — |
| 2 | **嗰 1,202–1,693ms 買到 0–26 條 pair**（request 總數 ~200）：DexScreener 嘅 shared egress IP 幾乎每次都 429，而佢嘅 90s cache-only block（`PAIR_BATCH_BACKOFF_MS`）係**per isolate**，isolate 每 ~30s 換一次 —— 即係每個新 isolate 都用 ~1.2s 嘅 dispatch 間距（`intervalMs` 已升到上限 1,200）去**重新賺同一個已知嘅拒絕** | 五個 tick 入面四個重複付，~1.2–1.7s × 每個 tick | 把拒絕搬上 `dex_spacing` 呢一行（`pairRefusedAt`），令 block 同 spacing 一樣跨 isolate；每個 episode 由「每個 isolate 試一次」變「全隊每 90s 試一次」。**實測：`poolLegMs.pairs` 1,202–1,693 → 0ms（7/10 tick），`scan_history.ms` p50 2,942 → 1,648（§8）** |
| 3 | Jupiter 補底一直係真正送貨嗰條腿：`pairsJup == pairs`（193–198 條）而 Dex 只回 0–26；一個**繼承咗活 block** 嘅 tick 讀 `poolLegMs.pairs 0` + `pairs-jup 418ms` —— 即係「跳過已知拒絕」嘅形狀係啱嘅 | — | 保留 fail-open：block 一定買到恢復探測（過期就重新問） |

## 1. 量度：一個 tick 嘅解剖（2026-10-16 00:25–00:27Z，`/health` 取樣）

| tick (UTC) | `heartbeat.ms` | `feedsMs` | `poolMs` | `evalMs` | `poolLegMs.pairs` | `poolLegMs.pairs-jup` | `pairs` | `pairsJup` | `dbTickSteps` 加總 |
|---|---|---|---|---|---|---|---|---|---|
| 00:25:02 | 3,430 | 1,193 | 98 | 2,134 | **1,485** | 635 | 219 | 193 | 77ms |
| 00:25:36 | 3,133 | 666 | 75 | 2,338 | **1,693** | 624 | 196 | 196 | 167ms |
| 00:26:07 | 3,816 | 756 | 0 | 2,910 | **0** | 418 | 197 | 173 | 187ms |
| 00:26:40 | 3,125 | 693 | 17 | 2,312 | **1,665** | 631 | 198 | 198 | 153ms |
| 00:27:02 | 3,322 | 1,343 | 12 | 1,847 | **1,202** | 623 | 200 | 191 | 113ms |

同一個窗口嘅 `heartbeat.dex`：`intervalMs 1,200`（＝上限，`spacingFleetSteps 4`）、
`http429` 兩分鐘內由 1 升到 22、`pairCacheRefused 4–16`、`lastPairCacheStatus HTTP-429`、
而「付咗嗰 1.2s」之後嘅 tick 讀 `blockedForMs ~89,377ms`（即 block 啱啱由**佢自己**
嘅 429 重新武裝）。`subreqs.current`：每 tick 11–13 個 subrequest，其中
`api.dexscreener.com` 1–3 個、`lite-api.jup.ag` 4–5 個 —— 即係 pair 相位裏面
DexScreener 只係問一兩次，而嗰一兩次就係嗰 1.2–1.7s。

唯一一個平嘅 tick（00:26:07）係**繼承咗仍然生效嘅 block**：`blockedForMs 27,216` →
`pairs` 腿 0ms，eval 剩返 418ms（Jupiter）。呢個就係「唔好重複畀」嘅目標形狀 ——
而且證明 skipped 之後 gates 照樣有 ~197/200 條 pair 可以用（`fails.mcap 160` 之類係
正常嘅 gate 拒絕，唔係「冇數據」）。

## 2. 機制：點解同一個拒絕會逐個 isolate 重複付

`fetchPairsForTokens`（`src/dexscreener.ts`）：

1. 先食 in-memory pair cache（`PAIR_CACHE_TTL_MS 180s`），淨低嘅係 misses；
2. `if (Date.now() < this.batchBlockedUntil) return result;` —— 90s 內一個 request 都唔發；
3. 過咗就先問 `this.throttle.nextSlotAt()`：佢係**全 isolate 共享**嘅 dispatch 計劃，
   間距係 `AdaptiveSpacing` 嘅當前值（429 之後由 250ms 升到上限 1,200ms）；
4. 一個 batch 收到 429 → `note429(batchLane=true)` → `batchBlockedUntil = now + 90s`
   → `saw429` 停埋其餘 batch —— 即係「一個 slot 換一個拒絕」。

`batchBlockedUntil` 係 **instance 欄位**，而 isolate 每 ~30s 換一次（
`dex_spacing` 嘅整段註釋就係為咗同一個問題寫：spacing 嘅 raise 單獨活唔過 isolate）。
所以每個新 isolate 都要自己畀一次 1.2s 嘅 slot 去學「endpoint 拒絕緊我」——
而隊友（同一個 egress IP）早就學過。

## 3. 修正：把 batch lane 嘅 block 搬上同一行 row

`DexSpacingStamp` 加一個欄位（**向後兼容**，舊 row 冇佢照樣係有效 row）：

```jsonc
{ "at": 1792110421405, "steps": 4, "pairRefusedAt": 1792110421405 }
//   spacing 幾時立下      幾多級 raises   最後一次「batch lane 自己」嘅 429
```

- **只記 batch lane 自己嘅拒絕**（`note429(batchLane=true)` 先寫 `pairRefusedAt`）。
  唔會用任何 lane 共用嘅 429 ring（`dex_429_at`）：LIST lane 喺呢個 egress IP 上被拒
  係常態（見 `DEX_429_RECORD_MIN_GAP_MS`），而 2026-10-01 嘅 lane split 就係為咗
  「一個 list 拒絕唔准閘住 pair lane」——呢個修正照跟同一條線。
- **adoption（`adoptDurableSpacing`）raise-only，同 spacing 一樣**：
  `batchBlockedUntil = max(local, pairRefusedAt + PAIR_BATCH_BACKOFF_MS)`。
  已經用咗（過期）嘅 row 永遠唔會縮短一個更新鮮嘅本地 block；寫入時帶
  **兩者較後**嗰個拒絕，唔會用舊嘅蓋新嘅。
- **成本 0 個 round trip**：row 一直係 scan front 嘅一次讀（`db.SCAN_FRONT_GATE_KEYS`
  已經有 `dex_spacing`）同一次寫（`finally` 嘅 `stampFront`），今次只係 payload 多個欄位；
  健康嘅 fleet（冇拒絕）一個字都唔會寫。
- **fail-open 不變**：block 過期就照問（該次 429 會重新武裝）；`pairsByToken.size <
  一半` 就會叫 Jupiter 補底 —— 即係「跳過」永遠唔會等於「冇 pair 數據」。

**點解唔用其他 lever**：

- **唔把 entire pair lane 永久降級去 Jupiter**：DexScreener 嘅 mcap/liquidity 係 gate
  嘅校準尺（見 `docs/mcap-basis-and-pool-pick-2026-10-02.md`、`docs/liquidity-provenance.md`），
  健康嘅一日嗰條腿係要跑嘅。呢個修正只喺**fleet 知道 endpoint 拒收緊**嗰陣跳。
- **唔同時跑 Dex + Jupiter 兩條腿**：咁樣喺健康嘅日子會多咗成批 Jupiter 請求去換
  兩個唔同尺嘅讀數；而 block 已經令「拒絕氣候」下嘅 phase 只剩 Jupiter 一條腿。
- **唔調 `PAIRS_FETCH_BUDGET_MS`／`DEX_REQUEST_INTERVAL_MS`**：budget 唔係成本
  （leg 早過 budget 就停），而 spacing 係 429 嘅**反應**，唔係原因（
  `wrangler.toml` 2026-09-18 已經量過：350 同 250 一樣被拒）。

## 4. 釘住（測試）

`scripts/test-unit.js`：

- `parseDexSpacingStamp + dexSpacingDecaySteps`：新欄位係**可選、分級**——舊 row
  （冇 `pairRefusedAt`）仍然係有效 row，垃圾值讀成「row 上冇拒絕」而唔會連累 `at`/`steps`；
  `dexFleetPairBlockUntil` 用 **同一個 90s 規則**（唔係第二個 backoff），並且（測試內）
  直接同本地 `blockedForMs` 對齊，兩個數字唔可以drift。
- `DexScreenerClient: the batch lane's 90s block crosses the isolate boundary too`：
  isolate A 被拒 → row 帶住時間；isolate B（10s 後、從未拒絕過）adopt 之後
  **一個 request 都唔發**（fetch 次數不變、`pairCache*` 全 0、`pairFleetRefusedAgeMs`
  非 null）；block 過期之後**照樣會問**；一個過期嘅 row **唔會縮短**更新鮮嘅本地 block；
  而且為咗其他原因（spacing walk-back）嘅寫入**唔會擦走** row 上嘅拒絕。
- 舊有嘅 `spacing row crosses the isolate boundary` 個案改成讀 **legacy row**（冇
  `pairRefusedAt`）—— 即係「舊 row 唔會無中生有一個 block」嗰條規則。

## 5. 驗收（deploy 之後讀呢幾個位）

1. `/health.heartbeat.summary.poolLegMs.pairs` 由 1,202–1,693ms 落到 **0**（除咗每 90s
   一次嘅探測 tick），`evalMs` 跟住落到 ≈ `pairs-jup`（~0.4–0.7s）；
2. `/health.heartbeat.summary.heartbeat.dex`：`blockedForMs > 0` 而
   `pairFleetRefusedAgeMs` 非 null，**喺一個自己從未拒絕過嘅 isolate 上** —— 即係 block
   真係跨咗邊界；`spacingFleetSteps` 唔變（raise-only）；
3. tick 冇斷：`heartbeat.ms`、`scan_history` 間距、`lastScanMs`、tracker pass 嘅
   `trackerMs`／`db Nms`、`writeDrainError null`、`deadTickStreak 0`；
4. 覆蓋冇跌：`pairs` 仍然 ~200（`pairsJup == pairs`）、`pairsMissing` 唔升、
   `pushed`／`fails` 嘅分佈同改前一致。

**After 讀數：見 §8。**

## 6. 下一個槓桿（第 1、3 條已做：見 `docs/tick-probe-and-feed-legs-2026-10-16.md`）

1. **探測 tick 嘅 ~1.0–1.4s**（§8.3）——✅ 已做（純 latency）：探測唔再喺 tick 嘅
   臨界路徑上等 queue 嘅 gap，交畀 `waitUntil`；見新文件 §1。
2. **`feedsMs` 666–1,343ms**：profiles/boosts/feed fan-out。佢嘅 edge cache 讀數
   （`listCacheHits` vs `listCacheMisses`／`listCacheRefused`）係決定 TTL 嘅料。
   — ✅ 讀數已加（`feedLegMs` / `feedJoinMs`，見新文件 §2）：**砍邊條要等兩三日嘅
   分佈**，唔係今次就砍。
3. **`poolMs`／`front-write`**：0–98ms，暫時唔係槓桿。
4. **Jupiter 補底嘅 418–635ms**：block 生效之後佢就係 pair 相位嘅全部。佢係
   `fetchTokenDataBatch` 分 batch 打 `lite-api.jup.ag`（~4–5 個 request/tick），
   可以睇嘅係 batch 大小／併發，同埋「pair 數據可唔可以 reuse 上一 tick 嘅」。

## 7. 限制（唔可以當過）

- 五個 tick 嘅樣本（同一個窗口），而且 `poolLegMs` 係**相位級**讀數：佢答
  「邊條腿食咗時間」，唔答「leg 入面邊個 await」。1.2–1.7s 嘅組成（佔多數係 dispatch
  間距嘅等待）係由 `intervalMs 1,200` + 每 tick 1–3 個 DexScreener request + 429 之後
  `saw429` 停隊推出嚟嘅，冇 per-await 讀數。
- `http429`／`pairCacheRefused` 等係 **per isolate** 計數器，deploy 換代就重計；
  `blockedForMs`／`pairFleetRefusedAgeMs` 係當前 isolate 讀到嘅 row 同本地狀態。
- `pairRefusedAt` 係「**batch lane 最近一次自己嘅拒絕**」，唔係「endpoint 而家健康」——
  所以一個長期被拒嘅 egress 會令每日大部分 tick 都由 Jupiter 供數（呢個同改之前**實際上**
  一樣，只係唔再為同一個拒絕付 1.2s）。
- 呢個修正**唔會**令健康嘅 egress 快啲：`spacingSteps 0`／冇拒絕嘅一日，pair 腿嘅行為
  同改前逐個 byte 一樣（測試釘住 legacy row 唔會無中生有 block）。

## 8. 部署後實測（2026-10-16 00:45:16Z deploy，commit `5a68a60`）

**Run 38831072548 三個 job 全綠**：`migrate` 00:43:12→35、`deploy` 00:43:37→00:45:27
（unit tests 過 → `Uploaded solana-meme-bot (7.85 sec)` → `Deployed … triggers`）、
`catchup` 00:45:29→49。

### 8.1 持久讀數：`scan_history.ms`（跨 isolate 嘅真正記錄）

| 窗口 | n | min | **p50** | mean | max |
|---|---|---|---|---|---|
| 改之前 00:38:37–00:45:36 | 14 | 1,959 | **2,942** | 2,845 | 3,379 |
| 改之後 00:46:10–00:51:01 | 10 | 1,238 | **1,648** | 2,096 | 3,658 |

分佈係雙峰，而且分得對應設計：**7 個 tick 1,238–1,656ms**（繼承到仍然生效嘅 fleet block，
pair 腿 0ms）＋ **3 個探測 tick 2,773–3,658ms**（block 用完，問一次 → 429 → 重新武裝）。
90s episode ÷ ~30s tick ≈ 三次入面一次探測，同窗口嘅 3/10 吻合（00:48:20 嗰個 3,658ms
同時仲有一個 candidate chain）。

### 8.2 tick 側逐條腿（`/health` 取樣）

| tick (UTC) | `ms` | `feedsMs` | `evalMs` | `poolLegMs.pairs` | `pairs-jup` | `blockedForMs` | `pairFleetRefusedAgeMs` | 自己嘅 `http429` |
|---|---|---|---|---|---|---|---|---|
| 00:46:10 | 2,773 | 1,020 | 1,637 | 986 | 636 | 89,364 | null | 3 |
| 00:47:00 | **1,639** | 722 | 828 | **0** | 426 | 39,324 | 50,676 | 0 |
| 00:48:52 | **1,628** | 676 | 858 | **0** | 474 | 57,584 | 32,416 | 2 |
| 00:49:24 | **1,238** | 561 | 580 | **0** | 564 | 25,584 | 64,416 | 0 |
| 00:49:57 | 2,814 | 806 | 1,880 | 1,190 | 652 | 89,348 | 97,603 | 3 |
| 00:50:29 | **1,656** | 672 | 884 | **0** | 871 | 57,057 | 32,943 | 4 |
| 00:51:01 | **1,322** | — | — | **0** | — | 25,405 | 64,595 | 3 |

驗收點逐條：

1. `poolLegMs.pairs` **1,202–1,693ms → 0ms**（7/10 個 tick；探測 tick 係 986–1,190ms，
   即係由「每個 isolate 每次」變成「全隊每 90s 一次」）；
2. **block 真係跨咗邊界**：`pairFleetRefusedAgeMs` 32,416–97,603ms 非 null，而同一批
   tick 嘅本地 `http429` 有 0（00:47:00、00:49:24）——即係嗰個 block 唔係呢個 isolate
   自己賺嘅；`blockedForMs 25,405–89,364` 同 `pairRefusedAt` 喺 row 上對得上
   （`worker_state.dex_spacing = {"at":1792111861191,"steps":4,"pairRefusedAt":1792111796580}`，
   `pairRefusedAt` = 00:49:56.58Z 嗰次探測嘅 429）；
3. **coverage 冇跌**：`pairs` 187–201（改前 196–219），`pairsJup == pairs`、
   `pairsMissing 1`、`pushed`／`fails` 同改前同一形狀；
4. **tick 冇斷**：`ok 1` 全部 24 行、`writeDrainError null`、`deadTickStreak 0`、
   `initError null`、`dbReady true`、tracker pass `trackerMs 274ms`（`relay inner`）、
   冇 `cut`。

### 8.3 呢批讀數嘅限制

- 窗口係 14 個 tick（改前）對 10 個 tick（改後）；`scan_history.ms` 係跨 isolate 嘅持久記錄
  （最硬），但 `poolLegMs`／`dex.*` 係 `/health` 取樣（每次落到邊個 isolate 唔受控）。
- 探測 tick **冇消失**，只係變疏：佢仍然要 ~1.0–1.4s（一個 1,200ms 嘅 dispatch 間距 + 429），
  呢個係 §6 嘅下一個槓桿；pair 相位喺跳過嘅 tick 上剩返 `pairs-jup` 426–871ms。
- 呢批讀數係喺「egress IP 持續被拒」嘅氣候下量嘅 —— 即係今次修正針對嘅情形。
  健康嘅一日（`spacingSteps 0`、`pairRefusedAt` 缺）pair 腿同改前逐個 byte 一樣。

## 9. 落地清單

1. `npm run test:unit`（build + 13 個腳本，包括新嗰個跨 isolate 個案）—— ✅ 本地全綠（545 passed / 0 failed）。
2. Push → `deploy.yml`（migrate / deploy / catchup）—— ✅ 三個 job 全綠，見 §8。
3. 5 / 15 分鐘後讀 §5 嗰四個位 —— ✅ after 讀數見 §8。
