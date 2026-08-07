import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeTables, decodeTables, findTables, mdTables } from "./md-tables.mjs";

// Markdown tables, compacted losslessly.
//
// This closes the second measured gap: a spreadsheet reached Markdown losslessly and then the compression stage that followed
// was the LOSSY log path, because a Markdown table already states its headers once — so the only reduction left was dropping
// rows. A table's real redundancy is DOWN THE COLUMNS.
//
// The dangerous half is detection: comma-separated lines also describe prose containing commas. Half these tests are about
// not encoding something that is not a table.

const rows = (n) => Array.from({ length: n }, (i0, i) => [
  `region-${i % 4}`, `rep-${i + 1}`, String(100 + i), (1000 + i * 7.5).toFixed(2), i % 2 ? "admin" : "user", "2026-08-03",
]);

const pipeTable = (n) => {
  const r = rows(n);
  return ["| Region | Rep | Units | Revenue | Role | Closed |", "| --- | --- | --- | --- | --- | --- |",
    ...r.map((x) => `| ${x.join(" | ")} |`)].join("\n");
};

const denseTable = (n) => ["Region,Rep,Units,Revenue,Role,Closed", ...rows(n).map((x) => x.join(","))].join("\n");

const roundTrip = (text) => {
  const { text: encoded, tables } = encodeTables(text);
  return { encoded, tables, back: decodeTables(encoded) };
};

// --- the property that matters ------------------------------------------------------------------------------

test("PROPERTY: a pipe table round-trips EXACTLY, separator included", () => {
  // "Equivalent-looking" is not good enough. A compressor claiming lossless must return the text it was given, which is why
  // the form and the presence of a separator row are both recorded.
  const input = pipeTable(40);
  const { back, tables } = roundTrip(input);
  assert.equal(tables, 1);
  assert.equal(back, input);
});

test("PROPERTY: a dense table round-trips exactly", () => {
  const input = denseTable(40);
  const { back, tables } = roundTrip(input);
  assert.equal(tables, 1);
  assert.equal(back, input);
});

test("PROPERTY: a table WITHOUT a separator row stays without one", () => {
  const input = ["| A | B |", "| 1 | 2 |", "| 3 | 4 |", "| 5 | 6 |", "| 7 | 8 |", "| 9 | 10 |", "| 11 | 12 |"].join("\n");
  assert.equal(roundTrip(input).back, input);
});

test("PROPERTY: surrounding prose keeps its position", () => {
  // A table lifted out of place would lose the sentence that introduces it.
  const input = `Sales by region were as follows.\n\n${pipeTable(20)}\n\nGrowth was strongest in the east.`;
  const { back } = roundTrip(input);
  assert.equal(back, input);
});

test("PROPERTY: cells containing the delimiter survive", () => {
  const pipe = ["| Cmd | Note |", "| --- | --- |",
    ...Array.from({ length: 8 }, (i0, i) => `| a \\| b | note ${i} |`)].join("\n");
  assert.equal(roundTrip(pipe).back, pipe);

  const dense = ["Cmd,Note", ...Array.from({ length: 8 }, (i0, i) => `"a, b",note ${i}`)].join("\n");
  assert.equal(roundTrip(dense).back, dense);
});

test("PROPERTY: a quote inside a dense cell survives", () => {
  const input = ["Cmd,Note", ...Array.from({ length: 8 }, (i0, i) => `"say ""hi""",note ${i}`)].join("\n");
  assert.equal(roundTrip(input).back, input);
});

// --- the win -------------------------------------------------------------------------------------------------

test("a table with repeating columns compacts substantially", () => {
  // The columns here are what a real spreadsheet looks like: a cycling region, an incrementing id, a constant date.
  const input = denseTable(300);
  const { encoded, back } = roundTrip(input);

  assert.equal(back, input, "must be lossless");
  const saved = (input.length - encoded.length) / input.length;
  assert.ok(saved > 0.3, `expected over 30% on a repetitive table, got ${(saved * 100).toFixed(1)}%`);
});

test("the transform reports what it did, and reports it as lossless", () => {
  const r = mdTables.run({ text: denseTable(50), budget: 1000 });
  assert.equal(r.applied, true);
  assert.match(r.reason, /1 table\(s\) encoded by column, nothing removed/);
  assert.equal(mdTables.lossless, true);
});

// --- refusing to encode, which is the safety half ------------------------------------------------------------

test("PROSE containing commas is NOT treated as a table", () => {
  // The dangerous false positive. Prose does not hold a constant comma count for six consecutive lines; a table does.
  const prose = [
    "The supplier shall perform all duties, obligations and services",
    "set out in the schedule, and shall not subcontract",
    "without prior written consent, which may be withheld",
    "at the sole discretion of the client, acting reasonably",
    "and in accordance with the terms, conditions and covenants",
    "recorded herein, including any amendments",
  ].join("\n");

  const { tables } = roundTrip(prose);
  assert.equal(tables, 0, "prose must not be encoded as a table");
});

test("a table too SHORT to pay for a header is left alone", () => {
  const small = ["| A | B |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |"].join("\n");
  assert.equal(roundTrip(small).tables, 0);
  assert.equal(roundTrip(small).back, small, "and it comes back untouched");
});

test("a single-column list is not a table", () => {
  // One field per line is a list. Encoding it as a table would add a header for no gain.
  const list = Array.from({ length: 20 }, (i0, i) => `item ${i}`).join("\n");
  assert.equal(roundTrip(list).tables, 0);
});

test("lines with INCONSISTENT field counts are not a table", () => {
  const ragged = ["a,b,c", "d,e", "f,g,h,i", "j,k", "l,m,n", "o,p"].join("\n");
  assert.equal(roundTrip(ragged).tables, 0);
});

test("the transform DECLINES rather than growing the output", () => {
  const r = mdTables.run({ text: "no table here at all, just a sentence with commas\n".repeat(20), budget: 1000 });
  assert.equal(r.applied, false);
  assert.ok(r.reason);
});

test("text with no table at all is returned unchanged", () => {
  const prose = "Plain prose with no structure whatsoever. ".repeat(30);
  const { text, tables } = encodeTables(prose);
  assert.equal(tables, 0);
  assert.equal(text, prose);
});

// --- detection ----------------------------------------------------------------------------------------------

test("findTables returns segments in document order", () => {
  const input = `intro line\n\n${pipeTable(10)}\n\noutro line`;
  const segments = findTables(input);
  assert.deepEqual(segments.map((s) => s.type), ["text", "table", "text"]);
  assert.match(segments[0].lines.join("\n"), /intro line/);
  assert.match(segments[2].lines.join("\n"), /outro line/);
});

test("two tables in one document are both found", () => {
  const input = `${pipeTable(10)}\n\nbetween\n\n${denseTable(10)}`;
  assert.equal(findTables(input).filter((s) => s.type === "table").length, 2);
});

test("applies() is cheap and declines short or table-free input", () => {
  assert.equal(mdTables.applies({ text: "| A | B |", budget: 1000 }), false, "too short");
  assert.equal(mdTables.applies({ text: "x".repeat(500), budget: 1000 }), false, "no delimiter at all");
  assert.equal(mdTables.applies({ text: denseTable(40), budget: 1000 }), true);
});
