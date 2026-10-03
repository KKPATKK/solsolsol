# Boosts feed：ladder 天花板之下唔再被 slot drop（2026-10-03）

## 一、需求

Operator 跟進上一輪（§4.58）嘅界線①：「boosts：現時基本上每次都被 throttle slot drop（未送出），output ≈ 0；要恢復覆蓋係設計取捨（leg 次序／throttle），未改」。

即係：要唔要、同埋點樣，恢復 boosts 呢條 lane 嘅覆蓋。

## 二、量到嘅原因（讀碼 + live，2026-10-03）

### 機制：呢個唔係「取捨」，係一個算術上永遠唔會成立嘅窗口

| 讀數 | 值 | 意思 |
|---|---|---|
| boosts leg 嘅預算 | `deadline = max(now + 480, throttle.nextSlotAt() + BOOST_FEED_ATTEMPT_MS[480])` | 佢一定要等 **自己嘅 slot** 加一次嘗試 |
| slot 由邊度嚟 | tick **第一支** DexScreener 請求（profiles，tick 開始 dispatch） | slot ≈ 第一支請求 + 一個 gap |
| gap 嘅上限 | `DEX_ADAPTIVE_MAX_MS = 1200` | 429 自適應嘅天花板（250→400→640→1024→1200） |
| ⇒ leg 最壞情況 | **1200 + 480 = 1680ms**（由 tick 開始計） | |
| 佢收到嘅 cap | `FEED_DEADLINE_MS = 1600`（shared feed deadline） | **1600 < 1680 ⇒ 結構上塞唔落** |

所以喺天花板之下，`getJson` 嘅 slot 檢查**每個 tick** 都係「未送出就 drop」，唔係偶發、唔係取捨 —— 係一條永遠靜音嘅 lane，直到 spacing 自己落返去。

### Live 對照（2026-10-03 抽樣，`/health`）

| 時間 (Z) | `intervalMs` | `spacingSteps` | `boosts` | `dropsByLeg.boosts` | `feedsMs` |
|---|---|---|---|---|---|
| 09:46:13 | 1200 | 4 | **0** | 26 | 752 |
| 09:46:56 | 1200 | 4 | **0** | 27 | 750 |
| 09:47:40 | 750 | 3 | **22** | 2 | 786 |
| 09:48:01 | 1200 | 4 | **0** | 5 | 766 |
| 09:48:45 | 1200 | 4 | **0** | 1 | 758 |

- **天花板（1200）**：連續 28 個 tick `boosts 0`，`dropsByLeg.boosts` 每 tick +1，`lastDropLeg "boosts"` 恆常。
- **750**：同一個 feed 即刻回 22 行。
- 429 環境：`http429` 27–41/isolate、`pairCacheRefused` 15–25、`lastHour 35`。即係「被拒 → spacing 升 → 條 leg 死」嘅耦合。

## 三、做法：呢條 leg 有自己嘅窗口（唔係加大一個常數）

| 位置 | 改動 |
|---|---|
| `src/dexscreener.ts` | `BOOST_FEED_ATTEMPT_MS` 改為 **export**（caller 要由佢砌窗口）；`BOOST_FEED_SELF_BUDGET_MS` 嘅註釋補上「天花板 + attempt 一定大過舊 cap」嘅算術 |
| `src/scanner.ts` | 新 export `BOOST_FEED_WINDOW_MS = DEX_ADAPTIVE_MAX_MS + BOOST_FEED_ATTEMPT_MS + BOOST_FEED_WINDOW_SLACK_MS(320)` = **2000**；boosts leg 用 `Math.min(startedAt + BOOST_FEED_WINDOW_MS, frontDeadline)` 做**自己嘅 cap + race**，唔再收 `feedDeadline` |
| `scripts/test-deferred-priority.js` | 新 case：**天花板（1200）之下 leg 照問照答**，`budgetDrops 0`、`dropsByLeg` 全 0、兩支請求真係出到網 |
| `scripts/test-dex-list-cache.js` | 新 source-anchor guard：call site 必須傳 `boostsDeadline`、**唔准**再傳 `feedDeadline`、窗口由 `startedAt` 起計 |

