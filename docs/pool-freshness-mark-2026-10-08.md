# 重估池死幣標記（讀數新鮮度）2026-10-08

> 相關：`docs/round-trips.md` §4.48（pool 兩條 builder 嘅 drift 同輪替覆蓋）、
> `docs/stale-readings-2026-10-03.md`（決策點嘅 stale 讀數守衛）、
> `docs/gecko-429.md`（pair lane 嘅 429 窗）。

## 一、原本嘅缺口：地板只判斷「讀數講咩」

`DEAD_POOL_CLAUSE`（2026-09-19）已經解決咗一半：由 lifetime high-water
`max_liquidity_observed` 改成讀 `last_liquidity_usd`，所以「有過池、之後乾塘」嘅幣會喺下一次
sweep 被剔走。剩低嘅係另一半——**pair 完全消失嘅幣**：

| 情況 | pair lane 回咩 | `last_liquidity_usd` | 舊 clause 判 |
|---|---|---|---|
| 池乾塘、pair 仲在 | `liquidity 0` | 覆寫成 0 | 剔走 ✓ |
| 池／token 消失，冇任何 venue 答 | 完全冇呢隻幣 | **唔會被覆寫** | **留住 ✗** |

第二種幣嘅最後一個讀數（≥ $1K，地板之上）就變成永久擔保：每個 rotation 都照讀佢、佔一個
pair-fetch 名額、喺 gate 前被拒——但佢已經冇可能 qualify。兩個 high-water prune
（`max_mcap_observed` / `max_liquidity_observed`）設計上答唔到，因為佢哋只升不跌。

## 二、訊號：掃咗但一個讀數都冇（＋健康批次守衛）

`scanner.poolSweepMisses(poolTokens, answers, answered, requested)` —— 純函數，收
rotation slice、pair phase 最後嘅 token→pair map、同覆蓋率，回「問咗但冇答」嘅池幣。

三條刻意收窄：

1. **只計 rotation slice**，唔計 `scannedProfiles`：feed 嘅新幣（bonding curve 未畢業）本身
   就冇 pair，標記佢等於喺佢畢業一刻將佢擋喺池外——caller 只傳 `poolSlice`。
2. **只計健康批次**：覆蓋率 < `POOL_SWEEP_HEALTHY_COVERAGE`（0.5，同 Jupiter fallback
   自己嘅觸發線同一個數）→ **整個列表清空**。被拒係 transport 嘅事實，唔可以推進任何標記。
3. **只回報，唔寫入**：寫入喺 tick 尾（`worker.flushObservedLiquidity`），同一次 sweep
   產生嘅「清 0」同「+1」一齊落，所以兩半喺一個 tick 內唔可能交錯。

## 三、為何用 sweeps 而唔用 wall-clock TTL

- **掃描停／DB 退化唔會累積**：冇 sweep 就冇 miss，一次靜默期唔可能一次過清走活幣。
  一個 wall-clock 界反而要猜一個大過 worst rotation recurrence 嘅值，而 §4.48 量到 worst
  far band 要 8 個 recurrence（≈2.4h）才覆蓋全部 row——猜細咗就係誤殺。
- **單位同池一致**：池本身就係以 rotation 計，幾時睇一隻幣係輪替決定，唔係鐘。

## 四、門檻同代價

`DEAD_POOL_MISS_MAX = 3`（`src/db.ts`）。90-coin slice 對 ~1,200 pool ⇒ 同一隻幣大約每
13 分鐘被掃一次，3 次 ≈ 40 分鐘嘅**幣層面**空白。用 sweep 計，所以同 scan cadence、同
cron/DO clock 嘅節奏無關。

- **標記 = 一個 column**（`sweeps_since_reading`），**淘汰 = pool query 嘅 predicate**：
  `DEAD_POOL_MARK` 由 `DEAD_LIQUIDITY_USD` / `DEAD_POOL_MISS_MAX` 兩個常數砌出，兩條
  builder（`getReevalPool` / `getReevalPoolBatched`）同 `/debug/pool` 嘅讀數都用佢，唔可能
  drift。NULL 讀數照樣 fail-open（三值邏輯：mark 為 NULL → 當活）。
