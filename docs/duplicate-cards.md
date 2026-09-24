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
  **2026-09-24 收窄**：冇 mark 但 audit 有**同一個 sig** 嘅 proof、而且個 proof 落喺 row 自己
  `last_checked` 嘅分鐘桶（或下一個）之內 ⇒ 照樣公告但**唔送**（＝舊有 cut-mark 規則同一把尺，延伸到
  「已送達」嗰種），suppress 嘅同時**補寫返 mark**。見 §十九。
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
* **已修（見 §十九）**：`fire()` 以前**只喺有 cut mark 時**才查 audit proof，所以「已送達但 mark 冇落地」
  嘅卡會重送。
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

## 八、線上驗收（deploy 之後）

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

### 8.4 補完部署後嘅線上讀數（2026-09-23 00:07–00:12Z，`9682d9c`）

Deploy：「Deploy Worker to Cloudflare」成功（run 35800552243，00:06:28Z 開始，1m8s）。

| 驗收項 | 讀數（`/health`、`/debug/push-watch?limit=200`、`/debug/push-audit`） | 結論 |
|---|---|---|
| `p:` mark 保留 | 58 行之中 **11 行**帶 `p:<sig>:<bucket>`，每行保留自己嘅時間戳，同 stage mark 並存（例：`p:w45:29835333,up100,up50,w35`） | ✅ 冇被新 stamp 覆蓋 |
| pass note 唔再停滯 | note `at`：00:07:18Z → 00:09:17Z → 00:10:18Z → 00:11:18Z（`trackerMs` 4.0–4.2s），每個 pass 之後都前進（09-22 同一個位置曾經凍結 19 分鐘） | ✅ 前進；惟 00:08 嗰分鐘冇新 note，未排除係該 tick 本身冇行 tracker pass（唔係「寫入被取消」嘅已知形狀，但單靠呢次讀數分不到） |
| audit entry 帶 `sig` | `/debug/push-audit` 30 筆**全部早過** deploy（最新 00:06:17Z，26 筆 followup）⇒ 0 筆帶 `sig` 係預期。deploy 之後嘅 pass 一律 `alerted 0`，未有新 followup 卡 | ⏳ 等下一張 followup 卡（呢條路由 §7.4 嘅 unit test 鈞住：`delivered[0].sig === "up100"`） |
| `dup-skip` | note 冇 `dup-skip`；`ok:10/0`（10 行檢查、**0 卡**）。58 行之中 51 行 terminal，7 行 active 但**冇一行帶 attempt mark** | ⏳ 請不到：dup-skip 要「同一 transition 重新推導」，terminal row 唔再推導、active row 沒 mark ⇒ 現時結構上冇機會出現 |
| 一個 pass 多張卡嘅 mark | 暫未量到（冇 row 帶 2＋ 個 mark）：要等一條 row 一個 pass 帶 🚀＋⚠️ 而中途被切／拒 | ⏳ unit test 已針住，negative control 反轉 patch 會 fail（§7.4） |

睇 `dup-skip` 嘅正確方法（唔係只睇 note）：某行 fire 同一張卡之後，row 仍然帶 `p:<sig>` 而 `followupsSent` 冇升。

### 8.5 一個 pass 出多張卡，係幾時嘅事（2026-09-23 分析）

* 一個 pass **最多只出一張 🚀**（stage walk 有 `break`），而 💀／💧 係 terminal 而且只有一張。所以要 2 張
  就一定係**跨分支**：🚀 ＋（⚠️ weak ／ 📈 holders ／ ⚡ div ／ 🩸 sell-pressure）。
* 「🚀(S) ＋ ⚠️」需要 **`peak/push ≥ (1+S/100)/0.65`**（S=50 → 2.31、100 → 3.08、200 → 4.62、400 → 7.69），
  而且該 ⚠️ mark 未被用過。用真引擎驗過（push $100K／peak $400K，ratio 4.0）：mcap $205K 出 `["up100","w45"]`、
  $230K 出 `["up100","w35"]`；ratio 2.0 或者 ⚠️ mark 已用 ⇒ 只出 1 張。
* 線上 17 條 active row（~00:2xZ payload，mcap 掃 0.3×–4× push、liquidity 用 row 儲存值）：**0 條**出得到 2 張。
  其中 4 條（inu、F-35、BM、BOP）嘅 🚀／⚠️ mark 全部用盡（只剩 💀）；最近嘅係 UPTOBER（ratio 2.27 vs 需要 3.08）。
* 即係話：呢個 fix 係為 **POPEYE 型**（推送 → 大幅拉升 → 回落：曾經真出現過）而設，唔係現時常態。
* 多 mark 嘅形狀（用真 `PushWatcher` 造：一個 pass 一張送到、一張被切）：
  `upStages = p:up100:29835382,p:w35:29835382` — 每張卡各自 `p:<sig>:<分鐘桶>`，同一 pass 所以桶相同，
  逗號排序（`p:` 在最前，跟住 stage mark）；送到嗰張嘅 audit entry 帶 `sig: "up100"`。

## 九、留底

`docs/patches/`：`cut-card-dedupe-proof`（audit proof helper）、`cut-card-dedupe-engine`（sig／mark／fire ／🚀 walk）、
`cut-card-dedupe`（tracker：proof 讀取、dedupe skip、背景 audit、cut mark 寫入）、`cut-card-dedupe-optional`、
`cut-card-dedupe-tests`、`cut-card-dedupe-behaviour-tests`（兩條既有測試斷言隨行為改變更新）。
六個 patch 依序 `git apply` 可重建整個改動，反向亦可還原到 HEAD。

第二修嘅補完（09-23，依序 `git apply --recount`）：`cut-card-dedupe-all-attempts`（row loop：所有 attempt
一次寫入 ＋ 已證實嘅卡原封帶落去）、`cut-card-dedupe-audit-sig`（audit entry type 加 `sig`）、
`cut-card-dedupe-attempt-clock`（把 attempt 時鐘讀提升到 terminal／非 terminal 分支之上，兩條路都用到）、
`pass-note-awaited`（scanner：note 由 race 改 await）、`cut-card-dedupe-popeye-test`（regression test）。
第三修（09-23，見 §11）：`cut-card-proof-held`（cut／terminal 嘅 proof 由 fire-and-forget 改成 tick 嘅 waitUntil 代持，
terminal settle 嘅 audit entry 補上 `sig`）——同前面幾塊一樣係獨立 patch，`git apply --recount` 可重播，`-R` 可還原。
反向 `git apply -R` 亦實測過（negative control）。

## 十、唔會漏卡嘅完整檢查（2026-09-23，`b77f7eb`）

問題係 operator 嗰句：**已完成嘅改動會唔會令卡漏推**（合資格幣嘅推送 ＋ 跟進卡）。方法係逐條
「唔送」嘅出口驗，再喺線上量 mark 同 proof 嘅實際形狀。

### 10.1 合資格幣嘅推送路徑：改動碰唔到

* `git log --name-only`（`0eb053d` → `b77f7eb`）只改 `src/pushwatch.ts`、`src/deferrallog.ts`、
  `src/db.ts`（audit entry 加 `sig`）、`src/scanner.ts`（**只有** `persistPassNote`）、`scripts/test-unit.js`
  同 docs —— 冇一個 scan／gate／push 嘅檔案。
* `persistPassNote` 嘅唯一呼叫者係 `Scanner.runTrackerPass`（1787／1810／1824），而 `worker.ts:2470`
  喺 **completion flush 之後**才叫佢（flush 2309–2440）⇒ scan 嘅推送結果已經落地，note 等幾耐都只係
  蝕自己嗰行 telemetry（連 tail 都蝕埋嘅話，下一 tick 重寫）。線上支持：note `at` 01:06:26Z、
  `trackerMs 4821`、`rows 8/30 miss 0 lost 0 budget-cut`。

### 10.2 跟進卡：每一個「唔送」都要求同一張卡嘅交付證據

| 出口 | 觸發條件 | 卡會去邊 |
|---|---|---|
| `deduped`（公告唔送） | 有 `p:<sig>` attempt mark **＋** 同一 token 同一 sig 嘅 proof ≥ mark 時間 | 唔送；但張卡一個 cut 之前已經入咗 chat（transition／`followupsSent`／`lastAlertAt` 照落） |
| 延後一個 check | mark 屬於 row 最近一次 check（同一分鐘桶）而 proof 未讀到 | 唔送唔公告、量測照行；mark 用**自己**時間戳寫返（唔會自己延長）⇒ 下一個 check 冇 proof 就照送 |
| rollback | 卡被切／timeout／throw／send slice 用盡 | `undelivered` ＋ make-up 集合；公告欄位回捲 ⇒ 下一 tick 重新推導 |
| terminal abandoned | 💧 卡唔再等 | tracked state 保留 ＋ durable unconfirmed 記錄 ⇒ 冇 proof 就 re-arm 重推 |
| proof 讀唔到（ring throw／`getPushAudit` 缺席） | — | 當「冇證據」⇒ 照送（fail-open） |
| proof 舊過 mark、或者另一個 sig | — | 照送 |

唯一「唔送」嘅出口係 `deduped`，而佢**必須**有一張同 card 嘅 proof；掉返轉，所有失敗路徑都終結於「送」。

### 10.3 mark 嘅壽命：舊 mark 壓抑唔到新卡

