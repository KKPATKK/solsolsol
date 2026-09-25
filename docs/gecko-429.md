# GeckoTerminal 429：改用邊緣快取，唔係再降頻（2026-09-20）

> 相關：`docs/push-baseline-ledger.md`（feed 預算／DexScreener profiles 嘅 429 線）、
> `docs/scan-completion-loss.md`（`writeDrain` 100% 失敗，同日處理）。

## 量度（同一分鐘，兩個方向）

| 來源 | `new_pools` | `trending_pools` |
|---|---|---|
| 普通主機（本機 curl，07:19Z） | **200**，`cf-cache-status: HIT`，29.9KB / 20 pools | **200**，HIT，36.7KB / 20 pools |
| Worker（`/debug/gecko-trending` × 3） | — | **429 ×3**：`{"status":"429","title":"Rate Limited"}` |

同時 `/health` 每個 tick 都係 **`geo 0 / geoTrend 0`**（gecko 兩條 discovery feed 一路
冇貢獻任何幣），而同一個 tick 嘅 `profiles 28 / jup 20` 正常 —— 即係問題局限喺 gecko。

429 body 係 **app-level**（`gt-error-code-429`、`{"status":{"error_code":429,…}}`），
即係 GeckoTerminal 用**呼叫方 IP** 做 quota，而 Cloudflare Worker 嘅 egress 係一組共用 IP：
quota 早就畀其他 Worker 用光，同我們自己嘅頻率無關（我們只係 2 req/min，遠低於公開嘅 30/min）。
沙盒側反而係 200 —— GeckoTerminal 本身就係 Cloudflare zone，自己出
`cache-control: max-age=30, s-maxage=60`，而我哋嗰下 curl 係 `cf-cache-status: HIT`：
**object 已經喺邊緣快取裏面**。

## 為何之前係「每 5 分鐘 ping 一次」

`src/geckoterminal.ts` 嘅 `GECKO_RATE_LIMIT_BACKOFF_MS` 係**固定 5 分鐘**：

1. 窗口一過 → 出去一次 → 食 429 → 再武裝 5 分鐘；
2. 即係每小時 **12 次註定失敗**嘅請求；
3. 而且每 5 分鐘嗰個 tick 嘅兩條 gecko feed（new_pools ＋ trending）都係 0 ——
   discovery 淨靠 DexScreener profiles ＋ Jupiter。

## 改咗乜（全部喺 `src/geckoterminal.ts`，窗口內）

### 1. 邊緣快取（主刀）

每個 call 而家帶：

```ts
fetch(url, {
  headers: {
    Accept: "application/json",
    "User-Agent": GECKO_USER_AGENT,   // 冇佢 → 403（2026-09-21 實測）
  },
  signal: AbortSignal.timeout(10_000),
  cf: {
    cacheEverything: true,          // Worker subrequest 默認唔用 cache
    cacheTtl: ttlS,                 // 分層：discovery 300s、snapshot 60s
    cacheTtlByStatus: { "200-299": ttlS, "300-399": 0, "400-599": 0 },
  },
});
```

- Worker 嘅 subrequest **默認唔會**用 Cloudflare cache，所以過去每一次都係打去 origin
  （被共用 IP quota 擋）；`cacheEverything` 令佢加入邊緣快取 —— 命中就唔會再撞 rate limiter。
- **TTL 分層**（`geckoCacheTtlS()`，2026-09-21 再改）：在同一個 egress IP 被 quota 封住嘅情況下，
  快取裏面只會有「難得一次 200」放進去嘅 object —— 而 **429 一定唔入快取**，
  所以 60s TTL 等於一次成功祇買到**一個 tick** 嘅 `geo 20`（實測：`geo 20` → 一分鐘後 0，
  `ok 1 429 1 cacheHits 1`）。discovery 改 **300s**：一次成功覆蓋五個 tick，
  而 discovery 本身冇損失（幣要 **80 分鐘之後** 才入合格窗口，註冊係 idempotent）。
  **tracker 嘅 token snapshot 保持 60s**（上游自己嘅 `s-maxage`）—— 陳舊嘅流動性讀數係
tracker 唯一唔應該照消化嘅東西，而嗰啲 call 係 per-coin，量少。
- **429 明確唔准入 cache**（`400-599: 0`），唔會將一個壞分鐘當新 feed 派畀下一個 tick。

### 2. 升級式 backoff（安全網）

