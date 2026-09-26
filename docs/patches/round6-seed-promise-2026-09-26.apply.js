#!/usr/bin/env node
/*
 * Round 6.2, client half: `fetchLatestSolanaProfiles` takes the caller's
 * journal row as a PROMISE and waits for it only on the fallback path.
 *
 * WHY: the scanner dispatches this fetch before it has read the row (the
 * dispatch has to be at tick start — see FEED_DEADLINE_MS), so a refusal that
 * lands first settled before the seed existed. Live 2026-09-26T23:10:10Z and
 * 23:11:15Z: both ticks were refused (one of them instantly, from this
 * client's own 90s cache-only backoff) and read `profiles 3` — the make-up
 * lane alone — while `dex_profiles_last` held a two-minute-old list. Awaiting
 * the row here, inside the failure path only, decides the lane AFTER the row
 * is known: a healthy fetch still never waits on Turso.
 *
 * Run: node docs/patches/round6-seed-promise-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "..", "src", "dexscreener.ts");
let src = fs.readFileSync(p, "utf8");

const apply = (label, old, next, marker) => {
  if (src.includes(marker)) {
    console.log(`= dexscreener.ts: ${label} already applied`);
    return;
  }
  const count = src.split(old).length - 1;
  if (count !== 1) {
    console.error(`✗ dexscreener.ts: ${label} anchor found ${count} times (need exactly 1)`);
    process.exit(1);
  }
  src = src.replace(old, next);
  console.log(`✓ dexscreener.ts: ${label} patched`);
};

// ---- 1. the signature and its contract -------------------------------------
apply(
  "the seed parameter",
  j(
    "   * upstream that never answers at all: the call abandons its own fetch",
    "   * inside the tick's window and still builds the make-up list, instead of",
    "   * letting the caller's race throw the list away with the body.",
    "   */",
    "  async fetchLatestSolanaProfiles(): Promise<TokenProfile[]> {",
  ),
  j(
    "   * upstream that never answers at all: the call abandons its own fetch",
    "   * inside the tick's window and still builds the make-up list, instead of",
    "   * letting the caller's race throw the list away with the body.",
    "   *",
    "   * `seed` is the caller's durable journal row (see DEX_PROFILES_LAST_KEY),",
    "   * handed over as a PROMISE because the caller dispatches this fetch before",
    "   * it has read that row: the two overlap by design, and a refusal can land",
    "   * first — instantly, when this client is in its own 90-second cache-only",
    "   * backoff. Waiting for the row on the fallback path only (see below) is",
    "   * what makes the lane order-independent: live 2026-09-26T23:10-23:11Z, two",
    "   * ticks whose fetch was refused read `profiles 3` — the make-up lane alone",
    "   * — while the row on disk was two minutes old, purely because the fetch had",
    "   * already settled before the seed existed.",
    "   */",
    "  async fetchLatestSolanaProfiles(",
    "    seed?: Promise<ProfileFeedSnapshot | null>,",
    "  ): Promise<TokenProfile[]> {",
  ),
  "seed?: Promise<ProfileFeedSnapshot | null>",
);

// ---- 2. the wait, on the fallback path only --------------------------------
apply(
  "await the seed before the reuse decision",
  j(
    "    const now = Date.now();",
    "    const reuse = shouldReuseProfileList(",
  ),
  j(
    "    // The caller's row, waited for ONLY when this fetch is about to fall",
    "    // back (see the seed parameter): `failed || feed.length === 0` is exactly",
    "    // the set shouldReuseProfileList may serve below, so a healthy fetch never",
    "    // waits on Turso and a refused one gets the list the caller had ALREADY",
    "    // read. The wait is short by construction — the caller's row read is one",
    "    // round trip that is already in flight — and a rejected or absent row is",
    "    // simply no seed.",
    "    if (seed && (failed || feed.length === 0)) {",
    "      try {",
    "        this.seedLastGoodProfiles(await seed);",
    "      } catch {",
    "        /* the row is best-effort: a failed read seeds nothing */",
    "      }",
    "    }",
    "    const now = Date.now();",
    "    const reuse = shouldReuseProfileList(",
  ),
  "this.seedLastGoodProfiles(await seed);",
);

fs.writeFileSync(p, src);
console.log("node docs/patches/round6-seed-promise-2026-09-26.apply.js — done");
