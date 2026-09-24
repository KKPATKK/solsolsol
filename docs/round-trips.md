# 唔付費路線：減 invocation 內嘅 Turso round trip

> 背景：一個 cron tick 嘅**真·硬上限**係 Workers Free 嘅 **50 subrequests per invocation**，
> 而呢個 bot 嘅 Turso 走 HTTP transport（`src/db.ts` `createRawClient`），所以**每個 DB round trip
> 都係一個 subrequest**。爆預算之後，下一個 fetch／DB call 直接 throw，而 tick 尾段所有寫入
> （history row、`phase:done`、note、heartbeat）都係 best-effort ⇒ 一次性解釋晒 dead tick、
> note 停在 `running`、`err:Too many subrequests`、`lost_completion_write`。
> 診斷全文見 `docs/scan-completion-loss.md` 嘅「2026-09-23：dead tick 嘅真身」。

呢份 doc 記低「唔付費」方向第一刀落咗嘅 code（2026-09-23，已 push 並經
`.github/workflows/deploy.yml` 上線：commit `bba1312`，deploy run 35832992942 success，1m9s）。

## 1. 改咗邊五個位

| 位 | 之前 | 現在 |
| --- | --- | --- |
| cron 到達記錄（`scheduled_tick_total` / `_at` / ring） | 自己一個 raw client：**1 read + 1 write**（線上量到 `bump 564–2211ms`） | 讀搭 cadence gate 嗰個 read（`Db.getWorkerStates` 一次讀 2–3 個 key）；寫搭 scan-lock claim batch（`Db.scheduledTickStatements`）。**正常 tick 0 額外 round trip** |
| `init` 同 gate 兩次 heartbeat read | 2 次（同一行 `scan_heartbeat`） | 1 次（`lastHeartbeatRead` ＋ `HEARTBEAT_REUSE_MS` = 2s 重用窗口；`maybeRunScanIfStale` 都用同一個） |
| pass 嘅 recap claim ＋ prune | 2 次（`markRecapClaimedMany` ＋ `prunePushWatch`） | **1 次**（`Db.claimRecapsAndPrune`：claim UPDATE 同 bulk DELETE 同一個 batch） |
| pass 嘅 heal 開場讀（untracked ＋ push-baseline ledger） | 2 次（而且 ledger 讀只喺有料返時才付，即係最貼近 budget cut 嗰一刻先加一個 subrequest） | **1 次**（`Db.findUntrackedPushesAndLedger`） |
| pass 嘅 holder 寫入 | N 次（每個 probe 一次 `setPushWatchHolders`） | **1 次**（`Db.setPushWatchHoldersMany`，loop 完一次 flush） |

claim / prune / heal / holder 呢四項，全部係 `src/pushwatch.ts` 嘅 deep call site，改動記錄喺
`docs/patches/tracker-pass-batched-consumer.apply.js`。

## 2. 唔變嘅保證（呢啲係卡片正確性嘅底線）

* **claim-before-send**：recap 卡仍然係「claim 咗才發」。claim 只係由「獨立一個 request」
  變成「同 DELETE 同一個 batch」——按 libsql 嘅語意 batch 係**一個 request、statement 依序執行**，
  所以 claim 一樣喺發卡之前完成。
* **`expired` CAS**：claim 嘅 guard（`last_state NOT IN ('expired','unwatched')`）一字不改 ⇒
  第二個 isolate 拎唔到同一個 claim，唔會重複發 🏁 卡。
* **prune 只會收窄唔會放寬**：DELETE 用同一個 `windowCutoff`；而且以前「claim 成功但 prune 未跑」
  嘅窗口冇埋（同一個 batch 一齊 land 或者一齊唔 land），冇可能出現「行被刪但張卡冇出」。
* **park 語意**：probe 冇 count（timeout／無資料／throw）即刻 park 該行；batch 被拒就 park
  佢覆蓋嘅每一行 —— 同以前「單行寫入失敗」到達嘅狀態一樣。
* **holder 每行嘅數值同 cadence**：一行一個 count、一行一個 `holders_checked_at`，唔變。
* **trips 讀數唔會講大話**：`note` 尾嘅 `trips` 係由 pass 自己按「實際 await 咗幾次」數出嚟，
  test 有一條 `assert.equal(out.trips, calls.total)` 釘住（fakes 已跟新 shape）。

## 3. 落線點驗

`/health.pushWatchPass.note`（或 `/debug/tick` 嘅 pass 讀數）：

1. `trips N` 比同類 pass 低 3–5（setup −1、heal −1、holders −(N−1)）。
2. `spent.holders.trips` = 1（note 嗰段 `holders <ms>/<trips>`）。
3. `/debug/tick.summary.preTick.steps.bump` 唔應該再出現（正常 tick 搭住 claim batch 走；
   只有 `!scanner`、gate 讀失敗、或 claim 拎唔到 lease 嘅路徑才會 fallback 用 legacy bump）。
4. `summary.pushWatch` 唔應該再出 `err:Too many subrequests`；
   `/debug/push-watch.issues` 唔應該再增加 `lost_completion_write`。
5. 卡片方向：`dup-skip` 唔應該上升（呢批改動冇新增任何「唔送」出口）。

### 3.1 落線實測（2026-09-23 07:41–07:47Z，即 HKT 15:41–15:47，deploy 後第一節）

抽 `/health.pushWatchPass` 嘅 pass note（順序即時間序）：

| pass（UTC） | note 尾段 |
| --- | --- |
| 07:42:32 | `ok:0/0 deferred:tick-budget allow 2637 spend[setup 784/3 heal-cut 4254/8 miss1 enrolled1 pairs 0/0 rows 0/0 holders 0/0 held0 cut0] trips 11 db 4793ms` |
| 07:43:24 | `ok:4/0 rows 4/30 pairs 10/10 miss 0 lost 0 budget-cut allow 2500 spend[setup 508/2 heal 504/1 miss0 enrolled0 pairs 54/0 rows 1127/4 holders 0/0 held0 cut4] trips 8 db 2398ms` |
| 07:44:16 | `ok:3/0 rows 3/30 pairs 10/10 miss 0 lost 0 budget-cut allow 1844 spend[setup 509/2 heal-skipped 0/0 miss0 enrolled0 pairs 49/0 rows 802/3 holders 0/0 held0 cut4] trips 6 db 1565ms` |
| 07:46:52 | `ok:5/0 rows 5/30 pairs 10/10 miss 0 lost 0 budget-cut allow 3787 spend[setup 610/2 heal 1200/1 miss0 enrolled0 pairs 54/0 rows 1388/5 holders 0/0 held0 cut4] trips 9 db 3456ms` |

對照舊基線（`docs/duplicate-cards.md`：`setup 677/3 heal 231/1 … rows 6 → trips 11`
同 `rows 9 → trips 18`）：

1. **setup 3 → 2 trips**：`508/2`、`509/2`、`610/2`，三個有落 row 嘅 pass 都係 2（
   init／gate 合併一個 heartbeat read）。
2. **heal 2 → 1 trip**：07:43:24 同 07:46:52 都係 `heal …/1`（untracked ＋ ledger 一個
   batch）；冇嘢要 heal 嘅 pass 直接 `heal-skipped 0/0`，唔再為 ledger 付一個 subrequest。
3. **`trips` 總數**：rows 3 / 4 / 5 分別 `trips 6 / 8 / 9`，而每個 pass 嘅固定成本比舊
   基線低 2（setup −1、heal −1）；row loop 嘅 per-row CAS 仍然係主導項（§4 未做）。
4. **`spent.holders` 全部係 `0/0 held0 cut4`**——呢個係今節最誠實嘅一條，而同
   「冇 row due」唔一樣。`/debug/push-watch` 話 40 行裡有 35 行根本冇
   `holders_checked_at`（有 stamp 嘅只 5 行，最舊嘅 stamp 係 352–368 分鐘前），所以
   `head` 每次都滿（`slice(0, PUSH_WATCH_MAX_HOLDER_CHECKS = 4)` ⇒ `due` 4 行），但
   `Date.now() + TRACKER_HOLDER_CAP_MS > deadline` 喺 i=0 就 break，`holdersCut = 4`
   ——即係**舊有**嘅 holder stage 飢餓（跟呢批改動無關），而唔係「冇 probe 做」。
   後果有兩重，兩重都要講清楚：
   * 「N 次 probe → 1 trip」**今日喺線上冇行使過**，所以 holder 那項實際省到嘅
     round trip 係 **0**（舊 code 喺 0 個 write 嘅 pass 亦一樣係 0）；佢仍然係對嘅改動
     （一次 flush 代替 N 個 subrequest），但要等 holder stage 不再被切才有讀數。
   * holder 讀數（card 上嘅持有人數）今日實際上停寫：40 行裡 35 行冇 count 落過。
     呢個係一條獨立嘅覆蓋問題，同 §4 一樣未有解，唔應該當成「今次改動已驗」。
5. **cron 到達真係搭咗 claim**：`scheduled_tick_total` 54267 → 54273、
   `scheduled_tick_at` 每分鐘前行（07:41:31 → 07:44:16 → 07:45:18 → 07:46:32 →
   07:47:16），而同一時間 `/health.summary.preTick.steps` 係
   `{bump:0, json:0, claim:174/311}`：到達記錄由 claim batch 帶走，唔再自己一個 raw
   client（`bump 564–2211ms` 冇再出現）。
6. **冇爆 budget**：抽樣期間 heartbeat `err` 只有一個 race 切掃描嘅紀錄
   （07:46:25 `scan exceeded its 4689ms race window … preRace 311ms = json 0 + claim 311`，
   係 poll 撞正 in-flight scan），**冇** `err:Too many subrequests`；
   `/debug/push-watch.issueCount` 全程等於 **3**（CashFrog／Bengal／DeadCatBounce，
   全部係 2026-09-22 嘅舊 row），`lost_completion_write` 冇增加。
7. **`dup-skip` 冇上升**：抽樣期間冇任何 pass note 帶 `dup-skip`（`miss 0 lost 0`）。

## 4. audit 剩返落嚟嘅嘢

### 4.1 holder stage 嘅飢餓 — 已修（2026-09-23，已 deploy `57e06c7`／`010d319`）

第一節上線讀數揭到嘅唔係「冇 row due」，而係 stage 永遠起步唔到：佢排喺 pass 最尾，
而佢自己嘅規矩係「probe 嘅整個 `TRACKER_HOLDER_CAP_MS`（1200ms）要 fit 得入 pass
deadline 才開始」—— 但 row loop 每次都先花光 allowance。讀數：40 行裡 35 行完全冇
`holders_checked_at`，最舊 stamp 368 分鐘，而每個 pass 都係 `holders 0/0 held0 cut4`。

修法：**probe 搭住 pair batch 起步，collect 留返最尾**（寫入次序一字不改）。

* 起步位：`runTick` 嘅 pair batch 之後（`holderProbe*` 一組 local：`Due`/`Held`/
  `Misses`/`Writes`/`Pending`/`Unsettled`）。起步條件**一字不改**
  （`Date.now() + TRACKER_HOLDER_CAP_MS <= deadline`），只係喺呢個位 pass 仲有 1.0–3.0s。
* 收集位：原本嘅 holder stage，只剩 `await bounded(Promise.all(pending), min(cap, 剩餘))`
  ＋一個 batch 寫入（`setPushWatchHoldersMany`）。
* **點解唔搶 row 時間**：probe 係 I/O-bound HTTP（Birdeye `token_overview`，實測
  300–900ms，就係 cap 定 1200 嘅原因），而 row loop 嘅時鐘係 Turso round trip ——兩種唔
  同性質嘅時間 ⇒ 並行而唔係排隊。
* **語意不變**：所有寫入照舊喺 row loop 之後、次序一樣；只有真正拿到 count 嘅 probe 才
  會有寫入；`bounded(...)` 仍然係唯一上限；答唔到嘅 row 照舊 park（只有成功才清 park）。
* note 讀數：`holders <ms>/<trips>` 嘅 ms 而家係 **collect** 嘅時間（probe 已同 row loop
  重疊），`trips` 一樣係「一個 batch = 1」；`held` 不變；`cut` = 今個 pass 拿唔到 count 嘅
  due row —— 實際上係「起步位都唔夠 1200ms」那批（
  「起步咗但仲飛緊」係安全網，只有 timers 被星死才會發生，因為起步條件已保證 probe 自己
  嘅 cap 會先到期）。
* 測試：`test-unit.js` 加兩條 —— (a) 4 行 due、row loop 食完全部 allowance
  （400ms/row vs 2s）之下仍然 4 個 probe 起步、4 個 count 一次 batch 寫入（舊 code 喺同一
  shape 下係 `probes 0`，所以係真 regression test）；(b) allowance 剩返 < cap 時一個 probe
  都唔起，note 讀 `held0 cut1`。
