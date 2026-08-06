import { test } from "node:test";
import assert from "node:assert/strict";
import { readingOrder, findGutters, splitAtGutter, naiveOrderDiffers, MIN_LINES } from "./pdf-columns.mjs";
import { parseWidths } from "../util/pdffont.mjs";

// Multi-column reading order.
//
// The gate: a two-column page reads down the left column then down the right, and the naive y-then-x order — which is
// what the standard tools do — is demonstrably different. Half the tests are about NOT claiming columns, because a false
// positive reorders a page that was already correct.

/** A line with a real horizontal extent, which is what column detection needs. */
const line = (text, x, y, width, size = 11) => ({ text, x, y, width, size });

/** A two-column page: left column at x=72 width 200, right at x=320 width 200, gutter 48pt wide. */
const twoColumn = () => [
  ...Array.from({ length: 8 }, (i0, i) => line(`L${i + 1}`, 72, 700 - i * 14, 200)),
  ...Array.from({ length: 8 }, (i0, i) => line(`R${i + 1}`, 320, 700 - i * 14, 200)),
];

/** A single-column page: every line starts at 72 and runs the full measure. */
const oneColumn = () => Array.from({ length: 12 }, (i0, i) => line(`line ${i + 1}`, 72, 700 - i * 14, 448));

// --- the gate ---------------------------------------------------------------------------------------------

test("GATE: a two-column page reads DOWN the left column, then down the right", () => {
  const r = readingOrder(twoColumn());
  assert.equal(r.columns, 2);
  assert.deepEqual(
    r.lines.map((l) => l.text),
    ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"],
  );
});

test("GATE: the naive y-then-x order is demonstrably WRONG on the same page", () => {
  // This is the failure the tier exists to fix: because both columns share each y, sorting by y then x interleaves them
  // and every line becomes two half-sentences spliced together.
  const { differs, naive } = naiveOrderDiffers(twoColumn());
  assert.equal(differs, true, "if the orders agreed, this tier's risk would not be worth taking");
  assert.match(naive, /^L1\nR1\nL2\nR2/, "the naive order interleaves the columns");
});

test("GATE: a single-column page is NOT reordered", () => {
  // A false positive is worse than a miss: it reorders a page that was already correct.
  const lines = oneColumn();
  const r = readingOrder(lines);
  assert.equal(r.columns, 1);
  assert.deepEqual(r.lines.map((l) => l.text), lines.map((l) => l.text));
  assert.match(r.basis, /no vertical gutter/);
});

// --- gutters need EXTENTS, not origins ---------------------------------------------------------------------

test("a gutter is found from line EXTENTS", () => {
  const gutters = findGutters(twoColumn());
  assert.equal(gutters.length, 1);
  assert.equal(gutters[0].from, 272, "the left column ends at 72+200");
  assert.equal(gutters[0].to, 320, "the right column starts at 320");
});

test("without extents there is no gutter to find", () => {
  // The reason /Widths had to exist first: with origins alone, a page of short centred lines looks like it has gutters
  // everywhere, and a page of long lines looks like it has none.
  const noWidths = twoColumn().map((l) => ({ ...l, width: 0 }));
  assert.deepEqual(findGutters(noWidths), []);
});

test("a narrow gap is not a gutter", () => {
  // Word spacing and paragraph indentation create small gaps constantly.
  const lines = [
    ...Array.from({ length: 8 }, (i0, i) => line(`a${i}`, 72, 700 - i * 14, 200)),
    ...Array.from({ length: 8 }, (i0, i) => line(`b${i}`, 280, 700 - i * 14, 200)),
  ];
  // An 8pt gap across a ~408pt text width is under the 4% threshold.
  assert.deepEqual(findGutters(lines), []);
});

// --- refusing to claim columns ------------------------------------------------------------------------------

test("a gutter with too little text on one side is NOT a column", () => {
  // An indented block, a pull quote or a figure caption creates a gutter. Treating it as a column reorders the page
  // around it, which is a corruption rather than an improvement.
  const lines = [
    ...Array.from({ length: 14 }, (i0, i) => line(`body ${i}`, 72, 700 - i * 14, 200)),
    line("caption", 320, 600, 200),
    line("more", 320, 586, 200),
  ];
  const r = readingOrder(lines);
  assert.equal(r.columns, 1);
  assert.match(r.basis, /too little text/);
});

