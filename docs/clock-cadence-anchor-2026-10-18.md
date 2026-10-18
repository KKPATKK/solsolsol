# 2026-10-18：clock 嘅 re-arm 錨落「alarm 自己嘅 scheduled time」（114.8 → 120 tick/h）

前提：`docs/do-clock-2026-10-02.md` 起咗個 30s 嘅 DO alarm loop，而它嗰句
「平均 32s ≠ 嚴格 30s」一直係已知項。呢份文件答一條更具體嘅問題：**240-tick 窗口
讀到 114.8 tick/小時（應該 120）—— 邊個部分係 cron 同 clock 打架（設計，唔蝕），
邊個部分係真蝕？** 答案係後者只有一樣：re-arm 喺 alarm body 之後才跑。

## 0. 結論

| # | 讀數（實測） | 原因 | 處理 |
|---|---|---|---|
| 1 | 240-tick durable 窗口：**114.8 tick/h**、mean gap 31.5s、p90 40.8s、max 46.5s；`/debug/clock` `lastWorkMs 2022` | re-arm 喺 `finally`（兩個 relay 之後）用 `Date.now() + tickMs`，所以真實週期 = `tickMs + work`（每個 tick 白加 ~2.0s） | ✅ 改成 `clockRearmAt`：下一個 alarm = **上一個 alarm 自己嘅 scheduled time + tickMs**（見 §3） |
| 2 | gap 分佈有兩條帶：<20s（8.1/h）＋ 40–47s（3.3/h ≥45s） | cron 通過 15s gate 嘅 scan 會封鎖下一個 clock slot —— **均值唔蝕**（每次 cron scan 啱好食一個 slot），只係 gap 形狀 | 唔郁：gate 同 cron 份額照舊（見 §2 嘅模擬：7 個相位全部 120/h） |
| 3 | 模擬預測（同一把尺） | anchored 之後：**120.0 tick/h、mean gap 30.0s、max ≤ 40.4s、≥45s gap 0** | ⏳ after 讀數要 deploy 之後讀（§5） |

一句話：**114.8/120 全部係 re-arm 計錯週期，唔係 cron 搶咗 scan。**

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

## 5. 部署後驗收（deploy 之後照順序讀）

1. `/debug/clock`：`lastAlarmAt − lastTickAt ≈ 30,000ms`（改前係
   `30,000 + lastWorkMs`）；`lastWorkMs` 本身唔變（~2,000ms）。
2. 等滿 240 個 tick（~2.1h）再讀同一支 command：

   ```
   node scripts/tick-metrics.mjs durable --label after --rows 240
   ```

   預期：per hour **~120（±1）**、mean gap **30.0s ± 0.2**、p90 ≤ 41s、**max ≤ 41s**、
   `gaps > 120s` = 0。
3. gap histogram：**≥45s 應該係 0**；<20s 同 40–45s 兩帶**仍然可能出現**（見 §2：cron
   相位固定之後，形狀會穩定成 20/40 交替或全部 30/30，兩者都係 120/h）。
4. 覆蓋/推送唔變：`candidates` / `pushed` 同改前同一形狀；`scanLockSkips 0`、
   `deadTickStreak 0`、`backfilledTicks 0`、`writeDrainError null`、`initError null`。
5. Cron 讀數冇被污染：`scheduledTickTotal` / ring / pre-init stamp 照舊只數 cron
   （今次改動冇碰任何 arrival 側嘅嘢）。

## 6. 限制（唔可以當過）

- **Alarm 係 best-effort，只會遲唔會早**：anchor 保證嘅係「遲嘅部分唔會累積」
  （改前每個 tick 累積 work），唔係 30.000s 嘅硬實時；所以每個 gap 仍然帶
  sub-second 到 1–2s 嘅 alarm lag。
- **冷啟動**：DO eviction / 新 deploy 之後嘅第一個 tick 冇 schedule 記憶 →
  一次 `now + tickMs`（同舊行為一樣）。呢個係刻意嘅：一個 tick 嘅相位重置好過
  記錯一個舊 schedule。
- **今次冇 after 讀數**：本地只有 typecheck/tests/模擬；§5 嘅嘢要 push → deploy
  之後才有，所以「114.8 → 120」而家係**預測**而非實測。
- 已知項照舊：`SCAN_LOCK_TTL_MS` 未跟 clock period 縮短、`maybeRunScanIfStale`
  嘅 rescue gap 仍然行 `SCAN_INTERVAL_SECONDS`（見 `docs/do-clock-2026-10-02.md` §8）。
- 呢個修正只動 clock 自己嘅週期：gate 唔動、cron 份額唔動、`SCAN_INTERVAL_SECONDS`
  嘅意思唔動（clock off 時照舊）。