- 第一次 429 仍然係 5 分鐘（保留原有行為）；之後**每次加倍** 5 → 10 → 20 → 40 → **60 分鐘封頂**；
- 成功一次即清零（`consecutive429 = 0`、`backoffMs = 0`）；
- 上游若果有 `Retry-After`（秒數或 HTTP-date）**且比 escalation 長**就用它，硬上限 6 小時；
- ±10% jitter，避免多個 isolate 同一秒再試。

效果：就算快取幫唔到手，失敗成本都由 **12 次/時 降到 ~1 次/時**（cold isolate 最多再食一次），
而 feed 會自動回復。

### 3. 可驗收嘅遙測

`summary.gecko`（由窗口內嘅 `tickprobe.ts` 掛上 summary，因為 worker 嘅 telemetry block 喺窗口外）：

```ts
{ active, requests, ok, http429, consecutive429, cacheHits,
  lastStatus, lastCacheStatus, last429At, lastOkAt, backoffMs, backoffUntil }
```

以前 `geo 0` 分唔清「被封」同「市場靜」；而家一眼睇得到，`cacheHits` 更直接證明快取有冇生效。

## 補償：主 host 被封時改問另一個 host ＋ 可選 keyed quota（2026-09-21）

### 為何快取救唔到（先講清楚）

`cacheEverything` 只幫到「origin 肯出 200」嘅情況：IP quota 用光之後 origin 直接 429，而
`cacheTtlByStatus["400-599"] = 0` 令嗰個 429 **唔入 cache**，所以下一個 request 照樣 MISS → 照樣 429 ——
快取永遠冇一個 200 可以 HIT。線上讀數正是咁：`ok2 429x2 cacheHits1 lastCacheStatus BYPASS`，而 `geo` 長期 0。

### 主刀：同一個 payload，另一個 hostname

```ts
export const GECKO_ALT_BASE_URL = "https://api.coingecko.com/api/v3/onchain";
```

- `api.geckoterminal.com` 同 `api.coingecko.com` 係**兩個 host**（唔同 rate-limit bucket），
  而 CoinGecko Onchain API 一樣發佈 `new_pools`。
- 由乾淨主機實測（2026-09-21 07:57Z）：
  `GET /api/v3/onchain/networks/solana/new_pools?page=1` → **200 / 29,960 bytes**，
  `parseNewPools()` **20/20 全中**，全部有 `pool_created_at`（age 1 分鐘）⇒ **唔需要新 parser**。
- **但同一個 URL 半個鐘後唔再 200**（重新實測 08:22Z，三種打法）：

| request | 結果 |
|---|---|
| 冇 `User-Agent`（＝ Worker `fetch` 嘅默認形態） | **403** `Please add a descriptive User-Agent to your request` |
| 有 `User-Agent`（默認 curl 或我們嘅） | **401** `Requests without API key are not allowed for this endpoint` |

  即係：**呢個 host 嘅 keyless 入場券已經冇了**（new_pools 同 trending 一樣要 key）。
  同一個 host 由沙盒 IP 都係 401，所以唔係 Worker egress 問題，而係**帳號層面嘅規則**。
- 結論：**fallback 只有在有 key 嘅情況下才真正服務得到**；keyless 下佢只係一條**有界探測**
  （拒收 → `armAltPause` → 每 5→60 分鐘一次）——成本極低，而且將來若放寬或加 key 會自動回復。
  主 host（`api.geckoterminal.com/api/v2`）反而係 **冇 UA 都 200**（實測），所以 429 純粹係 egress IP quota。
- 唔係全 host mirror：`trending_pools` 喺呢個 host 一樣 key 閘住，所以 fallback 係 **per-path**。

### 規則（全部喺 `get()`）

| 情況 | 行為 |
|---|---|
| 主 host 未暫停 | 照舊只問主 host |
| 主 host 暫停＋path 合資格（keyless 只有 `new_pools`） | 改問 alt host |
| 主 host 暫停＋path 唔合資格 | 一個 request 都唔花 |
| alt 自己 429 | **alt 自己嘅 pause**（同主 host 分開，一樣 5→60 分鐘遞增）；主 host 嘅 pause **唔會被 alt 成功清零** |
| alt 成功 | discovery 照舊有幣；主 host 到佢自己窗口先再試 |

成本上限：任何失敗（包括 429 以外嘅硬拒收）都會 arm alt 自己嘅 pause ⇒
**每個 alt 窗口一次探測**（唔係每 tick 一次）。

### 遙測

`summary.gecko` 新增：`lastHost: "primary" | "alt"`、`altAttempts`、`altOk`、`alt429`、`altBackoffUntil`、`keyed`。

### 可選：keyed quota（唯一真正離開 IP 限流嘅方法）

