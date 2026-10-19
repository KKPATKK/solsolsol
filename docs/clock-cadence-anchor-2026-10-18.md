# 2026-10-18：clock 嘅 re-arm 錨落「alarm 自己嘅 scheduled time」（114.8 → 120 tick/h）

前提：`docs/do-clock-2026-10-02.md` 起咗個 30s 嘅 DO alarm loop，而它嗰句
「平均 32s ≠ 嚴格 30s」一直係已知項。呢份文件答一條更具體嘅問題：**240-tick 窗口
讀到 114.8 tick/小時（應該 120）—— 邊個部分係 cron 同 clock 打架（設計，唔蝕），
邊個部分係真蝕？** 答案係後者只有一樣：re-arm 喺 alarm body 之後才跑。

## 0. 結論

| # | 讀數（實測） | 原因 | 處理 |
|---|---|---|---|
| 1 | 240-tick durable 窗口：**114.8 tick/h**、mean gap 31.5s、p90 40.8s、max 46.5s；`/debug/clock` `lastWorkMs 2022` | re-arm 喺 `finally`（兩個 relay 之後）用 `Date.now() + tickMs`，所以真實週期 = `tickMs + work`（每個 tick 白加 ~2.0s） | ✅ 改成 `clockRearmAt`：下一個 alarm = **上一個 alarm 自己嘅 scheduled time + tickMs**（見 §3） |
| 2 | gap 分佈有兩條帶：<20s（8.1/h）＋ 40–47s（3.3/h ≥45s） | cron 通過 15s gate 嘅 scan 會封鎖下一個 clock slot —— **均值唔蝕**（每次 cron scan 啱好食一個 slot），只係 gap 形狀 | 唔郁：gate 同 cron 份額照舊（見 §2 嘅模擬：7 個相位全部 120/h）。after 實測更確認唔使郁 —— 呢個相位 cron 一次都過唔到 gate，形狀自己就係 30/30（§5.2） |
| 3 | **after 實測**（03:02:22.9–04:02:25Z，121 ticks / 1.00 h，同一把尺） | **119.9 tick/h、mean gap 30.017s、p50 30.005s、max 33.98s、≥45s 0、<20s 0**；`/debug/clock` 錨 = **29,998ms**（`lastWorkMs 2,266`） | ✅ 見 §5；240-tick 窗口未滿（~05:10Z），但 121-tick 讀數已經係同一形狀 |

一句話：**114.8/120 全部係 re-arm 計錯週期，唔係 cron 搶咗 scan；after 實測（§5）119.9/h、gap 30/30。**

## 1. 量度（before，2026-10-18 00:18:10–02:23:38Z）

```
node scripts/tick-metrics.mjs durable --label before --rows 240
```

| reading | value |
|---|---|
| ticks / span | 240 / 2.091 h |
| **per hour** | **114.8** |
| mean gap | **31.50s** |
| gap p50 / p90 / p99 / max | 31.83 / 40.79 / 45.40 / **46.53s** |
| histogram | <20s **17**、20–25 **22**、25–30 **24**、30–35 **125**、35–40 **22**、40–45 **22**、≥45 **7** |
| per hour | <20s 8.1、≥45s 3.3 |

同一個窗口嘅 `/debug/clock`：

```json
{"tickMs":30000,"on":true,"ticks":88,"lastWorkMs":2022,
 "lastAlarmAt":1792290093939,"alarmAt":1792290093939,"now":1792290087821}
```

`lastWorkMs 2022` 就係問題：`alarm()` 喺 `finally` 設
`this.lastAlarmAt = Date.now() + tickMs`，而 `Date.now()` 係**兩個 relay 跑完之後**，
所以每個週期 = 30,000 + work（~1–2s）。2.09 小時嘅均值 31.5s 對得住
（30,000 + ~1,500ms 加上 cron 相位嘅抖動）。

## 2. 機制：cron 唔係元兇（模擬同一把尺）

一支 600 分鐘嘅模擬（clock + 60s cron + 15s gate + work；工作時間掃過
0.5–3.0s，揀 1.0s 係因為佢重現 live 嘅 114.7/h）：

