#!/usr/bin/env node
/**
 * Round 5c (2026-09-26): /health pays ONE round trip for its forensics rows
 * instead of six.
 *
 * WHY. The per-isolate step counter (`dbSteps`) is published inside the tick's
 * completion summary, so reading it via /health shows whatever Worker
 * invocations shared that isolate — the same trap scripts/read-heartbeat.js
 * exists for. Read from Turso instead, one tick showed five single-key reads
 * (`push_watch_pass`, `telemetry_token_stats_count`, `telemetry_seen_tokens_count`,
 * `listEnabledChats`, `scan_heartbeat`) that belong to the /health handler, not
 * to the tick: the uptime monitor drives that page once a minute, and it was
 * paying 2 batched reads + 4 single-key reads ≈ 6 round trips, ~15-20ms of CPU,
 * under the SAME 10ms Workers Free ceiling that Cloudflare has been killing
 * this Worker's invocations for (`exceededResources`, cpuTime pinned at
 * 10,000us). A killed /health is a dead status page, which is the page an
 * operator uses to diagnose exactly that.
 *
 * WHAT. The rows /health already batches (scheduled-arrival diagnostics, the
 * drain's failure record, both Birdeye CU ledgers) are joined by the three rows
 * it read on their own (the tracker pass line and both telemetry counters), and
 * the enabled-chats LISTING becomes a COUNT(*) statement inside the same batch
 * — /health only ever used its length, so the mapping was decoded for nothing.
 * One request, one round trip.
 *
 * THE ONE RULE THAT MUST NOT DRIFT. The telemetry counters have a self-heal:
 * a NEGATIVE row is the drifted state (observed -3105) whose live COUNT(*)
 * becomes the new truth. That rule now lives in two exported pure functions
 * which BOTH the single-read path and the batched path call, instead of being
 * re-implemented at the second call site.
 *
 * Run: node docs/patches/round5-health-front-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new] */
const EDITS = [
  // ---------- src/db.ts ----------
  [
    "src/db.ts",
    "db: the telemetry-counter rule becomes two pure functions",
    lines(
      "  private async readTelemetryCounter(",
      "    key: string,",
      "    fallbackSql: string,",
      "  ): Promise<number> {",
      "    let cached: number | null = null;",
      "    try {",
      "      const v = await this.getWorkerState(key);",
      "      if (v !== null && /^-?\\d+$/.test(v)) cached = Number(v);",
      "    } catch {",
      "      // fall through to the live count",
      "    }",
    ),
    lines(
      "  private async readTelemetryCounter(",
      "    key: string,",
      "    fallbackSql: string,",
      "  ): Promise<number> {",
      "    let cached: number | null = null;",
      "    try {",
      "      cached = parseTelemetryCounter(await this.getWorkerState(key));",
      "    } catch {",
      "      // fall through to the live count",
      "    }",
    ),
  ],
  [
    "src/db.ts",
    "db: readHealthFront, the page's ONE read",
    lines(
      "  /**",
      "   * Last N scan-history rows (newest first) for gap forensics — the data",
      "   * behind /debug/scan-history. A gap in these rows while the tick ring",
    ),
    lines(
      "  /**",
      "   * Everything /health reads in ONE round trip (2026-09-26).",
      "   *",
      "   * The page's forensic rows are read by an uptime monitor once a minute,",
      "   * and they used to arrive as two batched reads plus four single-key reads",
      "   * (~6 round trips, ~15-20ms of CPU at the 2.4-5.8ms scripts/cpu-profile.js",
      "   * measures per round trip) — under the same 10ms Workers Free ceiling that",
      "   * Cloudflare has been killing this Worker's invocations for. Same shape as",
      "   * Db.readScanFront: one batch, one request, and the caller passes the keys",
      "   * it needs so the list stays visible where it is used.",
      "   *",
      "   * `enabledChats` is a COUNT, not the listing: /health only ever used the",
      "   * length of listEnabledChats, so the row mapping was decoded for nothing.",
      "   *",
      "   * Failure is all-or-nothing, like every other batched read here: the caller",
      "   * catches once and the page renders with nulls, which is what its per-block",
      "   * try/catch already did for the reads that lived in separate requests.",
      "   */",
      "  async readHealthFront(keys: readonly string[]): Promise<{",
      "    states: Map<string, string>;",
      "    enabledChats: number;",
      "  }> {",
      "    const state = {",
      "      sql: `SELECT key, value FROM worker_state WHERE key IN (${keys",
      "        .map(() => \"?\")",
      "        .join(\",\")})`,",
      "      args: [...keys] as Array<string | number | null>,",
      "    };",
      "    const chats = {",
      "      sql: \"SELECT COUNT(*) AS n FROM chat_settings WHERE enabled = 1\",",
      "      args: [] as Array<string | number | null>,",
      "    };",
      "    const res = await this.get().batch([state, chats], \"read\");",
      "    const states = new Map<string, string>();",
      "    for (const row of res[0]?.rows ?? []) {",
      "      const r = row as Record<string, unknown>;",
      "      states.set(String(r.key), String(r.value));",
      "    }",
      "    const counted = res[1]?.rows?.[0] as { n?: number | bigint } | undefined;",
      "    return { states, enabledChats: Number(counted?.n ?? 0) };",
      "  }",
      "",
      "  /**",
      "   * Last N scan-history rows (newest first) for gap forensics — the data",
      "   * behind /debug/scan-history. A gap in these rows while the tick ring",
    ),
  ],
  // Parse + usability, module scope, above `export class Db` (they are pure, and
  // readTelemetryCounter lives inside the class but must not own the rule).
  [
    "src/db.ts",
    "db: parseTelemetryCounter / telemetryCounterUsable at module scope",
    lines(
      "/**",
      " * The front's gate keys, in one place so the read and the legs cannot drift:",
      " * the launch_ms migration flag, the token_stats prune stamp and the Birdeye",
      " * backfill stamp. Every one of them is a \"when did this job last run\" row,",
      " * read once per tick.",
      " */",
    ),
    lines(
      "/**",
      " * A telemetry counter row as a number: the integer it holds, or null when the",
      " * row is absent or not integer-shaped.",
      " *",
      " * A NEGATIVE value is returned as it is, on purpose: it is the drifted state",
      " * readTelemetryCounter self-heals (observed telemetry_token_stats_count =",
      " * -3105, where the incremental bumps had drifted past zero), and folding it",
      " * into the same null an absent row returns would erase the only signal that a",
      " * heal is due.",
      " *",
      " * Exported and pure because the judgement has TWO callers: the single-row",
      " * read inside Db and /health's batched front (Db.readHealthFront), which",
      " * receives the row for free and must not re-invent the rule.",
      " */",
      "export function parseTelemetryCounter(",
      "  raw: string | null | undefined,",
      "): number | null {",
      "  if (raw === null || raw === undefined) return null;",
      "  return /^-?\\d+$/.test(raw) ? Number(raw) : null;",
      "}",
      "",
      "/**",
      " * Whether a counter read may be SERVED, or has to be re-derived from the live",
      " * COUNT(*) instead: absent and negative are both \"re-derive\" (see",
      " * parseTelemetryCounter for why negative is kept rather than discarded).",
      " */",
      "export function telemetryCounterUsable(value: number | null): value is number {",
      "  return value !== null && value >= 0;",
      "}",
      "",
      "/**",
      " * The front's gate keys, in one place so the read and the legs cannot drift:",
      " * the launch_ms migration flag, the token_stats prune stamp and the Birdeye",
      " * backfill stamp. Every one of them is a \"when did this job last run\" row,",
      " * read once per tick.",
      " */",
    ),
  ],
];

