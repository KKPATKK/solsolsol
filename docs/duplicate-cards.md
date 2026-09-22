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

* **未 deploy**：以上係本地實作＋單元測試；線上嘅 `dup-skip`、`p:` mark、補 audit 仲未見過真讀數。
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

### 7.4 未落地嘅一半（老實講）

* **row loop 仍然只為「被 cut 嗰張」寫 mark**（`addCutMark(row.upStages, cutSig, now)`）。所以一條 row
  一次過送幾張卡而中途被切／冇 slice，較早**已經送到**嗰幾張仍然會被重新公告（POPEYE 型）。
  修法已經備好：row loop 收集今個 pass **所有 attempt**（送到嘅＋被切嘅）再一次寫入 `addCutMarks`，
  每張卡就會各自用自己嘅 proof 擋住重複。
* **audit 寫入位未傳 `sig`**：所以暫時行 token 級 fallback（proof 仍然有效，只係分唔到同一 row 嘅兄弟卡）。
  一行改動：`recordPushDelivery({ …, kind: "followup", sig: a.sig })`（`Db.recordPushDelivery` 嘅
  parameter type 亦要加 `sig?: string`）。
* 上面兩處都在 `src/pushwatch.ts` 嘅 row loop（約 2000–2400 行）／`src/db.ts`（約 2030 行），而呢個
  workspace 嘅檔案編輯工具只能讀寫檔案**前 ~50KB**（`str_replace` 在深處會報 "not found"），
  所以今次改唔到；兩處都係細而獨立嘅改動，唔影響 7.2 嘅語意（只係少一半精度）。
* `p:` mark 用分鐘桶，所以「同一個 check」嘅判斷有一個 straddle：cut 嗰刻跨分鐘（pass 橫跨 :59 → :00）
  就會當成「唔係最近一次 check」，退回舊行為（照送）。量到約一成分嘅 cut。

### 7.5 驗收點

1. 同一 token 唔再喺一兩個 pass 內收到**同一張卡**；`dup-skip N` 繼續出現（proof 讀到時）。
2. proof 讀唔到嗰個 pass：`push_watch.upStages` 會保留 `p:<sig>:<bucket>`（**唔會**被新 stamp 覆蓋），
   而 tracker note 見唔到新卡；下一個 check 就會出現 `dup-skip`（proof 到）或者真係送一次。
3. 單元測試：`evaluateWatch: an attempt from the row's last check is not re-sent while its proof is missing`、
   `deliveredFollowupProofs: the newest delivery per (token, sig)…`、`cut marks: …`。

## 八、留底

`docs/patches/`：`cut-card-dedupe-proof`（audit proof helper）、`cut-card-dedupe-engine`（sig／mark／fire ／🚀 walk）、
`cut-card-dedupe`（tracker：proof 讀取、dedupe skip、背景 audit、cut mark 寫入）、`cut-card-dedupe-optional`、
`cut-card-dedupe-tests`、`cut-card-dedupe-behaviour-tests`（兩條既有測試斷言隨行為改變更新）。
六個 patch 依序 `git apply` 可重建整個改動，反向亦可還原到 HEAD。