| 形狀 | tick/h | mean gap | p90 | max | ≥45s gaps |
|---|---|---|---|---|---|
| **current**（re-arm 喺 work 之後） | 114.7 | 31.4s | 40.8s | 46.8s | 3.9/h（＋短 gap 5.8/h） |
| **anchored**（re-arm 錨落 scheduled） | **120.0** | **30.0s** | ≤40.4s | **≤40.4s** | **0** |

掃 7 個 cron 相位（0/5/12/20/28/40/52s）嘅結果：

- **current**：全部 111.1–112.5/h（work 2.0s 時），即係相位唔影響均值 —— 蝕嘅係週期本身。
- **anchored**：全部 **120.0–120.1/h**，mean gap 29.99–30.00s。cron 相位只決定形狀：
  - 相位 < gate（15s）：cron 永遠過唔到 gate（age = 相位 < 15），clock 自己跑 30.0s 一拍；
  - 相位 ≥ gate：cron 每分鐘通過一次、封鎖緊接嘅一個 clock slot → 19.6s / 40.4s 交替。
  兩者都係 **120/h** —— 因為每次 cron scan 啱好吃掉一個 clock slot，均值唔變。
  呢個就係「cron 搶 scan 唔會蝕」嘅算術根據；要令 gap 全部 30s 就只可以叫 cron 讓路，
  但咁樣等於削走 backstop 嘅 scan 份額，而既然是 120/h vs 120/h，**唔值得動**。
  （after 實測同上：cron 過唔到 gate 嘅相位果然係 30/30，見 §5.2。）

## 3. 改動

`src/worker.ts`：新 pure helper（放在 `clockTickMs` 隔籬，同一個風格：export 出嚟俾測試釘）：

```ts
export function clockRearmAt(scheduledAtMs: number, tickMs: number, nowMs: number): number {
  const anchor = scheduledAtMs > 0 ? scheduledAtMs : nowMs;
  return Math.max(anchor + tickMs, nowMs);
}
```

- `TickClock.alarm()` 嘅 `finally`：`this.lastAlarmAt = clockRearmAt(this.lastAlarmAt ?? 0, tickMs, Date.now());`
  —— 讀到嘅 `this.lastAlarmAt` 就係**當前呢個 tick 原本幾點被 schedule**（上一個
  `finally` 或 `armIfUnset` 寫落）。
- `TickClock.armIfUnset()`：`setAlarm(at)` 之後記低 `this.lastAlarmAt = at`，
  令第一個 tick 都有 anchor（唔係嘅話佢會 fallback 落 `now + tickMs`，白蝕一次）。
- Edge cases（測試釘住）：`scheduledAtMs <= 0`（cold arm / eviction / 舊版本 arm 嘅
  alarm）→ `now + tickMs`，即係一次舊形狀，唔會跳；work 超過自己週期 →
  `Math.max(..., nowMs)` floor 住，唔會 set 一個過去嘅 alarm（過去嘅 alarm 會即刻
  fire，再由 gate/scan lock 仲裁）。
- 大 block comment 嘅 FAILURE SHAPE 段加咗一句講 anchor（period = tickMs，唔係
  tickMs + work）。

## 4. 測試

`npm run typecheck` → 0；`npm run test:unit` 全部 suite 綠（`test-unit.js` **575 passed /
0 failed**，14 個腳本全 exit 0）。

`scripts/test-unit.js` 嘅 clock suite 新增：

- `clockRearmAt` 三條：anchor（`now − 1.5s` → `now + 28.5s`）、冇 schedule 嘅 fallback、
  overrun 嘅 floor；
- 跑真 `TickClock` 物件：`lastAlarmAt = now − 1,500` → `alarm()` →
  `storage.alarmAt === now − 1,500 + 30,000`。**呢條等式就係回歸測試**：舊寫法
  （`Date.now() + tickMs`）永遠出 ~30,000 + work，等式不可能成立。

直接跑 `dist/worker.js` 嘅讀數（本地）：

```
anchored re-arm delta (s): 28.500   (old shape would be ~30.0 + work)
pure helper: anchored
cold re-arm delta (s): 30.000       (冇 schedule 記憶 = 一次舊形狀)
overrun floor: now
```