```bash
# 唔好放 wrangler.toml —— 係 SECRET，用 Cloudflare dashboard（或 Freebuff 嘅 Keys UI）
COINGECKO_API_KEY  = "CG-..."
COINGECKO_API_PLAN = "demo"   # demo → x-cg-demo-api-key；pro → x-cg-pro-api-key
```

有 key 時**每個 request** 都帶 key ⇒ quota 由 key 計（唔再係共用 egress IP），主 host 唔會再 429，
而且 alt 變成**全 mirror**。`gecko.keyed` 就係「有冇生效」嘅讀數。

**要老實講嘅 quota 數學**：我們每個 tick 打 gecko 約 2 次（`new_pools` 1 ＋ trending 1）＝
**~86K 次／月**，而 CoinGecko Demo plan 係 **10K 次／月** ⇒ 免費 key 只夠 ~3 日連續使用。
所以 key 係「**fallback 放大器**」（只喺主 host 被封時先燒）或者付費 plan 先合理，
唔係免費路徑嘅替代品 —— 免費主路徑仍然係 keyless ＋ 快取 ＋ alt fallback。

## 為何唔係降頻

- **降頻冇用**：quota 唔係我們嘅用量造成（共用 egress IP 被其他 Worker 用光），
  拉到 90s 只係少一半請求，仍然係食 429。
- **換源已經做咗**（見上一節）：同一個 payload 嘅第二個 host，零 key、零成本；
  付費／keyed 路線保留做 operator 嘅選項（quota 數學見上）。
- **唔會漏推**：gecko 只係 **discovery ＋ tracker 嘅第三 pair 來源**，兩邊都有
  DexScreener／Jupiter 嘅 fail-open 路徑，所以 gecko 全死都唔可以令任何一張卡唔推。

## 驗收點（deploy 後）

```bash
curl -s .../health | jq '.heartbeat.summary | {geo, geoTrend, gecko}'
```

- **快取生效**：`geo` / `geoTrend` 回復 > 0，`gecko.cacheHits` 上升、`lastCacheStatus: "HIT"`；
- **快取唔中**：`gecko.lastStatus: 429` 但 `http429` **唔再每 5 分鐘 +1**（改成 10/20/40/60 分鐘），
  `backoffUntil` 對得上，`geo` 仍然 0 —— 即係「真係 upstream 封 IP，但唔再盲目撞」；
- **反面驗收**：`geo 0` 期間 `profiles`／`jup` 照樣有數（實測 28／20），卡片推送不受影響。
- **fallback**：`gecko.lastHost`／`altOk`／`altAttempts`／`altFailures`／`altLastStatus`。
  `altAttempts` 上升但 `altOk 0` ⇒ 睇 `altLastStatus` 分辨（**實測係 403，見下節**）。
- **探針**：`/debug/gecko-alt` —— 同一個 URL 三種打法（有 UA／冇 UA／有 UA＋cf 快取選項），
  回 status、`cf-cache-status`、body 頭 200 字，用嚟一次過分辨「WAF 擋」、「要 key」、
  「UA」同「快取選項」四個可能。

## 部署後實測：alt host 由 Worker egress 係 **403**（`15982ea`，2026-09-21 08:08–08:15Z）

```
geo 0  prof 28 | req 7  ok 0  429 2  cacheHits 0  lastStatus 429  backoffS 648
               | altAtt 5  altOk 0  alt429 0  altBackoffUntil 0   ← 舊寫法（只認 429）
```

1. **fallback 確實有喺 worker 內部發出**：`altAttempts` 4 → 5，約每分鐘一次，即係 `get()` 真係
   路由到 CoinGecko Onchain（唔係靜靜地被跳過）。
2. **但答案係 403**（唔係 429、唔係 200）——同一個 URL 由乾淨主機係 **200 / 29,960 bytes**，
   由 Worker egress 係 **403**：即係該 host 對 Cloudflare Worker egress（或對無 key 嘅請求）直接拒收。
3. **`alt429 0` 就係漏洞**：403 唔會入 429 統計，所以「只認 429」嘅寫法會**每個 tick 燒一個 request**
   而 `geo` 照樣 0（上面 `altAtt 5` 就係證據）。
4. **因此修成：任何失敗都 arm alt 嘅 pause**（403 ↔ 429 共用同一條 5→60 分鐘 escalation，
   成功即清零），成本由「每 tick 1 次」降到「每個窗口 1 次」，而萬一將來解封或加了 key 會自動回復。
   遙測加 `altFailures` / `altLastStatus`，所以「係唔係真係 403」一眼睇得到。

## 部署後實測（`b52d4ce`，2026-09-21 08:23–08:29Z）