function main() {
  const problems = [];
  const applied = [];
  const files = new Map();
  for (const [file] of EDITS) if (!files.has(file)) files.set(file, read(file));

  for (const [file, label, old, next] of EDITS) {
    const src = files.get(file);
    const count = hits(src, old);
    if (count !== 1) {
      problems.push(`${file}: anchor for "${label}" matched ${count}x (need exactly 1)`);
      continue;
    }
    files.set(file, src.replace(old, next));
    applied.push(`${file}: ${label}`);
  }

  const out = files.get("src/db.ts");
  for (const needle of [
    "export function parseTelemetryCounter(",
    "export function telemetryCounterUsable(",
    "async readHealthFront(keys: readonly string[]): Promise<{",
    "cached = parseTelemetryCounter(await this.getWorkerState(key));",
    "SELECT COUNT(*) AS n FROM chat_settings WHERE enabled = 1",
    "return { states, enabledChats: Number(counted?.n ?? 0) };",
    "const res = await this.get().batch([state, chats], \"read\");",
  ]) {
    if (hits(out, needle) < 1) problems.push(`post-condition failed: missing ${needle}`);
  }
  // The inline rule must be GONE from readTelemetryCounter, or the two paths
  // can drift — which is the one thing this change must not introduce.
  if (hits(out, "if (v !== null && /^-?\\d+$/.test(v)) cached = Number(v);") !== 0) {
    problems.push("the inline regex in readTelemetryCounter was left behind");
  }
  if (hits(out, "export function parseTelemetryCounter(") !== 1) {
    problems.push("parseTelemetryCounter must be declared exactly once");
  }

  if (problems.length > 0) {
    console.error("NOT APPLIED — nothing written:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  for (const [file, src] of files) fs.writeFileSync(path.join(root, file), src, "utf8");
  console.log(`applied ${applied.length} edit(s):`);
  for (const a of applied) console.log(`  ✓ ${a}`);
}

main();