- **唔 delete row**：row 帶住其他 prune 嘅輸入（`launch_ms` 窗口、`firstSeenAt` = age gate
  嘅基礎）。刪咗再被 feed 註冊就等於當新 discovery，age 會被重設。標記係會被
  **第一個真讀數清 0** 嘅（`recordObservedLiquidity` 同一句 UPDATE），所以 discovery feed
  再搵到佢就自動返池——同 mcap / peak-liquidity prune 一樣嘅永久排除 trade-off。
- **一次 deploy 嘅 cache 窗**：池 snapshot 係 colo 共享，key 由
  `poolQueryFingerprint` 指紋決定。predicate 本體舊版指紋睇唔到，所以加咗
  `POOL_QUERY_SHAPE_VERSION`（`v2-2026-10-08-dead-mark`）——舊 predicate 寫落嘅 snapshot
  唔會答新 query，deploy 後第一 tick 就係新謂詞。日後改 pool SQL 嘅形狀要 bump 佢。

## 五、改動清單

| 檔案 | 改動 |
|---|---|
| `src/db.ts` | `DEAD_POOL_MISS_MAX` / `DEAD_POOL_MARK` / `DEAD_POOL_CLAUSE`；新 column `sweeps_since_reading INTEGER NOT NULL DEFAULT 0`（`addColumnIfMissing`，同 `last_liquidity_usd` 一樣唔進 DDL fingerprint）；`recordObservedLiquidity` 同一句加 `sweeps_since_reading = 0`；新 `noteSweptWithoutReading(tokens)`；`getPoolHistogram` 加 `deadMarked` / `deadPending`（騎同一個 full scan，零額外讀） |
| `src/scanner.ts` | `POOL_SWEEP_HEALTHY_COVERAGE` / `poolSweepMisses()`（純函數）；每次 scan 開始清空 `pendingPoolSweepMisses`（早退嘅 tick 唔會重報上一 tick 嘅 miss），pair phase 之後填佢 + `diag.poolMisses`；`takePoolSweepMisses()`（take-once）；`POOL_QUERY_SHAPE_VERSION` 進指紋 |
| `src/worker.ts` | `flushObservedLiquidity(scanner)`：先寫 miss（+1）、後寫 readings（清 0），兩個空集合都唔會跳過另一半；`observedLiquidityUsd()` provenance 閘（見第九節）；`/debug/pool` 回 `deadMarked` / `deadPending` |
| `scripts/pool-read-cost.js` | 離線儀器嘅 SQL 同步（clause 由 `?` 參數改成鏡像嘅常數，arg list 對齊） |
| `scripts/test-unit.js` | 三條新測試（見下） |

## 六、驗收（離線，本機）

| 檢查 | 結果 |
|---|---|
| `npx tsc --noEmit` | 綠 |
| `npm run test:unit`（全部 suite） | **501 passed / 0 failed**（含第九節新增嗰條） |
| 新測試：`pool: a coin whose sweeps keep coming back empty is marked dead…` | 4 隻幣同一個 band、同一個 peak，只有 streak 唔同：`ONESHORT`（bound-1）照掃、`MARKED`（=bound）出池、`NOMEASURE`（讀數 NULL、streak 超過 bound）照掃；`noteSweptWithoutReading` 令 `ONESHORT` 到界即出池；一個 `recordObservedLiquidity` 即刻清標記返池；histogram 兩個 counter = 1 / 1 |
| 新測試：`Scanner.poolSweepMisses: only a HEALTHY batch can mark a pool coin` | 覆蓋率 1.0 同**剛剛等於 0.5**都算 miss；低於 0.5 全清空；空 slice / 冇問過任何幣 = 空 |
| 新測試：`freshness mark: one sweep produces both halves…` | 源碼釘位：列表由 `poolSlice` 砌（唔係 feed）、take-once 而且會清、尾段同時寫兩半、兩個 builder 都帶 clause、histogram 同 clause 用同一個 `DEAD_POOL_MARK`、shape version 進指紋 |

