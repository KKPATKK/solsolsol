#!/usr/bin/env node
/*
 * MUTATION CHECK for the init-boot self-heal (see
 * docs/patches/init-boot-heal-2026-09-27.apply.js and its -tests- sibling).
 *
 * A test that cannot fail is not evidence, so each half of the fix is reverted
 * one at a time and the suite is re-run against the mutated build. The script
 * ALWAYS restores src/worker.ts from its own backup (and verifies it with a
 * byte compare), so an interrupted run cannot leave the tree mutated.
 *
 * What each mutation must be caught by:
 *   1. verdict boundary `>` -> `>=`      "at the bound the boot is still reused"
 *      (the boundary pair is pinned from both sides, so the inclusive operator
 *      trips the "still reused" half first — caught either way)
 *   2. rejection arm loses the age reset "and the boot stops being pending"
 *   3. rejection arm loses onReject      "the reason is reported, never swallowed"
 *   4. call site loses the identity test "and it is tracked with the identity test"
 *   5. call site drops trackInitBoot     "and it is tracked with the identity test"
 *
 * Run: node docs/patches/init-boot-heal-mutation-2026-09-27.check.js [1 2 3 4 5]
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const FILE = path.join(ROOT, "src", "worker.ts");
const TEST_NAME = "init boot cache: a REJECTED or HUNG boot stops being cached";
/*
 * A run that is KILLED mid-mutation (the terminal's own timeout is shorter than
 * a build + full suite, so this is not hypothetical) leaves the mutated file on
 * disk — and the next run would then adopt THAT as its backup. Two guards: the
 * pristine copy is written to disk at startup, and a precheck refuses to start
 * on a file that already carries a mutation.
 */
const PRISTINE = path.join(require("os").tmpdir(), "worker.pristine-2026-09-27.ts");
/** Present exactly once in the fixed file, and absent under mutation 3. */
const PRISTINE_MARKER = "      handlers.onReject(err);";

const MUTATIONS = [
  {
    id: 1,
    what: "cachedInitVerdict: `>` -> `>=` (the bound stops being exclusive)",
    from: "return pendingSince > 0 && now - pendingSince > maxMs ? \"drop\" : \"reuse\";",
    to: "return pendingSince > 0 && now - pendingSince >= maxMs ? \"drop\" : \"reuse\";",
    expect: "at the bound the boot is still reused",
  },
  {
    id: 2,
    what: "trackInitBoot: the rejection arm no longer clears the pending age",
    from: `    (err: unknown) => {
      if (handlers.isCurrent()) state.pendingSince = 0;
      handlers.onReject(err);
    },`,
    to: `    (err: unknown) => {
      handlers.onReject(err);
    },`,
    expect: "and the boot stops being pending",
  },
  {
    id: 3,
    what: "trackInitBoot: the rejection reason is swallowed",
    from: "      handlers.onReject(err);\n",
    to: "      void err;\n",
    expect: "the reason is reported, never swallowed",
  },
  {
    id: 4,
    what: "call site: the boot is tracked without the identity test",
    from: "    isCurrent: () => initPromise === boot,",
    to: "    isCurrent: () => true,",
    expect: "and it is tracked with the identity test",
  },
  {
    id: 5,
    what: "call site: the boot's self-heal is never wired in",
    from: `  trackInitBoot(boot, initBoot, {
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
  });`,
    to: "  void boot.then(() => {}, () => {});",
    expect: "and it is tracked with the identity test",
  },
];

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
}

function main() {
  const wanted = process.argv.slice(2).map(Number).filter((n) => n > 0);
  const picked = wanted.length ? MUTATIONS.filter((m) => wanted.includes(m.id)) : MUTATIONS;
  const backup = fs.readFileSync(FILE, "utf8");
  if (backup.split(PRISTINE_MARKER).length - 1 !== 1) {
    console.log(
      `✗ refusing to start: src/worker.ts does not look pristine ` + 
        `(the marker "${PRISTINE_MARKER.trim()}" appears ${backup.split(PRISTINE_MARKER).length - 1} times).\n` +
        `  Restore it first — docs/patches/init-boot-heal-2026-09-27.apply.js is idempotent, ` +
        `and ${PRISTINE} holds the copy a killed run left behind.`,
    );
    process.exit(1);
  }
  fs.writeFileSync(PRISTINE, backup);
  const restore = () => {
    fs.writeFileSync(FILE, backup);
    console.log(`\n✓ src/worker.ts restored before exit (pristine copy: ${PRISTINE})`);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      restore();
      process.exit(130);
    });
  }
  let failures = 0;
  try {
    for (const mutation of picked) {
      const hits = backup.split(mutation.from).length - 1;
      if (hits !== 1) {
        console.log(`✗ ${mutation.id}: anchor matched ${hits} times — cannot mutate`);
        failures += 1;
        continue;
      }
      fs.writeFileSync(FILE, backup.replace(mutation.from, mutation.to));
      run("npm", ["run", "build"]);
      let out = "";
      try {
        out = run("node", ["scripts/test-unit.js"]);
      } catch (err) {
        out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      }
      // Match on the assertion TEXT, never on the suite's status glyph: the
      // failure line is the only line that carries both the test's name and the
      // message the mutated build should have tripped.
      const line = out
        .split("\n")
        .find((l) => l.includes(TEST_NAME) && l.includes(mutation.expect));
      const failed = Number((out.match(/(\d+) failed/) ?? [])[1] ?? 0);
      const caught = Boolean(line) && failed > 0;
      console.log(
        `${caught ? "✓" : "✗"} ${mutation.id}. ${mutation.what}\n` +
          `     expected the suite to fail on: ${mutation.expect}\n` +
          `     observed: ${line ? line.trim() : "(that assertion never failed — NOT CAUGHT)"}`,
      );
      if (process.env.HEAL_MUT_DEBUG) {
        const dump = path.join(require("os").tmpdir(), `heal-mut-${mutation.id}.txt`);
        fs.writeFileSync(dump, out);
        console.log(`----- raw suite output for mutation ${mutation.id} -> ${dump} -----`);
        console.log(
          out
            .split("\n")
            .filter((l) => l.includes(TEST_NAME) || l.includes("passed,"))
            .join("\n"),
        );
      }
      if (!caught) failures += 1;
      fs.writeFileSync(FILE, backup);
    }
  } finally {
    restore();
    run("npm", ["run", "build"]);
  }
  const restored = fs.readFileSync(FILE, "utf8");
  console.log(
    `\n${restored === backup ? "✓ src/worker.ts restored byte-for-byte" : "✗ RESTORE FAILED"}`,
  );
  console.log(`${picked.length - failures}/${picked.length} mutations caught`);
  process.exit(failures === 0 && restored === backup ? 0 : 1);
}

main();
