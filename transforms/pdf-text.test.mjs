import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { readLiteral, readHex, tokenise, runContentStream, groupIntoLines, joinLine, extractPage, buildPageFonts } from "./pdf-text.mjs";
import { loadPdf, pageOrder, pageContent } from "../util/pdfobj.mjs";
import { makeFontDecoder } from "../util/pdffont.mjs";

// PDF text extraction — Tier 1.
//
// The gate is end to end: a PDF built with real Flate streams produces readable text, in reading order, with spaces in
// the right places. Everything else here is a specific failure mode that would otherwise look like random text loss.

// --- string literals: where a naive tokeniser loses text ---------------------------------------------------

test("parentheses NEST, so a string containing them is not truncated", () => {
  // Scanning for the first `)` cuts this at "a (b". Citations and emoticons make it common enough that the loss looks
  // random rather than systematic.
  const { bytes } = readLiteral("(a (b) c)", 0);
  assert.equal(bytes.toString("latin1"), "a (b) c");
});

test("an escaped parenthesis does not close the string", () => {
  const { bytes } = readLiteral("(smile :\\) done)", 0);
  assert.equal(bytes.toString("latin1"), "smile :) done");
});

test("octal escapes are read as 1 to 3 digits, not a fixed three", () => {
  // `\1013` is "A" followed by "3". Reading three digits blindly would consume the 3.
  assert.equal(readLiteral("(\\101)", 0).bytes.toString("latin1"), "A");
  assert.equal(readLiteral("(\\1013)", 0).bytes.toString("latin1"), "A3");
  assert.equal(readLiteral("(\\0)", 0).bytes[0], 0);
});

test("named escapes and line continuations", () => {
  assert.equal(readLiteral("(a\\nb)", 0).bytes.toString("latin1"), "a\nb");
  assert.equal(readLiteral("(a\\tb)", 0).bytes.toString("latin1"), "a\tb");
  assert.equal(readLiteral("(a\\\\b)", 0).bytes.toString("latin1"), "a\\b");
  // A backslash before a newline is a continuation and contributes nothing.
  assert.equal(readLiteral("(ab\\\ncd)", 0).bytes.toString("latin1"), "abcd");
});

test("an unterminated string returns what it read rather than nothing", () => {
  // A truncated stream still contains real text, and discarding it would lose the last page of a damaged file.
  assert.equal(readLiteral("(hello", 0).bytes.toString("latin1"), "hello");
});

test("hex strings decode, and an odd digit is padded", () => {
  assert.equal(readHex("<48656C6C6F>", 0).bytes.toString("latin1"), "Hello");
  assert.equal(readHex("<41 42 43>", 0).bytes.toString("latin1"), "ABC", "whitespace inside is ignored");
  assert.equal(readHex("<414>", 0).bytes.toString("hex"), "4140", "an odd final digit is padded with zero");
});

// --- the tokeniser ----------------------------------------------------------------------------------------

test("operands accumulate and an operator consumes them", () => {
  const ops = [...tokenise("72 720 Td (Hi) Tj")];
  assert.deepEqual(ops.map((o) => o.op), ["Td", "Tj"]);
  assert.equal(ops[0].args.length, 2);
  assert.equal(ops[1].args[0].bytes.toString("latin1"), "Hi");
});

test("an unknown operator is harmless because its operands are cleared", () => {
  // Otherwise a stray operator's operands would be consumed by the NEXT operator, corrupting a position or a font size.
  const ops = [...tokenise("1 2 3 zzz 72 720 Td")];
  assert.equal(ops[ops.length - 1].op, "Td");
  assert.equal(ops[ops.length - 1].args.length, 2, "Td must see only its own two operands");
});

test("a TJ array keeps its strings and kerning numbers in order", () => {
  const [{ op, args }] = [...tokenise("[(A) -250 (B)] TJ")];
  assert.equal(op, "TJ");
  assert.equal(args[0].items.length, 3);
  assert.equal(args[0].items[1].v, -250);
});