* **active row**：stage／weak／liq／div 一整段都喺 `if (cooledDown)` 內，而 `announcedUpStages = csv` 嘅
  比較係同 `row.upStages`（**連 `p:` 一齊**）比 ⇒ 只要 CSV 有 `p:` mark，第一個過咗 cooldown 嘅 check
  就會寫返個唔含 `p:` 嘅 column，mark 用一次就冇。cooldown 之內根本冇卡 fire（🩸 例外，但佢有 1h pace，
  走唔出 mark 嘅生命期）。
* **terminal row**：`dead` 分支回 `announcedUpStages: undefined`（COALESCE 保留原狀），所以 mark 會長留 ——
  但同一個 sig 要再 fire 一定要經 `revive`，而 `revive` 寫 `""` 清空 column。所以「舊 mark ＋ 舊 proof」
  壓抑「新 transition」呢條路走唔通。
* 實測（01:0xZ，12 個活 `p:` mark）：最舊 451 分鐘（BIRDDOG），全部係 terminal row。

### 10.4 一個真正 fail-closed 嘅窄縫（已量度，已自行收窄）

`proofFor(sig)` 嘅 token 級 fallback 只喺 **exact key 缺席**時被問，所以同一 token 嘅**另一張**卡（唔同 sig、
entry 冇 `sig` —— 即 deploy 前寫落）喺 ≥ mark 桶嘅時間送到，就可以「證明」一張根本冇送到嘅 cut 卡 ⇒ 靜默漏。
呢個正係 §7.1 指名嘅 bug，只係為 legacy entry 而保留（§7.2）；方向唔係保證 fail-open。

線上量度（01:0xZ）：12 個 mark 之中 **2 個** 嘅桶舊過同一 token 嘅 sig-less entry —— UAP `w45`（桶 23:33 vs
entry 23:56:15）、kirkinu `dead`（桶 23:30 vs 23:55:15）—— 但兩條都 `lastState=dead`，同 sig 唔可能再 fire
（見 10.3）⇒ **實際暴露 0**。而且所有 sig-less entry 都係 deploy（00:06:28Z）之前寫嘅（最遲 00:06:17Z），
ring 30 筆一轉就冇，新 entry 一律帶 `sig`（見 10.5）⇒ 窄縫會自己閂。改走呢個 fallback 會令 ring 裡面嗰 17 張
冇 `sig` 嘅卡即刻冇得 dedupe，所以唔改。

### 10.5 §8.4 掛住嗰個 ⏳ 落實：audit 帶 `sig`

`/debug/push-audit`（01:06Z）：30 筆之中 28 張 followup，**11 筆帶 `sig`**（`w35`、`revive`、`liqwarn`、
`ignite`、`up100`、`dead`），全部係 deploy 之後寫嘅 ⇒ §7.4 第二條線上落地，新卡嘅 proof 由 token 級升級到
per-card。`dup-skip` 仍然未出現，而且讀得出為咩：12 個活 mark 之中 **0 個**有 exact proof（＝未有嘗試喺
「proof 已到」嘅情況下被重新推導）—— 同 §8.2／8.4 一致。

### 10.6 測試

* `npm run build`（tsc）：0 error。
* `node scripts/test-unit.js`：**269 passed, 0 failed**（含 POPEYE regression、cut-mark、
  `deliveredFollowupProofs`、attempt-clock）。
* `node scripts/test-deferred-priority.js`：pass。`node scripts/test-tick-path.js`：pass
  （含 `card-send outcome (cut / delivered / deferred)`、`duplicate-card counter (audit ring → heartbeat)`）。

### 10.7 結論

冇發現需要修嘅漏卡路徑，所以呢次落地嘅只有呢份記錄（10.4 嘅窄縫係 legacy entry 限定、方向已知、已自行收窄）。

## 十一、`dup-skip` 為何一直未出現，同一個真正觸發得到嘅場景（2026-09-23，`b77f7eb` ＋ `cut-card-proof-held`）

問題係 operator 嗰兩句：**再查一次 `dup-skip` 未出現嘅原因**，同 **設計一個可以喺線上真正觸發 dedupe 嘅場景**。

### 11.1 四個條件，斷喺邊一個

`deduped` 要同時成立四件事：

| # | 條件 | 現狀 |
|---|---|---|
| A | 一張卡被 **cut**（send slice 用完）而寫低 `p:<sig>` mark | ✅ 有（12 個活 mark）——但 cut 本身罕有：要 Telegram 一次 send 慢過 350–1000ms |
| B | 同一個 sig 喺**之後**嘅 check 被重新推導 | ❌ **主因**：11/12 個 mark 都坐喺 `lastState=dead` 嘅 row（💀 已經落地，silent-watch 唔會再推同一個 sig，只有 `revive` 會清 column）——即 §8.2 嗰個原因，仍然成立 |
| C | proof 真係寫入 audit ring | ❌ **新發現，真正嘅阻塞點**：cut 路徑嘅 proof 係 `void inFlight.then(...)`（`pushwatch.ts`）——**一個喺 pass 尾端建立、冇人 await 嘅 promise**。Cloudflare 喺 handler return 嗰刻會取消未 await 嘅 promise，repo 自己為咗同一件事整咗 `tickWaitUntil`（註釋：deferred writes 冇佢之下 100% 失敗）⇒ proof 通常根本冇寫入 |
| D | proof 係 per-card | ❌ terminal（💧）卡嘅背景 settle 寫 audit entry 時**冇帶 `sig`** ⇒ 只入 token key（粗），精準唔到 |

量到嘅讀數（01:0xZ）：12 個活 `p:` mark，**0 個**有 exact proof。最硬嘅一個樣本係 **PICKAXE**：
mark `p:revive:29835415`（00:55）**完全在 ring 窗口（23:50–01:06）之內**，而 ring 裡面一個 PICKAXE entry 都冇
——即係「request 真係冇送達」或者「送達咗但冇 audit」，両者都指向同一個結論：**cut 卡嘅 proof 信唔過**。
跟住嘅連鎖反應就係 operator 見到嗰個重複：冇 proof ⇒ `deduped` 永遠唔會 true ⇒ 下一個 check 照送。

### 11.2 修法：`docs/patches/cut-card-proof-held.patch`

| 位置 | 改動 |
|---|---|
| `src/pushwatch.ts` | 新增 `keepAliveForTick` ＋ `holdForTick(promise)`（有 hand-off 就交出去，冇就照舊 fire-and-forget） |
| 同上（cut 路徑） | `void inFlight.then(...)` → `const proof = ...` ＋ `this.holdForTick(proof)` |
| 同上（terminal settle） | 背景鏈一樣改成 `settle` ＋ hold；audit entry 補上 `sig`（＝ `drain`）⇒ D 補完 |
| `src/scanner.ts` | `runTrackerPass(deadlineMs, keepAlive?)` 原有參數不變（可選），一路傳落 `runTick` |
| `src/worker.ts` | 呼叫時傳 `tickWaitUntil`（cron 路徑一定有）。**限制**：`tickWaitUntil` 只在 `scheduled` 內被設；由 HTTP 觸發、而之前未受過 cron 嘅 isolate 係 null ⇒ 退回火-and-forget（deferred writes 今日一樣有呢個限制，唔係新問題） |
| `scripts/test-unit.js` | 新測試：cut 卡嘅 proof promise **真係交咗給 tick**，`await Promise.all(held)` 之後 audit 才落地；冇 hook 時行為不變 |

方向：呢個改動只令「已經發生嘅 rollback＋mark＋re-announce」嗰筆**記帳**落得實，**唔會改變 pass 任何一個決定**
（唔會多送、唔會少送）⇒ 冇新增漏卡方向；失去它只會賠一張重複卡，即係現狀。

### 11.3 一個真正可以喺線上觸發嘅場景

要四個條件同時成立。最現實嘅入口唔係「一個 pass 帶兩張卡」（§8.5：現時 0 條 row 做得到），而係**任何一個 cut 之後嗰條 row 嘅 transition 仍然可推導**：

1. 一條 **active** row（`lastState` 唔係 `dead`／`rug`／`expired`／`unwatched`）；
2. 佢喺某個 pass 被 cut ⇒ `up_stages` 出現 `p:<sig>:<bucket>`；
3. 該 sig 仲可以 re-derive（`dead`：`lastState` 未係 `dead`；`w45`：drawdown 仍 ≤ -45%；`drain`：仍然 sub-floor）；
4. 下一個 check 之前 Telegram 答咗 ⇒ proof 入 ring（修完之後由 `tickWaitUntil` 保證）。

**驗收讀法（唔可以只睇 note）**：

| 讀邊度 | 要見到 | 意思 |
|---|---|---|
| `/debug/push-audit` | 一條 `followup`，`token`＝該 row、`sig`＝該 mark 嘅 sig、`at` ≥ mark bucket | proof 落地（C/D 修好） |
| `/debug/push-watch?limit=200` | 下一個 check 之後：`upStages` 冇咗 `p:`（mark 被消費）、`lastState` 變成該 sig 嘅狀態、`followupsSent` **升 1**（公告落地）——而該 `(token, sig)` 嘅 audit **冇新 entry** | 公告但冇送 ⇒ dedupe 真正觸發（`followupsSent` 係**公告**計數，唔係送出計數） |
| `/health.pushWatchPass.note` | 該 pass 出現 `dup-skip 1` | 計數器（note 已不再被遺棄，所以睇得到） |

