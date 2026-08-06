import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_LOSSLESS_GAIN, tabulable, toTable, fromTable, compactDocument, compact,
} from "./lossless.mjs";

// Lossless-first compaction.
//
// The contract under test: every transform here makes content smaller WITHOUT REMOVING ANYTHING. The round-trip tests
// are the ones that matter — they turn "lossless" from an adjective into a checked property.

const people = (n) =>
  Array.from({ length: n }, (i0, i) => ({ id: i + 1, name: `person-${i + 1}`, role: i % 2 ? "admin" : "user", active: i % 3 !== 0 }));

// --- the core claim: round-trip equality ---------------------------------------------------------------

test("a tabulated array reverses to exactly the original", () => {
  const rows = people(20);
  const t = toTable(rows);
  assert.ok(t, "should tabulate");
  assert.deepEqual(fromTable(t.text), rows);
});

test("round-trip survives the values that usually break CSV", () => {
  // Each of these has broken a naive table writer: a comma splits a cell, a quote unbalances one, a newline splits a
  // row, and a leading zero becomes a different number if parsed carelessly.
  const rows = [
    { id: 1, note: "hello, world", tag: 'say "hi"' },
    { id: 2, note: "line one\nline two", tag: "plain" },
    { id: 3, note: "", tag: "trailing space " },
    { id: 4, note: "007", tag: "-12.5" },
  ];
  const t = toTable(rows);
  assert.ok(t);
  const back = fromTable(t.text);
  assert.equal(back[0].note, "hello, world");
  assert.equal(back[0].tag, 'say "hi"');
  assert.equal(back[1].note, "line one\nline two");
  assert.equal(back[3].tag, "-12.5");
});

test("a missing key and a null value stay different", () => {
  // A table has one slot for both, so without an explicit marker `{a:1}` and `{a:1,b:null}` render identically — lossy
  // in a way that is almost impossible to spot.
  const rows = [{ a: 1, b: null }, { a: 2, b: null }, { a: 3 }];
  const t = toTable(rows);
  assert.ok(t);
  const back = fromTable(t.text);
  assert.equal(back[0].b, null, "explicit null must survive");
  assert.ok("b" in back[0]);
  assert.ok(!("b" in back[2]), "an absent key must stay absent, not become null");
});

test("booleans and numbers keep their types", () => {
  const rows = [{ n: 1, f: 1.5, t: true, s: "1" }, { n: 2, f: 2.5, t: false, s: "2" }, { n: 3, f: 3.5, t: true, s: "3" }];
  const back = fromTable(toTable(rows).text);
  assert.equal(typeof back[0].n, "number");
  assert.equal(typeof back[0].f, "number");
  assert.equal(typeof back[0].t, "boolean");
  assert.equal(back[0].s, "1");
  assert.equal(typeof back[0].s, "string", "a numeric-looking STRING must not become a number");
});

// --- when it must DECLINE, which is most of the interesting cases ---------------------------------------

test("declines a ragged array rather than producing a sparse table", () => {
  // A table of mostly-empty cells is larger than the original and harder to read. Declining is the right answer.
  assert.equal(tabulable([{ a: 1 }, { b: 2 }, { c: 3 }]), null);
});

test("declines when any row has a nested value", () => {
  // A nested object in a cell would have to be re-serialised inline, and that is where a 'lossless' table quietly
  // stops being lossless.
  const rows = [{ id: 1, meta: { x: 1 } }, { id: 2, meta: { x: 2 } }, { id: 3, meta: { x: 3 } }];
  assert.equal(tabulable(rows), null);
});

test("declines an array too short to pay for a header row", () => {
  assert.equal(tabulable([{ a: 1 }, { a: 2 }]), null);
});

test("declines arrays of scalars and arrays of arrays", () => {
  assert.equal(tabulable([1, 2, 3, 4]), null);
  assert.equal(tabulable([[1], [2], [3]]), null);
});

test("declines when a key exists on only one row", () => {
  // A shared-key table would silently drop it.
  const rows = [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5, rare: "keep me" }];
  assert.equal(tabulable(rows), null);
});

// --- the gain threshold: declining is a success, not a failure ------------------------------------------

test("a real payload compacts substantially, and reports how much", () => {
  const json = JSON.stringify({ data: people(140) }, null, 2);
  const r = compact(json);
  assert.equal(r.applied, true);
  assert.ok(r.gain > 0.5, `expected >50% lossless gain, got ${(r.gain * 100).toFixed(1)}%`);
  assert.match(r.reason, /nothing removed/);
  assert.equal(r.tables, 1);
});

test("declines below the gain threshold and says why", () => {
  const r = compact(JSON.stringify({ rows: people(3) }), { minGain: 0.95 });
  assert.equal(r.applied, false);
  assert.match(r.reason, /below the 95% threshold/);
  assert.equal(r.text, JSON.stringify({ rows: people(3) }), "the original must come back untouched");
});

test("non-JSON is returned untouched, not mangled", () => {
  const r = compact("this is not json at all");
  assert.equal(r.applied, false);
  assert.equal(r.reason, "not JSON");
  assert.equal(r.text, "this is not json at all");
});

test("valid JSON with nothing tabulable is returned untouched", () => {
  const json = JSON.stringify({ name: "x", nested: { deep: true } });
  const r = compact(json);
  assert.equal(r.applied, false);
  assert.equal(r.reason, "no tabulable arrays");
  assert.equal(r.text, json);
});

