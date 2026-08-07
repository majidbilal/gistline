// Ingestion: bytes in, text out.
//
// ONE RESPONSIBILITY: work out what a file is and convert it to Markdown. It compresses nothing.
//
// WHY THIS IS A PRE-STAGE AND NOT A TRANSFORM. Every transform in the pipeline receives TEXT — the context carries a
// string, and 206 tests depend on that. A spreadsheet is a ZIP of XML: bytes, not text. Forcing it through a text
// pipeline would mean either decoding binary as a string first (which corrupts it) or making every transform
// binary-aware (which changes an interface that nine of them share, to serve one).
//
// So conversion happens BEFORE the pipeline. `ingest` turns bytes into Markdown; `gist` then compresses that Markdown
// exactly as it would any other text. The two stages compound and neither knows about the other.
//
// DETECTION IS BY CONTENT, NOT BY EXTENSION. A `.xlsx` that is really a CSV, or a `.txt` that is really HTML, is
// ordinary. The bytes are evidence; the name is a claim.

import { looksLikeZip, ooxmlKind, ZipError } from "../util/unzip.mjs";
import { readXlsx } from "../transforms/xlsx.mjs";
import { readDocx } from "../transforms/docx.mjs";
import { readPptx } from "../transforms/pptx.mjs";
import { looksLikeHtml, readHtml } from "../transforms/html.mjs";
import { classifyPdf, describePdf } from "../transforms/pdf-classify.mjs";
import { readPdf } from "../transforms/pdf.mjs";
import { toMarkdown } from "./markdown.mjs";

/** What ingestion produced, and what it could not. */
const result = (text, kind, { notes = [], converted = false, original = 0 } = {}) => ({
  text, kind, notes, converted, original,
});

/**
 * Formats that need special handling rather than a fixed refusal message.
 *
 * PDF is here because it may now be READ: the handler either converts it or refuses with the classifier's own diagnosis,
 * and a single message could do neither.
 */
const HANDLED = [
  {
    id: "pdf",
    test: (buf) => buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-",
    handler: convertPdf,
  },
];

/**
 * Formats recognised but deliberately not read.
 *
 * Named individually rather than lumped into "unsupported", because a reader who is told *which* format this is and
 * *why* it was refused can act on that; "unsupported file" cannot be acted on at all.
 */
