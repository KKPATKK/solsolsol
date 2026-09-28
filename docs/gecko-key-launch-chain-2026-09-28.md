# Gecko 鑰匙 + launch slot 改組 + pool 流動性 prune（2026-09-28）

> 相關：`docs/gecko-429.md`（keyless 共用 egress IP 被 quota 打死嘅由來）、
> `docs/round-trips.md`（scan front 嘅單次讀／單次寫）、
> `docs/patches/gecko-key-launch-chain-2026-09-28.apply.js`（本次落地嘅逐條 edit）。

## 一、三個改動

| # | 改動 | 位置 |
|---|---|---|
| 1 | pool 查詢嘅流動性 prune 由 **0.6× → 0.8×**（`POOL_LIQUIDITY_PRUNE_RATIO`） | `src/scanner.ts`、`scripts/cpu-profile.js` |
| 2 | gecko `new_pools` 有 **CoinGecko 鑰匙**，改成**每 5 分鐘拎一次貨**（DURABLE 閘） | `src/config.ts`、`src/scanner.ts`、`src/db.ts`、`wrangler.toml` |
| 3 | pump.fun v3 改成**每 tick 都拎貨**（always-on） | `wrangler.toml` |
| 4 | gecko 拎唔到貨 → 由 **Meteora launch 頂上** | `src/scanner.ts` |

## 二、點解要咁改（量度／算術）

**第 1 項**：prune 係**單向而且永久**嘅（跌出 pool 就永遠唔會被推），所以佢一定
低於 gate 本身。0.8 仍然安全：**峰值流動性連 0.8× gate 都冇到嘅幣，本來就過唔到
果個 gate**，冇任何本來推得出嘅幣會消失；同時 2026-09-10 量到「~330 個被判定嘅幣
有 ~215 個死喺流動性 gate」嘅垃圾，會再早一步離開 band 掃描。呢個數字係
`POOL_LIQUIDITY_PRUNE_RATIO` 常數，測試直接釘住，唔會再出現「註解寫 0.6、
數值係別的」嘅情況。

**第 2 項（鑰匙）**：keyless 嘅 429 係 **Cloudflare 整個 egress 池共用嘅 IP quota**
（`docs/gecko-429.md`），所以鑰匙係唯一出路。但鑰匙係 **quota-bound，唔係
rate-bound**：demo plan = 10K calls/月，而 `new_pools` **每個 tick 一次 = ~43K/月**
——鑰匙一星期就燒光，跟住又回到 429。**每 5 分鐘一次 = 8,640/月**，剛好入表。

「遲 5 分鐘」對 discovery 完全冇成本：一個 launch pool 要**老化入 30 小時嘅合資格
窗**才會被判定，遲 5 分鐘登記嘅幣，判斷佢嘅係同一個 tick。

閘係 **DURABLE**（`worker_state.gecko_discovery_at`），唔係 per-isolate 記憶：
呢個 Worker 嘅 isolate 每 ~30 秒就換一次，per-isolate 時間戳永遠等唔到 5 分鐘
就 reset，上面嘅配額算術就唔成立。呢一行搭 **scan front 嘅單次讀 + 單次寫**
（`SCAN_FRONT_GATE_KEYS`），所以閘本身**零額外 round trip**。

**第 4 項（Meteora 頂上）**：既然 gecko 五個 tick 只做一次，launch slot 就會有四
個 tick 空 —— Meteora 就係補呢四個 tick（同時補「到期但回空／被拒」嘅 tick）。
pump.fun 唔再參與呢個決定：佢已經係 always-on feed，兩者係**並行**而唔係先後。

## 三、成本與量

| 指標 | 改前 | 改後 |
|---|---|---|
| gecko `new_pools` 請求 | 每 tick（多半 429） | **每 5 分鐘 1 次**（鑰匙 quota 8,640/月） |
| pump.fun 請求 | 0（只在 gecko 空時） | **每 tick 1 次**（同一 host，20 幣） |
| Meteora 請求 | 只在 gecko + pump 都空 | **每 tick（gecko 未交貨時）** |
| 新增 host / rate-limit bucket | — | **無** |

三個都喺同一個 feed fan-out（`fetchFeedCapped`）裏面，窗口冇剩就唔會派出去，
所以上游卡死都拖唔到個 phase 過 deadline。

## 四、驗收點（睇 `/health`）

| 看 | 預期 | 意思 |
|---|---|---|
| `heartbeat.summary.geoDue` | 約每 5 個 tick 一次 `true` | 閘生效；`false` = 呢個 tick 完全冇花 gecko |
| `heartbeat.summary.geo` | 到期嘅 tick 20；其餘 0 | 到期回空 = 鑰匙／上游問題，唔係閘 |
| `heartbeat.summary.meteora` | 見到 gecko 未交貨嘅 tick 就 > 0 | Meteora 正在頂上（設計如此） |
| `heartbeat.summary.pump` | 每個 tick 都應 > 0 | always-on feed 冇被擋 |
| `heartbeat.gecko.keyed` | `true` | 鑰匙真係入咗 Worker（secret 有寫入） |
| `heartbeat.gecko.requests` | 每分鐘只升約 1/5 | 同 `geoDue` 對得上就係配額正確 |
| `worker_state.gecko_discovery_at` | 每 5 分鐘前進一次 | 閘嘅實際節奏（跨 isolate） |

