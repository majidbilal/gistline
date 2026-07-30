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

### Better handling of ordinary text
**This is the honest weak spot today.** If your content has no errors and no structure — plain prose,
a CSV export, an HTML page, an `npm install` log — there's nothing for gistline to latch onto, so it
falls back to keeping the start and end. That works, but it's blunt.

Planned: strategies that understand **CSV/TSV** (keep the header and a representative sample),
**HTML/XML** (keep structure, drop boilerplate), **install logs** (keep what changed and what
warned), and **prose** (keep opening, closing, and the parts that carry information).

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
