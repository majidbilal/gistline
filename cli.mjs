#!/usr/bin/env node
// gistline CLI — pipe anything in, get the gist out.
//
//   npm test 2>&1 | npx gistline
//   npx gistline --budget 2000 --label "build" < build.log
//   npx gistline --kind test --stats < run.log
//
// Exit codes: 0 always on successful processing (this is a filter, not a gate), 2 on bad usage.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { gist, gistFile, makeGistStats, formatGistStats, estimateTokens, DEFAULT_BUDGET } from "./index.mjs";
import { openStore, DEFAULT_STORE_DIR } from "./store.mjs";
// The wired transform list, so the CLI gets lossless-first compression and document conversion rather than the bare
// single-strategy path. Without this the CLI silently used a different pipeline from every other entry point.
import { TRANSFORMS } from "./transforms/legacy.mjs";

const argv = process.argv.slice(2);

function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] ?? fallback : fallback;
}
const has = (name) => argv.includes(`--${name}`);

// --- retrieval subcommands: what makes the compression note honest -------------------------------
const sub = argv[0];

/**
 * Registration subcommands.
 *
 * Placed before the retrieval block because `install` is the first command most people run, and because a subcommand that
 * writes files should be impossible to reach by accident from a piping path.
 */
if (["install", "uninstall", "status", "platforms"].includes(sub)) {
  const { PLATFORMS, findPlatform, installPlatform, uninstallPlatform, detect, status, installHook, uninstallHook } = await import("./install.mjs");
  const project = argv.includes("--project");
  const dryRun = argv.includes("--dry-run");
  // Hooks write to a settings file, which is a bigger intrusion than a skill file. `--no-hooks` opts out without losing
  // the instruction, for anyone who would rather keep their own settings untouched.
  const noHooks = argv.includes("--no-hooks");
  const named = flag("platform", null);

  if (sub === "platforms") {
    console.log(`gistline supports ${PLATFORMS.length} assistants.\n`);
    const width = Math.max(...PLATFORMS.map((p) => p.label.length));
    for (const p of PLATFORMS) {
      const scopes = [p.user ? "user" : null, p.project ? "project" : null].filter(Boolean).join(", ");
      console.log(`  ${p.label.padEnd(width)}  --platform ${p.id.padEnd(12)} ${p.kind.padEnd(12)} (${scopes})`);
    }
    console.log("\n  gistline install                      register with whatever is detected");
    console.log("  gistline install --platform cursor    a specific assistant");
    console.log("  gistline install --project            write into this repository instead of your profile");
    process.exit(0);
  }

  if (sub === "status") {
    const rows = status();
    if (!rows.length) {
      console.log("gistline is not registered with any assistant. Run: gistline install");
      process.exit(0);
    }
    console.log(`gistline is registered in ${rows.length} file(s):\n`);
    for (const r of rows) {
      console.log(`  ${r.path}`);
      console.log(`    ${r.scope}-scoped ${r.kind}, read by: ${r.platforms.join(", ")}`);
    }
    process.exit(0);
  }

  // Which platforms to act on: the one named, or everything detected.
  let targets;
  if (named) {
    try { targets = [findPlatform(named)]; }
    catch (e) { console.error(`gistline: ${e.message}`); process.exit(2); }
  } else {
    targets = detect();
    if (!targets.length) {
      console.error("gistline: no AI assistant detected. Name one explicitly:\n  gistline install --platform claude");
      console.error("  gistline platforms          to see all supported assistants");
      process.exit(2);
    }
  }

  const act = sub === "install" ? installPlatform : uninstallPlatform;
  const hookAct = sub === "install" ? installHook : uninstallHook;
  let done = 0;

  for (const p of targets) {
    // Try the requested scope, and fall back to the other one when a platform supports only that. A platform with no
    // project location should not silently do nothing when `--project` is passed.
    let r = act(p, { project, dryRun });
    if (!r.ok) r = act(p, { project: !project, dryRun });

    if (r.ok) {
      done += 1;
      console.log(`  ${r.action ?? "wrote"} ${r.path}${r.shared ? "  (shared file — only gistline's block was touched)" : ""}`);
    } else {
      console.log(`  skipped ${p.label}: ${r.reason}`);
    }

    /**
     * The hook, where the platform supports one.
     *
     * A separate step because it can fail independently: an unparseable `settings.json` must not cost the instruction file
     * that already installed successfully. So a hook failure is reported and the install still counts as done.
     */
    if (p.hooks && !noHooks) {
      const h = hookAct(p.id, { project, dryRun });
      if (h.ok) console.log(`  ${sub === "install" ? "hooked" : "unhooked"} ${h.path}  (${h.event})`);
      else console.log(`  no hook for ${p.label}: ${h.reason}`);
    }
  }

  if (sub === "install" && done) {
    console.log(`\ngistline registered with ${done} location(s)${dryRun ? " (dry run — nothing written)" : ""}.`);
    console.log("Verify with: gistline status");
  }
  process.exit(done ? 0 : 1);
}

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

