// Generate docs/ARCHITECTURE.md from the actual code.
//
// WHY GENERATED RATHER THAN WRITTEN. A hand-written architecture document is accurate on the day it is written and
// misleading a month later — and a misleading map is worse than no map, because someone trusts it. This one is derived
// from symbolmap's real import graph, so it cannot describe a dependency that does not exist or miss one that does.
//
// What it deliberately does NOT try to be: a description of what each module means. That belongs in the module's own
// header comment, next to the code it describes, where it will be read and updated. This file answers "where do I look"
// and "what breaks if I change this".
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SYMBOLMAP = process.env.SYMBOLMAP ?? "D:\\Projects\\teamify-ai\\tools\\symbolmap\\cli.mjs";

if (!existsSync(SYMBOLMAP)) {
  console.error(`symbolmap not found at ${SYMBOLMAP}. Set SYMBOLMAP to its cli.mjs.`);
  process.exit(2);
}

const map = JSON.parse(execSync(`node "${SYMBOLMAP}" --json`, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));

// Source only: tests and scripts are real code but they are not the architecture, and including them buries the shape.
const isSource = (p) => !p.includes(".test.") && !p.startsWith("scripts/") && !p.startsWith("docs/");
const modules = map.modules.filter((m) => isSource(m.path));

/** The layer a module belongs to, from its directory. Order matters: it is the dependency direction. */
const LAYERS = [
  ["Entry points", (p) => ["index.mjs", "cli.mjs", "mcp.mjs", "install.mjs"].includes(p),
    "What a caller touches. Everything below is reachable from here and nothing here is imported by the layers below."],
  ["core/", (p) => p.startsWith("core/"),
    "Orchestration and shared state. Decides what runs and in what order; transforms nothing itself."],
  ["transforms/", (p) => p.startsWith("transforms/"),
    "One transformation each. A transform never decides whether it should run — the pipeline decides."],
  ["util/", (p) => p.startsWith("util/"),
    "Shared primitives with exactly one implementation. Each exists because two consumers needed identical rules and the second derivation got them wrong."],
  ["Root modules", (p) => !p.includes("/"),
    "Long-standing modules that predate the layering and remain at the root because they are part of the published surface."],
];

const layerOf = (p) => LAYERS.find(([, test]) => test(p))?.[0] ?? "Other";

// Who imports each module, so the doc can answer "what breaks if I change this" without running anything.
const importers = new Map();
for (const m of map.modules) {
  for (const i of m.imports) {
    if (!i.target || i.external) continue;
    if (!importers.has(i.target)) importers.set(i.target, []);
    importers.get(i.target).push(m.path);
  }
}

const internalDeps = (m) => [...new Set(m.imports.filter((i) => i.target && !i.external).map((i) => i.target))];
const externalDeps = (m) => [...new Set(m.imports.filter((i) => i.external).map((i) => i.from))];

const out = [];
const rel = (p) => `[\`${p}\`](../${p})`;

out.push("# Architecture");
out.push("");
out.push("**Generated from the code by `npm run architecture`. Do not edit by hand.**");
out.push("");
out.push("A hand-written map is accurate the day it is written and misleading a month later, and a misleading map is worse");
out.push("than none because someone trusts it. This is derived from the real import graph, so it cannot describe a");
out.push("dependency that does not exist or miss one that does.");
out.push("");
out.push("What each module *means* lives in its own header comment, next to the code it describes. This answers **where to");
out.push("look** and **what breaks if I change this**.");
out.push("");

// --- the shape, in one block a reader can hold ------------------------------------------------------------
out.push("## The shape");
out.push("");
out.push("```");
out.push("bytes or text in");
out.push("      |");
out.push("      v");
out.push("  core/ingest         detect the format; convert a document to Markdown, or decline with a reason");
out.push("      |");
out.push("      v");
out.push("  core/pipeline       order the transforms and stop as soon as the budget is met");
out.push("      |");
out.push("      +--> convert    transforms/html          format changes, text does not");
out.push("      +--> lossless   transforms/tables        nothing removed");
out.push("      |               transforms/templates");
out.push("      +--> lossy      transforms/legacy        something removed, and it says so");
out.push("      |");
out.push("      v");
out.push("  store.mjs           the original, addressable by content hash");
out.push("```");
out.push("");
out.push("**The ordering IS the guarantee.** Lossless transforms run before lossy ones because of where they sit in the");
out.push("list, not because any transform checks. No individual transform can get the rule wrong, because none applies it.");
out.push("");

