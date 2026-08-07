// Markdown tables, compacted losslessly.
//
// ONE RESPONSIBILITY: find tables in Markdown text and encode their columns. It converts no documents.
//
// THE GAP THIS CLOSES. A spreadsheet reaches Markdown losslessly and then the compression stage that follows is the LOSSY
// log path — because a Markdown table already states its headers once, so the redundancy `toTable()` exists to remove was
// already gone, and the only reduction left was dropping rows.
//
// But a table's redundancy is not in its headers. It is DOWN THE COLUMNS: a date column where every value shares a month, a
// status column with four distinct values across 300 rows, an id column that increments. `columnar.mjs` already encodes
// exactly that, and it was built for log values — so this is mostly a matter of finding the tables and handing them over.
//
// WHY IT IS A SEPARATE TRANSFORM rather than part of the document readers: text arriving as Markdown from anywhere at all —
// a file, a paste, another tool's output — gets the same treatment. A reader that did this itself would only help the
// documents gistline happens to read.

import { encodeColumn, decodeColumn } from "./columnar.mjs";
import { split, join } from "../util/lines.mjs";

/** A table needs this many data rows before a per-column header pays for itself. */
export const MIN_ROWS = 6;

/**
 * Average words per field, above which a "table" is really prose.
 *
 * A CELL IS A VALUE, NOT A CLAUSE, and that is the discriminator. Field count alone does not work: prose with one comma per
 * line is a perfect two-column table by that measure, and a test caught exactly that — six lines of contract prose were
 * encoded as a table.
 *
 * Measured on both corpora rather than guessed:
 *
 *   prose, one comma per line   avg 4.08 words per field
 *   a wide table                avg 1.00
 *   a narrow table              avg 1.00
 *
 * Per-column length variation was the other candidate and it does NOT separate them — 0.19 for prose against 0.57 for a
 * narrow table, the wrong way round. Words per field separates cleanly, so 2.5 sits well clear of both.
 */
export const MAX_WORDS_PER_FIELD = 2.5;

/** Does this block of rows look like values rather than sentences? */
function looksLikeValues(rows) {
  const fields = rows.flat();
  if (!fields.length) return false;
  const words = fields.reduce((n, f) => n + String(f).trim().split(/\s+/).filter(Boolean).length, 0);
  return words / fields.length <= MAX_WORDS_PER_FIELD;
}

/** Both table forms gistline itself emits, plus the one everyone else writes. */
const PIPE_ROW = /^\s*\|.*\|\s*$/;
const SEPARATOR = /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/;

