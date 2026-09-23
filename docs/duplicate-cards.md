# 重複卡片：同一個 transition 送兩次（💀 REK、🚀 POPEYE）

操作員報告（2026-09-21，HKT）：

```
20:39  💀 走死 REK | 峰值 $238.59K → 現 $74.45K (-69%)，轉入靜默監控（收復 $111.67K…）
21:02  💀 走死 REK | 峰值 $238.59K → 現 $59.64K (-75%)，轉入靜默監控（收復 $89.45K…）

18:36 18:39 18:43 18:46 18:49   🚀 續漲 POPEYE | 推送時 $111.01K → $366.65K (+230%) | … 下一關 +400%
```

要求：**唔可以重複收到，但唔可以漏**。

## 一、唔係規則引擎錯，係「送出」錯

同一個 transition 被推導咗兩次（文字唔會逐字一樣，因為卡帶 live 數字），
真正發生兩次嘅係 **send**。follow-up 卡用 `bounded(send, slice, null)` 發，
而 `null` 嘅意思係「我哋唔再等」，**唔係**「Telegram 拒絕」——
request 仲在飛，卡通常已經入咗 chat。tracker 將佢當失敗：
rollback 咗該 row 嘅 announcement bookkeeping（`checkFields(hold)`），
下一個 pass 就重新推導同一張卡再送一次。

### 線上證據（2026-09-21 13:0xZ 讀取）

| 證據 | 讀數 | 意思 |
|---|---|---|
| `push_watch` REK 行 | `lastState:null`、`lastAlertAt:0`、`followupsSent:0`、`upStages:null`、`deadTroughMcap:null`，但 `lastMcap:59635`（＝第二張卡嘅讀數）、`peakMcap:238586`（＝卡上嘅峰值） | **公告欄位全部被 rollback 到 pre-send**（量測欄位照樣前進）——一次 `hold` 寫入嘅指紋 |
| `push_watch` POPEYE 行 | `upStages:"up50"`、`chgSincePushPct:74.2`、`peakMcap:193349`，但卡上寫過 `$366.65K` | 峰值被舊 snapshot 蓋細；mark 亦退返只剩 `up50` ⇒ 至少一次 rollback |
| `/debug/push-audit`（30 筆 ring，約 2h） | 26 張 follow-up 卡，只覆蓋 11 個 token（8 個 token 收多過一張） | 重複係常態，唔係偶發 |
| 同上：message id | ring 由 **2857 → 2902**，中間有 **16 個 id 從缺**（`2884–2890, 2892, 2894–2899, 2901`） | 呢 16 張卡**真係送到 chat**，但冇 audit entry ⇒ 就係 cut send 嘅簽名（cut 路徑唔會 audit）。REK 兩張 💀 都喺缺號之列 |
| POPEYE 卡間隔 3–4 分鐘 | `PUSH_WATCH_COOLDOWN_MIN` 預設 30、下限 5 | 3 分鐘間隔唔可能通過 cooldown ⇒ `lastAlertAt` 確實被 rollback |

## 二、兩個獨立成因

### (A) 🚀 里程碑「降階 walk」

`RISING_STAGES = [50, 100, 200, 400]`，而 loop 由**最高**一級向下找未 mark 嘅：

```
for (let i = RISING_STAGES.length - 1; i >= 0; i--) { if (chg >= stage && !fired) { fire(); firedStages.add(state); break; } }
```

每次只 mark 一級 ⇒ 一次 tick 由 0 跳到 +230% 嘅幣（POPEYE 正是）會跨 3 級，
之後**每個 cooldown window 出一張**，而且係**降序**：
`下一關 +400%` → `+200%` → `+100%`，同一組數字講三次。

### (B) cut send → rollback → 重新公告（💀 同 🚀 都中）

見上。rollback 本身係「at-least-once」嘅設計（寧可重複），
但 cut（唔再等）同 failed（Telegram 真拒絕）係兩件事，
而 cut 之後**冇任何交付證據被留低**——audit 唔寫，所以下一次只能盲送。

## 三、修法

