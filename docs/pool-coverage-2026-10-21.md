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
| hot（evidenced） | `min(len, 0.2 × window)`，每個 tick | 25（cap 30） |
| near（evidenced） | `len / nearTicks`，`nearTicks = nearSlots × poolTTL ÷ 30s` | `403 / 6 ≈ 68` → 3 分鐘掃完 |
| far（evidenced） | `len / farTicks`，`farTicks = farSlots × poolTTL ÷ 30s` | `136 / 24 ≈ 6` → 12 分鐘掃完 |
| filler | 剩餘 | 51（舊 90-row split 只有 36，**冇退步**） |

- 每個 zone 有**自己一個 cursor**，經 `slicePoolRotation`（tail 規則、deferred 優先
  全部繼承），所以同一 zone 一輪內唔會重複、亦唔會 wrap back。
- Window 係 budget 唔係 quota：zone 細過自己份額就交俾下一個（near → far → hot → filler）；
  zone 到 list 尾就只會服務 tail 並 reset，唔會借位重掃。`slice` 永遠 ≤
  `RE_EVAL_PER_TICK_MAX`。
- `RE_EVAL_PER_TICK_MAX` 90 → **150**：25 + 68 + 6 = 99 行 fast，留 51 行俾 filler。
  Pair fetch 成本用 lane 自己的算式計：30 addresses/batch、250ms spacing、3 條並行
  → `batches × 250 / 3`；150 + feed ~170 + tracker head ≈ 340 addresses = 12 batches
  ≈ 1.0s pacing，仍然遠低過 `PAIRS_FETCH_BUDGET_MS 2,000`。

### 2. Cursor 持久化（`Db.POOL_SLICE_CURSOR_KEY`）

- 新 row `pool_slice_cursor`（JSON `{hot,near,far,filler}`）加入
  `SCAN_FRONT_GATE_KEYS`：讀嘅時候搭 front 的 ONE read，寫嘅時候搭 front 的 ONE
  write（`stampFront`），**零額外 request**。
- 冷 isolate 讀到上一 tick 寫落的 cursor，所以兩個 delivery 都會推進；無 front 的
  standalone Scanner 照舊用 isolate 內 copy。
- 解析 fail-safe：absent / junk / 負數 / NaN → 0（等於未改之前），值 clamp 到
  `POOL_SLICE_MAX_CURSOR`。

### 3. Reject log 的 hot cap（`POOL_HOT_REJECT_SLOTS = 8`）

Slice 的 eval 次序係 hot → near → far → filler，而 hot 多數係流動性 $0 的塵，
第一個閘就死。若果照舊 first-come-first-served 填 20 個位，hot 會再霸晒個 log，
near/far 有掃都睇唔到。呢個 cap 令 hot 最多佔 8 個位，剩 12 個位俾 near/far/filler；
owed coin 照舊豁免（`logBudget` 的第一個分支）。

Cap 的範圍係 **今個 tick 實際 eval 的 hot slice**（`feedOnly.length + served.hot`），
唔係整個回傳的 hot cohort（`zoneLists.hot.length`）。生產數字係 25 vs 403：用 cohort
做界，`hotEndIdx` 會越過成條 pool slice，cap 連 near/far 都封埋，剛剛好就係它要
救的那個 starvation。呢個細節由 `matchCoins log budget` 測試釘住（12 行 hot slice
→ 8 行 log、4 行靜音、near 照 log）。

### 4. 驗收讀數

Tick summary 新增：

- `poolSliceLanes`：`{hot, near, far, filler}` 回傳人口（取代舊的 `{fast, filler}`）。
- `poolServed`：今個 tick 每個 zone 實際攞了幾多行。

`poolSliceLanes[zone] ÷ poolServed[zone]` 就係該 zone 一輪的 tick 數；`poolServed`
連續 0 就係 starvation。

## 四、驗證

