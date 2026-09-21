# 掃描「停止」嘅真相：completion flush 冇落地，唔係冇掃描

2026-09-19 21:18 → 23:46Z 量度（`/debug/scan-history` 120 行 ring、`/health.tickRing`、
`/debug/pushes`，全部即時抓，worker `solana-meme-bot.cool1999k.workers.dev`）。

## 量度

| 觀察 | 數值 |
|---|---|
| cron 交付 | `tickRing` 全程每 60s 一次、**零斷層** → cron 冇事 |
| 真掃描 row / dead-backfill row | **55 / 65**（2.5 小時）→ **約 44% 嘅 tick 冇完成 row** |
| dead 行嘅 `at` | 多數係 `:07`／`:08`（cron 係 `:06.8`）→ claim 喺 tick 開頭 **0.2–1s** 就落 → **唔係前段慢** |
| 完成嘅 tick | `ms` 1684–5000；durable `phases done` 3169–3351ms → **9.5s 信封冇爆** |
| dead 行 `ms` | 60–113s（＝上一個 tick claim 到後繼偵測，即一個 60s cadence） |

`outageAlertAt` = `2026-09-19T23:32:08Z` → 新嘅 completion-based alert 響過，就係 Telegram
收到嘅「連續約 N 分鐘沒有完成任何一次掃描」。

## 決定性證據：dead tick 照樣推卡

`/debug/pushes` 最近 20 條之中，落入 ring 嘅 8 條**全部**係 dead tick 推嘅（push 喺該 tick
claim 之後 +3～4s）：

```
23:44:11 rowStart 23:44:08 DEAD offset +3s
23:09:28 rowStart 23:09:24 DEAD offset +4s
22:58:22 rowStart 22:58:19 DEAD offset +3s
22:20:46 rowStart 22:20:42 DEAD offset +4s
22:13:21 rowStart 22:13:17 DEAD offset +4s
22:03:16 rowStart 22:03:13 DEAD offset +3s
21:35:26 rowStart 21:35:23 DEAD offset +3s
```

> **「dead」唔係冇掃描：掃描照跑、候選照評、卡片照推，只有 completion flush 冇落地。**

後果：`scan_history` 缺行、heartbeat 停在 `phase=scanning`、下一個 tick 補一行 backfill、
`outageAlertAt` 郁 → Telegram 收到「停止掃描」。所以嗰個 alert **高估**咗中斷。

## 成因（喺編輯窗口外）

completion flush 係 `worker.ts:1837+` 嘅一個 **12.4KB batch**（`heartbeat` 12.4KB ＝
`summary.rejects` 5.0KB ＋ `deferral` 4.9KB ＋ 其餘；`deferral.events` ring 佔 4.3KB）。
`persistScanCompletion`、claim batch、race 信封全部喺 ~72–95KB，超出本 repo 每檔約
48–60KB 嘅編輯窗口，所以今次改唔到。

順帶一個**獨立**發現：`writeDrain` ＝ **4 calls / 4 failures（100%）** → deferred 嘅
token_stats bookkeeping（`updateTokenMaxMcaps`／`recordTokenStatsMany`）一路冇落地。
唔影響推送，但係數據缺損。

> **2026-09-20 已修（窗口內）**：根因唔係寫入本身，而係 drain **唔被 await**（見下節
> 「writeDrain 100% 失敗」）。`src/tickprobe.ts` 嘅 queue 而家改成**原地**走：一個 deferred write
> 只會喺**真正落地之後**才離開 queue，失敗就留住（FIFO），由**下一個 tick 嘅 drain**再試，上限
> `DEFERRED_WRITE_MAX_ATTEMPTS = 3` 次之後才丟（idempotent 寫入，所以重試安全）。
> 即係嗰 4/4 由「永久數據缺損」變成「遲一個 tick 落地」；`writeDrain.pending` 會顯示仲等緊嘅數量。
> 仲有一塊**窗口外**嘅根治（cron invocation 冇 waitUntil）——可直接貼嘅 diff 就喺下面一節。

### writeDrain 100% 失敗：根因同根治（窗口外 patch）

**根因（代碼路徑）**：tick 完結時 worker 係 `void drainDeferredWrites()` —— **唔 await**。
`fetch` 嘅 promise 只要 handler 一 return 就會被取消，所以嗰批 token_stats 寫入 reject
（transport abort 或者 `wrapClientWithHardWall` 嘅 3.0s 硬牆），而舊 code 只係**計數**。
Cron 路徑最明顯：`scheduled(_event, env)` **冇第三個參數**，即係連 `ctx.waitUntil` 都冇，
所以個 invocation 一完就殺 —— 嗰個 isolate 之後自己睇就係 `calls 4 / failures 4`。
（HTTP 路徑唔同：`maybeRunScanIfStale` 已經入咗 `ctx.waitUntil`，所以佢嘅 drain 通常落得到 ——
即係同一個 isolate 睇 `/health` 會見到 `failures 0`，令人以為已經好返。）

**已落地嘅一半（窗口內，`src/tickprobe.ts`）**：queue 改成**原地**走，entry 只喺落地之後
才 shift；失敗就留住由下一個 drain 再試（`DEFERRED_WRITE_MAX_ATTEMPTS = 3`，之後才丟）。
即係「invocation 被殺 → 永久冇落 row」變成「下一個 tick 落返」。驗收：`writeDrain.failures`
升嘅同時 `writeDrain.pending` 會係 1，而下一分鐘嗰個 tick 嘅 drain 會清返 0；
`dbSteps.recordTokenStatsMany.calls` 應該跟住真寫入升（唔再係「有 calls 冇 row」）。

**窗口外嘅一半（2026-09-20 已落地）**：令 cron 嘅 invocation 自己保命。三塊必須一齊。以前只可以
人手貼（`worker.ts` 去到 ~1750／~3965 行已經超出檔案編輯窗口：同一個 `str_replace` 喺第 103 行成功，
喺 1741／3941 行就算字串逐字一樣都唔會 match），而家係一個直接 apply 嘅 patch：

```
git apply docs/patches/write-drain-waituntil.patch   # git apply --check 驗過乾淨 apply
```

**2026-09-20 已經 apply 咗入 tree（三塊都喺 source）**，所以正常情況下唔使再做嘢；patch file 留低
做審計／萬一 `worker.ts` 被重寫時嘅重播來源。改動係咪齊，睇個 pin 就知：
`npm run test:unit | grep 'drain is held'`（A/B/C 三個 marker 要麼全中、要麼全冇，
半貼會即刻紅）。下面三塊只係內容摘要。

**Patch A —— module state（`worker.ts`，`interface ExecutionContextLike` 之後；下面係實際插入嘅內容，
唯一來源仍然係 `docs/patches/write-drain-waituntil.patch`）**

```ts
/** Minimal ExecutionContext shape — avoids pulling in workers-types. */
interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
+
+/**
+ * The invocation's waitUntil, when the handler driving the tick has one. The
+ * HTTP fallback always has (`maybeRunScanIfStale` is itself a waitUntil);
+ * `scheduled` gets one only from its third argument, which is why the cron
+ * path needs Patch C. The tick's deferred token_stats writes are fired WITHOUT
+ * being awaited, and an un-awaited promise is cancelled the moment the handler
+ * returns — measured 2026-09-19 as `writeDrain` 4 calls / 4 failures (100%),
+ * i.e. the bookkeeping never landed. Holding the drain promise here keeps the
+ * isolate alive for it WITHOUT adding its cost to the tick itself.
+ */
+let tickWaitUntil: ((promise: Promise<unknown>) => void) | null = null;
```

**Patch B —— 個 drain 呼叫（`worker.ts` ~1741）**：`void drainDeferredWrites().then(…)` 改成
`const drained = drainDeferredWrites().then(…)` 再 `tickWaitUntil(drained)`；冇 ctx 就照舊
fire-and-forget，外面嘅 `try/catch` 係防「一個已經完結嘅 invocation 嘅 stale context」拖垮 tick 尾巴
（`onTickEnd` callback 一 throw 就會炸到 tick 收尾）。

**Patch C —— cron handler（`worker.ts` ~3965）**：`scheduled(_event, env)` 收第三個參數
`ctx: ExecutionContextLike`，入面第一句 `tickWaitUntil = (promise) => ctx.waitUntil(promise);`
（呢個就係 cron 路徑由「冇 waitUntil」變成「有」嘅關鍵）。

**防半貼**：`scripts/test-unit.js` 嘅「out-of-window patch: the cron drain is held by waitUntil」
檢查 A／B／C 三個 marker 要麼全中、要麼全冇（同上一組窗口外 patch 同一套規矩），並且確認
`void drainDeferredWrites()` 已經消失。

**驗收點（貼完 + deploy）**：一個**只由 cron 驅動**嘅 isolate 應該見到
`writeDrain.failures` 唔再等於 `calls`；`writeDrain.pending` 應該幾乎永遠係 0（貼完之後
write 唔再被殺，所以連 retry 都唔需要）。相反若果 `pending` 經常係 1–2，即係寫入真係慢
（Turso）而唔係 invocation 被殺 —— 兩種情況喺同一個 view 分得開。

## 今次改嘅（窗口內，`src/worker.ts`）

**後繼 recovery 嘅每個 DB await 都上界。**

- 新增 `RECOVERY_DB_BOUND_MS = 800` 同 `recoveryAwait(work, ms, what)`：timeout 同
  rejection 都當「未 settle」，**唔 throw**（回 `null`）。
- 包住 announce write（`db.setWorkerState("scan_heartbeat", …)`）同
  `trackNoCompletionStretch`（內含一個 read ＋ 一個 write）。
- 改前最壞：`1500（read）＋ 7200×3（三個無界寫撞 6s × 1.2 硬牆）≈ 22s` → recovery tick
  自己都死 → **一次失手變成 5–13 連 dead**（實測 `X60 X60 X60 X60 X60 X76`）。
  改後最壞：`1500 ＋ 800×2 ＝ 3.1s`。
- 順手修一個細 bug：announce write 一 throw 會跳過 alert（同一個 `try`）；現在 alert
  獨立、唔會被前一步拖累。

## 已做（窗口內）：縮細每次寫入

| 旋鈕 | 位置 | 改動 | 量到 |
|---|---|---|---|
| `PUSH_DEFERRAL_RING_MAX` | `deferrallog.ts`（全檔可改） | 60 → **12** events | snapshot 4709B → **1253B**（−3456B）|
| `REJECT_LOG_MAX` | `scanner.ts:992`（53KB，可改） | 50 → **20** entries | 5401B → **2161B**（−3240B）|
| | | **completion heartbeat 合計** | 12369B → **≈5673B（−54%）** |

