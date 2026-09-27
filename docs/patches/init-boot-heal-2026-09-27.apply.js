#!/usr/bin/env node
/*
 * APPLY (idempotent): make the cached init boot self-heal.
 *
 * src/worker.ts is past this repo's file-edit window (the editor's snapshot of
 * it goes stale), so the edit lands as an anchored, verify-then-write script
 * that prints ✓ / = / ✗ and can be re-run safely.
 *
 * THE BUG. `ensureInitialized` caches its boot promise in `initPromise` and
 * hands it to every later tick. The only thing that ever cleared it sat AFTER
 * `await initPromise`:
 *
 *     initPromise = (async () => { ... })();
 *     await initPromise;
 *     if (tursoConfigured && !dbReady) initPromise = null;
 *
 * A REJECTION throws straight past that reset (the await is what raises), and a
 * boot that never settles never reaches it at all — so either shape pins the
 * isolate to `scanner === null` for as long as Cloudflare keeps it warm. Every
 * tick then records its arrival and returns at the handler's `!scanner` guard:
 * precisely the live shape measured 2026-09-27 (cron ticks arriving every
 * minute, zero completions for ~9h, ending only when a deploy replaced the
 * isolate; the durable attribution probes are blind because that path never
 * reaches a claim).
 *
 * THE FIX adds the two missing exits (see the block it inserts):
 *   - trackInitBoot: a REJECTED boot clears the cache at once, reports the
 *     reason, and its attached handler also stops a late rejection from
 *     surfacing as an unhandled rejection on the isolate.
 *   - cachedInitVerdict: a boot still UNSETTLED past INIT_UNSETTLED_MAX_MS is
 *     dropped by the next tick, so a hung init rebuilds instead of wedging.
 *
 * Run: node docs/patches/init-boot-heal-2026-09-27.apply.js
 */

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "..", "src", "worker.ts");

const HELPERS = `/**
 * How long the cached init promise may stay UNSETTLED before the next tick
 * drops it and lets a fresh attempt rebuild the isolate (see
 * cachedInitVerdict). Generous on purpose: a healthy boot is ~1-2s (the handler
 * only allows FRONT_INIT_BOUND_MS = 3.5s in front of a tick), so 60s is ~17x
 * the measured cost and a merely SLOW Turso can never be mistaken for a hung
 * one. The cost of waiting is bounded and honest — an isolate that reaches this
 * barrier is answering every tick with the \`!scanner\` guard anyway.
 */
export const INIT_UNSETTLED_MAX_MS = 60_000;

/**
 * What a tick should do with the CACHED init promise. Pure and exported so the
 * two shapes this closes can be asserted offline instead of watched live:
 *
 *   - \`reuse\`: nothing is pending, or the pending boot is young — the normal
 *     shape, and the one that must never re-init (the cache is what keeps a
 *     warm isolate from paying init on every tick and every request).
 *   - \`drop\`: the boot has been UNSETTLED past \`maxMs\`, i.e. it is hung. It
 *     will never set \`scanner\`, so every later tick would answer the
 *     \`!scanner\` guard for as long as Cloudflare keeps the isolate warm — the
 *     failure measured 2026-09-27 (cron ticks arriving every minute, no scan
 *     completed for ~9h, ending only when a deploy replaced the isolate).
 *     Dropping the cache is what lets the SAME tick start a fresh boot.
 */
export function cachedInitVerdict(
  pendingSince: number,
  now: number,
  maxMs: number = INIT_UNSETTLED_MAX_MS,
): "reuse" | "drop" {
  return pendingSince > 0 && now - pendingSince > maxMs ? "drop" : "reuse";
}

/**
 * Wire a freshly created init boot to the cache it is about to occupy.
 * Exported (like the rest of this file's tick machinery) so the shapes below
 * can be pinned offline.
 *
 * WHY THE SETTLE HANDLERS LIVE HERE, and not at the call site: the cached
 * promise is handed to every later tick, so it must stop being cached the
 * moment it can only make them fail, and \`ensureInitialized\` cannot do that
 * for itself — its own reset sits AFTER \`await initPromise\`, which a REJECTION
 * throws straight past, and a boot that never settles never reaches it at all.
 * The two shapes are therefore:
 *
 *   - REJECTED (a constructor that throws — grammy on a bad token, a client
 *     that validates its config, anything unguarded in the boot body): the
 *     cache is cleared at once so the next tick retries, and \`onReject\` gets
 *     the reason so the failure is visible instead of silent. Attaching a
 *     handler also stops a boot that rejects AFTER its creator's 3.5s front
 *     bound from surfacing as an UNHANDLED rejection on that isolate.
 *   - STILL PENDING: handled by the next caller's cachedInitVerdict, which
 *     drops it past INIT_UNSETTLED_MAX_MS (see there for why).
 *
 * \`isCurrent()\` is the identity test: a boot a newer one has already replaced
 * must not zero the LIVE boot's age, or the staleness guard would be blinded by
 * the very settle it is waiting for. Its rejection is still reported — that is
 * a real failure of a real attempt — but the cache is left alone.
 */
export function trackInitBoot<T>(
  boot: Promise<T>,
  state: { pendingSince: number },
  handlers: { isCurrent: () => boolean; onReject: (err: unknown) => void },
  now: () => number = () => Date.now(),
): void {
  state.pendingSince = now();
  void boot.then(
    () => {
      if (handlers.isCurrent()) state.pendingSince = 0;
    },
    (err: unknown) => {
      if (handlers.isCurrent()) state.pendingSince = 0;
      handlers.onReject(err);
    },
  );
}

async function ensureInitialized(env: Env): Promise<void> {`;

