// PDF to the document model.
//
// ONE RESPONSIBILITY: assemble the classifier, the object reader and the text extractor into a document. It parses
// nothing itself.
//
// EXTRACTION IS PER PAGE, and that is a decision the plan's review forced. A real 80-page PDF may have 70 clean pages and
// 10 scanned ones, or one page whose fonts have no recovery path. The two obvious behaviours are both wrong: refusing the
// whole document loses 70 good pages, and silently omitting 10 tells the reader nothing.
//
// So each page succeeds or fails on its own, and the failures are reported BY PAGE NUMBER. "Pages 34 to 43 have no text
// layer and were skipped" is actionable; a gap in the middle of the text is not.

import { doc, paragraph, heading, raw, table } from "../core/doc.mjs";
import { loadPdf, pageOrder, pageContent } from "../util/pdfobj.mjs";
import { classifyPdf, describePdf } from "./pdf-classify.mjs";
import { extractPage, buildPageFonts } from "./pdf-text.mjs";
import { findRunningContent, describeRunningContent } from "./pdf-running.mjs";
import { findTables, tableCaveats, looksLikeHeaderRow } from "./pdf-tables.mjs";

/**
 * Below this ratio of resolvable codes, a page's text is not worth emitting.
 *
 * Set low deliberately. A page mixing one unreadable decorative font with readable body text is worth keeping, and the
 * threshold exists to catch the case where almost NOTHING resolved — which is the case that produces confident nonsense.
 */
export const MIN_RELIABILITY = 0.5;

/** Collapse a list of page numbers into ranges, so a note reads "34-43" rather than listing ten numbers. */
export function asRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const out = [];
  let start = null;
  let prev = null;

  for (const n of sorted) {
    if (start === null) { start = n; prev = n; continue; }
    if (n === prev + 1) { prev = n; continue; }
    out.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out.join(", ");
}

/**
 * Read a PDF into the document model.
 *
 * Throws only when NOTHING can be read — an encrypted file, a file with no text layer at all. A partially readable
 * document returns what it has, with the gaps named.
 */
