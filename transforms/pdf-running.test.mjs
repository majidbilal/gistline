import { test } from "node:test";
import assert from "node:assert/strict";
import { findRunningContent, bodyRange, normalise, describeRunningContent, MIN_PAGES } from "./pdf-running.mjs";

// Running headers and footers.
//
// The removal is lossless: a header on 200 pages is one fact repeated 200 times. The DANGER is that the same description
// fits a legitimately repeated line — a recurring clause, a per-page form question, a table header repeated on each page.
// Half these tests are therefore about refusing to remove.

/** A page of body lines at plausible coordinates, optionally with a header and footer. */
const page = (bodyLines, { header = null, footer = null } = {}) => [
  ...(header ? [{ y: 760, size: 9, text: header }] : []),
  ...bodyLines.map((text, i) => ({ y: 700 - i * 14, size: 11, text })),
  ...(footer ? [{ y: 50, size: 9, text: footer }] : []),
];

const body = (n, prefix) => Array.from({ length: n }, (i0, i) => `${prefix} line ${i + 1}`);

// --- the win ----------------------------------------------------------------------------------------------

test("a header repeated on every page is stated ONCE and removed from the body", () => {
  const pages = Array.from({ length: 8 }, (i0, i) =>
    page(body(6, `p${i + 1}`), { header: "Service Agreement — Confidential", footer: "Page 1 of 8" }));

  const r = findRunningContent(pages);

  assert.equal(r.furniture.length, 2, "the header and the footer should both be found");
  assert.ok(r.furniture.some((f) => f.where === "header" && /Service Agreement/.test(f.text)));
  assert.ok(r.furniture.some((f) => f.where === "footer"));

  // Gone from every page, and the body untouched.
  for (const p of r.pages) {
    assert.ok(!p.some((l) => /Service Agreement/.test(l.text)), "the header must be removed from every page");
    assert.equal(p.length, 6, "exactly the body lines should remain");
  }
});

test("a header carrying a page number is still recognised as one header", () => {
  // A running header is rarely identical across pages: it carries a number, a date, or a section name. Comparing raw text
  // would find no repetition at all in the documents where this matters most.
  const pages = Array.from({ length: 10 }, (i0, i) =>
    page(body(6, "b"), { footer: `Page ${i + 1} of 10` }));

  const r = findRunningContent(pages);
  assert.equal(r.furniture.length, 1);
  assert.equal(r.furniture[0].varies, true, "a varying footer must be flagged as varying");
  assert.match(r.furniture[0].text, /Page \d+ of 10/);
});

test("the removal is proportional to the document: 200 pages, one header line", () => {
  const pages = Array.from({ length: 200 }, () => page(body(4, "x"), { header: "Annual Report 2026" }));
  const r = findRunningContent(pages);

  const before = pages.reduce((n, p) => n + p.length, 0);
  const after = r.pages.reduce((n, p) => n + p.length, 0);

  assert.equal(before - after, 200, "200 copies of one line should be removed");
  assert.equal(r.furniture.length, 1, "and stated once");
});

test("normalise collapses digits and whitespace, and nothing else", () => {
  assert.equal(normalise("Page 12 of 40"), "page # of #");
  assert.equal(normalise("Chapter  3   —  Terms"), "chapter # — terms");
  // Different words must stay different, or genuinely distinct lines would merge.
  assert.notEqual(normalise("Chapter 3 — Terms"), normalise("Chapter 3 — Schedule"));
});

// --- refusing to remove, which is the safety half ----------------------------------------------------------

test("a repeated line INSIDE the body text is NOT removed", () => {
  // The condition a recurring clause cannot satisfy. Position outside the body is what distinguishes furniture from
  // content, and this is the test that stops the feature deleting a legal clause.
  const pages = Array.from({ length: 8 }, (i0, i) => [
    { y: 760, size: 9, text: "Contract" },
    { y: 700, size: 11, text: `Section ${i + 1}` },
    { y: 686, size: 11, text: "This clause is repeated in every section." },
    { y: 672, size: 11, text: `Detail for section ${i + 1}` },
    { y: 658, size: 11, text: "More detail." },
    { y: 644, size: 11, text: "Even more detail." },
  ]);

  const r = findRunningContent(pages);
  for (const p of r.pages) {
    assert.ok(p.some((l) => /This clause is repeated/.test(l.text)), "a repeated line inside the body must survive");
  }
});

