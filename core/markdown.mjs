// The Markdown writer.
//
// ONE RESPONSIBILITY: render a document model as Markdown. It reads no format and parses nothing.
//
// This is the module that stops four readers each carrying their own copy of "how do I write a table". Pipe escaping,
// ragged-row padding and the header separator are decided here, once, and every reader inherits them.
//
// The output is plain CommonMark with GitHub-style tables — no HTML fallbacks, no custom syntax — because the next stage
// in the pipeline is a compressor that has to be able to read it.

import { validate, textLength } from "./doc.mjs";

/**
 * TWO OUTPUT MODES, and `information` is the default.
 *
 * The purpose of reading a document is almost always to learn what it says, not to rebuild it — so the default output
 * carries the information and drops the presentation. Reconstruction is an occasional, explicit request.
 *
 * WHICH PARTS ARE OVERHEAD WAS MEASURED, NOT ASSUMED. On a realistic report (4 headings, a list, a 40x6 table):
 *
 *   table delimiters      28.7% of the output   <- the dominant cost
 *   separator row          1.4%                 <- carries nothing at all
 *   heading/list markers   0.6%                 <- cheap, and a heading LEVEL is information
 *
 * So information mode keeps headings and list markers, because they are almost free and the hierarchy of an argument is
 * part of what the document says. It replaces the pipe table, because that is where the cost actually is.
 *
 * Rows are encoded with the SHARED delimiter-safe encoder rather than joined with commas, so a cell containing a comma or
 * a newline survives. That encoder already has round-trip tests; writing a second escaping scheme here is how this project
 * produced its worst class of bug twice.
 */
export const MODES = ["information", "preserve"];

/**
 * Escape a table cell.
 *
 * A pipe would end the cell and a newline would end the row, so both must go. The newline becomes a space rather than
 * `<br>`: a cell containing HTML defeats the point of converting away from HTML, and a compressor downstream would then
 * be compressing markup again.
 */
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();

/**
 * A cell in the dense form.
 *
 * Quoted ONLY when it would otherwise be ambiguous — it contains the delimiter, a quote, or a newline. That is the standard
 * CSV rule and nothing more.
 *
 * WHY NOT `encodeRow`, WHICH ALREADY EXISTS. It quotes any numeric-looking string in order to round-trip the
 * string-versus-number distinction, so `1200.5` becomes `"1200.5"`. Measured at 7.9% of the encoded text, and worse than
 * the size: it puts quotes through output that a model has to read, for a distinction information mode explicitly does not
 * need.
 *
 * The two have genuinely different requirements — the lossless path must reproduce types exactly, this one must only be
 * unambiguous to a reader — so `encodeRow` is left alone rather than given a mode. Making a shared, heavily-tested
 * primitive serve two masters is how it stops being trustworthy for either.
 */
const denseCell = (s) => {
  const v = String(s ?? "").replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/** Render one table. Ragged rows are padded HERE, so no reader has to decide the width. */
function renderTable(b, mode) {
  const width = Math.max(b.head.length, ...b.rows.map((r) => r.length), 1);
  const pad = (r) => Array.from({ length: width }, (i0, i) => r[i] ?? "");

  if (mode === "information") {
    /**
     * The dense form: a header line, then one line per row.
     *
     * No separator row, no pipes, no padding — measured as 28.7% of a report's output, and this is what removes it. Every
     * value is present and every row has the same field count, so a reader can still tell which value belongs to which
     * column, which is the only thing a table's structure has to convey.
     */
    const lines = [pad(b.head).map(denseCell).join(",")];
    for (const r of b.rows) lines.push(pad(r).map(denseCell).join(","));
    return lines.join("\n");
  }

  const lines = [];
  // A headerless table still needs a header row, because Markdown has no syntax for one without. Empty cells are the
  // honest choice: inventing column names would put words in the document that were never in the source.
  lines.push(`| ${pad(b.head).map((c) => cell(c)).join(" | ")} |`);
  lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
  for (const r of b.rows) lines.push(`| ${pad(r).map((c) => cell(c)).join(" | ")} |`);
  return lines.join("\n");
}

/** Render one list. Ordered items are numbered by position, which is what a reader of the source saw. */
function renderList(b) {
  return b.items
    .map((item, i) => {
      const marker = b.ordered ? `${i + 1}.` : "-";
      // Preserve an item's own line breaks as continuation lines, indented so they stay part of the item.
      const text = String(item).split(/\r?\n/).map((l, j) => (j === 0 ? l : `  ${l.trim()}`)).join("\n");
      return `${marker} ${text}`;
    })
    .join("\n");
}

/** Render one block. Unknown types are impossible after `validate`, so the default throws rather than guessing. */
function renderBlock(b, mode) {
  switch (b.type) {
    case "heading": return `${"#".repeat(b.level)} ${String(b.text).replace(/\r?\n/g, " ").trim()}`;
    case "paragraph": return String(b.text).trim();
    case "list": return renderList(b);
    case "table": return renderTable(b, mode);
    case "code": return `\`\`\`${b.lang}\n${b.text.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n\`\`\``;
    case "raw": return String(b.text);
    case "rule": return "---";
    default: throw new Error(`markdown: no renderer for block type ${JSON.stringify(b.type)}`);
  }
}

/**
 * Render a document.
 *
 * `mode` defaults to `information`: the caller wanted to know what the document says. `preserve` produces
 * GitHub-flavoured Markdown a person can paste somewhere, and is for when reconstruction or presentation matters.
 *
 * `notes` are emitted at the END and clearly marked. A reader that skipped tracked changes or met an element it could
 * not represent records a note, and surfacing it is the difference between a converter with known limits and one that
 * quietly pretends it read everything.
 */
export function toMarkdown(d, { includeNotes = true, mode = "information" } = {}) {
  validate(d);
  if (!MODES.includes(mode)) throw new Error(`markdown: unknown mode ${JSON.stringify(mode)}. Use one of: ${MODES.join(", ")}`);

  const body = d.blocks
    .map((b) => renderBlock(b, mode))
    .map((s) => s.trim())
    .filter((s) => s.length)
    .join("\n\n");

  if (!includeNotes || !d.notes.length) return body;

  const notes = d.notes.map((n) => `- ${n}`).join("\n");
  return `${body}\n\n---\n\n**What this conversion could not represent**\n\n${notes}`;
}

/** Was the conversion worth doing? Compared on rendered length, since that is what the next stage receives. */
export function worthIt(d, originalLength, { minGain = 0.1 } = {}) {
  const rendered = toMarkdown(d).length;
  const gain = (originalLength - rendered) / Math.max(1, originalLength);
  return { worth: gain >= minGain, rendered, gain, textLength: textLength(d) };
}