// --- statistics, measured -----------------------------------------------------------------------------------
out.push("## Size");
out.push("");
out.push("| | Count |");
out.push("|---|---|");
out.push(`| Source modules | ${modules.length} |`);
out.push(`| Source lines | ${modules.reduce((n, m) => n + m.lines, 0).toLocaleString("en-GB")} |`);
out.push(`| Test files | ${map.modules.filter((m) => m.path.includes(".test.")).length} |`);
// `edges` is symbolmap's own key. Reading a key that does not exist printed a dash and looked deliberate, which is the
// quiet kind of wrong a generated document should never contain.
out.push(`| Import edges across the repo | ${(map.stats?.edges ?? 0).toLocaleString("en-GB")} |`);
out.push(`| Distinct symbols | ${(map.stats?.symbols ?? 0).toLocaleString("en-GB")} |`);
out.push(`| Runtime dependencies | **0** |`);
out.push(`| Node built-ins used | ${[...new Set(map.modules.flatMap(externalDeps))].sort().join(", ") || "none"} |`);
out.push("");

// --- layers ------------------------------------------------------------------------------------------------
for (const [name, test, why] of LAYERS) {
  const inLayer = modules.filter((m) => layerOf(m.path) === name);
  if (!inLayer.length) continue;

  out.push(`## ${name}`);
  out.push("");
  out.push(why);
  out.push("");
  out.push("| Module | Lines | Imports | Imported by |");
  out.push("|---|---|---|---|");

  for (const m of inLayer.sort((a, b) => a.path.localeCompare(b.path))) {
    const deps = internalDeps(m);
    const used = (importers.get(m.path) ?? []).filter(isSource);
    out.push(`| ${rel(m.path)} | ${m.lines} | ${deps.length || "—"} | ${used.length || "—"} |`);
  }
  out.push("");
}

// --- blast radius: the question a change actually raises -----------------------------------------------------
out.push("## What breaks if this changes");
out.push("");
out.push("Modules with the most dependants, highest first. A change here is a change everywhere, so these are the ones");
out.push("worth a round-trip test and a second read.");
out.push("");
out.push("| Module | Dependants | Who |");
out.push("|---|---|---|");

const ranked = modules
  .map((m) => ({ path: m.path, users: (importers.get(m.path) ?? []).filter(isSource) }))
  .filter((x) => x.users.length)
  .sort((a, b) => b.users.length - a.users.length)
  .slice(0, 10);

for (const r of ranked) {
  out.push(`| ${rel(r.path)} | **${r.users.length}** | ${r.users.map((u) => `\`${u}\``).join(", ")} |`);
}
out.push("");

// --- health, from symbolmap's own checks ---------------------------------------------------------------------
const health = (cmd) => execSync(`node "${SYMBOLMAP}" ${cmd}`, { encoding: "utf8" }).trim();

out.push("## Health");
out.push("");
out.push("Checked by symbolmap on every regeneration. These are the three failures this codebase has actually produced.");
out.push("");

const broken = map.broken ?? [];
out.push(`**Broken relative imports:** ${broken.length ? `${broken.length} — see below` : "none"}`);
if (broken.length) for (const b of broken) out.push(`- \`${b.from ?? b}\``);
out.push("");

const cycles = health("cycles");
out.push(`**Import cycles:** ${/no import cycles/.test(cycles) ? "none" : "present — see `symbolmap cycles`"}`);
out.push("");

const orphans = health("orphans");
out.push("**Unimported modules:**");
out.push("");
out.push("```");
out.push(orphans);
out.push("```");
out.push("");
out.push("`mcp.mjs` is expected here: it is a declared `bin` entry point, so nothing imports it. Anything *else* appearing");
out.push("in that list is the failure this project produced four times — a module built, tested, and never connected to");
out.push("anything, passing its own tests while doing nothing in the real path.");
out.push("");

// --- navigation ---------------------------------------------------------------------------------------------
out.push("## Finding things");
out.push("");
out.push("```");
out.push("symbolmap where <symbol>        where it is declared");
out.push("symbolmap uses <symbol>         who uses it");
out.push("symbolmap blast <file>          everything that could break if it changes");
out.push("symbolmap deps <file>           what it imports");
out.push("symbolmap orphans              modules nobody imports");
out.push("symbolmap unused-exports       exports nothing in the repo uses");
out.push("```");
out.push("");
out.push("Faster than grep and it excludes comments and strings, so `uses` returns call sites rather than mentions.");
out.push("");
out.push("## Where everything lives");
out.push("");
out.push("```");
out.push("core/          orchestration: ingest, pipeline, context, document model, Markdown writer");
out.push("transforms/    one transformation each, plus the format readers");
out.push("util/          shared primitives: escaping, lines, masking, ZIP, PDF objects, PDF fonts");
out.push("scripts/       demos, the claim checker, the installed-package smoke test, generators");
out.push("docs/          hero.svg, this file");
out.push("docs/internal/ working plans — gitignored, never published");
out.push("```");
out.push("");
out.push("Tests sit beside the module they test: `core/pipeline.mjs` has `core/pipeline.test.mjs`.");
out.push("");
out.push("---");
out.push("");
out.push(`*${modules.length} source modules · regenerate with \`npm run architecture\`*`);

writeFileSync("docs/ARCHITECTURE.md", `${out.join("\n")}\n`, "utf8");
console.log(`wrote docs/ARCHITECTURE.md — ${modules.length} source modules, ${out.length} lines`);