## 5. 部署後驗收（實測）

deploy = commit `c01056a`，run **39091740530**（migrate / deploy / catchup 全綠）。
Cloudflare 將新 code 交去運行中嘅 DO 用咗 ~4.5 分鐘（version 新 ≠ instance 即刻新），
實際換版 03:01:53Z，第一個 anchored tick 03:02:22.9Z。after 窗口 =
**03:02:22.9Z → 04:02:25Z（121 ticks / 1.00 h）**，同 §1 同一把尺（`/debug/scan-history`）：

| reading | before（deploy 前最後 240 rows：00:55:11–03:01:39Z） | after（deploy 後全部） |
|---|---|---|
| ticks / span | 240 / 2.11 h | 121 / 1.00 h |
| **per hour** | 113.4 | **119.9** |
| mean gap | 31.752s | **30.017s** |
| gap min / p50 / p90 / p99 / max | 16.65 / 31.89 / 41.19 / 45.40 / **46.53s** | 27.82 / **30.005** / 30.96 / 32.10 / **33.98s** |
| histogram | 15–20 **15**、20–25 23、25–30 23、30–35 125、35–40 24、40–45 23、≥45 **6** | 25–30 **57**、30–35 **63**，其餘桶 **0** |
| gaps <20s / ≥45s | 15 / 6 | **0 / 0** |

（before 呢組係 deploy 前「最後 240 條」，同 §1 嘅 00:18–02:23 窗口（114.8/h、p90
40.79s）同形狀，差異係 sample；重點係 after 嘅 min 已經貼住週期。）

同一窗口嘅 `/debug/clock`：

```json
{"tickMs":30000,"on":true,"ticks":121,"lastWorkMs":2266,
 "lastTickAt":"2026-10-18T04:02:23.629Z","lastAlarmAt":"2026-10-18T04:02:53.627Z"}
```

`lastAlarmAt − lastTickAt = 29,998ms`（改前係 `30,000 + lastWorkMs`），而
`lastWorkMs 2,266` 仍然係兩個 relay 嘅 wall clock —— 只係已經唔再加落週期。§4 嗰條
等式喺 live 成立。

### 5.1 對原定驗收（改動前 §5 嗰五點）

| # | 預期 | 實測 | |
|---|---|---|---|
| 1 | `lastAlarmAt − lastTickAt ≈ 30,000ms`；`lastWorkMs` 唔變 | 29,998ms；`lastWorkMs 2,266`（before 2,022） | ✅ |
| 2 | 240-tick 窗口：~120/h、mean 30.0±0.2、p90 ≤ 41s、max ≤ 41s | 121 ticks（未滿 240）：**119.9/h、mean 30.017s、p90 30.96s、max 33.98s** | ✅（窗口未滿，見 §6） |
| 3 | ≥45s = 0；<20s / 40–45s 兩帶仍可能出現 | **兩個帶都零出現** —— 呢個相位 cron 過唔到 gate（見 §5.2） | ✅ |
| 4 | 覆蓋/推送唔變；`scanLockSkips`/`deadTickStreak`/`backfilledTicks` 0；`writeDrainError`/`initError` null | `dbStore d1`、`initError`/`lastScanError`/`writeDrainError` null、`scanLockSkips 0`、`deadTickStreak 0`、`backfilledTicks 0`、`wedgedStateResets 0`、`crossIsolateScanSkips 0`；`profiles 26 / pool 1197 / candidates 1 / pushed 0` 正常形狀 | ✅ |
| 5 | cron 讀數只數 cron | `scheduledTickTotal 88958`、`scheduledArrivalTotal 19456`（每分鐘 +1）、ring 90 條全部 `:37.5x`、`scheduledArrivalUnaccounted false`；clock tick 冇入任何一樣 | ✅ |

### 5.2 follow-up：cron 嘅 gate 應唔應該讓路？（實測答案：唔使讓，呢個相位佢已經永遠過唔到）

問題：既然 gap 形狀係 cron / clock 相位決定，應唔應該改 gate，令 cron 喺 clock
健康時讓路，將形狀壓成嚴格 30s？實測：

