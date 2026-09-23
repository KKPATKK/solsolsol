#!/usr/bin/env node
/**
 * Compile/behaviour fix for docs/patches/holder-probe-cu-budget.apply.js: the
 * durable CU stamp was written inside the holder stage's trip window, so the
 * note read `holders 1/2` — the stage's own `trips` is meant to count the
 * WRITES the probes produced (one batch), not the budget bookkeeping that made
 * them possible. The stamp moves to just after the row loop's accounting: still
 * after the rotation (so a probe never delays it), still before the stage (so
 * the stage's trip count keeps its meaning), and still landing for a miss.
 *
 * Same discipline: exactly one match or nothing is written.
 */
const fs = require("fs");

const PW = "src/pushwatch.ts";

const stampBlock =
  "    // The CU stamp lands HERE, after the row loop, so a probe never delays the\n" +
  "    // rotation with its bookkeeping — and it lands for a MISS too (a miss is a\n" +
  "    // billed Birdeye call, and nothing else records it for the next isolate).\n" +
  "    // One round trip per pass that probed, bounded by the budget it\n" +
  "    // implements; a failure costs this isolate's memory of the stamp, not the\n" +
  "    // probe's count.\n" +
  "    if (holderStampPending) {\n" +
  "      try {\n" +
  "        trips += 1;\n" +
  "        await this.db.setWorkerState(HOLDER_PROBE_STAMP_KEY, String(now));\n" +
  "      } catch {\n" +
  "        /* telemetry-grade: the in-memory stamp still covers this isolate */\n" +
  "      }\n" +
  "    }\n";

const anchor =
  "    spent.rows.ms = Date.now() - rowsStart;\n" +
  "    spent.rows.trips = trips - rowsTrips;\n";

const moved =
  anchor +
  "\n" +
  "    // The holder probe's CU stamp lands HERE: after the row loop, so a probe\n" +
  "    // never delays the rotation with its bookkeeping, and BEFORE the holder\n" +
  "    // stage, so that stage's own `holders <ms>/<trips>` keeps counting the\n" +
  "    // writes its probes produced. It lands for a MISS too (a miss is a billed\n" +
  "    // Birdeye call, and nothing else records it for the next isolate): one\n" +
  "    // round trip per pass that probed, bounded by the budget it implements,\n" +
  "    // and a failure costs this isolate's memory of the stamp, never a count.\n" +
  "    if (holderStampPending) {\n" +
  "      try {\n" +
  "        trips += 1;\n" +
  "        await this.db.setWorkerState(HOLDER_PROBE_STAMP_KEY, String(now));\n" +
  "      } catch {\n" +
  "        /* telemetry-grade: the in-memory stamp still covers this isolate */\n" +
  "      }\n" +
  "    }\n";

let text = fs.readFileSync(PW, "utf8");

// 1. Remove the block from the holder stage.
const at = text.indexOf(stampBlock);
if (at < 0) {
  console.error("MISS      pw: the stamp block inside the holder stage");
  process.exit(1);
}
if (text.indexOf(stampBlock, at + 1) >= 0) {
  console.error("AMBIGUOUS pw: the stamp block inside the holder stage");
  process.exit(1);
}
text = text.slice(0, at) + text.slice(at + stampBlock.length);

// 2. Re-anchor it after the row loop's accounting.
const anchorAt = text.indexOf(anchor);
if (anchorAt < 0) {
  console.error("MISS      pw: the row-loop accounting anchor");
  process.exit(1);
}
if (text.indexOf(anchor, anchorAt + 1) >= 0) {
  console.error("AMBIGUOUS pw: the row-loop accounting anchor");
  process.exit(1);
}
text = text.slice(0, anchorAt) + moved + text.slice(anchorAt + anchor.length);

fs.writeFileSync(PW, text);
console.log("ok        pw: the CU stamp lands between the row loop and the holder stage");