**實際操作**：每 1–2 分鐘拉一次 `/debug/push-watch?limit=200`，揀出「有 `p:<sig>` 而 `lastState` ≠ 該 sig 對應狀態」嗰條 row
（例如 `p:dead` 但 `lastState` 係 `null`/`weak`/`up*`）＝候選；跟住嗰 2–3 個 check 就係睇 audit 有冇該 `(token, sig)`、
row 有冇被 announce 而冇送。cut 大約每小時一次（12 個 mark／十幾小時），所以候選唔會等太久。

**Offline 對照（已 pin）**：`PushWatcher: a CUT card's proof is HANDED to the tick, so the invocation cannot cancel it`（新）、
`evaluateWatch: an attempt from the row's last check is not re-sent while its proof is missing`、
`PushWatcher: a CUT card leaves a mark, a late send proves itself, and the next pass refuses the duplicate`（Pass 2 就係 `dup-skip 1`）。

### 11.4 測試

`npm run build` → 0 error；`npx tsc --noEmit` → 乾淨；`node scripts/test-unit.js` → **270 passed, 0 failed**（新增一條）；
`test-deferred-priority.js` → pass；`test-tick-path.js` → pass。

### 11.5 線上驗收：第一張 post-deploy cut 已經觸發到 dedupe（09-23 01:39–01:48Z，`43bb323`）

Deploy：run **35805867249** success，**01:21:27Z 上線**。第一張上線後嘅 cut 係 **REALLY**（`HraqV71u`）嘅 `revive`：

| 步驟 | 讀數 | 意思 |
|---|---|---|
| 1. cut 寫 mark | `push_watch.upStages = p:revive:2983569x`（桶 01:39）、`lastState=dead`、`fu=1` | cut 有被記錄 |
| 2. proof 入 ring | `/debug/push-audit`：`01:39:45Z followup sig=revive msgId=3840`（**exact card key**） | **`holdForTick` 真係令 proof 落到地**（修前 12 個 mark 全部冇 proof） |
| 3. 下一個 check 重新推導 | 01:46:16Z：`lastState` dead→`null`、`followupsSent` 1→2、`lastAlertAt` 落地、`upStages` 清空 | 公告落地、mark 被消費 |
| 4. 冇再送 | `(HraqV71u, revive)` 嘅 audit entry **仍然只有 1 條**（01:39:45） | **第二次公告冇送出 ⇒ dedupe 真正觸發** |

這四個讀數只有一個路徑解釋得到：`deduped`（送出失敗會 rollback 令 mark 及 `lastState` 留住；cut 會寫新 mark；
真送會多一條 audit entry）。即係 §7.2 嗰個設計終於在線上生效，同時 **冇漏卡**（唯一一張 revive 卡早在 01:39:45 已入 chat）。

**惟要注意：嗰個 pass 嘅 note 沒寫入。** 01:45:14Z 之後直接跳到 01:47:26Z，中間 01:46:16Z 嗰個 pass（就係 dedupe 嗰個）
冇持久化 note，所以 `dup-skip 1` 冇痕跡。呢個就係 §8.3／§10.1 嗰個間歇性凍結（本次讀到凍結 01:36:25Z→01:45:14Z，
row 檢查一路跑到 01:43），**已 deploy 嘅 `pass-note-awaited`（改 await）未能完全解決**。結論同 operator 講嘅一樣：
**驗 dedupe 要直接睇 row mark ＋ audit proof，唔可以只睇 note**。

## 十二、straddle 收窄：跨分鐘嘅 attempt 一樣算「最近一次 check」（2026-09-23，`cut-card-straddle-hold`）

問題：§7.4 尾段量到約一成分嘅 cut 跨分鐘（pass 由 :59 跑落 :00）。`p:` mark 用**分鐘桶**存
（`cutMarkFor` 截斷），而 `last_checked` 係寫 mark 嗰個 pass 嘅**精確** claim 時間，所以跨分鐘嗰個
attempt 嘅桶會係自己 pass 時鐘嘅**下一個**桶。舊 gate（桶相等才叫 current）就當佢係「更早嘅一個 pass」
⇒ 跳過「等一個 check」，而嗰張卡嘅 late proof 仲喺飛 ⇒ 照送 ⇒ 就係最後一條已知重複路徑。

改動（`src/pushwatch.ts`，`attemptIsCurrent`）：桶相等 **或** 係下一個桶
（`attemptBucket === checkBucket || attemptBucket === checkBucket + 1`）。
呢個係 straddle 嘅 slop，**唔係**「放寬窗口」：attempt 一定發生喺自己 pass 嘅 claim **之後**，
所以只有呢兩個桶可能裝住該 row 最近一次 attempt；再早一個 check 嘅 attempt（包括 dedupe 原封帶落去嗰個 mark）
都係落後兩個桶以上 ⇒ 照舊判斷。`last_checked = 0`（fixture／terminal settle 重 arm 過嘅 row）唔會誤中：
真 mark 嘅桶係幾千萬，唔會等於 0 或 1。

代價：跨分鐘嗰次最多等兩個 check（同「同桶」規則本身一樣 —— 等 `last_checked` 嘅桶行過個 mark），
唔會漏卡：過咗之後冇 proof 就照送。呢個 patch 唔改任何送／唔送嘅**出口**，方向仍然 fail-open。

驗收（offline，已 pin）：

* 新測試 `evaluateWatch: an attempt that straddles the minute IS the row's last check`：fixture 真跨分鐘
  （claim 桶 = attempt 桶 − 1）⇒ 冇 proof 時 defer（`alerts: []`、mark 原封、量測照行）；proof 到 ⇒
  `deduped`（公告唔送）；再過一個桶 ⇒ 照送（等嘅時間有界）。
* Negative control：`git apply -R --recount --include=src/pushwatch.ts docs/patches/cut-card-straddle-hold.patch`
  之後 `npm run build`，該測試 fail（`no card while the straddling attempt is unproven`，270 passed / 1 failed）；
  還原後 **271 passed, 0 failed**。
* `npx tsc --noEmit` 0 error；`test-deferred-priority.js`、`test-tick-path.js` pass。

線上讀數（02:11–02:15Z，`152523b` 之後，即係 commit／push／deploy 前）：

| 讀邊度 | 讀數 | 意思 |
|---|---|---|
| `/health.pushWatchPass` | note `at` 02:11:23Z → 02:14:25Z（`trackerMs` 3.9–4.4s），該 pass `ok:10/0 … cut4` | 冇停滯（§11.5 嗰段凍結今回讀唔到）；冇 `dup-skip`（該 pass 0 張卡） |
| `/debug/push-watch?limit=200` | 55 行之中 **6 行**帶 `p:` mark，**全部** 坐喺 `lastState=dead` 嘅 row（5 × `p:dead`、1 × `p:liqwarn`） | 冇 dedupe 候選：`dead` 分支吸收一切（只有 `revive` 會再推導，而 revive 寫 `""` 清 column） |
| `/debug/push-audit`（30 筆 ring） | **23 筆**帶 `sig`（7 筆冇，全部係 00:06:28Z deploy 之前寫落），含 01:39:45Z `HraqV7 revive` | §7.4 第二條線上落地；§11.5 嗰次 dedupe 嘅 proof 仍然係 `(token, sig)` 唯一一條 |

留底：`docs/patches/cut-card-straddle-hold.patch`（`src/pushwatch.ts` 嘅 `attemptIsCurrent` ＋ 新 unit test），
`git apply --recount` 可重播，`-R` 可還原（兩種方向都實測過）。

## 十三、第二次線上 dedupe，而 note 讀得到 `dup-skip 1`（2026-09-23 02:17Z）

`93148ee` push 之後（deploy run 35810030834，02:22:43Z 完成）第一個讀數，影到嘅係 deploy 前最後幾個 pass；
其中 **02:17:26Z** 嗰個 note 第一次帶住 `dup-skip`：

```
ok:9/2 rows 9/30 pairs 10/10 miss 0 lost 0 dup-skip 1 recovered 1 budget-cut allow 5000 spend[…] trips 18
```

即 §11.3 第三個讀法（note 出 `dup-skip 1`）落實，而且係第二次真正觸發（第一次係 §11.5 嘅 REALLY `revive`，嗰次 note 冇入到）。

被 dedupe 嘅 row：**PICKAXE**（`6QxMcE…`）：

* `lastAlertAt` 02:17:20Z（該 pass 公告咗）、`upStages` 只剩 `up50`（`p:` mark 已被消費）、`followupsSent = 2`；
* `/debug/push-audit` 只得兩條：`01:16:24Z revive`、`02:13:25Z up50 msgId 3848` —— 02:17 嗰個 pass **冇**新 entry。
* 讀法：02:13:25Z 嗰張 up50 卡係 **cut**（audit entry 係嗰個 request 自己嘅 late settle，就係 §11.2 嘅形狀，
  所以 `followupsSent` 冇當佢送過），rollback 寫低 `p:up50:<02:13 桶>`；02:17:20Z 同一個 transition 被重新推導，
  proof（02:13:25 ≥ mark 桶）已到 ⇒ 公告但**唔送** ⇒ `dup-skip 1`。chat 冇重複卡，亦冇漏（卡早喺 02:13:25 入咗）。