test("comments and marked-content dictionaries are skipped", () => {
  const ops = [...tokenise("% a comment\n<< /MCID 0 >> BDC (x) Tj EMC")];
  assert.ok(ops.some((o) => o.op === "Tj"));
  assert.ok(!ops.some((o) => o.op === "MCID"));
});

// --- the text state machine -------------------------------------------------------------------------------

const F = new Map([["F1", makeFontDecoder({ baseEncoding: "/WinAnsiEncoding" })]]);

test("TD sets the leading to the NEGATIVE of its vertical move", () => {
  // Missing that makes every later `T*` move by zero and the whole page collapses onto one line — a spectacular failure
  // that is invisible in the code.
  const { runs } = runContentStream(
    "BT /F1 12 Tf 72 700 Td 0 -14 TD (first) Tj T* (second) Tj ET", { fonts: F });
  assert.equal(runs.length, 2);
  assert.ok(runs[0].y > runs[1].y, "the second line must be below the first");
  assert.ok(Math.abs((runs[0].y - runs[1].y) - 14) < 0.01, `expected a 14pt step, got ${runs[0].y - runs[1].y}`);
});

test("T* uses the leading set by TL", () => {
  const { runs } = runContentStream("BT /F1 10 Tf 72 700 Td 20 TL (a) Tj T* (b) Tj ET", { fonts: F });
  assert.ok(Math.abs((runs[0].y - runs[1].y) - 20) < 0.01);
});

test("cm is COMPOSED with the text matrix, not ignored", () => {
  // A page that draws its body inside a translated coordinate system has its real y in the product. Tracking only Tm
  // gives coordinates that are internally consistent and wrong relative to the page — lines in the right order, columns
  // indistinguishable.
  const withCm = runContentStream("q 1 0 0 1 0 500 cm BT /F1 12 Tf 0 100 Td (x) Tj ET Q", { fonts: F });
  const without = runContentStream("BT /F1 12 Tf 0 100 Td (x) Tj ET", { fonts: F });
  assert.equal(without.runs[0].y, 100);
  assert.equal(withCm.runs[0].y, 600, "the graphics translation must be applied");
});

test("q and Q restore the graphics state", () => {
  const { runs } = runContentStream(
    "q 1 0 0 1 0 500 cm BT /F1 12 Tf 0 0 Td (a) Tj ET Q BT /F1 12 Tf 0 0 Td (b) Tj ET", { fonts: F });
  assert.equal(runs[0].y, 500);
  assert.equal(runs[1].y, 0, "Q must undo the translation");
});

test("a large negative kern in TJ becomes a SPACE", () => {
  // Justified text is set this way: the space between words is a kerning adjustment, not a character. Extracting only the
  // strings runs every word together.
  const { runs } = runContentStream("BT /F1 12 Tf 72 700 Td [(Hello) -600 (world)] TJ ET", { fonts: F });
  const joined = runs.map((r) => r.text).join("");
  assert.match(joined, /Hello world/);
});

test("a small kern does NOT become a space", () => {
  // Ordinary letter kerning is a small adjustment, and inserting a space for it would break words apart.
  const { runs } = runContentStream("BT /F1 12 Tf 72 700 Td [(A) -20 (V)] TJ ET", { fonts: F });
  assert.equal(runs.map((r) => r.text).join(""), "AV");
});

test("the quote operators move to the next line and show text", () => {
  const { runs } = runContentStream("BT /F1 10 Tf 72 700 Td 15 TL (one) Tj (two) ' 0 0 (three) \" ET", { fonts: F });
  assert.deepEqual(runs.map((r) => r.text), ["one", "two", "three"]);
  assert.ok(runs[0].y > runs[1].y && runs[1].y > runs[2].y, "each must be on its own line");
});

// --- lines and spacing ------------------------------------------------------------------------------------

