// PDF objects and streams.
//
// ONE RESPONSIBILITY: find the objects in a PDF and decode their streams. It extracts no text.
//
// WHY OBJECTS ARE FOUND BY SCANNING, NOT BY FOLLOWING THE XREF TABLE.
//
// The cross-reference table is the specified way to locate objects, and in a real corpus it is also the most commonly
// broken part of the file. Incremental updates leave stale entries, linearised files carry two tables, editors write
// offsets that are wrong by a few bytes, and a truncated download loses the table entirely — while the objects
// themselves are still all present and intact.
//
// So this scans for object headers directly. That is what makes it work on files a spec-faithful parser rejects, and it
// costs one pass over bytes we have already loaded. The xref is consulted for nothing, which also means there is no
// xref-parsing code to get wrong.
//
// The trade: an object superseded by an incremental update appears twice. Later definitions win, which is the same rule
// the xref would have applied, and is why the scan records them in order rather than keying blindly.

import { inflateSync, inflateRawSync } from "node:zlib";

/** An object header: `12 0 obj`. The generation number is almost always 0 but is part of the identity. */
const OBJ_HEADER = /(\d+)\s+(\d+)\s+obj\b/g;

/** Thrown for a structurally unusable file, so a caller can decline rather than crash. */
export class PdfError extends Error {
  constructor(message, { code = "PDF_INVALID" } = {}) {
    super(message);
    this.name = "PdfError";
    this.code = code;
  }
}

/**
 * Index every object in the file.
 *
 * Returns a Map keyed by object number. A LATER definition replaces an earlier one, because an incrementally-updated PDF
 * appends new versions of changed objects and the last one is current — the same resolution the cross-reference table
 * performs, reached without parsing it.
 */
export function indexObjects(bytes) {
  const objects = new Map();
  OBJ_HEADER.lastIndex = 0;

  let m;
  while ((m = OBJ_HEADER.exec(bytes)) !== null) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;

    // `endobj` terminates the object. A missing terminator means a damaged file, and rather than discarding the object,
    // its body runs to the next header — which recovers the content of a truncated final object.
    const endIdx = bytes.indexOf("endobj", bodyStart);
    const nextHeader = (() => {
      OBJ_HEADER.lastIndex = bodyStart;
      const next = OBJ_HEADER.exec(bytes);
      OBJ_HEADER.lastIndex = m.index + m[0].length;
      return next ? next.index : bytes.length;
    })();

    const bodyEnd = endIdx === -1 || endIdx > nextHeader ? nextHeader : endIdx;

    objects.set(num, { num, gen: Number(m[2]), bodyStart, bodyEnd, body: bytes.slice(bodyStart, bodyEnd) });
  }

  return objects;
}

/**
 * Read the top-level keys of a PDF dictionary.
 *
 * Deliberately SHALLOW and deliberately not a real parser. Values are captured as raw text — `12 0 R`, `/FlateDecode`,
 * `[ /A /B ]`, `<< nested >>` — and interpreted by the caller that knows what it is looking for.
 *
 * Nesting is tracked by depth so that a nested dictionary's keys are not mistaken for the outer one's. Without that,
 * `<< /Font << /Length 5 >> /Length 900 >>` yields the wrong length and the stream is read at the wrong size.
 */
