import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { classifyPdf, describePdf, countPages, fontRecovery, divergenceSignals } from "./pdf-classify.mjs";

// PDF classification — Tier 0.
//
// The gate: a born-digital PDF classifies as text, a scan classifies as scanned and is refused, an encrypted one is
// named as encrypted, and a compressed-stream PDF is NOT mislabelled as a scan.
//
// That last one is the whole difficulty of this tier. Content streams are almost always Flate-compressed, so text
// operators are invisible to a byte scan — and a classifier that reads "no visible Tj" as "no text" would label the
// majority of real PDFs as scans.

/** Build a minimal but structurally real PDF. */
function pdf({ pages = 1, content = "BT /F1 12 Tf 72 720 Td (Hello world) Tj ET", fonts = "", extra = "", compress = false, encrypt = false } = {}) {
  const streamBody = compress ? deflateSync(Buffer.from(content, "latin1")).toString("latin1") : content;
  const filter = compress ? "/Filter /FlateDecode " : "";

  const pageObjs = Array.from({ length: pages }, (i0, i) =>
    `${3 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${100 + i} 0 R /Resources << /Font << /F1 50 0 R >> >> >>\nendobj\n`).join("");

  const contentObjs = Array.from({ length: pages }, (i0, i) =>
    `${100 + i} 0 obj\n<< ${filter}/Length ${streamBody.length} >>\nstream\n${streamBody}\nendstream\nendobj\n`).join("");

  const fontObj = `50 0 obj\n<< /Type /Font /Subtype /Type1 ${fonts || "/BaseFont /Helvetica /Encoding /WinAnsiEncoding"} >>\nendobj\n`;

  return Buffer.from(
    `%PDF-1.7\n`
    + `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
    + `2 0 obj\n<< /Type /Pages /Count ${pages} >>\nendobj\n`
    + pageObjs + contentObjs + fontObj + extra
    + `trailer\n<< /Root 1 0 R ${encrypt ? "/Encrypt 99 0 R " : ""}/Size 200 >>\n%%EOF\n`,
    "latin1",
  );
}

// --- the gate ----------------------------------------------------------------------------------------------

test("GATE: a born-digital PDF classifies as text, with usable signals", () => {
  const c = classifyPdf(pdf({ pages: 3 }));
  assert.equal(c.verdict, "text");
  assert.equal(c.version, "1.7");
  assert.equal(c.pages, 3);
  assert.ok(c.textOps > 0);
  assert.equal(c.fonts.standardEncoding, true);
  assert.match(c.reason, /usable font mapping/);
});

test("GATE: a scan is identified as needing OCR", () => {
  // No text operators, image draws only.
  const c = classifyPdf(pdf({ content: "q 612 0 0 792 0 0 cm /Im1 Do Q", fonts: "/BaseFont /None" }));
  assert.equal(c.verdict, "scanned");
  assert.ok(c.imageOps > 0);
  assert.match(c.reason, /needs OCR/);
});

test("GATE: an encrypted PDF is named as encrypted, and nothing else is claimed about it", () => {
  // Nothing else can be determined from ciphertext, so no other signal would be trustworthy.
  const c = classifyPdf(pdf({ encrypt: true }));
  assert.equal(c.verdict, "encrypted");
  assert.equal(c.encrypted, true);
  assert.match(c.reason, /password-protected/);
});

test("GATE: a PDF with COMPRESSED streams is not mislabelled as a scan", () => {
  // The decisive case for this tier. The text operators are inside the compressed stream and invisible to a byte scan, so
  // their absence proves nothing — and calling this a scan would mislabel most real PDFs.
  const c = classifyPdf(pdf({ compress: true }));
  assert.equal(c.verdict, "mixed");
  assert.ok(c.compressedStreams > 0);
  assert.match(c.reason, /must be decompressed before this can be decided/);
  assert.match(c.reason, /Not a scan on this evidence/);
});

// --- the font recovery ladder -------------------------------------------------------------------------------

test("the ladder reports WHAT EXISTS rather than judging, because paths are per-font", () => {
  // A document commonly mixes them: one font with a ToUnicode CMap and another with only glyph names is ordinary. A
  // single verdict would have to be wrong about one of them.
  const c = classifyPdf(pdf({
    fonts: "/BaseFont /ABCDEF+Custom /Encoding << /Differences [ 65 /A /B ] >>",
    extra: "60 0 obj\n<< /Type /Font /ToUnicode 61 0 R >>\nendobj\n",
  }));
  assert.equal(c.fonts.differences, true);
  assert.equal(c.fonts.toUnicode, 1);
  assert.equal(c.fonts.subsetFonts, 1);
  assert.equal(c.verdict, "text", "one recoverable path is enough to attempt extraction");
});

test("a subset font is NOT treated as unrecoverable on its own", () => {
  // This was my error before the plan was reviewed: I repeated the common claim that a subsetted font makes text
  // unrecoverable. It only does so when NOTHING on the ladder resolves it, and glyph names via the Adobe Glyph List are a
  // real path that summaries of this problem usually omit.
  const c = classifyPdf(pdf({ fonts: "/BaseFont /ABCDEF+Subset /Encoding /WinAnsiEncoding" }));
  assert.equal(c.fonts.subsetFonts, 1);
  assert.equal(c.verdict, "text", "a subset font with a standard encoding is perfectly readable");
});

test("identity encoding with NO recovery path at all is the case that is refused", () => {
  // Raw glyph ids and nothing to map them with. Extracted characters would be glyph numbers rather than letters.
  const c = classifyPdf(pdf({ fonts: "/Subtype /Type0 /BaseFont /ABCDEF+CID /Encoding /Identity-H" }));
  assert.equal(c.fonts.identityEncoded, true);
  assert.equal(c.fonts.toUnicode, 0);
  assert.equal(c.verdict, "mixed");
  assert.match(c.reason, /glyph ids rather than letters/);
});

test("identity encoding WITH a ToUnicode map is readable", () => {
  // The distinction that stops the refusal being too broad.
  const c = classifyPdf(pdf({
    fonts: "/Subtype /Type0 /Encoding /Identity-H",
    extra: "70 0 obj\n<< /Type /Font /ToUnicode 71 0 R >>\nendobj\n",
  }));
  assert.equal(c.fonts.identityEncoded, true);
  assert.ok(c.fonts.toUnicode > 0);
  assert.equal(c.verdict, "text");
});

test("fontRecovery counts fonts and finds each path independently", () => {
  const bytes = "/Type /Font /ToUnicode 1 0 R /Type /Font /Differences [ 65 /A ] /Encoding /MacRomanEncoding";
  const f = fontRecovery(bytes);
  assert.equal(f.fonts, 2);
  assert.equal(f.toUnicode, 1);
  assert.equal(f.differences, true);
  assert.equal(f.standardEncoding, true);
});

// --- divergence: extracted text can differ from what a human sees ------------------------------------------

test("ActualText overrides are counted and surfaced", () => {
  // PDF separates rendering from extraction by design: /ActualText changes what an extractor reports for a span without
  // changing what is drawn. Legitimate for accessibility, and worth surfacing when feeding a model.
  const c = classifyPdf(pdf({ extra: "80 0 obj\n<< /ActualText (something else) >>\nendobj\n" }));
  assert.equal(c.divergence.actualText, 1);
  assert.match(describePdf(c), /1 ActualText override/);
});

test("a tagged PDF is reported neutrally, because structure is usually good news", () => {
  const c = classifyPdf(pdf({ extra: "81 0 obj\n<< /Type /Catalog /StructTreeRoot 82 0 R >>\nendobj\n" }));
  assert.equal(c.divergence.tagged, true);
  assert.equal(c.verdict, "text", "being tagged must not change the verdict");
});

// --- structural robustness ---------------------------------------------------------------------------------

test("text operators are matched only as operators, not inside names", () => {
  // `/FontTJ` and `/DoNotPrint` contain the operator letters. Counting them would inflate the signal and could turn a
  // scan into a false "text" verdict.
  assert.equal(classifyPdf(pdf({ content: "/FontTJ /DoNotPrint /TjName", fonts: "/BaseFont /X" })).textOps, 0);
  assert.equal(classifyPdf(pdf({ content: "BT (a) Tj ET", fonts: "/BaseFont /X" })).textOps, 1);
});

test("all four text-showing operators are counted", () => {
  // A word processor emits TJ where a report writer emits Tj; looking for one finds nothing in half of all files.
  for (const op of ["Tj", "TJ", "'", '"']) {
    const c = classifyPdf(pdf({ content: `BT (a) ${op} ET`, fonts: "/BaseFont /X" }));
    assert.ok(c.textOps > 0, `operator ${op} was not counted`);
  }
});

test("pages are counted from page OBJECTS, not from /Count", () => {
  // /Count appears in intermediate page-tree nodes and is frequently wrong after an incremental update. Counting the
  // objects cannot disagree with itself.
  assert.equal(countPages("/Type /Page /Type /Page /Type /Pages /Count 99"), 2);
  assert.equal(countPages("/Type /Pages /Count 40"), 0, "/Type /Pages must not count as a page");
});

test("a truncated file is DAMAGED, not scanned", () => {
  // The difference decides whether anything is worth attempting.
  const c = classifyPdf(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n", "latin1"));
  assert.equal(c.verdict, "damaged");
  assert.match(c.reason, /truncated or corrupt/);
});

test("a non-PDF is rejected without pretending to know anything else", () => {
  const c = classifyPdf(Buffer.from("<html><body>not a pdf</body></html>"));
  assert.equal(c.verdict, "not-pdf");
  assert.equal(c.pages, 0);
  assert.equal(describePdf(c), "Not a PDF.");
});

test("binary bytes are read as latin-1, so the scan is not corrupted", () => {
  // Decoding a PDF as UTF-8 turns invalid sequences into replacement characters and destroys the patterns being searched
  // for. A file with high bytes must still classify.
  const withBinary = Buffer.concat([
    Buffer.from("%PDF-1.5\n1 0 obj\n<< /Type /Page >>\nendobj\nBT (x) Tj ET\n", "latin1"),
    Buffer.from([0xff, 0xfe, 0x80, 0x81, 0x00, 0x92]),
    Buffer.from("\ntrailer\n<< /Root 1 0 R >>\n%%EOF", "latin1"),
  ]);
  const c = classifyPdf(withBinary);
  assert.equal(c.verdict, "text");
  assert.equal(c.pages, 1);
});

test("describePdf is a single readable line", () => {
  const line = describePdf(classifyPdf(pdf({ pages: 12 })));
  assert.ok(!line.includes("\n"));
  assert.match(line, /PDF 1\.7 · 12 page\(s\) · text/);
});
