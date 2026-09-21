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

**後續（2026-09-20，同一修正嘅第二半 —— 推播閘門）**：`scanner.ts` `matchCoins` 都係食緊跨源數字，
`const liquidityUsd = pair.liquidity.usd ?? 0` 直接餵 `minLiquidityUsd` 同 `mcapLiqRatioMax`，
即係 Jupiter 腿 tick 嚴格一倍。兩條規則而家讀 `gateLiquidityUsd(pair)`：

- 可比腿（DexScreener／未標記）→ 照舊判斷：**真正嘅 0 同「可比腿冇讀數」都仍然當 $0 池深**，
  乾池唔會因此放過。
- 唔可比腿（Jupiter／Gecko）→ `null` = **唔判斷**（fail-open，同其他閘門「missing data never judges」
  一致）。幣留喺 re-eval pool，下一個 DexScreener 腿嘅 tick 照常判 → 代價係「遲一個 tick」，唔係誤判。

「兩條腿唔可比」同「可比腿冇讀數」嘅分別用新導出嘅 `liquidityIsComparable(pair)` 判
（`comparableLiquidity` 亦都改用佢），唔會喺兩處各自重寫一次規則。

同樣超出窗口，落地為 `docs/patches/liq-gate-source-guard.patch`（`git apply`，已 apply）。

---

## 4. 驗收

- `npm run test:unit` → **223 passed / 0 failed**，新增四個測試：
  - `comparableLiquidity: only DexScreener's metric may face a USD-level rule`
  - `push-watch: a Jupiter-sourced reading can neither rug nor crash a live coin`
    （釘死「原始數字 = 出卡」而「guard 後 = 無卡」；同一數字但 `feedSource: "dexscreener"` 仍然 rug，
    證明規則本身冇被削弱）
  - `gateLiquidityUsd: the push gate's two USD rules judge one leg only`
    （釘死「Jupiter 腿入唔到 floor／ratio」而「同一個數由 DexScreener 嚟就係真抽乾」——
    同 tracker 測試同一套對照法）
  - `out-of-window patch: liquidity provenance is guarded`（6 個 pushwatch marker + 3 條腿嘅
    `feedSource` 標記 + 5 個 scanner 閘門 marker，半貼即紅 —— 同 `write-drain-waituntil.patch`
    同一套 drift guard）
- `npm run typecheck` ✅、`npm test`（整合掃描）✅。
- deploy 後線上驗收：`/debug/push-watch` 嘅 `lastLiquidity` **唔應該再係 DexScreener 值嘅一半**；
  對照 `lite-api.jup.ag` 應該見到兩者分離（舊行會保留一半值直到下一個 DexScreener check 覆蓋佢）；
  並且**唔應該再收到「LP 僅剩 $X（X < $10K）」但實際池有兩倍以上嘅卡**。

---

## 5. 仲有嘅事（三項都已修，2026-09-20）

1. ~~**推播閘門**（`scanner.ts` `liquidityUsd`）仍然食跨源數字 → `minLiquidityUsd` 同
   `mcapLiqRatioMax` 喺 Jupiter 腿 tick 嚴格一倍（延遲風險，見第 2 節）。~~
   **✅ 已修（2026-09-20）**：兩條規則改讀 `gateLiquidityUsd(pair)`，唔可比腿 = 唔判斷；
   見第 3 節後續同 `docs/patches/liq-gate-source-guard.patch`。
2. ~~**`token_stats.max_liquidity_observed` 嘅寫入**（`raises`，~2,600 行）仍然係
   `pair.liquidity?.usd ?? 0`~~ **✅ 已修（2026-09-20）**：同一個源、另一個閘門。
   呢條欄餵 re-eval pool 嘅 `minQualifyLiquidity` prune（0.6× 最闊 chat 嘅 `minLiquidityUsd`，
   DexScreener 校準）而且係 **raise-only**，所以 Jupiter 嘅半價讀數唔會被之後嘅可比讀數修正 ——
   佢只會令該幣嘅 lifetime 高水位偏低，令一隻仍然活嘅幣被剔出 pool（**永久漏推**，
   比閘門嘅「遲一個 tick」貴）。修法同閘門一致：
   `const liquidity = liquidityIsComparable(pair) ? (pair.liquidity?.usd ?? 0) : undefined` ——
   唔可比腿 ⇒ `liquidityUsd` 整個 omit（`updateTokenMaxMcaps` 對 `undefined` 會將條
   liquidity CASE 完全略過），下一個 DexScreener 腿嘅 sweep 照樣記錄；可比腿嘅 0 仍然落地
   （乾池嘅 $0 LP 本身就係訊號）。