`gecko.keyed: false` 而 `geoDue: true` 但 `geo` 長期 0 ⇒ **鑰匙未入到 Worker**
（見下節），唔係碼嘅問題。

## 五、需要人手做嘅一步（未做）

鑰匙係 **secret**，唔可以入 `wrangler.toml`（public repo）。二選一：

1. **GitHub Actions secret**（建議，可重現）：repo → Settings → Secrets and
   variables → Actions → New repository secret，名 `COINGECKO_API_KEY`，
   值 `CG-…`。`deploy.yml` 已經加咗一步喺 deploy 之後
   `wrangler secret put COINGECKO_API_KEY`（best-effort：未設就跳過，唔會 block
   deployment）。
2. **Cloudflare dashboard**：Workers → solana-meme-bot → Settings → Variables and
   Secrets → 加 `COINGECKO_API_KEY`（加密）。

**`COINGECKO_API_PLAN` 唔需要設，而且 deploy workflow 唔會讀佢** —— 只有
`COINGECKO_API_KEY` 有寫入步驟。`CG-` 係 demo key，碼嘅預設就係 `demo`
（Header `x-cg-demo-api-key`），而 `loadConfig` 只喺值**正好係 `pro`** 時才改用
`x-cg-pro-api-key`：其他任何值（包括空、`demo`、亂數）都等於 demo，所以喺 GitHub
建一個叫 `COINGECKO_API_PLAN` 嘅 secret 係**冇效果**嘅，唔會壞事但亦唔會幫到手。
要真正用 Pro header，就要同一個 Pro key 一齊，喺 `wrangler.toml` 嘅 `[vars]` 加
`COINGECKO_API_PLAN = "pro"`。

## 六、誠實記錄：未量度嘅部分

- **鑰匙未設之前，所有 gecko 讀數都唔會變**（`geoDue` 會 true，但 fetch 仍然
  429）。上面第四節嘅表要喺 secret 落地之後才有意義。
- **Meteora 嘅請求量會明顯上升**（由「幾乎唔跑」變成大多數 tick 都跑）。佢係
  keyless、一個請求，但註冊入 `token_stats` 嘅新幣數量會上升 → pool 變大、
  rows-read 亦跟住升。要盯 `tokenStatsCount` 同 `/debug/pool`；如果 pool 成本
  蓋過 Meteora 帶嚟嘅覆蓋，`METEORA_FALLBACK_LIMIT` 係第一個該調低嘅旋鈕
  （或者把 `GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS` 調細，令 gecko 承擔多啲 tick）。
- **`PUMPFUN_FALLBACK_LIMIT` 已變 legacy**（always-on limit > 0 時嗰條分支行唔到），
  維持 0；碼同設定都保留，方便日後想再退回「gecko → pump → Meteora」嘅形狀。
- **`minQualifyLiquidity` 提高**會令 pool 縮細（少啲垃圾），目前未量到實際縮幾多；
  睇 `/debug/pool` 嘅 `neverPushed` / `eligibleInWindow` 同 band 讀數。

## 七、驗證（離線）

- `npm run typecheck` → 0。
- `npm run test:unit` → `test-unit.js` **402 passed / 0 failed**，其餘 7 個 suite 全 0 failed。
- 新增測試：`geckoDiscoveryDue` 嘅 fail-open 規則、`loadConfig` 嘅新 var（junk 值
  要 fail **closed** 去 300s，唔可以變成每 tick）、兩個 tick 嘅**跨 tick 閘**
  （證明 `gecko_discovery_at` 真係寫得入）、`=0` 時閘消失、`POOL_LIQUIDITY_PRUNE_RATIO
  === 0.8`，以及一個跨檔 source pin（wrangler 三個值 + deploy 的 secret 步驟 +
  scanner 用常數而唔係字面值）。
- `scripts/test-deferred-priority.js` 嘅 subrequest-floor 測試加咗
  `GECKOTERMINAL_DISCOVERY_INTERVAL_SECONDS: "0"`：佢連續跑幾個 tick 測**floor**，
  唔應該順便被 cadence 閘影響（一次測一個軸）。
- 修了一個**自己的 bug**：測試 patch 最初用 template literal 內嵌，把 `strip()`
  regex 嘅反斜線食掉（`\/` → `/`、`\s` → `s`、`[^\n]` → 真換行），令
  `scripts/test-unit.js` 變 syntax error。已改用同目錄嘅 `.block.txt`
  （literal 讀入）＋ `…-tests-2026-09-28.repair.js` 修復，兩個腳本都寫低咗。
