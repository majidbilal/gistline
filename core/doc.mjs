// The document model.
//
// ONE RESPONSIBILITY: describe a document as blocks, in a form every reader can produce and one writer can render.
//
// WHY THIS EXISTS. The HTML transform converted straight to Markdown. Had XLSX, DOCX and PPTX done the same, the logic
// for emitting a Markdown table — pipe escaping, ragged-row padding, the header separator — would have existed FOUR
// times. This project has already produced that failure once: the same escaping rules were derived twice and the second
// derivation was wrong.
//
// The shape is borrowed from the most mature converter in this space, which describes itself as "a set of readers…
// which produce a native representation of the document… and a set of writers". Adding a format then means adding a
// reader, not a converter.
//
// DELIBERATELY SMALL. Six block types, and no styling, no fonts, no colours, no positioning. A model that tried to
// represent everything would be a worse version of the formats it reads from. The honest framing, which the same
// project states about itself: the intermediate representation is less expressive than the formats it converts between,
// so perfect fidelity is not on offer — and saying so is better than implying otherwise.

/** Block constructors. Plain objects, so a reader needs no imports beyond these and a writer needs no classes. */

/** A heading. `level` is clamped to 1–6, because a reader may find `<h9>` or a nine-deep outline. */
export const heading = (level, text) => ({ type: "heading", level: Math.min(6, Math.max(1, Number(level) || 1)), text: String(text ?? "") });

/** A run of prose. */
export const paragraph = (text) => ({ type: "paragraph", text: String(text ?? "") });

/** A list. `ordered` decides numbering; items are strings, because nested lists are represented by indented text. */
export const list = (items, { ordered = false } = {}) => ({ type: "list", ordered: !!ordered, items: (items ?? []).map((i) => String(i ?? "")) });

/**
 * A table. `head` may be empty for a headerless table.
 *
 * Rows are arrays of strings and may be ragged — the writer pads them. Readers should not pad, because a reader that
 * pads has to decide the width, and two readers deciding it differently is how a shared writer stops being shared.
 */
export const table = (head, rows) => ({ type: "table", head: (head ?? []).map((c) => String(c ?? "")), rows: (rows ?? []).map((r) => (r ?? []).map((c) => String(c ?? ""))) });

/** A code block. `lang` is optional and unvalidated: a reader knows more about it than this module does. */
export const code = (text, { lang = "" } = {}) => ({ type: "code", lang: String(lang ?? ""), text: String(text ?? "") });

/**
 * Text to emit verbatim.
 *
 * The escape hatch, and it exists so a reader is never forced to lie. Content that does not fit the five real block
 * types goes here intact rather than being squeezed into a paragraph and losing its shape.
 */
export const raw = (text) => ({ type: "raw", text: String(text ?? "") });

/** A separator. Kept because it carries meaning in slide decks and printed documents. */
export const rule = () => ({ type: "rule" });

export const BLOCK_TYPES = ["heading", "paragraph", "list", "table", "code", "raw", "rule"];

/**
 * A document: blocks plus what the reader could not represent.
 *
 * `notes` is not decoration. A reader that skipped tracked changes, or found an unsupported element, records it here and
 * the writer surfaces it — so the reader's limits reach the person reading the output rather than staying in a comment.
 */
export const doc = (blocks = [], { notes = [], source = null } = {}) => ({
  blocks: blocks.filter(Boolean),
  notes: [...notes],
  source,
});

/** Validate a document, so a malformed reader fails at its own boundary rather than inside the writer. */
export function validate(d) {
  if (!d || !Array.isArray(d.blocks)) throw new Error("document: blocks must be an array");
  for (const [i, b] of d.blocks.entries()) {
    if (!b || !BLOCK_TYPES.includes(b.type)) {
      throw new Error(`document: block ${i} has unknown type ${JSON.stringify(b?.type)}`);
    }
  }
  return d;
}

/** Total text length, for deciding whether a conversion was worth it without rendering first. */
export const textLength = (d) =>
  (d.blocks ?? []).reduce((n, b) => {
    if (b.type === "table") return n + b.head.join("").length + b.rows.reduce((m, r) => m + r.join("").length, 0);
    if (b.type === "list") return n + b.items.join("").length;
    if (b.type === "rule") return n + 3;
    return n + String(b.text ?? "").length;
  }, 0);
