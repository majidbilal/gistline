# Roadmap

What works now, what's coming, and what deliberately isn't. No dates — this is maintained honestly
rather than optimistically.

Got a use case that isn't covered? [Open an issue](https://github.com/majidbilal/gistline/issues) —
real problems get prioritised over speculative features.

---

## Working now (0.2.x)

| | |
|---|---|
| **Test output** | Keeps failures and their error detail plus the final score; drops passing lines. This is the strongest case — measured at 98% smaller on a real 605-test run. |
| **Stack traces** | Keeps your code's frames; drops `node_modules` and Node internals. |
| **JSON** | Keeps the shape (which fields exist, how long arrays are) and shortens values. Output stays valid JSON. |
| **Diffs** | Keeps file headers and changed lines; drops unchanged context. |
| **Logs** | Keeps lines mentioning errors **wherever they are** in the file, not just at the ends. |
| **Anything else** | Falls back to keeping the start and the end. |
| **Retrieval** | `--store` keeps the original; `grep`, `slice` and `retrieve` pull back anything dropped. |
| **Budgets** | By characters, or by estimated tokens with `--max-tokens`. Never exceeded. |
| **MCP server** | Four tools your AI assistant can call directly. Stateless. |

---

## Coming next

### Lossless-first compression

Today gistline decides what to keep and drops the rest. A large amount of what makes output big is not extra
information — it is the same shape repeated. An array of 200 records repeats its field names 200 times; a log repeats
the same handful of message formats thousands of times.

So before anything is dropped, gistline will try to state the repetition once:

- **Tables** — an array of like-shaped records becomes a header and rows. Measured at **67.9% smaller with nothing
  removed** on a 300-record API response.
- **Log formats** — each repeated message format stated once, then only the parts that vary. Measured at **29.2%
  smaller with nothing removed**, and expected to improve considerably once timestamps are stored as differences
  rather than repeated in full.

Anything dropped afterwards is dropped from a much smaller starting point, and the report says which stages were
lossless and which were not — so you can tell "nothing was removed" from "1,400 lines were dropped".

### Reading documents

Most content that reaches a model does not start as text. It arrives as a spreadsheet, a Word document, a slide deck,
a scraped page or a PDF, and those formats spend a great many tokens on structure that carries no meaning.

gistline will convert what it can read to Markdown first, then compress it — and the two stages compound, because a
spreadsheet becomes a table and tables are what the lossless stage is best at.

Planned, in this order:

| Format | Intent |
|---|---|
| **HTML** | strip boilerplate, keep headings, lists, tables and links |
| **ZIP** | read archives, which is also what the next three need |
| **XLSX** | sheets to Markdown tables |
| **DOCX** | headings, paragraphs, lists, tables |
| **PPTX** | slide titles and body text |
| **Images** | report what an image will cost in tokens, and when a smaller version would cost less for no loss |
| **PDF** | best effort on text, and an honest refusal otherwise |

**Two commitments about this, because they matter more than the feature list:**

**Every stage can decline.** A converter that always produces something produces plausible nonsense on the inputs it
cannot handle. If gistline cannot read a file properly — a scanned PDF, an encrypted document, a layout it cannot
follow — it will say so rather than emit text that looks right and is not.

**No OCR, and no new dependencies.** Reading images requires a model, and gistline stays dependency-free. For scanned
documents, use a dedicated converter; gistline will compress what that converter gives it.

### Better handling of ordinary text
**This is the honest weak spot today.** If your content has no errors and no structure — plain prose,
a CSV export, an `npm install` log — there's nothing for gistline to latch onto, so it
falls back to keeping the start and end. That works, but it's blunt.

Planned: strategies that understand **CSV/TSV** (keep the header and a representative sample),
**install logs** (keep what changed and what warned), and **prose** (keep opening, closing, and the
parts that carry information).

*HTML and XML moved to "Reading documents" above, where they belong — they are a conversion problem
before they are a compression one.*

### More accurate token counts
Token estimates are currently one formula for all content. Since gistline already detects *what kind*
of content it's looking at, and code costs far more tokens per character than prose, using that
knowledge is free accuracy. You'll also be able to supply your own counter if you have a real
tokenizer to hand.

### Streaming for very large inputs
Right now the whole input is read into memory. Fine for a test log; wrong for a multi-gigabyte file.

### Optional AI summarising
For genuinely narrative text, pattern matching can only do so much. A model could summarise properly.
This will be **opt-in** and will never become a requirement — the offline, deterministic, zero-cost
path stays exactly as it is.

### Published benchmarks
The 98% figure is one favourable case on one project. Before claiming more, it needs measuring across
content types and published so you can check it yourself.

---

## Not planned, and why

Saying no clearly is more useful than a vague maybe.

**A real tokenizer bundled in.** Accurate token counting needs a vocabulary file of a megabyte or
more, which means a dependency and a download. gistline's zero-dependency guarantee is worth more
than the last few percent of counting accuracy — so estimates stay estimates, and say so.

**Summarising your conversation history or RAG results.** gistline compresses *tool output*. Those
are different problems with different tradeoffs, and a tool that does everything does nothing well.

**Rewriting or "fixing" your output.** It shortens and it retrieves. It never edits.

---

## How versions work

`0.x` means the API may still change between minor versions, though breaking changes will be called
out in the release notes. Anything published is tested on Linux, macOS and Windows across Node 18, 20
and 22, and every release carries a [provenance
attestation](https://docs.npmjs.com/generating-provenance-statements) — cryptographic proof of which
commit and workflow built it.
