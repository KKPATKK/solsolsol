# Boosts lane 節奏閘（2026-10-07）：一支請求／5 分鐘，durable stamp 騎 scan front

> 相關：`docs/boosts-ceiling-window-2026-10-03.md`（boosts 窗口修復，令條 leg 喺
> 天花板之下唔再被 slot drop）、`docs/profiles-feed-zeros.md`（DexScreener 429 係
> 共享 egress IP 問題）、`docs/gecko-key-launch-chain-2026-09-28.md`（同形 cadence
> gate 嘅來源，今次係照抄嗰個形狀）。

## 一、要減嘅唔係覆蓋，係請求率

boosts 係 tick 嘅**第二支** `api.dexscreener.com` 請求，而呢個 host 按 **SOURCE IP**
限流 —— 個 IP 係成個 Worker fleet 共用，所以無論 client 自己點樣斯文，`http429`／
`listCacheRefused`／`pairCacheRefused` 都會升（同 `docs/gecko-429.md` 同一類）。

2026-10-07 deploy 前量到（同 `wrangler.toml` 嗰段註釋同源）：

| 讀數 | 值 |
|---|---|
| `dex.http429` | **110**（per-isolate 累計） |
| `dex.blockedForMs` | **89283**（client 泊喺自己嘅 90s cache-only backoff） |
| `listCacheRefused` / `pairCacheRefused` | **50 / 60** |
| 條 leg 自己 | 被拒嘅 tick 讀 `boosts 0` |
| `/debug/dex429`（deploy 一刻抽樣） | `total 12211`、`lastAt 21:36:43Z`、ring 21:25–21:36 之間每個 1–3 分鐘一簇 |

兩個令「降頻」係正確槓桿嘅事實：

1. **row size 買唔到嘢**：Solana subset 無論 `DEXSCREENER_BOOSTS_LIMIT` 開幾多都
   係 20 樓下（見該 var 嘅註釋）。
2. **lane 嘅 lifetime yield 本身就細**：`/debug/feed-stats` boosts 累計
   `coins 37 / pushed 4` —— 幾十枚幣、幾張卡。所以唯一誠實嘅 dial 係**節奏**。

決定：**保留 lane、降頻**（唔用「關 boosts」嗰條路）。同 gecko keyed leg 嘅 5 分鐘
cadence 完全同構 —— 嗰條係 quota-bound（key 配額），呢條係 rate-bound（共享 IP）。

## 二、改動

| 檔案 | 改動 |
|---|---|
| `src/db.ts` | 新 `DEX_BOOSTS_AT_KEY = "dex_boosts_at"`，加入 `SCAN_FRONT_GATE_KEYS` —— 騎 scan front 嘅**同一條 IN-list 讀**同**同一筆 front write**，零額外 round trip |
| `src/config.ts` | 新 `AppConfig.dexscreenerBoostsIntervalMs`（`DEXSCREENER_BOOSTS_INTERVAL_SECONDS`；default 300s、`"0"` = 無閘、**junk fail-closed** 返 300s） |
| `src/scanner.ts` | 純函數 `boostsDiscoveryDue()`（fail-open：冇 row／junk／未來 stamp 都係 due）；`ScanSummary.boostsDue` 讀數；boosts leg 加閘；stamp 喺 **closure 內 dispatch 時** `stampFront`（窗口冇剩就唔 stamp，唔會白燒 5 分鐘） |
| `wrangler.toml` | `DEXSCREENER_BOOSTS_INTERVAL_SECONDS = "300"` ＋ 驗收指引註釋（點讀、點 rollback） |
| `scripts/test-unit.js` | 新 cases：`boostsDiscoveryDue` fail-open／邊界／兩閘一致（5 個讀數）；`loadConfig` default／`"0"`／junk；4 條 source anchor（call site、stamp、`SCAN_FRONT_GATE_KEYS`、wrangler 值） |

**點解覆蓋無損**：boosted mint 冇 metrics、冇 timestamp，佢嘅 age 嚟自 pair，而
scanner 只會喺幣 age 入咗 30h qualifying window 之後才判斷 —— 遲一個 interval
註冊嘅 mint 會喺**完全相同嘅 tick** 被判斷。呢個就係 gecko keyed leg 可以用
5 分鐘 cadence 嘅同一條算術。被閘住嘅 tick 由 always-on lanes 補位（profiles
每 tick、Jupiter recent/trending 每 tick、jupTrend 同呢條 lane 分擔同一份工）。

**Durable 而唔係 per-isolate**：isolate 每 ~30s 換一次，per-isolate stamp 永遠唔夠
時間過期，降頻就會「不存在」。row 放喺 front 嘅單次讀寫上面，成本係 0。

## 三、測試

- 本機 `npm run test:unit` **exit 0**：main suite **497 passed / 0 failed**；其餘
  suite 全綠（`test-dex-list-cache` 11 passed、`test-deferred-priority`、
  `test-tick-path`、`test-schema-gate`、`test-health-front`、`test-usd-formatter`、
  `test-dex-last-profiles`、`test-tick-legs` 全部 exit 0）。
- 新增嘅 source anchor 釘住嘅係**接線**（唔係 client）：call site 必須問
  `boostsDiscoveryDue(...)`、stamp 必須喺 dispatch closure 內、row 必須喺
  `SCAN_FRONT_GATE_KEYS`、wrangler 值必須係 `"300"` —— 將呢條閘還原做
  「每 tick 一 fetch」會即刻 fail，唔會靜靜地過。
- deploy workflow 喺**同一個 SHA** 再跑一次 `npm run typecheck` ＋ `npm run test:unit`,
  全綠（見下）。

## 四、部署記錄

