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

## 驗收

待 deploy 後補：

- `scan-history` 嘅 `profiles` 唔再係 0（或顯示 `profilesSettled: false` + make-up 條數）
- `/debug/crime-wallets` 嘅 `persistedUpdatedAt` **唔再每 25–45 秒跳**（改為每 6 小時一次）

## 順帶發現（唔屬今次改動）

`solana-meme-bot.cool` 目前**全球 NXDOMAIN**（Cloudflare DoH 同 Google DoH 都係 `Status: 3`，
authority 係 `.cool` TLD 自己嘅 SOA）——即係個自訂域名已經冇 delegation（過期／被刪），
`.cool` 嘅 RDAP 主機亦連唔到。Worker 本身完全正常，只係要經
`https://solana-meme-bot.cool1999k.workers.dev` 入。
