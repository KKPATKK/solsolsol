# Pin 短 TTL Snapshot：429 期間唔使全員 skip（2026-10-03）

> 承接 `docs/pool-pin-2026-10-02.md`（pool pin 本體）。呢個係上線後一個鐘觀察（commit
> `541f11d`）量到嘅缺口，同埋補法。
>
> **更新（2026-10-03 同日第二版）**：TTL 90s → 120s，note 加 `(oldest Xs)` 量度；
> §1–§7.1 寫嘅 90s 係當時狀態，新狀態見 §9。

## 1. 問題（量度，唔係推斷）

2026-10-03 一個鐘觀察（`/debug/scan-history` 抽樣 ＋ `/health`）：

| 讀數 | 觀察值 |
|---|---|
| token lane（429 期間） | `pairs 23/23`（食 edge/client cache，答案照有） |
| pin lane（429 期間） | `pins 0/23 pin-skip 23`（by-address 多數要真請求 → 先中 429 → 全員 skip） |
| pass 好壞比例 | 舊窗 ~13/15 good；現時 ~3/16 good（其餘全 `pin-skip`） |
| 429 密度 | `lastHour` 32–36 ↗、ring 50 episode 跨 43 分鐘（飽和），真實 ≥70/h |

行冇停死：一個 good pass 75 秒內一次過查齊 23 個活躍行 → 追蹤變「突發式」，alert 慢幾個 pass。
呢個 patch 就係喺「全員 skip」同「用陌生池判」之間落墨：**用返同一池近期已答嘅 snapshot 續判**。

## 2. 設計

### 2.1 Snapshot 係乜

`Scanner.pinSnapshots`（per-isolate 記憶）：

```
pool address → { pair: PairInfo, at: number }
```

- **寫入**：by-address lookup **answered 且 response 入面有嗰個池** → 記（`at = now`）。
- **清除**：answered 且**absent** → 刪。確認換池唔可以被舊 snapshot 遮蓋。
- **讀取**：lookup **冇答**（429／`batchBlockedUntil`／窗口用盡／partial）→ 每個仍未解嘅池，
  若 snapshot 存在且 `now - at <= PIN_SNAPSHOT_TTL_MS`（**90s**）→ 用佢判；過期／冇 → 照舊 skip
  （過期 entry 即場清）。
- **上限**：`PIN_SNAPSHOT_MAX` 512，oldest-first evict（同 pair cache 同一紀律）。

### 2.1b Colo carrier（多 isolate 共享）

記憶係 per-isolate，唔夠：實測 2026-10-03（deploy 後幾分鐘）一個 isolate 答完，下一個 pass
喺另一個 isolate 被拒 → 照樣 `pins 0/23 pin-skip 23`；同一段時間 `/health` 連續讀數出現
計數器倒退（`poolCache.hits` 3→0、`preTick.at` 新→舊），證明同時有幾個 isolate 服務 tick。
所以 map 加一層 colo 載體：

- `PIN_SNAPSHOT_CACHE_URL`（`caches.default`，同 reeval pool snapshot 同一 pattern）：
  一個 entry 載住近期答案（`PIN_SNAPSHOT_EDGE_MAX` 128、newest first），Cache-Control
  90s；entry 本身過期遲早會回歸 miss，但 serve 嗰陣仍然逐條用 `at` 過濾。
- **讀**：只喺冇答嗰條路（仍有未解池先讀）→ merge 入本地 map（過期唔收、本地較新唔覆蓋）
  → 再 serve。
- **寫**：pass 有郁過 map（記新答案或確認缺席）先寫；寫之前**先 merge 一次**（union——
  一個只有兩條答案嘅 pass 唔可以蓋掉另一個 isolate 嘅 20 條），並**跳過今 pass 確認
  缺席嘅池**。merge 同 write 都係 **await**（唔同 reeval 嘅 fire-and-forget：呢度喺
  tick 尾巴，唔 await 有機會被 invocation 取消——寫唔到就載體永遠 stale）。
- 冇 Cache API（Node entry／unit tests）→ 行為同以前一樣；cache 讀寫錯誤只 log 唔 throw。
- 已知 race：另一個 isolate 同時寫返舊 entry，可以令一次確認換池喺 ≤90s 內被舊
  snapshot 蓋返一次——同 TTL 本身嘅「換池最多遲 90s」界限一致，唔另設機制。

### 2.2 同 pin 政策嘅關係（重點）

- Snapshot **只係「判數」用途，唔係證據**：唯一 repin 觸發仍然係 **answered 且缺席**（`null`）。
- Row loop 一個字都冇改：snapshot 值只係 map 值，`pinGone` 只由 `null` 觸發 →
  snapshot-served 行永遠唔會 re-pin。
