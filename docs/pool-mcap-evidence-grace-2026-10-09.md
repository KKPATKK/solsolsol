# 重估池死幣排除：冇 mcap 證據 ＋ 6h 寬限期（2026-10-09）

## 做咗咩

池嘅 pre-filter（`Db.getReevalPool` 同 `Db.getReevalPoolBatched`，兩條 builder）
多一條 clause：

```sql
AND (max_mcap_observed IS NOT NULL OR first_seen_at > ?)   -- ? = now - 6h
```

- 常數 `POOL_MCAP_EVIDENCE_GRACE_MS = 6 * 3600_000`（`src/db.ts`）；cutoff 由
  query 自己嘅 `now`（`opts.now`，tick 釘死嗰個）推導，兩條 builder 同一刻切。
- `src/scanner.ts`：`POOL_QUERY_SHAPE_VERSION` v2 → **v3-2026-10-09-mcap-evidence**
  （snapshot key 帶 SQL shape，唔 bump 就會用舊 predicate 嘅 cache 答新 query），
  同 call-site 加咗一段註解。
- `scripts/pool-read-cost.js`：離線儀器鏡像新 clause（bound arg）＋ import 新常數
  （唔重述數字）。
- 測試：新行為測試＋擴充既有 source pin；三條舊 pool 測試嘅 fixture 對齊新合約
  （原因見下）。

## 語意：點解係「冇 mcap 證據」

`max_mcap_observed` 係 **每次被讀到嘅 pair leg（DS／Jupiter／Gecko）正讀數** 先會
raise 嘅 high-water（scanner 嘅 raise loop：`marketCap <= 0` 唔記）。所以 NULL＝
「每次真係睇過佢，mcap 都非正」——幣由飼到熟都未見過生。舊行為係 NULL 永遠
fail-open（唔喺猜嘅情況下 prune），呢個喺「未量到」嘅窗口係啱嘅；但過咗窗口，
一條冇人量到過嘅 row **永遠都唔會量到入 push**（冇正讀數就冇 qualify），之後每個
sweep 都係為一條答案永遠一樣嘅 row 找數。

- 唔係 delete：clause 讀 column 本身（唔係 one-way mark），一次正讀數即刻返池。
- 同 freshness mark（`DEAD_POOL_MISS_MAX`，2026-10-08）獨立：嗰個數「連續幾次
  空 sweep」，需要 healthy-batch 守衛；呢個唔使——冇任何 row 因為「讀唔到」被
  淘汰，淘汰嘅係「讀到但每次非正」嘅 row。

## 量度：點解要做（2026-10-09 00:51–01:01Z，只讀探針）

- 池窗口（30h）**72,304** row，其中 `max_mcap_observed` NULL＝**10,394（14%）**；
  呢 10,394 條**每一條**連 DS 流動性讀數都冇。
- NULL row 按 first-seen 年齡：<3h **927**、3–6h **1,343**、6–12h **2,572**、
  12–24h **3,650**、>24h **1,902**。→ 6h 寬限期切 **8,124（78%）**、3h 切 9,467
  （91%）、12h 切 5,552（53%）。
- 全表 **77,480** row、mcap NULL **11,009**。

## 點解係 6 小時

- 最壞巡迴期量過：worst far band 要 **8 個 recurrence ≈ 2.4h** 先覆蓋全部
  （`docs/round-trips.md` §4.48）。6h ＝ 2.5× 最壞覆蓋期。
- 3h 只係 1.25×——冇位畀一個 429 窗口或者被 deadline 剪尾嘅 sweep。
- 12h 留低一半人口（5,552/10,394）換唔到額外訊號。
- 對照：freshness mark 用 3 個 sweep（≈40min，幣層面 recurrence ~13min）；
  呢個唔係 sweep 計數（見上「唔使 health guard」），時間界要壓過覆蓋缺口。

## 驗收讀數（01:23–01:29Z，只讀）

**每 band 候選集（rows-read ＋ per-band LIMIT 嘅分母）**，同 slot before/after
（`now` vs `now-24h`，Δ=480 slot＝Δ%near 0、Δ%far 0，即 sub-window 完全一樣）：

