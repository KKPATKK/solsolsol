# Uptime Monitor 設置指南（掃描器保險）

> 背景（2026-08-14 事件）：Cloudflare Cron Trigger 目前**沒有投遞** scheduled
> 事件（schedule 已綁定、API 重建過、最新版本在跑，但 Worker 端 pre-init
> 計數 25+ tick 全為 null —— 屬 Cloudflare 平台端問題，需 dashboard toggle 或
> 支援介入）。
>
> 掃描器已改為**由 HTTP 請求驅動**：每次 `/health` 請求都會在背景觸發一次
> 完整掃描（`ctx.waitUntil` 保證掃描在 isolate 內跑完），並寫入心跳
> （`heartbeat.at` = 最近一次掃描完成時間）。
>
> **設一個外部監控每 1 分鐘 ping `/health`，bot 就能不依賴 cron 正常掃描
> 推送**（掃描節奏為每 ~1 分鐘一次：cron 每分鐘觸發，worker 以 DB 心跳做
> 60 秒間隔閘門；如上游 429 壓力回升，可把 SCAN_INTERVAL_SECONDS 調回 90
> 改為 ~2 分鐘一次）。cron 修好後，監控變成雙保險（cron + 監控都驅動掃描；
> 掃描器有 running 鎖保護，重疊呼叫只會跳過，不會重複推送）。

---

## 監控目標

| 項目 | 值 |
|---|---|
| URL | `https://solana-meme-bot.cool1999k.workers.dev/health` |
| 期望回應 | HTTP 200 + JSON body（含 `"ok":true`） |
| 建議檢查間隔 | **1 分鐘**（維持原有掃描頻率） |
| 注意 | `/health` 永遠回 200（即使掃描停擺也回 200）——「Down」只代表 Worker 不可達；掃描健康要看心跳時間 |

---

## 方案比較

| 服務 | 免費額度 | 檢查間隔 | 適合 |
|---|---|---|---|
| **HetrixTools**（推薦） | 15 monitors | **1 分鐘** | ✅ 免費 + 維持 1 分鐘掃描 |
| UptimeRobot | 50 monitors | 5 分鐘 | 品牌熟、註冊最快；掃描降為 5 分鐘一次 |
| UptimeRobot Solo | 付費約 $7/月 | 1 分鐘 | 想用 UptimeRobot 又要 1 分鐘 |

> Freshping（Freshworks）已於 2026-03-06 關閉，不要再選。

---

## 方案 A：HetrixTools（推薦 —— 免費 1 分鐘）

### 1. 註冊
1. 開 https://hetrixtools.com ，用 Email 註冊（免信用卡）。
2. 收驗證信並啟用帳號，登入 dashboard。

### 2. 新增 Monitor
1. 左側選單 → **Uptime Monitor**（或主頁 **+ Add Monitor**）。
2. 填寫表單：

   | 欄位 | 值 |
   |---|---|
   | Monitor Name | `Solana Bot Scanner` |
   | Monitor Type | **HTTP(S)** |
   | URL | `https://solana-meme-bot.cool1999k.workers.dev/health` |
   | Check Interval | **1 minute**（免費可用） |
   | Check Locations | 保留預設（2 個即可；多一個 location = 多一次 ping/分鐘，掃描器鎖會擋重疊） |
   | Timeout | 預設即可（如可選，設 30 秒） |

3. **Keyword 檢查（可選，較準）**：設 keyword = `"ok":true`，條件選
   **「必須存在」**——body 不正常時會觸發告警（比純 200 更早發現問題）。

### 3. 通知設定
1. 左側 **Contact Groups** → 確認或新增你的 Email（註冊時通常已有預設）。
2. 可選：在 Monitor 的 Alert 設定裡綁定 Telegram / Slack / Webhook 通知。

### 4. 儲存並驗證
1. Save 後等 1–2 分鐘，Monitor 狀態應顯示 **Up**。
2. 開 `/health`（瀏覽器或 curl），看 `heartbeat.at`：
   - 第一次請求時：`heartbeat.at` 是**幾秒前**（這次請求觸發的掃描）。
   - 隔 1 分鐘再開：`heartbeat.at` 應又前進一次 → **監控已接管掃描節奏**。
3. 若 `heartbeat.at` 超過 3 分鐘沒動：看 `/health` 的 `lastSkip`、`initError`、
   `scheduledTickTotal` 欄位，把內容回報。

---

## 方案 B：UptimeRobot（免費，5 分鐘）

1. 註冊 https://uptimerobot.com（免信用卡）。
2. Dashboard → **+ Add New Monitor**：

   | 欄位 | 值 |
   |---|---|
   | Monitor Type | **HTTP(s)** |
   | Friendly Name | `Solana Bot Scanner` |
   | URL | `https://solana-meme-bot.cool1999k.workers.dev/health` |
   | Monitoring Interval | **5 minutes**（免費上限；1 分鐘需付費 Solo 方案） |
   | Alert Contacts | 預設 Email |

3. **Create Monitor**，等第一個檢查週期（最多 5 分鐘）→ 狀態應為 **Up**。
4. 驗證同方案 A：隔 5 分鐘看 `/health` 的 `heartbeat.at` 有前進。

---

## 驗證清單（通用）

- [ ] Monitor 顯示 **Up**（HTTP 200）
- [ ] `curl -s https://solana-meme-bot.cool1999k.workers.dev/health` 回傳 `"ok":true`
- [ ] 間隔一個檢查週期再看一次，`heartbeat.at` **有前進**
- [ ] （可選）`heartbeat.summary` 有資料：`profiles` ≈ 20+、`pool` ≈ 200+

### 心跳停擺時的判斷

| `/health` 欄位 | 代表 |
|---|---|
| `heartbeat.skip = "previous-scan-still-running"` | 上一次掃描卡住；鎖有 25s 時效，下一 tick 自動重試 |
| `lastSkip = "no-chats-enabled"` | 所有 chat 的 push 被關閉（`/on` 重開） |
| `lastSkip = "empty-feed-and-pool"` | DexScreener feed 與追蹤池都空（資料源問題） |
| `initError` 非 null | Turso 初始化失敗（DB 健康度） |
| `scheduledTickTotal` 持續 null | cron 沒投遞（本事件背景） |

---

## 原理（為什麼這樣能救命）

- 每次 `/health` 請求 → Worker 背景跑一次完整掃描（waitUntil 保持 isolate
  存活直到掃描完成）→ 寫入心跳。
- 外部監控每 1 分鐘 ping → 掃描維持在 ~1 分鐘一次（cron 的 60s 間隔閘門
  對齊 1 分鐘 cron；監控 ping 只是補充驅動，不會加速超過閘門）。
- 掃描器有 running 鎖（25s 時效自動打破）+ SCAN_INTERVAL_SECONDS=60 的
  心跳間隔閘門（跨 isolate），cron 與監控同時驅動也不會重疊或重複推送。
