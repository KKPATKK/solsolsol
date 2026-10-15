#!/usr/bin/env node
/*
 * Injects the D1 binding into wrangler.toml (2026-10-15).
 *
 * WHY THIS IS A STEP AND NOT A COMMITTED BLOCK. The binding's `database_id` is
 * an account resource, not repository content: the database is created on the
 * first CI run (see scripts/d1-copy.js ensure), and the id Cloudflare mints for
 * it belongs to the run's own checkout. Committing it would mean the repo
 * carries an id that any other account's deploy would fail on — and it would
 * ALSO mean the switch to D1 happened by committing, i.e. silently, in a commit
 * with no mention of a migration. Here the switch is a declared CI step: the
 * deploy job injects the binding it was handed by the migrate job and deploys,
 * and because `Env.DB` PRESENCE is the store switch (see src/worker.ts), the
 * deploy IS the cutover.
 *
 * The block is written at the END of the file: `[[d1_databases]]` is a
 * root-level array of tables wherever it appears, and appending cannot land
 * inside another table's body (which inserting before the first `[` header
 * could, once a comment block sits above it).
 *
 * Idempotent by construction: the marked block is removed before it is
 * rewritten, so running this twice (or with a new id) never stacks two
 * bindings — two `DB` bindings in one config is a wrangler error.
 *
 * Usage:
 *   node scripts/d1-bind.js --database-id <uuid> [--name solana-meme-bot]
 *                           [--binding DB] [--file wrangler.toml] [--print]
 */
const fs = require("node:fs");
const path = require("node:path");

const BEGIN = "# >>> d1 binding (injected by scripts/d1-bind.js — do not commit) >>>";
const END = "# <<< d1 binding <<<";

function parseArgs(argv) {
  const out = { file: "wrangler.toml", name: "solana-meme-bot", binding: "DB", print: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i++;
      return v;
    };
    if (arg === "--database-id") out.databaseId = next();
    else if (arg === "--name") out.name = next();
    else if (arg === "--binding") out.binding = next();
    else if (arg === "--file") out.file = next();
    else if (arg === "--print") out.print = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

/** The block this file owns, exactly as wrangler reads it. */
function bindingBlock({ binding, name, databaseId }) {
  return [
    BEGIN,
    "[[d1_databases]]",
    `binding = "${binding}"`,
    `database_name = "${name}"`,
    `database_id = "${databaseId}"`,
    END,
    "",
  ].join("\n");
}

/** The file without this file's own block (the pre-injection state). */
function stripBlock(text) {
  const begin = text.indexOf(BEGIN);
  if (begin === -1) return text;
  const end = text.indexOf(END, begin);
  if (end === -1) {
    throw new Error("wrangler.toml has the d1 binding's opening marker but not its closing one");
  }
  const afterEnd = text.indexOf("\n", end);
  const head = text.slice(0, begin).replace(/\n+$/, "\n");
  const tail = afterEnd === -1 ? "" : text.slice(afterEnd + 1);
  return `${head}${tail}`;
}

/** wrangler.toml with the binding block for `databaseId` and nothing else changed. */
function applyBinding(text, options) {
  const base = stripBlock(text);
  const separator = base.endsWith("\n") ? "" : "\n";
  return `${base}${separator}\n${bindingBlock(options)}`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.databaseId) {
    throw new Error("--database-id is required (the D1 database's uuid)");
  }
  if (options.print) {
    process.stdout.write(bindingBlock(options));
    return;
  }
  const file = path.resolve(options.file);
  const before = fs.readFileSync(file, "utf8");
  const after = applyBinding(before, options);
  if (after === before) {
    console.log(`d1 binding already present in ${file} (binding ${options.binding} → ${options.databaseId})`);
    return;
  }
  fs.writeFileSync(file, after);
  console.log(
    `injected [[d1_databases]] binding="${options.binding}" database_name="${options.name}" database_id="${options.databaseId}" into ${file}`,
  );
  console.log("NOTE: this file is the runner's checkout only — commit it nowhere. The binding's presence is the store switch.");
}

module.exports = { BEGIN, END, applyBinding, bindingBlock, stripBlock, parseArgs };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`d1-bind failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
