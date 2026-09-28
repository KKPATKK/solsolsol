## 4.45 死亡之後嗰個 tick：drain 收縮到一個 call，同埋 drain 唔再排喺 completion flush 前面（2026-09-28）

### ⚠️ 先更正上一節：原本 §4 講嘅「self-heal 從來冇 fire」係錯嘅

上一 turn 報嘅缺口（`if (flushSettled) deadTickStreak = 0;` 喺檢查之前歸零，所以 `finally` 嗰條重建路徑
永遠到唔到 2）**係真嘅 code 缺口，但唔係 00:33–00:53Z 呢條 20 分鐘 stretch 嘅成因**：successor 側**另有一條
冇門檻嘅重建路徑** —— `deadTickRebuildDecision`，跑喺 `ensureInitialized` 最前面，條件只有「前一個 tick 係
stale `phase=scanning` 而且 heartbeat 冇 `rebuiltAt` 標記」。而個標記係重建自己寫落 heartbeat，之後由**claim**
寫嘅 `heartbeatJson`（唔帶 `rebuiltAt`）覆蓋。所以：

> **每一條成功落地嘅 backfill row，都證明嗰個 successor 嘅 claim 有落地；claim 覆蓋咗標記 ⇒ 嗰個
> successor 一定行過重建。**

12 條 backfill row ⇒ 20 分鐘內最少 12 次重建（差唔多每分鐘一次），而死亡照樣繼續。重建已經清晒**所有**
module state（`dex`／`helius`／`gmgn`／`scanner`／`initPromise = null`，`initPromise` 一 null 就連
`db = new PoolFallbackDb(...)` 都重開），所以「isolate module state 中毒」唔係成因，再多 wire 一條
counter-based 重建只係第二條醫唔到病嘅路。**結論：§4 冇落手，改為落下面兩樣（同一份證據支持）。**

### A. drain 由「flush 之前」搬去「flush 之後」（真正嗰個修法）

`drainDeferredWrites()` 本來 fire 喺 tickprobe 嘅 `onTickEnd` hook，而**嗰個 hook 係喺 worker 嘅 completion
flush 之前跑**：`onTickEnd` 係 scanner `runOnce` wrapper 嘅 `finally`，而 `flushJson`（`buildFlushPayload()`）
同 `persistScanCompletion()` 係 `runOnce` **return 之後**才 build／寫（`worker.ts` ~4110 → 4255 → 4297）。
即係每個 tick 最多 `DEFERRED_MAX_CALLS_PER_DRAIN = 10` 個 bookkeeping round trip（libsql 內部重試下，每個可以
變成 2–3 個 platform subrequest）**排在嗰個 tick 唯一唔可以輸嘅寫入前面**。drain 自己嘅註釋一路都寫
「called by the worker AFTER its completion flush」——呢個改動係令實作同合約一致。

- 改：`onTickEnd` 唔再 fire（原地留一段解釋），改為喺 tick tail、**completion flush 之後**、tracker pass 之前 fire。
- 效果：`drainTrackerReserve` 講嘅「leave for the tracker pass behind it」終於字面成立（drain 之後只剩 pass ＋ deferral sync）。
- 冇改：`writeDrain` 讀數依然係「上一個 tick 嘅 drain」（summary 喺 `onTickEnd` 時序列化），queue 依然係 module state、依然由 `tickWaitUntil` 夾住，fire-and-forget 冇 twin。

### B. 「backfill 咗死亡」嗰個 tick 收縮 drain（§4 想講嘅嘢，但用喺有效嘅地方）

`runScan` 本來就知道自己 backfill 咗一個死亡（`dead !== null`）。呢個 tick 正正係**要證明死亡潮結束**嗰個
tick ——佢自己嘅 completion flush 就係收尾嗰個寫入。所以：