要點：

1. **唔係「無限加預算」**：2000 = 天花板算術（1680）+ 320ms slack（live `preFeedMs` 7–62ms）。窗口仍然係 cap：塞唔落嘅 gap 一樣 `noteDrop` 做**有名嘅讀數**（`dropsByLeg.boosts`），唔會變空 list。
2. **窗口由算術砌，唔係一個 magic number**：`DEX_ADAPTIVE_MAX_MS` 或者 `BOOST_FEED_ATTEMPT_MS` 一改，`BOOST_FEED_WINDOW_MS` 跟住行 —— 唔會靜靜地再 drop 返條 leg。
3. **front window 唔會爆**：2000（feeds 內 boosts 嘅 cap）同 pool 2400、pairs 2000 相加 = 6400 = `FRONT_PHASE_WINDOW_MS`；boosts 嘅窗口仲要 `Math.min(..., frontDeadline)`，所以佢唔可以食 `SCAN_GATE_RESERVE_MS`。
4. **唔改 leg 次序**：profiles 仍然第一支（佢有 30 分鐘 reuse lane、係最大 discovery lane）；boosts 仍然第二支。次序冇動，改嘅係「第二支有幾多窗口」。
5. **pair phase 嘅代價講清楚**：天花板 tick 之下，feed phase 會行到 ~1680ms 先 join（之前係一 drop 就 join），pair phase 遲大約一個 gap + 一次嘗試才開始 —— 但 pair 自己嘅 2000ms cap 喺 6400ms front window 內仍然夠位，gate reserve 唔受影響。會動嘅讀數係 `feedsMs`（天花板 tick 可以到 ~1680，之前 cap 喺 1600）。

## 四、測試

- 新 case（`scripts/test-deferred-priority.js`，`dexListCacheTest` 內）：
  - **天花板 1200**：`fetchLatestSolanaProfiles()` 佔第一 slot 之後，`fetchBoostedTokens(20, now + BOOST_FEED_WINDOW_MS)` 必須**照問、照答**（`[EDGE_H]`），`budgetDrops 0`，`dropsByLeg` 全 0，而且真係有兩支請求出網；
  - 另外一條 assertion 直接釘住不變量：`BOOST_FEED_WINDOW_MS > DEX_ADAPTIVE_MAX_MS + BOOST_FEED_ATTEMPT_MS`。
- **確定性驗證過「舊行為一定 fail」**（唔係事後合理化）：同一情境手動傳 `Date.now() + 1600`（舊 shared window）⇒ `0 rows / dropsByLeg.boosts 1`、只有 profiles 出網；傳 `BOOST_FEED_WINDOW_MS` ⇒ `1 row / 0 drops`、兩支出網。
- **source-anchor guard 亦驗證過會咬**：臨時把 call site 還原做 `const boostsDeadline = feedDeadline;` 重新 build，`test-dex-list-cache` 立即以「the window is declared at the call site」fail（10 passed, 1 failed）；還原後 11 passed。
- 全套：main suite **487 passed, 0 failed**（同基線一樣），其餘 suite 全綠（`deferred-priority` pass、`dex-list-cache` 11 passed、`tick-legs` 9 passed 等）；`npm run typecheck` rc 0。

## 五、驗收（deploy 後）

```bash
curl -s .../health | jq '.heartbeat.summary | {boosts, feedsMs, dex: .dex | {intervalMs, spacingSteps, budgetDrops, dropsByLeg}}'
curl -s .../debug/dex429 | jq '{lastHour, last6h, total}'
curl -s .../debug/feed-stats | jq '.byFeed[] | select(.feed=="boosts")'
```