test("a line that DRIFTS vertically is part of a flowing layout, not furniture", () => {
  // A line whose position moves by more than a line height is flowing with the content, so its repetition is
  // coincidental rather than structural.
  const pages = Array.from({ length: 8 }, (i0, i) => [
    { y: 770 - i * 30, size: 9, text: "Recurring but moving" },
    ...body(6, "b").map((text, j) => ({ y: 700 - j * 14, size: 11, text })),
  ]);

  const r = findRunningContent(pages);
  assert.equal(r.furniture.length, 0, `nothing should be removed, got ${JSON.stringify(r.furniture)}`);
  assert.match(r.reason, /no line repeats in a fixed position/);
});

test("a line on a MINORITY of pages is not furniture", () => {
  // Appearing on two pages of ten is not a running header; it is a coincidence or a section marker.
  const pages = Array.from({ length: 10 }, (i0, i) =>
    page(body(6, "b"), { header: i < 2 ? "Draft" : null }));

  const r = findRunningContent(pages);
  assert.equal(r.furniture.length, 0);
});

test("a document too SHORT for repetition to mean anything is left alone", () => {
  // On two pages, a line appearing on both is as likely to be content as furniture.
  const pages = Array.from({ length: 2 }, () => page(body(6, "b"), { header: "Report" }));
  const r = findRunningContent(pages);

  assert.equal(r.furniture.length, 0);
  assert.equal(r.pages, pages, "the pages must be returned untouched");
  assert.match(r.reason, new RegExp(`below ${MIN_PAGES}`));
});

test("the same line twice on ONE page is not evidence of repetition across pages", () => {
  // Counted as distinct pages, not as hits.
  const pages = Array.from({ length: 8 }, (i0, i) => [
    ...(i === 0 ? [{ y: 770, size: 9, text: "Twice" }, { y: 760, size: 9, text: "Twice" }] : []),
    ...body(6, "b").map((text, j) => ({ y: 700 - j * 14, size: 11, text })),
  ]);
  const r = findRunningContent(pages);
  assert.equal(r.furniture.length, 0);
});

test("sparse pages do not establish a body range, and nothing is removed", () => {
  // With three lines per page there is no reliable middle, so the safe answer is to do nothing.
  const pages = Array.from({ length: 6 }, () => [
    { y: 760, size: 9, text: "Header" },
    { y: 700, size: 11, text: "One line only" },
  ]);
  const r = findRunningContent(pages);
  assert.equal(r.furniture.length, 0);
  assert.match(r.reason, /too sparse/);
});

// --- the body range ---------------------------------------------------------------------------------------

test("bodyRange excludes the outermost lines, or it would define the body as the whole page", () => {
  // Circular otherwise: including the header in the body range makes the body the whole page and finds nothing outside it.
  const pages = Array.from({ length: 5 }, () => page(body(6, "b"), { header: "H", footer: "F" }));
  const range = bodyRange(pages);
  assert.ok(range.top < 760, "the header's y must be above the body range");
  assert.ok(range.bottom > 50, "the footer's y must be below the body range");
});

test("one unusual page cannot widen the range for the whole document", () => {
  // The median is used rather than the extreme, so a single full-bleed page does not disable detection everywhere.
  const normal = Array.from({ length: 9 }, () => page(body(6, "b"), { header: "H" }));
  const odd = [{ y: 790, size: 11, text: "edge to edge" }, ...body(6, "b").map((t, j) => ({ y: 700 - j * 14, size: 11, text: t })), { y: 20, size: 11, text: "very bottom" }];

  const r = findRunningContent([...normal, odd]);
  assert.ok(r.furniture.some((f) => f.text === "H"), "detection must survive one unusual page");
});

// --- reporting -------------------------------------------------------------------------------------------

test("furniture is described rather than silently dropped", () => {
  const lines = describeRunningContent([
    { where: "header", text: "Annual Report", pages: 200, varies: false },
    { where: "footer", text: "Page 1 of 200", pages: 200, varies: true },
  ]);
  assert.match(lines[0], /Running header on 200 page\(s\), shown once here: "Annual Report"/);
  assert.match(lines[1], /Running footer/);
  assert.match(lines[1], /the number or reference varied by page/);
});
