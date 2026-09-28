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

**06:31:41Z 補充 —— 抽到一條 alerting row，而個尾冇斷**：

```
ok:30/1 rows 30/30 pairs 30/30 miss 0 lost 0 allow 4783
spend[setup 791/2 heal 389/1 miss0 enrolled0 pairs 33/0 rows 1931/5 holders 0/0 held0 cut4 probe0 miss0 cu-gate] trips 9 db 3011ms
```

`ok:30/1` ＝ 30 行 checked、1 條出咗 card；`rows 1931/5` ＝ 5 個 trip（batch 1 ＋ 嗰行嘅
claim／reservation／final write）。**alerting row 在場都一樣 `rows 30/30`、冇 `budget-cut`、
`trackerMs 3_567` 仍在 `allow 4_783` 之内** —— 即係「alerting row 會唔會再切尾」呢個問題 live
答咗：唔會（以前 3 條 alerting row 就已經令 pass 停喺 17/30）。

**未證嘅只剩「被拒」嗰半（老實講）**：抽樣期間冇一條 card 因為唔夠 slice 而被拒，所以
`defer-send N` ＋ `budget-cut` 今次 **live 抽唔到**，只由 unit test 釘住：
`a card that cannot be sent leaves its row untouched` 斷言 `defer-send 1` ＋ `budget-cut`，
而 fix1 把 `overBudget` 由 send gate 拿返出嚟之後佢仍然綠。

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

---

### 4.9 write drain 唔可以食 tracker 嘅 subrequest 配額（2026-09-25）

**Live：41 分鐘冇任何 row 被 evaluate。** 31 條 active row 全部 stale
2312s → 2558s；每一個完成嘅 pass 都係 `ok:0/0 deferred:subreq-budget … rows 0/0`；
`tickProgress.stage` 停喺 `front`／`postscan`，`scanCount 0`；02:36:51Z 自己恢復，
下一個 pass 即刻 `rows 26/30`。

**原因：個 tick 長期住喺平台 50 個 subrequest 嘅 43–45。** `summary.subreqs` 顯示一個
完成嘅 tick `total 43–45`，其中 Turso 35（`budget 50 / unseenAllowance 12 / usable 38`）。
tracker pass 係最後一個跑嘅階段，而且係明文嘅 residual claimant（worker.ts 自己寫：冷
isolate 上 front 已經用咗 47/50，pass 第一個 Turso call 就係俾 runtime 拒嗰個）。

**最尖嗰一段係 write drain**：佢由 `onTickEnd` fire，即係喺 tracker **之前**，而
`while (queue.length > 0)` 冇任何 ceiling —— backlog 幾長就食幾多個 round trip。
Durable record 正正係一條 20 條嘅 backlog（`writeDrainError {method
updateTokenMaxMcaps, "db execute hit the 3000ms hard wall — libsql retry loop never
settled", pending 20}`），而 starvation 散嗰刻 `summary.writeDrain.pending` 係 0。

**修正**（`docs/patches/drain-yields-tracker.apply.js`）：

| | 之前 | 之後 |
|---|---|---|
| drain 嘅上限 | 冇（backlog 幾長食幾長） | `subreqLeft() <= DRAIN_TRACKER_RESERVE`（14）就停 |
| 停咗嘅 entry | — | 留在 queue（「landed 才離開」），下一 tick／pass 之後再落 |
| 讀數 | `pending` | `pending` ＋ `heldForTracker`（held **唔係** failure：唔計 `failures`、唔寫 durable 錯、唔消耗 3 次重試） |

**未修**：scan 自己嘅 ~17–20（多數係 Turso）＋ tracker 行輪替（一行一個 claim/check
UPDATE ⇒ 一次 ~30）令個 tick 貼住 50，drain 只係最尖、最冇產品價值嗰段。要再收窄就要
**減 round trip**：把 row loop 嘅 claim/check 合併成一個 `batch()`（30 → 1–2），或者喺
scan 側先留配額（scanner 現時完全唔讀 `subreqRemaining`）。

> **2026-09-25 更正（見 §4.11）**：上面「一行一個 claim/check UPDATE ⇒ 一次 ~30」係
> **舊**事實。`claimPushWatchChecksMany` 已經把靜默行嘅 CAS 全部 pipeline 成**一個**
> HTTP request（libsql 嘅 `batch()` 係一次 `/v2/pipeline`：open stream → execute →
> close），live pass note 讀 `spend[… rows 282/1 …] trips 5` —— 28 行輪替 = **1 個**
> subrequest。所以「30/50 嘅大頭」唔喺 row loop，而係散喺 front／tail 十幾條一次性
> statement 度。量度同下一步見 §4.11。

### 4.10 被拒嘅 note：pass 自己嘅讀數要留在記憶體（2026-09-25）

**Live（02:56–03:0xZ，第二次同類事件）**：`pushWatchPass {phase:"running", note:"running",
trackerMs:0}` 卡住 60s+（下一個 tick 又開一個新 pass，所以個 record 永遠停在 running），
row 新鮮度 `fresh 0/31 → 1/30`（輪替真係停咗，唔係慢）。但個 tick 本身健康：
`tickProgress {stage postscan, ms 2530, subreqs 10}`、心跳 `done`、`dex http429 0`、
`subreqs current 10–16`；drain 亦冇新失敗（`writeDrainErrorAgeMin 172`）⇒ 唔係 §4.9 嘅
subrequest 撞頂，又唔係 feed —— 最可能係 Turso 3,000ms hard wall 落喺 pass 自己嘅 stage。

**點解完全冇證據**：pass 開頭寫 `running`、**最後一步**才寫最終 note，所以被殺 = 永遠
`running`；而 pass 內部每個 DB stage 都已經係「失敗就算」（listing、recap claim、
silent batch），失敗只會變成 `claimLost` 一個數字，而嗰個數字只喺最後嗰個 note 度出現
—— 即係喺**寫唔入**嗰個寫入度。

**修正**（`docs/patches/tracker-pass-pulse.apply.js`）：`trackerPassPulse()`
（pushwatch.ts，module memory，**零 DB 寫入**）記住最後一個 pass 嘅
`{at, doneAt, stage, checked, alerted, claimLost, note}`：pass 開頭、row loop 之後、pass
結尾三個時點更新，而 `stage` 跟住 pass 自己嘅標籤**每個** stage 都更新（所以死喺邊個
stage 一定報得到）。worker 每個 tick 嘅 heartbeat summary 加
`pushWatchLive`（讀數）同 `pushWatchFail`（worker 自己 catch 到嘅 throw，連 message 同
當時嘅讀數）⇒ 一條 `/health` 就答得到「pass 有冇行完（`doneAt`）、停喺邊個 stage、
checked／claimLost 幾多」，即使 DB 嗰刻寫唔入任何嘢。

**留心兩點**：pulse 喺**下一個** tick 才上 heartbeat（summary 係 pass 之前砌），即係最多
遲一個 tick；而 row loop 嘅計數係 loop **返嚟**才發佈，所以喺 loop 中途被殺嘅 pass 只會報
`stage: rows / doneAt: null / checked: 0` —— 輪替行到幾遠，睇 durable row 嘅 `fresh` 就夠。

---

## 4.11 一個 tick 嘅 subrequest 到底去咗邊（2026-09-25）＋ scan 側地板

**量度**（live `/health` → `heartbeat.subreqs`，2026-09-25 03:30–03:50Z）

| window | total | 去咗邊 |
|---|---|---|
| 有 scan 嘅 tick（最重嗰個） | 32 | turso 29、lite-api 2、api 1 |
| 另一個 tick | 24 | turso 23、api 1 |
| `/health` 自觸發嘅 invocation | 23 | turso 12、dexscreener 6、gecko 2、jup 2、pump 1 |
| 跳過 scan 嘅 tick | 11 / 16 | **全部 turso** |

**結論一：row loop 已經唔係大頭。** `claimPushWatchChecksMany` 一次 `batch()` = 一個
HTTP request，所以 28 行輪替 = 1 個 subrequest（pass note `rows 282/1`）。一行一個
claim 嘅年代已經過去，§4.9 嗰句已更正。

**結論二：大頭係「散」。** 一個 tick 嘅 Turso 係 ~20 條**一次性** statement：front
（lock／heartbeat claim／pool／seen／token_stats ×2／counters）＋ completion flush
（`persistScanCompletion` 本身已經係一個 batch）＋ tail（pass 5 個 trip、deferral sync
3–5、grouped telemetry 1 讀 1 寫、drain）。冇一條「30 → 1」可以 cut；要 cut 就係合併
啲一次性 state op —— 即係 §4.6.2 做過嘅同一招（三個 sync 由 6 個 round trip 收成
1 讀 1 寫）。

**`summary.dbTickSteps`（今次新增）**：逐個 Db method 嘅 calls／ms，**只計呢個 scan
window** 嘅差額（`dbTickStepView()`：37 個 method 計時、**永不 defer**）。`subreqView`
嘅 host split 只講得出「29 個去咗 turso」，呢個講得出係邊幾條。留意同 `phases` 一樣
係一個 tick 之前嘅讀數。

**scan 側地板 `SCAN_SUBREQ_FLOOR = 12`**：scan 係唯一有可選工作嘅階段，所以由佢讓路。
`subreqRemaining() <= 12` 時放棄：

| 放棄嘅 leg | 點解可以放棄 |
|---|---|
| `meteora`（最後手段 launch 腿） | 前面有 gecko new_pools ＋ pump.fun；少一次只係少一個 tick 嘅覆蓋 |
| `geoTrend` / `jupTrend`（momentum） | 唔係主要 discovery：池會保留隻幣，有 room 嗰個 tick 再掃 |
| `gmgn` / `axiom` trending | 同上（axiom 仲有 session 讀 = 額外 Turso） |
| `backfill`（Birdeye 定期回補） | 唯一會**寫 DB** 嘅可選腿；interval gate 不變，夠鐘嗰個 tick 補做 |
| `crime-refresh`（黑名單刷新） | 有 TTL 快取；少一次刷新唔改變判斷 |

**唔會放棄**：DexScreener profiles、gecko new_pools、pump.fun、Jupiter recent 四個**主**
discovery 腿，同埋**卡片 enrichment**（arkham／axiom／gmgn／flurry／wallet）——後者係刻意
嘅：cut 一個付費 call 會改卡片顯示（§4.4.2／§4.5.1），寧願讓 discovery 廣度。每個被放棄
嘅腿都會**點名**落 `summary.subreqSkip`（＋ `summary.subreqFloor`），所以「momentum feed
靜」永遠唔會同「上游出事」混淆。

**12 呢個數**：tail 需要 pass 嘅 reserve（6）＋ grouped telemetry（1 讀 1 寫）＋ completion
flush（1 batch）＋ drain 嘅 tracker 切片 = 12 個**可見** subrequest —— 同
`DRAIN_TRACKER_RESERVE = 14` 同一套算術，只係寫入側 vs 讀取側。

**下一步（已做，見 §4.12）**：把 tail 嗰幾條一次性 state op（deferral sync 嘅讀／寫、grouped
telemetry）合併成一個讀 ＋ 一個 batch 寫。要保留「duplicate guard 先行」嘅次序同
「landed 之後才清 delta」嘅紀律（§4.9、deferrallog），所以先要 `dbTickSteps` 嘅實數。

**再下一步（已做，見 §4.13）**：front 階段同一招 —— 三條 maintenance gate row
（`schema_alter_v2_done` / `token_stats_last_prune` / `birdeye_backfill_at`）同
enabled chats，四個 round trip 收成一個讀；佢哋嘅 bookkeeping 收成一個 batch 寫。

---

## 4.12 tick tail：一個讀 + 一個寫（2026-09-25）

§4.11 留低嘅下一刀：把 tail 嗰幾條一次性 state op 合併。做咗。

**之前**（一個「全部到期」嘅 tick）

| # | 動作 | round trip |
|---|---|---|
| 1 | `getWorkerState(push_deferral)` | 1 讀 |
| 2 | duplicate guard：`getPushAudit()`；有 pending 時再加 `push_ledger` ＋ `listPushWatch(60)` | 1–3 讀 |
| 3 | 有 deliver-proof 就寫 shrunken row | 1 寫 |
| 4 | `syncPostScanTelemetry()`：`readPostScanTelemetry(4 keys)` ＋ 有嘢變就 `setWorkerStatesMany` | 1 讀 ＋ 1 寫 |
| 5 | delta 落地 | 1 寫 |

合計 **最多 6 個 Turso round trip**。

**現在**

- `Db.readPostScanTelemetry(stateKeys, limit)`：key set 由 caller 決定（worker 嘅
  `TAIL_STATE_KEYS` = `push_deferral` / `push_ledger` / `push_audit` /
  `skip_capture` / `birdeye_cu_v1`），SQL 用 `IN (?, …)` —— 同上面
  `getWorkerStates(keys)` 一模一樣。兩個 listing（`push_watch` 60 行、enabled
  chats）照舊，ORDER BY … LIMIT 不變。
- `syncPushDeferralCounters(summary)` 變成整個 tail：**一個讀**（全部 row 一次）
  → duplicate guard（純函數，唔再 await 自己嘅讀）→ shrink、三個 telemetry
  merge、delta **一個 batch 寫**（`setWorkerStatesMany`）。
- `syncPostScanTelemetry` / `runPostScanTelemetry` 退役。讀已經喺 tail 開頭
  發生，所以 throttle 判斷搬入 tail，merge 本身變成 pure planner
  `planPostScanTelemetry`（read 入；writes ＋ landed 之後才套嘅 side effect 出）。
  三個 `*_SYNC_BOUND_MS` 跟住退役：一個讀一個寫唔需要三段 900ms race，tail 由
  call site 一個 `DEFERRAL_SYNC_BOUND_MS` 包住。

**紀律冇變**（呢個係合併，唔係簡化）

- duplicate guard 依然第一個跑，in-memory drop 即刻應用 —— 同 §4.9 一樣：真正
  阻止重複卡嘅係 in-memory 嗰半，寫入只係阻止日後 recycle 再 seed 返。
- 所有 in-memory 前進（`pushDeferralBaseline`、`stalledUnflushed`、mirrors、三個
  delta 嘅清除）**只在 batch landed 之後**。一個被拒嘅 batch 等於三條失敗嘅
  單獨寫：乜都冇動，下個 tick 原封不動再試。shrink 亦因此唔會「自己一個落地」
  而 delta 冇。
- telemetry throttle 照舊「試過就前進」（best-effort；delta 未清就係 re-offer
  機制）。
- 同一條 row 兩次寫（shrink ＋ delta）嘅次序不變：後面嗰個 supersede 前面嗰個，
  最終 row 同兩次獨立寫 byte-identical。

**價錢**：每個 tick 都讀 5 條 row ＋ 60 行 watch ＋ chats（以前 idle tick 只讀
2 條 row）。仍然係**一個** request；多咗約 35 行 rows-read/tick（≈50K/日，同 pool
query 唔同量級）。換到：idle tick 2 讀 → 1 讀；全部到期嘅 tick 6 → **2** 個
round trip。

**量度**：`heartbeat.summary.dbTickSteps` 會顯示 `readPostScanTelemetry` 1 call
（以前 `getWorkerState` ×2–3 ＋ `getPushAudit` ＋ `listPushWatch` ＋
`readPostScanTelemetry`）同 `setWorkerStatesMany` ≤1 call（以前最多 3 個
`setWorkerState`）。

**測試**（`scripts/test-unit.js`）：`worker: the whole tick tail is ONE read and ONE write`
（真 client、數 round trip：2；drop ＋ ledger merge ＋ 寫入同一 batch）同
`worker: a rejected tail batch lands nothing and re-offers the delta`（write 被拒 ⇒
連 shrink 都唔會自己一個落地；retry 原封不動再試、唔會 double count；之後閒嘅 tick
只讀唔寫）。多謝 registry 係 module state：兩個測試自己 seed 自己清（`forgetDeferredTokens`），
唔會影響同一個 process 之後嘅測試。

---

## 4.13 scan 嘅 front：一個讀 + 一個寫（2026-09-25）

§4.11 留低嘅第二刀（第一刀係 §4.12 嘅 tail）：**front 階段嘅一次性 state op**。

**之前**（每個 tick 都係咁，唔理有冇嘢做）

| # | 動作 | round trip |
|---|---|---|
| 1 | `listEnabledChats()`（scan 嘅第一個讀） | 1 讀 |
| 2 | `resumeLaunchBackfill` → `getWorkerState(schema_alter_v2_done)` | 1 讀（migration 完成之前） |
| 3 | `pruneOldTokenStats` → `getWorkerState(token_stats_last_prune)` | 1 讀（**每 tick**，就算唔到期） |
| 4 | `runPeriodicBackfill` → `getWorkerState(birdeye_backfill_at)` | 1 讀（**每 tick**） |
| 5 | 到期嘅 prune：counter bump ＋ interval stamp | 最多 2 寫 |

四條讀全部係「一條 `worker_state` row ＋ 隔籬一個 chat listing」——同一條 `batch()`
可以一次做完，同 §4.12 一模一樣嘅形狀。

**現在**

- `Db.readScanFront(SCAN_FRONT_GATE_KEYS)`：**一個** `batch([stateRows, chats], "read")`。
  key set 由 caller 決定（`SCAN_FRONT_GATE_KEYS` = `schema_alter_v2_done` /
  `token_stats_last_prune` / `birdeye_backfill_at`），chats 半邊係逐字
  `SELECT * FROM chat_settings WHERE enabled = 1`，`mapRow` 亦係同一個。
- `Db.writeScanFront(entries)`：front 嘅 bookkeeping 一個 batch。`add: true` 嘅 entry
  用 `bumpTelemetryCounter` **逐字一樣**嘅 SQL（`CAST(value AS INTEGER) + excluded.value`），
  delta 0 唔入 batch（同以前 delta 0 唔寫一樣）。
- 三條腿改成食 pre-read：`Db.gateOf(front, key)`（db 內部）／
  `Scanner.stampFront(key, value)`（scanner 內部）。**冇 front 嘅 caller**（command handler、
  diagnostic、test）行為完全不變 —— 仍然自己讀自己寫。
- `Scanner.flushScanFront()` 喺 pool 階段之後叫一次（正常路徑），scan 嘅 `finally`
  再叫一次（提早 return 嘅路徑：subrequest floor cut、stop check、空 pool）。buffer 空就係
  no-op，所以唔會多一個 request。

**保留嘅紀律**

- **「absent」唔等於「冇讀過」**：gate row 唔喺 map 入面 = 條 row 從未寫過，係一個
  **讀數**。所以 `gateOf` 同 scanner 嗰句 inline lookup 都係 `get() ?? null`，冇 fallback
  re-read —— 一個唔存在嘅 flag 唔可以因為「順手」而變成一次多餘嘅 round trip，
  亦唔可以變成「假設佢存在」。
- **被拒嘅 batch = 全部冇寫**：每一條 row 都係「呢個 maintenance job 上次幾時跑」，
  下個 tick 由頭推導，所以 flush 只 log 唔 throw —— scan 唔會因為 bookkeeping 而失敗。
  buffer 喺寫之前清空，所以一個被拒嘅 counter 唔會加兩次。
- chats 半邊嘅 projection／ORDER／`mapRow` 完全唔變，所以 pool bounds 用嘅係同一組
  chats row。

**價錢**：冇。四個讀 ＋ 最多兩個寫 → **一個讀 ＋ 最多一個寫**。以前 idle tick 嘅
15–16 個 Turso statement 裡面，呢四條固定出現嘅 gate 讀冇咗三個。

**量度**：`heartbeat.summary.dbTickSteps`（scan window 嘅 census）同 `dbSteps`
（cumulative per isolate）—— `readScanFront` 係 census 一分了（`src/tickprobe.ts`），所以
**before** 係 `getWorkerState` ×2–3 ＋ `listEnabledChats` 1，**after** 係
`readScanFront` **1** ＋ `listEnabledChats` **0** ＋（有 bookkeeping 嗰個 tick）
`writeScanFront` **1**。

**測試**（`scripts/test-unit.js`，兩個都數真 client 嘅 round trip）：
`scanner: the scan front is ONE read, and its legs pay no reads of their own`（front read =
1 個 read batch、0 個 execute；absent 嘅 gate row 唔會出現喺 map；prune 唔到期 ⇒ 0 個新 request；
resume 嘅完成旗係**排隊**而唔係自己寫；`writeScanFront` = 1 個 write）同
`scanner: a due prune rides the front's ONE write, counter and stamp together`
（到期 prune：deletes 照跑、讀數 0；counter（ADD）＋ interval stamp 入同一個 batch，
counter 剛好減咗 deleted；空 buffer 唔算一個 request）。

---

## 4.14 Birdeye CU：由一個總數到「邊個花嘅」，同取樣下限嘅答案（2026-09-25）

Operator 問：用 `birdeyeCu` 嘅真實月用量重新評估 holder probe gap 同卡片側 CU 預算，
睇可唔可以收窄取樣下限？——**答案係唔收窄**，但答得成之前先要修好個讀數，因為 §4.5.1
嗰個 counter 只答得到「幾多」，答唔到「邊個」。

### 1. 量到嘅數（live，2026-09-25 08:03Z）

```
birdeyeCu { day "2026-09-25", today 780, monthCu 2740, pendingCu 0, monthlyMax 30000 }
```

* 計數器**2026-09-23 12:54Z 才上線**（§4.5.1 嘅 deploy），所以 `monthCu` 2740 係
  **43.2 小時**嘅總和，唔係一個月 ⇒ 63 CU/h ≈ **1,522 CU/日 ≈ 46K CU/月**。
  而今日自己係 96.7 CU/h（≈70K/月），不過入面有大約 **340 CU 係我自己嘅診斷**：
  一個 `/debug/backfill` 就係 `chunkCount 7` × 40 CU ≈ 280 CU（＋new_listing probe 40）
  —— 即係**一次診斷等於一日 probe 預算嘅 2/3**。
* 三個消費者同佢哋嘅**上限**（config 推出嚟，唔係估）：

  | 消費者 | 單價 | 次數/日 | CU/日 | 佔比 |
  | --- | --- | --- | --- | --- |
  | holder probe（`PUSH_WATCH_HOLDER_MIN_GAP_MIN = 60`） | 20 CU | ≤24 | **≤480** | ≤21–36% |
  | periodic backfill（`BIRDEYE_BACKFILL_INTERVAL_MIN = 360`，lookback 360 ⇒ 1 chunk） | 40 CU | 4 | **160** | ~11% |
  | 卡片側 `resolveHolderCount`（每次 enrich 一次 `token_overview`） | 20 CU | 每次 unseen candidate 入 enrich | **其餘 ≥60%** | — |
  | 卡片側 `resolveTraderData`（`top_traders`，**冇記錄單價** ⇒ charge 0） | 0 CU | 同上（同一次 enrich） | 唔入賬 | 未知 |

  `getFirstMinuteVolume` / `getMinMarketCapUsd`（ohlcv 35 CU）喺 repo 內**冇任何 call site**
  ⇒ §4.4.2 表入面「首分鐘量、最低市值」嗰兩項已經係死 code，唔再係消費者。
* 一個重要嘅誠實邊界：上表加起來 46K/月 > 30K free tier，但 Birdeye **冇**頂 —— 實測
  `/debug/birdeye-overview?address=…` 597ms 正常回 `holderCount 622`，冇 429。所以一係
  account 已經係 paid，一係 `token_overview = 20 CU` 高估咗 ≥33%，一係 `top_traders` 嘅
  未記錄單價令實況更差。**任何以 CU 為單位嘅決定都要先答呢條**，而答佢需要 calls 對數。

### 2. 做咗嘅：`byEndpoint` ＋ `recentDays`（純讀數，唔改任何決定）

* `chargeBirdeyeCu` 除咗總數，再記每個 endpoint 嘅 `{ calls, cu }`（**0 CU 都數呼叫**：
  `top_traders` 係 vendor 真收費、repo 冇單價嘅嗰隻，佢嘅呼叫數就係 `monthCu` 嘅窿）。
  同一個 isolate scope、同一條 drain 紀律：read 無條件、**landed 之後才清 delta**、
  寫入途中到達嘅 charge 留在 pending（逐格驗）。
* 新 durable row `birdeye_cu_by_v1`，行 shape `{ v: 1, days: { "YYYY-MM-DD": { endpoint: { calls, cu } } } }`。
  **`birdeye_cu_v1` 一個 byte 都唔改** —— 歷史日子冇拆分就係「冇讀數」，唔會扮 0。
  兩條 row 喺 tail 嘅**同一個 read**（`TAIL_STATE_KEYS`）同**同一個 batch**寫入
  ⇒ 零額外 round trip，總數同拆分唔可能對唔上。
