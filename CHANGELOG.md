# Changelog

Dates are the release date. Numbers quoted here are measured by the demos in this repository and reproduce with
`npm run demo`, `npm run demo-xlsx` and `npm run demo-pdf`.

## 0.6.0

### The original is kept by default

**A behaviour change, and the reason is that the promise was conditional.**

gistline's central claim is that nothing is lost: whatever was removed can be fetched back by id. But the store was
*opt-in* for piped input and `--file`, and on only for `gistline run` — so the id a reader was told to use frequently was
not there. An assistant reading "retrieve the original by id" would find none, and either invent one or conclude the tool
was broken.

Now every invocation retains the original, so the id is present whenever something was actually removed. A lossless result
still stores nothing, because nothing was dropped and there is nothing to recover.

**`--no-store` opts out.** Keeping the original means writing it to disk, and that is a real cost — so anyone compressing
something sensitive has a switch, it is documented in the README, and [SECURITY.md](SECURITY.md) states plainly that
compressed content is now on disk in full by default.

The note wording changed with it: when the original was not retained it no longer advises passing `--store`, because that
flag is now the default and reaching that branch means the caller declined it deliberately.

### Documentation

Where the retrieval id comes from is now explained, with a worked example, in both the README and the instruction gistline
installs into 23 assistants. Neither had said it — both showed `gistline retrieve <id>` and left the reader to work out
what `<id>` was.

Also added: what to do when a detail is missing from compressed output. Retrieve it, rather than guessing or re-running
the command.

513 tests.

## 0.5.0

### Logs now compress as well as JSON

**29.2% to 67.5%**, and the gap was structural rather than a tuning problem: template extraction removed the repeated format
words, but a timestamp still had to be emitted in the values row, so it *moved* rather than shrank.

Values are now encoded **column by column**, because a column is far more predictable than a row. Four encodings, chosen per
column by measuring all of them and keeping the smallest that round-trips exactly:

| | |
|---|---|
| `stamps` | epoch deltas, with the original text form recorded so reconstruction is exact rather than equivalent |
| `delta` | each value as its difference from the previous |
| `dict` | repeated values as short references plus a legend |
| `runs` | consecutive identical values as a count |

Measured, not predicted. "Timestamps ascend so use delta" is true of most logs and *larger* on one with interleaved sources.

### Markdown tables, and a lossless spreadsheet path

A table's redundancy is down its **columns**, not in its headers — so the same encoding applies. The spreadsheet path is now
lossless from sheet XML to compressed output; previously its second stage was the lossy log path.

Detection was the hard part: prose with one comma per line is a perfect two-column table by field count. The discriminator
was measured rather than guessed — **4.08 average words per field for prose against 1.00 for tables**. A cell is a value,
not a clause.

### `gistline run <command>`

Execute and compress in one step. The alternative is two — redirect to a file, then compress it — and **that is why
compression tools get skipped**. It passes through the command's own exit code, so it is safe in CI.

```
$ gistline run npm test
[npm test output compressed: 90,125 → 131 chars. Full output retained as id 3daa3cf5dc1f28de]
```

### Comments in Word, Excel and PowerPoint

Word's output used to say "Comments are not included" — accurate, and a real gap: a reviewer's comment is frequently the most
useful text in a document.

Now read with their author, their date, and **the text they point at**, because "check this against schedule 2" is nearly
meaningless alone. Excel reads **both** comment formats, since it writes both. PowerPoint attaches them to the slide they
were left on.

### OCR, as an optional adapter

gistline uses **Tesseract if it happens to be installed** and refuses cleanly if not. Nothing is bundled, downloaded or
required — with Tesseract absent, every path behaves exactly as it did before OCR existed, and there is a test asserting it.

Empty recognition output is treated as a **failure**, not a success with no text: a blank result from a page that visibly
contains writing means recognition did not work.

### Information is the default output

The reason to read a document is almost always to learn what it says, not to rebuild it. Which parts of Markdown are
overhead was **measured**: table delimiters 28.7%, separator row 1.4%, heading markers 0.6%. So headings stay — a heading
level is information and nearly free — and the pipe table is replaced with a dense form.

**23.3% smaller** on a mixed report, **26.2%** on a spreadsheet, **0%** on pure prose. `--preserve` is for when the answer
has to go back into a document, and what gistline installs documents it **by intent**: "change this in my PDF" takes it,
"here are the files for context" does not.

