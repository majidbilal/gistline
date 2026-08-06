// XLSX reader.
//
// ONE RESPONSIBILITY: turn a spreadsheet into document-model blocks. It emits no Markdown — the shared writer does that.
//
// WHY THIS FORMAT MATTERS MOST. A sheet is already a table, and a table is exactly the shape the lossless compaction
// stage handles best. So the two stages compound here more than anywhere else: conversion removes the XML, and
// compaction removes the repeated column headers.
//
// THE FOUR RISKS THIS FILE EXISTS TO GET RIGHT, all identified before writing it because each one FAILS SILENTLY:
//
//   1. Inline strings vs shared strings are different code paths. Handling only the second drops text with no error.
//   2. A date is a NUMBER plus a format. Emitting `45872` where the sheet shows `2026-08-03` looks like success.
//   3. A formula cell holds both the formula and its cached result. The result is what a reader wants.
//   4. Merged cells repeat a value in the source or leave blanks; either way the shape must stay rectangular.

import { readZip } from "../util/unzip.mjs";
import { doc, heading, table, paragraph } from "../core/doc.mjs";

/** The files a workbook actually needs. Everything else — images, themes, printer settings — is skipped unread. */
const wanted = (name) =>
  name === "xl/workbook.xml" ||
  name === "xl/_rels/workbook.xml.rels" ||
  name === "xl/sharedStrings.xml" ||
  name === "xl/styles.xml" ||
  /^xl\/worksheets\/[^/]+\.xml$/.test(name);

const text = (buf) => (buf ? buf.toString("utf8") : "");

/** Decode the five XML entities. A spreadsheet cell legitimately contains `<`, `&` and quotes. */
const unxml = (s) =>
  String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    // Ampersand LAST, or `&amp;lt;` would decode twice and turn escaped text into markup.
    .replace(/&amp;/g, "&");

/**
 * The shared string table.
 *
 * A string may be split across several `<t>` runs when parts of it are formatted differently — bold in the middle of a
 * sentence produces three runs. Concatenating every `<t>` inside the `<si>` is what keeps the sentence whole; taking the
 * first would silently truncate it.
 */
export function readSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unxml(t[1])).join(""));
}

/**
 * Which style indexes are dates.
 *
 * Excel has no date type. A date is a number whose style points at a date format, so the only way to tell `45872` the
 * quantity from `45872` the date is to follow that reference. Built-in format ids 14–22 and 45–47 are dates and times;
 * a custom format is a date if its code contains a day, month or year token.
 */
export function readDateStyles(xml) {
  if (!xml) return new Set();

  const BUILT_IN_DATES = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const customDates = new Set();

  for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = unxml(m[2]);
    // Strip quoted literals and colour codes first, so a format like `"day "0` is not read as a day token.
    const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
    if (/[dmyhs]/i.test(bare) && /[dy]|mm?m|h/i.test(bare)) customDates.add(Number(m[1]));
  }

  const dateStyles = new Set();
  const cellXfs = xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!cellXfs) return dateStyles;

  let index = 0;
  for (const xf of cellXfs[1].matchAll(/<xf\b[^>]*>/g)) {
    const id = Number((xf[0].match(/numFmtId="(\d+)"/) ?? [])[1] ?? 0);
    if (BUILT_IN_DATES.has(id) || customDates.has(id)) dateStyles.add(index);
    index += 1;
  }
  return dateStyles;
}

/**
 * Excel serial number to an ISO date.
 *
 * The epoch is 1899-12-30, not 1900-01-01, because Excel treats 1900 as a leap year — a bug preserved deliberately for
 * compatibility with a competitor from 1983. Serials at or below 60 fall inside that fiction, so they are returned
 * unconverted rather than shifted by a day: a wrong date is worse than a raw number, because a raw number is visibly
 * raw.
 */
export function serialToDate(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 60) return null;

  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;

  const iso = d.toISOString();
  // A whole number is a date; a fraction carries a time, and dropping it would lose information.
  return n % 1 === 0 ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
}

/** A cell reference such as `BC12` to a zero-based column index. Needed because sparse sheets omit empty cells. */
export function columnIndex(ref) {
  const letters = String(ref).match(/^([A-Z]+)/)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Read one cell to a string.
 *
 * The type attribute decides everything, and the cases are not interchangeable:
 *   t="s"          the value is an INDEX into the shared string table
 *   t="inlineStr"  the text is inside the cell, in its own `<is><t>` wrapper
 *   t="str"        a formula's cached string result
 *   t="b"          boolean, stored as 0 or 1
 *   t="e"          an error such as #DIV/0!
 *   absent         a number, which may be a date depending on its style
 */
function readCell(cellXml, { strings, dateStyles }) {
  const type = (cellXml.match(/\bt="([^"]*)"/) ?? [])[1] ?? "n";
  const styleAttr = (cellXml.match(/\bs="(\d+)"/) ?? [])[1];

  if (type === "inlineStr") {
    const runs = [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1]));
    return runs.join("");
  }

  const v = (cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) ?? [])[1];
  if (v === undefined) return "";
  const value = unxml(v);

  if (type === "s") {
    const i = Number(value);
    // An out-of-range index means the table and the sheet disagree. Empty is honest; the index itself would be noise.
    return strings[i] ?? "";
  }
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";
  if (type === "e" || type === "str") return value;

  // A number, possibly a date.
  if (styleAttr !== undefined && dateStyles.has(Number(styleAttr))) {
    const asDate = serialToDate(value);
    if (asDate) return asDate;
  }
  return value;
}