- `npx tsc --noEmit`、`npm run build` exit 0。
- `node scripts/test-unit.js`：**583 passed, 0 failed**。新增：
  - `slicePoolZones` 5 個測試：生產人口（25/403/136/550、window 150）得到
    `served {25,68,6,51}`、hot 排第一；403 near 在 6 ticks 內全覆蓋、136 far 在 24
    ticks 內全覆蓋；細 zone 被整個拿走時只 reset 自己 cursor；空 zone 交還 budget；
    zone 到尾只服務 tail；window 係 ceiling（nearTicks=1 都會截到 150）。
  - `parsePoolSliceCursors` / `serializePoolSliceCursors`：absent、junk、partial、
    負數、clamp、round-trip。
  - `poolZoneTicks`：2×90s/30s = 6、8×90s/30s = 24、junk 唔會除零。
  - `db.poolZoneOfLaunch`：hot 邊界、pre-window 當 near、6h 邊界、cursor key 在
    `SCAN_FRONT_GATE_KEYS` 內。
  - source pin：call site 係 `slicePoolZones(zoneLists, sliceCursors, ...)`、
    `zoneByToken.set(...poolZoneOfLaunch...)`、durable cursor 的 read/write、
    `diag.poolServed = served`、`hotEndIdx = feedOnly.length + served.hot`。
- 模擬（dist）：24 ticks、生產人口 → tick 6 `near 403/403`、tick 19 `far 136/136`、
  每個 tick slice 150。far 早過 24 係因為 spare budget 會交俾下一個 zone：near 在
tick 6 到尾（63 行，5 個位剩）、filler 在 tick 11 同 18 到尾，呢啲位全部按
near → far → hot → filler 次序落入 far，所以 far 唔止 6/tick。24 ticks 係上界，
唔係唯一結果。

## 五、上線後要讀乜

1. `/health`：`summary.poolServed` 應該每個 tick 都 ≈ `{25, 68, 6, 51}`；
   `poolSliceLanes` 應該 ≈ `{25, 403, 136, ~550}`。
2. 隔 5 分鐘抓 `/health`：`hot` cursor 應該已經轉過（`poolServed.hot` 25），
   而且 reject log 應該**同時**出現 hot（70–110m）同 near/far（>110m）的年齡，
   唔再係冷 tick 全 hot（hot 最多 8 個位，見 §三.3）。
3. `/debug/tick-legs`：`ms` 應由 1.2–2.2s 升到 ~2.5–3.5s（150 + 12 pair batches）；
   如果 `pairs` 明顯低過 `pairsMissing` 或 tick 反覆撞 `PAIRS_FETCH_BUDGET_MS`，
   window 要退回 120 並重讀 cadence（near `403/6` 仍然 ≈ 68，filler 會變 21）。
4. `/debug/pool`：`poolQueryCount` 仍會 ≈ 1,114（hot 460 + near 518 + far 136）。
   呢個數字唔會因為今次改動而變 —— **band 的 LIMIT 係 query 的事**，今次修的是
   slice 的分配。

## 六、殘餘（照直講）

- **near band 仍然被 query clip**：2,390 / 1,459 行只有 518 回傳。evidenced 的 403
  行全部在 518 之內，所以 actionable cohort 冇被切；被切的是 no-evidence filler，
  它們靠 `POOL_BAND_ROTATE_BUCKETS` 的 8 個 tie bucket 在 8 個 recurrence（~24 分鐘）
  輪流被抽樣，唔係逐隻掃。要把全部 3,845 行逐隻掃，要改 slot 數（near 8 slots →
  12 分鐘一輪）或者加 `RE_EVAL_POOL_SIZE`，兩者都係另一個 measurement。
- **filler lane 唔係 cadence promise**：51/tick 對 ~550 行 = ~11 ticks（5.5 分鐘）
  一輪；hot filler（約 435 行）約 4–5 分鐘先拿到第一次讀數，比舊「每個冷 tick 都掃
  hot 頭」慢。代價換來 near/far 的 actionable cohort 3/12 分鐘，亦令 filler lane
  由 36/tick 升到 51/tick（overall 快咗）。
- **cadence 假設 30s tick**（`POOL_SLICE_TICK_MS`）。clock 停咗只剩 cron 1/min 的話，
  near/far 會等比例拉長一倍，但唔會漏掃。
- 今次只改 slice 分配與 cursor；`Db.getReevalPool` 的 band LIMIT（hot 460 / near 518
  / far 222）冇改。