### Hooks on five platforms

Pre-tool hooks for Claude Code, Gemini CLI and CodeBuddy by settings entry, and OpenCode and Kilo Code by plugin module.
They **advise rather than rewrite** — silently altering a command means the thing that runs is not the thing that was
decided — and never block.

### Benchmarks that measure fidelity

[`BENCHMARKS.md`](BENCHMARKS.md) is generated by `npm run benchmark` over eight corpora **including the case gistline does
badly**. Every corpus declares needles that must be literally present, and a lost needle **fails the build**.

It found three real bugs on its first run, listed below.

### Fixed

- **The compression note lied.** It said "Nothing was deleted" whenever no store was configured, regardless of whether a
  lossy transform had run — so a CSV with a third of its rows dropped was reported as having lost nothing. Two independent
  facts had been conflated: *was anything removed* and *can the original be recovered*.
- **`gistline --file report.docx` printed the raw ZIP archive.** The CLI read every file as UTF-8 text and never called the
  document reader, while the README documented exactly that command. Every test used the API; the command a person types was
  the one path with no coverage.
- **The lossy step dropped whole categories.** It filled the budget from one template group at a time, so a CSV whose
  `region-3` rows shared one template lost every one while `region-0` kept a hundred. Now sampled round-robin.
- **Columnar output was destroyed by the lossy step**, which drops *lines* — and in columnar form a line is a block of 200
  rows. Now the form the next stage can safely reduce is chosen, even when it is larger.
- **`rank` did not recognise `not ok`**, TAP's failure marker and the single most important line in a test run.
- **The test script relied on shell glob expansion**, which PowerShell does not do, so CI failed on every Windows runner.
- **`engines` claimed `>=18`** while `util/unzip.mjs` needs `zlib.crc32`, added in 20.15. Now `>=20.15.0`, verified in CI
  before any test runs.
- **`exports` exposed only the entry point**, making every other module unreachable from an installed package.

### Structure

Root reduced from 28 files to 17, with `scripts/`, `hooks/`, `docs/` and a gitignored `docs/internal/`.
`docs/ARCHITECTURE.md` is generated from the real import graph, so it cannot drift.

502 tests, 8 benchmark corpora, four checks gating CI and publication.

## 0.4.0 — not published

Committed and tested but never released: 0.5.0 landed first and includes all of it. Kept here because the reasoning is worth
having, and because a version number that exists in the history but not on the registry should say so rather than look like
a gap.

### Information is the default output; presentation is opt-in

The purpose of reading a document is almost always to learn what it says, not to rebuild it. The default output now carries
the content and drops the presentation, and reconstruction is asked for with `--preserve`.

**Which parts of Markdown are overhead was measured, not assumed.** On a realistic report:

| | Share of output | Decision |
|---|---|---|
| Table delimiters and padding | **28.7%** | replaced with a dense form |
| Separator row | 1.4% | dropped — it carries nothing |
| Heading and list markers | 0.6% | **kept** — a heading level is information, and nearly free |

Measured saving: **23.3%** on a mixed report, **26.2%** on a spreadsheet, **25.3%** on a wide table, **0%** on pure prose.
Every value survives in both modes, and there is a test asserting it.

`--preserve` is documented by **intent** rather than by file type in what gistline installs — "change this in my PDF" takes
it, "here are the files for context" does not — because a flag nobody knows when to set is a flag nobody sets.

### Fixed: `gistline --file <document>` printed the raw archive

The CLI read every file with `readFileSync(file, "utf8")` and passed it to the text path, so `gistline --file report.docx`
emitted the ZIP archive as mojibake — while document reading had worked through the API for days and the README documented
exactly that command.

Nothing caught it because every test exercised `ingest` directly and the smoke test used the API. **The command a person
actually types was the one path with no coverage.** There is now a CLI test file covering all five formats, both output
modes, refusals, `--json`, `--stats` and stdin.

### Guidance on fetching

What gistline installs now tells the assistant to fetch web pages **through the shell** rather than with a built-in fetch
tool. A built-in fetch puts the page straight into the conversation where it can never be compressed, and scraped HTML is
the largest saving available. Commands are given for macOS, Linux, Windows `curl.exe`, PowerShell `Invoke-WebRequest` and
`wget`, because naming only one would leave most users with something that does not work.