兩者都只係**紀錄／rate window**，唔影響掃描行為：`rejects` 只係已經被閘門拒收嘅幣嘅日誌
（`addReject` 同 `reject()` 只 push，唔會改變資格判定；`REJECT_LOG_MAX` 亦係 feed/pool
分配 slots 嘅唯一預算，所以結構不變）；deferral ring 只係 cadence 讀數，`totals`／
`pendingTokens`／首末時間戳照舊保留（`pendingTokens` **冇**收縮 —— 佢係功能狀態，唔係遙測）。`test-unit.js` 新增兩條 pin：「the serialized row stays a small write」（量全滿 ring 嘅 JSON
字節並上界）同「an oversized ring is trimmed on READ, newest kept」。

**Deploy 後實測（`91bfb89b`，00:18–00:19Z）發現一個缺口**：`summary.rejects` 即刻由 50 → 20
條、4957B → 1961B（有效），但 `deferral.events` **仍然係 60 條 / 4958B**。原因：deferral row
只喺**真正有 deferral/recovery/stall 發生**時才重寫，而 deferrals 本身少（設計如此）→
`parsePushDeferralSnapshot`（`loadPushDeferralSnapshot` 嘅唯一讀者）冇套 cap，所以舊 row
嘅 60 條 ring 會繼續映落每一次 heartbeat。已修：**讀側都套同一個 cap**（保留最新 N 條，
totals 不動）→ 唔再靠「下次 deferral」才生效。

## 做咗（窗口內）：令 flush 嘅並行 retry 真正有機會落地

**先更正上面一段（原本寫「唔做」）**：結論錯，因為模型錯。我當時以為 completion flush 嘅寫入
行**scan 嗰條 1.2s 短索**，所以用「3s → 硬牆 3.6s > 3300ms」推出「降 timeout 零影響」。今次讀
`scanner.ts:3187` 確認實情係相反：

- `exitScanMode()` 喺 `runOnce()` 嘅 `finally` 執行 ⇒ tick 嘅 completion flush 係喺 **scan mode
  之外**寫入 ⇒ 佢行嘅係 `DB_REQUEST_TIMEOUT_MS`（原本 6s → **硬牆 7.2s**）；
- flush 自己嘅時間表：第一次嘗試最多等到 `FLUSH_ATTEMPT_BOUND_MS = 1200`，然後**並行**重試嘅窗
  係 `SCAN_FLUSH_RESERVE_MS − 1200 = 3300ms`；
- 請求只會喺**硬牆**（`1.2 × timeout`）之後 reject。7.2s > 3300ms ⇒ 吊死嘅寫入**連失敗都嚟唔切**，
  即係重試係喺度 race 一個唔可能 settle 嘅 promise ⇒ **tick 必死**：掃描跑咗、卡推咗、row 冇落地。

而 `worker.ts:2017` 嘅註釋其實一直寫住呢個約束（"the hard-wall error arrives only after
DB_REQUEST_TIMEOUT_MS\*1.2, which alone can outlive the flush window"）—— 只係冇任何嘢強制執行。

**改動**（`src/db.ts` 頭 ~2KB，窗口內）：`DB_REQUEST_TIMEOUT_MS` 6000 → **2500**（硬牆 3.0s < 3300ms）。
即係吊死嘅 flush 寫入而家會**失敗**，而 idempotent 嘅 batch 仲有第二次機會真正落地。2500 仍然係
健康 round trip（100–300ms）嘅 ~8x、實測最慢健康查詢（poolMs 145–600ms）嘅 ~4x，所以健康路徑
唔會被打斷。同時 `export` 佢（連 `SCAN_FLUSH_RESERVE_MS`、`FLUSH_ATTEMPT_BOUND_MS`），令
`scripts/test-unit.js` 可以釘住呢條算術（新增 case：hard wall 必須 fit 落 retry window，並且舊嘅 6s
值必須係唔合格嘅 —— 即係呢個回歸唔會再靜靜發生）。

**reserve 冇得加大**：`scanRaceMs = max(2500, BUDGET − RESERVE − preRace)`，flush 嘅窗固定結束喺
**t≈9.5s**，而 cron invocation kill 喺 ~9.6s（2026-09-15 用 12s budget 時每 tick 都死，成功嘅 tick 喺
8.7–9.6s flush）。即係 9.5s 已經貼住 kill，冇得延後 → **每次請求嘅上界同字節**係唯一仲買得返嘅嘢。

## 編輯窗口：2026-09-20 再驗證過，係真嘅（唔係字串打錯）

同一個 session、同一個工具，做過對照：

| 位置 | 動作 | 結果 |
|---|---|---|
| `worker.ts` ~27KB（`OUTAGE_ALERT_GAP_MS`） | 讀 | ✅ |
| `worker.ts` ~50KB（`trackNoCompletionStretch` 一帶） | **改** | ✅ apply |
| `worker.ts` ~77KB（`runScan` 嘅 claim 路徑） | **改**（exact-match） | ❌ `old string not found` |
| `scanner.ts` ~53KB（`REJECT_LOG_MAX`） | 改 | ✅ apply |

50KB 過、77KB 唔過，所以係**硬邊界**，唔係我打錯字。即係 `persistScanCompletion`（~88KB）、
race 信封（~81KB）、claim（~77KB）、`/health`（~113KB）全部改唔到。

2026-09-20 再量精確 byte offset（改動前嘅檔）：`async function runScan` = **75,225**、race 信封 =
**86,354**、`persistScanCompletion` = 90,259、`flushDeadline` = 93,246、retry 區 = 95,378 / 96,063 ——
全部喺窗口外。同一時間**in** 嘅係：`DB_REQUEST_TIMEOUT_MS`（db.ts, ~1KB）、`SCAN_FLUSH_RESERVE_MS`
= 34,494、`FLUSH_ATTEMPT_BOUND_MS` = 35,118、`WEDGE_CHECK_BOUND_MS` = 42,690、recovery 一帶 ≈ 56–59K。
今次所有改動都落喺 in 嗰邊。

## 窗口外嘅正確修正（等窗口開／人手貼）

**問題**：`scanRaceMs = Math.max(2_500, SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - preRace)`
嘅 `Math.max(2_500, …)` **違反佢上面自己寫嘅不變式**：「the flush ALWAYS starts inside the same
wall-clock window no matter how slow the pre-race phase was」。

算術：race 完結時間 = `preRace + max(2500, 9500 − 4500 − preRace)`。preRace 0.3s → 5.0s（flush 窗
4.5s，正常）；preRace 5s → 7.5s（窗 2.0s）；**preRace 7s → 9.5s（窗 0）**。而 dead 連鎖嘅後繼
tick 正正係要 rebuild ＋ re-init（可能連 cold crime 清單 ~4.8K 一齊重抓）→ 前段變長 → 更容易再死。

**修正**（`src/worker.ts` ~1706，窗口外）：

```ts
      // Never overshoot the tick budget: a front phase slow enough to eat the
      // scan window must cost a scan, not the completion flush. The floor was
      // there so a slow pre-race still got SOME scan; it does that by breaking
      // the very invariant this calculation exists to hold.
      const scanRaceMs = Math.max(
        0,
        Math.min(
          5_000,
          SCAN_TICK_BUDGET_MS - SCAN_FLUSH_RESERVE_MS - (Date.now() - startedAt),
        ),
      );
```

效果：前段慢嘅 tick 照樣寫一行 completion（`ok:false`，reason 顯示 race window 0–2500ms），
**一定落地**；代價係該 tick 唔掃描 —— 而文件自己講過「a completed 6s scan every minute beats
a dead 12s tick that evaluates nothing」。

**但呢段唔係今次失 flush 嘅主因**（唔好當佢係）：live row 顯示 claim 喺 cron 之後 0.2–1.2s 就落
（即 preRace 細），floor 要 `preRace > 2500` 才會生效；而推送證據顯示掃描係跑完嘅（push 喺 claim
+3~4s）。即係「44% tick 冇 row」嘅收窄係由上面嗰個**硬牆**造成，唔係 floor。呢段 patch 仍然係
要落地嘅**正確性修正**（等窗口開／人手貼），但唔應該當佢係減失 flush 嘅一步。

## 已做（窗口內）：completion alert 重新校準

`OUTAGE_ALERT_GAP_MS`（3 分鐘）**兩條 alert 共用**，所以唔可以改佢（會連「完全冇 claim」嘅舊
alert 一齊放寬）。改為新增獨立常數：

| | 舊 | 新 |
|---|---|---|
| completion alert 門檻 | 3 分鐘（共用） | **`COMPLETION_ALERT_GAP_MS` = 10 分鐘** |
| age-based alert（`checkOutageAndAlert`） | 3 分鐘 | 3 分鐘（**不變**，佢先係真正「完全冇 claim」嗰條）|
| cooldown | 30 分鐘 | 30 分鐘（共用同一行 `outage_alert_at`，唔會重複發）|
| 訊息 | 「…沒有完成任何一次掃描」 | 「…沒有任何一次掃描**完成落地**（掃描本身可能仍在運行，丢失的是完成写入…）」|

理由（有數）：呢條 alert **只喺有 claim 死 tick 時才觸發**，即係掃描幾乎肯定有跑（8/8 推送證據）；
而 44% 嘅 tick 失 flush → 3 分鐘門檻等於每幾十分鐘就叫一次假警報。10 分鐘過咗所有量度到嘅
失 flush 連鎖（最長 13 連），但仍然捉得到真 wedged（16:05–16:33Z 那次係 28 分鐘）。

同時把決策抽成純函數 `shouldAlertNoCompletion(silentMs, lastAlertAt, now, gap, cooldown)` 並加
9 條斷言 —— 「發送半邊」之前零自動化覆蓋（上一輪我自己指出嘅缺口）。

## 未做

> **2026-09-20：以下三項已經整理成逐字可貼（verbatim verified）嘅 patch，見文末
> 「可直接貼上嘅窗口外 patch」——三態 send 嘅規則／讀側已經落地並有單元測試，剩返嘅只係搬線。**

- race 信封嘅 floor clamp（窗口外，patch 已寫喺上面 —— 係正確性修正，唔係今次減失 flush 嘅主刀）。
- flush 仍然會失手：今次改嘅係「吊死嘅寫入而家喺 reserve 內失敗，令重試有機會落地」，唔係令 Turso
  唔會吊死。要真正封死，仍然係上面嗰段信封／claim 嘅窗口外工作。
