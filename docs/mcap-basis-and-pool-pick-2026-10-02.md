# 假 💀（現價細一半）：一條行嘅 series 撈咗兩種估值基準 + 一個池嘅位

> 事故（2026-10-02 20:11 HKT，Agency）：Telegram 收到
> `💀 走死 Agency | 峰值 $3.34M → 現 $1.53M (-54%)，轉入靜默監控（收復 $2.3M＝低點 ×1.5 會再通知）`，
> 但同一分鐘營運者喺 DexScreener 睇係 **$3.04M**。20:07 嗰張 🚀 卡（峰值 $3.34M）係對嘅。

---

## 1. 量度（唔係「一時讀數跳」）

**行本身**（`/debug/push-watch`，Agency `7VertkgF9KLhxxJXHX6uaWuoYZTP9LdGj2bWmVXVpump`）：

| 欄 | 值 | 對照 |
|---|---|---|
| `mcapAtPush` | 972,862 | 推送時（10:40 HKT）主池價 ✓ |
| `peakMcap` | 3,338,584.42 | 20:07 主池 12:06–12:07 高 3.23–3.46M ✓ |
| 💀 卡讀數 | 1,530,000 (±0.5%) | **主池 12:11:00 係 0.003166 → $3.06M**（user 睇 $3.04M）—— 即 **0.50×** |
| `deadTroughMcap` | 601,816.84 | 主池 10:00–12:35 最低 0.001287（$1.29M）—— 即 **0.20×** |
| 12:21:57 讀數 | 2,985,414.65 | 主池 12:20 0.003088 → 2,983,700（差 0.06%）✓ |
| `upStages` | `base:972862,p:dead:29849051,up100,up200,up50` | `p:dead` = 12:11:00 嘅 cut 標記；卡本身 12:11:58 已送達（audit 8441） |

**同一隻幣嘅池**（DexScreener 單一地址 endpoint，12:00–13:00 HKT 反覆量度）：

| 池 | mcap | LP | 備註 |
|---|---|---|---|
| pumpswap（主池） | 2.83M–3.57M | 198K–222K | 用戶睇到嘅數 |
| meteora ×2 | 2.9M–3.4M | 90K–180K | 正常 |
| meteora | 2,284,414 | 9,958 | 薄池，11:55 後冇成交（價凍結） |
| meteora | **3,058** | **85,154** | **同一個幣，mcap 細 1000 倍** |
| meteor / raydium | 2.80M / 2.25M | 2.93 / 0 | 乾池 |
| pumpfun（curve 殘留） | 48,561.93 | null | 價凍結 |

⇒ 同一個 mint，**同一個 response 內 mcap 由 $48K 到 $3.3M（68 倍）**，而且其中有明顯壞數
（$85K LP 報 $3,058）。當日 12:00–12:25 DexScreener 429 風暴（`/debug/dex429`：一小時 22 宗），
所以三條腿（DexScreener → Jupiter → Gecko）輪流供數 —— 行嘅歷史亦對得上：讀數小數位有
16 位 float（Jupiter 樣）、8 位（Gecko 樣）、整數（DexScreener 樣）混住。

## 2. 根因（兩處，兩處都係「一條 series 撈兩種尺」）

**(a) Gecko 腿嘅市值基準唔同其他人。** `parseTokenSnapshot` 係
`fdvUsd = market_cap_usd ?? fdv_usd`，而 `market_cap_usd` 係 CoinGecko 嘅**流通市值**；
另外兩條腿同整條歷史都係 FDV／總供應基準（DexScreener `marketCap` == `fdv`；
Jupiter `mcap` == `fdv`）。Gecko 腿一被叫中，就會將一個 **~2 倍細嘅估值**放入同一條 series，
tracker 嘅峰值／回撤數學當佢係真跌 → 假 💀。實測同一批行：`row/gecko-fdv` 多數 0.90–1.17，
但 COMMIE 一條 **0.52**（即該行嘅 series 當時正踩住一個 2 倍基準）。
事故讀數 1.53M = 主池 3.06M × **0.50** 正好係呢個形狀。

