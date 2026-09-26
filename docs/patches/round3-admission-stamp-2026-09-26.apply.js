#!/usr/bin/env node
/**
 * Round 3 of the Turso round-trip merges (2026-09-26): the phase ladder's
 * ADMISSION stamp rides the scan-lock claim batch.
 *
 * WHY: the ladder costs FIVE requests per tick (measured live: the cumulative
 * census delta showed setWorkerState:tick_progress +5 on one tick, while the
 * per-tick census read only 2 because the trail lands after the scan window).
 * The admission stamp's reading — "this tick was admitted, the scan not yet
 * entered" — is ALREADY written by the claim batch, which upserts the heartbeat
 * with `{at: startedAt, phase: "scanning"}` in the same request that admits the
 * tick. So the stamp rides that batch: one fewer request on every tick, and the
 * reading lands atomically with the claim instead of ~150ms after it.
 *
 * GUARDED like historyStmt (the same batch's dead-tick row): written only when
 * THIS tick's claim won the lock, so a tick that lost the lease and skipped the
 * scan cannot stamp a phase it never reached.
 *
 * A batch is a transaction: a refused claim loses the stamp with the claim —
 * which is the pre-merge shape exactly (no claim, no stamp, the ladder's first
 * write is then the scan's front/gate phase or the postscan record).
 *
 * Run: node docs/patches/round3-admission-stamp-2026-09-26.apply.js
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
    "claimScanLock: the admission stamp rides the claim batch, guarded by the claim",
    lines(
      `    cronTick?: ScheduledTickEntry | null,`,
      `  ): Promise<string | null> {`,
      `    const value = \`\${now + ttlMs}|\${owner}\`;`,
    ),
    lines(
      `    cronTick?: ScheduledTickEntry | null,`,
      `    /**`,
      `     * The tick's ADMISSION stamp (worker.TICK_PROGRESS_KEY), written WITH the`,
      `     * claim that admits it (2026-09-26).`,
      `     *`,
      `     * WHY: the phase ladder's first stamp used to be a request of its own`,
      `     * (~150ms after the claim), and its whole reading — "this tick was`,
      `     * admitted, the scan not yet entered" — is already written by this batch`,
      `     * (the heartbeat below carries the same \`at\` and \`phase: "scanning"\`).`,
      `     * Measured live 2026-09-26 with the labelled census: the ladder cost FIVE`,
      `     * requests per tick, the single largest DB item in a ~21-request tick,`,
      `     * and the per-tick census under-read it at 2 because the trail lands`,
      `     * after the scan window. Riding the claim makes the stamp free.`,
      `     *`,
      `     * GUARDED (see historyStmt): the stamp is written only when THIS tick's`,
      `     * claim won the lock, so a tick that lost the lease — and therefore`,
      `     * skipped the scan — cannot stamp a phase it never reached. A refused`,
      `     * batch loses the stamp with the claim: the pre-merge shape (no claim,`,
      `     * no admission reading).`,
      `     */`,
      `    tickProgressJson?: string | null,`,
      `  ): Promise<string | null> {`,
      `    const value = \`\${now + ttlMs}|\${owner}\`;`,
    ),
    (src) => src.includes("tickProgressJson?: string | null,"),
  ],
  [
    "src/db.ts",
    "the guarded admission statement joins the batch",
    lines(
      `    const cronStatements = cronTick ? this.scheduledTickStatements(cronTick) : [];`,
      `    const winBatch = [claimStmt, heartbeatStmt, historyStmt, ...cronStatements].filter(`,
    ),
    lines(
      `    const progressStmt: { sql: string; args: Array<string | number | null> } | null =`,
      `      tickProgressJson`,
      `        ? {`,
      `            // INSERT..SELECT carries an explicit WHERE because SQLite's`,
      `            // UPSERT parser needs one to disambiguate the ON CONFLICT clause`,
      `            // (the documented workaround), and that WHERE is the guard: the`,
      `            // row lands only while this tick's own lock value is in place.`,
      `            sql: \`INSERT INTO worker_state (key, value)`,
      `                  SELECT 'tick_progress', ?`,
      `                  WHERE EXISTS (SELECT 1 FROM worker_state WHERE key = 'scan_lock' AND value = ?)`,
      `                  ON CONFLICT(key) DO UPDATE SET value = excluded.value\`,`,
      `            args: [tickProgressJson, value],`,
      `          }`,
      `        : null;`,
      `    const cronStatements = cronTick ? this.scheduledTickStatements(cronTick) : [];`,
      `    const winBatch = [`,
      `      claimStmt,`,
      `      heartbeatStmt,`,
      `      historyStmt,`,
      `      progressStmt,`,
      `      ...cronStatements,`,
      `    ].filter(`,
    ),
    (src) => src.includes("const progressStmt:"),
  ],
  // The claim has THREE arms that can carry extra statements (the win path, the
  // "row vanished mid-claim" retry, and the stale-holder takeover). All three
  // take the stamp: the guard is the same lock value in every arm, so a stamp
  // written by an arm that did NOT win is impossible — and a stamp-only claim
  // (no heartbeat/history/cron) still has to take the batch path.
  [
    "src/db.ts",
    "arm 1 (win): a stamp-only claim still takes the batch path",
    lines(
      `    if (heartbeatStmt || historyStmt || cronStatements.length > 0) {`,
      `      const batch = await this.get().batch(winBatch, "write");`,
    ),
    lines(
      `    if (heartbeatStmt || historyStmt || progressStmt || cronStatements.length > 0) {`,
      `      const batch = await this.get().batch(winBatch, "write");`,
    ),
    (src) =>
      src.includes(
        `    if (heartbeatStmt || historyStmt || progressStmt || cronStatements.length > 0) {\n      const batch = await this.get().batch(winBatch, "write");`,
      ),
  ],
  [
    "src/db.ts",
    "arm 2 (retry): the ticket's stamp rides the retried batch too",
    lines(
      `      if (heartbeatStmt || historyStmt || cronStatements.length > 0) {`,
      `        const batch = await this.get().batch(winBatch, "write");`,
    ),
    lines(
      `      if (heartbeatStmt || historyStmt || progressStmt || cronStatements.length > 0) {`,
      `        const batch = await this.get().batch(winBatch, "write");`,
    ),
    (src) =>
      src.includes(
        `      if (heartbeatStmt || historyStmt || progressStmt || cronStatements.length > 0) {\n        const batch = await this.get().batch(winBatch, "write");`,
      ),
  ],
  [
    "src/db.ts",
    "arm 3 (stale-holder takeover): the takeover batch restores liveness AND the admission reading",
    lines(
      `    if (won && (heartbeatStmt || historyStmt || cronStatements.length > 0)) {`,
      `      // Rare path (dead holder): restore liveness with a separate write —`,
      `      // one extra round trip only when a takeover actually happens.`,
      `      try {`,
      `        await this.get().batch(`,
      `          [heartbeatStmt, historyStmt, ...cronStatements].filter(`,
    ),
    lines(
      `    if (won && (heartbeatStmt || historyStmt || progressStmt || cronStatements.length > 0)) {`,
      `      // Rare path (dead holder): restore liveness with a separate write —`,
      `      // one extra round trip only when a takeover actually happens. The`,
      `      // ADMISSION stamp rides it for the same reason it rides the win path`,
      `      // (2026-09-26): the takeover UPDATE above already put this tick's lock`,
      `      // value in place, so the stamp\'s guard sees it.`,
      `      try {`,
      `        await this.get().batch(`,
      `          [heartbeatStmt, historyStmt, progressStmt, ...cronStatements].filter(`,
    ),
    (src) => src.includes("[heartbeatStmt, historyStmt, progressStmt, ...cronStatements].filter("),
  ],
  [
    "src/worker.ts",
    "the claim carries the admission record instead of the ladder paying for it",
    lines(
      `  if (db) {`,
      `    const claimAt = Date.now();`,
      `    try {`,
      `      scanLock = await db.claimScanLock(`,
      `        SCAN_LOCK_OWNER,`,
      `        startedAt,`,
      `        SCAN_LOCK_TTL_MS,`,
      `        heartbeatJson,`,
      `        backfillEntry,`,
      `        cronTick ?? null,`,
      `      );`,
    ),
    lines(
      `  if (db) {`,
      `    const claimAt = Date.now();`,
      `    // The tick's ADMISSION stamp rides the claim (2026-09-26): the ladder's`,
      `    // first stamp was a request of its own, and its reading — admitted, the`,
      `    // scan not yet entered — is what this batch already writes (the heartbeat`,
      `    // above carries the same \`at\` and phase). Measured live: the ladder cost`,
      `    // FIVE requests per tick (the census's largest DB item) and this is the`,
      `    // one that was free. \`preRaceMs: 0\` is honest — the pre-race split is`,
      `    // computed after the claim returns, so it did not exist at stamp time`,
      `    // (the note renders a 0 as \`preRace n/a\`).`,
      `    const admissionRecord = tickProgressRecord({`,
      `      at: startedAt,`,
      `      stage: "scan",`,
      `      payloadBytes: 0,`,
      `      scanMs: 0,`,
      `      preRaceMs: 0,`,
      `      subreqs: subreqView().current.total,`,
      `      cut: false,`,
      `      err: null,`,
      `    });`,
      `    try {`,
      `      scanLock = await db.claimScanLock(`,
      `        SCAN_LOCK_OWNER,`,
      `        startedAt,`,
      `        SCAN_LOCK_TTL_MS,`,
      `        heartbeatJson,`,
      `        backfillEntry,`,
      `        cronTick ?? null,`,
      `        admissionRecord,`,
      `      );`,
    ),
    (src) => src.includes("const admissionRecord = tickProgressRecord({"),
  ],
  [
    "src/worker.ts",
    "the ladder no longer pays for the admission stamp",
    lines(
      `      // The phase stamp the worker itself owns (see tickPhaseLadder): the`,
      `      // tick is admitted, the scan not yet entered. The three phases INSIDE`,
      `      // the scan are stamped through the scanner's hook below — without it`,
      `      // the row would stop here, which is where four of four captured deaths`,
      `      // stopped.`,
    ),
    lines(
      `      // The phases INSIDE the scan are stamped through the scanner's hook`,
      `      // below — without it the row would stop at the admission stamp, which`,
      `      // is where four of four captured deaths stopped. The ADMISSION stamp`,
      `      // itself no longer queues here (2026-09-26): it rides the claim batch`,
      `      // above, so the ladder's own writes start with the scan's first phase`,
      `      // (or with the postscan record on a tick whose scan never stamped).`,
    ),
    (src) => src.includes("The ADMISSION stamp\n      // itself no longer queues here"),
  ],
  [
    "src/worker.ts",
    "the admission call site is gone",
    lines(
      `      if (scanner) scanner.onTickPhase = notePhase;`,
      `      notePhase("scan");`,
    ),
    lines(
      `      if (scanner) scanner.onTickPhase = notePhase;`,
    ),
    (src) => !src.includes(`      notePhase("scan");`),
  ],
  [
    "src/worker.ts",
    "the note renders an unmeasured pre-race split as n/a, not as a free phase",
    lines(
      `  bits.push(\`subreqs \${rec.subreqs}\`, \`preRace \${rec.preRaceMs}ms\`);`,
    ),
    lines(
      `  // 0 = the split did not exist when this record was written (the admission`,
      `  // stamp, which rides the claim — see Db.claimScanLock): printing it as`,
      `  // "0ms" would read as a pre-race phase that cost nothing.`,
      `  bits.push(\`subreqs \${rec.subreqs}\`, \`preRace \${rec.preRaceMs > 0 ? \`\${rec.preRaceMs}ms\` : "n/a"}\`);`,
    ),
    (src) => src.includes("preRace ${rec.preRaceMs > 0 ?"),
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
