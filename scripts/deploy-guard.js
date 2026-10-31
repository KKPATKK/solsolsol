#!/usr/bin/env node
/*
 * REFUSE TO SHIP A WORKER WITHOUT ITS D1 BINDING (2026-10-31).
 *
 * WHY THIS EXISTS. `env.DB` IS the store switch (see /health.dbStore and the
 * note in src/worker.ts): with it, the Worker reads and writes live D1; without
 * it, the same code keeps running — silently — against the frozen Turso archive,
 * the pre-2026-10-15 state machine, and re-pushes coins it already pushed. The
 * binding is NOT in the repository on purpose: its `database_id` is an account
 * resource, so the deploy job injects it into the runner's own checkout
 * (scripts/d1-bind.js) immediately before `wrangler deploy`.
 *
 * Which means the obvious thing — `npm run deploy:worker` on a laptop — ships a
 * Worker with no binding, and nothing fails. That is exactly what happened at
 * 03:28Z on 2026-10-31: a manual deploy of this checkout took production off D1
 * for ~3 minutes (no cards escaped only because the archive's tracker list was
 * empty) and it looked like a successful deploy in the terminal.
 *
 * So the deploy scripts run through here: a checkout without the binding cannot
 * be deployed, and the refusal names the documented path instead. CI never hits
 * this wall (it injects first), and `--print` shows the command without running
 * it.
 *
 * Usage:
 *   node scripts/deploy-guard.js [--file wrangler.toml] [--print] [-- <wrangler args>]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

/**
 * The binding names this config actually declares — parsed, not text-matched:
 * the table must be a real `[[d1_databases]]` header (not a comment, not a
 * string), and only the lines inside it count. A `# binding = "DB"` in a
 * comment is a note, not a binding.
 */
function d1BindingNames(toml) {
  const names = [];
  let inTable = false;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inTable = line === "[[d1_databases]]";
      continue;
    }
    if (!inTable) continue;
    const m = /^binding\s*=\s*"([^"]*)"/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/** Does `toml` bind the Worker's `env.DB` to a D1 database? */
function hasD1Binding(toml, binding = "DB") {
  return d1BindingNames(toml).includes(binding);
}

function parseArgs(argv) {
  const out = { file: path.join(ROOT, "wrangler.toml"), print: false, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      out.passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--file") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--file needs a value");
      out.file = v;
    } else if (arg === "--print") out.print = true;
    else out.passthrough.push(arg);
  }
  return out;
}

function refusal(file) {
  return [
    `✋ refusing to deploy: no \`[[d1_databases]]\` binding with \`binding = "DB"\` in ${file}.`,
    "",
    "`env.DB` IS the store switch (/health.dbStore). It is injected into the",
    "runner's own checkout by CI (scripts/d1-bind.js) and is never committed, so",
    "this checkout would ship a Worker with no D1 binding: it keeps running —",
    "silently — against the frozen Turso archive (pre-2026-10-15 state) and",
    "re-pushes coins it already pushed.",
    "",
    "Deploy the documented way:",
    "  push to main                (or: gh workflow run deploy.yml --ref main)",
    "",
    'Then verify the switch:  /health must answer  "dbStore": "d1"',
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const file = path.resolve(options.file);
  let toml;
  try {
    toml = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`✋ deploy-guard: cannot read ${file}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (!hasD1Binding(toml)) {
    console.error(refusal(file));
    process.exit(1);
  }
  const wrangler = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(wrangler)) {
    console.error(`✋ deploy-guard: wrangler is not installed at ${wrangler} (run npm ci)`);
    process.exit(1);
  }
  const args = [wrangler, "deploy", "--config", file, ...options.passthrough];
  if (options.print) {
    process.stdout.write(`${process.execPath} ${args.join(" ")}\n`);
    return;
  }
  const res = spawnSync(process.execPath, args, { stdio: "inherit", cwd: ROOT });
  if (res.error) {
    console.error(`✋ deploy-guard: wrangler did not run: ${res.error.message}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}

module.exports = { d1BindingNames, hasD1Binding, parseArgs };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`deploy-guard failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
