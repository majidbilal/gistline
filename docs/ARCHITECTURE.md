# Architecture

**Generated from the code by `npm run architecture`. Do not edit by hand.**

A hand-written map is accurate the day it is written and misleading a month later, and a misleading map is worse
than none because someone trusts it. This is derived from the real import graph, so it cannot describe a
dependency that does not exist or miss one that does.

What each module *means* lives in its own header comment, next to the code it describes. This answers **where to
look** and **what breaks if I change this**.

## The shape

```
bytes or text in
      |
      v
  core/ingest         detect the format; convert a document to Markdown, or decline with a reason
      |
      v
  core/pipeline       order the transforms and stop as soon as the budget is met
      |
      +--> convert    transforms/html          format changes, text does not
      +--> lossless   transforms/tables        nothing removed
      |               transforms/templates
      +--> lossy      transforms/legacy        something removed, and it says so
      |
      v
  store.mjs           the original, addressable by content hash
```

**The ordering IS the guarantee.** Lossless transforms run before lossy ones because of where they sit in the
list, not because any transform checks. No individual transform can get the rule wrong, because none applies it.

## Size

| | Count |
|---|---|
| Source modules | 34 |
| Source lines | 8,494 |
| Test files | 29 |
| Import edges across the repo | 215 |
| Distinct symbols | 1,055 |
| Runtime dependencies | **0** |
| Node built-ins used | node:assert/strict, node:child_process, node:crypto, node:fs, node:os, node:path, node:test, node:url, node:zlib |

## Entry points

What a caller touches. Everything below is reachable from here and nothing here is imported by the layers below.

| Module | Lines | Imports | Imported by |
|---|---|---|---|
| [`cli.mjs`](../cli.mjs) | 269 | 4 | — |
| [`index.mjs`](../index.mjs) | 415 | 3 | 3 |
| [`install.mjs`](../install.mjs) | 499 | — | 1 |
| [`mcp.mjs`](../mcp.mjs) | 284 | 2 | — |

## core/

Orchestration and shared state. Decides what runs and in what order; transforms nothing itself.

| Module | Lines | Imports | Imported by |
|---|---|---|---|
| [`core/context.mjs`](../core/context.mjs) | 92 | 1 | 1 |
| [`core/doc.mjs`](../core/doc.mjs) | 85 | — | 6 |
| [`core/ingest.mjs`](../core/ingest.mjs) | 281 | 9 | 1 |
| [`core/markdown.mjs`](../core/markdown.mjs) | 157 | 1 | 2 |
| [`core/pipeline.mjs`](../core/pipeline.mjs) | 111 | — | 1 |

## transforms/

One transformation each. A transform never decides whether it should run — the pipeline decides.

| Module | Lines | Imports | Imported by |
|---|---|---|---|
| [`transforms/columnar.mjs`](../transforms/columnar.mjs) | 277 | — | 2 |
| [`transforms/docx.mjs`](../transforms/docx.mjs) | 405 | 2 | 1 |
| [`transforms/html.mjs`](../transforms/html.mjs) | 337 | 3 | 2 |
| [`transforms/legacy.mjs`](../transforms/legacy.mjs) | 125 | 5 | 1 |
| [`transforms/md-tables.mjs`](../transforms/md-tables.mjs) | 283 | 2 | 1 |
| [`transforms/pdf-classify.mjs`](../transforms/pdf-classify.mjs) | 210 | — | 2 |
| [`transforms/pdf-columns.mjs`](../transforms/pdf-columns.mjs) | 182 | — | 1 |
| [`transforms/pdf-running.mjs`](../transforms/pdf-running.mjs) | 204 | — | 1 |
| [`transforms/pdf-tables.mjs`](../transforms/pdf-tables.mjs) | 299 | — | 1 |
| [`transforms/pdf-text.mjs`](../transforms/pdf-text.mjs) | 504 | 3 | 1 |
| [`transforms/pdf.mjs`](../transforms/pdf.mjs) | 240 | 6 | 1 |
| [`transforms/pptx.mjs`](../transforms/pptx.mjs) | 335 | 2 | 1 |
| [`transforms/tables.mjs`](../transforms/tables.mjs) | 47 | 1 | 1 |
| [`transforms/templates.mjs`](../transforms/templates.mjs) | 418 | 4 | 1 |
| [`transforms/xlsx.mjs`](../transforms/xlsx.mjs) | 396 | 2 | 1 |

## util/

