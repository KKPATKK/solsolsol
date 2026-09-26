#!/usr/bin/env node
/*
 * Round 6.2, scanner half: the front read starts before the profiles dispatch,
 * and the fetch is handed that read's row as the seed promise.
 *
 * The dispatch itself does not move in any way that matters: between the old
 * call site and the new one there is nothing but synchronous bookkeeping, so
 * the fetch is still in flight before the tick's first await, still bounded by
 * `feedDeadline`, and both handlers still ride the promise so the early
 * returns can abandon it without an unhandled rejection. What changes is that
 * the row now exists — as a promise — when the client decides which list to
 * evaluate.
 *
 * The read has to start AFTER `this.db.enterScanMode()`: it is a round trip of
 * this scan, and the scan client is the one that carries the tick's 1.2s leash
 * (a read started earlier would ride the 6s command-handler budget instead).
 *
 * Run: node docs/patches/round6-seed-promise-scanner-2026-09-26.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "..", "src", "scanner.ts");
let src = fs.readFileSync(p, "utf8");

const apply = (label, old, next, marker) => {
  if (src.includes(marker)) {
    console.log(`= scanner.ts: ${label} already applied`);
    return;
  }
  const count = src.split(old).length - 1;
  if (count !== 1) {
    console.error(`✗ scanner.ts: ${label} anchor found ${count} times (need exactly 1)`);
    process.exit(1);
  }
  src = src.replace(old, next);
  console.log(`✓ scanner.ts: ${label} patched`);
};

// ---- 1. the old dispatch site keeps a pointer ------------------------------
apply(
  "vacate the old dispatch site",
  j(
    "    // The profiles fetch is STARTED here — at tick start, before the",
    "    // enabled-chats read and the crime-wallet load below — and awaited where",
    "    // its result is used (see the call site). Its window is `feedDeadline`,",
    "    // i.e. FEED_DEADLINE_MS measured from tick start, and the point of",
    "    // starting it early is that it is already in flight while those pre-feed",
    "    // steps run: they used to run FIRST, and on a cold isolate they spent",
    "    // 2.8-3.6s of the 900ms window, so `fetchFeedCapped` short-circuited and",
    "    // this call was never even dispatched (2026-09-21, see FEED_DEADLINE_MS).",
    "    // Both handlers are attached HERE, so every early return below — no",
    "    // enabled chats, the stop checks — can abandon the promise without an",
    "    // unhandled rejection, and a late settle still reaches the client's own",
    "    // bookkeeping (noteProfileFeed) exactly as it did when the call was made",
    "    // later in the tick.",
    "    const profilesCall = this.dex.fetchLatestSolanaProfiles().then(",
    "      (list) => ({ list, settled: true }),",
    "      (err: unknown) => {",
    "        console.error(",
    "          \"[scanner] dexscreener profile feed failed:\",",
    "          err instanceof Error ? err.message : err,",
    "        );",
    "        return { list: [] as TokenProfile[], settled: true };",
    "      },",
    "    );",
  ),
  j(
    "    // The profiles fetch is dispatched further down, together with the front",
    "    // read whose row it takes as its seed (see the dispatch): the point of",
    "    // starting it early is unchanged — it is already in flight while the",
    "    // pre-feed steps run, because those used to run FIRST and on a cold",
    "    // isolate spent 2.8-3.6s of the 900ms window, so `fetchFeedCapped`",
    "    // short-circuited and this call was never even dispatched (2026-09-21,",
    "    // see FEED_DEADLINE_MS).",
  ),
  "The profiles fetch is dispatched further down",
);

// ---- 2. the read + the dispatch, together -----------------------------------
apply(
  "start the read and dispatch with its promise",
  j(
    "    }, SCAN_TIMEOUT_MS);",
    "    try {",
    "      // THE FRONT'S ONE READ (see Db.readScanFront): the enabled chats and the",
  ),
  j(
    "    }, SCAN_TIMEOUT_MS);",
    "    // THE FRONT'S ONE READ starts HERE, and the profiles fetch is dispatched",
    "    // with the row that read carries as its seed (see",
    "    // DexScreenerClient.fetchLatestSolanaProfiles). The read goes first so the",
    "    // seed exists at all, and it goes AFTER enterScanMode above on purpose: it",
    "    // is a round trip of this scan, and the scan client is the one that",
    "    // carries the tick's 1.2s leash (a read started earlier would ride the 6s",
    "    // command-handler budget instead).",
    "    //",
    "    // Nothing but synchronous bookkeeping sits between the old dispatch site",
    "    // and this one, so the fetch is still in flight before the tick's first",
    "    // await, still bounded by `feedDeadline`, and both handlers still ride the",
    "    // promise so every early return below — no enabled chats, the stop checks",
    "    // — can abandon it without an unhandled rejection.",
    "    //",
    "    // WHY THE PROMISE (live 2026-09-26T23:10:10Z, 23:11:15Z): with the fetch",
    "    // dispatched above the read, a refusal that landed first — and this",
    "    // client's own 90s cache-only backoff makes those refusals INSTANT —",
    "    // settled before the seed existed, so those ticks read `profiles 3` (the",
    "    // make-up lane alone) while the durable row was two minutes old. Handing",
    "    // the row over as a promise moves that decision inside the client, after",
    "    // the row is known.",
    "    const frontRead = this.db.readScanFront(SCAN_FRONT_GATE_KEYS);",
    "    const profileFeedSeed = frontRead.then(",
    "      (front) =>",
    "        parseProfileFeedSnapshot(front.gates.get(DEX_PROFILES_LAST_KEY) ?? null),",
    "      () => null,",
    "    );",
    "    const profilesCall = this.dex.fetchLatestSolanaProfiles(profileFeedSeed).then(",
    "      (list) => ({ list, settled: true }),",
    "      (err: unknown) => {",
    "        console.error(",
    "          \"[scanner] dexscreener profile feed failed:\",",
    "          err instanceof Error ? err.message : err,",
    "        );",
    "        return { list: [] as TokenProfile[], settled: true };",
    "      },",
    "    );",
    "    try {",
    "      // THE FRONT'S ONE READ (see Db.readScanFront): the enabled chats and the",
  ),
  "const profileFeedSeed = frontRead.then(",
);

// ---- 3. the tick awaits the same promise -----------------------------------
apply(
  "await the promise the dispatch was given",
  j(
    "      const front = await this.db.readScanFront(SCAN_FRONT_GATE_KEYS);",
    "      this.scanFront = front;",
  ),
  j(
    "      const front = await frontRead;",
    "      this.scanFront = front;",
  ),
  "const front = await frontRead;",
);

// ---- 4. the seed block's contract ------------------------------------------
apply(
  "the seed block reads the promise",
  j(
    "      // The last-good profile list rides that same read (see",
    "      // DEX_PROFILES_LAST_KEY): seeding it HERE is what lets a 429 tick reuse",
    "      // a minutes-old list instead of the make-up coins alone, and this is the",
    "      // earliest point in the tick that already has the row in hand. The stamp",
    "      // is kept beside the seed so a reused list never re-writes itself.",
    "      //",
    "      // One honest caveat: the profiles fetch is dispatched ABOVE this read",
    "      // (see profilesCall), so a refusal that lands before this point returns",
    "      // sees no seed and falls back to the make-up lane — exactly the old",
    "      // behaviour, never worse. Measured, a 429 on the shared egress answers in",
    "      // 200-500ms while the front read settles in ~90-110ms, so the seed wins",
    "      // that race on the common tick.",
  ),
  j(
    "      // The last-good profile list rides that same read (see",
    "      // DEX_PROFILES_LAST_KEY): its row is what a refused fetch evaluates",
    "      // instead of the make-up coins alone — the client is handed this very",
    "      // promise (see the dispatch) — and it is also where this tick's skip",
    "      // stamp comes from, so a reused list never re-writes itself.",
    "      //",
    "      // The caveat that used to live here is gone: the fetch is dispatched with",
    "      // this read's row as a promise, so a refusal that lands first no longer",
    "      // falls back to the make-up lane (live 2026-09-26T23:10-23:11Z: two",
    "      // instant refusals read `profiles 3` under the old shape while the row",
    "      // was two minutes old).",
  ),
  "The caveat that used to live here is gone",
);

apply(
  "the stamp derives from the promised row",
  j(
    "      const profileFeedRow = parseProfileFeedSnapshot(",
    "        front.gates.get(DEX_PROFILES_LAST_KEY) ?? null,",
    "      );",
    "      this.dex.seedLastGoodProfiles(profileFeedRow);",
    "      this.profileFeedStampedAt = profileFeedRow?.at ?? null;",
  ),
  j(
    "      // The row is the SAME promise the fetch was handed (see the dispatch),",
    "      // so the client's reuse seed and this tick's stamp can never disagree",
    "      // about what the row said.",
    "      const profileFeedRow = await profileFeedSeed;",
    "      this.dex.seedLastGoodProfiles(profileFeedRow);",
    "      this.profileFeedStampedAt = profileFeedRow?.at ?? null;",
  ),
  "const profileFeedRow = await profileFeedSeed;",
);

fs.writeFileSync(p, src);
console.log("node docs/patches/round6-seed-promise-scanner-2026-09-26.apply.js — done");
