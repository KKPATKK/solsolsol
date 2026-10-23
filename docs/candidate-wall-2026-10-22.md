# 2026-10-22：慢 tick 的第 0 + 1 層 —— 留住讀數，同埋每個 candidate 自己嘅牆

## 一、量到乜（2026-10-22，production，20 個慢 tick）

| 形狀 | `evalMs` | 結果 |
|---|---|---|
| 1 個 candidate | 7,098–7,286 | 推得到，但成條 chain 食晒窗口 |
| 2–3 個 candidate | 8,265–9,422 | `candidates 2, pushed 0`（後面嘅被 defer） |

兩個獨立問題，所以分兩層做：

1. **冇讀數**（層 0）：`/health` 只留最新一個 tick 嘅 summary，`tick_legs` 係固定
   17 欄，`pushPhase`／有機讀數／`fails` 一概冇落 durable row。tick 一過，嗰個
   「邊一步食咗 3 秒」嘅答案就冇咗，audit 只能再 poll `/health` 撞彩。
2. **冇牆**（層 1）：candidate chain 每一步都只 clamp 去**共用** `chainDeadline`
   （tick start + 8.1s），冇任何一步有自己嘅預算。RugCheck 嘅 2s+4s retry ladder
   係 **6 秒 sleep**（`AbortSignal.timeout(15_000)` 每次 attempt），`bestEffort` 只係
   「唔再等」——個 promise 同啲 sleep 照跑，個 coin 嘅窗口照樣燒。第一個 coin 燒完，
   第二、三個就係 `pushed 0`。

## 二、層 0：慢 tick 嘅讀數要留得住

`TickLegRow`（`src/worker.ts`，`/debug/tick-legs` 嘅 `rows`／`slow`）加咗：

| 欄 | 來源 | 答乜 |
|---|---|---|
| `pushPhase` | `ScanSummary.pushPhase` | tick 停喺邊一步（`rugcheck` / `wallets` / `flurry` / `send:*`） |
| `organicMs` / `organicWaited` / `organicRetried` / `organicStatus` | Jupiter card read 嘅 per-card note | 有機讀數等咗幾久、等咗／retry 咗幾多次、最後 HTTP status |
| `walletAnalysis` | `diag.walletAnalysis` | 錢包分析有冇完成（0 = 冇） |
| `flurryRpcCalls` | `diag.flurryRpcCalls` | Flurry 用咗幾多個 Helius call |
| `fails` | `diag.fails`（copy，唔係 alias） | 邊個 gate 擋咗幾多個 coin |

呢啲欄唔入 `tick_legs`：嗰張表每加一欄就係一次 migration，而 `TickLegRow` 本身已經有
JSON durable 半（`persistSlowTickLeg` → `worker_state: tick_leg_slow`，ms ≥
`TICK_LEG_SLOW_MS` 才寫，即 7/500 個 tick）。所以慢 tick 嘅 chain split 由「只有
isolate 內存」變成「跟 ring 一齊落 durable」，零新 request。

冇 summary 嘅 tick（cut / shed / early return）照舊**全部 null**，唔會補 0：
「冇讀數」同「用咗 0ms」係兩個答案（`buildTickLegRow` 嘅契約）。

## 三、層 1：每個 candidate 自己嘅牆

### 1. `CANDIDATE_CHAIN_BUDGET_MS = 3_500`（`src/scanner.ts`）

```ts
const candidateDeadline = Math.min(
  chainDeadline,
  Date.now() + CANDIDATE_CHAIN_BUDGET_MS,
);
```

由 `resolveRugcheckData` 開始，`crime`、`axiom`、`wallets`（Helius 分析嘅
`deadline` 亦一齊換）、`flurry` 全部 clamp 去 `candidateDeadline`。效果：

- 一個慢 upstream 只會蝕**佢自己嗰個 coin** 嘅裝飾（卡片「未檢測」／「—」），
  下一個 coin 仲有窗口。
- 3.5s 係兩張卡塞得入 8.1s chain window 嘅數（2 × 3.5 ≤ 8.1），而單一 candidate
  仍然留足 1.5s `CANDIDATE_PUSH_RESERVE_MS` 俾 send。
- 所有步驟照舊 **fail open**：RugCheck 冇數 → 卡片「未檢測」；wallet 冇數 →
  卡片少一行；Flurry 冇數 → 唔擋；有機閘冇讀數 → 唔擋（send gate 嘅 hold 仍然
  會等同一條 promise）。

### 2. RugCheck ladder 兩邊都有界（`src/rugcheck.ts`）

- 每個 attempt 嘅 `AbortSignal.timeout` 由 15s 改成
  `min(REQUEST_TIMEOUT_MS, deadline - now)`；
- retry 嘅 2s / 4s backoff **跨過 deadline 就唔 sleep**，直接 break；
- `Throttle.run` 喺**入睡前**檢查：等唔到 deadline 就 throw，唔會再出現
  「`bestEffort` 已經放棄，但個 sleep 照跑 5 秒」嘅背景燒窗口；
- 冇傳 deadline 嘅 caller 行為完全不變（舊 test／其他入口零影響）。

### 3. 有機閘自己嘅等待：`ORGANIC_GATE_WAIT_MS = 1_500`

早期 Jupiter gate 唔再等足 candidate 牆：讀數喺 chain 頭已經 dispatch，到 gate 仲未
返就係等緊 429 窗口，而呢個判斷 **fail open**，等多 1.5s 只會拖住個 coin，唔會改變
verdict。真正需要讀數嘅判斷喺 send gate 嘅 hold（`ORGANIC_CARD_GATE_HOLD_MS`），
所以晚到嘅讀數仍然 judge 得到。

## 四、驗證

- `scripts/test-rugcheck-deadline.js`（新）：429 ladder 一個 attempt 就收工（<1s）；
  throttle 唔會為咗等位而入睡；正常路徑讀數不變；scanner 真係將
  `candidateDeadline` 傳去 rugcheck / wallet / flurry，早期閘用
  `organicGateDeadline`；2 × 3.5s ≤ 8.1s 嘅算術。
- `scripts/test-tick-legs.js`：新欄位有 map、有 copy、冇 summary 時係 null。
- `npm run test:unit`：586 + 全部附屬 suite 綠。

## 五、之後點睇

`/debug/tick-legs` 嘅 `slow`（durable）而家可以直接答：

- `pushPhase` → 慢 tick 停喺邊一步；
- `organicMs` / `organicStatus` → 有機讀數係「慢」定「refuse」；
- `fails` → 有冇 gate 連環擋（例如 `fails.mcap` 飆升 = 上游 pool 讀數變差）。

如果 3.5s 之後 `evalMs` 仍然成日貼住 8.1s，下一步（層 2）就唔再係加牆，而係睇
`walletAnalysis` 同 `flurryRpcCalls`：兩個都係 Helius 序列 call，一張卡 8 個 wallet
就係 8 個 round trip。