* note 多兩個讀數：`probe<N> miss<M>`（patch `holder-stage-probe-counters.apply.js`）。
  理由係實測逼出來嘅：`holders 0/0 held0 cut0` 可以係「冇 row due」又可以是
  「4 個 probe 起步、4 個都 miss」——因為 miss 唔寫任何嘢，而且被 miss 嘅 row 係剛剛
  檢查完，佢已經離開 rotation 頭，park 永遠唔會顯示成 `held`。舊讀數就係因此隱瞞咗
  颟餓一個鐘。
* 改動落線紀錄：`docs/patches/holder-stage-probes-early.apply.js`
  （＋ `holder-stage-cut-semantics.apply.js` 修正第一版寫錯嘅一條測試 —— 「起步咗但未完」
  嘅路徑其實到唔到，見上面；＋ `holder-stage-probe-counters.apply.js` 上一個 bullet）。

#### 4.1.1 上線後讀數（deploy `57e06c7` @ 08:05Z，note 版本 `010d319` @ 08:21Z）

| 時間（UTC） | note 尾段 |
| --- | --- |
| 08:10:27 | `holders 274/1 held0 cut0`（第一批 count 落地） |
| 08:23:54 | `holders 131/1 held0 cut0 probe4 miss3` |
| 08:25:01 | `holders 120/1 held0 cut0 probe4 miss3` |

1. **`probe4 miss3`** = 每個 pass 4 個 probe 都真係起步，3 個撞 cap／冇 count
   （park 10 分鐘），1 個答到 → 一個 batch 寫入（`holders …/1`）。同一 shape 之下舊 code
   係 `holders 0/0 … cut4`。
2. **卡片層面**：`/debug/push-watch` 有 `holders_checked_at` 嘅 row 由 **5 → 15**，
   30 分鐘內刷新過嘅有 **9** 行（counts 1937 / 193 / 536 / 853 / 546 / 253 / 232 /
   1042 / 1144）——「35 行從來冇 count」嘅颟餓狀態結束。
3. **速率對得住設計**：29 行 active ÷ 30 分鐘 refresh window ≈ 0.97 行/min，實測
   ~1 行/pass（1 pass/min）⇒ 行得切。
4. **`cut0` 全程**：冇一個 due row 得唔到 turn（舊 shape `cut4` 冇再出現）。
5. 唯一未改善嘅係 Birdeye 自己嘅長尾（`/debug/birdeye-overview` 實測 323 / 323 /
   **2296**ms）：過 1200ms cap 嘅 probe 就算 miss（park 10 分鐘再試）。呢個係 cap 嘅原意，
   唔係 bug；要推高命中率先要動 `TRACKER_HOLDER_CAP_MS`，而家冇必要（見第 3 點）。
   **2026-09-23 更正**：同一個 probe 再量係 `1_008–2_525ms`（六個裡面五個過 1200），即係
   endpoint 自己慢咗一個量級 ⇒ cap 已經唔再係「原意」，變咗命中率嘅天花板。呢點就係 §4.3。
6. 順帶一個不是今次改動嘅數字：`/debug/push-watch.issueCount` 3 → 4，新增嘅係
   04:17Z 嘅 `REALLY`（`lost_completion_write`，checked == alertAt）——時間戳比今次
   deploy（08:05Z）早四個鐘，同 holder 改動無關，但既然看到就照記。

### 4.2 row loop 嘅 per-row CAS — 已修（2026-09-23，已 deploy `21521eb`）

原本每個 silent row 一個 round trip（`claimPushWatchCheck`：CAS 同 check fields 同一個
statement），而 **pass 嘅覆蓋率就係佢嘅 trips**（live `rows 5/30 … spend[rows 1388/5] trips 9`，
每行 ~150–400ms），同時 ~90% 嘅 row 其實係 silent（冇嘢要 announce）。

修法：silent row **入 queue**（`silentChecks`），loop 完之後**一次 batch**
（`Db.claimPushWatchChecksMany`）——每個 statement 同以前逐行嘅一模一樣：
`SET <check fields>, last_checked = ? WHERE token = ? AND last_checked = ?`。

* **不動嘅語意**：cross-isolate 排他（輸嘅 row 照舊 count `lost` 兼 skip）、
  每行原子性（claim ＋ fields 同一 statement）、pair-miss 嘅 row 完全冇 claim、
  而 **alerting path 一個字都沒改**（claim → reserve → send → final write —— 卡片嘅
  reservation 一定要在 send 之前落地）。
* **寫入時序**：silent 嘅 fields 原本逐行即時寫，現在 loop 完一次寫。冇任何 row 會讀
  自己嘅 stored fields（`evalResult` 來自 snapshot）⇒ 次序不影響結果；唯一分別是
  「寫之前 pass 死掉」嘅損失由 0 變最多一個 head（下一 pass 重算重寫，high-water mark
  係單向抬升）。
* **batch 被拒**：整批唔寫，每行保持未 claim、保住 rotation 位置 —— 同以前
  「逐行寫失敗」到達嘅狀態一樣；queue 空就零成本。
* **買到嘅嘢**：一個 pass 嘅 silent 部分由 N trips 變 **1 trip**，所以同一個 allowance
  覆蓋得到整個 head（10 行）而唔係 5 行；loop 嘅 reserve 機制（`tripMs` /
  `rowReserveMs`）現在只為 alerting row 服務（send 真嘅唔可以切一半）。
* 測試：兩條 pin 舊 per-row pricing 嘅 test 改成新形狀
  （`a silent row claims and writes in ONE round trip…` → `the whole head's silent claims and
  writes cost ONE trip`；`a degraded round trip stops the loop before it starts another row`
  → `a degraded store is paid ONCE for the whole silent queue`），另外 8 個 watcher test
  double 加咗 `claimPushWatchChecksMany`（逐行 mirror 舊行為，所以 `updated` 嘅 assertion
  全部仍然有效）；holder 餓那個 test 嘅「花光 allowance」道具也改成一個 1.6s 嘅 batch。
* 落線紀錄：`docs/patches/row-loop-batched-silent-claims.apply.js`
  （＋ `…fix1.apply.js` 綁 `now` 嘅編譯修正）。

#### 4.2.1 上線後讀數（2026-09-23 10:25–10:41Z，即 HKT 18:25–18:41；deploy `21521eb` @ 08:33Z）

| pass（UTC） | note 尾段 |
| --- | --- |
| 10:25:31 | `ok:10/0 rows 10/30 pairs 10/10 miss 0 lost 0 allow 4860 spend[setup 244/2 heal 244/1 miss0 enrolled0 pairs 146/0 rows 158/1 holders 2286/1 held0 cut0 probe3 miss2] trips 6 db 1243ms` |
| 10:38:46 | `ok:10/0 rows 10/30 pairs 10/10 miss 0 lost 0 allow 4862 spend[setup 548/3 heal 370/1 miss0 enrolled0 pairs 179/0 rows 133/1 holders 2307/1 held0 cut0 probe4 miss3] trips 7 db 1452ms` |
| 10:40:09 | `ok:10/0 rows 10/30 pairs 10/10 miss 0 lost 0 undelivered 1 allow 4860 spend[setup 338/3 heal 224/1 miss0 enrolled0 pairs 163/0 rows 1261/4 holders 1162/1 held0 cut0 probe4 miss2] trips 10 db 1603ms` |

1. **整個 head 一個 trip**：`rows 10/30`（舊基線 `rows 5/30`），而 silent 部分嘅價錢係
   `rows 133–158ms/1`（舊 `rows 1388/5`，每行 ~150–400ms）——同一個 allowance 由 5 行變 **10 行
   （head 上限）**，10 行只付一個 subrequest。呢個就係 §4.2 要買嘅嘢，量到咗。
2. **`trips`**：silent head 6（setup 2 ＋ heal 1 ＋ 有 cut mark 時嘅 audit 1 ＋ rows 1 ＋ holders 1）、
   alerting head 10（同一批再加 4 行 alerting path 嘅 claim／reserve／final write）。舊基線同樣 5 行係 9。
3. **`db` 1243–1603ms**：pass 自己嘅 round trip wall time，比舊基線（`db 2398–4793ms`）低一截 ⇒
   note 尾嗰個數字係回落嘅，唔係搬咗個成本去第二度。
4. **`pairs 146–179ms/0`**：pair 階段由 `lastPairs`（本 tick scan 前排已為 head 付過嘅批次）服務，
   冇自己去 DexScreener。同一段時間唯一一次見到 wire 上嘅係 10:29:19
   （`pairs 601/0 pairs 1/10 miss 9`，601ms ≈ 600ms 嘅 `TRACKER_PAIRS_BUDGET_MS`，即係嗰個 pass
   嘅 head 全部 miss 咗一次真 request）。所以 §4.4 嗰條「pair 重複讀」今日嘅形狀係 **0 個 HTTP**，
   唔係一個 tick 兩次 request。
5. **`miss 0 lost 0`**：head 10 行全部拿到 pair（新 head 每 pass 前進 10 行 ⇒ 30 行一輪約 3 分鐘，
   舊基線 5 行一輪 = 6 分鐘）。10:40:09 嗰個 pass 帶 `undelivered 1`：一張卡嘅 send 唔成功，
   rollback 照舊寫咗（下一步由 §11.3 嘅 audit ring 睇，唔靠 note）。

### 4.3 holder probe 嘅 cap 同 slot — 已修（2026-09-23，已 deploy `2b4b9fe`）

上線後嘅 holder 讀數（09:54Z `ae269d4` 前後）：

| 時間（UTC） | holder 段 |
| --- | --- |
| 10:25:31 | `holders 2286/1 held0 cut0 probe3 miss2` |
| 10:38:46 | `holders 2307/1 held0 cut0 probe4 miss3` |
| 10:40:09 | `holders 1162/1 held0 cut0 probe4 miss2` |

即係 `ae269d4`（把一個 gate 收進 cap）**冇改變命中率**：仍然係 4 個 probe 起步、2–3 個 miss。
量到嘅原因唔喺 gate，喺 endpoint：

* `/debug/birdeye-overview` 對一個 live tracked mint（INURANUS 嗰個 token）由 **worker 自己嘅
  egress** 連打六次：`1_008 / 2_368 / 2_525 / 2_281 / 2_451 / 2_272ms`。同一個 probe 喺
  2026-09-21 係 `303–907ms`（六個裡面五個）⇒ **endpoint 兩日內慢咗一個量級**，而 cap 仍然寫住
  1200：cap 落喺今日 median 之下，所以一個 pass 開 4 個 probe 就有 2–3 個一定撞 cap
  （park 10 分鐘，個 count 掉咗）。
* gate 本身唔係每個 probe 各付一次（同一 window 嘅 call 一齊 fire，`ae269d4` 嘅 stub 量到
  `302 / 1_402 / 1_402 / 1_404ms` 就係咁）——所以「N 個 probe = 一個 wait」係真，但每個 probe
  仍然係**一個獨立嘅 Birdeye subrequest**（invocation 嘅 50 之一），而舊 cap 之下 4 個裡面 3 個係白付。

修法（三樣，全部由上面嘅量決定）：

1. `TRACKER_HOLDER_CAP_MS` **1200 → 2400**（今日實測 median）。
2. `TRACKER_HOLDER_STAGE_MS` **2400 → 3500** ＝ cap ＋ 一個 gate：collect 一定要蓋得住自己開嘅
   bound，否則開咗都係 miss（呢個就係舊 shape 嘅 bug）。
3. slot 規則由「slice 蓋得住 gate＋fetch 就開整個 due head」改成 **一個 pass 一個 probe**：
   refresh window 只需要 ~1 count/min（29 行 ÷ 30 分鐘 ≈ 0.97，§4.1.1 已量），而每個額外 probe
   係一個獨立 subrequest；`cfg.maxHolderChecksPerTick` 仍然係上限，所以想開返 head 只需改呢一行。

**唔變嘅保證**：collect 仍然喺 row loop 之後、一個 batch 寫入；`holders_checked_at` 只喺成功時寫；
拿唔到 count 嘅 due row 照舊報 `cut`（唔 park）；miss 照舊 park `TRACKER_HOLDER_BACKOFF_MS`。

**代價（老實講）**：一個 pass 只 refresh 一行，而命中率 ≈ endpoint 回應喺 cap 之內嘅比例
（今日 ≈ 2/3）。而「一個 pass 一個 probe」仍然係 1,440 次/日 —— 相對 Birdeye 免費 quota 仲係天文數字，
所以 §4.4 再加一個 CU gap，順手把 park 由 10 分鐘縮到 3 分鐘（ladder）。