同一個 pass 嘅另一張卡（**JOLLYBOT** `9Vkx8J`、`revive`）係**真送**：audit 02:17:22Z msgId 3849、`lastState` → null、
`upStages` 清空 —— 即兩條路（送／唔送）同一個 pass 一齊出現，note 都數得到（`ok:9/2`）。

**惟 note 之後又停**：02:23:09Z 讀 `/health` 時 note 仍然係 02:17:26Z，而 row 檢查已經做到 02:19:08Z
（Commotitty、BULLFART）⇒ §8.3／§11.5 嗰個間歇性凍結再現（今次係 02:17:26Z 之後）。所以 §11.3 嘅結論唔變：
**驗 dedupe 要睇 row mark ＋ audit proof，note 只係加分。**

**下一張 post-deploy（`93148ee`，02:22:43Z 上線）嘅 cut 仍然要盯**：候選＝任何 `lastState` 唔係 `dead`／`rug`、
而 `upStages` 帶 `p:<sig>` 嘅 row（straddle 修好之後，跨分鐘嗰啲都會行「等一個 check」，verdict 只會更準）。

## 十四、pass note 為何仍然停：note 係 pass 嘅最後一個寫入（2026-09-23 02:36–02:48Z）

答案唔係「寫入被取消」——§7.4 已經修好嗰個 race；而係 **note 係 tracker pass 嘅最後一步**：
pass 冇行完，就冇人寫 note。而 pass 有兩種「行唔完」，今次一次凍結裡面兩種都實測到。

### 14.1 兩個實測形狀

`02:36:26Z` 起 note `at` 凍結，一路到至少 `02:47:54Z`（11 分鐘以上）。同一段時間嘅讀數：

| 讀數 | 值 | 意思 |
|---|---|---|
| `scan_history` 02:37–02:41 | 連續 **5 行** `ok:false ms 11500`，err `scan exceeded its 2500ms race window (… preRace 9000ms = json 0 + claim 3000)` | **形狀 A**：tick 喺 pre-race 就燒掉 9 秒（撞硬牆嘅 Turso round trip，硬牆＝1.2×2500＝3000ms），race 只剩 2500ms 下限，成個 tick 11500ms ⇒ `trackerBudgetMs = 9500 − 1000 − 11500 < 0` ⇒ **pass 完全冇開始**，worker 亦冇寫任何嘢 |
| `scan_history` 02:45:13 | `ok:true ms 4179`（**成功** tick）而 note `at` 仍然 02:36:26Z | **形狀 B**：tick 成功、pass 有開始，但 note 冇更新 |
| `push_watch` 02:45:13 | 只有 **SRI 一行** `lastChecked 02:45:13Z`（＝該 tick 嘅 claim 時間），其餘行仲係 02:36:22／02:35:22 | pass 行到第一行（row 自己嘅寫入落地），之後就冇咗 ⇒ 第一行食盡成個 pass |

形狀 B 嘅機制：row loop **只在行與行之間**檢查預算（`if (!firstRow && Date.now() + TRACKER_ROW_MIN_MS > deadline) break;`），
而一行嘅鏈（pair、claim、alert reservation、send、delivery audit、final check write）係最多五個 Turso round trip，
scan mode 之外每個硬牆 3000ms ⇒ **單單一行就可以超成個 tick**。pass 冇 return ⇒ `persistPassNote` 冇跑 ⇒ note 停，
但嗰一行自己嘅寫入照樣落地 ⇒ 睇落似「row 檢查一路做、note 一路停」。

即係話 note 凍結唔等於寫入失敗，而係「pass 冇行完」嘅症狀；§8.3／§11.5 教「唔可以只睇 note」係對嘅，
但唔應該要人繞路讀。

### 14.2 修法：note 由「一個尾寫」變成「三個相位」（`docs/patches/tracker-pass-note-phases.patch`）

| 位置 | 改動 |
|---|---|
| `src/scanner.ts` `persistPassStart()` | pass 落**第一步之前**先寫 `{at, note:"running", trackerMs:0, phase:"running"}`：一行都未掂就已經證明自己開始咗 |
| `src/scanner.ts` `persistPassNote(note, startedAt, phase)` | 完成時寫 `phase:"done"`（同舊行為一樣，只多一個欄位） |
| `src/scanner.ts` `noteTrackerSkipped(reason)`（public） | 冇預算開 pass 就寫 `{note:"skip:<reason>", phase:"skip", trackerMs:0}` |
| `src/worker.ts` | `trackerBudgetMs <= 0` 嘅分支叫 `noteTrackerSkipped(\`tick ${lastScanMs}ms[ timed-out]\`)` ⇒ 形狀 A 唔再「靜」，而係明講呢個 tick 冇跑到 pass |

修完之後嘅讀法（`/health.pushWatchPass`、`/debug/scan-history.pushWatchPass`）：

* `phase:"running"` ＋ 新鮮 `at` ⇒ pass 進行中（一個 tick 內正常會變 `done`）；
* `phase:"running"` 而 `at` 原地停留超過一兩個 tick ⇒ pass 卡死喺某一行（形狀 B），而 `at` 本身講得出幾點開始卡；
* `phase:"skip"` ＋ `note:"skip:tick 11500ms timed-out"` ⇒ tick 燒爆 envelope，pass 冇開；
* `at` **完全唔動**（連 running／skip 都冇）⇒ invocation 喺 tick tail 之前就死咗 —— 呢個係唯一 note 幫唔到嘅情況，
  而 `heartbeat`／`scan_history` 本身已經睇得到。

`phase` 係新增欄位，舊讀者（只讀 `at`／`note`／`trackerMs`）唔受影響。

### 14.3 測試

`Scanner.runTrackerPass: the note row is stamped RUNNING before the pass works, and a skipped tick still moves it`：
由 `runTick` 內部讀寫入記錄，證明 **running stamp 喺 pass 做任何嘢之前已經落地**，並針住 `done`／`skip` 兩個相位同 `trackerMs`。

Negative control 實測：只反轉 `src/scanner.ts` ＋ `src/worker.ts`（保留測試）再 build ⇒ `271 passed, 1 failed`
（`the running stamp must land BEFORE the pass does any work`），還原後 `272 passed, 0 failed`。
`test-deferred-priority.js`、`test-tick-path.js` 一樣 pass；patch 反向 `--check` 確認同 working tree 一模一樣。

### 14.4 仍未收（老實講）

* 形狀 B 嘅**根因**（一行食盡成個 pass）冇改：note 只係由「睇唔到」變成「睇得到」。收窄應該係一行內部都檢查預算，
  或者將每行嘅 Turso 鏈限制喺一個 slice 內 —— 但嗰個改動會碰 claim／send 嘅時序，唔應該混喺 note 修復度做。
* 形狀 A 嘅根因（pre-race 9 秒）係 Turso 延遲造成嘅三個硬牆 round trip，唔關 note 事；但它同時令呢啲 tick
  **完全冇 scan、亦冇 pass**，係下一步值得查嘅對象。

### 14.5 部署後讀數（2026-09-23 03:02–03:07Z，`ed20dbf`）

Deploy：push `ed20dbf` →「Deploy Worker to Cloudflare」成功（run 35812517983，1m13s，03:00:23Z 完成）。
下面係 `/health.pushWatchPass` 嘅連續讀數：

| 讀數 | 值 | 結論 |
|---|---|---|
| deploy 前（03:01:08–03:02:08Z） | `phase` 缺席、`at` 停留 02:58:26Z | 舊版 Worker 寫嘅 row |
| 03:02:26Z | `phase:"running"`、`at 03:02:24Z`、`trackerMs 0`、`note:"running"` | ✅ running stamp 線上出現 |
| 03:02:45Z | `phase:"done"`、`at 03:02:26Z`、`trackerMs 1690`、`ok:1/0 … budget-cut` | ✅ 同一個 tick 完成；該 tick `hbMs 5000`（已經係被切嘅 tick），pass 仍然開得成 |
| 03:03:25／03:04:25／03:05:24／03:06:25／03:07:24Z | `phase:"done"`，`trackerMs 4074–4822`，每次都前進 | ✅ **note 每個 tick 都動**（凍結唔再重現） |
| 03:04:21Z、03:05:20Z | `phase:"running"`（兩個 tick 都影到中間態） | ✅ |

`phase:"skip"` **今次未影到**：deploy 之後每個 tick 嘅 scan 都係 2.1–3.1s，`trackerBudgetMs > 0` ⇒ 冇 tick 需要跳過 pass。
呢條分支由單元測試釘住；下一次 burst（scan＋flush ≥ 8.5s 嘅 cut tick，即 02:37–02:41Z 嗰種）出現就會睇到。

### 14.6 第一次線上「卡死嘅 pass」讀得到（2026-09-23 03:10–03:11Z）

修好之後第二個 sample 就影到形狀 B 本身，而佢而家有簽名：

| 讀數（`/health.pushWatchPass`） | 值 | 意思 |
|---|---|---|
| 03:10:36Z、03:10:54Z、03:11:18Z | `phase:"running"`、`at 03:10:23Z`（停留 **55 秒**） | 03:10:23Z 開嘅 pass 冇 return ⇒ 就係形狀 B（一行食盡 pass）。舊版呢一刻只會見到 note 靜止，分唔清「卡死」定「寫入失敗」 |
| 03:11:39Z | `phase:"done"`、`at 03:11:25Z`、`trackerMs 4436` | 下一個 tick（03:11:20Z 開）嘅 pass 正常完成，`running` stamp 亦被覆蓋 |

