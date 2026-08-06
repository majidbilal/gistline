# Known issues

Recorded rather than left to be discovered. Each entry says what is wrong, how it shows up, and what would fix it.

An issue here is not a promise to fix it. Several are trade-offs kept on purpose, and those say so.

---

## Compression

### Logs compress far less than JSON

**29.2% against 67.9%**, and the gap is structural rather than a tuning problem.

Template extraction removes the repeated format words, but a timestamp masked as `<ts>` still has to be emitted in the
values row — so it **moves rather than shrinks**. In a 62-character log line the timestamp is 20 of those characters and
templating cannot touch them.

**Fix:** column-wise encoding of the values row. Delta-encode timestamps (`14:22:01` then `+3`, `+5`), dictionary-encode
repeated variables (a worker id appearing 150 times becomes a short reference plus a legend), and run-length-encode
sorted columns. Estimated to reach 60-70%, still lossless. Not built.

### The XLSX second stage is lossy, and should not be

The conversion is lossless and takes 74.2% of the sheet XML. The compression stage that follows is currently the **lossy
log path**, because a Markdown table already states its headers once — so the redundancy `toTable()` removes was already
gone, and the remaining reduction comes from dropping rows.

**Fix:** a Markdown-table-aware lossless transform, using the same columnar encoding the log gap needs.

### Prose barely compresses

There is no repeated structure to state once, so gistline falls back to keeping the start and the end. That works and is
blunt. Tools using a trained model do better here; that is the trade zero dependencies buys.

### `headTail` overshoots its budget

By roughly 50 characters, because the elision marker it inserts is not counted against the budget. A 400-character budget
yields 452.

Pre-existing and consistent across both the current and the previous code path, so it is a bug rather than a regression.
There is a test asserting the overshoot stays bounded, which will fail if it grows.

---

## PDF

### Reading order is inferred for multi-column pages

Single-column pages follow the page's own drawing order and are reliable. Multi-column order is derived from the gutter
between columns, and **an inferred order can be wrong in ways that read perfectly**.

Every extraction reports its basis, so a caller can decide how much to trust the sequence. Genuinely interleaved layouts
— marginalia, glosses, sidebars — are underdetermined by geometry alone and no amount of tuning fixes that.

### Tables are inferred from alignment

A PDF records no table structure at all: no cell, no row, and a border may not exist. Tables are recovered from vertical
alignment, which works well for regular grids and less well for merged cells, nested tables and multi-line cells.

Suspected merged cells are **reported** rather than guessed at. Ruling lines are not read, because a border is a
path-drawing operator and plenty of real tables have none while plenty of bordered boxes are not tables.

### No OCR, and no plan for one

A scanned page has no text layer. Reading it requires a model, which would end the zero-dependency guarantee. gistline
detects the case and refuses with the reason.

The same applies to a font with arbitrary glyph ids and no character mapping anywhere: the page is skipped by number
rather than emitting glyph numbers as words.

**Deliberately not attempted:** guessing a font mapping from letter frequencies. It would produce fluent, confident,
wrong text — the single worst output this tool could emit, because nothing downstream could detect it.

### Preserve mode is not implemented

Reading is optimised for extracting information, not for rebuilding a document. `mode: "preserve"` is accepted and
**says plainly that it is not implemented** rather than silently behaving as read mode.

---

## Documents

### Extracted text can differ from what a human sees

PDF separates rendering from extraction by design. A font can be built so every glyph displays one character while its
mapping returns a different string, and `/ActualText` overrides what an extractor reports without changing what is drawn.

gistline **flags the mechanism** when present but cannot judge intent, and the mechanism has legitimate accessibility
uses. See [SECURITY.md](SECURITY.md).

### Word documents: comments and revision history are not read

Comments are excluded, and the output says so. Tracked deletions are excluded and insertions kept, so the result is the
revised document — also stated.

### Spreadsheets: charts, images and cell formatting are not read

Stated in the output. Formula cells yield their last calculated value, which is what a reader wants but is not the same
as the formula.

---

## Tooling

### `gistline run <command>` does not exist yet

The current flow is two steps: run a command redirecting output, then compress the file. **That is why the tool gets
skipped** — one command is a habit, two is a decision made every time.

**Fix:** a wrapper that executes and compresses in one action. This is the highest-value missing piece.

### No published benchmark

The numbers in the README are measured by the demos in this repository and reproduce exactly, but there is no shared
harness, no committed corpus, and — more importantly — **no measurement of fidelity**. A 100% saving that drops the one
failing test is a bug, not a win.

**Fix:** a corpus committed to the repository with **needles** per file (the failing assertion, the stack frame, the error
line) and a check that every needle survives. Including the cases where gistline does badly, because a benchmark showing
only wins is marketing.

### The installer writes files but installs no hooks

Skill, rule and instruction files are written. The **pre-tool hooks** that some assistants support — which would fire
before a command likely to produce large output — are not yet written, so on those platforms the instruction is
always-on guidance rather than an automatic prompt.

---

## Reporting something not listed here

A corpus that compresses badly is the most useful thing you can send. A case where gistline **removed something it should
have kept** is the most important. See [CONTRIBUTING.md](CONTRIBUTING.md).
