#!/usr/bin/env node
/**
 * Round 5b (2026-09-26): the schema column probes become ONE batched read per
 * cold isolate instead of one round trip per column.
 *
 * WHY: the DDL batch is now behind a fingerprint (round5-schema-ddl-gate), so
 * the leftover per-column cost is what the new suite exposed —
 * scripts/test-schema-gate.js counted 12 `execute` calls on a SECOND init over
 * an already-migrated database, i.e. round trips that exist purely to be told
 * "duplicate column name". addColumnIfMissing asks one column at a time, by
 * attempting an ALTER, and that was 26 authored call sites (15 token_stats, 7
 * chat_settings, 4 push_watch). scripts/cpu-profile.js measured a libsql round
 * trip at 2.4-5.8ms of CLIENT CPU even for a 46-byte, one-row reply — the
 * encode/decode, not the network — so the probes are ~30-70ms on every isolate
 * that recycles: the largest item left in a tick once the DDL was gated.
 * Cloudflare has been killing these invocations with `exceededResources` and
 * cpuTime pinned at exactly 10,000us, the Workers Free CPU ceiling.
 *
 * WHAT: one batched `SELECT name FROM pragma_table_info(?)` per table
 * (COLUMN_PROBE_TABLES), answered from an isolate-scoped Set afterwards, so
 * the following 25 calls are free. Verified against a real libsql client:
 * bound arguments work in the table-valued pragma, and a table that does not
 * exist returns ZERO ROWS rather than throwing — which is the behaviour this
 * relies on for a table the DDL has not created yet.
 *
 * SAFETY: the default answer is the OLD one. A column the read did not report
 * is still ALTERed (duplicates still swallowed), a call naming a table that is
 * not in COLUMN_PROBE_TABLES simply misses the cache, and an unreadable batch
 * degrades to exactly one ALTER per column, as before. Nothing about the
 * migration's outcome changes; only how many round trips ask for it.
 *
 * Run: node docs/patches/round5-column-probe-merge-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new] */
