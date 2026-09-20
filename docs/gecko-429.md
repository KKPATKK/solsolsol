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

## 為何唔係降頻／換源

- **降頻冇用**：quota 唔係我們嘅用量造成（共用 egress IP 被其他 Worker 用光），
  拉到 90s 只係少一半請求，仍然係食 429。
- **換源**＝CoinGecko Onchain API（付費 key、`x-cg-demo-api-key`，要換 endpoint 同整條 client）。
  如果快取都唔生效，呢個係下一步，等 operator 決定（有 key 我可以接）。
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

## 單元測試（`test:unit` = 218 passed）

- `GeckoTerminalClient: every call asks for the Cloudflare edge cache`
  —— 釘住 `cacheEverything` / `cacheTtl` / `400-599: 0`，同 `cacheHits` 有計數；
- `GeckoTerminalClient: consecutive 429s escalate the pause; a success resets it`
  —— 第一次 5 分鐘、第二次更長、backoff 期間**零請求**、成功清零；
- `geckoBackoffMs / parseRetryAfterMs: Retry-After wins, capped`
  —— 純規則：加倍、封頂、硬上限、秒數／HTTP-date 兩種 `Retry-After`。

（原有嗰條 `GeckoTerminalClient backs off all calls for 5 min after a 429` 保持不變：
今次改動令第一次 429 嘅行為同以前一致。）
