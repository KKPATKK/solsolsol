## 4.46 真死因：Workers Free 每個 invocation 10ms CPU —— §4.45 嗰個 subrequest 框架被推翻（2026-09-28）

### 點解今次先有硬證據

`docs/scan-completion-loss.md` §2026-09-23 一直講「死因＝invocation 級 subrequest 上限 50」，而 §4.45 尾段仲寫住
呢個係「唯一解釋得晒所有形狀嘅機制」。兩者都係**由 worker 內部推論出嚟**，而且個機制本身係**loop 死**：
爆預算就係死喺 telemetry 寫入，所以「死嗰刻用咗幾多」永遠寫唔低。要打破個循環，就要一個**worker 外面**嘅證人。

`.github/workflows/cf-invocations.yml`（`cron: "7,37 * * * *"`，兩個鐘一次）＋ `scripts/cf-invocations.mjs`
就係嗰個證人：用 deploy workflow 自己嘅 `CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID` 直接查 Cloudflare
GraphQL 嘅 `workersInvocationsAdaptive`，按分鐘列 status／subrequests／cpuTime／memory，唔經 worker 任何一行 code。

### 決定性嘅一 run（run `36366536887`，window 2026-09-27T13:35Z–2026-09-28T01:35Z，`hours=12`）

十二個鐘嘅 status 分佈：

| status | invocations | |
|---|---|---|
| success | 2838 | 正常 |
| **exceededResources** | **19** | 非 success —— 就係告警嗰個形狀 |
| scriptThrewException | 7 | |
| clientDisconnected | 2 | |

19 條 `exceededResources` **一分鐘一條、落喺 00:33–00:52Z**（00:33、00:34…00:44、00:46、00:47…00:52），
即係 §4.45 追嗰條 **00:33–00:53Z、約 20 分鐘**嘅 stretch，一個一個對得上。逐分鐘嘅幾條關鍵讀數：

| 分鐘 | 嗰個 failed 嘅 subrequests | 佢嘅 cpuTime (us) | 同一分鐘生還者嘅 cpuP99 (us) |
|---|---|---|---|
| 00:33 | 21.0 | **48385** | 11792 |
| 00:34 | 8.0 | **10000** | 27965 |
| 00:35 | 8.0 | **10086** | 31824 |
| 00:36 | 8.0 | **10000** | 27287 |
| 00:37 | 9.5 | **10000** | 26139 |
| 00:38 | 12.5 | **10000** | 25863 |
| 00:39 | 7.5 | **10000** | 29048 |
| 00:40 | 8.0 | **10000** | 31970 |
| 00:41 | 9.0 | **10000** | 39672 |
| 00:42 | 9.0 | **10000** | 40299 |
| 00:43 | 10.0 | **10000** | 7827 |
| 00:44 | 9.0 | **10000** | 24144 |
| 00:46 | 20.0 | **25982** | 119226 |
| 00:47 | 8.0 | **10000** | 27582 |
| 00:49 | 8.5 | **10000** | 29973 |
| 00:50 | 6.0 | **10000** | 11411 |
| 00:51 | 10.0 | **14181** | 145655 |
| 00:52 | 7.0 | **10000** | 29513 |

（00:48 嗰條係 `scriptThrewException`，唔係 `exceededResources`，所以唔入上面呢組。）

**subrequest 上限唔可能係死因 —— 數字自己講**：嗰 19 個被殺嘅 invocation 全部只行到 **6–21 個 subrequest**
（Free 上限 50）。整個 12 小時 window 更加係 3739 個 invocation、平均 **7.4 個** subrequest、典型一分鐘 **8.3 個**
—— script 自己都咁落結論：「That is nowhere near the cap, so the cap is NOT the mechanism.」

反過來，CPU 嗰條線完全對得上：

- 18 個 `exceededResources` 嘅 cpuTime **整整 10,000 us**（00:35 嗰個 10,086 us 係同一個數嘅量測抖動）——
  唔係跑得啱啱好，而係**喺 10,000 us 被人叫停**，所以讀數釘死喺上限度。
- 同一分鐘、同一批 isolate、**生還**嗰啲 invocation 讀 7,827–145,655 us，好多遠超 10 ms 都跑得完。
- 12 小時整體：典型一分鐘 cpuTimeP50 = **7,176 us**、cpuTimeP99 去到 **276,184 us**（≈27 倍上限），
  而 Workers Free 嘅 cron CPU 上限係 **10 ms**。
