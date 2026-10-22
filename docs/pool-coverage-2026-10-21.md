# 2026-10-21：near/far 掃描覆蓋 —— 由「排隊頭」改成「按 cadence 分配」＋ cursor 持久化

## 一、量到乜（2026-10-21 00:31–00:42Z，production）

`/health`、`/debug/pool`、`/debug/tick-legs` 的 durable 240-tick ring，加一條直接對 D1 跑的
band count（predicate 與 `Db.getReevalPool` 逐句一致，用 `460 + 518 + 136 = 1,114 =
poolQueryCount` 交叉驗證過）：

| band | prune 後行數 | per-slot LIMIT | 結果 |
|---|---|---|---|
| hot（age 50–110min） | 1,007（evidenced 74，其中回傳 25） | 460 | **54% 冇回傳** |
| near slot 0 / 1（110min–6h50m） | **2,390 / 1,459** | 518 | **72–78% 冇回傳** |
| far slot 0–7（6h50m–29h） | 133–189 | 222 | ✅ 冇 clip |

而 tick 的 90 個 eval 位**每個 tick 都填滿**（`poolSliced 90`、`pairs 257–274`、
`pairsMissing 0`、`ms 1.2–2.2s`），但 5 個連續 tick 的 reject log 顯示：

| tick | via | reject 年齡 |
|---|---|---|
| 00:40:34 | clock | 70–90m（全 hot） |
| 00:40:51 | cron | 276–437m（near/far） |
| 00:41:34 | clock | 71–91m（全 hot） |
| 00:41:51 | cron | 297–438m（near/far） |

## 二、兩個根因

1. **slice 取的是「pool 回傳次序的頭」**。`getReevalPool` 回傳 hot → near → far，
   `slicePoolTwoLanes` 只按 mcap evidence 分兩條 lane，再各自取頭 54 / 36 行。
   實測 lane 人口：hot evidenced 74（fast 頭 54 行全部喺 hot）、hot filler 939
   （filler 頭 36 行全部喺 hot）→ **冷 isolate 的 90 個位 100% 係 hot**，near/far
   要等暖 isolate 的 cursor 推過 hot 才輪到。
2. **cursor 只存在 isolate 內**。兩個 delivery 輪流落在暖／冷 isolate（`poolCache.memory`
   0 / `misses 1` 對 `memory 2`），冷 isolate 每次都由 0 開始，所以 5 分鐘後 14/20 個
   reject token 一模一樣（年齡 +5）。near+far prune 後 5,139 行、暖 tick 每分鐘 90 行
   → **約 57 分鐘一輪**，而設計係 near 3 分鐘 / far 12 分鐘。

## 三、改咗乜

### 1. `slicePoolZones`（`src/scanner.ts`，取代 `slicePoolTwoLanes`）

Window 由「排隊頭」改成**按 band 自己的 cadence 分配**：

| zone | 每 tick take | 生產數字（window 150） |
|---|---|---|
| hot（evidenced） | `min(len, 0.18 × window)`，每個 tick | 25（cap 27） |
| near（evidenced） | `len / appearance`，`appearance = nearTicks ÷ nearSlots`，上限 `0.43 × window` | `190 / 3 ≈ 64` |
| far（evidenced） | `len / appearance`，`appearance = farTicks ÷ farSlots`，上限 `0.27 × window` | `155 / 3 ≈ 52`，cap 40（4 ticks，仍遠在 24-tick recurrence 內） |
| filler | **預留** `0.12 × window`，再食剩餘 | 18（之前係「剩幾多食幾多」，繁忙時跌到 4） |

- 每個 zone 有**自己一個 cursor**，經 `slicePoolRotation`（tail 規則、deferred 優先
  全部繼承），所以同一 zone 一輪內唔會重複、亦唔會 wrap back。
- **near/far 係輪轉 cohort（每個 slot 一個 sub-window）**：pool query 每 `poolTTL`
  換一個 slot，同一個 sub-window 只會出現 `appearance = recurrence ÷ slots` 個 tick
  （near 2 slots → 3 ticks；far 8 slots → 3 ticks）。所以 take 係除以 **appearance**
  （`len / 3`），唔係除以 recurrence（`len / 6`、`len / 24`）——後者只掃到 sub-window
  的 1/slots，其餘行永遠等唔到。
