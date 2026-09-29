/*
 * The /debug/db-latency route, second pass (2026-09-29): report the probe's
 * counter check (see dblatency.changesVerdict) next to the latencies.
 *
 *   node docs/patches/db-latency-2026-09-29.worker-verify.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "src", "worker.ts");
let src = fs.readFileSync(file, "utf8");

if (src.includes("changesVerdict")) {
  console.log("already applied — src/worker.ts untouched");
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

swap(
  "imports",
  `import {
  claimShapeSavingMs,
  clampLatencySamples,
  dbRegionFromUrl,
  summarizeLatencyOps,
} from "./dblatency";`,
  `import {
  changesVerdict,
  claimShapeSavingMs,
  clampLatencySamples,
  dbRegionFromUrl,
  summarizeLatencyOps,
  DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE,
} from "./dblatency";`,
);

swap(
  "route body",
  `        dbLatencyLastRunAt = Date.now();
        const samples = clampLatencySamples(url.searchParams.get("samples"));
        const rawMs = await db.measureLatency(samples);
        const ops = summarizeLatencyOps(rawMs);
        return Response.json({
          ok: true,
          at: new Date().toISOString(),
          colo:
            (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? null,
          dbRegion: dbRegionFromUrl(env.TURSO_DATABASE_URL),
          samples,
          ops,
          claimShapeSavingMs: claimShapeSavingMs(ops),
          rawMs,
        });`,
  `        dbLatencyLastRunAt = Date.now();
        const requested = clampLatencySamples(url.searchParams.get("samples"));
        const measured = await db.measureLatency(requested);
        const ops = summarizeLatencyOps(measured.raw);
        return Response.json({
          ok: true,
          at: new Date().toISOString(),
          colo:
            (request as unknown as { cf?: { colo?: string } }).cf?.colo ?? null,
          dbRegion: dbRegionFromUrl(env.TURSO_DATABASE_URL),
          samples: measured.samples,
          ops,
          claimShapeSavingMs: claimShapeSavingMs(ops),
          // The arithmetic check. Each sample must move the probe counter by
          // DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE, which only happens if the
          // statement after an INSERT inside a batch sees THAT insert's
          // changes() — the basis of the batched claim (Db.claimTokenPush).
          // \\"verified\\" is the live proof that batching the counter is safe;
          // \\"mismatch\\" is the reading that says it is not.
          changes: {
            before: measured.counterBefore,
            after: measured.counterAfter,
            expectedDelta:
              measured.samples * DB_LATENCY_EXPECTED_COUNTER_PER_SAMPLE,
            verdict: changesVerdict(
              measured.counterBefore,
              measured.counterAfter,
              measured.samples,
            ),
          },
          rawMs: measured.raw,
        });`,
);

fs.writeFileSync(file, src);
console.log("wrote src/worker.ts");