- **429 靜**（`intervalMs 250`）：應該同以前一樣 `boosts 20-22 / dropsByLeg.boosts 0`（健康日行為不變）。
- **天花板（`intervalMs 1200`）**：**新行為**係 `boosts > 0` 而 `dropsByLeg.boosts` 唔再每 tick 升；**舊行為**係 `boosts 0` 而 `dropsByLeg.boosts` +1/tick。呢個係今次唯一有區分力嘅時段 —— 429 靜嘅日 sample 分唔出。
- `feedsMs` 喺天花板 tick 可以升到 ~1680ms（leg 真係出咗網），呢個係預期，唔係 regression。
- 讀數限制：`/health` 嘅 `dex` block 係 **per-isolate** 計數（isolate 約 30s 換一次），所以 `dropsByLeg.boosts` 睇「同一 isolate 內仲有冇升」；跨 isolate 嘅長期趨勢睇 `/debug/feed-stats` 嘅 `boosts.coins`。

### 5.5 上線讀數（2026-10-03，deploy `a061aba4-78fb-4ae9-887d-38dee93a86c7` 之後）

| 時間 (Z) | `intervalMs` | `boosts` | `dropsByLeg.boosts` | `lastListCacheStatus` | `feedsMs` |
|---|---|---|---|---|---|
| 10:50:07 | 1200 | **22** | 0 | HIT | 1194 |
| 10:50:24 | 1200 | 0 | 0 | **HTTP-429** | 1197 |
| 10:51:34 | 1200 | **22** | 0 | HIT | 1208 |
| 10:53:06 | 750 | **22** | 0 | HIT | 1591 |
| 10:53:55 | 1200 | 0 | 0 | **HTTP-429** | 1195 |
| 10:54:44 | 1200 | **22** | 0 | HIT | 1220 |
| 10:55:17 | 1200 | **22** | 0 | HIT | 1201 |
| 10:56:28 | 1200 | 0 | 0 | **HTTP-429** | 1195 |
| 10:56:46 | 1200 | **22** | 0 | HIT | 1191 |
| 10:57:20 | 1200 | **22** | 0 | HIT | 1195 |
| 10:58:30 | 1200 | 0 | 0 | **HTTP-429** | 1191 |

- **天花板（1200）之下交付成功**：多個 tick `boosts 22`，`dropsByLeg.boosts` 全程 **0**。對照改前：同一情境係 `boosts 0` 且 `dropsByLeg.boosts` **每 tick +1**。
- **答 0 嘅時候係「問過被拒」，唔係「冇送出」**：所有 `boosts 0` 樣本都配 `lastListCacheStatus = HTTP-429`（`listCacheRefused` 跟住升），即條 leg 真係出到網、origin 拒 —— 呢個係**唔同嘅讀數**，亦係分流原則想見到嘅形狀。
- **健康 tick 不變**：`intervalMs 750` 一樣 `boosts 22 / 0 drops`。
- `feedsMs` 如預期升：天花板 tick 1.19–1.22s，未見觸及 2000 上限（亦未見 1680 最壞情況，因為 429 一出現通常即刻被拒而唔係等到 abort）。
- **`/debug/feed-stats` boosts lane 係 lifetime 累計**（`coins 31, pushed 3`），短期升幅唔可以當逐 tick 讀數。

## 六、界線（老實講）

- **未 cover ①：`fetchFeedCapped` 嘅 250ms floor**（同 §4.58 一樣）—— 如果 fan-out 到達時窗口剩 ≤ 250ms，boosts 根本唔會被叫，而且唔會計 drop。今日未見過（`preFeedMs` 7–62ms）。
- **未 cover ②：上游本身**。呢個 fix 唔會減少 429；`pairCacheRefused 15–25`、`listCacheRefused` 仍然係共享 egress IP 嘅問題（同 `docs/gecko-429.md` 同一類）。
- **未 cover ③：真係塞唔落嘅情況**（`frontDeadline` 已經好近）照樣係 named drop —— 呢個係刻意保留，唔係漏。
- **收益仍然細**：boosts 累計只發現幾十枚幣、push 極少（`/debug/feed-stats` lifetime）。今次係修正「結構上永遠靜音」呢個 bug，唔係話呢條 lane 會帶好多卡。
- **`feedsMs` 會升**：天花板 tick 由 ≤1600 到 ~1680，係 leg 真係出網嘅證據；唔好誤讀成 phase 變慢。
