#!/usr/bin/env node
/**
 * Deferred-prune probe note (2026-09-26): document the one reading of
 * `/debug/deferral` that could be misread.
 *
 * The probe returns two halves, and a COLD isolate answers them asymmetrically
 * on purpose: `durable` is re-read from Turso, so it is the fleet's live row
 * whatever isolate served the request, while `isolate` is that isolate's own
 * registry — empty (and `windowMaxAgeMin: null`) until its first tick seeds it
 * from that row. Without the sentence, `pending: []` beside a non-empty
 * durable list reads like a bug instead of "this isolate has not ticked yet".
 *
 * src/worker.ts is far past the file tool's edit window, so this is a
 * verify-then-write patch.
 *
 * Run: node docs/patches/deferred-prune-probe-note-2026-09-26.apply.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const lines = (...xs) => xs.join("\n");
const hits = (src, needle) => src.split(needle).length - 1;

const OLD = lines(
  `    //  - \`isolate\`: THIS isolate's registry — how long each owed coin has`,
  `    //    been owed, its consecutive no-pair misses, the window the last`,
  `    //    observation judged against, and the recent retirements with the`,
  `    //    reason and the age each was judged at.`,
);

const NEW = lines(
  `    //  - \`isolate\`: THIS isolate's registry — how long each owed coin has`,
  `    //    been owed, its consecutive no-pair misses, the window the last`,
  `    //    observation judged against, and the recent retirements with the`,
  `    //    reason and the age each was judged at. Asymmetry, on purpose: a COLD`,
  `    //    isolate has not ticked yet, so it hydrates nothing and this half`,
  `    //    reads empty (windowMaxAgeMin: null) while \`durable\` is already the`,
  `    //    fleet's live row — "this isolate has not seeded yet", never "nothing`,
  `    //    is owed".`,
);

const src = read("src/worker.ts");
if (src.includes("Asymmetry, on purpose: a COLD")) {
  console.log("skip src/worker.ts: the cold-isolate note (already applied)");
  process.exit(0);
}
const n = hits(src, OLD);
if (n !== 1) {
  console.error(`src/worker.ts: anchor matched ${n} times (want exactly 1) — NO file was written.`);
  process.exit(1);
}
const next = src.replace(OLD, NEW);
fs.writeFileSync(path.join(root, "src/worker.ts"), next);
console.log(`wrote src/worker.ts (${next.length} bytes)`);