- `pendingTokens` 上限 500：功能狀態（真正等住推送嘅幣），唔可以截；500 個 base58 地址會令
  snapshot 爆到 ~22KB，但實測 pending 只有 4–6 個 → 冇動，只記錄。

## 已做（窗口內）：補推重複嘅修正（live 2026-09-20 00:47Z GROYPER，+2 分鐘再收一次）

> **2026-09-20 更正（重要）**：本節嘅 *機制* 仍然成立（pending 寫入跟 completion flush 同生死），但
> **GROYPER 00:49Z 那張重複卡唔係由呢條路徑產生**：audit ring 有一條 `resend GROYPER`（00:49:50Z，
> id 2339），而 `resend` 只會由 **tracker self-heal 嘅「補發」** 寫 —— 即係用戶口中嘅「補推卡片」。
> 真正嘅生成器係下面「重複推送卡片」一節嘅 **(B) self-heal 補發循環**（已修），呢節嘅 deferral 守衛
> 係另一條獨立防線（live 驗證過：pending 由 7 降到 5，兩個已送幣被正確 forget）。

**機制**：`push_deferral` 嘅 pending 列表同推送**係同一個 completion flush 寫嘅**。flush 一失手，
卡片已經送出但「仲欠佢一張」嘅記錄冇清 → 下一 tick 嘅 make-up pass 再送同一張卡 → 用戶收到重複。
即係呢個重複係上面「失 completion」嘅**下游**後果，唔係獨立問題。

**Live 證據**（deploy 前嘅 `/health` × `/debug/push-audit` 交叉核對）：

| | |
|---|---|
| `deferral.pendingTokens` | 8 個 |
| 其中 audit ring 已經有交付記錄（`initial`/`resend`） | **4 個**：`DFQHUegJ…pump`、`BmnGRH8N…SdpHk`、`6dWoxftz…9Eba`、`9gaMApmv…UW2Y` |

即係嗰 4 個幣「卡片已經送到」，但當時仍然排住隊等補推 → 全部都有機會再送一次。

**規則**（純函數 `deliveredDeferredTokens`，`deferrallog.ts`，窗口內）：
只有 audit ring 嘅 **`initial`**（scanner 送卡成功、Telegram 回咗 `message_id` 之後才寫）同
**`resend`**（tracker 嘅 heal 重送，同樣條件）可以證明「已送」。`followup` 同 `heal-current` **唔算**
—— 佢哋講嘅係 tracker 自己嘅行同 baseline，證明唔到嗰張 initial 卡到底送咗未。

**接線**（`worker.ts`，窗口內）：`syncPushDeferralCounters` 喺 **seed 之前即時讀一次** audit ring
（**唔用** 5 分鐘 throttle 嗰個 mirror —— 重複就係喺下一 tick 出現，正好落喺 throttle 嘅盲區），
把已送嘅 pending token 由 registry（`forgetDeferredTokens`）、鏡像同持久行**一齊**刪；
而「持久行要寫」嘅條件放寬為 `stale.length > 0` 都要寫（否則行留住舊 token，recycle 後又 seed 返）。
讀 audit 失敗 = 當「證唔到」→ pending 完全不動。

**為何唔會漏推**：
- `initial`/`resend` entry 只會在 send **成功之後**（Telegram 回 `message_id`）寫；冇 entry 即證唔到 → 一律保留 → 照舊補推。
- deferral 本身就係「唔寫任何嘢、幣留喺 pool」（見 `DeferredPushLedger` 嘅註釋），所以 forget 只係取消**強制補推優先**，幣仍然可以經正常 rotation 再考。
- 讀取失敗一律 fail-open（保留 pending）。

**已知限制（老實講）**：
1. 覆蓋範圍：最新係 **audit ring ＋ 持久 push ledger 兩邊一齊讀**（見下）。原本只用 ring，live 一量就發現唔夠。
2. 若 tick 喺「send 成功」同「寫 audit」之間被殺，就冇任何記錄可證 → 呢種重複**唔可以**靠推斷消除（推斷就等於有機會漏推）。寧可有重複，唔可以漏。
3. 多 chat：卡片送到 chat A 就會令該 token 被 forget，即使 chat B 後來才啟用。
4. 冷 isolate 首次 seed 喺 `worker.ts` ~74KB（窗口外）讀持久行；持久行會由窗口內嘅寫入收緊，所以最多一個 tick 後收斂。

**Live 量到嘅覆蓋缺口（deploy 後即刻發現，已修）**：首個 post-deploy 讀數
（02:03:44Z）顯示 overlap 由 4 降至 **2**（`6dWoxftzRFH…STACK`、`9gaMApmv31…MEMEMAN` 被刪掉 ✓），
但另一對（`DFQHUegJW…PUMPCAT`、`BmnGRH8N1…`）仍在 pending —— 因為 **audit ring 只有 30 條**
（initial、resend、followup、heal 一齊塞），13 分鐘就將它們揷出窗。所以補上第二個證明來源：
**持久 push ledger** 嘅 `source: "initial-send"` entries（同一個 `initial` 交付類別，TTL 7 日／240 條），
經 `ledgerDeliveredTokens`（純函數，`pushledger.ts`）抽出，同 ring 合併成同一個 kind whitelist。
`watch-row` provenance 刻意唔算（有 row 唔等於送過卡）。
02:05:42Z 複測：pending 8 → **6**，overlap **0**。

**第二輪 live 驗證（deploy 8e67fd33，02:12:01Z）—— 又一個缺口**：pending 7、ring overlap **0** ✓，
但 `DFQHUegJW…PUMPCAT`、`BmnGRH8N1…` 仍在 pending。原因量到：佢哋嘅交付記錄係 **`resend`**，而
ledger 只收 `initial` 一種 provenance（push-time mcap 嘅用途決定嘅），ring 又已經捲走。
所以加第三個**持久**來源：**`push_watch` 嘅 rows**（`PushWatcher.onPush` 係「成功推送之後」才寫，
只被 defer 嘅幣永遠冇 row）→ 合成 kind **`pushed-row`**（`DELIVERED_CARD_KINDS` 白名單加入）。
三個來源並行讀、合成同一個 proof set，依然係「證唔到就保留」。

**驗收點**：`/health` 嘅 `deferral.pendingTokens` 唔應該再包含 audit ring 或 ledger 已有 `initial` 嘅 token；
console 會出現 `[worker] forgot N deferred obligation(s) already delivered — …`；同一個 token 唔應該再收兩張卡。

## 已做（窗口內）：令 gauge 同 pending 列表係「同一個事實」

**病徵（live 2026-09-20 02:30Z）**：`/health` 嘅 `deferral.pending` 讀 **7**，但同一行嘅
`pendingTokens` 只有 **5** 個，而且維持成個 tick（一直到下次寫入）。`pending` 就係運維／警報睇嘅 backlog。

**成因**：兩個來源各自數一次。
- `pending` 由 caller 帶入：`worker.ts` 傳 `summary.deferPending` —— 即 scanner **掃描當時**嘅
  `deferredPushes.pendingCount`；
- `pendingTokens` 由 registry 讀，而 duplicate guard 係喺**同一個 tick 嘅尾段**（掃描之後）才刪走已送嘅 token。

所以「掃描時 7 → 尾段刪剩 5」嗰個 tick 寫落去嘅行就是 `pending: 7` ＋ 5 個 token，之後每次心跳照抄。

**修法**：`nextPushDeferralSnapshot`（`deferrallog.ts`，窗口內）唔再收 caller 嘅數做 gauge ——
**只要 caller 交咗列表，gauge 就係嗰個列表（去重、−500 截斷之後）嘅長度**，一個數只有一個來源，
兩個欄位唔可能再分開。`delta.pending` 只喺 caller 完全冇列表（投影／legacy caller）時保留為 fallback。
事件 ring 嘅 `pending` 亦用同一個數，所以連 ring 都唔會自相矛盾。

**刻意保留嘅邊界**：caller 交**空**列表**唔會清空** `pendingTokens` —— 空列表可以係「真係冇欠」，
亦可以係「呢個 isolate 未 seed registry（scanner 未 ready）」，而兩者要靠 caller 分；猜錯嘅代價唔對稱：
**漏清 = 多一張重複卡；清錯 = 漏推一張卡**，所以一律保留（fail-open），
而 gauge 就跟着「保留落嚟嗰個列表」嘅長度 → 不變式 `pending === pendingTokens.length`
喺兩個分支都成立。

**讀側亦要推導（deploy 後即刻量到嘅缺口）**：第一版只改寫入路徑，02:41:37Z deploy，02:44:50Z 讀
`/health` 仍然係 **7 vs 5** —— 因為對上一次寫入（02:23:49Z）早於修正，而**冇 delta 嘅 tick
只會照抄行嘅值**（`loadPushDeferralSnapshot` = init 時嘅鏡像），即係舊行會一直服務落去。
所以鏡像亦改為**由列表推導 gauge**（`loadPushDeferralSnapshot`，同一個不變式）：舊行一經讀出就
唔可能再發布一個同自己列表唔一致嘅 backlog。事件 ring 亦係同一個數。

**驗收點**：任何讀數都應該 `deferral.pending === deferral.pendingTokens.length`；出現過刪除嘅 tick 之後
（console 有 `[worker] forgot N …`）唔應該再見到 7 vs 5 嗰種組合。

## 重複推送卡片（live 2026-09-20 10:48–11:08 HKT，GROYPER、PONDER 各重複 4–5 次）

**唔關之前嘅 deferral 守衛事**：那個守衛管嘅係「pending／補推」清單（欠一張卡）。用戶回報嘅重複有**兩個獨立生成器**，兩個都不經過那份清單：

| | 觸發 | 重複嘅卡從哪來 | 今日狀態 |
|---|---|---|---|
| **(A) cut → unclaim → re-eval 重推** | 卡片送到一半被 send deadline 切斷 | re-eval pool 下一個 tick 當佢「未推」再送 | **機制確認，修法在窗口外**（見下） |
| **(B) tracker self-heal 嘅「補發」循環** | 幣喺 `seen_tokens`（已 claim）但冇 `push_watch` row，而且 audit ring 冇 `initial` entry | `pushwatch.ts` 嘅 self-heal 送「📤 補發推送」，**每個 pass 再送一次** | **已修（窗口內）** ✅ |

