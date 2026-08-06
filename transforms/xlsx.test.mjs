import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import {
  readXlsx, readSheet, readSharedStrings, readDateStyles, readSheetIndex, serialToDate, columnIndex,
} from "./xlsx.mjs";
import { toMarkdown } from "../core/markdown.mjs";

// XLSX reading.
//
// The four risks were named in the plan BEFORE this file was written, because every one of them fails SILENTLY:
//   1. inline strings vs shared strings — different code paths; handling one drops text with no error
//   2. dates are numbers plus a format — emitting 45872 for 2026-08-03 looks like success
//   3. formula cells hold a formula and a cached result — the result is what a reader wants
//   4. sparse rows omit empty cells — reading in sequence shifts every later value into the wrong column
//
// Each has a test that would fail if the handling were removed.

/** Build a genuine xlsx. Same reasoning as the ZIP tests: a fixture crafted to satisfy the reader proves only agreement. */
function makeXlsx(parts) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of parts) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const body = deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, body]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8); eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const WORKBOOK = `<workbook><sheets>
  <sheet name="Q3 Sales" sheetId="1" r:id="rId1"/>
  <sheet name="Notes" sheetId="2" r:id="rId2"/>
</sheets></workbook>`;

const RELS = `<Relationships>
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Target="worksheets/sheet2.xml"/>
</Relationships>`;

const SHARED = `<sst count="5">
  <si><t>Region</t></si>
  <si><t>Revenue</t></si>
  <si><t>Closed</t></si>
  <si><t>North</t></si>
  <si><r><t>Very </t></r><r><t>important</t></r></si>
</sst>`;

// numFmtId 14 is a built-in date format; style index 1 points at it.
const STYLES = `<styleSheet>
  <numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>
  <cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>
</styleSheet>`;

const SHEET1 = `<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
  <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1200.5</v></c><c r="C2" s="1"><v>45872</v></c></row>
  <row r="3"><c r="A3" t="inlineStr"><is><t>South</t></is></c><c r="B3"><f>SUM(B2:B2)</f><v>1200.5</v></c><c r="C3" s="2"><v>45900</v></c></row>
  <row r="4"><c r="A4" t="s"><v>4</v></c><c r="C4" t="b"><v>1</v></c></row>
</sheetData></worksheet>`;

const SHEET2 = `<worksheet><sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>Free text with &amp;amp; and &lt;angle&gt;</t></is></c></row>
</sheetData></worksheet>`;

const BOOK = () => makeXlsx([
  ["[Content_Types].xml", "<Types/>"],
  ["xl/workbook.xml", WORKBOOK],
  ["xl/_rels/workbook.xml.rels", RELS],
  ["xl/sharedStrings.xml", SHARED],
  ["xl/styles.xml", STYLES],
  ["xl/worksheets/sheet1.xml", SHEET1],
  ["xl/worksheets/sheet2.xml", SHEET2],
]);

// --- the gate ----------------------------------------------------------------------------------------------

