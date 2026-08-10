import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { deflateSync, deflateRawSync, crc32 } from "node:zlib";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// The CLI, exercised as a person actually uses it.
//
// THIS FILE EXISTS BECAUSE OF A REAL BUG. The CLI read every file with `readFileSync(file, "utf8")` and passed it to the
// TEXT path, so `gistline --file report.docx` printed the raw ZIP archive as mojibake — while `ingest()` had known how to
// read docx, xlsx, pptx, pdf and html for days and the README documented exactly that command.
//
// Nothing caught it because every other test exercised `ingest` directly and the smoke test used the API. The command a
// person types was the one path with no coverage. So these tests run the actual binary.

const CLI = new URL("./cli.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/** Run the CLI and capture stdout. A non-zero exit returns its stderr instead, so refusals are testable. */
function run(args, { input = null } = {}) {
  try {
    return execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      input: input ?? undefined,
      stdio: input === null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    return `EXIT${e.status}:${e.stderr ?? ""}`;
  }
}

// --- fixtures: real archives, built here -------------------------------------------------------------------

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

const dir = mkdtempSync(join(tmpdir(), "gistline-cli-"));
const at = (name, bytes) => { const p = join(dir, name); writeFileSync(p, bytes); return p; };

const DOCX = at("report.docx", zipOf([["word/document.xml",
  `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
    <w:p><w:r><w:t>Revenue rose twelve per cent.</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cost</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Setup</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>500</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`]]));

const XLSX = at("book.xlsx", zipOf([
  ["xl/workbook.xml", `<workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>`],
  ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
  ["xl/sharedStrings.xml", `<sst><si><t>Region</t></si><si><t>North</t></si></sst>`],
  ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c></row></sheetData></worksheet>`],
]));

const PPTX = at("deck.pptx", zipOf([
  ["ppt/presentation.xml", `<p:presentation><p:sldIdLst><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>`],
  ["ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>`],
  ["ppt/slides/slide1.xml", `<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
    <p:txBody><a:p><a:r><a:t>Kickoff</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
]));

const pdfBody = deflateSync(Buffer.from("BT /F1 12 Tf 72 700 Td (Contract terms follow.) Tj ET", "latin1")).toString("latin1");
const PDF = at("doc.pdf", Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
  + "2 0 obj\n<< /Type /Pages /Kids [ 3 0 R ] /Count 1 >>\nendobj\n"
  + "3 0 obj\n<< /Type /Page /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n"
  + `4 0 obj\n<< /Filter /FlateDecode /Length ${pdfBody.length} >>\nstream\n${pdfBody}\nendstream\nendobj\n`
  + "5 0 obj\n<< /Type /Font /Subtype /Type1 /Encoding /WinAnsiEncoding >>\nendobj\n"
  + "trailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));

const HTML = at("page.html", Buffer.from(
  `<html><head><style>${".a{b:c}".repeat(200)}</style></head><body><main><h1>Title</h1>`
  // A table is included deliberately: the two output modes differ only in how a TABLE is rendered, so a fixture without
  // one cannot tell them apart. My first version had no table, and the mode test failed against correct code.
  + `<table><tr><th>Metric</th><th>Value</th></tr><tr><td>Revenue</td><td>1200</td></tr></table>`
  + `<p>${"Real content. ".repeat(60)}</p></main><footer>Copyright</footer></body></html>`, "utf8"));

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

// --- every document format, through the CLI ---------------------------------------------------------------

test("CLI reads a .docx rather than printing the archive", () => {
  // The exact bug: this printed `PK` and mojibake.
  const out = run(["--file", DOCX, "--budget", "4000"]);
  assert.match(out, /Quarterly Report/);
  assert.match(out, /Revenue rose twelve per cent\./);
  assert.ok(!out.includes("PK"), "the raw archive must never reach stdout");
  assert.ok(!out.includes("word/document.xml"), "nor its internal paths");
});

test("CLI reads a .xlsx", () => {
  const out = run(["--file", XLSX, "--budget", "4000"]);
  assert.match(out, /Region/);
  assert.match(out, /North/);
  assert.ok(!out.includes("sharedStrings"));
});

test("CLI reads a .pptx", () => {
  const out = run(["--file", PPTX, "--budget", "4000"]);
  assert.match(out, /Kickoff/);
  assert.ok(!out.includes("p:sldIdLst"));
});

test("CLI reads a .pdf", () => {
  const out = run(["--file", PDF, "--budget", "4000"]);
  assert.match(out, /Contract terms follow\./);
  assert.ok(!out.includes("%PDF"));
});

test("CLI reads an .html page and drops its furniture", () => {
  const out = run(["--file", HTML, "--budget", "4000"]);
  assert.match(out, /Real content/);
  assert.ok(!out.includes("Copyright"), "the footer must be gone");
  assert.ok(!out.includes("{b:c}"), "the styles must be gone");
});

// --- the two modes, through the CLI -----------------------------------------------------------------------

test("the CLI defaults to information mode, and --preserve switches it", () => {
  // The default is information because the caller wanted to know what the document says. Preserve is for putting the answer
  // back into a document, and must be asked for.
  const info = run(["--file", DOCX, "--budget", "4000"]);
  const pres = run(["--file", DOCX, "--budget", "4000", "--preserve"]);

  assert.match(info, /Item,Cost/, "the default is the dense form");
  assert.ok(!info.includes("| Item | Cost |"), "the default must not emit pipe tables");

  assert.match(pres, /\| Item \| Cost \|/, "--preserve gives GitHub-flavoured Markdown");
  assert.match(pres, /\| --- \| --- \|/, "including the separator row");

  assert.ok(pres.length > info.length, "preserve is larger — that is the cost of presentation");
});

test("--preserve reaches EVERY format, not just the one I remembered", () => {
  // Threading a mode through five call sites by hand is where one gets missed, and the miss shows only on the format nobody
  // tested with the flag.
  for (const [label, path] of [["docx", DOCX], ["xlsx", XLSX], ["html", HTML]]) {
    const pres = run(["--file", path, "--budget", "8000", "--preserve"]);
    const info = run(["--file", path, "--budget", "8000"]);
    assert.notEqual(pres, info, `${label}: --preserve had no effect`);
  }
});

test("both modes keep every value", () => {
  // Denser presentation, identical content. If preserve has a value the default lacks, the default is losing data.
  const info = run(["--file", XLSX, "--budget", "8000"]);
  const pres = run(["--file", XLSX, "--budget", "8000", "--preserve"]);
  for (const v of ["Region", "North"]) {
    assert.ok(info.includes(v), `information mode lost ${v}`);
    assert.ok(pres.includes(v), `preserve mode lost ${v}`);
  }
});

// --- refusals, through the CLI ----------------------------------------------------------------------------

test("a refused format exits non-zero with the reason on stderr", () => {
  // stdout stays empty so a caller piping it gets nothing rather than half a document, and the reason is the useful part.
  const scan = at("scan.pdf", Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n"
    + "2 0 obj\n<< /Length 30 >>\nstream\nq 612 0 0 792 0 0 cm /Im1 Do Q\nendstream\nendobj\n"
    + "trailer\n<< /Root 1 0 R >>\n%%EOF", "latin1"));

  const out = run(["--file", scan]);
  assert.match(out, /^EXIT[12]:/, "a refusal must exit non-zero");
  assert.match(out, /OCR/, "and say what would fix it");
  assert.match(out, /scan\.pdf/, "naming the file");
});

test("an image is refused with the fact that matters about images", () => {
  const png = at("shot.png", Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(400)]));
  const out = run(["--file", png]);
  assert.match(out, /^EXIT/);
  assert.match(out, /pixel dimensions/, "resizing reduces token cost directly, which is the actionable part");
});

test("a missing file fails with a usage exit code, not a stack trace", () => {
  const out = run(["--file", join(dir, "nope.docx")]);
  assert.match(out, /^EXIT2:/);
  assert.ok(!out.includes("at Object."), "no stack trace");
});

// --- the flags that already existed must still work -------------------------------------------------------

test("stdin still works, and is unaffected by the file path changes", () => {
  const log = `${"ok 1 - passing\n".repeat(400)}not ok 401 - AssertionError\n# fail 1\n`;
  const out = run(["--kind", "test", "--budget", "400"], { input: log });
  assert.match(out, /not ok 401 - AssertionError/, "the failure must survive");
  assert.ok(out.length < log.length / 4, "and it must actually compress");
});

test("--json still returns the full result object", () => {
  const out = run(["--file", DOCX, "--budget", "4000", "--json"]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.ingest.kind, "docx");
  assert.equal(parsed.ingest.converted, true);
  assert.ok(typeof parsed.compressedChars === "number");
  assert.ok(Array.isArray(parsed.applied), "the reporting fields must be present");
});

test("conversion notes go to stderr, never into the compressed output", () => {
  // A note is for a person. Putting it on stdout would feed the model text about the conversion instead of the document.
  const out = run(["--file", DOCX, "--budget", "4000"]);
  assert.ok(!out.includes("note:"), "notes must not reach stdout");
  assert.ok(!out.includes("Images, charts"), "nor the reader's limitation text");
});

test("--budget is validated rather than silently producing nothing", () => {
  assert.match(run(["--file", DOCX, "--budget", "5"]), /EXIT2:.*budget/s);
});

// --- gistline run: execute and compress in one action ------------------------------------------------------
//
// The highest-value missing piece, per the project's own issue log: the two-step flow — redirect to a file, then compress the
// file — is WHY the tool gets skipped. One command is a habit; two is a decision made every time.

test("run executes a command and compresses its output", () => {
  const script = "let s='';for(let i=0;i<600;i++)s+='ok '+i+' - passing test\\n';s+='not ok 601 - AssertionError: expected 200\\n# fail 1\\n';process.stdout.write(s)";
  const out = run(["run", "--kind", "test", "--budget", "400", process.execPath, "-e", script]);

  assert.match(out, /not ok 601 - AssertionError/, "the failure must survive");
  assert.ok(!out.includes("ok 300 - passing"), "the ordinary lines should be gone");
  assert.ok(out.length < 4000, "and it must actually have compressed");
});

test("run passes through the COMMAND'S exit code", () => {
  // A compressor that swallowed a build failure would be worse than useless in CI. `gistline run npm test` must fail exactly
  // when `npm test` fails.
  //
  // Scripts here use SINGLE quotes throughout. A multi-argument command is spawned directly, so each argument arrives
  // verbatim — an escaped double quote would arrive as a literal quote character and fail to parse.
  const ok = run(["run", process.execPath, "-e", "process.exit(0)"]);
  assert.ok(!ok.startsWith("EXIT"), `a passing command should exit 0, got: ${ok.slice(0, 120)}`);

  const bad = run(["run", process.execPath, "-e", "console.log('boom');process.exit(3)"]);
  assert.match(bad, /^EXIT3:/, "a failing command's code must reach the caller");
});

test("run captures stderr as well as stdout", () => {
  // A build's errors are the part most worth keeping, and they are usually on stderr.
  const out = run(["run", "--budget", "2000", process.execPath, "-e", "console.error('ERROR: disk full')"]);
  assert.match(out, /ERROR: disk full/);
});

test("run labels the output with the command, so nobody has to invent one", () => {
  const out = run(["run", "--budget", "400", process.execPath, "-e", "process.stdout.write('x'.repeat(5000))"]);
  assert.match(out, /compressed/, "the note should be present");
  assert.match(out, /node/, "and should name what ran");
});

test("run needs a command, and says so", () => {
  const out = run(["run"]);
  assert.match(out, /^EXIT2:/);
  assert.match(out, /run needs a command/);
});

test("run does not mistake gistline's own flags for the command", () => {
  // `--budget 400` belongs to gistline; everything else is the command. Getting this wrong would try to execute "--budget".
  const out = run(["run", "--budget", "2000", "--kind", "test", process.execPath, "-e", "process.stdout.write('hello')"]);
  assert.ok(!out.startsWith("EXIT"), `should have run cleanly, got: ${out.slice(0, 120)}`);
  assert.match(out, /hello/);
});

test("run accepts -- to separate its flags from a command with its own", () => {
  const out = run(["run", "--budget", "2000", "--", process.execPath, "-e", "process.stdout.write('after-dashdash')"]);
  assert.match(out, /after-dashdash/);
});

test("run uses the SHELL when given a single argument, so pipes work", () => {
  // The two forms serve different needs and neither can serve the other's. One argument means the shell, because the user
  // wrote it as a shell line; several mean a direct spawn, because quoting must survive.
  //
  // Tested with a PIPE, which is the thing the shell form exists for and the thing a direct spawn cannot do. Deliberately
  // not using `process.execPath` here: on Windows it is `C:\Program Files\nodejs\node.exe`, and an unquoted path containing
  // a space is split by the shell — a property of the test's own fixture, not of `run`.
  const out = run(["run", "--budget", "2000", "echo one two three | sort"]);
  assert.ok(!out.startsWith("EXIT"), `the shell form should work, got: ${out.slice(0, 160)}`);
  assert.match(out, /one two three/, "the piped output must come through");
});

test("run reports a command that cannot be executed", () => {
  const out = run(["run", "definitely-not-a-real-command-xyz"]);
  // A shell reports an unknown command with its own non-zero code rather than failing to spawn, so either path is correct —
  // what matters is that it does not look like success.
  assert.match(out, /^EXIT[1-9]/);
});

test("run resolves a command that needs a shell to be found", () => {
  // `gistline run npm test` — the headline use case — failed with `spawnSync npm ENOENT` until a shell fallback existed,
  // because on Windows the executable is `npm.cmd` and only a shell resolves that.
  //
  // Found by running the command BY HAND, not by any test: every other test here invokes `node` by absolute path, which
  // needs no resolution, so the whole suite passed while the primary use case was broken.
  //
  // `npm --version` is used rather than `npm test`, which would run this suite recursively.
  const out = run(["run", "--budget", "2000", "npm", "--version"]);
  assert.ok(!out.startsWith("EXIT"), `npm should be resolvable, got: ${out.slice(0, 160)}`);
  assert.match(out, /\d+\.\d+\.\d+/, "npm's version should come through");
});

test("run prefers a direct spawn, falling back to the shell only when the command cannot be found", () => {
  // The order matters: direct first preserves quoting for everything that works that way, and the shell is a fallback where
  // the alternative is not working at all. A quoted argument must survive.
  const out = run(["run", "--budget", "2000", process.execPath, "-e", "process.stdout.write('spaces  and  quotes \"kept\"')"]);
  assert.match(out, /spaces {2}and {2}quotes "kept"/, "exact quoting must survive the direct path");
});

// --- the store is on by default ----------------------------------------------------------------------------
//
// It used to be opt-in for piped input and `--file`, and on only for `run` — so the tool's central promise, that the
// original can always be fetched back, was conditional in a way nobody would guess. An assistant reading "retrieve by id"
// would find no id and either invent one or conclude the tool was broken.

test("piped input keeps the original by default, and prints its id", () => {
  const out = run(["--kind", "log", "--budget", "300"], { input: "y".repeat(5000) });
  assert.match(out, /Full output retained as id [0-9a-f]{16}/, "an id must be issued without asking");
});

test("--file keeps the original by default", () => {
  // A document large enough to ACTUALLY be compressed. The small fixture above is under any sensible budget, so gistline
  // returns it untouched and issues no id — correctly, since nothing was removed and there is nothing to retrieve. My first
  // version of this test asserted an id for content that needed no compression.
  const big = at("big.docx", zipOf([["word/document.xml",
    `<w:document><w:body>${Array.from({ length: 200 }, (i0, i) =>
      `<w:p><w:r><w:t>Paragraph ${i} of a long document.</w:t></w:r></w:p>`).join("")}</w:body></w:document>`]]));

  const out = run(["--file", big, "--budget", "300"]);
  assert.match(out, /retained as id/);
});

test("run keeps the original by default, as it always did", () => {
  const out = run(["run", "--budget", "300", process.execPath, "-e", "process.stdout.write('x'.repeat(5000))"]);
  assert.match(out, /retained as id/);
});

test("--no-store opts out, and the note stops promising retrieval", () => {
  // The privacy escape hatch: keeping the original writes it to disk, and someone compressing something sensitive needs a
  // way to decline.
  const out = run(["--kind", "log", "--budget", "300", "--no-store"], { input: "y".repeat(5000) });
  assert.ok(!out.includes("retained as id"), "it must not claim a retrieval it did not make");
  assert.match(out, /was not retained, so it cannot be recovered/);
  // And it must not tell the caller to pass a flag they deliberately declined.
  assert.ok(!out.includes("--store"), "advising --store here would be wrong");
});

test("the id printed by the CLI actually retrieves the original", () => {
  // End to end, through the binary: the promise is only real if the id works.
  const input = `${"ok - passing\n".repeat(500)}not ok 501 - AssertionError\n`;
  const compressed = run(["--kind", "test", "--budget", "300"], { input });

  const id = (compressed.match(/retained as id ([0-9a-f]{16})/) ?? [])[1];
  assert.ok(id, `no id in the note: ${compressed.slice(0, 160)}`);

  const original = run(["retrieve", id]);
  assert.equal(original.trimEnd(), input.trimEnd(), "the retrieved original must be byte-identical");
});

test("grep works on the retrieved original, not just retrieve", () => {
  const input = `${"ok - passing\n".repeat(500)}not ok 501 - AssertionError: boom\n`;
  const id = (run(["--kind", "test", "--budget", "300"], { input }).match(/retained as id ([0-9a-f]{16})/) ?? [])[1];
  assert.ok(id);
  assert.match(run(["grep", id, "AssertionError"]), /not ok 501 - AssertionError: boom/);
});

test("--store <dir> still chooses where the original goes", () => {
  // The flag keeps its old meaning for anyone who wants a specific location, rather than becoming a no-op.
  const dir = join(dirname(DOCX), "custom-store");
  const out = run(["--kind", "log", "--budget", "300", "--store", dir], { input: "y".repeat(5000) });
  assert.match(out, /retained as id/);
  assert.ok(existsSync(dir), "the named directory should have been created and used");
});
