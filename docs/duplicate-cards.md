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