test("a page with too FEW lines does not get a column claim", () => {
  // On a title page, two blocks of text side by side are as likely to be a layout flourish as columns.
  const lines = [line("A", 72, 700, 200), line("B", 320, 700, 200), line("C", 72, 686, 200)];
  const r = readingOrder(lines);
  assert.equal(r.columns, 1);
  assert.match(r.basis, new RegExp(`only ${lines.length} line`));
});

// --- spanning lines ---------------------------------------------------------------------------------------

test("a full-width heading keeps its own section with it", () => {
  // Reading all of the left column then all of the right would move a heading's section above the heading. Segmenting at
  // the spanning line is what prevents that.
  const lines = [
    line("TITLE ACROSS BOTH", 72, 740, 448, 16),
    ...Array.from({ length: 5 }, (i0, i) => line(`L${i + 1}`, 72, 700 - i * 14, 200)),
    ...Array.from({ length: 5 }, (i0, i) => line(`R${i + 1}`, 320, 700 - i * 14, 200)),
    line("MIDDLE HEADING", 72, 600, 448, 14),
    ...Array.from({ length: 4 }, (i0, i) => line(`L${i + 6}`, 72, 570 - i * 14, 200)),
    ...Array.from({ length: 4 }, (i0, i) => line(`R${i + 6}`, 320, 570 - i * 14, 200)),
  ];

  const r = readingOrder(lines);
  const order = r.lines.map((l) => l.text);

  assert.equal(r.columns, 2);
  assert.ok(order.indexOf("TITLE ACROSS BOTH") < order.indexOf("L1"), "the title must precede its section");
  assert.ok(order.indexOf("L5") < order.indexOf("MIDDLE HEADING"), "the first section must finish before the next heading");
  assert.ok(order.indexOf("MIDDLE HEADING") < order.indexOf("L6"), "the heading must precede the section it introduces");
  assert.ok(order.indexOf("R5") < order.indexOf("MIDDLE HEADING"), "including the right column of that section");
});

test("splitAtGutter classifies spanning lines as neither column", () => {
  const lines = [line("left", 72, 700, 200), line("right", 320, 700, 200), line("both", 72, 740, 448)];
  const { left, right, spanning } = splitAtGutter(lines, { from: 272, to: 320 });
  assert.deepEqual(left.map((l) => l.text), ["left"]);
  assert.deepEqual(right.map((l) => l.text), ["right"]);
  assert.deepEqual(spanning.map((l) => l.text), ["both"]);
});

// --- the basis is always stated ----------------------------------------------------------------------------

test("inferred order says it is inferred", () => {
  // An inferred order can be wrong in ways that read perfectly, so the claim must be labelled as an inference.
  const r = readingOrder(twoColumn());
  assert.match(r.basis, /inferred rather than declared/);
});

// --- widths, which this tier depends on ---------------------------------------------------------------------

test("parseWidths reads /Widths from FirstChar", () => {
  const f = parseWidths("<< /FirstChar 65 /Widths [ 722 667 722 ] >>");
  assert.equal(f.of(65), 722);
  assert.equal(f.of(66), 667);
  assert.equal(f.of(67), 722);
  assert.equal(f.known, 3);
});

test("a code outside /Widths falls back rather than returning undefined", () => {
  const f = parseWidths("<< /FirstChar 65 /Widths [ 722 ] >>");
  assert.equal(typeof f.of(200), "number");
});

test("a Type0 font's /W array handles BOTH of its interleaved forms", () => {
  // `c [w w w]` and `cFirst cLast w` appear in the same array. Reading one form loses the other entirely.
  const f = parseWidths("<< /W [ 1 [ 500 600 ] 10 12 750 ] /DW 1000 >>");
  assert.equal(f.of(1), 500);
  assert.equal(f.of(2), 600);
  assert.equal(f.of(10), 750);
  assert.equal(f.of(12), 750);
  assert.equal(f.of(99), 1000, "/DW is the default for a Type0 font");
});

test("a pathological /W range is bounded", () => {
  const f = parseWidths("<< /W [ 0 999999999 500 ] >>");
  assert.ok(f.known <= 65536, `produced ${f.known} entries`);
});