即係 §14.1 形狀 B 唔係一次性，而家每次發生都留得住證據（`running` ＋ 舊 `at`，`at` 自己講得出幾點開始卡）。

`phase:"skip"`（形狀 A 嘅簽名）到 03:12Z 仍然未影到：deploy 之後所有 tick 嘅 scan 都完成喺 2.1–3.1s，
所以每個 tick 都有預算開 pass。要等下一次 11500ms burst。

## 十五、BillSmith 三張 up50 卡：冇證明 ⇒ fail-open 重送（2026-09-23 02:26／02:35／03:03Z）

Operator 報告（HKT 10:26／10:35／11:03）：`🚀 續漲 BillSmith | 推送時 $14.31K → …，下一關 +100%` 收到三次。

### 15.1 係重複，而且三張都係同一級

三次漲幅 +59%／+60%／+73% 都未過 100%，而三張都寫「下一關 +100%」⇒ 三次都係 `up50` 呢個 transition。
Row 讀數（03:2xZ）：`pushedAt` 09-22 23:52:15Z、`mcapAtPush` 14310.62（＝卡上嘅 $14.31K）、`lastState "up50"`、
`upStages "up50"`、`lastAlertAt 03:03:20Z`、`followupsSent 5`、`peakMcap` 27472。即係第三次（03:03）之後 mark 才真正落地。

### 15.2 audit ring：只有第三張有證明

`/debug/push-audit`（30 筆，覆蓋 01:19–03:21Z）BillSmith 只有兩筆：`01:31:32Z revive`（msg 3839）、
`03:03:23Z up50`（msg 3865）。即 02:26 同 02:35 兩張卡**冇任何 audit entry**（ring 時間覆蓋得到，唔係被 evict）。
而 02:17:22Z → 02:36:25Z 之間整段 ring 空白 —— 正好係 §14 嗰段切割／飢餓期。

### 15.3 機制（設計上嘅 fail-open）

1. 02:26 送卡時 slice 用盡 ⇒ **cut**（唔係 Telegram 拒絕）。cut 之後 rollback 咗公告欄位，只留一個 attempt mark
   `p:up50:<桶>`；佢嘅 proof（遲到嘅 settle）要寫入 audit 才算數。
2. 02:35 個 check 重新推導 `up50`（mark 唔係 stage mark），問 audit 攞 `(token, up50)` 嘅 proof ≥ 02:26 ⇒ **冇** ⇒
   fail-open ⇒ 再送；又 cut，mark 換成 `p:up50:29835515`（02:35 桶）—— 就係 02:44Z 線上讀到嘅值。
3. 03:03 再一次；今次送得完 ⇒ `upStages` 變 `up50`、`lastAlertAt 03:03:20Z`、audit `sig up50` msg 3865 ⇒
   從此唔會再出 `up50`（下一級只可以係 +100%）。

所以「重複」係 at-least-once 設計嘅代價：**冇證據就必須重送**（寧願多一張，唔可以靜默漏）。
唯一可以擋住佢嘅就係嗰個 per-card proof，所以一條永遠產生唔到 proof 嘅路徑就等於保證重複。

### 15.4 為何 02:26／02:35 冇證明：fallback tick 冇 wire waitUntil（已修）

`pushwatch.holdForTick`：冇 keepAlive 就 `void promise` —— 即係直接放棄嗰個 promise，invocation 一完就取消。
`keepAliveForTick` 來自 worker 嘅 `tickWaitUntil`，而 `tickWaitUntil` **只喺 `scheduled` 入面設定**；
HTTP fallback（`maybeRunScanIfStale`，由任何 request 經 `ctx.waitUntil` 觸發）行同一個 tick tail，
但從來冇設定過佢 ⇒ 嗰啲 tick 嘅 cut proof 一定掉落 ⇒ 永遠冇 proof ⇒ 永遠 fail-open。

修法（`docs/patches/fallback-tick-waituntil.patch`）：`maybeRunScanIfStale(env, ctx)`，entry 就
`if (ctx) tickWaitUntil = (promise) => ctx.waitUntil(promise);`，呼叫點傳 `ctx`。
同一時間亦修好 `writeDrain`（同一個 hand-off；§10 之前量到 fallback tick 100% 掉落）。

### 15.5 驗收

`npx tsc --noEmit` 0 error；`test-unit.js` 272/0、`test-deferred-priority.js`、`test-tick-path.js` 全部 pass。
線上驗收要等落線：下一次 cut 送卡，`/debug/push-audit` 應該見到帶 `sig` 嘅 entry（即使係 cut 出嘅卡），
而 `push_watch.upStages` 嘅 `p:` mark 下一個 check 就會被 proof 擋成 `dup-skip`（讀法見 §14.2）。

## 十六、收窄 §14.4 兩個根因：pass 跑喺 tick 皮帶上、row loop 用實測 trip 做 reserve（2026-09-23）

Patch（依序 `git apply --recount`）：`tick-leash-for-pass-and-prerace`、`tracker-row-reserve-measured`、
`tracker-row-reserve-cleanup`、`tracker-row-reserve-drop-card-guard`、`tracker-row-reserve-test`。

### 16.1 形狀 B：一行最多五個「3s 硬牆」→ 最多五個 1.4s，而且 loop 唔會再亂開行

* `Scanner.runTrackerPass` 而家自己 `enterScanMode()`／`exitScanMode()`。scanner 嘅 `exitScanMode()` 喺 `runOnce` 尾
  —— 即係 pass **之前** —— 但 `Db.enterScanMode` 嘅註釋本身寫明呢條皮帶包含「the post-push tracker pass, which all
  live inside the tick」；實際上 pass 一直行 3s 硬牆（`SCAN_DB_TIMEOUT_MS 1200 × 1.2 = 1.44s` 才對）。修完之後：
  一行嘅鏈由最多 ~15s 降到最多 ~7s，而且每次呼叫都會喺 tick 內**報錯**，唔會呆等。
* Row loop 嘅 reserve 由固定 `TRACKER_ROW_MIN_MS 300` 改成**實測**：
  `tripMs = 本 pass 已用時間 ÷ 本 pass 行過嘅 row-loop trips`，reserve = `clamp(tripMs, 300, 1500)`。
  健康 Turso 同以前完全一樣（floor 300，唔會少收一行）；degraded 時 loop 會喺未夠一個實測 trip 之前停手，
  唔會再開一條自己一定完成唔到嘅行（03:10Z 嗰個 55 秒卡死就係開咗嗰種行）。
* note 尾多咗 `db <ms>`：pass 嘅 round-trip 實時成本（呢個數字以前完全冇，所以「pass 慢」只能靠 stage split 估）。

### 16.2 形狀 A：pre-race 9 秒 → 每個 round trip 都喺皮帶內

`runScan` 一開頭 `db.enterScanMode()`，完成 flush 之前 `db.exitScanMode()`（flush 照舊用長窗口
`DB_REQUEST_TIMEOUT_MS`，同 Db 註釋一致）；lock-lost 嘅 early return 亦補咗 exit，唔會漏出 tick。

claim 係 1–3 個 round trip（insert-or-ignore → CAS takeover 嘅 SELECT + UPDATE），加埋 dead-predecessor 讀取，
degraded 時實測 `preRace 9000ms = json 0 + claim 3000` ⇒ scan 只剩 2500ms 下限 ⇒ tick 11500ms ⇒
**tracker pass 完全被跳過**（一個 rotation turn 冇咗，唔止一張卡）。喺 1.4s／trip 之下，同一階段最多 ~2.9s，
scan 窗口回到 ~4.6s，pass 亦有預算開。

### 16.3 測試與 negative control

* 新測試 `PushWatcher: a degraded round trip stops the loop before it starts another row`：900ms／trip、1500ms 預算
  ⇒ 只行一行、`writes ["AAA"]`、note 帶 `budget-cut`。
* Negative control 實測：`git checkout -- src/pushwatch.ts`（回到回合前嘅 300ms flat reserve）＋保留新測試 ⇒
  `272 passed, 1 failed`（`the second row is deferred, not started (checked 2)`）；四個 patch 依序
  `git apply --recount --include=src/pushwatch.ts` 還原後 `273 passed, 0 failed`。
* `test-deferred-priority.js`、`test-tick-path.js` 都 pass。

### 16.4 仍然冇收（老實講）

* 一行嘅鏈仍然可以跑到 ~7s（5 × 1.44s）：皮帶係「每次呼叫」嘅界，唔係「整條鏈」嘅界。要再收窄需要
  per-call deadline，而 `reservePushWatchAlert` 係唯一唔可以中途放棄嘅呼叫（放棄＝卡靜默消失），所以唔可以亂 race。
* Row loop 嘅**第一行永遠照跑**（progress floor，2026-09-17 嘅教訓），所以「第一行食盡成個 tick」仍然可能發生，
  只係上限由 15s 降到 ~7s，而且 note 嘅 `phase` 會即刻顯示（§14.2 嘅讀法）。
* 落線後要睇：note 尾嘅 `db <ms>`（正常幾百 ms；degraded 會跳到幾秒）同 burst 期間 `preRace` 仲會唔會到 9000ms。

## 十七、pass 一定要 return：watchdog ＋ recap send 收皮帶（2026-09-23 04:01Z 嘅 61 秒）

### 17.1 讀數