- **每個 sub-window 各自一個 cursor**（`near: number[]`、`far: number[]`，index =
  slot）：sub-window 落畫時 cursor 跟住停，返嚟時由自己條尾續，唔會攞住別的 sub-window
  的 offset 續掃（shared cursor 會令部分行永遠 skip）。Cohort 大過自己的 share cap 時
  只會慢（cursor 跨 appearance 保留），唔會漏。
- Window 係 budget 唔係 quota：zone 細過自己份額就交俾下一個（near → far → hot → filler）；
  zone 到 list 尾就只會服務 tail 並 reset，唔會借位重掃。`slice` 永遠 ≤
  `RE_EVAL_PER_TICK_MAX`。
- **Filler 係預留 lane**：`0.12 × window` 先扣起，再分 hot/near/far；三者有剩餘才
  按上面的次序回流（filler 排最後）。所以 filler 的 cadence 唔再係「其他 lane 食淨幾多」
  的函數 — 18/tick 係保證值，返到 query 每 phase 的 page（~45 行 / 3 ticks）就夠食。
- `RE_EVAL_PER_TICK_MAX` 90 → **150**：hot 27 + near 64 + far 40 + filler 18 = 149。
  Pair fetch 成本用 lane 自己的算式計：30 addresses/batch、250ms spacing、3 條並行
  → `batches × 250 / 3`；150 + feed ~170 + tracker head ≈ 340 addresses = 12 batches
  ≈ 1.0s pacing，仍然遠低過 `PAIRS_FETCH_BUDGET_MS 2,000`。

### 2. Cursor 持久化（`Db.POOL_SLICE_CURSOR_KEY`）

- 新 row `pool_slice_cursor`（JSON `{hot,near:[…],far:[…],filler}`，near/far 係
  每個 sub-window 一個 offset）加入
  `SCAN_FRONT_GATE_KEYS`：讀嘅時候搭 front 的 ONE read，寫嘅時候搭 front 的 ONE
  write（`stampFront`），**零額外 request**。
- 冷 isolate 讀到上一 tick 寫落的 cursor，所以兩個 delivery 都會推進；無 front 的
  standalone Scanner 照舊用 isolate 內 copy。
- 解析 fail-safe：absent / junk / 負數 / NaN → 0（等於未改之前），值 clamp 到
  `POOL_SLICE_MAX_CURSOR`。

### 3. Query 的 band page（`POOL_BAND_ROTATE_BUCKETS = 64`）

2026-10-21 實測（D1，predicate 與 query 逐句一致）：hot band **730** 行（81 evidenced）、
near 兩個 slot **1,451 / 2,034** 行（146 / 168 evidenced）、far band 1,179 行（~1,177
evidenced）。hot limit 460、near 518、far 222，所以 clip 只發生在 no-evidence 行。

舊做法係「signal 排序 + tie-break bucket」：tie-break 只會輪轉同一個 signal key 的
**tie group**，group 下面的行永遠唔會入 LIMIT（實測覆蓋率停在 ~77%）。現在改成：

- `poolBandPageSql()` 係 WHERE clause：`max_mcap_observed IS NOT NULL OR bucket = phase`。
  **Evidenced 行永遠唔 page**（佢哋係 actionable cohort，每次都要返）；no-evidence 行
  每個 phase 只返一個 bucket，而且**整個 bucket 一定入 LIMIT**（K=64：near page ~32、
hot ~11、far ~2，遠低過各自的殘餘額）。
- Phase：hot = 每個 slot（90s）、near = `floor(slot / nearSlots)`、far =
  `floor(slot / farSlots)`。所以每一行 no-evidence 的週期係 **K × recurrence**：
near 64 × 3 min = 3.2h、hot 64 × 1.5 min = 96 min、far 64 × 12 min = 12.8h，
  而且係**保證一次**，唔係抽樣。
