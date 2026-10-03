# Pin 短 TTL Snapshot：429 期間唔使全員 skip（2026-10-03）

> 承接 `docs/pool-pin-2026-10-02.md`（pool pin 本體）。呢個係上線後一個鐘觀察（commit
> `541f11d`）量到嘅缺口，同埋補法。

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

### 2.2 同 pin 政策嘅關係（重點）

- Snapshot **只係「判數」用途，唔係證據**：唯一 repin 觸發仍然係 **answered 且缺席**（`null`）。
- Row loop 一個字都冇改：snapshot 值只係 map 值，`pinGone` 只由 `null` 觸發 →
  snapshot-served 行永遠唔會 re-pin。
- 只喺 **by-address 答案**記 snapshot。Front `lastPairs` 命中嘅池唔記——佢哋每個 pass 都直接判，
  唔需要替身（亦令 `pin-snap` 讀數唔會被 front lane 混淆）。
- 碰路徑（`answered:false` 但部分 batch 有 hit）：hit 照用照記（係真答案），
  其餘池先食 snapshot。

### 2.3 讀數

Pass note 新增 `pin-snap N`（今 pass 有幾多個 pin 係由 snapshot 判），放喺 `pins a/b` 後面：

- 正常 pass：`pins 23/23`（無 `pin-snap`）＝全部即時答案。
- 429 pass（有 snapshot）：`pins 23/23 pin-snap 23`、冇 `pin-skip`。
- 429 pass（冷記憶）：`pins 0/23 pin-skip 23`，同上線前一樣。

唔標記就會分唔清「edge cache 答咗」同「snapshot 撐住」——兩種 `pins N/N` 意義唔同。

## 3. 檔案

| 檔案 | 變更 |
|---|---|
| `src/scanner.ts` | `PIN_SNAPSHOT_TTL_MS`（90s）／`PIN_SNAPSHOT_MAX`（512）；`pinSnapshots` map；`poolPairsForTracker` 記／清／serve snapshot，回傳 `{ pairs, snapshots }`；`rememberPinAnswer`／`servePinSnapshots`／`trimPinSnapshots` |
| `src/pushwatch.ts` | `poolPairsFor` 契約改為 `{ pairs, snapshots }`；note 加 `pin-snap N`；pin 規則註釋加規則 5 |
| `scripts/test-unit.js` | Scanner 新 test（答→記；拒→serve；答缺席→清＋唔可以被 snapshot 復活；TTL 過期→skip）；PushWatcher 五 pass 劇本加 snapshot pass |

## 4. 成本 / 風險（設計上接受）

1. 換池最多遲 `PIN_SNAPSHOT_TTL_MS`（90s）被發現——而且只有成個窗口嘅 lookup 全部被拒先會發生。
2. 記憶係 plain map、per-isolate：deploy／isolate recycle 由空開始，唔會跨 isolate 共用。
3. 冇新 request、冇新 DB 寫、冇 schema 改動。

## 5. 驗收（上線後睇）

1. 429 episode 期間 note：`pins 23/23 pin-snap N`、`pin-skip` 大幅回落（對比觀察期 3/16 good）。
2. 剛 deploy／recycle 後第一個 429 pass 仍可以 `pin-skip`（snapshot 未建立）——一個 good pass
   之後就唔應該再全員 skip。
3. 真換池嗰 pass 照樣 `pin-skip 1` ＋ `repin 1`（snapshot 唔會遮蓋確認換池）。

## 6. Rollback

Deploy 上一版 code 即可：純記憶、無 DB 欄、無 migration。`pin-snap` 只係 note 字串，舊 code
唔識讀亦無害。
