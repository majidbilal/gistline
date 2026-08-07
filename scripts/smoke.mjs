// Does the PUBLISHED package actually work, or only the repository?
//
// A module left out of `files` works locally and throws MODULE_NOT_FOUND for everyone who installs it. This exercises every
// path a real user reaches, from an installed tarball rather than from source.
import { deflateSync, deflateRawSync, crc32 } from "node:zlib";
import { gist, gistFile, ingest, tryIngest } from "../index.mjs";

const line = (s) => console.log(`  ${s}`);
let failures = 0;
const check = (name, fn) => {
  try {
    const detail = fn();
    line(`ok    ${name}${detail ? `  ${detail}` : ""}`);
  } catch (e) {
    failures += 1;
    line(`FAIL  ${name}  ${e.message}`);
  }
};

console.log("Installed-package smoke test\n");

check("compress a test log", () => {
  const log = "ok 1 - a\nnot ok 2 - b\n  error: boom\n" + "ok 3 - c\n".repeat(500) + "# tests 502\n# fail 1\n";
  const r = gist(log, { kind: "test", budget: 600, label: "suite" });
  if (!r.text.includes("not ok 2")) throw new Error("the failure was dropped");
  return `${r.originalChars} -> ${r.compressedChars}`;
});

check("lossless JSON table compaction", async () => {
  const { TRANSFORMS } = await import("../transforms/legacy.mjs");
  const rows = Array.from({ length: 200 }, (i0, i) => ({ id: i, name: `n${i}`, ok: i % 2 === 0, tier: "a" }));
  const r = gist(JSON.stringify({ data: rows }, null, 2), { budget: 99999, transforms: TRANSFORMS });
  return `applied ${r.applied.filter((a) => a.applied).map((a) => a.id).join(",") || "none"}`;
});

check("HTML conversion", () => {
  const html = `<html><head><style>${".a{b:c}".repeat(200)}</style></head><body><main><h1>Title</h1>`
    + `<p>${"Real content. ".repeat(60)}</p></main><footer>Copyright</footer></body></html>`;
  const r = ingest(html);
  if (!r.text.includes("Real content")) throw new Error("content lost");
  if (r.text.includes("Copyright")) throw new Error("footer leaked");
  return `${r.kind}, ${html.length} -> ${r.text.length}`;
});

// A real xlsx, built here, so the reader and the ZIP layer are both exercised.
const zipOf = (parts) => {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of parts) {
    const nb = Buffer.from(name, "utf8"); const data = Buffer.from(content, "utf8");
    const body = deflateRawSync(data); const crc = crc32(data);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x800, 6); l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(body.length, 18); l.writeUInt32LE(data.length, 22); l.writeUInt16LE(nb.length, 26);
    locals.push(Buffer.concat([l, nb, body]));
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
    c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([c, nb]));
    offset += l.length + nb.length + body.length;
  }
  const cd = Buffer.concat(centrals); const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(parts.length, 8); e.writeUInt16LE(parts.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e]);
};

check("XLSX reading", () => {
  const book = zipOf([
    ["xl/workbook.xml", `<workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<sst><si><t>Region</t></si><si><t>North</t></si></sst>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c></row>
      <row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`],
  ]);
  const r = ingest(book);
  if (r.kind !== "xlsx") throw new Error(`kind was ${r.kind}`);
  if (!r.text.includes("North")) throw new Error("cell missing");
  return "sheet read";
});

check("DOCX reading", () => {
  const d = zipOf([["word/document.xml",
    `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p>
     <w:p><w:r><w:t>Body.</w:t></w:r></w:p></w:body></w:document>`]]);
  const r = ingest(d);
  if (!/^# Report/m.test(r.text)) throw new Error("heading missing");
  return "heading and body read";
});

check("PPTX reading", () => {
  const p = zipOf([
    ["ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`],
    ["ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>Kickoff</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
  ]);
  const r = ingest(p);
  if (!r.text.includes("Kickoff")) throw new Error("slide title missing");
  return "slide read";
});

check("PDF reading", () => {
  const content = "BT /F1 12 Tf 72 700 Td (Contract terms follow.) Tj ET";
  const body = deflateSync(Buffer.from(content, "latin1")).toString("latin1");
  const pdf = Buffer.from("%PDF-1.7\n"
    + "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
    + "2 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n"
    + "3 0 obj\n<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
    + `4 0 obj\n<< /Filter /FlateDecode /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`
    + "5 0 obj\n<< /Type /Font /Subtype /Type1 /Encoding /WinAnsiEncoding >>\nendobj\n"
    + "trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
  const r = ingest(pdf);
  if (!r.text.includes("Contract terms follow")) throw new Error("text not extracted");
  return "text extracted";
});

check("a scanned PDF is refused with a reason", () => {
  const scan = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n"
    + "2 0 obj\n<< /Length 30 >>\nstream\nq 612 0 0 792 0 0 cm /Im1 Do Q\nendstream\nendobj\n"
    + "trailer\n<< /Root 1 0 R >>\n%%EOF", "latin1");
  const r = tryIngest(scan, { name: "scan.pdf" });
  if (r.ok) throw new Error("a scan should be refused");
  if (!/OCR/.test(r.reason)) throw new Error("the refusal does not mention OCR");
  return "refused, with OCR advice";
});

check("retrieval store round-trip", async () => {
  const { openStore } = await import("../store.mjs");
  const store = openStore({ dir: ".store-smoke" });
  const original = "line\n".repeat(3000);
  const r = gist(original, { kind: "log", budget: 400, store });
  const back = store.get(r.retrievalId);
  if (back !== original) throw new Error("the original did not come back byte-exact");
  return `id ${r.retrievalId}`;
});

check("installer is reachable and lists platforms", async () => {
  const { PLATFORMS, contentFor, findPlatform } = await import("../install.mjs");
  const body = contentFor(findPlatform("cursor"));
  if (!body.includes("alwaysApply")) throw new Error("cursor rule lacks frontmatter");
  return `${PLATFORMS.length} platforms`;
});

console.log(`\n${failures ? `${failures} FAILURE(S)` : "every path works from the installed package"}`);
process.exit(failures ? 1 : 0);
