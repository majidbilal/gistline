# Changelog

Dates are the release date. Numbers quoted here are measured by the demos in this repository and reproduce with
`npm run demo`, `npm run demo-xlsx` and `npm run demo-pdf`.

## 0.4.0

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
