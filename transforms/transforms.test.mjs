import { test } from "node:test";
import assert from "node:assert/strict";
import { gist } from "../index.mjs";
import { TRANSFORMS, LOSSY_TRANSFORMS } from "./legacy.mjs";

// The wired pipeline.
//
// These tests exist because two revisits in a row found work that was BUILT AND NOT CONNECTED — each passing its own
// unit tests while doing nothing in the real path. So these assert connection and end-to-end behaviour, not internals.

const rows = (n) => Array.from({ length: n }, (i0, i) => ({
  id: i + 1,
  name: `person-${i + 1}`,
  email: `p${i}@example.com`,
  role: i % 2 ? "admin" : "user",
  active: i % 3 !== 0,
}));
const payload = (n = 200) => JSON.stringify({ status: "ok", total: n, data: rows(n) }, null, 2);

// --- wiring ---------------------------------------------------------------------------------------------

test("WIRED: conversion runs first, then lossless, then lossy — in that order", () => {
  // Order IS the architecture, and the invariant has three tiers rather than two.
  //
  // The first version of this test asserted `TRANSFORMS[0].lossless === true`, which broke the moment an HTML
  // CONVERTER was added at the front. The test was right to fail and the assertion was too crude: conversion is
  // neither lossless (the markup is gone) nor content-dropping (no text was removed), and it must precede everything
  // because every later stage operates on its output.
  const tier = (t) => (t.contentPreserving ? 0 : t.lossless ? 1 : 2);
  const tiers = TRANSFORMS.map(tier);

  assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b),
    `transforms are out of tier order: ${TRANSFORMS.map((t) => `${t.id}=${tier(t)}`).join(", ")}`);

  assert.equal(TRANSFORMS[0].id, "html-to-markdown", "conversion must be first");
  assert.ok(TRANSFORMS.some((t) => t.lossless === true), "there must be at least one lossless stage");
  assert.equal(TRANSFORMS[TRANSFORMS.length - 1].id, "head-tail", "the last resort must be last");
});

test("WIRED: a conversion is not reported as content loss", () => {
  // `lossless: false` and `contentPreserving: true` together mean "the format changed, the text did not". Collapsing
  // that into one boolean would tell a reader their content had been dropped when it had not.
  const conv = TRANSFORMS.filter((t) => t.contentPreserving);
  assert.ok(conv.length >= 1);
  for (const t of conv) assert.equal(t.lossless, false, `${t.id}: conversion is not reconstructible, so not lossless`);
});

test("WIRED: gist actually runs the pipeline when transforms are supplied", () => {
  const r = gist(payload(), { kind: "json", budget: 9000, transforms: TRANSFORMS });
  assert.ok(r.applied.some((a) => a.id === "json-tables" && a.applied), "json-tables did not run");
});

// --- the point of the whole exercise --------------------------------------------------------------------

test("the lossless path keeps EVERY row; the lossy path does not", () => {
  // The headline claim, stated as a comparison so it cannot be true by accident.
  const lossless = gist(payload(), { kind: "json", budget: 9000, transforms: TRANSFORMS });
  const lossy = gist(payload(), { kind: "json", budget: 9000, transforms: LOSSY_TRANSFORMS });

  assert.equal(lossless.lossy, false, "the lossless path must not report as lossy");
  assert.equal(lossy.lossy, true);

  assert.match(lossless.text, /"__rows":\s*200/, "all 200 rows must be recorded");
  assert.ok(lossless.text.includes("person-200"), "the last row must survive losslessly");
  assert.ok(!lossy.text.includes("person-200"), "the lossy path is expected to drop it");
});

test("a document that fits after lossless compaction never reaches a lossy transform", () => {
  // The stop condition, end to end: this is what stops rows being dropped from something that already fitted.
  const r = gist(payload(), { kind: "json", budget: 9000, transforms: TRANSFORMS });
  const lossyRan = r.applied.filter((a) => a.applied && a.lossless === false);
  assert.deepEqual(lossyRan, [], `a lossy transform ran unnecessarily: ${JSON.stringify(lossyRan)}`);
});

// --- truncatable: two real bugs a revisit caught --------------------------------------------------------

test("an uncuttable output is preferred OVER BUDGET rather than corrupted", () => {
  // Being slightly too large is recoverable. Being quietly wrong is not.
  //
  // Before the fix this returned 452 characters of truncated JSON that looked structured and did not parse. The
  // pipeline tracked `truncatable` and never passed it to later transforms, so the protection existed and did nothing.
  const r = gist(payload(), { kind: "json", budget: 300, transforms: TRANSFORMS });
  assert.ok(r.compressedChars > 300, "an uncuttable document must be allowed to exceed the budget");
  assert.match(r.text, /"__rows":\s*200/, "all rows must still be present");

  const body = r.text.slice(r.text.indexOf("\n") + 1);
  assert.doesNotThrow(() => JSON.parse(body), "the output must still be valid JSON");
});

test("the lossy JSON strategy does not shred a table it does not understand", () => {
  // The second bug: `compressJson` truncates long strings to 200 characters. Run after `json-tables` it would find the
  // compacted table as one long `__table` string and cut it — destroying 200 rows that had just been preserved.
  const r = gist(payload(), { kind: "json", budget: 300, transforms: TRANSFORMS });
  const table = r.text.match(/"__table":\s*"((?:[^"\\]|\\.)*)"/);
  assert.ok(table, "the table string must still be present");
  assert.ok(table[1].length > 1000, `the table was truncated to ${table[1].length} chars`);
});

test("head-tail still protects a truncatable output", () => {
  // The safety net must not have been disabled for content that CAN safely be cut.
  //
  // This test used to also assert the pipeline matched the legacy path BYTE FOR BYTE, which was true when both ended at
  // head-tail. It is no longer: columnar template encoding gets the same log to 93 characters where the legacy path needs
  // 452. Asserting equality would now be asserting that an improvement had not happened, so the check is what actually
  // matters — the pipeline is never WORSE, and the net still engages when it is the transform that applies.
  const log = Array.from({ length: 2000 }, (i0, i) => `2026-08-03 INFO line ${i}`).join("\n");

  const piped = gist(log, { kind: "log", budget: 400, transforms: TRANSFORMS });
  const legacy = gist(log, { kind: "log", budget: 400 });

  assert.ok(piped.compressedChars <= legacy.compressedChars,
    `the pipeline should be no worse: ${piped.compressedChars} vs ${legacy.compressedChars}`);
  assert.ok(piped.compressedChars <= 400 + 60, `budget not respected: ${piped.compressedChars}`);
});

test("head-tail engages when nothing else can reduce the content", () => {
  // The net exists for content with no structure at all: no repeated format, no table, nothing rankable. Prose that simply
  // will not fit. Without this the previous test no longer covers head-tail, since templates now handle the log case.
  const prose = "The quick brown fox jumps over the lazy dog. ".repeat(200);
  const r = gist(prose, { kind: "log", budget: 400, transforms: TRANSFORMS });

  assert.ok(r.compressedChars <= 400 + 60, `budget not respected: ${r.compressedChars}`);
  assert.ok(r.compressedChars < prose.length, "it must actually have reduced");
  assert.ok(r.applied.some((a) => a.applied), "some transform must have run");
});
