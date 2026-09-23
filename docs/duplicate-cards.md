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
| `/debug/push-watch?limit=200` | 下一個 check 之後：`upStages` 冇咗 `p:`、`lastState` 變成該 sig 嘅狀態、而 `followupsSent` **冇升** | 公告但冇送 ⇒ dedupe 真正觸發 |
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
