import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32, deflateSync } from "node:zlib";
import { ingest, tryIngest, looksLikeText, UnsupportedFormat } from "./ingest.mjs";
import { gistFile } from "../index.mjs";
import { TRANSFORMS } from "../transforms/legacy.mjs";

// Ingestion.
//
// This is a PRE-STAGE, not a transform: every transform receives text and a spreadsheet is bytes. The tests therefore
// cover format DETECTION and REFUSAL as much as conversion, because "every stage can decline" is the commitment this
// whole document effort rests on.

function makeZipOf(parts) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of parts) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const body = deflateRawSync(data); const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, body]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(parts.length, 8); eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const workbook = (rowCount = 5) => {
  const rows = Array.from({ length: rowCount }, (i0, i) =>
    `<row r="${i + 2}"><c r="A${i + 2}" t="s"><v>2</v></c><c r="B${i + 2}"><v>${100 + i}</v></c></row>`).join("");
  return makeZipOf([
    ["xl/workbook.xml", `<workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<sst><si><t>Name</t></si><si><t>Score</t></si><si><t>Alice</t></si></sst>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>${rows}
    </sheetData></worksheet>`],
  ]);
};

// --- conversion --------------------------------------------------------------------------------------------

test("a workbook is detected from its BYTES and converted to Markdown", () => {
  // Detection is by content, not extension: a .xlsx that is really a CSV is ordinary, and the bytes are the evidence.
  const r = ingest(workbook());
  assert.equal(r.kind, "xlsx");
  assert.equal(r.converted, true);
  assert.match(r.text, /^## Data/m);
  assert.match(r.text, /\| Name \| Score \|/);
  assert.match(r.text, /\| Alice \| 100 \|/);
});

test("the reader's limits come back as notes, not as silence", () => {
  const r = ingest(workbook());
  assert.ok(r.notes.some((n) => /Formulas are shown as their last calculated value/.test(n)));
  assert.ok(r.notes.some((n) => /Read 1 sheet\(s\)/.test(n)));
});

test("HTML is converted; plain text is passed straight through", () => {
  const html = `<html><body><main><h1>Title</h1><p>${"content ".repeat(40)}</p></main></body></html>`;
  assert.equal(ingest(html).kind, "html");
  assert.match(ingest(html).text, /^# Title/m);

  const plain = "just some text, nothing structural about it";
  assert.equal(ingest(plain).kind, "text");
  assert.equal(ingest(plain).text, plain, "text must not be altered");
  assert.equal(ingest(plain).converted, false);
});

test("an empty input is a kind of its own rather than an error", () => {
  assert.equal(ingest(Buffer.alloc(0)).kind, "empty");
  assert.equal(ingest(Buffer.alloc(0)).text, "");
});

// --- refusals: named, with a reason a reader can act on ----------------------------------------------------

test("a readable PDF is now READ; a scan is refused with a specific reason", () => {
  // This test previously asserted that BOTH were refused, and it failed the moment extraction was wired in — correctly.
  // The two cases must diverge: one produces text, the other produces advice.
  const scanned = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n"
    + "2 0 obj\n<< /Length 30 >>\nstream\nq 612 0 0 792 0 0 cm /Im1 Do Q\nendstream\nendobj\n"
    + "trailer\n<< /Root 1 0 R >>\n%%EOF", "latin1");

  const s = tryIngest(scanned, { name: "scan.pdf" });
  assert.equal(s.ok, false);
  assert.equal(s.format, "pdf");
  assert.match(s.reason, /scan\.pdf/);
  assert.match(s.reason, /needs OCR/);

  // A real PDF with a text layer, a font and a Flate content stream.
  const content = "BT /F1 12 Tf 72 700 Td (Contract terms follow.) Tj ET";
  const body = deflateSync(Buffer.from(content, "latin1")).toString("latin1");
  const textual = Buffer.from(
    "%PDF-1.7\n"
    + "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
    + "2 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n"
    + "3 0 obj\n<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
    + `4 0 obj\n<< /Filter /FlateDecode /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`
    + "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n"
    + "trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");

  const t = ingest(textual, { name: "contract.pdf" });
  assert.equal(t.kind, "pdf");
  assert.equal(t.converted, true);
  assert.match(t.text, /Contract terms follow\./);
  assert.ok(t.notes.some((n) => /Read all 1 page/.test(n)));
  // The confidence basis travels with the text, because Tier 1 only claims single-column order.
  assert.ok(t.notes.some((n) => /not verified\s+for multi-column/.test(n)));
});

test("an encrypted PDF gets encryption-specific advice", () => {
  const enc = Buffer.from(
    "%PDF-1.6\n1 0 obj\n<< /Type /Page >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n%%EOF", "latin1");
  const r = tryIngest(enc);
  assert.match(r.reason, /encrypted/);
  assert.match(r.reason, /Remove the password/);
});

test("a pre-2007 Office file is distinguished from a modern one", () => {
  // .doc and .docx are entirely different containers, and telling someone to re-save is actionable.
  const ole = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(100)]);
  const r = tryIngest(ole);
  assert.equal(r.ok, false);
  assert.equal(r.format, "legacy-office");
  assert.match(r.reason, /Re-save it as \.docx/);
});