test("GATE: a real multi-sheet workbook converts, with sheet names and correct cells", () => {
  const { document, sheets } = readXlsx(BOOK());
  const md = toMarkdown(document);

  assert.equal(sheets, 2);
  assert.match(md, /^## Q3 Sales/m);
  assert.match(md, /^## Notes/m);
  assert.match(md, /\| Region \| Revenue \| Closed \|/);
  // 45658 is 2025-01-01, so 45872 is 214 days later: 2025-08-03. My first expectation here said 08-04, and the
  // implementation was right — worth recording, because the arithmetic is easy to get wrong in either direction.
  assert.match(md, /\| North \| 1200\.5 \| 2025-08-03 \|/);
});

// --- risk 1: inline strings vs shared strings ---------------------------------------------------------------

test("RISK 1: inline strings are read, not silently dropped", () => {
  // A different code path from shared strings. Handling only the second loses the text with no error at all.
  const md = toMarkdown(readXlsx(BOOK()).document);
  assert.match(md, /South/, "an inlineStr cell was dropped");
  assert.match(md, /Free text with &amp; and <angle>/, "an inlineStr with entities was mangled");
});

test("a shared string split across formatting runs stays whole", () => {
  // Bold in the middle of a sentence produces three <t> runs. Taking the first would truncate it.
  assert.deepEqual(readSharedStrings(SHARED)[4], "Very important");
});

test("entity decoding happens once, not twice", () => {
  // Decoding `&` before the others turns `&amp;lt;` into `<`, silently converting escaped text into markup.
  const [s] = readSharedStrings(`<sst><si><t>&amp;amp; &amp;lt;tag&amp;gt;</t></si></sst>`);
  assert.equal(s, "&amp; &lt;tag&gt;");
});

// --- risk 2: dates are numbers plus a format ----------------------------------------------------------------

test("RISK 2: a date-formatted number becomes a date, not a serial", () => {
  // Emitting 45872 where the sheet shows a date is the failure that LOOKS like success.
  const md = toMarkdown(readXlsx(BOOK()).document);
  assert.ok(!md.includes("45872"), "a raw serial number reached the output");
  assert.match(md, /2025-08-03/);
});

test("a CUSTOM date format is recognised, not only the built-in ids", () => {
  // numFmtId 164 with formatCode dd/mm/yyyy is a date, and nothing but the format code says so.
  const styles = readDateStyles(STYLES);
  assert.ok(styles.has(1), "built-in id 14 not recognised");
  assert.ok(styles.has(2), "custom dd/mm/yyyy not recognised");
  assert.ok(!styles.has(0), "a general-format cell must not be treated as a date");
});

test("a number that is NOT date-formatted stays a number", () => {
  // The other half: treating every number as a date would be worse than treating none as one.
  const md = toMarkdown(readXlsx(BOOK()).document);
  assert.match(md, /1200\.5/);
});

test("a format code with a quoted literal is not mistaken for a date", () => {
  // `"day "0` contains a `d` only inside a quoted string.
  const styles = readDateStyles(`<styleSheet><numFmts><numFmt numFmtId="170" formatCode="&quot;day &quot;0"/></numFmts>
    <cellXfs count="1"><xf numFmtId="170"/></cellXfs></styleSheet>`);
  assert.ok(!styles.has(0));
});

test("serials inside the 1900 leap-year fiction are left unconverted", () => {
  // Excel treats 1900 as a leap year, so serials at or below 60 are ambiguous. A raw number is visibly raw; a wrong date
  // is not.
  assert.equal(serialToDate(1), null);
  assert.equal(serialToDate(60), null);
  assert.equal(serialToDate("nonsense"), null);
  assert.equal(serialToDate(45658), "2025-01-01");
});

test("a serial with a fractional part keeps its time", () => {
  const withTime = serialToDate(45658.5);
  assert.match(withTime, /^2025-01-01 12:00:00$/);
});

// --- risk 3: formula cells ----------------------------------------------------------------------------------

test("RISK 3: a formula cell yields its cached RESULT, not the formula text", () => {
  const md = toMarkdown(readXlsx(BOOK()).document);
  assert.ok(!md.includes("SUM("), "the formula text reached the output");
  // The cached value 1200.5 appears for the formula row.
  assert.ok((md.match(/1200\.5/g) ?? []).length >= 2, "the cached result is missing");
});

test("the formula limitation is STATED, not left for the reader to discover", () => {
  const md = toMarkdown(readXlsx(BOOK()).document);
  assert.match(md, /Formulas are shown as their last calculated value/);
});

// --- risk 4: sparse rows ------------------------------------------------------------------------------------

test("RISK 4: a sparse row places cells by REFERENCE, not by order", () => {
  // The worst failure of the four: reading in sequence shifts every value after a gap into the wrong column, producing a
  // perfectly plausible table with the data in the wrong places.
  const rows = readSheet(`<worksheet><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="D1" t="inlineStr"><is><t>d</t></is></c></row>
  </sheetData></worksheet>`);
  assert.deepEqual(rows[0], ["a", "", "", "d"]);
});

test("column references beyond Z are decoded correctly", () => {
  assert.equal(columnIndex("A1"), 0);
  assert.equal(columnIndex("Z9"), 25);
  assert.equal(columnIndex("AA1"), 26);
  assert.equal(columnIndex("BC12"), 54);
});

test("rows are padded to a common width, so the table is rectangular", () => {
  const rows = readSheet(SHEET1, { strings: readSharedStrings(SHARED), dateStyles: readDateStyles(STYLES) });
  const widths = new Set(rows.map((r) => r.length));
  assert.equal(widths.size, 1, `ragged rows: ${[...widths].join(", ")}`);
});