| 讀數 | 值 |
|---|---|
| `/health.pushWatchPass` | `phase:"running"`、`at 04:01:51Z` **停留 61 秒**（04:01:51 → 04:02:52） |
| `scan_history` | `04:00:26 False 78014`、`03:59:24 False 62197`（`previous tick died before its completion flush`）＋ `04:01:49 False 5000` |
| 回復 | `04:03:19 True 3623`、`04:04:20 True 3077` |

健康 tick 3–4s、envelope 9.5s、pass 上限 8.5s（§16.1 嘅 `db 3616ms`）。所以 78s／62s 嘅 tick 唔係
「預算唔夠」，係 pass **冇 return**；§16 嘅皮帶（每次呼叫 ≤1.44s）救唔到，因為卡死一定喺一個
**冇 bound 嘅非 DB await**。

### 17.2 兩個真兇

1. **`pushwatch.runTick` 嘅 case-closed recap 送卡**：pass 四個 send 之中唯一冇經 `bounded()` 嘅一個。
   Telegram 429 唔會 reject —— grammy 內部 sleep `retry_after`（30–60s 好平常）——所以 `await` 佢就等於
   等成分鐘，而個 pass 唔理有幾多預算都會被佢揸住。呢個正正解釋到 61 秒。
2. **任何其他未被 bound 嘅 await**：逐個 stage 審核之後，其餘全部有界 —— DB 喺皮帶內、send／holder／
   Jupiter／Gecko 經 `bounded()`、`pairsForTracker` 嘅 DexScreener 腿有自家 `PAIRS_FETCH_BUDGET_MS` ＋
   呼叫者 deadline。所以需要一個「最後防線」。

### 17.3 修法（`docs/patches/tracker-pass-watchdog.patch`）

* `Scanner.runTrackerPass`：`Promise.race([pushWatcher.runTick(...), 時限])`。watchdog 一開火 ⇒ 寫
  `cut:watchdog <ms> db <ms>` 同 `phase:"cut"`（`persistPassNote` 多一個相位，同 `running`／`done`／`skip` 並列）。
  **放棄唔等於取消**：被放棄嗰條 pass 自己繼續跑（佢已寫落嘅 row mark 照算，下一個 check 重新推導），
  而佢啲 cut 卡嘅 proof 早就交咗俾 tick 嘅 `waitUntil`（§15.4 嘅 `holdForTick`），所以出界唔會掉卡。
* 時限 = `deadline + TRACKER_PASS_OVERRUN_MS`，而 8s 係**一行 chain 嘅實測上界**：
  claim 1.5 ＋ reservation 1.5 ＋ send 1.35 ＋ audit 1.5 ＋ 最後寫 1.5 = 7.35s（＋開場 pair batch 0.6s）。
  刻意放喺**所有既有界之外**：pass 嘅規則係 reserve-then-send，如果喺 reservation 同最後
  `updatePushWatchCheck` 之間被砍，就會「reservation 已落、卡冇出、下個 pass 亦唔會再推導」＝
  **靜默漏卡**，即係唯一唔可以發生嘅事。所以只有「冇 bound 嘅 await」先會超越 8s，正中目標。
* `src/pushwatch.ts`：recap 送卡入 `bounded(…, TRACKER_SEND_CAP_MS)`，而且**先** `holdForTick(card)` 再 await ——
  超時只係唔再等，卡照樣有機會遲到送達。

### 17.4 測試與 negative control

* 新測試一 `Scanner.runTrackerPass: the watchdog abandons a pass that never returns, and says so`：
  `runTick` 永不 resolve ＋ `trackerPassOverrunMs = 40` ⇒ note `cut:watchdog …ms db …ms`、
  `writes[1].phase === "cut"`、note 上到 `/health`；同時釘住「時限 ＝ deadline ＋ overrun」
  （`deadline = now + 60` ⇒ 最少等 80ms 先砍）。
* 新測試二 `PushWatcher: the case-closed recap send is BOUNDED`：`sendMessage` 永不 resolve ⇒ `runTick`
  仍然 return、`held.length === 1`（卡交咗俾 `waitUntil`）、note 照有 `trips`。
* Negative control：只反轉實作（`git apply -R --include=src/scanner.ts` 同
  `git apply -R --include=src/pushwatch.ts` 兩個指令）、保留測試 ⇒ suite **連 summary 都印唔到**
  （node 冇 pending handle 就靜靜哋退出）—— 即係「pass 冇 return」本身。還原後 **275 passed, 0 failed**
  （原本 273 ＋ 新 2）；`test-deferred-priority.js`、`test-tick-path.js` pass；`npx tsc --noEmit` 0 error。

### 17.5 仍未收（老實講）

* 8s 係**上限**，唔係正常值：正常 pass 3–4s 完成，watchdog 唔應該開火。落線之後要睇 note 有冇
  `cut:watchdog` —— 一出現就代表仲有一個未被 bound 嘅 await，而個 `<ms>` 就係佢嘅成本。
* 卡片路徑本身冇放寬：`reservePushWatchAlert` 仍然係唯一唔可以中途放棄嘅呼叫，watchdog 亦刻意唔會
  喺「reservation → 最後寫」呢段入面砍（見 17.3），所以「唔可以漏卡」嘅方向冇變。
* 若果 watchdog 開火而 pass 當時正停喺某一行嘅**送卡**度（reservation 已落），嗰張卡一樣係漏 ——
  同「唔開火、永遠等落去」嘅結果相同，唔會更差；但呢個窗口係已知嘅，屬下一輪要處理嘅對象。
  **2026-09-23 已收：見 §17.6**（唔係「同永遠等一樣」—— 追落去係**靜默漏卡**方向）。

### 17.6 第三個 bullet 已收：reservation → final-write 嘅 span 交俾 tick 嘅 waitUntil（2026-09-23，已修）

§17.5 第三點寫「同唔開火、永遠等落去一樣，唔會更差」。追落去係**唔同意**，而且係 §17.3 自己講
「唯一唔可以發生」嘅方向 —— 靜默漏卡：

* `reservePushWatchAlert` 係**喺送卡之前** commit 嗰個 transition（呢個就係 dedupe 嘅全部意義）。
* 由嗰一刻到該行最後嗰個 `updatePushWatchCheck`，行係「對其他 isolate 嚟講已宣布、但冇任何
  bookkeeping 支持」。
* watchdog 開火 ⇒ `runTrackerPass` return、worker 收尾、**handler return**。被放棄嗰條 pass
  **冇被取消**（§17.3），但**冇任何嘢保住個 isolate**：handler return 一刻，凡係冇交俾 `waitUntil`
  嘅 promise 一律被取消 —— 同 worker `tickWaitUntil` 同一條規矩（`writeDrain` 實測 100% 寫唔到嗰單）。
  嗰段 span 就死喺度。
* 對比「冇 watchdog、永遠等落去」嘅世界：個 pass 揸住個 isolate，個 final write **有機會**落。
  Span 被切就係**一定**唔落 ⇒ 行停喺 **reserved-but-unwritten**，下一個 pass 讀到前進咗嘅 reservation
  （`(last_state, last_alert_at)` 已改），dedupe 就**唔會再發**呢張卡。

修法（`PushWatcher.holdRowSpan`，落線 script `docs/patches/tracker-row-span-hold.apply.js`）：

* **揸住嗰段 span**：`holdForTick` 交一個 promise 俾 tick 嘅 `waitUntil`，回傳一個 release handle。
* **建立位**：`checked += 1` 之後、`reserveAlert()` **之前** —— 所以 reservation 自己嗰個寫入都
  喺 span 入面（reservation 落咗而 pass 即刻死，一樣係 reserved-but-unwritten）。
* **釋放位**：兩個出口各一次 —— (a) reservation 輸咗嗰條 `continue`（冇嘢宣布過，即刻放）；
  (b) 行尾最後嗰個 `updatePushWatchCheck` 之後。**WON reservation 之後冇其他出口**：send loop 裏面
  嘅 `break`（send budget 用盡／terminal abandoned／send 超時）全部 fall through 到最後嗰個寫入，
  所以呢兩個 release 冚得晒整個 span。
* **刻意有界**（`TRACKER_ROW_SPAN_HOLD_MS` = `TRACKER_SEND_CAP_MS` ＋ 2 × `TRACKER_ROW_LEASH_MS`
  ＋ 1s slack = 5_000ms）：交俾 `waitUntil` 嘅 promise 如果**永遠唔 settle**，就會拉長 invocation ——
  正係 §17.3 拆走嘅嗰種 stall，而且會推翻 watchdog 自己嘅前提（「pass 內每個 stage 都有界」）。
  所以 hold 有 timer 兜底；因為行一定會行到最後嗰個寫入（見上），timer **只會喺已經 throw 嘅路徑**
  上開火，嗰時再揸住 invocation 純粹係 leak。
* **唔變嘅保證**：pass 嘅決定、reservation 嘅 guard、rollback 語意、cut 卡嘅 proof（§15.4）一律
  冇改；呢刀只係多交一個 promise 俾 tick，**唔加任何 round trip**，亦唔改 note 格式。

