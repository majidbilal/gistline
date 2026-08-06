// DOCX reader.
//
// ONE RESPONSIBILITY: turn a Word document into document-model blocks. It emits no Markdown.
//
// THREE THINGS THAT FAIL SILENTLY, named before writing because each produces a plausible result rather than an error:
//
//   1. DELETED TEXT IS STILL IN THE FILE. Tracked changes store removals as `<w:del>` with the original text intact
//      inside. Reading every `<w:t>` therefore resurrects text the author deleted — and in a contract or a policy that
//      is not a formatting glitch, it is a wrong document that reads perfectly.
//
//   2. LIST NUMBERS ARE NOT IN THE PARAGRAPH. A numbered paragraph carries only a reference into `numbering.xml`; the
//      digits are computed by the renderer. Extracting the paragraph text alone loses the enumeration entirely.
//
//   3. WHITESPACE IS SIGNIFICANT AND CONDITIONAL. A run's text is `<w:t xml:space="preserve">` when its spaces matter.
//      Trimming everything joins words together; trimming nothing leaves ragged output.

import { readZip } from "../util/unzip.mjs";
import { doc, heading, paragraph, list, table, code } from "../core/doc.mjs";

/** Only what a document's text needs. Images, fonts, themes and settings are never inflated. */
const wanted = (name) =>
  name === "word/document.xml" ||
  name === "word/numbering.xml" ||
  name === "word/_rels/document.xml.rels" ||
  name === "word/footnotes.xml";

const asText = (buf) => (buf ? buf.toString("utf8") : "");

/** Decode XML entities. Ampersand last, or an escaped entity decodes twice and becomes markup. */
const unxml = (s) =>
  String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");

/**
 * Remove the parts of a paragraph that are not its current content.
 *
 * `<w:del>` holds text the author deleted with tracked changes on. `<w:delText>` is its inner element. Both must go
 * BEFORE any text is collected, because afterwards the deleted words are indistinguishable from kept ones.
 *
 * `<w:ins>` — inserted text — is kept and unwrapped: an insertion is part of the current document.
 */
export function stripRevisions(xml) {
  let s = String(xml);
  let previous;
  // Loop: revisions nest, and one pass leaves the inner ones behind.
  do {
    previous = s;
    s = s.replace(/<w:del\b[^>]*>[\s\S]*?<\/w:del>/g, "");
  } while (s !== previous);
  // A self-closing or unmatched form, and the standalone deleted-text element.
  s = s.replace(/<w:del\b[^>]*\/>/g, "");
  s = s.replace(/<w:delText\b[^>]*>[\s\S]*?<\/w:delText>/g, "");
  return s;
}

/**
 * The text of one paragraph or cell.
 *
 * `xml:space="preserve"` is honoured by NOT trimming those runs. A run without it may still carry meaningful single
 * spaces, so runs are joined as-is and only the assembled line is trimmed at its ends — which keeps interior spacing and
 * removes only the ragged edges.
 *
 * `<w:tab>` becomes a space and `<w:br>` a newline, because both are content rather than formatting.
 */
export function runText(xml) {
  // Tabs and breaks are substituted AS TEXT ELEMENTS, not as bare characters.
  //
  // A bare space would be inert: the collector below reads only what is inside `<w:t>`, so a space placed between two
  // runs sits outside every match and is discarded. The first version did exactly that, and `A<tab>B` came out as `AB`
  // — a table of contents or any tabbed layout would collapse into one unbroken line. A test caught it.
  const cleaned = stripRevisions(xml)
    .replace(/<w:tab\b[^>]*\/?>/g, '<w:t xml:space="preserve"> </w:t>')
    .replace(/<w:br\b[^>]*\/?>/g, '<w:t xml:space="preserve">\n</w:t>');

  const parts = [];
  for (const m of cleaned.matchAll(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g)) {
    parts.push(unxml(m[2]));
  }
  // Also the self-closing empty form, which contributes nothing but must not break the match above.
  return parts.join("").replace(/[ \t]+\n/g, "\n").replace(/^[ \t]+|[ \t]+$/g, "");
}

