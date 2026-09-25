# 2026-09-25：死 tick 嘅收費閘（chain fence）＋ profiles raw 空嘅真兇（共用 egress IP 429）

操作員嘅兩個讀數：

| 症狀 | 量度（live） |
|---|---|
| 死 tick | `/debug/scan-history?rows=500`：36/500 死（7.2%），32 個 `previous tick died before its completion flush` ＋ 4 個乾淨嘅 race-window cut；階段分佈 gate 19 / postscan 5 / front 4 / pair 2 / scan 1 / none 1 |
| profiles raw 空 | 133/464 tick（27%）`lastRawProfiles 0`，全靠 8 條 make-up 撐 |

## 1. 死 tick：唔係 wall clock，係 invocation 嘅 50-subrequest 上限

`docs/scan-completion-loss.md` 早已指出機制（2026-09-23 拍到 `err:Too many subrequests by single Worker
invocation`），但未落任何柵欄。今次先用**階段 stamp 嘅 ms**核對，排除「~9.6s wall-clock 殺點」：

| at | stage | 離 tick 開始 | 已計 subreqs | preRace |
|---|---|---|---|---|
| 22:53:41Z | front | **+960ms** | 10 | 228ms |
| 16:14:49Z | front | **+918ms** | 10 | 63ms |
| 15:05:50Z | scan | **+91ms** | 2 | 91ms |
| 21:49:50Z | gate | +2362ms | 38 | 57ms |

一個 tick 一般 2–3.6s 就跑完（`deadTickStreak 0`、p50 2.35s），所以 `+91ms`／`+960ms` 死唔可能係 wall
clock。另一個關鍵：**最後落地嘅 stamp 個 count 偏低（2–38）**——因為 stamp 自己都係一個 subrequest，
爆預算之後連 stamp 都寫唔入，所以 row 只講得出「最後趕得及落地嗰個階段」，真正死點之後（通常喺 chain）。
咁同 `src/subreqs.ts` 開頭嗰句完全一致：爆預算時**最後死嘅就係 telemetry 寫入**，包括 completion flush。

**核心唔對稱**：scan 側只有 `dropOptionalLeg`（可選腿，`SCAN_SUBREQ_FLOOR = 12`）同 tracker pass 嘅
`TRACKER_PASS_SUBREQ_RESERVE = 9`，但 **candidate chain（gate 階段）完全冇閘**——而 chain 正正係每
candidate 一堆 upstream fetch ＋ Turso 寫入嘅地方，亦係 15/32 死亡 stamp 停低嘅階段。Turso 每個
round trip ＝ 一個 subrequest，慢嘅 call 更會被 libsql 內部重試放大（一個 call 食幾個）。

### 落咗乜（`src/scanner.ts`）

`CHAIN_SUBREQ_FLOOR = 3`：chain 每次開始一個 coin 之前，若 `subreqsLeft() <= 3` 就**唔開始**，改為
defer 落下一個 tick。

* **3 係算術，唔係round number**：chain 之後唯一唔可以輸嘅 call 係 completion flush，而 flush 嘅整條
  重試梯（attempt 1 ＋ racing retry ＋ backoff retry）＝ **3 個 subrequest**。停喺 3 就係「唔開始啲
  tick 負擔唔起嘅工作」。
* **代價嘅形狀同隔籬嗰個 deadline break 一樣**：coin 唔係消失，係留喺 re-eval pool（near zone 3 分鐘
  一轉），等於一次延遲，唔等於漏推。相反：死一個 tick ＝ 一條 60–107s 嘅 cadence 洞 ＋ 一次 tracker
  turn ＋ 一行要人手解讀嘅 backfill。
* **讀數**：`summary.chainFloor`（= 3）、`summary.chainDeferred`（今次 defer 咗幾多個 candidate）、
  `summary.subreqSkip` 會多一個 `chain`（同 `meteora` / `jupTrend` / `boosts` 等可選腿並列），所以
  「chain 唔夠錢」永遠唔會同「上游冇貨」撈亂。

## 2. profiles raw 空：一個 tick 一個 request，仍然中 429

`/debug/dex429`（durable ring）：**17 次/鐘**，而 27% × 60 tick ≈ 16 次/鐘——兩個數幾乎一樣。原因係
DexScreener 對 `/token-profiles/latest/v1` 係**逐來源 IP** 限流（約 5 req/min），而 Cloudflare Worker
嘅 egress IP 係全 fleet 共用：桶係陌生人花嘅，我哋每 tick 嗰一個 request 就係被 429 嗰個。2026-09-19
嘅紀錄（「一次 per ~5 分鐘」）今日已經變成 3–4 分鐘一次，所以一條 tick 換一次空白。

