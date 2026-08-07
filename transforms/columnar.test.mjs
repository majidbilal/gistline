import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeColumn, decodeColumn, encodeDelta, decodeDelta, encodeDict, decodeDict,
  encodeRuns, decodeRuns, encodeStamps, decodeStamps, ENCODINGS,
} from "./columnar.mjs";

// Columnar encoding.
//
// This closes the largest measured gap: logs at 29.2% against JSON's 67.9%. The cause is structural — templating removes the
// format words but a timestamp still has to be emitted, so it MOVES rather than shrinks.
//
// Every encoding here has a reverse function and a round-trip test, because that is the one rule that does not bend. And
// every choice is MEASURED rather than predicted: a heuristic like "timestamps ascend, so use delta" is true of most logs
// and wrong on a log with interleaved sources, where being wrong means being LARGER.

const roundTrip = (values) => {
  const { encoding, text } = encodeColumn(values);
  const back = decodeColumn(encoding, text);
  return { encoding, text, back };
};

// --- the property that matters ------------------------------------------------------------------------------

test("PROPERTY: every column round-trips exactly, whatever encoding wins", () => {
  const columns = [
    ["2026-08-03T14:22:01Z", "2026-08-03T14:22:04Z", "2026-08-03T14:22:09Z", "2026-08-03T14:22:11Z"],
    ["worker-1", "worker-2", "worker-3", "worker-1", "worker-2", "worker-3"],
    ["INFO", "INFO", "INFO", "INFO", "WARN", "INFO"],
    ["1", "2", "3", "4", "5", "6"],
    ["a", "b", "c", "d", "e", "f", "g"],
    ["", "", "", ""],
    ["1200.5", "1201.5", "1202.5", "1203.5"],
    ["-5", "-3", "0", "7"],
    ["007", "008", "009", "010"],
    ["value,with,commas", "another,one", "value,with,commas", "another,one"],
    ['has "quotes"', "has 'apostrophes'", 'has "quotes"', "plain"],
    ["line\nbreak", "another\nbreak", "line\nbreak", "x"],
  ];

  for (const col of columns) {
    const { encoding, back } = roundTrip(col);
    assert.deepEqual(back, col, `${encoding} did not reproduce: ${JSON.stringify(col.slice(0, 3))}`);
  }
});

test("PROPERTY: an encoding is never larger than verbatim", () => {
  // The one outcome a compressor must not produce. Every encoding is measured against the baseline and discarded if bigger.
  const columns = [
    ["5", "9000", "12", "77777"],            // deltas larger than the values
    ["a", "b", "c", "d", "e", "f", "g", "h"], // all distinct, so a dictionary cannot pay
    ["x", "y", "x", "y", "x", "y"],           // alternating, so runs cannot pay
  ];

  for (const col of columns) {
    const { text } = encodeColumn(col);
    const verbatim = col.join("\u0002");
    assert.ok(text.length <= verbatim.length, `encoded ${text.length} > verbatim ${verbatim.length}`);
  }
});

// --- timestamps: where a log's cost actually is --------------------------------------------------------------

test("a timestamp column collapses to deltas, and this is the big win", () => {
  const stamps = Array.from({ length: 100 }, (i0, i) => {
    const s = new Date(Date.UTC(2026, 7, 3, 14, 22, 1) + i * 3000).toISOString().replace(/\.\d{3}Z$/, "Z");
    return s;
  });

  const { encoding, text, back } = roundTrip(stamps);
  const verbatim = stamps.join("\u0002");

  assert.deepEqual(back, stamps, "must reproduce exactly");
  assert.equal(encoding, "stamps");
  const saved = (verbatim.length - text.length) / verbatim.length;
  assert.ok(saved > 0.7, `expected over 70% on a timestamp column, got ${(saved * 100).toFixed(1)}%`);
});

test("the EXACT string form is reproduced, not merely the same instant", () => {
  // `…14:22:01Z` and `…14:22:01.000Z` are the same instant and different strings. A compressor claiming lossless must
  // return the one it was given.
  for (const shape of [
    ["2026-08-03T14:22:01Z", "2026-08-03T14:22:04Z", "2026-08-03T14:22:09Z", "2026-08-03T14:22:11Z"],
    ["2026-08-03T14:22:01.000Z", "2026-08-03T14:22:04.000Z", "2026-08-03T14:22:09.000Z", "2026-08-03T14:22:11.000Z"],
    ["2026-08-03 14:22:01", "2026-08-03 14:22:04", "2026-08-03 14:22:09", "2026-08-03 14:22:11"],
  ]) {
    const back = decodeStamps(encodeStamps(shape));
    assert.deepEqual(back, shape, `shape not preserved: ${shape[0]}`);
  }
});

test("a MIXED timestamp column is declined rather than normalised", () => {
  // Handling it would need per-row metadata, which costs more than it saves — and normalising would silently change the
  // text. Declining is correct, and the generic encodings still get their turn.
  assert.equal(encodeStamps(["2026-08-03T14:22:01Z", "2026-08-03 14:22:04"]), null);
  assert.equal(encodeStamps(["2026-08-03T14:22:01Z", "2026-08-03T14:22:04.500Z"]), null);
});

test("timestamps going BACKWARDS still round-trip", () => {
  // A log with interleaved sources is not monotonic. Negative deltas must work.
  const stamps = ["2026-08-03T14:22:09Z", "2026-08-03T14:22:01Z", "2026-08-03T14:22:30Z", "2026-08-03T14:22:05Z"];
  assert.deepEqual(decodeStamps(encodeStamps(stamps)), stamps);
});

test("a non-timestamp column is declined by the timestamp encoder", () => {
  assert.equal(encodeStamps(["not", "a", "timestamp", "at all"]), null);
  assert.equal(encodeStamps(["2026-13-45T99:99:99Z", "x", "y", "z"]), null);
});
