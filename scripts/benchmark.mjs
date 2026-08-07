// The benchmark harness.
//
// ONE RESPONSIBILITY: measure compression AND fidelity on a committed corpus, and write BENCHMARKS.md from the result.
//
// WHY FIDELITY IS THE POINT. A 100% saving that drops the one failing test is a bug, not a win — and a benchmark reporting
// only ratios cannot tell those apart. So every corpus entry carries NEEDLES: the failing assertion, the error line, the
// value someone would grep for. A row is only a pass if every needle survived.
//
// AND WHY THE BAD CASES ARE INCLUDED. A benchmark showing only wins is marketing. Prose compresses by nothing here, and that
// row stays in the table.
import { writeFileSync } from "node:fs";
import { gist } from "../index.mjs";
import { TRANSFORMS } from "../transforms/legacy.mjs";

const BUDGET = 4000;

/**
 * The corpus.
 *
 * Generated rather than committed as files, so it is reproducible from source and reviewable in a diff. Each entry declares
 * the needles that MUST survive — chosen as the things a person would actually search the output for.
 */
const CORPUS = [
  {
    name: "Test suite, one failure",
    kind: "test",
    needles: ["not ok 601", "AssertionError", "# fail 1"],
    build: () => `${Array.from({ length: 600 }, (i0, i) => `ok ${i + 1} - passing check ${i + 1}`).join("\n")}\n`
      + "not ok 601 - AssertionError: expected 200 to equal 500\n"
      + "  at Object.<anonymous> (/app/test/api.test.mjs:42:3)\n"
      + "# tests 601\n# pass 600\n# fail 1\n",
  },
  {
    name: "Build log, six formats",
    kind: "log",
    needles: ["disk full", "ERROR"],
    build: () => `${Array.from({ length: 1200 }, (i0, i) => {
      const ts = new Date(Date.UTC(2026, 7, 3, 14, 0, 0) + i * 3000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const k = i % 6;
      if (k === 0) return `${ts} INFO  [worker-${i % 8}] processed ${i} records in ${(i % 40) / 10}s`;
      if (k === 1) return `${ts} DEBUG cache hit ratio ${i % 100}% after ${i} lookups`;
      if (k === 2) return `${ts} INFO  GET /api/users/${i} 200 ${i % 50}ms`;
      if (k === 3) return `${ts} DEBUG wrote /var/log/app/chunk-${i}.bin`;
      if (k === 4) return `${ts} INFO  compiled module ${i} of 1200`;
      return `${ts} DEBUG heartbeat ${i}`;
    }).join("\n")}\n2026-08-03T15:00:00Z ERROR failed to flush: disk full\n`,
  },
  {
    name: "JSON API response, 300 records",
    kind: "json",
    needles: ["person-300", "p299@example.com"],
    build: () => JSON.stringify({
      status: "ok",
      total: 300,
      data: Array.from({ length: 300 }, (i0, i) => ({
        id: i + 1, name: `person-${i + 1}`, email: `p${i}@example.com`,
        role: i % 2 ? "admin" : "user", active: i % 3 !== 0, createdAt: `2026-08-0${(i % 9) + 1}`,
      })),
    }, null, 2),
  },
  {
    name: "Stack trace, 300 frames",
    kind: "stacktrace",
    needles: ["TypeError", "is not a function"],
    build: () => `TypeError: handler is not a function\n${
      Array.from({ length: 300 }, (i0, i) => `    at frame${i} (/app/src/module${i}.mjs:${i + 1}:9)`).join("\n")}\n`,
  },
  {
    name: "Unified diff, 500 lines",
    kind: "diff",
    /**
     * The needles are the things a reader searches a diff for: WHICH FILE changed, and the markers that say a change
     * happened. Not an arbitrary interior line.
     *
     * My first attempt used `removed 0` — line 4 of 503 — and it failed. That was a bad needle, not a bug: with 500
     * near-identical lines, no compressor can promise any particular one, and demanding it would mean demanding no
     * compression at all. A needle has to be something whose loss would actually matter.
     */
    needles: ["diff --git", "src/index.mjs"],
    build: () => `diff --git a/src/index.mjs b/src/index.mjs\n--- a/src/index.mjs\n+++ b/src/index.mjs\n${
      Array.from({ length: 500 }, (i0, i) => (i % 3 ? `+added line ${i}` : `-removed ${i}`)).join("\n")}\n`,
  },
  {
    name: "Scraped HTML article",
    kind: null,
    needles: ["Passkeys and recovery", "the full guide"],
    build: () => `<!DOCTYPE html><html><head><title>x</title><style>${".cls{margin:0;padding:0}".repeat(300)}</style>`
      + `<script>${"trackEvent({a:1});".repeat(300)}</script></head><body><nav>Home About Contact</nav>`
      + `<main><article><h1>Passkeys and recovery</h1>${
        Array.from({ length: 40 }, (i0, i) => `<p>Paragraph ${i} explaining recovery in some detail.</p>`).join("")}`
      + `<p>See <a href="https://example.com/guide">the full guide</a>.</p></article></main>`
      + `<footer>Copyright 2026</footer></body></html>`,
  },
  {
    /**
     * The case gistline does BADLY, kept deliberately.
     *
     * Prose has no repeated structure to state once, so there is nothing to compact losslessly and the fallback is blunt. A
     * benchmark showing only wins is marketing.
     */
    name: "Plain prose (gistline does badly)",
    kind: null,
    needles: ["Sentence 1 ", "Sentence 400 "],
    build: () => Array.from({ length: 400 }, (i0, i) =>
      `Sentence ${i + 1} carries a distinct thought with no repeated shape whatsoever.`).join(" "),
  },
  {
    name: "CSV export, 400 rows",
    kind: null,
    /**
     * The needles are the header and a value from EVERY category, because a truncated listing must still show what kinds of
     * thing are in it.
     *
     * `1399` — the last row's value — was in the first version and failed. That was a bad needle: 400 rows cannot fit a
     * 4,000-character budget, so no particular row can be promised. But `region-3` failing WAS a real bug: every region-3 row
     * shared one template, and the lossy step filled the budget from one group at a time, so an entire category vanished
     * while another kept a hundred rows. Fixed by sampling round-robin across templates.
     */
    needles: ["region,rep,units", "region-0", "region-1", "region-2", "region-3"],
    build: () => `region,rep,units,revenue,role,closed\n${
      Array.from({ length: 400 }, (i0, i) =>
        `region-${i % 4},rep-${i + 1},${1000 + i},${(500 + i * 2.5).toFixed(2)},${i % 2 ? "admin" : "user"},2026-08-03`).join("\n")}\n`,
  },
];

