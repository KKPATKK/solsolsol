> ⚠️ **2026-09-28：呢一節嘅結論已經被推翻（OVERTURNED），保留作歷史。** 真死因係 **Workers Free
> 每個 invocation 10ms CPU**，唔係 subrequest 上限 50。決定性證據喺 worker 外面（Cloudflare 分析 API）：
> 19 個 `exceededResources` 全部只行到 **6–21 個 subrequest**（上限 50），而佢哋嘅 cpuTime **整整
> 10,000 us**（喺上限度被叫停），同一分鐘生還嗰啲讀 7,827–145,655 us；12 小時 window 平均只有
> **7.4** 個 subrequest／invocation。詳見下面 §2026-09-28 同 `docs/round-trips.md` §4.46。
>
> 呢節以下嘅 subrequest 解剖**唔可以整個掉**：佢正確描述咗**觀測點解係盲嘅**（爆預算嗰刻最後死嘅就係
> telemetry 寫入），同埋每個 Turso round trip 都係一個 subrequest 呢個事實。錯嘅只有「50 就係成因」
> 嗰半 —— 而「減 round trip」因此由「唯一槓桿」降級為「好習慣」。
