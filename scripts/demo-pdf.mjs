// PDF end to end: a real multi-page document with running furniture.
//
// Run: node demo-pdf.mjs
import { deflateSync } from "node:zlib";
import { readPdf } from "../transforms/pdf.mjs";
import { toMarkdown } from "../core/markdown.mjs";
import { gist } from "../index.mjs";
import { TRANSFORMS } from "../transforms/legacy.mjs";

const PAGES = 12;

/** A page: a running header, a running footer, and six lines of body text. */
const pageContent = (n) => {
  const lines = [
    `BT /F1 9 Tf 72 760 Td (Acme Services Agreement \\226 Confidential) Tj ET`,
    ...Array.from({ length: 6 }, (i0, i) =>
      `BT /F1 11 Tf 72 ${700 - i * 16} Td (Clause ${n}.${i + 1}: the supplier shall perform the duties set out herein.) Tj ET`),
    `BT /F1 9 Tf 72 50 Td (Page ${n} of ${PAGES}) Tj ET`,
  ];
  return lines.join("\n");
};

/** Assemble a genuine PDF with Flate-compressed content streams. */
function buildPdf() {
  const parts = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Count ${PAGES} /Kids [ ${Array.from({ length: PAGES }, (i0, i) => `${10 + i} 0 R`).join(" ")} ] >>\nendobj\n`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
  ];

  for (let i = 0; i < PAGES; i++) {
    const body = deflateSync(Buffer.from(pageContent(i + 1), "latin1")).toString("latin1");
    parts.push(`${10 + i} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${100 + i} 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`);
    parts.push(`${100 + i} 0 obj\n<< /Filter /FlateDecode /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`);
  }

  return Buffer.from(`%PDF-1.7\n${parts.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1");
}

const pdf = buildPdf();
const { document, pages, recovered, skipped, classification } = readPdf(pdf);
const md = toMarkdown(document, { includeNotes: false });

const pct = (a, b) => `${(((a - b) / a) * 100).toFixed(1)}%`;

console.log("PDF extraction, end to end\n");
console.log(`  classification         ${classification.verdict} · ${classification.pages} page objects · PDF ${classification.version}`);
console.log(`  pages read             ${recovered} of ${pages}`);
console.log(`  skipped                empty ${skipped.empty.length}, unreliable ${skipped.unreliable.length}, failed ${skipped.failed.length}`);
console.log(`  file on disk           ${pdf.length} bytes`);
console.log(`  extracted markdown     ${md.length} chars   ${pct(pdf.length, md.length)} smaller than the file`);

console.log("\n--- FIRST PAGE OF OUTPUT ---");
console.log(md.split("<!-- page 2 -->")[0].trim());

console.log("\n--- RUNNING FURNITURE, STATED ONCE ---");
for (const n of document.notes.filter((x) => /^Running/.test(x))) console.log(`  ${n}`);

console.log("\n--- FIDELITY ---");
console.log(`  every clause present:        ${Array.from({ length: PAGES }, (i0, i) => md.includes(`Clause ${i + 1}.1`)).every(Boolean)}`);
console.log(`  header appears in body:      ${md.includes("Confidential")}   (should be false)`);
console.log(`  footer appears in body:      ${/Page \d+ of 12/.test(md)}   (should be false)`);
console.log(`  en-dash decoded from WinAnsi: ${document.notes.some((n) => n.includes("\u2013"))}`);

console.log("\n--- THEN COMPRESSED ---");
const c = gist(md, { budget: 1500, label: "contract", transforms: TRANSFORMS });
console.log(`  ${c.originalChars} -> ${c.compressedChars} chars   ${pct(c.originalChars, c.compressedChars)} smaller`);
console.log(`  transforms: ${c.applied.filter((a) => a.applied).map((a) => a.id).join(" -> ") || "(none)"}`);
console.log(`  lossy: ${c.lossy}`);
console.log(`\n  end to end: ${pdf.length} bytes of PDF -> ${c.compressedChars} chars = ${pct(pdf.length, c.compressedChars)} smaller`);

console.log("\n\n=== TIER 4: A TABLE IN A REAL PDF ===\n");

const tableDoc = (() => {
  const content = `
    BT /F1 14 Tf 72 740 Td (Quarterly Summary) Tj ET
    BT /F1 11 Tf 72 700 Td (Sales by region were as follows.) Tj ET
    BT /F1 10 Tf 72 660 Td (Region) Tj ET
    BT /F1 10 Tf 260 660 Td (Units) Tj ET
    BT /F1 10 Tf 400 660 Td (Revenue) Tj ET
    BT /F1 10 Tf 72 644 Td (North) Tj ET
    BT /F1 10 Tf 260 644 Td (120) Tj ET
    BT /F1 10 Tf 400 644 Td (12,400) Tj ET
    BT /F1 10 Tf 72 628 Td (South) Tj ET
    BT /F1 10 Tf 260 628 Td (98) Tj ET
    BT /F1 10 Tf 400 628 Td (9,880) Tj ET
    BT /F1 10 Tf 72 612 Td (East) Tj ET
    BT /F1 10 Tf 260 612 Td (143) Tj ET
    BT /F1 10 Tf 400 612 Td (15,020) Tj ET
    BT /F1 11 Tf 72 570 Td (Growth was strongest in the east.) Tj ET
  `;
  const body = deflateSync(Buffer.from(content, "latin1")).toString("latin1");
  return Buffer.from(
    `%PDF-1.7\n`
    + `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`
    + `2 0 obj\n<< /Type /Pages /Count 1 /Kids [ 3 0 R ] >>\nendobj\n`
    + `3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`
    + `4 0 obj\n<< /Filter /FlateDecode /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\n`
    + `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /FirstChar 32 /Widths [ ${Array(95).fill(556).join(" ")} ] >>\nendobj\n`
    + `trailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
})();

const t = readPdf(tableDoc);
console.log(toMarkdown(t.document, { includeNotes: false }));

console.log("\n--- WHAT IT SAYS ABOUT ITS OWN CERTAINTY ---");
for (const n of t.document.notes.filter((x) => /table|INFERRED/i.test(x))) console.log(`  ${n}`);

console.log("\n--- FIDELITY ---");
const tmd = toMarkdown(t.document, { includeNotes: false });
console.log(`  intro sentence kept in place:   ${tmd.indexOf("as follows") < tmd.indexOf("| Region")}`);
console.log(`  closing sentence after table:   ${tmd.indexOf("| East") < tmd.indexOf("strongest in the east")}`);
console.log(`  header row promoted:            ${tmd.includes("| Region | Units | Revenue |")}`);
console.log(`  every figure present:           ${["120", "12,400", "98", "9,880", "143", "15,020"].every((v) => tmd.includes(v))}`);
console.log(`  title not swallowed by table:   ${tmd.includes("Quarterly Summary") && !tmd.includes("| Quarterly Summary |")}`);