const REFUSALS = [
  {
    id: "legacy-office",
    // The OLE2 compound-document signature: .doc, .xls, .ppt from before the XML formats.
    test: (buf) => buf.length > 8 && buf.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1",
    why:
      "This is a pre-2007 Office file (.doc, .xls or .ppt), which is a binary compound document rather than a ZIP of "
      + "XML. Re-save it as .docx, .xlsx or .pptx and gistline can read it.",
  },
  {
    id: "image",
    test: (buf) =>
      (buf.length > 8 && buf.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") ||
      (buf.length > 3 && buf.subarray(0, 3).toString("hex") === "ffd8ff") ||
      (buf.length > 6 && buf.subarray(0, 6).toString("latin1").startsWith("GIF8")) ||
      (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP"),
    why:
      "This is an image. Reading text from it needs OCR, which requires a model and would end this tool's "
      + "zero-dependency guarantee. Note that an image's token cost is driven by its pixel dimensions, so resizing it "
      + "before sending reduces cost directly.",
  },
];

/** Thrown when a format is recognised and deliberately not read. Carries the reason, so a caller can show it. */
export class UnsupportedFormat extends Error {
  constructor(id, why) {
    super(why);
    this.name = "UnsupportedFormat";
    this.format = id;
  }
}

/**
 * PDF: extracted if it can be, refused with a specific reason if it cannot.
 *
 * Tier 0 classification decides. A document with a text layer and a usable font mapping is READ; the cases where no
 * per-page attempt could help — encrypted, scanned, damaged — are refused with the classifier's own diagnosis, which is
 * more specific than anything a generic message could say.
 *
 * A PARTIALLY readable document is read, not refused. Losing seventy good pages because ten are scanned would be the
 * wrong trade, and the notes name the missing pages by number.
 */
function convertPdf(buf, name, mode) {
  try {
    const { document, pages, recovered, skipped } = readPdf(buf, { mode });
    const text = toMarkdown(document, { includeNotes: false, mode });

    const summary = recovered === pages
      ? `Read all ${pages} page(s).`
      : `Read ${recovered} of ${pages} page(s).`;

    return result(text, "pdf", {
      notes: [...document.notes, summary],
      converted: true,
      original: buf.length,
    });
  } catch (e) {
    const where = name ? `"${name}"` : "This PDF";
    const next = {
      encrypted: "Remove the password and try again.",
      scanned: "It needs OCR, which requires a model. Run it through an OCR tool first and gistline will compress the result.",
      damaged: "The file appears truncated. Try re-downloading or re-exporting it.",
      "not-pdf": "The bytes do not start with a PDF header.",
      unreadable: "Try an OCR tool, which can read the glyphs as images even when their character mapping is missing.",
    }[e.verdict] ?? "";

    throw new UnsupportedFormat("pdf", `${where}: ${e.message} ${next}`.trim());
  }
}

/**
 * Does this look like text at all?
 *
 * A NUL byte in the first few kilobytes is the reliable signal of binary: text encodings do not produce it, and every
 * binary container this tool might meet does. Checking a prefix rather than the whole file keeps it cheap on a large
 * input.
 */
export function looksLikeText(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/**
 * Convert whatever this is into text.
 *
 * Order matters: binary containers are identified first, because a ZIP or an image can contain byte sequences that would
 * satisfy a text heuristic. Text detection is the fallback, not the first guess.
 */
export function ingest(input, { name = "", mode = "information" } = {}) {
  // A string is already text. Passed through so a caller can use one entry point for both.
  if (typeof input === "string") {
    return looksLikeHtml(input)
      ? convertHtml(input, mode)
      : result(input, "text", { original: input.length });
  }

  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  if (!buf.length) return result("", "empty", { original: 0 });

  // Formats with a handler run FIRST: they may succeed, where a refusal never can.
  for (const h of HANDLED) {
    if (h.test(buf)) return h.handler(buf, name, mode);
  }

  for (const r of REFUSALS) {
    if (r.test(buf)) throw new UnsupportedFormat(r.id, r.why);
  }

  if (looksLikeZip(buf)) return convertZip(buf, name, mode);

  if (!looksLikeText(buf)) {
    throw new UnsupportedFormat(
      "binary",
      "This file is binary and its format was not recognised. gistline reads text, HTML, and the XML-based Office "
      + "formats (.docx, .xlsx, .pptx).",
    );
  }

  const text = buf.toString("utf8");
  return looksLikeHtml(text) ? convertHtml(text, mode) : result(text, "text", { original: buf.length });
}

/** HTML through the reader and the shared writer. */
function convertHtml(source, mode) {
  const document = readHtml(source);
  const text = toMarkdown(document, { includeNotes: false, mode });
  return result(text, "html", { notes: document.notes, converted: true, original: source.length });
}

/**
 * A ZIP: an Office document, or an archive we can name but not interpret.
 *
 * An ordinary ZIP is refused rather than guessed at. Concatenating the text files inside an arbitrary archive would
 * produce something plausible and meaningless, and "here is a wall of text from 40 files" is worse for a reader than
 * being told to extract the one they wanted.
 */
function convertZip(buf, name, mode) {
  let kind;
  try { kind = ooxmlKind(buf); }
  catch (e) {
    throw new UnsupportedFormat("zip", `This ZIP archive could not be read: ${e.message}`);
  }

  if (kind === "xlsx") {
    const { document, sheets, cells } = readXlsx(buf);
    const text = toMarkdown(document, { includeNotes: false, mode });
    return result(text, "xlsx", {
      notes: [...document.notes, `Read ${sheets} sheet(s), ${cells} cell(s).`],
      converted: true,
      original: buf.length,
    });
  }

  if (kind === "docx") {
    const { document, blocks } = readDocx(buf);
    const text = toMarkdown(document, { includeNotes: false, mode });
    return result(text, "docx", {
      notes: [...document.notes, `Read ${blocks} block(s).`],
      converted: true,
      original: buf.length,
    });
  }

  if (kind === "pptx") {
    const { document, slides, withNotes } = readPptx(buf, { mode });
    const text = toMarkdown(document, { includeNotes: false, mode });
    return result(text, "pptx", {
      notes: [...document.notes, `Read ${slides} slide(s), ${withNotes} with speaker notes.`],
      converted: true,
      original: buf.length,
    });
  }

  throw new UnsupportedFormat(
    "zip",
    `${name ? `"${name}" is ` : "This is "}a ZIP archive rather than an Office document. Extract the file you want and `
    + "pass that instead — concatenating everything inside an archive produces text that reads plausibly and means "
    + "nothing.",
  );
}

/** Try to ingest, and report a refusal as data rather than an exception, for callers that prefer that shape. */
export function tryIngest(input, opts = {}) {
  try {
    return { ok: true, ...ingest(input, opts) };
  } catch (e) {
    if (e instanceof UnsupportedFormat || e instanceof ZipError) {
      return { ok: false, format: e.format ?? "unknown", reason: e.message, text: "", kind: "unsupported", notes: [] };
    }
    throw e;
  }
}
