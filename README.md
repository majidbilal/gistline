# gistline

**Large output costs tokens. gistline makes it smaller before your AI assistant reads it — and tells you whether
anything was thrown away.**

[![npm](https://img.shields.io/npm/v/gistline?color=0b7285&label=npm)](https://www.npmjs.com/package/gistline)
[![tests](https://img.shields.io/badge/tests-379%20passing-1f6f43)](#how-it-is-tested)
[![dependencies](https://img.shields.io/badge/dependencies-0-1f6f43)](#zero-dependencies-is-the-point)
[![node](https://img.shields.io/badge/node-%E2%89%A518-333333)](#requirements)
[![licence](https://img.shields.io/badge/licence-MIT-333333)](LICENSE)

A test suite prints 40,000 characters. A build log prints 200,000. An API response repeats the same six field names
across 300 records. A 12-page PDF arrives as a wall of text with the same header on every page.

All of that goes into a context window and all of it is paid for. Most of it is not information — it is the same shape
repeated, and it can be made smaller **without removing anything**.

```
$ npm test 2>&1 | npx gistline --kind test --label suite

[suite output compressed: 69,567 → 131 chars. Nothing was deleted — request the verbatim output if you
 need a dropped detail.]
[compressed: 758 passing lines omitted]

# tests 379
# pass 379
# fail 0
```

The 758 passing lines are gone. **The failures never are** — and the original is retrievable by id, so nothing is
actually lost.

---

## Install

```
npm install -g gistline        # or use it without installing: npx gistline
gistline install              # register with your AI assistant
```

That second command is the one that matters. It writes the file your assistant already reads, so the assistant starts
compressing large output on its own instead of waiting to be asked.

```
$ gistline install
  created /Users/you/.claude/skills/gistline/SKILL.md

gistline registered with 1 location(s).
Verify with: gistline status
```

**23 assistants supported.** `gistline platforms` lists them; [the table is below](#supported-assistants).

---

## What it actually does

Two stages, and the order is the whole design.

**Stage one restates the content more compactly, removing nothing.**

| Input | What is repeated | Result |
|---|---|---|
| 300-record JSON response | the six field names, 300 times | **67.9% smaller**, every record present |
| Build log, six message formats | the format words, 1,200 times | **29.2% smaller**, every line reconstructible |
| 12-page PDF | the running header, 12 times | stated once, 24 lines of furniture removed |
| Scraped HTML page | markup, scripts, navigation, styling | **95.8% smaller**, all text kept |
| Spreadsheet | column headers per row, XML per cell | **94.0% smaller** end to end |

**Stage two removes things — but only from what is left, and only when the budget still is not met.**

A 74,000-character log becomes 52,000 losslessly. If the budget is 4,000, the remainder is then reduced by dropping
ordinary lines and **keeping every error and warning** — which is why the combined path fits **1.9× more of the log**
into the same budget than dropping lines from the start would.

---

## The part that matters most

**Every result says whether anything was removed.**

```
[compressed 96,443 → 2,284: json-tables (lossless), log-templates (lossless)]
```
> Nothing was thrown away. Every value is still there, stated differently.

```
[compressed 96,443 → 2,284: log-templates (lossless), template-rows (LOSSY: 1,400 rows dropped)]
```
> Something was thrown away, and it says how much.

Those two are completely different facts, and a compressor that cannot tell you which one you have is a compressor you
cannot trust with a build log.

**And the original is always recoverable:**

```
gistline retrieve dd0fd19eb38f9210    # the whole thing, byte for byte
gistline slice    dd0fd19eb38f9210 --from-line 400 --lines 50
gistline grep     dd0fd19eb38f9210 "AssertionError"
```

That is what makes aggressive compression safe. The 758 dropped test lines are one command away.

---

## Documents

Most content reaching a model does not start as text. gistline reads it and converts to Markdown first, then compresses
the result — and the two stages compound, because a spreadsheet becomes a table and tables are what stage one is best
at.

| Format | What is read |
|---|---|
| **HTML** | headings, lists, tables, links; scripts, styling, navigation and footers discarded |
| **XLSX** | every sheet as a table, with dates as dates rather than serial numbers |
| **DOCX** | headings, lists, tables, footnotes, hyperlinks; tracked deletions excluded |
| **PPTX** | slide titles and body text in presentation order, plus speaker notes |
| **PDF** | text, tables recovered from alignment, running headers stated once |
| **ZIP** | the archive's contents, listed and extractable |

```
gistline --file report.pdf
gistline --file quarterly.xlsx --budget 4000
gistline --file scraped-page.html
```

**It reads for information, not for reconstruction.** The default assumes you want to know what a document says. Fonts,
colours, exact positions and page layout are dropped, and the output says so. If you need to rebuild the document, keep
the original — gistline will not pretend it can give it back.

### What it refuses, and why that is the useful part

```
$ gistline --file scan.pdf
"scan.pdf": PDF 1.4 · 40 page(s) · scanned — no text operators and 40 image draws:
this is a scan and needs OCR. Run it through an OCR tool first and gistline will
compress the result.
```

Every refusal names the format, the reason, and what would fix it:

- **A scanned PDF** needs OCR, which needs a model. gistline stays dependency-free, so it declines and says so.
- **A `.doc`** is a pre-2007 binary container, not a ZIP of XML. Re-save it as `.docx`.
- **An image** cannot be read without OCR — and its token cost is driven by pixel dimensions, so resizing it before
  sending reduces cost directly.
- **An ordinary ZIP** is refused rather than concatenated, because joining forty files produces text that reads
  plausibly and means nothing.
- **A page whose fonts carry no character mapping** is skipped by page number, because the extracted text would be
  glyph ids rather than words.

A converter that always produces *something* produces plausible nonsense on the inputs it cannot handle. Every stage
here can decline, and declining is a successful outcome.

---

## Supported assistants

`gistline install` detects what you have. Name one explicitly with `--platform`, or add `--project` to write into the
repository instead of your user profile.

| Assistant | Command | Mechanism |
|---|---|---|
| Claude Code | `gistline install` | skill + hook |
| Cursor | `gistline install --platform cursor` | always-applied rule |
| Codex | `gistline install --platform codex` | `AGENTS.md` |
| Gemini CLI | `gistline install --platform gemini` | `GEMINI.md` + hook |
| GitHub Copilot CLI | `gistline install --platform copilot` | skill |
| VS Code Copilot Chat | `gistline install --platform vscode` | `copilot-instructions.md` |
| OpenCode | `gistline install --platform opencode` | `AGENTS.md` |
| Aider | `gistline install --platform aider` | `AGENTS.md` |
| Windsurf | `gistline install --platform windsurf` | rule file |
| Kiro IDE/CLI | `gistline install --platform kiro` | skill |
| Kilo Code | `gistline install --platform kilo` | skill |
| CodeBuddy | `gistline install --platform codebuddy` | `CODEBUDDY.md` + hook |
| Factory Droid | `gistline install --platform droid` | `AGENTS.md` |
| OpenClaw | `gistline install --platform claw` | `AGENTS.md` |
| Trae | `gistline install --platform trae` | `AGENTS.md` |
| Trae CN | `gistline install --platform trae-cn` | `AGENTS.md` |
| Hermes | `gistline install --platform hermes` | `AGENTS.md` |
| Kimi Code | `gistline install --platform kimi` | `AGENTS.md` |
| Amp | `gistline install --platform amp` | skill |
| Pi coding agent | `gistline install --platform pi` | skill |
| Devin CLI | `gistline install --platform devin` | skill |
| Google Antigravity | `gistline install --platform antigravity` | rule file |
| Agent Skills (cross-framework) | `gistline install --platform agents` | `.agents/skills/` |

**Shared files are spliced, never overwritten.** `AGENTS.md` belongs to your project — gistline writes a delimited
block and replaces only that block. `gistline uninstall` removes the block and leaves everything else exactly as it
was.

```
gistline status       # which files were written, and which assistants read each one
gistline uninstall    # remove from everything detected
```

---

## Commands

```
gistline [--kind K] [--budget N] [--label L]        compress stdin
gistline --file <path>                              compress a file, converting a document if needed

gistline retrieve <id>                              the original, byte for byte
gistline slice <id> --from-line N --lines M         part of the original
gistline grep <id> <pattern>                        search the original
gistline store-stats                                what the store is holding

gistline install [--platform P] [--project]         register with an assistant
gistline uninstall [--platform P] [--project]       remove
gistline status                                     verify what is registered
gistline platforms                                  list all 23 assistants
```

`--kind` overrides content detection: `test`, `log`, `diff`, `json`, `stacktrace`. Detection is usually right; the flag
exists for when it is not.

`--budget` is a character ceiling, default 4,000. A structured result that cannot be safely cut is allowed to exceed it
rather than be corrupted — **being slightly too large is recoverable, being quietly wrong is not.**

### As an MCP server

```
gistline-mcp
```

Exposes `compress`, `retrieve`, `slice` and `grep` over stdio, for assistants that prefer tool calls to shell pipes.

---

## Zero dependencies is the point

gistline installs nothing. No model, no native module, no runtime pinning. That is not minimalism for its own sake —
it is what makes the tool usable as a build gate:

- **Deterministic.** Rules, not a model. The same input produces byte-identical output on every machine, every run.
- **No warm-up.** Nothing to load, so it is fast enough for a pre-commit hook.
- **Works everywhere Node does.** No CPU feature requirements, no Python version to match.

Tools in this space that use a trained model get better compression on prose and pay for it with a large install, a
warm-up, and results that can differ between machines. gistline makes the opposite trade deliberately.

*Want model-quality compression of prose?* Use a tool built for that. This one is for CI.

---

## How it is tested

**379 tests, and the ones that matter assert what was NOT lost.**

Every lossless transform has a reverse function and a round-trip test, because "lossless" is otherwise an adjective
rather than a claim. The round-trips caught bugs that reading the code did not:

- a newline inside a value split the row
- a numeric-looking string came back as a number
- negative zero lost its sign
- values were transposed, because applying patterns in sequence cannot preserve appearance order
- an encoded `null` vanished entirely

Documented limitations are **tested**, so they cannot quietly change. Table compaction preserves every key and value
but not per-row key order — there is a test asserting exactly that, which will fail if someone makes it
order-preserving without updating the documentation.

```
npm test
```

---

## Requirements

Node 18 or newer. Nothing else.

---

## Releases

Publishing runs from GitHub Actions using **OIDC trusted publishing**, so no npm token is stored in the repository or
in CI. Pushing a `vX.Y.Z` tag triggers the workflow, which runs the full test suite and then publishes with a
**provenance attestation** — a cryptographic link from the published package back to the exact commit and workflow run
that built it.

```
.github/workflows/ci.yml         tests on every push and pull request
.github/workflows/publish.yml    publishes on a version tag, with provenance
```

You can verify any published version came from this repository:

```
npm audit signatures
```

---

## Known limits

Stated here rather than left to be discovered:

- **Logs compress less than JSON** — 29.2% against 67.9%. A timestamp masked as `<ts>` still has to be emitted, so it
  moves rather than shrinks. Column-wise and delta encoding of the values would take this considerably further and are
  not built yet.
- **Prose barely compresses at all.** There is no repeated structure to state once. gistline falls back to keeping the
  start and the end, which works and is blunt.
- **PDF reading order is inferred, not declared.** Single-column pages follow the page. Multi-column order is derived
  from the gutter between columns and is labelled as inferred, because it can be wrong in ways that read perfectly.
- **PDF tables are inferred from alignment**, since a PDF records no table structure at all. Suspected merged cells are
  reported rather than guessed at.
- **No OCR.** A scanned document is refused, not attempted.
- **Extracted text from an untrusted source is untrusted input.** gistline converts and compresses; it does not
  sanitise. A PDF can be built so that extracted text differs from what a human sees on screen, and gistline flags the
  mechanism when it is present but cannot judge intent.

[ROADMAP.md](ROADMAP.md) has what is planned and what is deliberately not.

---

## Contributing

The most useful contribution is a **corpus that compresses badly**. Open an issue with the input and what you expected,
and it becomes a test case.

See [CONTRIBUTING.md](CONTRIBUTING.md). Every lossless transform needs a round-trip test; that is the one rule that
does not bend.

---

## Licence

MIT. See [LICENSE](LICENSE).
