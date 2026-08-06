import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, deflateRawSync } from "node:zlib";
import {
  loadPdf, indexObjects, parseDict, refTo, decodeStream, expandObjectStreams, pageOrder, pageContent, PdfError,
} from "./pdfobj.mjs";

// PDF objects and streams.
//
// The gate: objects are found in a file whose xref is absent or wrong, streams inflate, object streams expand, and page
// order comes from the page TREE rather than from the order objects happen to appear.

/** A stream object with a real Flate payload. */
const streamObj = (num, dictExtra, content, { raw = false } = {}) => {
  const body = raw ? deflateRawSync(Buffer.from(content, "latin1")) : deflateSync(Buffer.from(content, "latin1"));
  return `${num} 0 obj\n<< /Filter /FlateDecode /Length ${body.length} ${dictExtra} >>\nstream\n${body.toString("latin1")}\nendstream\nendobj\n`;
};

const wrap = (objs, trailer = "trailer\n<< /Root 1 0 R >>\n%%EOF\n") => Buffer.from(`%PDF-1.7\n${objs}${trailer}`, "latin1");

// --- the gate ----------------------------------------------------------------------------------------------

test("GATE: objects are found by SCANNING, so a broken xref does not matter", () => {
  // The cross-reference table is the most commonly broken part of a real file: stale entries after incremental updates,
  // two tables in a linearised file, offsets wrong by a few bytes, or no table at all after a truncated download — while
  // the objects themselves are intact. This file has an xref pointing at nonsense.
  const pdf = wrap(
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
    + `2 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n`
    + `3 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n`
    + streamObj(4, "", "BT (Hello) Tj ET"),
    `xref\n0 5\n0000000000 65535 f \n9999999999 00000 n \ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );

  const { objects } = loadPdf(pdf);
  assert.equal(objects.size, 4);
  assert.ok(objects.has(1) && objects.has(4));
});

test("GATE: a stream inflates, and /Length is not trusted to find its end", () => {
  // A length that is too short truncates the stream mid-token; one that is too long swallows the terminator. Locating
  // `endstream` is authoritative, which is why this file declares a wrong length and still reads correctly.
  const body = deflateSync(Buffer.from("BT (Correct content) Tj ET", "latin1")).toString("latin1");
  const pdf = wrap(`5 0 obj\n<< /Filter /FlateDecode /Length 3 >>\nstream\n${body}\nendstream\nendobj\n`);

  const { bytes, objects } = loadPdf(pdf);
  const decoded = decodeStream(bytes, objects.get(5));
  assert.match(decoded.data.toString("latin1"), /Correct content/);
});

test("GATE: object streams expand, or a modern PDF yields almost nothing", () => {
  // Since PDF 1.5 most non-stream objects may be packed into a compressed /Type /ObjStm. A byte scan alone finds the
  // container and none of the page tree, fonts or resources inside it.
  const inner = `<< /Type /Catalog /Pages 20 0 R >> << /Type /Pages /Kids [ 21 0 R ] >> << /Type /Page /Contents 22 0 R >>`;
  const offsets = "19 0 20 36 21 71";
  const payload = `${offsets} ${inner}`;
  const first = offsets.length + 1;

  const pdf = wrap(streamObj(9, `/Type /ObjStm /N 3 /First ${first}`, payload) + streamObj(22, "", "BT (Inside) Tj ET"));

  const { objects, expanded } = loadPdf(pdf);
  assert.equal(expanded, 3, "three packed objects should have been recovered");
  assert.ok(objects.has(19) && objects.has(20) && objects.has(21));
  assert.match(objects.get(21).body, /\/Type \/Page/);
});

test("GATE: page order comes from the page TREE, not from file order", () => {
  // Object order in the file is arbitrary and is wrong in any edited document. Here the pages appear as 12, 10, 11 and are
  // presented as 10, 11, 12.
  const pdf = wrap(
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
    + `2 0 obj\n<< /Type /Pages /Kids [ 10 0 R 11 0 R 12 0 R ] >>\nendobj\n`
    + `12 0 obj\n<< /Type /Page /Contents 99 0 R >>\nendobj\n`
    + `10 0 obj\n<< /Type /Page /Contents 97 0 R >>\nendobj\n`
    + `11 0 obj\n<< /Type /Page /Contents 98 0 R >>\nendobj\n`,
  );

  const { bytes, objects } = loadPdf(pdf);
  const { pages, inferred } = pageOrder(bytes, objects);
  assert.deepEqual(pages, [10, 11, 12]);
  assert.equal(inferred, false);
});