```ts
drainCallCeiling(deadPredecessor)  = deadPredecessor ? DEFERRED_DEAD_PREDECESSOR_MAX_CALLS : DEFERRED_MAX_CALLS_PER_DRAIN
drainShedReason(deadPredecessor)   = deadPredecessor ? "dead-predecessor" : null
```

`drainDeferredWrites(subreqLeft, { maxCalls, shed })` 多咗一個 `DrainOptions` 參數，`WriteDrainView` 多咗一個
`shed` 讀數（null = 正常 ceiling）。一個 call（最多 40 筆）依然令隊列有進展（queue coalesces，冇落地嘅繼續
owed），剩返嘅 allowance 留俾 pass 同 deferral sync。正常 tick 一行都冇改：依然最多 10 個 call，而
`owedTokens ≥ 400` 嘅強制落地規則唔變。

### 測試 ＋ mutation

- `scripts/test-unit.js`：新測試「a tick that backfilled a death sheds its drain to one call」——1 個 call、
  `shed` 有出、其餘 owed、`heldForTracker 2`，而且有 **control**（同一個隊列、同一個 room、正常 ceiling）
  證明 room 真係允許更多 call（冇 control 就分唔清「shed」同「隊列本來就細」）。另有 source drift guard：
  drain 嘅 call site 必須喺 `db?.persistScanCompletion(` **之後**（`drainAt > flushAt`）。
- `scripts/test-tick-path.js`：`drainCallCeiling` / `drainShedReason` 嘅純規則（`1 < 10`，唔可以反過來）。
- mutation **5/5 全部被捉到**（`docs/patches/dead-tick-shed-mutation-2026-09-28.check.js`，逐個跑、每次 byte-for-byte
  還原）：M1 忽略 caller 嘅 ceiling、M2 唔發布 `shed`、M3 `drainCallCeiling` 永遠回正常值、
  M4 `drainShedReason` 永遠 null、M5 把 drain 搬返 `onTickEnd`（即係 fix 之前嘅形狀）。
- 全樹：`npx tsc --noEmit` ✅、`npm run build` ✅、`test-unit` **387/0**、`test-tick-path` ✅、
  `test-deferred-priority` ✅、`test-dex-list-cache` 9/0、`test-dex-last-profiles` 13/0、`test-schema-gate` 6/0、
  `test-health-front` 5/0、`test-usd-formatter` 4/0。

### 驗收點（deploy 後）

1. `/health.writeDrain`：正常 tick `shed: null`、`calls 1–4`；backfill 嗰個 tick `shed: "dead-predecessor"`、`calls 1`。
2. `scan_wedge`：下一條 stretch 嘅長度（目標：由 20 分鐘級降到一兩個 cadence 就結束）；`outage_alert_at` 唔應該再過 10 分鐘線。
3. `owedTokens` 仍然要喺 100–400 之間震盪（A 令 drain 睇到嘅 room 少幾格，可能輕微推高；若長期單調上升就睇 `calls` 同 `shed`）。

### 界線（老實講）

- **呢兩個改動都改唔到「tick 死喺掃描途中」**（今日 12 條都係 `prog scan +0ms`，即係 scan 一開始就死）。
  佢改嘅係「捱到 flush 嗰個 tick 幾大機會寫得入」——而一條 stretch 只要有一個 tick 寫得入就結束。
- 死因嘅**硬證據仍然要喺 worker 外面攞**（Cloudflare dashboard → Workers → Metrics → Invocation Statuses，
  00:33–00:53Z；或者 Workers Paid 先有 logs）。`docs/scan-completion-loss.md` §2026-09-23 嘅結論（invocation
  級 subrequest 上限 50，Turso round trip 每個都計，libsql 重試會放大）依然係唯一解釋得晒所有形狀嘅機制，
  而免費方案下唯一嘅槓桿就係減 round trip —— A 係唔再搶 flush 嗰份，B 係死亡 tick 少花 9 個。
- 最直接嘅方案冇變：Workers Paid（US$5/月，50 → 10,000）。
