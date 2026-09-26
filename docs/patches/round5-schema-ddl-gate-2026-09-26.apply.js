#!/usr/bin/env node
/**
 * Round 5 (2026-09-26): the schema DDL batch goes behind a fingerprint gate, so
 * a cold isolate stops paying it on every recycle.
 *
 * WHY: scripts/cpu-profile.js measured, against this Worker's own database, that
 * the init DDL batch costs 46-189ms of CPU on the client while a single-row read
 * costs 2.4-5.8ms — the largest single CPU item in a tick. Cloudflare's own
 * analytics names the limit that has been killing these ticks: the invocation
 * outcome is `exceededResources` with cpuTime pinned at exactly 10,000us, the
 * Workers Free ceiling, while the same minutes' surviving invocations report
 * 13,000-187,000us. An isolate recycles, so the next one pays the DDL again for
 * a schema that has not changed in days.
 *
 * The gate reads ONE small row (worker_state.schema_ddl_fingerprint, ~46 bytes)
 * and runs the batch only when that row does not already describe exactly these
 * statements. The fingerprint is derived from the `ddl` array ITSELF (FNV-1a,
 * see schemaFingerprint in src/db.ts), so a statement added or edited busts the
 * gate automatically — the failure a hand-kept version number would eventually
 * produce (DDL skipped, table missing) is not reachable. Any read failure is
 * also a mismatch, which is exactly when the DDL should run.
 *
 * IN-WINDOW PARTS ALREADY APPLIED (not repeated here): the `schemaFingerprint`
 * helper and SCHEMA_DDL_FINGERPRINT_KEY above `export class Db`, and the
 * `const ddl: string[] = [` hoist that turned the batch's array into a named
 * value. This script is the one edit past the file tools' window: the other
 * side of that array, where the gate itself lives.
 *
 * Run: node docs/patches/round5-schema-ddl-gate-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

/** [file, label, old, new, alreadyApplied] */
const EDITS = [
  [
    "src/db.ts",
    "Db.init: the DDL batch runs only when the stored fingerprint is different",
    lines(
      '        `CREATE INDEX IF NOT EXISTS idx_pushed_holders_at ON pushed_holders(pushed_at);`,',
      "      ],",
      '      "write",',
      "    );",
    ),
    lines(
      '        `CREATE INDEX IF NOT EXISTS idx_pushed_holders_at ON pushed_holders(pushed_at);`,',
      "    ];",
      "",
      "    // See the fingerprint gate comment above `ddl`. ONE small read decides",
      "    // whether the batch runs at all: the row is a single short string (~46",
      "    // bytes on the wire), against ~8KB of statements and their results.",
      "    const ddlFingerprint = schemaFingerprint(ddl);",
      "    let storedFingerprint: string | null = null;",
      "    try {",
      "      const known = await c.batch(",
      "        [",
      "          {",
      '            sql: "SELECT value FROM worker_state WHERE key = ?",',
      "            args: [SCHEMA_DDL_FINGERPRINT_KEY],",
      "          },",
      "        ],",
      '        "read",',
      "      );",
      "      storedFingerprint =",
      "        known[0]?.rows.length > 0 ? String(known[0].rows[0].value) : null;",
      "    } catch {",
      "      // Every `worker_state` failure mode — table absent (a database that",
      "      // has never been initialized), refused read, timeout — means an",
      "      // UNKNOWN schema, which is exactly when the DDL should run. Swallowing",
      "      // it here is required, not optional: a gate that could throw would",
      "      // turn a cheap optimisation into a way for init to fail on the one",
      "      // database it has never seen.",
      "      storedFingerprint = null;",
      "    }",
      "    if (storedFingerprint !== ddlFingerprint) {",
      '      await c.batch(ddl, "write");',
      "      // Stamped AFTER the batch, so the marker can never claim a schema the",
      "      // database does not have. Best-effort: a refused write only means the",
      "      // next cold isolate pays the DDL again, which is the pre-gate shape.",
      "      try {",
      "        await c.batch(",
      "          [",
      "            {",
      '              sql: "INSERT OR REPLACE INTO worker_state (key, value) VALUES (?, ?)",',
      "              args: [SCHEMA_DDL_FINGERPRINT_KEY, ddlFingerprint],",
      "            },",
      "          ],",
      '          "write",',
      "        );",
      "      } catch {",
      "        /* telemetry-grade: the gate must never be able to fail init */",
      "      }",
      "    }",
    ),
    (src) => src.includes("schemaFingerprint(ddl)"),
  ],
];

const problems = [];
const out = new Map();
for (const [file, label, oldText, newText, already] of EDITS) {
  const src = out.has(file) ? out.get(file) : read(file);
  if (already(src)) {
    console.log(`skip ${file}: ${label} (already applied)`);
    continue;
  }
  const n = hits(src, oldText);
  if (n !== 1) {
    problems.push(`${file}: ${label} — anchor matched ${n} times (want exactly 1)`);
    continue;
  }
  out.set(file, src.replace(oldText, newText));
  console.log(`ok   ${file}: ${label}`);
}
if (problems.length > 0) {
  console.error(`\n${problems.length} anchor(s) failed — NO file was written.`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
for (const [file, text] of out) {
  fs.writeFileSync(path.join(root, file), text);
  console.log(`wrote ${file} (${text.length} bytes)`);
}
console.log("\nall anchors applied.");