3. ~~**該行嘅狀態被回滾**~~ **✅ 已修（2026-09-20）**：Lobby 出卡後 DB 係 `lastState = null`、
   `lastAlertAt = 0`（`/debug/push-audit` 亦**冇**該次 follow-up 記錄）＝ 送卡時 `bounded()`
   超時，走咗 rollback 路徑，即係卡片聲稱「停止追蹤」但實際仲 active、cooldown 未武裝。
   終態卡（💧 抽乾卡 —— `evaluateWatch` 只有呢個 branch 會 `stopTracking`，而且佢只回一張卡）
   而家跟**首卡**嗰套 abandoned 政策（`cardSendDisposition`，同一個純函數）：
   - **sent** → 照舊 audit + 計數。
   - **failed**（Telegram 真係拒收，例如 400）→ 事實，唔係「未知」：照舊 rollback，下一 tick 重發。
   - **abandoned**（超時，請求可能仲在途）→ **保留**終態轉換（`last_state = 'rug'` +
     `last_alert_at` 武裝）＋ 用 call 自己嘅 ring 寫一條 durable 記錄
     （`UNCONFIRMED_TERMINAL_STATE_KEY`，同首卡嘅 ring **分開**：兩者嘅「release」係兩件
     唔同嘅事 —— 首卡係 unclaim seen_tokens 令 scan 重推，終態卡係 re-arm 該行令下一次 check
     重發同一張卡）。該請求若然後來成功，背景鏈會補寫 `followup` audit 並清走記錄。
   - pass 開頭 settle 一次（有記錄 pending 或者 isolate 第一次 pass 才讀，所以正常 tick 唔會
     多一個 round trip）：有 audit 證明 → 掉記錄；過咗 `UNCONFIRMED_CARD_GRACE_MS`（120s）
     仍未證實 → `rearmPushWatchAlert` 將該行（**只限** `last_state = 'rug'`）改回 ACTIVE、
     清 `last_alert_at`、`last_checked = 0` → 下一次 check 重新推同一張卡。
     即係「冇漏卡」，但延遲一個 grace 而唔係立即重發一張仲在途嘅卡（後者就係用戶見到嘅重複）。
   順序上 re-arm 先、縮短 ring 後：萬一中途死，只會再 re-arm 一次已經 active 嘅行（被
   `last_state = 'rug'` 守衛擋成 no-op），唔會反過來掉低一張從來冇證實嘅卡。
   兩件都超出檔案編輯窗口，落地為 `docs/patches/terminal-send-and-liq-prune.patch`（`git apply`，已 apply）。
4. **Gecko 腿**同理已標記為 `gecko`；如果將來想用佢判流動性，要先有 Gecko↔DexScreener 嘅校準。

### 驗收（2026-09-20，第二輪）

- `npm run test:unit` → **228 passed / 0 failed**，新增五個測試：
  - `deliveredFollowupTokens: only the tracker's own follow-up entry proves a tracker card`
    （同時釘死「首卡嘅證明唔可以借去問終態卡」，兩個 whitelist。）
  - `PushWatcher: an ABANDONED terminal card KEEPS the transition and records the unknown delivery`
    （釘死送卡超時**唔會** rollback：`lastState = 'rug'`、`lastAlertAt > 0`、`undelivered = 0`、
    ring 有一條該幣記錄、note 有 `abandoned 1`。）
  - `PushWatcher: a REJECTED terminal card still rolls back (a fact, not an absence)`
    （拒絕 ≠ 未知：照樣 `undelivered 1`、`lastState = null`、ring 冇記錄。）
  - `PushWatcher settle: an unproven terminal card re-arms the row after the grace (proof does not)`
    （三態：(a) 過 grace 無證明 → re-arm ＋ 掉記錄 ＋ note `rearmed 1`；(b) 有 `followup` 證明 →
    唔 re-arm；(c) 仍在 grace 內 → 兩樣都唔做。）
  - `out-of-window patch: the terminal card's three-state send is all in`（半貼即紅嘅 drift guard，
    連同上面 `liquidity provenance` 嗰條加咗 prune 寫入嘅兩個 marker。）