| 位置 | 改動 |
|---|---|
| `WatchAlert` | 每張卡帶 `sig`（transition 身分：`dead`/`revive`/`sell`/`ignite`/`drain`/`liqwarn`/`liqcrash`/`hold`/`div`/`weak35`/`weak45`/`up50`…）。文字做唔到呢件事（帶 live 數字） |
| cut 嘅 rollback | `checkFields(hold, cutSig)` 把 `p:<sig>:<minute>` 寫入 row 自己嘅 mark CSV（`up_stages`）。`addCutMark` 會取代舊 mark（一次只有一張卡在飛） |
| 背景鏈 | cut 之後仍然持有嗰個 request：遲嚟嘅成功會補寫 `kind:"followup"` 嘅 audit entry——**呢個就係 proof**（cut 路徑本來唔 audit） |
| 下一次評估 | `evaluateWatch` 讀到 `p:` mark ＋ audit 有 ≥ 該分鐘嘅 follow-up proof（`deliveredFollowupProofs`）⇒ 該 transition **照樣公告（state、`followupsSent`、`lastAlertAt` 全落地），但唔再送**。pass note 出 `dup-skip N` |
| `p:` mark | 唔係公告記憶：下一次 check 寫入會重算 `up_stages` 而唔會重新加入 ⇒ 一個 attempt 一個 mark，唔會殘留去壓抑**之後**真正新嘅 transition |
| 🚀 walk | 一級觸發時 mark **所有已跨越**級別（`for (let j = 0; j <= i; j++)`）。卡本身已寫「下一關」，所以跨級只公告一次唔會漏資訊 |

## 四、「唔會漏」點保證

* 冇 mark、冇 proof、proof 太舊（早過 attempt）、或者 mark 講嘅係**另一個** sig ⇒ **照送**（fail-open 方向）。
* audit ring 讀唔到（throw）⇒ `followupProofAt` 缺席 ⇒ **唔會即刻送**：該 attempt 如果仲屬於 row 最近一次 check，就延後一個 check（見 §7）；下一個 check 冇 proof 就照送。
* proof 只係「同一 token、同一 sig、時間 ≥ 該 attempt」先算數；30 筆 ring 被 evict 之後就冇 proof，會重送（可能多一張）——同今日嘅 at-most-one-duplicate 一致，但唔會退化成靜默漏卡。
* `p:` mark 讀取成本：只有 rotation head 真有 `p:` mark 時才讀一次 audit ring（1 trip）；一般 pass 零成本。

## 五、驗收點（deploy 之後）

1. `/health` 或 `/debug/tick` 嘅 tracker note 出現 `dup-skip N` ⇒ 有卡被 audit 擋住咗。
2. `push_watch` 行短暫出現 `p:<sig>:<bucket>`（`?limit=200` 見到 `upStages` 帶 `p:`）⇒ cut 有被記錄。
3. `/debug/push-audit` 唔再出現「message id 從缺」：cut 之後嘅遲到成功會補 audit（16 個缺號係修前簽名）。
4. 同一 token 嘅 follow-up 卡唔再喺幾分鐘內重複**同一段文字**；`undelivered` 唔再日日重複同一隻幣。

## 六、未驗 / 已知限制（老實講）

* **已 deploy（2026-09-22 17:29Z）**：`p:` mark 已經線上讀到；`dup-skip` 仲未出現過，原因見 §8.2。
  （呢一段寫嘅時候仍未上線，讀數見 §8。）
* **已修（見 §7）**：proof 已由 token 級改為 per-card（`cardProofKey`）。
* **仍然存在**：一條 row 若一次帶多過一張卡，row loop 只為**被切嗰張**寫 mark，所以該 pass 較早、
  已經送達嗰幾張卡仍可能重新公告（只係少數多卡 row 會撞到；§7.4 已列明修法）。
* cut 後如果遲到嘅 request 真係失敗（reject），冇 proof ⇒ 重送，正確。
* `p:` mark 用**分鐘**做時間桶，所以 proof 只要求「同一分鐘或之後」；同一 token 同一分鐘內兩張**唔同 sig** 嘅卡唔會互相壓抑（sig 一定要相同）。
* 未歸因：嗰 16 個缺號當中，有幾多係 cut 之後**真係送達**、有幾多係根本冇送達——兩者 audit 都空白，要靠修後嘅補 audit 才分得開。