(B) 才是用戶口中「その後收到 X 補推卡片」嘅那張：用戶 00:47Z GROYPER 收到推送，00:49Z 收到補推 — audit ring 正好有一條 `resend GROYPER`（00:49:50Z，id 2339）；同一形狀的 `resend` 還有 JEV（00:33）、STACK（01:02）、MEMEMAN（01:39）。

### (B) self-heal 補發循環 —— 已修（窗口內）

**代碼路徑**：`pushwatch.ts` 嘅 heal 段（`findUntrackedPushes` → 逐幣）；gate 原文：

```ts
const recentClaim = now - m.pushedAt <= FIRST_CARD_RESEND_GRACE_MS;   // 15 分鐘
if (recentClaim && !audited.has(m.token)) {   // audited = getInitialPushAuditTokens()（只有 kind "initial"）
  ... 送一張完整的首卡，然後寫 kind: "resend" 的 audit entry ...
}
```

**為何會循環**：被 cut 嘅卡片**會送到，但一個 audit entry 都唔會寫**（cut 路徑只有 throw → unclaim）。所以：

1. 第一次 heal pass：冇 `initial` → 覺得「首卡未送達」→ 送補發，並寫一條 `resend`；
2. 下一次 pass：gate 只認 `initial`，**看不到自己剛寫嘅 `resend`** → 又送一張補發；
3. 15 分鐘 grace 內每個 pass 重複 → 用戶在 11 分鐘內收到 4–5 張同一枚幣嘅卡（live PONDER 02:57/03:01/03:03/03:08Z，其中 03:01:11Z 嘅 `lastPushError` 正是 `cardSendTimeout`）。

**修法（`src/pushwatch.ts` + `src/deferrallog.ts`，都是窗口內）**：gate 由「有冇 `initial`」改成「**有冇任何已送達嘅卡**」——即 `deferrallog.deliveredCardTokens(audit)`（kind ∈ `initial` / `resend` / `pushed-row`）：

```ts
const delivered = new Set(deliveredCardTokens(ring));   // ring = 同一條 push_audit row
if (recentClaim && !delivered.has(m.token)) { ... 送補發 ... }
```

**為何仍然「一定唔會漏推」**（安全論證）：

- 補發會寫自己嘅 `resend` entry，所以**每個 token 每個 ring 窗最多補發一次**；
- **完全冇 entry** 嘅 token 照舊即時補發（never-miss 那半完全未動）；
- ring 每個 kind 都只在 Telegram 回 `message_id` 之後才寫 → 有 entry = 用戶確實收過一張該幣嘅卡；
- ring 讀失敗 → 退回舊嘅 initial-only 集合（fail toward the old behaviour，唔會多發）。

**為何用 seam 讀**：heal 測試用嘅 Db double 只實作 `getInitialPushAuditTokens`，所以新 reader 用 `typeof` 檢查（缺就退回舊集合）——純規則本身有單元測試釘死。

### (A) cut → unclaim → re-eval 重推 —— 機制確認，修法在窗口外

**機制（代碼路徑，`scanner.ts` sendTo，行 ~3020，窗口外）**

1. `claimTokenPush(chatId, token)` = `INSERT OR IGNORE INTO seen_tokens` → 搶到 claim 才會送（設計上「storage layer 令重複不可能」）。
2. 送卡片係 `bestEffort(() => bot.api.sendMessage(...), sendDeadline, null)` = `Promise.race([send, timeout])`。**timeout 只係唔再等，send 本身繼續在飛** → Telegram 可能已經收下呢張卡。
3. 但 `sent === null` 時代碼 **throw**（`cardSendTimeout`），catch 裡 **`unclaimTokenPush`** 把 claim `DELETE` 掉 → 個幣又變返「未推」。
4. 下一 tick 嘅 re-eval pool 見佢未推 → 再送 → **第二張卡**。喺失手嘅 slice 修好之前，每個 tick 重複一次。

**Live 證據**

| 證據 | 讀數 |
|---|---|
| 該 chat 嘅 push 失敗記錄（`/debug/chats` → `lastPushError`） | `{"description":"initial-card send exceeded its deadline (card may not have been delivered)","token":"3QgAJyTGGKfp…"（PONDER）, "at": 03:01:11Z}` ← 正是用戶收到 11:01 HKT 嗰張卡 |
| 該 tick 嘅 phase stamps（`/health` → `heartbeat.summary.phases`） | `flow@2102, rugcheck@2102, enrich-dispatch@2378, enrich-await@2378, wallets@2800（= enrich deadline）, flurry@3300（= chain deadline）, render@3300, send@3542, tracker@4131, done@4638`；`candidates 1, pushed 0, cardSendDeferred 1` |
| 換算 | chain 用到 3300ms 為止（用盡每個 deadline）→ render/claim 190ms → **send 開 3542ms，距 4200ms deadline 只剩 658ms** |
| claim 閘門邊界 | `CARD_CLAIM_BUDGET_MS + CARD_SEND_MIN_MS = 400 + 250 = 650`，最後可 claim 嘅起點 3550ms → **tick 就係壓在這條線上**，一係剛剛夠（送出去但被 cut），一係一時過就 defer |
| Telegram 真實往返（`/debug/test-push`，5 次 curl 計時） | **0.62s / 1.23s**（`/health` 同期 baseline 1.12–1.21s，即大部分係 isolate 啟動，Telegram 自己約 0.5–1s）→ **658ms 嘅 slice 根本裝唔落** |
| audit ring 嘅 message_id 缺口 | 最後一條有真 id 嘅 audit = **2361（02:37:09Z）**；之後我發測試訊息拿到 **2370/2371/2372/2373/2374** → **2362–2369 呢 8 條訊息完全冇 audit**（用戶回報嘅 4–5 張重複卡就落在這窗）。⚠️ 注意 ring 裏有 `messageId: 1` 嘅行（PONDER 兩條 `initial`、幾條 `followup`），即係 id 並不總是真實 id → 呢個缺口算術只適用於 id 落喺 23xx 嘅行 |

**為何 deferred 守衛幫唔到**：`deferredDeferredTokens` 只管 `push_deferral.pendingTokens`（補推義務）；呢邊係 `seen_tokens` 被刪 → 推送閘門再開。守衛讀 proof 之後只會 forget pending，唔會（亦唔應該）擋一次合法 push。

**真正嘅修法（窗口外，`scanner.ts` sendTo）**：把兩態改成**三態**，送嘅 promise 自己帶背景處理：

```ts
// 現在：const sent = await this.bestEffort(() => send, deadline, null);
//       if (sent === null) throw cut;          // → catch 裡 unclaim → 重複
const started = this.bot.api.sendMessage(chatId, message, opts);   // 立即開
const raced = await Promise.race([
  started.then((m) => ({ status: "sent", messageId: Number(m.message_id) }))
         .catch(() => ({ status: "failed" })),
  new Promise((r) => setTimeout(() => r({ status: "abandoned" }), Math.max(0, sendDeadline - Date.now()))),
]);
if (raced.status === "failed") throw new Error(...);            // 冇送到 → unclaim，等下 tick
if (raced.status === "sent") { /* audit（今日本身有：kind "initial"）*/ }
if (raced.status === "abandoned") {
  // 唔 unclaim：卡片可能已送到，claim 留著 = 唯一阻止即刻重推嘅嘢。
  // 先寫一筆持久「未確認」紀錄（worker_state ring：{chatId, token, at}），然後
  void started.then(async (m) => {
    await this.db.recordPushDelivery({ ...kind: "initial", messageId: Number(m.message_id) }); // 證明已送
  }).catch(async () => {
    await this.db.unclaimTokenPush(chatId, token);   // 真係失敗 → 放返出去，唔會漏
  });
}
```

**配套（worker 側，窗口內可寫）**：tick 尾（`syncPushDeferralCounters` 隔離區塊）對持久「未確認」紀錄做 reconcile：
超過 2 個 tick（約 2 分鐘）而 audit/ledger/watch row **仍證唔到** delivery → 真正 `unclaimTokenPush`（放返出去，最壞情況=多一張重複，唔會漏）。
即係：**freeze 天花板**由「即刻重複」變成「兩分鐘後最多重複一次」，而成功確認嘅個案完全唔會重複。

**窗口內可以做嘅替代方案（有代價，未做，等決定）**

1. **把 send 嘅 slice 補到約 1.1–1.3s**：`CARD_SEND_FLOOR_MS` 600→900、`CARD_SEND_MIN_MS` 250→700（claim 閘門 → 1100ms）。效果：`send@3542` 嗰種 tick 由「cut 但照送」變成**defer**（一個字都唔寫、零重複風險），真正送出去嘅卡都有 ≥1100ms。
   障礙：所產生嘅邊界（`cardSendDeadline(t0,t0+4150)`、`cardClaimDeadline(t0,t0+3550/3551)`）**被 `scripts/test-unit.js` ~2018–2056 行嘅斷言釘死**，而該處在 file-sync 窗口外 → 改咗會 CI 紅。
2. **把 chain 提前收工**：`CANDIDATE_PUSH_RESERVE_MS` 900→1300–1500（`chainDeadline` 3300→2900–2700）。效果：send 開 ~3200ms → slice ~1.0–1.25s。代價：`enrichDeadline` 由 2800 跌到 2400–2200，而 live enrich dispatch 喺 **2378ms** → 卡片會失去 Birdeye/Arkham/GMGN 那些裝飾行，wallet/Flurry 閘門嘅窗口亦相應縮短（fail-open，唔會漏推但少判）。
3. **拉長 tail / `SCAN_TICK_DEADLINE_MS`**：**否決**。tail（4400）已經只離最小 race window（4742）340ms，再拉就會令 completion flush 又開始死（即之前那個病）。

**已落地嘅改動（全部窗口內）**

| 檔案 | 改動 | 作用 |
|---|---|---|
| `src/deferrallog.ts` | 新純函數 `deliveredCardTokens(audit)`；`deliveredDeferredTokens` 改用同一個 rule | 一個 rule 服侍兩個 call site（deferral 守衛 + heal gate） |
| `src/deferrallog.ts` | 新純函數 `duplicateInitialTokens(audit)` | 由 ring 數「同一 token 有兩張 `initial`」= **可證實**嘅重複（見下方限制） |
| `src/pushwatch.ts` | heal gate 改為 `deliveredCardTokens`；新增 `readDeliveredTokens(db)` seam | **修掉 (B) 循環**：每 token 每窗最多一張補發 |
| `src/tickprobe.ts` | 新 `CardSendView`（`classifyCardSend` → cut / sent / deferred）＋ `DeliveryDuplicatesView`（`noteDuplicateCards` → `duplicates` / `tokens` / `at`） | 兩個計數器都掛上 `summary.cardSend` / `summary.deliveryDuplicates`，心跳會 serialize |
| `src/worker.ts` | `dropDeliveredPendings` 改為**每個 tick 都讀一次 audit ring**（pending 空時只讀一條，唔再 3 條）並呼叫 `noteDuplicateCards` | 站內就有重複率，唔再靠用戶人手報告 |