### Pre-tool hooks

`gistline install` writes a hook for Claude Code, Gemini CLI and CodeBuddy that speaks up before a command likely to
produce large output. It **advises rather than rewrites**, never blocks, merges into an existing `settings.json` without
destroying it, and restores that file byte-identically on uninstall. Opt out with `--no-hooks`.

### Structure

Root reduced from 28 files to 17, with `scripts/`, `hooks/`, `docs/`, and a gitignored `docs/internal/` for working plans.
`docs/ARCHITECTURE.md` is generated from the real import graph by `npm run architecture`, so it cannot drift from the code.

429 tests.

## 0.3.0

The release that changes what gistline is: it used to decide what to keep and drop the rest. Now it first makes content
smaller **without removing anything**, and only then drops what is genuinely left over.

### Lossless compression

- **Table compaction.** An array of like-shaped records becomes a header and rows, so field names are stated once
  instead of per record. **67.9% smaller on a 300-record API response, with every record present.**
- **Log template extraction.** Each repeated message format is stated once, then only the values that vary. **29.2%
  smaller with nothing removed**, and fully reversible.
- **Structure-aware lossy continuation.** When a document is still over budget after the lossless stage, the reduction
  understands what the lossless stage produced — so it keeps the header and every error, and drops ordinary rows. The
  combined path fits **1.9x more of a log** into the same budget than dropping lines from the start.

### Honest reporting

- `gist()` now returns which stages ran and whether any of them removed content, so **"nothing was removed" is
  distinguishable from "1,400 rows were dropped"**. Those are different facts and the old note could express neither.
- A structured result that cannot safely be cut is allowed to exceed the budget rather than be corrupted. Being slightly
  too large is recoverable; being quietly wrong is not.

### Documents

Read and converted to Markdown, then compressed — the two stages compound.

- **HTML** — headings, lists, tables and links kept; scripts, styling, navigation and footers discarded. **95.8% smaller
  on a real page.**
- **XLSX** — every sheet as a table. Dates are dates rather than serial numbers, inline strings are read as well as
  shared ones, formula cells yield their cached value, and sparse rows are placed by cell reference rather than by order.
  **94.0% smaller end to end.**
- **DOCX** — headings, lists, tables, footnotes and hyperlinks. Tracked deletions are excluded and insertions kept, so
  the output is the revised document, and it says so.
- **PPTX** — slide titles and body text in presentation order, plus speaker notes marked as notes.
- **PDF** — see below.
- **ZIP** — read via `node:zlib` alone, with CRC verification, a decompression-size limit, and ZIP64 declined explicitly.

### PDF

- **Classification first**, with six verdicts and advice specific to each. A scanned document is told it needs OCR; a
  readable one is read.
- **Four font-recovery paths**, so a subsetted font with named glyphs is read correctly rather than written off.
- **Per-page extraction.** A document with seventy clean pages and ten scanned ones returns the seventy, and names the
  gaps by page number.
- **Multi-column reading order**, from the gutter between columns, labelled as inferred.
- **Running headers and footers stated once** instead of repeated on every page.
- **Tables recovered from alignment**, labelled as inferred, with suspected merged cells reported.

### Assistant integration

- `gistline install` registers gistline with **23 AI coding assistants** — skill files, always-applied rules, or a
  delimited block in a shared instruction file, depending on what each one reads.
- Shared files such as `AGENTS.md` are **spliced, never overwritten**, and `gistline uninstall` removes only gistline's
  block.
- `gistline status` reports what is actually on disk, grouped by file, because install without verification is how a tool
  appears installed and does nothing.

### Structure

- Readers produce a document model; one Markdown writer renders it. Pipe escaping and ragged-row padding are decided
  once and inherited by every reader.
- Shared utilities for delimiter-safe encoding, line handling and variable masking, each with one implementation and one
  set of round-trip tests.

### Tests

379, up from 30. Every lossless transform has a reverse function and a round-trip test, and documented limitations are
tested so they cannot quietly change.

## 0.2.2

Provenance attestations via GitHub Actions OIDC trusted publishing.

## 0.2.0

Retrieval store: compressed output carries an id, and the original can be retrieved, sliced or grepped. This is what
makes aggressive compression safe.

## 0.1.0

First release. Content-kind detection and per-kind compression for test output, logs, diffs, JSON and stack traces.
