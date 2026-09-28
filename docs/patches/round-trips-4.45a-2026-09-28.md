### 4.45a 補正：A（drain 搬去 flush 之後）實測即刻回退，剩下 B（2026-09-28 02:2xZ）

新 build 02:21:40Z 上線之後，**同一日即刻量到 A 有代價，所以回退咗 A、保留 B**。數字：

| 時間（build） | `calls` | `shed` | `reserve` | `owedTokens` |
|---|---|---|---|---|
| 01:11–01:16（A 之前） | 3 / 2 / **4** / 2 | — | 6 | 129 → 185 → **141** → 214（有跌過） |
| 02:23:14（A 之後） | **0** | `dead-predecessor` | 14 | 124 |
| 02:25:54（A 之後） | **0** | null | 9 | 244 |
| 02:26:35 | **0** | null | 9 | 293 |
| 02:27:14 | **0** | null | 6（強制） | 344 |
| 02:28:13 | **1** | null | 6 | **420（釘死喺 400 上限）** |

原因好清楚：drain 而家跑喺 flush **之後**，而佢自己嘅 room check 係 `subreqRemaining() <= reserve` ——
flush 已經花咗嗰份，所以幾乎每個 tick 都係「冇 room」，walk 一次都唔開始。隊列唔會爆（coalescing 按 token，
上限由 pool 嘅 distinct token 數決定），但變成一條**永遠追唔上嘅 backlog**（每 tick 入 ~150 筆、出 40 筆），
而 `token_stats` 簿記（registration、max-mcap raise）落後 = 一個 tick 嘅延遲承諾唔再成立。

**所以 A 冇留低。** 留下嘅係：

- drain 返去原本嘅位置（`onTickEnd` hook，即係 flush 之前），`calls 1–4`、隊列會跌返 —— 同 A 之前一樣；
- **B（死亡 tick 收縮到一個 call）照留**，而且位置更貼題：嗰個 tick 個 drain 正正排在**自己嘅 completion
  flush 前面**，所以「少花 9 個 round trip」係直接俾咗嗰個要收尾嘅寫入。Live 已經見到 B 上線：
  02:23:14 嗰個 tick `shed: "dead-predecessor"`（同時 `calls 0`，即係嗰個 tick 連一個 call 都冇 room）。

**老實講嘅 trade-off（仍然存在，唔係解決咗）**：drain 嘅 round trip 依然排在 flush 前面。要安全咁搬佢過去，
需要一個真正嘅**預算分割**（drain／flush／pass 各有明確份額），而唔係三個階段輪流去量同一個 `reserve` ——
呢個係下一步，唔係今次。

**驗收點更新**（取代 §4.45 第 3 點）：`owedTokens` 應該同改動前一樣喺 100–400 之間震盪（有升有跌），
`calls` 每個 tick 1–4；`shed: "dead-predecessor"` 只會喺 backfill 咗死亡嗰個 tick 出現（唔應該連續幾個 tick 都係 1）。

**順手記低**：deploy 落地之前，01:47:09.586Z 開嘅嗰條 stretch 一直燒到 `scan_wedge.tickAt` **02:21:24Z**
（約 34 分鐘，同前幾次一樣由 deploy 收尾）；deploy 之後到 02:28Z 冇再出現新嘅死亡 row。