export function readPdf(buffer, { mode = "read", minReliability = MIN_RELIABILITY, tables = true } = {}) {
  const classification = classifyPdf(buffer);

  // The cases where no per-page attempt can help. Refused with the classifier's own reason, which is more specific than
  // anything this function could add.
  if (["encrypted", "not-pdf", "damaged", "scanned"].includes(classification.verdict)) {
    const e = new Error(describePdf(classification));
    e.verdict = classification.verdict;
    e.classification = classification;
    throw e;
  }

  const { bytes, objects, errors: loadErrors } = loadPdf(buffer);
  const { pages, inferred } = pageOrder(bytes, objects);

  const notes = [...loadErrors];
  if (inferred) {
    notes.push("Page order could not be read from the page tree and was inferred from object numbering.");
  }

  const blocks = [];
  const skipped = { empty: [], unreliable: [], failed: [] };
  let totalUnmapped = 0;

  // FIRST PASS: extract every page's positioned lines.
  //
  // Two passes are necessary rather than tidy. Whether a line is running furniture depends on the OTHER pages — it is a
  // cross-page question — so no page can be finalised until all of them have been read. Emitting text as each page was
  // extracted, as the previous version did, made Tier 3 impossible to add without extracting twice.
  const extracted = [];

  pages.forEach((pageNum, i) => {
    const humanPage = i + 1;

    let page;
    try {
      const { text: content, errors } = pageContent(bytes, objects, pageNum);
      if (errors.length) notes.push(`Page ${humanPage}: ${errors.join("; ")}`);
      if (!content) { skipped.empty.push(humanPage); return; }

      const fonts = buildPageFonts(bytes, objects, objects.get(pageNum));
      page = extractPage(content, { fonts });
    } catch (e) {
      // One bad page must not cost the other seventy-nine.
      skipped.failed.push(humanPage);
      notes.push(`Page ${humanPage} could not be read: ${e.message}`);
      return;
    }

    totalUnmapped += page.unmapped;

    if (!page.text.trim()) { skipped.empty.push(humanPage); return; }

    // A page where almost nothing resolved would contribute confident nonsense. Refused individually rather than dragging
    // the document down with it.
    if (page.reliability < minReliability) {
      skipped.unreliable.push(humanPage);
      return;
    }

    extracted.push({ humanPage, lines: page.positioned });
  });

  // SECOND PASS: remove the furniture, then emit.
  const running = findRunningContent(extracted.map((p) => p.lines));

  if (running.furniture.length) {
    // Stated once, at the top, rather than dropped silently — a reader needs to know the header existed.
    notes.push(...describeRunningContent(running.furniture));
  }

  let recovered = 0;
  const tableNotes = [];

  extracted.forEach((p, i) => {
    const lines = running.pages[i] ?? p.lines;
    if (!lines.length) { skipped.empty.push(p.humanPage); return; }

    recovered += 1;
    // Page boundaries are kept as a marker rather than a heading: in read mode a page number is not content, but a reader
    // scanning for "the table on page 4" needs the boundary to exist.
    if (blocks.length) blocks.push(raw(`<!-- page ${p.humanPage} -->`));

    /**
     * Tables are recovered IN PLACE, as segments interleaved with the prose.
     *
     * Lifting a table out and appending it would lose the sentence that introduces it — "sales by region were as follows"
     * followed by nothing is worse than a table left as text.
     *
     * `positioned` lines carry their runs, which is what alignment detection needs; a line whose runs were discarded
     * cannot be assessed, so those fall through as prose rather than being dropped.
     */
    const segments = tables ? findTables(lines.filter((l) => l.runs)) : [{ type: "text", lines }];
    const withoutRuns = lines.filter((l) => !l.runs);

    for (const seg of segments) {
      if (seg.type === "table") {
        const rows = seg.rows;
        const header = looksLikeHeaderRow(rows);
        blocks.push(header ? table(rows[0], rows.slice(1)) : table([], rows));

        // Caveats are per table and reported once each, so a document with five clean tables and one suspect one says so.
        for (const c of tableCaveats(rows)) {
          const note = `Page ${p.humanPage}, table with ${seg.columns} column(s): ${c}`;
          if (!tableNotes.includes(note)) tableNotes.push(note);
        }
        continue;
      }

      const text = seg.lines.map((l) => l.text).join("\n").trim();
      if (text) blocks.push(paragraph(text));
    }

    // Any line without runs still contributes its text rather than vanishing.
    const leftover = withoutRuns.map((l) => l.text).join("\n").trim();
    if (leftover) blocks.push(paragraph(leftover));
  });

  const tableCount = blocks.filter((b) => b.type === "table").length;
  if (tableCount) {
    notes.push(
      `${tableCount} table(s) were recovered from the alignment of the text. A PDF records no table structure, so these `
      + "grids are INFERRED: the cells are the words that were there, but the row and column boundaries are a reading of "
      + "the layout rather than something the document declared.",
    );
    notes.push(...tableNotes);
  }

  // The gaps, by page number.
  if (skipped.empty.length) {
    notes.push(`No text found on page(s) ${asRanges(skipped.empty)} — these are likely images or blank.`);
  }
  if (skipped.unreliable.length) {
    notes.push(
      `Page(s) ${asRanges(skipped.unreliable)} were skipped: their fonts carry no usable character mapping, so the `
      + "extracted text would have been glyph ids rather than words.",
    );
  }
  if (skipped.failed.length) {
    notes.push(`Page(s) ${asRanges(skipped.failed)} could not be parsed.`);
  }

  if (!recovered) {
    const e = new Error(
      `${describePdf(classification)} No page yielded readable text`
      + `${skipped.unreliable.length ? " — the fonts carry no usable character mapping" : ""}.`,
    );
    e.verdict = "unreadable";
    e.classification = classification;
    throw e;
  }

  // The confidence basis, stated once for the document. Tier 1 only claims single-column order.
  notes.push(
    "Reading order follows each page's own drawing order. That is correct for single-column pages and is not verified "
    + "for multi-column layouts, where columns may be interleaved.",
  );

  if (classification.divergence?.actualText) {
    // PDF separates rendering from extraction by design; /ActualText changes what an extractor reports without changing
    // what is drawn. Usually legitimate, and worth surfacing when the text is going to a model.
    notes.push(
      `This document uses ${classification.divergence.actualText} /ActualText override(s), which can make extracted text `
      + "differ from what is displayed.",
    );
  }

  if (totalUnmapped) {
    notes.push(`${totalUnmapped} character code(s) across the document could not be mapped and were omitted.`);
  }

  notes.push(
    mode === "preserve"
      ? "Preserve mode is not implemented for PDF; this is a read-mode extraction and layout is not recoverable from it."
      // Kept accurate as tiers landed. This note previously said tables were not separated out, which stopped being true
      // the moment Tier 4 was wired — a stale claim in the output is worse than no claim, because a reader believes it.
      : "Read mode: text, tables recovered from alignment, and running headers stated once. Fonts, colours, images, exact "
        + "positions and page layout are not included.",
  );

  return {
    document: doc(blocks, { notes, source: "pdf" }),
    pages: pages.length,
    recovered,
    skipped,
    classification,
  };
}