### 1. 403 嘅真因：冇描述性 `User-Agent`（唔係 WAF、唔係快取選項）

`/debug/gecko-alt` 喺 **Worker 自己嘅 egress** 打同一個 URL 三次：

```
userAgent: solana-meme-bot/1.0 (+https://github.com/KKPATKK/solsolsol)
ua        → 429  You've exceeded the Rate Limit
noUa      → 403  Please add a descriptive User-Agent to your request
uaCached  → 429  （加 cf 快取選項結果一樣 ⇒ 快取選項無關）
```

⇒ **UA 真係必要**（沙盒冇 UA 都係一樣 403），而且 `cf` 選項被排除；
Worker 可以正常自行設 `User-Agent`。剩下嘅牆就係**keyless 額度**（同主 host 一樣是 IP 層面）。

### 2. `geo` 有回復，但會閃（5 分鐘 TTL 就係為此）

```
08:27:27 geo 20  jup 20 prof 23 | req 2 ok 1 429 1 cacheHits 1 host primary
08:27:52 geo  0  jup 20 prof 23 | req 3 ok 1 429 1 cacheHits 1 host primary altAtt 1 altFail 1 altStatus 429
08:28:18 geo  0  ...             | altAtt 1（**冇再升**）
```

- `geo 20` 係快取 HIT（`cacheHits 1`）——主 host 嘅 keyless 額度偶爾通到；
- 下一個 tick 主 host 429 ⇒ 轉去 alt ⇒ alt 亦 429 ⇒ `armAltPause` 煞停（`altFailures 1`、
  `altLastStatus 429`，之後 `altAtt` 唔再升）——**成本由舊寫法嘅每 tick 1 次降到每窗口 1 次**；
- 「一個 tick 20、下一個 0」正是 60s TTL 嘅問題，所以 discovery 已改 **300s**（見上）。

## 第三個 keyless 源：pump.fun v3（`ca5c91c`／`wrangler.toml`，2026-09-21 08:54Z）

### 先驗 Worker egress（`/debug/pool-source`）

由 **Worker 自己嘅 egress** 打每一個候選源：

| 候選 | 結果 | 判定 |
|---|---|---|
| `frontend-api-v3.pump.fun/coins?sort=created_timestamp` | **200**，38,959 bytes，20 個，**最新嗰個 4 秒前** | ✅ 用 |
| `frontend-api.pump.fun`（舊 host） | **530** `error code: 1016`（origin DNS 冇了） | ❌ 難怪之前要熄 |
| `api.dexscreener.com/token-boosts/latest/v1` | 200，15 個 solana（無建立時間） | ⏸ 後備 |
| `api-v3.raydium.io/pools/info/list-v2` | 200，但 **`sortField` enum 只有 liquidity/volume/fee/apr** | ❌ 冇「最新」排序 |
| `api.orca.so/v2/solana/pools` | 200，171KB，**`sortBy` enum 只有 volume/fee/rewards/yield/tvl**、payload 冇 `createdAt` | ❌ 同上 |
| `dlmm-api.meteora.ag/...` | 404（由乾淨主機都係） | ❌ 唔存在 |

Raydium 同 Orca 嘅排序選項係由**佢哋自己嘅規格**讀出來嘅（Raydium OpenAPI 嘅 `poolSortField` enum、Orca 嘅 400 錯誤列表），所以唔係「Worker 打唔到」而係**根本冇一個「最新 pools」入口**。

### 接線方法

- `src/pumpfun.ts`：BASE_URL 改去 v3，`sort=created` → **`sort=created_timestamp`**
  （v3 嘅 400 自己列明合法值），加描述性 UA。
- `pumpfunDiscoveryLimit()`：**只在 gecko `new_pools` 暫停時**才回一個 batch
  （`PUMPFUN_FALLBACK_LIMIT=20`）——gecko 健康時係 0，所以 steady state 成本不變；
  `summary.pumpFallback` 就係「呢批係唔係補位」嘅讀數。
- 舊 host 已死，所以 v3 唔係「多一個 feed」，而係**同一條 feed 復活 + 只在 gecko 死時跑**。

### 線上驗收

```
/debug/pool-source → pumpfun-v3 status 200 count 20 newestAgeS 4
/health            → gecko geo 0（仍然被封）| pump 20 pumpFallback true | prof 22 jup 20 jupTrend 15
```

**結論（更新）**：gecko 仍然降級，但 brand-new-coin 槽位**已經有人補**，而且補得更早
（pump.fun 嗰 20 個係**秒級**新幣，gecko 嘅 new_pools 係已建池、分鐘級）。
完整推播覆蓋仍然靠 profiles ＋ jup；gecko 自己要靠 key 或等 egress quota 回復。