export function parseDict(text) {
  const start = text.indexOf("<<");
  if (start === -1) return {};

  const out = {};
  let i = start + 2;
  let depth = 1;

  while (i < text.length && depth > 0) {
    // Enter or leave a nested structure without recording its contents.
    if (text.startsWith("<<", i)) { depth += 1; i += 2; continue; }
    if (text.startsWith(">>", i)) { depth -= 1; i += 2; continue; }

    if (depth !== 1 || text[i] !== "/") { i += 1; continue; }

    const keyMatch = /^\/([A-Za-z0-9._-]+)/.exec(text.slice(i));
    if (!keyMatch) { i += 1; continue; }

    const key = keyMatch[1];
    let j = i + keyMatch[0].length;
    while (j < text.length && /\s/.test(text[j])) j += 1;

    // The value: a nested dictionary, an array, a NAME, or a token run up to the next key.
    let value;
    if (text.startsWith("<<", j)) {
      value = readBalanced(text, j, "<<", ">>");
    } else if (text[j] === "[") {
      value = readBalanced(text, j, "[", "]");
    } else if (text[j] === "/") {
      // A name value is read as one token.
      //
      // This case was missing, and its absence was silent and total: the fallback below searches for "the next key",
      // whose pattern is `\s*\/[A-Za-z]` — which matches at offset ZERO when the value is itself a name. Every
      // name-valued key therefore parsed as an empty string, so `/Filter /FlateDecode` reported no filter at all and
      // every compressed stream came back as undecoded bytes. Two gate tests caught it; reading the code did not.
      value = (/^\/[A-Za-z0-9._-]*/.exec(text.slice(j)) ?? ["/"])[0];
    } else {
      const rest = text.slice(j);
      const stop = rest.search(/(?:\s*\/[A-Za-z]|\s*>>|\s*$)/);
      value = (stop === -1 ? rest : rest.slice(0, stop)).trim();
    }

    out[key] = value;
    i = j + (value ? value.length : 1);
  }

  return out;
}

/** Read a balanced `<< >>` or `[ ]` run, so a nested structure is captured whole. */
function readBalanced(text, from, open, close) {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    if (text.startsWith(open, i)) { depth += 1; i += open.length; continue; }
    if (text.startsWith(close, i)) { depth -= 1; i += close.length; if (depth === 0) return text.slice(from, i); continue; }
    i += 1;
  }
  return text.slice(from);
}

/** Resolve `12 0 R` to an object number, or null if the value is not a reference. */
export const refTo = (value) => {
  const m = /^(\d+)\s+\d+\s+R$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) : null;
};

/**
 * Decode an object's stream, if it has one.
 *
 * `/Length` IS NOT TRUSTED, and that is the important decision here. It is frequently an indirect reference to another
 * object, and frequently wrong in files that have been edited — a length that is too short truncates the stream mid-token
 * and a length that is too long swallows the terminator. Locating `endstream` is authoritative because it is what a
 * conforming reader falls back to and what every real file actually contains.
 *
 * Returns null when the object has no stream, which is the common case: most objects are dictionaries.
 */
export function decodeStream(bytes, obj, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const rel = obj.body.indexOf("stream");
  if (rel === -1) return null;

  // Skip the EOL that must follow the `stream` keyword: CRLF or LF, never CR alone.
  let from = rel + 6;
  if (obj.body[from] === "\r") from += 1;
  if (obj.body[from] === "\n") from += 1;

  const end = obj.body.indexOf("endstream", from);
  if (end === -1) throw new PdfError(`object ${obj.num}: stream has no endstream`, { code: "PDF_BAD_STREAM" });

  // A trailing EOL before `endstream` belongs to the delimiter, not the data.
  let to = end;
  if (obj.body[to - 1] === "\n") to -= 1;
  if (obj.body[to - 1] === "\r") to -= 1;

  const raw = Buffer.from(obj.body.slice(from, to), "latin1");
  if (raw.length > maxBytes) throw new PdfError(`object ${obj.num}: stream exceeds ${maxBytes} bytes`, { code: "PDF_TOO_BIG" });

  const dict = parseDict(obj.body.slice(0, rel));
  return applyFilters(raw, dict, obj.num);
}

/**
 * Apply a stream's filters.
 *
 * Only Flate is supported, and the others are NAMED when refused. `/DCTDecode` is a JPEG and `/CCITTFaxDecode` is a fax
 * image — neither contains text, so meeting them is information rather than a failure. `/ASCIIHexDecode` and
 * `/ASCII85Decode` do appear on text streams and are worth having; they are simple and are implemented.
 */