**計數器嘅已知限制（唔修飾）**：`duplicateInitialTokens` 只能捉到**兩張卡都有 audit entry** 嘅重複（即 (B) 類，或已 claim 成功嘅重複）；**(A) 類嘅主體係「cut 但送到」——一個 entry 都冇，因此在 ring 裏完全隱形**。所以 (A) 嘅唯一可量度訊號係 `cardSend.cut`（上游生成器）而非重複數本身；`deliveryDuplicates` 應該讀成「可證實嘅重複」下界。

**`room ≈ R − 220` 模型（用 live tick 校準，供 (A) 調參用）**：`chainDeadline = SCAN_TICK_DEADLINE_MS − CANDIDATE_PUSH_RESERVE_MS`，而 live tick 顯示由 chain 收工到 `send:telegram` 之間固定花 ~220–250ms（render + claim round trip）。所以 send 實際可用時間 ≈ **R − 220ms**：R=900 → 680ms（實測 658ms ✓ 模型吻合），要 ~1.2s 就要 **R ≈ 1400**。

## 驗收點（deploy 後）

- 主：`scan-history` 嘅**連續** dead 行長度上限（改前 5–13 連）→ 應縮到 1–2。
- 主（今次新增嘅 timeout 改動）：60 行窗口嘅 dead 比例（改前 ~44%）應該下降；如果 Turso 吊死，
  console 會見到 `completion write hung — firing racing retry` 之後**同一 tick 仍然寫到行**
  （改前係一定冇）。55 分鐘級嘅樣本太細 → 唔應該用 15 行就下結論。
- 次：`/health` 嘅 `heartbeat` 大小（`JSON.stringify(heartbeat).length`）應由 ~12.4KB 跌到 ~5.7KB；
  `deferral.events.length` ≤ 12；`summary.rejects.length` ≤ 20。
- 輔：`outageAlertAt` 更新頻率；warm isolate `/health` 嘅 `wedgedStateResets`。
- **唔可以**再用 dead 行判斷「有冇掃描」——要交叉核對 `/debug/pushes` 嘅時間戳。
- 量度注意：**任何 HTTP 路由都會行 `maybeRunScanIfStale`**，所以 curl `/health`（或
  UptimeRobot）本身會補跑掃描、令 cron 分鐘行消失（會見到 `scanCount 1` 嘅新 isolate）。
  睇 `tickRing` 才分得清 cron 有冇 fire。

### 重複推送卡片那條線

- 新指標：`/health` → `heartbeat.summary.cardSend = { cut, sent, deferred, lastCutAt, lastCutMs }`
  同 `heartbeat.summary.deliveryDuplicates = { count, tokens, at }`。
  基線：`cut` 應該幾乎每次卡被送都 +1（每次 `send@>3500ms` 嘅 tick），`sent` 只喺快 slice 出現。
- **(B) 已修嘅驗收**：同一 token 喺 audit ring 唔應該再出現**多過一條** `resend`（改前可以 4–5 條）；
  用戶唔應該再收到「📤 補發推送」。呢個係 deploy 後最快見到嘅成效（下一次有 cut 或漏 row 嘅幣就會觸發）。
- **(A) 未修**：`cardSend.cut` 應該維持（上游生成器仍在）；`deliveryDuplicates.count` 唔會反映 (A)（見限制）。
  (A) 嘅驗收要等窗口外嘅三態 send 落地：**同一 token 喺 `/debug/push-audit` 只應有 1 條 `initial`**、
  `seen_tokens` 唔應該再因為 timeout 而被刪。
- 反面驗收（防漏推）：模擬一個 request reject 嘅 send → 仍然要 `unclaimTokenPush` + 下 tick 補推；
  只有 `abandoned` 才保留 claim，而且 2 個 tick 內證唔到 delivery 就必須放返出去。
  heal gate 嘅反面驗收：**ring 完全冇 entry 嘅 token 必須照樣補發**（單元測試 `deliveredCardTokens` 覆蓋）。

## 2026-09-20（今次）：量清編輯窗口，然後用窗口內唯一嘅旋鈕去減 (A)

### 先講窗口（今次實測，之前只係估）

用 `.syncprobe.ts`（worker.ts 嘅暫存副本）逐個偏移試 apply，得到：

| 檔案 | 行 | byte offset | 結果 |
|---|---|---|---|
| `.syncprobe.ts`（= `worker.ts`） | 700 | 32,050 | ✅ apply |
| 同上 | 1000 | 48,479 | ✅ |
| 同上 | 1088 | 52,649 | ✅ |
| 同上 | 1190 | 57,259 | ✅ |
| 同上 | 1241（`COMPLETION_ALERT_GAP_MS`） | 59,404 | ❌ not found |
| 同上 | 1300 | 62,009 | ❌ |
| 同上 | 1400 | 66,907 | ❌ |
| `scripts/test-unit.js` | 2018 | 97,884 | ❌ |
| 同上（cardSendDeadline 斷言） | 2090–2129 | 100.5K | ❌ |
| `src/scanner.ts` | 172（常數區） | 9,889 | ✅ |

即係：**窗口大約係每個檔案嘅頭 1,200 行**（唔係固定 byte 數，亦唔係「某 % 數」——
59.4K 唔過、62K 唔過，而 57.2K 過）。今日所有改動都落喺窗內。

**推論**：`scanner.ts` 只可改頭 ~1200 行（send 喺 ~3020 行 ⇒ 唔得）；`worker.ts` 只可改頭 ~1200 行
（race 信封喺 ~1980 行 ⇒ 唔得）；`db.ts` 只可改頭 ~1200 行（`claimTokenPush` 喺 ~1957 行 ⇒ 唔得）。

### 今次落地：`CANDIDATE_PUSH_RESERVE_MS` 900 → **1500**（窗口內，`scanner.ts` ~172 行）

**為何可以繞過「send floor 改唔到」嘅死結**：send 實際分到嘅 slice 唔係由 `CARD_SEND_FLOOR_MS`
單獨決定，而係

```
send deadline = max(now + FLOOR, SCAN_TICK_DEADLINE_MS)  （再由 CARD_SEND_TAIL_MS 封頂）
send 起點     = chainDeadline + overhead
             = (SCAN_TICK_DEADLINE_MS − CANDIDATE_PUSH_RESERVE_MS) + ~242ms
⇒ slice = SCAN_TICK_DEADLINE_MS − chainDeadline − overhead
         = CANDIDATE_PUSH_RESERVE_MS − overhead      （只要 reserve − overhead > FLOOR）
```

所以 `reserve` 就係「room ≈ R − 220」模型裏面嗰個 R，而它**唔受任何測試釘住**
（`cardSendDeadline`/`cardClaimDeadline` 嘅斷言只依賴 `(t0, now)` 同 FLOOR/MIN/BUDGET，
reserve 唔喺裏面）。今日實測：

| | 改前 | 改後 |
|---|---|---|
| `chainDeadline` | 3300ms | **2700ms** |
| send 起點（live `render@3300 → send@3542` 嘅 242ms overhead） | 3542ms | ~2942ms |
| send slice | **658ms** | **~1258ms** |
| Telegram 實測 round trip（`/debug/test-push`） | 0.62s / 1.23s | 兩者都裝得落 ✅ |
| 處理候選嘅鏈窗口 | 1.2s | 600ms |
| gate 窗口（= `CANDIDATE_GATE_TAIL_MS`） | 500ms | 500ms（**刻意不動**） |

**點解可以減 (A)**：slice 由 658ms（細過 1.23s 樣本、亦細過常見 ~1s）升到 ~1258ms
（≥ 最慢樣本）⇒ send 嘅 await 通常喺 deadline 前 settle ⇒ `sent !== null` ⇒ claim 保留 +
delivery audit 落地 ⇒ **下一 tick 冇「未推」狀態可以再推**。裝唔落嘅 tick 會 `cardSendDeadline`
返 null ⇒ **defer**（零寫入、零 claim、保留 make-up 優先），即係 400ms 由「重複風險」換成「延遲」。

**代價（老實列，全部 fail-open 且心跳可量）**

1. **卡片裝飾行**：decor batch 係喺 ~2378ms dispatch、用 `enrichDeadline = chainDeadline − 500` 封頂，
   所以它嘅 grace 由「2800 − 2378 = 422ms」跌到「2200 − 2378 < 0」。Birdeye 持有人/Pro、GMGN、
   Arkham（本來已停用）、Jupiter 有機度 會照舊 render 成「—」。呢啲 client 逐 mint 有 cache，
   所以暖 cache / 重掃嘅幣照樣有數據。
2. **慢 gate 走查**：wallets / Flurry 一條 cold walk 喺 500ms 窗都已經行唔完（live `wallets`
   2800→3300 直接燒到 chain deadline），而家更早被切 ⇒ 呢啲判斷更少（fail-open：唔會漏推，
   但少判）。local/cached 嘅判斷（crime creator、top10 band、已 cache 嘅 Flurry/wallet verdict）
   照樣落地。
3. **晚開始嘅鏈**：front phase 用盡 `FRONT_PHASE_WINDOW_MS`（2600ms）嘅 tick，鏈一開波就撞
   `Date.now() > chainDeadline` guard ⇒ 該候選 defer 去下一 tick（latency，唔會失去硬幣）。
4. **trailing tracker + summary 早 ~500ms 完**，所以**反而**退返時間俾 worker 嘅 completion flush
   （即上面嗰條失 flush 線嘅同一種 slack）。

**如果要反悔**：只需改一個常數（`CANDIDATE_PUSH_RESERVE_MS`）。`cardSend.cut`（心跳）會量到
剩返幾多 cut，`/health.deferral.pending` 會量到多咗幾多 defer。

### 新單元測試（`scripts/test-unit.js` 頭部，窗口內）

`card send room: the push reserve covers a measured Telegram round trip` —— 釘住
`CANDIDATE_PUSH_RESERVE_MS − 250 ≥ 1200`（最慢實測 round trip）、
`SCAN_TICK_DEADLINE_MS − reserve ≥ 600`（鏈仍然要有窗口）、同埋
「舊值 900 應該唔合格」嘅見證斷言。兩個常數已 `export`（`scanner.ts`）。
`test:unit` = **211 passed, 0 failed**；`test-deferred-priority` / `test-tick-path` 全 pass。

