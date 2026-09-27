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