**原本嘅結論**：免費路徑**仍然係降級狀態**（主 host 跟 alt 都被 keyless IP quota 封），
但（a）403 呢個真 bug 修好了，（b）失敗成本有界，（c）一次成功而家覆蓋五個 tick。
其他 feed 完全冇受影響：`profiles 23–24`、`jup 20`、`jupTrend 15`、tick 全 ok。
要 gecko 完全穩定，只剩三條路：**帶 key**（`COINGECKO_API_KEY`，Demo 10K/月 ≈ 只夠 fallback 用）、
**另一個 keyless 源**（Raydium／Orca／Meteora 嘅公開 pool API）、或者**接受降級**
（re-eval pool ＋ Birdeye backfill 兜住，輪換與推送都唔受影响）。

---

## 第三個 keyless 源（真正嗰個）：Meteora Data API（2026-09-21 09:2xZ）

### 一、先驗 Worker egress（`/debug/pool-source`，`128e434` 起）

| 候選 | Worker egress 結果 | 判定 |
|---|---|---|
| `frontend-api-v3.pump.fun/coins` | 200，39,112 bytes，20 個，**newestAgeS 2** | ✅ 現役第一後備 |
| `frontend-api.pump.fun`（舊 host） | 530 `error code: 1016` | ❌ 已死 |
| `api.dexscreener.com/token-boosts/latest/v1` | 200，15 個 solana，**冇建立時間** | ⏸ 唔夠用 |
| `api-v3.raydium.io/pools/info/list-v2` | 200 | ❌ **排序唔可以由建立時間** |
| `api.orca.so/v2/solana/pools` | 200，172KB，50 個 | ❌ **payload 冇建立時間** |
| `dlmm-api.meteora.ag`（舊 host） | **404，0 bytes（連 root 都 404）** | ❌ 唔存在（之前就係卡在這裏） |
| **`damm-v2.datapi.meteora.ag/pools`** | **200，19,735 bytes，10 個，newestAgeS 32**，`newestMint 4uEsfHuhsHnf`，`newestLaunchpad met-dbc` | ✅ **用** |
| `dlmm.datapi.meteora.ag/pools` | 200，19,342 bytes，10 個，newestAgeS 64，`newestTvl 2485` | ⏸ 姊妹端點，備用 |
| `dbc.datapi.meteora.ag/pools` | 200，10 個，newestAgeS 509 | ⏸ 太慢、欄位唔齊 |

（Raydium／Orca 今次係**重新量度**，唔係照抄上次：Raydium 嘅 `sortField` 係真參數——`time`／`openTime`／`bogus`
全部回 500 `query sortField check error`，只有 liquidity/volume/fee/apr 合法；而上次以爲嘅 `poolSortField`
係**被靜靜忽略**（`liquidity`／`time`／`bogus` 三個回傳**完全一樣** 20,465 bytes、同一排序）。
Orca 嘅 pool object 完全冇 creation 欄位（只有 `updatedAt`／`updatedSlot`）。所以這兩家**任何價錢都做唔到「最新 pools」**。）

### 二、接線：launch-slot chain（gecko → pump.fun → Meteora）

- `src/meteora.ts`（新）：`GET /pools?page=1&page_size=N&sort_by=pool_created_at:desc`，
  `parseMeteoraPools()` 由 *非 quote* 那一邊取 mint（WSOL／USDC／USDT 三個當 quote；兩邊都係 quote、
  兩邊都唔係 quote、無 `created_at`、mint 唔似 base58 全部丟棄），`created_at` 係**毫秒**。
- **一次請求、冇 retry ladder**：429／403／HTML／parse 失敗一律 `[]`。同一 tick 內重試唔會好，
  而唔 await 嘅重試鏈會活過 feed 窗口、同 eval／push 爭 isolate（GMGN 嗰個 2s/4s 教訓）。
- `src/scanner.ts`：三層改成**真 chain**（每層 await 上一層）。排列位置係關鍵 —— 舊碼把 pump 那層放在
  gecko job **上面**，而 async IIFE 會同步跑到第一個 await，所以 `if (geckoJob !== null)` 永遠係 false：
  即係「gecko fallback」實際上係**每個 tick 都跑**，而 `pumpFallback` 亦永遠為 true。而家 pump／Meteora
  兩層都建在 gecko job **之後**，只有 gecko 交白卷才會輪到佢們，`diag.geo > 0 || diag.pump > 0` 就停鏈。
