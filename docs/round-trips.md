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
