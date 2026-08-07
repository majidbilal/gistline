import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { readPptx, readSlide, paraText, slideOrder } from "./pptx.mjs";
import { toMarkdown } from "../core/markdown.mjs";

// PPTX reading.
//
// Four risks, named before writing:
//   1. slide order is not file order — slide10 sorts before slide2 as a string
//   2. a title is a PLACEHOLDER TYPE, not a position or font size
//   3. a paragraph is split into runs, exactly as in Word
//   4. speaker notes are a separate file per slide, and often the only prose in the deck

function zipOf(parts) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of parts) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const body = deflateRawSync(data); const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(Buffer.concat([local, nameBuf, body]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    offset += local.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(parts.length, 8); eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const slide = (title, bullets, extra = "") => `<p:sld><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>
    <a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
  <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>
    ${bullets.map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`).join("")}</p:txBody></p:sp>
  ${extra}
</p:spTree></p:cSld></p:sld>`;

// A deck whose FILE numbering disagrees with its presentation order: slide10 is presented second.
const PRESENTATION = `<p:presentation><p:sldIdLst>
  <p:sldId id="256" r:id="rId1"/>
  <p:sldId id="257" r:id="rId10"/>
  <p:sldId id="258" r:id="rId2"/>
</p:sldIdLst></p:presentation>`;

const PRES_RELS = `<Relationships>
  <Relationship Id="rId1" Target="slides/slide1.xml"/>
  <Relationship Id="rId10" Target="slides/slide10.xml"/>
  <Relationship Id="rId2" Target="slides/slide2.xml"/>