* `/health.birdeyeCu` 加 `recentDays`（逐日總數，新到舊，7 日）同 `byEndpoint { today, month }`；
  兩條 CU row 併入 /health 本來就有嘅 `getWorkerStates` 批次，順手收埋原本嗰個獨立讀（−1 subrequest）。

### 3. 答案：唔收窄（而且唔係「暫時」）

1. **全機已經超支**：46K CU/月 vs 30K tier。
2. **probe 唔係大頭**：≤480 CU/日（≤21–36%），而其餘 ≥60% 係卡片側。
3. **收窄買到嘅嘢比想像中少**：gap 60 → 30 令 probe 由 480 → 960 CU/日（**+14.4K/月**），
   而因為「一個 pass 一個 probe」（§4.3），每行嘅持有人數刷新由 **~31 小時** 縮到 **~15 小時**
   —— 唔改變任何 gate、發卡條件或者卡片語意，純粹係卡面個持有人數幾新。
4. **要收窄，先要卡片側唔再重複買**：一張卡嘅 `token_overview`（20 CU）而家係**每次 enrich**
   都買一次，而 enrich 唔止發卡嗰次（defer／重評都會再入 enrich）。省到嗰邊，gap 60 → 30
   甚至 20 就有預算（30 分鐘 = 28.8K/月，20 分鐘 = 43.2K/月 —— 仍然要同卡片側分）。
   §4.4.2 已經記低兩個唔使錢嘅方向（durable holder cache、GMGN 免費 `holder_count`），
   兩者都會改卡面數字嘅新鮮度／來源，所以係一個要明講嘅決定，唔應該夾埋喺讀數刀做。

### 4. 落線點驗（下一個鐘）

1. `curl /health | jq .birdeyeCu.recentDays` 有 ≥2 日、新到舊。
2. `curl /health | jq .birdeyeCu.byEndpoint.month` 有 `tokenOverview` / `newListing`
   （`ohlcv` 應該**完全唔出現**，因為冇 call site），而 `topTraders.calls` > 0 即係確認
   「repo 個 CU 總數低估咗 vendor 嘅收費」。
3. `byEndpoint.month.tokenOverview.calls` = 卡片 enrich 次數 ＋ probe 次數；probe 嘅次數由
   pass note 嘅 `probe<N>`（§4.4.1）數得到，所以**卡片側 = calls − probes** ——
   呢個就係下一步「卡片側值唔值得買」嘅數。
4. 同 Birdeye dashboard 嘅當日用量對數：如果 vendor 讀數係 repo 讀數嘅 1/20，咁 20 CU/次
   就係高估，全盤預算決定（包括 gap）都要重算。

**測試**（`scripts/test-unit.js`）：`birdeye: the split ledger counts calls per endpoint, priced or not`
（calls/CU 分開、0 CU 都數、空 endpoint 冇格、mid-write 逐格）＋ `birdeye: the split parser, merge and stats
follow the totals' window`（unknown endpoint／junk day／bad number／空日全 drop、合併、剪枝同 totals 同一個窗、
today vs month、`recentDays` 排序）＋ 舊 `worker: syncBirdeyeCu …` 測試擴充（同一個 batch 寫兩條 row、
rejected batch 兩邊 delta 一齊 re-offer；write-down stub 改成連 batch 都失敗）。

---

## 4.15 卡片側嘅持有人數：由「每次 enrich 都買」變成「一個 durable 讀數」（2026-09-25）

Operator 嘅決定（§4.14 §3.4 嘅下一步）：**要收窄 gap，先要卡片側唔再每次 enrich 都買一次
`token_overview`。** 兩個方向之中揀咗 **durable holder cache**，唔用 GMGN 免費 `holder_count`。

### 1. 點解係 cache 而唔係 GMGN

* GMGN 個 `holder_count` 係**另一把尺**（換源＝換卡面數字，正正係 §4.14 §3.4 講嘅「要明講嘅決定」）；
* 而且佢個 edge 以 IP 級 429 封咗 Worker 嘅共用 egress（2026-09-24 實測 `requests 9 / http429 9 /
  consecutive429 9 / lastStatus 429`，leg 已經關咗），即係呢條路今日**行唔通**。

Cache 保住同一個數字、同一個來源、同一個 metric，只係唔再重複買。

### 2. 慳喺邊：重複唔係「每張卡」，係「每次 enrich」

`resolveHolderCount` 唔係每次發卡叫一次 —— 係每次 **enrich** 叫一次，而同一個幣會重入 enrich：

* 卡片送出被 tick cut 延後（deferral）→ 下一個 tick 再 enrich；
* 某個 gate 今個 tick 拒、下個 tick 放（mcap/vol 喺邊界浮動）→ 再 enrich。

`isTokenSeen` 只喺**成功送出之後**才寫，所以呢條路冇 dedupe：每次重入都係 20 CU
（`getJson` 逐個 attempt 收費，失敗重試最多 3 次 = 60 CU）。基線係 §4.14：46K CU/月，
卡片側 ≥60%。

### 3. 做咗嘅：`token_stats.holder_count` / `holder_count_at` ＋ TTL

* 兩條新 column。CREATE TABLE 有（fresh DB 唔使 ALTER），legacy DB 由 `addColumnIfMissing` 補
  （idempotent，同 `max_mcap_observed` 一條路）。讀側係 `SELECT *`，所以兩條 column **順便帶返嚟**
  ⇒ **cache hit = 0 request、0 CU、0 round trip**。
* `holderCountCacheHit()`（`src/birdeye.ts`，exported 做測試）：
  * 界線係 miss（TTL exclusive）—— 過期一定要重新買，唔可以靠 off-by-one 多食一個 tick；
  * `ttlMs <= 0` = 關（＝ pre-2026-09-25 行為，逃生門）；
  * `cachedAt <= 0` = 「從未寫過」嘅 sentinel，唔係 1970（同 `healthAgeMs` 同一條規矩）；
  * `null` count = 冇讀數，唔會當 0（發明一個 0 = 卡面聲稱 0 個持有人）。
* 寫入：**只有真正拿到 count 才寫**（一次 UPDATE，`stats.token` = token_stats PK）。寫入失敗
  ＝失去一個 cache entry，**唔會**失去個讀數（卡照出嗰個數），下一次再買返。
* 新 dial `BIRDEYE_HOLDER_CACHE_MIN = 30`（code default 30，0 = 關）。
* **新幣完全唔受影響**：第一次 enrich 冇 cache，所以卡第一次出嘅數字永遠係即時買嘅。TTL 只決定
  「一個仲喺 enrich 出入緊嘅幣」幾久重買一次 —— 最壞 30 分鐘一次（≈2 次/鐘），而 deferral 每 tick
  重試嘅話本來係 ≈60 次/鐘。

### 4. 落線點驗

1. `byEndpoint.month.tokenOverview.calls` 對 `pushes`（`/debug/pushes`）：本來 `calls ≫ pushes`
   （enrich 重入），之後應該收窄到 ≈「每個（coin, 30 分鐘窗）一次」。呢個就係本次改動嘅收據。
2. 有值嘅 row：`holder_count_at` 係讀取時間（唔係 0），而且 re-enrich 喺 TTL 內**唔會**改動佢。
3. 卡面持有人數唔會跌到 `—`（第一次一定 live）。
4. 回退驗證：`BIRDEYE_HOLDER_CACHE_MIN = 0` 要即時回復舊行為（唔使 redeploy code，wrangler.toml
   改完再 deploy 即可）。

### 5. 咁 gap 呢？（刻意唔喺呢一刀改）

* 卡片側落返之後先計得準：以 §4.14 嘅數，卡片側 ≥60%（≈28K/月）係最大變數，cache 之後跌幾多
  要睇上面 #1 嘅 calls 對數。
* gap 60 → 30 = probe 480 → 960 CU/日（**+14.4K/月**）；60 → 20 = **+28.8K/月**。
* 所以次序係：deploy → 睇 calls/pushes 比 → 才決定 gap。收窄 gap 會改卡面數字嘅刷新率（每行
  ~31 小時 → ~15 小時），係一個要明講嘅 dial 決定，唔應該夾埋喺「令卡片側唔再重複買」呢一刀。

**測試**（`scripts/test-unit.js`）：`birdeye: the holder cache reuses a reading inside its TTL and never
invents one`（界線係 miss、時鐘偏差、`0` = 關、`null`/`0` 唔算讀數）＋ `db: the holder cache is ONE write,
and a coin nobody read stays unknown`（真 DB：fresh schema 帶兩條 column、未讀過 = null 唔係 0、
一次 write、覆寫舊讀數）＋ `out-of-window patch: the card path reads the holder cache BEFORE it buys`
（順序、`holderCountCacheHit` 必須係 value import 唔可以變 type import、半貼即紅）。

---

## 4.16 Tracker probe 同卡片側共用同一個持有人讀數（2026-09-25）

Operator 要求：probe 嘅持有人數都寫入 §4.15 嗰個 durable cache，令 probe 同卡片側共用同一個讀數。

### 1. 兩個買家，同一個幣

`/defi/token_overview`（20 CU）喺 repo 只有兩個買家：

* 卡片側 `Scanner.resolveHolderCount`（§4.15 加咗 cache）；
* tracker probe（`PushWatcher` 嘅 holder stage，每個 pass 一個、隔 `PUSH_WATCH_HOLDER_MIN_GAP_MIN`）。

而一個幣係**被推嘅下一秒就被追蹤**：`push_watch` 第一行嘅 `holders_checked_at` 係 NULL，所以下一個
pass 就會 probe 佢 —— 即係同一個讀數啱啱先買完，轉頭又買多次。呢個就係今次接埋嘅窿。

### 2. 做咗嘅

* `Db.setPushWatchHoldersMany`（probe 嘅唯一寫入點，一個 batch ＝ 一個 round trip）除咗寫 push_watch
  嘅 `holders_last` / `holders_checked_at` / `holders_at_push`，再加 N 條
  `UPDATE token_stats SET holder_count, holder_count_at`。
* **特登同一個 batch**：row 自己個數同共用 cache 唔可能對唔上（一個 rejected request 兩邊都冇寫），
  而 trips 數目完全不變（`spent.holders.trips`）。
* 卡片側唔使改：`resolveHolderCount` 已經讀 token_stats（§4.15）。

### 3. 買到咗幾多（誠實量度）

唔係大錢，講清楚：

* probe 一 pass 一個、gap 60 分鐘 ⇒ 上限 24 次/日 ＝ 480 CU/日（§4.14）；
* 主要受益位係「一個新幣被推之後嗰個 pass」：40–52 卡/月 ⇒ **800–1040 CU/月**；
* 其餘情況係「同一個幣喺 30 分鐘窗內有人買過」—— 例如第二個 chat 嘅卡被 defer 之後重試。

所以呢一刀買到嘅係**一致性**（兩邊講同一個數）＋一個細但實嘅 CU 位，唔係第二個 28K。

### 4. 刻意冇做：probe 讀 cache

即係「probe 見到 cache 新鮮就唔買」。慳嘅係上面 §3 嗰 800–1040 CU/月，但代價係：

* probe note 要加一個新 counter（唔係 probe 就唔可以報 `probe1`）—— 即係改 `probe/miss/cut` 嘅讀數
  格式，而呢個 repo 對「讀數唔准講大話」嘅要求高過 20 CU；
* 若果 TTL 大過 tracker 嘅持有人刷新窗，probe 就會永遠唔買，tracker 嘅持有人數會**凍結**
  （退化唔明顯，但係真嘅）；
* 要安全就要多一條規則：只喺 `cachedAt > 該行自己嘅 holders_checked_at` 時重用（即「別人已經讀過，
  而且比我手上嘅新」），咁 probe 就永遠唔會令自己嗰行變舊。

呢個係一個獨立、要明講嘅改動，應該配自己嘅 note counter，所以留返下一步。

### 5. 落線點驗

1. 一個新 push 之後嘅第一個 tracker pass：`probe` 照舊（probe 冇變），而 `token_stats.holder_count_at`
   會等於 probe 嗰個 `at`。
2. `spent.holders.trips` 唔應該上升（同一個 batch 多咗 N 條 statement，但 request 冇多）。
3. 反向：如果第二個 chat 嘅卡被 defer，佢下一次 enrich 唔應該再買（`tokenOverview.calls` 冇升，而卡面
   持有人數仍然有值）。
4. 一致性：同一個幣，`push_watch.holders_last` 同 `token_stats.holder_count` 喺 probe 之後應該逐字一樣。

**測試**（`scripts/test-unit.js`）：`db: the tracker's holder probe shares its reading with the card path,
in ONE write`（真 DB：一次 write 同時落 push_watch 同 token_stats；`holders_at_push` 由第一次 probe seed；
卡片側 `holderCountCacheHit` 對 probe 嗰個讀數為 true；rejected batch 兩邊都冇寫；之後嘅 probe 覆寫兩邊）。

---

## 4.17 卡片側兩條付費線直接刪（Sniper / Holders）：Axiom 免費行已經有嗰兩個數（2026-09-25）

Operator 嘅問題（承接 §4.15 / §4.16）：「**唔要卡片 holders 行同 Sniper 行，可以省幾多 CU？**」
答案：兩條線嘅 endpoint 直接歸零 —— 而呢個係唯一一種**唔會令卡面數字變差**嘅刪法。

### 1. 為咩刪得：嗰兩個數已經由免費來源印

| 卡面行 | 來源 | 價 | 刪完之後 |
|---|---|---|---|
| `🎯 Sniper 買入` | Birdeye `/defi/v2/tokens/top_traders`（`getTraderInfo`） | 帳簿記 0 CU（vendor 實價未知，見 §4.14） | 冇咗；`狙擊 0%` 已經喺 Axiom 行 |
| `👥 Holders` | Birdeye `/defi/token_overview`（`getTokenOverview`） | **20 CU／次** | 冇咗；`持有人 356` 已經喺 Axiom 行 |

`renderAxiomSummaryLine` 喺 Axiom payload 解得開嘅時候**已經**印 `持有人`（`numHolders`）同
`狙擊`（`snipersHoldPercent`），所以刪走嘅係「Axiom 解唔到 → fallback 行」嗰份複製品，
唔係卡面資訊本身。Axiom session 死嗰陣卡片少兩行（唔係顯示 `—`）——同 GMGN / Arkham /
crime 一樣嘅「冇就唔出」立場。

兩條線都**唔餵任何 gate**（sniper filter 早就拆咗，holder 數一直只係卡面），所以呢一刀嘅
代價完全喺卡面，push 覆蓋率零影響。

### 2. 其餘 caller（刪完之後仲喺度，所以 endpoint 冇死）

* `getTokenOverview`：tracker 嘅 holder probe（`pushwatch.ts`，gap 60 分鐘制）＋ `/debug/birdeye-overview`；
* `getTraderInfo`：`scripts/test-filters.js`（手動測試腳本）。

即係話刪嘅係**卡片側**嘅 caller，唔係 endpoint 本身；probe 同 §4.16 之前一模一樣照跑。

### 3. 連帶清走嘅死碼

* `Scanner.resolveTraderData` / `Scanner.resolveHolderCount`（兩個係卡側唯一 caller）；
* `holderCountCacheHit`（`birdeye.ts`）—— §4.15 個 TTL 規則，唯一 reader 就係 `resolveHolderCount`；
* `Db.updateTokenHolderCount`—— §4.15 個 cache 寫入，唯一 caller 亦係 `resolveHolderCount`；
* `Db.setPushWatchHoldersMany` 入面 N 條 `token_stats` statement（§4.16 嘅 shared-cache 寫入）——
  probe 自己嗰行（`holders_at_push` / `holders_last` / `holders_checked_at`）**照寫**，仍然係 1 個 batch；
* `BIRDEYE_HOLDER_CACHE_MIN` 同 `AppConfig.birdeyeHolderCacheMs`——冇 cache 就冇嘢好 tune。

`token_stats.holder_count` / `holder_count_at` 兩條 column **留返喺 schema**（唔為咗刪一個規則
去刪資料；`CREATE TABLE` 同 `addColumnIfMissing` 都唔動）。§4.15 / §4.16 兩節保留做歷史記錄。

### 4. CU 算術：為咩非砍 ~49% 不可

Operator 嘅 Birdeye dashboard：period **2026-09-20 → 10-20**，額度 30,000，**已用 8,470 CU**。
`/health.birdeyeCu` 自己嗰個月 3,160 CU 係 counter 上線（2026-09-23 12:54Z）之後 44.4 小時嘅
讀數 —— 兩個來源都 ≈ **1,700 CU／日**。

* 剩 21,530 CU ÷ 25 日 ⇒ 上限 **861 CU／日**；
* 照原本速度 ~12.7 日燒完 ⇒ **10 月 7–8 日見底**；
* 整個 period 需要 ~50,800 CU ⇒ **要砍 ~49%**。

砍喺邊：§4.14 量到卡片側係 ≥60%（≤ ~1,000 CU／日），而嗰 60% 嘅全部就係呢兩條線之一
（`token_overview` 20 CU 係大頭）。所以呢一刀嘅目標係**令卡片側歸零**，剩返嘅只有
probe（≤480 CU／日）、backfill（160 CU／日）同 `/debug/*`。

### 5. 落線點驗

1. `/health.birdeyeCu.byEndpoint.month.tokenOverview.calls` **唔應該再跟 pushes 上升** —— 只應該
   跟 `pushWatch`（probe）上升，即 ≈ 1 次／60 分鐘／被追蹤嘅幣。
2. `…byEndpoint.month.topTraders.calls` **停止增長**（= 0）。vendor 嗰邊嘅真價仍然要用 dashboard
   同日 delta ÷ calls 去推 —— 帳簿記 0，唔可以用帳簿證明省幾多。
3. 卡面：Axiom 行照有 `持有人` / `狙擊`；Axiom 解唔到嘅卡少兩行（預期行為）。
4. 追蹤警報 `📈 持倉增長`（+10%）同 `⚡ 背離` **照響** —— 佢哋讀 `push_watch.holders_last` /
   `holders_at_push`，同卡面嗰兩行無關（probe 保留就係為咗呢個）。
5. `/debug/birdeye-overview` 照樣買得到 `token_overview`（probe 路徑未死）。

### 6. 已知代價

* Axiom session 死嗰陣卡片少兩行（唔係差數字）；
* `token_stats` 兩條 column 變成純歷史資料；
* CI 只係 typecheck ＋ unit test ＋ deploy，所以 #1 要等落線後至少一個 probe 週期（60 分鐘）
  才睇得到 —— `byEndpoint` 喺新 isolate 打過 Birdeye 之前會係空嘅，唔係 bug。

**測試**（`scripts/test-unit.js`）：`out-of-window patch: the card stops buying Birdeye`（掃描
stripped 源碼：卡側冇 caller、冇 cache reader、render 冇兩行、batch 只剩三個 slot、endpoint 仍然
存在）＋ `db: the holder probe writes its own row and nothing else, in ONE write`（真 DB：1 個
request、N 條 statement＝每行一條、`holders_at_push` 由第一次 probe seed、token_stats 冇被寫）。

<!-- 4.17-correction -->

### 更正（落線後查證，2026-09-25）：Axiom 行今日係熄嘅，卡面真係少咗嘅兩個數

上面寫「兩條線嘅數字已經由免費嘅 Axiom 行印」——**呢句係指 Axiom 行著嘅時候**，唔係今日。
Axiom 自 **2026-09-19** 起全域關咗：`wrangler.toml` 嘅 `AXIOM_ENABLED = "0"`，因為
refresh-token endpoint 被 Cloudflare Bot Management 418 擋死，session 冇法由 Worker 續期。
所以 `/health` 讀到 `axiomConfigured: false`，`renderAxiomSummaryLine()` **每一次都回 `null`**，
卡面一直行嘅係 legacy fallback group。

即係話：**今日嘅卡片係真係冇咗狙擊同持有人數嘅** —— 唔係顯示 `—`，係整行冇咗。上面 §1 嘅表格
同 §5 第 3 點要照呢點讀（「已經喺 Axiom 行」＝復活 Axiom 之後先會發生）。

呢個係今次改動**已知、要明講嘅交易**：卡片側 Birdeye 花費 → 0（≈ −49% 總量），換嚟卡面少兩個
數據點。兩個數會喺 Axiom 復活（`docs/axiom-refresher.md`）之後自動返嚟，唔使再改 code；
追蹤嘅 `📈 持倉增長` / `⚡ 背離` 警報**不受影響**（佢哋讀 `push_watch` 自己嘅讀數）。


---

## 4.18 The 2026-09-25 audit's five findings (scan envelope, tracker slice, cron front, stale drain error, profiles abort)

Operator ran the five-finding audit against the live worker and said "fix 1-5". Each finding,
its cause, and what landed:

### 1. Scan ticks dying again after 12:00Z, in the gate/front stage (red)

**Cause**: `scanRaceWindowMs` floored the race window at 2_500ms, which broke its own
invariant - `preRace + scanRace + flush <= SCAN_TICK_BUDGET_MS`. At preRace 7s the sum is 14s,
so the slow-front tick the clamp existed to protect was the one killed before its completion
flush, and a recovering successor is a slow-front tick BY CONSTRUCTION (rebuild + re-init).
This is `docs/scan-completion-loss.md`'s Patch 1, written but never applied.

**Fix** (`src/worker.ts`): the window drains 1:1 to 0 and is capped at `budget - reserve`.
`scanRaceMs === 0` fires the timeout branch at once, `scanner.abort()` stops the scan at its
next phase boundary, and the tick still writes a completion row (`ok:false`, reason naming the
0ms window). Cost: that one tick evaluates nothing - its candidates stay in the re-eval pool.
A completed 0s scan beats a dead tick that evaluates nothing.

### 2. Tracker pass `ok:0/0` - the scan ate the subrequest residual (red)

**Cause**: the pass runs LAST and defers by name, so it is the residual claimant of the
invocation's 50 subrequests - and the scan, which runs first, had no reservation for it.
Live: `ok:0/0 deferred:subreq-budget` pass after pass while the rotation stalled.

**Fix** (`src/worker.ts`): `TRACKER_PASS_SUBREQ_RESERVE = 9` (the pass's own
`TRACKER_SUBREQ_FLOOR` 3 + `TRACKER_SUBREQ_RESERVE` 6) plus a pure `scanSubreqLeft` helper; the
worker now hands `scanner.runOnce(() => scanSubreqLeft(subreqRemaining()))`. The scan's OPTIONAL
legs (meteora / geoTrend / jupTrend / gmgn / axiom / backfill / crime-refresh) stand down while
the pass's slice is intact. Nothing mandatory changes: DexScreener profiles, gecko new_pools,
pump.fun, Jupiter recent and the card-enrichment path are untouched.

### 3. No COMPLETED cron tick for 26 minutes, held up by the HTTP fallback (amber)

**Cause**: the cron handler's `ensureInitialized` was the last UNBOUNDED front await. A wedged
init (cold-isolate DDL, a stalled Turso handshake) died inside the invocation BEFORE the gate
could record the arrival, so `scheduled_tick_at` froze while the fallback kept scanning - a cron
hole that reads exactly like a dead trigger.

**Fix** (`src/worker.ts`): `FRONT_INIT_BOUND_MS = 3_500`, and the scheduled handler awaits
`recoveryAwait(ensureInitialized(env), FRONT_INIT_BOUND_MS, "init")`. A timed-out init falls
through to the existing `!scanner` guard, which records the arrival with the standalone raw
client (`bumpScheduledTickLegacy`) and returns; the pending `initPromise` is picked up by the
next delivery. The pre-tick split still publishes `steps.init`.

### 4. `writeDrainError` frozen at 8.4h and reading as live (amber)

**Cause**: the durable row is written only on a FAILURE and never rewritten on success, so after
a recovery it described an incident that was over while `/health` presented it beside counters
that do move.

**Fix** (two halves):

- `src/tickprobe.ts`: `drainDeferredWrites` clears the row once a drain lands clean (and on an
  empty queue), guarded by a module flag so only the isolate that wrote it clears it, and only
  once - a healthy isolate pays NO extra write.
- `src/worker.ts`: `/health` publishes `writeDrainErrorStale` (age > `WRITE_DRAIN_ERROR_STALE_MS`
  = 10 min) beside the existing age, covering the cross-isolate case where the reader is not the
  isolate that failed.

### 5. `profiles` raw empty, carried by the make-up lane (yellow)

**Cause**: the bounded profiles fetch measured its abort window BEFORE the shared DexScreener
throttle queue, so an attempt could be issued with an expired window (or a 1ms one) - a doomed
request that also ran the caller past its budget. Live: `raw 0` tick after tick with the make-up
list filling `profiles` (a 429 reads as `failedTotal`, not as an empty feed).

