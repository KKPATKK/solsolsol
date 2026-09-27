#!/usr/bin/env node
/*
 * Round 6.3, tests (fifth pass): the last stub. It shares its four lines with
 * the fakeDb double already rewritten, so this one anchors on the neighbours
 * that only the bounded-recap test has.
 *
 * Run: node docs/patches/tracker-claim-reserve-merge-tests5-2026-09-27.apply.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const j = (...lines) => lines.join("\n");
const p = path.join(__dirname, "..", "..", "scripts", "test-unit.js");
let src = fs.readFileSync(p, "utf8");

const oldBlock = j(
  "      listPushWatch: async () => rows,",
  "      claimRecapsAndPrune: async (tokens) => ({ won: tokens.map(() => true), pruned: 1 }),",
  "      findUntrackedPushesAndLedger: async () => ({ missing: [], ledgerRaw: null }),",
  "      claimPushWatch: async () => true,",
  "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
  "      claimPushWatchCheck: async () => true,",
  "      reservePushWatchAlert: async () => true,",
);
const newBlock = j(
  "      listPushWatch: async () => rows,",
  "      claimRecapsAndPrune: async (tokens) => ({ won: tokens.map(() => true), pruned: 1 }),",
  "      findUntrackedPushesAndLedger: async () => ({ missing: [], ledgerRaw: null }),",
  "      claimAndReservePushWatch: async () => ({ claimed: true, reserved: true }),",
  "      claimPushWatchChecksMany: async (rows) => rows.map(() => true),",
  "      claimPushWatchCheck: async () => true,",
);

const count = src.split(oldBlock).length - 1;
if (count !== 1) {
  console.error(`✗ test-unit.js: the recap-send stub anchor found ${count} times (need exactly 1)`);
  process.exit(1);
}
fs.writeFileSync(p, src.replace(oldBlock, newBlock));
console.log("✓ test-unit.js: the recap-send stub patched");
console.log("node docs/patches/tracker-claim-reserve-merge-tests5-2026-09-27.apply.js — done");
