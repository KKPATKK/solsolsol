# 2026-10-17：首推送卡的「🔕 停止追蹤」按了沒反應 — inbound 通道唔存在

**回報**：推送卡上的 `🔕 停止追蹤` 按咗冇反應。
**結論**：**唔係按鈕壞，係 Telegram 根本冇把嗰下 tap 送過嚟。** Bot 嘅 webhook 註冊
當時係空的（`getWebhookInfo` → `url: ""`），而寫卡片係 OUTBOUND，唔需要 webhook，
所以掃描照跑、卡照推、`/health` 照 `ok` —— 唯一死嘅係「入嚟嘅嘢」。

## 1. 證據（live，2026-10-17 02:00Z 前後）

```
GET /debug/webhook
{"ok":true,"telegram":{"ok":true,"result":{"url":"","has_custom_certificate":false,"pending_update_count":0}}}
```

同一個 Worker 嘅其他讀數全部正常：`botReady true`、`scannerReady true`、
`scheduledTickTotal 87382`、`pushedTotal 1266`。即係「推送得到、收唔到」——
一個只有 webhook 註冊會壞成咁嘅形狀。

**為什麼一直冇人發現**：呢個註冊從來唔屬於 repo。它係一次手動
`/debug/webhook?set=1` 寫落 Telegram 嘅外部狀態，deploy 唔會碰它、`/health`
唔會驗它、推送唔需要它。所以它靜靜消失之後，系統每一盞燈都仍然係綠。

## 2. 修正（兩層）

1. **即刻**：`GET /debug/webhook?set=1` 重新註冊
   `https://solana-meme-bot.cool1999k.workers.dev/webhook`，Telegram 答
   `Webhook was set`；再讀一次，`url` 已經係上面嗰條，`max_connections 40`。
2. **唔再靜靜死**：`src/worker.ts` 嘅 **maintenance delivery**（`*/5`，本身係
   「結果冇人等」嘅 invocation）每次開頭跑 `maybeHealTelegramWebhook`：
   `getWebhookInfo` → 唔等於自己嗰條 `/webhook` 就 `setWebhook`。
   放喺 maintenance 而唔係 tick 或 `ensureInitialized`：tick 的 front init 只得
   `FRONT_INIT_BOUND_MS = 3.5s`，塞一個 Telegram round trip 入去係拿卡片嘅鐘嚟賭；
   而且它跑在 `if (!scanner) return` **之前**，init 被切斷時仍然會做。
   整段有 `WEBHOOK_HEAL_BOUND_MS = 4s` 上限，`ensureTelegramWebhook` 永不 throw
   （失敗只係 `failed` 加一行 log）。

**故意唔送 `allowed_updates`**：default 集合包含 `callback_query`；一旦寫死一個子集，
就會得到「收到訊息、收唔到按鈕」—— 同今次一模一樣嘅症狀，但更難查。

**讀得到**：`/debug/webhook` 除咗 Telegram 原始答案，仲回報 `selfHeal`
（`at` / `url` / `result`: `ok`|`set`|`skipped`|`failed`|`timeout`），
所以「heal 有冇跑」唔再只係 isolate 內嘅一行 log。

## 3. 驗證（真 update，唔係只看 code）

修好註冊之後，向 `/webhook` POST 一個真形狀嘅 `callback_query`
（admin `530602939`，`data: "unwatch:<mint>"`）：

| 觀察 | 結果 |
|---|---|
| `push_watch` 該行 `lastState` | `rug` → **`unwatched`**（`/debug/push-watch` 讀回） |
| 同一個 update 換成唔認識嘅 prefix（`noop:x`） | 200，handler 早退 |
| `unwatch:` 嘅 HTTP status | **500** —— 見下面 |

**500 係測試自身嘅產物，唔係按鈕壞**：我偽造咗 `callback_query.id`，
handler 行到最後 `answerCallbackQuery` 時 Telegram 回 400
（`query is too old … query ID is invalid`），grammY 於是回 500。真 tap 嘅 id 係
新鮮嘅，同一句會成功。寫入（`unwatched`）已經喺嗰句之前 commit，所以
「update 有到 → admin 閘門 → D1 寫入」三格全部有讀數，
剩低嘅只有「toast 出唔出」。

用嘅 token 係 `TOAST`（`last_state` 原本已經係 `rug`，兩邊都係 terminal、都唔會再
發跟進卡），所以呢次驗證冇令任何仍活躍嘅幣被停止追蹤。

## 4. 界線

- **Heal 嘅節奏 = maintenance delivery 嘅節奏（5 分鐘）**，加上任何一次 deploy。
  如果 maintenance 自己都收唔到 cron，就要人手 `/debug/webhook?set=1`
  （或者等下一次 deploy）；呢一層係刻意的取捨 —— 把檢查放進 tick 就要拿卡片鐘找數。
- **註冊 URL 嚟自 `CRON_RELAY_URL`**（Worker 自己嘅 public origin）。換 domain 而
  `CRON_RELAY_URL` 冇跟住改，heal 會指向舊 host；兩者要一齊改。
- **`answerCallbackQuery` 仍然係無 catch 的**：真 tap 正常路徑會成功；但如果 handler
  用超過 Telegram 嘅 answer window（~10s）才答，toast 會被拒而 handler 會回 500
  （Telegram 會重試該 update，D1 寫入係 idempotent）。今次冇改，因為 unwatch 路徑
  正常係 ~200ms，而同一個 500 喺測試以外未見過。
- **呢個 file 記錄嘅係「收唔到 update」**，唔係「收到但 handler 壞」。真 tap 若仍然
  無反應，下一步係讀 `last_state`：變 `unwatched` = handler 好、係 toast 被拒；
  冇變 = handler 或 DB 出事。