落線紀錄：`docs/patches/holder-probe-slots-measured.apply.js`（＋ `…fix1` 舊 wording、`…fix2`
移除已無讀者嘅 local、`…tests.apply.js` 重釘三條 test）。測試：`test-unit.js` 由
`probe4 / held0 cut0` 變 `probe1 miss0 / held0 cut3`，hanging 半由 `probe2 miss2`（1_400ms）變
`probe1 miss1`（2_600ms）⇒ **278 passed, 0 failed**（詳見 §5）。

#### 4.3.1 上線後讀數（deploy `2b4b9fe` @ 10:50Z，run 35851038091 success 1m20s）

| pass（UTC） | note 尾段 |
| --- | --- |
| 10:52:53 | `ok:10/1 rows 10/30 pairs 10/10 miss 0 lost 0 dup-skip 1 … spend[setup 209/2 heal 192/1 … pairs 0/0 rows 485/4 holders 570/1 held0 cut3 probe1 miss0] trips 9 db 1234ms` |
| 10:53:54 | `ok:10/1 rows 10/30 pairs 10/10 miss 0 lost 0 undelivered 1 … spend[setup 205/2 heal 193/1 … pairs 97/0 rows 2327/8 holders 130/1 held0 cut3 probe1 miss0] trips 13 db 2068ms` |
| 10:54:52 | `ok:10/1 rows 10/30 pairs 10/10 miss 0 lost 0 … spend[setup 201/2 heal 267/1 … pairs 131/0 rows 1138/5 holders 119/1 held0 cut3 probe1 miss0] trips 10 db 1408ms` |
| 10:55:53 | `ok:10/1 rows 10/30 pairs 10/10 miss 0 lost 0 … spend[setup 199/2 heal 201/1 … pairs 100/0 rows 1283/5 holders 123/1 held0 cut3 probe1 miss0] trips 10 db 1585ms` |

1. **`probe1 miss0` 全程**（舊讀數 `probe4 miss3`／`probe4 miss2`）：一個 Birdeye call、一個 count、
   **零個 park**。即係之前 4 個 call 裡面 3 個白付嗰條數冇咗。
2. **`holders` 嘅 collect 由 1162–2307ms 跌到 119–570ms**：probe 仍然開喺 pair batch 後面、同
   row loop 重疊，而家只等一個 call 嘅 fetch（cap 2400 之下 119–570ms 全部命中）
   ⇒ pass 嘅 wall clock 亦回落（`trackerMs` 1699–3171，早前同類 pass 係 3792–3938）。
3. **`held0 cut3`**：其餘三個 due row 照舊留喺 due list 頭位（唔 park、唔燒 call），下一個 pass 接，
   所以 30 分鐘 window 係靠「每次真係寫一行」而唔係「開四個得一個」。
4. **`rows 10/30` 同 `pairs 10/10` 不變**（§4.2 嘅 head 冇被影響）；10:52:53 帶 **`dup-skip 1`**
   —— 即係 audit ring 帶 `sig` 嘅 proof 真係入到去重判斷（一張卡被正確儉返）嘅嗰條路，
   同 §11.3 嘅要求對得上。
5. `/debug/tick.summary.pushWatch` 抽到嘅係完整 pass note（唔再係 `err:Too many subrequests`），
   但抽樣期間仍然有 pass 處於 `phase:"running"`（10:51:53、10:54:50 兩個 sample）——
   invocation 嘅 subrequest 上限本身**未有解**（§5 尾）。


### 4.4 Birdeye CU 預算：cap 可調、probe 要有 gap、park 3 分鐘加 ladder

**Quota 事實**（Birdeye Data API free tier）：**30,000 CU/月**。本 bot 用到嘅 endpoint 單價
（repo 內已記錄，同官方 docs 對得上）：`/defi/token_overview`（卡片持有人數 ＋ holder probe）
**20 CU**、`/defi/ohlcv`（首分鐘量、最低市值）**35 CU**、`/defi/v2/tokens/new_listing`
（定期 backfill，4 次/日）**30–80 CU**。

30,000 ÷ 20 ＝ **1,500 次/月 ≈ 50 次/日**，而係全個 bot 加起來。holder stage 嘅歷史用量：

| 形狀 | calls/日 | CU/日 | CU/月 |
| --- | --- | --- | --- |
| 舊（每 pass 4 個 probe，§4.1 之前） | 5,760 | 115,200 | 3.5M（quota 嘅 115 倍） |
| §4.3 之後（每 pass 1 個 probe） | 1,440 | 28,800 | 864K（28 倍） |
| **§4.4 之後（gap 60 分鐘）** | **24** | **480** | **14.4K（quota 嘅 48%）** |

即係「一個 pass 一個 probe」唔夠 —— 1 分鐘 cron 本身就係 1,440 次/日。**一定要有一個 gap。**

三個改動：

1. **cap 由 config 落**（`PUSH_WATCH_HOLDER_CAP_MS`，default `2400`，clamp 500–5000）：呢個係
   **hit-rate dial，唔係 latency dial** —— probe 收唔到 count 都照計 CU，所以 cap 低過 endpoint
   自己嘅 median 就等於「付錢、然後掉咗個答案」。實測六次 `1_008 / 2_368 / 2_525 / 2_281 /
   2_451 / 2_272ms` ⇒ cap 1500 會把 6 次裡面 5 次已付費嘅 call 掉棄（舊 `probe4 miss3` 就係咁），
   cap 2400 就六次全中（`probe1 miss0`）。
2. **probe 之間最少一個 gap**（`PUSH_WATCH_HOLDER_MIN_GAP_MIN`，default `60` 分鐘，`0` = 關）：
   上面張表嘅關鍵。stamp 係 durable（`worker_state.holder_probe_at`）⇒ 跨 isolate 有效；
   讀一次最多一個 gap（gap 未夠就用內存記住、唔再讀），寫一次一個 probe ⇒ 最多 2 個 round trip/小時。
   被 gap 擋嘅 pass，note 尾多一個 `cu-gate`，due row 照舊報 `cut`（唔 park —— 佢哋冇出錯，
   只係今分鐘冇 budget）。
3. **park 10 分鐘 → 3 分鐘，並每次連續 miss 加倍**（3/6/12/24，上限 30 分鐘）：
   「faster coverage」嘅另一半。probe 速率被 CU 綁死之後，一個 miss 嘅 row 唔應該再坐 10 個
   scarce turn；但一個「永遠最舊 `holders_checked_at`」嘅慢 row 亦唔可以食光所有 probe
   （2026-09-21 嘅 starvation 形狀），所以 ladder 令佢 3/6/12/24 分鐘後才排到。

**唔變嘅保證**：`holders_checked_at` 只喺成功時寫；collect 仍然喺 row loop 之後、一次 batch；
miss 照舊 park（唔會靜靜地當檢查過）；gap 只會令 probe 變少，唔會令卡少一張（holder 係卡 detail）。

**Tuning 表**（要快就調 `PUSH_WATCH_HOLDER_MIN_GAP_MIN`，唔使 redeploy）：

| gap | calls/日 | CU/日 | CU/月 | 30 行全輪一次 |
| --- | --- | --- | --- | --- |
| **60 分鐘（default）** | 24 | 480 | 14.4K | ~1.25 日 |
| 30 | 48 | 960 | 28.8K | ~15 小時 |
| 20 | 72 | 1,440 | 43.2K | ~10 小時 |
| 10 | 144 | 2,880 | 86K | ~5 小時 |

CU 一爆 quota，Birdeye 會開始回 429／要求付款，probe 同卡片路徑一齊受影響，所以 default 保守；
要更快就明確改呢個 env（同時要知 CU 月費付出）。

落線紀錄：`docs/patches/holder-probe-cu-budget.apply.js`（＋ `…fix1` 把 stamp 移出 holder stage
嘅 trip 窗、`…tests.apply.js` 加一條 CU-gate test ＋ 關掉 park test 嘅 gap）。測試：
`test-unit.js` 由 278 → **279 passed, 0 failed**（新 test：第一個 pass 出 1 個 probe，
第二個 pass 出 `held0 cut2 probe0 miss0 cu-gate`）。

#### 4.4.1 上線後讀數（`66a9321`，deploy run 35854326659，2026-09-23 11:24–11:28Z）

抽 `/health.pushWatchPass` 三個相鄰 pass（全部 `ok:10/0`、`rows 10/29`、`pairs 10/10`）：

| pass（`at`） | holder stage | allow | trips | db |
| --- | --- | --- | --- | --- |
| 11:24:26 | `holders 0/0 held0 cut3 probe0 miss0` | 2087 | 6 | 1286ms |
| 11:26:53 | `holders 140/1 held0 cut1 probe1 miss0` | 4880 | 12 | 1633ms |
| 11:27:51 | `holders 0/0 held0 cut2 probe0 miss0 cu-gate` | 4883 | 5 | 614ms |

* 11:26:53 ＝ gap 開閘後第一個 due row：**一個 call 收到一個 count**（`probe1 miss0`）、collect
  140ms、**零 park**、零 miss。舊形狀（`probe4 miss3`、collect 1162–2307ms、每 pass 4 個已付費
  但掉棄嘅 call）冇再出現。
* 11:27:51 ＝ 被 gap 擋嘅 pass：note 尾 `cu-gate`、`probe0 miss0`、holder stage 0ms／**0 CU**，
  due row 只報 `cut`（唔 park）。冇 paid call，所以個 pass 反而最短（614ms、5 trips）。
* 11:24:26 嘅 `cut3` **唔係** gate（冇 `cu-gate`）：嗰個 pass 嘅 allowance 只有 `allow 2087`，而
  開 probe 嘅條件係整個 cap（2400）要落喺 deadline 內 ⇒ 剩 2.0s 開唔到，三行照留隊頭。
  即係 cap 2400 之後，**probe 只會喺 allowance ≥ ~2.4s 嘅 pass 出現**（今日讀數 2.0–4.9s）——
  coverage 嘅真上限係 pass allowance，唔止係 gap。

#### 4.4.2 Quota 賬目（同日實測）：holder probe 唔係大戶

30,000 CU/月 係**全個 bot 共用**，而三個 Birdeye 消費者係：

| 消費者 | 單價 | 次數/日（實測） | CU/月 |
| --- | --- | --- | --- |
| holder probe（§4.4 之後） | 20 CU（`/defi/token_overview`） | 24（gap 60 分鐘） | **14.4K** |
| 卡片持有人數 `resolveHolderCount` | 20 CU（同上） | ~40–52（＝卡片數） | **24–31K** |
| 卡片 `resolveTraderData` | **未核實**（`/defi/v2/tokens/top_traders`，repo 冇記錄單價） | ~40–52 | 未核實 |
| `new_listing` backfill（4 次/日 × 1 chunk） | 30–80 CU | 4 | 3.6–9.6K |

卡片數實測（`/debug/pushes.byDay`）：09-16 25、09-17 43、09-18 33、09-19 32、09-20 40、09-21 52、
09-22 52、09-23（至 11:31Z）18 ⇒ **~40–52 張/日**。

⇒ holder probe 嘅 14.4K 只係 quota 一半唔到，**卡片側嘅 `token_overview`（20 CU × 40–52 ＝ 24–31K）
單獨就已經可以頂爆 30K**。今次**冇**動卡片側：改嘅係卡片顯示同 push 驗證嘅語意，唔應該順手做。

兩個省 CU 嘅位（兩個來源都已經喺 repo 內）：

* 卡片持有人數：同一張卡已經有 GMGN `holder_count`（`gmgn.ts`，0 Birdeye CU；卡片本身已有
  `🧠 GMGN: 👤N` 一行），改用佢即省 20 CU × 40–52 ＝ **24–31K CU/月**。
* tracker probe：同理改用 GMGN／Axiom 嘅持有人數，probe 就唔使 60 分鐘 gap，「30 行全輪」
  可以由 1.25 日壓到 ~30 分鐘。

CU 用量本身**冇任何計數器**（repo 內冇 Birdeye call 統計，`/debug/birdeye-overview` 只係手動
probe），所以上表除咗 probe 一項之外都係由卡片數推算 —— 2026-09-23 已補上量度，見 §4.5.1。

### 4.5 未做

* ~~**durable cron 到達記錄會停**（2026-09-23 13:46:27Z 起 ≥ 30 分鐘，見 §5.1 第 3 點）~~ →
  **已修，見 §4.5.3**。原本：`scheduled_tick_total` / `scheduled_tick_at` / ring 尾一齊凍結，而
  scan row 照落；要一個**唔經 claim batch** 嘅到達標記（或者睇 Cloudflare 嘅 cron 指標）才分得開
  「cron 冇投遞」同「cron 死喺 init」，而後者係 §1 搬走 pre-init 寫入之後新開嘅盲點（舊 code 喺
  init **之前**寫到達記錄，正正係為咗呢件事）。**呢句仍然成立**：fix 之前唔應該再加任何「到達記錄
  搭去第二個 write」嘅優化 —— 新 stamp 亦冇打破佢（佢係唯一一個唔搭 claim、又唔屬正常 path 嘅寫入）。
