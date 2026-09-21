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
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(10_000),
  cf: {
    cacheEverything: true,          // Worker subrequest 默認唔用 cache
    cacheTtl: GECKO_CACHE_TTL_S,    // 60s ＝ 上游自己嘅 s-maxage
    cacheTtlByStatus: { "200-299": 60, "300-399": 0, "400-599": 0 },
  },
});
```

- Worker 嘅 subrequest **默認唔會**用 Cloudflare cache，所以過去每一次都係打去 origin
  （被共用 IP quota 擋）；`cacheEverything` 令佢加入邊緣快取 —— 命中就唔會再撞 rate limiter。
- TTL 60s ＝ 上游自己嘅 `s-maxage`；discovery 只用 `pool_created_at`，而幣要 **80 分鐘之後**
  才入合格窗口，所以遲一分鐘完全冇影響（tracker 嘅 snapshot 亦然）。
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
- 唔係全 host mirror：`trending_pools` 喺呢個 host **keyless 係 401**
  （`Requests without API key are not allowed for this endpoint`），所以 fallback 係 **per-path**。

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
- **探針**：`/debug/gecko-alt` —— 同一個 URL 兩種打法（有／冇 `cf` 快取選項），
  回 status、`cf-cache-status`、body 頭 200 字，用嚟分辨 WAF 擋、要 key、同快取選項本身。

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

**截至此刻嘅結論**：免費 alt host **由 Worker egress 用唔到**（403）。免費路徑就係原本嘅
keyless 主 host ＋ 快取（同一批讀數裏面 `ok 0 429 2`，即係主 host 都仍然被封），
而 gecko 貢獻 0 **唔影響其他 feed**：同一時間 `profiles 27–28`、`jup 20`、`jupTrend 15`。
下一步只有三種：**帶 key**（`COINGECKO_API_KEY`，CoinGecko 對 keyed 流量用另一條路；未驗證）、
**另一個 keyless 源**、或者**接受 gecko 降級**（re-eval pool ＋ Birdeye backfill 兜住）。

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