/**
 * Which numbering definitions are ORDERED.
 *
 * A numbered paragraph references a `numId`, which resolves through `numbering.xml` to an abstract definition whose
 * first level has a format: `decimal`, `bullet`, `lowerLetter` and so on. Without following that chain, a numbered list
 * and a bulleted list are indistinguishable in the document body — and rendering one as the other loses the fact that
 * the items were in a sequence.
 */
export function readNumbering(xml) {
  if (!xml) return new Map();

  // abstractNumId -> is the first level ordered?
  const abstract = new Map();
  for (const m of String(xml).matchAll(/<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const firstLevel = m[2].match(/<w:lvl\b[^>]*w:ilvl="0"[\s\S]*?<\/w:lvl>/);
    const fmt = (firstLevel?.[0].match(/<w:numFmt\b[^>]*w:val="([^"]+)"/) ?? [])[1] ?? "bullet";
    abstract.set(m[1], fmt !== "bullet" && fmt !== "none");
  }

  // numId -> ordered?
  const byNum = new Map();
  for (const m of String(xml).matchAll(/<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const ref = (m[2].match(/<w:abstractNumId\b[^>]*w:val="(\d+)"/) ?? [])[1];
    byNum.set(m[1], abstract.get(ref) ?? false);
  }
  return byNum;
}

/** Hyperlink targets, so a link's URL survives. A link whose text is its own URL is not worth duplicating. */
function readRels(xml) {
  const rels = new Map();
  for (const m of String(xml ?? "").matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    rels.set(m[1], unxml(m[2]));
  }
  return rels;
}

/** Inline hyperlinks are rewritten to Markdown before the text is collected, since afterwards the target is gone. */
function inlineLinks(xml, rels) {
  return String(xml).replace(/<w:hyperlink\b([^>]*)>([\s\S]*?)<\/w:hyperlink>/g, (m, attrs, inner) => {
    const id = (attrs.match(/r:id="([^"]+)"/) ?? [])[1];
    const href = id ? rels.get(id) : null;
    const label = runText(inner);
    if (!href || !label) return inner;
    if (label === href) return `<w:r><w:t xml:space="preserve">${href}</w:t></w:r>`;
    // Re-wrapped as a run so the surrounding paragraph logic is unchanged.
    return `<w:r><w:t xml:space="preserve">[${label}](${href})</w:t></w:r>`;
  });
}

/** A paragraph's style name, which is how a heading announces itself. */
function styleOf(paraXml) {
  return (paraXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/) ?? [])[1] ?? "";
}

/** Heading level from a style name. `Heading2`, `heading 2` and `Title` all occur in real documents. */
function headingLevel(style) {
  if (/^title$/i.test(style)) return 1;
  if (/^subtitle$/i.test(style)) return 2;
  const m = style.match(/^heading[\s_-]*(\d)$/i);
  return m ? Math.min(6, Number(m[1])) : 0;
}

/** The numbering reference on a paragraph, if it is a list item. */
function numberingOf(paraXml) {
  const numPr = paraXml.match(/<w:numPr\b[\s\S]*?<\/w:numPr>/);
  if (!numPr) return null;
  const numId = (numPr[0].match(/<w:numId\b[^>]*w:val="(\d+)"/) ?? [])[1];
  const ilvl = Number((numPr[0].match(/<w:ilvl\b[^>]*w:val="(\d+)"/) ?? [])[1] ?? 0);
  return numId ? { numId, level: ilvl } : null;
}

/**
 * Walk a table into rows of cell text.
 *
 * A cell holds paragraphs, so its text is those paragraphs joined by a newline — the writer turns that into a space.
 * Nested tables are flattened to their text rather than dropped: losing a nested table's content would be worse than
 * losing its shape, and the model has no nested-table block.
 */
function readTable(tblXml, ctx) {
  const rows = [];
  for (const tr of tblXml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
    const cells = [];
    for (const tc of tr[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
      const paras = [...tc[1].matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)]
        .map((p) => runText(inlineLinks(stripRevisions(p[1]), ctx.rels)))
        .filter(Boolean);
      cells.push(paras.join("\n"));
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * Read the body into blocks.
 *
 * Paragraphs and tables are walked IN DOCUMENT ORDER, which means matching them from one scan rather than collecting
 * each kind separately — a table sitting between two paragraphs must stay between them, and gathering all paragraphs
 * then all tables would silently reorder the document.
 *
 * Consecutive list items are gathered into one list block, because a run of items is one list to a reader even though
 * the file records each as its own paragraph.
 */
function readBody(bodyXml, ctx) {
  const blocks = [];
  let pending = null; // an open list: { ordered, items, numId, level }

  const flush = () => {
    if (pending?.items.length) blocks.push(list(pending.items, { ordered: pending.ordered }));
    pending = null;
  };

  // One pass over top-level paragraphs and tables, in order.
  const re = /<w:(p|tbl)\b[^>]*>([\s\S]*?)<\/w:\1>/g;
  for (const m of bodyXml.matchAll(re)) {
    if (m[1] === "tbl") {
      flush();
      const rows = readTable(m[2], ctx);
      if (!rows.length) continue;
      // A first row of non-empty cells is treated as a header: Word marks header rows inconsistently, and a table whose
      // first row is its headings is the overwhelmingly common case.
      const [head, ...body] = rows;
      blocks.push(body.length ? table(head, body) : table([], rows));
      continue;
    }

    const inner = inlineLinks(stripRevisions(m[2]), ctx.rels);
    const content = runText(inner);
    const num = numberingOf(m[2]);
    const level = headingLevel(styleOf(m[2]));

    if (num) {
      const ordered = ctx.numbering.get(num.numId) ?? false;
      // A change of numbering id or list type starts a new list; a change of indent level does not, because the model
      // has no nested list and indenting the text is closer to the source than splitting it.
      if (!pending || pending.numId !== num.numId || pending.ordered !== ordered) {
        flush();
        pending = { ordered, items: [], numId: num.numId, level: num.level };
      }
      if (content) pending.items.push(num.level > 0 ? `${"  ".repeat(num.level)}${content}` : content);
      continue;
    }

    flush();
    if (!content) continue;
    blocks.push(level ? heading(level, content) : paragraph(content));
  }

  flush();
  return blocks;
}

/**
 * Read a whole document.
 *
 * Footnotes are appended as their own section rather than inlined, because inlining them at the reference point breaks
 * the sentence they interrupt — and a reader looking for a footnote can find a section titled Footnotes.
 */
export function readDocx(buffer) {
  const { files, errors } = readZip(buffer, { only: wanted });
  const notes = [...errors];

  const documentXml = asText(files.get("word/document.xml"));
  if (!documentXml) throw new Error("not a Word document: word/document.xml is missing");

  const ctx = {
    numbering: readNumbering(asText(files.get("word/numbering.xml"))),
    rels: readRels(asText(files.get("word/_rels/document.xml.rels"))),
  };

  const body = (documentXml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/) ?? [, documentXml])[1];
  const blocks = readBody(body, ctx);

  // Tracked deletions were removed, and that is worth stating: a reader comparing this against the original document
  // needs to know which version they are looking at.
  if (/<w:del\b/.test(documentXml)) {
    notes.push("This document contains tracked changes. Deleted text was excluded and insertions were kept, so this is the revised version.");
  }
  if (/<w:commentReference\b/.test(documentXml)) {
    notes.push("Comments are not included.");
  }

  const footnotesXml = asText(files.get("word/footnotes.xml"));
  if (footnotesXml) {
    const items = [...footnotesXml.matchAll(/<w:footnote\b[^>]*w:id="(\d+)"[^>]*>([\s\S]*?)<\/w:footnote>/g)]
      // Ids 0 and -1 are the separator and continuation notices, not content.
      .filter((m) => Number(m[1]) > 0)
      .map((m) => runText(stripRevisions(m[2])))
      .filter(Boolean);
    if (items.length) {
      blocks.push(heading(2, "Footnotes"));
      blocks.push(list(items, { ordered: true }));
      notes.push("Footnotes are collected at the end rather than shown at their reference points.");
    }
  }

  if (!blocks.length) blocks.push(paragraph("This document contains no readable text."));
  notes.push("Images, charts, headers, footers and formatting are not included.");

  return { document: doc(blocks, { notes, source: "docx" }), blocks: blocks.length };
}