- K=64 的兩個 sizing 條件（寫在 `db.ts` 的註釋）：page 要細過 band 的殘餘 LIMIT，
  亦要細過 filler lane 在一個 page 週期內食得落的分量。實測 page ~45 行 / 3 ticks
  ≈ 15/tick，filler 預留 18/tick 蓋得住。
- 副作用：`poolQueryCount` 會由 ~1,329 跌到 ~460–520（回傳行少咗，slice 仍然填滿
  150）；`poolSliceLanes.filler` 會由 731 跌到 ~45。呢兩個都係預期，唔係漏 data。

### 4. Reject log 的 hot cap（`POOL_HOT_REJECT_SLOTS = 8`）

Slice 的 eval 次序係 hot → near → far → filler，而 hot 多數係流動性 $0 的塵，
第一個閘就死。若果照舊 first-come-first-served 填 20 個位，hot 會再霸晒個 log，
near/far 有掃都睇唔到。呢個 cap 令 hot 最多佔 8 個位，剩 12 個位俾 near/far/filler；
owed coin 照舊豁免（`logBudget` 的第一個分支）。

Cap 的範圍係 **今個 tick 實際 eval 的 hot slice**（`feedOnly.length + served.hot`），
唔係整個回傳的 hot cohort（`zoneLists.hot.length`）。生產數字係 25 vs 403：用 cohort
做界，`hotEndIdx` 會越過成條 pool slice，cap 連 near/far 都封埋，剛剛好就係它要
救的那個 starvation。呢個細節由 `matchCoins log budget` 測試釘住（12 行 hot slice
→ 8 行 log、4 行靜音、near 照 log）。

### 5. 驗收讀數

Tick summary 新增：

- `poolSliceLanes`：`{hot, near, far, filler}` 回傳人口（取代舊的 `{fast, filler}`）。
- `poolServed`：今個 tick 每個 zone 實際攞了幾多行。

`poolSliceLanes[zone] ÷ poolServed[zone]` 就係該 zone 一輪的 tick 數；`poolServed`
連續 0 就係 starvation。

## 四、驗證

- `npx tsc --noEmit`、`npm run build` exit 0。
- `node scripts/test-unit.js`：**586 passed, 0 failed**。新增：
  - `slicePoolZones` 10 個測試：生產人口（25/403/136/550、window 150）得到
    `served {25,101,6,18}`（near 拿到 cap 64 再加上 spare 37；far 只需 6；filler 保留
    18）、hot 排第一；403 near 在 6 ticks 內全覆蓋、136 far 在 24 ticks 內全覆蓋；
    細 zone 被整個拿走時只 reset 自己 cursor；空 zone 交還 budget；zone 到尾只服務
    tail；window 係 ceiling（nearTicks=1 都會截到 150）。
  - **輪轉 cohort 回歸**（3 個）：2 near / 8 far sub-window、每個 appearance 3 ticks，
    `served` first tick 係 `{hot:27, near:65, far:40, filler:18}`；near 的 190 行在
    一個 appearance 內全 served（65 × 3 ≥ 190），far 的 155 行跨兩次 appearance
    （cursor 保留）仍然全 served；appearance 縮短到 2 ticks 都唔會餓死；cohort
    260/190 大過 share cap 時 240 ticks 內仍然全覆蓋（慢，但唔 skip）。
  - **query band page 回歸**（`getReevalPool: the overflow is PAGED by bucket`）：30 行
    no-evidence + 1 行 evidenced，64 個 phase 內 30 行**每行只返一次**、冇頁面重疊，
    而 evidenced 行**每個 phase 都返**；page 大小 ≤ 3（唔係 30 行的 head）。
  - grace / pre-filter / seen-exclusion 三個舊測試的 no-evidence 種子改用
    `pagedName(base, phase)`：確保測試觀察的是被測規則，唔係 page filter。
  - `parsePoolSliceCursors` 對新 shape 的測試：near/far array、缺 slot、junk slot、
    clamp、round-trip；舊 row 的單一數字（`{"near":12}`）讀成 slot-0 cursor，
    其餘 slot 由 0 起（會重掃，但唔會漏）。
  - `parsePoolSliceCursors` / `serializePoolSliceCursors`：absent、junk、partial、
    負數、clamp、round-trip。
  - `poolZoneTicks`：2×90s/30s = 6、8×90s/30s = 24、junk 唔會除零。
  - `db.poolZoneOfLaunch`：hot 邊界、pre-window 當 near、6h 邊界、cursor key 在
    `SCAN_FRONT_GATE_KEYS` 內。
  - source pin：call site 係 `slicePoolZones(zoneLists, sliceCursors, ...)`、
    `zoneByToken.set(...poolZoneOfLaunch...)`、durable cursor 的 read/write、
    `diag.poolServed = served`、`hotEndIdx = feedOnly.length + served.hot`。
