#!/usr/bin/env node
/**
 * The trailing comma that filled the deferred-write queue (2026-09-24).
 *
 * FOUND BY the durable drain record added earlier today — the thing it was built
 * for. `/health` went from `writeDrain {pending 47, failures 38}` with no cause
 * to a named one:
 *
 *   { "method": "updateTokenMaxMcaps", "name": "LibsqlError",
 *     "message": "SQL_PARSE_ERROR: SQL string could not be parsed: near WHERE,
 *                 \"None\": syntax error at (3, 18)",
 *     "pending": 11 }
 *
 * `updateTokenMaxMcaps` builds two CASE clauses and dropped the comma between
 * them unconditionally:
 *
 *     max_mcap_observed = CASE ... ELSE max_mcap_observed END,${ liqCases ? ... : "" }
 *                                                              ^ outside the conditional
 *
 * A batch where EVERY entry lacks a comparable liquidity reading (the Jupiter/
 * Gecko legs — `liquidityIsComparable` false, so the scanner omits the column)
 * therefore produced `... ELSE max_mcap_observed END,` followed by `WHERE` — a
 * trailing comma, which libsql refuses to parse at all. The failure is not
 * partial: the ENTIRE statement is rejected, so that tick's mcap raises never
 * land, the entry stays at the head of the deferred queue and is retried (and
 * fails) twice more before being dropped (DEFERRED_WRITE_MAX_ATTEMPTS), which is
 * exactly the backlog shape `pending`/`failures` had been showing for days with
 * no reason attached.
 *
 * Why it takes the whole batch with it: the CASE clause exists only to make the
 * raise monotonic in ONE statement (a CASE arm's THEN is skipped when the
 * comparison is false, so no per-row round trip is needed). The comma, not the
 * clause, was the bug.
 *
 * The existing unit test never caught it because every fixture it passes carries
 * a `liquidityUsd` — the mixed batch is the tested shape, the all-undefined one
 * is not. The test below is that missing shape.
 *
 * An apply script because src/db.ts and scripts/test-unit.js both sit past the
 * file-tool window at these offsets; anchors must match exactly once.
 */
const fs = require("fs");
const lines = (...xs) => xs.join("\n");

