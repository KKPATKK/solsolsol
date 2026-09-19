# 推送基準帳（Push Baseline Ledger）

> 2026-09-19。為咗回答「7/39 行推送市值超出 band」而做，順手令調參唔再受
> heal / band 變更污染。

## 問題（舊行為）

`push_watch.mcap_at_push` 有**三個 writer**，只有一個係閘門值：

| # | writer | 寫入的值 | 可否同 band 比 |
|---|---|---|---|
| 1 | `scanner.ts` `onPush(c.pair.marketCap)` | 過閘嘅同一個 frozen pair 值 | ✅ |
| 2 | `pushwatch.ts` self-heal 補掛 | **heal 嗰一刻**嘅市值 | ❌（$45K 推、插水後補掛 → $12K baseline） |
| 3 | `pushwatch.ts` 死而復生重置 | 復活嗰一刻嘅 live mcap | ❌ |

再加兩樣：

- band 係 per-chat DB override（live 係 **$60K–$230K**，code default 係
  $40K–$380K），而 `push_watch` 係 26h 滾動窗 → 同一份數據用唔同尺睇會得出
  3/37 或 15/37 兩種「超 band」答案（`chat_settings` 冇 `updated_at`，
  `push_watch` 冇錄當時 band，所以逐行無法還原）。
- `PairInfo.marketCap` 係三個來源混合：DexScreener 流通市值 / Jupiter
  `mcap || fdv` / GeckoTerminal `fdv_usd`。`market_cap_usd` 對 Solana meme 幣
  通常係 null，所以一條腿會攞 FDV —— Tilcayo `$1,591,544` baseline 對
  token 統計 `$341K`（4.67×，典型流通比例）就係 FDV 被當成市值。

## 解決（新行為）

`src/pushledger.ts`（純函數）＋ `worker_state.push_ledger`（同一路徑已有
`push_audit` / `push_deferral` 先例）。每個推送幣一條**不可變**記錄：

- `mcapAtPush`：閘門當時見到嘅值（來源 `initial-send` = 送卡 audit 記錄，
  權威；`watch-row` = 只喺 `push_watch` 第一次見到，可能已被改寫）
- `bandMin` / `bandMax` / `bandAt`：當時生效嘅 band（送入卡 ≤ 6h 內、或 row
  ≤ 5 分鐘內被觀察到才蓋印；否則**唔蓋**，列為 `unbanded`，唔會亂報超 band）
- `rowMcapAtPush` / `baselineMovedAt`：row 現值同記錄值唔一致 → 即係被
  heal / 復活改寫過（原本值永遠保留）

Tracker 嘅 self-heal 亦改成用帳本嘅**真推送值**做 baseline（冇記錄才退回
當前市值），所以之後補掛唔會再污染倍數。

## 點讀

```bash
curl -s https://solana-meme-bot.cool1999k.workers.dev/health \
  | jq '.heartbeat.pushLedger'
```

| 欄位 | 意思 |
|---|---|
| `entries` | 帳本條數（上限 240 條 / 7 日） |
| `authoritative` | 有 audit 權威值嘅條數（其餘為 `watch-row`，可信度較低） |
| `outOfBandCount` / `outOfBand[]` | **well-defined** 超 band 數：只計有 band 印嘅行，並列最多 12 個 token |
| `rewrittenCount` / `rewritten[]` | baseline 被改寫過嘅行，附 `mcapAtPush`（原值）→ `rowMcapAtPush`（現值） |
| `unbanded` | 冇 band 印（推送早於本功能 / 觀察太遲）→ 調參時應排除 |
| `band` | 最新一次觀察到嘅 band |
| `updatedAt` / `ageMs` | 帳本最後變更時間（同步每 5 分鐘一次，無變化唔會寫 row） |

調參只取 `authoritative` 且非 `unbanded` 嘅條數，就唔會再受 band 變更、
heal、復活污染。

## 仍未落地（編輯工具窗口限制）

本 repo 大檔（`db.ts` 3022 行、`scanner.ts` 3812 行）嘅檔案編輯只能觸及大約
頭 1000 行，以下三個 hunk 喺窗口外，要用 VS Code / 終端手動貼上（全部獨立、
唔互相依賴）：

1. **`push_watch` 欄位**（`db.ts`）：喺 `CREATE TABLE push_watch` 加
   `baseline_source TEXT, band_min REAL, band_max REAL, mcap_is_fdv INTEGER
   NOT NULL DEFAULT 0`；喺無條件 ALTER 區加同名 `addColumnIfMissing`；`upsertPushWatchMany`
   寫入、`listPushWatch` 讀出、`updatePushWatchCheck` 用 `COALESCE` 更新。
2. **`seen_tokens.push_mcap`**（`db.ts` + `scanner.ts`）：`claimTokenPush`
   加 `push?: { mcapAtPush; bandMin; bandMax; isFdv }` 並寫入
   `push_mcap/push_band_min/push_band_max/push_fdv`；`findUntrackedPushes`
   讀返。`scanner.ts` 嘅 `sendTo` 呼叫處傳入
   `{ mcapAtPush: c.pair.marketCap, bandMin: chat.minMarketCapUsd, bandMax: chat.maxMarketCapUsd, isFdv: c.pair.mcapFromFdv === true }`。
3. **Gecko 腿標記 FDV**（`scanner.ts` `pairsForTracker`）：
   ```ts
   if (!snap || (snap.marketCapUsd === null && snap.fdvUsd === null && snap.reserveUsd === null)) continue;
   ...
   marketCap: snap.marketCapUsd ?? snap.fdvUsd ?? 0,
   fdvUsd: snap.fdvUsd,
   mcapFromFdv: snap.marketCapUsd === null && snap.fdvUsd !== null,
   ```
   （`GeckoTokenSnapshot` 已經暴露 `marketCapUsd` / `fdvOnlyUsd` /
   `fdvUsedAsMcap`；價值語意已修正為「優先市場市值」，呢一步只係補標記。）

`PairInfo.fdvUsd` / `mcapFromFdv`（`dexscreener.ts`、`jupfeeds.ts`）已經就位，
等上面第 3 步一貼就即刻有值。
