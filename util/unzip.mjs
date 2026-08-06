// ZIP reading, on `node:zlib` alone.
//
// ONE RESPONSIBILITY: list and extract the entries of a ZIP archive.
//
// WHY THIS IS POSSIBLE WITHOUT A DEPENDENCY. A ZIP entry is a raw DEFLATE stream, and `node:zlib` — built into Node —
// provides `inflateRawSync`. That single fact is what makes DOCX, XLSX and PPTX readable here at all: each is a ZIP of
// XML, so this module is the prerequisite for all three rather than a feature of its own.
//
// STRUCTURE OF THE FORMAT, since the code below is meaningless without it. A ZIP is read from the END:
//
//   [local header + data] [local header + data] … [central directory] [end-of-central-directory]
//
// The end-of-central-directory record says where the central directory is; the central directory lists every entry with
// its name, sizes, compression method and the offset of its local header. Reading forward from the start is possible but
// wrong: only the central directory is authoritative about what the archive contains.
//
// WHAT THIS DELIBERATELY DOES NOT DO: write archives, decrypt, or handle multi-disk spans. It reads, and it declines
// clearly when it cannot.

import { inflateRawSync, crc32 } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Compression methods this reader understands. 0 is stored, 8 is deflate — and stored is not a theoretical case. */
export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;

/** Thrown for a malformed or unsupported archive, so a caller can decline rather than crash. */
export class ZipError extends Error {
  constructor(message, { code = "ZIP_INVALID" } = {}) {
    super(message);
    this.name = "ZipError";
    this.code = code;
  }
}

/**
 * Locate the end-of-central-directory record.
 *
 * Scanned BACKWARDS from the end, because the record may be followed by an archive comment of up to 65,535 bytes. The
 * bound is that comment's maximum length plus the record's own 22 bytes; searching the whole file would be wasteful and
 * would risk matching the signature inside compressed data.
 */
function findEocd(buf) {
  const maxBack = Math.min(buf.length, 22 + 0xffff);
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i >= 0 && buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError("not a ZIP archive: no end-of-central-directory record found", { code: "ZIP_NOT_ZIP" });
}

/**
 * ZIP64, detected rather than attempted.
 *
 * When an archive exceeds 65,535 entries or 4 GB, the classic record stores sentinel values and the real numbers live in
 * a ZIP64 record. Documents of the kind this reader exists for are far below those limits, so ZIP64 is DECLINED with a
 * clear reason instead of half-implemented — a partly-correct ZIP64 path would fail on exactly the large archives it was
 * added for.
 */
function checkZip64(buf, eocd) {
  const entries = buf.readUInt16LE(eocd + 10);
  const size = buf.readUInt32LE(eocd + 12);
  const offset = buf.readUInt32LE(eocd + 16);

  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError("ZIP64 archives are not supported (over 65,535 entries or 4 GB)", { code: "ZIP_ZIP64" });
  }
  // A locator immediately before the record is a strong signal even when the sentinels are absent.
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === EOCD64_LOCATOR_SIG) {
    throw new ZipError("ZIP64 archives are not supported", { code: "ZIP_ZIP64" });
  }
  return { entries, size, offset };
}

/**
 * List the archive's entries from the central directory.
 *
 * Directories are excluded: a ZIP records them as zero-length entries whose names end in `/`, and returning them as
 * files would make every caller filter them out itself.
 */
export function listEntries(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22) throw new ZipError("too short to be a ZIP archive", { code: "ZIP_NOT_ZIP" });

  const eocd = findEocd(buf);
  const { entries, offset } = checkZip64(buf, eocd);

  const out = [];
  let p = offset;

  for (let i = 0; i < entries; i++) {
    if (p + 46 > buf.length) throw new ZipError(`central directory entry ${i} runs past the end of the file`);
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new ZipError(`central directory entry ${i} has a bad signature`);
    }

    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc32 = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);

    // Bit 0 of the general-purpose flags means the entry is encrypted. Detected here so the failure names the cause
    // rather than surfacing as a corrupt-stream error from zlib.
    const encrypted = (flags & 0x1) === 1;

    // Names are UTF-8 when bit 11 is set; otherwise CP437 in theory. Decoded as UTF-8 either way, because every tool
    // that produces the documents this reader targets sets the flag, and mis-decoding a name is recoverable while
    // failing on it is not.
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");

    if (!name.endsWith("/")) {
      out.push({ name, method, encrypted, crc32, compressedSize, uncompressedSize, localOffset });
    }

    p += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}

/**
 * Extract one entry to a Buffer.
 *
 * The local header is re-read rather than trusted from the central directory, because its name and extra-field lengths
 * are what determine where the data actually starts, and the two records may legitimately differ in their extra fields.
 */