- 記憶體先排除（錯得比較平嗰個）：被殺嗰批峰值 **16.2 MB**，對住 128 MB isolate 上限，差一個數量級。

script 尾段嗰句就係個機制：

> An invocation killed with `exceededResources` reports cpuTime EXACTLY at 10,000 us (the limit, where
> Cloudflare stopped it), while invocations in the same minute that were allowed to finish report
> 14,000-121,000 us. … an isolate has built-in flexibility for a Worker that runs over its limit
> INFREQUENTLY, and … one which hits it CONSISTENTLY gets terminated. That is the burst: **the slack is
> withdrawn for a few minutes at a time**.

呢句解釋晒所有形狀：呢個 worker 幾乎**每個** tick 都超 10 ms（p50 7.2 ms、p99 276 ms），Cloudflare 對「偶爾超」
有寬限，但對「持續超」就收回 —— 收回嗰幾分鐘就係一條 stretch，每個 tick 一出 scan 就畀人斬。

### 所以推翻咗乜嘢

- **§4.45「界線（老實講）」第二點**（「§2026-09-23 嘅結論依然係唯一解釋得晒所有形狀嘅機制」）⇒ **唔成立**。
  被殺嗰批係**喺 50 之前**就死，唔係撞到 50。
- **§2026-09-23 成節**：invocation 級 subrequest 上限 50 唔係死因（`docs/scan-completion-loss.md` 已加
  overturned banner ＋ §2026-09-28 正式更正）。爆 50 嗰個失敗模式**可能存在**，但唔係呢 19 個。
- **`prog scan +0ms subreqs N` 呢個形狀**：「一開 scan 就死」係真嘅，但 `subreqs N` **唔係死嗰刻嘅數** ——
  `stage:"scan"` 嗰個 admission stamp 騎喺 `db.claimScanLock(...)` 嗰個 batch 上面寫（`src/worker.ts` ~4079），
  即係 **claim 嗰一刻**嘅讀數。所以佢從來冇證明過 50 呢條線；真正嘅解釋係 claim 之後一入 scan 就撞 CPU 封頂。

### 但係 subrequest 讀數係真嘅，只係唔 binding

唔可以因為咁就當佢唔存在：新 build 一個健康 tick 量到 `subreqs.current total 33`（turso 24、jup 5、…），
而且有讀數見到 `recent[1]: owner scan total 40`（可用上限 38，即係**貼住**）。所以：

- 減 round trip 依然係好習慣，尤其係上 Workers Logs 之後想睇清成本嗰陣；
- 但**唔係**今次 stretch 嘅成因。之前每次 audit 減 round trip 而 stretch 照樣出現，就係因為槓桿唔喺呢度。

**順手記低一個 instrumentation 缺口**：`beginSubreqWindow` 係**逐 module** 埋單，唔係逐 invocation ——
tracker pass 自己嗰個 cron 落喺同一個 isolate，會**截斷** scan 嗰條 window（實測：scan total 1、pass total 3、
相差 1 ms）。即係單一 tick 嘅真實總數，而家係讀唔到嘅；要真係量，就要一個 invocation 級嘅 window。

### 修法

**Workers Paid（US$5/月）係唯一直線修法**：cron CPU 10 ms → **30 s**（3,000 倍）、subrequest 50 → 1,000
（Free 唔可以調高；`wrangler [limits] subrequests` 只係喺 Paid 之內再調），而且解鎖 **Workers Logs** ——
今次呢個結論係靠 Cloudflare 嘅分析 API 拼出嚟嘅，Paid 之後可以直接睇 invocation log。

### 界線（老實講）

- 呢個結論**唔改**一個死 tick 嘅代價（一個 rotation turn 冇咗、一串讀數斷層），亦**唔改**任何 telemetry 嘅行為：
  寫唔入嗰啲 row 一樣寫唔入。佢改嘅係**原因**同**下一步**。
- Paid 之前，免費方案冇任何旋鈕可以直接買到 10 ms 以上嘅 CPU —— 只有**減少每個 tick 嘅 CPU 支出**。
  呢個就係下一個 audit 嘅方向（而唔再係「減 subrequest 數」）。
- 證據要留住：Cloudflare 分析 API 嘅 Free 保留期短，`scripts/cf-invocations.mjs` 繼續留（Paid 之後一樣可以
  當佢係「有冇 tick 又封頂」嘅探針）；`.github/workflows/cf-invocations.yml` 個 `schedule:` 就係為咗呢件事
  而暫時存在。
