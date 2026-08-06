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
 * Escape a table cell.
 *
 * A pipe would end the cell and a newline would end the row, so both must go. The newline becomes a space rather than
 * `<br>`: a cell containing HTML defeats the point of converting away from HTML, and a compressor downstream would then
 * be compressing markup again.
 */
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();

/** Render one table. Ragged rows are padded HERE, so no reader has to decide the width. */
function renderTable(b) {
  const width = Math.max(b.head.length, ...b.rows.map((r) => r.length), 1);
  const pad = (r) => Array.from({ length: width }, (i0, i) => cell(r[i] ?? ""));

  const lines = [];
  // A headerless table still needs a header row, because Markdown has no syntax for one without. Empty cells are the
  // honest choice: inventing column names would put words in the document that were never in the source.
  lines.push(`| ${pad(b.head).join(" | ")} |`);
  lines.push(`| ${Array(width).fill("---").join(" | ")} |`);
  for (const r of b.rows) lines.push(`| ${pad(r).join(" | ")} |`);
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
function renderBlock(b) {
  switch (b.type) {
    case "heading": return `${"#".repeat(b.level)} ${String(b.text).replace(/\r?\n/g, " ").trim()}`;
    case "paragraph": return String(b.text).trim();
    case "list": return renderList(b);
    case "table": return renderTable(b);
    case "code": return `\`\`\`${b.lang}\n${b.text.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n\`\`\``;
    case "raw": return String(b.text);
    case "rule": return "---";
    default: throw new Error(`markdown: no renderer for block type ${JSON.stringify(b.type)}`);
  }
}

/**
 * Render a document.
 *
 * `notes` are emitted at the END and clearly marked. A reader that skipped tracked changes or met an element it could
 * not represent records a note, and surfacing it is the difference between a converter with known limits and one that
 * quietly pretends it read everything.
 */
export function toMarkdown(d, { includeNotes = true } = {}) {
  validate(d);

  const body = d.blocks
    .map(renderBlock)
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
