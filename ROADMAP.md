# Roadmap

What gistline does today, what is coming, and what it will not do. Numbers here are measured by the demos in this
repository and reproduce with `npm run demo`, `npm run demo-pdf` and `npm run demo-xlsx`.

Anything listed under **Coming next** is an intention, not a commitment. Anything under **Not planned** is a decision.

---

## Working now (0.3.x)

### Lossless compression

Content is made smaller **without removing anything** before anything is dropped.

- **Tables** — an array of like-shaped records becomes a header and rows, so field names are stated once rather than per
  record. **67.9% smaller** on a 300-record API response, with every record present.
- **Log templates** — each repeated message format stated once, then only the values that vary. **29.2% smaller**, fully
  reversible.
- **Running headers and footers** in paginated documents, stated once instead of on every page.

### Structure-aware lossy reduction

When a document is still over budget, what gets dropped is chosen by something that understands the structure: the
header stays, every error and warning stays, and ordinary rows go. The combined path fits **1.9x more of a log** into the
same budget than dropping lines from the start.

### Honest reporting

Every result says whether anything was removed. "Nothing was removed" and "1,400 rows were dropped" are different facts,
and both are stated plainly. The original is always retrievable by id.

### Documents

Read, converted to Markdown, then compressed — the two stages compound.

| Format | Status |
|---|---|
| **HTML** | headings, lists, tables, links; scripts, styling, navigation and footers discarded |
| **XLSX** | every sheet as a table; dates as dates, formulas as their cached value, sparse rows placed correctly |
| **DOCX** | headings, lists, tables, footnotes, hyperlinks; tracked deletions excluded and it says so |
| **PPTX** | slide titles and body text in presentation order, plus speaker notes |
| **PDF** | classification, four font-recovery paths, per-page extraction, multi-column ordering, running furniture, tables from alignment |
| **ZIP** | read via `node:zlib` alone, with CRC verification and a decompression cap |

### Assistant integration

`gistline install` registers with **23 AI coding assistants**. Shared instruction files are spliced, never overwritten,
and uninstall restores them byte-identically.

### Compression by content kind

Test output, logs, diffs, JSON and stack traces, with detection and a `--kind` override.

---

## Coming next

### Columnar encoding of log values

**The largest measured gap.** Logs compress to 29.2% where JSON reaches 67.9%, and the reason is structural: template
extraction removes the repeated format words, but a timestamp masked as `<ts>` still has to be emitted in the values row,
so it **moves rather than shrinks**. In a 62-character log line the timestamp is 20 of those characters.

Planned: delta-encode timestamps (`14:22:01` then `+3`, `+5`), dictionary-encode repeated variables, and run-length-encode
sorted columns. Estimated to reach 60-70%, still lossless.

The same work fixes a second gap: the XLSX pipeline's lossless stage takes 74.2% of the sheet XML, but the compression
stage that follows is currently the lossy log path, because a Markdown table already states its headers once. A
table-aware lossless transform would make both stages lossless.

### `gistline run <command>`

Execute a command and compress its output in one action.

This matters more than it sounds. The current flow is two steps — redirect output to a file, then compress the file —
and **that is why the tool gets skipped**. One command is a habit; two is a decision made every time. It is the
highest-value missing piece and it is small.

### Pre-tool hooks

Some assistants support a hook that fires before a command runs. On those platforms gistline could prompt automatically
rather than relying on always-on guidance. The instruction files are written today; the hooks are not.

### Published benchmarks

A committed corpus with a reproducible harness — including the cases where gistline does badly, because a benchmark
showing only wins is marketing.

Critically, it must measure **fidelity, not just ratio**. A 100% saving that drops the one failing test is a bug, not a
win. Every corpus file will carry **needles** — the failing assertion, the stack frame, the error line — and the harness
will assert every needle survives.

### Better handling of ordinary text

**The honest weak spot.** Content with no errors and no structure — plain prose, a CSV export, an `npm install` log — has
nothing to latch onto, so gistline keeps the start and the end. That works and is blunt.

Planned: strategies that understand **CSV/TSV** (keep the header and a representative sample), **install logs** (keep
what changed and what warned), and **prose** (keep opening, closing, and the parts that carry information).

### More accurate token counts

Character counts are a proxy. A real tokeniser would be exact — and would be a dependency, which is the whole trade.
Likely answer: keep the estimate, and make the arithmetic configurable for anyone who wants to supply their own.

### Streaming for very large inputs

Everything is currently read into memory. Fine for a build log, wrong for a multi-gigabyte one.

### Preserve mode for documents

Reading is optimised for extracting information rather than rebuilding a document, which is almost always what is wanted.
`mode: "preserve"` is accepted today and **says plainly that it is not implemented** rather than silently behaving as read
mode. Building it properly means recording what read mode deliberately drops.

---

## Not planned, and why

### OCR

A scanned page has no text layer, and reading it needs a model — which would end the zero-dependency guarantee that makes
gistline usable as a build gate. gistline detects the case and refuses with the reason.

**Related and firmly excluded:** guessing a font mapping from letter frequencies. It would produce fluent, confident,
wrong text — the worst possible output, because nothing downstream could detect it.

### A trained compression model

Tools using one get better results on prose. They also need a large install, a warm-up, and produce results that can
differ between machines. gistline is deterministic and instant, and that is the deliberate trade. For model-quality
compression of prose, use a tool built for it.

### A proxy that sits between an assistant and its tools

Compressing another tool's output requires either that tool calling gistline, or a proxy intercepting everything. A proxy
is a different product with a much larger surface, and it would not be zero-dependency.

gistline reduces what **enters** a context window. It cannot reduce what a host chooses to re-send, and saying which half
is ours is more useful than implying otherwise.

### Full-fidelity document conversion

Mature converters exist for turning a document into a faithful reproduction. gistline reads what it can with zero
dependencies and says plainly when it cannot. Competing with a dedicated converter would mean being a worse one.

### Sanitising untrusted content

gistline converts and compresses. It does not judge what a document says. Extracted text from an untrusted source is
untrusted input — see [SECURITY.md](SECURITY.md).

---

## How versions work

**Patch** — fixes, and compression improvements that do not change what output means.

**Minor** — new capabilities, new formats, new assistants. Existing output may get smaller; what it *means* does not
change.

**Major** — a change to the contract: the shape of a result, the meaning of a note, or the removal of a command.

The `applied` and `lossy` fields in a result are part of the contract. A stage that changes from lossless to lossy, or
the reverse, is a major change even if the output looks similar — because the guarantee is the product.

---

Known limits are tracked in [ISSUES.md](ISSUES.md). Released changes are in [CHANGELOG.md](CHANGELOG.md).
