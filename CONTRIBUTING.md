# Contributing

## The most useful contribution

**A corpus that compresses badly.**

Open an issue with the input — a log, a JSON payload, a document — and what you expected. That becomes a benchmark entry,
and a benchmark entry is worth more than a patch, because it tells us where the tool is wrong rather than where someone
thought it might be.

Second most useful: a case where gistline **removed something it should have kept**. That is the failure this project cares
about most, and it is the hardest to find from the inside. Every one found so far was found by a check, not by reading.

## The two rules that do not bend

**Every lossless transform needs a reverse function and a round-trip test.**

Without one, "lossless" is an adjective. With one, it is a checked property. The round-trips here have caught bugs that
reading the code did not: a newline inside a value splitting a row, a numeric-looking string coming back as a number,
negative zero losing its sign, and values transposed because applying patterns in sequence cannot preserve appearance
order.

If a transform cannot preserve all the information, it is not lossless — it belongs on the lossy path, behind a retrieval
id, where the caller can see that something was set aside.

**Anything a reader would search for must survive LITERALLY.**

Not "reconstructible" — present. An error you can only see after running a decoder is not visible to the reader the output
is for. This is why `rank` exists, why interesting lines are kept verbatim even inside a columnar block, and why every
benchmark corpus declares needles that fail the build if lost.

## Setup

```
git clone https://github.com/majidbilal/gistline
cd gistline
npm test
```

There is nothing to install. If `npm test` needs a dependency, something has gone wrong.

## The checks

```
npm test              the whole suite
npm run benchmark     compression AND fidelity on the committed corpus
npm run check-claims  the README's claims against the code
npm run smoke         the packed tarball, installed clean and exercised
```

All four run in CI and before publishing. `npm run benchmark` **fails the build** if any corpus loses a needle, which is
the whole reason it is worth having.

Regenerate the derived files when the code they describe changes:

```
npm run architecture  docs/ARCHITECTURE.md, from the real import graph
npm run hero          docs/hero.svg, from measured numbers
```

## What the code expects of itself

**A transform does one transformation.** It does not decide whether it should run, know the budget, parse, tokenise, format
a note, or call another transform. The pipeline orders and decides; a transform transforms.

**Lossless before lossy, by ordering rather than by rule.** A transform never checks whether it is allowed to run first —
it holds because of where it sits in the list. No individual transform can get the rule wrong, because none applies it.

**Every stage can decline.** A refusal is a normal, successful outcome. A converter that always produces something produces
plausible nonsense on the inputs it cannot handle.

**Say what was dropped, and say it accurately.** The `notes` field exists so a reader's limits reach the person reading the
output. A stale claim is worse than no claim, because a reader believes it — the compression note once said "nothing was
deleted" while a third of the rows had been dropped, and the benchmark caught it.

**Measure rather than predict.** Where a choice depends on data — which encoding is smallest, whether a block is a table or
prose — try them and compare. Heuristics that sound reasonable are wrong on the inputs that matter: "timestamps ascend so
use delta" is true of most logs and larger on one with interleaved sources.

## Comments

Explain **why**, not what. The code says what it does; a comment earns its place by recording the reasoning, the
alternative that was rejected, or the failure that made the current shape necessary.

The most valuable comments here name a bug a test caught. Those are the ones that stop someone reintroducing it.

## Before opening a pull request

- `npm test`, `npm run benchmark`, `npm run check-claims` and `npm run smoke` all pass.
- A new lossless transform has a round-trip test.
- A new format reader has a wiring test proving it is reachable from `ingest`, and a CLI test proving it is reachable from
  the command a person types. Five modules in this project's history were built, tested and never connected — and the CLI
  once printed a raw ZIP archive because every test used the API instead.
- A documented limitation that changed has had its documentation changed with it.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.
