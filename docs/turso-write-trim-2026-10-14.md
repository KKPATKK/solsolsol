# 2026-10-14 Turso 寫入裁剪：observed-liquidity 批改成「邊緣觸發」

免費 plan 嘅寫入額度係 **10M rows written／月（= 333k／日）**，而量到嘅實際用量係
**613k–710k／日**（~233–267 行／tick × 2,650 tick）——即係長期超支，所以要砍。今次只改一條
statement：`Db.recordObservedLiquidity`，令它**只在寫入仍然可以改變判決**時才寫。

## 1. 量到嘅數（2026-10-14）

Turso usage API（org/db `kkpatkk`，`GET /v1/organizations/<org>/databases/<db>/usage`）：

| 日 | rows_read | rows_written | 寫入／tick |
|---|---|---|---|
| 10-09 | 15.48M | 565,782 | 213 |
| 10-11 | 12.04M | 545,385 | 204 |
| 10-12 | 14.40M | 710,204 | 267 |
| 10-13 | 18.79M | 643,321 | 242 |

每 tick 寫入嘅成分（`/health.dbSteps` 嘅 call 數 ＋ `/health.heartbeat.summary` 嘅
`pairs` 讀數 ＋ 代碼逐條對）：

| 來源 | 行／tick | 佔比 |
|---|---|---|
| **`recordObservedLiquidity`**（每個本 tick 攞到 pair 讀數嘅池幣 1 行）| **~204** | **~85%** |
| `noteSweptWithoutReading`（每個 miss +1）| 0–50（`pairsMissing 0` 時係 0）| 少 |
| token_stats 登記 INSERT | ~20 | 8% |
| `pruneOldTokenStats` DELETE（10 分鐘一次，攤分）| ~20 | 8% |
| tracker claim／check、front／tail／state／ring | ~30–45 | 15% |

`pairs 204` = feed legs union（profiles 26 + pump 20 + meteora 19 + jup 30 + jupTrend 5 +
raydium 20，去重後 ~95）＋ `poolSliced 90` ＋ tracker head 30。**寫入量基本上就係呢條數**，
所以砍它就係砍 ~85%。

## 2. 規則：三種情況才寫，其餘跳過

```sql
UPDATE token_stats SET last_liquidity_usd = CASE token ... END,
       sweeps_since_reading = 0
 WHERE token IN (...)
   AND (sweeps_since_reading > 0              -- ① freshness mark 需要歸零
        OR last_liquidity_usd IS NULL         -- ② 第一次讀數（fail-open 分支／census）
        OR ((last_liquidity_usd < 1000)
            IS NOT ((CASE token ... END) < 1000)))  -- ③ 跨過 $1,000 呢條線（任一方向）
```

**為何判決等價**：`last_liquidity_usd` 全個 codebase 只有三種讀者 ——

1. `DEAD_POOL_MARK`（`last_liquidity_usd < $1,000 OR sweeps_since_reading >= 3`）——兩個
   pool query builder 都掛 `DEAD_POOL_CLAUSE`；
2. `getPoolHistogram` 嘅 `deadMarked`／`deadPending`（`/debug/pool`）；
3. `/debug/pool` 嘅 coverage census。

條 column 只會被**同 $1,000 比較**，所以「同一邊」嘅兩個讀數對以上所有讀者完全一樣 ——
存 25,000 定 24,000 都係 alive，存 900 定 800 都係 dead。要寫嘅就只有：mark 要清零、
第一次讀到、同埋真正穿線嗰次。push 路徑完全唔讀呢條 column（gate 讀
`max_liquidity_observed`，由 `updateTokenMaxMcaps` raise-only 維護）。

**已知副作用（只影響診斷）**：column 由「最新讀數鏡射」變成「最後一次關鍵變化」——
一隻靜靜地活住嘅幣會留住上次穿線時嘅數（~$1,000 附近）而唔係今日嘅數；同一隻死屍被掃幾
多次都留住殺死它嗰個數。`deadMarked`（由同一堆 state 數出來）同 pool query 嘅判決**不變**，
`deadPending` 同 census 由「讀數」變成「穿線」。

## 3. 改動

