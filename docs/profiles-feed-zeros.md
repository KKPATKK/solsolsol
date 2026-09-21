# `profiles 0` 一個鐘：feed 冇壞，係 tick 嘅**前段**食咗 feed 嘅窗口

2026-09-21 04:30–05:40Z 量度（live worker `solana-meme-bot.cool1999k.workers.dev`：
`/debug/scan-history`、`/debug/tick`、`/debug/crime-wallets`、`/debug/dex429`）。

## 症狀

| 觀察 | 數值 |
|---|---|
| 最後一個鐘嘅 tick | 45 個 `profiles 0` / 只有 7 個有 feed（>50% 至 ~75% 視乎 10 分鐘窗口） |
| `profiles 0` 嘅 tick `ms` | 平均 **4737ms**（1770–10423） |
| 有 feed 嘅 tick `ms` | 平均 **2829ms**（1675–5262），`profiles` 平均 23 |
| 分界 | **04:30Z** 之前 ~20% 係 0（03:50 6/9、04:10 2/10、04:20 2/8），04:30Z 之後 60–90%（04:30 9/11、05:10 11/12） |

## 決定性量度：client 由頭到尾冇被叫過

`/debug/tick` 連環取樣（每個 request 自己跑一次 scan，所以有 summary）：

```text
i=1  totalMs 4934  profiles 31  feedsMs 492  feedReq 1  raw 25  injected 6
i=2  totalMs 4686  profiles  0  feedsMs   0  feedReq 0  raw  0  injected 0   ← pool 99、dbMs 932
i=3  totalMs 5830  profiles 31  feedsMs 279  feedReq 1  raw 25  injected 6
i=4  totalMs 4049  profiles 31  feedsMs 279  feedReq 1  raw 25  injected 6
```

`feedsMs 0` 係關鍵：整個 feed fan-out **一瞬間**返晒空。`fetchFeedCapped` 喺剩餘窗口
< 250ms 時係**直接 return `empty`、唔會 dispatch**，所以 `feedRequests 0`＝DexScreener client
由頭到尾冇被呼叫。而 `pool 99` 證明 scan 之後照跑 —— 即係**唔係上游出問題，係 tick 前段
用晒 900ms 窗口**（`FEED_DEADLINE_MS`）先去到 fan-out。

## 前段食窗口嘅係邊個

`startedAt` 之後、feed phase 之前只有兩步：`listEnabledChats()`（一次 Turso round trip）
同 `crimeWallets.refreshIfStale()`。第二個就係兇手：

| 量度 | 數值 |
|---|---|
| `/debug/crime-wallets?refresh=1`（worker 自己 egress） | **2.8s / 3.6s**（列表 4816 個地址） |
| 列表本身（GitHub raw，另一 egress） | 216,424 bytes、0.32s → 網絡唔係主因，**parse + 216KB re-persist** 係 |
| `?refresh` 以外嘅 status call | 0.36–0.40s（warm）／2.2s（cold isolate） |
| **cold isolate 頻率** | `crime_wallets_updated_at`（DB，跨 isolate）05:42:14 → 05:43:04 → 05:43:40 ⇒ **每 25–45 秒就有一個 cold isolate 跑第一個 tick** |
| `dex429` ring | total 1870、lastHour 22（慢性 drip，但 429 只係 ~320ms 內結束，**唔會**造成 `feedsMs 0`） |

一件 2.8–3.6s 嘅 cold-start 工作，等喺一個只有 900ms 嘅窗口之前 ⇒ 窗口幾乎**永遠**冇得剩，
`profiles 0`（同時 `pump/geo/jup/gmgn/axiom` 全部 0）就成為常態。cold isolate 之所以貴，
係因為 TTL 同副本都住在 isolate 記憶體：每次 recycle 都要重新 download + 重新 persist 216KB。

即係：**同一個 upstream，同一個 429 環境，04:30Z 前後嘅分別係 cold tick 佔比**，
唔係 DexScreener 忽然壞 —— 上游對其他 egress 一直係 200 / ~60-85ms。

## 修法（三層，全部有單元測試）

