# 假 💧「流動性枯竭」：三條 feed 腿用緊三把唔同嘅尺

> 事故（2026-09-20 20:16 HKT）：Telegram 收到
> `💧 流動性枯竭 Lobby | LP 僅剩 $7.95K（< $10K），市值數據已失真（LP 被抽乾），停止追蹤`，
> 但同一時間喺 DexScreener 睇該池係 **$17.5K**（用戶自己睇係 ~$21K）。
> 卡片係**假警報**，而且佢把一個健康嘅幣標成 terminal（`lastState = rug`，跟進從此靜音）。

---

## 1. 量度：唔係「一時讀數跳」，係系統性 2 倍差

即時對照 tracker 每行嘅 `lastLiquidity`（`/debug/push-watch`）同兩個上游嘅當前值
（`/latest/dex/tokens/{mint}` 第一個 pair、`lite-api.jup.ag/tokens/v2/search?query={mint}`）：

| 幣 | tracker 記住 | DexScreener | Jupiter | 記住／DS | 記住／JUP |
|---|---|---|---|---|---|
| Lobby（事故幣） | **7,950** | 17,446 | 7,793 | **0.46** | **1.02** |
| SI | 13,305 | 26,568 | 13,372 | 0.50 | 0.99 |
| SWOGE | 10,450 | 21,468 | 10,624 | 0.49 | 0.98 |
| Tokens | 15,106 | 31,130 | 15,153 | 0.49 | 1.00 |
| ROBUX | 15,132 | 29,984 | 15,004 | 0.50 | 1.01 |
| CHUD | 11,704 | 23,464 | 11,726 | 0.50 | 1.00 |
| ANONYMOUS | 15,822 | 31,065 | 15,814 | 0.51 | 1.00 |
| PIKAMOON | 13,434 | 26,872 | 13,413 | 0.50 | 1.00 |
| DONATED | 29,327 | 55,212 | 28,579 | 0.53 | 1.03 |
| PONDER | 19,641 | 34,024 | 19,285 | 0.58 | 1.02 |
| PUMPCAT | 21,436 | 21,424 | 9,831 | **1.00** | 2.18 |
| STACK | 21,057 | 21,057 | 10,701 | **1.00** | 1.97 |
| INU | 31,909 | 32,591 | 15,454 | **0.98** | 2.06 |
| Pigeon | 18,951 | 17,833 | 8,026 | **1.06** | 2.36 |

- **10 / 14** 行嘅記錄值 = Jupiter 嘅數（誤差 ≤ 2%），同時係 DexScreener 嘅 **0.46–0.58 倍**。
- 另外 4 行 = DexScreener 嘅數（1.00）。
- 即係話 tracker 每次拿到邊條腿，就決定咗個數係「正常」定「細一半」——**唔係市場波動，係換咗把尺**。

Lobby 自己嘅 5 分鐘序列亦吻合 Jupiter：12:14（寫入 7,950）→ 12:34（7,578，`liquidityChange5m -13.8%`），
而 DexScreener 同期係 19,288 → 18,125 → 17,446（單向緩降）。所以 7,950 **冇可能**係 DexScreener 讀數。

（查證方法：`/debug/push-watch` 嘅 `lastChecked` 顯示 Lobby 喺 12:14:45Z 被 check 過，
即寫入時間就係出卡前後；卡片文字同卡內數字同 code path 完全對得上。）

---

## 2. 根因：USD 級規則撞到跨源比較

`PushWatcher` 嘅 pair 由三條腿依次補：`Scanner.lastPairs`（掃描嘅 pair 快取）→ DexScreener 即時 →
**Jupiter**（`jupfeeds.ts`）→ **GeckoTerminal**（`scanner.ts` 嘅 gecko 腿）。
三條腿 `liquidity` 各用各嘅定義：

| 腿 | 欄位 | 意思 |
|---|---|---|
| DexScreener | `liquidity.usd` | **池嘅總 USD 儲備**（規則嘅校準基準） |
| Jupiter | `liquidity` | Jupiter 自己嘅演算法，同一個池約為一半 |
| GeckoTerminal | `total_reserve_in_usd` | 只加佢索引到嘅池，同樣偏低 |

而 `pushwatch.ts` 兩條流動性規則都係「絕對 USD」語意：

1. `LIQ_FLOOR_USD = 10_000`：`live.liquidity < 10_000` → 💧 枯竭 + `stopTracking`（**terminal**）。
2. `LIQ_CRASH_RATIO = 0.45`：`live < row.lastLiquidity × 0.45` → 💧 驟降。

一條健康、DexScreener 讀 17–21K 嘅池，經 Jupiter 腿就會讀成 8–10K → 觸發第 1 條。
第 2 條更麻煩：佢係**兩次讀數相減**，跨腿比較等於無中生有咁造出 −50% 跌幅
（實測：儲 26,000（DexScreener）＋即時 11,000（Jupiter）→ 「−58% 驟降」）。