| 檔案 | 改動 |
|---|---|
| `src/db.ts` | `recordObservedLiquidity`：WHERE 加三條件；CASE 綁兩次（SET 同 WHERE 各一次），args 順序 = CASE pairs → IN list → CASE pairs；doc comment 記低規則、依據同副作用 |
| `scripts/test-unit.js` | 新測試 `pool: a routine reading is not written — only a crossing, a first reading or a mark to clear`：釘住 (a) 同邊跳過、(b) 穿線寫、(c) 同邊重複跳過、(d) 死屍重讀跳過、(e) 第一次讀數寫、(f) mark 清零寫，再讀一次 pool query 證明四個判決（穿線即踢、死屍唔返、NULL fail-open、mark 清返入池）同以前一樣 |

## 4. 驗收（deploy 之後）

| 讀數 | 預期 |
|---|---|
| Turso usage `rows_written`／日 | 由 613–710k 跌到 **~110–160k**（−70~80%）|
| 同一小時嘅 `pairs`（`/health.heartbeat.summary`）| **唔變**（~204）—— 跳過嘅係寫入，唔係 pair 讀取 |
| `/debug/pool` `deadMarked` | 唔應該跌（穿線嗰次照寫，死屍照留低嗰個數）|
| `/debug/pool` `poolQueryCount` / `buckets` | 唔應該升（冇幣因為跳過寫入而返池）|
| `dbSteps.recordObservedLiquidity.calls` | 唔變（仍然每 tick 一次 call，只係 `rowsAffected` 由 ~204 變穿線數）|

## 5. 未改動嘅其他寫入源（如果仲要再砍）

- `noteSweptWithoutReading`：`pairsMissing > 0` 嘅 tick 先有數，同一個 cadence 一齊睇。
- phase ladder：**已於同日處理，見第 6 節**。
- tracker `persistPassNote` ~1.5 行／tick（pass 嘅 `running` 同 `done` 兩張 row）：改動會影響
  「pass 有冇卡住」嘅讀數，要先量清楚先好動。
- tracker `claimPushWatchChecksMany` ~30 行／tick：改動會延遲 follow-up 卡，屬「影響運作」。
- `pruneOldTokenStats` DELETE = 登記數（穩態），要減就要縮 30h retention（會提早踢走池幣）。
- 緊急掣（無代碼改動）：`CLOCK_TICK_SECONDS "30" → "60"` ⇒ 所有 per-tick 讀寫減半，代價係
  掃描節奏減半（卡最遲遲 30–60 秒）。

## 6. L2（同日後續）：phase ladder 加風險閘

`worker_state.tick_progress` 係 tick 唯一嘅「逐相」記錄（admission → `front` → `pair` → `gate`
→ `postscan`），用嚟解釋一隻死咗嘅 tick 死在哪一相。實測 `dbSteps`
`setWorkerState:tick_progress` = **65 calls／17 ticks = 3.8 行／tick**（~10k／日，~2% 免費額度），
而其中三張中間相（`front`/`pair`/`gate`）係**保險**：正常 tick 寫完冇人睇。

**量到嘅分佈**（`scan_history`，7 日 18,475 tick）：0–3s 6,244、3–5s 11,624（⇒ **96.7% 嘅 tick 喺
5 秒內完結**）、5–8s 275、8–12s 13、12s+ 319（全部係 15.5s 嘅 race cut）。同期
`ok=0` 318 條、而**後面帶 `prog` note 嘅：0 條** ⇒ 一星期內 ladder 冇出過任何讀數。

**改動**：`TICK_PHASE_STAMP_MIN_MS = 5_000` ＋純函數 `tickPhaseStampDue(startedAt, now)`；
`notePhase` 喺 queued 之前先問一次，唔夠鐘就 return。結果：健康 tick 只寫
**admission（騎 claim batch，0 行）＋ pre-flush record（1 行）**，即 ~1.1 行／tick，
**−2.7 行／tick ≈ −7.2k／日 ≈ −215k／月**。