const pct = (a, b) => ((a - b) / a) * 100;
const n = (x) => x.toLocaleString("en-GB");

const rows = [];
let failures = 0;

for (const entry of CORPUS) {
  const input = entry.build();
  const started = process.hrtime.bigint();
  const r = gist(input, { kind: entry.kind, budget: BUDGET, label: entry.name, transforms: TRANSFORMS });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  // FIDELITY: every needle must be literally present in the output. Not "reconstructible" — present, because an error you can
  // only see after running a decoder is not visible to the reader the output is for.
  const missing = entry.needles.filter((needle) => !r.text.includes(needle));
  if (missing.length) failures += 1;

  rows.push({
    name: entry.name,
    before: input.length,
    after: r.compressedChars,
    saved: pct(input.length, r.compressedChars),
    lossy: r.lossy,
    transforms: r.applied.filter((a) => a.applied).map((a) => a.id),
    ms,
    needles: entry.needles.length,
    missing,
  });
}

// --- the table --------------------------------------------------------------------------------------------

const md = [];
md.push("# Benchmarks");
md.push("");
md.push("**Generated by `npm run benchmark`. Do not edit by hand.**");
md.push("");
md.push("Every figure here is produced by running the tool on a corpus generated from source, so it is reproducible on any");
md.push("machine and reviewable in a diff. The corpus is in [`scripts/benchmark.mjs`](scripts/benchmark.mjs).");
md.push("");
md.push("## Fidelity is the measurement that matters");
md.push("");
md.push("**A 100% saving that drops the one failing test is a bug, not a win** — and a benchmark reporting only ratios cannot");
md.push("tell those apart. So every corpus entry declares **needles**: the failing assertion, the error line, the value someone");
md.push("would actually grep for. A row passes only if every needle is still **literally present** in the output.");
md.push("");
md.push("Not \"reconstructible\" — present. An error you can only see after running a decoder is not visible to the reader the");
md.push("output is for.");
md.push("");
md.push(`Budget: ${n(BUDGET)} characters. Node ${process.version} on ${process.platform}.`);
md.push("");
md.push("| Corpus | Before | After | Saved | Removed anything? | Needles kept | Transforms |");
md.push("|---|---|---|---|---|---|---|");

