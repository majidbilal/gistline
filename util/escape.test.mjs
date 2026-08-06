import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ABSENT, isAmbiguous, encodeValue, encodeRow, decodeBlock, decodeCell, decodeRows,
} from "./escape.mjs";

// Delimiter-safe encoding.
//
// This module exists because the same rules were needed in two places and the second derivation got them wrong. These
// tests are therefore the shared contract: if they pass, both consumers are correct.

const roundTrip = (v, opts) => decodeCell(decodeBlock(encodeValue(v, opts), opts)[0][0]);

// --- the type-preservation problem, which is the hard part -----------------------------------------------

test("a numeric-looking STRING stays a string", () => {
  // Untyped text: once `1` is written, nothing distinguishes the number from the string unless it was quoted.
  assert.equal(roundTrip("1"), "1");
  assert.equal(typeof roundTrip("1"), "string");
  assert.equal(roundTrip("007"), "007", "leading zeros must survive");
  assert.equal(roundTrip("-12.5"), "-12.5");
  assert.equal(typeof roundTrip("-12.5"), "string");
});

test("actual numbers stay numbers", () => {
  assert.equal(roundTrip(1), 1);
  assert.equal(typeof roundTrip(1), "number");
  assert.equal(roundTrip(-12.5), -12.5);
});

test("boolean-looking strings stay strings, real booleans stay booleans", () => {
  assert.equal(roundTrip("true"), "true");
  assert.equal(typeof roundTrip("true"), "string");
  assert.equal(roundTrip(true), true);
  assert.equal(typeof roundTrip(true), "boolean");
});

test("an empty string and null are different", () => {
  assert.equal(roundTrip(""), "");
  assert.equal(typeof roundTrip(""), "string");
  assert.equal(roundTrip(null), null);
});

test("isAmbiguous names exactly the cases that need quoting for type reasons", () => {
  for (const s of ["", "true", "false", "1", "0", "-4", "3.14"]) assert.equal(isAmbiguous(s), true, s);
  for (const s of ["a", "1a", "true story", " 1", "1,2"]) assert.equal(isAmbiguous(s), false, s);
});

// --- delimiters, quotes and newlines --------------------------------------------------------------------

test("values containing the delimiter round-trip", () => {
  assert.equal(roundTrip("hello, world"), "hello, world");
  assert.equal(roundTrip("a|b", { delimiter: "|" }), "a|b");
});

test("values containing quotes round-trip", () => {
  assert.equal(roundTrip('say "hi"'), 'say "hi"');
  assert.equal(roundTrip('""'), '""');
});

test("values containing newlines round-trip, which line-splitting cannot do", () => {
  // The bug that forced stream parsing: split-then-parse breaks the row apart here.
  assert.equal(roundTrip("line one\nline two"), "line one\nline two");
  assert.equal(roundTrip("a\nb\nc"), "a\nb\nc");
});

test("quoting is applied only when needed, because unconditional quoting costs the saving", () => {
  assert.equal(encodeValue("plain"), "plain");
  assert.equal(encodeValue("has space"), "has space");
  assert.equal(encodeValue("has,comma"), '"has,comma"');
  assert.equal(encodeValue("1"), '"1"');
});

// --- rows and blocks -------------------------------------------------------------------------------------

test("a row of mixed values round-trips", () => {
  const values = [1, "one", true, null, "1", "a,b", "x\ny"];
  const rows = decodeRows(encodeRow(values));
  assert.deepEqual(rows[0], values);
});

test("ABSENT survives, and is not the same as null", () => {
  const encoded = encodeRow([1, ABSENT, null]);
  const [cells] = decodeRows(encoded);
  assert.equal(cells[0], 1);
  assert.equal(cells[1], ABSENT, "an absent key must stay absent");
  assert.equal(cells[2], null, "an explicit null must stay null");
});

test("multiple rows decode as separate rows", () => {
  const block = [encodeRow([1, "a"]), encodeRow([2, "b"]), encodeRow([3, "c"])].join("\n");
  assert.deepEqual(decodeRows(block), [[1, "a"], [2, "b"], [3, "c"]]);
});

test("a row containing a newline value still decodes as ONE row", () => {
  // The reason decode is a stream: this row spans two physical lines and is still one row.
  const block = [encodeRow([1, "x\ny"]), encodeRow([2, "z"])].join("\n");
  const rows = decodeRows(block);
  assert.equal(rows.length, 2, "a newline inside a value must not create a row");
  assert.equal(rows[0][1], "x\ny");
  assert.equal(rows[1][1], "z");
});

test("a trailing newline does not produce a phantom row", () => {
  assert.equal(decodeRows(`${encodeRow([1, "a"])}\n`).length, 1);
});

test("a custom delimiter is honoured throughout", () => {
  const values = ["a,b", "c|d", 1];
  const rows = decodeRows(encodeRow(values, { delimiter: "|" }), { delimiter: "|" });
  assert.deepEqual(rows[0], values);
  // The comma is NOT special when the delimiter is a pipe, so it must not be quoted.
  assert.equal(encodeValue("a,b", { delimiter: "|" }), "a,b");
});

// --- the property that matters ---------------------------------------------------------------------------

test("PROPERTY: every value in a representative set round-trips exactly", () => {
  // Kept as one property test so a new edge case is added in one place and covered for both consumers.
  const values = [
    null, "", " ", "  a  ", 0, -0, 1, -1, 3.14, -3.14,
    true, false, "true", "false", "0", "007", "1e5", "NaN", "Infinity",
    "plain", "has space", "has,comma", 'has"quote', "has\nnewline", "has\r\ncrlf",
    "∅ looks like the marker", "tab\there", "emoji 🙂", "a".repeat(500),
  ];
  for (const v of values) {
    assert.deepEqual(roundTrip(v), v, `failed to round-trip: ${JSON.stringify(v)}`);
  }
});
