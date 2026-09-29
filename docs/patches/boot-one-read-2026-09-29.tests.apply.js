/*
 * Tests for docs/patches/boot-one-read-2026-09-29.apply.js (P0-3).
 *
 * scripts/test-schema-gate.js pinned the old shape explicitly — "THREE batches,
 * and that is the whole cost of a recycled isolate" — so it has to move with the
 * change, and it is the right place to pin the new one: a recycled isolate's
 * init is ONE request carrying four question families, and ZERO single-statement
 * reads (the telemetry-seed marker used to be one).
 *
 * Idempotent.
 *
 *   node docs/patches/boot-one-read-2026-09-29.tests.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "scripts", "test-schema-gate.js");
let src = fs.readFileSync(file, "utf8");

if (src.includes("the boot read carries the marker")) {
  console.log("already applied — scripts/test-schema-gate.js untouched");
  process.exit(0);
}

function swap(label, old, neu) {
  const parts = src.split(old);
  if (parts.length !== 2) {
    console.error(`ANCHOR MISS (${parts.length - 1} matches): ${label}`);
    process.exit(1);
  }
  src = parts.join(neu);
  console.log(`ok: ${label}`);
}

// ---- 1. the imports the new assertions need -----------------------------
swap(
  "imports",
  `const { Db, schemaFingerprint, SCHEMA_DDL_FINGERPRINT_KEY } = require("../dist/db.js");`,
  `const {
  Db,
  COLUMN_PROBE_TABLES,
  MIGRATION_FLAG_KEYS,
  SCHEMA_DDL_FINGERPRINT_KEY,
  TELEMETRY_SEED_MARKER_KEY,
  schemaFingerprint,
} = require("../dist/db.js");`,
);

// ---- 2. the counting client also records BATCH statement text -----------
swap(
  "countingClient: record batch text",
  `function countingClient(client) {
  const seen = { batches: 0, statements: 0, executes: 0, maxBatchSize: 0, sql: [] };
  return {
    seen,
    execute: (a) => {
      seen.executes++;
      // Keep the statement text: when this count is not what the test expects,
      // the ONLY useful question is which statement was paid for, and guessing
      // it from the source is how a wrong answer gets baked into a comment.
      seen.sql.push(String(a.sql).replace(/\\s+/g, " ").slice(0, 90));
      return client.execute(a);
    },
    batch: (a, m) => {
      seen.batches++;
      seen.statements += a.length;
      seen.maxBatchSize = Math.max(seen.maxBatchSize, a.length);
      return client.batch(a, m);
    },
    close: () => client.close(),
  };
}`,
  `function countingClient(client) {
  const seen = { batches: 0, statements: 0, executes: 0, maxBatchSize: 0, sql: [], batchSql: [] };
  return {
    seen,
    execute: (a) => {
      seen.executes++;
      // Keep the statement text: when this count is not what the test expects,
      // the ONLY useful question is which statement was paid for, and guessing
      // it from the source is how a wrong answer gets baked into a comment.
      seen.sql.push(String(a.sql).replace(/\\s+/g, " ").slice(0, 90));
      return client.execute(a);
    },
    batch: (a, m) => {
      seen.batches++;
      seen.statements += a.length;
      seen.maxBatchSize = Math.max(seen.maxBatchSize, a.length);
      // Same reason, one level down: a batch's SQL alone cannot say WHICH row it
      // asked for when the key rides in args (the boot read parameterises the
      // marker, the flags and the seed row), so the args go in too.
      seen.batchSql.push(
        a
          .map(
            (s) =>
              \`\${String(s.sql).replace(/\\s+/g, " ")} [\${JSON.stringify(s.args ?? [])}]\`,
          )
          .join(" | "),
      );
      return client.batch(a, m);
    },
    close: () => client.close(),
  };
}`,
);

// ---- 3. the three-batch assertion becomes the one-batch assertion -------
swap(
  "second init: ONE batch",
  `    // THREE batches, and that is the whole cost of a recycled isolate: the
    // DDL fingerprint, the flag reads, and ONE batched column probe. The probe
    // is a batch rather than N executes on purpose — see the round5b note on
    // addColumnIfMissing: it used to be one ALTER per column (~12 reached of
    // 26 call sites), each a full round trip at the 2.4-5.8ms of client CPU
    // scripts/cpu-profile.js measured.
    assert.equal(
      second.seen.maxBatchSize < 10 && second.seen.batches === 3,
      true,
      \`the second init must be the marker read, the flags read and the ONE \` +
        \`column probe, got \${second.seen.batches} batch(es), largest \` +
        \`\${second.seen.maxBatchSize}\`,
    );`,
  `    // ONE batch, and that is the whole cost of a recycled isolate since
    // 2026-09-29: the DDL marker, the nine migration flags, the column probe for
    // COLUMN_PROBE_TABLES and the telemetry-seed marker, all riding ONE request
    // (see Db.init's boot read). It used to be THREE batches plus the seed
    // marker's own \`getWorkerState\` — four Turso round trips on EVERY fresh
    // isolate, which live /health measured as the ~1.0s \`init\` a cron tick's
    // front split is made of (\`preStart 1006 init 1008\`). The probe is a batch
    // rather than N executes on purpose — see the round5b note on
    // addColumnIfMissing: it used to be one ALTER per column (~12 reached of 26
    // call sites), each a full round trip at the 2.4-5.8ms of client CPU
    // scripts/cpu-profile.js measured.
    assert.equal(
      second.seen.batches,
      1,
      \`the second init must be ONE batch, got \${second.seen.batches}: \` +
        second.seen.batchSql.join(" | "),
    );`,
);

// ---- 4. the executes ceiling becomes an equality ------------------------
swap(
  "second init: zero standalone reads",
  `    // And the remaining single-statement traffic stays bounded: at this commit
    // it is exactly one read, the telemetry-seed marker in init
    // (\`SELECT value FROM worker_state WHERE key = ?\`), which is a real question
    // rather than a probe. A ceiling rather than an equality, so adding an
    // unrelated one-key read does not fail the suite that guards THIS change.
    assert.ok(
      second.seen.executes <= 2,
      \`the second init should be batches plus at most a couple of real reads, \` +
        \`got \${second.seen.executes}: \${second.seen.sql.join(" | ")}\`,
    );`,
  `    // And there is NO single-statement traffic left at all: the telemetry-seed
    // marker — the last of the four reads pre-2026-09-29 init paid separately —
    // now rides the boot batch too. An equality rather than a ceiling, because
    // "a recycled isolate costs exactly ONE request" is the whole claim this
    // suite guards; a standalone read appearing here is the regression.
    assert.equal(
      second.seen.executes,
      0,
      \`a recycled isolate's init must pay no standalone read, got \` +
        \`\${second.seen.executes}: \${second.seen.sql.join(" | ")}\`,
    );`,
);

// ---- 5. the new suite: what the ONE batch actually carries --------------
swap(
  "new test: what the boot read carries",
  `    const marker = await db.getWorkerState(SCHEMA_DDL_FINGERPRINT_KEY);
    assert.match(
      String(marker),
      /^[0-9a-f]{8}$/,
      "init must leave the fingerprint behind for the next isolate",
    );
    await t.cleanup();
  });`,
  `    const marker = await db.getWorkerState(SCHEMA_DDL_FINGERPRINT_KEY);
    assert.match(
      String(marker),
      /^[0-9a-f]{8}$/,
      "init must leave the fingerprint behind for the next isolate",
    );
    await t.cleanup();
  });

  await test("init: the boot read carries the marker, every flag, the probe and the seed row", async () => {
    // The batched read is only worth having if it carries EVERYTHING the boot
    // block used to ask for one at a time — a family left out of it silently
    // buys back the round trip the merge exists to remove. This pins the
    // membership, not just the count: the flag keys and the probed tables ride
    // in ARGS (see countingClient's batchSql), so a statement that asked for the
    // wrong row would still pass a count-only assertion.
    const t = tmpDb();
    const first = new Db("file:injected", undefined, t.client);
    await first.init();

    const counting = countingClient(t.client);
    const again = new Db("file:injected", undefined, counting);
    await again.init();

    assert.equal(
      counting.seen.batches,
      1,
      \`a recycled isolate's init must be ONE batch, got \${counting.seen.batches}\`,
    );
    assert.equal(
      counting.seen.statements,
      1 + MIGRATION_FLAG_KEYS.length + COLUMN_PROBE_TABLES.length + 1,
      \`the boot batch is the marker, every flag, one probe per table and the \` +
        \`seed row, and nothing else: \${counting.seen.statements}\`,
    );
    const all = counting.seen.batchSql.join(" \\u0001 ");
    assert.ok(
      all.includes(SCHEMA_DDL_FINGERPRINT_KEY),
      \`the gate's own marker must ride it: \${all}\`,
    );
    assert.ok(
      all.includes(TELEMETRY_SEED_MARKER_KEY),
      \`and the telemetry-seed row, which was the fourth read: \${all}\`,
    );
    for (const key of MIGRATION_FLAG_KEYS) {
      assert.ok(all.includes(key), \`every migration flag, missing \${key}: \${all}\`);
    }
    for (const table of COLUMN_PROBE_TABLES) {
      assert.ok(
        all.includes(table),
        \`and the column probe for \${table}, without which addColumnIfMissing \` +
          \`pays a round trip per column again: \${all}\`,
      );
    }
    // The DDL itself must NOT be in this batch: it is the batch the fingerprint
    // gate exists to skip, and a recycle that ran it would defeat the whole
    // marker (the fingerprint assertion above is the other half of this).
    assert.ok(
      !/CREATE TABLE|CREATE INDEX/i.test(all),
      \`a recycled isolate must not run DDL at all: \${all}\`,
    );
    await t.cleanup();
  });`,
);

fs.writeFileSync(file, src);
console.log("scripts/test-schema-gate.js written");