我哋改唔到人哋個桶，但改得到**個 request 有冇去到 origin**。所以兩個 *list* feed
（`/token-profiles/latest/v1`、`/token-boosts/latest/v1`）改用 GeckoTerminal leg 自 2026-09-21 一直
用嘅同一招（`src/geckoterminal.ts` `requestInit`）：

```ts
cf: {
  cacheEverything: true,
  cacheTtl: 60,
  cacheTtlByStatus: { "200-299": 60, "300-399": 0, "400-599": 0 },
}
```

* colo cache **HIT 唔會去 origin**：冇 429，latency 由共用 egress 嘅 300–800ms 落到 ~10ms（subrequest
  照計一個，因為 fetch 本身就係一個）。
* `cacheTtlByStatus` 保持 4xx/5xx **唔入 cache**，所以一個被拒嘅分鐘永遠唔會被當成新 feed 餵落一個 tick。
* **60 秒**＝一個 tick 嘅節奏：呢個 endpoint 係慢慢轉嘅「最新 profile」清單，而本 client 已經接受
  10 分鐘前嘅清單（`PROFILE_FEED_REUSE_MS`）——即係 60 秒嘅 HIT 一定比 tick 本來會評估嘅嘢新。
* **刻意唔套用喺 pair batch**（`/latest/dex/tokens`）：嗰啲係 gate 同 tracker 判嘅 metrics
  （5m vol/change、流動性），而且 key 係今個 tick 手上嘅地址集——client 自己已經有 pair cache。

### 順手加咗一個之前讀唔到嘅讀數

`raw 0` 一直撈埋兩種截然不同嘅事：**(a)** upstream 拒絕（429，`http429` ＋1）、**(b)** 我哋根本冇發出去
（throttle queue 食晒 caller 個 480ms 窗口，`getJson` 直接 return null）。兩者 fix 唔同，但之前個 counter
分唔開。而家 `/health.summary.dex` 多三個欄：

| 欄 | 意思 |
|---|---|
| `listCacheHits` | list feed 有幾多次由 colo cache 出（爬升 ＝ origin 冇被問過 ＝ fix 生效） |
| `lastListCacheStatus` | 最後一次嘅 `cf-cache-status`（`HIT` / `MISS` / `BYPASS` / `DYNAMIC`…） |
| `budgetDrops` / `lastDroppedAt` | 有幾多次「窗口早用完、request 冇發出」 |

## 代價同界線（誠實版）

* **呢兩刀冇減少 tick 嘅 Turso round trip 數**（每個仍然係一個 subrequest）。實測一個健康 tick 嘅
  window 係 `total 22–29`，其中 turso 16–20；慢 DB 時 libsql 內部重試會放大。`docs/round-trips.md`
  §4.11 已經記住咗下一步嘅方向（合併一次性 state op），**但結構性嘅答案仍然係 Workers Paid**
  （subrequests 50 → 10,000、cron CPU 10ms → 30s）——呢點唔可以靠 code 繞過。
* chain fence 會令**熱市**（≥2 個同時合格嘅 candidate）嘅第二、三個 coin 延遲一個 tick。呢個係刻意嘅
  取捨：完成一個 0 秒 scan（candidate 留 pool）勝過一個死 tick（乜都冇評估 ＋ 冇紀錄）。
* Edge cache 係「讀」而唔係「填」（同 gecko 一樣）：如果 60 秒內冇任何 Cloudflare 客戶問過同一條 URL，
  我哋嗰次就會 MISS 去 origin，該 tick 仍然可能 429。`raw 0` 唔會變零，只會大跌；`listCacheHits`
  同 `lastRawProfiles` 兩個數一齊睇就分得出。

## 驗收（deploy 之後點讀）

1. `/health.heartbeat.summary.dex`：`listCacheHits` 應該**爬升**、`lastListCacheStatus` 應該出現
   `HIT`（若長期 `BYPASS`/`DYNAMIC` ＝ 呢個 host 唔俾 cache，就要回退 `cf` 呢兩行）。
2. `/debug/scan-history?rows=500`：`previous tick died before its completion flush` 應該由 32 跌；
   出現 `[prog ... ]` 但階段係 `gate` 嘅行應該明顯減少。
3. `summary.chainFloor` / `chainDeferred`：正常熱市會偶爾見到；**若每個 tick 都見到 `chain` 落
   `subreqSkip`**（即 fence 恒常觸發），代表個 tick 真係長期冇錢，要回過頭睇 turso round trip 數
   （`summary.dbTickSteps`），唔係再收緊 fence。
