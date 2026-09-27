// Verify-then-write: the seam fake models the REAL Db handle, so at least one
// of its methods must touch `this` — live 2026-09-27 the drain called an
// unbound method and `this.get` threw, which no `this`-free fake could see.
const fs = require("fs");

const FILE = "scripts/test-tick-path.js";
let src = fs.readFileSync(FILE, "utf8");
let patched = 0;

function patch(label, from, to) {
  if (src.includes(to)) {
    console.log(`= ${label}: already applied`);
    return true;
  }
  if (!src.includes(from)) {
    console.log(`✗ ${label}: anchor NOT found`);
    process.exitCode = 1;
    return false;
  }
  src = src.replace(from, to);
  patched += 1;
  console.log(`✓ ${label}: patched`);
  return true;
}

patch(
  "the seam fake pins its receiver",
  `    async recordTokenStatsMany(rows) {
      wire.push("register");
      clock += 200;
      return undefined;
    },`,
  `    async recordTokenStatsMany(rows) {
      // \`this\` ON PURPOSE: the real Db methods are called off their handle
      // (\`this.get\`/\`this.execute\`), and the drain invokes this LATER with no
      // call-site receiver — live 2026-09-27 that threw \`TypeError: this.get is
      // not a function\` on every drained call while this fake passed.
      assert.equal(this, seamDb, "the drain calls a method on its own handle");
      wire.push("register");
      clock += 200;
      return undefined;
    },`,
);

if (patched > 0) {
  fs.writeFileSync(FILE, src);
  console.log(`wrote ${FILE}`);
}