test("lines are ordered TOP TO BOTTOM, because PDF's origin is the bottom-left", () => {
  // Sorting y ascending prints the document upside down.
  const lines = groupIntoLines([
    { text: "bottom", x: 72, y: 100, size: 12 },
    { text: "top", x: 72, y: 700, size: 12 },
    { text: "middle", x: 72, y: 400, size: 12 },
  ]);
  assert.deepEqual(lines.map((l) => l.runs[0].text), ["top", "middle", "bottom"]);
});

test("runs on the same line are ordered by x regardless of draw order", () => {
  const [line] = groupIntoLines([
    { text: "second", x: 200, y: 700, size: 12 },
    { text: "first", x: 72, y: 700, size: 12 },
  ]);
  assert.deepEqual(line.runs.map((r) => r.text), ["first", "second"]);
});

test("the line tolerance scales with font size, so a superscript joins its line", () => {
  // One absolute threshold cannot suit a 24pt heading and an 8pt footnote on the same page.
  const lines = groupIntoLines([
    { text: "x", x: 72, y: 700, size: 10 },
    { text: "2", x: 80, y: 704, size: 6 },
  ]);
  assert.equal(lines.length, 1, "a superscript must not become its own line");
});

test("a GAP between runs becomes a space", () => {
  // Where most extractors visibly fail: a PDF frequently draws each word as its own run with no space character anywhere,
  // and the space is the distance. Joining without measuring gives "thesupplierhallnot".
  const [line] = groupIntoLines([
    { text: "the", x: 72, y: 700, size: 12 },
    { text: "supplier", x: 140, y: 700, size: 12 },
  ]);
  assert.equal(joinLine(line), "the supplier");
});

test("adjacent runs with no gap are NOT separated", () => {
  // The other half: a word split across runs by a font change must stay one word.
  const [line] = groupIntoLines([
    { text: "sub", x: 72, y: 700, size: 12 },
    { text: "contract", x: 72 + 3 * 6, y: 700, size: 12 },
  ]);
  assert.equal(joinLine(line), "subcontract");
});

// --- the end-to-end gate ----------------------------------------------------------------------------------

