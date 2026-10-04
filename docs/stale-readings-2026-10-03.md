# Stale readings：卡片用嘅「現價」其實係幾分鐘前嘅 cache（2026-10-03）

> 觸發：HK 19:53／19:54 兩張 💀 `DUST` 卡，兩張嘅「現市值」都係 $121.02K，
> 但當時池價 ~$290K–430K。呢份寫現場證據、根因、修法同驗收。

## 1. 現場（量度）

`/debug/push-audit` ring 抽 DUST（token `HAcEq…xdust`，pinned pool `9KBF3K…yhFT`）：

| 時間 (Z) | 轉換 | 讀數 |
|---|---|---|
| 11:53:34 | 💀 dead（第 1 張卡） | mcap 121,023，卡文「峰值 $330.34K → 現 $121.02K (-63%)」 |
| 11:53:45 (+11s) | 🟢 revive | mcap 381,369（→ peak 被重設為 381,369） |
| 11:54:44 (+59s) | 💀 dead（第 2 張卡） | mcap 121,023，卡文「峰值 $381.37K → 現 $121.02K (-68%)」 |

- 兩張**唔係重複卡**：ring 係真嘅 dead→revive→dead 三段轉換。
- 讀數自洽：`121023 × 1.5 = 181534.5`（卡上「收復 $181.53K」），百分比都對 ——
  所以問題唔喺算式，喺**$121,023 呢個數本身係舊嘅**。
- 對外核數（DexScreener 現有 6 個池；GeckoTerminal OHLCV）：11:53–11:54Z 池價
  ~$290K–430K；**$121,023 ≈ 11:46–11:49Z 嘅真價** → 卡發出時讀數已老 **~4 分鐘**。
  11:53:45 嗰個 $381K 反而係新鮮（≈11:52 價）。

## 2. 根因

### 2.1 三層 cache 疊加（量度）

| 層 | TTL | 蓋章內容 |
|---|---|---|
| DexScreener 自家 CDN | `cache-control: public, max-age=30`（HIT 帶 `age` 0–26s） | 唔關我哋事，但佢嘅 age 會被上層保存 |
| 我哋嘅 colo edge cache | `PAIR_BATCH_CACHE_TTL_S = 120s` | `cf-cache-status: HIT`，但**冇記錄條目幾舊** |
| 本機 in-memory pair cache | `PAIR_CACHE_TTL_MS = 180s` | `{pair, at}`，`at = 收到嗰刻` |

三層係**疊加**：一個 120s 前寫入 edge 嘅 copy 仲可被本機 cache 再存 180s →
內容最老可達 ~30 + 120 + 180 ≈ **5.5 分鐘**，而每一層嘅 stamp 都只係
**自己 receipt 嘅時間**。所以條鏈由頭到尾都讀「fresh」。

### 2.2 點解一張卡會老 4 分鐘

由 11:53:34 反推：內容 ≈ 11:49:0x（`age` 當時 ≈30s）→ 我哋 11:49:3x 由 edge
MISS 收到（順手寫入 edge，TTL 120s）→ 11:51:3x 由 edge HIT 拎到（age ≈120s），
同時寫入本機 cache（`at = now`）→ **11:54:30 前本機都會照派**。11:53:34 同
11:54:44 兩張卡就係兩次派到同一個 ~4 分鐘前嘅 copy；中間 11:53:45 嗰 pass 咁啱
拎到另一個（新啲嘅）copy，於是 revive。

### 2.3 後果：錯嘅唔止一張卡

- 💀 卡引用錯 現價。
- 復活目標 `live.mcap × 1.5 = $181.53K` **低過當時真實市價**（$290K+）→ 下一個
  新鮮讀數一定「復活」，形成 dead↔revive 來回。
- 規則引擎本身冇錯：錯嘅輸入，正確咁計出錯嘅卡。

## 3. 修法

### 3.1 內容時鐘（`PairInfo.contentAt`）

- `getJson` 由回應自己嘅 header 讀內容時間：
  `age` 有 → `now - age`（邊層 cache 派都keep）；冇 age 就 fallback `date`；
  兩個都冇 → **undefined（unknown）**。