## 七、第二修：attempt 身分 ＋「唔夠證據就等多一個 check」（2026-09-22）

觸發：operator 再問一次「可否改成不會重複發送同一樣的卡」，例子係 Finagotchi ⚠️
流動性跌穿地板 23:36 / 23:48 兩條幾乎一樣嘅訊息（第一修之後嘅線上行為）。

### 7.1 兩個成因（都係「用『冇證據』去做『重送』嘅決定」）

* **proof 係 token 級**：`deliveredFollowupProofs` 舊版每 token 只留最新一個 `at`，
  而一條 row 一個 pass 可以帶幾張卡。分鐘桶之下，**同一分鐘內鄰居卡嘅送到**就足以
  「證明」一張根本冇送到嘅卡 ⇒ 靜默漏卡（比重複更貴）。
* **proof 未寫到就當冇**：cut 嘅定義係「唔再等」，唔係「Telegram 拒絕」；proof 係
  嗰個 request 自己嘅 settle 之後才寫。下一個 pass 若讀唔到（Turso 慢／ring 讀 throw），
  「冇 proof」就會被當成「冇送到」⇒ 即刻重送 ⇒ 就係 operator 見到嘅第二條訊息。

### 7.2 改動

| 位置 | 改動 |
|---|---|
| `deferrallog.cardProofKey(token, sig)` | proof 嘅新 key：**每張卡**（token ＋ transition sig） |
| `deferrallog.deliveredFollowupProofs` | 同一個 audit 讀取，改成 per-card map。未 stamp `sig` 嘅 entry 仍然入 **token key**（粗但唔會比舊版差）：精確 key 只會**增加**精度 |
| `evaluateWatch` 嘅 `fire()` | dedupe 條件：**同一 sig** 嘅 attempt mark ＋ 該卡 proof ≥ mark 時間 ⇒ 公告但唔送 |
| `evaluateWatch` 嘅 `attemptIsCurrent()` | mark 嘅分鐘桶 == `row.last_checked` 嘅桶 ⇒ 呢個 attempt 係「今個 check 之前嗰個 pass」留低嘅 |
| attempt 未證實 ＋ `attemptIsCurrent` | **整個 evaluation 延後一個 check**：唔送、唔公告（`alerts: []`）、量測照樣前進，attempt mark 用**佢自己嘅時間戳**寫返（唔會自己延長自己） |
| `addCutMarks(csv, attempts)` | 一次寫多張 attempt mark（各自保留自己嘅時間戳）；`addCutMark` 係單張版本 |

### 7.3 為咩「等一個 check」唔算漏

* 等嘅條件好窄：**同一個 sig**、**未證實**、**仲屬於 row 最近一次 check**。
* 過咗一個 check 之後（`last_checked` 嘅桶前進），同一張卡照樣會推導出來，**冇 proof 就照送**
  ⇒ 代價只係遲一個 check，唔係漏卡。
* 有 proof 就更簡單：公告（state／`followupsSent`／`lastAlertAt` 全落地）但唔送。
* 冇 check clock（`last_checked = 0`：手寫 fixture、或者被 terminal settle `rearmPushWatchAlert` 清過鐘嘅 row）
  **唔會**行呢條路 —— 冇「剛剛嗰個 pass」可以等。

### 7.4 補完：兩個「未落地嘅一半」＋ pass note 嘅遺棄（2026-09-23）

09-22 個 deploy 只落地一半，原因係 workspace 嘅檔案編輯工具只寫得到檔案**前 ~50KB**（`str_replace`
在深處報 "not found"），而兩處都在深處。今次用 `git apply --recount`（patch 留底在 `docs/patches/`）
逐個落地，共四個改動：