- 成本：gecko 健康時 **零**；gecko 死而 pump.fun 有貨時零（Meteora 唔會出場）；三層全交白卷才 = 2 個請求/tick。
  每次請求仍然在 `fetchFeedCapped` 的窗口內，冇窗口就唔 dispatch。

### 三、順手修好嘅真 bug：`PUMPFUN_PROFILE_LIMIT="0"` 從來冇熄過

`loadConfig` 嗰個 ternary 係 `raw > 0 ? clamp : 100`，所以 wrangler.toml 寫的 `"0"`（註解寫「DISABLED」）
其實變成 **100** —— 即係 always-on feed 每個 tick 拉 5 頁（`limit=20` × 5）塞在 900ms 窗口內、被 cut，
所以線上 `/debug/tick` 係 `pump 0` 兼且**冇 `pumpFallback`**（即係 fallback 分支根本冇行過、gecko 嘅判斷被浪費）。
修法：`env` 未設 → 100（保留歷史默認），設 0／負數／垃圾 → **0（熄）**，正數 → clamp 到 300。
新增測試釘死（`loadConfig: PUMPFUN_PROFILE_LIMIT=0 ...`）。

### 四、驗收點（deploy 後）

```
/debug/tick → summary.pump == 20 兼 pumpFallback true（gecko 死 → 第一後備接手）
            → summary.geo > 0 嘅 tick 必須 pump 0 / meteora 0（鏈停）
            → pump.fun 都交白卷嘅 tick 才會見到 summary.meteora > 0
```

`summary.meteora` 只會在**最後一層**出現，所以「非零」本身就證明前兩層都失敗；而 `meteora 0` ＋
`pumpFallback false/absent` ＋ `geo 0` 三者同時出現，就是「三層都死」的完整簽名。

## 部署後實測（`92cb2ea`，2026-09-20 10:08–10:15Z）

```
$ curl -s .../health | jq '.heartbeat.summary | {geo, geoTrend, gecko}'
geo 20   geoTrend 0
gecko {requests 3, ok 1, http429 2, consecutive429 1, cacheHits 1,
       lastStatus 429, lastCacheStatus "BYPASS", backoffMs 307956, backoffUntil +5min}

$ curl -s .../debug/gecko-trending        # 裸 fetch，冇 cf options
{"ok":false,"status":429,...}

$ curl -s .../debug/feed-stats            # 累計（DB）
gecko: coins 1575, pushed 21
```

讀法：

1. **主刀有效**：同一個 isolate 嘅 3 個 request 有 1 個係 cache HIT（`cacheHits 1`），而 `geo`
   由修前嘅「每 tick 都 0」變成 **20**（page 1 有 20 個 pool）—— 即係快取真係替 subrequest 擋咗
   一次 origin 撞限流。
2. **限流確實係 IP 級**：`/debug/gecko-trending` 呢條**冇帶 `cf` options 嘅裸探針**仍然 429，
   同修前一樣 —— 所以今次唔係「upstream 忽然放行」，而係「同一條路，但改行快取就通」。
3. **429 上嘅 `BYPASS` 係預期，唔係快取失效**：`cacheTtlByStatus["400-599"] = 0` 嘅目的就係要
   429 **唔入 cache**，所以嗰個 response 直穿（`lastStatus 429` + `lastCacheStatus BYPASS` 同時出現
   係一致嘅讀數，唔代表壞）。
4. **`geoTrend 0` 仍然會出現**：`trending_pools` 嗰次係 MISS → 撞 429 → 即刻入 backoff，所以
   trending 係整組最脆弱嗰條。但 gecko 只係 discovery／tracker 第三來源，DexScreener／Jupiter
   fail-open 照樣跑（同一 tick `profiles`／`jup` 有數）→ **唔會因為 gecko 而漏推**。
5. **推論（未單獨驗證）**：一個 cached 200 成功之後 `consecutive429` 會清零，所以 backoff
   唔會一路升到 60 分鐘封頂 —— 呢個就係「修完之後 requests 唔會爆」嘅機制。
6. **注意**：`/health` 嘅計數係**每個 isolate 自己**（module state），所以抽到一個冷 isolate
   （`count 1`、`requests 0`）唔代表嗰分鐘冇 request，只係嗰個 isolate 未跑過 gecko。跨 isolate
   只可以睇累計嘅 `/debug/feed-stats`。

## 單元測試（`test:unit` = 245 passed）

- `GeckoTerminalClient: every call asks for the Cloudflare edge cache`
  —— 釘住 `cacheEverything` / `cacheTtl` / `400-599: 0`，同 `cacheHits` 有計數；
- `GeckoTerminalClient: consecutive 429s escalate the pause; a success resets it`
  —— 第一次 5 分鐘、第二次更長、成功清零；
