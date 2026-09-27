#!/usr/bin/env node
/*
 * The tracker's own invocation (docs/patches/tracker-own-invocation-2026-09-27.apply.js)
 * moved things the source pins in scripts/test-unit.js were watching, so the
 * pins follow the code instead of holding it back:
 *
 *  1. "worker (stamp BEFORE init)" — the arrival stamp's anchor was the first
 *     `const initAt = Date.now(); await recoveryAwait(…, "init")` in the file.
 *     runTrackerInvocation has the same prologue (a pass needs the same init),
 *     and it sits EARLIER in worker.ts than the scheduled handler, so the pin
 *     now SCOPES the anchor to the handler it is about.
 *  2. that anchor's own text — the scheduled signature ends with a trailing
 *     comma after the last parameter, so the scoped lookup needs it.
 *  3. "worker (the pass's own delivery runs ONE pass on its own budget)" — the
 *     pin spelled the argument list with a stray comma inside the options
 *     object (`{via:"cron-pass",}`), so it never matched the code it described.
 *  4. "scanner (the durable note is the same line)" — the thrown pass's note
 *     now carries the phase and the owner (`"done", options?.via`); the pin's
 *     point (ONE call site, the same errNote the log line carries) is unchanged,
 *     so it follows the call.
 *
 * Run: node docs/patches/tracker-own-invocation-pins-2026-09-27.apply.js
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const file = path.join(root, "scripts", "test-unit.js");
let src = fs.readFileSync(file, "utf8");
const before = src;
const notes = [];

function swap(name, find, replace, marker) {
  if (src.includes(marker)) {
    notes.push(` = ${name} — already applied`);
    return;
  }
  const count = src.split(find).length - 1;
  if (count !== 1) {
    throw new Error(`${name}: anchor matched ${count} times (want exactly 1)`);
  }
  src = src.replace(find, replace);
  notes.push(` ✓ ${name} — patched`);
}

swap(
  "pins: the arrival stamp's init anchor is scoped to the scheduled handler",
  `    // The init this stamp must precede is BOUNDED now (see
    // FRONT_INIT_BOUND_MS), so the anchor follows the recoveryAwait call.
    const scheduledInit = workerSrc.indexOf(
      'constinitAt=Date.now();awaitrecoveryAwait(ensureInitialized(env),FRONT_INIT_BOUND_MS,"init");',
    );
`,
  `    // The init this stamp must precede is BOUNDED now (see
    // FRONT_INIT_BOUND_MS), so the anchor follows the recoveryAwait call — and
    // it is scoped to the SCHEDULED HANDLER, because the tracker's own delivery
    // enters through the same init prologue (runTrackerInvocation, see
    // worker.TRACKER_CRON) and a bare indexOf would find that one first.
    const handlerStart = workerSrc.indexOf(
      'asyncscheduled(event:ScheduledEventLike,env:Env,ctx:ExecutionContextLike,):Promise<void>{',
    );
    const scheduledInit = workerSrc.indexOf(
      'constinitAt=Date.now();awaitrecoveryAwait(ensureInitialized(env),FRONT_INIT_BOUND_MS,"init");',
      handlerStart,
    );
`,
  "const handlerStart = workerSrc.indexOf(",
);

swap(
  "pins: the handler's signature anchor carries the code's own trailing comma",
  "      'asyncscheduled(event:ScheduledEventLike,env:Env,ctx:ExecutionContextLike):Promise<void>{',",
  "      'asyncscheduled(event:ScheduledEventLike,env:Env,ctx:ExecutionContextLike,):Promise<void>{',",
  "'asyncscheduled(event:ScheduledEventLike,env:Env,ctx:ExecutionContextLike,):Promise<void>{',",
);

swap(
  "pins: the stamp really lands inside that handler, before its init",
  `      "worker (stamp BEFORE init)":
        stampCall >= 0 && scheduledInit >= 0 && stampCall < scheduledInit,
`,
  `      "worker (stamp BEFORE init)":
        handlerStart >= 0 && stampCall >= handlerStart && scheduledInit > stampCall,
`,
  "handlerStart >= 0 && stampCall >= handlerStart",
);

swap(
  "pins: the pass's own delivery is spelled the way the code spells it",
  '{via:"cron-pass",},);',
  '{via:"cron-pass"},);',
  "'awaitscanner.runTrackerPass(Date.now()+TRACKER_PASS_BUDGET_MS,hold?(p:Promise<unknown>)=>hold(p):undefined,subreqRemaining,{via:\"cron-pass\"},);'",
);

swap(
  "pins: the thrown pass's note is the same call, with the owner it now carries",
  `        (scannerSrc.split("awaitthis.persistPassNote(errNote,startedAt);").length - 1) === 1 &&
`,
  `        // The call now carries the phase and the owner ("done", options?.via);
        // what this check is about (ONE call site, the same errNote the log
        // line uses) follows the call instead of pinning it back.
        (scannerSrc.split('awaitthis.persistPassNote(errNote,startedAt,"done",options?.via);')
          .length -
          1) ===
          1 &&
`,
  'awaitthis.persistPassNote(errNote,startedAt,"done",options?.via);',
);

if (src !== before) {
  fs.writeFileSync(file, src);
}
for (const line of notes) console.log(line);