function applyFilters(raw, dict, num) {
  const filters = String(dict.Filter ?? "")
    .replace(/[[\]]/g, " ")
    .split(/\s+/)
    .filter((f) => f.startsWith("/"))
    .map((f) => f.slice(1));

  if (!filters.length) return { data: raw, filters: [], dict };

  let data = raw;
  for (const f of filters) {
    if (f === "FlateDecode" || f === "Fl") {
      data = inflate(data, num);
    } else if (f === "ASCIIHexDecode" || f === "AHx") {
      data = Buffer.from(data.toString("latin1").replace(/>[\s\S]*$/, "").replace(/[^0-9a-fA-F]/g, ""), "hex");
    } else if (f === "ASCII85Decode" || f === "A85") {
      data = ascii85(data.toString("latin1"));
    } else {
      // Image and unsupported filters: the stream is returned undecoded and labelled, because a caller looking for text
      // should skip it rather than treat compressed bytes as characters.
      return { data, filters, dict, undecoded: f };
    }
  }

  // A predictor re-encodes the decompressed bytes row by row, and is normal on xref streams. Not applied: this reader
  // does not use xref streams, and applying it wrongly to a content stream would corrupt text that is currently correct.
  const predictor = Number((String(dict.DecodeParms ?? "").match(/\/Predictor\s+(\d+)/) ?? [])[1] ?? 1);
  if (predictor > 1) return { data, filters, dict, predictor };

  return { data, filters, dict };
}

/**
 * Inflate, tolerating the two common malformations.
 *
 * A PDF stream is zlib-wrapped, but producers exist that write raw deflate, and others that leave a stray byte before the
 * header. Trying zlib, then raw, then a one-byte offset recovers files that a strict inflate rejects — and rejecting a
 * whole document over one leading byte would be a poor trade.
 */
function inflate(data, num) {
  try { return inflateSync(data); } catch { /* try the next form */ }
  try { return inflateRawSync(data); } catch { /* try the next form */ }
  try { return inflateSync(data.subarray(1)); } catch { /* out of options */ }
  throw new PdfError(`object ${num}: stream could not be inflated`, { code: "PDF_BAD_STREAM" });
}

/** ASCII85, which appears on text streams often enough to be worth the twenty lines. */
function ascii85(s) {
  const body = s.replace(/^<~/, "").replace(/~>[\s\S]*$/, "").replace(/\s/g, "");
  const out = [];
  let group = [];

  for (const ch of body) {
    if (ch === "z" && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      group = [];
    }
  }

  // A final partial group encodes fewer than four bytes; padding with the maximum digit and discarding the extras is the
  // specified behaviour.
  if (group.length > 1) {
    const padded = [...group, ...Array(5 - group.length).fill(84)];
    let n = 0;
    for (const g of padded) n = n * 85 + g;
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytes.slice(0, group.length - 1));
  }

  return Buffer.from(out);
}

/**
 * Expand object streams.
 *
 * WHY THIS IS NOT OPTIONAL. Since PDF 1.5 a producer may pack most non-stream objects into a compressed `/Type /ObjStm`.
 * In such a file the byte scan finds a handful of objects and almost none of the ones that matter — the page tree, the
 * fonts, the resources are all inside. A reader that skips this works on old PDFs and finds nothing in new ones.
 *
 * The layout: `/N` objects, a header of `N` pairs of `objnum offset`, then the objects themselves at `/First + offset`.
 * The objects are stored WITHOUT their `obj`/`endobj` wrappers, so each is synthesised into the same shape the scan
 * produces — which is what lets every caller treat both kinds identically.
 */
export function expandObjectStreams(bytes, objects) {
  const added = [];
  const errors = [];

  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm\b/.test(obj.body)) continue;

    let decoded;
    try { decoded = decodeStream(bytes, obj); }
    catch (e) { errors.push(`object stream ${obj.num}: ${e.message}`); continue; }
    if (!decoded || decoded.undecoded) { errors.push(`object stream ${obj.num}: could not be decoded`); continue; }

    const text = decoded.data.toString("latin1");
    const dict = parseDict(obj.body);
    const n = Number(dict.N);
    const first = Number(dict.First);

    if (!Number.isFinite(n) || !Number.isFinite(first)) {
      errors.push(`object stream ${obj.num}: missing /N or /First`);
      continue;
    }

    // The pair table lives before /First and is plain text.
    const header = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = header[i * 2];
      const offset = header[i * 2 + 1];
      if (!Number.isFinite(num) || !Number.isFinite(offset)) continue;

      // Each object runs to the next one's offset, and the last to the end of the stream.
      const nextOffset = i + 1 < n ? header[(i + 1) * 2 + 1] : text.length - first;
      const body = text.slice(first + offset, first + (Number.isFinite(nextOffset) ? nextOffset : text.length - first));

      // An object already found by the scan is NOT replaced: a directly-stored object is a later revision than one packed
      // into a stream written earlier, and overwriting it would undo an incremental update.
      if (objects.has(num)) continue;

      const synthesised = { num, gen: 0, bodyStart: -1, bodyEnd: -1, body, fromObjStm: obj.num };
      objects.set(num, synthesised);
      added.push(num);
    }
  }

  return { added, errors };
}