export function extractEntry(buffer, entry) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (entry.encrypted) {
    throw new ZipError(`"${entry.name}" is encrypted or password-protected`, { code: "ZIP_ENCRYPTED" });
  }

  const p = entry.localOffset;
  if (p + 30 > buf.length) throw new ZipError(`"${entry.name}": local header runs past the end of the file`);
  if (buf.readUInt32LE(p) !== LOCAL_SIG) throw new ZipError(`"${entry.name}": bad local header signature`);

  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;

  if (end > buf.length) throw new ZipError(`"${entry.name}": data runs past the end of the file`);
  const raw = buf.subarray(start, end);

  if (entry.method === METHOD_STORED) return verify(Buffer.from(raw), entry);

  if (entry.method === METHOD_DEFLATE) {
    let out;
    try {
      out = inflateRawSync(raw);
    } catch (e) {
      // A zlib failure here means the stream is corrupt or uses an unexpected variant. Named, so a caller can decline
      // this entry and still read the rest of the archive.
      throw new ZipError(`"${entry.name}": could not inflate (${e.message})`, { code: "ZIP_BAD_STREAM" });
    }
    return verify(out, entry);
  }

  throw new ZipError(`"${entry.name}": unsupported compression method ${entry.method}`, { code: "ZIP_METHOD" });
}

/**
 * Check the entry's CRC32.
 *
 * NOT OPTIONAL, and it was missing. DEFLATE has weak internal error detection: a corrupted stream frequently inflates
 * to *something* rather than failing, so without this check silent corruption passes as success. A test caught it —
 * flipping a byte in a stream produced no error at all.
 *
 * The archive already carries the checksum for exactly this purpose, and it was being read into the entry and ignored.
 * Checking it is what makes "extracted successfully" mean the bytes are the original bytes.
 */
function verify(data, entry) {
  // A zero CRC with a non-empty payload means the producer left it in a data descriptor after the stream, which this
  // reader does not follow. Unverifiable rather than wrong, so it passes with the size check alone.
  if (entry.crc32 !== 0) {
    const actual = crc32(data);
    if (actual !== entry.crc32) {
      throw new ZipError(
        `"${entry.name}": checksum mismatch — the data is corrupt (expected ${entry.crc32}, got ${actual})`,
        { code: "ZIP_BAD_CRC" },
      );
    }
  }
  if (entry.uncompressedSize && data.length !== entry.uncompressedSize) {
    throw new ZipError(
      `"${entry.name}": size mismatch — expected ${entry.uncompressedSize} bytes, got ${data.length}`,
      { code: "ZIP_BAD_SIZE" },
    );
  }
  return data;
}

/**
 * Read an archive into a name-to-text map.
 *
 * The convenience every reader above this actually wants: OOXML formats need a handful of named XML files and nothing
 * else, so `only` avoids inflating a 40 MB embedded image to reach a 4 KB sheet.
 *
 * A FAILING ENTRY DOES NOT FAIL THE ARCHIVE. One corrupt or encrypted member should not cost the caller every other
 * file, so failures are collected and returned. A caller that needs all-or-nothing checks `errors` itself.
 */
export function readZip(buffer, { only = null, maxBytes = 64 * 1024 * 1024 } = {}) {
  const entries = listEntries(buffer);
  const wanted = only
    ? entries.filter((e) => (typeof only === "function" ? only(e.name) : only.includes(e.name)))
    : entries;

  const files = new Map();
  const errors = [];
  let total = 0;

  for (const e of wanted) {
    // A bound on decompressed size, because a small archive can declare an enormous member — a compression bomb should
    // stop the read rather than exhaust memory.
    if (total + e.uncompressedSize > maxBytes) {
      errors.push(`"${e.name}": skipped, would exceed the ${Math.round(maxBytes / 1024 / 1024)}MB decompression limit`);
      continue;
    }
    try {
      const data = extractEntry(buffer, e);
      total += data.length;
      files.set(e.name, data);
    } catch (err) {
      errors.push(err.message);
    }
  }

  return { files, errors, entries };
}

/** Is this a ZIP? Cheap: the local header signature at the start. Also true of every OOXML document. */
export function looksLikeZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_SIG;
}

/**
 * Which OOXML format is this, if any?
 *
 * Decided by the presence of the format's own marker directory rather than by file extension, because an extension is a
 * claim and the archive contents are evidence.
 */
export function ooxmlKind(buffer) {
  if (!looksLikeZip(buffer)) return null;
  let names;
  try { names = listEntries(buffer).map((e) => e.name); }
  catch { return null; }

  if (names.some((n) => n.startsWith("word/"))) return "docx";
  if (names.some((n) => n.startsWith("xl/"))) return "xlsx";
  if (names.some((n) => n.startsWith("ppt/"))) return "pptx";
  return null;
}