</Relationships>`;

const DECK = () => zipOf([
  ["[Content_Types].xml", "<Types/>"],
  ["ppt/presentation.xml", PRESENTATION],
  ["ppt/_rels/presentation.xml.rels", PRES_RELS],
  ["ppt/slides/slide1.xml", slide("Quarterly Review", ["Revenue up", "Costs flat"])],
  ["ppt/slides/slide10.xml", slide("Second In Order", ["This is presented second"])],
  ["ppt/slides/slide2.xml", slide("Third In Order", ["This is presented last"], `
    <p:graphicFrame><a:tbl>
      <a:tr><a:tc><a:p><a:r><a:t>Region</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>Total</a:t></a:r></a:p></a:tc></a:tr>
      <a:tr><a:tc><a:p><a:r><a:t>North</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>1200</a:t></a:r></a:p></a:tc></a:tr>
    </a:tbl></p:graphicFrame>`)],
  ["ppt/slides/_rels/slide1.xml.rels", `<Relationships><Relationship Id="rId1" Target="../notesSlides/notesSlide3.xml"/></Relationships>`],
  ["ppt/notesSlides/notesSlide3.xml", `<p:notes><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>7</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:txBody><a:p><a:r><a:t>The actual point is margin, not revenue.</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:notes>`],
]);

// --- the gate ----------------------------------------------------------------------------------------------

test("GATE: a deck converts with titles, bullets, a table and notes", () => {
  const { document, slides, withNotes } = readPptx(DECK());
  const md = toMarkdown(document);

  assert.equal(slides, 3);
  assert.equal(withNotes, 1);
  assert.match(md, /^## Quarterly Review/m);
  assert.match(md, /^- Revenue up\n- Costs flat/m);
  assert.match(md, /Region,Total/);
  assert.match(md, /North,1200/);
});

// --- risk 1: slide order is not file order -----------------------------------------------------------------

test("RISK 1: slides come out in PRESENTATION order, not file-name order", () => {
  // slide10 sorts before slide2 as a string, and a deck that had slides reordered keeps its original file names. This
  // deck presents slide1, slide10, slide2 — in that order — so both naive sorts get it wrong.
  const md = toMarkdown(readPptx(DECK()).document);
  const first = md.indexOf("Quarterly Review");
  const second = md.indexOf("Second In Order");
  const third = md.indexOf("Third In Order");

  assert.ok(first < second, "slide10 must be presented second, not last");
  assert.ok(second < third, "slide2 must be presented last, not second");
});

test("slideOrder resolves relationship ids to paths, including ../ targets", () => {
  const order = slideOrder(PRESENTATION, PRES_RELS);
  assert.deepEqual(order, ["ppt/slides/slide1.xml", "ppt/slides/slide10.xml", "ppt/slides/slide2.xml"]);
});

test("a deck with unreadable relationships falls back to NUMERIC order and says so", () => {
  // Numeric file order is right for a deck never reordered, which makes it a reasonable fallback — but a reader must
  // know, because slide order is the one thing they will notice being wrong.
  const { document, slides } = readPptx(zipOf([
    ["ppt/presentation.xml", "<p:presentation></p:presentation>"],
    ["ppt/slides/slide2.xml", slide("Two", ["b"])],
    ["ppt/slides/slide10.xml", slide("Ten", ["c"])],
    ["ppt/slides/slide1.xml", slide("One", ["a"])],
  ]));
  const md = toMarkdown(document);

  assert.equal(slides, 3);
  assert.ok(md.indexOf("One") < md.indexOf("Two"), "numeric order, not string order");
  assert.ok(md.indexOf("Two") < md.indexOf("Ten"), "slide10 must come after slide2");
  assert.match(md, /Slide order could not be read/);
});

// --- risk 2: a title is a placeholder type -----------------------------------------------------------------

test("RISK 2: the title comes from its PLACEHOLDER TYPE, wherever the shape sits", () => {
  // Guessing by font size or position would be wrong on any deck with a custom template. Here the title shape is placed
  // AFTER the body shape and must still be the heading.
  const blocks = readSlide(`<p:sld><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody>
      <a:p><a:r><a:t>body first in the file</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody>
      <a:p><a:r><a:t>The Real Title</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`, { number: 1 });

  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].text, "The Real Title");
  assert.match(blocks[1].text, /body first in the file/);
});

test("a slide with no title placeholder is numbered rather than left headless", () => {
  const blocks = readSlide(`<p:sld><p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>just a text box</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`, { number: 4 });
  assert.equal(blocks[0].text, "Slide 4");
});

test("a two-line title is ONE title, not a title and a stray paragraph", () => {
  const blocks = readSlide(`<p:sld><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody>
      <a:p><a:r><a:t>Part One:</a:t></a:r></a:p><a:p><a:r><a:t>The Beginning</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`, { number: 1 });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, "Part One: The Beginning");
});

// --- risk 3: runs -------------------------------------------------------------------------------------------

test("RISK 3: a line split across runs by formatting stays one line", () => {
  assert.equal(paraText(`<a:p><a:r><a:t>Revenue </a:t></a:r><a:r><a:rPr b="1"/><a:t>up</a:t></a:r><a:r><a:t> sharply</a:t></a:r></a:p>`),
    "Revenue up sharply");
});

test("a break becomes a separator, not nothing", () => {
  // The Word reader had exactly this bug: a bare character placed between runs sits outside every <a:t> and is
  // discarded, so the substitution does nothing.
  assert.match(paraText(`<a:p><a:r><a:t>A</a:t><a:br/><a:t>B</a:t></a:r></a:p>`), /A\s+B/);
});

test("entities decode once", () => {
  assert.equal(paraText(`<a:p><a:r><a:t>&amp;amp; and &amp;lt;x&amp;gt;</a:t></a:r></a:p>`), "&amp; and &lt;x&gt;");
});

// --- risk 4: speaker notes ----------------------------------------------------------------------------------

test("RISK 4: notes are found via the SLIDE's own relationships, not by matching numbers", () => {
  // slide1 links to notesSlide3 — numbers that disagree, which happens whenever slides have been deleted. Matching on
  // the number would attach the wrong notes to the wrong slide, which is worse than attaching none.
  const md = toMarkdown(readPptx(DECK()).document);
  assert.match(md, /\*\*Speaker notes:\*\* The actual point is margin, not revenue\./);
});

test("the slide-number placeholder in a notes slide is not read as prose", () => {
  // A notes slide carries the slide number as a placeholder shape. Without excluding it, "7" appears as speaker notes.
  const md = toMarkdown(readPptx(DECK()).document);
  assert.ok(!/Speaker notes:\*\* 7/.test(md), "the slide-number placeholder leaked into the notes");
});

test("notes are MARKED rather than merged into the slide body", () => {
  // A reader needs to know what was on screen and what was said.
  const md = toMarkdown(readPptx(DECK()).document);
  const notesAt = md.indexOf("Speaker notes:");
  assert.ok(notesAt > md.indexOf("Costs flat"), "notes belong after the slide's own content");
});

// --- read mode is the default -------------------------------------------------------------------------------

test("read mode is the default and states what it dropped", () => {
  const md = toMarkdown(readPptx(DECK()).document);
  assert.match(md, /Read mode: slide text, tables, speaker notes and review comments are included/);
  assert.match(md, /Layout, geometry, themes, transitions, animations and images are not/);
});

test("preserve mode is honest about not being implemented", () => {
  // Silently behaving as read mode while accepting a preserve request would be the worst option.
  const md = toMarkdown(readPptx(DECK(), { mode: "preserve" }).document);
  assert.match(md, /Preserve mode is not implemented for presentations/);
});

test("slides are separated, so a reader can tell where one ends", () => {
  const md = toMarkdown(readPptx(DECK()).document);
  assert.ok(md.includes("\n---\n"), "slides must be visually separated");
});

test("an empty deck says so rather than returning nothing", () => {
  const md = toMarkdown(readPptx(zipOf([["ppt/presentation.xml", "<p:presentation/>"]])).document);
  assert.match(md, /no readable slides/);
});

test("a missing presentation.xml is an error naming what is missing", () => {
  assert.throws(() => readPptx(zipOf([["ppt/slides/slide1.xml", "<a/>"]])), /ppt\/presentation\.xml is missing/);
});

// --- slide comments: both formats, and the namespace prefix problem ---------------------------------------
//
// A review comment on a slide is frequently the whole point of sending a deck, and neither format was being read.

const DECK_WITH_COMMENTS = () => zipOf([
  ["ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`],
  ["ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`],
  ["ppt/slides/slide1.xml", slide("Budget", ["Two options"])],
  // The comment file is comment7.xml for slide1.xml, so matching on the number would find nothing.
  ["ppt/slides/_rels/slide1.xml.rels", `<Relationships><Relationship Id="rId1" Target="../comments/comment7.xml"/></Relationships>`],
  ["ppt/commentAuthors.xml", `<p:cmAuthorLst><p:cmAuthor id="1" name="Dana Okafor" initials="DO"/></p:cmAuthorLst>`],
  ["ppt/comments/comment7.xml", `<p:cmLst><p:cm authorId="1" dt="2026-08-05T14:00:00Z" idx="1">
    <p:pos x="100" y="200"/><p:text>Option B is over budget.</p:text></p:cm></p:cmLst>`],
]);

