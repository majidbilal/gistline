import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTables, assessBand, clusterColumns, assignToColumns, tableCaveats, looksLikeHeaderRow,
  MIN_ROWS, MIN_COLUMNS,
} from "./pdf-tables.mjs";

// Tables from coordinates.
//
// A PDF has no concept of a table: there is text at coordinates, and a border may not exist at all. The signal that
// survives is ALIGNMENT — a table's cells line up vertically because that is what makes it a table, and prose does not,
// because a paragraph's words fall wherever the previous word ended.
//
// So the tests are about telling those two apart, and most of them are about NOT finding a table. A false positive turns
// three sentences into a grid, which is worse than leaving a real table as text.

/** A row of cells at fixed x positions, as a line with runs. */
const row = (cells, y, { size = 10 } = {}) => ({
  y,
  size,
  runs: cells.map(([text, x]) => ({ text, x, y, size, width: text.length * size * 0.5 })),
  text: cells.map(([t]) => t).join("  "),
});

/** A four-row, three-column table. */
const table = () => [
  row([["Region", 72], ["Units", 260], ["Revenue", 400]], 700),
  row([["North", 72], ["120", 260], ["12,400", 400]], 686),
  row([["South", 72], ["98", 260], ["9,880", 400]], 672),
  row([["East", 72], ["143", 260], ["15,020", 400]], 658),
];

/** Prose: every line starts at the margin and its words fall wherever the previous word ended. */
const prose = () => [
  row([["The supplier shall perform all duties", 72]], 700),
  row([["set out in the schedule attached", 72]], 686),
  row([["hereto, and shall not subcontract", 72]], 672),
  row([["without prior written consent.", 72]], 658),
];

// --- the gate ---------------------------------------------------------------------------------------------

test("GATE: an aligned grid is recovered as a table with its cells intact", () => {
  const segments = findTables(table());
  const tables = segments.filter((s) => s.type === "table");

  assert.equal(tables.length, 1, `expected one table, got ${JSON.stringify(segments.map((s) => s.type))}`);
  assert.equal(tables[0].columns, 3);
  assert.deepEqual(tables[0].rows[0], ["Region", "Units", "Revenue"]);
  assert.deepEqual(tables[0].rows[1], ["North", "120", "12,400"]);
  assert.deepEqual(tables[0].rows[3], ["East", "143", "15,020"]);
});

test("GATE: prose is NOT a table, however consistently it starts at the margin", () => {
  // The false positive that matters. Every prose line aligns at the left margin trivially, which yields one well-filled
  // column and nothing else — and turning three sentences into a grid is worse than leaving a real table as text.
  const segments = findTables(prose());
  assert.equal(segments.filter((s) => s.type === "table").length, 0);
  assert.equal(segments[0].type, "text");
  assert.equal(segments[0].lines.length, 4);
});

test("GATE: a table inside a page of prose is found, and the prose stays in place", () => {
  // A table lifted out of its position would lose the sentence that introduces it.
  const lines = [
    row([["Sales by region were as follows.", 72]], 740),
    ...table(),
    row([["Growth was strongest in the east.", 72]], 640),
  ];

  const segments = findTables(lines);
  assert.deepEqual(segments.map((s) => s.type), ["text", "table", "text"]);
  assert.match(segments[0].lines[0].text, /as follows/);
  assert.equal(segments[1].rows.length, 4);
  assert.match(segments[2].lines[0].text, /strongest in the east/);
});

// --- refusing to find a table, which is most of the safety ------------------------------------------------

test("two rows is a heading with a line under it, not a table", () => {
  const segments = findTables([
    row([["Item", 72], ["Cost", 260]], 700),
    row([["Setup", 72], ["500", 260]], 686),
  ]);
  assert.equal(segments.filter((s) => s.type === "table").length, 0);
});

test("one column is prose, however many rows it has", () => {
  const lines = Array.from({ length: 10 }, (i0, i) => row([[`line ${i}`, 72]], 700 - i * 14));
  assert.equal(findTables(lines).filter((s) => s.type === "table").length, 0);
  assert.match(assessBand(lines).reason, /column/);
});