| 位置 | 變更 |
|---|---|
| `scanner.ts` | profiles fetch **喺 tick 開頭就 dispatch**（`profilesCall`），到 call site 才 await —— window 由 tick 起計，前段幾慢都唔再偷得走；`fetchFeedCapped(..., inFlight)` 對「已經在飛」嘅 call 廢除 250ms floor，只由 deadline 決定 |
| `scanner.ts` | call site 嘅 `empty` 由 `[]` 改成 **pending make-up 幣**（deferred lane）—— 即使窗口真係冇，tick 都唔會「乜都冇評估」（`docs/push-baseline-ledger.md` 本來就記咗要咁做） |
| `scanner.ts` | 新增 `preFeedMs`（tick 起 → fan-out 起）同 `profilesSettled`（call 有冇喺窗口內答）—— 今次缺嘅就係呢兩個數 |
| `crimewallets.ts` | TTL 改成**全 fleet 共用**：cold isolate 由 `worker_state` 嘅副本 + 時間戳 hydrate（兩次讀），只有時間戳過期（6h）才真係上網；寫入次序改成**先 list 後 stamp**，令 stamp 永遠唔會早於佢所認證嘅副本 |

## 驗收（deploy `d493dcb` 之後，實測）

- `scan-history` 200 行（03:38–06:41Z）：`profiles==0` 由 **66%（114/172）跌到 4%（1/28）**；
  部署後 28 行裡 25 行 `profiles 20–30`、2 行 `6`（make-up lane）、1 行 `0`。
- `/health.summary.feedMakeup`：`lastRawProfiles 21–23`、`injectedTotal` 每 tick +6、
  `emptyFeedTotal 0`、`failedTotal 0` —— 上游答得到，make-up 疊加正常。
- 出事的形狀親眼見到一次：`pre 847 / feedsMs 0 / profiles 29` —— 前段食咗 847ms（窗口 900ms），
  但因為 call 喺 tick 開頭已經飛出去，答案照樣拿到 29。
- `/debug/crime-wallets` 嘅 `persistedUpdatedAt` 連續 5 次取樣**完全不動**（改為每 6 小時一次）；
  冷 isolate 出現 `loadedFrom: "persisted"`（零上網 hydrate），`?refresh=1` 走 network 且 stamp 與副本一致。

## 順帶發現（唔屬今次改動）

`solana-meme-bot.cool` 目前**全球 NXDOMAIN**（Cloudflare DoH 同 Google DoH 都係 `Status: 3`，
authority 係 `.cool` TLD 自己嘅 SOA）——即係個自訂域名已經冇 delegation（過期／被刪），
`.cool` 嘅 RDAP 主機亦連唔到。Worker 本身完全正常，只係要經
`https://solana-meme-bot.cool1999k.workers.dev` 入。

---

# 後續（2026-09-21 同日）：其他 feed 一樣被前段偷窗口

profiles 修好之後，逐個 feed 量度，發現**同一類問題還有四個 feed**，另加兩個上游死亡。

## 量度

| feed | 實測 | 判定 |
|---|---|---|
| profiles | raw 21–23 + make-up 6 → 27–29，`failedTotal 0` | ✅ 已修好 |
| pairs（batch） | tracker note `rows 10/24 pairs 10/10` | ✅ |
| jup recent | `/debug/jupiter` recent 5；每 tick `jup 20`，但**間中 `jup 0`** | ⚠️ 窗口被偷 |
| geo（new_pools） | worker egress 3/3 → **429**「You've exceeded the Rate Limit」；同一 endpoint 由普通 host → **200 / 29KB** | ⚠️ 依 IP 限流 + 窗口被偷 |
| geoTrend | 全部樣本 0（同一個 client、共用 backoff） | ⚠️ 同上 |
| jupTrend | `/trending/24h` → HTTP 200 但 body `[]`（2 bytes），普通 host 都一樣；`/toporganicscore/24h` → 7691 bytes 有數據 | ❌ 上游端點已空 |
| pump.fun | `frontend-api.pump.fun/coins` → **530 / CF 1016**（origin DNS 冇了） | ❌ 上游已死（設計上由 jup recent 代替） |
| gmgn | `/debug/gmgn` → 429 | ❌ 已知被擋 |
| axiom / arkham | `AXIOM_TRENDING_LIMIT=0` / 無 key | ⚪ 設定關閉 |
| birdeye backfill | `/debug/backfill` fetched 140 seeded 140 | ✅ |

