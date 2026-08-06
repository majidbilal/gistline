// PPTX reader.
//
// ONE RESPONSIBILITY: turn a slide deck into document-model blocks. It emits no Markdown.
//
// READ MODE IS THE DEFAULT, and for a deck that distinction is larger than for any other format. A slide is mostly
// LAYOUT: positions, placeholder geometry, transitions, theme colours, animation timings. Almost none of it is
// information. What a reader wants is the words, in slide order, with the titles marked.
//
// So this reader keeps: slide titles, body text in reading order, tables, and speaker notes. It drops: geometry,
// theme, transitions, animations, and the placeholder machinery — and says so, rather than implying it read everything.
//
// THE RISKS, named before writing because each fails quietly:
//
//   1. SLIDE ORDER IS NOT FILE ORDER. `slide10.xml` sorts before `slide2.xml` as a string, so naive sorting scrambles a
//      ten-slide deck. The real order is in the presentation's relationships.
//   2. A TITLE IS A PLACEHOLDER TYPE, not a position or a font size. Guessing by size would be wrong on any deck with a
//      custom template.
//   3. A PARAGRAPH IS SPLIT INTO RUNS, exactly as in Word: one italic word makes three `<a:t>` elements.
//   4. SPEAKER NOTES ARE A SEPARATE FILE per slide, linked by relationship. Ignoring them loses what is often the only
//      prose in the deck — the slide says three words and the notes say the actual point.

import { readZip } from "../util/unzip.mjs";
import { doc, heading, paragraph, list, table, rule } from "../core/doc.mjs";

const wanted = (name) =>
  name === "ppt/presentation.xml" ||
  name === "ppt/_rels/presentation.xml.rels" ||
  /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
  /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name) ||
  /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name);

const asText = (buf) => (buf ? buf.toString("utf8") : "");

/** Decode XML entities. Ampersand last, or an escaped entity decodes twice and becomes markup. */
const unxml = (s) =>
  String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");

/**
 * Text of one paragraph, joining its runs.
 *
 * RISK 3. `<a:br/>` becomes a newline as a text element rather than a bare character, for the same reason it must in
 * Word: the collector reads only what is inside `<a:t>`, so a bare character placed between runs is discarded and the
 * substitution does nothing. That exact bug was found in the Word reader by a test.
 */
