# 每 tick 分段環（`/debug/tick-legs`）

## 為什麼有（2026-10-02 事後檢討）

429 風暴期間（00:49–01:06Z）有 7 個 8–14s 慢 tick，事後想問「邊一段食咗時間」時**已經冇得答**：

- `scan_history` 只有 8 欄（`at/ok/ms/err/profiles/pool/candidates/pushed`），冇 leg；
- `/health` 只保留**最新一個 tick** 嘅 `heartbeat.summary.*` 同 `tickProgress`；
- 唯一留低嘅風暴期內錨點係 `poolFallback.lastAt = 01:06:13.239Z`（喺 01:06:17 嗰個 8266ms tick 行到 4.1s 時，Turso pool 讀仲喺度失敗重試）。

同款形狀（細 pool／feed-only）今日仍然出現（03:20:07 tick，ms 5145：`poolMs 2400 / poolWaitMs 1870 / pairs 1202 / eval 1624 / preStart 1150+260`），所以要逐個 tick 歸因，就要有**每 tick 分段環**。

## 係咩：兩半，缺一不可

### 1. 記憶體環（`rows`）

- `src/worker.ts` 模組級 `tickLegRing`：保留**本 isolate** 最近 `TICK_LEG_RING_SIZE = 120` 個 tick（≈ 2 小時）。
- 每個 tick 喺 completion flush **之前**記錄（flush 慢／失手都唔會帶走分段），cut／shed／early-return 全部照記。
- 每行＝`buildTickLegRow` 投影：`at / via / ok / ms / err / cut / cutNote / skip / subs`、front（`preStartMs / preRaceMs / raceMs / steps`）、scan legs（`feedsMs / preFeedMs / poolMs / poolWaitMs / poolLegMs / pairs / pairsJup / pairsMissing / evalMs / dbMs`）、counters（`profiles / pool / candidates / pushed`）。
- 冇 summary 嘅 tick（cut/shed/早退）leg 一律記 `null`，唔會造假 0——「冇讀數」同「用咗 0ms」係兩回事。

### 2. 持久慢 tick 環（`slow`）

**為何要**：落線嗰日實測——`/health` 每次抽到嘅 isolate 都係 `scanCount 0`，但 durable heartbeat 嘅 `claimScanLock` 由 7 一路升。即係話 **cron tick 同 HTTP 讀取唔係同一個 isolate**；module-state 環永遠讀唔到，答唔到佢存在嘅目的。

所以慢 tick（`ms ≥ TICK_LEG_SLOW_MS = 8_000`，即 2026-10-02 風暴嗰批）另外寫入 `worker_state` 嘅 `TICK_LEG_SLOW_KEY`：

- ring 容量 `TICK_LEG_SLOW_RING_SIZE = 20`，oldest→newest 存，讀取時倒序；
- 寫入係 read-modify-write（一次讀舊環、一次寫新環），**fire-and-forget、唔 await**（`tickWaitUntil` 保 invocation 唔死），唔喺 tick 關鍵路徑上；
- 成本：慢 tick 先至多 2 個 subrequest（實測 500 tick 得 7 個 ≥8s，全部喺風暴窗口）——快 tick 一個額外 round trip 都唔使畀。

## 點讀

```
GET /debug/tick-legs          # 最新 60 行（newest first）
GET /debug/tick-legs?rows=120 # 打滿記憶體環
```

回應：`{ ok, now, count, capacity, slowMs, slowCapacity, rows: [...], slow: [...] }`

- `rows`＝**呢個 isolate** 嘅記憶體環（如果就係會 tick 嗰個 isolate，最完整）；
- `slow`＝**fleet 嘅持久慢 tick 環**（最後 20 個 ≥8s tick，newest first）——就算請求落到唔會 tick 嘅 isolate 都有答案。

下次風暴期間抽一次 `/debug/tick-legs`，配 `/debug/scan-history`（持久 ms）同 `/health`（最新 tick）一齊睇就有逐段歸因。
