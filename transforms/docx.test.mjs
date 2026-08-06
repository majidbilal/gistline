import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync, crc32 } from "node:zlib";
import { readDocx, stripRevisions, runText, readNumbering } from "./docx.mjs";
import { toMarkdown } from "../core/markdown.mjs";

// DOCX reading.
//
// Four risks, named before the file was written because each produces a plausible result rather than an error:
//   1. deleted text is still in the file — reading every <w:t> resurrects it
//   2. list numbers live in numbering.xml, not the paragraph
//   3. whitespace is conditional on xml:space="preserve"
//   4. a run is not a word — formatting splits one sentence into several <w:t> elements

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

const NUMBERING = `<numbering>
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
  <w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="7"><w:abstractNumId w:val="1"/></w:num>
</numbering>`;

const RELS = `<Relationships><Relationship Id="rId9" Target="https://example.com/spec"/></Relationships>`;

const DOCUMENT = `<w:document><w:body>
  <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Service Agreement</w:t></w:r></w:p>
  <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Scope</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">The supplier shall </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>not</w:t></w:r><w:r><w:t xml:space="preserve"> subcontract.</w:t></w:r></w:p>
  <w:p><w:r><w:t xml:space="preserve">Fee is </w:t></w:r><w:del><w:r><w:delText>1000</w:delText></w:r></w:del><w:ins><w:r><w:t>2500</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"> per month.</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>First obligation</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>Second obligation</w:t></w:r></w:p>
  <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>A bulleted note</w:t></w:r></w:p>
  <w:tbl>
    <w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Setup</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>500</w:t></w:r></w:p></w:tc></w:tr>
  </w:tbl>
  <w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:t>the spec</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> for detail.</w:t></w:r></w:p>
  <w:p><w:r><w:commentReference w:id="1"/></w:r><w:r><w:t>Reviewed.</w:t></w:r></w:p>
</w:body></w:document>`;