| band | candidates before | after | cut | NULL 情況 |
|---|---|---|---|---|
| hot（50–110min） | 394（null 314） | 394（null 314） | 0 | 314 條全喺寬限期內 |
| near（275–440min） | 1,645（null 1,415） | 892（null 662） | **753** | cut 全部係 old NULL；fresh NULL 662 留 |
| far（1523–1740min） | 1,834（null 1,466） | 368（null 0） | **1,466** | 呢個 band 嘅 NULL 全部 old |

→ 每個 sweep 少 **2,219** 條 row 入 sort；far band 嘅候選集縮 **80%**（1,834→368），
near 縮 **46%**。far 由 80% NULL 變 0% NULL。

**返回集唔變（934 行／462 NULL，兩邊完全一樣）**——今日 sweep 帶住嘅 NULL 全部
喺寬限期內（first-seen age 50–360min，median 92min：hot 314 ＋ near 148）。原因：
signal ordering 將 NULL 排最後，cut 走嘅 old NULL 本來就排喺 LIMIT 之外。呢個係
預期，唔係冇效果：**槓桿係候選集**（rows-read ＋「LIMIT 花喺邊啲幣」嘅比例），
唔係今日嘅返回內容；當一個 band 嘅非 NULL 供給唔夠填 LIMIT 時（昨晚 55% NULL
嘅 sweep 就係），舊 NULL 先會霸返回位——今日唔係嗰種 slot。

**`pool-read-cost.js` report（01:23Z）**：+prunes hot 391 / near 893 / far 146
（limit 460/518/222）；EXPLAIN 仍然行 partial index `idx_pool_band_m48000`
（新 clause 唔破壞 floor 嘅 index implication）。

## 測試

- 新增：`pool: a no-evidence row is dropped after the grace, kept inside it, and a
  first reading returns it` —— boundary（cutoff±1ms）、兩條 builder 同一 set、
  **negative control**（同一批 row、鐘撥早 2h＝ cutoff 撥早，被剔嘅全部返嚟）、
  recovery（`updateTokenMaxMcaps` 一次正讀數返池）。
- Source pin 擴充：兩條 builder 都要帶 `[DEAD_POOL_CLAUSE,
  POOL_MCAP_EVIDENCE_CLAUSE]`、clause 定義 1 次用 2 次、兩邊 bound arg 位置
  （`…sinceMs, mcapEvidenceSinceMs]`）、v3 shape version、儀器鏡像＋import。
- 三條舊 pool 測試 fixture 對齊新合約（唔係改斷言）：band order／rotation 測試
  嘅幣畀返非 NULL mcap（嗰條 test 唔應該量寬限期）；mcap floor 嘅 fail-open 測試
  同 chat-aware seen 測試嘅 NULL 幣改成「寬限期內」（新合約＝NULL 喺寬限期內
  照 fail-open，過期先剔——兩半各有自己嘅測試）。
- 結果：`test-unit.js` **502 passed / 0 failed**；其餘 9 個測試檔（filters、
  deferred-priority、tick-path、schema-gate、health-front、dex-list-cache、
  usd-formatter、dex-last-profiles、tick-legs）全 pass；`npm run build` exit 0。

## 未做／限制

- **未 deploy**（Freebuff Changes panel 交付）。
- 被剔嘅 row 要等 discovery feed 再搵到（feed 評估唔受池影響，第一條正讀數
  就返池），或者……冇其他返池路徑——同 mcap floor／ceiling／peak-liquidity
  三個 prune 嘅永久排除 trade-off 一樣。
- 寬限期係 db.ts 常數（唔係 config）：一個 per-tick 調嘅 knob 會令 snapshot
  key 同界線靜靜漂走。
- `pool-read-cost.js` report 每次 ~150k rows quota；今次兩個 before/after 探針
  （`scripts/tmp-band-evidence.js`）同 window 人口探針（`tmp-evidence-size.js`）用完即刪。
- 已做（同日晚）：slice 兩道 lane（evidence / filler）＋ far sweep 12min，見
  `docs/pool-lane-split-2026-10-09.md` —— 唔再收緊呢條 clause，只係把 freed budget
  用返喺覆蓋率。