- **cron 冇死**：ring 由 02:33 到 04:02 每分鐘一條、全部 `:37.54–:37.84`，
  `scheduledArrivalTotal` 每分鐘 +1。
- **cron 一次都冇 scan**：`scan_trigger_cron` 喺 03:51 → 04:02（11 分鐘、
  內含 10 個 arrival）企死 **18,541**，同期 `scan_trigger_clock` 29,042 → **29,064**；after
  窗口 121 條 tick 全部落喺 30s 格（histogram 只有 25–30 / 30–35 兩桶），抽樣
  `heartbeat.via` 全部 `clock`。
- **係結構性，唔係抖動**：clock 格 = `:23.63 / :53.63`（03:01:53Z 換版時
  `armIfUnset` 定落），cron arrival 平均 `:37.59` → 距上一個 completion 只有
  10.9–13.5s（arrival `:37.539–:37.843`、tick `ms 761–3,051`）< gate 15,000ms。就算
  嗰個 tick 零工作、arrival 最遲（`:37.843`），age 都只有 14.21s < 15s，所以呢個
  相位 cron **永遠**過唔到。

2 小時模擬（30s grid + 60s cron @ :37.55 + gate 15s + work 0.9s）嘅相位對照：

| clock 相位（mod 60s） | cron scan | rate/h | mean | min | max |
|---|---|---|---|---|---|
| **22.9（live）** | **0** | **120.0** | **30.00s** | 30.0s | 30.0s |
| 10–22 或 40–50 | ~60/h | 120.0–120.2 | 30.0s | 16.6s | **43.4s** |

**判決：唔郁。** 兩個 regime 都係 120/h（每次 cron scan 啱好食一個 clock slot），
所以「叫 cron 讓路」只係買形狀、買唔到 cadence；而代價係攞走 backstop 嘅 scan
份額 —— clock 死嗰陣 cron 係唯一仲保住 ~60s cadence 嘅嘢（HTTP rescue 係 120s）。
`docs/do-clock-2026-10-02.md` §8 已經用同一個理由拒過一次；after 實測只係確認：
呢個相位連讓路都唔使。

## 6. 限制（唔可以當過）

- **Alarm 係 best-effort，只會遲唔會早**：anchor 保證嘅係「遲嘅部分唔會累積」
  （改前每個 tick 累積 work），唔係 30.000s 嘅硬實時；所以每個 gap 仍然帶
  sub-second 到 1–2s 嘅 alarm lag。
- **冷啟動**：DO eviction / 新 deploy 之後嘅第一個 tick 冇 schedule 記憶 →
  一次 `now + tickMs`（同舊行為一樣）。呢個係刻意嘅：一個 tick 嘅相位重置好過
  記錯一個舊 schedule。
- **after 讀數有咗，但 240-tick 窗口未滿**：§5 嘅 121 ticks 係 deploy 後 60 分鐘嘅
  實測（per-hour 119.9 係呢 60 分鐘嘅讀數，唔係模擬）；窗口 ~05:10Z 先滿，屆時再
  讀同一支 command 補齊。
- **gap 形狀係「相位鎖定」**：anchored 之後 clock 格同 cron arrival 都固定喺一分鐘
  內嘅固定秒數，所以 cron 過唔過 gate 係 DO 換版嗰刻定落嘅一個 regime（今次實測：
  永遠過唔到 → 30/30）。下次 DO 換版可以翻去「每分鐘過」嘅 regime：形狀變
  ~16.6/43.4s 交替，rate 一樣 120/h、≥45s 仍然 0（§5.2 嘅相位表）。想形狀*保證*
  30/30 嘅槓桿係 arm / 重啟相位，唔係 gate。
- 已知項照舊：`SCAN_LOCK_TTL_MS` 未跟 clock period 縮短、`maybeRunScanIfStale`
  嘅 rescue gap 仍然行 `SCAN_INTERVAL_SECONDS`（見 `docs/do-clock-2026-10-02.md` §8）。
- 呢個修正只動 clock 自己嘅週期：gate 唔動、cron 份額唔動、`SCAN_INTERVAL_SECONDS`
  嘅意思唔動（clock off 時照舊）。
