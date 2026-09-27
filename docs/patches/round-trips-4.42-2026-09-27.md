## 4.42 Cron tick 卡死嘅真身：cached init promise 冇 exit（2026-09-27）

### 量度（live，2026-09-27 22:12–22:30Z，60s 模式）

| 訊號 | 讀數 |
|---|---|
| cron 到達（`scheduled_tick_ring` / `scheduled_tick_total`） | **1/min**，45 分鐘 45 個、間距 +59.9–64.2s、**零漏洞** |
| 完成掃描（`scan_history`） | 13Z–21Z **每小時 24–26 次**（10Z–12Z 係 43/52/59）→ 近 3 小時 gap p50 **132s** |
| 觸發歸因（`scan_trigger_*`） | 22:19:32 cron **283** / http 275 → 22:27:13 cron **283** / http **278**（7.7 分鐘內 **Δcron = 0**、Δhttp = +3） |
| 直接窗口 | 兩次 120s：各 **2 個 cron 到達、0 個 cron 完成**，同期 http 完成 1 |
| heartbeat `via` | 22:23:24 / 22:26:14 / 22:28:21 **全部 http** |

即係：**cron tick 每分鐘都有到達，但由 ~12:45Z 起冇再完成過任何一次掃描**，成個 fleet 嘅
掃描全靠 uptime monitor 嘅 HTTP rescue（佢嘅 rescue 門檻係 `scanRescueGapMs` = 120s，所以
節奏自然跌到 ~132s）。累計數字亦吻合：http 278 ≈ 兩段異常窗口 + 12:45Z 之後嘅全部完成。

### 點解睇唔到原因（三個探針都盲）

到達記錄係喺 handler 一開頭（pre-init stamp）或 claim batch 落嘅，所以 **ring 完整**；
但之後嘅路徑全部落唔到任何 durable 痕跡：

- `skip_capture` 自 **20:39:20Z** 起冇再動過（total 7）——原因係**記憶體**計數，要等
  「下一次完成掃描嘅 tail write」才落地，而一個冇 scanner 嘅 isolate 永遠唔會有完成；
- 死 tick backfill 需要**下一次贏到 claim**（`BACKFILL_STALE_MS` 45s），所以死喺 claim 之前
  嘅 tick 一個 row 都唔會留（err rows：10Z 2、12Z 8、13Z 1、14Z 1，之後 0）；
- `scan_wedge` 凍結在 09:24:52→09:28:29。

### 真身：`ensureInitialized` 唯一嘅 cache 出口喺 `await` 之後

```ts
initPromise = (async () => { ... })();   // db.init() 同所有 client/bot 建構
await initPromise;                        // ← reject 就由呢句 throw 出去
if (tursoConfigured && !dbReady) initPromise = null;
```

上面嗰個 reset 只覆蓋「**settled 但 dbReady false**」一種失敗（`db.init()` 喺自己嘅
try 入面 throw）。另外兩種形狀**冇 exit**：

| 形狀 | 為何 reset 到唔到 | 結果 |
|---|---|---|
| boot **REJECT**（未包 try 嘅建構：grammy token、Scanner/client 建構、`installTickProbe`…） | `await` 直接 throw，reset 嗰句根本冇執行 | rejected promise 永遠留在 `initPromise` |
| boot **永遠唔 settle**（libsql client 內部 retry loop） | 永遠到唔到 `await` 之後 | 同上 |

兩種都令該 isolate **永遠 `scanner === null`**：之後每一個 tick 都行 handler 嘅
`!scanner` 分支——記錄到達、`noteSkipReason("init-no-scanner")`（只入記憶體）、
`return`。而 `if (initPromise) return initPromise;` 令每一個後續 tick 都**直接食返嗰個
死 promise**，所以只有 Cloudflare 回收 isolate（或者 deploy）才會復原——正好解釋
「每次都係 deploy 之後好返」同今次 12:45Z 之後冇 deploy 就一直卡住。

### 修法：cache 由外面自己清

| 新增 | 作用 |
|---|---|
| `cachedInitVerdict(pendingSince, now)` | 純函數：pending 超過 `INIT_UNSETTLED_MAX_MS`（**60s**，約 17× 健康 boot 嘅 ~1–2s）就 `drop`，令**同一個 tick** 可以重新 boot（覆蓋「永遠唔 settle」） |
| `trackInitBoot(boot, state, { isCurrent, onReject })` | boot 一 reject 就即刻清 cache（覆蓋 throw）＋ 報原因；`isCurrent()` 係 identity test，避免一個**已被取代**嘅舊 boot 嘅 settle 清走現行 boot 嘅年齡；順手令「creator 3.5s 前台 timeout 之後才 reject」唔再變成 **unhandled rejection** |

boot 成功 settle（無論 resolve / reject）就將年齡歸零，所以健康路徑完全冇多餘判斷。

### 測試同 mutation

- `test-unit`：新測試「init boot cache: a REJECTED or HUNG boot stops being cached」
  ——verdict 兩邊邊界（bound 上仍然 reuse、過 1ms 就 drop）、reject 會清 pending age 同報原因、
  resolve 唔會、**late settle 唔會清走現行 boot 嘅年齡**，再加兩條 whitespace-squashed
  wiring pin（guard 真係清 cache、boot 真係帶 identity test 去 track）。
- Mutation（`docs/patches/init-boot-heal-mutation-2026-09-27.check.js`，逐個跑、每次比對
  還原）：① verdict `>`→`>=` ② reject 分支唔清 age ③ 吞咗 onReject ④ identity test 改
  `() => true` ⑤ call site 完全唔 wire `trackInitBoot` —— **5/5 都被捉到**。

### 驗收（deploy 之後）

1. `scan_trigger_cron` 重新以 **~1/min** 上升（唔再係 Δcron 0），而 `scan_heartbeat.via`
   會重新見到 `cron`；`scan_history` 每小時返到 ~60 次。
2. 到達 ring 應該一如以往完整（唔變）。
3. Cloudflare log：萬一真係 throw，會見到
   `[worker] init THREW — dropping the cached init so the next tick retries: …`；
   若果係 hung，就會見到 `init promise still unsettled after Ns — dropping the cached init…`。
   **兩句都代表 isolate 自己復原緊**（log 出現之後下一個 tick 應該掃得成）。
