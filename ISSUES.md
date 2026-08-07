# Known issues

Recorded rather than left to be discovered. Each entry says what is wrong, how it shows up, and what would fix it.

An issue here is not a promise to fix it. Several are trade-offs kept on purpose, and those say so.

---

## Compression

### Prose barely compresses

There is no repeated structure to state once, so gistline falls back to keeping the start and the end. That works and is
blunt. The benchmark keeps a prose row precisely so this is visible rather than hidden.

Tools using a trained model do better here; that is the trade zero dependencies buys.

### `headTail` overshoots its budget

By roughly 50 characters, because the elision marker it inserts is not counted against the budget. A 400-character budget
yields 452.

Pre-existing and consistent across every code path, so it is a bug rather than a regression. There is a test asserting the
overshoot stays bounded, which will fail if it grows.

### Columnar output is not human-readable

The columnar form stores values by column, so a value is reconstructible but **not literally visible**. Interesting lines
— anything `rank` considers a failure, error or warning — are deliberately kept verbatim for exactly this reason, and the
columnar form is only chosen when it fits the budget outright.

But an ordinary value in a columnar block cannot be grepped for. If you need to search the output rather than the
original, use `gistline retrieve <id>` and search that.

### Token counts are estimated, not measured

Characters are a proxy for tokens, at roughly 3.6 characters each. A real tokeniser would be exact and would be a
dependency. The estimate is deliberately conservative, but it is an estimate.

---

## PDF

### Reading order is inferred for multi-column pages

Single-column pages follow the page's own drawing order and are reliable. Multi-column order is derived from the gutter
between columns, and **an inferred order can be wrong in ways that read perfectly**.

Every extraction reports its basis, so a caller can decide how much to trust the sequence. Genuinely interleaved layouts —
marginalia, glosses, sidebars — are underdetermined by geometry alone and no amount of tuning fixes that.

### Tables are inferred from alignment

A PDF records no table structure at all: no cell, no row, and a border may not exist. Tables are recovered from vertical
alignment, which works well for regular grids and less well for merged cells, nested tables and multi-line cells.

Suspected merged cells are **reported** rather than guessed at. Ruling lines are not read, because a border is a
path-drawing operator and plenty of real tables have none while plenty of bordered boxes are not tables.

There is no per-table confidence score, so a caller cannot tell a clean grid from a marginal one. That is on the roadmap.

### Preserve mode is not implemented for PDF or PowerPoint

`mode: "preserve"` is accepted and **says plainly that it is not implemented** for these two, rather than silently
behaving as read mode. HTML, DOCX and XLSX honour it.

### A scanned PDF needs rasterising before OCR

gistline uses Tesseract when installed, but Tesseract reads **images, not PDFs**. A scanned PDF must be turned into images
first (`pdftoppm` from Poppler, or ImageMagick), and the refusal says so rather than sending someone to a tool that cannot
do the job alone.

Rasterising a PDF ourselves would require a rendering engine, which is not a zero-dependency proposition.

---

## Documents

### Extracted text can differ from what a human sees

PDF separates rendering from extraction by design. A font can be built so every glyph displays one character while its
mapping returns a different string, and `/ActualText` overrides what an extractor reports without changing what is drawn.

gistline **flags the mechanism** when present but cannot judge intent, and the mechanism has legitimate accessibility
uses. See [SECURITY.md](SECURITY.md).

### OCR output contains errors

Where Tesseract is used, the output says so and warns that anything mattering should be verified against the image.
Layout, tables and reading order are not recovered — it is the text Tesseract found, in the order it found it.

### Spreadsheets: charts, images and cell formatting are not read

Stated in the output. Formulas yield their last calculated value, which is what a reader wants but is not the same as the
formula.

### Word: revision history beyond the current state is not read

Tracked deletions are excluded and insertions kept, so the result is the revised document — and it says so. The history of
who changed what, and when, is not reconstructed.

---

## Tooling

### Hooks reach five platforms, guidance reaches all 23

`gistline install` writes a **pre-tool hook** for Claude Code, Gemini CLI and CodeBuddy by settings entry, and for
OpenCode and Kilo Code by plugin module. It **advises rather than rewrites**: silently altering a command means the thing
that runs is not the thing that was decided, and it breaks on redirections and multi-command lines.

On the remaining eighteen platforms gistline is always-on guidance in a skill, rule or instruction file rather than an
automatic prompt. Opt out of hooks with `gistline install --no-hooks`.

### The benchmark corpus is generated, not real-world

Every corpus in [`scripts/benchmark.mjs`](scripts/benchmark.mjs) is built from source so the figures are reproducible and
reviewable in a diff. That also means they are *representative* rather than *real* — a corpus of genuine build logs from
several projects would be better evidence.

**A corpus that compresses badly is the most useful thing you can send.** See [CONTRIBUTING.md](CONTRIBUTING.md).

### No comparison against other tools

Their corpora and budgets differ, and a table built to flatter one tool is worth nothing. Run `npm run benchmark` on your
own content instead.

### Everything is read into memory

Fine for a build log, wrong for a multi-gigabyte one. Streaming is on the roadmap.

---

## Reporting something not listed here

A corpus that compresses badly is the most useful thing you can send. A case where gistline **removed something it should
have kept** is the most important — that is the failure this project cares about most, and the hardest to find from the
inside. See [CONTRIBUTING.md](CONTRIBUTING.md).