- `parseDexPair(raw, contentAt)` 把佢寫入 `PairInfo.contentAt`。
- 呢個欄位**跟住 pair 物件**穿過所有 cache（in-memory map、pin snapshot、
  colo 載體、`lastPairs`），所以任何一層派返嚟都仲知條數幾舊。
- 出口：`pairContentAgeMs(pair, now)`（null = unknown）。

### 3.2 太舊就唔准用（`PAIR_CONTENT_MAX_AGE_MS = 180_000`）

一個數，三個用法（第三個係 2026-10-04 延伸，見 §7）：

1. **唔准再派**（`dexscreener.ts`）：in-memory cache hit 但內容 >180s =
   MISS，照去問 wire。呢個係安全嘅，因為 edge 條目喺內容去到 180s 前必定
   已過期（edge 最長 120s ＋ 寫入時已帶 ≤30s 上游 age）→ re-ask 係真 refresh。
2. **唔准判**（`pushwatch.ts`）：pass 收到嘅讀數 >180s → **成行拒判**：
   - 唔 claim、唔寫任何 column（連 measurement 都唔寫，因為同一條舊數）、
     唔出卡；
   - 行保留喺 rotation 隊頭，下個 pass 用最新 copy 重判；
   - note 加 `stale N` 令佢可觀察。

   `PUSH_WATCH_MAX_READING_AGE_MS` 直接 = `PAIR_CONTENT_MAX_AGE_MS`（一個數，
   兩個 module 唔會講兩套）。
3. **唔准判（scan 前端）**（`scanner.ts`）：`matchCoins` 收到嘅 pair 內容
   >180s → 成個 coin 唔判：唔跑任何 gate、唔 log reject（reject ring 係記錄
   「判過嘅嘢」，呢隻 coin 未判過）、fails 唔動，coin 留喺 pool 下個 rotation
   用新讀數重判。`SCAN_MAX_READING_AGE_MS = PAIR_CONTENT_MAX_AGE_MS`。

- **unknown 唔算 stale**（fail-open）：fixtures／synthetic／Jupiter・Gecko legs
  冇 `contentAt` → 照舊判。呢個係「missing data never judges」嘅方向：只有
  真係度到 age 嘅讀數先會被拒。
- **唔止 💀**：初版只 gate dead/revive，測試即刻證明唔夠 —— 同一條舊數會先出
  一張 ⚠️ w45（「峰值 $330.34K → 現 $121.02K (-63%)」），現價一樣錯。
  所以 gate 係整行：任何卡都唔准由 stale 讀數出。

### 3.3 為何係 180s（算術，唔係口味）

- 條鏈喺**健康路徑**最舊可以派到嘅內容：edge write age ≤120s ＋ 寫入時上游
  age（實測 0–26s）≈ **146s**。
- 180s 喺 146s 之上 → 健康 hit 永遠唔會被拒；又遠低於 DUST 嗰 ~4 分鐘。
- 條 bound 亦係 UPPER bound：>180s 嘅內容代表背後嘅 edge 條目一定已過期，
  所以「re-ask」係真係拎到新數，唔會白問。

## 4. 測試（`scripts/test-unit.js`）

- `DexScreenerClient: a pair batch is dated by its CONTENT, and an over-age cache
  hit is re-asked`：age→contentAt、cache hit 唔會 re-stamp、>bound 嘅 hit 變
  MISS（wire 被再問）、無 header = unknown（照 serve）、by-address lane 一樣帶鐘。
- `evaluateWatch: a stale reading cannot call a coin dead or revive it (DUST,
  2026-10-03)`：4 分鐘舊讀數 → 零卡、`readingStale: true`、唔改 state／anchor；
  同一組數 fresh → 💀 照出（negative control）；bound 邊界（=bound 判、
  bound+1ms 拒）；unknown 照判；dead 行 stale → 唔復活；⚠️／🚀 一樣被拒。
