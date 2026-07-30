#!/usr/bin/env node
// gistline CLI — pipe anything in, get the gist out.
//
//   npm test 2>&1 | npx gistline
//   npx gistline --budget 2000 --label "build" < build.log
//   npx gistline --kind test --stats < run.log
//
// Exit codes: 0 always on successful processing (this is a filter, not a gate), 2 on bad usage.

import { readFileSync } from "node:fs";
import { gist, makeGistStats, formatGistStats, estimateTokens, DEFAULT_BUDGET } from "./index.mjs";
import { openStore, DEFAULT_STORE_DIR } from "./store.mjs";

const argv = process.argv.slice(2);

function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? fallback : fallback;
}
const has = (name) => argv.includes(`--${name}`);

// --- retrieval subcommands: what makes the compression note honest -------------------------------
const sub = argv[0];
if (["retrieve", "slice", "grep", "store-stats"].includes(sub)) {
  const store = openStore({ dir: flag("store", DEFAULT_STORE_DIR) });
  const id = argv[1];

  if (sub === "store-stats") {
    const s = store.stats();
    console.log(`gistline store: ${s.entries} originals, ${s.chars.toLocaleString()} chars at ${store.dir}`);
    process.exit(0);
  }
  if (!id) { console.error(`gistline: ${sub} needs an id. See --help.`); process.exit(2); }

  let out = null;
  if (sub === "retrieve") out = store.get(id);
  else if (sub === "slice") out = store.slice(id, { fromLine: Number(flag("from-line", 1)), lines: Number(flag("lines", 200)) });
  else {
    const pattern = argv[2];
    if (!pattern) { console.error("gistline: grep needs a pattern."); process.exit(2); }
    const hits = store.grep(id, pattern, { max: Number(flag("max", 100)) });
    out = hits === null ? null : hits.map((h) => `${h.line}: ${h.text}`).join("\n");
  }

  if (out === null) { console.error(`gistline: no original held for id "${id}".`); process.exit(1); }
  process.stdout.write(`${out}\n`);
  process.exit(0);
}

if (has("help") || has("h")) {
  console.log(`gistline — keep the gist of large output

USAGE
  <command> 2>&1 | gistline [options]
  gistline [options] < file
  gistline [options] --file <path>

OPTIONS
  --budget <chars>   character budget (default ${DEFAULT_BUDGET})
  --max-tokens <n>   token budget instead of characters (takes precedence)
  --kind <kind>      force a strategy: test | diff | json | stacktrace | listing | log
  --label <name>     what produced this output (appears in the note)
  --file <path>      read from a file instead of stdin
  --store [dir]      KEEP the original so it can be retrieved later (prints an id in the note)
  --stats            print a one-line summary to stderr
  --json             emit the full result object as JSON instead of text
  --help             this message

RETRIEVAL (needs --store on the original run)
  gistline retrieve <id>                       print the full original
  gistline slice <id> --from-line 4300 --lines 40
  gistline grep <id> "FATAL" [--max 100]
  gistline store-stats

WHY
  Truncating output keeps the wrong part. gistline is structure-aware: it keeps test
  failures, preserves JSON shape, keeps your stack frames and drops library noise, and
  prioritises salient log lines by content rather than position.`);
  process.exit(0);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const file = flag("file");
let input = "";
try {
  input = file ? readFileSync(file, "utf8") : await readStdin();
} catch (e) {
  console.error(`gistline: cannot read input: ${e.message}`);
  process.exit(2);
}

if (!input) {
  console.error("gistline: no input. Pipe something in, or pass --file <path>. See --help.");
  process.exit(2);
}

const budget = Number(flag("budget", DEFAULT_BUDGET));
if (!Number.isFinite(budget) || budget < 100) {
  console.error("gistline: --budget must be a number >= 100");
  process.exit(2);
}

const result = gist(input, {
  budget,
  maxTokens: flag("max-tokens") ? Number(flag("max-tokens")) : null,
  kind: flag("kind"),
  label: flag("label", "") ?? "",
  // `--store` with no value falls back to the default directory.
  store: has("store") ? openStore({ dir: (flag("store") ?? "").startsWith("--") ? DEFAULT_STORE_DIR : flag("store") ?? DEFAULT_STORE_DIR }) : null,
});

if (has("json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`${result.text}\n`);
}

if (has("stats")) {
  const stats = makeGistStats();
  stats.record(result);
  process.stderr.write(`${formatGistStats(stats.snapshot())}\n`);
}
