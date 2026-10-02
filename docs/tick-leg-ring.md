# 每 tick 分段環（`/debug/tick-legs`）

## 為什麼有（2026-10-02 事後檢討）

429 風暴期間（00:49–01:06Z）有 7 個 8–14s 慢 tick，事後想問「邊一段食咗時間」時**已經冇得答**：

- `scan_history` 只有 8 欄（`at/ok/ms/err/profiles/pool/candidates/pushed`），冇 leg；
- `/health` 只保留**最新一個 tick** 嘅 `heartbeat.summary.*` 同 `tickProgress`；
- 唯一留低嘅風暴期內錨點係 `poolFallback.lastAt = 01:06:13.239Z`（喺 01:06:17 嗰個 8266ms tick 行到 4.1s 時，Turso pool 讀仲喺度失敗重試）。

同款形狀（細 pool／feed-only）今日仍然出現（03:20:07 tick，ms 5145：`poolMs 2400 / poolWaitMs 1870 / pairs 1202 / eval 1624 / preStart 1150+260`），但要逐個 tick 歸因，就必須**落線一個每 tick 嘅分段環**。

## 係咩

- `src/worker.ts` 模組級 `tickLegRing`：保留**本 isolate** 最近 `TICK_LEG_RING_SIZE = 120` 個 tick（≈ 2 小時）。
- 每個 tick 喺 completion flush **之前**記錄（flush 慢／失手都唔會帶走分段），cut／shed／early-return 全部照記。
- 每行＝`buildTickLegRow` 投影：`at / via / ok / ms / err / cut / cutNote / skip / subs`、front（`preStartMs / preRaceMs / raceMs / steps`）、scan legs（`feedsMs / preFeedMs / poolMs / poolWaitMs / poolLegMs / pairs / pairsJup / pairsMissing / evalMs / dbMs`）、counters（`profiles / pool / candidates / pushed`）。
- 冇 summary 嘅 tick（cut/shed/早退）leg 一律記 `null`，唔會造假 0——「冇讀數」同「用咗 0ms」係兩回事。

## 成本／界線

- **零 Turso round trip、零 subrequest**：純 module memory，唔入 tick 關鍵路徑。
- 代價同本檔其他 module-scoped 計數一樣：**環跟 isolate 一齊死**（eviction／deploy 清空），所以佢答「我頭先睇住嗰啲 tick 去咗邊」，唔答「琴日成隊 fleet 做過咩」——嗰半係 `scan_history` 嘅工作。

## 點讀

```
GET /debug/tick-legs          # 最新 60 行（newest first）
GET /debug/tick-legs?rows=120 # 打滿環
```

回應：`{ ok, now, count, capacity, rows: [...] }`。

下次風暴／慢 tick 期間，**趁 isolate 未死**抽一次就即刻有逐段答案；配 `/debug/scan-history`（持久 ms）同 `/health`（最新 tick）一齊睇就得。