至於「每 tick 有無問題」：200 行裡 `ok 159`，41 個 notOk **全部 ≤ 06:25:10Z**（部署前）；
部署後 28 行裡 27 ok（唯一一個係我自己的 `/debug/tick` probe）。
節奏 median 63s / p90 81s / max 118s，`gaps>120s: 0`。

## 修法（三層）

| 位置 | 變更 |
|---|---|
| ~~`scanner.ts`~~ | ~~pump / geo / geoTrend / gmgn / axiom / jup recent / jupTrend 全部改為 tick 開頭 dispatch（`startFeedCall`）~~ —— **同日內已 revert**，見下面「為什麼 revert」 |
| `jupfeeds.ts` | trending leg 由死掉的 `/trending/24h` 改指 `/toporganicscore/24h`（同日實測：top 20 裡 4 個落在年齡窗內：12.5h–24h、mcap 177K–4.0M、organic 75+） |
| `tickprobe.ts` | `summary.gecko` 移出 `captured.length > 0` 的 guard —— 所有 `markPhase` 都在 per-candidate 鏈裡，所以「0 candidate」的 tick（多數 tick，而且正正就是 `geo 0` 的形狀）以前**乜都唔發佈**，解釋 `geo 0` 的數字剛好在需要時讀不到（live：8/8 次取樣都缺） |

## 為什麼 revert 咗 scanner 那一半

`4434fe6` 部署後即刻量到：

| 窗口（同一份 scan-history） | 行數 | ok | `died before its completion flush` | race cut | ms median |
|---|---|---|---|---|---|
| 06:24–07:02（`d493dcb`，即改動前） | 48 | 44 | **0** | 4 | 2928 |
| 07:02+（`4434fe6`，改動後） | 7 | 3 | **3** | 1 | 5000 |

`died before its completion flush` 就是 `worker.ts` 描述的 **~9.6s cron kill** 那一類：tick 的 wall clock 超出殺點，
完成寫入來不及落地（同一類在 2026-09-15/16 都以每分鐘一行連續出現過）。同一個 envelope 的註釋本身就寫住
「Never widen this number to make room for a new tail stage」—— 9.5s 預算裡再塞七個 tick 開頭就飛出去的 feed，
就是這個 envelope 最唔想見到的事：被跳過的 feed（約五分一 tick）現在一定跑，而且它們的 throttle sleep + JSON 解析
同 eval 階段爭同一個 isolate，令本來 2.9s 的 tick 拉長到撞殺點。

所以 scanner 那一半已 `git apply -R` 還原（`docs/patches/feed-early-dispatch-revert-scanner-test.patch`），
保留兩個不會加 tick 負擔的：`jupfeeds.ts` 的 endpoint 修正（同一個請求，但終於有回報）
同 `tickprobe.ts` 的 `summary.gecko`（只係 summary 多一個細 object）。

要再試 feed-window 這個方向，正確做法係先分清「邊個 feed 值一個請求」——例如 pump.fun（530）同 gmgn（429）
係死上游，每次請求都係純浪費，應該先把它們從 fan-out 拿掉，騰出的 budget 再餵給一個 feed，每次只加一個。

## 驗收（今次）

- 單元測試 **242 passed / 0 failed**（新增：`JupTokensClient: the trending leg reads /toporganicscore/24h`；`test-tick-path.js` 新增「0-candidate tick 仍要發佈 `summary.gecko`」斷言）。
- Live（`4434fe6` 部署後，`/debug/tick`）：`prof 26 / settled true / jup 20 / **jupTrend 15** / gecko 有值` ——
  死掉的 trending leg 終於有 15 個幣進來，而且 `summary.gecko` 在 0-candidate tick 上讀得到（之前 8/8 次取樣都缺）。
- 跟進：revert 之後再量同一組窗口，確認 `died before its completion flush` 是否回到 0——未完成，見下一輪 push。