### 仍然要人手貼（窗口外，patch 已備）

1. **race 信封嘅 floor clamp**（`worker.ts` ~1980 行）：依然係正確性修正，位置/內容同上面一節
   一樣。今次改動令 scan 早 ~500ms 完，flush 多咗 slack，但 envelope 本身嘅不變式仍然係錯嘅。
2. **(A) 嘅根治：三態 send**（`scanner.ts` sendTo ~3020 行）：本節嘅 reserve 改動只係令 cut 變罕見，
   唔係令 cut 無害。要真正封死：「abandoned 唔 unclaim + 背景寫 delivery + 2 個 tick 內證唔到才釋放」
   （patch 一樣喺上面「(A) cut → unclaim → re-eval 重推」一節）。
3. **`CARD_SEND_FLOOR_MS` 600→900 / `CARD_SEND_MIN_MS` 250→700**：仍然**做唔到**，因為
   `scripts/test-unit.js` 2090–2129 嘅四條斷言（4150/4151、3550/3551）喺窗口外，改咗會 CI 紅。
   reserve=1500 已經買到同一個效果，所以呢個配對而家係「可選加強」，唔再係必須。

---

# 可直接貼上嘅窗口外 patch（2026-09-20 整理）

## 先講已經喺窗口內落地嘅部分（唔需要貼）

三態 send 嘅**規則**同**讀側尊重**已經寫入 repo 並有單元測試釘住，所以下面每塊 patch 只剩
「搬線」嘅部分，冇未測試嘅邏輯：

| 位置 | 內容 | 測試 |
|---|---|---|
| `src/deferrallog.ts` | `UNCONFIRMED_CARD_STATE_KEY` / `UNCONFIRMED_CARD_MAX`(12) / `UNCONFIRMED_CARD_GRACE_MS`(120s)、`parse/add/remove/serialize UnconfirmedCardSend…`、`settleUnconfirmedCardSends`、`cardSendDisposition` | `cardSendDisposition: abandoned keeps the claim…`、`unconfirmed ledger: one record per coin, capped, and removable`、`settleUnconfirmedCardSends: proof keeps the claim, silence releases it after the grace`（`test:unit` = 214 passed / 0 failed） |
| `src/pushwatch.ts` | heal gate 多一個條件：`recentClaim && !delivered.has(token) && !unconfirmed.has(token)`；`readDeliveredTokens` 多回一個 `unconfirmed` 集合（讀唔到 = 空集 = 舊行為） | 規則本體（`cardSendDisposition` / `settle…`）已釘；gate 係 fail-open 讀側 |

**為何要 pushwatch 呢一步**：冇佢，abandoned 嘅卡（可能已經送到、但冇 audit entry）會被 self-heal
判成「首卡未送達」→ 即刻送一張「📤 補發推送」= 用戶投訴嘅重複。有佢之後，補發由
「unconfirmed 記錄」接住，而該記錄最遲兩個 tick 由 worker reconcile 放返 claim，硬幣照樣經正常
掃描再推 —— 延遲幾分鐘，唔會漏。

---

## Patch 1／4：race 信封嘅 floor clamp（`src/worker.ts`，~1977–1983 行）

**OLD**

```ts
      // phase was. The constant's floor still applies to ticks with a fast
      // pre-race (the common case).
      // The race ends EARLY, leaving SCAN_FLUSH_RESERVE_MS for the
      // completion flush below: the tick envelope is then
      // preRace + scanRace + flush <= SCAN_TICK_BUDGET_MS no matter how slow
      // the pre-race phase was, so there is always time left to land the
      // flush before Cloudflare kills the invocation.
      const scanRaceMs = Math.max(
        2_500,
        SCAN_TICK_BUDGET_MS -
          SCAN_FLUSH_RESERVE_MS -
          (Date.now() - startedAt),
      );
```

**NEW**

```ts
      // phase was.
      // The race ends EARLY, leaving SCAN_FLUSH_RESERVE_MS for the
      // completion flush below: the tick envelope is then
      // preRace + scanRace + flush <= SCAN_TICK_BUDGET_MS no matter how slow
      // the pre-race phase was, so there is always time left to land the
      // flush before Cloudflare kills the invocation.
      //
      // 2026-09-20 (correctness): the 2_500ms FLOOR broke that invariant —
      // preRace 7s → envelope 9.5s → flush window 0, i.e. the slow-pre-race
      // tick this calculation exists to protect was exactly the tick it
      // killed. A recovering successor is a slow-pre-race tick by
      // construction (rebuild + re-init, sometimes a cold crime-list fetch),
      // which is how one death became a 5-13 tick chain (the backfill rows
      // all report 54-77s spans). A tick that cannot afford a scan now spends
      // its envelope on the COMPLETION instead: `scanRaceMs === 0` fires the
      // timeout branch at once, `scanner.abort()` stops the scan at its next
      // phase boundary, and the row that lands says so. "A completed 6s scan
      // every minute beats a dead 12s tick that evaluates nothing" — and a
      // completed 0s scan (deferred candidate, re-offered next tick) beats
      // both.
      const scanRaceMs = Math.max(
        0,
        Math.min(
          5_000,
          SCAN_TICK_BUDGET_MS -
            SCAN_FLUSH_RESERVE_MS -
            (Date.now() - startedAt),
        ),
      );
```

唔需要改其他嘢：race 之後嘅 `lastScanOk = !timedOut`、`lastScanError`（用 `scanRaceMs` 砌訊息）同
`finally` 嘅 completion flush 全部照舊，所以 `scanRaceMs === 0` 係一條「已落地嘅 timeout 行」，
唔係死 tick。`Math.min(5_000, …)` 係善意上界（現值 9_500−4_500 正好 5_000），防止將來調 budget 時
race 反過來變成無上限。

---

## Patch 2／4：三態 send（`src/scanner.ts`，`sendTo` 內 ~3086–3140 行）

### 2a. 檔案頂 import（窗口內，可即刻做）

`src/scanner.ts` 現時冇 import `deferrallog`，加：

```ts
import {
  cardSendDisposition,
  addUnconfirmedCardSend,
  removeUnconfirmedCardSend,
  UNCONFIRMED_CARD_STATE_KEY,
} from "./deferrallog";
```

### 2b. send 段整段換（**OLD → NEW**）

**OLD**

```ts
          try {
            // Bounded by the card-send tail (see CARD_SEND_TAIL_MS): a
            // null here means the send missed its slice, and the
            // caller's failure path releases the claim so the coin is
            // retried.
            this.markPhase(diag, "send:telegram", startedAt);
            const sent = await this.bestEffort(
              () =>
                this.bot.api.sendMessage(c.chatId, message, {
                  reply_markup: {
                    inline_keyboard: tradeKeyboard(
                      tokenAddress,
                      this.trade ? this.trade.buySizeLabel : "",
                      tradeMode,
                      { modeSwitch: Boolean(this.trade), unwatch: true },
                    ),
                  },
                }),
              sendDeadline,
              null,
            );
            if (sent === null) {
              const cut = new Error(
                `initial-card send exceeded its deadline (card may not have been delivered)`,
              ) as Error & { cardSendTimeout?: boolean };
              // Tagged so the delivery retry below does NOT sleep 1200ms and
              // re-send inside a tick that has already run out of room.
              cut.cardSendTimeout = true;
              throw cut;
            }
            // Delivery audit: Telegram returned a message_id, so the card
            // left us and was accepted. Recording it lets a later "never
            // got the first card" report be answered with hard evidence.
            try {
              await this.db.recordPushDelivery({
                chatId: c.chatId,
                token: c.profile.tokenAddress,
                symbol: c.profile.symbol ?? c.pair.baseToken.symbol ?? null,
                messageId: Number(
                  (sent as { message_id?: unknown }).message_id ?? 0,
                ),
                mcapAtPush: c.pair.marketCap,
                kind: "initial",
              });
            } catch {
              /* audit is best-effort */
            }
          } catch (err) {
```

**NEW**

