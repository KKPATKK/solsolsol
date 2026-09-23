#!/usr/bin/env node
/**
 * Add the host-split tests to scripts/test-unit.js.
 *
 * Written as an apply script rather than a file edit because test-unit.js is
 * past the file-tool window (the same reason, and the same shape, as
 * subreq-counter-tests.apply.js).
 *
 * WHY THESE TWO CASES
 * The phase ring only stamps once a CANDIDATE reaches the chain, and most
 * ticks process none — so on the first live reading (2026-09-23) the killed
 * window published `total 56` with an empty ring. The host split is the axis
 * that survives that case, and these two tests pin exactly the properties the
 * reading depends on: (1) a call is attributed to the host it was sent to, for
 * every target shape a client uses, and the rows always add up to the window
 * total; (2) the rows stay bounded while the folded row keeps the remainder
 * counted, and the split survives the roll into `recent` — which is what makes
 * a KILLED invocation readable at all.
 */
const fs = require("fs");

const T = "scripts/test-unit.js";
const lines = (...xs) => xs.join("\n");

const anchor = "  await test(\"subreqs: a window killed at the budget is read from the next one\", async () => {";

const tests = lines(
  "  await test(\"subreqs: the host split names who spent the window\", async () => {",
  "    // The common failed tick has NO phase point (the ring only stamps once a",
  "    // candidate reaches the chain, and most ticks process none), so the axis",
  "    // that has to localize it is the host split. Measured live 2026-09-23:",
  "    // windows of 34/44/56 subrequests with an empty phase ring.",
  "    resetSubreqWindows();",
  "    beginSubreqWindow(1_000);",
  "    for (let i = 0; i < 3; i += 1) countSubreq(\"https://api.telegram.org/botX/sendMessage\");",
  "    countSubreq(new URL(\"https://solana-meme-db.turso.io/v2/pipeline\"));",
  "    // A Request target (what a client that builds one passes) must land too.",
  "    if (typeof Request === \"function\") {",
  "      countSubreq(new Request(\"https://api.geckoterminal.com/api/v2/networks/solana\"));",
  "    } else {",
  "      countSubreq(\"https://api.geckoterminal.com/api/v2/networks/solana\");",
  "    }",
  "    countSubreq({ url: \"https://api.dexscreener.com/latest/dex/tokens/x\" });",
  "    // An unparseable target is still a spent subrequest, just unnamed.",
  "    countSubreq(\"not a url\");",
  "    const view = subreqView();",
  "    assert.equal(view.current.total, 7);",
  "    assert.deepEqual(view.current.hosts, [",
  "      { host: \"api.telegram.org\", count: 3 },",
  "      { host: \"api.dexscreener.com\", count: 1 },",
  "      { host: \"api.geckoterminal.com\", count: 1 },",
  "      { host: \"solana-meme-db.turso.io\", count: 1 },",
  "      { host: \"(unknown)\", count: 1 },",
  "    ]);",
  "    const sum = view.current.hosts.reduce((n, h) => n + h.count, 0);",
  "    assert.equal(sum, view.current.total, \"the split always adds up to the total\");",
  "  });",
  "",
  "  await test(\"subreqs: the host split is bounded and its remainder stays counted\", async () => {",
  "    resetSubreqWindows();",
  "    beginSubreqWindow(1_000);",
  "    // More distinct hosts than the read row count: the rows stay bounded and",
  "    // the folded row carries the difference, so a reader can still total it.",
  "    const hosts = SUBREQ_HOST_RING + 5;",
  "    for (let i = 0; i < hosts; i += 1) {",
  "      countSubreq(\"https://host\" + String(i).padStart(2, \"0\") + \".example.com/x\");",
  "    }",
  "    const view = subreqView();",
  "    assert.equal(view.current.total, hosts);",
  "    assert.equal(view.current.hosts.length, SUBREQ_HOST_RING + 1);",
  "    assert.equal(",
  "      view.current.hosts[view.current.hosts.length - 1].host,",
  "      SUBREQ_OTHER_HOST,",
  "      \"the remainder is visible, not dropped\",",
  "    );",
  "    assert.equal(",
  "      view.current.hosts.reduce((n, h) => n + h.count, 0),",
  "      hosts,",
  "      \"folding keeps the sum equal to the window total\",",
  "    );",
  "    // The split survives the roll, exactly like the phase ring does — that is",
  "    // what makes a killed window readable from the next tick.",
  "    beginSubreqWindow(2_000);",
  "    assert.equal(subreqView().recent[0].hosts.length, SUBREQ_HOST_RING + 1);",
  "    assert.equal(subreqView().recent[0].hosts[0].count, 1);",
  "  });",
  "",
  anchor,
);

let text = fs.readFileSync(T, "utf8");
const at = text.indexOf(anchor);
if (at < 0) {
  console.error("MISS      test-unit: the killed-window test (anchor)");
  process.exit(1);
}
if (text.indexOf(anchor, at + 1) >= 0) {
  console.error("AMBIGUOUS test-unit: the killed-window test (anchor)");
  process.exit(1);
}
if (text.includes("the host split names who spent the window")) {
  console.error("ALREADY   test-unit: the host-split tests");
  process.exit(1);
}
text = text.slice(0, at) + tests + text.slice(at + anchor.length);
fs.writeFileSync(T, text);
console.log("ok        test-unit: the host-split tests");