/** Build a real PDF with a Flate-compressed content stream and a WinAnsi font. */
function realPdf(content, { fontExtra = "/BaseFont /Helvetica /Encoding /WinAnsiEncoding" } = {}) {
  const body = deflateSync(Buffer.from(content, "latin1")).toString("latin1");
  return Buffer.from(
    `%PDF-1.7\n`
    + `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
    + `2 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n`
    + `3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`
    + `4 0 obj\n<< /Filter /FlateDecode /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`
    + `5 0 obj\n<< /Type /Font /Subtype /Type1 ${fontExtra} >>\nendobj\n`
    + `trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

/** Read the first page of a PDF buffer, the way a caller would. */
function readFirstPage(buf) {
  const { bytes, objects } = loadPdf(buf);
  const { pages } = pageOrder(bytes, objects);
  const { text: content } = pageContent(bytes, objects, pages[0]);
  const fonts = buildPageFonts(bytes, objects, objects.get(pages[0]));
  return extractPage(content, { fonts });
}

test("GATE: a real PDF yields readable text in reading order", () => {
  const pdf = realPdf(`
    BT /F1 18 Tf 72 720 Td (Service Agreement) Tj ET
    BT /F1 11 Tf 72 690 Td 14 TL (The supplier shall) Tj T* (not subcontract without consent.) Tj ET
    BT /F1 11 Tf 72 640 Td [(Fee:) -500 (2500 per month)] TJ ET
  `);

  const page = readFirstPage(pdf);

  assert.match(page.text, /^Service Agreement$/m);
  assert.match(page.text, /^The supplier shall$/m);
  assert.match(page.text, /^not subcontract without consent\.$/m);
  assert.match(page.text, /Fee: 2500 per month/, "a kerning gap must become a space");

  // Reading order: the heading first, the fee last.
  const lines = page.text.split("\n");
  assert.equal(lines[0], "Service Agreement");
  assert.match(lines[lines.length - 1], /Fee:/);
});

test("GATE: text drawn out of order still comes out in reading order", () => {
  // A generator may emit the footer before the body. Position decides the order, not the draw sequence.
  const page = readFirstPage(realPdf(`
    BT /F1 10 Tf 72 100 Td (Page 1 of 1) Tj ET
    BT /F1 16 Tf 72 720 Td (Title) Tj ET
    BT /F1 11 Tf 72 600 Td (Body paragraph.) Tj ET
  `));
  assert.deepEqual(page.text.split("\n"), ["Title", "Body paragraph.", "Page 1 of 1"]);
});

test("GATE: smart quotes and dashes survive the font ladder", () => {
  // WinAnsi codes 0x91-0x97. Getting these wrong is visible in the first paragraph of a real document.
  const page = readFirstPage(realPdf(`BT /F1 11 Tf 72 700 Td (\\221quoted\\222 \\226 dash) Tj ET`));
  assert.match(page.text, /\u2018quoted\u2019 \u2013 dash/);
});

test("GATE: a subset font with Differences is read correctly", () => {
  // The path that makes subsetted fonts readable, end to end. The codes are arbitrary; the glyph names say what they are.
  const page = readFirstPage(realPdf(
    `BT /F1 11 Tf 72 700 Td <0102030304> Tj ET`,
    { fontExtra: "/BaseFont /ABCDEF+Subset /Encoding << /Differences [ 1 /H /e /l /o ] >>" },
  ));
  assert.match(page.text, /Hello/);
  assert.equal(page.reliability, 1, "every code resolved");
});

test("reliability drops when codes cannot be mapped, so a caller can refuse the page", () => {
  // Identity encoding with no ToUnicode: the honest failure. A ratio is evidence; silence would look like success.
  const page = readFirstPage(realPdf(
    `BT /F1 11 Tf 72 700 Td <00240025> Tj ET`,
    { fontExtra: "/Subtype /Type0 /BaseFont /ABCDEF+CID /Encoding /Identity-H" },
  ));
  assert.ok(page.reliability < 0.5, `expected low reliability, got ${page.reliability}`);
  assert.ok(page.unmapped > 0);
});

test("every extraction states its confidence BASIS", () => {
  // The basis text CHANGED when Tier 2 landed, and this test failing was correct: it previously asserted "not verified
  // for multiple columns", which was Tier 1's honest limit. Now columns are checked, so the basis says what was found
  // rather than what was unexamined.
  const page = readFirstPage(realPdf(`BT /F1 11 Tf 72 700 Td (x) Tj ET`));
  assert.equal(page.columns, 1);
  assert.match(page.basis, /single column/);
});

test("a page's line extents are MEASURED when the font declares widths", () => {
  // Column detection depends on this. Without real widths every line's edge is an estimate, and one badly-measured line
  // can invent or erase a gutter.
  const page = readFirstPage(realPdf(
    `BT /F1 11 Tf 72 700 Td (Hello world) Tj ET`,
    { fontExtra: "/BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /Widths [ 278 " + Array(94).fill(556).join(" ") + " ]" },
  ));
  const [line] = page.positioned;
  assert.equal(line.measured, true, "the width should come from the font, not an estimate");
  assert.ok(line.width > 0);
  // 11 characters at ~556/1000 em of 11pt is roughly 65pt; the estimate would have said 60.5.
  assert.ok(line.width > 50 && line.width < 90, `implausible measured width: ${line.width}`);
});

test("a font with NO declared widths falls back and says so", () => {
  const page = readFirstPage(realPdf(`BT /F1 11 Tf 72 700 Td (Hello world) Tj ET`));
  const [line] = page.positioned;
  assert.equal(line.measured, false, "an estimated width must be labelled as one");
  assert.ok(line.width > 0, "an estimate is still better than nothing");
});

test("an empty page yields empty text rather than throwing", () => {
  const page = readFirstPage(realPdf(`q Q`));
  assert.equal(page.text, "");
  assert.equal(page.lines, 0);
});