## 七、部署後要讀嘅數（本文未量）

1. `/debug/pool` 嘅新欄 `deadMarked` / `deadPending`（同 `total` / `eligibleInWindow` 一齊讀；
   端點有 5 分鐘 durable TTL）。**預期**：`deadMarked` **唔係由 0 起**——佢係池嗰條死謂詞
   嘅人口（$1K 地板 ＋ 新鮮度界），所以一開始就係地板本來剔走嗰堆，之後先隨空 sweep 再升；
   真正要睇嘅增量係「`deadMarked` 高出地板人口嘅部分」同 `deadPending` ≤ 約 3 × 每日死亡數。
2. `/health` 摘要嘅 `diag.poolMisses`（同 `poolSliced` / `pairsMissing` 一齊讀）。
   **預期**：健康 tick 係細數（0–3）；429 窗係 **0**（守衛）；長期高企而 `pairsJup` 冇補上
   ⇒ 睇係 lane 有事定係真屍體。
3. Turso rows-read：池細咗應該反映喺 sweep 嘅行數（2026-10-07 量到 ~5.75k rows/read）。

**未量**：真實池入面有幾多 % row 會達門檻（冇生產讀數，deploy 前後都冇 baseline 對比）、
rows-read 實際省幾多、以及「被標記嘅幣幾耐之後被 feed 重新發現」。

## 八、界線（老實講）

- **未 deploy**：preview / prod 未跑過，所以本文冇任何生產讀數，全部係離線測試 +
  代碼推理。上面第七節係驗收指引，唔係結果。
- **已知縫 1**：同時出現喺 feed list 嘅池幣唔會被計 miss（caller 只傳 `poolSlice`）。刻意嘅：
  嗰啲幣本身仍然 discoverable，而且 feed 腿嘅失敗唔應該當成幣嘅死亡證據。
- **已知縫 2（同日修好，見第九節）**：provenance——`flushObservedLiquidity` 原本照寫任何腿
  嘅 `liquidity`，所以一個唔可比較嘅低讀數可以令活幣落到 $1K 地板之下，亦可以清 freshness
  標記。已加 `observedLiquidityUsd` 閘（只收 `liquidityIsComparable`）。
- **`deadPending` 唔係滯後指標**：`poolSweepMisses` 只喺「問過而且冇答」時 +1，
  一隻喺 slice 外嘅幣唔會被計，所以 counter 係「被掃過嘅幣入面有幾多喺標記途中」，唔係
  「池入面有幾多隻死咗」。

---

## 九、同日後續：provenance 閘（只收 calibrated 讀數）

`worker.observedLiquidityUsd(pair)`：`last_liquidity_usd` 係兩個 **DS 校準**規則嘅輸入
（$1K 地板 ＋ 新鮮度標記），所以 Jupiter（同一個池 0.46–0.58×，2026-09-20 量度）同
Gecko（reserve 只計佢索引到嘅池）嘅讀數一律唔准寫入——同 scanner 嘅 high-water raise
（`updateTokenMaxMcaps`）、tracker 嘅 `comparableLiquidity` 用同一個 source of truth
（`liquidityIsComparable`）。`feedSource` 缺失 = DS（fixtures／synthetic／legacy）。寫入路徑
只剩一條：wrapper 經呢個 helper，raw `pair.liquidity?.usd` 只可以喺 helper 內部出現**一次**
（測試釘住）。

**今日係咪 live bug？唔係——呢個係合約收口，唔係行為改變**（老實講）：