Shared primitives with exactly one implementation. Each exists because two consumers needed identical rules and the second derivation got them wrong.

| Module | Lines | Imports | Imported by |
|---|---|---|---|
| [`util/escape.mjs`](../util/escape.mjs) | 143 | — | 3 |
| [`util/lines.mjs`](../util/lines.mjs) | 115 | — | 3 |
| [`util/mask.mjs`](../util/mask.mjs) | 114 | — | 1 |
| [`util/ocr.mjs`](../util/ocr.mjs) | 180 | — | 1 |
| [`util/pdffont.mjs`](../util/pdffont.mjs) | 364 | 1 | 1 |
| [`util/pdfobj.mjs`](../util/pdfobj.mjs) | 411 | — | 3 |
| [`util/unzip.mjs`](../util/unzip.mjs) | 264 | — | 4 |

## Root modules

Long-standing modules that predate the layering and remain at the root because they are part of the published surface.

| Module | Lines | Imports | Imported by |
|---|---|---|---|
| [`lossless.mjs`](../lossless.mjs) | 213 | 1 | 1 |
| [`store.mjs`](../store.mjs) | 125 | — | 2 |

## What breaks if this changes

Modules with the most dependants, highest first. A change here is a change everywhere, so these are the ones
worth a round-trip test and a second read.

| Module | Dependants | Who |
|---|---|---|
| [`core/doc.mjs`](../core/doc.mjs) | **6** | `core/markdown.mjs`, `transforms/docx.mjs`, `transforms/html.mjs`, `transforms/pdf.mjs`, `transforms/pptx.mjs`, `transforms/xlsx.mjs` |
| [`util/unzip.mjs`](../util/unzip.mjs) | **4** | `core/ingest.mjs`, `transforms/docx.mjs`, `transforms/pptx.mjs`, `transforms/xlsx.mjs` |
| [`index.mjs`](../index.mjs) | **3** | `cli.mjs`, `mcp.mjs`, `transforms/legacy.mjs` |
| [`util/escape.mjs`](../util/escape.mjs) | **3** | `lossless.mjs`, `transforms/html.mjs`, `transforms/templates.mjs` |
| [`util/lines.mjs`](../util/lines.mjs) | **3** | `core/context.mjs`, `transforms/md-tables.mjs`, `transforms/templates.mjs` |
| [`util/pdfobj.mjs`](../util/pdfobj.mjs) | **3** | `transforms/pdf-text.mjs`, `transforms/pdf.mjs`, `util/pdffont.mjs` |
| [`core/markdown.mjs`](../core/markdown.mjs) | **2** | `core/ingest.mjs`, `transforms/html.mjs` |
| [`store.mjs`](../store.mjs) | **2** | `cli.mjs`, `mcp.mjs` |
| [`transforms/columnar.mjs`](../transforms/columnar.mjs) | **2** | `transforms/md-tables.mjs`, `transforms/templates.mjs` |
| [`transforms/html.mjs`](../transforms/html.mjs) | **2** | `core/ingest.mjs`, `transforms/legacy.mjs` |

## Health

Checked by symbolmap on every regeneration. These are the three failures this codebase has actually produced.

**Broken relative imports:** none

**Import cycles:** none

**Unimported modules:**

```
1 unimported module(s) that do not look like entry points:
  mcp.mjs
```

`mcp.mjs` is expected here: it is a declared `bin` entry point, so nothing imports it. Anything *else* appearing
in that list is the failure this project produced four times — a module built, tested, and never connected to
anything, passing its own tests while doing nothing in the real path.

## Finding things

```
symbolmap where <symbol>        where it is declared
symbolmap uses <symbol>         who uses it
symbolmap blast <file>          everything that could break if it changes
symbolmap deps <file>           what it imports
symbolmap orphans              modules nobody imports
symbolmap unused-exports       exports nothing in the repo uses
```

Faster than grep and it excludes comments and strings, so `uses` returns call sites rather than mentions.

## Where everything lives

```
core/          orchestration: ingest, pipeline, context, document model, Markdown writer
transforms/    one transformation each, plus the format readers
util/          shared primitives: escaping, lines, masking, ZIP, PDF objects, PDF fonts
scripts/       demos, the claim checker, the installed-package smoke test, generators
docs/          hero.svg, this file
docs/internal/ working plans — gitignored, never published
```

Tests sit beside the module they test: `core/pipeline.mjs` has `core/pipeline.test.mjs`.

---

*34 source modules · regenerate with `npm run architecture`*