- 模擬（dist）：24 ticks、輪轉 cohort 生產人口（near 2×190、far 8×155、hot 46）→
  每個 appearance（3 ticks）完結時，該 sub-window 的 190 / 155 行全部 served 且
  冇重複；24 ticks 內兩個 band 全部 sub-window 覆蓋。靜態（non-rotating）人口 403/136
  仍然係 6 / 24 ticks 全覆蓋（appearance = recurrence）。

## 五、上線後要讀乜

1. `/health`：`summary.poolServed` 應該每個 tick 都 ≈ `{27, 64, 40, 18}`（near 有時
   多過 64 係 spare 回流）；`poolSliceLanes` 應該 ≈ `{81, 188, 147, ~45}` ——
   filler 由 731 跌到 ~45 係 page filter 的正常結果，唔係 pool 變空。
2. 隔 5 分鐘抓 `/health`：`hot` cursor 應該已經轉過（`poolServed.hot` ≈ 27），
   而且 reject log 應該**同時**出現 hot（70–110m）同 near/far（>110m）的年齡，
   唔再係冷 tick 全 hot（hot 最多 8 個位，見 §三.4）。
3. `/debug/tick-legs`：`ms` 應由 1.2–2.2s 升到 ~2.5–3.5s（150 + 12 pair batches）；
   如果 `pairs` 明顯低過 `pairsMissing` 或 tick 反覆撞 `PAIRS_FETCH_BUDGET_MS`，
   window 要退回 120 並重讀 cadence（near 仍然係 `188/3 ≈ 63`，filler 保留 ~14）。
4. `/debug/pool`：`poolQueryCount` 會由 ~1,329 跌到 ~460–520（evidenced 全返，
   no-evidence 只返一個 page）。唔好當佢係載入失敗；`poolSliceLanes` 仍然有
   ~460 行可以填滿 150-row slice。

## 六、殘餘（照直講）

- **no-evidence 的 cadence 係「保證一次」而唔係「快」**：K=64 下 near 3.2h、hot 96 min、
  far 12.8h 一輪。呢個係 bandwidth 的物理下限（near 兩個 slot 共 3,485 行、filler lane
  18/tick），唔係漏掃；想快就要加 window（會壓低 near/far 或 pair fetch 預算）或減
  行數（prune / 收窄 age window），兩者都係另一個 measurement。
- **Evidenced 行仍然受 band LIMIT 約束**：page filter 只輪轉 no-evidence 行；如果某 band
  的 evidenced 多過自己的 LIMIT（hot 460 / near 518 / far 222），超出部分會永遠被切。
  2026-10-21 實測 hot 81 / near 168 / far ~147，全部在限額內，所以唔係當前問題；
  要重讀時看 `poolSliceLanes` 與 evidenced count。
- **cadence 假設 30s tick**（`POOL_SLICE_TICK_MS`）。clock 停咗只剩 cron 1/min 的話，
  near/far 會等比例拉長一倍，但唔會漏掃。
- `Db.getReevalPool` 的 band LIMIT（hot 460 / near 518 / far 222）冇改：今次是將
  **超出 LIMIT 的部分變成有界 page**，唔係加大 LIMIT。
- **Snapshot key 已 bump**：`POOL_QUERY_SHAPE_VERSION` 由 `v3-2026-10-09-mcap-evidence`
  升到 `v4-2026-10-21-band-page`，所以舊 predicate 寫落的 edge snapshot 唔會被新查詢
  當成同一個 key 讀（deploy 後第一個 slot 會 miss 重建，最多一個 TTL）。