* pair 階段嘅重複讀。今日嘅讀數（§4.2.1 第 4 點）話正常 pass 係 `pairs 179/0`——由 `lastPairs`
  服務，即喺同一個 tick 内並冇重複嘅 HTTP。但仍然有一條唔清楚嘅：10:29:19 嗰個
  `pairs 601/0 pairs 1/10 miss 9`，即係 head 全 miss 嘅一次真 request（一個 subrequest 加
  600ms，而個 pass 依然係 1/10 行）。要查係「scan 前排嗰個批次早已 429／被 cut，令
  `lastPairs` 空」定係「head 轉咗位令 10 個 address 全部唔喺 cache 内」。
* `bumpScheduledTick` 本体仍然留喺 `Db`（legacy fallback 用），冇再喺正常 tick 出現。
* ~~**Birdeye 每日 CU counter**~~ → **已修**，見 §4.5.1。
* **卡片側 CU**（§4.4.2）：持有人數改用 GMGN 已抓嘅 `holder_count`，同一個 coin 唔使再買一次
  `token_overview`；同時要決定 `resolveTraderData`（`top_traders`）值唔值呢個 CU。
  2026-09-23：**暫時唔做** —— 呢個就係 §4.5.1 個 counter 要答嘅問題，等有實測數字先。

### 4.5.1 Birdeye CU 帳簿：由推算變成量度（2026-09-23，已修，已 deploy `8a6c6fe`）

§4.4.2 嘅 quota 表除 holder probe 一項之外全部係由卡片數**推算** —— repo 從來沒有任何 Birdeye
call 計數器。呢刀就係補呢一項：**客戶端記帳 ＋ 每日 durable ledger ＋ `/health` 讀數**。
**唔改任何決定**（冇拒發、冇改 cap、冇改 gap）。

* **記帳點**：`src/birdeye.ts` 嘅 `getJson` 每次 **request attempt** 都 charge（唔係成功才 charge）。
  理由同 cap 一樣：Birdeye 對「到咗伺服器」嘅請求收費，而 timeout 咗嘅請求可能已經被處理；只計成功
  路徑會**最嚴重地低報**—— retry（429/5xx/timeout，即係呢個 client 最常做嘅事）全部走唔到成功路徑。
* **單價表**（`BIRDEYE_CU_PRICES`，test 釘住）：`token_overview` **20**、`ohlcv` **35**、
  `new_listing` **40**（docs 講 30–80，取中間）、`top_traders` **0**。`top_traders` 冇已核實單價，
  所以 charge 0 —— **未核實嘅 endpoint 唔可以自己作一個數出嚟，然後用嗰個數去做預算決定**。
* **durable ledger**：`worker_state.birdeye_cu_v1` ＝ `{ v: 1, days: { "YYYY-MM-DD": cu } }`，
  保留 32 日（ledger 只需要答「本月」）。寫入紀律同 push-ledger／skip-capture 一模一样：
  **read 無條件**（被回收後嘅 isolate 重新發佈全隊總數，唔會由自己嘅 0 開始而低報個月），
  **只有真正落地嘅寫入才清 in-memory delta**（寫失敗就下次再報，唔會掉咗筆開支）。
* **flush 位置**：搭 `syncPostScanTelemetry`（5 分鐘節流、900ms bound），**唔**入 tick path ——
  每個 tick 多一個 round trip 就係 §1 講嘅 50-subrequest 預算買唔起嘅嘢。代價照寫：sync gap 內
  被回收嘅 isolate 會掉自己嗰段 delta（上限一個 gap），呢個就係 read 要無條件嘅原因。
* **讀數**：`/health.birdeyeCu = { day, today, monthCu, pendingCu, monthlyMax }`。`monthlyMax` 由
  `BIRDEYE_MONTHLY_CU_MAX` 定（default 30_000 ＝ free tier）。`pendingCu` 係本 isolate 未落庫嘅
  開支，所以 **`monthCu + pendingCu` 才係最近即時嘅月用量**，而 `today` 回答嘅係「今日燒咗幾多」。
* **刻意唔做**：quota 到頂之後**拒發**哪一些 call。拒一個就改變卡片顯示（§4.4.2 自己嗰句：
  「改嘅係卡片顯示同 push 驗證嘅語意，唔應該順手做」），而呢個 counter 嘅全部意義就係令嗰個
  決定有數可依。
* 測試：`test-unit.js` 加 7 條（單價表、attempt 記帳、mid-write charge、parser 容錯、merge＋剪枝、
  today／month 分界、sync 落地＋失敗 re-offer）⇒ 279 → **286 passed, 0 failed**。
* 落線紀錄：`docs/patches/birdeye-cu-ledger.apply.js`（worker.ts／config.ts）
  ＋ `…fix1.apply.js`（把個 block 移返上 `recordDex429` 註解之前，唔好搶咗人哋嘅 doc）
  ＋ `docs/patches/birdeye-cu-ledger-tests.apply.js`（test-unit.js）。

**落線點驗**（deploy 後第一個鐘）：

1. `curl /health | jq .birdeyeCu` 有數，而且 `monthCu` 隨時間單向上升（唔會回落、唔會係 0 卡死）。
2. `birdeyeCu.day` 係 UTC 當日；跨 UTC 午夜後 `today` 歸零而 `monthCu` 繼續累加。
3. `monthCu + pendingCu` 同 §4.4.2 推算嘅 24–31K/月 對得上或者**更高**（推算假設一張卡一次；
   實際上一張卡可能唔止一次—— 例如 send 被 defer／`undelivered` 之後下一 tick 重評），
   呢個差異就係下一個決定嘅材料。
4. `pendingCu` 在冇 scan 嘅 tick 會繼續存在（drain 跟節流），有 scan 後回落。

#### 4.5.2 上線後讀數（deploy `8a6c6fe` @ 12:54Z，run 35863485480 success 1m21s；抽樣 13:52–14:17Z）

`/health.birdeyeCu` 已經上線，shape 同設計一模一樣（`monthlyMax` 由 `BIRDEYE_MONTHLY_CU_MAX`
讀到 30000）：

| 讀數（UTC） | `birdeyeCu` |
| --- | --- |
| 13:52 / 13:55 / 14:02 | `{ day:"2026-09-23", today:0, monthCu:0, pendingCu:0, monthlyMax:30000 }` |

1. **charge 半已經證實**：`/debug/birdeye-overview?address=AVXPQqxd…`（＝一個真嘅
   `token_overview`，20 CU）之後，**同一個 isolate 嘅下一個請求**就報 `pendingCu 20`；再打一次
   （14:17Z）之後嗰個 isolate 持 `pendingCu 40`。即係「per-attempt 記帳 → module delta →
   /health.pendingCu」全程通，同 §4.5.1 嘅設計一致。順帶量到今日 endpoint 唔慢：`507ms`
   （14:06:25）、`174ms`（14:17Z）、`holderCount` 2704 / 2703 —— 同 §4.3 嗰六次
   `1_008–2_525ms` 唔同時段，所以 cap 2400 呢個 hit-rate dial 今日唔係瓶頸。
2. **`pendingCu` 係 per-isolate，讀法要跟**：同一分鐘內連續兩個 `/health` 可以一個報 20、一個報
   0（實測 14:10:32–14:11:20 交替出現，即 LB 喺兩隻 isolate 之間輪流）。所以**月用量讀數要
   `monthCu + pendingCu` 而且抽幾次**，唔可以單發定論 —— 呢條係 §4.5.1「落線點驗」第 1 點嘅
   操作細節。
3. **durable 半今日未行使，原因係位置而唔係壞**：到 14:17Z 為止 `today 0 / monthCu 0` 冇動，
   而 `pendingCu` 由一隻 isolate 持住 40 未落庫。flush 搭住**收費嗰個 isolate 自己**嘅
   post-scan telemetry（5 分鐘節流 ＋ 要有一個完成嘅 scan），而今次嘅收費係由一支**唔掃描嘅
   HTTP isolate** 付（`/debug/birdeye-overview` 係手動 probe）—— 佢要等到自己下一次真係掃描才
   flush。生產路徑唔同：卡片嘅 `token_overview` 同 holder probe 都係**掃描裡面**付嘅，付錢嗰個
   isolate 就一定係會 flush 嗰個（scan 完就係 completion flush → `syncPostScanTelemetry`）。
   ⇒ 老實講：**charge 半已證、durable 半未證**（等一次自然掃描落庫，見落線點驗第 1 點）。
   * **手動 probe 嘅賬會卡住更耐，甚至永遠唔落**：`/debug/birdeye-overview` 係一支**只服務
     HTTP** 嘅 isolate 付錢，而佢唔會主動掃描（心跳一值新鮮就唔會 claim）—— 抽樣三段（14:06、
     14:17、14:18）共 ~60 CU 到 14:19Z 一條都冇落庫，就係呢個形狀。呢個係**量度工具嘅限制**，
     唔係生產帳目嘅限制（生產嘅 charge 一律喺 scan 裡面），但如果日後有人用呢條 route 去驗
     `monthCu`，要預佢唔動，唔好誤判成 ledger 壞咗。
4. **`pendingCu` 跨冇 scan 嘅 tick 一直存在**（抽樣期間反覆讀到 20/40），即落線點驗第 4 點嘅
   前半（drain 跟節流）成立。
5. **`cu-gate` 真係閘住**：抽樣嘅 pass note 全部係 `probe0 miss0` ＋ 尾段 `cu-gate`，例如 13:54
   `ok:10/0 rows 10/30 pairs 10/10 miss 0 lost 0 allow 4778 spend[setup 351/3 heal 228/1 miss0
   enrolled0 pairs 246/0 rows 143/1 holders 0/0 held0 cut4 probe0 miss0 cu-gate] trips 7 db 1099ms`
   —— 60 分鐘 gap 未開閘時一個 probe 都唔開、**0 CU**，而 §4.1 嘅「probe 搭 pair batch 起步」
   冇被今次改動影響（`pairs 490/0`、`rows 35/1` 呢種單 trip pass 照樣出現）。
6. **冇新增 push-watch issue**：`/debug/push-watch.issueCount` = 2，兩條都係舊嘅
   `lost_completion_write`（01:41Z APECAT、04:17Z REALLY），同今次 deploy 無關。

### 4.5.3 cron 到達盲點：pre-init arrival stamp（2026-09-24，已修）

§5.1 第 3 點／§4.5 第一項：到達記錄搭喺 claim batch，令「cron 死喺 init」同「cron 冇投遞」喺
`/health` 上長得一模一樣。

* **形狀**：每一個到達記錄都只喺 `ensureInitialized` **之後**才 reachable —— 正常路徑搭 claim
  batch（`Db.scheduledTickStatements`），到唔到 claim 嘅路徑各自寫自己嗰份 —— 所以**死喺 init 嘅
  tick 一個字都冇寫**。樣本（2026-09-23 21:41–00:07Z）：ring 凍 19 分鐘
  （23:43:26 → 00:02:26Z）、再凍 2h42m（20:21:26 → 23:03:26Z），期間 scan row 每 ~70s 照落
  （HTTP monitor 兜住）；durable counter 54_546（13:46Z）→ 54_846（23:56Z）十個鐘 ⇒ **約一半 beat
  冇記錄**。successor-tick recovery 只證明「到達去到 heartbeat read」，證明唔到「投遞本身」。
* **修法**：`Db.stampScheduledArrival(at)`（**一個 batch、三個 statement、零 read**，counter 喺 SQL
  加）＋ worker 喺 `ensureInitialized` **之前**呼叫，條件係純函數
  `shouldStampArrival(scheduledTickFinishedAt, cronAt)`。
* **點解唔係每個 tick 都寫**：`scheduledTickFinishedAt` ＝ 本 isolate 最近一個**返到**嘅 scheduled
  tick。冷 isolate（0）或前人 tick 冇返到（gap > `SCHEDULED_ARRIVAL_SUSPECT_GAP_MS` = 90s）才
  stamp ⇒ 健康 warm isolate **零成本**；瀕死 isolate 就「每個收到嘅 arrival 都 stamp」（flag 冇得
  前進，正正令 wedge 嘅投遞**可數**而唔係隱形）。
* **成本／界**：1 個 subrequest、0 read。`PRE_INIT_ARRIVAL_BOUND_MS` = 1_500 用 `recoveryAwait`
  兜住 —— stamp 唔可以食咗佢自己存在嘅目的（envelope）；被 bound 走就繼續跑（寫入 idempotent），
  tick 唔付。
* **cold-isolate fallback**：`db === null` 時起一個 raw `new Db(...)`（同 `bumpScheduledTickLegacy` 同形）。
* **flag 設定位**：legacy bump return、cadence-gate skip return、正常 tick 尾（**故意最後**設 ——
  死喺前面就留住舊值，嗰個 stale 值就係證人）。
