# 2026-10-17：每張卡自己交代有機度，同「每窗口留一槍」

兩件改動，同一個病根：卡片嘅 🌱 有機度 只係「今個 tick 最後一次讀」嘅讀數，而讀
嗰一下又排在一 tick 嘅 bulk 請求後面 —— 所以「呢張卡有冇線、閘有冇睇過」事後查唔到，
而且成日輸在窗口已經用盡。`7dc59df`（deploy run `38995856275`）。

## 1. 每張卡一行：`push_audit` 加 `organic`

`Db.recordPushDelivery` 嘅 entry 多一個 `organic`（只係 initial card 會帶）：

| 欄 | 意思 |
|---|---|
| `score` | 卡上印嘅 Jupiter organic score（`null` = 卡冇印線） |
| `tradersH1` | 卡上印嘅交易者數（`null` = 任何 window 都冇） |
| `tradersWindow` | 嗰個數嚟自 `1h` / `6h` / `24h` / `null`。**必要**：1400 ceiling 只judge `1h`，`6h`/`24h` 代表閘故意冇睇 |
| `why` | 讀數嘅原因（`JupCardReadWhy`），另有兩個只出現在 audit 嘅值（見下） |
| `waited` | 嗰次讀有冇先等完 429 窗口 |

**`why` 嘅兩個 audit-only 值**（`scanner.cardOrganicAudit`，pure、有單元測試）：

- `null` —— 卡 render 之前讀數未返，所以呢張卡**冇原因**（唔係 `ok`，亦唔係 `empty`）；
- `late` —— 讀數**有**返，但係喺卡 render 之後。呢個 shape 係出「卡冇線但讀數其實存在」時
  最需要分辨嘅：卡上冇線、亦冇任何閘 judge 過佢，寫 `ok` 就會講成「線有印、閘有睇」。

**點解要 per card**：`JupTokensClient.cardReadNote()` 係 last-call-wins，一個 tick 有
兩張卡同時讀就會蓋錯。所以 scanner 喺 slot 隔離開個 `organicNote` box，由嗰個讀嘅
callback 填，然後同 render 用嘅同一個 snapshot（`organicReading`）一齊 stamp：
**卡印乜、audit 就寫乜**，事後逐張卡查得返。

**讀返**：`/debug/push-audit?token=<mint>` 直接回 entry（ring 原樣），所以新卡會有
`organic`，舊卡（改動前寫入）冇。ring 上限 200 條（`Db.PUSH_AUDIT_MAX`），一張卡一行。

## 2. 每窗口留一槍（`JUP_RESERVE_CARD_SLOT`，默認開）

量到嘅事實（2026-10-17，本 repo 自己 egress）：lite-api 係 **5 requests / ~10s**
（`x-ratelimit-current: 5`），而一個 tick 嘅 bulk 腿——兩個 discovery feed 加 pair
fallback 嘅 chunk（DexScreener pair lane 全族被拒之後，每 tick 都跑、帶住全部地址）——
剛好花光五發。第六發就係卡片嘅讀：`organicWaited` 就係「等到窗口開」嘅讀數，
等唔到就係一張冇線嘅卡，而嗰個讀同時係三個 Jupiter 閘嘅唯一讀數。

所以：**bulk 每窗口最多 4 發，第 5 發留給卡片**（`jupfeeds.JUP_WINDOW_BULK_MAX`）。
判斷喺 **dispatch 嗰刻**，唔係 enqueue 嗰刻——throttle 可能壓住個 request 一秒，
要計嘅係它真正落地嘅窗口。被 stand down 嘅 bulk call 回 `null`（同「provider 打唔通」
同一個答案），另外用 `bulkStoodDownCount()` 計住，所以兩者事後分得清。

**代價，照直講**：帳面係 coverage。窗口滿咗嗰刻到達嘅 bulk call 就唔發——實際係
pair fallback 嘅最後一個 chunk（~100 個地址），嗰批 token 保留 re-eval slot，下個 tick
再讀。`diag.jupReserved` 就係「今個 tick 用幾多 coverage 換咗卡片嘅線」嘅讀數（per tick，
唔係 isolate 累計）。

**唔係萬能**：ledger 只數**同一個 client**（每個 isolate 一個）嘅 dispatch，睇唔到其他
isolate。呢度夠用，因為關窗口嘅就係嗰個 tick 自己嘅 bulk burst。真係要熄：
`JUP_RESERVE_CARD_SLOT=0`（junk / 未設 = 開）。

## 3. 驗證

**單元（567 + 其餘 9 個 suite 全 0 failed）**
- `cardOrganicAudit`：健康卡、`waited`、`backoff`、`late`、冇 note、`6h` fallback 六個 shape。
- 窗口：5 個 bulk → 4 發出去、第 5 個 stand down、`bulkStoodDownCount()===1`；跟住
  `fetchOrganicScore` 仲係上到線（第 5 發），窗口變 5；再一個 bulk 又 stand down；
  `JUP_RESERVE_CARD_SLOT=0` 回舊行為（5 發全出）。
- 接線 pin：per-card note box、`organic: cardOrganicAudit(organicReading, organicNote)`
  喺 initial card 嘅 `recordPushDelivery` 裡面、`diag.jupReserved` 係 per-tick delta。
- Mutation（改 dist 再跑）：`"late"` → `note.why` 令 audit 測試紅；
  `JUP_WINDOW_BULK_MAX = 5` 令窗口測試紅。兩次都重 build 返綠。

**Live（deploy 之後，run `38995856275`，02:43:21Z 完成）**
- `/debug/tick` 嘅 summary 已帶 `jupReserved`，而且量到 **`jupReserved: 1`**
  （同一個 tick `jup 30 / jupTrend 7 / pairsJup 200`）：bulk 到 4 發就停手，第 5 發
  讓咗俾卡片 —— 即係話以前嗰發會落到 pair fallback 嘅最後一個 chunk，而家唔落。

## 4. 驗收：deploy 後第一張新卡（HIVEMIND）

```
/debug/push-audit?token=6NLUC3veg7NGuQBNewE1UM7G6ir2mymJM4PvwdkGpump
{"chatId":"530602939","token":"6NLUC3veg7NGuQBNewE1UM7G6ir2mymJM4PvwdkGpump",
 "symbol":"HIVEMIND","messageId":12922,"mcapAtPush":221006.4,"kind":"initial",
 "organic":{"score":57.44429696043526,"tradersH1":873,"tradersWindow":"1h",
             "why":"ok","waited":false},
 "at":1792205559798}                      ← 2026-10-17T02:52:50.640Z
```

逐項對得上：`score 57.44` 在 55 floor 之上、`tradersH1 873` 在 1400 ceiling 之下、
`tradersWindow "1h"` 所以 ceiling **真係** judge 過嗰個數、`why "ok"` 代表卡印咗線、
`waited false` 代表呢次讀冇再等 429 窗口 —— 而同一時間 `jupReserved` 係 1，即係
「留一槍」真係做緊嘢。

**界線**：deploy 之後嘅第一張卡係 02:52:50Z，中間 9 分鐘冇 initial card（followup 照出），
所以呢個係「第一張」而唔係「連續 N 張」嘅讀數；`waited` 要等一張在窗口緊張時推嘅卡
才會變 true，嗰個仍然係未量到嘅 shape。