// 1. The helpers, immediately above ensureInitialized.
const HELPERS_ANCHOR = "async function ensureInitialized(env: Env): Promise<void> {";

// 2. The cache read: consult the verdict, then boot into a named promise.
const CACHE_OLD = `  if (initPromise) return initPromise;
  initPromise = (async () => {`;
const CACHE_NEW = `  if (initPromise && cachedInitVerdict(initBoot.pendingSince, Date.now()) === "drop") {
    // Hung, not merely slow (see cachedInitVerdict): it will never set
    // \`scanner\`, so this tick drops the cache and boots again rather than
    // answering the \`!scanner\` guard for the rest of the isolate's life.
    console.error(
      \`[worker] init promise still unsettled after \${Math.round(
        (Date.now() - initBoot.pendingSince) / 1000,
      )}s — dropping the cached init so this tick can rebuild\`,
    );
    initPromise = null;
    initBoot.pendingSince = 0;
  }
  if (initPromise) return initPromise;
  const boot = (async () => {`;

// 3. The tail: cache the named boot, wire its self-heal, await it, and reset
//    the age wherever the cache is cleared.
const TAIL_OLD = `  })();
  await initPromise;
  // A failed Turso init (transient 522 / timeout) must not stick forever:
  // reset so the next tick re-attempts init and the isolate self-heals
  // once the database recovers, instead of staying scanner-less until
  // Cloudflare evicts it.
  if (tursoConfigured && !dbReady) {
    console.warn("[worker] Turso init failed — will retry on the next tick");
    initPromise = null;
  }`;
const TAIL_NEW = `  })();
  initPromise = boot;
  // The cache must not outlive the boot it describes (see trackInitBoot): a
  // REJECTED boot clears it here, because the reset below is unreachable on
  // that path — the \`await\` underneath raises past it, and a hung boot never
  // reaches it at all. The failure is logged either way, so a throwing
  // constructor is a reading instead of the silent, hours-long wedge it
  // produced on 2026-09-27.
  trackInitBoot(boot, initBoot, {
    isCurrent: () => initPromise === boot,
    onReject: (err) => {
      console.error(
        "[worker] init THREW — dropping the cached init so the next tick retries:",
        err instanceof Error ? err.message : err,
      );
      if (initPromise === boot) {
        initPromise = null;
        initBoot.pendingSince = 0;
      }
    },
  });
  await boot;
  // A failed Turso init (transient 522 / timeout) must not stick forever:
  // reset so the next tick re-attempts init and the isolate self-heals
  // once the database recovers, instead of staying scanner-less until
  // Cloudflare evicts it. NOTE: this arm is the SETTLED-but-not-ready shape
  // (db.init() threw inside its own try) — the throwing and hung shapes are
  // trackInitBoot's and cachedInitVerdict's above.
  if (tursoConfigured && !dbReady) {
    console.warn("[worker] Turso init failed — will retry on the next tick");
    initPromise = null;
    initBoot.pendingSince = 0;
  }`;