**測試**（`docs/patches/tracker-row-span-hold-tests.apply.js` ＋ `…fix1.apply.js`）：三條性質，每條
錯都係靜默 ——（1）span promise 真係入到 tick 嘅 hook（唔係靠「pass 跑得完」睇得出）；（2）final write
**pending 嗰陣** hold 仲未 settle，而 final write 一完成就**由佢**釋放（唔係等 timer）；（3）reservation
**輸**嗰陣即刻釋放（否則每次輸 race 都揸住個 invocation 幾秒）。另加 bound 嘅兩條關係：要**蓋得住**
span 嘅 worst case，又要**裝得落** pass 自己嘅 envelope（watchdog 嗰 8s）。

**Negative control**（§17.4 規矩）：淨係閹咗個 hand-off（攞走 `this.holdForTick(held)`）、測試保留
⇒ suite **294 passed, 2 failed**，兩條正正係 `the span hold AND the cut's proof are handed to the tick`
同 `the reservation → final-write span is handed to the tick`；還原之後 **296 passed, 0 failed**。
注意 `…fix1` 嗰刀係必要嘅：§15.4 嗰條 CUT-proof test 原本釘住 `held.length === 1`，而家同一行有
**兩個** promise 搭上個 hook，所以佢改成 2 並寫明邊個係 proof。

#### 17.6.1 落線（deploy `47ebcfc`，run 35893562830 **success** 1m16s，17:08:26Z→17:09:42Z）

呢刀**冇新讀數**（唔加 round trip、唔改 note），所以驗收係「唔應該有變化」：

| 讀邊度 | 讀數（17:10–17:12Z） | 意思 |
|---|---|---|
| `cut:watchdog` | **0 次**（整個 `/debug/scan-history` payload） | watchdog 冇開火 ⇒ 冇未 bound 嘅 await 出現 |
| pass note | `phase:"done"`、`trackerMs 1255`、`ok:10/0 rows 10/29 pairs 10/10 … trips 7 db 562ms` | 正常尾段；`cut:watchdog` ／ `err:` 都冇 |
| `/debug/push-watch.issueCount` | **3**（全部 `lost_completion_write`，都係 09-23 04:16Z／01:41Z 嗰幾條舊 row） | 冇新增 issue |
| scan-history ring | 窗口 15:01:13Z→17:10:30Z，dead row **11** 條，最新一條 **16:11:21Z** | deploy（17:09Z）之後冇 dead tick；最後一條早咗成個鐘 |

真正嘅價值喺**下一次** watchdog 開火嗰陣：嗰行唔應該再出現「reservation 前進咗、bookkeeping 冇動」
嘅形狀（`terminalRowIssues` 嘅 `lost_completion_write`）。順帶一提：舊嗰 3 條 `lost_completion_write`
唔會因為呢刀而消失，佢哋要等 `terminalRowRepair` 收。

## 十八、`d7eb660` 落線驗收：`cut:watchdog` 冇出現，6 位數 ms **仍然出現**（2026-09-23 04:44–05:17Z）

Deploy：run **35819455746** success（04:42:59Z 開始、1m6s）⇒ **04:44:05Z 上線**。

### 18.1 `cut:watchdog`：冇出現（即係 pass 冇唔 return）

| 讀邊度 | 讀數 | 意思 |
|---|---|---|
| `/health.pushWatchPass` | 05:10:28Z `ok:7/0 … cut4 db 3803ms`、`phase:"done"`、`trackerMs 4132`；05:15:13Z／05:16:24Z 亦見 `running`（pass 開頭）之後正常收尾 | pass 正常 return（4.0–4.4s，遠低於 8s overrun）⇒ watchdog 冇開火 |
| note 帶 `cut:watchdog` ／ `phase:"cut"` | **0 次**（05:10–05:17Z 連續讀） | 冇影到「pass 唔 return」 |

### 18.2 6 位數 ms：仍然出現，而且 watchdog 覆蓋唔到

`/debug/scan-history?limit=1000`（120 行 ring ≈ 2h）嘅 dead row **10 行**：

```
03:59:24=62197  04:00:26=78014  04:13:24=60476  04:18:14=61833  04:19:16=62589
04:29:24=60704  04:30:25=61440  04:57:24=60242  04:58:24=59722  05:13:26=105014
```

（04:57／04:58／05:13 係 post-deploy；其餘 7 行喺 03:59–04:30。）

**要更正 §17.1 嘅歸因**：`previous tick died before its completion flush` **唔可能**係「pass 冇 return」造成 ——
pass 係喺 **completion flush 之後**才跑（`worker.ts` 2471–2500：flush 批次同一時間寫 history row 同
`phase:done`，pass 喺其後）。所以死喺 flush 之前嘅 tick，pass 根本未開始；§17.1 影到嘅 78s／62s
（03:59:24、04:00:26）亦**早過** 04:01:51 嗰個卡住嘅 pass，兩者係唔同事件。Watchdog 針對嘅係另一個形狀：

| 形狀 | 一眼認出嘅讀數 | 例子 | watchdog |
|---|---|---|---|
| pass 唔 return（tick 已 flush） | `pushWatchPass.phase` **停留喺 `running`**、history row 係 `ok` | §14.2 形狀 B；§17.2 嗰 61 秒 | ✅ 8s overrun 之後寫 `cut:watchdog` 並 return |
| tick 死喺 flush 之前 | `previous tick died before its completion flush`、heartbeat 停 `phase=scanning` | 上面 10 行（`ms` 60–105s 只係**偵測延遲**，唔係 tick 跑咗咁久） | ❌ 覆蓋唔到（pass 未開始） |

### 18.3 共同根因（新證據）：invocation subrequest 上限

同一個時段 `/debug/tick.summary.pushWatch` 讀到：

```
err:Too many subrequests by single Worker invocation. To configure this limit, refer to
https://developers.cloudflare.com/workers/wrangler/configuration/#limits
```

Cloudflare limits：**subrequest per invocation = 50（Free）／10,000（Paid，Free 唔可以調高）**；而呢個 bot 嘅
Turso 連線走 **HTTP transport**（`src/db.ts` `createRawClient`：`libsql://` → `https://` ＋ `fetch`），
所以**每一個 DB round trip 都係一個 subrequest**（libsql client 內部仲會自己重試，一個慢 call 可以食幾個）。
燒到 50 之後，**下一個** fetch／DB call 就 throw，而 tick 尾段每一個寫入都係 best-effort ⇒ 症狀係「靜靜地冇咗」：

| 爆預算嘅位置 | 見到嘅形狀 |
|---|---|
| completion flush | 冇 history row、heartbeat 停 `phase=scanning` ⇒ 下一 tick 補 **`previous tick died before its completion flush`** |
| pass 嘅最終 note 寫入 | `pushWatchPass.phase` 停在 **`running`**（`persistPassStart` 較早寫，預算未爆） |
| pass 內部嘅 call | `summary.pushWatch = err:Too many subrequests …` |
| terminal 卡嘅 settle | `last_checked == last_alert_at` ⇒ `/debug/push-watch.issues` 出 **`lost_completion_write`**（05:17Z：9 行） |
| deferred write drain | 舊讀數 `writeDrain 4 calls / 4 failures`（同一類：寫入被平台擋） |

即係之前分開追嘅三樣（dead tick、note 凍結、lost completion write）係**同一個上限嘅三個出口**。
完整拆解、點驗（dashboard → Workers & Pages → `solana-meme-bot` → Metrics → Errors → Invocation Statuses）、
同修法（Workers Paid 50→10,000，或者減 invocation 內嘅 Turso round trip）：
見 `docs/scan-completion-loss.md` 嘅「2026-09-23：dead tick 嘅真身 —— invocation 級 subrequest 上限」。

### 18.4 卡片方向：呢批失敗冇新增漏卡路徑

* 三個出口全部都係 **telemetry／bookkeeping 寫入**，冇一個會令卡唔送：唯一「唔送」出口係 `deduped`，
  而佢要 exact per-card proof（§10.2）；proof 讀唔到 ⇒ 照送（fail-open）。舊讀數亦證實 dead tick 照樣推卡
  （`docs/scan-completion-loss.md`：落入 ring 嘅 8 條卡全部由 dead tick 推）。
* Dedupe 現況（05:17Z）：52 行之中 **4 行**帶 `p:` mark（全部 `dead`／`weak`）；最接近觸發嘅係 **BillSmith**
  `p:up100:29835664`（05:04 桶；`last_checked` 05:04:11 同桶 ⇒ attempt 係 current），audit ring 未見
  `(BillSmith, up100)` 嘅 proof ⇒ 下一次重新推導 `up100` 會先「等一個 check」，跟住 `dup-skip` 或者真送。
  讀法照 §11.3（唔可以只睇 note：note 嘅寫入本身就係會爆預算嗰批）。
### 18.5 2026-09-23 21:14–23:56Z 重取樣：慢滴跌咗，楔形冇跌（17 分鐘內 17 條）

**問**：§17.6 嘅 span hold（`47ebcfc` 17:08Z）同 `docs/round-trips.md` §4.7 嘅 grouped telemetry
（`2a6de9a` 16:43Z）之後，dead-tick 形狀有冇移動？

**窗**：18:01Z 之後冇人手 polling，所以 21:14:17 → 23:56:15Z 呢個 120 行 ring 係迄今最乾淨嘅
「靜默」樣本（151 分鐘）。全部讀數來自 `/debug/scan-history`。

