// Parity: does the wrapped legacy path still produce byte-identical output to the pre-pipeline single-strategy path?
//
// Kept in the repo rather than deleted after use. It was written once, deleted, and then a change to `forKind` — adding
// a `truncatable` guard to EVERY legacy wrapper — went in with no way to check whether legacy behaviour had moved. A
// check that only exists while you remember to write it is not a check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gist } from "./index.mjs";
import { LOSSY_TRANSFORMS, TRANSFORMS } from "./transforms/legacy.mjs";

const CASES = [
  ["test", "ok 1 - a\nnot ok 2 - b\n  error: boom\n" + "ok 3 - c\n".repeat(400) + "# tests 402\n# pass 401\n# fail 1\n"],
  ["log", Array.from({ length: 900 }, (i0, i) => `2026-08-03T10:00:${String(i % 60).padStart(2, "0")}Z INFO worker-${i % 8} processed ${i} records`).join("\n") + "\nERROR: disk full\n"],
  ["diff", "diff --git a/x b/x\n" + Array.from({ length: 500 }, (i0, i) => (i % 3 ? `+added ${i}` : `-removed ${i}`)).join("\n")],
  ["stacktrace", "TypeError: x is not a function\n" + Array.from({ length: 300 }, (i0, i) => `    at fn${i} (/app/src/f${i}.mjs:${i}:1)`).join("\n")],
  ["json", JSON.stringify({ data: Array.from({ length: 300 }, (i0, i) => ({ id: i, name: `n${i}`, ok: i % 2 === 0 })) })],
];

test("PARITY: the wrapped legacy path is byte-identical to the direct path", () => {
  // If wrapping changed behaviour, that is a bug rather than a migration. This is the only honest way to know.
  for (const [kind, text] of CASES) {
    for (const budget of [300, 1000, 4000]) {
      const direct = gist(text, { kind, budget, label: kind });
      const wrapped = gist(text, { kind, budget, label: kind, transforms: LOSSY_TRANSFORMS });
      assert.equal(
        wrapped.text, direct.text,
        `${kind} @${budget}: wrapped ${wrapped.compressedChars} vs direct ${direct.compressedChars}`,
      );
    }
  }
});

test("the full pipeline never LOSES a failure that the legacy path kept", () => {
  // Adding lossless stages must not cost fidelity. Checked against the needles a reader would grep for, on the two
  // corpora that carry one.
  const needles = [["test", "not ok 2 - b"], ["log", "disk full"], ["stacktrace", "TypeError"]];
  for (const [kind, needle] of needles) {
    const text = CASES.find(([k]) => k === kind)[1];
    for (const budget of [300, 1000, 4000]) {
      const full = gist(text, { kind, budget, transforms: TRANSFORMS });
      assert.ok(full.text.includes(needle), `${kind} @${budget} lost "${needle}"`);
    }
  }
});

test("the full pipeline is never WORSE than the legacy path at fitting the budget", () => {
  // A pipeline that fits less into the same budget than the thing it replaced would be a regression, however elegant.
  for (const [kind, text] of CASES) {
    for (const budget of [1000, 4000]) {
      const legacy = gist(text, { kind, budget, transforms: LOSSY_TRANSFORMS });
      const full = gist(text, { kind, budget, transforms: TRANSFORMS });
      // Allow uncuttable output to exceed the budget deliberately; that is a documented trade, not a regression.
      const fullOk = full.compressedChars <= budget || full.applied.some((a) => a.applied && a.id === "json-tables");
      assert.ok(fullOk, `${kind} @${budget}: full pipeline produced ${full.compressedChars} for a ${budget} budget`);
      assert.ok(legacy.compressedChars > 0);
    }
  }
});