const PATCHES = [
  {
    file: "src/db.ts",
    what: "the liquidity CASE owns its comma",
    marker: "liqCases\n                  ? `,",
    anchor: lines(
      "    await this.get().execute({",
      "      sql: `UPDATE token_stats SET",
      "              max_mcap_observed = CASE ${mcapCases} ELSE max_mcap_observed END,${",
      "                liqCases",
      "                  ? `",
      "              max_liquidity_observed = CASE ${liqCases} ELSE max_liquidity_observed END`",
      '                  : ""',
      "              }",
      '            WHERE token IN (${tokens.map(() => "?").join(",")})`,',
    ),
    replacement: lines(
      "    // The comma after the mcap CASE belongs to the LIQUIDITY clause, not to",
      "    // the statement. Emitted unconditionally it produced `... END,` followed",
      "    // by `WHERE` whenever a batch carried no comparable liquidity reading at",
      "    // all (every coin that tick served by the Jupiter/Gecko legs — see",
      "    // liquidityIsComparable), and libsql rejects the whole statement:",
      "    // `SQL string could not be parsed: near WHERE, \"None\": syntax error at",
      "    // (3, 18)`. Not a partial failure — that tick's mcap raises never landed,",
      "    // and the deferred entry was retried twice more before being dropped,",
      "    // which is the backlog `writeDrain.pending` showed for days (2026-09-24:",
      "    // pending 47, and the named cause once the drain record was made",
      "    // durable: updateTokenMaxMcaps, pending 11).",
      "    await this.get().execute({",
      "      sql: `UPDATE token_stats SET",
      "              max_mcap_observed = CASE ${mcapCases} ELSE max_mcap_observed END${",
      "                liqCases",
      "                  ? `,",
      "              max_liquidity_observed = CASE ${liqCases} ELSE max_liquidity_observed END`",
      '                  : ""',
      "              }",
      '            WHERE token IN (${tokens.map(() => "?").join(",")})`,',
    ),
  },
  {
    file: "scripts/test-unit.js",
    what: "the all-undefined-liquidity batch",
    marker: "a batch with NO comparable liquidity reading still parses",
    anchor: lines(
      '      const firstZero = stats.get("FIRST_ZERO");',
      "      assert.equal(firstZero.maxMcapObserved, 100000);",
      "      assert.equal(",
      "        firstZero.maxLiquidityObserved,",
      "        0,",
      '        "the first $0 LP reading IS recorded on a NULL row (corpse signal)",',
      "      );",
      "    } finally {",
      "      await t.cleanup();",
      "    }",
      "  });",
    ),
    replacement: lines(
      '      const firstZero = stats.get("FIRST_ZERO");',
      "      assert.equal(firstZero.maxMcapObserved, 100000);",
      "      assert.equal(",
      "        firstZero.maxLiquidityObserved,",
      "        0,",
      '        "the first $0 LP reading IS recorded on a NULL row (corpse signal)",',
      "      );",
      "    } finally {",
      "      await t.cleanup();",
      "    }",
      "  });",
      "",
      '  await test("updateTokenMaxMcaps: a batch with NO comparable liquidity still parses", async () => {',
      "    // The shape above never exercises this: every one of its entries passes",
      "    // `liquidityUsd`. Live 2026-09-24 the OTHER shape is what ran — a tick",
      "    // whose coins all came from a leg whose liquidity metric is not",
      "    // comparable, so the column is omitted for every entry and the liquidity",
      "    // CASE comes out empty. The statement then ended `... max_mcap_observed",
      "    // END,` straight into WHERE (a trailing comma), libsql refused to parse",
      "    // it, and the whole batch's raises were lost — three attempts, then the",
      "    // entry is dropped (this is the queue /health showed as `pending`, whose",
      "    // named cause only became readable once the drain record went durable:",
      "    // `{method: updateTokenMaxMcaps, message: \"...near WHERE...\", pending",
      "    // 11}`).",
      "    const t = tmpDb();",
      "    try {",
      "      const db = new Db(t.p, undefined, t.client);",
      "      await db.init();",
      "      const H = 3600e3;",
      "      const now = 50 * 300e3;",
      "      await t.client.execute({",
      '        sql: "INSERT INTO token_stats (token, first_seen_at, first_m5_vol, first_seen_age_min, launch_ms, max_mcap_observed, max_liquidity_observed) VALUES (\'NOLIQ1\', ?, 0, ?, ?, 5000, 8000)",',
      "        args: [now - 6 * H, now - 6 * H],",
      "      });",
      "      // No `liquidityUsd` KEY at all (not a $0: an absent reading), which is",
      "      // what the scanner sends when the leg's metric is not comparable.",
      '      await db.updateTokenMaxMcaps([{ token: "NOLIQ1", mcapUsd: 90_000 }]);',
      '      const stats = await db.getTokenStatsMany(["NOLIQ1"]);',
      '      const row = stats.get("NOLIQ1");',
      '      assert.equal(row.maxMcapObserved, 90_000, "the mcap raise lands");',
      "      assert.equal(",
      "        row.maxLiquidityObserved,",
      "        8_000,",
      '        "and the unjudgeable liquidity column is left exactly as it was",',
      "      );",
      "    } finally {",
      "      await t.cleanup();",
      "    }",
      "  });",
    ),
  },
];

let failed = false;
for (const patch of PATCHES) {
  const text = fs.readFileSync(patch.file, "utf8");
  if (text.includes(patch.marker)) {
    console.log(`already   ${patch.file}: ${patch.what}`);
    continue;
  }
  const unmet = (patch.needs ?? []).filter((need) => !text.includes(need));
  if (unmet.length > 0) {
    console.error(`NEEDS     ${patch.file}: ${patch.what} — missing ${unmet.join(", ")}`);
    failed = true;
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
  fs.writeFileSync(patch.file, text.replace(patch.anchor, patch.replacement));
  console.log(`ok        ${patch.file}: ${patch.what}`);
}

if (failed) {
  console.error("\nrefusing to leave the tree half-patched — fix the anchors above");
  process.exit(1);
}
console.log("\nall patches applied");