| 窗 | 長(min) | dead | 率 | `ms>=100000` |
|---|---|---|---|---|
| §18.2 04:44–05:17 | 33 | 10 | 18/h | 1 |
| §5.1 13:52–14:17 | 145 | 21 | 8.7/h | 3 |
| 16:53Z 樣本 | 134 | 12 | 5.4/h | 1 |
| **今晚 21:14–23:56** | **151** | **22** | **8.7/h** | **0** |

**但總率呃人，要拆兩截**（呢個係今晚最重要嘅發現）：

* **慢滴 21:14:17 → 23:26:27（132 min）：5 條 = 2.3/h**（21:35:12、22:16:15、22:38:17、23:01:22、
  23:02:27；全部單條或一對）。比 16:53Z 之前嘅 5.4–8.7/h **跌 2–4 倍**，而 **6 位數偵測延遲
  由每窗 1–3 條變 0 條**：全窗 dead 行 `ms` 47k–92k，即每條死 tick 都喺下一秒（60s）就有
  successor 幫佢落 backfill row，冇再出現 100–111s 嘅延遲。OK tick 嘅 `ms`（98 條）= min 810 /
  中位 2454 / max 4201。
* **楔形 23:26:27 → 23:43:37（17.2 min）：17 條 = 59/h**，期間**零成功掃描**。22 條裡面 17 條係
  呢一舊。形狀同 2026-09-08／09-19 嘅「中毒 isolate」一樣：claim 贏咗、heartbeat
  `phase:"scanning"` 落到、完成 flush 冇。同 §18.3 嘅假設唔同：**唔係 subrequest 爆** ——
  楔形中兩輪生還嘅 tick（23:36:18 = 3.9s；23:45:13 = 3.7s）subrequest 窗係
  **total 30（turso 18 + dexscreener 7 + gecko 2 + jup 2 + gmgn 1）**，離 50 上限仲有 20 條。
* 楔形**無 deploy 喺附近**（最後一次係 17:12Z），亦**自己散**（~23:44，無人碰過）；
  23:47:28 → 23:56:10 連續 7 輪 OK（2.2–3.0s）。
* 楔形期間死嘅 tick 兩種驅動都中：頭 10 條全部貼 cron 節拍（`:27.1`–`:27.2`，cron arrival
  `:26.87`），之後有**非 cron 節拍**（`:37:19`、`:38:24`、`:39:24`、`:40:28` —— 疑似外部
  `/health` monitor／診斷讀取驅動）；兩輪生還者（`:36:18`、`:45:13`）都係非 cron 節拍。
  ⇒ **「cron 死、HTTP 活」係未證實嘅線索，唔係結論**（到達記錄喺下面凍結埋，分辨唔到）。
* `cut:watchdog` 喺成個 payload **0 次**（§17.5 講嘅「8 秒 watchdog 從來冇響過」今晚再確認）。
* **新讀數（pass 終結寫入）**：楔形中兩輪生還嘅 tick 各自留低一條**唔會終結**嘅
  `pushWatchPass`（`phase:"running"`、`trackerMs 0`、`at` = tick 起點 +0.26s／+0.64s），
  之後 23:46／23:47／23:49 三輪 OK 都冇覆寫佢 —— 即係 tick 自己嘅 row 落到（ok、3.7s），
  **pass 嘅終結寫入冇落**。到 23:54:24 嗰輪回復正常：`phase:"done"`、`trackerMs 3398`、
  `trips 12 db 1950ms`。呢個係 §17.3／§17.5「pass 唔 return」形狀**第一次有 live 證據**，
  而同一時間 **8 秒 watchdog 冇寫 cut**（同一輪 OK 之後 invocation 已完）。
* `outageAlertAt` = **23:39:22.197Z**（楔形第 13 分鐘）：durable 嘅 no-completion 記錄有 stamp，
  即係 ⚠️ 告警路徑冇死。
* `gaps`：兩段（22:52:21→22:54:28 = 127s；21:46:14→21:48:16 = 122s）。
* **順手再中一次 §4.5 未做第一項**：`scheduledTickAt`／`scheduledTickTotal`（54846）／`tickRing`
  由 **23:43:26.871** 起凍結（到 23:56:15 最少 13 分鐘），同一時間 scan row 照落 ⇒ 到達記錄同
  掃描係可以各自獨立停／行。

**判斷**（老實講）：

1. **慢滴有移動**（2.3/h、0 條 6 位數）—— 方向對，但只有一個窗、5 個事件，未夠力話係切造成
   （可能係時段差異）。
2. **楔形冇移動，而且主宰總數**（22 條中 17 條）；同 §18.2／§18.3 一樣係「claim 落到、flush 冇」，
   而且今次量到生還者係 30/50 ⇒ 唔係 subrequest 上限。
3. **兩個 cut 幫唔到楔形，亦唔係楔形成因**（楔形起／散都無 deploy）。
4. 未收：pass 終結寫入冇落（新形狀，tick 本身 ok）、8 秒 watchdog 對呢個形狀都唔響、
   cron 到達記錄再次凍結（§4.5 第一項）。

## 十九、第三修：冇 cut mark 都查 proof，但只認「呢一次 check」（2026-09-24）

仍然開住嘅一條：`fire()` **只喺有 cut mark 時**才查 audit proof。mark 係「attempt 過呢張卡」嘅記錄，
而佢係由**做咗嗰次 send 嘅 pass 自己**寫 —— 所以一個喺寫入之前就死咗嘅 pass（rollback、isolate 被殺）
會留低一張**送達咗但冇 mark** 嘅卡，下一次評估照樣重新推導、然後照送 ⇒ 重複。audit entry 本身就係
時間證據，佢答得到同一個問題。

* **收窄（唔係放寬）**：冇 cut mark 時**照樣**查 audit ring，但只認**同一個 sig** 嘅 exact proof
  （`cardProofKey(token, sig)`），**唔用** token 級 fallback —— fallback 講唔出邊張卡，而呢條規則
  冇 mark 做錨，用咗就可能壓抑一張**從來冇送過**嘅卡（唯一唔可以接受嘅方向）。
* **同一把尺**：proof 嘅時間戳要落喺 row 自己 `last_checked` 嘅分鐘桶、或者**下一個**桶之內
  （`proofIsCurrent`）—— 同 `attemptIsCurrent` 對 attempt 用嘅規則一模一樣（`:59` claim → `:00` 交付
  嘅 straddle）。更舊嘅唔算：re-armed row（🔁 resume、死而復生）之後可以**合法地**再公告同一個
  transition，舊嘅交付唔應該令新卡靜音。
* **suppress 嘅同時補寫返 mark**：被 suppress 嘅卡帶住 `dedupedAt`（＝proof 自己嘅時間戳）出返去，
  row loop 會將佢寫成該卡嘅 attempt mark。呢個係關鍵嘅另一半：rollback 會**推翻公告**，得 mark＋proof
  一對先擋得住下一次推導。冇咗個 mark，proof 一離開個窗，同一張卡就會被送出去 —— 即係「壓抑一次、
  遲啲補一張重複」，而唔係永遠壓抑。
* **讀 proof 嘅閘要跟住放寬**（同一個 bug 嘅第二半）：proof ring 本來**只喺 head row 已經帶 cut mark
  時**才讀（省一個 trip）。但新規則要處理嘅正正係**冇 mark** 嘅 row ⇒ 照舊閘法呢條規則係**死碼**，
  唯有 mark 已經答過同一條問題嘅地方才讀得到 proof。所以改成「head 有人可以評估就讀」，成本係
  **每次 pass 一個 trip**（老實講：呢個就係呢條修法嘅價錢，換嚟「送達但冇 mark」唔會重複）。
* **測試**（`scripts/test-unit.js`；negative control 驗過：攞走個規則 ⇒ 2 條齊 fail，300 passed／2 failed）：
  * `evaluateWatch`：冇 mark ＋ 同一個 check 桶嘅 proof ⇒ `deduped`、`dedupedAt` ＝ proof 嘅時間戳、
    transition 照落地；proof 喺**下一個**桶（straddle）⇒ 一樣；proof 早兩個桶 ⇒ **照送**；只有 token
    級 proof（冇 sig）⇒ **照送**；另一個 sig 嘅 mark ⇒ 唔影響（各自用自己嗰條）。
  * `PushWatcher`：一張已送達但冇 mark 嘅 🚀 ＋ 一個被拒嘅 ⚠️ sibling ⇒ 🚀 **唔送**、rollback 寫出
    `p:up100:<bucket>`；下一個 pass（row 帶住嗰個 mark、而 proof 已經偏離個窗 10 分鐘）⇒ 仍然擋得住，
    只有 ⚠️ 重送一次。呢條就係「補寫返 mark」嘅端到端證明。
* **落線 script**：`docs/patches/cut-card-proof-no-mark.apply.js`（row loop ＋ proof 讀取閘 ＋ 兩條測試）。
* **落線讀數**（2026-09-24 02:36Z，deploy run 35947790374）：pass note
  `ok:10/1 rows 10/29 pairs 10/10 miss 0 lost 0 undelivered 1 … trips 14 db 2456ms` ⇒ pass 正常完結
  （phase `done`），`/debug/push-watch.issueCount` 仍然係 2（兩條舊 `lost_completion_write`，冇新增）。
  `dup-skip` **未出現** —— 呢條規則要「已送達但 mark 冇落地」嘅巧合，唔會即刻撞到。驗收係佢出現嗰陣
  **唔會**跟住多送一張卡（同一條 row 嘅 `undelivered` 唔會因為我哋壓抑咗一張而升）。