**Fix** (`src/dexscreener.ts`): the throttle wait is charged to the caller's deadline (the
attempt is dropped, not sent, once the window is spent), and `PROFILE_FEED_SELF_BUDGET_MS` rose
320 -> 480. 480 still sits under the throttle gap plus `RETRY_MIN_ATTEMPT_MS` (250 + 250), so the
leg's single-attempt / fail-fast arithmetic is unchanged; the window is 900ms (FEED_DEADLINE_MS),
not the 600ms this budget was originally measured against.

### Verification

- `npm run typecheck` clean.
- `npm run test:unit` 348 passed / 0 failed (was 346): the race-window test now pins
  `scanRaceWindowMs(5_000) === 0` and `scanRaceWindowMs(9_000) === 0`; two new worker tests cover
  the reserve arithmetic + call site and the bounded init + its split; a test-tick-path case
  proves the drain-error clear is ONE write and then nothing; a defer-priority case proves no
  request is issued once the throttle wait has eaten the caller's window.
- Live verification still required after deploy: `scheduledTickHoleMs` / `scheduledTickAt` should
  stop freezing; `pushWatchPass.note` should read `rows N/...` instead of
  `ok:0/0 deferred:subreq-budget`; `/health.writeDrainErrorStale` should never be `false` beside
  an old record; `summary.feedMakeup.lastRawProfiles` should climb off 0.