/** Split a pipe row into cells, honouring the escape so a cell containing `\|` stays one cell. */
function pipeCells(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") { cur += "|"; i += 1; continue; }
    if (inner[i] === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += inner[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Split a dense row, which is the form information mode emits: comma-separated with CSV quoting. */
function denseCells(line) {
  const cells = [];
  let cur = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' && cur === "") { quoted = true; continue; }
    if (ch === ",") { cells.push(cur); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Re-emit a dense cell, quoting only when it would otherwise be ambiguous. Matches the writer's rule exactly. */
const denseCell = (s) => (/[",]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s));

/**
 * Find the tables in Markdown text.
 *
 * Both forms are recognised. A PIPE table is unambiguous — every line starts and ends with a pipe. A DENSE table is harder,
 * because comma-separated lines also describe ordinary prose containing commas, so it requires a consistent field count
 * across a run of lines. Prose does not hold a constant comma count for six lines; a table does.
 *
 * Returns segments in order, so the surrounding text keeps its position. A table lifted out of place would lose the sentence
 * that introduces it.
 */
export function findTables(text, { minRows = MIN_ROWS } = {}) {
  const lines = String(text).split("\n");
  const segments = [];
  let i = 0;

  const pushText = (line) => {
    const last = segments[segments.length - 1];
    if (last?.type === "text") last.lines.push(line);
    else segments.push({ type: "text", lines: [line] });
  };

  while (i < lines.length) {
    // --- a pipe table ---
    if (PIPE_ROW.test(lines[i])) {
      let end = i;
      while (end < lines.length && PIPE_ROW.test(lines[end])) end += 1;

      const block = lines.slice(i, end);
      const rows = block.filter((l) => !SEPARATOR.test(l)).map(pipeCells);

      if (rows.length >= minRows) {
        segments.push({ type: "table", form: "pipe", rows, hadSeparator: block.some((l) => SEPARATOR.test(l)) });
        i = end;
        continue;
      }
      for (const l of block) pushText(l);
      i = end;
      continue;
    }

    // --- a dense table: a run of lines with the same field count, more than one field ---
    if (lines[i].includes(",")) {
      const first = denseCells(lines[i]);
      if (first.length > 1) {
        let end = i + 1;
        while (end < lines.length && lines[end].includes(",") && denseCells(lines[end]).length === first.length) end += 1;

        const block = lines.slice(i, end);
        if (block.length >= minRows) {
          const rows = block.map(denseCells);
          // The values check, which is what stops prose containing commas being encoded as a table.
          if (looksLikeValues(rows)) {
            segments.push({ type: "table", form: "dense", rows, hadSeparator: false });
            i = end;
            continue;
          }
        }
      }
    }

    pushText(lines[i]);
    i += 1;
  }

  return segments;
}

/** Marker for an encoded block. A control character, so it cannot collide with content. */
const MARK = "\u0005MDT";

/**
 * Encode the tables in Markdown text.
 *
 * Returns the text unchanged when no table is worth encoding, which is the common case for prose and is a success rather
 * than a failure.
 */
export function encodeTables(text, opts = {}) {
  const segments = findTables(text, opts);
  const tables = segments.filter((s) => s.type === "table");
  if (!tables.length) return { text: String(text), tables: 0 };

  const out = [];

  for (const seg of segments) {
    if (seg.type === "text") { out.push(seg.lines.join("\n")); continue; }

    const width = Math.max(...seg.rows.map((r) => r.length));
    const columns = Array.from({ length: width }, (i0, c) => seg.rows.map((r) => r[c] ?? ""));
    const encoded = columns.map((col) => encodeColumn(col, { minRows: 1 }));

    out.push([
      MARK,
      seg.form,
      seg.hadSeparator ? "sep" : "nosep",
      String(seg.rows.length),
      ...encoded.map((e) => `${e.encoding}:${e.text}`),
    ].join("\u0004"));
  }

  return { text: out.join("\n"), tables: tables.length };
}

/**
 * Reverse `encodeTables` exactly.
 *
 * The FORM and the SEPARATOR are recorded so a pipe table comes back as a pipe table with its separator row, and a dense
 * table as a dense table. Rebuilding both as one shape would be equivalent-looking and different text, and a compressor
 * claiming lossless must return what it was given.
 */
export function decodeTables(text) {
  const out = [];

  for (const line of String(text).split("\n")) {
    if (!line.startsWith(MARK)) { out.push(line); continue; }

    const parts = line.split("\u0004");
    const form = parts[1];
    const hadSeparator = parts[2] === "sep";
    const rowCount = Number(parts[3]);
    if (!Number.isInteger(rowCount)) return null;

    const columns = parts.slice(4).map((spec) => {
      const at = spec.indexOf(":");
      if (at === -1) return null;
      return decodeColumn(spec.slice(0, at), spec.slice(at + 1));
    });
    if (columns.some((c) => c === null)) return null;

    const rows = Array.from({ length: rowCount }, (i0, r) => columns.map((c) => c[r] ?? ""));

    if (form === "pipe") {
      const width = rows[0]?.length ?? 0;
      const render = (r) => `| ${r.map((c) => String(c).replace(/\|/g, "\\|")).join(" | ")} |`;
      const lines = [render(rows[0])];
      if (hadSeparator) lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
      for (const r of rows.slice(1)) lines.push(render(r));
      out.push(lines.join("\n"));
    } else {
      out.push(rows.map((r) => r.map(denseCell).join(",")).join("\n"));
    }
  }

  return out.join("\n");
}

/**
 * The transform.
 *
 * `lossless: true` and verified on every run: the output is decoded and compared against the input, and any mismatch
 * declines the whole thing rather than applying part of it.
 *
 * `truncatable: false` because the output holds encoded blocks. Cutting one leaves a marker line referring to columns that
 * are no longer there — output that looks structured and cannot be read at all.
 */
export const mdTables = {
  id: "md-tables",
  lossless: true,
  truncatable: false,

  /**
   * Cheap predicate: enough text to hold a table, and a sign of one.
   *
   * A pipe or a comma is a weak signal on its own, which is deliberate — the real decision is made in `findTables`, which
   * requires a consistent field count across at least six lines. Prose does not hold that; a table does.
   */
  applies: (ctx) => ctx.text.length > 400 && /\n/.test(ctx.text) && /[|,]/.test(ctx.text),

  run: (ctx) => {
    const parts = split(ctx.text);
    const { text, tables } = encodeTables(ctx.text);

    if (!tables) return { text: ctx.text, applied: false, reason: "no table large enough to be worth encoding" };
    if (text.length >= ctx.text.length) {
      return { text: ctx.text, applied: false, reason: `encoding would grow the output (${ctx.text.length} -> ${text.length})` };
    }

    // The lossless claim, checked on this exact input.
    const back = decodeTables(text);
    if (back !== join({ ...parts, trailing: false })) {
      return { text: ctx.text, applied: false, reason: "declined: reconstruction did not match the input exactly" };
    }

    return {
      text,
      applied: true,
      reason: `${tables} table(s) encoded by column, nothing removed`,
    };
  },
};

export default mdTables;