- 只喺 **by-address 答案**記 snapshot。Front `lastPairs` 命中嘅池唔記——佢哋每個 pass 都直接判，
  唔需要替身（亦令 `pin-snap` 讀數唔會被 front lane 混淆）。
- 碰路徑（`answered:false` 但部分 batch 有 hit）：hit 照用照記（係真答案），
  其餘池先食 snapshot。

### 2.3 讀數

Pass note 新增 `pin-snap N`（今 pass 有幾多個 pin 係由 snapshot 判），放喺 `pins a/b` 後面；
2026-10-03 同日再加 `(oldest Xs)`（最舊 served snapshot 嘅年齡），見 §9：

- 正常 pass：`pins 23/23`（無 `pin-snap`）＝全部即時答案。
- 429 pass（有 snapshot）：`pins 23/23 pin-snap 23`、冇 `pin-skip`。
- 429 pass（冷記憶）：`pins 0/23 pin-skip 23`，同上線前一樣。

唔標記就會分唔清「edge cache 答咗」同「snapshot 撐住」——兩種 `pins N/N` 意義唔同。

## 3. 檔案

| 檔案 | 變更 |
|---|---|
| `src/scanner.ts` | `PIN_SNAPSHOT_TTL_MS`（90s）／`PIN_SNAPSHOT_MAX`（512）；`pinSnapshots` map；`poolPairsForTracker` 記／清／serve snapshot，回傳 `{ pairs, snapshots }`；`rememberPinAnswer`／`servePinSnapshots`／`trimPinSnapshots`；colo carrier：`PIN_SNAPSHOT_CACHE_URL`／`PIN_SNAPSHOT_EDGE_MAX`＋`mergePinSnapshotsFromEdge`／`writePinSnapshotsToEdge`／`serveSnapshotsFor` |
| `src/pushwatch.ts` | `poolPairsFor` 契約改為 `{ pairs, snapshots }`；note 加 `pin-snap N`；pin 規則註釋加規則 5 |
| `scripts/test-unit.js` | Scanner 新 test（答→記；拒→serve；答缺席→清＋唔可以被 snapshot 復活；TTL 過期→skip）；PushWatcher 五 pass 劇本加 snapshot pass |

## 4. 成本 / 風險（設計上接受）

1. 換池最多遲 `PIN_SNAPSHOT_TTL_MS` 被發現（90s→120s，見 §9）——而且只有成個窗口嘅 lookup 全部被拒先會發生。
2. 記憶係 plain map、per-isolate：deploy／isolate recycle 由空開始，唔會跨 isolate 共用。
3. 冇新 request、冇新 DB 寫、冇 schema 改動。
4. Colo carrier：**冇答**嘅 pass 加 1 個 cache 讀；有郁過 map 嘅 pass 加 1 讀 1 寫
   （Cache API，colo-local，唔計 fetch subrequest）。冇 Cache API 就全部降級做純記憶。

## 5. 驗收（上線後睇）

1. 429 episode 期間 note：`pins 23/23 pin-snap N`、`pin-skip` 大幅回落（對比觀察期 3/16 good）。
2. 冷 isolate（記憶空、但 colo 載體 90s 內有答案）嘅 429 pass 亦應該 `pin-snap N>0`
   ——未夠時先 `pin-skip`；全員 skip 只應喺「成個 colo 90s 內都冇答過」先出現。
3. 真換池嗰 pass 照樣 `pin-skip 1` ＋ `repin 1`（snapshot 唔會遮蓋確認換池）。

## 6. Rollback

Deploy 上一版 code 即可：純記憶＋colo cache、無 DB 欄、無 migration。`pin-snap` 只係 note
字串，舊 code 唔識讀亦無害。

## 7. 量度記錄（2026-10-03 上線後）

Deploy ffd83e7（CI run 37085674142 success，version `90cdf267-8308-4950-853f-81839229cefb`）
後即場抽樣：

| 時間（Z） | 讀數 |
|---|---|
| 01:23:23 | `rows 23/23 pairs 23/23 pins 22/22 pin-snap 3`（功能首次喺線上生效） |
| 01:23:57 | `pins 22/22 pin-snap 3` |
| 01:25:39 | `rows 2/25 pins 0/23 pin-skip 23`（冷 isolate／記憶未建） |
| 01:26:44 / 01:27:16 | `rows 2/25 pins 0/23 pin-skip 23` ×2 |
| 01:27:52–01:28:57 | `rows 25/25 pins 23/23`（429 window 過去） |

