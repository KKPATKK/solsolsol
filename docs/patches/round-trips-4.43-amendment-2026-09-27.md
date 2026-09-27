### 覆檢陷阱：deploy 之後嘅頭 2–3 個 tick 唔可以入基準（實測）

2026-09-27 23:53:34Z deploy 之後即刻量：頭兩個 tick 讀到 **`counted` 33 / 34（left 4 / 5）**，
而同一批 cron isolate 暖返之後就係 **21 / 24（left 17 / 14）**（23:55:11、23:56:18）。

即係一個 cold isolate 要為 init / boot reads 多付 **+6–8 個 subrequest** —— 同 23:21–23:22 嗰對
`profiles 3`（23:20:45Z deploy 之後）係同一個形狀。兩次都**唔係** feed 或 cadence 出事。

⇒ 覆檢時**跳過 deploy 之後嘅頭 2–3 個 tick**，否則會誤以為 `counted` p50 已經爬到 ≥28，
而按上面張表錯落 `DEXSCREENER_BOOSTS_LIMIT="0"`。
