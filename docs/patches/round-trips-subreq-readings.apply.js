#!/usr/bin/env node
/**
 * Record the live readings of the subrequest counter and its host split
 * (docs/round-trips.md §4.6 / §4.6.2).
 *
 * An apply script rather than a file edit because the file tool's matcher
 * fails on this doc's CJK punctuation (「」, …, ——): the same four lines can be
 * read back byte-identical and still not match. Anchors here are ASCII
 * prefixes, which is all the script needs.
 */
const fs = require("fs");

const T = "docs/round-trips.md";
const lines = (...xs) => xs.join("\n");

const splitBullet = lines(
  "* **第二條軸：host split**（`cc333db`，即日加）。上線後第一個讀數就揭到 phase ring 喺**常見情況係盲",
  "  嘅**：佢只喺有 candidate 入鏈時 stamp（`deferred`／`seen`／…），而大部分 tick `candidates: 0`",
  "  —— 實測一個 `total 56` 嘅 window `phases` 完全空。所以每個 window 同時記「每個 call 去邊個 host」",
  "  （`hosts`：count desc、tie 用 host name 排（求穩定）、最多 7 行 ＋ 一行 folded `(other)`，而",
  "  **rows 一定加返 = `total`**，讀者可以自己核）。呢條軸唔需要 scanner 行到任何 phase，同 phase ring",
  "  一樣跟 window 捲入 `recent` —— 即係被殺嘅 tick 都讀得到「邊個 consumer 燒咗」。落線：",
  "  `docs/patches/subreq-host-split-tests.apply.js` ＋ `…fix1.apply.js`（tie-break 順序修一次：",
  "  `(` 排喺字母前面）；測試 292 → **294 passed, 0 failed**。",
  "",
);

const section = lines(
  "#### 4.6.2 上線後讀數（`43c6f2c` run 35881957854 success 15:30:52Z；`cc333db` run 35886716005",
  "success ~16:09Z；抽樣 15:31–16:14Z）",
  "",
  "**儀器活著**：`/health.heartbeat.subreqs = { budget: 50, current, recent, windows }`；window 每 ~60s",
  "開一個（實測相鄰兩個 window 相差 **59.878s／60.004s** ⇒ 一個 window 真係一次掃描嘗試）。",
  "",
  "**讀數係 tick 自己寫落 Turso 嘅**：claim heartbeat（`phase:\"scanning\"`）同 completion flush",
  "（`phase:\"done\"`，同 history row 同一個 batch）都帶 `subreqView()`，而 `/health` serve 嘅係 persist",
  "咗嘅 copy。實測 15 秒內打 3 次 `/health` ＋ 2 次 `/debug/*`，`windows`／`current.at`／`total` 完全",
  "一樣 ⇒ **poll 唔會污染個數**（早前見到嘅「window 凍結」係因為嗰個 tick 已經完，唔係 counter 死）。",
  "被殺嘅 tick 自己永遠 publish 唔到，只可以喺**下一個** tick 嘅 `recent[0]` 讀。",
  "",
  "| window total | host split（`hosts`） | 讀法 |",
  "| --- | --- | --- |",
  "| 16 | turso 16 | **冇任何 upstream call** ⇒ 未入 feed 就結束嘅 tick（DB-only：init／gate／claim／lock） |",
  "| 30 | **turso 25** ＋ jup 2 ＋ gecko 1 ＋ dexscreener 1 ＋ gmgn 1 | DB 佔 83% |",
  "| 32 | **turso 20** ＋ dexscreener 6 ＋ gecko 2 ＋ jup 2 ＋ pump.fun 1 ＋ gmgn 1 | DB 佔 63%，upstream 12 |",
  "| 18／19 | —（有 `seen@17`） | 正常完成、有 candidate 入鏈 |",
  "| rolled 34／44／**56** | — | **56 係超 50 嗰個**（burst 一次 dispatch 幾個 ⇒ 過衝），而且 `phases` 空 |",
  "",
  "**phase ring 喺常見情況係盲嘅**（上線後首要發現）：ring 只喺有 candidate 入鏈時 stamp，而最近嘅",
  "history row 讀 `candidates: 0` —— `total 56` 嗰個 window 就係一例（見上面 4.6 尾段：所以先加 host",
  "split）。每個 window 樣本嘅 `hosts` 都加得返 = `total`；**DB round trip 佔每個 window 63–83%**，",
  "feeds 佔其餘（樣本 tick 嘅 upstream 12：dexscreener 6、gecko 2、jup 2、pump.fun 1、gmgn 1；而 pass",
  "note 嘅 `trips` 只係 9，即係 DB 裡只有約一半係 pass 自己嘅）。",
  "",
  "⇒ **下一刀唔係砍 feed，係砍 tick 內嘅 Turso round trip**：pre-tick front（init／gate／claim）＋",
  "pool／aged-eval reads ＋ flush ＋ deferral read ＋ 三個 5 分鐘 sync ＋ drain（§4.6.1 清單 4／5 合共",
  "~11–16 個）。清單 5（三個 sync 合成一個 grouped read ＋ 一個 batch write）係已確認可以 batch 嘅",
  "第一刀。",
  "",
  "同 §4.6.1「落線點驗」對照：第 1 點（安靜 tick ~20–30）**中**（18／19／30／32）；第 3 點（死 tick 出",
  "現喺 `recent[0]`）**中**（56 嗰個）；第 4 點（`windows` 遞增）**中**，但多咗一個決定性細節 ——",
  "讀數係 persist 嘅，唔係服務嗰個 isolate 嘅 live state，所以兩個 poll 完全一樣係正常，唔係卡住。",
  "",
);

	let text = fs.readFileSync(T, "utf8");
	const count = (needle) => text.split(needle).length - 1;

	const anchor461 = "#### 4.6.1 ";
	if (count(anchor461) !== 1) {
	  console.error("MISS/AMBIGUOUS  4.6.1 anchor");
	  process.exit(1);
	}
	if (!text.includes("第二條軸：host split")) {
	  const at = text.indexOf(anchor461);
	  text = text.slice(0, at) + splitBullet + text.slice(at);
	}

	const anchor5 = "\n## 5. ";
	if (count(anchor5) !== 1) {
	  console.error("MISS/AMBIGUOUS  §5 anchor");
	  process.exit(1);
	}
	if (text.includes("#### 4.6.2 ")) {
	  console.error("ALREADY         §4.6.2");
	  process.exit(1);
	}
	const at5 = text.indexOf(anchor5);
	text = text.slice(0, at5 + 1) + section + "\n" + text.slice(at5 + 1);

fs.writeFileSync(T, text);
console.log("ok        round-trips: the subrequest live readings");