| 腿 | 產生處 | 會唔會經過 wrapper |
|---|---|---|
| DexScreener | client 自己砌，`feedSource: "dexscreener"`（`dexscreener.ts:1381`） | 會（wrapper 就裝喺呢個 client） |
| Jupiter | `JupTokensClient.fetchTokenDataBatch`（`jupfeeds.ts:322`）→ 只 union 落 scanner 自己嘅 map | 唔會 |
| Gecko | scanner 由 snapshot 砌（`scanner.ts:4144`）→ 只入 `lastPairs`／pin lookup（車道自己已過濾非 DS，`scanner.ts:4205`） | 唔會 |

所以今日真實 wire 只餵 DS pair，閘係 no-op；佢封嘅係合約：一旦 leg-tagged pair 出現喺呢條
lane（例如將來將 Jupiter 腿併入 front pair lane——本 repo 常做嘅那種改動），就會靜靜地污染
地板同標記。

**測試**：`worker.observedLiquidityUsd: only the calibrated leg may be recorded`——9 個 case
（DS 讀數、無 tag、$0、Jupiter 12.5K、Gecko 4K、`usd: null`、`liquidity: null`、NaN）＋源碼
釘位（raw 讀數全檔只准一次）。`npm run test:unit` **501 passed / 0 failed**。

**剩下嘅界線**：非可比讀數既唔推進亦唔清除標記——scanner 嘅 miss 定義係「pair 答案冇呢隻
幣」，而 Jupiter 答到＝池讀得到。所以「只有 Jupiter 腿答得到」嘅幣會**凍結**標記：唔會被推
死，亦唔會被清。刻意嘅 fail-safe 方向，同「缺失數據不判斷」一致；下一個 DS-served sweep 就
會照常記錄同清 0。

---

## 十、部署同第一組生產讀數（2026-10-08）

`39834c6`（ff 落 `main`）→ GitHub Actions「Deploy Worker to Cloudflare」run `37861409692`
**success**（即 `npm ci` ＋ `typecheck` ＋ `test:unit` ＋ `wrangler deploy` ＋ 三個
best-effort secret 全部綠）。部署後即刻抽嘅兩個公開讀數：

| 端點 | 讀數 |
|---|---|
| `/debug/pool`（`cached: false`，23:51:07Z） | `ok true`；`total 77801`；`eligibleInWindow 70475`；**`deadMarked 522`**、**`deadPending 0`**；`poolQueryCount 1154`（limit 1200）；`mcapFloorUsd 48000`、`liquidityFloorUsd 8000` |
| `/health`（tick `via cron`、`relay inner`、`colo NRT`、`ms 3396`） | summary 有 **`poolMisses 0`**；`pairs 183`／`pairsJup 173`／`pairsMissing 0`（健康批次）；`staleReadings 0`；`pool 1222`、`poolSliced 90`；`getReevalPool 46ms` |

點讀：

- **代碼同 migration 都 live**：`/debug/pool` 兩個新欄係新 code 先有，而佢哋條 SQL 直接
  `SUM … sweeps_since_reading …` —— 呢個呼叫返到數，即係 `addColumnIfMissing` 已經喺
  prod 建好新欄（唔會 throw），而且池 query 本身健康（1154/1200 行，46ms）。
- **`deadMarked 522` 唔係「新鮮度標記剔咗 522 隻」**：佢係池嗰條死謂詞嘅人口，而
  `sweeps_since_reading` 啱啱才建、全部 row 都係 0 default——所以呢 522 隻全部係 **$1K 地板
  本來就剔走**嘅（同改動前一樣），新鮮度半邊今日嘅增量係 **0**。`deadPending 0` 亦一致：
  冇任何池幣行過空 sweep。
- **`poolMisses 0`**：呢個 tick `pairsMissing 0`（pair lane 答齊全），所以「掃咗但冇讀數」係
  0——守衛同預期一致；要見到非 0 就要等有幣嘅 pair 真嘅消失（或者 lane 局部拒絕）。
- **候選純度嘅提升仍然未量**：呢個 tick pool 1222／slice 90／candidates 0，同改動前冇
  baseline 對比，所以本文唔聲稱任何提升幅度；要量就要睇幾日 `deadMarked` 高出地板人口嘅部分
  同 `poolMisses` 嘅分佈。
