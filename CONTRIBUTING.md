# Contributing

## The most useful contribution

**A corpus that compresses badly.**

Open an issue with the input — a log, a JSON payload, a document — and what you expected. That becomes a test case, and
a test case is worth more than a patch, because it tells us where the tool is wrong rather than where someone thought it
might be.

Second most useful: a case where gistline **removed something it should have kept**. That is the failure this project
cares about most, and it is the hardest to find from the inside.

## The one rule that does not bend

**Every lossless transform needs a reverse function and a round-trip test.**

Without one, "lossless" is an adjective. With one, it is a checked property. The round-trips in this repository have
caught bugs that reading the code did not: a newline inside a value splitting a row, a numeric-looking string coming
back as a number, negative zero losing its sign, and values transposed because applying patterns in sequence cannot
preserve appearance order.

If a transform cannot preserve all the information, it is not lossless — it belongs on the lossy path, behind a
retrieval id, where the caller can see that something was set aside.

## Setup

```
git clone https://github.com/<owner>/gistline
cd gistline
npm test
```

There is nothing to install. If `npm test` needs a dependency, something has gone wrong.

## Running the tests

```
npm test                                            the whole suite
node --test transforms/pdf-text.test.mjs            one file
node --test *.test.mjs util/*.test.mjs core/*.test.mjs transforms/*.test.mjs
```

## What the code expects of itself

**A transform does one transformation.** It does not decide whether it should run, know the budget, parse, tokenise,
format a note, or call another transform. The pipeline orders and decides; a transform transforms. That is what keeps it
testable in isolation and reusable in a different order.

**Lossless before lossy, by ordering rather than by rule.** A transform never checks whether it is allowed to run first
— it holds because of where it sits in the list. No individual transform can get the rule wrong, because no individual
transform applies it.

**Every stage can decline.** A refusal is a normal, successful outcome. A converter that always produces something
produces plausible nonsense on the inputs it cannot handle.

**Say what was dropped.** The `notes` field exists so a reader's limits reach the person reading the output rather than
staying in a comment. A stale claim in the output is worse than no claim, because a reader believes it.

## Comments

Explain **why**, not what. The code says what it does; a comment earns its place by recording the reasoning, the
alternative that was rejected, or the failure that made the current shape necessary.

The most valuable comments in this repository name a bug a test caught. Those are the ones that stop someone
reintroducing it.

## Before opening a pull request

- `npm test` passes.
- A new lossless transform has a round-trip test.
- A new format reader has a wiring test proving it is reachable from `ingest`. Four modules in this project's history
  were built, tested, and never connected to anything — each passed its own tests while doing nothing in the real path.
- A documented limitation that changed has had its documentation changed with it.

## Reporting a security issue

See [SECURITY.md](SECURITY.md). Please do not open a public issue for a vulnerability.
