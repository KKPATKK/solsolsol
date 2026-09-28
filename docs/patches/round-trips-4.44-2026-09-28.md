---

## 4.44 drain 讓路門檻：由固定 14 改成「量度到嘅需要」＋隊列過上限就強制落地（2026-09-28）

### 病徵（live，2026-09-28 00:02–00:28Z，60s 模式）

| 時間 | `writeDrain.owedTokens` | `calls`（isolate 累計） | `heldForTracker` |
|---|---|---|---|
| 00:02 | 305 | 5 | 1 |
| 00:04 | 486 | 5 | 2 |
| 00:10 | 894 | 6 | 2 |
| 00:14 | 1072 | 7 | 2 |
| 00:25 | **2010** | 7 | 2 |
| 00:28 | **2098** | 7 | 2 |

`failures 0`、`write_drain_error` 空 —— 即係**唔係壞，係完全冇落地**：26 分鐘內隊列由 305 升到
2098 筆，而 isolate 一生只成功交過 7 個 call。

### 算術（就係 14 呢個數出事）

```
subreqRemaining() = 38（50 − 12 未見reserve）− counted
drain 讓路條件   = left <= DRAIN_TRACKER_RESERVE(14)
                  ⇒ counted >= 24 就完全讓路
```

實測 `counted` **24–36**（p50 ~27），所以 `left` 係 2–14，**每一個 tick 都 ≤ 14** ⇒ zero landings。
14 本身冇錯：佢係「一個有 room 嘅 pass 值得開跑」嘅需要（8 rows + 6 tail writes），只係呢個 bot 嘅
tick 已經冇 room 畀佢 —— 60s cadence 恢復之後 scan 自己先用咗 24–36。

### 改動（一個 commit 兩半）

1. **量度而唔係假設（②）**：`worker.ts` 喺 tick path 嗰個 pass 前後量 `subreqRemaining()` 嘅差，
   餵入 `tickprobe.noteTrackerPassSpend()`；`drainTrackerReserve()` 取最近 5 個樣本嘅 **worst**，
   clamp 落 `[DRAIN_TRACKER_RESERVE_MIN(9), DRAIN_TRACKER_RESERVE(14)]`。
   冇樣本（未量度過）就照舊 14 —— 未量度嘅 isolate 行為**完全不變**。
   9 = `pushwatch` 嘅 `TRACKER_SUBREQ_FLOOR(3) + TRACKER_SUBREQ_RESERVE(6)`，即「仍然算係一個 pass」
   嘅下限。**只有 tick path 會報數**：pass 自己個 cron delivery 獨佔成個 window，佢喺嗰度花幾多同
   共用 invocation 剩幾多 room 冇關係。
2. **過上限就強制落地（①）**：`owedTokens >= DEFERRED_FORCE_DRAIN_RECORDS`（= `40 × 10` = **400** 筆）
   時，yield 降到 `DEFERRED_FORCE_DRAIN_FLOOR`（**6**），即係淨係保住 pass 自己嘅 tail writes
   （note persist + deferral sync）。pass 可以照樣 `deferred:subreq-budget` 讓路（by name，唔會死），
   但唔可以連「我有跑過」嗰個 write 都冇。

新常數（`src/tickprobe.ts`）：

| 常數 | 值 | 意思 |
|---|---|---|
| `DRAIN_TRACKER_RESERVE` | 14 | 自適應 reserve 嘅**上限**，亦係未量度時嘅值 |
| `DRAIN_TRACKER_RESERVE_MIN` | 9 | 下限（3 + 6） |
| `TRACKER_PASS_SPEND_RING` | 5 | 取 worst 嘅樣本數 |
| `DEFERRED_FORCE_DRAIN_RECORDS` | 400 | 過咗就唔等 pass |
| `DEFERRED_FORCE_DRAIN_FLOOR` | 6 | 強制模式淨係留畀 pass 嘅 tail |

`writeDrain` view 多一個 `reserve`：14 = 未量度（等同舊行為）、9–14 = 量度到嘅 yield、
6 = 強制模式、0 = 空隊列。

### 測試同 mutation

`scripts/test-unit.js`（+1 測試，386 passed / 0 failed）釘住：未量度 = 上限；量度後跟 worst、
clamp 落 floor；離譜讀數（負數 / > usable / NaN）**丟棄而唔係夾**（個 counter 同 peer pass 共用，
會有壞樣本）；`left = 14` 未量度時仍然 hold、量度到 6 之後**同一個 room 就落地**；
隊列過 400 就降到 6 並交到一個 batch，而**同樣 room 之下未過上限就照樣 hold**（control）；
以及 worker 只有 tick path 一個 call site 報數。

mutation 6/6 全部被捉到（`docs/patches/drain-reserve-mutation-2026-09-28.check.js`，逐個跑、每次
byte-for-byte 還原）：抽走 force rule、用最新樣本代替 worst、抽走 floor clamp、相信離譜讀數、
gate 改返 flat 常數、worker 唔再報數。

### 驗收（live 睇乜）

1. `writeDrain.reserve` 應該由 14 開始，跟住出現 **9–13**（量度生效）；`heldForTracker` 應該
   由 2 變成 0–1。
2. `owedTokens` 應該**跌**（唔再單調上升）、`totals.calls` 應該明顯升。
3. `push_watch_pass` 唔應該退化：仍然 `via: cron-pass`、`rows 26/26`；如果開始見到
   `deferred:subreq-budget` 或 `rows` 大跌，即係 yield 調得太薄 ⇒ 覆檢 `TRACKER_PASS_SPEND_RING`
   嘅 worst 有冇如實反映（或者把 `DRAIN_TRACKER_RESERVE_MIN` 調返上去）。
4. 隊列過 400 嗰陣：`reserve 6` + `calls 1`（每 bucket 40 筆），直到跌返落上限以下。

> 註：drain 嘅 subrequest 唔會計入 heartbeat 嘅 `subreqs`（summary 喺 `onTickEnd` 之前 serialize），
> 亦唔會影響下一個 tick（每個 invocation 一個新 window）—— 所以 §4.43 嗰條 `counted` 基準線唔變，
> 唔需要重新校準。
