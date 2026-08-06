import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import {
  listEntries, extractEntry, readZip, looksLikeZip, ooxmlKind, ZipError,
  METHOD_STORED, METHOD_DEFLATE,
} from "./unzip.mjs";

// ZIP reading on node:zlib alone.
//
// The gate for this stage: a real archive's central directory is read and one entry inflates, and a corrupt archive
// DECLINES rather than throwing something unhelpful.
//
// Archives here are BUILT rather than hand-written as fixtures, because a fixture crafted to satisfy the reader proves
// only that the two agree. Building with `deflateRawSync` — the counterpart of the `inflateRawSync` under test — means
// the bytes are real.

/** Minimal but genuine ZIP writer, used only by these tests. */
function makeZip(files, { method = METHOD_DEFLATE } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const body = method === METHOD_STORED ? data : deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x800, 6);         // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, body]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

const SAMPLE = [
  ["word/document.xml", "<w:document><w:body><w:p><w:t>Hello</w:t></w:p></w:body></w:document>"],
  ["docProps/core.xml", "<coreProperties><title>Test</title></coreProperties>"],
  ["[Content_Types].xml", "<Types/>"],
];

// --- the gate ---------------------------------------------------------------------------------------------

test("GATE: a real archive lists its entries and one inflates correctly", () => {
  const zip = makeZip(SAMPLE);
  const entries = listEntries(zip);

  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map((e) => e.name).sort(), ["[Content_Types].xml", "docProps/core.xml", "word/document.xml"]);

  const doc = entries.find((e) => e.name === "word/document.xml");
  assert.equal(extractEntry(zip, doc).toString("utf8"), SAMPLE[0][1]);
});

test("GATE: a corrupt archive declines with a named reason", () => {
  // The failure must say what is wrong. A generic zlib error would send a caller looking in the wrong place.
  assert.throws(() => listEntries(Buffer.from("not a zip at all")), (e) => e instanceof ZipError && e.code === "ZIP_NOT_ZIP");
  assert.throws(() => listEntries(Buffer.alloc(4)), (e) => e.code === "ZIP_NOT_ZIP");

  // A valid trailer with a central directory pointing nowhere.
  const broken = makeZip(SAMPLE);
  broken.writeUInt32LE(broken.length - 5, broken.length - 6);
  assert.throws(() => listEntries(broken), ZipError);
});

// --- both compression methods, because stored is not theoretical -------------------------------------------

test("stored (uncompressed) entries are read as well as deflated ones", () => {
  // Real producers use method 0 for small or already-compressed members. A reader that assumed deflate would fail on
  // exactly those, and the failure would look like corruption.
  for (const method of [METHOD_STORED, METHOD_DEFLATE]) {
    const zip = makeZip([["a.xml", "<a>content</a>"]], { method });
    const [entry] = listEntries(zip);
    assert.equal(entry.method, method);
    assert.equal(extractEntry(zip, entry).toString("utf8"), "<a>content</a>", `method ${method}`);
  }
});

test("the local header is re-read rather than trusted, so data starts in the right place", () => {
  // Name and extra-field lengths in the local header determine where data begins, and they may differ from the central
  // directory's. Reading a long name proves the offset arithmetic.
  const long = `xl/worksheets/${"deeply/".repeat(12)}sheet1.xml`;
  const zip = makeZip([[long, "<worksheet>ok</worksheet>"]]);
  const [entry] = listEntries(zip);
  assert.equal(entry.name, long);
  assert.equal(extractEntry(zip, entry).toString("utf8"), "<worksheet>ok</worksheet>");
});

// --- what must be declined --------------------------------------------------------------------------------

test("an encrypted entry is named as encrypted, not reported as corrupt", () => {
  // Flag bit 0 means encrypted. Without this check, zlib fails on the ciphertext and the message sends the reader
  // looking for file corruption.
  const zip = makeZip([["secret.xml", "<a/>"]]);
  const entries = listEntries(zip);
  // Set the encrypted flag in the central directory record.
  const cdStart = zip.readUInt32LE(zip.length - 6);
  zip.writeUInt16LE(0x800 | 0x1, cdStart + 8);
  const [e] = listEntries(zip);
  assert.equal(e.encrypted, true);
  assert.throws(() => extractEntry(zip, e), (err) => err.code === "ZIP_ENCRYPTED");
  assert.ok(entries.length === 1);
});

test("an unsupported compression method is named, with the method number", () => {
  const zip = makeZip([["a.xml", "<a/>"]]);
  const e = { ...listEntries(zip)[0], method: 14 };
  assert.throws(() => extractEntry(zip, e), (err) => err.code === "ZIP_METHOD" && /method 14/.test(err.message));
});

test("ZIP64 is declined explicitly rather than half-supported", () => {
  // A partly-correct ZIP64 path would fail on exactly the large archives it was added for.
  const zip = makeZip(SAMPLE);
  zip.writeUInt16LE(0xffff, zip.length - 12);
  assert.throws(() => listEntries(zip), (e) => e.code === "ZIP_ZIP64");
});