Landed by `docs/patches/scan-front-and-tail-reserve.apply.js` (worker.ts and test-unit.js are far
past the file tool's edit window).

---

## 4.19 死 tick 嘅收費閘：candidate chain 自己一個 floor（2026-09-25）

500 行 scan-history 裡 32 個 `previous tick died before its completion flush`，15 個嘅階段 stamp
停喺 `gate`（chain 入口）而 count 偏低（10–30 / 可用 38）—— 即係爆嘅係 invocation 嘅 50
subrequest，而 stamp 自己都係 subrequest，所以連證據都寫唔入。scan 側一直只有可選腿嘅
`SCAN_SUBREQ_FLOOR` 同 tracker pass 嘅 reserve，**chain 完全冇閘**。

落咗：`CHAIN_SUBREQ_FLOOR = 3`（＝ completion flush 整條重試梯：attempt 1 ＋ racing retry ＋
backoff retry）—— chain 開始每個 coin 之前問一次，唔夠就 defer＋點名（`summary.chainFloor` /
`chainDeferred` / `subreqSkip` 多一個 `chain`），取捨同隔籬嗰個 deadline break 一樣（coin 留喺
re-eval pool，一次延遲，唔係漏推）。同時 list feed（profiles / boosts）改用 colo edge cache
（`cacheEverything` ＋ `cacheTtl 60` ＋ `cacheTtlByStatus` 把 4xx/5xx 拒之門外），因為
`raw 0` 嘅 27% 對得上 `/debug/dex429` 嘅 17 次/鐘 —— 共用 egress IP 嘅 429，唔係我哋嘅 spacing。

全部細節、代價同驗收步驟：`docs/tick-spend-and-profiles-2026-09-25.md`。

---

## 4.20 Round 2：tick 嘅 Turso round trip 再收三刀 ＋ `budgetDrops` 嘅真身（2026-09-26）

§4.11 量到嘅「一個 tick ~16–20 個 distinct one-shot statement」今次收咗三個：**cold init 嘅
四個 `worker_state` 讀 → 1 個 `getWorkerStates`**、**tracker pass 嘅 entry（RUNNING stamp ＋
listing ＋ settle 嗰行）3 → 1 個 batch**（`Db.beginTrackerPass`，被拒就跌落 pre-merge 三步，
代價最多等於舊 code）、**stamp 由 scanner 自己嘅一個 round trip 改為騎 entry batch**；
同時 census 加咗 key 入 label（`getWorkerState:axiom_access_token`），令下一輪合併有數可依。

另外一條獨立讀數：`budgetDrops` 每 tick 2–3 唔係被拒（429），係 **request 根本冇發出** ——
throttle 條 global 鏈會俾「注定答唔到嘅 attempt」佔 250ms 一個 slot，所以一個 drop 會推遲
後面嘅腿、變兩個。修法＝ `Throttle.nextSlotAt()` 喺入隊前先問 slot（冇窗就免費 drop，queue
內舊檢查留做 backstop），pair 階段喺 `nextSlotAt() >= deadline` 時直接收工、唔再製造尾巴
batch；同時 `dropsByLeg` / `lastDropLeg` 令讀數點名邊條腿（profiles / boosts / pairs 三種處理）。

本地驗收：`npm run typecheck` clean、`npm run test:unit` **353 passed / 0 failed**（前值 348；
新增真 Db 嘅 entry-batch case、source-shape guard、census labelled case，同
`test-deferred-priority` 嘅兩條 drop-slot case）。

全部細節、代價、已知取捨同落線驗收步驟：`docs/round2-merges-and-budget-drops-2026-09-26.md`；
落線紀錄：`docs/patches/round2-tick-merges-2026-09-26.apply.js` ＋
`docs/patches/round2-stamp-move-tests-2026-09-26.apply.js`。

---

## 4.21 Round 3：admission stamp 騎上 scan-lock claim（2026-09-26）

§4.20 留低嘅 labelled census 今次點名咗排頭嗰個：**`setWorkerState:tick_progress` 每 tick 5 個
request**（phase ladder：admission ＋ front／pair／gate ＋ postscan），係 ~21-request tick 裡最大
嘅單一 DB 項。但 ladder 嘅第一個 stamp——「tick 被接納、仲未入 scan」——claim batch 本身已經寫住：
同一個 batch 內嘅 heartbeat upsert 就係 `{at: startedAt, phase: "scanning"}`，同一個 `at`。
所以 admission stamp **騎上 claim batch**（`Db.claimScanLock` 第 7 個參數 `tickProgressJson`）：
每 tick 少一個 request，而且 admission 讀數同 claim 原子一齊落，唔會再有「贏咗 claim、stamp 未到」
嘅窗。

守衛同 historyStmt 一樣嘅 EXISTS 慣用法——`INSERT..SELECT` 嘅 `WHERE EXISTS (… key =
'scan_lock' AND value = ?)` 帶住**本 tick 自己嘅 lock value**，所以輸咗 lease（= 冇入 scan）嘅 tick
唔可能 stamp 一個佢冇行到嘅 phase；claim batch 被拒 = stamp 跟住冇，即 pre-merge 形狀。claim 三條
arm（win／row-vanished retry／stale-holder takeover）都收呢個 stamp，`winBatch` 嘅空檢查亦加咗
`progressStmt`，令「只有 stamp」嘅 claim 一樣行 batch 路徑。另外 `tickProgressNote` 對未量度嘅
preRace（admission record 係 claim 之前建嘅，pre-race split 未存在）改印 `preRace n/a`，唔會扮
成一個唔使時間嘅 phase。

本地驗收：`npm run typecheck` clean、`npm run test:unit` **354 passed / 0 failed**（前值 353；
`tick-progress-record.apply.js` 嘅 guard 由 pin `notePhase("scan")` 改為 pin「record 喺 claim
前建好並傳入 claim」，新增一條 round-3 out-of-window guard），`npx wrangler deploy --dry-run` 過。
落線後驗收：census 嘅 `setWorkerState:tick_progress` 應由 5 → 4／tick，`tick_progress` 行嘅
`at` 同 `scan_heartbeat` 嘅 `at` 差 < 10ms。

全部細節：`docs/round3-admission-stamp-2026-09-26.md`；落線紀錄：
`docs/patches/round3-admission-stamp-2026-09-26.apply.js` ＋
`docs/patches/round3-admission-stamp-tests-2026-09-26.apply.js` ＋
`docs/patches/round3-doc-pointer-2026-09-26.apply.js`。

---

## 4.22 供應流（🕸）落閘：卡片冇咗條線，檢查亦唔再跑（2026-09-26）

卡片上嘅 `🕸 供應流` 係 legacy enrichment 群嘅第三條線（Bundler / Top10 / 供應流）。
AXIOM_ENABLED = "0"（2026-09-19）之後 Axiom summary 唔再頂替嗰個群，所以條線又出現喺每張卡；
而佢背後係全張卡最貴嘅一步：每個 coin 一次 Helius 分析（`getTokenLargestAccounts` ＋
`getTokenTransfers`，~10 RPC，受 `SUPPLY_FLOW_BUDGET_MS` 限），加一個 `token_stats` 寫入，
每 `SUPPLY_FLOW_REFRESH_MIN` 對每個 coin 再跑一次。

落閘：`SUPPLY_FLOW_ENABLED = "false"`（wrangler.toml，operator 唔想再見到條線）。

- **分析半邊**：`resolveSupplyFlow` 喺 `!cfg.enabled` 即刻 return `unknown` —— 冇 RPC、冇 budget
  計算、冇 write（呢個 gate 本身已經存在，唔使改）。
- **顯示半邊**（今次新增）：卡嘅 `supplyFlowClean` 由 `boolean` 變 `boolean | null`；`null` ＝
  停用 ＝ **成條線唔出**（唔係印「—（未分析）」placeholder），scanner 停用時傳 `null`。同一
  「no data, no line」立場 GMGN / Arkham / crime 一向用開。

代價（講明）：只有 CONFIRMED flag 才會擋推，而嗰個 block 都跟住冇 —— 本來會被擋嘅 coin 而家照推，
形狀同今日「未分析」卡一樣（detector 一向 best-effort，從來唔係 gate）。手動 `/flow` 指令照用：
analyzer 用到才建，唔用零成本。

本地驗收：`npm run typecheck` clean；`npm run test:unit` **356 passed / 0 failed**（前值 354；
新增一條行為測試 —— `null` ＝ 冇線、`false`/`true` 照舊 —— 同一條 source-shape guard；並更新
`drop-card-birdeye-lines` guard 嘅簽名斷言）；`npx wrangler deploy --dry-run` 見到
`env.SUPPLY_FLOW_ENABLED ("false")`。

落線紀錄：`docs/patches/disable-supply-flow-2026-09-26.apply.js`。

---

## 4.23 有機度條線又唔見咗：card-only batch 移去 RugCheck 之前（2026-09-26）

卡片嘅 🌱 有機度（＋1h 交易者）再次失蹤，同 2026-09-17 嗰次同一個病：**資料在、窗冇**。查證：
當日 5 張推送卡嘅 mint（MuseXT 03:27、MAX 03:22、LESTER 03:07、DDOS 03:06、D/ACC 02:44）用
正常網絡問 Jupiter 個 search endpoint，全部有 `organicScore`（55–68，label medium）——上游健康。

病因：card-only display batch（GMGN／Arkham／Jupiter organic 三格）係喺 RugCheck await **之後**
才開，而佢個 wall 係 `enrichDeadline = tick start + 2200ms`（`4200 − 1500 − 500`）。RugCheck 個
`getReport` 係**每 tick 都真係打一次**（`rugcheckFetchedAt` 係 per-isolate cache，isolate 一回收
就冇），而 live 相位戳顯示 `seen` 落喺 1.8–2.1s、RugCheck await 跟住——即係 dispatch 已經係
2.0–3.0s，`bestEffort` 一見 `deadline − now ≤ 0` 就即刻回 fallback，三格未開就已經死。

修法係一個 **MOVE**：三格移去 RugCheck **之前**（但仍然喺 supply-flow gate 同 seen-check 之後，
免得為一張唔會推嘅卡開三個 call；flow 停用時嗰個 gate 係即時 return，所以實際上等於 loop 入口），
白賺 RugCheck 嗰 ~0.2–0.8s。同一個 call、同一個 deadline、同一個 await 位置（Axiom 步驟之後），
只係 overlap 改變——chain 嘅總 wall time 不變。

本地驗收：`npm run typecheck` clean、`npm run test:unit` **357 passed / 0 failed**（前值 356；新增
一條 order guard：batch 必須喺 RugCheck mark 之前、`const rugcheck = await …` 之前，同時仍然喺
flagged-gate 同 seen-check 之後）。落線後睇：有推送嘅 tick，`/debug/tick` 嘅 `organic` 計數器
應該 0 → 1，卡片出返 🌱 行。

落線紀錄：`docs/patches/organic-dispatch-before-rugcheck-2026-09-26.apply.js`。

---

## 4.24 有機度第三擊：slot 改成 late-bound，加 worker 探針（2026-09-26）

§4.23 把 card-only batch 移去 RugCheck 之前——**唔夠**。落線後第一張卡（roon, msgId 5384,
04:26Z）仍然冇 🌱 行。兩個量到嘅原因：

1. 個 batch 嘅 wall（`enrichDeadline` = tick start + 2200ms）大約就係 **chain 起步** 嘅時間
   （live `seen` 戳 1.4–2.5s，而 seen-check 自己都係一個 read），所以 slot 開喺 2.0–2.5s 對住
   2.2s 牆 = 未開已經死（`bestEffort` 一見 `deadline − now ≤ 0` 即回 fallback）。
2. Jupiter client **自己 throttle 每 500ms 一個 slot**（`JUPITER_REQUEST_INTERVAL_MS`），同 tick
   嘅 discovery 腿同 pair-fallback 共用，所以就算開得切，都可能排喺另一個 call 後面才答。

修法：🌱 slot 唔再由 chain await —— 同 batch 一齊開，wall 用 **tick deadline**（佢塞住任何人嘅
時間），喺 render 嗰刻讀「最新值」（late-bound，`organicBox`）。同一個 call、同一個計數、同一個
fallback（null → 唔出線）；佢幾時答到，唔再由 chain 嘅時間決定。

另外加 `/debug/jupiter?organic=<mint>`：用 worker 自己嘅 egress 行同一個 call，報讀數＋latency，
一個 request 分清「冇窗」同「冇資料」——唔使再等下一個 push 循環。

本地驗收：`npm run typecheck` clean、`npm run test:unit` **358 passed / 0 failed**（前值 357；新增
一條 guard，順手更新兩條 pin 住三格 await 嘅舊 guard）。

落線紀錄：`docs/patches/organic-late-bound-and-probe-2026-09-26.apply.js`。

---

## 4.25 Round 4：`trade_mode_override` 搭上 tick-front 嗰一句（2026-09-26）

**揀邊個做。** 上一輪留低兩個候選，標籤化 census 一睇就分開：

| 候選 | live 讀數 | 結論 |
| --- | --- | --- |
| `getWorkerState:trade_mode_override` | 連續三個 tick 都係 **1 call / 86–117ms**（`modeRead reads 1 reuses 0`） | 抵郁 —— 最後一個「每 tick 一次」嘅單 key read |
| `getWorkerState:scan_heartbeat` | cron tick **0 call** | 已經合併完 —— 郁唔到乜 |

`scan_heartbeat` 嘅消費者早就共用同一句（`WEDGE_READ_KEYS`，加 `lastHeartbeatRead` 嘅 2s 重用窗），
census 見到嘅單 key read 全部來自診斷／fallback 路徑（`/debug/tick` 唔傳 heartbeat、
`checkOutageAndAlert` 冇 `hbAt` 時自己讀）—— 設計如此，冇嘢好慳。真正每 tick 都付嘅淨返 mode
override 嗰行：prefetch 一定係冷快取，因為 tick 相隔 60s 而 `MODE_OVERRIDE_TTL_MS` 只有 15s。

**合併。** Tick front 喺 `ensureInitialized` 已經出咗一句 `getWorkerStates`（`WEDGE_READ_KEYS`）；
一句已經要出去嘅 statement 加多個 key **唔會多一個 subrequest**，所以：

1. `trade_mode_override` 加入 `WEDGE_READ_KEYS`（list 順手 export，令個 ride 可以喺線下斷言 ——
   同 `cronGateLoad` 一樣嘅理由）；
2. `frontModeOverrideRead()` 將嗰次讀數（值 ＋ 讀取時間）交去 tick 嘅 `onTickStart` hook，喺
   **prefetch 之前** prime 落 TradeService 快取 —— prefetch 變 no-op，於是成個 tick 對 mode 零 read。
   三態契約係重點：`{ raw: null }` 係**真讀數**（行唔存在 = 冇 override），要照 prime；**冇讀數**
   （冇 front read／batch timeout（`map === null`）／讀數舊過 `HEARTBEAT_REUSE_MS`）**唔准 prime**，
   畀 prefetch 自己照舊讀 —— 慢，但唔會無中生有一個 mode，即係 fail-safe 方向；
3. `/health` 唔再為同一行付第二次：個 key 加入佢本來就出嘅 `getWorkerStates` batch，驗證過嘅值由
   嗰次讀取提供，順手 prime 埋 service，所以 `effectiveMode` 都唔使再自己讀。

驗證規則順手收歸一個：`parseTradeModeOverride`（src/db.ts）本來就係 `Db.getTradeModeOverride` 用嘅
規則，而家 batch 讀者（/health、primed cache）用返同一條 —— 唔會出現兩把尺，亦唔使為咗搭車而
複製驗證邏輯。

**代價（講明）**：新鮮度性質不變 —— primed 值同自己讀嘅值一樣用 `MODE_OVERRIDE_TTL_MS` 過期，
而 worker 只會用「年輕過 `HEARTBEAT_REUSE_MS`」嘅 front read prime；`/setmode` 由另一個 isolate
翻嘅延遲上限仍然係 15 秒。front read 失敗／太舊 → 完全退回今日行為（prefetch 自己讀一個 round
trip）。舊嘅 ride 唔會覆蓋新嘅快取（兩個 caller 可以任何次序到）。

**觀測（落線後驗收點）**：`summary.modeRead` 多一個 `primes` 計數器 —— 食到 ride 嘅 tick 應該讀
`primes 1 / reads 0`；而 `summary.dbTickSteps` 唔應該再出現 `getWorkerState:trade_mode_override`。
（`reads` 保持「呢個 service 自己付嘅 round trip」嘅意思，所以兩個數字要一齊睇。）

本地驗收：`npm run typecheck` clean；`npm run test:unit` **359 passed / 0 failed**（前值 358；新增一條
round-4 out-of-window guard，並把 `tick-progress-record` guard 嘅 /health 斷言照三個 key 嘅新形狀
re-point）；`npx wrangler deploy --dry-run` 過。`scripts/test-tick-path.js` 補咗 ride 嘅行為測試
（primed／null 讀數／過期／junk／先後次序）。

落線紀錄：`docs/patches/round4-mode-rides-front-2026-09-26.apply.js`（本體：src/db.ts ＋
src/worker.ts；jupiter.ts 用普通 edit）、`docs/patches/round4-mode-rides-front-tests-2026-09-26.apply.js`、
`docs/patches/round4-mode-rides-front-fixes-2026-09-26.apply.js`、
`docs/patches/round4-tick-progress-guard-repoint-2026-09-26.apply.js` ＋ `docs/patches/round4-mode-giffy-fix-2026-09-26.apply.js`。

---

## 4.26 欠卡清單自動退場：推唔到嘅 obligation 唔再食 make-up 位（2026-09-26）

**問題（用戶問「呢 20 條 … 可以怎樣清理」）。** 我先答「唔影響任何 push」—— **錯**，一實測就反轉：

- `missingDeferredTokens`（src/deferredmakeup.ts）係 **oldest-first**，上限 `DEFERRED_MAKEUP_MAX = 8`／tick，
  而 live tick 讀 `feedMakeup.injectedTotal 8 / lastInjected 8` ⇒ **每一 tick 8/8 個 make-up 位**都畀最舊嗰 8 條食晒；
- 用 `/debug/token` 對 `launch_ms`：嗰 8 條係 47.6／120.2／126.2／156.4／165.1／165.3／166.6／167.0 小時大，
  而最闊 enabled chat 嘅卡窗上限係 **26 小時** ⇒ 8/8 都係**證明推唔到**；
- 後果唔止浪費 8 個 pair 地址／tick：第 9 條之後永遠拎唔到 make-up 位 —— 其中一條係實測 **7.7h 嘅真義務**
  （喺 80min–26h 卡窗內），排最尾，等同一世都冇 priority。

**規則。** obligation 喺下面兩個事實成立時**退場**（只會減少，永遠唔會多出一張卡）：

| reason | 判定 | 為何安全 |
| --- | --- | --- |
| `too-old` | 幣齡 > 最闊 enabled chat 嘅 `maxAgeMinutes` | 用嘅係**閘門自己嗰個數**（`Date.now() - pair.pairCreatedAt`）＋最闊窗口，即係每個 chat 都會照樣 reject；年齡單調遞增，過咗就永遠過咗，所以第一次觀測就退 |
| `no-pair` | 連續 `DEFERRED_PRUNE_ATTEMPTS = 3` 次觀測都冇 pair 資料 | 上游一 tick 失手（budget 切、429、last-good 重用）唔應該殺真義務；run 中間任何一次 in-window 觀測會歸零 |

- **「太新」故意唔退**：細幣會長大入窗。
- 被退嘅幣**仍然留喺 re-eval pool**（deferral 本身唔落庫），所以最壞情況係冇咗「強制 make-up 優先」，唔會冇咗張卡
  —— 同 `deliveredDeferredTokens` 嘅取捨同一個方向。
- **觀測點**：`Scanner.matchCoins`。欠單嘅幣一定經呢度（make-up lane 注入嘅、pool slice 帶嘅，兩者嘅 pair 都交去同一個 loop），
  所以 hook 只係每 profile 一次 `isDeferredToken` map 命中 ＋（命中時）一次純函數判定：**零額外 request、零額外 Turso round trip**。

**為何 durable row 要多一個 counter。** 退場會縮短 registry，而 row 嘅 `pendingTokens` 就係由 registry 寫出去 ——
即係「縮短」本身要等一個**會寫 row 嘅 tick** 才落地。所以 `pruned` 行 **cursor**（同 `deferred`／`recovered` 一樣：
scanner 累計數 − worker baseline，加 `applied` marker 防重複），而 `delta.pruned > 0` 就係令「只有退場、冇其他事」嘅 tick 都會寫 row 嘅原因。

**cursor 擺邊度（一個實作陷阱，已修）。** 一開始 `prunedTotal` 擺喺 module 級 registry，但 dead-tick rebuild 會**重設 worker baseline
同 Scanner**（因為 rebuilt scanner 嘅計數由零起）—— 而 module state 唔會重建，結果每次 rebuild 都會將「開機以來所有退場」
當成新 delta 重覆寫入。所以個計數搬去 `DeferredPushLedger`（同 `recovered` 一樣嘅歸屬）：rebuild 之後 baseline 0 對 counter 0。
registry 自己嘅 `prunedTotal` 留低做 **isolate 視角**（`/debug/deferral` 嗰個），兩者係唔同問題。

**探針 `/debug/deferral`**（read-only）。一個 request 答兩邊：

- `durable`：row 本身 —— pending list ＋ 四個 counter（deferred/recovered/stalled/pruned）＋ prune 首末時間戳；
  呢度**即時重讀** worker_state 而唔係用 tick 鏡像，所以冷 isolate 都答到實況；
- `isolate`：本 isolate 嘅 registry —— 每條欠單欠咗幾久（`owedMin`）、連續幾次 no-pair miss、上次判定用嘅窗口（`windowMaxAgeMin`），
  同最近退場嘅理由＋判定年齡（`lastPruned`，ring 12 條）。

**驗收點（落線後點睇）**：`durable.pending 20 → 跌`，同時 `durable.prunedTotal` 升，`lastPruned` 逐條講理由 ——
第一批應該係最舊嗰 8 條、reason 全部 `too-old`。一個 tick 只能觀測「被注入嘅」8 條，所以僵屍尾會**一波 8 條**咁退
（tick 1 → tick 2 → tick 3 清完），同時 make-up lane 即刻開始有真義務可用。

**代價（講明）**：`too-old` 用嘅 `pairCreatedAt` 係 DexScreener 揀嘅 pair；如果同一 mint 之後另開新池（`pairCreatedAt` 變細），
極端情況下條 obligation 會提早退 —— 影響同上（冇 priority，卡唔會冇）。`no-pair` 嘅 3 次 slack 亦係同一方向：寧願慢一拍退，唔好殺真義務。

本地驗收：`npm run typecheck` clean；`npm run test:unit` **362 passed / 0 failed**（前值 359）——
新增 registry 行為測試（too-old 即退／真義務同 too-fresh 留低／no-pair 三次 run 同 reset／探針 view）、
durable cursor 測試（累加、首末時間戳、applied marker、legacy row 讀 0/null、**legacy marker 唔可以 ACK 一個未寫嘅退場 delta**）、
同一條 out-of-window wiring guard；三條舊測試（`pushDeferralDelta` ×2、`loadPushDeferralSnapshot`）照新形狀 re-point。
`npx wrangler deploy --dry-run` 過（1562.41 KiB）。

****落線後第二個 bug（同日修）：tick 尾嘅 re-seed 會喺同一 tick 內 undo 退場。** 修好 refresh 之後，live 讀數係
`deferObserved 9 deferPruned 4`、`prunedTotal 38 → 41` —— 規則真係行緊，但 `pending` 企喺 21 唔跌。
原因係 tick 尾嘅次序：`refreshMirror()` 會由 durable row **re-seed** 落 registry（呢個 seed 係刻意放喺寫入之前 ——
佢就係「寫入失敗都唔會重覆推卡」嘅一半），所以 `matchCoins` 啱啱退咗嘅 token 即刻由未更新嘅 row 加返，
而同一 tick 嘅寫入又將佢哋 publish 出去 —— **一個退場捱唔過自己嗰個 tick**。

兩半，一個形狀：

1. **registry 會記住**：退場嘅 token 喺 `DEFERRED_RETIRE_MEMORY_MS`（15 分鐘）之內畀 seed 路徑拒收 ——
   但**唔會**擋真正嘅 `defer()`（佢只會喺卡片 send 被拒、而閘門已經放行之後發生，係更新鮮嘅「live」證據）；
   記憶過期之後 row 又可以贏返：失敗模式係「多一次觀測」，唔會係重覆卡。
2. **最後一波需要「空清單」有意義**：退到最後一條嗰 tick registry 係空，而寫入器原本「空清單唔會 wipe」嘅規矩
   （訂立嗰陣冇 caller 分得到「冇欠單」同「未讀過 row」）會令佢永遠清唔到。
   而家 readiness 係明示嘅：`deferredPushTokens()` 喺本 isolate 未 hydrate 過 row 之前答 `undefined`，
   而寫入器將任何**清單（包括空）**當權威 —— 空 = 真係冇欠單。
落線後第一個 bug（同日修）：counter 一定要喺同一 tick refresh。** 第一次 deploy 之後，規則明明行緊
（`/health`：`profiles 8` ＝ `lastRawProfiles 0` ＋ `injectedTotal 8`，`agedEval 10` 證明評估有行），
但 `durable.prunedTotal` 一直 0、探針 `windowMaxAgeMin` 一直 null。原因唔係 hook，而係 **summary 嘅 counter 幾時影快相**：
diag 係 tick 開頭建好（`deferPruned` 係嗰一刻嘅值），而 durable 寫入係 tick 尾讀 summary ⇒ 呢個 tick 退嘅 obligation
只會喺**下一個 tick** 嘅 summary 出現。對累積幾日嘅 counter（`deferRecovered` 同款滯後）無所謂，但呢個唔得：
cron tick 通常落喺**新 recycle 嘅 isolate**（一個 isolate 只行一個 tick），所以「下一個 tick」永遠唔會嚟，
row 繼續揸住成張 pending list，而下一個冷 isolate 又會由 row re-seed 返落 registry —— **退咗都等於冇退**。

修法就係 recovery path 已經用緊嘅模式（recover 嗰度即場寫 `diag.deferRecovered`／`diag.deferPending`）：
`matchCoins` 之後即刻 refresh —— `deferPruned`（今個 tick 退幾多 ⇒ 同一 tick 就寫入 row）、`deferPending`（收縮後嘅 gauge），
同一個**新觀測值 `deferObserved`**：今個 tick 有幾多條**欠單**真係畀評估睇過。呢個數字就係「hook 冇行」同「行咗但冇嘢退」
之間嘅分界（今次就係喺呢個歧義上面嘥咗一個鐘），而佢用 ledger 累計值嘅前後差計，所以 rebuilt scanner 都唔會歪。

落線紀錄：`docs/patches/deferred-prune-2026-09-26.apply.js`（src/scanner.ts ＋ src/worker.ts）、
`docs/patches/deferred-prune-tests-2026-09-26.apply.js`、`docs/patches/deferred-prune-tests-fixes-2026-09-26.apply.js`、
`docs/patches/deferred-prune-cursor-fix-2026-09-26.apply.js`（deferredmakeup.ts / deferrallog.ts 用普通 edit）。

落線紀錄（同日下午，readiness 由 scanner 搬返 registry 自己嗰個 module）：`docs/patches/deferred-prune-hydration-move-2026-09-26.apply.js`。
`deferredPushTokens()` 而家同 registry 一齊住喺 `src/deferredmakeup.ts`，而 `hydrateDeferredTokens()` 係唯一 seed 路徑 ——
因為「呢個 isolate 讀過 row 未」係 registry 自己嘅事實：擺喺 scanner 度，一個 mid-isolate rebuilt 嘅 scanner 會留低兩個答案。
副作用係好事：條 gate 而家有行為測試（未 hydrate → `undefined`；hydrate 一個空 row → `[]`；退場嘅 token 連 hydrate 都唔收），
而 wiring guard 唔使再靠 scanner 嘅 flag 字串。三條尾段測試亦改為經 `hydrateDeferredTokens()` 建 registry —— 生產本來就係嗰條路。

### §4.28 追蹤 pass 嘅 head row 唔再豁免 subrequest 閘（2026-09-26）

live 讀數（`/debug/tick` 連續幾個 tick）：`pushWatch: err:Too many subrequests by single Worker invocation … [rows subreq 0]`、
`[rows subreq 2]` —— pass 喺 `rows` stage 死，counter 嗰刻只剩 0–2（即係 invocation 真係到咗 50 嘅牆）。
成因唔係閘唔夠，而係**第一行豁免**：`subreqShort` 之前係 `rowIndex > 0 && subreqsLeft() <= TRACKER_SUBREQ_RESERVE`（常數 6），
即係 head row 就算得 0–2 剩都可以起一條「claim → 保留 → send → 兩個 write」嘅鏈，中途畀 runtime 拒 ⇒ **整個 pass 掉失**
（佢自己嘅 note、tail writes、剩返嘅 rotation 一齊冇），而張卡最後都冇出。

改法：閘套用到**每一行**（head 都唔例外），因為嗰個 floor 本來就屬於「量度」而唔係「花費」：
安靜行根本行唔到呢個閘（佢喺 `silentChecks` 分支已經 `continue`），所以頭行照樣畀評估、`last_checked` 照樣入 batch ——
舊註解講嘅「pass 唔可以連自己個 head 都拒」仍然成立，只係唔再包「花費」。alerting 行被拒係免費：row 完全冇動，
下一 tick 由 rotation 最前再衍生一次（最多延遲一個 tick），而 `subreq-cut N` / `defer-send N` 會喺 note 點名 —— 唔會再靜靜死。

落線紀錄：`docs/patches/tracker-head-subreq-gate-2026-09-26.apply.js`（src/pushwatch.ts ＋ scripts/test-unit.js）。
測試改為兩面：6 剩 → 兩條 alerting 行都拒、一條 backfill 行照量度（`rows 1/3 subreq-cut 2 defer-send 2`）；7 剩 → 頭行照樣出卡。

### §4.29 tick 嘅 CPU：DDL 指紋閘 ＋ 欄位探測合併（2026-09-26）

**先更正一個舊結論。** `docs/scan-completion-loss.md` 2026-09-23 嗰段把 dead tick 歸因 subrequest 上限。Cloudflare 自己嘅 analytics
（查法見 `.github/workflows/cf-invocations.yml`）講嘅係另一件事：12 小時 3,491 個 invocation 裏面 36 個 `exceededResources`，時段同
scan-history 嘅 dead row 一一對上（09:28–09:38 = 10 個 = HKT 17:38 嗰個「連續 10 分鐘冇完成落地」告警），而嗰啲被殺嘅 invocation
只用了 **2–37 個 subrequest**（上限 50）、**≤ 12.4 MB memory**（上限 128 MB）。唯一釘死喺上限嘅係 **CPU：cpuTime 10,000 µs
= Workers Free 嘅 10 ms**，而同一分鐘冇被殺嗰啲讀 13,000–187,000 µs —— 官方講嘅 flexibility 一收，就整分鐘整分鐘殺（每分鐘剛好
1 個，所以「掃描其實仍在運行、丟失嘅係完成寫入」呢句告警用字完全準確）。

**邊個 phase 貴。** Worker 自己嘅 telemetry 只有 wall clock，冇 CPU 維度（`feedsMs`／`poolMs`／`evalMs`／`pushPhaseMs` 分唔開
「慢」同「忙」），所以改用 `scripts/cpu-profile.js`（唯讀：真上游 payload ＋ repo 自己嘅 parser ＋ production Turso 嘅真 read）。
結論同預期相反：一個 libsql round trip 就算只回 **46 bytes 一行**都要 **2.4–5.8 ms CPU**（一次讀 6 個 key 幾乎一樣 ⇒ 係 per-call，
唔係 per-row），而個 tick 做 ~20–30 個 round trip ⇒ **60–120 ms** —— 大過所有 feed parser 加埋（13 ms）一個數量級。所以呢輪砍嘅係
**round trip 嘅次數**，唔係邊個 feed。

**兩刀（都係 cold isolate 專屬，零覆蓋損失）：**

1. **DDL 指紋閘**。`init` 嗰 18 句 `CREATE … IF NOT EXISTS` 以前每個冷 isolate 都重跑，量到 **46–189 ms CPU**：tick 最貴嘅單一項。
   而家先 read 一個細 row（`worker_state.schema_ddl_fingerprint`，~46 B），同當前 DDL 指紋一樣就唔跑個 batch。指紋由 `ddl` 陣列
   本身算（`schemaFingerprint`，FNV-1a，8 hex），所以改／加／搬一句都會自動破閘 —— 手寫版本號終有一日會被漏掉嘅失敗，喺呢度路唔通。
   讀取失敗（從未初始化嘅庫）都當唔匹配，即係正正要跑嗰陣。實測真 Turso：**92.2 ms → 9.8 ms**（同一程序內第一次 vs 第二次 init）。
2. **欄位探測合併**。`addColumnIfMissing` 以前逐個 column 撞一次 `ALTER TABLE`，靠 `duplicate column name` 當答案 —— 每個冷 isolate
   一次 round trip × ~12 個（26 個 call site：token_stats 15、chat_settings 7、push_watch 4）。而家一次 batch 讀
   `SELECT name FROM pragma_table_info(?)`（`COLUMN_PROBE_TABLES` 三張表，實測回 **54 欄**）＋ isolate 內 Set cache，之後 25 個 call 免費。
   降級方向刻意係**舊行為**：讀唔到 ⇒ 照樣逐個 ALTER（重複照吞）；表唔喺名單上 ⇒ 只係 miss cache。

`scripts/test-schema-gate.js`（6 條，已入 `npm run test:unit`）釘死：指紋對任何一句改動都變、跨句邊界搬字都變、第二次 init
**零 `ALTER TABLE`** 同 **零 DDL batch**、指紋唔啱照跑、從未初始化嘅庫照跑，以及 `COLUMN_PROBE_TABLES` 覆蓋所有 call site 嘅表。
量測嗰兩條腿留喺 `scripts/cpu-profile.js`：raw `/v2/pipeline` 嘅 **bound vs literal 對照** —— bound 參數喺 table-valued pragma 入面
係窄啲嘅形狀，靜靜回**少**欄位就會令 round trip 悄悄返嚟（而 pipeline 嘅 `Value` 係 internally tagged enum，所以嗰條腿要手寫
`{type:"text",value:…}`；兩個版本嘅錯誤計法同 3052 B 嘅真回應樣本一齊記喺 `countPipelineRows` 上面）。

**天花板照舊要講清楚**：加埋大概砍 40–50%（tick 由 36–187 ms 落到 ~20–100 ms），仍然係 10 ms 上限嘅 2–10 倍。Paid（cron CPU 10 ms
→ 30 s）係唯一完整解；呢兩刀係未升級前減低突發頻率同嚴重度。

落線紀錄：`docs/patches/round5-schema-ddl-gate-2026-09-26.apply.js`、`docs/patches/round5-column-probe-merge-2026-09-26.apply.js`。

### §4.30 邊緣 cache 嘅 hit:miss 由 isolate 記憶變成 durable row（2026-09-26）

**問題唔係 cache 壞，係讀數冇。** 想答「`LIST_FEED_CACHE_TTL_S = 60`（啱啱等於一個 tick）會唔會令 entry 喺下一 tick 問之前就過期」，
就要 hit:miss 比；而 `listCacheHits` / `lastListCacheStatus` 係 **client 嘅 module state**，isolate 每 tick 換 ⇒ 一個 tick 讀到
`listCacheHits 0、lastListCacheStatus null、http429 0、budgetDrops 0`，而同一 tick 明明 `profiles: 2`。即係修好咗都證明唔到，壞咗都睇唔到。

**三件事落咗線：**

1. **帳本搬去 module scope ＋ 加 misses。** 一個 accumulator（`hits` / `misses` / `status`），`getStats()` 由佢讀；delta 係同 baseline 嘅差。
   一條規則決定乜嘢係 hit（`/^(HIT|REVALIDATED)$/i`），而**冇 `cf-cache-status` header 而家算 miss** —— 以前呢種回應兩邊都唔計，
   即係一條永遠冇 header 嘅 lane 會喺讀數入面消失。
2. **peek / consume ＋ per-part landed ack。** 掃描器 peek → 每行寫完先 commit 自己嗰部分：寫唔到嘅下一 tick 再交（唔會漏），
   寫到嘅唔會寫第二次（唔會重複計）。剩低唯一損失寫明喺 code：**front 嗰個 batch 一寫就清空 buffer 且唔會重交**（見 `flushScanFront`），
   所以一個 front 冇落地嘅 tick 會少一段窗口 —— 而嗰個 tick 嘅 summary 一樣冇咗，比例唔會因此偏。
3. **寫入搭 tick 自己嗰個 front write（0 個新 round trip）**，而 delta 就喺 summary 拎 `dex:` 快照嘅同一點拎，所以 durable 行同頁面嗰個快照
   講同一個窗口（pushWatch 一樣嘅 one-tick carry）。伺服器端三個 row：`dex_list_cache_hits` / `_misses`（ADD）＋ `dex_list_cache_last`（replace，
   只喺 label 變咗先寫）。key 名由 `src/dexscreener.ts` export，寫嘅（scanner）同讀嘅（/health）**import 同一個常數**，唔會兩邊打錯字走樣。

**/health 嗰邊 0 個新 round trip**：三個 key 加落今朝已經做咗嘅 `Db.readHealthFront` 嗰個 batch（一句 statement 加 key 唔加 request），
數值照行 `parseTelemetryCounter` / `telemetryCounterUsable` 同一條規則，出 `dexListCache {hits, misses, hitPct, lastStatus}`。
`null`（未有任何 tick 報過）同 `0/0` 係兩個讀數：ADD 係零根本唔會寫（見 `ScanFrontWrite.add` / `frontStamp`）。
`src/db.ts` 嘅 `bumpTelemetryCounter` 由 private 變 public，做冇 front 時（standalone Scanner）嘅 ADD 路 —— 唔另開第二份 ADD SQL。

**TTL 未改，係故意的。** 而家個數係數據問題而唔係理論問題，所以個 guard（`scripts/test-deferred-priority.js`）照樣釘死 60：
佢個理由係「HIT 一定比 10 分鐘 reuse lane 新鮮」，同 hit:miss 冇衝突）照企，直到 durable 讀數顯示 `http429` 平穩而 misses 佔比明顯
—— 即係 origin 被問係因為 entry 過期。嗰陣先改 60 → 180，同時更新 guard 同 `LIST_FEED_CACHE_TTL_S` 上面嘅 OPEN QUESTION。

**測試**：`scripts/test-dex-list-cache.js`（7 條，已入 `npm run test:unit`）釘死：hit/miss 嘅定義（含冇 header 算 miss）、peek 唔會 advance、
consume 只 commit 落地嘅行、兩條 ADD 真係經**真** `Db.writeScanFront` **累加**（1 + 2 = 3：replace 會靜靜變 2 然後永久少計）、零 ADD 唔寫 row、
以及 /health 用 import 嘅常數而唔係字面值。另外 `test-deferred-priority.js` 嗰個 `listCacheHits === 1` 改成 baseline-relative —— 帳本由 client state
變 module state（就係畀掃描器逐 tick journal 嘅前提），個位數固定 1 已經唔再成立。

**落線後修正（同日，§4.31）：兩個錯都由 durable row 揭出嚟，唔係由頁面。**

落線紀錄：`docs/patches/round5-dex-listcache-client-2026-09-26.apply.js`、`docs/patches/round5-dex-listcache-wire-2026-09-26.apply.js`、
`docs/patches/round5-dex-listcache-health-2026-09-26.apply.js`。

### §4.31 邊緣 cache 帳本：第一次 deploy 個兩個錯，同向 durable row 學到嘅嘢（2026-09-26）

**頁面睇唔出錯。** deploy 完之後 `/health` 一樣 `ok`、tick 一樣 1.7–2.8s、profiles 一樣 24，而 `dexListCache` 一直係 `null`。
係改用唔經 Worker 嘅讀法（`node scripts/read-heartbeat.js --keys …`，今次加嘅 `--keys` 模式，read-only by construction）先見到真相：

```
dex_list_cache_hits:    -        ← 冇
dex_list_cache_misses:  "2"      ← 有
dex_list_cache_last:    -        ← 冇
schema_ddl_fingerprint: "e62d9a2a"   ← 對照組（已知會存在）
```

8 個 tick 只寫過一次，而且個 `2` 係一個**暖** isolate 帶住上一個 tick 嘅 outcome 寫落去 —— 呢個「罕有嘅成功」本身就係線索。

**錯 1：journal 擺喺 tick 嘅錯誤一端。** 我擺咗喺 summary 建構之前，理由係「同 `dex:` 快照同一個窗口」。但個 build 喺 **profiles 結果 await 之前**
（fetch 喺 tick 頭開始、feed 階段才 await）、亦喺 boosts fetch 之前 ⇒ **冷 isolate（＝絕大多數 tick）喺自己個 fetch 未答之前就 journal，delta 永遠空，
窗口跟 isolate 一齊死**。而家改喺本 tick 自己嘅 list fetch 之後、front 嗰個**唯一 write** 之前 ⇒ 窗口係本 tick 產生嘅，而且行係搭一個本身已經要出嘅 request。
測試加咗一條**次序 guard**（profiles await < boosts < pool < journal < flush，而且唔可以喺 diag 之前）：我驗過佢真係會咬 —— 用返舊位置，四條謂詞全部 fail。

**錯 2：拒絕被當成 miss。** `misses` 原本連非 2xx 都計，而現場 12 分鐘內就有 4 次 429（`dex_429_total` 4287）。但 `cacheTtlByStatus` 淨係 200–299 有 TTL
⇒ **429 從來唔係 edge cache 嘅候選，唔可以當成「entry 過期」嘅證據**，而且佢自己有 `http429` 計數器。而家只有 2xx 才會入帳（2xx 但冇 header 照樣算 miss，
理由見帳本註解：hit 係唯一需要 header 去證明自己嘅結果）。

**修正後嘅 live 讀數**（deploy `871df6b`，run `36252847526`）：

| 時間（Z） | 讀法 | 值 |
|---|---|---|
| 15:45:36 | durable row | `hits 4`、`misses 8`、`last HIT` |
| 15:46:0x | `/health.dexListCache` | `{hits:4, misses:8, hitPct:33.3, lastStatus:"HIT"}` |
| 15:48:10 | durable row | `hits 6`、`misses 8`、`last HIT`（遞增中） |

成本：同一個 tick 嘅 step 表照舊 `writeScanFront {calls 1, ms 45}`、`dbMs 125`、tick 1903–2545ms —— 行係搭 front 本身嗰個 request，冇新 step、冇新 round trip。

**兩件要講清楚嘅事**：

1. 舊邏輯寫落嘅 `misses 2` 留在 row 度（對一個會以千計嘅分母係噪音）：手寫 Turso DELETE 正是呢啲 read-only 儀器存在嘅理由。
2. `hitPct 33.3` 唔可以當結論：窗口只有幾分鐘、仲包含修正前嘅 2 個樣本，而且 `lastStatus` 淨係講最後一個 label。要答 `LIST_FEED_CACHE_TTL_S`（60 vs 180）
   就要等 miss 佔比喺**正常時段**（`http429` 平穩）企穩 —— 呢個就係 §4.30 講嘅數據條件，而家終於有得收。

落線紀錄：`docs/patches/round5-dex-listcache-timing-2026-09-26.apply.js`（source ＋ guard）、`scripts/read-heartbeat.js --keys`（診斷儀器）。

### §4.32 eval 階段：唯一未量過嘅 phase，量完發現係 `Intl.NumberFormat`（2026-09-26）

**點解係最後一個缺口。** §4.29 量咗 DB round trip、feeds 各自嘅 parser、pool 讀；`evalMs` 係唯一冇 CPU 讀數嘅 phase，而佢嘅 wall clock 係最長嘅
（現場：`feedsMs 613 / poolMs 183 / evalMs 891`，總共 1.9s）。`evalMs` 由 `const evalStart = Date.now()` 到 `diag.evalMs = …`，包住 pair 階段、逐個幣嘅閘、
enrichment 鏈、render 同 send —— 入面嘅 I/O 都已經喺別處定價，所以缺口係「每個幣行嘅 JS」，即 `Scanner.matchCoins`。

**量法**（`scripts/cpu-profile.js` 新嘅 `eval:` 腿，同樣係「dist/ 嘅真函數 + 真輸入」）：真 pool rows（`getReevalPool`，現場 393–477 行）、
真 pair payload（真 GET，唔齊就補 fetch，否則就係低報緊要量嘅嘢）、真 `chat_settings`，然後直接叫 `scanner.matchCoins(...)`，用 `process.cpuUsage()` 計 CPU。

**讀數（改之前，暖機後）：**

| 腿 | CPU | 換算 |
|---|---|---|
| `matchCoins` 344 coins（113 pairs） | 3.84–4.55 ms | ~11 µs／coin |
| `matchCoins` 113 **paired** coins（gate path） | **4.6–8.5 ms** | **40–73 µs／coin** |
| `matchCoins` 690 coins（doubled） | 15.63 ms | 線性 |
| `fmtUsd ×100`（暖） | 2.73 / 2.55 / 2.52 ms | **~25 µs／呼叫** |
| `new Intl.NumberFormat + format ×100` **#1（冷，付 ICU）** | **15.07 ms** | 一次性／isolate |
| `matchCoins` #1（Intl 未暖時，另一個 run） | **41.95 ms** | 冷 isolate 要付 |

**答案：係 `fmtUsd`。** `src/format.ts` 每次呼叫都 `new Intl.NumberFormat(...)`，而 `matchCoins` 每個被拒嘅幣都喺**呼叫現場**砌 reject 字串
（"流动性 $x < $y" 之類，每個字串 1–2 次 `fmtUsd`）—— 即係 `50 µs／被拒幣` 對比實測 `40–73 µs／coin`，完全對得上。而且 reject 訊息係**先砌後才知會唔會入**
（log 上限 20 條）：~94 個被拒嘅幣，大部份嘅字串砌完即掉。

**落線**：`fmtUsd` 嘅 formatter 改成按 option set cache（`cachedNumberFormat`，最多 4 個 entry：compact ＋ 三個小數位）。`Intl.NumberFormat` 嘅 `format()` 係無狀態嘅
—— 同一個 instance 可以共用 —— 而 option set 係封閉集合，所以 cache 係有界嘅。

**改之後（同一個 script、同一批資料）：**

| 腿 | 之前 | 之後 |
|---|---|---|
| `fmtUsd ×100`（暖） | 2.73 / 2.55 / 2.52 ms | **0.79 / 0.11 / 0.11 ms** |
| `matchCoins` 345 coins（111 pairs） | 3.84–4.55 ms | **0.31–0.41 ms** |
| `matchCoins` 113 paired（gate path） | 4.6–8.5 ms | **0.26–0.36 ms** |
| `matchCoins` 690 coins（doubled） | 15.63 ms | **2.10 ms** |

即係 eval 階段嘅逐幣 JS 由 ~5–15 ms 落到 ~0.3–2 ms。同一個 cache 亦順手改善**出卡**（`render.ts` 每張卡幾次 `fmtUsd`）同 pushwatch 訊息。
呢個係 §4.29 之後第一刀**唔係**砍 round trip 嘅 —— 佢砍嘅係 10 ms CPU 預算裏面嘅純計算，一 刀大約等於 1–3 個 DB round trip（每個 2.4–5.8 ms）。

**要老實講嘅三點：**

1. **冷 isolate 嗰 15 ms 冇得砍。** 第一次用 `Intl` 就要初始化 ICU/data（實測 15.07 ms），改前改後都要付 —— 之前係喺 eval 階段第一次砌 reject 字串時付。
   （改前 `matchCoins #1` 41.95 ms ≈ ICU 15 ms ＋ V8 對 matchCoins/fmtUsd 嘅 JIT/IC 暖機；改後同一條腿 1.41 ms，因為 ICU 已由前面嘅探針付咗。）
2. **Node 唔等於 workerd。** 兩邊都係 V8，所以 share 可以搬、絕對值唔可以（同一句寫喺 `scripts/cpu-profile.js` 開頭）。要當係「呢件事係最大單一項」嘅證據，唔係「production 一定係 0.3 ms」。
3. **evalMs 嘅 wall clock 依然係 I/O。** 修完之後逐幣 JS 唔再係槓桿：`evalMs ~840–1000 ms` 係 pair fetch、seen claim、enrichment 嘅等待，唔係 CPU。
   所以 eval 階段唔會再有「砍 computation」嘅一刀；要再壓就係壓 round trip 數（§4.29 嗰條線）。

**測試**：`scripts/test-usd-formatter.js`（4 條，已入 `npm run test:unit`）釘死三件事：每個分支嘅**輸出字串**一模一樣（12 個值，含 0/負/NaN/Infinity/三個小數位邊界/compact）、
分支之間**真係唔同 shape**（keys 撞咗就會靜靜用錯 options）、以及**N 次呼叫只 construction 4 次**（用真 `Intl.NumberFormat` 計數器，改前係 160 次）。我驗過呢個 guard 真係會咬：
把 cache 拆走（突變 `dist`）→ 160 次 construction → 測試會 fail。另外 `src/format.ts` 有 source guard：只可以兩處 `new Intl.NumberFormat(`（兩個 maker），第三處就係漏 cache 嘅呼叫點。

落線紀錄：`src/format.ts`（formatter cache）、`scripts/cpu-profile.js`（`eval:` 量測腿）、`scripts/test-usd-formatter.js`。

### §4.33 兩個 live 讀數嘅修法：profiles 429 嘅 43% tick ＋ 追蹤 pass 嘅 22 卡積壓（2026-09-26）

**① `profiles: 2` 唔係「feed 靜」，係被 429 拒。** 2026-09-26T21:40Z 嘅 scan ring：近 120 條有 **52 條（43%）讀 `profiles: 2`**，
而嗰 52 條嘅時間戳同 `dex429` ring **一對一**（例：429 @21:38:01 → tick @21:38:03 `profiles=2`）。2 就係 make-up lane 嘅大細
（`deferPending 2`），即係嗰啲 tick 嘅 DexScreener profiles 拉取被拒，只剩 make-up 幣。
client **本身已經有**呢個修法（失敗 fetch 用 `lastGoodProfiles`，窗 10 分鐘，見 `PROFILE_FEED_REUSE_MS`），
但嗰個 list 係 instance state，而 isolate 每個 tick 換 ⇒ 只有罕有嘅暖 tick 受惠。

**修法：將條 lane 由 isolate 記憶搬去 durable row（零新 round trip）。** 個 list 騎上 tick 本身已經出嘅 front read
（`readScanFront` 嗰句 `IN (...)` 加一個 key，見 `DEX_PROFILES_LAST_KEY`）seed 入 client；成功 fetch 之後，
騎同一個 front write（`writeScanFront`，同 `dex_list_cache_*` 同一個 batch）用 **REPLACE** 寫返。stamp 係 fetch 嘅 `at`，
所以**被 reuse 嘅 list 唔會再寫自己**（scanner 以 stamp 比對）。窗口、`settled`、make-up 語意**一律不變** ——
只係「邊個 isolate 記得個 list」變咗。

**② `rows 8/30 … subreq-cut 22 defer-send 22`：22 張卡被拒，行齡 126 分鐘。** 代碼只會喺真係有卡（`alerts.length > 0`）時行到嗰個閘，
所以 22 = 有 22 行帶卡；被拒嘅行**原封不動、留在隊頭**（設計：下 tick 重新推導），但每個 tick 都唔夠額度 ⇒ 佢哋永遠輪唔到。
行齡分佈完全對得上：**11 行 >60 分鐘、最大 126 分鐘**（16:30 嗰次檢查最大 13.7 分鐘）。兩個原因、兩個修法：

| 原因 | 修法 |
|---|---|
| scan 為 pass 留嘅 slice = **9**（entry 3 ＋ tail 6）—— 夠開門同收尾，**唔夠出卡**（一張卡 = claim＋reserve＋send＋final write = 4） | `TRACKER_PASS_SUBREQ_RESERVE` **9 → 13**（新常數 `TRACKER_ALERT_PATH_SUBREQ = 4` 做算術）。scan 嘅 optional legs／chain 早 4 個 subrequest 讓路 |
| pass 自己嘅**維護階段（heal／baseline repair）先花咗 trips**，先輪到 rotation | 新 `TRACKER_MAINTENANCE_SUBREQ_FLOOR = RESERVE(6) ＋ ALERT_PATH(4)`：額度低過佢，heal（連 proof read／補發）同 repair 直接讓路，note 出 **`heal-yield`**（唔再靜靜雞） |

**要老實講嘅：** 呢兩刀係將「永遠 0 張」變返「每 tick 1–2 張」（22 張約 10–20 分鐘清完、行齡上限由無界變 ~10–20 分鐘），
**唔係**即刻清空：一張卡要 4 個 subrequest，而 38 個可用額度要養成個 scan。下一條槓桿係 **claim＋reserve 合併**
（同一 batch 兩句、reserve 加 `last_checked = now` 守衛；4 → 3／卡，即 +33% 吞吐），要獨立一輪做＋過 duplicate-card 審查。

**驗證：** 新 `scripts/test-dex-last-profiles.js`（8 條，已入 `npm run test:unit`）＋ `scripts/test-unit.js` 新增 2 條
（薄額度時 heal 讓路、rotation 照出卡；健康額度時 heal 照跑）。守衛驗過會咬：突變 `dist` 令 `seedLastGoodProfiles` 變 no-op ⇒ 2 條 fail。

落線紀錄：`src/dexscreener.ts`（`ProfileFeedSnapshot`／`parseProfileFeedSnapshot`／seed＋snapshot API）、`src/db.ts`（`DEX_PROFILES_LAST_KEY` 入 `SCAN_FRONT_GATE_KEYS`）、
`src/scanner.ts`（front read seed ＋ front write journal）、`src/worker.ts`（slice 9 → 13）、`src/pushwatch.ts`（維護讓路）、`scripts/test-dex-last-profiles.js`（新）、`scripts/test-unit.js`。

### §4.34 個 journal 冇落地：fetch 快過 front read 就當「已經寫咗」（2026-09-26）

**live 讀數（deploy 22:44:06Z 之後）：** 四次成功 tick（scan row `profiles 28`、`dex_list_cache_last: HIT`）＋九分鐘之後，
`dex_profiles_last` 依然係 `-`（absent），而 `dex_list_cache_hits` 一直升（331 → 338）。即係 §4.33 ① 個 journal **冇落地**：
條 list 冇跨過 isolate 邊界，43% 被拒嘅 tick 照舊只剩 make-up lane。

**根因（唔係 DB，係 race）：** profiles fetch 係喺 front read **之前** dispatch（`profilesCall` 建喺 scanner.ts:2615，front read 喺 ~2734），
所以 fetch 答得快 —— edge-cache HIT、或者任何快過 Turso 嗰 ~100ms round trip 嘅 200 —— 就會喺 front read 之前已經寫入 `dex.lastGoodProfiles`。
而 seed 之後嗰句係讀 **client 自己嘅 live list**：

```ts
this.profileFeedStampedAt = this.dex.lastGoodProfilesSnapshot()?.at ?? null;
```

⇒ 嗰個 stamp 就係今個 tick 自己啲新 list，`stampProfileFeedSnapshot()` 見到 `snap.at === this.profileFeedStampedAt`，
當成「row 已經有呢條 list」而 **skip 咗個 write**。只有「fetch 慢過 front read」嘅幸運 tick 寫得入 ——
實測嗰次係 **22:56:11.553Z**（deploy 之後 12 分鐘，個 row 一有就會被 seed／reuse）。但因為 stamp 用錯來源，
下一個快 tick 唔會刷新個 row，佢只會一路變舊，10 分鐘 reuse 窗一到，被拒嘅 tick 又跌返 `profiles 2`。

**修法：** stamp 一定嚟自 **front read 讀到嗰行**（同 seed 共用同一個 parse），唔可以讀 client：

```ts
const profileFeedRow = parseProfileFeedSnapshot(
  front.gates.get(DEX_PROFILES_LAST_KEY) ?? null,
);
this.dex.seedLastGoodProfiles(profileFeedRow);
this.profileFeedStampedAt = profileFeedRow?.at ?? null;
```

咁兩邊都啱：row 唔存在 ⇒ 一定寫；row 就係今個 tick reuse 嗰條 list ⇒ 照 skip（唔會重覆寫自己）。
寫入依舊騎住 tick 本身已經出嘅 front write（一張 ~1.2KB 嘅 REPLACE），**零新 round trip**。

**驗證：** 新 test「a list fetched BEFORE the front read still journals (the live miss)」（fetch 快過 read 都要寫；
同一條 row 再被 reuse 就照 skip）＋ wiring 兩條 pin（stamp 一定係 `profileFeedRow?.at`；舊嘅
`this.dex.lastGoodProfilesSnapshot()?.at` 版本一定唔可以再出現），`npm run test:unit` **397 綠**、`npm run typecheck` 清、
`wrangler deploy --dry-run` OK。

**live 驗收（要 deploy 之後做）：** `dex_profiles_last` 應該**每個成功 tick 都刷新**（唔再靠慢 tick）；429 tick 嘅 scan row
由 `profiles 2` 變返 `profiles ≈ 26`，即係 seed 條 lane 真係跨到 isolate。

落線紀錄：`docs/patches/round6-journal-stamp-2026-09-26.apply.js`（apply script，verify-then-write）、`src/scanner.ts`
（`profileFeedStampedAt` field doc ＋ seed 段）、`scripts/test-dex-last-profiles.js`（+1 條 test ＋ 2 條 wiring pin）。

**② 嘅 live 讀數（同一時段，新 build）：** `ok:4/1 rows 4/30 … subreq-cut 25`（22:46:58Z）、`ok:5/1 … subreq-cut 25`（22:49:13Z）、
`ok:11/0 rows 11/30 … subreq-cut 19`（22:58:13Z）；deploy 前同一形狀係 `ok:9/0 rows 9/30 … subreq-cut 21`。
即係 slice 13 之後**每個 pass 出到 0–1 張卡**（之前 0 張），`heal-yield` 標籤同 `repair … fixed0` 都見到 = 新 build 真係行緊；
但 19–26 行仍然帶卡被拒（backlog 遠大於一個 pass 清得完嘅量），所以下一條槓桿（claim＋reserve 合併，4 → 3／卡）
照舊係真正嘅吞吐修法。

### §4.35 seed 個 race 收口：row 以 promise 交俾 fetch（2026-09-26）

**live 讀數（`80e230b` deploy 23:04:02Z 之後）：** row 終於識刷新 —— `at` 23:04:08.5 → 23:07:19.9 → 23:08:25.1（修法前凍死 12 分鐘），
23:12:06.8 嗰個被拒 tick 亦讀 `profiles 29`（26 reused ＋ 3 make-up，raw feed `lastRawProfiles 0 / failedTotal 1 / emptyFeedTotal 0`）。
**但仍然有漏：** 23:10:10 同 23:11:15 兩個 scan row 讀 **`profiles 3`**（純 make-up），嗰陣 row 只係兩分鐘新 —— 即係 §4.33 個 caveat 應驗：
fetch 快過 front read 就攞唔到 seed。特別係 429 之後 **client 自己嗰 90 秒 cache-only backoff**，令下一個 fetch **即時被拒**，幾乎一定輸俾 read。

**修法（round 6.2）：** 個 row 改為以 **promise** 交過去，lane 嘅決定搬入 client，喺 row 已知之後：

- **scanner**：front read 開成一條 promise（`const frontRead = this.db.readScanFront(SCAN_FRONT_GATE_KEYS)`，放喺 `enterScanMode()` 之後 —— 佢係 tick 嘅 round trip，要食 1.2s DB leash），
  `const profileFeedSeed = frontRead.then(parse…)`，然後 `this.dex.fetchLatestSolanaProfiles(profileFeedSeed)` 照舊喺 tick 開頭 dispatch；
  稍後同一個 tick 用 `await frontRead`、`await profileFeedSeed`（同一個 read、同一個 parse，seed 同 stamp 永遠一致）。
- **client**：`fetchLatestSolanaProfiles(seed?)` **只喺 `failed || feed.length === 0`（即 exactly 佢會 fallback 嘅情形）先 await 條 row** ⇒ 健康 fetch 唔會為 Turso 等，
  被拒 fetch 就得到 caller 已經讀到嗰條 list；row 壞／冇 ⇒ 等於冇 seed（best-effort，唔會 throw）。

**刻意唔改嘅嘢：** dispatch 位冇搬遲（冷 isolate 嘅 feed 窗保住，見 2026-09-21 嗰次）、front read 仍然只得一句（`subreqs`／`dbSteps` 唔變）、
`noteProfileFeed` 嘅 raw／failed／empty 讀數照舊、reuse 窗 `PROFILE_FEED_REUSE_MS`（10 分鐘）照舊。

**驗證：** 3 條新 test（refusal 快過 row 都要 serve row；健康 fetch 唔會等 seed —— 用 race 令回歸變 fail 而唔係 hang；row read 壞 = 冇 seed）
＋2 條 wiring pin（read 早過 dispatch、只得一個 `readScanFront`、stamp 同 seed 係同一條 promise）；`scripts/test-dex-last-profiles.js` 由 9 條變 **13 條**、
`npm run test:unit` 全綠、`npm run typecheck` 清、`wrangler deploy --dry-run` OK。突變驗證（只改 `dist/dexscreener.js`，驗完即刻還原）：
拆走 fallback await ⇒「…still served the ROW itself」fail；改成無條件 await ⇒「a healthy fetch never waits on the seed」fail。

**live 驗收（要 deploy 之後做）：** 429 tick（連 cache-only 嗰種即刻拒）嘅 scan row 應該讀 `profiles ≈ 28`，唔會再有 `2`／`3`。

落線紀錄：`docs/patches/round6-seed-promise-2026-09-26.apply.js`（client）、`docs/patches/round6-seed-promise-scanner-2026-09-26.apply.js`（scanner）、
`src/dexscreener.ts`（signature ＋ fallback await）、`src/scanner.ts`（promise 化嘅 front read／dispatch）、`scripts/test-dex-last-profiles.js`。

### §4.36 durable profile row 幾時會 stale？10 分鐘 reuse 窗要唔要拉長？（2026-09-26）

**Row 幾時會變舊（唯一寫入條件）：** `Scanner.stampProfileFeedSnapshot()` 只喺「fetch 唔 failed **而且** list 非空」嘅 tick 寫 row，
所以 `dex_profiles_last.at` = 最後一次「有得用」嘅 fetch。會令佢一路變舊嘅 regime 只有四種：

| # | 機制 | 實測 |
|---|---|---|
| 1 | profiles 被 429（連隨其後嘅 cache-only 90s 都令 1-2 個 tick 冇 origin 機會） | 50 條 episode 跨 2.4 小時、gap p50 138 s；**429 regime（cluster）最長 24.7 分鐘**（8 個 cluster：24.7 / 23.1 / 12.2 / 11.9 / 9.0 … 分鐘） |
| 2 | edge cache MISS 之後又被拒 —— 真正嘅 streak-maker | 帳本 404 hits / **8 misses**（2xx list 回答，≈2%）；一 MISS 撞正拒絕，90s cache-only 令跟住 1-2 個 tick 都冇 origin 可用 |
| 3 | 200 但空（masked feed）：成功但 list 空 ⇒ **唔會**刷新 row，而 tick 照 reuse | `emptyFeedTotal 0`（今日）；見 docs/profiles-feed-zeros.md |
| 4 | 機械性：tick 節奏／寫入被丟 | gap p50 61-67 s、max 120 s（10 分鐘 ≈ 5-10 個 tick）；`flushScanFront` 丟一批 = 最多一個 tick 冇刷新，下一個成功即補 |

**反直覺嘅關鍵：regime 長度 ≠ row 老幾多。** 429 regime 可以跑 24.7 分鐘，但 row 唔會跟住舊 —— **任何一個 HIT 或 200 都刷新 row**，而 edge cache 幾乎每 tick 都 HIT。
deploy（23:27:53Z）之後 17 個 tick（23:29-23:46）入面有 **5 次 429 episode**（23:30:06、23:31:09、23:33:06、23:37:18、23:41:11），
**17 個 tick 全部讀 `profiles 27-30`、low(≤4) row 0 條**；row 抽樣 age 13 秒。真正嘅「冇得用」streak 係 cache-only × MISS 綑綁出嚟嘅：
pre-fix 120-tick 樣本最長 **4 個 tick ≈ 3.9 分鐘**（25 條 run，34/103 條 low row），live 最大 row age（23:31:11 嗰個被拒 tick）= **4.9 分鐘**。

**決定：10 分鐘窗唔動。** 理由：

1. 邊際係量出嚟嘅：最長 streak ~4-5 分鐘 vs 窗 10 分鐘 ⇒ ~2-2.5×。
2. 窗 lapse 嘅代價細而且自我修正：嗰個 tick 跌返 make-up lane（2-4 條幣），pool rotation／pairs／gate 全部照跑，下一個成功 fetch 就補返。
3. 個窗同時係**診斷**：`profiles` 跌到 make-up 大細係 operator 一路睇開嘅警報（今晚 33% low-row 就係咁搵到）；`feedMakeup` 係 isolate-local、只在該 tick 嘅 summary 出現，唔可以完全代替。
4. 拉長只對「>10 分鐘冇得用」嘅 streak 有用（從未見過），同時會令同一個警報遲 2× 出現，換嚟嘅只係「多 10 分鐘重覆評估同一批 ~26 條幣」——
   而 re-eval pool 本身已經用 3 分鐘（near）／18 分鐘（far）sweep 覆蓋嗰批幣。

**Tripwire（幾時應該返嚟拉長）：** 見到**連續 ≥6 個 tick** 讀 make-up 大細（`profiles` 2-4）、而 `dex_429` 仍然熱、`dex_list_cache_misses` 有升
⇒ streak 已經唔再係 1-2 個 tick、而係跟住 regime 行；屆時要按 regime 長度（≥30 分鐘）size，並接受 `profiles` 警報延遲。
（caveat：`dex_list_cache_*` 係**兩條 list leg 合計**（profiles ＋ boosts），所以 misses 升係 whole-list-feed 訊號，唔係 profiles 專屬。）

**唯讀儀器：** `scripts/read-heartbeat.js`（`dex_profiles_last`／`dex_429_*`／`dex_list_cache_*`）、`/debug/scan-history`（tick 節奏 ＋ `profiles`）、
`/health.heartbeat.summary.feedMakeup`（raw／failed／empty，isolate-local）。

### §4.37 一張卡 4 → 3 個 subrequest：claim 同 reservation 合併成一個 batch（2026-09-27）

**動機（live 讀數，2026-09-27T00:07–00:15Z）：**

```
ok:0/0                deferred:subreq-budget      ← 整個 pass 讓路（scan front 食晒額度）
ok:21/0 rows 21/30 …  defer-send 9  subreq-cut 9
ok:21/1 rows 21/30 …  defer-send 9  subreq-cut 9
ok:13/1 rows 13/30 …  defer-send 17 budget-cut
```

同一時段 `heartbeat.subreqs.current.total` 讀 **18–36**（usable 38）、追蹤池最舊一行 16 分鐘冇 check、
而卡係出得到嘅（23:57–00:15 之間 10 張：liqwarn×4、w45×3、up200、sell、revive）——即係「出得，但每個 pass 得 0–1 張，9–17 行排隊」。
條路本身係 **4 個 subrequest**：claim CAS、reservation、Telegram send、final write。頭兩個係同一個 row，中間淨係隔一個 `await`。

**改咗啲乜：** `Db.claimAndReservePushWatch(token, expectedLastChecked, now, fromState, fromAlertAt, toState, alertAt)` ——
ONE `batch()`（`"write"`）帶兩句 CAS，次序照舊 claim → reservation：

1. `UPDATE push_watch SET last_checked = ? WHERE token = ? AND last_checked = ?`
2. `UPDATE push_watch SET last_state = ?, last_alert_at = ? WHERE token = ? AND last_state IS ? AND last_alert_at = ? AND last_checked = ?`

回傳 `{claimed, reserved}`（逐句 `rowsAffected`）。Call site（`pushwatch.ts` 嘅 alerting path）由兩次 await（`claimPushWatch` ＋ `reservePushWatchAlert`）變成一次。

**點解唔會漏、唔會重複：**

- **權威守衛冇變**：仍然係 reservation 嘅 `(last_state, last_alert_at)` CAS —— 兩個 contender 之中只有一句 UPDATE 入到，輸家唔送。
- **新增嘅係「唔可以幫自己冇 claim 到嘅 row 宣佈」**：第二句綁住同一個 batch 嘅 claim stamp（`last_checked = ?`）。
  單靠次序唔夠：如果**另一個 isolate** 喺 caller 讀完之後、batch 送出之前贏咗個 claim，row 身上係對方嘅 stamp，
  呢句就會失配 ⇒ 走返普通嘅 lost-reservation 路徑（hold announcement、寫 measurements、下一個 pass 重新推導）。
- 兩個 isolate 撞正同一毫秒都唔會**兩個都** reserve 到：`(last_state, last_alert_at)` CAS 照舊決定。
- 兩種 loss 分開：**lost claim** ＝ 對方嘅 row ⇒ 原封不動（`claimLost += 1`，span 即時 release）；
  **lost reservation** ＝ row 係我哋但過場已被人宣佈 ⇒ 照舊寫 measurements、announcement 兩欄保持舊值。
- Terminal-row hygiene 嘅不變量（`0 < last_checked - last_alert_at`）完好：兩句仍然寫同一個 `now`，final write 之後再 re-stamp 一個新 `Date.now()`。

**算術（同一條鏈，少一個 round trip）：**

- `pushwatch.TRACKER_ALERT_PATH_SUBREQ` 4 → 3（一張卡）。
- `worker.TRACKER_PASS_SUBREQ_RESERVE` 13 → 12（entry 3 ＋ tail 6 ＋ 卡 3）；`scanSubreqLeft` 嘅測試跟住更新（30 → 18、2 → -10）。
- `TRACKER_MAINTENANCE_SUBREQ_FLOOR` 自動跟（6 ＋ 3 = 9）。
- Watchdog 審計：claim＋reserve 由兩個 leash 變一個 ⇒ 7,350 → 5,850（＋pair 1,200 ＝ 7,050）；`TRACKER_PASS_OVERRUN_MS` **照留 8,600** ——
  呢個 bound 嘅唯一職責係捉「冇 bound 包住嘅 await」，而 abandoned pass 正正係 §17.5 嘅 silent-miss class；跟住條鏈收窄要配 live 讀數，唔係騎呢個 merge。

**測試（5 條新，3 個 mutation 全咬）：**

- `PushWatcher: an alerting row pays ONE round trip for claim + reservation`（同時釘死兩個舊 call 唔會返生）
- `…a lost CLAIM leaves the row untouched — no send, no write`（`claimLost` 係讀 pulse，唔係 runTick 嘅 return）
- `…a lost RESERVATION holds the announcement and lands the measurements`
- `Db.claimAndReservePushWatch: ONE batch, claim first, reservation bound to its stamp`（fake client：一個 batch、兩句、args 綁 stamp、逐句結果映射）
- `claimAndReservePushWatch: one batch, and a lost claim can never reserve`（**真 DB**；case (c) 專砌「另一 isolate 淨係 claim 咗、未 reserve」——
  拎走 `AND last_checked = ?` 就會變成 `{claimed:false, reserved:true}`）
- Mutation：拆 `last_checked = ?` ⇒ 2 條 fail（SQL pin ＋ 真 DB case c）；`if (!reserved)` 變 no-op ⇒ 1 條 fail；`if (!claimed)` 變 no-op ⇒ 1 條 fail。
- `npm run test:unit` ＝ **406 passed / 0 failed**（369＋6＋5＋9＋4＋13）；`npx tsc --noEmit` 清；`wrangler deploy --dry-run` OK。

**驗收點（live，deploy 後）：**

1. 同一形狀嘅 pass note：`defer-send`／`subreq-cut` 應該明顯細過 9–17，`ok:N/M` 嘅出卡率升（0–1 → 期望 ≥2）。
2. `trips` 每張卡少 1。
3. 追蹤池最舊未 check 行由 16 分鐘回落。
4. 冇新增重複卡（`dup-skip` 冇異常、`/debug/push-watch.issueCount` 保持 0）。

**落線紀錄：** `docs/patches/tracker-claim-reserve-merge-{db,watch,budget,comments,tests,tests2,tests3,tests4,tests5,tests6}-2026-09-27.apply.js`；
`src/db.ts`（`claimAndReservePushWatch`）、`src/pushwatch.ts`（alerting path ＋ `TRACKER_ALERT_PATH_SUBREQ 3`）、`src/worker.ts`（slice 12）、
`src/tickprobe.ts`（census 改名）、`src/scanner.ts`（watchdog 審計）、`scripts/test-unit.js`。

### §4.38 追蹤 pass 搬去自己一個 invocation：唔再同 scan 分嗰 38 個 subrequest（2026-09-27）

**動機（live 01:31–01:57Z，§4.37 落線之後）：** §4.37 令一張卡平咗一個 round trip，但卡嘅**數量**冇動 ——
連續抽樣 8 個 pass，**每一個都 `defer-send == subreq-cut`**（0／1／6／10／17…），一次 `budget-cut` 都冇。
拒絕唔係時鐘、亦唔係 Turso latency：`db 110ms` 嘅 pass 照樣拒 10 行，`db 3421ms` 嘅拒 6 行，數字只跟住 subrequest 走。

真正嘅因係「pass 開波之前 tick 已經食咗幾多」——`tickProgress {stage:"postscan"}` 同同一個 invocation 嘅 pass note 配對：

| front（postscan subreqs，usable 38） | pass 結果 |
|---|---|
| 39 | `ok:0/0 deferred:subreq-budget trips 0` ← **入口閘**，一行都冇 check |
| 23 | `rows 30/30`、`defer-send 0` |
| 18–20 | `rows 24–29/30`、`defer-send 1–10`（每行撞 `TRACKER_SUBREQ_RESERVE`） |

pass 係 tick 嘅**最後一棒**，所以永遠只執到前幾棒剩低嘅：front＋scan＋flush 用 18–39 個，pass 就得單位數。
而一張卡（claim＋reserve batch、Telegram、delivery-audit 讀同寫、final check 寫）實測 4–5 個 ⇒
一個執剩嘅 claimant 出 0–1 張，同 pass note 嘅 `alerted 0–1` 完全對得上。**要救卡，就要救 pass 嘅 window，唔係再平一張卡。**

**做法：第二個 cron trigger，pass 自己一個 invocation。**

- `wrangler.toml` `[triggers].crons` 一句變兩句：`"* * * * *"`（scan tick，照舊）＋ `"*/1 * * * *"`（pass ＝ `worker.TRACKER_CRON`）。
- `worker.scheduled` 見到 `event.cron` 命中 `TRACKER_CRON` 就入 `runTrackerInvocation`：
  `beginPreTick`（**自己一個 subrequest window**）→ bounded init（`FRONT_INIT_BOUND_MS`）→ **一個** pass
  （`TRACKER_PASS_BUDGET_MS`、`subreqRemaining`、`via:"cron-pass"`）→ return。
  佢喺 `scheduledTicks`、cron-arrival stamp、cadence gate **之前** return：嗰三樣都係數 **scan arrival**
  （注入嘅 cadence gate 同 outage check 都係比較佢哋），一個唔 scan 嘅 delivery 唔應該推佢哋。
- `isTrackerCron` 係純函數、**逐字元**比對（只 trim 外面）。Cloudflare 交低嘅 `event.cron` 就係設定嗰串字
  （見下面 platform facts），所以「裡面 spacing 唔同」≠ 我哋嘅 trigger；喺已經有兩個 trigger 嘅世界，
  一 string 唔 match 就係 scan tick，唔會有 delivery 靜靜雞掉包。
- `runTrackerInvocation` 亦要傳 `waitUntil`（`tickWaitUntil`）：CUT 卡嘅 delivery proof 係 pass tail 開嘅
  未 await promise，handler 一 return 就會被取消 —— 同 tick 嘅理由一樣。

**fallback：pass 嘅 row 就係 ownership clock。** 呢個 trigger 係新嘅，而平台對呢個 Worker 有前科
（`docs/uptime-monitor.md`：cron 靜靜雞停派）。所以第二個 trigger 係 **owner，唔係 requirement**：

- `SCAN_FRONT_GATE_KEYS` 加多一條 `push_watch_pass`（**免費**：同一句 SELECT，IN-list 多一個 key，唔多一個 request）。
  `Scanner` 記住佢（`peerPassRow`，front 清空都留到 —— 佢係 pass 唯一要問嘅嘢）。
- tick 叫 pass 時傳 `{ peerPassFreshMs: TRACKER_PASS_FALLBACK_FRESH_MS (120s), via: "tick" }`。
  row 年輕過 120s ⇒ **企埋一邊**，唔寫任何 durable row，只出 `yield:peer-pass Ns`（pulse stage `peer-pass`）。
  唔寫係重點：個 row 就係 ownership clock，yield 若果重寫，fallback 就會永遠瞓著（死 trigger 永遠冇人發現）。
- `passRowAgeMs` 有三種「答唔到」：冇 row／`phase:"skip"`（冇跑過 pass 嘅 tick 唔可以代表 ownership）／
  未來 stamp（讀 0，唔可以負；clock skew 唔應該開第二個 pass）。三種都係「你跑啦」。
- `skip:*` row 亦開始寫 `via:"tick"`；`via` 只喺 caller 講嗰陣寫，其他 caller（包括所有測試）嘅 row 一個 byte 都唔變。

**120s 嘅算術：** pass delivery 每 ~60s 寫一次 row，而 tick 讀嗰個係自己 front 嘅 copy（tick 開波 3–5s 讀，
所以最多舊一分鐘）。120s ＝「嗰一分鐘 ＋ 一個 cron 週期」，所以連一個遲到嘅 tick 都會讓；
而 trigger 真死嘅話，fallback 大約每 3 分鐘跑一次 —— 就係之前 live 見到嘅 `rows 24–30/30` 形狀嘅節奏。
最壞情況係 pass 嘅 cadence，永遠唔會係「冇人宣佈嘅卡」。

**platform facts（2026-09-27 查 Cloudflare 官方 docs 核實）：** cron trigger 數目上限係 per-account（Free 5 個），兩句冇問題；
`event.cron` 係設定嘅字串本身 ⇒ 逐字元比對係啱嘅；Cron Trigger 喺 Free plan 嘅 CPU 上限係 **10ms**
（同 scan tick 一樣）—— 呢次拆分**唔會**少咗 CPU：兩個 invocation 各自 10ms，而 pass 係 I/O-bound（等 round trip），
唔係 CPU-bound；Cron Trigger 嘅 duration 上限係 15 分鐘，遠大於 pass 嘅 5s 預算。

**測試（3 條新，加 3 條 pin 跟住走）：**

- `passRowAgeMs: a row that cannot answer never holds the ownership window`（absent／junk／`at:0`／`phase:"skip"`／未來 stamp）。
- `TRACKER_CRON: the pass's own delivery is routed, and wrangler.toml matches it character for character`
  —— 直接讀 `wrangler.toml`：兩句都要在，第一句（scan）唔可以係 pass 嘅 delivery。
- `Scanner.runTrackerPass: a fresh peer pass in the front makes the tick stand down, and writes nothing`
  —— 新鮮 ⇒ `yield:peer-pass`、**零 durable write**；舊 row ⇒ 真係跑，row 帶 `via:"tick"`；
  冇 options（＝pass 自己嘅 delivery）⇒ 照跑，row 帶 `via:"cron-pass"`。
- 跟住走嘅 pin：`worker (stamp BEFORE init)` 嘅 init anchor 收窄到 **scheduled handler**（`runTrackerInvocation` 有同一段
  prologue，而佢喺檔案更前）；`{via:"cron-pass"}` 個 pin 之前多打咗個 comma，永遠 match 唔到，順手修返；
  `persistPassNote(errNote, …, "done", options?.via)` 跟住新 call。

**本地驗證：** `npx tsc --noEmit` 清；`node scripts/test-unit.js` ＝ **372 passed / 0 failed**；
其餘 6 個 suite（6＋5＋9＋4＋13＋…）全綠；`npx wrangler deploy --dry-run` OK（兩個 triggers 都收貨）。

**驗收點（live，deploy 之後）：**

1. pass note 由 `ok:0/0 deferred:subreq-budget` ／ `defer-send == subreq-cut` 變成 `ok:≥N/…` 而且 **`alerted ≥2`**；`subreq-cut` 應該貼近 0。
2. row 帶 `via:"cron-pass"`（pass 自己嘅 delivery）；tick 嗰邊只出 `yield:peer-pass Ns`。
3. 追蹤池最舊未 check 行由 16 分鐘回落（30 行／分鐘嘅節奏＝一輪 ~1 分鐘）。
4. `/debug/push-watch.issueCount` 保持 0；`dup-skip` 冇異常（權威守衛冇動）。
5. 萬一第二條 trigger 冇派：`via:"tick"` 嘅 pass 每 ~3 分鐘出現 ⇒ fallback 有效，唔係靜靜死。

**`TRACKER_PASS_SUBREQ_RESERVE` 照留 12 —— 但佢嘅角色變咗。** 呢個常數係 scan 嘅窗口（`scanSubreqLeft`），
以前係「留返畀 tick 尾嗰個 pass」。而家 pass 正常喺自己嘅 invocation ⇒ 呢 12 個係留畀**fallback**
（第二條 trigger 冇派嘅時候）。唔收細佢係刻意嘅：真死 trigger 嘅話，fallback 就係主路徑，
而 12 ＝ entry 3 ＋ tail 6 ＋ 一張卡 3 —— 就係「跑得完、出得一張卡」嘅最低消費（§4.37 之前嗰個
「執剩單位數 ⇒ 0–1 張」形狀，正正係 12 以下）。健康形狀嘅代價係 scan 每 tick 讓 12 個（~3 個 pair batch、
~90 隻幣）；如果 live 見到 scan 嘅 `subreqSkip` 上升、覆蓋跌，下一個槓桿就係**令呢個 reserve 條件化**
（front 已經帶住 pass row，所以判斷唔使額外 round trip）。
**落線紀錄：** `docs/patches/tracker-own-invocation-2026-09-27.apply.js`（20 個 edit）、
`docs/patches/tracker-own-invocation-comment-fix-2026-09-27.apply.js`（block comment 食咗個 `*/`，見下）、
`docs/patches/tracker-own-invocation-pins-2026-09-27.apply.js`（3 條 source pin 跟住走）；
`wrangler.toml`（第二句 cron）、`src/worker.ts`（`TRACKER_CRON`／`isTrackerCron`／`TRACKER_PASS_FALLBACK_FRESH_MS`／
`runTrackerInvocation`／routing／tick 嘅 fallback 參數）、`src/scanner.ts`（`TrackerPassRunOptions`／`peerPassRow`／yield／`via`）、
`src/pushwatch.ts`（`passRowAgeMs`／`notePeerPassYield`）、`src/db.ts`（front 帶 row）、`scripts/test-unit.js`。

**一個誠實嘅註腳：** 第一個 apply script 嘅註釋裡寫咗 `*/1  *  *  *  *` 做例子，而 `*/` 喺 `/** … */` 裡面就係**收口** ——
worker.ts 由嗰行開始 parse 爛（tsc TS1109 之後一大串）。第二個 apply script 幫佢改成文字描述。教訓：
block comment 裡面寫 cron 表達式，永遠唔好寫成星號加斜線。

### §4.39 pass 走咗之後：slice 條件化、window 認主人、cold-init 少一個 read（2026-09-27）

**三件事，一個主題：** §4.38 之後 pass 已經由自己嘅 cron delivery 擁有（durable row 全部 `via:"cron-pass"`，
14 分鐘零 `via:"tick"`），所以 tick 身上兩樣嘢變成過時：(1) 佢仍然幫 pass 留 12 個 subrequest；(2) 個 counter
仍然係「兩個 owner 一齊數」而講唔出邊個花咗。第三件係順手執到嘅 cold-init 重複 read。

**1. `TRACKER_PASS_SUBREQ_RESERVE` 由常數變成問題。** `scanSubreqLeft` 以前無條件減 12，
而 scan 嘅 low-water gate 係 `subreqsLeft() > SCAN_SUBREQ_FLOOR (12)` —— 即係 `spent >= usable - 24 ≈ 14`
就要 drop optional legs。但當 pass 交咗俾 delivery，呢 12 個係為一個**唔會跑**嘅 pass 而留。現在：

- `scanSubreqLeft(remaining, reserve = 12)`：算術一樣，slice 變成參數（default 保住所有舊 caller 同舊讀數）。
- `Scanner.trackerPassSlice(windowMs, slice, atMs)`：row 新鮮 ⇒ **0**，否則 slice。
- 兩個決定共用**同一個讀數**：`Scanner.peerPassAgeMs(at, windowMs)`（row age，唔答就 null）。
  Pass 自己喺 `startedAt` 問，而 **scan 喺 `startedAt + SCAN_TICK_BUDGET_MS` 問** —— 即係呢個 invocation
  最遲幾時可以開 pass。喺最尾問嘅意思係：如果嗰刻 row 都仲新鮮，pass stage 到嗰陣必然都係讓路。
  兩邊唔會為咗一條「喺中間跨過 window」嘅 row 而講唔同嘅話（嗰種情況會變成 release 咗 slice 但 pass 照跑，
  然後 entry-gate `deferred:subreq-budget`）。
- 冇 front row（standalone scanner、front read 失敗）⇒ **fail safe**：slice 照留（＝未 split 之前嘅行為）。

**2. Window 認主人：`SubreqOwner`。** 呢個 counter 係 per module，而一個 isolate 每分鐘服務**兩個** invocation
（scan tick 同 pass delivery）—— 所以一個唔講主人嘅 window 係讀唔出答案嘅：tick 嘅 front 同 pass 嘅轉盤
同樣顯示成一句 `turso: N`。而家 `beginSubreqWindow(at, owner)` 帶 tag，`beginPreTick(entryAt, owner)` 傳落去，
`subreqView()` 每個 window（current ＋ recent）都出 `owner`：`"scan"`（scheduled 但唔係 pass 嘅 delivery）、
`"pass"`（pass 自己嘅 cron）、`"http"`（HTTP fallback 條路），唔講就 `"unknown"`（唔估）。
「tick front 花咗幾多」由此變成有答案嘅問題。

**3. Cold-init 嘅 boot read 併上 front 嗰一句。** `ensureInitialized` 嘅 front statement（`WEDGE_READ_KEYS`）
係每個 isolate 嘅**第一個** read，而 init boot 區塊 ~300ms 之後喺**同一個** invocation 再讀四條 key
（`axiom_access_token` ＋ 三個 mirror）—— 一個免費讀得到嘅第二個 round trip。現在：

- 新 `BOOT_STATE_KEYS` 被 `WEDGE_READ_KEYS` spread 入去（一條 list，兩處唔會 drift）。
- front read 落地即記落 `lastBootKeysRead`（`map: null` ＝ **冇讀數**，唔可以當「冇 row」，因為其中一條 key
  決定 Axiom client 起唔起）。
- boot 區塊喺 `HEARTBEAT_REUSE_MS`（2s，同 invocation）之內就用嗰個 map ⇒ **零 subrequest**；
  逾時／null 就照舊讀自己嘅（merge 嘅失敗形狀 ＝ 舊形狀，唔會少 row）。
- 量度背景：live census 讀到 `getWorkerStates 5 calls / 616ms`，係 front 最大嘅單一項，而冷 isolate 上面
  boot read 就係其中一個。

**測試（3 條新／改）：**

- `subreq reserve: …`：加咗 `scanSubreqLeft(30, 0) === 30`、`(2, 0) === 2`、`(30, 4) === 26`，
  同一個 whitespace-flattened pin 釘死**成個 call 形狀**（`scanOwner.runOnce(() => scanSubreqLeft(subreqRemaining(),
  scanOwner.trackerPassSlice(TRACKER_PASS_FALLBACK_FRESH_MS, TRACKER_PASS_SUBREQ_RESERVE, startedAt + SCAN_TICK_BUDGET_MS)))`）
  —— slice 唔再係常數，係要**問**。
- `Scanner.trackerPassSlice: the slice is released only when the pass WILL stand down`：
  冇 row ⇒ 12；40 秒前嘅 row ⇒ 0；**同一個 row 但問喺 tick 尾（＋200s）⇒ 12**（一致性嘅釘）；
  `phase:"skip"` ⇒ 12（冇跑過 pass 嘅 tick 唔係 owner）；`windowMs 0` ⇒ 12。
- `subreqs: a window names which invocation opened it`：scan → pass 先後開窗，current／recent 各自帶主人；
  唔講 ⇒ `unknown`。
- 跟住走嘅 pin：boot read 由「一個 `getWorkerStates`」改成「`BOOT_STATE_KEYS` 騎上 `WEDGE_READ_KEYS`
  ＋ boot 區塊優先讀 `lastBootKeysRead`，自己讀只做 fallback」。

**本地驗證：** `npx tsc --noEmit` 清（途中撞到 TS18047 —— slice probe 喺 closure 裡面摸唔到 module-level
`scanner` 嘅 narrowing，改用 call site 嘅 `scanOwner` local，同一個 capture 兩個用途）；
`node scripts/test-unit.js` ＝ **374 passed / 0 failed**；其餘 6 個 suite（6＋5＋9＋4＋13＋…）全綠；
`npx wrangler deploy --dry-run` OK。

**驗收點（live，deploy 之後）：**

1. `/health.subreqs` 嘅 window 開始帶 `owner`：tick 自己嘅窗讀 `"scan"`、pass delivery 讀 `"pass"`、
   HTTP fallback 讀 `"http"` ⇒ 由此可以逐個 owner 算 spend（呢個係本輪之後所有 front 讀數嘅前提）。
2. 健康形狀下 tick 嘅 optional legs 唔應該再咁早 drop：`summary.subreqSkip` 唔會再點名 boosts／meteora 之類，
   直到 `spent` 接近 26（之前 ~14）。覆蓋率（`profiles`／`pool`／`candidates`）應該跟住升。
3. Pass 照樣 `via:"cron-pass"`、`rows 30/30`、`defer-send 0`；tick 嗰邊繼續零 `via:"tick"`。
4. 冷 isolate 嘅 front 少一個 `getWorkerStates`（`subreqs.current.total` 同 hosts 嘅 `turso` 各少 1 至 2），
   而 boot 嘅 mirror（`deferral`／`pushLedger`／`skipCapture`）照樣有值 —— 佢哋係嗰個 merge 最容易讀錯嘅地方。


### §4.40 掃描係邊個跑：fallback 60s 太早、gate margin 太窄、`via` 要落地（2026-09-27）

**起點係一個我自己報錯咗嘅歸因。** §4.39 用 window owner 讀到 `[http] 21`（一個 HTTP fallback 真正掃描），
當時寫住「dedupe 用 `scan_heartbeat.at`（scan 開始時間）」。做完 cron ring 對照之後要更正兩樣：

- `scan_heartbeat.at` 係**完成時間** —— completion flush 用 `flushedAt` 覆寫咗 claim batch 嘅 start stamp
  （live 見到 claim `05:14:06` → done `05:14:09`）。
- 真正嘅驅動係**派送遲**：兩個 gate 用唔同 margin 打對台 ——

```
tick 完成遲 (:2x) → 下一個 tick 讀 age ~35-45s < gate 50s → skip（照樣付 init／gate／outage 嘅 front）
→ 之後任何一個過咗自己 60s trigger gate 嘅 HTTP 請求見到 age ≥ 60s → fallback 真掃描（http window）
→ 佢一完成，又令下一個 tick skip → 循環
```

**量度（05:13-05:30Z，唯讀）。** `scheduled_tick_ring`（handler entry，每分鐘一個，`cronAt = Date.now()`）
對照 `scan_history`：ring 嘅 90 分鐘窗口內 76 個 completion，**26 個（34%）對唔上任何 cron arrival** ——
12 個喺 arrival 之前完成（一定係 fallback），14 個喺 arrival 之後 12-21 秒（一個 tick 嘅 front 唔可能咁長；
05:27:27 嗰個 completion 嘅 `subreqs.current.owner` 讀 `"http"`、total 21，最接近嘅 arrival 離 race start 19 秒）。
全期 300 個 completion／347 分鐘（0.86/min）入面 45 個 gap 係 90-120s 嘅洞，而每個 :2x 完成後面就跟一個。
ring 亦顯示 90 個 arrival 有 18 個 ≥ :10（最遲 :29）——即係舊嘅 10s margin 根本唔夠。

**三樣改動：**

1. **Fallback 變真救援。** `scanRescueGapMs(scanGapMs) = max(120s, 2 × interval)`：要**兩個 cadence** 冇完成，
   一個 HTTP 請求才准自己掃。遲到 <1 cadence 嘅 tick 仍然係佢自己掃，fallback 只喺嗰樣都失敗之後接手；
   舊嘅 60s 門檻正正落喺「late tick 仍然擁有」嘅窗入面。
2. **Tick gate 用 jitter budget。** `scanGateMs(interval)`：
   - interval ＝一個 cron period（60s）⇒ gate ＝ **30s**（ring 量到最遲 :29）。一個遲完成嘅掃描唔再令
     下一個 tick 白白輸一分鐘 —— 佢會 catch up（同一個 scan lock 之下，唔會疊住跑）。
   - interval > 一個 cron period ⇒ margin 縮到「一個 period 以上剩幾多 room」：90s ⇒ gate **70s**，仍然
     skip 隔個 tick（唔會靜靜哋變成 60s）。overlap 由 scan lock 負責，唔係 gate。
3. **`via` 落地（`cron`｜`http`｜`manual`）。** 由 handler **參數**傳入 —— 唔可以係 module state：pass 嘅
   delivery 同一個 isolate 會覆寫 module 讀數（今次已經見到 tick 嘅 flush 出 `owner:"pass"`）。寫入**兩個**
   heartbeat（scanning ＋ done）同 completion payload；completion batch 內加一條 read-free counter statement
   （`scan_trigger_cron`／`_http`／`_manual`：`INSERT OR IGNORE` ＋ `CAST(CAST(value AS INTEGER) + 1 AS TEXT)`），
   **零額外 round trip**。front statement（`WEDGE_READ_KEYS`）帶埋三條 key ⇒ `/health.heartbeat.scanTriggers`
   ＝ `{cron, http, manual}`（滯後一次完成，同 `deferral` 一樣嘅「上次確認寫入」語意）。
4. **一個 skip 咗嘅 tick 照樣付 front —— 呢句係觀察，同 §4.39「削 front」係同一條數。**
   front 係 `WEDGE_READ_KEYS` 嗰**一句** read（14 條 key、1 個 subrequest、live 110-266ms），
   而佢同時係 gate 嘅輸入（`scan_heartbeat`）同死 tick 嘅唯一證人（`tick_progress`）—— 冇得
   「先決定唔掃、再讀」。所以 1 個 subrequest 就係「決定今分鐘掃唔掃」嘅價錢。以前呢筆錢好多係白付：
   ~1/3 嘅 tick 讀完 front 就 skip，而每次 skip 又會引一個 HTTP fallback 真掃描（各自再付一次 front，
   再加 ~21 個 subrequest）。兩個改動一齊令呢個比率塌落 —— gate 30s ⇒ tick 幾乎每次真掃
   （skip 由常態變例外），rescue 120s ⇒ ping 唔再接手。**直接讀數**：
   `scanTriggers.cron ÷ scheduled_tick_total` ＝ cron arrival 之中真正掃到嘅比例（1 − skip 率）。

**測試（4 條新 ＋ 2 條改）：** `scanGateMs(60_000) === 30_000`、`scanGateMs(90_000) === 70_000`（且 > 60s）、
`scanGateMs(300_000) === 270_000`、`scanGateMs(1_000) === scanGateMs(60_000)`；`scanRescueGapMs(60_000) === 120_000`、
`(90_000) === 180_000`、`(300_000) === 600_000`；三個 call site 嘅 `via`（whitespace-flattened source pin）＋
`via:scanVia,` 出現 2 次；`scanTriggerStatements`（2 條 statement、逐個 trigger 一條 row、零 bind）＋
`parseScanTriggerCounts`（null／junk／負數 ⇒ 0）；真 DB：完成掃描計數、heartbeat-only flush 唔計、
冇 tag 唔計、`scanTriggers` 三條 key 讀返嚟啱、heartbeat 記住 `via`。舊 pin 改成 `now-at<rescueGapMs`。

**Mutation（改編譯後 dist 再還原）：** counter `+ 1` → `+ 0` ⇒ 2 條 fail；`scanGateMs` 嘅 60s 分支改返
`interval - 10s` ⇒ 1 條 fail；`scanRescueGapMs` 由 `× 2` 改 `× 1` ⇒ 1 條 fail。

**本地驗證：** `npx tsc --noEmit` 清（途中撞到 `*/` 喺 JSDoc 裡面提早收 comment —— `TRACKER_CRON` 嘅
expression 唔可以照抄入註釋）；`node scripts/test-unit.js` ＝ **379 passed / 0 failed**；其餘 6 個 suite 全綠；
`npx wrangler deploy --dry-run` OK。

**驗收點（live，deploy 之後）：**

1. `/health.heartbeat.scanTriggers` 開始有數：`cron` 隨每分鐘升，`http` 唔應該再每三分鐘追一次。
2. `scan_history` 對 cron ring：對唔上 arrival 嘅 completion 應該由 26/76 跌到接近 0；90-120s 洞（45/299）
   應該同步跌，因為前一分鐘遲完成唔再令下一個 tick 輸一分鐘。
3. `/health.heartbeat.via` 喺 done 行應該讀 `"cron"`。
4. `scanTriggers.cron ÷ scheduled_tick_total` 應該貼近 1（skip 幾乎冇），而 `scanTriggers.http`
   應該平（rescue 只喺真死 cron 嘅時候動）—— 呢兩個數一齊就係「front 有冇白付」嘅答案。
5. 出卡／defer 讀數不變：`push_watch_pass` 照樣 `via:"cron-pass"`、`defer-send 0`、`issueCount 0`。

**落線紀錄：** `docs/patches/scan-trigger-via-2026-09-27.apply.js`（22 個 edit：db ＋ worker）、
`docs/patches/scan-trigger-via-tests-2026-09-27.apply.js`（＋ `-test-fixes`、`-title-fix`）；
`src/db.ts`（`ScanTrigger`／`scanTriggerStatements`／`parseScanTriggerCounts`／`persistScanCompletion(via)`）、
`src/worker.ts`（`scanGateMs`／`scanRescueGapMs`／`runScan(via)`／`scanTriggerMirror`）、`scripts/test-unit.js`。

**落線紀錄（§4.39）：** `docs/patches/tick-front-2026-09-27.apply.js`（19 個 edit）、
`docs/patches/tick-front-scanowner-2026-09-27.apply.js` ＋ `-fix`（capture 位置）、
`docs/patches/tick-front-tests-2026-09-27.apply.js`；`src/subreqs.ts`（`SubreqOwner` ＋ window owner）、
`src/worker.ts`（`scanSubreqLeft(reserve)`／`BOOT_STATE_KEYS`／`lastBootKeysRead`／`beginPreTick(owner)`／
tick 嘅 probe）、`src/scanner.ts`（`peerPassAgeMs`／`trackerPassSlice`）、`scripts/test-unit.js`。

---

## 4.41 Deferred 寫入嘅自我餵養：queue 按 token coalesce ＋ 讀者退休 stale row（2026-09-27）

### 量度（live，2026-09-27 09:49–10:00Z，60s 模式，一切健康）

| 時間 | `pending` | `heldForTracker` | 本次 calls | `totals.calls` | failures |
|---|---|---|---|---|---|
| 09:49:35 | 12 | 12 | 0 | 2 | **0** |
| 09:51:35 | 17 | 17 | 0 | 3 | **0** |
| 09:57:35 | 27 | 27 | 1 | 5 | **0** |
| 10:00:34 | **31** | **31** | 1 | 7 | **0** |

- 增長 **≈ +1.7 條／分鐘**，drain **≈ 0.36 條／分鐘** ⇒ 快 5 倍，而 **`failures 0`**、
  冇 durable 錯、冇 entry 被 drop。即係唔關 DB 事：佢只係**永遠冇 room**（每個 entry 都係
  `heldForTracker`，見 §4.9 嘅 `DRAIN_TRACKER_RESERVE = 14`）。
- 同 §4.9 嗰次係同一條數嘅兩面：當時 drain **食晒** budget（20 條 backlog = 20 個 round trip
  擋喺 pass 前面，撞 3000ms 牆）；加咗上限之後，佢變成**一啲都食唔到**。

### 點解會自己餵自己

兩條 deferred 寫入都由**DB 存住嘅值**決定要唔要寫：

| 寫入 | 判斷 | 未落地時嘅後果 |
|---|---|---|
| `recordTokenStatsMany` | `getTokenStatsMany` 讀唔到嗰啲當**新幣** | 下一 tick 又當新 ⇒ 再 enqueue |
| `updateTokenMaxMcaps` | raise 係同**存住嘅 max** 比 | 下一 tick 又係 raise ⇒ 再 enqueue |

⇒ queue 嘅內容係**同一批 token 嘅重複 entry**，長度無上限（`while (queue.length > 0)`，
只有「連續 3 次失敗」才會 drop；starvation 唔算失敗）。

### 修法一：queue 按 token coalesce（`DeferredBucket`）

| | 之前 | 之後 |
|---|---|---|
| 一個 queue 單位 | 一次 call（逐字排隊） | 一個 **bucket** = 一個 Db method × 一個 handle |
| 合併規則 | 冇 | 註冊 **first-wins**（`first_seen_at` 係池嘅年齡訊號，唔可以俾後嚟嘅 sight 推前）；raises **max-wins**（statement 本身 raise-only，`max(stored, a, b) ≡ max(stored, max(a, b))`，0 都算 finite —— 屍體嘅 $0 LP 就係訊號） |
| 落地次序 | 全體 call order | `rank`：註冊（0）**一定**先過 raises（1）——否則 raise 嘅 UPDATE 撲空，high-water 靜靜哋消失 |
| 一次 drain 嘅成本 | backlog 幾長就幾個 round trip | **每個 method 一個**（`DEFERRED_COALESCE_MAX_PER_CALL = 40` 個 record 一條 statement；裝唔落嘅留低） |
| 讀數 | `pending`（= 條數） | `pending` = **owed calls（0–2）**、`owedTokens` = **backlog（records）**、`deferredWriteCount()` = records |

即係：**backlog 由「幾多個 tick 想要」變成「幾多個 distinct token 未寫」**（有界），
一有 room 就一個 call 追返晒，而重複 entry 呢個增長源頭消失。

### 修法二：stale record 由讀者退休（`/health`）

Durable row 只有**寫嗰個 isolate** 會清（`clearPersistedDrainError`）⇒ 寫嗰個 isolate 喺
自己復原之前被 recycle，條 row 就永遠企喺度：live 讀到 **2026-09-25 04:09:59Z** 嗰條
（2.2 日前、`pending 30`），而後面每一個 drain 都落咗地。`/health` 係唯一由**任何** isolate
都睇得到嗰條 row 嘅地方，而且每分鐘被 poll：所以由佢退休自己判為歷史嘅 row ——

- 條件同 `writeDrainErrorStale` 用**同一個 predicate**（`drainErrorIsStale`），兩者永遠唔會
  對「邊條 row 係歷史」有第二個答案；
- 成本 = **一次事故一次寫**（冇 row 就咩都唔做；**live** 嘅 row 照樣留返俾寫嗰個 isolate 清）；
- 寫入係 `ctx.waitUntil`（唔係浮動 promise —— handler 一 return 就會被取消，同 §4.9 嗰個
  100% 失敗嘅形狀一樣）。

### 測試同 mutation

- `test-unit`：新測試「the deferred queue coalesces per token」（first-wins、max-wins 兩個
  column、cap 分兩次落地、rank 次序）＋「a drain record is retired once it is history」
  （predicate 邊界 ＋ whitespace-squashed wiring pin）；舊嘅 reserve 測試改成
  calls／records 兩個讀數。
- Mutation：`absorbFirstWins` 改 second-wins ⇒ coalescing 測試 fail；`max` 改 min ⇒ 同一條
  fail（raise column）；`rank` 兩個都 0 ⇒ 次序 pin fail；`drainErrorIsStale` 改 `>=` ⇒
  邊界 fail；退休嗰句拎走 ⇒ wiring pin fail。

### 驗收（deploy 之後）

1. `/health.heartbeat.summary.writeDrain`：`owedTokens` 應該係「distinct token 數」而唔係
   單調上升；一有 room（例如 skip 咗 scan 嗰個 tick）就見到 `calls 1–2`、`owedTokens → 0`。
2. `pending` 由兩位數字變成 **0–2**（coalesce 之後佢只數 calls）。
3. 下次有失敗：durable row 多咗 `owedTokens`（backlog 嗰個數），而條 row 一過 10 分鐘就會
   由**任何** isolate 嘅 `/health` 清走（唔會再見到 2 日前嘅 row）。

### 落線後即刻抓到嘅兩個缺陷（11:11Z deploy 後幾分鐘，同日修好）

1. **drain 冇 receiver**。Refactor 之後 `runBucket` 係用 `bucket.call(payload)` 直接叫個
   method，冇 `this`；真實 Db method 內部用 `this.get`，所以每一次落地都係
   `TypeError: this.get is not a function`、**0ms** 失敗（live 11:16–11:26Z：`totals.failures`
   1→3），3 次之後成個 bucket 被 drop —— 11:26Z 一 drop 就冇咗 **313 條註冊**。
   舊 code 用 `run: () => call.apply(target, args)` 包住 receiver，refactor 漏咗；
   離線 fake 全部冇 `this`，所以測試睇唔到。修法：wrap 時 `.bind(target)`，
   兩個 suite 嘅 fake 改成 `this`-based（unit 加 `this.calls`、seam 加
   `assert.equal(this, seamDb)`），mutation：拎走 `.bind` ⇒ coalescing 測試 fail。
2. **attempts 唔識 reset**。Bucket 嘅失敗計數係終身累計，但 drop 規則嘅原意係「**連續** 3 次」
   （舊 code 每個 entry 各自數）。即係一個失敗兩次後好返嘅 bucket，會俾之後**一次**新失敗
   即時 drop 晒（313 條咁嘅規模）。修法：落地成功就 `bucket.attempts = 0`，並加咗測試
   （fail ×2 → land → fail ×1 ⇒ 仍然 owed）。

驗收更新：deploy 之後 `totals.failures` 唔應該再升、`owedTokens` 應該開始跌（每次落地
最多 40 條／method）。

## 4.42 Cron tick 卡死嘅真身：cached init promise 冇 exit（2026-09-27）

### 量度（live，2026-09-27 22:12–22:30Z，60s 模式）

| 訊號 | 讀數 |
|---|---|
| cron 到達（`scheduled_tick_ring` / `scheduled_tick_total`） | **1/min**，45 分鐘 45 個、間距 +59.9–64.2s、**零漏洞** |
| 完成掃描（`scan_history`） | 13Z–21Z **每小時 24–26 次**（10Z–12Z 係 43/52/59）→ 近 3 小時 gap p50 **132s** |
| 觸發歸因（`scan_trigger_*`） | 22:19:32 cron **283** / http 275 → 22:27:13 cron **283** / http **278**（7.7 分鐘內 **Δcron = 0**、Δhttp = +3） |
| 直接窗口 | 兩次 120s：各 **2 個 cron 到達、0 個 cron 完成**，同期 http 完成 1 |
| heartbeat `via` | 22:23:24 / 22:26:14 / 22:28:21 **全部 http** |

即係：**cron tick 每分鐘都有到達，但由 ~12:45Z 起冇再完成過任何一次掃描**，成個 fleet 嘅
掃描全靠 uptime monitor 嘅 HTTP rescue（佢嘅 rescue 門檻係 `scanRescueGapMs` = 120s，所以
節奏自然跌到 ~132s）。累計數字亦吻合：http 278 ≈ 兩段異常窗口 + 12:45Z 之後嘅全部完成。

### 點解睇唔到原因（三個探針都盲）

到達記錄係喺 handler 一開頭（pre-init stamp）或 claim batch 落嘅，所以 **ring 完整**；
但之後嘅路徑全部落唔到任何 durable 痕跡：

- `skip_capture` 自 **20:39:20Z** 起冇再動過（total 7）——原因係**記憶體**計數，要等
  「下一次完成掃描嘅 tail write」才落地，而一個冇 scanner 嘅 isolate 永遠唔會有完成；
- 死 tick backfill 需要**下一次贏到 claim**（`BACKFILL_STALE_MS` 45s），所以死喺 claim 之前
  嘅 tick 一個 row 都唔會留（err rows：10Z 2、12Z 8、13Z 1、14Z 1，之後 0）；
- `scan_wedge` 凍結在 09:24:52→09:28:29。

### 真身：`ensureInitialized` 唯一嘅 cache 出口喺 `await` 之後

```ts
initPromise = (async () => { ... })();   // db.init() 同所有 client/bot 建構
await initPromise;                        // ← reject 就由呢句 throw 出去
if (tursoConfigured && !dbReady) initPromise = null;
```

上面嗰個 reset 只覆蓋「**settled 但 dbReady false**」一種失敗（`db.init()` 喺自己嘅
try 入面 throw）。另外兩種形狀**冇 exit**：

| 形狀 | 為何 reset 到唔到 | 結果 |
|---|---|---|
| boot **REJECT**（未包 try 嘅建構：grammy token、Scanner/client 建構、`installTickProbe`…） | `await` 直接 throw，reset 嗰句根本冇執行 | rejected promise 永遠留在 `initPromise` |
| boot **永遠唔 settle**（libsql client 內部 retry loop） | 永遠到唔到 `await` 之後 | 同上 |

兩種都令該 isolate **永遠 `scanner === null`**：之後每一個 tick 都行 handler 嘅
`!scanner` 分支——記錄到達、`noteSkipReason("init-no-scanner")`（只入記憶體）、
`return`。而 `if (initPromise) return initPromise;` 令每一個後續 tick 都**直接食返嗰個
死 promise**，所以只有 Cloudflare 回收 isolate（或者 deploy）才會復原——正好解釋
「每次都係 deploy 之後好返」同今次 12:45Z 之後冇 deploy 就一直卡住。

### 修法：cache 由外面自己清

| 新增 | 作用 |
|---|---|
| `cachedInitVerdict(pendingSince, now)` | 純函數：pending 超過 `INIT_UNSETTLED_MAX_MS`（**60s**，約 17× 健康 boot 嘅 ~1–2s）就 `drop`，令**同一個 tick** 可以重新 boot（覆蓋「永遠唔 settle」） |
| `trackInitBoot(boot, state, { isCurrent, onReject })` | boot 一 reject 就即刻清 cache（覆蓋 throw）＋ 報原因；`isCurrent()` 係 identity test，避免一個**已被取代**嘅舊 boot 嘅 settle 清走現行 boot 嘅年齡；順手令「creator 3.5s 前台 timeout 之後才 reject」唔再變成 **unhandled rejection** |

boot 成功 settle（無論 resolve / reject）就將年齡歸零，所以健康路徑完全冇多餘判斷。

### 測試同 mutation

- `test-unit`：新測試「init boot cache: a REJECTED or HUNG boot stops being cached」
  ——verdict 兩邊邊界（bound 上仍然 reuse、過 1ms 就 drop）、reject 會清 pending age 同報原因、
  resolve 唔會、**late settle 唔會清走現行 boot 嘅年齡**，再加兩條 whitespace-squashed
  wiring pin（guard 真係清 cache、boot 真係帶 identity test 去 track）。
- Mutation（`docs/patches/init-boot-heal-mutation-2026-09-27.check.js`，逐個跑、每次比對
  還原）：① verdict `>`→`>=` ② reject 分支唔清 age ③ 吞咗 onReject ④ identity test 改
  `() => true` ⑤ call site 完全唔 wire `trackInitBoot` —— **5/5 都被捉到**。

### 驗收（deploy 之後）

1. `scan_trigger_cron` 重新以 **~1/min** 上升（唔再係 Δcron 0），而 `scan_heartbeat.via`
   會重新見到 `cron`；`scan_history` 每小時返到 ~60 次。
2. 到達 ring 應該一如以往完整（唔變）。
3. Cloudflare log：萬一真係 throw，會見到
   `[worker] init THREW — dropping the cached init so the next tick retries: …`；
   若果係 hung，就會見到 `init promise still unsettled after Ns — dropping the cached init…`。
   **兩句都代表 isolate 自己復原緊**（log 出現之後下一個 tick 應該掃得成）。

## 4.43 `subreqSkip` 掉落率：`counted` p50 25.5 對住 26 呢條線（2026-09-27）

### 量度方法

- `scan_history` **唔帶** `subreqSkip`（佢住喺 heartbeat 個 summary 裡），所以掉落率只能逐 tick 抽樣；
  done row 會存活到下一個 tick claim 為止（~57s），所以每 14–15s 讀一次就捉得齊每個 tick。
- 探針：`docs/patches/subreq-skip-read-2026-09-27.read.js`（純讀取，`worker_state` + `scan_history`，
  唔經 `/health` 或 `/debug/*`）；按 `at|phase` 去重，每個新 tick 印一行。
- 判讀（`src/subreqs.ts` / `src/scanner.ts`）：

```
usable = SUBREQ_BUDGET_FREE(50) − SUBREQ_UNSEEN_ALLOWANCE(12) = 38
left   = max(0, 38 − counted)
drop   = dropOptionalLeg 在 left ≤ SCAN_SUBREQ_FLOOR(12) 時開火
       ⇒ counted ≥ 26 就係 drop zone
```

### 量到嘅（23:36:19 → 23:48:09，9 個有數據嘅 done row）

| tick（flush） | `counted` | `left` | 狀態 | `subreqSkip` |
|---|---|---|---|---|
| 23:36:19 | 27 | 11 | drop zone | `["chain"]` |
| 23:40:13 | 27 | 11 | drop zone | — |
| 23:41:24 | 25 | 13 | ok | — |
| 23:42:12 | 24 | 14 | ok | — |
| 23:43:12 | 27 | 11 | drop zone | — |
| 23:44:13 | 28 | 10 | drop zone | — |
| 23:45:12 | 25 | 13 | ok | — |
| 23:46:24 | 24 | 14 | ok | — |
| 23:47:12 | 26 | 12 | drop zone（正好撞線） | — |

- `counted`：**min 24 / p50 ~25.5 / max 28**；最近連續 8 個 tick 有 **4 個（50%）** 已經踏入 drop zone。
- `subreqSkip` 出現 **1/9（~11%）**，而最近連續 8 個 tick 係 **0/8**。掉嘅一律係 **`chain`**，
  **任何 feed leg**（`boosts` / `geoTrend` / `meteora` / `jupTrend` / `gmgn` / `axiom`）**一次都冇出現過**。
- 每個 tick 照樣 `profiles 24–25`、`ms 3.0–3.9s`、`via cron`、cron 1/min、`http 295` 凍結（冇 rescue）。

### 點解「入 zone」遠多過「真係掉」

必要條件係 `counted ≥ 26`，但**唔充分**：drop 要一個**後期**階段喺越線之後才開口。feed 階段嘅
optional leg（`crime-refresh`、`meteora`、`geoTrend`、`boosts`、`gmgn`、`axiom`、`jupTrend`）全部
**早**跑，所以它們逃得過；`chain` 係唯一夠後嘅階段 —— 所以歷史上唯一被點名嘅就係 `chain`。

**影響**：`chain` 被掉 = 該分鐘唔評估 candidate（`pushed 0` 唔一定等於冇合資格幣）→ 合資格嘅幣延到
下一個 tick（re-eval pool 會再查）。係**一個 tick 嘅延遲**，唔係永久漏推。

### 覆檢基準（下次直接對呢張表）

| 讀數 | 2026-09-27 23:36–23:48 基準 | 觸發動作 |
|---|---|---|
| `subreqSkip` 有 `chain` 嘅比率 | 1/9（~11%），最近連續 8 tick = 0/8 | 變成 **≥2/10** 或**任何 feed leg** 出現 ⇒ 先落 `DEXSCREENER_BOOSTS_LIMIT="0"` |
| flush `counted`（drop 線 26） | p50 **25.5**（min 24 / max 28） | p50 升到 **≥28** ⇒ 同上（先省 request） |
| `dex.http429` / `dex_429_ring` | 同 cadence 無關，~1 episode / 3–5 分鐘 | 持續升 ⇒ 250→350ms |
| `profiles` | 24–25、`settled true` | **持續**跌（唔係 1–2 個 tick）⇒ `SCAN_INTERVAL_SECONDS=90` |

> 註：改 cadence（60s）之後呢三個旋鈕都**未**落，理由見上表 —— 兩次量度都未達到 wrangler.toml 自己寫嘅標準。

### 覆檢陷阱：deploy 之後嘅頭 2–3 個 tick 唔可以入基準（實測）

2026-09-27 23:53:34Z deploy 之後即刻量：頭兩個 tick 讀到 **`counted` 33 / 34（left 4 / 5）**，
而同一批 cron isolate 暖返之後就係 **21 / 24（left 17 / 14）**（23:55:11、23:56:18）。

即係一個 cold isolate 要為 init / boot reads 多付 **+6–8 個 subrequest** —— 同 23:21–23:22 嗰對
`profiles 3`（23:20:45Z deploy 之後）係同一個形狀。兩次都**唔係** feed 或 cadence 出事。

⇒ 覆檢時**跳過 deploy 之後嘅頭 2–3 個 tick**，否則會誤以為 `counted` p50 已經爬到 ≥28，
而按上面張表錯落 `DEXSCREENER_BOOSTS_LIMIT="0"`。
---

## 4.44 drain 讓路門檻：由固定 14 改成「量度到嘅需要」＋隊列過上限就強制落地（2026-09-28）

### 病徵（live，2026-09-28 00:02–00:28Z，60s 模式）

| 時間 | `writeDrain.owedTokens` | `calls`（isolate 累計） | `heldForTracker` |
|---|---|---|---|
| 00:02 | 305 | 5 | 1 |
| 00:04 | 486 | 5 | 2 |
| 00:10 | 894 | 6 | 2 |
| 00:14 | 1072 | 7 | 2 |
| 00:25 | **2010** | 7 | 2 |
| 00:28 | **2098** | 7 | 2 |

`failures 0`、`write_drain_error` 空 —— 即係**唔係壞，係完全冇落地**：26 分鐘內隊列由 305 升到
2098 筆，而 isolate 一生只成功交過 7 個 call。

### 算術（就係 14 呢個數出事）

```
subreqRemaining() = 38（50 − 12 未見reserve）− counted
drain 讓路條件   = left <= DRAIN_TRACKER_RESERVE(14)
                  ⇒ counted >= 24 就完全讓路
```

實測 `counted` **24–36**（p50 ~27），所以 `left` 係 2–14，**每一個 tick 都 ≤ 14** ⇒ zero landings。
14 本身冇錯：佢係「一個有 room 嘅 pass 值得開跑」嘅需要（8 rows + 6 tail writes），只係呢個 bot 嘅
tick 已經冇 room 畀佢 —— 60s cadence 恢復之後 scan 自己先用咗 24–36。

### 改動（一個 commit 兩半）

1. **量度而唔係假設（②）**：`worker.ts` 喺 tick path 嗰個 pass 前後量 `subreqRemaining()` 嘅差，
   餵入 `tickprobe.noteTrackerPassSpend()`；`drainTrackerReserve()` 取最近 5 個樣本嘅 **worst**，
   clamp 落 `[DRAIN_TRACKER_RESERVE_MIN(9), DRAIN_TRACKER_RESERVE(14)]`。
   冇樣本（未量度過）就照舊 14 —— 未量度嘅 isolate 行為**完全不變**。
   9 = `pushwatch` 嘅 `TRACKER_SUBREQ_FLOOR(3) + TRACKER_SUBREQ_RESERVE(6)`，即「仍然算係一個 pass」
   嘅下限。**只有 tick path 會報數**：pass 自己個 cron delivery 獨佔成個 window，佢喺嗰度花幾多同
   共用 invocation 剩幾多 room 冇關係。
2. **過上限就強制落地（①）**：`owedTokens >= DEFERRED_FORCE_DRAIN_RECORDS`（= `40 × 10` = **400** 筆）
   時，yield 降到 `DEFERRED_FORCE_DRAIN_FLOOR`（**6**），即係淨係保住 pass 自己嘅 tail writes
   （note persist + deferral sync）。pass 可以照樣 `deferred:subreq-budget` 讓路（by name，唔會死），
   但唔可以連「我有跑過」嗰個 write 都冇。

新常數（`src/tickprobe.ts`）：

| 常數 | 值 | 意思 |
|---|---|---|
| `DRAIN_TRACKER_RESERVE` | 14 | 自適應 reserve 嘅**上限**，亦係未量度時嘅值 |
| `DRAIN_TRACKER_RESERVE_MIN` | 9 | 下限（3 + 6） |
| `TRACKER_PASS_SPEND_RING` | 5 | 取 worst 嘅樣本數 |
| `DEFERRED_FORCE_DRAIN_RECORDS` | 400 | 過咗就唔等 pass |
| `DEFERRED_FORCE_DRAIN_FLOOR` | 6 | 強制模式淨係留畀 pass 嘅 tail |

`writeDrain` view 多一個 `reserve`：14 = 未量度（等同舊行為）、9–14 = 量度到嘅 yield、
6 = 強制模式、0 = 空隊列。

### 測試同 mutation

`scripts/test-unit.js`（+1 測試，386 passed / 0 failed）釘住：未量度 = 上限；量度後跟 worst、
clamp 落 floor；離譜讀數（負數 / > usable / NaN）**丟棄而唔係夾**（個 counter 同 peer pass 共用，
會有壞樣本）；`left = 14` 未量度時仍然 hold、量度到 6 之後**同一個 room 就落地**；
隊列過 400 就降到 6 並交到一個 batch，而**同樣 room 之下未過上限就照樣 hold**（control）；
以及 worker 只有 tick path 一個 call site 報數。

mutation 6/6 全部被捉到（`docs/patches/drain-reserve-mutation-2026-09-28.check.js`，逐個跑、每次
byte-for-byte 還原）：抽走 force rule、用最新樣本代替 worst、抽走 floor clamp、相信離譜讀數、
gate 改返 flat 常數、worker 唔再報數。

### 驗收（live 睇乜）

1. `writeDrain.reserve` 應該由 14 開始，跟住出現 **9–13**（量度生效）；`heldForTracker` 應該
   由 2 變成 0–1。
2. `owedTokens` 應該**跌**（唔再單調上升）、`totals.calls` 應該明顯升。
3. `push_watch_pass` 唔應該退化：仍然 `via: cron-pass`、`rows 26/26`；如果開始見到
   `deferred:subreq-budget` 或 `rows` 大跌，即係 yield 調得太薄 ⇒ 覆檢 `TRACKER_PASS_SPEND_RING`
   嘅 worst 有冇如實反映（或者把 `DRAIN_TRACKER_RESERVE_MIN` 調返上去）。
4. 隊列過 400 嗰陣：`reserve 6` + `calls 1`（每 bucket 40 筆），直到跌返落上限以下。

> 註：drain 嘅 subrequest 唔會計入 heartbeat 嘅 `subreqs`（summary 喺 `onTickEnd` 之前 serialize），
> 亦唔會影響下一個 tick（每個 invocation 一個新 window）—— 所以 §4.43 嗰條 `counted` 基準線唔變，
> 唔需要重新校準。
### 4.44a 補正：落地要「一個 tick 多個 slice」，唔係每個 bucket 一個（2026-09-28 01:0xZ，deploy 之後即刻量到）

強制落地 rule（`reserve 6`）確實生效 —— 但隊列**仍然繼續升**：

| 時間 | `calls` | `heldForTracker` | `reserve` | `owedTokens` |
|---|---|---|---|---|
| 00:57:50 | 2 | 0 | 9 | 251 |
| 00:58:41 | 1 | 1 | 9 | 356 |
| 00:59:12 | 2 | 0 | **6** | 424 |
| 01:00:12 | 2 | 0 | 6 | 477 |
| 01:02:29 | 2 | 0 | 6 | 548 |

`calls 2` 每個 tick 都有落地（舊 build 係 `calls 0`），但 `owedTokens` 由 356 爬到 548，即
**+53…+71/tick**。原因係結構性：`ready = owedBuckets()` 係一個快照，個 loop 每個 bucket **只跑一次**，
所以一個 drain 最多就係每個 method 一個 40 筆嘅 slice = **80 筆/tick**，而 scanner 每個 tick 入隊
**~150 筆**（`recordTokenStatsMany` ×2 ＋ `updateTokenMaxMcaps` 掃 pool slice）。淨增長 ~+55/tick。

**改動**：一個 bucket 落完一個 slice 之後如果仲有筆數，就掉去 **worklist 隊尾**（兩個 method 之間
保持公平），所以 reserve 以上嘅 room 會用嚟落**整個 slice**，直到 room 冇或者撞到
`DEFERRED_MAX_CALLS_PER_DRAIN = 10`（10 × 40 = 400 筆，即隊列自己嘅上限）。
room check 仍然係真正嘅邊界（每個 call 一個 subrequest，落到 `reserve` 就停），個 cap 係防止
「room 讀數永遠唔跌」嗰種情況把一個 invocation 變成無上限嘅 walk。

**測試**：`90 筆 = 40 + 40 + 10`（同一個 drain）＋「過 cap 就留住剩額」；另外原本 coalescing 測試
嗰句「43 筆要兩個 drain」已經跟行為改成「同一個 drain 分 slice 交完」（一個 call 依然最多 40 筆）。
mutation 8/8 全部被捉到（新增：抽走 re-queue、把 cap 改成 1）。

**驗收更新**：`owedTokens` 應該**跌返落 100 上下並穩定**（唔再單調上升），`calls` 每個 tick 1–4、
`reserve` 6（強制）或 9（量度到）；若 `calls` 長期只有 2 而同 `owedTokens` 一齊升，即係 re-queue
或者 cap 有問題。

## 4.45 死亡之後嗰個 tick：drain 收縮到一個 call，同埋 drain 唔再排喺 completion flush 前面（2026-09-28）

> ⚠️ **2026-09-28：本節（同 §4.45a）嘅死因框架已經被 §4.46 推翻。** 尾段「界線（老實講）」寫嘅「§2026-09-23
> 嘅結論（invocation 級 subrequest 上限 50）依然係唯一解釋得晒所有形狀嘅機制」**唔成立** —— 真死因係 Workers
> Free 嘅 **10 ms CPU**（`docs/scan-completion-loss.md` §2026-09-28）。下面關於 drain 位置（A，已回退）、
> 死亡 tick 收縮（B，留低）同佢哋嘅量度唔受影響。

### ⚠️ 先更正上一節：原本 §4 講嘅「self-heal 從來冇 fire」係錯嘅

上一 turn 報嘅缺口（`if (flushSettled) deadTickStreak = 0;` 喺檢查之前歸零，所以 `finally` 嗰條重建路徑
永遠到唔到 2）**係真嘅 code 缺口，但唔係 00:33–00:53Z 呢條 20 分鐘 stretch 嘅成因**：successor 側**另有一條
冇門檻嘅重建路徑** —— `deadTickRebuildDecision`，跑喺 `ensureInitialized` 最前面，條件只有「前一個 tick 係
stale `phase=scanning` 而且 heartbeat 冇 `rebuiltAt` 標記」。而個標記係重建自己寫落 heartbeat，之後由**claim**
寫嘅 `heartbeatJson`（唔帶 `rebuiltAt`）覆蓋。所以：

> **每一條成功落地嘅 backfill row，都證明嗰個 successor 嘅 claim 有落地；claim 覆蓋咗標記 ⇒ 嗰個
> successor 一定行過重建。**

12 條 backfill row ⇒ 20 分鐘內最少 12 次重建（差唔多每分鐘一次），而死亡照樣繼續。重建已經清晒**所有**
module state（`dex`／`helius`／`gmgn`／`scanner`／`initPromise = null`，`initPromise` 一 null 就連
`db = new PoolFallbackDb(...)` 都重開），所以「isolate module state 中毒」唔係成因，再多 wire 一條
counter-based 重建只係第二條醫唔到病嘅路。**結論：§4 冇落手，改為落下面兩樣（同一份證據支持）。**

### A. drain 由「flush 之前」搬去「flush 之後」（真正嗰個修法）

`drainDeferredWrites()` 本來 fire 喺 tickprobe 嘅 `onTickEnd` hook，而**嗰個 hook 係喺 worker 嘅 completion
flush 之前跑**：`onTickEnd` 係 scanner `runOnce` wrapper 嘅 `finally`，而 `flushJson`（`buildFlushPayload()`）
同 `persistScanCompletion()` 係 `runOnce` **return 之後**才 build／寫（`worker.ts` ~4110 → 4255 → 4297）。
即係每個 tick 最多 `DEFERRED_MAX_CALLS_PER_DRAIN = 10` 個 bookkeeping round trip（libsql 內部重試下，每個可以
變成 2–3 個 platform subrequest）**排在嗰個 tick 唯一唔可以輸嘅寫入前面**。drain 自己嘅註釋一路都寫
「called by the worker AFTER its completion flush」——呢個改動係令實作同合約一致。

- 改：`onTickEnd` 唔再 fire（原地留一段解釋），改為喺 tick tail、**completion flush 之後**、tracker pass 之前 fire。
- 效果：`drainTrackerReserve` 講嘅「leave for the tracker pass behind it」終於字面成立（drain 之後只剩 pass ＋ deferral sync）。
- 冇改：`writeDrain` 讀數依然係「上一個 tick 嘅 drain」（summary 喺 `onTickEnd` 時序列化），queue 依然係 module state、依然由 `tickWaitUntil` 夾住，fire-and-forget 冇 twin。

### B. 「backfill 咗死亡」嗰個 tick 收縮 drain（§4 想講嘅嘢，但用喺有效嘅地方）

`runScan` 本來就知道自己 backfill 咗一個死亡（`dead !== null`）。呢個 tick 正正係**要證明死亡潮結束**嗰個
tick ——佢自己嘅 completion flush 就係收尾嗰個寫入。所以：

```ts
drainCallCeiling(deadPredecessor)  = deadPredecessor ? DEFERRED_DEAD_PREDECESSOR_MAX_CALLS : DEFERRED_MAX_CALLS_PER_DRAIN
drainShedReason(deadPredecessor)   = deadPredecessor ? "dead-predecessor" : null
```

`drainDeferredWrites(subreqLeft, { maxCalls, shed })` 多咗一個 `DrainOptions` 參數，`WriteDrainView` 多咗一個
`shed` 讀數（null = 正常 ceiling）。一個 call（最多 40 筆）依然令隊列有進展（queue coalesces，冇落地嘅繼續
owed），剩返嘅 allowance 留俾 pass 同 deferral sync。正常 tick 一行都冇改：依然最多 10 個 call，而
`owedTokens ≥ 400` 嘅強制落地規則唔變。

### 測試 ＋ mutation

- `scripts/test-unit.js`：新測試「a tick that backfilled a death sheds its drain to one call」——1 個 call、
  `shed` 有出、其餘 owed、`heldForTracker 2`，而且有 **control**（同一個隊列、同一個 room、正常 ceiling）
  證明 room 真係允許更多 call（冇 control 就分唔清「shed」同「隊列本來就細」）。另有 source drift guard：
  drain 嘅 call site 必須喺 `db?.persistScanCompletion(` **之後**（`drainAt > flushAt`）。
- `scripts/test-tick-path.js`：`drainCallCeiling` / `drainShedReason` 嘅純規則（`1 < 10`，唔可以反過來）。
- mutation **5/5 全部被捉到**（`docs/patches/dead-tick-shed-mutation-2026-09-28.check.js`，逐個跑、每次 byte-for-byte
  還原）：M1 忽略 caller 嘅 ceiling、M2 唔發布 `shed`、M3 `drainCallCeiling` 永遠回正常值、
  M4 `drainShedReason` 永遠 null、M5 把 drain 搬返 `onTickEnd`（即係 fix 之前嘅形狀）。
- 全樹：`npx tsc --noEmit` ✅、`npm run build` ✅、`test-unit` **387/0**、`test-tick-path` ✅、
  `test-deferred-priority` ✅、`test-dex-list-cache` 9/0、`test-dex-last-profiles` 13/0、`test-schema-gate` 6/0、
  `test-health-front` 5/0、`test-usd-formatter` 4/0。

### 驗收點（deploy 後）

1. `/health.writeDrain`：正常 tick `shed: null`、`calls 1–4`；backfill 嗰個 tick `shed: "dead-predecessor"`、`calls 1`。
2. `scan_wedge`：下一條 stretch 嘅長度（目標：由 20 分鐘級降到一兩個 cadence 就結束）；`outage_alert_at` 唔應該再過 10 分鐘線。
3. `owedTokens` 仍然要喺 100–400 之間震盪（A 令 drain 睇到嘅 room 少幾格，可能輕微推高；若長期單調上升就睇 `calls` 同 `shed`）。

### 界線（老實講）

- **呢兩個改動都改唔到「tick 死喺掃描途中」**（今日 12 條都係 `prog scan +0ms`，即係 scan 一開始就死）。
  佢改嘅係「捱到 flush 嗰個 tick 幾大機會寫得入」——而一條 stretch 只要有一個 tick 寫得入就結束。
- 死因嘅**硬證據仍然要喺 worker 外面攞**（Cloudflare dashboard → Workers → Metrics → Invocation Statuses，
  00:33–00:53Z；或者 Workers Paid 先有 logs）。`docs/scan-completion-loss.md` §2026-09-23 嘅結論（invocation
  級 subrequest 上限 50，Turso round trip 每個都計，libsql 重試會放大）依然係唯一解釋得晒所有形狀嘅機制，
  而免費方案下唯一嘅槓桿就係減 round trip —— A 係唔再搶 flush 嗰份，B 係死亡 tick 少花 9 個。
- 最直接嘅方案冇變：Workers Paid（US$5/月，50 → 10,000）。

### 4.45a 補正：A（drain 搬去 flush 之後）實測即刻回退，剩下 B（2026-09-28 02:2xZ）

新 build 02:21:40Z 上線之後，**同一日即刻量到 A 有代價，所以回退咗 A、保留 B**。數字：

| 時間（build） | `calls` | `shed` | `reserve` | `owedTokens` |
|---|---|---|---|---|
| 01:11–01:16（A 之前） | 3 / 2 / **4** / 2 | — | 6 | 129 → 185 → **141** → 214（有跌過） |
| 02:23:14（A 之後） | **0** | `dead-predecessor` | 14 | 124 |
| 02:25:54（A 之後） | **0** | null | 9 | 244 |
| 02:26:35 | **0** | null | 9 | 293 |
| 02:27:14 | **0** | null | 6（強制） | 344 |
| 02:28:13 | **1** | null | 6 | **420（釘死喺 400 上限）** |

原因好清楚：drain 而家跑喺 flush **之後**，而佢自己嘅 room check 係 `subreqRemaining() <= reserve` ——
flush 已經花咗嗰份，所以幾乎每個 tick 都係「冇 room」，walk 一次都唔開始。隊列唔會爆（coalescing 按 token，
上限由 pool 嘅 distinct token 數決定），但變成一條**永遠追唔上嘅 backlog**（每 tick 入 ~150 筆、出 40 筆），
而 `token_stats` 簿記（registration、max-mcap raise）落後 = 一個 tick 嘅延遲承諾唔再成立。

**所以 A 冇留低。** 留下嘅係：

- drain 返去原本嘅位置（`onTickEnd` hook，即係 flush 之前），`calls 1–4`、隊列會跌返 —— 同 A 之前一樣；
- **B（死亡 tick 收縮到一個 call）照留**，而且位置更貼題：嗰個 tick 個 drain 正正排在**自己嘅 completion
  flush 前面**，所以「少花 9 個 round trip」係直接俾咗嗰個要收尾嘅寫入。Live 已經見到 B 上線：
  02:23:14 嗰個 tick `shed: "dead-predecessor"`（同時 `calls 0`，即係嗰個 tick 連一個 call 都冇 room）。

**老實講嘅 trade-off（仍然存在，唔係解決咗）**：drain 嘅 round trip 依然排在 flush 前面。要安全咁搬佢過去，
需要一個真正嘅**預算分割**（drain／flush／pass 各有明確份額），而唔係三個階段輪流去量同一個 `reserve` ——
呢個係下一步，唔係今次。

**驗收點更新**（取代 §4.45 第 3 點）：`owedTokens` 應該同改動前一樣喺 100–400 之間震盪（有升有跌），
`calls` 每個 tick 1–4；`shed: "dead-predecessor"` 只會喺 backfill 咗死亡嗰個 tick 出現（唔應該連續幾個 tick 都係 1）。

**順手記低**：deploy 落地之前，01:47:09.586Z 開嘅嗰條 stretch 一直燒到 `scan_wedge.tickAt` **02:21:24Z**
（約 34 分鐘，同前幾次一樣由 deploy 收尾）；deploy 之後到 02:28Z 冇再出現新嘅死亡 row。

## 4.46 真死因：Workers Free 每個 invocation 10ms CPU —— §4.45 嗰個 subrequest 框架被推翻（2026-09-28）

### 點解今次先有硬證據

`docs/scan-completion-loss.md` §2026-09-23 一直講「死因＝invocation 級 subrequest 上限 50」，而 §4.45 尾段仲寫住
呢個係「唯一解釋得晒所有形狀嘅機制」。兩者都係**由 worker 內部推論出嚟**，而且個機制本身係**loop 死**：
爆預算就係死喺 telemetry 寫入，所以「死嗰刻用咗幾多」永遠寫唔低。要打破個循環，就要一個**worker 外面**嘅證人。

`.github/workflows/cf-invocations.yml`（`cron: "7,37 * * * *"`，兩個鐘一次）＋ `scripts/cf-invocations.mjs`
就係嗰個證人：用 deploy workflow 自己嘅 `CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID` 直接查 Cloudflare
GraphQL 嘅 `workersInvocationsAdaptive`，按分鐘列 status／subrequests／cpuTime／memory，唔經 worker 任何一行 code。

### 決定性嘅一 run（run `36366536887`，window 2026-09-27T13:35Z–2026-09-28T01:35Z，`hours=12`）

十二個鐘嘅 status 分佈：

| status | invocations | |
|---|---|---|
| success | 2838 | 正常 |
| **exceededResources** | **19** | 非 success —— 就係告警嗰個形狀 |
| scriptThrewException | 7 | |
| clientDisconnected | 2 | |

19 條 `exceededResources` **一分鐘一條、落喺 00:33–00:52Z**（00:33、00:34…00:44、00:46、00:47…00:52），
即係 §4.45 追嗰條 **00:33–00:53Z、約 20 分鐘**嘅 stretch，一個一個對得上。逐分鐘嘅幾條關鍵讀數：

| 分鐘 | 嗰個 failed 嘅 subrequests | 佢嘅 cpuTime (us) | 同一分鐘生還者嘅 cpuP99 (us) |
|---|---|---|---|
| 00:33 | 21.0 | **48385** | 11792 |
| 00:34 | 8.0 | **10000** | 27965 |
| 00:35 | 8.0 | **10086** | 31824 |
| 00:36 | 8.0 | **10000** | 27287 |
| 00:37 | 9.5 | **10000** | 26139 |
| 00:38 | 12.5 | **10000** | 25863 |
| 00:39 | 7.5 | **10000** | 29048 |
| 00:40 | 8.0 | **10000** | 31970 |
| 00:41 | 9.0 | **10000** | 39672 |
| 00:42 | 9.0 | **10000** | 40299 |
| 00:43 | 10.0 | **10000** | 7827 |
| 00:44 | 9.0 | **10000** | 24144 |
| 00:46 | 20.0 | **25982** | 119226 |
| 00:47 | 8.0 | **10000** | 27582 |
| 00:49 | 8.5 | **10000** | 29973 |
| 00:50 | 6.0 | **10000** | 11411 |
| 00:51 | 10.0 | **14181** | 145655 |
| 00:52 | 7.0 | **10000** | 29513 |

（00:48 嗰條係 `scriptThrewException`，唔係 `exceededResources`，所以唔入上面呢組。）

**subrequest 上限唔可能係死因 —— 數字自己講**：嗰 19 個被殺嘅 invocation 全部只行到 **6–21 個 subrequest**
（Free 上限 50）。整個 12 小時 window 更加係 3739 個 invocation、平均 **7.4 個** subrequest、典型一分鐘 **8.3 個**
—— script 自己都咁落結論：「That is nowhere near the cap, so the cap is NOT the mechanism.」

反過來，CPU 嗰條線完全對得上：

- 18 個 `exceededResources` 嘅 cpuTime **整整 10,000 us**（00:35 嗰個 10,086 us 係同一個數嘅量測抖動）——
  唔係跑得啱啱好，而係**喺 10,000 us 被人叫停**，所以讀數釘死喺上限度。
- 同一分鐘、同一批 isolate、**生還**嗰啲 invocation 讀 7,827–145,655 us，好多遠超 10 ms 都跑得完。
- 12 小時整體：典型一分鐘 cpuTimeP50 = **7,176 us**、cpuTimeP99 去到 **276,184 us**（≈27 倍上限），
  而 Workers Free 嘅 cron CPU 上限係 **10 ms**。
- 記憶體先排除（錯得比較平嗰個）：被殺嗰批峰值 **16.2 MB**，對住 128 MB isolate 上限，差一個數量級。

script 尾段嗰句就係個機制：

> An invocation killed with `exceededResources` reports cpuTime EXACTLY at 10,000 us (the limit, where
> Cloudflare stopped it), while invocations in the same minute that were allowed to finish report
> 14,000-121,000 us. … an isolate has built-in flexibility for a Worker that runs over its limit
> INFREQUENTLY, and … one which hits it CONSISTENTLY gets terminated. That is the burst: **the slack is
> withdrawn for a few minutes at a time**.

呢句解釋晒所有形狀：呢個 worker 幾乎**每個** tick 都超 10 ms（p50 7.2 ms、p99 276 ms），Cloudflare 對「偶爾超」
有寬限，但對「持續超」就收回 —— 收回嗰幾分鐘就係一條 stretch，每個 tick 一出 scan 就畀人斬。

### 所以推翻咗乜嘢

- **§4.45「界線（老實講）」第二點**（「§2026-09-23 嘅結論依然係唯一解釋得晒所有形狀嘅機制」）⇒ **唔成立**。
  被殺嗰批係**喺 50 之前**就死，唔係撞到 50。
- **§2026-09-23 成節**：invocation 級 subrequest 上限 50 唔係死因（`docs/scan-completion-loss.md` 已加
  overturned banner ＋ §2026-09-28 正式更正）。爆 50 嗰個失敗模式**可能存在**，但唔係呢 19 個。
- **`prog scan +0ms subreqs N` 呢個形狀**：「一開 scan 就死」係真嘅，但 `subreqs N` **唔係死嗰刻嘅數** ——
  `stage:"scan"` 嗰個 admission stamp 騎喺 `db.claimScanLock(...)` 嗰個 batch 上面寫（`src/worker.ts` ~4079），
  即係 **claim 嗰一刻**嘅讀數。所以佢從來冇證明過 50 呢條線；真正嘅解釋係 claim 之後一入 scan 就撞 CPU 封頂。

### 但係 subrequest 讀數係真嘅，只係唔 binding

唔可以因為咁就當佢唔存在：新 build 一個健康 tick 量到 `subreqs.current total 33`（turso 24、jup 5、…），
而且有讀數見到 `recent[1]: owner scan total 40`（可用上限 38，即係**貼住**）。所以：

- 減 round trip 依然係好習慣，尤其係上 Workers Logs 之後想睇清成本嗰陣；
- 但**唔係**今次 stretch 嘅成因。之前每次 audit 減 round trip 而 stretch 照樣出現，就係因為槓桿唔喺呢度。

**順手記低一個 instrumentation 缺口**：`beginSubreqWindow` 係**逐 module** 埋單，唔係逐 invocation ——
tracker pass 自己嗰個 cron 落喺同一個 isolate，會**截斷** scan 嗰條 window（實測：scan total 1、pass total 3、
相差 1 ms）。即係單一 tick 嘅真實總數，而家係讀唔到嘅；要真係量，就要一個 invocation 級嘅 window。

### 修法

**Workers Paid（US$5/月）係唯一直線修法**：cron CPU 10 ms → **30 s**（3,000 倍）、subrequest 50 → 1,000
（Free 唔可以調高；`wrangler [limits] subrequests` 只係喺 Paid 之內再調），而且解鎖 **Workers Logs** ——
今次呢個結論係靠 Cloudflare 嘅分析 API 拼出嚟嘅，Paid 之後可以直接睇 invocation log。

### 界線（老實講）

- 呢個結論**唔改**一個死 tick 嘅代價（一個 rotation turn 冇咗、一串讀數斷層），亦**唔改**任何 telemetry 嘅行為：
  寫唔入嗰啲 row 一樣寫唔入。佢改嘅係**原因**同**下一步**。
- Paid 之前，免費方案冇任何旋鈕可以直接買到 10 ms 以上嘅 CPU —— 只有**減少每個 tick 嘅 CPU 支出**。
  呢個就係下一個 audit 嘅方向（而唔再係「減 subrequest 數」）。
- 證據要留住：Cloudflare 分析 API 嘅 Free 保留期短，`scripts/cf-invocations.mjs` 繼續留（Paid 之後一樣可以
  當佢係「有冇 tick 又封頂」嘅探針）；`.github/workflows/cf-invocations.yml` 個 `schedule:` 就係為咗呢件事
  而暫時存在。
