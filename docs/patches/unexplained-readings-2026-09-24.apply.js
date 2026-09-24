#!/usr/bin/env node
/**
 * THE THREE READINGS THAT COULD NOT BE FINISHED — closed with evidence.
 *
 * 1. `writeDrainError {pending 15}` PARKED SINCE 11:58.
 *    NOT A STUCK QUEUE. `252b720` (the missing comma in the liquidity CASE)
 *    was committed 11:57:56Z and the record's `at` is 11:58:37.643Z — 41
 *    seconds later, i.e. the last failure of the OLD build, caught as the fix
 *    deployed. The row is never cleared on purpose ("the last thing that went
 *    wrong is evidence", persistDrainError), so `pending 15` is the queue size
 *    AT that failure, not the backlog now — and next to counters that DO move,
 *    a frozen number reads as live. FIX: publish its AGE (/health
 *    `writeDrainErrorAgeMs`), which is the reading that separates "a record
 *    from hours ago" from "a backlog right now".
 *
 * 2. GECKO "RETURNS 0 WITH http429 = 0".
 *    Two shapes, and only one was a real gap:
 *      - `requests` also counts ALTERNATE-host attempts, while `ok`/`http429`
 *        count only the primary. Live 22:59: `requests 3, ok 0, http429 2` with
 *        `altAttempts 1` — 3 = 2 + 1, fully accounted. There was never an
 *        unaccounted request.
 *      - The real one: a 200 page carrying ZERO pools. `ok` counts the HTTP
 *        success, so the feed is empty with every failure counter flat — live
 *        2026-09-24: `ok 1` while `summary.geo` stayed 0 and no 429 was
 *        recorded. FIX: name it — `emptyPages` / `emptyPageStreak` /
 *        `lastEmptyAt` / `parsedPools` on the discovery pages, plus one warn
 *        per empty streak.
 *
 * 3. `scheduledArrivalUnaccounted: true`.
 *    A TRUE POSITIVE, not a bug: it means an arrival was stamped pre-init (its
 *    predecessor never returned) and no cron tick has CLAIMED since. Today's
 *    cron-tick ring has two holes — 17:16:20 → 19:29:20 (2h13m) and 20:06:20 →
 *    22:41:20 (2h35m), the second ending at the 22:39:52 deploy — while scans
 *    kept landing from the HTTP fallback, which is exactly the shape
 *    shouldStampArrival's own note describes ("a 19-minute ring hole and a
 *    2h42m one, with scans still landing from the HTTP monitor"). The gap left
 *    was that a monitor could not see it: the flag is a boolean and the
 *    heartbeat stays green. FIX: publish `scheduledTickHoleMs` — how long since
 *    a cron tick claimed, a number with a threshold.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const DOC_HEADING = "## 2026-09-24（補）：三個讀數嘅結論";

const DOC = lines(
  "",
  "---",
  "",
  DOC_HEADING,
  "",
  "### 1. `writeDrainError {pending 15}` —— 唔係卡住嘅隊列",
  "",
  "`252b720`（liquidity CASE 少個逗號）**11:57:56Z** commit，而個 record 嘅 `at` 係",
  "**11:58:37.643Z** —— 遲 41 秒，即係**舊 build 最後一次失敗**，啱啱撞正 fix 部署落地。",
  "個 row 係故意唔會清（`persistDrainError`：最後錯過嘅嘢就係證據），所以 `pending 15` ＝",
  "**嗰次失敗時**嘅隊列長度，唔係而家。擺喺一堆會郁嘅計數器隔籬，凍住嘅數字就會讀成即時。",
  "",
  "修正：`/health.writeDrainErrorAgeMs`（record 有幾舊）。呢個就係分開「幾個鐘前嘅記錄」同",
  "「而家積壓」嘅讀數。",
  "",
  "### 2. Gecko「回 0 而 http429 = 0」—— 兩個形狀，一個係真空白",
  "",
  "**(a) 唔存在「唔見咗一個 request」**：`requests` 連 alternate host 嘅嘗試都計，但 `ok` / `http429`",
  "只計 primary。live 22:59：`requests 3, ok 0, http429 2`，同時 `altAttempts 1` —— 3 = 2 + 1，完全對得上。",
  "",
  "**(b) 真嘅空白**：一個 **200 但零個 pool** 嘅頁。`ok` 計嘅係 HTTP 成功，所以 feed 空、而所有失敗計數器",
  "都係平 —— live 2026-09-24：`ok 1` 而 `summary.geo` 一直 0，冇任何 429。",
  "修正：`emptyPages` / `emptyPageStreak` / `lastEmptyAt` / `parsedPools`（只計 discovery page），",
  "同每個空 streak 一次 warn。",
  "",
  "### 3. `scheduledArrivalUnaccounted: true` —— 真陽性",
  "",
  "意思係：有個 arrival 喺 pre-init 蓋咗（即佢前一個冇返嚟），而之後**冇任何 cron tick claim 過**。",
  "今日 cron tick ring 有兩個洞：",
  "",
  "| 洞 | 長度 | 點收 |",
  "|---|---|---|",
  "| 17:16:20 → 19:29:20 | 2h13m | 自己收（冇 deploy） |",
  "| 20:06:20 → 22:41:20 | 2h35m | 22:39:52 個 deploy |",
  "",
  "兩個洞期間掃描都照落（HTTP fallback 驅動），所以 heartbeat 一直綠 —— 呢個正是",
  "`shouldStampArrival` 註解本身記錄過嘅形狀（「a 19-minute ring hole and a 2h42m one, with scans",
  "still landing from the HTTP monitor」）。剩低嘅缺口係**冇嘢可以報警**：個 flag 係 boolean，",
  "而 heartbeat 睇唔到。",
  "",
  "修正：`/health.scheduledTickHoleMs` —— 距離上一次 cron tick claim 幾久，一個有 threshold 嘅數字（健康 60s 節奏讀 60–120s）。",
);

const PATCHES = [
  // ── src/worker.ts ────────────────────────────────────────────────────────
  {
    file: "src/worker.ts",
    what: "a pure age helper for the readings that stay put by design",
    marker: "export function healthAgeMs(",
    anchor: lines("  return { stamp, tail: () => tail };", "}"),
    replacement: lines(
      "  return { stamp, tail: () => tail };",
      "}",
      "",
      "/**",
      " * `now - at` for a durable epoch read by /health, or null when there is no",
      " * reading at all (a missing row is NOT a row written at the epoch).",
      " *",
      " * WHY AN AGE AND NOT JUST THE TIMESTAMP (2026-09-24): two of /health's",
      " * readings are snapshots that stay put BY DESIGN, and a bare timestamp next",
      " * to counters that DO move is what let them read as live:",
      " *",
      " *   - `writeDrainError.pending` is the queue size AT the failure — a clean",
      " *     drain never rewrites the row (see persistDrainError), so it sat at 15",
      " *     from 11:58 all day while the SQL it named had been fixed 41 seconds",
      " *     before that stamp was written.",
      " *   - `scheduledTickAt` frozen for 2h35m is a cron ring hole (deliveries",
      " *     arriving, every tick dying inside init, scans still landing from the",
      " *     HTTP fallback), and the heartbeat cannot show it because the fallback",
      " *     keeps the heartbeat green.",
      " *",
      " * An age is what a monitor can alert on. A timestamp is what a human reads.",
      " */",
      "export function healthAgeMs(now: number, at: number | null | undefined): number | null {",
      "  if (at === null || at === undefined) return null;",
      "  const value = Number(at);",
      "  if (!Number.isFinite(value) || value <= 0) return null;",
      "  return Math.max(0, Math.round(now - value));",
      "}",
    ),
  },
  {
    file: "src/worker.ts",
    what: "the drain record publishes how old it is",
    marker: "writeDrainErrorAgeMs:",
    anchor: lines(
      "        writeDrainError,",
      "        lastSkip: scanner?.lastSkip ?? null,",
    ),
    replacement: lines(
      "        writeDrainError,",
      "        // HOW OLD that record is (see healthAgeMs). `pending` inside it is",
      "        // the queue size AT the failure, never the backlog now: a clean",
      "        // drain writes nothing, so the row keeps the last failure's numbers",
      "        // for as long as the bot stays healthy. Live 2026-09-24: it read",
      "        // `pending 15` all day while its own `at` (11:58:37.643Z) sat 41",
      "        // seconds BEFORE the commit that ended those failures — the age is",
      "        // the one reading that says so.",
      "        writeDrainErrorAgeMs: healthAgeMs(",
      "          Date.now(),",
      "          writeDrainError === null ? null : writeDrainError.at,",
      "        ),",
      "        lastSkip: scanner?.lastSkip ?? null,",
    ),
  },
  {
    file: "src/worker.ts",
    what: "and a cron ring hole becomes a number with a threshold",
    marker: "scheduledTickHoleMs:",
    anchor: lines(
      "        scheduledArrivalUnaccounted:",
      "          scheduledArrivalAt !== null &&",
      "          (scheduledTickAt === null || scheduledArrivalAt > scheduledTickAt),",
    ),
    replacement: lines(
      "        scheduledArrivalUnaccounted:",
      "          scheduledArrivalAt !== null &&",
      "          (scheduledTickAt === null || scheduledArrivalAt > scheduledTickAt),",
      "        // The number behind that boolean, and the one a monitor can alert",
      "        // on: how long since a cron tick last CLAIMED. A healthy 60s",
      "        // cadence reads ~60-120s; the 2h35m it read on 2026-09-24",
      "        // (20:06:20 → 22:41:20) was a ring hole — cron deliveries arriving,",
      "        // every tick dying inside init, scans still landing from the HTTP",
      "        // fallback, so the heartbeat stayed green and NOTHING flagged it",
      "        // (see shouldStampArrival's own note on the 2026-09-23 holes).",
      "        scheduledTickHoleMs: healthAgeMs(Date.now(), scheduledTickAt),",
    ),
  },
  // ── src/geckoterminal.ts ─────────────────────────────────────────────────
  {
    file: "src/geckoterminal.ts",
    what: "the feed stats gain the empty-page reading",
    marker: "emptyPages: number;",
    anchor: lines(
      "  /** Responses that parsed as OK. */",
      "  ok: number;",
      "  /** 429s seen since the isolate booted. */",
      "  http429: number;",
    ),
    replacement: lines(
      "  /** Responses that parsed as OK. */",
      "  ok: number;",
      "  /**",
      "   * Pages that parsed as OK and carried ZERO pools — the \"Gecko returned 0",
      "   * with `http429: 0`\" shape, live 2026-09-24: `ok: 1` while `summary.geo`",
      "   * stayed 0 and every failure counter was flat. `ok` counts the HTTP 200,",
      "   * so without this the empty feed had no cause on any surface.",
      "   */",
      "  emptyPages: number;",
      "  /** Consecutive empty pages (0 after a page that carried pools). */",
      "  emptyPageStreak: number;",
      "  /** Pools every discovery page has parsed, since this isolate booted. */",
      "  parsedPools: number;",
      "  /** Epoch of the newest empty page (0 = none yet). */",
      "  lastEmptyAt: number;",
      "  /** 429s seen since the isolate booted. */",
      "  http429: number;",
    ),
  },
  {
    file: "src/geckoterminal.ts",
    what: "the inactive record carries them too",
    marker: "      emptyPages: 0,",
    anchor: lines(
      "      requests: 0,",
      "      ok: 0,",
      "      http429: 0,",
    ),
    replacement: lines(
      "      requests: 0,",
      "      ok: 0,",
      "      emptyPages: 0,",
      "      emptyPageStreak: 0,",
      "      parsedPools: 0,",
      "      lastEmptyAt: 0,",
      "      http429: 0,",
    ),
  },
  {
    file: "src/geckoterminal.ts",
    what: "the client counts them",
    marker: "  private emptyPages = 0;",
    anchor: lines("  private requests = 0;", "  private ok = 0;"),
    replacement: lines(
      "  private requests = 0;",
      "  private ok = 0;",
      "  /** See GeckoFeedStats.emptyPages — the 200-with-zero-pools reading. */",
      "  private emptyPages = 0;",
      "  private emptyPageStreak = 0;",
      "  private parsedPools = 0;",
      "  private lastEmptyAt = 0;",
    ),
  },
  {
    file: "src/geckoterminal.ts",
    what: "the stats() copy carries them",
    marker: "      emptyPages: this.emptyPages,",
    anchor: lines(
      "      requests: this.requests,",
      "      ok: this.ok,",
      "      http429: this.http429,",
    ),
    replacement: lines(
      "      requests: this.requests,",
      "      ok: this.ok,",
      "      emptyPages: this.emptyPages,",
      "      emptyPageStreak: this.emptyPageStreak,",
      "      parsedPools: this.parsedPools,",
      "      lastEmptyAt: this.lastEmptyAt,",
      "      http429: this.http429,",
    ),
  },
  {
    file: "src/geckoterminal.ts",
    what: "the discovery pages count what they parsed",
    // The POST-repair signature, so the entry reads as applied on a tree the
    // repair below has already touched (the first signature it wrote no longer
    // exists anywhere, and a marker that cannot be found makes this entry MISS
    // and block the whole run).
    marker: "private notePage(pools: NewPool[]): NewPool[] {",
    anchor: lines(
      "  async fetchNewPools(page = 1): Promise<NewPool[]> {",
      "    return parseNewPools(await this.get(`/networks/solana/new_pools?page=${page}`));",
      "  }",
    ),
    replacement: lines(
      "  /**",
      "   * Count one parsed discovery page (see GeckoFeedStats.emptyPages). A 200",
      "   * whose pool list is empty is counted as a SUCCESS by `ok`, so this is the",
      "   * counter that names \"Gecko answered, and the feed was still 0\" — the",
      "   * shape that looked identical to a quiet market until it had a name.",
      "   */",
      "  private notePage(pools: NewPool[]): NewPool[] {",
      "    if (pools.length > 0) {",
      "      this.parsedPools += pools.length;",
      "      this.emptyPageStreak = 0;",
      "      return pools;",
      "    }",
      "    this.emptyPages += 1;",
      "    this.emptyPageStreak += 1;",
      "    this.lastEmptyAt = Date.now();",
      "    // Once per streak, not once per page: a blocked/edge-empty feed would",
      "    // otherwise warn on every tick for hours.",
      "    if (this.emptyPageStreak === 1) {",
      "      console.warn(",
      "        \"[gecko] discovery page parsed OK with ZERO pools — this is NOT a 429: the API answered 200 with an empty page (see GeckoFeedStats.emptyPages)\",",
      "      );",
      "    }",
      "    return pools;",
      "  }",
      "",
      "  async fetchNewPools(page = 1): Promise<NewPool[]> {",
      "    return this.notePage(",
      "      parseNewPools(await this.get(`/networks/solana/new_pools?page=${page}`)),",
      "    );",
      "  }",
    ),
  },
  {
    file: "src/geckoterminal.ts",
    what: "the trending leg counts too",
    // NOT `return this.notePage(`: the new_pools entry above writes one too, so
    // that marker matched ITS output and skipped this entry (the same
    // marker-collision trap the phase-ladder patch hit twice). This fragment
    // exists only once the trending call is wrapped — the 8-space `await`.
    marker: "parseNewPools(\n        await this.get(\n          `/networks/solana/trending_pools",
    anchor: lines(
      "  async fetchTrendingPools(limit: number): Promise<NewPool[]> {",
      "    return parseNewPools(",
      "      await this.get(",
      "        `/networks/solana/trending_pools?include=base_token&limit=${Math.min(",
      "          Math.max(1, Math.floor(limit)),",
      "          20,",
      "        )}`,",
      "      ),",
      "    );",
      "  }",
    ),
    replacement: lines(
      "  async fetchTrendingPools(limit: number): Promise<NewPool[]> {",
      "    return this.notePage(",
      "      parseNewPools(",
      "        await this.get(",
      "          `/networks/solana/trending_pools?include=base_token&limit=${Math.min(",
      "            Math.max(1, Math.floor(limit)),",
      "            20,",
      "          )}`,",
      "        ),",
      "      ),",
      "    );",
      "  }",
    ),
  },
  // ── scripts/test-unit.js ─────────────────────────────────────────────────
  {
    file: "scripts/test-unit.js",
    what: "the age helper is imported",
    marker: "healthAgeMs } = require",
    anchor: lines(
      'const { tradeFingerprint, deadTickBackfillInfo, TICK_PROGRESS_KEY, tickProgressRecord, parseTickProgress, tickProgressNote, tickPhaseLadder } = require("../dist/worker.js");',
    ),
    replacement: lines(
      'const { tradeFingerprint, deadTickBackfillInfo, TICK_PROGRESS_KEY, tickProgressRecord, parseTickProgress, tickProgressNote, tickPhaseLadder, healthAgeMs } = require("../dist/worker.js");',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the age helper and the /health wiring are pinned",
    marker: "the two frozen readings publish their age",
    anchor: lines(
      '  await test("out-of-window patch: the pre-flush record is written BEFORE the flush and read by the successor (docs/patches/tick-progress-record.apply.js)", () => {',
    ),
    replacement: lines(
      '  await test("healthAgeMs: a frozen reading reports its age, and a missing row is not the epoch", () => {',
      "    assert.equal(healthAgeMs(1000, null), null, \"no row = no reading\");",
      "    assert.equal(healthAgeMs(1000, undefined), null);",
      "    assert.equal(healthAgeMs(1000, 0), null, \"0 is the 'never written' sentinel, not 1970\");",
      "    assert.equal(healthAgeMs(1000, Number.NaN), null);",
      "    assert.equal(healthAgeMs(2000, 1500), 500);",
      "    assert.equal(healthAgeMs(1000, 5000), 0, \"clock skew never reports a negative age\");",
      "  });",
      "",
      '  await test("out-of-window patch: the two frozen readings publish their age (docs/patches/unexplained-readings-2026-09-24.apply.js)", () => {',
      "    const strip = (text) =>",
      "      text",
      "        .replace(/\\/\\*[\\s\\S]*?\\*\\//g, \"\")",
      "        .replace(/\\/\\/[^\\n]*/g, \"\")",
      "        .replace(/\\s+/g, \"\");",
      "    const read = (p) => strip(fs.readFileSync(path.join(__dirname, \"..\", p), \"utf8\"));",
      "    const workerSrc = read(\"src/worker.ts\");",
      "    const geckoSrc = read(\"src/geckoterminal.ts\");",
      "    const applied = {",
      "      \"worker (the age helper exists)\": workerSrc.includes(\"exportfunctionhealthAgeMs(\"),",
      "      \"worker (the drain record publishes its age, next to the record)\":",
      "        workerSrc.includes(\"writeDrainErrorAgeMs:healthAgeMs(\") &&",
      "        workerSrc.includes(\"writeDrainError===null?null:writeDrainError.at,\"),",
      "      \"worker (and the cron ring hole is a number)\":",
      "        workerSrc.includes(\"scheduledTickHoleMs:healthAgeMs(Date.now(),scheduledTickAt),\"),",
      "      \"gecko (a 200 with zero pools has a counter of its own)\":",
      "        geckoSrc.includes(\"emptyPages:number;\") &&",
      "        geckoSrc.includes(\"privatenotePage(pools:NewPool[]):NewPool[]{\") &&",
      "        geckoSrc.includes(\"returnthis.notePage(\"),",
      "    };",
      "    const done = Object.entries(applied).filter(([, v]) => v);",
      "    if (done.length === 0) {",
      "      console.log(",
      '        "  \\u2139 the frozen-reading patch is missing - apply docs/patches/unexplained-readings-2026-09-24.apply.js",',
      "      );",
      "      return;",
      "    }",
      "    const missing = Object.entries(applied).filter(([, v]) => !v).map(([k]) => k);",
      "    assert.deepEqual(missing, [], `half-applied: ${missing.join(\", \")}`);",
      "  });",
      "",
      '  await test("out-of-window patch: the pre-flush record is written BEFORE the flush and read by the successor (docs/patches/tick-progress-record.apply.js)", () => {',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the gecko empty-page counter is driven end to end",
    marker: "a 200 page with zero pools",
    anchor: lines(
      '  await test("GeckoTerminalClient: consecutive 429s escalate the pause; a success resets it", async () => {',
    ),
    replacement: lines(
      '  await test("GeckoTerminalClient: a 200 page with zero pools is an EMPTY PAGE, not a quiet market", async () => {',
      "    const origFetch = global.fetch;",
      "    global.fetch = async () =>",
      "      new Response(JSON.stringify({ data: [] }), {",
      "        status: 200,",
      '        headers: { "Content-Type": "application/json" },',
      "      });",
      "    try {",
      "      const client = new GeckoTerminalClient({ geckoterminalRequestIntervalMs: 0 });",
      "      const before = client.stats();",
      "      await client.fetchNewPools(1);",
      "      const once = client.stats();",
      '      assert.equal(once.ok, before.ok + 1, "the HTTP 200 still counts as an OK response");',
      '      assert.equal(once.http429, before.http429, "and it is NOT a 429 - which is why the feed looked fine");',
      '      assert.equal(once.emptyPages, before.emptyPages + 1, "the zero-pool page is the reading that names the anomaly");',
      '      assert.equal(once.emptyPageStreak, 1);',
      '      assert.equal(once.parsedPools, before.parsedPools, "nothing was parsed");',
      '      assert.ok(once.lastEmptyAt > 0, "and the newest empty page is stamped");',
      "      await client.fetchTrendingPools(20);",
      "      const twice = client.stats();",
      '      assert.equal(twice.emptyPages, before.emptyPages + 2, "both discovery legs count");',
      '      assert.equal(twice.emptyPageStreak, 2, "and the streak follows");',
      "      assert.equal(geckoFeedStats().emptyPages, twice.emptyPages, \"the isolate publishes it\");",
      "      // The other branch: a page that carries pools counts them and ends the",
      "      // streak (called directly - the fetch stub above cannot produce pools).",
      "      client.notePage(new Array(7).fill(null));",
      "      const fed = client.stats();",
      '      assert.equal(fed.parsedPools, 7, "a page with pools counts them");',
      '      assert.equal(fed.emptyPageStreak, 0, "and clears the streak");',
      '      assert.equal(fed.emptyPages, twice.emptyPages, "without touching the empty count");',
      "    } finally {",
      "      global.fetch = origFetch;",
      "    }",
      "  });",
      "",
      '  await test("GeckoTerminalClient: consecutive 429s escalate the pause; a success resets it", async () => {',
    ),
  },
  {
    file: "src/geckoterminal.ts",
    // The first form returned a NUMBER from notePage, so neither call site
    // could return its array (tsc: TS2322/TS2345 on both legs). The counter
    // wraps a page, so it has to hand the page back.
    what: "notePage hands the page back, not its count",
    marker: "private notePage(pools: NewPool[]): NewPool[] {",
    anchor: lines(
      "  private notePage(pools: number): number {",
      "    if (pools > 0) {",
      "      this.parsedPools += pools;",
    ),
    replacement: lines(
      "  private notePage(pools: NewPool[]): NewPool[] {",
      "    if (pools.length > 0) {",
      "      this.parsedPools += pools.length;",
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "and the direct notePage call passes a page",
    marker: "client.notePage(new Array(7)",
    anchor: lines("      client.notePage(7);"),
    replacement: lines("      client.notePage(new Array(7).fill(null));"),
  },
  {
    file: "scripts/test-unit.js",
    // The guard's own needle pinned the FIRST signature (`pools:number:string`),
    // which the repair above changed — so the guard failed on a correctly
    // patched tree. A drift guard that fails on the fix it is guarding is
    // worse than none.
    what: "the guard's needle matches the signature the repair left",
    marker: "privatenotePage(pools:NewPool[]):NewPool[]{",
    anchor: lines('        geckoSrc.includes("privatenotePage(pools:number):number{") &&'),
    replacement: lines('        geckoSrc.includes("privatenotePage(pools:NewPool[]):NewPool[]{") &&'),
  },
];

const buffers = new Map();
const bufferOf = (file) => {
  if (!buffers.has(file)) buffers.set(file, fs.readFileSync(file, "utf8"));
  return buffers.get(file);
};
let failed = false;
for (const patch of PATCHES) {
  const text = bufferOf(patch.file);
  if (text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const at = text.indexOf(patch.anchor);
  if (at < 0) {
    console.error(`MISS      ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  if (text.indexOf(patch.anchor, at + 1) >= 0) {
    console.error(`AMBIGUOUS ${patch.file}: ${patch.what}`);
    failed = true;
    continue;
  }
  buffers.set(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

{
  const file = "docs/scan-completion-loss.md";
  const text = bufferOf(file);
  if (text.includes(DOC_HEADING)) {
    console.log(`already   ${file}: the three readings are documented`);
  } else {
    buffers.set(file, `${text.trimEnd()}\n${DOC}`);
    console.log(`ok        ${file}: the three readings are documented`);
  }
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchor above");
  process.exit(1);
}
let writes = 0;
for (const [file, text] of buffers) {
  if (text === fs.readFileSync(file, "utf8")) continue;
  fs.writeFileSync(file, text);
  writes += 1;
}
console.log(`\nall patches applied (${writes} file(s) written)`);