| 項目 | 值 |
|---|---|
| Commit | `bdb9895` Tag the legacy pump.fun probe expected-dead…（同批 push 嘅 `/debug/pool-source` 標記） |
| Commit | `64a4401` Gate the DexScreener boosts lane to one fetch per 5 minutes |
| Push | `543190c..64a4401 → origin/main`（fast-forward） |
| Deploy run | [37690651363](https://github.com/KKPATKK/solsolsol/actions/runs/37690651363) — **success**，1m38s，headSha `64a4401`（typecheck／test:unit／`wrangler deploy`／3 個 secret 寫入全綠） |

## 五、上線後 live 讀數（2026-10-07，21:37–21:47Z）

### 5.1 新 version 已上線嘅證

`/debug/pool-source`（deploy 後第一抽）：

```
pumpfun-v3           status 200, count 20, newestAgeS 3
pumpfun-legacy       status 530, body "error code: 1016",
                     expected: true, expectedNote: "legacy host — 530 / CF error 1016 …"
dexscreener-boosts   status 200, count 26
```

（`expected: true` 係同批上線嘅 probe 標記；`dexscreener-boosts` 讀數照舊如實報告。）

### 5.2 閘嘅讀數（`/debug/tick`）

| 時刻 (Z) | `boosts` | `boostsDue` | `dropsByLeg.boosts` | `dex.http429` | `blockedForMs` |
|---|---|---|---|---|---|
| 21:39:52 | 0 | **false** | 0 | 3（`last429At 21:39:54Z`） | 89296 |
| 21:44:45 | 0 | **false** | 0 | 6（`last429At 21:44:45Z`） | 89307 |
| 21:47:24 | 0 | **false** | 0 | 4（`last429At 21:46:30Z`） | — |

全部樣本 `budgetDrops 0`、`lastDropLeg null`、`dropsByLeg` 四條 leg 全 0 —— 即係
「**gated tick 唔係 dropped tick**」：廢票係零請求，而唔係送唔出。

其他同場讀數：`profiles 26`（always-on lane 照跑）、`geo 0／geoDue false`（gecko
閘亦揸住）、`pump 20`（pump.fun 照跑）。

### 5.3 窗口**真係會過期重開**（由 stamp 時序推斷，唔係捉到 `true` 一刻）

row 只可能由呢個新 code 建立，所以：

1. 首讀（21:39:52）`boostsDue false` ⇒ **當時已經有 stamp**，即首個 stamp ≤ 21:39:52
   （冇 row ⇒ fail-open 會讀 `true`）。
2. 最尾讀（有 isolate 於 ≥ 21:46:30 見過 429、而 summary 仍 `false`）⇒ 當時嘅
   stamp ≥ 21:43:30。
3. 兩點合埋 ⇒ 21:43:30 之後嗰個 stamp **唔可能係首個**（首個 ≤ 21:39:52）⇒
   中間必然有一次 re-dispatch ⇒ **gate 真係見過 due（300s 窗口過期）、重開、再消費**。

手動 poll 好難捉到 `boostsDue true` 一刻，係因為 standing cadence（clock ~30s ＋
cron 60s）會喺窗口一開嘅 ~30–60s 內就攞走佢 —— 呢點本身就係「閘交替行緊」嘅證據，
反而「長時間唔重開」先係 bug 嘅形狀。

### 5.4 `/debug/feed-stats`（21:40:10Z）

`boosts coins 37 / pushed 4` —— 同「lifetime 幾十粒幣」嘅前提一致。（同
`boosts-ceiling-window` doc §5.5 一樣：呢個係 lifetime 累計，短期升幅唔可以當
逐 tick 讀數。）

## 六、Operator 點讀呢個閘

- `summary.boosts 0` **＋** `boostsDue false` ＝ 閘揸住：**零請求**（`dropsByLeg.boosts` 唔會升）。
- `summary.boosts 0` **＋** `boostsDue true` ＝ 允許咗嘅 fetch 空手／被拒返（例如 client
  正喺 90s cache-only backoff）—— 呢個係 upstream 讀數，唔係閘壞。
- `summary.boosts > 0` ＝ 交付咗（例如 `/debug/pool-source` 探針嗰種 26 行）。
- **429 減幅嘅量法**：過幾個鐘對比 `/debug/dex429` 嘅 `lastHour`／`total`（同
  deploy 前 `total 12211`、`lastHour 50` 比），配 `summary.boostsDue` 一齊讀。
- **Rollback**：`DEXSCREENER_BOOSTS_INTERVAL_SECONDS = "0"` ＝ 還原 pre-gate
  一 tick 一 fetch 嘅形狀（code 唔使改）。
- **手動 `/debug/tick` 嘅陷阱**：有 25s cooldown，而且可能撞正 in-flight scan 而
  **被跳過**（`ms` 得幾十毫秒 ⇒ 回應嗰個 `summary` 可能係上一個 tick 嘅）；
  要讀閘就揀 `ms` 係秒級嘅回應。

## 七、界線（老實講）

- **429 減幅未量到**：deploy 後只係十幾分鐘嘅樣本，shared IP bucket 要長窗口先
  睇得出（方法見上）。呢份 doc 唔聲稱「429 跌咗幾多」。
- **未捉到字面嘅 `boostsDue true` 一刻**：理由見 §5.3；重開係由 stamp 時序證明，
  唔係靠一次撞彩讀數。
- **上游照樣可以拒**：呢個閘只減**本 Worker 嘅貢獻**（由 ~2 支/tick 降到 ~1.03 支/tick），
  陌生人貢獻佔多數，所以 `http429` 唔會變 0。
- **未郁**：lever B（關 boosts）、lever C（profiles 節奏）、lever D（DexScreener key，
  未有證據話有 key 制）—— 呢啲等有需要先算。