```ts
          try {
            // THREE-STATE send (2026-09-20 — docs/scan-completion-loss.md §
            // "(A) cut → unclaim → re-eval 重推"). The two-state version read
            // every non-delivery as a failure: bestEffort() returns `null`
            // BOTH when Telegram rejected the card AND when the tick merely
            // stopped waiting for a request that is still in flight. The
            // second case then released the claim (unclaim → the re-eval pool
            // sends the same coin again) while the first card was already on
            // its way — the operator's repeat cards (PONDER 5× in 11 minutes.
            //
            // The promise is started ONCE, here, so the background chain
            // below watches the very request the race gave up on.
            this.markPhase(diag, "send:telegram", startedAt);
            const inFlight = this.bot.api.sendMessage(c.chatId, message, {
              reply_markup: {
                inline_keyboard: tradeKeyboard(
                  tokenAddress,
                  this.trade ? this.trade.buySizeLabel : "",
                  tradeMode,
                  { modeSwitch: Boolean(this.trade), unwatch: true },
                ),
              },
            });
            // `settled` never rejects: a rejection is a FACT ("Telegram said
            // no") while the timeout is the ABSENCE of one, and not conflating
            // the two is the entire fix.
            const settled = inFlight.then(
              (m) => ({ status: "sent" as const, message: m }),
              () => ({ status: "failed" as const }),
            );
            let cutTimer: ReturnType<typeof setTimeout> | null = null;
            const abandoned = new Promise<{ status: "abandoned" }>((resolve) => {
              cutTimer = setTimeout(
                () => resolve({ status: "abandoned" }),
                Math.max(0, sendDeadline - Date.now()),
              );
            });
            const raced = await Promise.race([settled, abandoned]);
            // Cleared either way: a pending timer would hold the isolate (and
            // the abandoned scan's promise) open past this tick.
            if (cutTimer !== null) clearTimeout(cutTimer);
            // The never-miss rule as one tested function (deferrallog):
            //   sent      → audit it (hard proof of delivery)
            //   failed    → release the claim + surface the failure (catch
            //               below, unchanged — a rejected card was NOT sent)
            //   abandoned → keep the claim, record it durably, watch it to a
            //               conclusion in the background
            const plan = cardSendDisposition(raced.status);
            if (plan.throwFailure) {
              throw new Error(
                `initial-card send failed (Telegram did not accept it — the card was NOT delivered)`,
              );
            }
            const symbol = c.profile.symbol ?? c.pair.baseToken.symbol ?? null;
            const auditDelivery = async (messageId: number): Promise<void> => {
              try {
                await this.db.recordPushDelivery({
                  chatId: c.chatId,
                  token: c.profile.tokenAddress,
                  symbol,
                  messageId,
                  mcapAtPush: c.pair.marketCap,
                  kind: "initial",
                });
              } catch {
                /* audit is best-effort */
              }
            };
            if (plan.audit && raced.status === "sent") {
              // Delivery audit: Telegram returned a message_id, so the card
              // left us and was accepted. Recording it lets a later "never
              // got the first card" report be answered with hard evidence.
              await auditDelivery(Number(raced.message.message_id ?? 0));
            }
            if (plan.recordUnconfirmed) {
              // ABANDONED: the request is still in flight, so the card may
              // already be in the chat. KEEP the claim — it is the only thing
              // stopping the re-eval pool from sending a second card — and
              // record the send durably so the worker's reconcile
              // (reconcileUnconfirmedCardSends) can release it if nothing
              // ever proves delivery. The audit ring gets NOTHING here: an
              // entry means Telegram ACCEPTED a card.
              const recordUnconfirmedSend = async (): Promise<void> => {
                try {
                  const prev = await this.db.getWorkerState(
                    UNCONFIRMED_CARD_STATE_KEY,
                  );
                  await this.db.setWorkerState(
                    UNCONFIRMED_CARD_STATE_KEY,
                    addUnconfirmedCardSend(prev, {
                      chatId: c.chatId,
                      token: c.profile.tokenAddress,
                      at: Date.now(),
                      symbol,
                    }),
                  );
                } catch (err) {
                  // The record is what later RELEASES the claim, so losing it
                  // can only cost a duplicate, never a card: the claim stays,
                  // and a coin whose card never arrived is still re-sent by
                  // the tracker's self-heal (which allows a 補發 whenever
                  // there is neither proof nor an unconfirmed record).
                  console.warn(
                    "[scanner] unconfirmed card-send record write failed (claim kept):",
                    err instanceof Error ? err.message : err,
                  );
                }
              };
              const clearUnconfirmedSend = async (): Promise<void> => {
                try {
                  const prev = await this.db.getWorkerState(
                    UNCONFIRMED_CARD_STATE_KEY,
                  );
                  await this.db.setWorkerState(
                    UNCONFIRMED_CARD_STATE_KEY,
                    removeUnconfirmedCardSend(prev, c.chatId, c.profile.tokenAddress),
                  );
                } catch {
                  /* the worker's reconcile drops it on proof */
                }
              };
              await recordUnconfirmedSend();
              // Settle in the background: the tick is over either way. A late
              // success AUDITS the card (nothing re-pushes the coin, and the
              // tracking this call starts is the follow-up it was owed); a
              // late rejection RELEASES the claim (the never-miss half); an
              // isolate that dies before either is the reconcile's job.
              void settled
                .then(async (r) => {
                  if (r.status === "sent") {
                    await auditDelivery(Number(r.message.message_id ?? 0));
                    try {
                      await this.pushWatcher?.onPush(
                        c.chatId,
                        c.profile.tokenAddress,
                        symbol,
                        c.pair.marketCap,
                        c.pair.liquidity.usd,
                      );
                    } catch {
                      /* tracking is optional */
                    }
                  } else {
                    try {
                      await this.db.unclaimTokenPush(
                        c.chatId,
                        c.profile.tokenAddress,
                      );
                    } catch {
                      /* best-effort — the reconcile retries the release */
                    }
                  }
                  await clearUnconfirmedSend();
                })
                .catch(() => {
                  /* the reconcile settles whatever this isolate cannot */
                });
              return;
            }
          } catch (err) {
```

**行為對照（為何唔會漏、為何少重複）**

| Telegram 事實 | 舊行為 | 新行為 |
|---|---|---|
| 接受（返 message_id） | audit `initial`，claim 保留 | 一樣 |
| 明確拒絕（4xx/網絡錯） | throw → unclaim → 下 tick 補推 | 一樣（`plan.releaseClaim` 由原本嘅 catch 執行） |
| deadline 前冇答案 | throw → unclaim → **即刻重推（重複）** | **唔 unclaim**、寫 durable 記錄、背景跟到有答案；證實失敗先放 claim |

---

## Patch 3／4：worker 側 reconcile（`src/worker.ts`）—— 三態 send 嘅**必需**配套

冇呢塊，`abandoned` 嘅 claim 就永遠留住：卡片真係送唔到嘅話，硬幣就一直「已推」→ **漏推**。
所以要貼。兩處改動：import 同 `dropDeliveredPendings` 後面加一個函數 + 一行呼叫。

### 3a. import（`src/worker.ts` 頂 `./deferrallog` 嘅 import block）

```ts
import {
  PUSH_DEFERRAL_STATE_KEY,
  heldBackCandidates,
  loadPushDeferralSnapshot,
  nextPushDeferralSnapshot,
  deliveredDeferredTokens,
  duplicateInitialTokens,
  parsePushDeferralSnapshot,
  pushDeferralAlreadyApplied,
  pushDeferralDelta,
  // 三態 send（2026-09-20）：abandoned 嘅卡由下面 reconcileUnconfirmedCardSends 收尾。
  deliveredCardTokens,
  parseUnconfirmedCardSends,
  serializeUnconfirmedCardSends,
  settleUnconfirmedCardSends,
  UNCONFIRMED_CARD_STATE_KEY,
  UNCONFIRMED_CARD_GRACE_MS,
  type PushDeferralSnapshot,
} from "./deferrallog";
```

### 3b. 新函數（貼喺 `dropDeliveredPendings` 同 `syncPushDeferralCounters` 之間）

```ts
/**
 * Settle the durable "unconfirmed card send" records — the third state of the
 * send (see deferrallog.UNCONFIRMED_CARD_STATE_KEY).
 *
 * A card send that was ABANDONED (the tick stopped waiting while the request
 * was still in flight) keeps its seen_tokens claim so nothing re-pushes it, and
 * records itself durably. That record has exactly two endings, and this decides
 * both:
 *
 *   * the audit ring proves a card for that token was delivered → drop the
 *     record, the claim stands (the card arrived; re-pushing it IS the
 *     duplicate the operator reported);
 *   * two tick cadences pass with no proof anywhere → release the claim, so a
 *     later scan re-pushes the coin (never miss; at most one duplicate, two
 *     minutes late).
 *
 * The fast path is the scanner's own background settle, which lands within a
 * second of the send. This runs for records the scanner could not settle, i.e.
 * exactly the case where the sending isolate died before it could.
 *
 * ORDERING IS LOAD-BEARING: the SHRUNK row is persisted BEFORE any claim is
 * released, and nothing is released when that write fails. A record that
 * outlived its own release would release again on the next tick, and if the
 * coin had been re-pushed and re-claimed in between, that second release would
 * delete the NEW claim and put a third card in flight.
 */
async function reconcileUnconfirmedCardSends(): Promise<void> {
  if (!db) return;
  let raw: string | null;
  try {
    raw = await db.getWorkerState(UNCONFIRMED_CARD_STATE_KEY);
  } catch (err) {
    // Unreadable row: nothing is settled this tick. The record is durable, so
    // waiting is free; guessing costs a card.
    console.warn(
      "[worker] unconfirmed card-send read failed (nothing settled):",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  const records = parseUnconfirmedCardSends(raw);
  // The common tick: no record at all, one read, nothing else.
  if (records.length === 0) return;
  let proven: Set<string>;
  try {
    // ONE read of the ring the deferral guard already reads. A failed read
    // must NOT be taken as "nothing was delivered" — that would release
    // claims on a guess.
    proven = new Set(deliveredCardTokens(await db.getPushAudit()));
  } catch (err) {
    console.warn(
      "[worker] unconfirmed card-send proof read failed (nothing released):",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  const settled = settleUnconfirmedCardSends(
    records,
    Date.now(),
    UNCONFIRMED_CARD_GRACE_MS,
    proven,
  );
  if (settled.confirmed.length === 0 && settled.release.length === 0) return;
  try {
    await db.setWorkerState(
      UNCONFIRMED_CARD_STATE_KEY,
      serializeUnconfirmedCardSends(settled.kept),
    );
  } catch (err) {
    console.warn(
      "[worker] unconfirmed card-send shrink write failed (nothing released):",
      err instanceof Error ? err.message : err,
    );
    return;
  }
  if (settled.confirmed.length > 0) {
    console.log(
      `[worker] ${settled.confirmed.length} unconfirmed card send(s) proved delivered — claim kept, nothing re-pushed`,
    );
  }
  for (const r of settled.release) {
    try {
      await db.unclaimTokenPush(r.chatId, r.token);
      console.log(
        `[worker] unconfirmed card send for ${r.symbol ?? r.token} proved undelivered — claim released, a later scan re-pushes it`,
      );
    } catch (err) {
      console.warn(
        "[worker] unconfirmed card-send claim release failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
```

### 3c. 一行呼叫（`syncPushDeferralCounters`，喺 `dropDeliveredPendings` 之後）

**OLD**

```ts
  const stale = await dropDeliveredPendings(db, durable?.pendingTokens ?? []);
  const owedPending = durable
```

**NEW**

```ts
  const stale = await dropDeliveredPendings(db, durable?.pendingTokens ?? []);
  // 三態 send 嘅配套：收尾 abandoned 嘅卡（見 reconcileUnconfirmedCardSends）。
  // 同 duplicate guard 並排，因為兩者答同一條問題 ——「呢隻幣仲欠唔欠一張卡」。
  // 冇記錄嘅 tick 只係一個 read；有記錄先會寫 / unclaim。
  await reconcileUnconfirmedCardSends();
  const owedPending = durable
```

---

## Patch 4／4（**可選加強**）：send slice 下限 600→900、claim 下限 250→700

reserve=1500 已經買到同一個效果，所以呢塊唔貼都可以。要貼就**兩邊一齊貼**，否則 CI 紅。

### 4a. `src/scanner.ts`（窗口內，兩行）

```ts
const CARD_SEND_FLOOR_MS = 600;   →  const CARD_SEND_FLOOR_MS = 900;
const CARD_SEND_MIN_MS = 250;     →  const CARD_SEND_MIN_MS = 700;
```

### 4b. `scripts/test-unit.js` 四條斷言（~2250–2290 行）

實測（今次真係改咗常數再 build 去量）：`cardSendDeadline` 邊界由 **4150/4151** 移到
**3700/3701**，`cardClaimDeadline` 邊界由 **3550/3551** 移到 **3100/3101**。

