# 推送幣評分（push score）：可行性研究

> 2026-10-12。研究題目：**可否將已推送嘅合資格幣分析得出一個 score？**
> 參考對象：[crawl-hive](https://github.com/h100envy/crawl-hive)（CrawlHive）嘅
> Instant Crawl 0–100 分 + verdict，同佢「每個 signal 事後對真價格」嘅
> reputation 迴路。
>
> 結論先講：**可以，而且成本近乎零** —— 評分要用嘅料今日大部分已經喺
> push 嗰一刻 fetch 完、印喺卡上面；而「事後對價格」嗰半，`push_watch`
> 已經逐個 tick 抽緊價、已經有 🏁 結案判定。缺嘅只係一個**聚合器**
> （把散落嘅讀數變成一個 0–100 + verdict），同一欄**持久化**（令評分可
> 以同結果 join 埋校準）。
>
> 本文件只做研究同設計，**未改任何代碼**。
>
> **2026-10-12 補充**：§10 開始係「CrawlHive 本身點樣用」—— 佢有一個
> **免費、無 key、無錢包**嘅公開 scan API，已經現場實測（見 §10.2）。
>
> **同日再補**：§11 = 用本 bot 自己嘅 **10 隻推送幣**（含 6 隻 pump.fun
> mint）量嘅延遲同分數，並同 🏁 結果對照。工具：
> `scripts/crawlhive-probe.js`（新增，read-only）。

## 0. 參考對象做緊乜（只抄真正相關嘅兩點）

CrawlHive 自己講嘅評分有兩層，兩層都值得抄，但抄法唔同：

| CrawlHive 嘅做法 | 對本 bot 嘅意義 |
|---|---|
| **Instant Crawl 0–100**：market（流動性／FDV／pair age／1h vol／買賣比）、holders（mint/freeze authority、top holder 同 next-10）、clones、bundles（同一 funder 歸為一個 owner）、dev（creator 歷史、仲揸幾多）、Telegram／X。verdict = CLEAN / OK / RISKY / DANGER，pair < 30 分鐘 = TOO EARLY。 | **全部已有等價物，而且係免費嘅** —— 見 §2。真正值得抄嘅係「**一條 0–100 + 一句理由 + 幾個最嚴重 flag**」嘅輸出形狀，唔係佢嘅數據源。 |
| **Fair scoring / reputation**：每個 signal 事後對真價格（每 5 分鐘抽樣，窗口內最高嗰點算 hit），hit/miss 組成 crawler 嘅 reputation。 | **已經有**：`push_watch` 每 tick 抽 DexScreener 價，`peak_mcap`、`last_mcap`、`last_state`，仲有 🏁 結案判定同不可變嘅 push ledger。評分只係要掛上去 join。 |

即係話：CrawlHive 賣嘅係「你出 edge、crawler 幫你睇」；本 bot 嘅**edge
已經係推送本身**，缺嘅係「**呢個推送值幾多分、事後證明準唔準**」。

## 1. 直接答覆

**可以。** 分三件獨立嘅事，逐件都成立：

1. **推時評分（0–100）** —— 所有輸入喺 `scanner.ts` push site（`renderMessage`
   之前，約 L6970）**同時在 scope**：`rugcheck.bundlerPct/top10Pct/creator`、
   `wallet`、`crime`、`organic`、`flurry`、`gmgn`、`arkham`、`coin.pair`。
   一個純函數食呢堆讀數，零新上游請求。
2. **持久化** —— 一行（`push_watch.score_at_push`，或 push ledger 嘅
   `PushLedgerEntry`，順便有埋「當時 band」嘅 provenance）。
3. **事後校準** —— 26h/30h 窗口走完，🏁 recap 已經出判定；把評分
   同判定 join 埋，就得出「邊個分數帶真係會跑」——**唔需要任何新 API**。

唯一真正嘅**難點唔係技術，係誠實性**：缺讀數唔可以當安全（見 §5）。

## 2. 今日手上實有嘅數據（同埋邊啲其實熄咗）

`wrangler.toml` 嘅實際狀態（2026-10-12）：

| 來源 | 開關 | 提供 | 評分用嚟做 |
|---|---|---|---|
| DexScreener pair（`PairInfo`） | 常開 | `marketCap`、`fdvUsd`/`mcapFromFdv`、`volume{h24,h1,m5}`、`priceChange{m5,h1}`、`txns{m5Buys,m5Sells,h1Buys,h1Sells}`、`liquidity.usd`、`pairCreatedAt`、`feedSource` | market 維度：**買賣比**、turnover（vol/mcap）、pool age、liq/mcap |
| RugCheck | 常開 | `bundlerPct`、`top10Pct`、`creator`（**注意 null ≠ 0**） | 集中度、creator 身份 |
| Jupiter Token v2 `/search` | 常開 | `organicScore`（0–100）、`tradersH1`、`audit.isSus`、`devBalancePercentage`、`devMints`、`mint/freezeAuthorityDisabled`、`topHoldersPercentage` | 有機度、供應商 flag、dev 持倉 |
| wallet analysis | 預設開（`WALLET_ANALYSIS_ENABLED`） | creator 錢包 age、`serialLauncher` + `createCount`、holder 新錢包比、cross-coin cluster | creator 風險、關聯錢包 |
| Flurry（`FLURRY_BUDGET_MS=1200`） | 開 | `tier`（CRITICAL/HIGH/MODERATE/LOW）、`bundled`、deploy-slot 錢包數／供應 %、同資金來源錢包 | 開盤 slot 捆綁 |
| `token_stats`（自己存） | — | `first_m5_vol`、`first_seen_age_min`、`launch_ms`、`birdeye_1m_vol`、`birdeye_pro_traders`、`birdeye_sniper_pct`、`holder_count`、`min/max_mcap_observed`、`max_liquidity_observed` | 首現質素、歷史高低水、holder 增長 |
| GMGN／Arkham／Axiom／CrimeWallets／supply flow | **全部熄**（`GMGN_ENABLED=0`、`ARKHAM_ENABLED=0`、`AXIOM_ENABLED=0`、`CRIME_WALLETS_ENABLED=false`、`SUPPLY_FLOW_ENABLED=false`） | — | **唔可以計入評分**，只能顯示「未評」 |

→ 評分唔應該「假設」熄咗嘅腿有值。今日真正可算嘅維度係：**market、
RugCheck 集中度、Jupiter（有機度 + isSus + dev 持倉）、creator 深度、
Flurry 開盤**。五個維度已經覆蓋 CrawlHive Instant Crawl 嘅 market /
holders / bundles / dev 四項。

### 2.1 現行嘅「半成品 score」其實係四個獨立閘

本 bot 已經有自己嘅評分元素，但係**各自成閘、各自印一行**，冇匯總：

| 閘 / 讀數 | 現值 | 位置 |
|---|---|---|
| `ORGANIC_MIN_SCORE` | 55（0–100） | `scanner.organicMinBlockReason` |
| `ORGANIC_MAX_TRADERS_H1` | 1400 | `scanner.organicTradersBlockReason` |
| `TOP10_PCT_MIN/MAX` | 10 / 90 | chat settings |
| `MCAP_LIQ_RATIO_MIN` | 2（MAX 預設 10） | `scanner` liqRatio 閘 |
| `WALLET_NEW_RATIO_MAX` / `WALLET_NEW_MIN_CHECKED` | 0.8 / 5 | `scanner` |
| Jupiter `audit.isSus` | presence-only block | `jupiterSusBlockReason` |

而且 `docs/suspicious-token-gates.md`（2026-09-28）已經**量過**呢啲訊號嘅
準確度 —— 呢個就係評分權重最好嘅起點，唔使靠估：

| 準則 | 觸發 | 其中爆池 | 假陽性 |
|---|---|---|---|
| `audit.isSus === true` | 5 | **5** | **0 / 35** |
| `devBalancePercentage ≥ 10` | 5 | 5 | **0 / 35** |
| `liq/mcap ≥ 0.30` | 5 | 5 | **0 / 35**（乾淨組最高 0.289） |
| `liq/mcap ≥ 0.50` | 4 | 4 | 0 / 35 |
| `devMints ≥ 3` | 22 | 6 | **16 — 紅鯡魚** |

三個真訊號嘅聯集 = 6/6 爆池、0/35 假陽性，即係用 ~12% 嘅推送量抓到 46%
嘅抽水。**呢張表本身就係一個現成嘅評分骨幹**：`isSus`、`dev %`、
`liq/mcap` 三個係高置信度嘅扣分項，`devMints` 唔應該入分（或權重極低）。
反而 `liq/mcap` 低過 2.0 係 measured 嘅危險區（每 push 高於 2.9x mcap/LP
全部無事）。

## 3. 結果側：已經有，唔使起新嘢

「事後證明」呢一半係評分可唔可信嘅關鍵，而佢**已經喺度**：

| 現有物 | 內容 | 對評分嘅用途 |
|---|---|---|
| `push_watch` | `mcap_at_push`、`peak_mcap`、`last_mcap`、`last_state`、`holders_at_push/last`、`followups_sent`、`pushed_at`、`dead_trough_mcap`、`sell_dom_streak` | 每 tick 一個 DexScreener batch 抽樣 → **峰值倍數 = 標籤** |
| 🏁 `recapVerdict` | 門檻固定：peakX ≥4 🏆、≥2 🚀、≥1.5 📈、final ≥0.9 ➡️、≤0.45 💀、rug 💧 | 離散 ground truth，校準直接用 |
| `push_ledger`（純函數） | 不可變嘅 push 基準 + 當時 band（240 條 / 7 日），仲會 flag 被 heal／復活改寫過嘅行 | 唔會被 band 改動或 self-heal 污染嘅聯合鍵 |
| `push_audit` ring / `/debug/pushes` | 近 ~30–200 次送卡 | 短期回溯 |
| `scan_history` / `/health.fails` | 每 tick profiles/pool/candidates/pushed + 各閘擋咗幾多 | 睇「評分係咪改變咗輸出量」 |

即係：**評分上線第一日就已經可以事後驗證**，唔需要等市場、唔需要新
供應商。

## 4. 建議設計（兩層，一個純函數，唔做閘）

### 4.1 第一層：推時質量分 `score.ts`（純函數）

- 新檔 `src/score.ts`，跟 `pushledger.ts`／`pushwatch.ts` 嘅慣例：**純、
  無 I/O、無自己嘅鐘、唔 throw**，配 `scripts/test-score.js`。
- 輸入係 push site 已經有嘅讀數物件（唔加 fetch）：
  `{ pair, tokenStats, rugcheck, organic, wallet, flurry }`。
- 輸出 `{ score: number | null, band: "A"|"B"|"C"|"D"|null, reasons: string[], coverage: number }`。

建議維度同權重（全部有 measured 依據，唔係拍腦）：

| 維度 | 方向 | 依據 |
|---|---|---|
| `liq/mcap` | 越高越危險，< 2.0 重罰 | suspicious-token-gates §3（0 假陽性） |
| `audit.isSus` | true → 直接落 D | 同上，5/5 |
| `devBalancePercentage` | ≥10% → 重罰 | 同上，5/5 |
| RugCheck `bundlerPct` / `top10Pct` | 高 → 扣分；**null → 未評，唔扣亦唔加** | §5 誠實性 |
| creator：age、`serialLauncher`、仍持倉 | 新錢包／連發 → 扣分 | `walletanalysis` |
| Flurry `tier` + deploy-slot bundle | CRITICAL/HIGH → 重罰 | `flurry.ts` |
| Jupiter `organicScore`（低）／`tradersH1`（異常高） | 扣分 | `ORGANIC_*` 閘 |
| 加分項（free）：`txns` 買賣比、turnover `vol5/mcap`、pair age、holder 增長 | 越高越好 | `PairInfo` |

- **輸出形狀抄 CrawlHive**：一條 `⭐ 評分 72/100（B）｜主因：…`，同
  最嚴重 2–3 個 flag。唔另開一段長文，卡已經 16 行。
- **verdict 用返本 repo 嘅語彙**（✅/⚠️/🔴 + 「未評」），唔引入新一套
  CLEAN/OK/RISKY/DANGER，免得同卡上面其他行嘅語意打架。

### 4.2 第二層：結果分（校準，唔係新代碼）

- 把 `scoreAtPush` 寫入 `push_watch`（一欄）或 ledger entry（連 band）。
- 每日／每次結案之後抽一次：**每個 band 嘅 P(peak ≥2×)、P(rug)、平均峰值 ×**。
- 呢個係無限循環嘅免費標籤：`push_watch` 已經有取樣，🏁 已經有判定。
- 只有當 band 單調（高分帶真係跑得好過低分帶）先至值得考慮做閘。

### 4.3 明確**唔做**嘅事

- **唔做閘（gate）**。第一版只係一個讀數。本 repo 對「先讀數後閘」有
  明確紀律（band/liq 比例嘅調參都係先量後改），而 `ORGANIC_MIN_SCORE`
  之類嘅閘係 operator 嘅手調旋鈕，唔應該由一個新分數偷偷接管。
- **唔加 fetch、唔加 subrequest**。評分只食已在 scope 嘅物件；任何要
  新 API 嘅維度（X／Telegram 情緒）唔做。
- **唔改卡嘅既有行**，只加一行。

## 5. 誠實性要求（呢節最重要）

呢個 repo 已經為「假 all-clear」痛過一次（QNT 卡印
`🛡 Bundler: 0.0%（未檢測到捆綁網絡）`，而 `rugcheck_bundler_pct` 係
`null`）。評分一定要繼承嗰個教訓：

1. **`null ≠ 0`**。缺讀數既唔扣分亦唔加分，並計入 `coverage`。
   coverage 太低（例如 < 50%）→ 出「未評」，唔出數字。
2. **唔混 metrics**。`mcapFromFdv` 為 true 嘅行，市值係 FDV，唔應該同
   流通市值行同一條 `liq/mcap` 曲線；`feedSource` 亦要記錄
   （Jupiter/Gecko 嘅流動性係 DexScreener 嘅 ~0.5×，見 `PairInfo` 註解）。
3. **唔計熄咗嘅腿**（§2 表）。GMGN/Arkham/Axiom/crime/supply flow 全部
   off，評分唔可以「假設」佢哋無命中就係乾淨。
4. **`devMints` 唔入分**（22 觸發 / 16 假陽性，measured）。
5. 記錄**當時嘅輸入快照**（至少 scores 嘅 breakdown 或 reasons），
   否則事後無法解釋某一分係點嚟 —— 同 `push_ledger` 為「當時 band」
   做嘅事一樣。

## 6. 成本同風險

| 項目 | 估計 |
|---|---|
| 新上游請求 | **0**（全部已在 scope） |
| 新 subrequest / tick | 0（一個純函數） |
| Turso 寫入 | 每個 push 多 1 欄（`push_watch` upsert 已有），或 ledger entry 多一個欄位 —— 同一次 batch |
| 卡長度 | +1 行 |
| 代碼量 | ~1 個純函數檔 + 1 行 render + 1 欄 schema + 1 個 test script |
| 風險 | 主要係**誤導性數字**（見 §5）同**用推送樣本校準嘅選擇偏差**（見 §7） |

## 7. 校準方法（呢點決定分數有冇意義）

只對「已推送」嘅幣評分會有一個問題：推送本身已經過咗一輪閘，所以高分帶
會被過度抽樣，低分帶樣本不足 → 單調性睇唔出。

有兩個選擇：

| 方案 | 優點 | 缺點 |
|---|---|---|
| **只評推送幣**（最小改動） | 改動最細、直接回答用戶問題 | 樣本偏差；高分帶佔大多數 |
| **評所有被判斷嘅幣**（包括被拒） | 有對照組，單調性可驗證；`RejectionEntry.token` 已經存咗 mint，`/health.summary.rejects` 可以直接 join | 要喺 reject 路徑多叫一次純函數；要決定 reject 幣點抽價格（現時只追蹤推送幣） |

**建議**：第一版只評推送幣（零風險、即時可用）；如果睇完幾日發現分數
分佈太窄，再擴到「所有判斷過嘅幣」——因為純函數已經隔離好，擴展只係
多一個 call site。

## 8. 未做清單（等指示）

1. 寫 `src/score.ts` + `scripts/test-score.js`（純函數，先唔接線）。
2. 卡加一行 `⭐ 評分`；`push_watch` 加 `score_at_push`（或 ledger entry
   加欄）；`/debug/token?mint=` 帶出 breakdown。
3. 一個每日／結案後嘅 band-vs-outcome 讀數（可以係一個 read-only
   script，跟 `scripts/scan-history-daily.js` 嘅形狀）。
4. 有單調性證據之後，才決定要唔要做閘／改權重。

## 9. 限制

- 本文嘅「成本 0」係指**唔加新上游來源**；評分會令卡多一行，同每次
  push 多一個欄位寫入，兩者都要過 `/health` 同 subrequest 預算（現時
  `heartbeat.subreqs` 約 38）。
- 三個 measured 訊號（`isSus`／`dev %`／`liq/mcap`）嘅樣本係 2026-09-28
  嗰 48 個 unique token（13 個爆池），單一窗口；權重應該當成**起點**，
  唔係定案。
- 熄咗嘅腿（GMGN/Arkham/Axiom/crime/supply flow）令評分維度少過
  CrawlHive Instant Crawl；補返任何一條腿都應該重新睇 coverage 同權重。

## 10. CrawlHive 本身點樣用（2026-10-12 現場驗證）

### 10.1 原理：一條 pipeline，兩層評分

CrawlHive 係一個 Next.js 應用，核心係**兩件唔同嘅事**：

**(1) 自家 crawler 嘅 pipeline**（`src/lib/server/crawl/scheduler.ts`）。每個
crawler = **一個 source + 一組 targets + 一份 specification**（`docs/CRAWLERS.md`）：

| 階段 | 做乜 |
|---|---|
| Collect | source 由上一個 cursor（last post id／last run／page hash）開始攞新嘢 |
| Extract | 有 `XAI_API_KEY` → Grok 按規格讀出結構化 signal；冇 key → 規則（關鍵字 + `$TICKER`／合約地址） |
| Resolve | 對 DexScreener 解析成 token（合約優先，否則同鏈最深的同 ticker 池），記低當時價格 |
| Dedupe | 同一個 crawler 對同一個 token 12 小時內唔重複 |
| Deliver | 入 owner 嘅 My Signals（+ Telegram）；公開feed只出「有人放過」嘅紅刪本 |
| **Score** | `outcome.horizonMin` 之後再攞價，升幅 ≥ `outcome.hitThresholdPct` 就係 **hit**，否則 miss；hit/miss 入 `src/lib/reputation.ts` |

四個 source：**X**（Grok `x_search`，付費，$5/1000 posts，每 15–120 分鐘一次，
受 `XAI_DAILY_CALLS`=300/日 上限）、**Telegram**（`t.me/s/<channel>` 公開預覽，
免費）、**On-chain**（DexScreener profiles/boosts/search，免費）、**Docs**（公開網頁
diff，免費）。呢個就係 README 講嘅「你出 edge、crawler 幫你睇、記分板證明邊個啱」。

**(2) Instant Crawl —— 免費單幣掃描**（`src/lib/server/scan.ts`），即係我哋
真正想用嘅嘢：**6 隻 crawler 並行跑同一個 mint**（market／holders／clones／
bundles／dev／telegram），每隻寫一行 log，最後合成 **0–100 分 + verdict
（CLEAN／OK／RISKY／DANGER／TOO_EARLY）+ `factors[]`**。

### 10.2 已實測：公開 scan API（無 key、無錢包）

| 項目 | 實測結果 |
|---|---|
| Endpoint | `GET https://crawlhive.xyz/api/scan?q=<mint>`（`q` 亦收 `$TICKER`、DexScreener／pump.fun／Solscan 連結；`chain=solana\|robinhood` 只影響 ticker 解析） |
| 認證 | **完全冇** —— 無 key、無錢包、無 sign-up |
| 格式 | `Content-Type: text/event-stream`（SSE），每行 `data: {...}` |
| 事件序 | `log`（每隻 crawler 一行）→ **`result`**（唯一要嘅）→ `x`／`xoffer` → `done`；失敗係 `error` |
| 實測樣本 | WIF `EKpQGS…zcjm`：HTTP 200、`6 crawlers dispatched`、**first log → result 3.14s** |
| 實測 `result` | `score 90 / CLEAN`、`factors:[{Top-heavy,-10}]`、`holders{top1 13.7, top10 44.4, mint/freeze false}`、`bundles{checked 2, clusters []}`、`clones 14, original true`、`market{liquidity $157.3k, fdv $208.29M, buys1h 509, sells1h 241}` |
| 速率限制 | `allowScan`：**每個 IP 每 10 分鐘 8 次**（in-memory，per instance） |
| 快取 | 同一個 address 2 分鐘內重掃直接回舊 result（`CACHE_MS`） |
| X／Grok | **唔會自動跑**（付費）；只回快取 buzz，否則出 `xoffer` |
| 來源 | `src/app/api/scan/route.ts`、`src/lib/server/scan.ts`（MIT） |

`result` 嘅完整形狀（即係我哋會讀嘅欄位）：

```
id, chain, symbol, name, score, verdict, reason,
factors[{label, impact, note}],           // impact 負數 = 扣咗幾多分
market{priceUsd, liquidityUsd, fdv, volume1h, volume24h, change1h,
       ageHours, buys1h, sells1h, url, socials},
holders{top1, top10, mintAuthority, freezeAuthority},
bundles{checked, clusters[], fresh{wallets, pct}},
dev{...}, clones, original, telegram[], scannedAt
```

### 10.3 三條利用路徑

| # | 路徑 | 做乜 | 前置／成本 | 適合 |
|---|---|---|---|---|
| **A** | **公開 `/api/scan`** | 推送前後攞第三方 0–100 分 + `factors`，加一行卡／存入校準 | 免費、無 key；要過 8/10min 同 ~3s 延遲 | **建議第一步** |
| B | MCP server（`POST /mcp`，`Authorization: Bearer chb_…`） | `scan_token`（**20 次/小時/bot**）、`whats_new`、`crawler_signals`、`my_crawlers` 做 agent 迴路 | 要錢包登入佢個站開 bot key；`whats_new` 要有自己嘅 crawler（SOL 付費 30 日） | 將來想「用佢嘅 crawler 做我哋嘅 discovery」 |
| C | **借設計**（§0–§7） | 自建評分，零外部依賴 | 無 | 長遠主力 |

### 10.4 如果接 A，落喺本 repo 邊個位

1. **best-effort、never gate**：跟 `bestEffort` 嘅形狀，過 deadline 就當冇，卡少
   一行 —— 同 GMGN／Arkham／crime「無數據就唔出」一樣嘅立場。
2. **唔好放 hot push path 正中**：~3s 係一次上游 RPC 級數嘅延遲。放
   `push_watch` tracker lane（每 tick 一個 batch）或 deferred／makeup lane 較安全；
   若放 push site，就用 2–3s deadline fail-open。
3. **SSE 解析**：`fetch` → `response.body.getReader()` → 只讀 `data: ` 行 → 攞到
   `type:"result"` 即刻 `AbortController.abort()`（唔好等 `done`）。
4. **IP 限速係風險**：佢按 `x-forwarded-for[0]` 限 8/10min，而 Cloudflare Worker
   嘅 egress IP 係**共用**嘅 —— 所以「Too many scans」要當正常，**唔好重試**。
5. **量**：本 bot 今日 push 10–38/日（≈ 最多 1.6/小時），離 8/10min 好遠；加埋佢
   2 分鐘快取，同一 mint 重複掃係免費嘅。
6. **標明來源**：卡上寫 `🔭 CrawlHive: 90 CLEAN`，**唔可以**同本 bot 自己嘅
   `⭐ 評分` 混為一談（§5 誠實性嘅延伸）。
7. **額外好處（校準）**：佢免費，所以可以對**被我哋拒絕嘅幣**抽樣掃，直接回答
   「我哋啲閘擋咗幾多佢認為 CLEAN 嘅幣」—— 正係 §7 講嘅選擇偏差，唔使自己等。

### 10.5 風險同限制

- 冇公開嘅第三方 API 政策／free tier 文件；只有 code 入面嘅 IP 限速同 MIT
  license。要用就要**尊重限速、唔好批量掃**。
- 佢自認係 MVP，endpoint 可能改；接咗都要 fail-open，唔可以成為唯一讀數。
- `scan` 唔會自動跑 X／Grok，所以唔會有「AI 情緒」維度。
- 本文件嘅第一輪實測係 **2026-10-12 一個樣本（WIF，成熟幣）**。
  **第二輪（§11）已經補上 10 隻自家推送幣（含 6 隻 pump.fun mint）**：延遲同
  成熟幣一樣（result p50 3.49s / max 3.91s），即係 pump.fun 嘅 dev／bundles
  trace 冇令佢慢；但**佢嘅分數同我哋嘅推送結果無單調關係**，而且佢個 IP 限速
  係同陌生人共用嘅 —— 兩點都見 §11。

## 11. 實測：10 隻自家推送幣（2026-10-12 17:44–17:55Z）

### 11.1 方法

工具：`scripts/crawlhive-probe.js`（本次新增，**read-only**：讀自己
`/debug/push-audit` 攞 mint 清單，再逐個掃，**唔掂 Turso、唔寫任何 row**）。
樣本 = delivery ring 最新 10 條 `kind:"initial"`（推送時間 05:06–17:11Z），
其中 **6 隻 mint 以 `pump` 結尾**（pump.fun vanity），另加 Multipad 係由我哋
pump.fun feed 發現（`discoveredVia=pump`）。掃描時距推送 **0.55–7.5 小時**。

### 11.2 延遲（客戶端 wall-clock，即 Worker subrequest 實付嘅數）

| 讀數 | p50 | max |
|---|---|---|
| TTFB（連線已熱，8 個樣本） | **164ms** | 171ms |
| TTFB（每 batch 第一個 request，cold） | — | 581ms |
| 第一行 crawler log | 166ms | 552ms |
| **`result` 事件**（10 個樣本合併） | **3516ms** | **3913ms** |
| log 行數 | 8 | 8 |

10 隻（含 pump.fun）**全部冇 timeout、冇 5xx**；唯一失敗係限速（見 §11.4）。
即係：**~3.5 秒**，同成熟幣 WIF 一樣，pump.fun 嘅 dev／bundles trace 冇令佢變慢。

### 11.3 分數 + 同本 bot 自己結果嘅對照

`peak×` = 本 bot tracker 嘅 `peak_mcap / mcap_at_push`；`state` = 我們嘅終態
（`rug` = LP 枯竭）。

| # | 幣 | mint | 距推送 | 佢分數 | verdict | 佢嘅理由 | 我哋 peak× | 我哋 state |
|---|---|---|---|---|---|---|---|---|
| 1 | MINU | `2WvvNt…pump` | 33min | **90** | CLEAN | Low liquidity $19.4k | 1.04 | active |
| 2 | STUDIO | `Ft87to…pump` | 62min | **100** | CLEAN | No red flags | 1.24 | weak |
| 3 | GABOX | `GaBoXh…AHWm` | 3.0h | 55 | RISKY | Thin liquidity **$0** | 1.00 | active |
| 4 | OVERDRIVE | `HT1hPo…pump` | 3.2h | 85 | CLEAN | Dumping -60% 1h | 1.54 | dead |
| 5 | Multipad | `5v44XT…dpad` | 3.4h | 50 | RISKY | Thin $4.4k + sell pressure + -69% | 1.43 | **rug** |
| 6 | CHAOS | `A5WR25…fxJh` | 4.0h | 70 | OK | $6.3k + weak dev + copycats | 1.18 | **rug** |
| 7 | WIRED | `4FMSyE…pump` | 4.0h | 70 | OK | Thin $4.9k | 1.00 | **rug** |
| 8 | STARTUP | `DRGU3e…PMwD` | 5.1h | 70 | OK | $6.0k + fresh dev + copycats + no socials | 1.00 | **rug** |
| 9 | Gem | `9Y8CL6…pump` | 7.3h | **90** | CLEAN | Low liquidity $6.5k | 1.56 | **rug** |
| 10 | Ploy | `39fzwe…pump` | 7.5h | **90** | CLEAN | Low liquidity $17.1k | 1.00 | active |

**讀數：喺呢 10 隻入面，佢嘅分數同我哋嘅結果無單調關係。**

- 佢 5 隻 CLEAN（85–100）之中：Gem(90) 同 WIRED（70 OK）**已經 rug**、
  OVERDRIVE(85) `dead`（-68%）、MINU(90) 同 Ploy(90) 橫盤（1.04／1.00）。
- 佢最高分（100 STUDIO）peak 只有 1.24；peak 最高嘅 Gem(1.56) 亦係 90 CLEAN；
  而 peak 最低嘅一批（1.00）散落在 55 / 70 / 70 / 90 分之間。
- 兩隻 RISKY（55 GABOX、50 Multipad）之中，一隻橫盤、一隻 rug。

原因唔難理解，而且**唔係佢做錯**：`Instant Crawl` 係「**掃描嗰一刻嘅安全／質素
分**」，量嘅係當下 holder／liquidity／dev 狀態，唔係「呢個推送之後會唔會跑」。
而且佢喺 §11.3 每個樣本都係 **推送後 0.55–7.5 小時**先影嘅快照 —— 要量推時分
數，只能喺推送嗰刻同步掃（見 §11.6）。

### 11.4 IP 限速係真嘅，而且係共享嘅

| 時間 | 事件 |
|---|---|
| 17:44:29–17:45:15 | batch 1：**7 次成功**（最後一次係 WIRED） |
| ~17:45:22 | 第 8 次（STARTUP）→ `Too many scans from your network` |
| 17:46:11 | 再試 3 次 → 全部照樣被拒 |
| 17:54:45–17:54:59 | batch 2：**3 次全部成功** |

即係：**我哋自己只放咗 7 個 request 就撞頂**（限額 8/10min 按 IP 計，而我哋嘅
request 係由 Cloudflare 共用 egress IP 出去），由被拒到恢復 ≈ **9.3 分鐘**。

一個細節值得記低：恢復時間比「自己最後一次成功 + 10 分鐘」（17:55:15）**早了大
概半分鐘**。呢個不是怪事 —— `allowScan` 個 hits map 係
`globalThis.__crawlhiveScan`，即**每個 server instance 各自一份** module state
（README 也講係 in-memory）。所以我哋嘅配額其實係「每個 (IP, instance)」，
恢復時間會有 fuzzy：可能撞到另一個 instance 就過得去。

對本 bot 嘅含意：**呢個 API 唔係我哋獨佔嘅資源**，有時會攞唔到分。

### 11.5 佢嘅 factor 詞彙表（實測見到，可以直接餵 §4 嘅權重）

| factor | impact | 佢嘅門檻（本次實測） | 本 bot 有冇等價物 |
|---|---|---|---|
| Thin liquidity | **-25** | 池 < ~$5k | `liquidity.usd` / `MCAP_LIQ_RATIO_MIN` |
| Concentrated | **-20** | next 10 ≥ ~51% | `rugcheckTop10Pct` |
| Low liquidity | -10 | ~$6k–19k | 同上 |
| Weak dev record | -10 | 35/1100 earlier launches graduated | `walletanalysis` serialLauncher |
| Sell pressure | -10 | 26 sells vs 10 buys（1h） | `PairInfo.txns`（免費，已有） |
| Dumping | -10 | -60% ／ -69%（1h） | `PairInfo.priceChange.h1`（免費，已有） |
| Copycats | -10 | 11–19 個同 ticker | **冇**（新維度） |
| Fresh dev wallet | -5 | creator 錢包 < ~8h | `walletanalysis` creator age |
| No socials | -5 | DexScreener 冇 socials | **冇**（新維度） |

呢張表係本次最有價值嘅產出：**免費、已量、同本 repo 自己量到嘅
`liq`／`dev%` 結論方向一致**（§2.1），可以直接當 §4 自建評分嘅起始權重，
而 Sell pressure／Dumping 兩個 penalty 用嘅係我哋**已經有**嘅 `PairInfo` 欄位。

### 11.6 跨供應商數據打架（反面教材）

| 幣 | 佢讀嘅池 | 我哋 `last_liquidity` | 差異 |
|---|---|---|---|
| MINU | $19.4k | $12.4k | 佢**高** 1.56× |
| WIRED | $4.9k | $9.1k | 佢**低** 0.54× |
| GABOX | **$0** | $13.0k（幣仲喺度成交） | 完全唔同 |

→ 唔係固定比例、亦唔等於 DexScreener 嘅 `liquidity.usd`；GABOX 嗰個 `$0` 大機會
係佢 bind 咗**另一個（空）pair**。同 `docs/mcap-basis-and-pool-pick-2026-10-02.md`
嘅教訓一樣：**唔可以混兩個 provider 嘅流動性讀數**，更加唔可以攞佢個數落閘。

### 11.7 對 §4 設計嘅影響（實測之後修訂）

| 之前嘅假設 | 實測之後 |
|---|---|
| 「~3s 延遲，新幣可能更慢」 | ✅ pump.fun 幣一樣 3.4–3.9s；cold start 581ms TTFB |
| 「8/10min 額度應該夠（我哋 1.6/h）」 | ❌ **額度係共享嘅**，7 個 request 就到頂 |
| 「可以攞佢個分做卡上一行」 | ⚠️ 可以，但必須 fail-open + durable 記「成功／限速／失敗」，否則以為佢壞 |
| 「佢個分可以做排序／閘」 | ❌ n=10 無單調性；佢量嘅係當下安全分，唔係推送前景 |
| 自建評分嘅權重未定 | ✅ 有咗 §11.5 嘅免費起始權重（+ 2 個我哋冇嘅維度） |

**如果要量「推時分數 vs 推送結果」，唯一乾淨嘅做法係喺推送嗰刻同步掃**（而唔係
好似本次咁事後 0.55–7.5 小時掃）——咁就係 §10.4 講嘅 enrichment，加 §4.2 嘅
join。

## 12. GitHub 上有冇類似嘅可以運用（2026-10-12 調査）

問：GitHub 有冇好似 CrawlHive 嘅嘢可以直接用？
答：**冇第二個「無 key、無錢包」嘅 hosted signal API**（CrawlHive 嘅
`/api/scan` 仍然係唯一）。但係 GitHub 同免費服務嘅價值在另一個地方 ——
**透明嘅評分算法**，同一個「已經 fetch 緊但冇讀」嘅分。

### 12.1 最重要嘅發現：我哋已經 fetch 緊一個 1–100 風險分，只係冇讀

`src/rugcheck.ts` 每個判斷過嘅幣都會叫
`GET https://api.rugcheck.xyz/v1/tokens/{mint}/report`（**無 key**，我哋自己
`RUGCHECK_REQUEST_INTERVAL_MS=800` 節流），但只讀三個欄位：
`insiderNetworks` → `bundlerPct`、`topHolders` → `top10Pct`、`creator`。

同一個 response 嘅 top-level 仲有：**`score`、`score_normalised`、`risks[]`
（`name`／`level`／`score`）、`lpLockedPct`、`rugged`、`totalHolders`、
`creatorTokens`、`launchpad`、`deployPlatform`**。→ **加落卡／存落 row 係零新增
請求、零新依賴、零新 key**。

#### 喺我哋自己 10 隻推送幣上實測（`/report/summary`，2026-10-12）

| 幣 | 我哋 state | peak× | RC `score`（raw） | RC `score_normalised` | `lpLockedPct` | RC `risks` |
|---|---|---|---|---|---|---|
| MINU | active | 1.04 | 1 | **1** | 98.7% | — |
| STUDIO | weak | 1.24 | 1 | **1** | 100.0% | — |
| GABOX | active | 1.00 | 3129 | **34** | 92.6% | Single holder ownership(warn) |
| OVERDRIVE | dead | 1.54 | 1 | **1** | 84.7% | — |
| Multipad | **rug** | 1.43 | 1647 | **27** | 99.4% | Low Liquidity(danger) |
| CHAOS | **rug** | 1.18 | 618 | **17** | 99.7% | Low Liquidity(warn) |
| WIRED | **rug** | 1.00 | 1649 | **27** | **0.0%** | Low Liquidity(danger) |
| STARTUP | **rug** | 1.00 | 1654 | **27** | 100.0% | Low Liquidity(danger) |
| Gem | **rug** | 1.56 | 574 | **17** | 97.2% | Low Liquidity(warn) |
| Ploy | active | 1.00 | 1 | **1** | 100.0% | — |

**分得開嘅程度遠勝 CrawlHive**（§11.3）：

- `score_normalised ≥ 17` → 6 隻 = **5 隻 rug 全部在內** + GABOX；
- `score_normalised = 1` → 4 隻，**冇一隻是 rug**。
- 即係 rug 標籤上 **recall 5/5、precision 5/6**，而唯一「假陽性」GABOX ——
  CrawlHive 也剛好將它評最低（55 RISKY、池 $0、Concentrated），而它 peak 只有
  1.00（橫盤）。兩個互不相關嘅供應商同時指向同一隻，值得留意。
- 對比：CrawlHive 嘅分給我哋 5 隻 rug 之中 2 隻 90 CLEAN、1 隻 70 OK。

**方向問題（重要）**：`score` 係**原始風險分（非 0–100）**，本次值域
574–3129；`score_normalised` 才係 1–100 那條。方向係 **低 = 安全**（用實證確立：
該研究者 live-fetch 嘅 USDC `score=1`，同本表 4 隻非 rug 全部 = 1，rug 才 17–34）。
**唔好當它同 CrawlHive 嘅「高 = 好」同一個尺度。**

**限制（必須明說）**：本表係 **推送後 3–9 小時** 讀嘅，所以 `Low Liquidity` 風險
有一部分係「爆池已經發生」才見到 —— 證明唔到佢喺**推時**已經分得開。要證明，
就係由今日起喺推時存下 `score_normalised`（一行）再向前測。

### 12.2 可直接叫嘅其他免費 API（實測）

| 服務 | 實測結果 | 有冇 composite score | 值唔值得加 |
|---|---|---|---|
| **GoPlus** `api.gopluslabs.io/api/v1/solana/token_security?contract_addresses={mint}` | **HTTP 200，無 key** | ❌ 只有 flags：`mintable`、`freezable`、`closable`、`balance_mutable_authority`、`non_transferable`、`transfer_fee`、`transfer_hook`、`metadata_mutable`、`default_account_state(_upgradable)`、`creators`、`trusted_token` | ⚠️ 多數同 Jupiter `audit`（已免費在用）重疊；真正新嘅只有 Token-2022 那幾個（`closable`／`transfer_hook`／`non_transferable`／`transfer_fee`） |
| **CrawlHive** `/api/scan`（§10） | HTTP 200，無 key，但 **IP 限速共享** | ✅ 0–100 | ⚠️ 只做「有就加分」嘅 enrichment（§11.4） |
| **SicariusGuard**（GitHub，MIT） hosted `…run.app/v1/check/:mint` | **實測 2026-10-12：`/v1/check` → HTTP 500，`/v1/scan` → HTTP 503（"service … not available yet"）→ 服務當刻唔可用** | ✅ 算法係加權 composite + hard gate（但 hosted API 用唔到） | ❌ 當作 **純源碼** 參考（§12.4），唔好靠佢個 host |

### 12.3 唔可以用嘅（唔好再花時間）

| 服務 | 為什麼唔得 |
|---|---|
| **Mobula** `/api/2/token/security` | **已實測**：demo（無 key）返 **403 `API access is unavailable on the Free plan`**；production 要 key，免費層又唔包這個 endpoint |
| **Moralis** Token Score | 0–100 ✅ 但要 key；文件明寫 **Solana 支援已 deprecated，排 2026-07-31 移除** |
| **Solsniffer** | 文件 URL 404、`api.solsniffer.com` 解析不到；付費 API 仍廣告但無法驗證 |
| **Blockaid** | 無公開嘅 numeric token score endpoint（docs 要登入） |
| **HashDit** | 0–100（低 = 危險）合規格，但要 `X-API-KEY` 而且定價不公開 |
| **Solana Tracker** | 有 `risk.score` 但係 **1–10（高 = 危險）**，要 key |
| **Honeypot.is** | 官方 chain list 無 Solana |

### 12.4 可以**移植**嘅 GitHub 算法（透明權重，適合落 §4 嘅 `score.ts`）

| Repo | ★ | License | 語言 | 權重／門檻 |
|---|---|---|---|---|
| [0xdariel/solana-token-scanner](https://github.com/0xdariel/solana-token-scanner) | 1 | **MIT** | Python | 最簡可抄：mint authority **+30**、freeze **+15**、top1 >50% **+25**／>20% **+10**、top5 >80% **+15**、supply <1000 **+10**，cap 100，**高 = 危** |
| [Chronolapse411/sicarius-guard](https://github.com/Chronolapse411/sicarius-guard) | 2 | **MIT** | TypeScript | **on-chain 45% + LP lock 15% + age 5% + market 22% + reputation 13%**，加 hard gate（on-chain>25、LP≥20、market≥30、reputation≥30 就唔可以叫 SAFE）；verdict 0 SAFE／1–15 CAUTION／16–50 HIGH／51–100 CRITICAL |
| [SoCloseSociety/RugscoreBotTG](https://github.com/SoCloseSociety/RugscoreBotTG) | 1 | **MIT** | Python | 最透明嘅 8 維：contract 20%／liquidity 15%／holders 15%／dev wallet 15%／volume 10%／social 10%／smart money 10%／metadata 5% |
| [Laminar-Bot/solana-token-guard](https://github.com/Laminar-Bot/solana-token-guard) | 0 | **MIT** | Go | 三套**門檻 preset**（Strict/Normal/Relaxed）：LP ≥50/20/5 SOL、top10 <30/50/70%、top1 <10/20/30% |
| [degenfrends/solana-rugchecker](https://github.com/degenfrends/solana-rugchecker) | **78** | **冇 license** | TypeScript | `rugScore()`：mintable +80、freezable +65、mutable metadata +50、top-holder 20/35/50% +50/60/80、liquidity unlocked +80，per-holder 可疊加，≥80 = `isRug()`。**冇 license → 只可以參考，唔可以抄**（亦係 2024 年舊碼） |
| [Keya-Moradi/Cryptopunk](https://github.com/Keya-Moradi/Cryptopunk)（pump radar） | 0 | **冇 license** | TypeScript | 0–100 風險：mint auth 35、freeze 25、集中度 ≤30、冇 metadata 5 |

### 12.5 類似 CrawlHive 嘅 signal 系統（GitHub）

| Repo | ★ | License | 有冇可用 API |
|---|---|---|---|
| [h100envy/crawl-hive](https://github.com/h100envy/crawl-hive) | 50 | MIT | ✅ 唯一無 key 嘅 `/api/scan`（§10） |
| [dynamolabs/oracle-alpha](https://github.com/dynamolabs/oracle-alpha) | 0 | MIT | REST + WebSocket 但**要 key**；README 自認 demo mode 會生假 signal |
| [drixindustries/Rug-Killer-On-Solana](https://github.com/drixindustries/Rug-Killer-On-Solana) | 3 | MIT | 自架 `POST /api/analyze`（52+ 風險指標）；hosted 層 **$99/月** |
| [MbotixTech/meme-coins-signal](https://github.com/MbotixTech/meme-coins-signal) | 2 | MIT | ❌ 只推 Telegram；純門檻篩 |
| [gv211432/memecoin-data](https://github.com/gv211432/memecoin-data) | 2 | MIT | 自架 REST，基本用唔使認證；但佢係**聚合 enrichment**，唔係 signal |
| [TheSenseAI/SenseAI](https://github.com/TheSenseAI/SenseAI) | 19 | 冇 license | ❌ 宣稱有 `GET /analyze?mint=`，但**已 2025-01 停更、無法驗證** |

### 12.6 結論（對本 bot 嘅行動次序）

1. **先讀自己已有嘅分**：`rugcheck.ts` 加存 `score_normalised` + `risks[]` +
   `lpLockedPct` + `rugged`（零請求、零 key、單一 provider 無共享限速）。
   10 幣樣本上它比分 CrawlHive 更分得開 rug（§12.1），而且它係**上游已提供**
   嘅合規分，唔使自己發明權重。
2. **權重想自己話事**：抄 MIT 嘅 `0xdariel`（最簡）或 `sicarius-guard` 嘅
   `src/core/scoring.ts`（TS 加權 + hard gate）—— 注意後者只抄**源碼**，
   佢個 hosted API 實測已 500/503（§12.2）；再加本 repo 自己量到嘅閘
   （`liq/mcap`、`isSus`、`dev %`）做校準。
3. **CrawlHive** 只做「有就寫一行、冇就唔寫」嘅第三方 enrichment（§10.4），
   因為限速係共享嘅。
4. **GoPlus 可選**：免費無 key，但 90% 同 Jupiter `audit` 重疊；要加就只取
   Token-2022 那幾個 flag。
5. **Mobula／Moralis／Solsniffer／Blockaid／Solana Tracker 唔使試**（§12.3）。

### 12.7 幣齡只有 80 分鐘嘅幣，有冇完整分析？（2026-10-13 07:19–07:35Z 實測）

**答案：結構上完整。** 5 分鐘幣、80 分鐘幣、3.7 日幣返回**完全相同嘅 36 個 top-level key**
（`/report/summary` 亦一律 6 個 key：`tokenProgram`、`tokenType`、`risks`、`score`、
`score_normalised`、`lpLockedPct`），冇 404、冇部分回應、冇「等一陣先有」。
但「完整」要分開兩層講：**欄位齊 ≠ 每個維度都有結論**。

**方法**：37 隻 pump.fun／pumpswap 幣（DexScreener `token-profiles/latest` + RugCheck
`/v1/stats/recent`），逐隻攞 `/report` + `/report/summary`。**幣齡用 report 自己嘅
`detectedAt`**，唔用 DexScreener `pairCreatedAt` —— 後者係**池**建立時間，會比 mint 遲：
我最初以為「3 分鐘」嗰隻幣，用 `detectedAt` 計其實已經 53 分鐘。

80 分鐘幣（60–120m 桶，n=10）逐個維度：

| 維度 | 80 分鐘幣有冇 |
|---|---|
| 36 個 top-level key | **10/10** |
| `score` + `score_normalised` | **10/10** |
| `risks[]`（欄位在；10 隻中 2 隻有 ≥1 條風險） | **10/10** |
| `topHolders`（各 20 筆） + `totalHolders` | **10/10** |
| `markets` + `totalMarketLiquidity` + `price` | **10/10** |
| `mintAuthority`／`freezeAuthority`（已 revoke → `null`） | **10/10** |
| `creator` + `creatorBalance` + `tokenMeta` + `launchpad` | **10/10** |
| `lpLockedPct`（summary） | **10/10** |
| `token_extensions`（Token-2022） | **10/10** |
| `insiderNetworks` | **4/10**（其餘 `null`） |
| `creatorTokens`（＝creator 歷史） | **0/10** |
| `lockers`／`lockerScanStatus` | **0/10**（全部 `{}` / `"none"`） |
| `events`｜`verification`｜`totalLPProviders`｜`tokenType` | **0/10**（全空／`null`／`0`／`""`） |

**pop 得最遲嗰個維度唔係「等幣齡」**：`creatorTokens` 全樣本 37 隻只有 1 隻（153 分鐘）有，
而且係連住一條 `Creator history of rugged tokens`（`danger`，`score` 110400 → `norm` 80，本樣本最高危）。
但**同一個 creator**（`FdSShBiR1nBtxQzhwNMszyRdcvMVLiAeVraJLvERERZL`）嘅 4 隻**更舊**幣
（930／1684／1691／2310 分鐘）全部都係 `creatorTokens: null`、`risks: []`。
→ **唔係「幣夠老就有 creator 歷史分」**，而係逐隻幣嘅可用性問題（重複 fetch 結果穩定，所以
亦唔係「第一次問會觸發分析、之後就有」）。**80 分鐘幣基本上拿唔到 creator-history 維度。**

**report 每次都即時重算**（同一隻幣隔 15 秒再 fetch）：`price` 0.00003006→0.00002498、
`totalHolders` 618→616、`totalMarketLiquidity` 14721.5→12309.8、`topHolders[0].pct`
26.65→29.11 全部變；只有 `detectedAt`（＝首次見到嘅時間，唔係分析時間）同 `score` 唔變。
→ 80 分鐘幣讀到嘅數係**當前值**，唔係開幣時嘅 stale snapshot。

**順帶一個同本 repo 註釋打架嘅觀察**：37 隻裡 `insiderNetworks === null` ⟺
`graphInsidersDetected === 0`（19 隻 null 全部 graph=0；18 隻 array 全部 graph>0），
而 9.8 分鐘幣已經有 `arr[1]`。即 `null` 更似「**冇偵測到 insider network**」而非
「**RugCheck 未有答案**」—— 同 `src/rugcheck.ts` 現行註釋（引 2026-09-28 QNT 個案）
嘅解讀相反。**未有官方文件佐證，所以呢點只記低、唔改 code。**

**限制**：全部係 pump.fun／pumpswap／Token-2022 幣；樣本係「DexScreener 最新 profile」
（本身偏向已經有人 boost 嘅幣），所以可能**高估**咗新幣嘅分析完整度。Raydium 老幣只測到 1 隻。
`risks[]` 空唔等於「乾淨」，可能係「未觸發到某條規則」——本樣本 8/10 隻 80 分鐘幣 `risks: []`。