**(b) pair 選擇靠 DexScreener 嘅陣列位置。** `fetchPairsForTokens` 舊規則係
「第一個 pair wins」，而同一隻幣可以返 8 個池、mcap 相差 68 倍（上表）。位置唔係市場性質：
新池／凍結池／壞比例池一旦排第一，tracker 嘅峰值、回撤、💀、復活目標同掃描閘門全部
都會讀佢（`docs/push-baseline-ledger.md` 2026-09-19 曾量度 11 隻幣「第一個 = 最深」，
但 2026-10-02 同一隻 Agency 就出現 $85K LP 報 $3,058 嘅池）。

## 3. 修正（已落地）

| 位置 | 變更 |
|---|---|
| `src/scanner.ts`（gecko 腿） | `marketCap: snap.fdvOnlyUsd ?? snap.fdvUsd ?? 0` —— 只有 FDV 基準入 series；`mcapFromFdv` 一齊記錄（來源真係 FDV 頂市值） |
| `src/dexscreener.ts` | pair 選擇改為 **最深池 wins**（`pairDepth`：`liquidity.usd`，null → −1）。真讀數（包括乾池嘅 $0，因為佢係 💧 規則嘅證據）永遠贏「冇 liquidity 欄」嘅 pair；同深度保留第一個（穩定）。cache 亦改為只寫入贏家 |
| `scripts/test-unit.js` | ① `fetchPairsForTokens: the deepest pool represents a token, not its list position`（離市池排第一、$0 乾池 vs null、同深度、cache 寫贏家）；② provenance 測試加 gecko 基準 pin（`marketCap:snap.fdvOnlyUsd??…` 存在、`snap.fdvUsd??0` 唔存在） |

## 4. 驗收

- `npm run typecheck` ✅；`npm run build` ✅；`node scripts/test-unit.js` → **477 passed / 0 failed**。
- 線上驗收方向：
  1. 之後嘅 💀／🚀 卡「現價」應該同 DexScreener 主池（即用戶睇到嗰個）一致；
  2. `/debug/push-watch` 各行 `lastMcap` 應該同「最深池」嘅 mcap 對得上，唔會再跳去 2–5 倍外嘅池；
  3. Gecko 腿供數嗰個 tick，`lastMcap` 唔應該再係 DexScreener 值嘅一半。

## 5. 要老實講（未做／做唔到）

1. **1.53M 嘅來源冇得 100% 回溯**：事故當時嘅 pair 陣列同各腿即時值冇留底（
   `push_watch` 只存一格 `last_mcap`），所以(a)(b) 兩處係「量到嘅洞」而非「捉到嘅兇手」。
   兩處都修咗：即使當日係另一條路（新池／凍結池排第一）入嘅，最深池規則亦會擋住。
2. **Agency 行本身嘅數已經污染**：`peakMcap` 3,876,009.55、`deadTroughMcap` 601,816.84
   仍然寫住喺 DB（row 而家 `up200`，trough 唔再參與判斷）。冇自動改寫 —— 呢個行嘅
   峰值可能係一次真 spike（12:23 meteora 池 3.805M），冇證據之前唔應該改。
   `p:dead:29849051` cut 標記亦係無害（已證送達，唔會再發同一張卡）。
3. **殘餘風險**：`fetchPairsForTokens` 只拿到「每個 token 一個 pair」，所以 tracker 冇得
   知道自己行開嗰個池係咪仲喺 response 入面 —— 即係「行唔會跟住換池」呢件事未做。
   要再硬淨啲，就要喺 `push_watch` 加 `pool_address`（pin 池），換池嗰 pass 唔判斷。
   **已做（2026-10-02，同日）**：政策 = 偵測到換池嗰 pass 唔判 → re-pin 新池 →
   下一 pass 用新池續判（跳一 pass）。實作見 `docs/pool-pin-2026-10-02.md`。