test("the declared threshold is a named constant, so the trade-off is visible", () => {
  assert.equal(typeof MIN_LOSSLESS_GAIN, "number");
  assert.ok(MIN_LOSSLESS_GAIN > 0 && MIN_LOSSLESS_GAIN < 1);
});

// --- nested discovery, which is where the real payloads live -------------------------------------------

test("finds a tabulable array nested inside a document", () => {
  // The shape an API actually returns. A top-level-only check finds nothing here.
  const doc = { status: "ok", page: 1, payload: { items: people(30) } };
  const r = compactDocument(doc);
  assert.equal(r.tables, 1);
  assert.ok(r.value.payload.items.__table, "the nested array should become a table");
  assert.equal(r.value.payload.items.__rows, 30);
  assert.equal(r.value.status, "ok", "surrounding shape must be preserved");
  assert.equal(r.value.page, 1);
});

test("tabulates several arrays in one document", () => {
  const doc = { users: people(10), admins: people(8), meta: { count: 18 } };
  const r = compactDocument(doc);
  assert.equal(r.tables, 2);
  assert.equal(r.value.meta.count, 18);
});

test("a tabulated array is marked, not disguised as a string", () => {
  // A bare CSV string in place of an array would look like the original data had a string there.
  const r = compactDocument({ rows: people(5) });
  assert.ok("__table" in r.value.rows);
  assert.ok("__rows" in r.value.rows);
});

// --- determinism, which is the whole positioning -------------------------------------------------------

test("the same input always produces byte-identical output", () => {
  const json = JSON.stringify({ data: people(50) });
  const runs = Array.from({ length: 5 }, () => compact(json).text);
  assert.equal(new Set(runs).size, 1, "output varied between runs");
});

test("column order is stable regardless of key order in the input", () => {
  // Object key order varies between producers; the table must not.
  const a = [{ id: 1, name: "a", role: "x" }, { id: 2, name: "b", role: "y" }, { id: 3, name: "c", role: "z" }];
  const b = [{ role: "x", id: 1, name: "a" }, { name: "b", role: "y", id: 2 }, { id: 3, role: "z", name: "c" }];
  assert.equal(toTable(a).text.split("\n")[0], toTable(b).text.split("\n")[0]);
});

test("compaction never makes the output larger", () => {
  // The guarantee that lets `compact()` be called unconditionally.
  for (const doc of [
    { rows: people(3) },
    { rows: people(200) },
    { a: 1 },
    { mixed: [{ a: 1 }, { b: 2 }, { c: 3 }] },
    { deep: { deeper: { rows: people(12) } } },
  ]) {
    const json = JSON.stringify(doc, null, 2);
    const r = compact(json);
    assert.ok(r.after <= r.before, `output grew: ${r.before} -> ${r.after}`);
  }
});

// --- the limitation, tested so it cannot be forgotten --------------------------------------------------

test("KNOWN LIMITATION: values round-trip exactly, key ORDER does not", () => {
  // Found by checking a realistic payload AFTER the unit tests passed. `assert.deepEqual` ignores key order, so no
  // existing test could see this. A `JSON.stringify` comparison can.
  //
  // Tested rather than hidden: if someone later makes the transform order-preserving, this test fails and tells them
  // the documented behaviour changed.
  const rows = [
    { id: 1, name: "a", email: "x@y.z", role: "user", active: true },
    { id: 2, name: "b", email: "p@q.r", role: "admin", active: false },
    { id: 3, name: "c", email: "s@t.u", role: "user", active: true },
  ];
  const back = fromTable(toTable(rows).text);

  // Every key and value survives.
  assert.deepEqual(back, rows, "values and keys must round-trip exactly");

  // Order does not, and that is the documented trade-off.
  assert.notEqual(
    Object.keys(back[0]).join(","),
    Object.keys(rows[0]).join(","),
    "if key order now survives, update the documented limitation in lossless.mjs",
  );
  assert.notEqual(JSON.stringify(back), JSON.stringify(rows), "stringify is order-sensitive; deepEqual is not");
});

test("column order is frequency-then-alphabetical, which is what makes it deterministic", () => {
  // The reason order is not preserved: a stable order is what lets two producers emitting the same data with
  // different key orders compact to byte-identical output.
  const rows = [
    { zebra: 1, alpha: 2, common: 3 },
    { alpha: 4, common: 5, zebra: 6 },
    { common: 7, zebra: 8, alpha: 9 },
  ];
  assert.equal(toTable(rows).text.split("\n")[0], "alpha,common,zebra");
});

test("a realistic API payload compacts hard and reverses exactly", () => {
  // The end-to-end check that found the key-order limitation. Kept as a test so the headline number is verified
  // rather than quoted from memory.
  const rows = Array.from({ length: 140 }, (i0, i) => ({
    id: i + 1,
    name: `person-${i + 1}`,
    email: `p${i}@example.com`,
    role: i % 2 ? "admin" : "user",
    active: i % 3 !== 0,
    createdAt: `2026-08-0${(i % 9) + 1}`,
  }));

  const json = JSON.stringify({ status: "ok", total: 140, data: rows }, null, 2);
  const r = compact(json);

  assert.equal(r.applied, true);
  assert.ok(r.gain > 0.6, `expected >60% lossless gain on a realistic payload, got ${(r.gain * 100).toFixed(1)}%`);

  const restored = fromTable(JSON.parse(r.text).data.__table);
  assert.deepEqual(restored, rows, "the whole array must come back, all 140 rows");
  assert.equal(restored.length, 140);
});
