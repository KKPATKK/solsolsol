# raydium 腿嘅邊際發現量：jup 429 backoff 窗內捉到幾多粒（2026-10-14）

> 相關：`docs/raydium-page-lag-2026-10-14.md`（上一條：jup 先登記、頁面跟尾）、
> `scripts/raydium-attribution.js --jup-holes`（今次新增嘅可重跑讀數）、
> `src/jupfeeds.ts`（`JUP_RATE_LIMIT_BACKOFF_MS`）、`src/worker.ts:4327`
> （client 嘅建構點）。

## 一、問題

上一條結論留咗一句未證嘅話：raydium 腿嘅**唯一剩餘價值**係「jup 429
backoff 窗」等情形。今次就量佢 —— **jup 429 backoff 窗內，raydium 腿實際
多捉到幾多粒**？

## 二、點解唔可以查 counter（方法嘅第一步）

`jupfeeds.ts` 嘅 429 退避係 `rateLimitedUntil` 一個 **private instance 欄**，
`JUP_RATE_LIMIT_BACKOFF_MS = 5 * 60_000`。而 client 係喺
`worker.ts:4327` **每個 `Scanner` 建一次**（`if (db) { scanner = new Scanner(…) }`），
`scanner` 係 module-scoped（warm isolate 生命週期）—— 所以：

- 退避係**真嘅、會持續 5 分鐘**，但**只限產生佢嗰個 isolate**；
- **冇一個 durable row 記住佢**：`scan_history` 只有 8 欄
  （`at/ok/ms/err/profiles/pool/candidates/pushed`），heartbeat 只留最新一 tick，
  tick-leg ring 係記憶體環（而且唔含 per-feed 計數）。即係話，**由 counter／
  `/debug` 路線查唔到 jup 幾時黑過**。

所以唯讀路線係**由資料反推**：jup 嘅 `/recent` 窗約 50s、出世後 p50 15s
就登記（上一條量到），一次 429 退避會令 jup **成條腿啞 5 分鐘**（長過佢個
50s 窗）⇒ **jup-owned 嘅出世時間會出現一段約 5 分鐘嘅「洞」**，而其他腿照登記。

## 三、兩個讀數（`--jup-holes`）

**路線 1（fleet-wide 洞）**：jup-owned 出世時間排序，搵「連續 gap 內一段完全
冇 jup-owned 出世、而其他腿有登記」嘅洞。

**路線 2（per-mint 解析度）**：每粒 raydium-owned mint 嘅登記延遲
`first_seen_at - launch_ms`。jup 每 tick（~30s）都跑、窗約 50s ⇒ 健康嘅 jup 應該
喺 **出世後 ~80s 內**抬到。**一粒 raydium-owned、但登記延遲超過呢個上限嘅 mint，
就係 jup 喺整段時間內都冇抬到**（斷到 per-isolate 退避——路線 1 睇唔到嗰種）。

## 四、讀數（2026-10-14 05:3xZ，窗 24h）

**A. jup-owned 出世時間軸係健康嘅，冇退避規模嘅洞**

| 讀數 | 值 |
|---|---|
| 窗內總出世 / jup-owned | 49,383 / **35,622（72.1%）** |
| jup-owned 出世 gap | p50 **1s**、max **216s（3.6min）**；≥60s 22 個、≥120s **1 個**、≥240s **0 個** |
| 最長 gap | 2026-10-13 06:43:25→06:47:01（3.6min），**other-born 0** ⇒ 係靜市，唔係斷線 |
| 下一個 gap（有流量） | 2026-10-14 03:10:22→03:11:50（1.5min），other-born 30（pump 22） |
| 其餘大 gap | 全部 1.2–1.4min，內裏照有 pump 21–36 粒 |

⇒ **路線 1 搵到 0 個洞**（≥4min）：保留窗內 jup 從未沉默到退避規模。最長嗰段
216s 反而係**市靜**（連其他腿都冇出世），唔係 jup 被 ban。

**B. hourly（講清楚 24h 窗唔 homogeneous）**

| 小時（UTC） | jup 出世份額 |
|---|---|
| 2026-10-13 05:00–22:00 | **84–90%**（fit 前） |
| 2026-10-13 23:00 | 64%（deploy 邊界） |
| 2026-10-14 00:00–05:00 | **14–24%**（fit 後） |

`fe327bc`（2026-10-13T23:39:24Z，priority reverse）改咗 **label 嘅意義**：
之前最低-priority 贏、之後最高-priority 贏（見 §五）。所以 cohort 一定要切兩截。

**C. 路線 2：raydium-owned 登記延遲**

| 段 | n | p50 | max | >80s | >120s | >300s |
|---|---|---|---|---|---|---|
| 全部 | 75 | 47s | **737s** | 18 | 11 | 1 |
| **fit 前**（<23:39Z） | 55 | 65s | 737s | 18 | 11 | 1 |
| **fit 後**（≥23:39Z） | 20 | **28s** | **40s** | **0** | **0** | **0** |

⇒ **fit 後 20 粒全部登記延遲 ≤40s** —— 全部落喺 jup 個 ~50s `/recent` 窗**裏面**，
即係嗰一 tick jup 有機會抬到佢哋，**label 係「搶贏」而唔係「搵到」**。

**D. cohort 本身（唔變）**：75 粒、pushed **0**、best mcap **$53,969**（< $60K
floor）、never_priced 4、avg_age_at_discovery 1.2min。