4. `/debug/feed-stats` ＋ `summary.feedMakeup`：`lastRawProfiles` 應該由 0 爬返 20±、`failedTotal`
   增長放慢；`/debug/dex429` 嘅 `lastHour` 應該跌（因為 list feed 唔再打 origin）。
5. 單元測試：`scripts/test-deferred-priority.js` 新增兩組斷言——chain fence（真 DB、真 tick、真
   candidate：fence 住時 `chainDeferred 1 / pushed 0`，有錢時同一個 coin 照推到）同 list feed 嘅
   edge cache（兩個 list feed 有 `cf`、pair batch 冇、HIT 計數、窗口用完算 drop）。

## 落線讀數（2026-09-25 23:37Z deploy `68daea1`，Action run 36201667560 success）

`/health` 連環取樣（每個 tick 一個 `heartbeat.summary`）：

| 時間（Z） | `dex.listCacheHits` | `lastListCacheStatus` | `dex.budgetDrops` | `dex.http429` | `feedMakeup.lastRawProfiles` | tracker pass |
|---|---|---|---|---|---|---|
| 23:42:07 | 0（新 isolate） | null | 0 | 0 | 23 | — |
| 23:42:58 | **2** | **HIT** | 2 | 0 | 22 | — |
| 23:43:47 | **4** | **HIT** | 3 | 0 | 22 | — |
| 23:46:59 | **8** | **HIT** | 3 | 0 | 21 | `rows 22/27 pairs 27/27 miss 0 lost 0` |
| 23:47:52 | **10** | **HIT** | 6 | 0 | 21 | `rows 21/27 pairs 27/27 miss 0 lost 0` |

即係每個 tick 兩個 list feed（profiles ＋ boosts）都係 **colo cache HIT**，origin 冇被問過；同一時間
`http429` 由改前嘅 17 次/鐘跌到 0（呢個 isolate），`lastRawProfiles` 22 → 21 → 23（唔再係 0）。
對照之下 gecko leg 同一個機制讀 `lastCacheStatus BYPASS`——同 gecko 一直無 HIT 嘅紀錄一致（同一個 egress
bucket 問題，唔屬今次範圍）。

`/debug/scan-history?rows=200`：

| 窗口 | 行數 | ok | `died before its completion flush` | race cut | ms p50 | max |
|---|---|---|---|---|---|---|
| 22:00Z–23:37Z（改前） | 88 | 85 | **3** | 0 | 2594 | 82054 |
| 23:37Z–23:47Z（改後） | 7 | 7 | **0** | 0 | 2454 | 3363 |

⚠️ **7 個 tick 唔夠斷 6–7% 嘅死亡率**：今次只證明到「改後冇死」同「機制照跑」，統計上嘅結論要等
**一個鐘**之後再讀同一條查詢（`rows=500`：32 → 對比）。同一時間 `deadTickStreak 0`、
`wedgedStateResets 0`、`scheduledTickHoleMs ~35s`、`tickProgress postscan` 全部正常。

`chainFloor` / `chainDeferred` 喺呢個窗口**冇出現**——因為嗰幾個 tick 都係 `candidates 0`（fence 只會
喺真有 candidate 嘅 tick 觸發）。佢嘅行為由單元測試釘住（`scripts/test-deferred-priority.js`：同一個
coin，fence 住 = `chainDeferred 1 / pushed 0`，有錢 = 照推到），live 要等一個 candidate tick 才見得到。

順帶一個**新讀數**：`budgetDrops` 每個 tick 2–3（`allow 4289` 嗰個 cold isolate 仲高）。即係有 request
**根本冇發出**（throttle queue 食晒 caller 個 480ms 窗口），而唔係被 429 拒——呢個係改前就存在、只係
counter 分唔開嘅形狀；`lastRawProfiles` 證明唔係 profiles 腿（`failedTotal 0`），大約係 boosts / pair
批次。要收就跟手做「list feed 喺 throttle queue 有優先權」或者關掉 boosts。

## 回退槓桿

| 想收回 | 做法 |
|---|---|
| chain fence | 刪 `scanner.ts` chain loop 嗰個 `if (subreqsLeft() <= CHAIN_SUBREQ_FLOOR)` block（一行常數同理） |
| list feed 嘅 edge cache | 兩個 call site 傳少第三個參數（`getJson(path, deadline)`），code 路徑即刻同改前一樣 |
| boosts 腿（今次冇改） | `DEXSCREENER_BOOSTS_LIMIT = "0"`（wrangler.toml，一行） |
