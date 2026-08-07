# Roadmap

What gistline does today, what is coming, and what it will not do. Every figure here is measured by
[`npm run benchmark`](BENCHMARKS.md) or by the demos in this repository, and reproduces on any machine.

Anything under **Coming next** is an intention, not a commitment. Anything under **Not planned** is a decision, with the
reasoning.

---

## Working now (0.5.x)

### Lossless compression

Content is made smaller **without removing anything** before anything is dropped.

- **Tables** — an array of like-shaped records becomes a header and rows, so field names are stated once rather than per
  record. **67.9% smaller** on a 300-record API response, with every record present.
- **Log templates with columnar values** — each repeated message format stated once, then the values encoded **column by
  column**: timestamps as deltas, cycling identifiers as dictionary references, constant columns as run lengths. **67.5%
  smaller** on a 1,200-line log, fully reversible. Logs now compress as well as JSON, where they used to reach 29%.
- **Markdown tables** — a table's redundancy is down its columns, not in its headers, so the same columnar encoding
  applies. The spreadsheet path is now lossless from sheet XML to compressed output.
- **Running headers and footers** in paginated documents, stated once instead of on every page.

### Structure-aware lossy reduction

When a document is still over budget, what gets dropped is chosen by something that understands the structure: the header
stays, every error and warning stays, and ordinary rows go — sampled **round-robin across formats**, so a truncated
listing shows some of each kind rather than all of the first.

The combined path fits **4.7x more of a log** into the same budget than dropping lines from the start.

### Honest reporting

Every result states two separate facts: whether anything was **removed**, and whether the original can be **recovered**.
Conflating them is the failure mode this tool exists to avoid.

### Documents

Read, converted to Markdown, then compressed — the two stages compound.

| Format | Status |
|---|---|
| **HTML** | headings, lists, tables, links; scripts, styling, navigation and footers discarded |
| **XLSX** | sheets as tables, dates as dates, formulas as their cached value, cell comments with their author |
| **DOCX** | headings, lists, tables, footnotes, hyperlinks, and comments with the text they annotate |
| **PPTX** | slide text in presentation order, speaker notes, and review comments on their own slide |
| **PDF** | classification, four font-recovery paths, per-page extraction, multi-column ordering, running furniture, tables from alignment |
| **Images** | OCR via Tesseract when it is installed; a clear refusal when it is not |
| **ZIP** | read via `node:zlib` alone, with CRC verification and a decompression cap |

**Information is the default output**, not presentation: the reason to read a document is almost always to learn what it
says. `--preserve` is for when the answer has to go back into a document.

### One command

`gistline run <command>` executes and compresses in one step, and passes through the command's own exit code, so it is
safe in CI and in a pre-commit hook.

### Assistant integration

`gistline install` registers with **23 AI coding assistants**, including **pre-tool hooks** on five of them — three by
settings entry, two by plugin module. Shared instruction files are spliced, never overwritten.

### Benchmarks

[`BENCHMARKS.md`](BENCHMARKS.md) measures **fidelity, not just ratio**: every corpus declares needles that must survive,
and a lost needle fails the build.

---

## Coming next

### Better handling of ordinary text

**The honest weak spot.** Content with no errors and no structure — plain prose, an `npm install` log — has nothing to
latch onto, so gistline keeps the start and the end. That works and is blunt.

Planned: strategies that understand **install logs** (keep what changed and what warned) and **prose** (keep opening,
closing, and the parts that carry information). CSV is now handled by the columnar path.

### Preserve mode for documents

The flag exists and is honoured by the writer, so a document's tables and headings come back in full Markdown. But
`preserve` is **not implemented for PDF or PowerPoint**, and both say so plainly rather than silently behaving as read
mode. Building it properly means recording what read mode deliberately drops.

### More accurate token counts

Character counts are a proxy. A real tokeniser would be exact — and would be a dependency, which is the whole trade.
Likely answer: keep the estimate, and make the arithmetic configurable for anyone who wants to supply their own.

### Streaming for very large inputs

Everything is read into memory. Fine for a build log, wrong for a multi-gigabyte one.

### PDF preserve mode and table confidence

PDF tables are inferred from alignment and labelled as inferred. A confidence score per table would let a caller decide
whether to trust one, rather than treating all inferred tables alike.

---

## Not planned, and why

### A bundled OCR model

gistline **uses Tesseract when it is installed** and refuses cleanly when it is not. It will never bundle one: reading a
scanned page needs a model, and shipping one would end the zero-dependency guarantee that makes this usable as a build
gate.

The rule is: adopt the idea, never the code. An external tool may be an **optional adapter that never degrades behaviour
when absent** — with Tesseract missing, every path behaves exactly as it did before OCR existed.

**Firmly excluded:** guessing a font mapping from letter frequencies. It would produce fluent, confident, wrong text —
the worst possible output, because nothing downstream could detect it.

### A trained compression model

Tools using one get better results on prose. They also need a large install, a warm-up, and produce results that can
differ between machines. gistline is deterministic and instant, and that is the deliberate trade.

### A proxy between an assistant and its tools

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

The `applied` and `lossy` fields are part of that contract. A stage changing from lossless to lossy, or the reverse, is a
major change even if the output looks similar — because **the guarantee is the product**.

### Why not 1.0 yet

The published surface is still moving: `--preserve`, `gistline run` and the wording of the compression note all changed
in 0.5.0. 1.0 is a promise about stability, and that promise is worth making only after the surface has sat unchanged for
a while.

---

Known limits are tracked in [ISSUES.md](ISSUES.md). Released changes are in [CHANGELOG.md](CHANGELOG.md).