function main() {
  const original = fs.readFileSync(FILE, "utf8");
  let out = original;
  const report = [];

  // `appliedMarker` is the text that proves the step already landed, for the
  // steps whose NEW text has itself been revised by a later round.
  const replaceOnce = (label, oldText, newText, appliedMarker) => {
    const hits = out.split(oldText).length - 1;
    if (hits === 0) {
      // Already applied? Then the NEW text (or its marker) must be there.
      const applied =
        out.includes(appliedMarker ?? newText) ||
        out.includes((appliedMarker ?? newText).split("\n")[0]);
      report.push(
        `${applied ? "=" : "✗"} ${label}: ${applied ? "already applied" : "ANCHOR MISSING"}`,
      );
      return applied;
    }
    if (hits > 1) {
      report.push(`✗ ${label}: anchor matched ${hits} times — refusing to guess`);
      return false;
    }
    out = out.replace(oldText, newText);
    report.push(`✓ ${label}: applied`);
    return true;
  };

  // The helpers are keyed on their own marker because their anchor (the
  // function line) stays in place after they land.
  if (out.includes("export function cachedInitVerdict(")) {
    report.push("= helpers: already applied");
  } else {
    replaceOnce("helpers", HELPERS_ANCHOR, HELPERS);
  }
  replaceOnce(
    "cache read",
    CACHE_OLD,
    CACHE_NEW,
    // Present in BOTH forms (the named constant and the folded guard), which
    // is what makes this step a no-op once round 2 has replaced it.
    "cachedInitVerdict(initBoot.pendingSince, Date.now())",
  );
  // Round 2 of the same edit: the first pass wrote a named `cachedInit`
  // constant, which reads as if the no-cache case were a third verdict. Fold
  // the test into the guard instead.
  replaceOnce(
    "cache read (simplified)",
    `  const cachedInit = initPromise
    ? cachedInitVerdict(initBoot.pendingSince, Date.now())
    : "reuse";
  if (initPromise && cachedInit === "drop") {`,
    `  if (initPromise && cachedInitVerdict(initBoot.pendingSince, Date.now()) === "drop") {`,
  );
  replaceOnce("boot tail", TAIL_OLD, TAIL_NEW);

  for (const line of report) console.log(line);

  const failed = report.some((line) => line.startsWith("✗"));
  if (failed) {
    console.log("\nsrc/worker.ts left UNCHANGED");
    process.exit(1);
  }
  if (out === original) {
    console.log("\nsrc/worker.ts already carries the fix — nothing written");
    process.exit(0);
  }
  fs.writeFileSync(FILE, out);
  console.log(`\nsrc/worker.ts written (${original.length} -> ${out.length} bytes)`);
  // Post-write sanity: the three pieces must all be present exactly once.
  const written = fs.readFileSync(FILE, "utf8");
  for (const needle of [
    "export const INIT_UNSETTLED_MAX_MS",
    "export function cachedInitVerdict(",
    "export function trackInitBoot<T>(",
    "if (initPromise && cachedInitVerdict(initBoot.pendingSince, Date.now()) === \"drop\") {",
    "trackInitBoot(boot, initBoot, {",
    "await boot;",
  ]) {
    const n = written.split(needle).length - 1;
    console.log(`  ${n === 1 ? "✓" : "✗"} ${needle} x${n}`);
  }
}

main();
