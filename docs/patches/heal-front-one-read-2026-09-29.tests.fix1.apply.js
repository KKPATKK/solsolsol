/*
 * fix1 for docs/patches/heal-front-one-read-2026-09-29.tests.apply.js.
 *
 * The counting Db handle is a FRESH Db over an existing database: like every
 * other recycled-isolate handle in this repo it has to pay its own init before
 * any other method can use the client ("Database is not initialized" from
 * Db.get()). Its boot read is counted, then the counter is zeroed so the test's
 * "ONE request" assertion is about the read under test and not about init.
 *
 * Idempotent.
 *
 *   node docs/patches/heal-front-one-read-2026-09-29.tests.fix1.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(file, "utf8");

if (src.includes("init();\n    // Zeroed AFTER init")) {
  console.log("already applied — scripts/test-unit.js untouched");
  process.exit(0);
}

const anchor = `    const counting = new Db("file:injected", undefined, {
      execute: (a) => t.client.execute(a),
      batch: (a, m) => {
        batches += 1;
        return t.client.batch(a, m);
      },
      close: () => t.client.close(),
    });
`;

const replacement = `    const counting = new Db("file:injected", undefined, {
      execute: (a) => t.client.execute(a),
      batch: (a, m) => {
        batches += 1;
        return t.client.batch(a, m);
      },
      close: () => t.client.close(),
    });
    // A recycled isolate's handle: it has to init like any other, or Db.get()
    // answers "Database is not initialized". Billed to the counter above and
    // then zeroed, so the assertion below is about the read under test.
    await counting.init();
    batches = 0;
`;

const parts = src.split(anchor);
if (parts.length !== 2) {
  console.error(`ANCHOR MISS (${parts.length - 1} matches)`);
  process.exit(1);
}
fs.writeFileSync(file, parts.join(replacement));
console.log("ok: counting.init()");