* **讀數**：`/health` 同 `/debug/scan-history` 都出 `scheduledArrivalTotal` / `scheduledArrivalAt` /
  `scheduledArrivalUnaccounted`（`scheduledArrivalAt > scheduledTickAt` ⇒ 最新一個 cron 投遞未為
  自己入賬）。兩邊嘅 state read 順手合成一個（`/health` 2→1；`/debug/scan-history` 5→1）。
* **測試**：`test-unit.js` 加 3 條 —— Db stamp 一 trip 零 read（counting client 度到
  `executes 0 / batch 1 / statements 3`）、`shouldStampArrival` 規則（含「單一 lost arrival 都要
  捉到」嘅 < 120s 關係）、out-of-window patch guard（半套貼上係危險狀態）。296 → **299 passed, 0 failed**；
  §4.5.3.1 再落一條 cold-handle test ⇒ **300 passed, 0 failed**。
* **落線 script**：`docs/patches/preinit-arrival-stamp.apply.js`（`db.ts` ＋ `worker.ts`）＋
  `…fix1.apply.js`（export `SCHEDULED_ARRIVAL_SUSPECT_GAP_MS`）＋ `…-tests.apply.js` /
  `…-tests.fix1.apply.js`。

### 4.5.3.1 cold isolate 個 stamp 係 no-op：`get()` 對未 init 嘅 handle 會 throw（2026-09-24，已修）

落線後第一個鐘嘅讀數直接推翻 §4.5.3 嘅 cold-isolate 假設 —— 而且係喺**冇 wedge** 嘅情況下推翻。

* **現場**（01:43–01:51Z，deploy 之後）：`scheduledTickAt` 每分鐘 :02 前進、ring 最新一格
  01:51:05、scan row 照落 —— 即係 cron **每一分鐘都投遞、而且贏咗 claim**（`cronTick` 只有 scheduled
  handler 會傳入 `runScan`，所以 `scheduled_tick_at`／ring 前進本身就係投遞證據，唔關 HTTP monitor 事）。
  但 `scheduledArrivalTotal` 由頭到尾都係 **null**（key 根本唔存在）＝ cold isolate 一次都冇 stamp 成功。
  ⚠️ ring 係**新到舊**排（`tickRing[0]` 最新），所以睇 ring 尾幾個會誤以為「凍結」—— 睇 ring 要睇頭。
* **原因**：`Db.stampScheduledArrival` 用 `this.get()` 落筆，而 `get()` 喺 `client === null` 時 **throw
  "Database is not initialized"**；cold isolate 個 fallback 正正係一個**未 init 過**嘅 raw
  `new Db(url, token)`（同 `bumpScheduledTickLegacy` 同形 —— 分別係後者用 `this.connect()`，所以 legacy
  bump 一直冇事）。寫入 throw，worker 個 catch 靜靜食咗（只有 console.error，冇 reader）。即係 stamp 喺
  **唯一為佢而設**嘅路徑（冷 isolate／死喺 init 之前）上完全冇作用，只有「warm db handle ＋ stale flag」
  呢個罕見組合會真寫入。
* **修法**：改用 `this.connect()`（lazy、唔需要 init —— 同 `bumpScheduledTick` 一樣嘅 primitive），1 行。
  另加一條**回歸測試**：一個 init 過嘅 handle 建 schema ＋ 讀，另一個**冇 init** 嘅 handle 落 stamp，
  斷言讀得到 `1` 同時間戳。呢條測試釘住「stamp 必須喺未 init 嘅 handle 上生效」，所以 `get()` 版本會 fail。
* **點解原本 3 條測試捉唔到**：第一條 test 開頭就 `await db.init()`（即係已經係 warm handle），patch
  guard 只看原始碼有冇接線。**「warm handle 寫得到」同「cold handle 寫得到」係兩件事**，而 stamp 只喺
  cold／死亡路徑開火 —— 呢個就係測試同 production 嘅縫。
* **教訓**：`/health` 上「新 key 一直係 null」唔可以當「冇事發生」—— idle 同 broken 長得一模一樣。
  一個「沉默即健康」嘅儀器，落線第一件事係證明佢**開得著**（逼一個 arrival stamp，或者睇 error log），
  唔係等 wedge 嚟驗。
* **落線 script**：`docs/patches/preinit-arrival-cold-client.apply.js`（`db.ts` ＋ 測試 ＋ 本節）。

**落線讀數**（2026-09-24；`edbd57d` 見到 stamp 冇開火 → `a9711fd` 修好後驗證）：

* **修之前**（01:43–01:51Z，`edbd57d`）：`scheduledTickAt` 每分鐘 :02 前進、ring 最新一格 01:51:05、
  scan row 照落，但 `scheduledArrivalTotal` **一直係 null**（＝cold isolate 一次都冇 stamp 成功）——
  就係 §4.5.3.1 嗰個診斷。**呢個係「沉默即健康」儀器最危險嘅一刻**：個 key 冇出現，睇落好似
  「冇事發生」，實際上係儀器死咗。
* **修之後**（`a9711fd` deploy 完成後，02:00–02:01Z）：`scheduledArrivalTotal` = **1**、
  `scheduledArrivalAt` = **01:59:02.941Z** —— 即係 deploy 後**第一個** cron arrival（新 isolate 嘅
  flag 係 0 ⇒ 必定 stamp）—— 之後 tick 繼續每分鐘照行（`scheduledTickAt` 02:00:02.887Z）而個 counter
  **停在 1**。兩個設計目標（cold isolate stamp 一次／warm isolate 零成本）**同時**照住預期出現。
  `scheduledArrivalUnaccounted` = false（`arrivalAt` 01:59:02 ≤ `tickAt` 02:00:02 ⇒ 最新投遞自己入咗賬）。
* **落線點驗第 0 點已證**：deploy 之後個數字**開得著**，所以之後「唔動」先至真係代表「健康」。

**落線點驗**（deploy 後第一個鐘）：

0. **cold isolate 一定要 stamp 一次**：deploy 之後任何一個 isolate 都係新嘅 ⇒ 佢收到嘅第一個 cron
   arrival 個 flag 係 0 ⇒ 必定 stamp。修好之後 deploy 後第一個鐘就**應該**見到
   `scheduledArrivalTotal ≥ 1`；若果仍然係 null 而 ring／`scheduledTickAt` 照前進，即係 stamp 仲係死嘅
   （呢個就係 §4.5.3.1 嗰個狀態，唔好再當佢係「健康所以唔動」）。
1. 健康 warm isolate **唔應該**令 `scheduledArrivalTotal` 動 —— 佢一動就代表嗰個 arrival 嘅前人 tick
   冇返（stamp 只喺呢種 arrival 上開火）。
2. ring 有洞而 `scheduledArrivalTotal` **同時**上升 ⇒「cron 有投遞、tick 死喺 claim 之前」，兩個原因
   唔再分唔開。
3. `scheduledArrivalUnaccounted === true` 持續 ⇒ 最新投遞未入賬（＝仲有死亡路徑喺 init 之前）。
4. 若 `scheduledArrivalAt` 都唔動而 scan row 照落 ⇒ 真係 cron 冇投遞（HTTP monitor 兜緊）。

### 4.6 invocation 預算：先量度，才切（2026-09-23，已修，已 deploy `43c6f2c` @ 15:30Z＋`cc333db` @ 16:09Z）

§5 尾嘅結論係「下一步只可以繼續減 invocation 內嘅 subrequest」，但 repo 從來**冇一個數**可以答
「邊個 phase 燒咗個預算」：pass note 嘅 `trips` 只算 pass 自己嘅 DB round trip，`dbSteps` 只包三個
wrapped Db method，`writeDrain` 只算 drain。之前每一刀（§1、§4.2）都係靠「stage 分解」推，唔係靠總數
—— 所以今次先補呢個儀器，唔再靠估。

**量度點**：`src/subreqs.ts` ＋ worker 喺 module load 裝嘅一個 `fetch` wrapper（**唯一**嗰個 seam：
DB 係 `@libsql/client/web`，即 HTTP，所以 Turso round trip、Telegram send、所有 feed 都經同一個
function —— 一計就係 Cloudflare 真係限制嗰個量）。

* **window**：`beginPreTick` 開一個 new window（cron 同 HTTP fallback 都經呢個 seam）⇒ 一個 window
  ＝一次掃描嘅開支。`countSubreq()` 每 call 加一。
* **phase ring**：tick probe 嘅 `markPhase` wrapper 會 stamp 一個
  `{ phase, total, ms }`（保留最新 8 個）—— 呢個就係「邊個 phase 燒」嘅答案，而佢**唔需要新
  round trip**（`markPhase` 本來就有）。
* **死 tick 讀法**：被殺嘅 invocation 自己永遠 publish 唔到，所以 `beginSubreqWindow` 會把**上一個
  window** 捲入 `recent`（最新兩個）—— 下一個 tick（即 backfill 佢 history row 嗰個）就看得見
  「死嗰個去到邊、走到幾多」。呢個就係 counter 放喺 module scope 而唔係 per-call 嘅原因。
* **讀數**：`/health.heartbeat.subreqs = { budget: 50, current: {at,total,phases}, recent: [≤2], windows }`。
  completion heartbeat 帶嘅就係嗰個 tick 嘅 `current` ＋ 上一個 window 嘅 `recent`。
* 測試：`test-unit.js` 加 6 條（budget／ring 常數、累加、phase point 係該刻嘅 running total ＋
  window-relative ms、ring 保留最新、roll 嘅 newest-first＋cap＋idle window 唔佔位、被殺 window
  由下一個讀得到）⇒ 286 → **292 passed, 0 failed**。
* 落線紀錄：`docs/patches/subreq-counter.apply.js`（worker.ts）＋
  `…-tests.apply.js`（test-unit.js）＋ `…-tests.fix1.apply.js`（修正 roll test 嘅算術 —— 原本
  assert 一個「已經計過 1 個 call」嘅 window 唔會入 recent，係測試寫錯，唔係 counter 錯）。

* **第二條軸：host split**（`cc333db`，即日加）。上線後第一個讀數就揭到 phase ring 喺**常見情況係盲
  嘅**：佢只喺有 candidate 入鏈時 stamp（`deferred`／`seen`／…），而大部分 tick `candidates: 0`
  —— 實測一個 `total 56` 嘅 window `phases` 完全空。所以每個 window 同時記「每個 call 去邊個 host」
  （`hosts`：count desc、tie 用 host name 排（求穩定）、最多 7 行 ＋ 一行 folded `(other)`，而
  **rows 一定加返 = `total`**，讀者可以自己核）。呢條軸唔需要 scanner 行到任何 phase，同 phase ring
  一樣跟 window 捲入 `recent` —— 即係被殺嘅 tick 都讀得到「邊個 consumer 燒咗」。落線：
  `docs/patches/subreq-host-split-tests.apply.js` ＋ `…fix1.apply.js`（tie-break 順序修一次：
  `(` 排喺字母前面）；測試 292 → **294 passed, 0 failed**。
#### 4.6.1 由 code 得出嘅清單（切嘅候選，等數字定次序）

| # | 消費者 | 次數／tick | 註 |
| --- | --- | --- | --- |
| 1 | **candidate chain**（per coin：`isTokenSeen`、rugcheck、`token_overview`、`top_traders`、ohlcv、helius／flurry、supply-flow 寫入、proTraders／sniper 寫入、claim／send／delivery） | **~12–18 per candidate** | 唯一可以單 tick 加十幾個嘅項 ⇒ 懷疑係死 tick 嘅來源；但亦係改動風險最高嘅位（推卡語意） |
| 2 | pair phase | 2–8 | 250ms 一個 batch，2s 預算 ≈ 6–8 個 |
| 3 | feeds（profiles 1 ＋ 每條 leg 1 ＋ gecko pages） | 4–7 | 健康 gecko 時 fallback 層唔行 |
| 4 | 每 tick 固定 DB（gate read／claim／`listEnabledChats`／pool／prune due-check／`getTokenStatsMany`／flush） | ~7 | 基本盤 |
| 5 | post-flush tail（deferral read **1/tick** ＋ 三個 5 分鐘 sync 嘅 **4–7 reads** ＋ drain） | 2–9 | 唔會殺 row（flush 已落），但同 pass 搶預算 ⇒ pass note 嘅 `err:Too many subrequests` |
| 6 | pass 自己（`trips`） | 5–13 | §1／§4.2 已批過 |

**落線點驗**：

1. 安靜嘅 tick：`subreqs.current.total` 應該 ~20–30（清單 1 唔行），而 `phases` 嘅尾段會指出最大增
   幅係喺 `pool`／`pairs`／`gate` 邊個位。