**為何仍然捕捉到原本要捕捉嘅形狀**：慢嘅 tick 係「因為慢才會死」，所以慢嘅那一相自己就會
過 5 秒——feeds 拖到 8s 嘅 tick 會喺 8s stamp `front`，pool read 卡住嘅會 stamp `pair`，上面嗰批
cut／kill 全部 stamp `gate` 再 stamp pre-flush record。唯一失掉嘅形狀係「5 秒內就死」
（無任何記錄先例，而 admission stamp 已經寫低咗 `scan`）。admission stamp 同 pre-flush record
**故意唔受閘限**（測試釘住：`tickPhaseStampDue` 全個 worker 只有定義 + 一個 call site）。

**驗收讀數（一鍵）**：`node scripts/verify-tick-progress-writes.js`（唯讀：兩個 GET）。佢讀
`/health.heartbeat.summary.dbTickSteps["setWorkerState:tick_progress"]`（**每 tick** 嗰個，零點
在 `runOnce` 開頭拍下，尾巴都計在內）＋ `dbSteps` 嘅 rows／run 比（以 `claimScanLock` 為分母，
因為 `/health` 自己就係同一個 isolate 嘅 invocation，可以弄臟絕對計數）＋
`/debug/scan-history?rows=500` 嘅 ms 直方圖、`ok=0` 數同所有 `prog` note。
加 `--expect-live` 它在未上線時 exit 1 —— 就係用來卡住「未 deploy 就當驗過」。

**deploy 前實測（2026-10-15T00:34–00:36Z，同一個 script 跑出來）**：
`138 rows / 35 runs = 3.94 rows/run`；4 隻健康 tick（ms 1339／3269／3597／4120）分別寫
**2、2、2、3 行**；500 tick 嘅 ms 直方圖 167／324／9／0／0（衹有 1.8% 過 5 秒閘）、`ok=0` 0、
`prog` note 0。⇒ 上線後同一頁應該係「健康 tick 1 行、ratio ≤ 1.2」，而 `prog` note 仍然
衹有「真係死過 tick」才有（由後繼 tick 補寫）。

**測試**：`tickPhaseStampDue: the phase ladder is risk-gated, and the pre-flush record is not`
（2.9s／4.4s 唔 due、5.0s 邊界 due、15.5s／20s due、倒流時鐘／NaN 唔 due、bound 落喺 4–8s、
以及 stripped source 嘅 call-site 數目）。

**驗收**：deploy 後 `dbSteps.setWorkerState:tick_progress` 應該由 ~4／tick 跌到 ~1／tick；
`/debug/scan-history` 嘅 `ok` row 照樣每 tick 有一條（pre-flush record 冇被閘）。

注意 `prog` note 嘅真實來源（先前寫錯，現更正）：`tickProgressNote` 係**後繼 tick 幫死掉嘅前任
補寫**嘅（`deadTickBackfillInfo` 判定前一個 heartbeat 已經 stale），所以一隻**合作式 cut** 嘅 tick
—— 它自己寫完 flush 同 err（例如 `ms 15500`）——**唔會有** `prog` note。實測：7 日窗口 318 條
`ok=0` 全部係 cut／self-reported failure，其中帶 `prog` 的 = **0**；而 500 tick 窗口內 `prog` = 0
即係「無 tick 死過」，唔係「見證被閘丟了」。所以這條驗收糢式唔應該係「睇到 prog note」，而係：
**將來真有死 tick 時，佢嘅 note 要仍然報得出相名**（閘在 5 秒以上才會開，而死嘅 tick 一定是慢嘅）；
今日嘅窗口無死 tick，就無法提前證到這一點。

**deploy 前基線（live，2026-10-15T00:29Z 讀 `/health`）**：`dbSteps.setWorkerState:tick_progress
94 calls / 24 runs = 3.92 行／run`（4685ms，係全場最大單一 `setWorkerState` 來源）——同 10-14
嘅 65／17 = 3.8 一致，所以「~4 → ~1」嘅目標係同一個量。同一個 census 顯示仲有兩個
每 run 嘅 state 寫入：`push_watch_pass` 1.42／run（pass 嘅 `running`＋`done` 兩張 row）同
`writeScanFront` 1.33／run（無改動，二者都唔可以壓成一次寫入——前者嘅 `running` 係
「pass 係唔係卡住」嘅見證，寫在 pass 完結之前才有意義，同 ladder 嘅死亡見證同一個道理）。