- `GeckoTerminalClient backs off all calls for 5 min after a 429`
  —— 更新為：暫停期間**只准** alt host 嘅 `new_pools` 一次、唔合資格嘅路徑零請求、窗口過後主 host 再試；
- `GeckoTerminalClient asks the alternate host while the primary is paused`
  —— 主 host 中毒下 discovery 照樣拎到 pool、alt 成功**唔會**清零主 host 嘅 pause、
  alt 自己 429 之後唔會再探，**同埋 403 硬拒收一樣會煞停 fallback**（`altFailures 2`、`altLastStatus 403`）；
- `geckoAltEligible / keyed mode: a CoinGecko key rides every request and unlocks the mirror`
  —— 純規則（keyless 只有 `new_pools`）＋ demo/pro header ＋ `keyed` 讀數；
- `geckoBackoffMs / parseRetryAfterMs: Retry-After wins, capped`
  —— 純規則：加倍、封頂、硬上限、秒數／HTTP-date 兩種 `Retry-After`。

（第一批 219 條之中有一條係 writeDrain 嘅窗口外 patch 防半貼 pin，見 `docs/scan-completion-loss.md`。）

---

## 第四輪（2026-09-25 14:33–15:00Z）：量到配額實數，成因定案

前三輪證明咗「係 IP 級」、「UA 必要」、「alt 由 403 變 429」。呢輪補最關鍵嗰條：
**keyless 每個 IP 到底有幾多次。**

### 一、實測：每個來源 IP **5 次／分鐘**，60 秒完全重置

乾淨主機，同一 URL、同一 UA，每次加隨機 `cb=` 迫 MISS（唔食快取）：

| 次序 | 1 | 2 | 3 | 4 | 5 | 6 |
|---|---|---|---|---|---|---|
| 第一次 trending | 200 | 200 | 200 | 200 | **429** | 429 |
| 隔 68 秒後 new_pools | 200 | 200 | 200 | 200 | 200 | **429** |

⇒ 窗口 60 秒、額度 5 次，68 秒後補滿。**唔係每日額度，唔係永久封鎖。**
官方 FAQ 寫 public API 30 calls/min；量到 5/min 係因為乾淨主機本身都係 NAT 共享出口，
5/min 係「嗰個 IP 剩返幾多」，唔係帳號級數字。429 係 app-level（272 bytes JSON）而且飛快
（0.05s vs 200 嘅 0.7s）⇒ 喺 edge 擋，唔會去 origin。 ### 二、同一分鐘兩個方向（今日重測）

| 方向 | `api.geckoterminal.com/api/v2` | `api.coingecko.com/api/v3/onchain` |
|---|---|---|
| Worker egress | **429**（`You've exceeded the Rate Limit…`） | 有 UA **429**、冇 UA 403 |
| 乾淨主機 | **200 MISS → 隨後 HIT**（37.7KB） | 唔再係出路 |

### 三、定案：我哋**只係快取嘅讀者，永遠做唔到寫者**

`/health.heartbeat.summary.gecko`（14:50Z）：

```
requests 11  ok 4  cacheHits 4  http429 4
lastStatus 429  lastCacheStatus BYPASS  backoffMs 306462  keyed false
altAttempts 3  altOk 0  alt429 3  altFailures 3  altLastStatus 429
```

**`ok 4` 同 `cacheHits 4` 完全相等**（14:58Z 再讀：req 17 / ok 8 / cacheHits 8，一樣）。
⇒ 呢個 isolate 開機以來 gecko **一次 origin 都冇成功過**，每個 200 都係 edge HIT。
而 `cacheTtlByStatus["400-599"] = 0` 故意唔畀 429 入 cache，所以：

```
我哋 → origin 429 → 唔入 cache → 下一 tick 照 MISS → 照 429 ⟹ 永遠冇我哋自己嘅 200
```

之前講「快取係主刀」要補一句：**主刀只喺「有其他用家幫手暖咗個 DC 嘅 edge」時成立**。
上游 `s-maxage=60`，我哋 `cacheTtl: 300` 只延長**我哋自己** store 落去嘅對象——而我哋 store 唔到。 ### 四、實驗：外部暖 cache ⇒ `geo` 即刻回 20

14:58Z 由乾淨主機各打 3 次（`new_pools` 已經 `HIT`，`trending_pools` 先 `MISS` 再 `HIT`）：

```
14:58:49Z  geo 0   geoTrend 0
14:59:49Z  geo 20  geoTrend 0     ← 有對象，Worker 讀到
```