/**
 * Read one worksheet into rows.
 *
 * Cells are placed by their COLUMN REFERENCE, not by their order of appearance. A sparse sheet omits empty cells
 * entirely, so reading them in sequence shifts every value after a gap into the wrong column — a failure that produces a
 * perfectly plausible table with the data in the wrong places.
 */
export function readSheet(xml, { strings = [], dateStyles = new Set() } = {}) {
  const rows = [];

  for (const rowMatch of String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] ?? "";
      const inner = cellMatch[2] ?? "";
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) ?? [])[1];
      const at = ref ? columnIndex(ref) : cells.length;
      cells[at] = readCell(`<c${attrs}>${inner}</c>`, { strings, dateStyles });
    }
    // Fill the holes a sparse row leaves, so every row is a dense array.
    rows.push(Array.from({ length: cells.length }, (i0, i) => cells[i] ?? ""));
  }

  // Trailing rows and columns that are entirely empty carry no information and cost tokens.
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  const width = Math.max(0, ...rows.map((r) => { let w = 0; r.forEach((c, i) => { if (c !== "") w = i + 1; }); return w; }));
  return rows.map((r) => Array.from({ length: width }, (i0, i) => r[i] ?? ""));
}

/** Sheet names in workbook order, paired with their file paths via the relationship ids. */
export function readSheetIndex(workbookXml, relsXml) {
  const rels = new Map();
  for (const m of String(relsXml).matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    rels.set(m[1], m[2].replace(/^\/?xl\//, "").replace(/^\//, ""));
  }

  const sheets = [];
  for (const m of String(workbookXml).matchAll(/<sheet\b[^>]*>/g)) {
    const name = unxml((m[0].match(/\bname="([^"]*)"/) ?? [])[1] ?? "");
    const rid = (m[0].match(/r:id="([^"]+)"/) ?? [])[1];
    const target = rels.get(rid);
    if (target) sheets.push({ name, path: `xl/${target}` });
  }
  return sheets;
}

/**
 * Read a whole workbook into the document model.
 *
 * One heading and one table per sheet. A sheet's first row becomes the header only when it looks like one — text in
 * every populated cell — because promoting a row of numbers to a header would lose that row's data.
 */
export function readXlsx(buffer) {
  const { files, errors } = readZip(buffer, { only: wanted });
  const notes = [...errors];

  const workbook = text(files.get("xl/workbook.xml"));
  if (!workbook) throw new Error("not a workbook: xl/workbook.xml is missing");

  const strings = readSharedStrings(text(files.get("xl/sharedStrings.xml")));
  const dateStyles = readDateStyles(text(files.get("xl/styles.xml")));
  const index = readSheetIndex(workbook, text(files.get("xl/_rels/workbook.xml.rels")));

  // Fall back to whatever worksheets exist if the relationships could not be read: a workbook with unreadable rels is
  // still worth converting, and losing the sheet NAMES is a smaller loss than losing the sheets.
  const sheets = index.length
    ? index
    : [...files.keys()].filter((n) => /^xl\/worksheets\//.test(n)).sort().map((path, i) => ({ name: `Sheet${i + 1}`, path }));

  if (!index.length && sheets.length) notes.push("Sheet names could not be read; sheets are numbered instead.");

  const blocks = [];
  let cells = 0;

  for (const sheet of sheets) {
    const xml = text(files.get(sheet.path));
    if (!xml) { notes.push(`Sheet "${sheet.name}" could not be read.`); continue; }

    const rows = readSheet(xml, { strings, dateStyles });
    if (!rows.length) { notes.push(`Sheet "${sheet.name}" is empty.`); continue; }

    blocks.push(heading(2, sheet.name));

    const populated = (r) => r.filter((c) => c !== "");
    const firstLooksLikeHeader =
      rows.length > 1 &&
      populated(rows[0]).length > 0 &&
      populated(rows[0]).every((c) => Number.isNaN(Number(c)));

    if (firstLooksLikeHeader) blocks.push(table(rows[0], rows.slice(1)));
    else blocks.push(table([], rows));

    cells += rows.reduce((n, r) => n + r.length, 0);
  }

  if (!blocks.length) blocks.push(paragraph("This workbook contains no readable sheet data."));

  // Stated plainly rather than implied: these are real limits and a reader of the output should know them.
  notes.push("Formulas are shown as their last calculated value. Charts, images and cell formatting are not included.");

  return { document: doc(blocks, { notes, source: "xlsx" }), sheets: sheets.length, cells };
}