- `PushWatcher: an over-age reading skips its row untouched and is named
  (`stale N`)`：pass 層 —— 唔 send、`checked 0`、DB 一個 write 都冇、note 有
  `stale 1`；同一行 fresh → 卡照出、note 冇 `stale`。
- 487 → **490 passed / 0 failed**（另 7 個 suite 全綠）。

## 5. 未做／已知限制

- `contentAt` 只覆蓋 DexScreener legs（Jupiter／Gecko 係 live fetch，冇 cache
  分層，維持 unknown）。
- 前端 scan gates（2026-10-04 延伸，見 §7）：`matchCoins` 嘅所有 gate 而家
  一樣拒判 >180s 內容嘅讀數。DexScreener 條 pair lane 本身會 re-ask 過期
  hit，所以健康 tick 呢個 counter 預期係 0。
- 若上游持續唔更新 cache，>`bound` 嘅 copy 會被拒直到真係拎到新數 —— 方向係
  fail-quiet（延遲，唔係遺失）：所有 stage marks 係 persistent，跨過嘅檻會喺
  下一個新鮮讀數一次過補發。

## 6. Post-deploy 驗收（2026-10-04 00:44Z）

- 部署：`c1a774a`（CI run 37165782859：Typecheck／Unit tests／Deploy 全 success），
  Worker version `d812f0a3-…`，uploaded 00:44:09Z。
- Live pass note（00:49:11Z）：
  `ok:27/1 rows 27/27 pairs 27/27 pins 27/27 pin-snap 26 (oldest 64s) miss 0 lost 0 muted 1` ——
  **冇 `stale`**，即部署以嚟未出現 >180s 讀數；個字只會喺真拒判嗰下出現。
- DUST 對外抽查（00:51:2xZ）：row `lastMcap 107,126`（fetch 前 3 秒讀到），
  DexScreener 即時 `marketCap 108,473` → 差 1.2%；上游回應
  `cache-control: public, max-age=30`、`cf-cache-status: EXPIRED`、冇 `age` 有 `date`
  （content clock 會 fallback 去 `date`）。
- 未觀察到：live 上真嘅 `stale N` 拒判（要等一個 >180s 內容嘅讀數）。守衛由
  3 個 unit test ＋ negative control（拔守衛即出卡）覆蓋。

## 7. 延伸：scan 前端 gates（2026-10-04）

- **做咗咩**：`src/scanner.ts` 加 `SCAN_MAX_READING_AGE_MS =
  PAIR_CONTENT_MAX_AGE_MS`；`matchCoins` 攞到 pair 之後即刻度
  `pairContentAgeMs(pair, now)`，>bound 就 `continue`：唔跑 gate、唔 log
  reject、唔動 fails，coin 留喺 re-evaluation pool 下個 rotation 重判。
  Counter `staleReadings` 上 `ScanSummary`（`/health` 嘅 summary 直接讀到）。
- **點解要 gate 喺決策點**：fetch lane 嘅 re-ask 係「一個 carrier 嘅屬性」；
  `matchCoins` 係判決本身，一個 reject 嘅代價同遲一張卡唔同——reject 綁到
  下個 rotation，而且係 scan 唯一冇得即刻 undo 嘅嘢。
- **Unknown 照判**（無 `contentAt`：Jupiter／Gecko legs、fixtures）——同
  pushwatch 一樣 fail-open。
- **測試**：`Scanner.matchCoins: a stale reading is never judged, and the skip
  is named` —— fresh 同 stale 用同一 fixture 淨係換鐘：stale → 0 candidates、
  `staleReadings 1`、`agedEval 0`、冇 reject、fails 全 0；邊界 ±1s；undated
  照判；stale 兼本身會 fail mcap 嘅形狀一樣唔 log。**Negative control**：喺
  dist 撬開守衛 → 同一條 4 分鐘讀數即刻 qualify（candidates 1）＋ stale 兼
  fail 嘅形狀即刻出 reject（1）——證實守衛正係 suppressor。
  `491 passed / 0 failed`。
- **未做**：pool discovery 嘅 prune 用 `token_stats.last_liquidity_usd`（recorded
  series，唔係 live pair 讀數），維持唔收。
