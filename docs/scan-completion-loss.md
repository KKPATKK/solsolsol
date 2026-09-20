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

## 唔做 `DB_REQUEST_TIMEOUT_MS`：算術唔支持

原本嘅想法係「令吊死嘅第一次 flush 喺 reserve 內 abort，重試先有機會落地」。查完常數後
唔成立：

- `FLUSH_ATTEMPT_BOUND_MS = 1200`（唔係 2500）→ 第一次嘗試只等 **1.2s** 就轉為**並行**重試；
- 重試嘅等待窗係 `remainingFlushMs()` ＝ `4500 − 1200` ≈ **3300ms**，同 transport timeout **無關**；
- `DB_REQUEST_TIMEOUT_MS = 6000`（硬牆 7.2s）→ 就算降到 3s（硬牆 3.6s）仍然 > 3300ms，對
  flush 嘅窗**零影響**，只會令其他熱路徑（command handler、`/debug`、deferred drain）更早
  放棄 → 多一個失敗源。

**而 reserve 亦冇得加大**：`scanRaceMs = max(2500, BUDGET − RESERVE − preRace)`，所以 flush 嘅
窗永遠係 `[BUDGET−RESERVE, BUDGET]`，固定結束喺 **t≈9.5s**；加大 RESERVE 只係由掃描度搶時間。
檔案自己記載嘅實測：**cron invocation kill 就喺 ~9.6s 之後**（2026-09-15 用 12s budget 時每一
tick 都死，而成功嘅 tick 喺 8.7–9.6s flush）。即係 9.5s 已經貼住 kill，冇得延後 →
**字節係唯一仲買得返嘅嘢**。

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

- completion flush 本身（窗口外，需要上面那段 patch）。
- `pendingTokens` 上限 500：功能狀態（真正等住推送嘅幣），唔可以截；500 個 base58 地址會令
  snapshot 爆到 ~22KB，但實測 pending 只有 4–6 個 → 冇動，只記錄。

## 驗收點（deploy 後）

- 主：`scan-history` 嘅**連續** dead 行長度上限（改前 5–13 連）→ 應縮到 1–2。
- 次：`/health` 嘅 `heartbeat` 大小（`JSON.stringify(heartbeat).length`）應由 ~12.4KB 跌到 ~5.7KB；
  `deferral.events.length` ≤ 12；`summary.rejects.length` ≤ 20。
- 輔：`outageAlertAt` 更新頻率；warm isolate `/health` 嘅 `wedgedStateResets`。
- **唔可以**再用 dead 行判斷「有冇掃描」——要交叉核對 `/debug/pushes` 嘅時間戳。
- 量度注意：**任何 HTTP 路由都會行 `maybeRunScanIfStale`**，所以 curl `/health`（或
  UptimeRobot）本身會補跑掃描、令 cron 分鐘行消失（會見到 `scanCount 1` 嘅新 isolate）。
  睇 `tickRing` 才分得清 cron 有冇 fire。