## 五、結論

**jup 429 backoff 窗內，raydium 腿實際多捉到嘅： 0 粒（量到嘅）。**

1. **冇窗**：保留窗內 jup-owned 出世時間軸冇 ≥4min 嘅洞（max 216s，而且嗰段係
   靜市）。所以「backoff 窗」根本冇出現 ⇒ 窗內多捉 = 0。呢個唔係「佢冇用」，
   而係「呢條槓桿今次冇被行使」。
2. **per-mint 層面同一結論**：fit（現行 priority）之後，20 粒 raydium-owned 全部
   登記延遲 ≤40s，全部喺 jup 個 50s 窗以內 ⇒ 佢哋係**同 tick 搶 label**，唔係
   覆蓋。真正「jup miss 咗」嗰 18 粒（延遲 82–737s）**全部喺 fit 之前**，係舊
   label 語意下嘅樣本。
3. **fit 改咗 label 嘅意思，令兩截唔可比**（讀數嘅重點）：
   - **fit 前**：最低-priority 贏 ⇒ `raydium` label 表示「raydium 抬過、而冇任何更低
     leg（…jup…）抬過」⇒ **pre-fix 嘅 raydium row 天生就係邊際（jup 冇抬）**。
   - **fit 後**：最高-priority 贏 ⇒ `raydium` label 只表示「dex 同 pump 冇抬」，
     **jup 可能同一 tick 都抬過** —— label 收埋咗。所以 fit 後要用延遲（路線 2）
     去論證，唔可以只靠 label。
4. 承接上一條：raydium 腿係「同 tick 搶贏」為主；今次證明連「jup 退避窗口」
   呢個剩餘理由，喺現行 priority 下**亦量唔到貢獻**（0）。

## 六、界線（老實講）

- **反推，唔係直擊**：backoff 冇 durable 記錄，路線 1 係 effect-level 推論 ——
  佢話「jup-owned 出世停咗」，唔話「因為 429」（一個 jup 腿嘅 deploy 都會似樣，
  只係 5 分鐘啱好對上退避常數）。
- **單一 isolate 嘅退避睇唔到**：client 係 per-isolate 建一次，一個 isolate 被
  429 只會令 jup **率跌**、唔會歸零 ⇒ 路線 1（要嚴格零）會漏。路線 2 補到呢半，
  但佢假設「jup 健康就喺 80s 內抬到」——`/recent` 窗闊度隨 launch 密度變
  （30 行；burst 時可短過 50s），所以 80s 係一個近似線。
- **fit 後樣本細**：post-fix 只有 20 粒、時間跨度 ~6h（`fe327bc` 23:39 → 05:33）。
  「0」係可信嘅下限，唔係大樣本。
- **一個 tick 嘅 jup 沉默分唔清**：可能係 jup 真係冇抬，亦可能係佢嗰 tick fetch
  失敗/退避。所有 1.2min 嘅 gap 都屬呢類。
- 冇改 runtime 代碼；唯一改動係 `scripts/raydium-attribution.js`（唯讀診斷，新增
  `--jup-holes`）。

## 七、驗收

- `node scripts/raydium-attribution.js --jup-holes` → 上面表 A/C（exit 0）。
- `node scripts/test-unit.js` → **535 passed / 0 failed**。

## 八、2026-10-15 補充：改讀 D1 之後嘅第一次實跑

原稿讀嘅係 Turso；2026-10-15 09:33Z 個 store 切去 D1（見 `docs/d1-migration-2026-10-15.md`），
Turso 變成唯讀 archive。`scripts/raydium-attribution.js` 已改成**預設讀 D1**
（`scripts/d1-rest.js` 嘅 REST binding ＋ `src/d1.ts` 嘅 transport，即 migration／backfill 同一條路；
`--archive` 先至讀凍結咗嘅舊 store），每次跑都會印一行 `source:`。
下面係同一條問題喺 **live D1**（22:2xZ，窗 6 小時）第一次讀到嘅數：

| 讀數 | live D1（6h 窗） | 原稿（2026-10-14 05:3xZ，24h 窗，archive） |
|---|---|---|
| jup holes（≥4min，且窗內其他腿 ≥3 粒） | **4 個，合共 24 分鐘** | 0 個（最長 gap 216s） |
| raydium cohort | 275 粒 | 20 粒 |
| 落喺 hole 內嘅 raydium-owned | **21 粒**（in-hole births 132） | 0 粒 |
| raydium 佔 in-hole births vs 全窗 | **15.9% vs 2.2%** | —（無 hole 可讀） |

**唔可以當定論**，界線照舊：(1) post-fix 嘅 `jup` label 只代表「jup 抬過、而無更高-priority 腿
抬過」，所以一條 hole 亦可以由「嗰段時間所有 launch 都俾 pump/raydium/meteora 搶咗 label」造成，
唔一定係 jup 沉默（見 §五.3 同一點）；(2) 嗰 4 個 hole 之中，21:33:29→21:42:13（8.7min）夾住
Birdeye backfill 當時 seed 嘅 20 條 `legacy` row，成分唔乾淨。要坐實「raydium 喺 jup 退避窗內
真係多捉」，下一步係要 per-tick 嘅 jup 429 證據（今日冇 durable row），而唔係只靠 label 形狀。
