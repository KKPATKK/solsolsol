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

### 4.3 holder probe 嘅 cap 同 slot — 已修（2026-09-23，未 deploy）

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

### 4.5.1 Birdeye CU 帳簿：由推算變成量度（2026-09-23，已修，未 deploy）

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

## 5. 驗證狀態（本地 + 上線）

* `npm run build`（tsc）✅
* `node scripts/test-unit.js` → **286 passed, 0 failed** ✅（279 → 286：§4.5.1 新增 7 條 CU-ledger test
  —— 單價表、attempt 記帳、mid-write charge、parser 容錯、merge＋剪枝、today/month 分界、
  sync 落地＋失敗 re-offer；§4.4 嗰條 CU-gate test 與 `trips` invariant 仍然釘住）
* `node scripts/test-deferred-priority.js` ✅、`node scripts/test-tick-path.js` ✅
* push `bba1312` → Deploy Worker to Cloudflare **success**（1m9s）✅；`21521eb`（§4.2 row loop）
  → run 35837821096 **success**（1m27s）✅；`ae269d4`（§4.1 holder gate）→ run 35845665809
  **success**（1m16s）✅；`2b4b9fe`（§4.3 probe cap／slot）→ run 35851038091 **success**（1m20s）✅；
  `66a9321`（§4.4 CU budget）→ run 35854326659 **success**（1m20s）✅
* 上線後讀數：§3.1（第一刀）、§4.1.1（holder 由飢餓救返）、§4.2.1（row loop 一個 head 一個 trip）、
  §4.3.1（`probe1 miss0` 同 collect 回落）、§4.4.1（`probe1 miss0` → 下一個 pass `cu-gate`）
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

## 6. 點解要一個 script 落呢個改動

`src/pushwatch.ts`（148KB）同 `scripts/test-unit.js`（454KB）都遠超檔案工具嘅編輯窗口：
第 ~1000 行（約 50KB）之後，`str_replace` 一律答「old string not found」（逐行 probe 過，
`docs/patches/tracker-pass-batched-consumer.apply.js` 就係因此存在）。所以：

* 改動用 script 落，**兩個階段**：先驗 18 個 replacement 每個都**只可以唯一命中**，
  有任何一個唔中就跑都唔跑、直接 exit 1（唔會出現半套改動）。
* 記錄留底喺 `docs/patches/`（同 `poolfallback.ts`、`getReevalPoolBatched` 一樣，
  呢個 repo 一直有呢類「deep call site 要繞路」嘅處理）。
* 落完之後用 `git diff` + `tsc` + 三個 test suite 驗，唔靠腳本自己講。