**OLD**

```js
    // Late but still usable: clamped by the tail, not by `now + floor`.
    assert.equal(cardSendDeadline(t0, t0 + 4_000), t0 + 4_400);
```

**NEW**

```js
    // Late but still usable: clamped by the tail, not by `now + floor`.
    assert.equal(cardSendDeadline(t0, t0 + 3_600), t0 + 4_400);
    // No sub-700ms slice is ever handed out any more: a send starting at
    // 4_000ms (the shape that used to get 400ms and get cut mid-flight) is
    // now refused outright — deferred, not half-sent.
    assert.equal(cardSendDeadline(t0, t0 + 4_000), null);
```

**OLD**

```js
    // Boundary: exactly the minimum slice is still attempted, one ms more is
    // not (the card is deferred, not dropped).
    assert.equal(cardSendDeadline(t0, t0 + 4_150), t0 + 4_400);
    assert.equal(cardSendDeadline(t0, t0 + 4_151), null);
```

**NEW**

```js
    // Boundary: exactly the minimum slice (700ms) is still attempted, one ms
    // more is not (the card is deferred, not dropped).
    assert.equal(cardSendDeadline(t0, t0 + 3_700), t0 + 4_400);
    assert.equal(cardSendDeadline(t0, t0 + 3_701), null);
```

**OLD**

```js
    // Late but affordable: 700ms of tail still covers 400 (claim) + 250
    // (least send).
    assert.equal(cardClaimDeadline(t0, t0 + 3_500), t0 + 3_900);
    // Boundary: exactly 650ms of tail, one ms less is refused.
    assert.equal(cardClaimDeadline(t0, t0 + 3_550), t0 + 3_950);
    assert.equal(cardClaimDeadline(t0, t0 + 3_551), null);
```

**NEW**

```js
    // Late but affordable: the claim runs while 400 (claim) + 700 (least send)
    // are still available before the 4.2s internal deadline.
    assert.equal(cardClaimDeadline(t0, t0 + 3_000), t0 + 3_400);
    // Boundary: exactly 1100ms of room, one ms less is refused. NB the tail
    // clamp is what moves this from 3550 to 3100 — past it the send's own
    // floor (900) can no longer cover the 700 minimum.
    assert.equal(cardClaimDeadline(t0, t0 + 3_100), t0 + 3_500);
    assert.equal(cardClaimDeadline(t0, t0 + 3_101), null);
```

唔變嘅斷言（保留）：`+2_000`/`+3_000` → `t0 + 4_200`；`+4_309` → `null`；`+9_000` → `null`；
`cardClaimDeadline` 嘅 `+2_000` → `t0 + 2_400`、`+3_792`/`+4_200`/`+9_000` → `null`。

順手要更新（純註釋，唔會令 CI 紅）：`src/scanner.ts` ~237–300 行嘅 `CARD_SEND_FLOOR_MS` /
`CARD_SEND_MIN_MS` 註釋仍然寫住「4150/4151、3550/3551」同「raising THIS value (to ~900…)」——
改完之後應改成 3700/3701、3100/3101（或者索性刪走舊邊界嗰兩句）。

---

## 貼完之後嘅驗收點

1. `bun convex`／`npm run test:unit`：214 passed（三態規則已釘）＋ 四條新邊界斷言（只有貼咗 Patch 4 才需要）。
2. `npx tsc --noEmit` 過（Patch 2 嘅 `plan` / `raced` 收窄係嚴格模式友善；`settled` 永遠唔 reject）。
3. Live：同一個 token 喺 `/debug/push-audit` **只應有 1 條 `initial`**；`seen_tokens` 唔應該再因為
   send timeout 而被刪（`/debug/chats` 唔應該再出現 `initial-card send exceeded its deadline` 配住下一 tick 重推）。
4. 反面（防漏推）：`pushwatch` 嘅自我修復仍然要為「完全冇 entry 而且冇 unconfirmed 記錄」嘅 token 補發；
   reconcile 之後 `unconfirmed_card_sends` 行應該返 `[]`，而 release 過嘅幣要喺下一個 scan 真係再推。
5. 觀察 `console.warn`：`unconfirmed card-send record write failed` / `proof read failed` / `shrink write failed`
   —— 三者任何一個都代表「寧可重複，唔會漏」，但值得跟。


---

## 2026-09-21：量 `preRace` 花喺邊（`summary.preTick`）

### 問題

信封算術一直係 `scanRaceMs = max(2500, 9500 − 4500 − preRace)`，所以 `preRace` 係**唯一一條**
「只要慢就即刻食掃描窗口」嘅數。但佢一直**冇讀數**：

- `dbSteps`（tickprobe）量嘅係**掃描內**嘅 DB step（live：`getTokenStatsMany {calls 1, ms 113}`）；
- `modeRead` 量嘅係**掃描內**嘅 trade-mode 讀（live：`{reads 1, lastReadMs 105, cachedAgeMs 2127}`）；
- 兩者都喺 scan 開始之後，答唔到「掃描之前用咗幾多」。

唯一嘅間接證據係**被切嗰行**：`err` 寫住窗口，所以 `preRace = 9500 − 4500 − 窗口`。
（`docs/push-baseline-ledger.md` 嘅未解項 1 就係靠呢條式子推「preRace 實測 1–4s，候選係 Turso latency」。）

### 量到嘅（live，`/debug/scan-history?limit=200`，120 行 ≈ 2 小時）

| tick（Z） | 窗口 | 反推 preRace | 結果 |
|---|---|---|---|
| 10:01:06 | 4386ms | **614ms** | 被 race 切（唔係被 scan 自己嘅 4.2s deadline 切）|
| 10:53:10 | 2500ms（**下限**） | **≥ 2500ms** | 被 race 切，而且該 tick 總共行咗 **11.5s**（連 flush 都過鐘）|

同一窗口仲有 4 行 `previous tick died before its completion flush`（10:03、10:17、10:19、10:20Z）。
老實講：嗰 4 行嘅 `ms`（62–101s）唔係掃描時長，而係**後繼 tick 同死 tick 嘅距離**，我只當佢哋係
「同時段信封出事」嘅旁證，未歸因。

### payload 半邊已經排除

`heartbeatJson` 用嘅 mirror（`skipCapture` / `heal` / `dex` / `deferral` / `pushLedger`）本來係
「CPU 貴」嘅嫌疑。實測（直接攞 live `/health` 嘅 heartbeat object，序列化後 4513 bytes）：

```
JSON.stringify(heartbeat) × 2000 → 25.1ms  ⇒ 0.013ms / 次
```

即係 payload 半邊**結構上唔可能**解釋 614ms，更加唔可能解釋 ≥2500ms。剩低嘅嫌疑人只有
**claim 嗰個 round trip**（`claimScanLock`：heartbeat + lock INSERT，有 backfill 就多一行）
—— 冷 isolate 嘅第一個請求（新連線/TLS）同 Turso 抖動都喺呢一步。呢個就係今次加讀數要分開嘅兩半。

### 加咗嘅讀數

`summary.preTick`（`/health`、`/debug/tick` 都有）：

```json
{
  "at": 1758452345678,          // handler entry，對齊 heartbeat.at / scan_history.at
  "steps": { "bump": 120, "init": 40, "gate": 260, "outage": 30, "json": 3, "claim": 611 },
  "preStartMs": 450,           // handler entry → startedAt（食 wall clock，唔食掃描窗口）
  "preRaceMs": 614,            // startedAt → race 開始（**呢個**才食掃描窗口）
  "raceMs": 4386               // 實際派到嘅窗口
}
```

- `bump` / `init` / `gate` / `outage` = handler 入面四個步驟（cron counter 寫、`ensureInitialized`、
  cadence gate 讀、outage check），全部喺 `startedAt` 之前。`gate` 用 `finally` 包住，所以**被 skip 嘅 tick
  一樣報數**（skip 嘅成因就係嗰個讀）。
- `json` = payload 組裝 + 序列化（CPU，預期 ~0）；`claim` = claim round trip（DB）。兩者相加 ≈ `preRaceMs`。
- 未量到嘅一律 `null`，**唔會**填 0（0 會讀成「好快」）。
- 被 race 切嗰行嘅 `err` 亦開始自帶拆帳：
  `scan exceeded its 4386ms race window (tick budget 9500ms, flush reserve 4500ms, preRace 614ms = json 3 + claim 611)`。

### 點讀

| 讀數 | 意思 |
|---|---|
| `preRaceMs` 400–700ms、`claim` ≈ 全部 | 正常：一個 Turso round trip 就係咁貴 |
| `claim` 突然 1.5s+ | Turso 抖動／冷 isolate 首個請求 —— 該 tick 已經冇咗 1.5s 掃描 |
| `raceMs == 2500`（下限） | 警號：`preRace ≥ 2500`，race 已經唔再由 `budget − reserve` 決定 |
| `json` 佔比大 | 唔應該發生；發生即係 mirror 其中一個 getter 變成有 I/O |

### 驗收點（deploy 後）

1. `/debug/tick` 或 `/health`：`summary.preTick` 出現、`steps.json + steps.claim ≈ preRaceMs`。
2. 下一次 race cut 嗰行 `err` 自帶 `preRace Xms = json Y + claim Z`；Y 應該係個位數 ms。
3. `raceMs` 未再跌到 2500（跌到就係上面嗰個警號，唔好當「有下限所以冇事」）。

### 未做（老實講）

- **未修**：呢一步只係裝讀數。要唔要修（例如 claim 前預熱連線、或將 `bump`/`outage` 移出前置路徑）
  應該等 live 拆帳出咗數先決定 —— `docs/push-baseline-ledger.md` 未解項 1 嘅「候選係 Turso latency」
  而家有得證實或推翻。
- 4 個 dead-tick backfill（10:03–10:20Z）未歸因；佢哋同 10:53 嗰個 11.5s tick 有冇共同前置，要等下一批讀數。
- `bump` 用自己嘅 raw client（`new Db` + 一個 round trip，喺 init 之前），所以冷 isolate 嘅
  `bump + init + claim` 係**三個**各自可能要開連線嘅步驟；呢點只有在 live 見到 `claim` 對唔上 round-trip
  成本時才值得追。
- `steps.json` 由 `heartbeatAt` 開始量，而 `heartbeatAt` 喺「fallback heartbeat read」之後：cron 同
  HTTP fallback 都會傳入嗰個 read，所以只有 `/debug/tick` 嗰條路會多一個 read 而唔計入任何 step。