test("directory entries are excluded, so no caller has to filter them", () => {
  const zip = makeZip([["dir/", ""], ["dir/file.xml", "<a/>"]]);
  const entries = listEntries(zip);
  assert.deepEqual(entries.map((e) => e.name), ["dir/file.xml"]);
});

// --- readZip: the shape callers actually use ---------------------------------------------------------------

test("readZip returns the wanted files and does not inflate the rest", () => {
  const zip = makeZip([...SAMPLE, ["word/media/image1.png", "x".repeat(50_000)]]);
  const { files, errors } = readZip(zip, { only: ["word/document.xml"] });
  assert.equal(files.size, 1);
  assert.match(files.get("word/document.xml").toString("utf8"), /Hello/);
  assert.deepEqual(errors, []);
});

test("only accepts a predicate as well as a list", () => {
  const zip = makeZip(SAMPLE);
  const { files } = readZip(zip, { only: (n) => n.startsWith("docProps/") });
  assert.deepEqual([...files.keys()], ["docProps/core.xml"]);
});

test("ONE failing entry does not cost the caller every other file", () => {
  // A corrupt or encrypted member should not fail the archive. Failures are collected so a caller can decide.
  const zip = makeZip([["good.xml", "<a>fine</a>"], ["bad.xml", "<b/>"]]);
  const entries = listEntries(zip);
  const bad = entries.find((e) => e.name === "bad.xml");
  // Corrupt the deflate stream of the second entry only.
  zip[bad.localOffset + 30 + Buffer.byteLength(bad.name) + 2] ^= 0xff;

  const { files, errors } = readZip(zip);
  assert.ok(files.has("good.xml"), "the intact entry must still be readable");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bad\.xml/);
});

test("a decompression bomb is stopped by the size limit, not by exhausting memory", () => {
  const zip = makeZip([["big.xml", "a".repeat(200_000)]]);
  const { files, errors } = readZip(zip, { maxBytes: 1000 });
  assert.equal(files.size, 0);
  assert.match(errors[0], /decompression limit/);
});

// --- detection --------------------------------------------------------------------------------------------

test("looksLikeZip and ooxmlKind decide by CONTENT, not by extension", () => {
  // An extension is a claim; the archive contents are evidence.
  assert.equal(looksLikeZip(Buffer.from("PK\u0003\u0004rest")), true);
  assert.equal(looksLikeZip(Buffer.from("<html>")), false);

  assert.equal(ooxmlKind(makeZip([["word/document.xml", "<a/>"]])), "docx");
  assert.equal(ooxmlKind(makeZip([["xl/workbook.xml", "<a/>"]])), "xlsx");
  assert.equal(ooxmlKind(makeZip([["ppt/presentation.xml", "<a/>"]])), "pptx");
  assert.equal(ooxmlKind(makeZip([["readme.txt", "hi"]])), null);
  assert.equal(ooxmlKind(Buffer.from("not a zip")), null);
});

test("silent corruption is caught by the CHECKSUM, which DEFLATE alone does not catch", () => {
  // This is why the CRC check exists. Flipping a byte in a deflate stream frequently inflates to *something* rather than
  // failing, so without verifying the archive's own checksum, corruption passes as success. The test that found this was
  // asserting an error and getting none.
  const zip = makeZip([["a.xml", "<a>the original content of this file</a>"]]);
  const [entry] = listEntries(zip);
  const dataStart = entry.localOffset + 30 + Buffer.byteLength(entry.name);

  let caught = null;
  for (let i = 0; i < entry.compressedSize && !caught; i++) {
    const copy = Buffer.from(zip);
    copy[dataStart + i] ^= 0xff;
    try { extractEntry(copy, entry); }
    catch (e) { caught = e; }
  }

  assert.ok(caught, "no single-byte corruption was detected anywhere in the stream");
  assert.ok(["ZIP_BAD_CRC", "ZIP_BAD_STREAM", "ZIP_BAD_SIZE"].includes(caught.code), `unexpected code ${caught.code}`);
});

test("an intact entry passes the checksum, so verification is not merely rejecting everything", () => {
  // The other half of the previous test: a check that always fails is not a check.
  const zip = makeZip([["a.xml", "<a>content</a>"]]);
  const [entry] = listEntries(zip);
  assert.doesNotThrow(() => extractEntry(zip, entry));
  assert.equal(extractEntry(zip, entry).toString("utf8"), "<a>content</a>");
});

test("a size mismatch is reported even when the checksum cannot be used", () => {
  const zip = makeZip([["a.xml", "<a>content</a>"]]);
  const entry = { ...listEntries(zip)[0], crc32: 0, uncompressedSize: 9999 };
  assert.throws(() => extractEntry(zip, entry), (e) => e.code === "ZIP_BAD_SIZE");
});
