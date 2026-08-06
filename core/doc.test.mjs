import { test } from "node:test";
import assert from "node:assert/strict";
import { heading, paragraph, list, table, code, raw, rule, doc, validate, textLength, BLOCK_TYPES } from "./doc.mjs";
import { toMarkdown, worthIt } from "./markdown.mjs";

// The document model and the Markdown writer.
//
// These exist so that four readers do not each carry their own copy of "how do I write a table". The tests therefore
// concentrate on the things a reader would otherwise get wrong independently: pipe escaping, ragged rows, and the fact
// that a cell cannot contain a newline.

// --- the writer's job, done once for everyone --------------------------------------------------------------

test("a pipe in a cell cannot break the table", () => {
  const md = toMarkdown(doc([table(["Cmd"], [["a | b"]])]));
  assert.match(md, /a \\\| b/);
  // Exactly three pipes per row: the two delimiters plus none from the content.
  const row = md.split("\n").find((l) => l.includes("a \\|"));
  assert.equal((row.match(/(?<!\\)\|/g) ?? []).length, 2);
});

test("a newline in a cell becomes a space, not an HTML break", () => {
  // A cell containing HTML defeats the point of converting away from HTML, and the compressor downstream would then be
  // compressing markup again.
  const md = toMarkdown(doc([table(["A"], [["line one\nline two"]])]));
  assert.match(md, /\| line one line two \|/);
  assert.ok(!md.includes("<br"), "no HTML fallback");
});

test("ragged rows are padded by the WRITER, so no reader decides the width", () => {
  const md = toMarkdown(doc([table(["A", "B", "C"], [["1"], ["1", "2", "3"], []])]));
  const rows = md.split("\n").filter((l) => l.startsWith("|"));
  for (const r of rows) {
    assert.equal((r.match(/\|/g) ?? []).length, 4, `wrong cell count: ${r}`);
  }
});

test("a headerless table still renders, with empty cells rather than invented names", () => {
  // Markdown has no syntax for a table without a header. Inventing column names would put words in the document that
  // were never in the source.
  const md = toMarkdown(doc([table([], [["1", "2"]])]));
  assert.match(md, /\|\s+\|\s+\|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.ok(!/Column/i.test(md), "no invented header text");
});

test("headings are clamped to 1-6, because a reader may find deeper nesting", () => {
  assert.match(toMarkdown(doc([heading(9, "deep")])), /^###### deep/);
  assert.match(toMarkdown(doc([heading(0, "shallow")])), /^# shallow/);
  assert.match(toMarkdown(doc([heading("bad", "x")])), /^# x/);
});

test("ordered lists are numbered by position; unordered use a dash", () => {
  assert.match(toMarkdown(doc([list(["a", "b", "c"], { ordered: true })])), /1\. a\n2\. b\n3\. c/);
  assert.match(toMarkdown(doc([list(["a", "b"])])), /- a\n- b/);
});

test("a multi-line list item stays one item", () => {
  const md = toMarkdown(doc([list(["first line\nsecond line"], { ordered: true })]));
  assert.match(md, /1\. first line\n {2}second line/);
});

test("code blocks keep their content verbatim and their language when known", () => {
  const md = toMarkdown(doc([code("const a = 1;\nif (a) {}", { lang: "js" })]));
  assert.match(md, /```js\nconst a = 1;\nif \(a\) \{\}\n```/);
  assert.match(toMarkdown(doc([code("plain")])), /```\nplain\n```/);
});

test("raw is emitted untouched, so a reader is never forced to lie", () => {
  const md = toMarkdown(doc([raw("<<< kept exactly | as-is >>>")]));
  assert.match(md, /<<< kept exactly \| as-is >>>/);
});

// --- notes: the reader's limits must reach the reader of the output ----------------------------------------

test("notes are surfaced, clearly marked, at the end", () => {
  // A converter that does not say what it skipped invites the assumption that it read everything.
  const d = doc([paragraph("body")], { notes: ["Tracked changes were ignored.", "2 embedded images were skipped."] });
  const md = toMarkdown(d);
  assert.match(md, /What this conversion could not represent/);
  assert.match(md, /- Tracked changes were ignored\./);
  assert.match(md, /- 2 embedded images were skipped\./);
  assert.ok(md.indexOf("body") < md.indexOf("could not represent"), "notes come after the content");
});

test("no notes means no notes section, not an empty one", () => {
  assert.ok(!toMarkdown(doc([paragraph("body")])).includes("could not represent"));
});

test("notes can be suppressed for a caller that wants content only", () => {
  const d = doc([paragraph("body")], { notes: ["something"] });
  assert.equal(toMarkdown(d, { includeNotes: false }), "body");
});

// --- validation at the boundary ----------------------------------------------------------------------------

test("a malformed block fails at the document boundary, not inside the writer", () => {
  // A reader with a bug should fail where the bug is, naming the block index.
  assert.throws(() => validate({ blocks: [{ type: "nonsense" }] }), /block 0 has unknown type/);
  assert.throws(() => validate({}), /blocks must be an array/);
  assert.throws(() => toMarkdown({ blocks: [{ type: "nope", text: "x" }] }), /unknown type/);
});

test("every declared block type actually renders", () => {
  // Guards against a type being added to the model and forgotten in the writer.
  const samples = {
    heading: heading(2, "h"), paragraph: paragraph("p"), list: list(["i"]),
    table: table(["a"], [["b"]]), code: code("c"), raw: raw("r"), rule: rule(),
  };
  for (const type of BLOCK_TYPES) {
    assert.ok(samples[type], `no sample for declared type ${type}`);
    assert.doesNotThrow(() => toMarkdown(doc([samples[type]])), `${type} does not render`);
  }
});

test("empty and falsy blocks are dropped rather than rendered as blank space", () => {
  const md = toMarkdown(doc([paragraph(""), null, paragraph("real"), paragraph("   ")]));
  assert.equal(md, "real");
});

// --- worthIt: declining is a valid outcome ------------------------------------------------------------------

test("worthIt reports the gain and refuses a conversion that gains nothing", () => {
  const d = doc([paragraph("x".repeat(1000))]);
  assert.equal(worthIt(d, 1100).worth, false, "a 9% gain is not worth a format change");
  assert.equal(worthIt(d, 5000).worth, true);
  assert.ok(worthIt(d, 5000).gain > 0.7);
});

test("textLength counts content without rendering", () => {
  // Used to judge a conversion before paying to render it.
  assert.equal(textLength(doc([paragraph("abcde")])), 5);
  assert.equal(textLength(doc([table(["ab"], [["cd"], ["ef"]])])), 6);
  assert.equal(textLength(doc([list(["ab", "cd"])])), 4);
});