/**
 * `--preserve` keeps the document's presentation.
 *
 * The default is information: the caller wanted to know what the document says. Preserve is for when the answer has to go
 * back into a document, and it must be asked for.
 */
const mode = argv.includes("--preserve") ? "preserve" : "information";

const budget = Number(flag("budget", DEFAULT_BUDGET));
if (!Number.isFinite(budget) || budget < 100) {
  console.error("gistline: --budget must be a number >= 100");
  process.exit(2);
}

// `--store` with no value falls back to the default directory.
const store = has("store")
  ? openStore({ dir: (flag("store") ?? "").startsWith("--") ? DEFAULT_STORE_DIR : flag("store") ?? DEFAULT_STORE_DIR })
  : null;

const common = {
  budget,
  maxTokens: flag("max-tokens") ? Number(flag("max-tokens")) : null,
  kind: flag("kind"),
  store,
  transforms: TRANSFORMS,
};

/**
 * A FILE IS READ AS BYTES, NOT AS TEXT.
 *
 * This was a real bug. The CLI read every file with `readFileSync(file, "utf8")` and passed it to `gist()`, the text path —
 * so `gistline --file report.docx` printed the raw ZIP archive as mojibake, while `ingest()` had known how to read docx,
 * xlsx, pptx, pdf and html for days and the README documented exactly that command.
 *
 * Nothing caught it because the tests exercised `ingest` directly and the smoke test used the API. The command a person
 * actually types was the one path with no coverage, which is now closed by a CLI test.
 */
let result;

if (file) {
  try {
    result = gistFile(readFileSync(file), { ...common, name: basename(file), mode, label: flag("label", basename(file)) });
  } catch (e) {
    // A refusal is a normal outcome and its message is the useful part, so no stack trace. Exit 1 for "I understood this
    // format and declined", 2 for "I could not read it at all" — a caller can tell them apart.
    console.error(`gistline: ${e.message}`);
    process.exit(e.format ? 1 : 2);
  }
} else {
  let input = "";
  try {
    input = await readStdin();
  } catch (e) {
    console.error(`gistline: cannot read input: ${e.message}`);
    process.exit(2);
  }
  if (!input) {
    console.error("gistline: no input. Pipe something in, or pass --file <path>. See --help.");
    process.exit(2);
  }
  result = gist(input, { ...common, label: flag("label", "") ?? "" });
}

if (has("json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  process.stdout.write(`${result.text}\n`);
}

// Conversion notes — what a reader could not represent — go to stderr, so they inform a person without polluting the
// compressed output a model receives on stdout.
if (result.ingest?.notes?.length && !has("quiet") && !has("json")) {
  for (const n of result.ingest.notes) process.stderr.write(`  note: ${n}\n`);
}

if (has("stats")) {
  const stats = makeGistStats();
  stats.record(result);
  process.stderr.write(`${formatGistStats(stats.snapshot())}\n`);
}