- `npm run typecheck` ✅、`npm run build` ✅。
- 線上驗收（deploy 後）：下次再見到 💧 卡而 `/debug/push-watch` 嘅 `lastState` 係空，即係呢個修
  未生效；預期係卡片同 DB 一致（`rug` + cooldown 武裝），而且 **唔會**再出現「同一張停止追蹤卡
  隔幾分鐘再出一次」。

## 6. 終態行嘅一致性（fix 前留低嘅唔一致 row，2026-09-20）

💧 抽乾係 tracker **唯一**會消費一張卡去換返嚟嘅終態，所以 `push_watch` 用兩欄記低佢，而兩欄係
同一個 pass 裡**唔同時間**寫：

- `last_alert_at` ← `reservePushWatchAlert` 寫入 pass 嘅 `now`；
- `last_checked` ← `claimPushWatch` 寫同一個 `now`，之後**完成寫入**（`Db.updatePushWatchCheck`）
  用一個**新鮮** `Date.now()` 再覆一次 —— 即係喺張卡送出之後。

所以一行健康嘅終態行必定係 `0 < last_checked − last_alert_at`，而個差額就係 reserve 之後行嘅那
段時間（送卡）。三個可從行本身直接證明嘅唔一致形狀：

| 形狀 | 意思 |
|---|---|
| `last_alert_at === last_checked` | 完成寫入冇落地（isolate 喺 reserve 同 flush 之間死；即 dead-tick 形）。行凍結喺 claim+reserve：量度值係上一個 pass 嘅、卡片有冇到係未知。**正常**行冇可能 0 差，因為完成寫入個 stamp 係送卡之後讀嘅鐘。 |
| `last_alert_at === 0`（或者落後到超出一個 pass 預算） | 個轉換背後從來冇武裝過一張卡：舊嘅單欄寫入（`setPushWatchState` 只碰 `last_state`）寫低咗 💧 語意但冇記低佢。卡片可能從來冇送出，而行就永久靜音。 |
| `last_liquidity >= LIQ_FLOOR_USD` | 判斷只可能由**低於地板**嘅讀數產生（`evaluateWatch` 嘅流動性分支），所以一筆高於地板嘅存量數值支撐唔到佢自己嗰個狀態 —— 就係「用錯腿」或者「完成寫入唔見咗」嘅指紋。 |

規則同修理都係純函數：`pushwatch.terminalRowIssues(row)` 診斷，`pushwatch.terminalRowRepair(issues, provedDelivered)`
決定動作 —— 同 tracker 自己 settle 一張被切嘅終態卡用完全同一套政策（audit 就係證明）：

- **有 audit 證明** → 卡片已經喺 chat，只係簿記未動 → 保留轉換、`armTerminalAlertClock`
  （同 re-arm 唔同，行照樣終態；而且係 inert —— `rug` 行永遠唔會被再評估，見 runTick 嘅
  `activeRows` filter）；
- **冇證明** → 卡片可能真係唔見咗 → `rearmPushWatchAlert` 令下一個 pass 重新推導同一個判斷，
  而行唔會就咁靜音落去；
- 另外兩類（lost write / 量度同狀態矛盾）**只報告、唔改寫**：前者嘅轉換係一個真嘅 reserve 寫落嘅，
  後者只係一個過時數字，唔係一個錯判斷。

落地：`docs/patches/terminal-row-hygiene.patch`（pushwatch 規則 + `Db.armTerminalAlertClock` +
`/debug/push-watch` 嘅 `?limit=` census 同 `POST ?repair=<mint>`，三個檔案一齊 apply）。
`/debug/push-watch?limit=N`（上限 500）順便修好 audit 上嘅盲點：原本硬性 40 行，而行係可以活過
24 小時窗口（prune 同 enrollment self-heal 打對台），即係普查嗰陣正好可能睇唔到要睇嘅行。

### 量度（2026-09-21 普查前，線上 40 行）

9 行 `rug`：8 行嘅時鐘差係 1.2–2.1s（正常 —— 就是送卡用嘅時間），唯一例外係 **Bogdanoff**
（差 `0.000s`、存量 `last_liquidity = 12,420` ≥ 地板）。即係 dead-tick 嘅完成寫入冇落地，行
凍結喺 claim+reserve。fix 前嘅「rug 但時鐘未武裝」嗰類（Bruce）已經隨 24 小時窗口被 prune 走，
普查亦冇發現新嘅一行。

