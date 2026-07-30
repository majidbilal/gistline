# gistline

[![npm](https://img.shields.io/npm/v/gistline)](https://www.npmjs.com/package/gistline)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![license](https://img.shields.io/npm/l/gistline)](./LICENSE)
[![CI](https://github.com/majidbilal/gistline/actions/workflows/ci.yml/badge.svg)](https://github.com/majidbilal/gistline/actions/workflows/ci.yml)

**Keep the gist of large output.** Structure-aware compression for AI agents and CI logs.
Zero dependencies, pure functions, Node ≥18.

```bash
npx gistline --help        # no install needed
npm i gistline             # as a library
npm i -g gistline          # as a command
```

**Measured:** a real 605-test suite, `96,443 → 2,284` characters. **98% smaller, failure intact.**

## The problem

Truncation keeps the wrong part. A 40,000-line test run ends with a summary and contains one
failure — keep the first 4,000 characters and you get neither. Large tool output is the main way an
AI agent's context gets exhausted, crowding out the task itself.

## The idea

Compression should understand what it is compressing:

| Output | What gistline keeps | What it drops |
|---|---|---|
| **test runs** | failures + their diagnostic block + the summary | passing lines, TAP subtest announcements |
| **diffs** | file headers + changed lines | unchanged context |
| **JSON** | parseable *shape*: keys, types, array lengths | sampled array items, long string tails |
| **stack traces** | the message + your frames | `node:internal` and `node_modules` frames |
| **logs / listings** | salient lines by **content, not position** | routine progress noise |

Anything unrecognised falls back to a head-and-tail keep — the cause is usually at the start and the
result at the end.

## Retrieval is real, not reassuring

Most compressors tell you "nothing was lost". gistline can prove it. Pass a store and the original is
kept, content-addressed, and the note carries an id:

```bash
npm test 2>&1 | npx gistline --store --label "npm test"
# [npm test output compressed: 102654 → 133 chars.
#  Full output retained as id dd0fd19eb38f9210 — retrieve, slice, or grep it for any dropped detail.]

npx gistline retrieve dd0fd19eb38f9210
npx gistline slice   dd0fd19eb38f9210 --from-line 4300 --lines 40
npx gistline grep    dd0fd19eb38f9210 "FATAL"
npx gistline store-stats
```

`slice` and `grep` matter more than `retrieve` in practice: after reading a summary you usually want
*one specific region*, not the whole 100k characters back.

Without a store, the note promises only what it can deliver — it never claims a retrieval it cannot
honour. A store that fails to write degrades to that same honest note rather than breaking the run.

## Token budgets

Characters are a convenient proxy but they misprice code, where punctuation and short identifiers each
cost a token. `--max-tokens` budgets in estimated tokens instead:

```bash
npx gistline --max-tokens 500 < build.log
```

`estimateTokens()` costs words by length and symbols individually, so it tracks code far better than
`chars / 4`. It is an **estimate** — a real BPE tokenizer would mean shipping a vocabulary file and a
dependency. Good enough to budget with; not for billing.

## CLI

```bash
npm test 2>&1 | npx gistline
npx gistline --budget 2000 --label build < build.log
npx gistline --kind test --stats < run.log
npx gistline --json < payload.json
```

| Option | Meaning |
|---|---|
| `--budget <chars>` | character budget (default 4000) |
| `--kind <kind>` | force `test` \| `diff` \| `json` \| `stacktrace` \| `listing` \| `log` |
| `--label <name>` | what produced the output (appears in the note) |
| `--file <path>` | read a file instead of stdin |
| `--stats` | one-line summary to stderr |
| `--json` | emit the full result object |

## Library

```js
import { gist, makeGistStats, formatGistStats } from "gistline";

const res = gist(hugeTestLog, { budget: 4000, label: "npm test" });
res.text;            // the compressed output, with a leading note
res.ratio;           // 0.024
res.kind;            // "test"
res.originalChars;   // 96443
res.compressedChars; // 2284

// Prove it is engaging, rather than assuming
const stats = makeGistStats();
stats.record(res);
formatGistStats(stats.snapshot());
// "gistline: 1/1 outputs compressed, 94,159 chars saved (98% smaller)"
```

Individual strategies are exported too (`compressTest`, `compressDiff`, `compressJson`,
`compressStacktrace`, `compressLog`, `headTail`, `detectKind`) if you want to compose your own.

## Measured

Run against a real 512-test Node suite: **96,443 chars → 2,284 (98% smaller)**, with the failure
diagnostics and the `# pass / # fail` summary intact.

## Design rules

- **Pure.** No filesystem, no network, no clock, no model call. Same input, same output.
- **Never exceeds the budget.** Every strategy is clamped.
- **Never silently lossy.** Each result states what was dropped and that retrieval is possible.
- **Zero dependencies.** Nothing to audit, nothing to break.

## License

MIT