/**
 * Load a PDF into an object map, with object streams expanded.
 *
 * The single entry point a reader needs. Returns the objects plus what could not be read, because a document with one bad
 * stream and ninety good ones should still be usable — and the caller decides whether the losses matter.
 */
export function loadPdf(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  // Latin-1: a lossless byte-to-character mapping. UTF-8 would turn invalid sequences into replacement characters and
  // corrupt both the structure being scanned and any stream sliced out of it.
  const bytes = buf.toString("latin1");

  if (!/%PDF-/.test(bytes.slice(0, 1024))) throw new PdfError("not a PDF: no %PDF- header", { code: "PDF_NOT_PDF" });

  const objects = indexObjects(bytes);
  if (!objects.size) throw new PdfError("no objects found in the file", { code: "PDF_NO_OBJECTS" });

  const { added, errors } = expandObjectStreams(bytes, objects);

  return { bytes, objects, expanded: added.length, errors };
}

/**
 * Pages, in document order.
 *
 * Order comes from the page tree's `/Kids` arrays, walked from the catalog — not from the order page objects happen to
 * appear in the file, which is arbitrary and is wrong in any document that has been edited.
 *
 * Falls back to scan order when the tree cannot be walked, and says so via the returned flag: a wrong page order is
 * something a reader will notice, so it must not be silent.
 */
export function pageOrder(bytes, objects) {
  const catalogNum = [...objects.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.body))?.num;
  const rootRef = catalogNum !== undefined ? refTo(parseDict(objects.get(catalogNum).body).Pages) : null;

  const ordered = [];
  const seen = new Set();

  const walk = (num, depth = 0) => {
    // A malformed tree can contain a cycle; depth and a seen-set bound it rather than hanging.
    if (depth > 64 || num == null || seen.has(num) || !objects.has(num)) return;
    seen.add(num);

    const obj = objects.get(num);
    if (/\/Type\s*\/Page\b(?![sA-Za-z])/.test(obj.body)) { ordered.push(num); return; }

    const kids = parseDict(obj.body).Kids ?? "";
    for (const m of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(m[1]), depth + 1);
  };

  if (rootRef != null) walk(rootRef);

  if (ordered.length) return { pages: ordered, inferred: false };

  const scanned = [...objects.values()]
    .filter((o) => /\/Type\s*\/Page\b(?![sA-Za-z])/.test(o.body))
    .map((o) => o.num)
    .sort((a, b) => a - b);

  return { pages: scanned, inferred: true };
}

/**
 * The decoded content of one page.
 *
 * `/Contents` may be a single reference or an array of them, and a page split across several streams must be joined
 * before the operators are read — a text object can begin in one stream and end in the next, and parsing them separately
 * loses the text at every boundary.
 */
export function pageContent(bytes, objects, pageNum) {
  const page = objects.get(pageNum);
  if (!page) return { text: "", errors: [`page object ${pageNum} not found`] };

  const contents = parseDict(page.body).Contents ?? "";
  const refs = [...String(contents).matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));

  const parts = [];
  const errors = [];

  for (const ref of refs) {
    const obj = objects.get(ref);
    if (!obj) { errors.push(`content object ${ref} not found`); continue; }
    try {
      const decoded = decodeStream(bytes, obj);
      if (!decoded) continue;
      if (decoded.undecoded) { errors.push(`content object ${ref} uses ${decoded.undecoded}`); continue; }
      parts.push(decoded.data.toString("latin1"));
    } catch (e) {
      errors.push(`content object ${ref}: ${e.message}`);
    }
  }

  return { text: parts.join("\n"), errors };
}
