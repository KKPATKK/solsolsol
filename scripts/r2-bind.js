#!/usr/bin/env node
/*
 * Injects the R2 cold-archive binding into wrangler.toml (2026-10-17).
 *
 * WHY THIS IS A STEP AND NOT A COMMITTED BLOCK. `wrangler deploy` refuses a
 * binding whose bucket does not exist, and the account's API token does not
 * currently carry R2:Edit (measured 2026-10-17: `wrangler r2 bucket list`
 * answers Authentication error 10000). Committing `[[r2_buckets]]` would
 * therefore break the next deploy for a feature that is optional by design —
 * without the binding the history prune keeps its original bulk DELETE.
 *
 * So the deploy workflow runs this BEFORE `wrangler deploy`, and it:
 *   1. lists the account's buckets;
 *   2. creates the archive bucket if it is missing;
 *   3. appends the binding block only when step 1 or 2 proved the bucket is
 *      reachable.
 * A token without R2:Edit makes step 1 fail; the script prints a warning and
 * exits 0 WITHOUT touching wrangler.toml, so the deploy proceeds exactly as it
 * did before this file existed. That is the whole contract: this script may
 * skip, never block.
 *
 * Idempotent: the marked block is removed before it is rewritten, so running
 * it twice (or with a new bucket) never stacks two bindings — two `ARCHIVE`
 * bindings in one config is a wrangler error.
 *
 * Usage:
 *   node scripts/r2-bind.js [--bucket solana-meme-bot-cold]
 *                           [--binding ARCHIVE] [--file wrangler.toml] [--print]
 */

const fs = require("node:fs");
const path = require("node:path");

const API_BASE = "https://api.cloudflare.com/client/v4";
const BEGIN = "# >>> r2 binding (injected by scripts/r2-bind.js — do not commit) >>>";
const END = "# <<< r2 binding <<<";
const DEFAULT_BUCKET = "solana-meme-bot-cold";

function parseArgs(argv) {
  const out = {
    file: "wrangler.toml",
    bucket: process.env.R2_BUCKET || DEFAULT_BUCKET,
    binding: "ARCHIVE",
    print: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      i++;
      return v;
    };
    if (arg === "--bucket") out.bucket = next();
    else if (arg === "--binding") out.binding = next();
    else if (arg === "--file") out.file = next();
    else if (arg === "--print") out.print = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

/** The block this file owns, exactly as wrangler reads it. */
function bindingBlock({ binding, bucket }) {
  return [
    BEGIN,
    "[[r2_buckets]]",
    `binding = "${binding}"`,
    `bucket_name = "${bucket}"`,
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
    throw new Error("wrangler.toml has the r2 binding's opening marker but not its closing one");
  }
  const afterEnd = text.indexOf("\n", end);
  const head = text.slice(0, begin).replace(/\n+$/, "\n");
  const tail = afterEnd === -1 ? "" : text.slice(afterEnd + 1);
  return `${head}${tail}`;
}

/** wrangler.toml with the binding block and nothing else changed. */
function applyBinding(text, options) {
  const base = stripBlock(text);
  const separator = base.endsWith("\n") ? "" : "\n";
  return `${base}${separator}\n${bindingBlock(options)}\n`;
}

async function api(accountId, token, method, endpoint, body) {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { ok: res.ok && Boolean(payload?.success), status: res.status, payload };
}

/** The bucket list, from either shape the API has used for this endpoint. */
function bucketNames(payload) {
  const result = payload?.result;
  const list = Array.isArray(result) ? result : result?.buckets;
  return Array.isArray(list)
    ? list.map((b) => (typeof b === "string" ? b : b?.name)).filter(Boolean)
    : [];
}

async function ensureBucket(accountId, token, bucket) {
  const listed = await api(accountId, token, "GET", `/accounts/${accountId}/r2/buckets`);
  if (!listed.ok) {
    return {
      ok: false,
      reason:
        `R2 bucket list was refused (HTTP ${listed.status}). ` +
        "The API token needs R2:Edit; the archive stays off and this run continues.",
    };
  }
  if (bucketNames(listed.payload).includes(bucket)) return { ok: true, created: false };
  const created = await api(accountId, token, "POST", `/accounts/${accountId}/r2/buckets`, {
    name: bucket,
  });
  if (!created.ok) {
    return {
      ok: false,
      reason: `creating R2 bucket "${bucket}" failed (HTTP ${created.status}) — archive stays off`,
    };
  }
  return { ok: true, created: true };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.print) {
    process.stdout.write(bindingBlock(options));
    return;
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) {
    console.log(
      "r2-bind: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are unset — skipping the archive binding",
    );
    return;
  }
  const ensured = await ensureBucket(accountId, token, options.bucket);
  if (!ensured.ok) {
    console.log(`::warning::r2-bind skipped: ${ensured.reason}`);
    return;
  }
  const file = path.resolve(options.file);
  const before = fs.readFileSync(file, "utf8");
  const after = applyBinding(before, { binding: options.binding, bucket: options.bucket });
  if (after === before) {
    console.log(
      `r2-bind: binding already present in ${file} (${options.binding} → ${options.bucket})`,
    );
    return;
  }
  fs.writeFileSync(file, after);
  console.log(
    `r2-bind: ${ensured.created ? "created" : "found"} bucket ${options.bucket}; injected ` +
      `[[r2_buckets]] binding="${options.binding}" into ${file}`,
  );
  console.log("NOTE: this file is the runner's checkout only — commit it nowhere.");
}

module.exports = { BEGIN, END, applyBinding, bindingBlock, stripBlock, parseArgs, bucketNames };

if (require.main === module) {
  main().catch((err) => {
    // The contract is "skip, never block": an unexpected error here must not
    // fail a deploy whose only optional half is the archive.
    console.log(`::warning::r2-bind failed: ${err instanceof Error ? err.message : err}`);
    process.exit(0);
  });
}