const FOOTNOTES = `<w:footnotes>
  <w:footnote w:id="-1"><w:p><w:r><w:t>separator</w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="0"><w:p><w:r><w:t>continuation</w:t></w:r></w:p></w:footnote>
  <w:footnote w:id="2"><w:p><w:r><w:t>Rates reviewed annually.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;

const DOC = () => zipOf([
  ["[Content_Types].xml", "<Types/>"],
  ["word/document.xml", DOCUMENT],
  ["word/numbering.xml", NUMBERING],
  ["word/_rels/document.xml.rels", RELS],
  ["word/footnotes.xml", FOOTNOTES],
]);

// --- the gate ----------------------------------------------------------------------------------------------

test("GATE: a real document converts with headings, lists, a table and a link", () => {
  const md = toMarkdown(readDocx(DOC()).document);

  assert.match(md, /^# Service Agreement/m, "Title style is a level-1 heading");
  assert.match(md, /^## Scope/m);
  assert.match(md, /^1\. First obligation\n2\. Second obligation/m, "an ordered list, numbered by position");
  assert.match(md, /^- A bulleted note/m, "a bulleted list from a different numbering id");
  assert.match(md, /\| Item \| Cost \|/);
  assert.match(md, /\| Setup \| 500 \|/);
  assert.match(md, /\[the spec\]\(https:\/\/example\.com\/spec\)/);
});

// --- risk 1: tracked changes ------------------------------------------------------------------------------

test("RISK 1: deleted text is EXCLUDED and insertions are kept", () => {
  // The worst failure in this file. A revised clause holds both "1000" and "2500"; taking every <w:t> produces
  // "Fee is 1000 2500 per month" — a wrong contract that reads perfectly.
  const md = toMarkdown(readDocx(DOC()).document);
  assert.ok(!md.includes("1000"), "deleted text was resurrected");
  assert.match(md, /Fee is 2500 per month\./, "the revised wording must be intact");
});

test("the presence of tracked changes is STATED, so a reader knows which version this is", () => {
  const md = toMarkdown(readDocx(DOC()).document);
  assert.match(md, /contains tracked changes/);
  assert.match(md, /this is the revised version/);
});

test("stripRevisions removes a deletion wholly, including a nested w:t", () => {
  // A deleted run can contain <w:t> rather than <w:delText>, so removing the element by name is not enough.
  const out = stripRevisions(`<w:p><w:r><w:t>keep</w:t></w:r><w:del><w:r><w:t>drop</w:t></w:r></w:del></w:p>`);
  assert.ok(!out.includes("drop"));
  assert.ok(out.includes("keep"));
});

test("an insertion's text survives being unwrapped", () => {
  assert.match(runText(stripRevisions(`<w:p><w:ins><w:r><w:t>new</w:t></w:r></w:ins></w:p>`)), /new/);
});

// --- risk 2: list numbering lives elsewhere ---------------------------------------------------------------

test("RISK 2: ordered and bulleted lists are distinguished via numbering.xml", () => {
  // The paragraph carries only a numId. Whether that renders as "1." or a bullet is recorded in a different file, so a
  // reader that guesses turns a sequence into an unordered pile.
  const numbering = readNumbering(NUMBERING);
  assert.equal(numbering.get("5"), true, "decimal numbering id should be ordered");
  assert.equal(numbering.get("7"), false, "bullet numbering id should be unordered");
});

test("the two indirections are both followed", () => {
  // numId -> abstractNumId -> numFmt. Following only the first finds nothing at all.
  assert.equal(readNumbering(`<numbering>
    <w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerLetter"/></w:lvl></w:abstractNum>
    <w:num w:numId="11"><w:abstractNumId w:val="3"/></w:num>
  </numbering>`).get("11"), true);
});

test("a numbering file that is missing does not break the read", () => {
  // Without numbering.xml every list becomes unordered, which is a degraded result rather than a failure.
  const md = toMarkdown(readDocx(zipOf([
    ["word/document.xml", `<w:document><w:body>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>
    </w:body></w:document>`],
  ])).document);
  assert.match(md, /^- item/m);
});

test("consecutive items become ONE list, and a change of list type starts a new one", () => {
  const md = toMarkdown(readDocx(DOC()).document);
  // Two ordered items in one block, then a separate bulleted block.
  assert.match(md, /1\. First obligation\n2\. Second obligation\n\n- A bulleted note/);
});

// --- risks 3 and 4: whitespace and runs -------------------------------------------------------------------

test("RISK 3 and 4: a sentence split across runs by formatting stays one sentence with its spaces", () => {
  // "The supplier shall " + "not" + " subcontract." is three runs because one word is bold. Joining them without
  // honouring xml:space would give "The supplier shallnotsubcontract."
  const md = toMarkdown(readDocx(DOC()).document);
  assert.match(md, /The supplier shall not subcontract\./);
});

test("tabs and explicit breaks are preserved as separators", () => {
  // Without them a table of contents collapses into one unbroken line.
  assert.match(runText(`<w:p><w:r><w:t>A</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>B</w:t></w:r></w:p>`), /A\s+B/);
  assert.match(runText(`<w:p><w:r><w:t>A</w:t><w:br/><w:t>B</w:t></w:r></w:p>`), /A\s+B/);
});

test("entities decode once, not twice", () => {
  assert.equal(runText(`<w:p><w:r><w:t>&amp;amp; and &amp;lt;tag&amp;gt;</w:t></w:r></w:p>`), "&amp; and &lt;tag&gt;");
});

// --- document order and structure --------------------------------------------------------------------------

test("a table between two paragraphs STAYS between them", () => {
  // Collecting all paragraphs then all tables would silently reorder the document.
  const md = toMarkdown(readDocx(DOC()).document);
  assert.ok(md.indexOf("| Item | Cost |") < md.indexOf("See [the spec]"), "the table must precede the following paragraph");
  assert.ok(md.indexOf("A bulleted note") < md.indexOf("| Item | Cost |"), "the list must precede the table");
});

test("footnotes are collected at the end, and the separator entries are not content", () => {
  const md = toMarkdown(readDocx(DOC()).document);
  assert.match(md, /## Footnotes/);
  assert.match(md, /Rates reviewed annually\./);
  assert.ok(!md.includes("separator"), "footnote id -1 is not content");
  assert.ok(!md.includes("continuation"), "footnote id 0 is not content");
});

test("comments are excluded and said to be excluded", () => {
  const md = toMarkdown(readDocx(DOC()).document);
  assert.match(md, /Comments are not included\./);
  assert.match(md, /Reviewed\./, "the paragraph containing the reference is still read");
});

test("a document with no body text says so rather than returning nothing", () => {
  const md = toMarkdown(readDocx(zipOf([["word/document.xml", "<w:document><w:body></w:body></w:document>"]])).document);
  assert.match(md, /no readable text/);
});

test("a missing document.xml is an error naming what is missing", () => {
  assert.throws(() => readDocx(zipOf([["word/styles.xml", "<a/>"]])), /word\/document\.xml is missing/);
});
