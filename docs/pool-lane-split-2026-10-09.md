# 重估池 slice 兩道 lane ＋ far sweep 12 分鐘（2026-10-09）

> 相關：`docs/pool-mcap-evidence-grace-2026-10-09.md`（上一條槓桿：
> 冇 mcap 證據嘅 row 6h 後出池）、`docs/pool-freshness-mark-2026-10-08.md`
> （死幣標記）、`docs/round-trips.md` §4.48（輪替覆蓋）。

## 一、做咗咩

| 檔案 | 改動 |
|---|---|
| `src/scanner.ts` | 新 `RE_EVAL_FAST_LANE_SHARE = 0.6`（exported，測試釘住）；新 `slicePoolTwoLanes()`（同一個 per-tick 額度拆兩條 lane，各有 cursor、lane 內保留 `slicePoolRotation` 嘅 owed 幣優先同無 wrap-back）；`poolSliceCursor` → `poolSliceCursors {fast, slow}`；call site 用 `recentStats` 嘅 `maxMcapObserved` 做 evidence split；`diag.poolSliceLanes = {fast, filler}` 上 heartbeat；`RE_EVAL_PER_TICK_MAX` 改為 exported（儀器唔再自己抄 90） |
| `wrangler.toml` | `REEVAL_FAR_SWEEP_MIN 18 → 12`（12 / 1.5 = 8 far slots；near 3 / 1.5 = 2 不變） |
| `scripts/test-unit.js` | 5 條 lane 行為測試＋1 條 source pin（見第三節） |

## 二、點解

量度（2026-10-09 23:23–23:35Z，只讀探針）：

1. **band LIMIT 冇 clip 任何有證據嘅 row**：hot 46/46、near 191/191、far 68/68
   全部返回；被 clip 嘅全部係冇 mcap 嘅 row，而且喺 tie group 內（bucket 輪替
   照樣掃到，唔係 starve）。所以「提升覆蓋」唔喺 band LIMIT。
2. **瓶頸係 per-tick slice 嘅分配**：90 行對 ~1,100-1,200 返回池 ⇒ 全池一轉
   ≈ 13 ticks（~6.5min），而 ~2/3 名額落喺寬限期內冇 mcap 嘅 filler
   （一個 slot 度：hot 401 + near 326 + far 154）。
3. **far band 喺 no-evidence prune 之後 underfill**：一個 slot 1,107 → 127
   （cut 980，返回 222 → 127，127 條有證據全部保留）。瓶頸由 LIMIT 轉為
   **sub-window 幾耐出現一次**（18min），因為 slice 只掃到池嘅一部分，slot 就轉走。

兩個改動都係「加覆蓋、唔剔幣」：lane split 唔改 90 額度、唔加 fetch，只改派發；
far sweep 12min 只加密 recurrence。真正嘅剔除（6h 冇證據）留返上一條槓桿，
今次冇再收緊。

## 三、驗收（本機，未 deploy）

- `npm run build` **exit 0**；`test-unit.js` **508 passed / 0 failed**（新增：
  fast lane 份額、兩條 lane 各自一轉內全覆蓋、細 lane 只 reset 自己 cursor、
  空 fast lane 全額讓俾 filler、owed 幣喺 lane 內保持優先，＋call-site source pin）。
  其餘 8 個 suite（deferred-priority、tick-path、schema-gate、health-front、
  dex-list-cache、usd-formatter、dex-last-profiles、tick-legs）全 pass。
- **Live 模擬**（2026-10-10 00:03:20Z；生產 `getReevalPool` 一次讀：pool 1,074，
  evidence 294 / filler 780；同一個 array 分別跑舊／新 slicer 60 ticks，靜態池）：

| slicer | first-appearance p50/p90 | 最大重估 gap p50/p90/max | missed |
|---|---|---|---|
| 舊 single cursor（全部） | 6 / 11 | 12 / 12 / 12 | 0 |
| 新 fast lane（有證據） | 3 / 5 | **6 / 6 / 6** | 0 |
| 新 filler lane（冇證據） | 11 / 20 | 22 / 22 / 22 | 0 |

→ 有證據 row 嘅重估週期 **12 → 6 ticks**（30s clock ≈ 6min → ~3min）；
filler 全部照掃（22 ticks ≈ ~11min），零剔除；兩條 lane 都冇 row 被漏。

## 四、Deploy 後要讀嘅數

1. `/health` summary：`poolSliced` 要維持 **90**（lane split 唔加大額度）；
   新欄 `poolSliceLanes.fast + filler` 應 ≈ `pool` 減 feed 行；
   `poolMisses` 0；tick `ms` / `evalMs` 唔升；`fails.mcap` / `fails.other` 唔惡化；
   `candidates` / `pushed` 唔退。
2. far recurrence：`REEVAL_FAR_SWEEP_MIN = 12` ⇒ 8 slots × 90s = 12min
   （對比之前 18min）；睇 `/debug/pool` 同 sweep 讀數。
3. 未量：`RE_EVAL_FAST_LANE_SHARE = 0.6` 係常數。如果 evidence 人口比例之後大變
   （e.g. registration 補 mcap 之後），fast lane cycle 會跟住變，要再量再調。

## 五、界線（老實講）

- 模擬係**靜態池**：真池每 90s 換 slot（band rotation），兩邊同樣受 drift 影響；
  模擬證明嘅係 slicer 行為，唔係未來 fill rate。
- `slicePoolTwoLanes` 有行為測試；call-site 只有 source pin（唔會跑真 Scanner 物件）。
- far sweep 只改 wrangler 值；`src/config.ts` 嘅 clamp（near ≤12、far ≤48）不變，
  值必須係 cache TTL 嘅倍數（12 / 1.5 = 8）。