⚠️ 同日第二個後果（要知）：**推播閘門都係食跨源數字** ——
`scanner.ts` 嘅 `liquidityUsd = pair.liquidity.usd ?? 0` 直接餵 `chat.minLiquidityUsd`
同 `mcapRatioBlockReason`。Jupiter 腿嗰個 tick，閘門等於嚴格咗一倍
（市值／流動性比亦大一倍）。因為量化寬鬆係 per-tick，幣仍然留喺 re-eval pool 每 tick 再評，
所以主要係**延遲**而唔係永久漏推；但如果一個幣只喺窗口內被 Jupiter 腿讀到，就會延到窗口完。
呢個未改（見第 5 節）。

---

## 3. 修正（已落地喺工作樹）

**來源標記**：`PairInfo.feedSource?: "dexscreener" | "jupiter" | "gecko"`，三條腿各自實作
（`dexscreener.ts`、`jupfeeds.ts`、`scanner.ts` 的 gecko 腿）。缺席（舊 fixture／合成 pair）＝ DexScreener。

**唯一入口**：`pushwatch.ts` 新增並 export 純函數

```ts
export function comparableLiquidity(pair: {
  liquidity: { usd: number | null };
  feedSource?: "dexscreener" | "jupiter" | "gecko";
}): number | null {
  if (pair.feedSource !== undefined && pair.feedSource !== "dexscreener") return null;
  return pair.liquidity.usd;
}
```

tracker 只將 `comparableLiquidity(pair)` 交畀規則（非 DexScreener → `null`），並且：

- `evaluateWatch({ liquidity: comparableLiquidity(pair) })` → 兩條流動性規則自動變「資料不明，唔判斷」
  （同推播閘門「missing data never judges」同一套紀律）。
- 寫返 DB 時 `lastLiquidity: comparableLiquidity(pair) ?? row.lastLiquidity`
  （兩個寫入點：reserve 失敗回滾分支、主寫入）→ **唔會用一把唔可比嘅尺覆蓋基準**。
- heal 播種 `liquidityUsd: comparableLiquidity(pair)`。

**代價（講清楚）**：DexScreener 被 429／封鎖嗰個 tick，該行唔會判斷流動性
（其他規則照跑）。真 rug 會喺下一個 DexScreener 來源嘅 check 抓到 —— rotation 每行幾分鐘內被再 check
一次 —— 代價係「遲一個 tick」，而唔係「用差 2 倍嘅證據判死」。

**唔喺窗口內嘅部分**：`pushwatch.ts` 深處（~1,300／1,486／1,557／1,661 行）同 `scanner.ts` gecko 腿
（~1,746 行）超出平台檔案編輯窗口，所以以真 unified diff 落地：
`docs/patches/liq-source-guard.patch`（`git apply`，已 apply 且 `git apply --check` 通過）。

---

## 4. 驗收

- `npm run test:unit` → **222 passed / 0 failed**，新增三個測試：
  - `comparableLiquidity: only DexScreener's metric may face a USD-level rule`
  - `push-watch: a Jupiter-sourced reading can neither rug nor crash a live coin`
    （釘死「原始數字 = 出卡」而「guard 後 = 無卡」；同一數字但 `feedSource: "dexscreener"` 仍然 rug，
    證明規則本身冇被削弱）
  - `out-of-window patch: liquidity provenance is guarded`（5 個 pushwatch marker + 3 條腿嘅
    `feedSource` 標記，半貼即紅 —— 同 `write-drain-waituntil.patch` 同一套 drift guard）
- `npm run typecheck` ✅、`npm test`（整合掃描）✅。
- deploy 後線上驗收：`/debug/push-watch` 嘅 `lastLiquidity` **唔應該再係 DexScreener 值嘅一半**；
  對照 `lite-api.jup.ag` 應該見到兩者分離（舊行會保留一半值直到下一個 DexScreener check 覆蓋佢）；
  並且**唔應該再收到「LP 僅剩 $X（X < $10K）」但實際池有兩倍以上嘅卡**。

---

## 5. 仲有嘅事（未做，等指示）

1. **推播閘門**（`scanner.ts` `liquidityUsd`）仍然食跨源數字 → `minLiquidityUsd` 同
   `mcapLiqRatioMax` 喺 Jupiter 腿 tick 嚴格一倍（延遲風險，見第 2 節）。
2. **該行嘅狀態被回滾**：Lobby 出卡後 DB 係 `lastState = null`、`lastAlertAt = 0`
   （`/debug/push-audit` 亦**冇**該次 follow-up 記錄）＝ 送卡時 `bounded()` 超時，
   走咗 rollback 路徑（at-least-once 設計：有機會重發），即係卡片聲稱「停止追蹤」但實際仲 active、
   而且 cooldown 未武裝。呢個係另一個（既有）題目，唔係今次跨源 bug。
3. **Gecko 腿**同理已標記為 `gecko`；如果將來想用佢判流動性，要先有 Gecko↔DexScreener 嘅校準。
