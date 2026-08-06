import { test } from "node:test";
import assert from "node:assert/strict";
import { split, join, toLines, rank, isInteresting, foldRuns, unfoldRuns } from "./lines.mjs";

// Lines.
//
// This module exists so that "what is a line" is decided once. The round-trip test is the contract: five transforms
// previously made this decision independently, and they agreed only by luck.

// --- the round-trip, which is the whole point ------------------------------------------------------------

test("PROPERTY: join(split(x)) === x for every line shape", () => {
  // Byte-exactness is the claim of the lossless path, so a trailing newline or a CRLF is not a detail.
  const inputs = [
    "", "a", "a\n", "a\nb", "a\nb\n", "\n", "\n\n", "a\n\nb",
    "a\r\nb", "a\r\nb\r\n", "  leading", "trailing  ", "  \n  ",
    "line with, comma\nline with \"quote\"", "a".repeat(1000),
  ];
  for (const x of inputs) {
    assert.equal(join(split(x)), x, `failed to round-trip: ${JSON.stringify(x)}`);
  }
});

test("a trailing newline is remembered, not silently added or dropped", () => {
  assert.equal(split("a\nb").trailing, false);
  assert.equal(split("a\nb\n").trailing, true);
  // The failure this prevents: rejoining without the flag changes the byte count.
  assert.notEqual(join(split("a\nb")), join(split("a\nb\n")));
});

test("CRLF is normalised for processing and restored on join", () => {
  const s = split("a\r\nb\r\n");
  assert.equal(s.crlf, true);
  assert.deepEqual(s.lines, ["a", "b"], "transforms see clean lines");
  assert.equal(join(s), "a\r\nb\r\n", "a Windows log must not become a Unix one as a side effect");
});

test("empty text is zero lines, not one empty line", () => {
  assert.deepEqual(split("").lines, []);
  assert.equal(join(split("")), "");
});

test("toLines is the array-only convenience", () => {
  assert.deepEqual(toLines("a\nb\nc"), ["a", "b", "c"]);
});

// --- ranking: shared so "interesting" cannot drift between transforms -----------------------------------

test("a failure outranks a warning outranks a marker outranks ordinary", () => {
  assert.equal(rank("Error: connection refused"), 3);
  assert.equal(rank("AssertionError: expected 1"), 3);
  assert.equal(rank("warning: deprecated API"), 2);
  assert.equal(rank("# tests 90"), 2);
  assert.equal(rank("=========="), 1);
  assert.equal(rank("    at main (/app/x.mjs:1:1)"), 1);
  assert.equal(rank("processed 142 records"), 0);
});

test("ranking is case-insensitive, because logs are inconsistent", () => {
  for (const s of ["ERROR: x", "Error: x", "error: x", "FAILED", "Timeout"]) {
    assert.equal(rank(s), 3, s);
  }
});

test("isInteresting is the grep test a reader would apply", () => {
  assert.equal(isInteresting("Exception in thread"), true);
  assert.equal(isInteresting("all good"), false);
});

// --- run folding: lossless by construction --------------------------------------------------------------

test("PROPERTY: unfoldRuns(foldRuns(x)) === x", () => {
  const cases = [
    [], ["a"], ["a", "a"], ["a", "a", "b"], ["a", "b", "a"],
    ["x", "x", "x", "y", "y", "z"], Array(50).fill("same"),
  ];
  for (const lines of cases) {
    assert.deepEqual(unfoldRuns(foldRuns(lines)), lines, JSON.stringify(lines));
  }
});

test("folding counts consecutive runs only, so order is preserved", () => {
  // "a,b,a" must stay three entries: collapsing non-adjacent duplicates would reorder the output.
  assert.deepEqual(foldRuns(["a", "b", "a"]), [
    { line: "a", count: 1 }, { line: "b", count: 1 }, { line: "a", count: 1 },
  ]);
  assert.deepEqual(foldRuns(["a", "a", "a"]), [{ line: "a", count: 3 }]);
});

test("camelCase compounds rank as failures, which word boundaries alone miss", () => {
  // `\berror\b` does not match inside `AssertionError`, and these are the commonest failure markers in real test
  // output. A test caught `AssertionError: expected 1` scoring 0, which would have dropped it under budget pressure.
  for (const s of [
    "AssertionError: expected 1 to equal 2",
    "TypeError: x is not a function",
    "ValueError: invalid literal",
    "RuntimeException at line 4",
    "ETIMEDOUT connectTimeout exceeded",
  ]) {
    assert.equal(rank(s), 3, s);
  }
});

test("splitting camelCase does not create false positives", () => {
  // Dropping the right-hand \b instead would have matched these. The case transition is doing real work.
  for (const s of ["terror management", "failsafe engaged", "unassertive tone"]) {
    assert.notEqual(rank(s), 3, s);
  }
});
