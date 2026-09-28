## 2026-09-28：真死因 —— Workers Free 每個 invocation 10ms CPU（推翻上面 §2026-09-23）

上面 §2026-09-23 講嘅「死因＝invocation 級 subrequest 上限 50」係**錯嘅**。真死因係 **Workers Free 嘅
每個 invocation 10 ms CPU 上限**。呢節記低推翻嘅過程同證據，因為原先嗰個框架（subrequest 預算）一直
主導住呢個 doc 同所有調優方向。

### 為何之前一直睇唔到

呢個 doc 自己講中咗一半：爆限嗰刻**最後死嘅就係 telemetry 寫入**（note／heartbeat／history 都係 Turso），
所以連「死嗰刻用咗幾多」都寫唔低 —— 一個自我封閉嘅觀測盲點。要答，就一定要一個**worker 外面**嘅證人。
嗰個證人係 `.github/workflows/cf-invocations.yml` ＋ `scripts/cf-invocations.mjs`：用 deploy workflow
自己嘅 `CLOUDFLARE_API_TOKEN`／`CLOUDFLARE_ACCOUNT_ID` 查 Cloudflare GraphQL 嘅 `workersInvocationsAdaptive`，
按分鐘列出每個 invocation 嘅 status／subrequests／cpuTime／memory。

### 決定性證據（run `36366536887`，window 2026-09-27T13:35Z–2026-09-28T01:35Z，`hours=12`）

十二個鐘嘅 status 分佈：**success 2838、`exceededResources` 19、`scriptThrewException` 7、
`clientDisconnected` 2**。19 條 `exceededResources` 一分鐘一條、落喺 00:33–00:52Z —— 即係同日嗰條
**00:33–00:53Z、約 20 分鐘**嘅 stretch，一個一個對得上。

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

三條線一齊收口：

1. **subrequest 唔可能係死因** —— 被殺嗰 19 個全部只行到 **6–21 個** subrequest（上限 50）；整個 12 小時
   window 3739 個 invocation 平均 **7.4 個**、典型一分鐘 **8.3 個**。script 自己嘅判詞：
   「That is nowhere near the cap, so the cap is NOT the mechanism.」
2. **CPU 完全對得上** —— 18 個被殺嗰個嘅 cpuTime **整整 10,000 us**（00:35 嘅 10,086 us 係量測抖動），即係
   **喺上限度被叫停**；同一分鐘生還嗰啲讀 7,827–145,655 us。12 小時整體：cpuTimeP50 **7,176 us**、
   cpuTimeP99 **276,184 us**，對住 **10 ms** 嘅 cron CPU 上限。
3. **記憶體排除** —— 被殺嗰批峰值 **16.2 MB**，對 128 MB isolate 上限差一個數量級。

機制（script 尾段落嘅結論）：Cloudflare 對「偶爾超限」嘅 Worker 有內建寬限，但對「持續超限」嗰個就
**收回** ——「**the slack is withdrawn for a few minutes at a time**」。呢個 worker 幾乎每個 tick 都超
（p50 7.2 ms、p99 276 ms），所以寬限一收，連續幾分鐘每個 tick 一出 scan 就被斬，就係一條 stretch。

### 具體推翻邊幾樣

- **「死因＝subrequest 50」** ⇒ 改成「死因＝CPU 10 ms」。爆 50 嗰個失敗模式可能存在，但唔係呢 19 個。
- **`prog scan +0ms subreqs N`**（本 doc §2026-09-24 嗰套 stage stamp）：`subreqs N` **唔係死嗰刻嘅數** ——
  `stage:"scan"` 嗰個 admission stamp 騎喺 `db.claimScanLock(...)` 嗰個 batch 上面寫（`src/worker.ts` ~4079），
  即係 **claim 嗰一刻**嘅讀數。所以「6–21 個 subrequest 就死」係假象，唔係證據。
- **「減 Turso round trip 係免費方案下唯一槓桿」** ⇒ 減 round trip 仍然係好習慣（新 build 健康 tick 量到
  `subreqs.current total 33`，turso 24；亦有 `recent[1]: owner scan total 40` 貼住可用上限 38），
  但**唔係** stretch 嘅修法。免費方案下真正嘅槓桿係**減 CPU 支出**。

**順手記低**：`beginSubreqWindow` 係**逐 module** 埋單，tracker pass 自己嗰個 cron 落喺同一個 isolate 會
**截斷** scan 嗰條 window（實測 scan total 1、pass total 3、相差 1 ms），所以單一 tick 嘅真實 subrequest
總數而家係讀唔到嘅 —— 除非加一個 invocation 級嘅 window。

### 修法（更新 §2026-09-23 嘅「修法」一節）

**Workers Paid（US$5/月）係唯一直線修法**：cron CPU 10 ms → **30 s**、subrequest 50 → 1,000（Free 唔可以
調高；`wrangler [limits] subrequests` 只係喺 Paid 之內再調），而且解鎖 **Workers Logs**。付費之前，免費方案
想活就要**壓 CPU**；呢個變成之後每次 audit 嘅度量單位。

### 驗收（下次 stretch 點睇）

1. 再出現「冇 completion」嘅窗口，用 `scripts/cf-invocations.mjs` 對嗰幾分鐘：`exceededResources` 嗰批
   應該係 **cpuTime = 10,000 us ＋ subrequests 遠低於 50**。若果然係**另一種**形狀（例如 cpuTime 只有幾 ms、
   subrequests 貼 50），咁就係一個新機制，唔可以套返呢個結論。
2. `CFMIN` 行嘅 `cpuByStatus.exceededResources` 對 `cpuByStatus.success` 兩欄，就係「同一分鐘被殺 vs 生還」
   嘅直接對照。
3. 呢個 workflow 嘅 `schedule:` 係**暫時**嘅：等 dead tick 完全歸因（或上 Paid）之後，刪走 `schedule:`，
   淨留 `workflow_dispatch`（同 path 觸發）。
