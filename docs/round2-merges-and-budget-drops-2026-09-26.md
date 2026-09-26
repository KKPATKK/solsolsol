# Round 2：tick 嘅 Turso round trip 合併 ＋ `budgetDrops` 嘅真身（2026-09-26）

> 背景（`docs/round-trips.md` §4.11）：一個 cron tick 嘅真·硬上限係 Workers Free 嘅
> **50 subrequests per invocation**，而 Turso 走 HTTP transport ⇒ **每個 DB round trip 都係一個
> subrequest**；慢嗰陣 libsql 自己嘅重試會放大。§4.12 收咗 tick tail（6 → 2）、§4.13 收咗
> scan 嘅 front（4 → 1 read ＋ 1 write），但之後一個 tick 仍然係 **~16–20 個 distinct one-shot
> statement**（唔係一個大 loop）。今次係第二輪：**三個合併 ＋ 一個讀數修正**，加上令下一輪
> 有數可依嘅 census 標籤。

## 1. 落咗嘅四樣

| # | 位 | 之前 | 現在 |
| --- | --- | --- | --- |
| 1 | cold init（`worker.ts` `ensureInitialized`） | 4 個 `getWorkerState`（`axiom_access_token` ＋ deferral ＋ ledger ＋ skip-capture），每個一個 round trip | **1 個 `getWorkerStates`**（同一個 try；讀唔到＝「冇讀數」，map 冇 key，即係以前嘅 null，唔係「冇 row」） |
| 2 | tracker pass 嘅 entry（`pushwatch.ts` → `Db.beginTrackerPass`） | 3 個 one-shot statement：RUNNING stamp、`push_watch` listing、settle 階段嗰行 `worker_state` | **1 個 batch**（一個 HTTP request，statement 依序執行）：可選嘅 `IN (…)` state 讀 → listing → stamp upsert 放最後 |
| 3 | RUNNING stamp 嘅擁有者 | `Scanner.persistPassStart`（pass 之前自己一個 round trip） | 騎 entry batch（pass 嘅第一個 request）；scanner 每個 pass 只寫一個 row：note |
| 4 | census 標籤（`tickprobe.ts` `dbStepLabel`） | `getWorkerState 5 calls / 2559ms`（分唔清邊 5 個 key） | `getWorkerState:axiom_access_token 2`——key 入 label，下一輪合併才 actionable |

**點解係呢三條**：census window 實測最大單一 method 就係 `getWorkerState`（5 calls / 2559ms），
而佢係 ~40 個 key 共用嘅讀法；cold init 嗰四行喺**每個被回收嘅 isolate** 都再付一次，
pass entry 嗰三個 statement 係**互相唔依賴**嘅（一個 batch 唔會改變佢哋任何一個嘅語意）。
label 規則淨係套落呢兩個 generic method（其餘 method 本身已經係具體操作），而且係 arguments
嘅純函數 ⇒ cumulative `dbSteps` 同 per-tick `dbTickSteps` 一樣可比。

### 唔變嘅保證（呢啲係正確性底線）

* **batch 係 transaction**：entry batch 被拒就三個讀數一齊冇——caller 跌落 pre-merge 形狀
  （自己補 stamp、重新讀 listing、settle 階段自己讀嗰行），即係**代價最多等於舊 code**，
  唔會少一個讀數。冇 `beginTrackerPass` 嘅 Db（測試 double／本地 runner）照舊三步走。
* **stamp 嘅承諾仍在**：pass 一開始就動 durable row（entry batch 係 pass 嘅第一個 request）。
  **老實講嘅損失**：喺 entry gate 就被 defer 嘅 pass，或者 entry batch 被拒嘅 pass，
  係出 note 而唔係 `running` stamp——兩條路都仍然寫 durable note，所以 row 一樣會動。
* **listing 一字不改**：`beginTrackerPass` 用 `listPushWatch` 原本嗰條 SELECT（verbatim），
  共用 `PushWatchListRow` ＋ `mapPushWatchRows`（一份定義，兩邊唔可以 drift）。
* **`getWorkerStates` 讀唔到 ≠ 冇 row**：map 淨係缺 key，同以前單讀嘅 null 一模一樣。

## 2. `budgetDrops` 每 tick 2–3：request 冇發出，唔係被拒

讀數本身講嘅係：throttle 條 queue 揸住個 attempt 揸到過咗 caller 嘅窗（profiles/boosts 480ms、
pair 1s），所以**根本冇 dispatch**（唔係 429）。三個成因／出路：

1. **一個 drop 會變兩個**。`Throttle` 嘅鏈係 global 嘅，request **START** 之間隔 `intervalMs`
   （250ms）——一個注定答唔到嘅 attempt 一樣會佔一個 slot，即係**佢後面嘅腿要遲一整個 gap**。
   修法：`Throttle.nextSlotAt()` 講出「而家入隊會幾時真正開始」，`getJson` **入隊之前**先問；
   窗已經冇就**免費** drop（唔佔 slot）。queue 內嘅舊檢查留做 backstop，處理「isolate 卡住、
   plan 睇唔到嘅一次真 dispatch」。