2. 有 candidate 嘅 tick：`total` 會跳上 35–50 ⇒ 清單 1 就係目標；`phases` 入面 `gate` 之後嘅增幅
   直接指出係邊個 per-coin call。
3. 死 tick：下一個 tick 嘅 `recent[0]`（`total` 貼近 50、`phases` 尾 = 死者最後 stamp）—— 呢個數
   就係「應該切邊個」嘅最終答案，唔使再估。
4. `windows` 遞增（代表 counter 活著）；`/health` 兩個連續請求可能出現兩個 isolate 嘅 window
   （per-isolate，讀法同 §4.5.2 第 2 點一樣）。

**下一刀（跟數字）**：清單 5 係已確認可以「batch 埋」嘅（三個 5 分鐘 sync 嘅 read 合成一個 grouped
read ＋ 一個 batch write）；清單 1 係最大但風險最高，等 §4.6.1 第 2 點嘅數字確認係唔係佢才動手。

#### 4.6.2 上線後讀數（`43c6f2c` run 35881957854 success 15:30:52Z；`cc333db` run 35886716005
success ~16:09Z；抽樣 15:31–16:14Z）

**儀器活著**：`/health.heartbeat.subreqs = { budget: 50, current, recent, windows }`；window 每 ~60s
開一個（實測相鄰兩個 window 相差 **59.878s／60.004s** ⇒ 一個 window 真係一次掃描嘗試）。

**讀數係 tick 自己寫落 Turso 嘅**：claim heartbeat（`phase:"scanning"`）同 completion flush
（`phase:"done"`，同 history row 同一個 batch）都帶 `subreqView()`，而 `/health` serve 嘅係 persist
咗嘅 copy。實測 15 秒內打 3 次 `/health` ＋ 2 次 `/debug/*`，`windows`／`current.at`／`total` 完全
一樣 ⇒ **poll 唔會污染個數**（早前見到嘅「window 凍結」係因為嗰個 tick 已經完，唔係 counter 死）。
被殺嘅 tick 自己永遠 publish 唔到，只可以喺**下一個** tick 嘅 `recent[0]` 讀。

| window total | host split（`hosts`） | 讀法 |
| --- | --- | --- |
| 16 | turso 16 | **冇任何 upstream call** ⇒ 未入 feed 就結束嘅 tick（DB-only：init／gate／claim／lock） |
| 30 | **turso 25** ＋ jup 2 ＋ gecko 1 ＋ dexscreener 1 ＋ gmgn 1 | DB 佔 83% |
| 32 | **turso 20** ＋ dexscreener 6 ＋ gecko 2 ＋ jup 2 ＋ pump.fun 1 ＋ gmgn 1 | DB 佔 63%，upstream 12 |
| 18／19 | —（有 `seen@17`） | 正常完成、有 candidate 入鏈 |
| rolled 34／44／**56** | — | **56 係超 50 嗰個**（burst 一次 dispatch 幾個 ⇒ 過衝），而且 `phases` 空 |

**phase ring 喺常見情況係盲嘅**（上線後首要發現）：ring 只喺有 candidate 入鏈時 stamp，而最近嘅
history row 讀 `candidates: 0` —— `total 56` 嗰個 window 就係一例（見上面 4.6 尾段：所以先加 host
split）。每個 window 樣本嘅 `hosts` 都加得返 = `total`；**DB round trip 佔每個 window 63–83%**，
feeds 佔其餘（樣本 tick 嘅 upstream 12：dexscreener 6、gecko 2、jup 2、pump.fun 1、gmgn 1；而 pass
note 嘅 `trips` 只係 9，即係 DB 裡只有約一半係 pass 自己嘅）。

⇒ **下一刀唔係砍 feed，係砍 tick 內嘅 Turso round trip**：pre-tick front（init／gate／claim）＋
pool／aged-eval reads ＋ flush ＋ deferral read ＋ 三個 5 分鐘 sync ＋ drain（§4.6.1 清單 4／5 合共
~11–16 個）。清單 5（三個 sync 合成一個 grouped read ＋ 一個 batch write）係已確認可以 batch 嘅
第一刀。

同 §4.6.1「落線點驗」對照：第 1 點（安靜 tick ~20–30）**中**（18／19／30／32）；第 3 點（死 tick 出
現喺 `recent[0]`）**中**（56 嗰個）；第 4 點（`windows` 遞增）**中**，但多咗一個決定性細節 ——
讀數係 persist 嘅，唔係服務嗰個 isolate 嘅 live state，所以兩個 poll 完全一樣係正常，唔係卡住。

### 4.7 三個 5 分鐘 sync 合成一個 grouped read ＋ 一個 batch write（2026-09-23，已修）

§4.6.2 嘅結論係「下一刀砍 tick 內嘅 Turso round trip，而清單 5（三個 5 分鐘 sync）係已確認可以
batch 嘅第一刀」。三個 sync 各自係「一次讀（ledger 嗰個係四次讀）＋ 有事就一次寫」，所以佢哋同時
到鐘嘅嗰個 tick（5 分鐘一次嘅常見形狀）要 **6 個 read ＋ 最多 3 個 write ＝ 9 個 subrequest**。

改動：**一次 grouped read ＋ 一次 batch write**。

* **grouped read**（`Db.readPostScanTelemetry`）：一個 libsql `batch`（＝ 一個 HTTP request）載住
  (a) 四條 `worker_state` 讀（`push_ledger`、`push_audit`、`skip_capture`、`birdeye_cu_v1` ——
  原本係 `getWorkerState` 逐條 ＋ `getPushAudit` 自己一條），(b) `push_watch` 嘅 baselines，
  (c) enabled chats 嘅 band。statement 順序＝原本嘅讀取順序，batch 結果照 statement 順序返嚟。
* **batch write**（`Db.setWorkerStatesMany`）：三個 sync 想落地嘅 key 合成一個 `batch`；每一個
  statement 同 `setWorkerState` 逐字一樣（`INSERT ... ON CONFLICT(key) DO UPDATE`）。
* **merge 邏輯冇分身**：三個 sync 嘅合併抽成純函式（`planPushLedgerSync` /
  `planSkipCaptureSync` / `planBirdeyeCuSync`），單獨嘅 `syncPushLedger` /
  `syncSkipCaptureState` / `syncBirdeyeCu` 同 grouped path 用**同一個** planner，所以兩條路一定
  寫出逐字一樣嘅 row（唔係 `getReevalPoolBatched` 嗰種「兩份 SQL、一條 test 釘住」）。
* **唔變嘅保證**：throttle（5 分鐘）、「冇變就唔寫」、「冇 delta 就唔讀」、`markSkipCaptureSynced`
  / `consumeBirdeyeCuDelta` 只喺 **batch 真係落地之後**才跑（寫失敗＝三個 delta 全部留返俾下一個
  attempt，正係以前「三個獨立寫全部失敗」到達嘅狀態）。
* **代價（老實講）**：以前一個 sync throw 唔會擋住另外兩個；而家係一個 batch，所以一次過全中或
  全唔中。讀數上唯一分別係 `/health` 嘅三個 mirror 會一齊更新，而唔係逐個。
* **bound 亦簡化**：以前三個 sync 各自 `Promise.race` 一個 900ms、順序行（最差 2.7s）；而家一個
  request，所以一個 bound 蓋得住整塊 —— 而且「有冇到鐘」先算，三個都未到鐘就 0 request。

落線紀錄：`docs/patches/post-scan-telemetry-grouped-tests.apply.js`（test-unit.js）。
測試：`test-unit.js` 加 1 條 —— 用一個 counting client 釘住「四條 state row ＋ 兩個 listing 係
**一個** client call」，同時釘住 grouped 嘅 row set／band 同 `listPushWatch(60)` /
`listEnabledChats` 逐個一樣（`ORDER BY ... LIMIT` 逐字抄過去，防兩邊漂移）⇒ 294 →
**295 passed, 0 failed**。

**落線點驗**：`/health.heartbeat.subreqs.current.hosts` 裡面嘅 turso 計數，喺 5 分鐘邊界嗰個 tick
應該比之前少 4–7；而 turso 仍然係最大嗰個 host（DB 本身冇消失，只係同一件事嘅 request 變少）。

#### 4.7.1 上線後讀數（deploy `2a6de9a`，run 35890757964 **success** 1m20s，2026-09-23 16:43–16:47Z）

1. **durable 半真係寫到落去**：`/health.birdeyeCu` 由 §4.5.2 抽樣嗰陣嘅 `monthCu 0 / pendingCu 40`
   一路升 —— 連續三個樣本係 `today 80 / monthCu 80 / pendingCu 0` → `120 / 120 / 0`。呢個係
   **grouped batch write** 落地嘅直接證據（三個 sync 嘅 row 而家係同一個 `batch` 出街）；
   `pendingCu 0` 亦代表 charge 之後 flush 有追得上（唔再係「手動 probe 嘅 isolate 唔會掃描」嗰個卡住形狀）。
2. **cron 到達記錄冇再停**：`scheduledTickTotal 54620`、`scheduledTickAt 16:46:26.898Z`，而 `now` 係
   16:47:03Z ⇒ 每個 tick 都前進。§5.1 第 3 點嗰個「`scheduled_tick_total` 凍住」**今次冇出現** ——
   但呢個係觀察而唔係已修（§4.5 未做第一項照舊）。
3. **死 tick 冇再出現**：120 行 scan-history ring 嘅 dead row 係 **0**（§5.1 抽樣係 21–24 條），
   而 `ms >= 100000` 只有 **1 條**，時間戳 15:17:25Z —— **早過今次 deploy**（16:43Z），即係新
   deploy 之後冇再出 6 位數 ms；`cut:watchdog` 亦冇出現。最近六條 row 嘅 `ms` 係 2221–2638（正常）。
4. **pass 正常**：`/debug/scan-history.pushWatchPass` 係 `phase:"done"`，note 尾段
   `… spend[setup 239/2 heal 249/1 … rows 858/5 holders 2564/0 held0 cut3 probe1 miss1] trips 11 db 1217ms`
   —— 冇 `err:`、冇 `cut:watchdog`；`/debug/push-watch.issueCount` = **3**，三條都係舊 row
   （REALLY 04:16Z、APECAT 01:41Z…），同今次 deploy 無關。
5. **老實講：per-tick 嘅 turso 計數今次證明唔到**。`/health.heartbeat.subreqs` 抽到嘅 window
   turso 數係 8／24／25／27／41，而 total 係 18／35／36／39／56 —— 變異大到冇辦法喺 /health 上
   認出「邊個 window 係 5 分鐘邊界嗰個」（counter 冇 stamp「今次有冇跑 telemetry」）。所以「少 4–7 個
   request」呢句**只由 unit test 釘住**（一個 counting client 度到整個讀係 1 個 call、寫係 1 個 call），
   live 冇獨立證據。要 live 量就要喺 window 入面加一個 telemetry 讀數（下一刀）。

## 4.8 追蹤池 head：10 → 30，一個 pass 掃完全池（2026-09-24，已上線）

**問題唔喺「掃唔掃到」，而喺「幾時掃到」。** `/debug/push-watch?limit=500`（03:46:28Z）
顯示表 46 行 ＝ **31 active ＋ 15 terminal**（`rug` / `unwatched`，故意唔掃）。但 active 行嘅
`last_checked` 年齡一直係**三堆、每堆十行**：

| 抽樣（Z） | 年齡波浪（30s 桶 → 行數） | 最舊 |
|---|---|---|
| 03:29Z | `2min:10 / 4min:10 / 5min:10` | 5.2min |
| 03:31:13Z | `120s:10 / 210s:10 / 480s:9` | 8.3min |
| 03:46:28Z | `0:10 / 120s:10 / 360s:10 / 420s:1` | 7.3min |

即一個 pass 只掃 10 行、全池一輪 3 個 pass、最舊嗰批 5–8 分鐘。**但個 pass 根本冇用盡
allowance**（03:29:07Z）：

```
ok:10/0 rows 10/29 pairs 10/10 miss 0 lost 0 allow 4873
spend[setup 346/3 heal 214/1 miss0 enrolled0 pairs 335/0 rows 136/1 holders 0/0 held0 cut4 probe0 miss0 cu-gate] trips 7 db 1056ms
trackerMs 1376
```

10 行 silent claim 而家係**一個 trip / 136ms**（§4.2 嘅 batching 成果），成個 pass 只用
1.4s／4.9s，冇 `budget-cut`。所以停喺 10 行純粹係 `TRACKER_PAIR_HEAD` **呢個 head 上限**，
唔係時間、唔係 Turso。

**改動**：