| 改動 | 位置 | 內容 |
|---|---|---|
| row loop 寫**所有** attempt | `src/pushwatch.ts`（`checkFields` ／ row loop） | `cutSig: string \| null` 換成 `attempts: Array<{sig, at}>`：送到嘅卡（成功 send，stamp = **送出前**嘅 `Date.now()`）＋被切嘅卡，一次 `addCutMarks` 寫入 `up_stages` |
| 已證實嘅卡**原封**帶落去 | 同上（`priorMarks`） | `a.deduped` 嘅卡今個 pass 冇 attempt；佢個 mark 用**原本**時間戳帶落去 — 重新 stamp 會令 mark 排喺 proof 之後，反而放返個 duplicate 出嚟 |
| audit entry 帶 `sig` | `src/pushwatch.ts`（成功 send ＋ cut 嘅 late settle）／`src/db.ts`（entry type） | `recordPushDelivery({ …, kind: "followup", sig: a.sig })` ⇒ proof 由 token 級升級到 per-card（§7.2 第一條） |
| pass note 唔再被遺棄 | `src/scanner.ts`（`persistPassNote`） | 由 `Promise.race` 改成直接 `await`（`PUSH_WATCH_PASS_STATE_BOUND_MS` 已刪）：race 輸咗就係放棄個 write，而未 await 嘅 promise 喺 invocation 完結時會被**取消**。09-22 18:09–18:28Z 實測 shape：row 檢查一路跑，note `at` 凍結 19 分鐘。Db 自己已經有 hard wall（`wrapClientWithHardWall`），所以 await 唔會吊死 tick |

`p:` mark 用分鐘桶，所以「同一個 check」嘅判斷有一個 straddle：cut 嗰刻跨分鐘（pass 橫跨 :59 → :00）
就會當成「唔係最近一次 check」，退回舊行為（照送）。量到約一成分嘅 cut。呢個仍然存在。

驗收測試：`PushWatcher: a DELIVERED card is not re-announced when a later sibling is held back (POPEYE)`
（一行 row 一個 pass 帶 🚀＋⚠️，🚀 送到、⚠️ 被 Telegram 拒 ⇒ 下一個 pass 只可以重送 ⚠️）。
Negative control 已實測：反轉 `cut-card-dedupe-all-attempts` ＋ `cut-card-dedupe-attempt-clock` 再 build，
該測試 fail（`the DELIVERED card leaves an attempt mark too: null`），還原後 `269 passed, 0 failed`。

### 7.5 驗收點

1. 同一 token 唔再喺一兩個 pass 內收到**同一張卡**；`dup-skip N` 繼續出現（proof 讀到時）。
2. proof 讀唔到嗰個 pass：`push_watch.upStages` 會保留 `p:<sig>:<bucket>`（**唔會**被新 stamp 覆蓋），
   而 tracker note 見唔到新卡；下一個 check 就會出現 `dup-skip`（proof 到）或者真係送一次。
3. 單元測試：`evaluateWatch: an attempt from the row's last check is not re-sent while its proof is missing`、
   `deliveredFollowupProofs: the newest delivery per (token, sig)…`、`cut marks: …`。

## 八、線上驗收（2026-09-22 18:12–18:26Z，deploy 之後）

Deploy 證據：`5aa4624`（Wait one check for a cut card's proof）嘅
「Deploy Worker to Cloudflare」執行成功（17:29:42Z，1m10s）——部署通道係
`.github/workflows/deploy.yml`（push main → typecheck → unit tests → wrangler），
唔係 Freebuff hosting。

### 8.1 `p:` mark：確認保留（唔會被新 stamp 覆蓋）

`/debug/push-watch?limit=200` 讀到 **8 行** 帶 `p:<sig>:<bucket>`，每行保留自己嘅時間戳：

| row | `upStages` | mark 時間 | 該行 `lastChecked` |
|---|---|---|---|
| MC | `p:dead:29835013` | 18:13:00Z | 18:13:14Z |
| JOLLYBOT | `p:w45:29835019,up50` | 18:19:00Z | 18:19:48Z |
| Transfinance | `p:liqwarn:29834865` | 18:14:00Z | 18:14:31Z |
| CLOUT | `p:liqwarn:29834928,up50,w45` | 16:48:00Z | 18:13:12Z |
| BIRDDOG | `p:dead:29834976` | 17:36:00Z | 18:14:26Z |
| Commotitty | `p:dead:29834963,up100,up50,w45` | 17:23:00Z | 18:17:24Z |
| USDC | `p:w45:29834957,up100,up50,w35` | 17:17:00Z | 18:19:46Z |
| AMD | `p:revive:29834950,up100,…,w35` | 17:10:00Z | 18:09:20Z |