**誠實 caveat**：delivery audit ring 只裝 30 條、跨度約 6 小時（09-20 17:46→23:59），所以一條 13–23
小時前嘅舊終態行一律讀成「冇證明」—— 對舊行而言「未證實」係**缺席嘅證明**，唔係證明咗冇送。
照 at-least-once 嘅原則行（寧願重複都唔可以唔見卡），但代價係有機會重發一張其實已經到咗嘅卡。

### 清理（2026-09-21 00:28–00:48Z，線上）

`/debug/push-watch?limit=500` 全表普查：**46 行 → 2 行有 issue**，兩個都係 `unarmed_alert_clock`
（即 fix 前留低嘅「rug 但 alert clock 未武裝」），兩個都冇 audit 證明（ring 30 條／跨度 5.2 小時；
兩行嘅最後檢查已經係 6.1／9.4 小時前，屬上面講嘅「缺席嘅證明」），所以照 at-least-once 行
`re_arm_row`：

| 幣 | 存量 `last_liquidity` | 診斷 | 動作 |
|---|---|---|---|
| BARREN | 9,636（< 地板，同 rug 一致） | `unarmed_alert_clock` | `re_arm_row` |
| JPC | 9,796（同上） | `unarmed_alert_clock` | `re_arm_row` |

`POST /debug/push-watch?repair=<mint>` 兩次都回 `{"repaired":true,"plan":"re_arm_row","proved":false}`；
普查亦即刻轉 `issueCount 0`（兩行變 `last_state = NULL`、`last_alert_at = 0`、`last_checked = 0`）。

**收斂（線上）**

- **BARREN**：下一個 pass（00:29:18Z）就重新評估 → `lastState = null`（返 ACTIVE）。佢線上
  DexScreener 主池係 **$16.2K**，即係 9,636 嗰個讀數已經唔再成立；該 pass 讀到嘅係非可比腿，
  所以流動性未判、`last_liquidity` 照留舊值，下一個可比腿 tick 就會寫返真值。
- **JPC**：修復後約兩分鐘**由表消失**，00:33:45Z 又由 self-heal（`findUntrackedPushes`）重新
  enroll（`last_checked` = 插入鐘、`last_liquidity` / `last_mcap` 都係 null）。佢線上主池仍然係
  $2.8K，即係判決本身冇錯，只係嗰行以身殉咗。

**點解 JPC 會唔見（同一個 fix 家族嘅第二個窿）**：唔係 prune —— 佢 `pushed_at` 只係 6.9 小時前，
窗係 26 小時。係 row loop 嘅 pair-miss 分支：寬限由**最後一次成功 check** 起計
（`Math.max(pushedAt, lastChecked)`），而 re-arm 啱啱好把 `last_checked` 清零 —— fallback 於是變咗
`pushedAt`，即係「unfindable 夠 2 小時先 drop」嘅寬限**喺 re-arm 之後嘅第一次 pass 就已經超時**，
第一次 miss 就 delete 咗行。re-arm 嘅承諾（下一個 pass 重新推導、需要時重發同一張卡）就咁被一個
miss 抵銷 —— 正正係呢份 doc 一路修嘅「冇卡喺 chat、行又靜靜哋消失」形狀。今次 self-heal 救返
（推播只係 6.9 小時前，喺 heal lookback 內）；再舊啲嘅行就會係永久消失。

**修法**（`docs/patches/rearm-pair-miss.patch`，已 apply）：寬限一定要由**真嘅 check 鐘**起計 ——
`row.lastChecked > 0 && now - lastSeen > 2h`。冇鐘（arm/re-arm 之後未 check 過）＝冇「2 小時搵唔到」
嘅證據，行留畀下一個 pass 再試；終點仍然係窗口 prune（`pushed_at` + 窗），而一次成功 check 就會
還原個鐘。負向對照：喺 build artifact 度移走 fix，同一個測試即刻紅（`231 passed, 1 failed`）。

- `npm run test:unit` → **232 passed / 0 failed**，新增
  `PushWatcher: a re-armed row is not deleted on its first pair miss`（同一份 6 小時前嘅 `pushed_at`：
  `last_checked = 0` 嗰行要留、`last_checked = pushed_at` 嗰行照樣 drop）。
- `npm run typecheck` ✅。
- 呢個 fix 要 deploy 先喺線上生效；未 deploy 前再手動 repair 舊行，仍然有機會被第一次 miss 刪走
  （self-heal 會喺 lookback 內補返，但唔應該靠佢）。