| 位 | 前 | 後 | 理由 |
|---|---|---|---|
| `pushwatch.TRACKER_PAIR_HEAD` | 10 | **30** | ＝ `cfg.maxTracked`（config.ts 硬 cap 30），而 listing 係 active 行按 `last_checked` 最舊先排 → head 就係輪替隊列本身 |
| `pushwatch.TRACKER_PAIRS_BUDGET_MS` | 600 | **1_200** | 批次由 10 個 address 變 30 個，**仍然係一個 request**（`/latest/dex/tokens` 一請求食 30 個 address，見 `DexScreenerClient.fetchPairsForTokens` 嘅 30 分批）；10 個實測 335ms，30 個要 ~3 倍 payload 嘅餘裕 |
| `scanner.TRACKER_PASS_OVERRUN_MS` | 8_000 | **8_600** | watchdog 嘅前提係「枚舉得完嘅 bounded 鏈」：pair batch 600 → 1_200，鏈尾跟住加 600 |

**唔變嘅保證**：`pairMiss` 只喺 loop 內部加（`pairMiss += 1`）—— 批次冇 cover 到嘅行
（pool > cap 嘅形狀）唔會被 blame，所以亦唔會觸發「2 小時搵唔到」嘅刪行；批次一個都冇回
仍然係 `pairs-empty`（唔判斷、唔寫、唔刪），下個 tick 重試；row loop 嘅 reserve 同 heal 嘅
deadline 都由 `TRACKER_PAIRS_BUDGET_MS` 推算，所以一個慢批次一樣要讓路畀啲行。

**一個要知嘅代價**：heal 嘅 slice 係 `deadline − (TRACKER_PAIRS_BUDGET_MS + TRACKER_ROW_RESERVE ×
TRACKER_ROW_MIN_MS)`，即由 1_200 變 **1_800** —— 一個只淨 ~2.5s 嘅 pass 而家會 `heal-skipped`
（讓路畀輪替），唔再係以前嗰種「開咗 heal 再喺中途 cut」。兩個形狀都係 fail-open（下一 pass 由
同一個 listing 重新提供嗰啲 missing push），而 live pass 多數 `allow ≈ 4_800`，heal 一樣食得到
自己嗰 2_600ms 上限。單元測試嗰個 cut-heal fixture 因此由 2_500 → 3_200ms（見 fix1 script）。

**一個附帶修好**：holder stage 嘅候選集係 `pairs.has(token)`，即係以前 head 以外嘅行
**永遠冇機會**被 probe；而家 due list 係全 pool 按 `holdersCheckedAt` 排序，最舊嗰行一定
食到每 pass 唯一嘅 slot。

**active 31 > cap 30**：listing 嘅 `LIMIT ?` ＝ 30，排序係 active 行最舊先，所以多出嚟嗰行
係**最新檢查**嗰行；下一 pass 佢就係最舊，自然回到隊列 —— 唔會餓死，只係快取／慢取之分。

### 4.8.1 上線後讀數（2026-09-24 04:31–05:05Z）

`0938959` → Deploy Worker run **35953548509 success** ✅（03:56:43Z push、1m14s、~03:58Z 落線）。

| 要讀嘅嘢 | 讀數 | 判讀 |
| --- | --- | --- |
| `pairs N/N` | `pairs 30/30`（04:33:14Z、04:56:13Z 兩個 pass） | head 已係全池：**一個 request 食 30 個 address**，同 10 個嗰時一樣一條 subrequest |
| `rows X/N` | `rows 3/30`（04:33，慢 DB）→ **`rows 17/30`**（04:56） | 一個 pass 由 checked **10 → 17 行**；N ＝ `activeRows.length`（pool 30），所以 17/30 ＝ 一個 pass 行咗 17 行 |
| tracked 行年齡 | 30 行（`dead` 9／`null` 15／`weak` 4／`up200` 1／`ignite` 1）**全部 52–55s**；`rug` 13／`unwatched` 1 照樣幾個鐘頭唔掃 | **三堆變一堆**，達到目標（比「最舊 < 3 分鐘」更好） |
| `budget-cut` | **照樣出現**（兩個 pass 都有） | 同預測相反 —— 見下 |
| `cut:watchdog` | **冇出現** | watchdog 前提仍然 hold（新嘅 8_600 冇咬） |
| subrequest 窗 | `/health.heartbeat.subreqs.recent` 最高 **37／50**；DB 佔 29–30 條／窗 | 冇撞上限，DB 仍然係大頭（同 §4.6） |
| scan pair phase | ring `ms === 5000`（race cut）由 02:40–03:56 嘅 76 分鐘 **2 條**，變 03:58–04:52 嘅 52 分鐘 **4 條** | 多出嗰兩條落喺 04:30 桶（同時 `db 4462ms`）→ 睇唔到 head 直接造成，但**唔算「冇變」**，要再抽一段乾淨時段才算證 |

**`budget-cut` 冇消失，而原因唔係 head**（04:56:13Z）：

```
ok:17/2 rows 17/30 pairs 30/30 miss 0 lost 0 budget-cut allow 4521
spend[setup 521/2 heal 498/1 miss0 enrolled0 pairs 0/0 rows 3701/9 holders 284/1 held0 cut3 probe1 miss0] trips 16 db 5163ms
trackerMs 6080
```

`rows 3701/9` ＝ row loop **每行 ~411ms**（pair batch 反而 0ms —— 180s 快取命中）。30 行 × 411ms ≈
**12.3s**，而 row loop 嘅預算係 `allow − reserve ≈ 4.5s − 0.6s`。即 head 由 10 升到 30 之後，瓶頸
仍然係「每行嘅 Turso 成本」而唔係 head：cut 咗嗰 13 行留喺隊列（`last_checked` 最舊先），下一個
pass 接手。所以**一個 pass 掃 17 行、全池一輪 ≈ 2 個 pass（~2 分鐘）**，未做到預期嘅 1 個 pass，
但已經由「3 個 pass／5–8 分鐘」收到「2 個 pass／~2 分鐘」。

**更正（見 §4.8.2）**：`rows 3701/9` **唔係**「411ms／行」。嗰 9 個 trip 係 ~3 條 alerting
row 嘅（claim ＋ reservation ＋ final write），而 quiet row 本身 **零 trip**（一次過 batch 寫）。
即個 pass 唔係唔夠 round trip，係喺 loop 頂 `break` 走出輪替，剩低 13 條 quiet row 明明可以
搭同一個 batch **免費**寫埋。所以下一刀唔係「減每行 trip」（冇嘢好減），而係把 gate 由每行搬去
每次 spend —— 見 §4.8.2。

**一個讀數陷阱（raise head 之後新出現）**：`rows X/N` 嘅 X 係 `checked`（真係行過嘅行），但隊列
stamp 係 batch claim 一次過蓋全池（§4.2 省 trip 嘅設計），所以 30 行一齊 52–55s **只證明 claim 蓋咗
章**，唔證明 30 行都重新評估過 —— 每 pass 有 30 − 17 ＝ **13 行「蓋咗章、冇重新評估」**，而佢哋
照樣排去隊尾（以前 head 10 ＝ checked 10，冇剩呢個形狀）。要盯：抽兩次相隔幾分鐘嘅表，睇
`lastMcap`／`chgSincePushPct` 有冇真係更新，唔可以只睇年齡。

**另一個失敗形狀（同 head 無關）**：Turso 一慢，tracker 會被整個 defer —— 04:34:13Z／04:35:12Z
兩個 pass 係 `deferred:tick-budget allow 0`／`allow 308`、`rows 0/0`，同一時間 `db 4462ms`、
`setup 2003/2`（正常係 `db 1056ms`、`setup 346/3`）。呢個就係中間一度見到 tracked 行企到 13–19
分鐘嘅原因：**抽讀數一定要連 `deferral` 一齊睇**，單睇一兩個 pass 會誤判成 regression。

**四點結論**：(1) head 30 落線、`pairs 30/30` 一條 request ✅；(2) 年齡三堆變一堆 ✅；
(3) checked 10 → 17、全池一輪 2 pass ✅ 但未到 1 pass，而且 `budget-cut` **仍然出現** ❌；
(4) subrequest 冇撞 50 上限、`cut:watchdog` 冇出現 ✅。

### 4.8.2 一刀：budget gate 由「每行」搬去「每次 spend」（2026-09-24，已上線）

**§4.8.1 嗰句「下一刀係減每行嘅 round trip」係錯嘅診斷，要收回。** 睇返 `rows 3701/9`：
9 個 trip **唔係** 17 行攤分（411ms／行），而係 **~3 條 alerting row** 各自嘅 claim／reservation／
final write（3 trip／條）。其餘 ~14 條 quiet row **一個 trip 都唔使** —— 佢哋排隊，由 loop 之後
嗰一個 `claimPushWatchChecksMany` 一次過寫（§4.2 嘅 batching 成果）。

即 04:56:13Z 嗰個 pass **唔係唔夠 round trip**：佢喺 loop 頂嗰道 gate
`if (!firstRow && Date.now() + rowReserveMs() > deadline) { budgetCut = true; break; }`
**跳出咗成個輪替**，剩低 13 條 quiet row 明明可以搭同一個 batch **免費**寫埋。

| 位 | 前 | 後 |
| --- | --- | --- |
| loop 頂嘅 gate | 每行之前檢查，超時 `break`（跳走其餘輪替） | 只計一個 `overBudget` flag，唔 break |
| `pairMiss` 嘅 delete | 無條件 `await deletePushWatch`（呢個 branch 唯一嘅 trip） | `!overBudget` 才做 |
| alerting row 嘅 send gate | 唔夠 slice → `break`（跳走其餘輪替） | 唔夠 slice → `continue`（該行完全唔碰，其餘照行落去） |

**唔變嘅嘢**：at-most-once 嘅機器一模一樣 —— claim 同 reservation 仍然係兩個獨立 CAS、
reservation 仍然喺 send 之前落地、refused 嘅 row 仍然「完全唔碰」（`last_checked` 都唔寫），
所以下一個 tick 用新 budget 喺隊頭再試。改動只係「唔再因為一個唔夠錢嘅 spend，放棄其餘免費嘅行」。

**單元測試**：舊嗰條「the row loop always evaluates a row, even when the pair batch ate the
budget」（2 條 quiet row、100ms budget 對 250ms batch）斷言 `checked === 1` ＋ `budget-cut`，
即係**釘住舊嘅 break 行為**，已改成 `checked === 2`、`rows 2/2`、**冇** `budget-cut`；另加一條新
test：30 行、pair batch 食晒 allowance，仍然 `rows 30/30`，而 `claimPushWatchChecksMany` 只叫
**一次**（30 行一個 trip）。

**第一刀錯咗，已修（`row-loop-spend-gate.fix1.apply.js`）**：第一版把 `overBudget` 都加落
send gate —— 即「過咗 deadline 就唔准開新嘅 alerting row」。兩條既有 test 即刻紅：
`a row that starts after the deadline sends inside the pass tail` 同 `a held-back card is
re-announced on the next pass`。一條 row 嘅池裡面，嗰條 row **就係** progress floor，而真正
bound 住 pass tail 嘅係 **send slice**（`TRACKER_SEND_CAP_MS`／`TRACKER_SEND_FLOOR_MS`），唔係
個 reserve —— live 有個 tick 喺 ~4_840ms race window 嘅 4_857ms 才完，成個 flush 都輸埋。所以
send gate 嘅條件**保持原狀**（只有 slice），只係 `break` → `continue`；而家被時鐘管住嘅只剩
`pairMiss` 嗰個 delete（佢係唯一冇自己 slice 嘅 spend）。

### 4.8.3 上線後讀數（2026-09-24 06:22–06:27Z）

`050e121` → Deploy Worker run **35963736602 success** ✅（1m20s，06:16:53Z push、~06:18Z 落線）。

| 要讀嘅嘢 | 讀數 | 判讀 |
| --- | --- | --- |
| `rows X/N` | **`rows 30/30`** 連續三個 pass（06:22:39／06:25:40／06:26:39Z） | 一個 pass 掃完全池 —— **目標達到**（同日前 04:56 係 17/30，head 10 嗰時係 10/29） |
| `rows <ms>/<trips>` | `rows 214/1`、`rows 230/1`、`rows 240/1` | **30 行一個 trip**（之前 17 行要 9 trip／3_701ms）|
| `budget-cut` | **冇出現**（三個 pass 都冇） | 冇 spend 被拒 → 冇嘢要 cut，同預期一致 |
| 成本 | `trackerMs 1_527–1_825`（allow 4_728–4_779）、`trips 5`、`db 1_292–1_573ms` | pass 由 6_080ms 落到 ~1.6s，trip 由 16 落到 5 |
| `pairs N/N` | `pairs 30/30`，pair trip 0–31ms（快取命中） | §4.8 嗰條冇回退：仍然一個 request |
| tracked 行年齡 | 29/30 行 **27s**（＋1 行 86s）＝一個堆 | 一個 pass 就刷完全池 |
| `cut:watchdog` | **冇出現** | watchdog 前提仍然 hold |

