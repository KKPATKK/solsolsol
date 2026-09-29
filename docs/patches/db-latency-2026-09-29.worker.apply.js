/*
 * B4 (2026-09-29): the /debug/db-latency route in src/worker.ts.
 *
 * Anchored + idempotent, same reason as the db.ts patch: src/worker.ts is
 * synced through the Vly Daytona path, which has silently failed to match an
 * exact editor anchor here before. Two edits, both refusing on a mismatch:
 *
 *   1. import the src/dblatency.ts helpers,
 *   2. add the cooldown state and the route (registered next to the other
 *      read-only /debug probes).
 *
 *   node docs/patches/db-latency-2026-09-29.worker.apply.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "src", "worker.ts");
let src = fs.readFileSync(file, "utf8");

if (src.includes("/debug/db-latency")) {
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

// ---- 1. imports --------------------------------------------------------
swap(
  "dblatency import",
  `  type SkipDelta,
} from "./skipcapture";`,
  `  type SkipDelta,
} from "./skipcapture";
// Turso round-trip probe (see /debug/db-latency and src/dblatency.ts): the
// pure helpers live in that module so this route stays a thin reader of one
// measurement.
import {
  claimShapeSavingMs,
  clampLatencySamples,
  dbRegionFromUrl,
  summarizeLatencyOps,
} from "./dblatency";`,
);

// ---- 2. cooldown state -------------------------------------------------
swap(
  "cooldown state",
  `let tickDebugLastRunAt = 0;`,
  `let tickDebugLastRunAt = 0;
/**
 * Cooldown for /debug/db-latency (see the route). Each call spends six round
 * trips per sample against the SAME database the tick is pushing through, so
 * a poll loop must not be able to add load to the push path — while a human
 * iterating on the numbers should never notice the wait.
 */
const DB_LATENCY_COOLDOWN_MS = 15_000;
let dbLatencyLastRunAt = 0;`,
);

// ---- 3. the route ------------------------------------------------------
swap(
  "/debug/db-latency route",
  `    // from a steady drip was this READ, which had no reader.
    if (url.pathname === "/debug/dex429") {`,
  `    // from a steady drip was this READ, which had no reader.
    if (url.pathname === "/debug/db-latency") {
      // Turso round-trip probe (2026-09-29). The push path gives its claim a
      // 400ms slice (scanner.CARD_CLAIM_BUDGET_MS) against a database this
      // Worker does not run next to, and until the batching shipped with this
      // route the claim was TWO sequential requests. This endpoint is the
      // measurement behind that argument, taken from the isolate answering
      // it, because nowhere else shares this isolate's path to the database:
      //
      //   select1             pure round trip — the distance/handshake number.
      //   readRow             the tick's front-read shape (one row by key).
      //   writeUpsert         the fleet-wide writer's cost, isolated.
      //   claimShapeTwoTrip   the claim's OLD shape: INSERT OR IGNORE then an
      //                       awaited counter upsert — two requests.
      //   claimShapeOneTrip   the claim's shape NOW: the same two statements
      //                       in ONE batch (see Db.claimTokenPush).
      //
      // \`claimShapeSavingMs\` is the difference between them, and \`rawMs\`
      // keeps every sample so a slow FIRST sample (connection setup on a cold
      // isolate) stays visible instead of being averaged into the median.
      // \`colo\` (where Cloudflare ran this request) next to \`dbRegion\` (parsed
      // from the connection URL) is the distance question itself.
      //
      // Read-mostly: the only writes land on two fixed worker_state probe
      // rows, never seen_tokens — see src/dblatency.ts.
      const since = Date.now() - dbLatencyLastRunAt;
      if (since < DB_LATENCY_COOLDOWN_MS) {
        return Response.json(
          {
            ok: false,
            error: "cooldown — the probe spends real round trips",
            retryAfterSec: Math.ceil((DB_LATENCY_COOLDOWN_MS - since) / 1000),
          },
          { status: 429 },
        );
      }
      if (!db) {
        return Response.json(
          { ok: false, error: "db 未就緒", initError, dbReady },
          { status: 503 },
        );
      }
      try {
        dbLatencyLastRunAt = Date.now();
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
        });
      } catch (err) {
        return Response.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          },
          { status: 500 },
        );
      }
    }
    if (url.pathname === "/debug/dex429") {`,
);

fs.writeFileSync(file, src);
console.log("wrote src/worker.ts");