讀取期間 **有新 mark 出現**（MC 18:13、JOLLYBOT 18:19），所以唔係舊行殘留：
cut 寫 mark 呢條路係線上活嘅。（舊 mark 會被**下一次 attempt** 取代 —— `addCutMarks` 語意；
Transfinance 由 `p:dead:29834865` 變成 `p:liqwarn` 就係一例。）

### 8.2 `dup-skip`：未見到，而且讀得出「為咩」

`worker_state.push_watch_pass`（`/health.pushWatchPass`）嘅 note 冇 `dup-skip`：

```
ok:6/0 rows 6/30 pairs 10/10 miss 0 lost 0 budget-cut allow 3024
spend[setup 677/3 heal 231/1 miss0 enrolled0 pairs 274/0 rows 1490/6 holders 0/0 held0 cut4] trips 11
```

`dup-skip` 只喺 `fire()` 內部算（`evaluateWatch` 只喺**同一個 transition 重新推導**時才問 proof）。
而 8 行帶 mark 嘅 row **全部係 terminal 狀態**（`dead` / `rug`：14 dead、14 rug、4 unwatched），
terminal row 唔會再推導同一張卡 ⇒ dedupe 冇機會被評估，mark 就一直留喺 row 度。
最接近觸發嘅係 **JOLLYBOT**：`lastState=up50`、mark 係 current（18:19 桶 == `last_checked` 桶）、
而 audit ring 有 `followup` 18:19:48Z ≥ mark 18:19:00Z ⇒ 佢下一次再推導 `w45` 就會「公告但唔送」
（pass note 出 `dup-skip 1`）。

### 8.3 順手量到嘅兩件事（老實講）

* **proof 仍然係 token 級**：`/debug/push-audit` 30 筆之中 **0 筆**帶 `sig`，
  即係 §7.4 第二條（audit 寫入傳 `sig`）未落地，線上走嘅係 token fallback。
  精度少一半，但方向仍然係 fail-open（多送一張，唔會靜默漏）。
* **durable note 有停滯**：note 由 18:09:23Z 起冇再更新，而 row 檢查一路做到 18:19:48Z
  （pass 明顯有跑）——`persistPassNote` 嘅 900ms race 輸咗；同一時段仲有一 tick 死喺 18:22
  （110s，下一個 tick backfill）。所以 `dup-skip` 可能發生過而未入到 note，
  驗收要直接睇 row 嘅 mark ＋ audit proof（8.1／8.2 就係咁讀）。
* **mark 喺 terminal row 會長留**：`p:` mark 只在分支重算 `up_stages` 時才被清
  （revive 寫 `""`、stage 寫 `marks`），`dead` 分支回 `announcedUpStages: undefined`（保持原狀），
  所以 §3「一個 attempt 一個 mark」對 terminal row 唔成立：mark 一直留到該 row 再 fire 同一個 sig。
  代價係每次 pass 多一次 audit ring 讀（head 有 mark 就讀），同一個「同 sig 再 fire」有機會被舊 proof 擋。

## 九、留底

`docs/patches/`：`cut-card-dedupe-proof`（audit proof helper）、`cut-card-dedupe-engine`（sig／mark／fire ／🚀 walk）、
`cut-card-dedupe`（tracker：proof 讀取、dedupe skip、背景 audit、cut mark 寫入）、`cut-card-dedupe-optional`、
`cut-card-dedupe-tests`、`cut-card-dedupe-behaviour-tests`（兩條既有測試斷言隨行為改變更新）。
六個 patch 依序 `git apply` 可重建整個改動，反向亦可還原到 HEAD。

第二修嘅補完（09-23，依序 `git apply --recount`）：`cut-card-dedupe-all-attempts`（row loop：所有 attempt
一次寫入 ＋ 已證實嘅卡原封帶落去）、`cut-card-dedupe-audit-sig`（audit entry type 加 `sig`）、
`cut-card-dedupe-attempt-clock`（把 attempt 時鐘讀提升到 terminal／非 terminal 分支之上，兩條路都用到）、
`pass-note-awaited`（scanner：note 由 race 改 await）、`cut-card-dedupe-popeye-test`（regression test）。
反向 `git apply -R` 亦實測過（negative control）。
