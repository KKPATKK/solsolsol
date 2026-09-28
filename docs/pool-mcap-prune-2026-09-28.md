# Pool 嘅市值地板 prune：0.6 → 0.8（2026-09-28）

> 相關：`src/scanner.ts` 嘅 `POOL_MCAP_PRUNE_RATIO`（與流動性地板
> `POOL_LIQUIDITY_PRUNE_RATIO` 成對）、`docs/gecko-key-launch-chain-2026-09-28.md`、
> 量度工具 `scripts/pool-mcap-floor.js`。

## 一、改咗乜

| 位置 | 改動 |
|---|---|
| `src/scanner.ts` | 新增 `export const POOL_MCAP_PRUNE_RATIO = 0.8`；pool 查詢由 `poolMinMcapUsd * 0.6` 改成 `* POOL_MCAP_PRUNE_RATIO` |
| `src/worker.ts` | `/debug/pool` 探針由 `minMcap / 2`（＝0.5，比生產**鬆**）改成 `* POOL_MCAP_PRUNE_RATIO` |
| `scripts/cpu-profile.js` | 離線 profiler 由 `* 0.6` 改成同一個常數（佢本身聲明要量「同 tick 一樣嘅 pool」） |
| `src/jupfeeds.ts` | trending band 嘅 `* 0.6` 抽出成 `TREND_BAND_MCAP_FLOOR_RATIO`，**故意維持 0.6**（見第四節） |
| `src/db.ts` | `minQualifyMcap` docstring 由「0.6×」更新成常數描述 |
| `scripts/test-unit.js` | 釘住 `POOL_MCAP_PRUNE_RATIO === 0.8`、scanner／profiler／探針三處都用常數、以及 trending band 故意留守 0.6 |

呢個係同日流動性地板 0.6 → 0.8 嘅**姊妹改動**。兩個地板以前都係 0.6，所以
「the 0.6 prune」指邊個都講唔清；依家各自有名字、各自被測試釘住。

## 二、點解安全（算術）

prune 係**單向而且永久**：跌出 pool 嘅幣唔會再被重新量度（除非佢之後再出現在
feed —— 任何 feed 出現都會重新登記並更新峰值）。而 gate 係**同一方向**嘅下限：

> 峰值市值從未達到 `0.8 × gate` 嘅幣，本來就過唔到果個 gate。
> 唔會有任何本來推得出嘅幣因為呢次提升而消失。

活躍 chat 嘅 gate 係 **$60K**，故地板由 **$36K 升到 $48K**（$40K 係代碼預設，
只作說明用；gate 係 per-chat，所以引用要引 ratio）。流動性姊妹地板係 $8K。

**代價嘅形狀同流動性嗰個唔同**：池深係幾個百分點咁變，市值係會**跳**——
「$26K 一炮衝過 $40K」正正係呢隻 bot 搵嘅形態。所以「跌出 pool 就唔再量度」對
市值嘅殺傷力大過對流動性。呢個係要**量度**而唔係推論嘅部分 ↓

## 三、量度（生產 Turso，唯讀）

`node scripts/pool-mcap-floor.js` —— 同一 slot 內所有 rung 用同一個 `now`（apples
to apples），`wrangler [vars]` 疊上（near 2 / far 12 / rotation 90s / limit 1000，
同生產一致），跑咗兩次（3 + 4 = 7 個 slot）：

```
  slot      0.5    0.6    0.7    0.8    0.9  dropped  backfill   net  nullPeak  >=gate
  #1        819    814    813    811    809        5         2    -3       715      76
  #2        464    462    461    459    456        5         2    -3       388      60
  #3        746    741    739    737    736        6         2    -4       651      69
  #4        415    414    411    408    405        8         2    -6       331      64
```

| 量度 | 結果 |
|---|---|
| 每次 sweep 少讀 | **4–8 行**（7 個 slot 平均 5.4；另一次 3-slot 運行係 4/6/4），即 600–730 行嘅 **0.5–1%** |
| 淨 pool 縮細 | **−3 至 −6 行**／sweep（band 有 LIMIT，被剔走嘅位會由同一窗口**補返** 1–2 行，所以「剔走 N」同「淨細 N−backfill」係兩個數） |
| 被剔走嘅幣，峰值市值 | $36.5K–$47.4K ＝ gate 嘅 **61–79%**，即每個要再升 **27–64%** 才夠 $60K |
| `max_mcap_observed` 係 NULL 嘅行 | **86–89%**（7 slot：715/388/651/331…）← 重點 |
| 峰值已達 gate 嘅行 | 60–76 / 每 slot |

**結論一**：呢次提升幾乎免費 —— 每 sweep 少 5 行左右、pool 淨細 3–6 行，代價集中
在一撮「已量度、但峰值停在 gate 六至八成」嘅邊緣幣（每個都差 27–64% 才夠 gate）。

**結論二（更重要）**：**86–89% 嘅 pool 行根本冇峰值市值**。prune 對 NULL 係
**fail-open**（`max_mcap_observed IS NULL` 一律保留），所以**任何 ratio 都摸唔到
佢哋**——0.5 到 0.9 之間，pool 只由 ~608 行變 ~602 行。真正令 sweep 攤薄嘅係呢批
未量度嘅大多數，唔係 ratio。要收窄 sweep，槓桿係：
(a) 登記時就補一次量度，或 (b) 對 NULL 行設寬限期後剔除（會改動 fail-open 紀律，
要另立文檔）。呢個發現已寫入 `POOL_MCAP_PRUNE_RATIO` 嘅 docstring，免得下次又由
ratio 著手。