→ 記憶層有效（`pin-snap 3`），但 per-isolate 令拒絕嗰 pass 落喺冷 isolate 時仍然全員 skip。
所以就加咗 §2.1b 嘅 colo carrier；cold-isolate 讀數要用再落一版嘅 deploy 驗。

### 7.1 Colo carrier 上線後（47d3d65 / 2e58cd1，CI 全 success）

| 時間（Z） | 讀數 |
|---|---|
| 01:40:52 | `rows 0/25 pairs 25/25 pins 24/24 pin-snap 24 pin-skip 0`（429 期間） |
| 01:42:34 | `rows 25/25 pairs 8/25 pins 25/25 pin-snap 17`（token lane 餓死、pin 層頂住） |
| 01:56:52 | `rows 26/26 pins 26/26 pin-snap 22`（429 lastAt 01:54:52） |
| 01:57:21 | `rows 26/26 pins 26/26 pin-snap 26`（全體由 snapshot 判） |
| 01:57:53 | `pins 4/26 pin-skip 22`（上次成功答案距今 ~100s，TTL 90s 過期 → 照舊 skip） |

結論：

1. 功能成立——429 期間 pin lane 唔再全員 skip，行照判（連 token lane 剩 `pairs 8/25` 仍
   `rows 25/25 pin-snap 17`）；`pin-skip 0` 喺抽樣過半數 pass 出現。
2. **TTL 90s 係真正嘅界**：最後一次成功答案過咗 90s，snapshot 全部過期 → 拒絕 pass 回歸
   `pin-skip`（01:57:53 實例）。即係長 episode 只 cover 頭 ~2–3 個 pass；要 cover 更長就要
   加大 `PIN_SNAPSHOT_TTL_MS`（代價＝用更舊嘅池數判卡）。
3. Carrier 寫入要 await（2e58cd1 嘅修正）：呢個 write 喺 tick 尾巴，fire-and-forget 有機會
   隨 invocation 取消而永遠寫唔到。

## 9. 2026-10-03（同日第二版）：TTL 90s → 120s＋`(oldest Xs)` 量度

### 9.1 決定

起因：§7.1 嗰個邊界（01:57:53，最後成功答案 ~100s → 全員 skip）同一次評估。結論：

- **120s = pair cache 嘅窗（`PAIR_BATCH_CACHE_TTL_S`）**，即係設計上講嘅「snapshot 唔應該老過
  可以替代佢嘅 cache 內容」嗰條界——90 → 120 係行到去界，冇越界。
- **>120s 唔做**：要 cover 多分鐘風暴就要 300s+，代價＝用最多 5 分鐘前嘅池數判卡；而且
  mega-storm（全 colo 過 TTL 冇答案）照樣 skip，邊際收益遞減；carrier 嘅 stale-write race
  窗口（§2.1b）亦同 TTL 一齊放大。
- 代價（設計上接受）：判數可以舊到 120s；換池被舊 snapshot 遮蓋嘅窗口亦係 ≤120s。

### 9.2 改動

| 檔案 | 變更 |
|---|---|
| `src/scanner.ts` | `PIN_SNAPSHOT_TTL_MS` 90_000 → 120_000（carrier `Cache-Control: max-age=max(60, TTL/1000)` **自動跟**）；`poolPairsForTracker` 回傳多 `snapshotOldestMs`（今 pass served snapshot 中最舊嘅 age）；`serveSnapshotsFor`／`servePinSnapshots` 回傳 `{ served, oldestMs }` |
| `src/pushwatch.ts` | `poolPairsFor` 契約加 optional `snapshotOldestMs`；note `pin-snap N` → `pin-snap N (oldest Xs)` |
| `scripts/test-unit.js` | snapshot test 加 ~100s 案例（120s TTL 下必須判＋age 讀數）＋ colo 載體 60s 案例；PushWatcher 五 pass 劇本 pass 5 驗 `(oldest 87s)` |

### 9.3 驗收（上線後睇）

1. 429 拒絕 pass 嘅 note：`pins N/N pin-snap K (oldest Xs)`。
2. 01:57:53 型（最後答案 ~100s）唔再全員 skip——`pin-skip` 應該喺呢種邊界消失。
3. age 讀數本身：正常 429 期間 `oldest` 係幾十秒；接近 120 就係長 episode 尾，超出即係 bug
   （TTL 過濾失效）。

### 9.4 Rollback

改返 `PIN_SNAPSHOT_TTL_MS = 90_000` 即可；note 嘅 `(oldest Xs)` 對舊 code 無害（純字串）。
