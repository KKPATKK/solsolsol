### 4.44a 補正：落地要「一個 tick 多個 slice」，唔係每個 bucket 一個（2026-09-28 01:0xZ，deploy 之後即刻量到）

強制落地 rule（`reserve 6`）確實生效 —— 但隊列**仍然繼續升**：

| 時間 | `calls` | `heldForTracker` | `reserve` | `owedTokens` |
|---|---|---|---|---|
| 00:57:50 | 2 | 0 | 9 | 251 |
| 00:58:41 | 1 | 1 | 9 | 356 |
| 00:59:12 | 2 | 0 | **6** | 424 |
| 01:00:12 | 2 | 0 | 6 | 477 |
| 01:02:29 | 2 | 0 | 6 | 548 |

`calls 2` 每個 tick 都有落地（舊 build 係 `calls 0`），但 `owedTokens` 由 356 爬到 548，即
**+53…+71/tick**。原因係結構性：`ready = owedBuckets()` 係一個快照，個 loop 每個 bucket **只跑一次**，
所以一個 drain 最多就係每個 method 一個 40 筆嘅 slice = **80 筆/tick**，而 scanner 每個 tick 入隊
**~150 筆**（`recordTokenStatsMany` ×2 ＋ `updateTokenMaxMcaps` 掃 pool slice）。淨增長 ~+55/tick。

**改動**：一個 bucket 落完一個 slice 之後如果仲有筆數，就掉去 **worklist 隊尾**（兩個 method 之間
保持公平），所以 reserve 以上嘅 room 會用嚟落**整個 slice**，直到 room 冇或者撞到
`DEFERRED_MAX_CALLS_PER_DRAIN = 10`（10 × 40 = 400 筆，即隊列自己嘅上限）。
room check 仍然係真正嘅邊界（每個 call 一個 subrequest，落到 `reserve` 就停），個 cap 係防止
「room 讀數永遠唔跌」嗰種情況把一個 invocation 變成無上限嘅 walk。

**測試**：`90 筆 = 40 + 40 + 10`（同一個 drain）＋「過 cap 就留住剩額」；另外原本 coalescing 測試
嗰句「43 筆要兩個 drain」已經跟行為改成「同一個 drain 分 slice 交完」（一個 call 依然最多 40 筆）。
mutation 8/8 全部被捉到（新增：抽走 re-queue、把 cap 改成 1）。

**驗收更新**：`owedTokens` 應該**跌返落 100 上下並穩定**（唔再單調上升），`calls` 每個 tick 1–4、
`reserve` 6（強制）或 9（量度到）；若 `calls` 長期只有 2 而同 `owedTokens` 一齊升，即係 re-queue
或者 cap 有問題。