## 四、故意唔改：trending band 維持 0.6

`jupfeeds.ts` 嘅 band 以前明文話自己鏡像 pool 嘅 prune 邊界。呢次**故意唔跟升**：

- pool 嘅係 **prune**：跌出嘅幣已經在 `token_stats`，只係停止被重新量度。
- band 嘅係 **discovery filter**：被佢剔走嘅 trending 幣**從來冇入過表**，
  downstream 冇任何東西可以救返。

所以 band 留守一個**比 pool 鬆**嘅值係安全方向；跟升只會令 discovery 變成覆蓋率
嘅瓶頸（唔可逆）。成本只係多幾行永遠唔會被 sweep 嘅登記。

## 五、驗收點

| 睇 | 預期 |
|---|---|
| `/debug/pool` `poolQueryCount` | 由 0.5× 改成 0.8× 之後**細咗**（探針以前比生產*鬆*）。探針仍然帶 `seenChatIds` 而 scanner 冇帶 —— 呢個差異係另一件事，唔係呢次改動 |
| `/debug/pool` `poolQueryBuckets` | 分佈不變（呢次只動市值維度，唔動年齡維度） |
| `/debug/pool` `eligibleInWindow` | 不變（佢係 COUNT，唔經 prune） |
| `tokenStatsCount` | **唔應該**因為呢次改動而跌 —— 呢個 prune 係查詢裡嘅 WHERE，唔會刪行（行係 `pruneOldTokenStats` 清） |
| `heartbeat.summary.pool` | 可能**輕微**細（每 sweep 少 3–6 行），唔係故障 |

## 六、同日嘅附帶修正：離線儀器嘅窗口常數

上面嘅量度暴露咗同一個病嘅第二個實例 —— **儀器自己抄常數**。

`scripts/cpu-profile.js` 一直用 `RE_EVAL_WINDOW_MS = 43h` / `RE_EVAL_AGE_MARGIN_MIN = 30min`
手抄，而 tick 係 **30h / 180min**。三者之中兩個（`test-filters.js` 30h/180、
`pool-mcap-floor.js` 30h/180）剛好抄對，一個抄錯 —— 兩對一唔係機制，係運氣。
而 `cpu-profile.js` 嘅 pool phase 明文要量「同 tick 一樣嘅 pool」，所以佢一直量
一個**唔同嘅 pool**，兩邊可以永遠唔一致而無人知。

修正：`src/scanner.ts` 把兩個常數 `export` 出嚟，三個儀器全部 import
（`test-filters.js` 本身已經 require `dist/scanner.js`，所以係零成本）。順手：
`test-filters.js` 嘅 `RE_EVAL_POOL_SIZE = 40` 亦改食 `cfg.reevalPoolSize`（pool 大小
係 config 而唔係 scanner 常數，手抄 40 會令設了 `REEVAL_POOL_SIZE` 嘅人診斷出
一個 tick 從來冇用過嘅 pool 大小）。

### 呢個 drift 值幾多？

新儀器 `node scripts/pool-window-drift.js [windowHours] [marginMin]`（唯讀，default
43h/30min ＝ 舊抄法）同一次 `now` 之下各查一次 pool，再比較**集合**。兩個樣本
（兩個 slot）：

| slot | tick 行數 | 舊抄法行數 | 只在舊抄法出現 | 只在 tick 出現 | 只在其中一邊 |
|---|---|---|---|---|---|
| #1 | 875 | 705 | 108 | 279 | 387 / 984 (39%) |
| #2 | 507 | 393 | 118 | 232 | 350 / 625 (56%) |

「只在舊抄法出現」嘅 118 個幣，**冇一個**在 tick 嘅 band 之外（0 個老過、0 個後生過）
—— 佢哋全部係 20–22h 齡、兩邊 band 都包含嘅幣。原因係兩個常數一動，band 嘅**絕對
邊界**就跟著動，而 rotation slot 係按 band 邊界切嘅，所以 slot 窗口會落去第二個
位置。即係話：唔係「順手多量幾隻」，係**換咗一批**（39–56% 唔重疊，slot 相關）。

所以呢個修正唔係潔癖：`cpu-profile.js` 報嘅 pool 數字（行數、組成、prune 效果）
過去係另一個 pool 嘅數字。

### 驗收點

| 睇 | 預期 |
|---|---|
| `scripts/test-unit.js` | 有 pin 釘住 `export const RE_EVAL_*`、三個儀器都唔可以再出現 `const RE_EVAL_* =`、`test-filters.js` 用 `cfg.reevalPoolSize` |
| 三個儀器 | `grep -n "RE_EVAL"` 只應該出現 import 同使用，唔應該有本地宣告 |
| 之後改窗口 | 改 `src/scanner.ts` 一處，三個儀器自動跟上（`cpu-profile.js` 亦因此唔再係唯一抄錯嘅例外） |