test("images are refused, and the refusal states the useful fact about them", () => {
  // Token cost is driven by pixel dimensions, so resizing reduces cost with no OCR involved. A refusal that mentions it
  // is more useful than one that only says no.
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(50)]);
  const jpg = Buffer.concat([Buffer.from("ffd8ff", "hex"), Buffer.alloc(50)]);
  const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(50)]);

  for (const img of [png, jpg, gif]) {
    const r = tryIngest(img);
    assert.equal(r.ok, false, "an image must be refused");
    assert.equal(r.format, "image");
    assert.match(r.reason, /pixel dimensions/);
  }
});

test("an ordinary ZIP is refused rather than concatenated", () => {
  // Joining the text files inside an arbitrary archive produces something plausible and meaningless.
  const zip = makeZipOf([["notes.txt", "hello"], ["data.csv", "a,b\n1,2"]]);
  const r = tryIngest(zip, { name: "bundle.zip" });
  assert.equal(r.ok, false);
  assert.equal(r.format, "zip");
  assert.match(r.reason, /reads plausibly and means\s+nothing/);
  assert.match(r.reason, /bundle\.zip/, "the name should be used when given");
});

test("all three Office formats are READ, and detected from their contents", () => {
  // These tests are what stop a reader becoming an orphan. The docx reader was 151 lines of helpers with no entry point
  // until a whole-work check found it, and nothing but a wiring test prevents that recurring.
  const docx = makeZipOf([
    ["word/document.xml", `<w:document><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p>
      <w:p><w:r><w:t>Body text here.</w:t></w:r></w:p>
    </w:body></w:document>`],
  ]);
  const d = ingest(docx);
  assert.equal(d.kind, "docx");
  assert.match(d.text, /^# Report/m);
  assert.match(d.text, /Body text here\./);

  const pptx = makeZipOf([
    ["ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`],
    ["ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree>
      <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>
        <a:p><a:r><a:t>Kickoff</a:t></a:r></a:p></p:txBody></p:sp>
      <p:sp><p:txBody><a:p><a:r><a:t>First point</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:sld>`],
  ]);
  const p = ingest(pptx);
  assert.equal(p.kind, "pptx");
  assert.equal(p.converted, true);
  assert.match(p.text, /^## Kickoff/m);
  assert.match(p.text, /First point/);
  assert.ok(p.notes.some((n) => /Read 1 slide\(s\)/.test(n)));
});

test("unrecognised binary is refused, and lists what IS readable", () => {
  const junk = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42]);
  const r = tryIngest(junk);
  assert.equal(r.ok, false);
  assert.match(r.reason, /\.docx, \.xlsx, \.pptx/);
});

test("looksLikeText uses a NUL byte as the signal, checking only a prefix", () => {
  assert.equal(looksLikeText(Buffer.from("plain text")), true);
  assert.equal(looksLikeText(Buffer.from([0x41, 0x00, 0x42])), false);
  // A NUL far beyond the prefix is not searched for: cheap beats exhaustive on a large file.
  const late = Buffer.concat([Buffer.alloc(8000, 0x41), Buffer.from([0x00])]);
  assert.equal(looksLikeText(late), true);
});

test("tryIngest reports a refusal as data, and does not swallow real errors", () => {
  assert.equal(tryIngest(Buffer.from("%PDF-1.4")).ok, false);
  // A programming error must still throw rather than being reported as an unsupported format.
  assert.throws(() => tryIngest({ then: 1 }));
});

// --- the two stages together -------------------------------------------------------------------------------

test("gistFile converts THEN compresses, and reports both", () => {
  const big = workbook(400);
  const r = gistFile(big, { budget: 2000, label: "sheet", transforms: TRANSFORMS });

  assert.equal(r.ingest.kind, "xlsx");
  assert.equal(r.ingest.converted, true);
  assert.ok(r.ingest.originalBytes > 0, "the bytes that arrived must be reported");
  assert.ok(r.ingest.convertedChars > r.compressedChars, "compression must have reduced the converted text");
  assert.ok(r.compressedChars <= 2000 + 60, `budget not respected: ${r.compressedChars}`);
});

test("gistFile returns the SAME SHAPE for an empty file as for a full one", () => {
  // The trap fixed earlier in `gist`: a function whose result shape depends on its input.
  const r = gistFile(Buffer.alloc(0));
  assert.ok(Array.isArray(r.applied));
  assert.equal(typeof r.lossy, "boolean");
  assert.equal(typeof r.ingest.kind, "string");
});

test("gistFile leaves plain text alone when it already fits", () => {
  const r = gistFile("short text", { budget: 4000 });
  assert.equal(r.compressed, false);
  assert.equal(r.text, "short text");
  assert.equal(r.ingest.converted, false);
});