06:22:39Z 原文：

```
ok:30/0 rows 30/30 pairs 30/30 miss 0 lost 0 allow 4784
spend[setup 364/2 heal 415/1 miss0 enrolled0 pairs 0/0 rows 214/1 holders 0/0 held0 cut4 probe0 miss0 cu-gate] trips 6 db 1348ms
```

**未證嘅一半（老實講）**：三個抽樣 pass 都係 `ok:30/0` —— **冇一條 alerting row**，所以
「被拒嘅 card 仍然會出聲」（`defer-send N` ＋ `budget-cut`）今次 **live 抽唔到**，只由 unit test
釘住：`a card that cannot be sent leaves its row untouched` 斷言 `defer-send 1` ＋ `budget-cut`，
而 fix1 把 `overBudget` 由 send gate 拿返出嚟之後佢仍然綠。要等一條真 alerting row 出現，
先可以話 live 都證實。

## 5. 驗證狀態（本地 + 上線）

* `npm run build`（tsc）✅
* `node scripts/test-unit.js` → **304 passed, 0 failed** ✅（§4.8.2 換走嗰條釘住舊 `break` 行為嘅
  「always evaluates a row」test ＋ 加 1 條「30 行一個 batch trip」test；§4.8 加 1 條「pair batch
  問全池」test ＋ 改寫 1 條 strict-subset test 成 40 行 fixture；再之前 302 ＝ §十九（duplicate-cards）
  嗰 2 條 no-mark
  dedupe test；再之前 300 —— §4.5.3.1 嗰 1 條 cold-handle test；299 —— §4.5.3 嗰 3 條 pre-init arrival
  test；296 —— §17.6 嗰 3 條 row-span-hold test；295 ＝ §4.7 嗰 1 條 grouped-telemetry test；
  292 —— §4.6 嗰 6 條 subrequest-counter test ＋ `cc333db` 嗰 2 條 host-split test；
  其餘見下 —— 279 → 286 係 §4.5.1 嗰 7 條 CU-ledger test
  —— 單價表、attempt 記帳、mid-write charge、parser 容錯、merge＋剪枝、today/month 分界、
  sync 落地＋失敗 re-offer；§4.4 嗰條 CU-gate test 與 `trips` invariant 仍然釘住）
* `node scripts/test-deferred-priority.js` ✅、`node scripts/test-tick-path.js` ✅
* `edbd57d`（§4.5.3 pre-init arrival stamp）→ Deploy Worker run 35944044690 **success** ✅；
  `a9711fd`（§4.5.3.1 cold-handle fix）→ run 35945163059 **success** ✅（落線讀數見 §4.5.3.1）
* `4021c35`（duplicate-cards §十九 no-mark dedupe）→ Deploy Worker run 35947790374 **success** ✅
* `b6f07e0`（§十九 no-mark 第一小時紀錄）→ Deploy Worker run 35948129083 **success** ✅（1m20s）
* `0938959`（§4.8 追蹤池 head 10 → 30）→ Deploy Worker run **35953548509 success** ✅（1m14s，
  03:56:43Z；落線讀數見 §4.8.1）
* `050e121`（§4.8.2 spend gate）→ Deploy Worker run **35963736602 success** ✅（1m20s，
  06:16:53Z；落線讀數見 §4.8.3）
* push `bba1312` → Deploy Worker to Cloudflare **success**（1m9s）✅；`21521eb`（§4.2 row loop）
  → run 35837821096 **success**（1m27s）✅；`ae269d4`（§4.1 holder gate）→ run 35845665809
  **success**（1m16s）✅；`2b4b9fe`（§4.3 probe cap／slot）→ run 35851038091 **success**（1m20s）✅；
  `66a9321`（§4.4 CU budget）→ run 35854326659 **success**（1m20s）✅；`8a6c6fe`（§4.5.1 Birdeye
  CU 帳簿）→ run 35863485480 **success**（1m21s，12:54:28Z）✅；`43c6f2c`／`cc333db`（§4.6
  subrequest counter ＋ host split）→ run 35881957854／35886716005 **success**✅；`2a6de9a`（§4.7
  grouped telemetry）→ run 35890757964 **success**（1m20s，16:43:47Z→16:45:07Z）✅
* 上線後讀數：§3.1（第一刀）、§4.1.1（holder 由飢餓救返）、§4.2.1（row loop 一個 head 一個 trip）、
  §4.3.1（`probe1 miss0` 同 collect 回落）、§4.4.1（`probe1 miss0` → 下一個 pass `cu-gate`）、
  §4.5.2（CU 帳簿：charge 半已證、durable 半未證）、§4.6.2（subreq counter：DB 佔 63–83%）、
  §5.1（note／history 觀察）、§4.7.1（grouped telemetry：durable 半已證）、§4.8.1（head 10 → 30：
  `pairs 30/30`、checked 10 → 17、三堆變一堆，`budget-cut` 仍在）、§4.8.3（spend gate：
  `rows 30/30`、30 行一個 trip）
* 卡片側：`/debug/push-audit` 有帶 `sig` 嘅 follow-up entry（ARGUS 嘅 `ignite`／`liqwarn`／`drain`、
  HANDLES 嘅 `ignite` 等，30 條 ring），`/debug/push-watch.issueCount` = **1**
  （DeadCatBounce，2026-09-22 嘅舊 row）
* **仍然未解（同呢兩刀無關）**：invocation 嘅 subrequest 上限照樣咬 —— 抽樣期間
  `/debug/tick.summary.pushWatch` 出 `err:Too many subrequests …`（10:26Z），而 10:27:09 開嘅 pass
  個 note 一直停留喺 `phase:"running"` 直到 10:29:19 下一個 pass 接手（2 分 10 秒）；120 行
  scan-history ring 有 **4 條** dead row（08:59:48／09:34:48／10:20:48 三條
  `previous tick died before its completion flush`，加 08:57:14 一條 race cut）。呢三條係 §18.2
  講嘅「偵測延遲」（68–82s），**唔係** tick 跑咗咁久：ring 内 `ms >= 100000` 係 **0** 條
  （之前見過嘅 6 位數 ms 今次冇再出現），而 `cut:watchdog` 亦冇再出現。下一步只可以繼續減
  invocation 內嘅 subrequest（§4.4）。
  **13:52–14:17Z 更新：呢組讀數已經唔再成立** —— dead row 24/120、`ms >= 100000` 3 條、pass note
  亦再停喺 `running`；只有 `cut:watchdog` 一樣冇出現。抽樣同判讀見 §5.1。

### 5.1 note／history 觀察（2026-09-23 13:52–14:17Z，即 HKT 21:52–22:17）

| 睇嘅嘢 | 今次抽樣 | 判讀 |
| --- | --- | --- |
| `cut:watchdog` | **冇出現**（抽到嘅每個 pass note 都係正常尾段） | 8s watchdog 仍然 hold：pass 一定 return |
| 6 位數 ms | **返嚟**：120 行 ring 有 3 條 `ms >= 100000`（101889 @13:46:27、102737 @13:50:25、111176 @13:26:27） | 見第 1 點 —— 呢個 ms **唔係** tick 時長 |
| `previous tick died before its completion flush` | 120 行 ring（11:41:50–13:55:18Z）**21 條**：12 點鐘 9 條、13 點鐘 12 條 | 即 ~**20%** tick 死喺 completion flush 之前 |
| `scan exceeded its … race window` | 3 條（12:26:10、12:52:31、13:08:31） | race cut 正常（有 history row，唔係 dead tick） |
| `err:Too many subrequests` | **仍然出現**（`/debug/tick.summary.pushWatch` 抽到） | 50-subrequest 上限照舊係兇手；pass note 因此停喺 `phase:"running"` |

1. **6 位數 ms 係「偵測延遲」，唔係 tick 跑咗 100 秒**：`ms` 由 `deadTickBackfillInfo` 計，係
   `now - 死者 heartbeat.at` —— 前人 tick 開咗 scan（`phase:"scanning"`）之後死咗，下一個贏到
   lease 嘅 tick 幾耐之後才發現。所以 `102737` 係「一個 tick 死喺 13:48:43，13:50:25 才被
   backfill」，中間 102 秒冇人贏到 lease（45s 嘅 `BACKFILL_STALE_MS` 之後還要等下一個掃描 tick）。
   同 §18.2 嘅講法一致：**呢條數答「偵測延遲」，唔答「tick 有幾長」**。
2. **pass note 會停喺 `running`**：13:57:16 / 13:57:44 / 13:58:11 / 13:58:39 連續四個樣本（跨 4
   分鐘）都係 `phase:"running"`，14:02:18 又回 `done`。即被殺嗰個 tick 嘅 pass 永遠唔會寫 terminal
   note，要等下一個 tick 接手 —— 睇 note 一定要連 `phase` 一齊睇，唔好當 `running` 係「跑緊」。
3. **新發現：durable 嘅 cron 到達記錄會停**。`scheduled_tick_total` 凍在 **54546**、
   `scheduled_tick_at` 同 ring 尾凍在 **13:46:27.007Z**，由 13:46 一直到 14:17 都冇動；同一時間
   heartbeat 每分鐘前進、scan row 照落（heartbeat `phase:"done"`、`lastScanGapMs` 幾秒）。再早一段
   ring 仲有一個 **2400s 洞**（12:16:26 → 12:56:27）同三個 120s 洞（13:26／13:30／13:37）。
   兩個可能，喺 /health 上長得一樣：
   * **cron 冇投遞** —— HTTP monitor 每分鐘 ping `/health` 照樣驅動掃描（docs/uptime-monitor.md
     設計嘅保險），所以 bot 冇停，只係「cron 仲生唔生」呢個信號靜咗；或者
   * **cron 有投遞但死喺 init** —— §1 把到達記錄搬上 claim batch（每個 tick 慳 ~2 個 round trip），
     代價係「到唔到 claim」以外嘅死亡路徑（`ensureInitialized` throw；或者 gate 讀 throw 而
     legacy bump 亦 throw）**連到達記錄都唔會寫**。舊 code 係喺 init **之前**寫嘅，正正為咗呢件事
     （worker.ts 嘅註解原話："a slow/failed init … otherwise kills the scheduled event inside the
     init"）。
   ⇒ 分開呢兩者要一個**唔經 claim batch** 嘅到達標記（或睇 Cloudflare 嘅 cron 指標）：抽樣期間
   `/health.scheduledTicks`（module counter）喺我打到嘅樣本全部係 0，但嗰啲 isolate 亦可能根本唔
   收 cron，所以**唔算證據**，唔應該當結論。呢條列入 §4.5 未做第一項。
   **2026-09-24 已修**：見 §4.5.3（pre-init arrival stamp —— 到達記錄唔再只喺 claim batch 上出現）。
4. **掃描冇斷**（呢點要講清楚，否則上面嘅讀數會被誤讀成「bot 死咗」）：抽樣期間 scan row 每 ~60s
   落一條、heartbeat `phase:"done"`、`lastScanError` null、`initError` null、`issueCount` 冇升 ——
   即係 push 檢查／卡片路徑照跑，問題集中喺「invocation 預算」同「cron 到達信號」。
### 5.2 dead-tick 形狀重取樣（2026-09-23 21:14–23:56Z，讀數喺 `docs/duplicate-cards.md` §18.5）

§4.7／§17.6 落線之後最乾淨嘅一個靜默窗（151 分鐘、120 行 ring）：**慢滴由 5.4–8.7/h 跌到 2.3/h**
（21:14→23:26，5 條），**6 位數偵測延遲 0 條**（baseline 每窗 1–3 條）；但 23:26:27 起有一個
**17 分鐘楔形**（17 條 dead、零成功掃描），佢**無 deploy 喺附近、自己散**，同切唔切冇因果。
生還 tick 嘅 subrequest 窗係 total 30（turso 18）—— 亦即「正常一輪離 50 上限仲有 20 條」。
詳見 §18.5。


## 6. 點解要一個 script 落呢個改動

`src/pushwatch.ts`（148KB）同 `scripts/test-unit.js`（454KB）都遠超檔案工具嘅編輯窗口：
第 ~1000 行（約 50KB）之後，`str_replace` 一律答「old string not found」（逐行 probe 過，
`docs/patches/tracker-pass-batched-consumer.apply.js` 就係因此存在）。所以：

* 改動用 script 落，**兩個階段**：先驗 18 個 replacement 每個都**只可以唯一命中**，
  有任何一個唔中就跑都唔跑、直接 exit 1（唔會出現半套改動）。
* 記錄留底喺 `docs/patches/`（同 `poolfallback.ts`、`getReevalPoolBatched` 一樣，
  呢個 repo 一直有呢類「deep call site 要繞路」嘅處理）。
* 落完之後用 `git diff` + `tsc` + 三個 test suite 驗，唔靠腳本自己講。