const EDITS = [
  [
    "src/db.ts",
    "the tables whose columns are probed, named once for the batched read",
    lines(
      'export const SCHEMA_DDL_FINGERPRINT_KEY = "schema_ddl_fingerprint";',
    ),
    lines(
      'export const SCHEMA_DDL_FINGERPRINT_KEY = "schema_ddl_fingerprint";',
      "",
      "/**",
      " * Every table addColumnIfMissing is called for (checked 2026-09-26:",
      " * token_stats 15 call sites, chat_settings 7, push_watch 4). Listed here",
      " * because the batched probe below has to ask for their columns UP FRONT",
      " * — a table missing from this list is not broken, it just keeps paying",
      " * the old one-round-trip-per-column path.",
      " */",
      'export const COLUMN_PROBE_TABLES = ["chat_settings", "token_stats", "push_watch"] as const;',
      "",
      "/**",
      ' * Cache key for one column: `table\\0column`. The separator is a NUL',
      " * rather than a dot so a table name containing a dot could never be",
      " * confused with a column of another table.",
      " */",
      "function columnKey(table: string, column: string): string {",
      '  return `${table}\\u0000${column}`;',
      "}",
    ),
  ],
  [
    "src/db.ts",
    "addColumnIfMissing: answer from the batched cache instead of one ALTER per call",
    lines(
      "  private async addColumnIfMissing(",
      "    table: string,",
      "    column: string,",
      "    definition: string,",
      "  ): Promise<void> {",
      "    try {",
      "      await this.get().execute({",
      "        sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,",
      "        args: [],",
      "      });",
      '      console.log(`[db] added column ${table}.${column}`);',
      "    } catch (err) {",
      '      // SQLite throws "duplicate column name" when it already exists — fine.',
      "      const msg = err instanceof Error ? err.message : String(err);",
      "      if (!/duplicate column/i.test(msg)) {",
      '        console.warn(`[db] migrate ${table}.${column} skipped:`, msg);',
      "      }",
      "    }",
      "  }",
    ),
    lines(
      "  /**",
      "   * Columns this isolate has already confirmed exist, keyed",
      "   * `table\\0column` (see columnKey). Null until the first probe.",
      "   */",
      "  private columnCache: Set<string> | null = null;",
      "",
      "  /**",
      "   * Whether `table.column` exists — WITHOUT a round trip of its own once",
      "   * the cache is primed.",
      "   *",
      "   * WHY THIS EXISTS (2026-09-26, CPU). addColumnIfMissing used to ask the",
      "   * database one column at a time, by attempting an ALTER and reading",
      "   * SQLite's \"duplicate column name\" as a negative answer: one round trip",
      "   * PER COLUMN on every cold isolate — 26 call sites, 12 reached on this",
      "   * schema. scripts/cpu-profile.js measured a libsql round trip at 2.4-5.8ms",
      "   * of CLIENT CPU even for a 46-byte, one-row reply (the encode/decode, not",
      "   * the network), so the probes alone were ~30-70ms: the largest item left",
      "   * in a tick once the DDL batch went behind a fingerprint. Cloudflare kills",
      "   * these invocations with `exceededResources` at exactly 10,000us, the",
      "   * Workers Free CPU ceiling, while the same minutes' surviving invocations",
      "   * report 13,000-187,000us. The answer is to ask ONCE: one batched read of",
      "   * pragma_table_info for every table this migration touches, then answer",
      "   * every following call from memory.",
      "   */",
      "  private async columnExists(table: string, column: string): Promise<boolean> {",
      "    if (this.columnCache === null) this.columnCache = await this.readColumnNames();",
      "    return this.columnCache.has(columnKey(table, column));",
      "  }",
      "",
      "  /**",
      "   * Every column of COLUMN_PROBE_TABLES, in ONE round trip.",
      "   *",
      "   * Best-effort by design: on an unreadable batch it returns an empty set,",
      "   * which makes every following columnExists() false and so reproduces the",
      "   * pre-2026-09-26 behaviour exactly — one ALTER per call, duplicates",
      "   * swallowed — instead of skipping a migration that might be needed. A",
      "   * table the DDL has not created yet returns zero rows (verified against",
      "   * libsql; it does not throw), which is the same answer as an empty table.",
      "   */",
      "  private async readColumnNames(): Promise<Set<string>> {",
      "    const found = new Set<string>();",
      "    try {",
      "      const res = await this.get().batch(",
      "        COLUMN_PROBE_TABLES.map((table) => ({",
      '          sql: "SELECT name FROM pragma_table_info(?)",',
      "          args: [table],",
      "        })),",
      '        "read",',
      "      );",
      "      COLUMN_PROBE_TABLES.forEach((table, i) => {",
      "        for (const row of res?.[i]?.rows ?? []) {",
      '          found.add(columnKey(table, String(row.name ?? "")));',
      "        }",
      "      });",
      "    } catch (err) {",
      "      console.warn(",
      '        "[db] column probe unavailable, falling back to one ALTER per column:",',
      "        err instanceof Error ? err.message : String(err),",
      "      );",
      "    }",
      "    return found;",
      "  }",
      "",
      "  private async addColumnIfMissing(",
      "    table: string,",
      "    column: string,",
      "    definition: string,",
      "  ): Promise<void> {",
      "    if (await this.columnExists(table, column)) return;",
      "    try {",
      "      await this.get().execute({",
      "        sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,",
      "        args: [],",
      "      });",
      "      // Keep the cache honest for the rest of this isolate's init: without",
      "      // this, a second call for the same column in the same init would pay",
      "      // an ALTER that must fail — the exact cost this cache exists to avoid.",
      "      this.columnCache?.add(columnKey(table, column));",
      '      console.log(`[db] added column ${table}.${column}`);',
      "    } catch (err) {",
      '      // SQLite throws "duplicate column name" when it already exists — fine.',
      "      const msg = err instanceof Error ? err.message : String(err);",
      "      if (!/duplicate column/i.test(msg)) {",
      '        console.warn(`[db] migrate ${table}.${column} skipped:`, msg);',
      "      }",
      "    }",
      "  }",
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

  // Post-conditions: the gate must not ship half-applied. Every one of these
  // has to be present in the RESULT, not in the input.
  const out = files.get("src/db.ts");
  // Presence, not count: these names appear in their own doc comments too, and
  // a post-condition that counts prose would fail on a comment that mentions
  // itself (it did, first run: COLUMN_PROBE_TABLES matched 4x).
  for (const needle of [
    "COLUMN_PROBE_TABLES",
    "private columnCache: Set<string> | null = null;",
    "private async columnExists(",
    "private async readColumnNames(",
    "if (await this.columnExists(table, column)) return;",
    "SELECT name FROM pragma_table_info(?)",
    "this.columnCache?.add(columnKey(table, column));",
  ]) {
    if (hits(out, needle) < 1) {
      problems.push(`post-condition failed: ${JSON.stringify(needle)} is missing`);
    }
  }
  if (hits(out, "export const COLUMN_PROBE_TABLES = [") !== 1) {
    problems.push("the table list must be declared exactly once");
  }
  // The cache must be consulted BEFORE the ALTER, or the whole change is a
  // no-op that still pays every round trip.
  if (
    !/private async addColumnIfMissing\([\s\S]{0,200}if \(await this\.columnExists\(table, column\)\) return;/.test(out)
  ) {
    problems.push("addColumnIfMissing must consult the cache before the ALTER");
  }
  // The old shape must be GONE, or this script silently did nothing useful.
  if (hits(out, "      await this.get().execute({\n        sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,") !== 1) {
    problems.push("the ALTER inside addColumnIfMissing should now be the single remaining one");
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