/** The modern form, with an arbitrary namespace prefix and GUID author ids. */
const DECK_MODERN_COMMENTS = () => zipOf([
  ["ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`],
  ["ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`],
  ["ppt/slides/slide1.xml", slide("Roadmap", ["Q3 plan"])],
  ["ppt/slides/_rels/slide1.xml.rels", `<Relationships><Relationship Id="rId1" Target="../comments/modernComment_abc.xml"/></Relationships>`],
  ["ppt/authors.xml", `<authorLst><author id="{A1-B2}" name="Priya Raman" initials="PR"/><author id="{C3-D4}" name="Sam Vale"/></authorLst>`],
  ["ppt/comments/modernComment_abc.xml", `<p188:cmLst xmlns:p188="http://x">
    <p188:cm id="{1}" authorId="{A1-B2}" created="2026-08-06T09:00:00Z">
      <p188:txBody><a:p><a:r><a:t>Can we </a:t></a:r><a:r><a:t>move this to Q4?</a:t></a:r></a:p></p188:txBody></p188:cm>
    <p188:cm id="{2}" authorId="{C3-D4}" created="2026-08-06T10:15:00Z" parentId="{1}">
      <p188:txBody><a:p><a:r><a:t>Yes.</a:t></a:r></a:p></p188:txBody></p188:cm>
  </p188:cmLst>`],
]);

test("legacy slide comments are read, with their author and date", () => {
  const { document, comments } = readPptx(DECK_WITH_COMMENTS());
  const md = toMarkdown(document);

  assert.equal(comments, 1);
  assert.match(md, /\*\*Comment\*\* by Dana Okafor, 2026-08-05: Option B is over budget\./);
  assert.match(md, /## Budget/, "the slide itself is still read");
});

test("comments are found through the SLIDE's relationships, not by number", () => {
  // The fixture points slide1 at comment7. Matching on the number would find nothing, and matching the wrong file would
  // attach another slide's objection — which reads as a real objection to this slide.
  assert.match(toMarkdown(readPptx(DECK_WITH_COMMENTS()).document), /Option B is over budget/);
});

test("the MODERN comment format is read too, whatever its namespace prefix", () => {
  // The prefix is arbitrary: p188, p1510 or anything else depending on which PowerPoint wrote the file. Keying on one
  // prefix means the reader works on the deck it was tested against and nothing else.
  const { document, comments } = readPptx(DECK_MODERN_COMMENTS());
  const md = toMarkdown(document);

  assert.equal(comments, 2);
  assert.match(md, /by Priya Raman, 2026-08-06/, "GUID author id resolved through authors.xml");
  assert.match(md, /Can we move this to Q4\?/, "runs joined, since formatting splits a sentence");
  assert.match(md, /by Sam Vale.*\(reply\): Yes\./, "a reply is marked, because a thread's answer is usually the reply");
});

test("comments appear on the slide they were left on", () => {
  // A comment detached from its slide is much less useful, and a comment on the wrong slide is misleading.
  const md = toMarkdown(readPptx(DECK_WITH_COMMENTS()).document);
  assert.ok(md.indexOf("## Budget") < md.indexOf("Option B is over budget"), "after the slide's own content");
});

test("both author files are consulted, since a deck may carry either", () => {
  // An older deck has commentAuthors.xml only; a recent one has authors.xml. Reading one leaves every comment attributed to
  // nobody on half of all decks.
  assert.match(toMarkdown(readPptx(DECK_WITH_COMMENTS()).document), /Dana Okafor/);
  assert.match(toMarkdown(readPptx(DECK_MODERN_COMMENTS()).document), /Priya Raman/);
});

test("a deck with no comments says nothing about them", () => {
  const { comments } = readPptx(DECK());
  assert.equal(comments, 0);
  assert.ok(!toMarkdown(readPptx(DECK()).document).includes("**Comment**"));
});

test("an unattributable comment is still shown", () => {
  // Losing the reviewer's point because the author file is missing would be the wrong trade.
  const zip = zipOf([
    ["ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`],
    ["ppt/slides/slide1.xml", slide("T", ["x"])],
    ["ppt/slides/_rels/slide1.xml.rels", `<Relationships><Relationship Id="rId1" Target="../comments/comment1.xml"/></Relationships>`],
    ["ppt/comments/comment1.xml", `<p:cmLst><p:cm authorId="9"><p:text>Needs a source.</p:text></p:cm></p:cmLst>`],
  ]);
  const md = toMarkdown(readPptx(zip).document);
  assert.match(md, /by unknown: Needs a source\./);
});