test("a column filled in only a FEW rows is coincidental alignment, not a column", () => {
  // Prose produces aligned origins by chance — one long line's second word can land under another's. Requiring most rows
  // to reach the column is what separates a table from justified text.
  const lines = [
    row([["The supplier shall perform", 72]], 700),
    row([["all duties set out in the", 72]], 686),
    row([["schedule", 72], ["attached", 260]], 672),
    row([["hereto and shall not", 72]], 658),
    row([["subcontract without consent", 72]], 644),
  ];
  const v = assessBand(lines);
  assert.equal(v.isTable, false);
  assert.match(v.reason, /coincidental|column/);
});

test("a single-column row in the MIDDLE does not split the table", () => {
  // A subtotal line or a section label inside a table is ordinary, and cutting the table in two there would be worse than
  // keeping it. Only the edges are trimmed.
  const lines = [
    row([["Region", 72], ["Units", 260]], 700),
    row([["North", 72], ["120", 260]], 686),
    row([["Subtotal", 72]], 672),
    row([["South", 72], ["98", 260]], 658),
    row([["East", 72], ["143", 260]], 644),
  ];
  const tables = findTables(lines).filter((s) => s.type === "table");
  assert.equal(tables.length, 1, "the table must not be split in two");
  assert.equal(tables[0].rows.length, 5, "the subtotal row belongs to the table");
});

test("column tolerance scales with font size, so narrow columns are not merged", () => {
  // A fixed number of points would merge two narrow columns in small text or split one wide column in large text.
  const small = clusterColumns([
    row([["a", 72], ["b", 90]], 700, { size: 6 }),
    row([["c", 72], ["d", 90]], 690, { size: 6 }),
  ]);
  assert.equal(small.length, 2, "18pt apart at 6pt type is two columns");

  const large = clusterColumns([
    row([["a", 72], ["b", 90]], 700, { size: 24 }),
    row([["c", 72], ["d", 90]], 660, { size: 24 }),
  ]);
  assert.equal(large.length, 1, "18pt apart at 24pt type is one column with a gap");
});

// --- the honest reporting ---------------------------------------------------------------------------------

test("a suspected merged cell is REPORTED rather than guessed at", () => {
  // The honest version of "merged cells are not supported": produce the grid AND state the suspicion, instead of silently
  // producing a wrong one.
  const caveats = tableCaveats([
    ["Region", "Units", "Revenue"],
    ["North", "120", "12,400"],
    ["Total across all regions", "", ""],
    ["South", "98", "9,880"],
  ]);
  assert.ok(caveats.length > 0, "a row with far fewer filled cells should raise a caveat");
  assert.ok(caveats.some((c) => /merged|span/i.test(c)), `expected a merge caveat, got ${JSON.stringify(caveats)}`);
});

test("a clean table raises no caveats", () => {
  // A check that always fires is not a check.
  const caveats = tableCaveats([["A", "B"], ["1", "2"], ["3", "4"]]);
  assert.deepEqual(caveats, []);
});

test("a header row is recognised when it looks like one, and not when it does not", () => {
  // Text in every cell of the first row, numbers below it, is the overwhelmingly common shape.
  assert.equal(looksLikeHeaderRow([["Region", "Units"], ["North", "120"], ["South", "98"]]), true);
  // All-numeric first row is data, and promoting it would lose a row.
  assert.equal(looksLikeHeaderRow([["1", "2"], ["3", "4"], ["5", "6"]]), false);
});

test("cells are assigned to their nearest column, and content outside the grid is refused", () => {
  const columns = clusterColumns([
    row([["a", 72], ["b", 260]], 700),
    row([["c", 72], ["d", 260]], 686),
  ]);
  const assigned = assignToColumns(row([["x", 74], ["y", 262]], 672), columns);
  assert.deepEqual(assigned, ["x", "y"], "a small offset still lands in its column");
});