export function paraText(xml) {
  const cleaned = String(xml).replace(/<a:br\b[^>]*\/?>/g, "<a:t>\n</a:t>");
  return [...cleaned.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((m) => unxml(m[1]))
    .join("")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Slide order, from the presentation's relationships.
 *
 * RISK 1. `<p:sldIdLst>` lists slides in presentation order by relationship id, and the relationships map those to file
 * names. Sorting file names as strings puts slide10 before slide2; sorting them numerically is closer but still wrong,
 * because a deck whose slides were reordered keeps its original file names.
 */
export function slideOrder(presentationXml, relsXml) {
  const rels = new Map();
  for (const m of String(relsXml ?? "").matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    rels.set(m[1], `ppt/${m[2].replace(/^\.\.\//, "").replace(/^\/?ppt\//, "")}`);
  }

  const order = [];
  for (const m of String(presentationXml ?? "").matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)) {
    const path = rels.get(m[1]);
    if (path) order.push(path);
  }
  return order;
}

/**
 * Is this shape the slide's title?
 *
 * RISK 2. A title declares itself as a placeholder of type `title` or `ctrTitle` in `<p:ph>`. Nothing about its position
 * or font size is reliable — a custom template can put the title anywhere at any size, and a large text box that is not
 * a title is ordinary.
 */
const isTitleShape = (shapeXml) => /<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(shapeXml);

/** Text of a table inside a slide, as rows of cell text. */
function shapeTable(shapeXml) {
  const rows = [];
  for (const tr of shapeXml.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
    const cells = [...tr[1].matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((tc) =>
      [...tc[1].matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((p) => paraText(p[1])).filter(Boolean).join(" "));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/**
 * Read one slide into blocks.
 *
 * Shapes are walked in DOCUMENT ORDER, which on a well-built slide is reading order. That is a heuristic and it is worth
 * naming as one: PowerPoint stores shapes in z-order, which usually follows the order they were created, which usually
 * follows reading order — three "usually"s stacked. Sorting by position instead would be worse, because a two-column
 * slide would interleave.
 *
 * The title is emitted first regardless of where its shape appears, because a title is the slide's heading even when the
 * template puts it at the bottom.
 */
export function readSlide(xml, { number, notes = "" } = {}) {
  const blocks = [];
  let title = "";
  const body = [];

  // `<p:sp>` is a shape, `<p:graphicFrame>` holds a table. Matched together so their order is preserved.
  for (const m of String(xml).matchAll(/<p:(sp|graphicFrame)\b[^>]*>([\s\S]*?)<\/p:\1>/g)) {
    const shape = m[2];

    if (m[1] === "graphicFrame") {
      const rows = shapeTable(shape);
      if (rows.length) body.push({ kind: "table", rows });
      continue;
    }

    const paras = [...shape.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((p) => paraText(p[1])).filter(Boolean);
    if (!paras.length) continue;

    if (isTitleShape(shape) && !title) {
      // A title shape may hold several paragraphs; joined, because a two-line title is one title.
      title = paras.join(" ");
      continue;
    }

    // A shape with several paragraphs is a bullet list in all but name — that is what a slide body is. One paragraph is
    // a statement, not a list of one.
    if (paras.length > 1) body.push({ kind: "list", items: paras });
    else body.push({ kind: "para", text: paras[0] });
  }

  blocks.push(heading(2, title || `Slide ${number}`));

  for (const item of body) {
    if (item.kind === "table") {
      const [head, ...rest] = item.rows;
      blocks.push(rest.length ? table(head, rest) : table([], item.rows));
    } else if (item.kind === "list") {
      blocks.push(list(item.items));
    } else {
      blocks.push(paragraph(item.text));
    }
  }

  // RISK 4. Notes are often the only prose in a deck: the slide says three words and the notes say the actual point.
  // Marked rather than merged, because a reader needs to know what was on screen and what was said.
  if (notes) {
    blocks.push(paragraph(`**Speaker notes:** ${notes}`));
  }

  return blocks;
}

/**
 * Read a whole deck.
 *
 * Notes are located through each slide's own relationships rather than by matching `slideN` to `notesSlideN`. Those
 * numbers frequently disagree — a deck that had slides deleted keeps the original notes numbering — and matching on the
 * number would attach the wrong notes to the wrong slide, which is worse than attaching none.
 */
export function readPptx(buffer, { mode = "read" } = {}) {
  const { files, errors } = readZip(buffer, { only: wanted });
  const notes = [...errors];

  const presentation = asText(files.get("ppt/presentation.xml"));
  if (!presentation) throw new Error("not a presentation: ppt/presentation.xml is missing");

  let order = slideOrder(presentation, asText(files.get("ppt/_rels/presentation.xml.rels")));

  if (!order.length) {
    // Fall back to numeric file order, which is right for a deck that has never been reordered. Recorded, because slide
    // order is the one thing a reader will notice being wrong.
    order = [...files.keys()]
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
    if (order.length) notes.push("Slide order could not be read from the presentation and was inferred from file numbering.");
  }

  const blocks = [];
  let slides = 0;
  let withNotes = 0;

  for (const path of order) {
    const xml = asText(files.get(path));
    if (!xml) { notes.push(`${path} could not be read.`); continue; }

    slides += 1;

    // The notes file for THIS slide, via its own relationships.
    const relsPath = path.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
    const rels = asText(files.get(relsPath));
    const notesTarget = (rels.match(/Target="([^"]*notesSlide\d+\.xml)"/) ?? [])[1];
    const notesPath = notesTarget ? `ppt/notesSlides/${notesTarget.split("/").pop()}` : null;

    let notesText = "";
    if (notesPath && files.has(notesPath)) {
      const notesXml = asText(files.get(notesPath));
      // A notes slide also contains the slide-number placeholder; excluding it stops "7" being read as prose.
      const withoutPlaceholders = notesXml.replace(/<p:sp\b[^>]*>(?:(?!<\/p:sp>)[\s\S])*?<p:ph\b[^>]*type="sldNum"[\s\S]*?<\/p:sp>/g, "");
      notesText = [...withoutPlaceholders.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
        .map((p) => paraText(p[1])).filter(Boolean).join(" ");
      if (notesText) withNotes += 1;
    }

    if (slides > 1) blocks.push(rule());
    blocks.push(...readSlide(xml, { number: slides, notes: notesText }));
  }

  if (!slides) blocks.push(paragraph("This presentation contains no readable slides."));

  notes.push(
    mode === "preserve"
      ? "Preserve mode is not implemented for presentations; this is a read-mode extraction."
      : "Read mode: slide text, tables and speaker notes are included. Layout, geometry, themes, transitions, animations and images are not.",
  );

  return { document: doc(blocks, { notes, source: "pptx" }), slides, withNotes };
}