for (const r of rows) {
  const needles = r.missing.length ? `**${r.needles - r.missing.length}/${r.needles} — FAILED**` : `${r.needles}/${r.needles}`;
  md.push(`| ${r.name} | ${n(r.before)} | ${n(r.after)} | ${r.saved.toFixed(1)}% | ${r.lossy ? "yes" : "**no**"} `
    + `| ${needles} | ${r.transforms.join(", ") || "none" } |`);
}

md.push("");
md.push(`**${rows.length - failures} of ${rows.length} corpora kept every needle.**`);
md.push("");

// --- what the table shows, said plainly --------------------------------------------------------------------

const lossless = rows.filter((r) => !r.lossy);
const worst = [...rows].sort((a, b) => a.saved - b.saved)[0];
const best = [...rows].sort((a, b) => b.saved - a.saved)[0];

md.push("## Reading this honestly");
md.push("");
md.push(`**Best case:** ${best.name} at ${best.saved.toFixed(1)}%.`);
md.push("");
md.push(`**Worst case:** ${worst.name} at ${worst.saved.toFixed(1)}%. That row is kept deliberately — prose has no repeated`);
md.push("structure to state once, so there is nothing to compact losslessly and the fallback is blunt. A benchmark showing only");
md.push("wins is marketing.");
md.push("");
md.push(`**${lossless.length} of ${rows.length} corpora were compressed with nothing removed at all**, which is the column worth`);
md.push("reading first. A lossless result means every value is still there, stated differently.");
md.push("");
md.push("Where something *was* removed, the original remains retrievable by id — so the saving is safe rather than final.");
md.push("");
md.push("## Timing");
md.push("");
md.push("| Corpus | Time |");
md.push("|---|---|");
for (const r of rows) md.push(`| ${r.name} | ${r.ms.toFixed(1)}ms |`);
md.push("");
md.push("Deterministic and dependency-free: no model to load, no warm-up, and the same input produces byte-identical output on");
md.push("every run. That is what makes it usable in a pre-commit hook.");
md.push("");
md.push("## What is not measured here");
md.push("");
md.push("- **Token counts.** Characters are a proxy. A real tokeniser would be exact and would be a dependency.");
md.push("- **Comparison against other tools.** Their corpora and budgets differ, and a table built to flatter one tool is worth");
md.push("  nothing. Run `npm run benchmark` on your own content instead.");
md.push("- **Very large inputs.** Everything is read into memory; streaming is on the roadmap.");
md.push("");
md.push(`*Regenerate with \`npm run benchmark\`.*`);

writeFileSync("BENCHMARKS.md", `${md.join("\n")}\n`, "utf8");

// --- console summary --------------------------------------------------------------------------------------

console.log(`benchmark: ${rows.length} corpora, budget ${n(BUDGET)}\n`);
for (const r of rows) {
  const flag = r.missing.length ? `NEEDLES LOST: ${r.missing.join(", ")}` : "needles kept";
  console.log(`  ${r.name.padEnd(34)} ${String(n(r.before)).padStart(7)} -> ${String(n(r.after)).padStart(6)}`
    + `  ${r.saved.toFixed(1).padStart(5)}%  lossy=${String(r.lossy).padEnd(5)} ${flag}`);
}
console.log(`\nwrote BENCHMARKS.md`);

// A lost needle is a FAILURE, not a note. This runs in CI, so it must be able to fail the build.
if (failures) {
  console.error(`\n${failures} corpus/corpora LOST a needle. That is a bug, not a compression result.`);
  process.exit(1);
}
