import { test } from "node:test";
import assert from "node:assert/strict";
import { probeTesseract, resetProbe, imageFormat, ocrImage, ocrAdvice } from "./ocr.mjs";
import { tryIngest } from "../core/ingest.mjs";

// OCR as an OPTIONAL adapter.
//
// The rule this file enforces: with Tesseract absent, behaviour is exactly what it was before OCR existed. Nothing is
// installed, nothing is downloaded, no error is raised for its absence, and no message nags beyond naming it once.
//
// These tests must therefore pass on a machine WITH Tesseract and a machine WITHOUT it, which is why they branch on the
// probe rather than assuming either. A test that only passes on the developer's machine is not a test.

const png = (bytes = 400) => Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(bytes)]);

// --- format detection, which needs no Tesseract at all -----------------------------------------------------

test("image formats are detected from BYTES, not from a filename", () => {
  // A filename is a claim. `report.png` may be a JPEG and `data.bin` may be a PNG.
  assert.equal(imageFormat(Buffer.from("89504e470d0a1a0a", "hex")), "png");
  assert.equal(imageFormat(Buffer.concat([Buffer.from("ffd8ff", "hex"), Buffer.alloc(20)])), "jpg");
  assert.equal(imageFormat(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])), "webp");
  assert.equal(imageFormat(Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)])), "gif");
  assert.equal(imageFormat(Buffer.concat([Buffer.from("BM"), Buffer.alloc(20)])), "bmp");
  assert.equal(imageFormat(Buffer.concat([Buffer.from("49492a00", "hex"), Buffer.alloc(20)])), "tif");
});

test("a non-image returns null rather than a guess", () => {
  assert.equal(imageFormat(Buffer.from("%PDF-1.7")), null);
  assert.equal(imageFormat(Buffer.from("<html>")), null);
  assert.equal(imageFormat(Buffer.alloc(4)), null, "too short to identify");
  assert.equal(imageFormat(null), null);
});

// --- the probe ---------------------------------------------------------------------------------------------

test("the probe reports availability without throwing, either way", () => {
  resetProbe();
  const p = probeTesseract();
  assert.equal(typeof p.available, "boolean");
  if (p.available) {
    assert.match(p.version, /[\d.]/, "a version should be reported");
    assert.ok(Array.isArray(p.languages));
  } else {
    assert.ok(p.reason, "an unavailable probe must say why");
  }
});

test("the probe is cached, so it does not spawn a process per document", () => {
  resetProbe();
  const first = probeTesseract();
  const second = probeTesseract();
  assert.equal(first, second, "the same object should come back");
});

test("the probe honours GISTLINE_TESSERACT, and a bad path is not an error", () => {
  // Someone with a non-standard install can point at it; a wrong value must degrade to "unavailable" rather than crash.
  const before = process.env.GISTLINE_TESSERACT;
  try {
    process.env.GISTLINE_TESSERACT = "definitely-not-a-real-binary-xyz";
    resetProbe();
    const p = probeTesseract({ force: true });
    assert.equal(p.available, false);
    assert.ok(p.reason);
  } finally {
    if (before === undefined) delete process.env.GISTLINE_TESSERACT;
    else process.env.GISTLINE_TESSERACT = before;
    resetProbe();
  }
});

// --- THE RULE: absent means unchanged ----------------------------------------------------------------------

test("with Tesseract absent, an image is refused exactly as before", () => {
  const p = probeTesseract();
  const r = tryIngest(png(), { name: "shot.png" });

  if (p.available) {
    // On a machine with Tesseract, a blank PNG still yields no text — so it refuses, but for a different reason.
    assert.equal(r.ok, false);
    assert.match(r.reason, /Tesseract/, "the refusal should name what it tried");
    return;
  }

  assert.equal(r.ok, false);
  assert.equal(r.format, "image");
  // The fact that matters about images regardless of OCR: cost is driven by pixels, so resizing reduces it directly.
  assert.match(r.reason, /pixel dimensions/);
  assert.match(r.reason, /Tesseract/, "it should name the tool so the reader can decide to install it");
  assert.match(r.reason, /not bundled/, "and say plainly that it is not shipped");
});

test("OCR never throws for its own absence — that is a normal condition", () => {
  // An exception would force every caller to wrap it, and the whole point is that nothing changes when it is missing.
  assert.doesNotThrow(() => ocrImage(png()));
  const r = ocrImage(png());
  assert.equal(typeof r.ok, "boolean");
  assert.equal(typeof r.text, "string");
});

test("a non-image is refused before a subprocess is spawned", () => {
  const r = ocrImage(Buffer.from("%PDF-1.7 not an image"));
  assert.equal(r.ok, false);
  if (r.available) assert.match(r.reason, /not an image format/);
});

test("an oversized image is refused by the limit, not by exhausting memory", () => {
  const r = ocrImage(png(1000), { maxBytes: 100 });
  assert.equal(r.ok, false);
  if (r.available) assert.match(r.reason, /OCR limit/);
});

// --- empty output is a FAILURE, not an empty success -------------------------------------------------------

test("empty recognition output is reported as a failure", () => {
  // A blank result from a page that visibly contains writing means recognition did not work. Returning ok with an empty
  // string would present that as "this page has no text" — confident, and wrong.
  const r = ocrImage(png());
  assert.equal(r.ok, false);
  assert.equal(r.text, "");
});

// --- the advice differs by situation, because the next step differs -----------------------------------------

test("advice for a scanned PDF names the MISSING PIECE, not just OCR", () => {
  // Tesseract reads images, not PDFs. Saying "install Tesseract" to someone with a scanned PDF sends them to a tool that
  // still will not do the job on its own.
  const advice = ocrAdvice({ isPdf: true });
  assert.match(advice, /pdftoppm|ImageMagick/, "rasterisation is required first, and the tool should be named");
});

test("advice differs between absent and present, because the actionable step differs", () => {
  const p = probeTesseract();
  const advice = ocrAdvice({ isPdf: false });
  if (p.available) assert.match(advice, /installed but could not read/);
  else assert.match(advice, /will use Tesseract automatically if it is installed/);
});

test("the zero-dependency guarantee is stated in the refusal", () => {
  // Someone reading it should understand why it is not simply bundled.
  if (probeTesseract().available) return;
  assert.match(ocrAdvice({ isPdf: false }), /zero-dependency/);
});