⇒ `geo 0 / geoTrend 0` **唔係我哋 code 有 bug**，而係「呢 60 秒內個 DC 冇人 store 過」。
`geoTrend` 較韌：trending 個 URL 帶 `include=base_token&limit=20`，edge 對象少人問。

### 五、損失量（`/debug/feed-stats` 累計）

| feed | coins | pushed |
|---|---|---|
| jup | 20,140 | 119 |
| pump | 5,210 | 11 |
| **gecko** | **2,083** | **33** |
| dex | 554 | 270 |
| jupTrend | 10 | 9 |

gecko 係**次要** discovery 源，兩個槽位都有人頂：launch slot 已經係 `pump 20 + pumpFallback true`
（pump.fun v3，1 個 keyless 請求，Worker egress 實測 200，而且**更新鮮——秒級 vs gecko 嘅分鐘級**），
momentum slot 係 `jupTrend`。tracker／push 兩邊都有 Dex／Jupiter fail-open ⇒ **唔會漏推**。 ### 六、出路：Demo 免費 key 係唯一真正離開 IP 限流嘅方法

官方條款（`coingecko.com/en/api/pricing`）：**Demo 免費 plan = 100 calls/min、10,000 calls/月**，
quota 記喺 **key** 度 ⇒ 共用 egress IP 唔再係問題。Code 全部接好
（`COINGECKO_API_KEY` + `COINGECKO_API_PLAN=demo` → `x-cg-demo-api-key` 每個 request 都帶，
`/health.gecko.keyed` 係讀數）⇒ **加 secret 就通，唔使改一行 code**。

**但預算要重算。** 每 tick 最多 4 次（新_pools 1 ＋ trending 1 ＋ tracker 快照
`TRACKER_GECKO_LOOKUPS=2`）＝ 43,200 tick/月 × 4 ＝ **172,800/月＝超額 17 倍**：

| 方案 | calls/月 | 結論 |
|---|---|---|
| 現狀（4/tick） | 172,800 | ❌ 17× |
| 熄 tracker 快照（2/tick） | 86,400 | ❌ 8.6× |
| 熄 trending（1/tick） | 43,200 | ❌ 4.3× |
| **一條腿、每 5 分鐘一次** | **8,640** | ✅ 用 86%，餘 1,360 |

最後一行唔可以靠 cache 自動省（上游 `s-maxage=60`），要喺 **code 層**加「gecko origin 呼叫
最短隔 300 秒」嘅閘，`cacheTtl: 300` 當後備而唔當保證。配 `GECKOTERMINAL_TRENDING_LIMIT=0`
（momentum 交畀 `jupTrend`）＋ `TRACKER_GECKO_LOOKUPS=0`（tracker 已有 Dex／Jupiter）就啱。

**未驗的一格**：Demo key 會唔會被 v2 host 認（而唔止 v3）。加咗 key 一行就分曉：
`keyed true` ＋ `lastStatus 200` ⇒ 認；`keyed true` ＋ `lastStatus 429` ⇒ v2 唔認，
咁就把 `BASE_URL` 換 v3（`parseNewPools` 已食同一 payload，09-21 乾淨主機 20/20 全中）。 ### 七、不加 key 嘅兩個選擇

1. **熄咗佢，承認降級**（推薦）：`GECKOTERMINAL_TRENDING_LIMIT=0` ＋（如可）pool pages 歸 0。
   慳每 tick 1–4 個 subrequest（啱啱做完 subreq 預算修正，呢度最平），代價係第五節嗰層冗餘，
   而家由 pump.fun／Meteora／jupTrend 補緊。
2. **外部 pinger 幫手暖 cache**（實測有效、但冇 SLA）：任何**非 Worker 出口**（本機、
   1 U$ VPS、GH Actions cron）每 <60s 打一次嗰兩條 URL，Worker 嘅 `cacheEverything` 就持續 HIT，
   `geo` 唔會長期 0。1 次/分鐘遠低於 5/min 所以合法，但 (a) 要同一個 DC 先中，
   (b) 上游一改 `s-maxage` 就失效 ⇒ **只可當過渡，唔可以當長線方案**。

### 八、驗收點（將來加咗 key）

```bash
curl -s .../health | jq '.heartbeat.summary | {geo, geoTrend, gecko: .gecko.keyed}'
# 期望：keyed true、lastStatus 200、requests/日 ≈ 288（一條腿每 5 分鐘）
```

若果 `keyed true` 但 `lastStatus 429` 兼 `requests` 每 tick 照加 ⇒ v2 host 唔認 key，轉 v3
（或者確認 Demo quota 係咪只計 v3，咁就要將 gecko 整條腿搬去 alt host）。
