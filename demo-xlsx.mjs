// Does the compounding actually happen?
//
// The plan asserted that XLSX -> Markdown -> lossless compaction compounds, and recorded it as a HYPOTHESIS inferred
// from the 67.9% measured on JSON. This measures it.
import { deflateRawSync, crc32 } from "node:zlib";
import { readXlsx } from "./transforms/xlsx.mjs";
import { toMarkdown } from "./core/markdown.mjs";
import { gist } from "./index.mjs";
import { TRANSFORMS } from "./transforms/legacy.mjs";

function makeXlsx(parts) {
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

// A realistic sales sheet: 300 rows, 6 columns, shared strings for the repeated region names.
const HEADERS = ["Region", "Rep", "Product", "Units", "Revenue", "Closed"];
const REGIONS = ["North", "South", "East", "West"];
const PRODUCTS = ["Widget", "Gadget", "Sprocket"];
const strings = [...HEADERS, ...REGIONS, ...PRODUCTS];
const si = (s) => strings.indexOf(s);

const rows = Array.from({ length: 300 }, (i0, i) => {
  const cells = [
    `<c r="A${i + 2}" t="s"><v>${si(REGIONS[i % 4])}</v></c>`,
    `<c r="B${i + 2}" t="inlineStr"><is><t>rep-${i + 1}</t></is></c>`,
    `<c r="C${i + 2}" t="s"><v>${si(PRODUCTS[i % 3])}</v></c>`,
    `<c r="D${i + 2}"><v>${(i % 40) + 1}</v></c>`,
    `<c r="E${i + 2}"><v>${(1000 + i * 7.5).toFixed(2)}</v></c>`,
    `<c r="F${i + 2}" s="1"><v>${45658 + (i % 300)}</v></c>`,
  ].join("");
  return `<row r="${i + 2}">${cells}</row>`;
}).join("\n");

const sheet = `<worksheet><sheetData>
<row r="1">${HEADERS.map((h, i) => `<c r="${String.fromCharCode(65 + i)}1" t="s"><v>${si(h)}</v></c>`).join("")}</row>
${rows}
</sheetData></worksheet>`;

const book = makeXlsx([
  ["[Content_Types].xml", "<Types/>"],
  ["xl/workbook.xml", `<workbook><sheets><sheet name="Q3 Sales" r:id="rId1"/></sheets></workbook>`],
  ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
  ["xl/sharedStrings.xml", `<sst>${strings.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`],
  ["xl/styles.xml", `<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`],
  ["xl/worksheets/sheet1.xml", sheet],
]);

const pct = (a, b) => `${(((a - b) / a) * 100).toFixed(1)}%`;

console.log("XLSX -> Markdown -> compression, measured\n");

const rawXml = sheet.length;
const { document, sheets, cells } = readXlsx(book);
const md = toMarkdown(document, { includeNotes: false });

console.log(`  archive on disk        ${String(book.length).padStart(7)} bytes`);
console.log(`  sheet XML inside it    ${String(rawXml).padStart(7)} chars   (what a naive reader would hand the model)`);
console.log(`  stage 1: Markdown      ${String(md.length).padStart(7)} chars   ${pct(rawXml, md.length)} smaller than the XML`);

const compressed = gist(md, { budget: 4000, label: "sheet", transforms: TRANSFORMS });
console.log(`  stage 2: compressed    ${String(compressed.compressedChars).padStart(7)} chars   ${pct(md.length, compressed.compressedChars)} smaller again`);
console.log(`\n  end to end             ${pct(rawXml, compressed.compressedChars)} smaller than the sheet XML`);
console.log(`  transforms applied     ${compressed.applied.filter((a) => a.applied).map((a) => a.id).join(" -> ") || "(none)"}`);
console.log(`  lossy                  ${compressed.lossy}`);

console.log(`\n  sheets ${sheets}, cells ${cells}`);
console.log(`  row 300 present in Markdown:  ${md.includes("rep-300")}`);
console.log(`  dates converted, no serials:  ${!md.includes("45658") && md.includes("2025-01-01")}`);