2. **pair 階段嘅尾巴 batch**。1s 窗 ＋ 250ms global spacing ⇒ 最多 6 個 batch；尾巴嗰啲以前
   係「入咗隊、然後被 queue 揸到過期」，同樣每個食一個 slot 然後答零。修法：`nextSlotAt()
   >= deadline` 就**收階段**，唔入隊——跳過嘅 token 保住 pool slot，下一輪 rotation 再讀，
   同一個 drop 嘅結果一樣，但冇 slot、冇假讀數。
3. **讀數要講得出邊條腿**。`dropsByLeg`（四個 key 永遠齊，0 都要在——「冇 drop」唔可以讀成
   「冇跑過」）＋ `lastDropLeg`；`dexFeedLeg(path)` 係純函數、有 unit test。三條腿三種處理：
   profiles 係最大 discovery lane（drop 係真損失，靠 10 分鐘 reuse lane 頂住）、
   boosts 本身就係 optional（`dropOptionalLeg("boosts")`）、pairs 係 rotation（尾巴留 pool）。

## 3. 本地驗收

* `npm run typecheck` clean。
* `npm run test:unit` **353 passed / 0 failed**（今次之前 348）：新增／改寫
  (a) `db: a pass's entry is ONE request — stamp, listing and the settle row together`（真 Db
  ＋ counting client：1 batch、0 execute、listing 同 `listPushWatch` deep-equal、空 stateKeys
  仍然一個 request）；
  (b) `out-of-window patch: the cold-init reads and the pass entry are ONE request each`
  （source-shape guard；cold-init 嗰條係 **scoped 去嗰個 block**——`await db?.getWorkerState(
  "axiom_access_token")` 喺 axiom token refresh 路徑仍然合法，所以 whole-file ban 會誤報）；
  (c) census 測試改讀 labelled shape；
  (d) `test-deferred-priority` 加 drop-slot 兩條（drop 唔佔 slot、pair 階段唔再製造 drop）。

### 3.1 今次 patch 自己嘅兩個 bug（照記）

* `round2-tick-merges-2026-09-26.apply.js` 嘅 idempotency check 用咗 `a pass's entry is ONE
  request`，但同一輪插入嘅 RUNNING 測試註解**自己引咗呢句** ⇒ script 第二次跑就以為 entry
  test 已落，靜靜地跳過（所以第一次交付時 entry test 根本冇入到）。改為用測試名做 anchor。
* census splice 嘅 replacement 尾係 `  });`（冇 newline），撞落 KEEP marker 令兩個 test
  黏成一行。兩者都喺 script 內加咗 repair 並重跑；352 → 353。

## 4. 落線點驗（deploy 後第一個鐘）

1. `/debug/tick` 或 `/health` 嘅 census：出現 `getWorkerState:<key>`、`setWorkerState:<key>`
   標籤；cold isolate 嘅 boot 由 4 個單讀變一個 `getWorkerStates`（`getWorkerState:axiom_access_token`
   唔應該再係 tick 嘅首位成本）。
2. `pushWatchPass.note` 尾嘅 `trips`：同類 pass 應該比舊形狀低 2（entry 3 → 1，scanner 嘅
   stamp −1）；`rows …/1`、`pairs …/0` 不變。
3. `/health` heartbeat dex 段：`budgetDrops` 應該落到 0–1，而且一旦唔係 0，`dropsByLeg` 會
   點名邊條腿——`boosts` 出現＝optional 腿被正確放棄，`profiles` 出現＝真損失（睇 reuse lane），
   `pairs` 出現＝rotation 尾巴（應該由第 2 條修法清零）。
4. `phase:"running"` 嘅凍結讀數：entry batch 落唔到嘅 pass 會出 note 而唔係 `running`——
   `/debug/push-watch` 見到連續 note 但 row 有動，係已知取捨，唔係卡死。

## 5. 剩返嘅嘢（下一輪素材）

* 一個 tick 而家大概 **13–17** 個 round trip（cold isolate 再 −3）；census 由今日起講得出
  **邊個 key**，所以下一刀應該由 `dbTickSteps` 排頭嗰幾個 entry 揀，而唔係再靠估。
* 未動：alerting row 嘅 per-row 路徑（claim → reserve → send → final write）、
  settle/prune 以外嘅零散 `worker_state` 寫入、HTTP fallback 路徑（`PoolFallbackDb`）。
* `src/worker.ts` 有一行 pre-existing 嘅 jam（`jupiterKeyed = Boolean(…);      if (config.tursoUrl) {`，
  HEAD 已經係咁），同今次改動無關，未動。

落線紀錄：`docs/patches/round2-tick-merges-2026-09-26.apply.js`（worker/db/pushwatch/scanner/
tickprobe ＋ test-unit）＋ `docs/patches/round2-stamp-move-tests-2026-09-26.apply.js`（stamp 轉手
嘅三條 assertion）。dexscreener 嘅三個 drop 修法同 `test-deferred-priority` 嘅兩條 case 由
file tool 直接落（該檔仍在 edit window 內）。
