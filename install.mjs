// Installation: register gistline with an AI coding assistant.
//
// ONE RESPONSIBILITY: write the file each assistant reads, and remove exactly what was written. It compresses nothing.
//
// WHY THIS EXISTS. gistline works when it is used, and it gets used when the assistant reaches for it without being
// asked. Across a long build the tool sat unused while whole files were read by hand — not because it was unknown, but
// because remembering to pipe a command is a decision made every single time. A registered instruction is a decision made
// once.
//
// THREE MECHANISMS, and which one an assistant supports decides everything:
//
//   skill        a file the assistant loads as a callable capability   (.claude/skills, .agents/skills, ...)
//   rule         a file the assistant includes in every conversation   (.cursor/rules/*.mdc with alwaysApply)
//   instruction  a section in a persistent instruction file            (AGENTS.md, CLAUDE.md, GEMINI.md)
//
// An instruction file is SHARED with other tools, so gistline writes a delimited block and replaces only that block.
// Clobbering someone's AGENTS.md would be a worse outcome than not installing at all.

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Markers that make a block in a shared file replaceable and removable. */
export const BLOCK_START = "<!-- gistline:start -->";
export const BLOCK_END = "<!-- gistline:end -->";

/**
 * The platforms, and where each one reads from.
 *
 * `user` is the profile-wide location; `project` is repository-local. Both are relative to their base, and a platform with
 * no `project` path is user-scoped only.
 *
 * Kept as data rather than code so adding a platform is one row, and so the list can be printed — a reader asking "does
 * this work with my setup" should get an answer from `gistline install --list` rather than from source.
 */
export const PLATFORMS = [
  // --- skill files: the assistant loads gistline as a capability -------------------------------------------
  { id: "claude", label: "Claude Code", kind: "skill", user: ".claude/skills/gistline/SKILL.md", project: ".claude/skills/gistline/SKILL.md", hooks: true },
  { id: "agents", label: "Agent Skills (cross-framework)", kind: "skill", user: ".agents/skills/gistline/SKILL.md", project: ".agents/skills/gistline/SKILL.md", alias: ["skills"] },
  { id: "copilot", label: "GitHub Copilot CLI", kind: "skill", user: ".config/copilot/skills/gistline/SKILL.md", project: ".github/skills/gistline/SKILL.md" },
  { id: "vscode", label: "VS Code Copilot Chat", kind: "instruction", user: null, project: ".github/copilot-instructions.md" },
  { id: "amp", label: "Amp", kind: "skill", user: ".config/amp/skills/gistline/SKILL.md", project: ".amp/skills/gistline/SKILL.md" },
  { id: "pi", label: "Pi coding agent", kind: "skill", user: ".config/pi/skills/gistline/SKILL.md", project: ".pi/skills/gistline/SKILL.md" },
  { id: "kiro", label: "Kiro IDE/CLI", kind: "skill", user: ".kiro/skills/gistline/SKILL.md", project: ".kiro/skills/gistline/SKILL.md" },
  { id: "devin", label: "Devin CLI", kind: "skill", user: ".config/devin/skills/gistline/SKILL.md", project: ".devin/skills/gistline/SKILL.md" },
  { id: "kilo", label: "Kilo Code", kind: "skill", user: ".config/kilo/skills/gistline/SKILL.md", project: ".kilo/skills/gistline/SKILL.md", hooks: true },

  // --- rule files: always included in the conversation -----------------------------------------------------
  { id: "cursor", label: "Cursor", kind: "rule", user: null, project: ".cursor/rules/gistline.mdc" },
  { id: "windsurf", label: "Windsurf", kind: "rule", user: null, project: ".windsurf/rules/gistline.md" },
  { id: "antigravity", label: "Google Antigravity", kind: "rule", user: null, project: ".agents/rules/gistline.md" },

  // --- instruction files: a delimited block in a shared file -----------------------------------------------
  { id: "codex", label: "Codex", kind: "instruction", user: ".codex/AGENTS.md", project: "AGENTS.md" },
  { id: "opencode", label: "OpenCode", kind: "instruction", user: ".config/opencode/AGENTS.md", project: "AGENTS.md", hooks: true },
  { id: "aider", label: "Aider", kind: "instruction", user: null, project: "AGENTS.md" },
  { id: "claw", label: "OpenClaw", kind: "instruction", user: null, project: "AGENTS.md" },
  { id: "droid", label: "Factory Droid", kind: "instruction", user: null, project: "AGENTS.md" },
  { id: "trae", label: "Trae", kind: "instruction", user: null, project: "AGENTS.md" },
  { id: "trae-cn", label: "Trae CN", kind: "instruction", user: null, project: "AGENTS.md" },
  { id: "hermes", label: "Hermes", kind: "instruction", user: ".hermes/AGENTS.md", project: "AGENTS.md" },
  { id: "kimi", label: "Kimi Code", kind: "instruction", user: null, project: "AGENTS.md" },
  { id: "codebuddy", label: "CodeBuddy", kind: "instruction", user: null, project: "CODEBUDDY.md", hooks: true },
  { id: "gemini", label: "Gemini CLI", kind: "instruction", user: ".gemini/GEMINI.md", project: "GEMINI.md", hooks: true },
];

const byId = new Map(PLATFORMS.flatMap((p) => [[p.id, p], ...(p.alias ?? []).map((a) => [a, p])]));

/** Resolve a platform id or alias. Unknown ids fail loudly, listing what is available. */
export function findPlatform(id) {
  const p = byId.get(String(id ?? "").toLowerCase());
  if (!p) {
    throw new Error(`unknown platform "${id}". Available: ${PLATFORMS.map((x) => x.id).join(", ")}`);
  }
  return p;
}

/**
 * The instruction gistline writes.
 *
 * Written as MOMENTS rather than as a description of the tool, because that is the difference between an instruction that
 * gets followed and one that gets read. "Before reading a command's output" is actionable at the instant it applies;
 * "gistline compresses output" is a fact an assistant can hold while reading 40,000 characters by hand.
 *
 * The 500-character threshold is stated because a tool used indiscriminately stops being trusted: below it, the note
 * gistline prints costs more than the compression saves.
 */
export function instructionText({ scope = "project" } = {}) {
  return `## gistline

Large command output and large files should be compressed before being read.

**Before reading the output of any command likely to exceed ~500 characters** — a test run, a build log, an install log,
a large \`git diff\`, a directory listing — run it through gistline instead of reading it directly:

\`\`\`
npx gistline run <command>
\`\`\`

That is one step, not two. It executes the command, compresses the output, and **passes through the command's own exit
code**, so it is safe in CI. Piping also works if the command is already written that way:

\`\`\`
<command> 2>&1 | npx gistline --kind test --label <what-ran>
\`\`\`

**Before reading a file over ~500 characters** where only part of it matters:

\`\`\`
npx gistline --file <path> --budget 2000
\`\`\`

**For a document** (\`.pdf\`, \`.docx\`, \`.xlsx\`, \`.pptx\`, \`.html\`), convert and compress in one step:

\`\`\`
npx gistline --file report.pdf
\`\`\`

### Fetching a web page

**Use the shell, not a built-in fetch tool.** A built-in fetch puts the page straight into the conversation, where it can
never be compressed — and scraped HTML is the single largest saving available, around 95%, because only about 10-15% of its
tokens are content.

Only what arrives on stdout can be compressed, so route the fetch through the shell and pipe it:

\`\`\`
# macOS, Linux
curl -sL "<url>" | npx gistline --label page

# Windows PowerShell
curl.exe -sL "<url>" | npx gistline --label page
# or, if curl.exe is unavailable:
(Invoke-WebRequest -Uri "<url>" -UseBasicParsing).Content | npx gistline --label page

# where curl is absent
wget -qO- "<url>" | npx gistline --label page
\`\`\`

The same applies to reading a file: a built-in file-reading tool loads the whole thing into the conversation, where
\`npx gistline --file <path>\` would have compressed it first.

### When to preserve a document's formatting

By default gistline returns the **information** in a document, not its presentation — because the usual reason to read a
document is to learn what it says. That output is around 25% smaller on anything containing a table.

Pass \`--preserve\` **only when the answer has to go back into a document**, which is signalled by what was asked for:

| The person said | Use |
|---|---|
| "what does this contract say", "summarise the deck", "here is the spec" | the default |
| "here are the files for context", "use this data" | the default |
| "change this in my PDF", "update the spreadsheet", "rewrite this section" | \`--preserve\` |
| "reformat", "regenerate the document", "keep the layout" | \`--preserve\` |

Feeding a document as background information is the common case and the default serves it. Editing a document is the
exception, and \`--preserve\` keeps the table and heading structure a rewrite needs.

### What to expect

- Output is prefixed with a note stating what was compressed and by how much.
- The note says whether anything was **removed** or whether the content was only **restated more compactly**. A lossless
  result means every value is still present.
- **When the original was kept, the note contains its id**, and that is where the id comes from:

  \`\`\`
  [npm test output compressed: 91,921 → 132 chars. Full output retained as id 092d1b24d287fa0a
   — retrieve, slice, or grep it for any dropped detail.]
  \`\`\`

  Then \`npx gistline retrieve 092d1b24d287fa0a\`, or \`slice\` it, or \`grep\` it.

- \`gistline\` keeps the original **by default**, so the id is there whenever something was actually removed. A lossless
  result has no id because nothing was dropped — there is nothing to retrieve, and the note says so.
- \`--no-store\` opts out. Keeping the original writes it to a local directory, so use that flag for anything sensitive.
- gistline **declines** when it cannot help. A refusal is a normal result, not an error.

### If a detail is missing from compressed output

Do not guess and do not re-run the command. Retrieve the original:

\`\`\`
npx gistline grep <id> "<what you are looking for>"
npx gistline slice <id> --from-line 400 --lines 50
\`\`\`

If there is no id in the note, read what the note says: either nothing was removed — in which case it is all already
there — or the original was not retained, in which case re-running without \`--no-store\` will keep it.

### When not to use it

Content under ~500 characters. The note costs more than the compression saves, and a tool applied indiscriminately stops
being worth trusting.
`;
}

/** Cursor's rule format needs frontmatter with `alwaysApply`, or it is never loaded. */
function cursorRule() {
  return `---
description: Compress large command output and files before reading them
alwaysApply: true
---

${instructionText()}`;
}

/** A skill file needs frontmatter naming and describing the capability, or the assistant cannot decide when to load it. */
function skillFile() {
  return `---
name: gistline
description: >-
  Compress large command output, logs, and documents before reading them. Use before reading any test run, build log,
  large diff, or file over ~500 characters, and to convert PDF, DOCX, XLSX, PPTX or HTML into Markdown. Reduces tokens
  while keeping the failures and values that matter, with the full original retrievable by id.
---

${instructionText()}`;
}

/** The body for one platform, in whatever shape that platform reads. */
export function contentFor(platform, { scope = "project" } = {}) {
  if (platform.kind === "rule" && platform.id === "cursor") return cursorRule();
  if (platform.kind === "rule") return instructionText({ scope });
  if (platform.kind === "skill") return skillFile();
  return instructionText({ scope });
}

/** Where a platform's file goes, for the requested scope. Returns null when that scope is unsupported. */
export function pathFor(platform, { project = false, cwd = process.cwd(), home = homedir() } = {}) {
  const rel = project ? platform.project : platform.user;
  if (!rel) return null;
  return resolve(project ? cwd : home, rel);
}

/**
 * Splice gistline's block into a shared instruction file.
 *
 * Replaces an existing block if one is present, appends otherwise, and leaves every other line untouched. This is the
 * whole reason for the markers: `AGENTS.md` belongs to the project, not to this tool, and overwriting it would be a worse
 * outcome than declining to install.
 */
export function spliceBlock(existing, body) {
  const block = `${BLOCK_START}\n${body.trim()}\n${BLOCK_END}`;
  const text = String(existing ?? "");

  const from = text.indexOf(BLOCK_START);
  const to = text.indexOf(BLOCK_END);

  if (from !== -1 && to > from) {
    return `${text.slice(0, from)}${block}${text.slice(to + BLOCK_END.length)}`;
  }

  if (!text.trim()) return `${block}\n`;
  return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

/** Remove gistline's block, leaving the rest of a shared file alone. */
export function removeBlock(existing) {
  const text = String(existing ?? "");
  const from = text.indexOf(BLOCK_START);
  const to = text.indexOf(BLOCK_END);
  if (from === -1 || to <= from) return { text, removed: false };
  const out = `${text.slice(0, from).replace(/\s*$/, "")}\n${text.slice(to + BLOCK_END.length).replace(/^\s*/, "")}`;
  return { text: out.trim() ? `${out.trim()}\n` : "", removed: true };
}

/**
 * Install for one platform.
 *
 * A skill or rule file is OWNED by gistline and written whole. An instruction file is shared and spliced. The distinction
 * matters: writing a whole AGENTS.md would delete a project's own guidance.
 */
export function installPlatform(platform, { project = false, cwd = process.cwd(), home = homedir(), dryRun = false } = {}) {
  const target = pathFor(platform, { project, cwd, home });
  if (!target) {
    return { ok: false, platform: platform.id, reason: `${platform.label} has no ${project ? "project" : "user"}-scoped location` };
  }

  const owned = platform.kind !== "instruction";
  const body = contentFor(platform, { scope: project ? "project" : "user" });
  const existed = existsSync(target);
  const next = owned ? body : spliceBlock(existed ? readFileSync(target, "utf8") : "", body);

  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, next, "utf8");
  }

  return {
    ok: true,
    platform: platform.id,
    label: platform.label,
    kind: platform.kind,
    path: target,
    action: existed ? (owned ? "replaced" : "updated the gistline block in") : "created",
    shared: !owned,
    hooks: !!platform.hooks,
  };
}

/**
 * Uninstall for one platform.
 *
 * An owned file is deleted; a shared file has only its block removed. A shared file that becomes empty is deleted, because
 * leaving an empty AGENTS.md behind is litter.
 */
export function uninstallPlatform(platform, { project = false, cwd = process.cwd(), home = homedir(), dryRun = false } = {}) {
  const target = pathFor(platform, { project, cwd, home });
  if (!target || !existsSync(target)) {
    return { ok: false, platform: platform.id, reason: "nothing installed at that location" };
  }

  const owned = platform.kind !== "instruction";

  if (owned) {
    if (!dryRun) rmSync(target, { force: true });
    return { ok: true, platform: platform.id, path: target, action: "removed" };
  }

  const { text, removed } = removeBlock(readFileSync(target, "utf8"));
  if (!removed) return { ok: false, platform: platform.id, reason: "no gistline block found in that file" };

  if (!dryRun) {
    if (text.trim()) writeFileSync(target, text, "utf8");
    else rmSync(target, { force: true });
  }
  return { ok: true, platform: platform.id, path: target, action: text.trim() ? "removed the gistline block from" : "removed (it held nothing else)" };
}

/**
 * Detect which assistants are present.
 *
 * Used when no platform is named, and deliberately conservative: it looks for a directory the assistant itself created,
 * never for one gistline might have made. Installing into a tool nobody uses is clutter, and guessing wrongly means a file
 * appears in a repository for no reason.
 */
export function detect({ cwd = process.cwd(), home = homedir() } = {}) {
  const marks = [
    ["claude", [join(home, ".claude"), join(cwd, ".claude")]],
    ["codex", [join(home, ".codex"), join(cwd, ".codex")]],
    ["cursor", [join(cwd, ".cursor")]],
    ["gemini", [join(home, ".gemini"), join(cwd, ".gemini")]],
    ["windsurf", [join(cwd, ".windsurf")]],
    ["kiro", [join(cwd, ".kiro"), join(home, ".kiro")]],
    ["kilo", [join(cwd, ".kilo"), join(home, ".config", "kilo")]],
    ["opencode", [join(home, ".config", "opencode"), join(cwd, ".opencode")]],
    ["codebuddy", [join(cwd, ".codebuddy")]],
    ["amp", [join(home, ".config", "amp")]],
    ["hermes", [join(home, ".hermes")]],
    ["agents", [join(home, ".agents"), join(cwd, ".agents")]],
    ["vscode", [join(cwd, ".github")]],
  ];

  return marks
    .filter(([, dirs]) => dirs.some((d) => existsSync(d)))
    .map(([id]) => findPlatform(id));
}

/**
 * Verify an install.
 *
 * Install without verification is how a tool appears installed and does nothing. This reports what is actually on disk,
 * per platform and per scope, so the answer to "did that work" comes from the filesystem rather than from the exit code of
 * the command that claimed to do it.
 */
export function status({ cwd = process.cwd(), home = homedir() } = {}) {
  /**
   * Grouped BY FILE, not by platform.
   *
   * Eight assistants read `AGENTS.md`, so a per-platform list reported "registered with 10 locations" when two files
   * existed — accurate and confusing. What a reader wants to know is which files were written and who reads them.
   */
  const byPath = new Map();

  for (const p of PLATFORMS) {
    for (const project of [false, true]) {
      const target = pathFor(p, { project, cwd, home });
      if (!target || !existsSync(target)) continue;

      const text = readFileSync(target, "utf8");
      const present = p.kind === "instruction" ? text.includes(BLOCK_START) : /gistline/i.test(text);
      if (!present) continue;

      const key = `${target}\u0000${project}`;
      if (!byPath.has(key)) {
        byPath.set(key, { path: target, kind: p.kind, scope: project ? "project" : "user", platforms: [] });
      }
      byPath.get(key).platforms.push(p.label);
    }
  }

  return [...byPath.values()];
}

/**
 * Where each platform's hook configuration lives, and in what shape.
 *
 * Five platforms, three protocols. The shapes are genuinely different — Claude and CodeBuddy use a matcher-plus-command
 * array under an event name, Gemini uses a flatter form, and OpenCode and Kilo want a plugin module rather than a settings
 * entry. Pretending they are the same would mean installing something that silently never fires.
 */
export const HOOK_TARGETS = {
  claude: {
    label: "Claude Code",
    file: ".claude/settings.json",
    project: ".claude/settings.json",
    build: (cmd) => ({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }] } }),
    event: "PreToolUse",
  },
  codebuddy: {
    label: "CodeBuddy",
    file: ".codebuddy/settings.json",
    project: ".codebuddy/settings.json",
    build: (cmd) => ({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }] } }),
    event: "PreToolUse",
  },
  gemini: {
    label: "Gemini CLI",
    file: ".gemini/settings.json",
    project: ".gemini/settings.json",
    build: (cmd) => ({ hooks: { BeforeTool: [{ matcher: "run_shell_command", commands: [cmd] }] } }),
    event: "BeforeTool",
  },

  /**
   * OpenCode and Kilo Code load a PLUGIN MODULE rather than running a command.
   *
   * A genuinely different integration shape, not a different protocol on the same one — there is no process to spawn. So the
   * installed artefact is a small file that re-exports gistline's plugin, and the settings entry names it.
   *
   * These two were recorded in ISSUES.md as "not built" while the other three worked, because claiming support that does not
   * exist is worse than naming the gap.
   */
  opencode: {
    label: "OpenCode",
    file: ".config/opencode/opencode.json",
    project: "opencode.json",
    kind: "plugin",
    pluginFile: ".opencode/plugin/gistline.mjs",
    pluginProject: ".opencode/plugin/gistline.mjs",
    build: () => ({ plugin: ["./.opencode/plugin/gistline.mjs"] }),
    event: "plugin",
  },
  kilo: {
    label: "Kilo Code",
    file: ".config/kilo/config.json",
    project: ".kilo/config.json",
    kind: "plugin",
    pluginFile: ".kilo/plugins/gistline.mjs",
    pluginProject: ".kilo/plugins/gistline.mjs",
    build: () => ({ plugin: ["./.kilo/plugins/gistline.mjs"] }),
    event: "plugin",
  },
};

/** The command a hook entry runs. `npx --no-install` so it fails visibly rather than silently downloading mid-command. */
const hookCommand = () => `node "${new URL("hooks/pre-tool.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")}"`;

/**
 * Merge a hook into an existing settings file.
 *
 * DEEP MERGE, NEVER OVERWRITE. `settings.json` holds a person's own configuration — permissions, model choices, other
 * tools' hooks — and replacing it would be the worst thing this installer could do. The same principle as splicing
 * `AGENTS.md`, but JSON needs real merging rather than delimiters.
 *
 * Idempotent by command string: installing twice does not produce two identical hooks, which would run the advice twice.
 */
export function mergeHook(existing, addition, event) {
  const base = existing && typeof existing === "object" ? structuredClone(existing) : {};
  base.hooks ??= {};

  const incoming = addition.hooks[event];
  const current = Array.isArray(base.hooks[event]) ? base.hooks[event] : [];

  /**
   * Compared ENTRY BY ENTRY, not entry against the whole array.
   *
   * The first version compared each existing entry to `JSON.stringify(incoming)` — an array — so it never matched anything
   * and installing twice produced two identical hooks, which run the advice twice and read like a bug. A test caught it.
   */
  const isOurs = (entry, ours) => JSON.stringify(entry) === JSON.stringify(ours);
  const toAdd = incoming.filter((entry) => !current.some((existing) => isOurs(existing, entry)));

  base.hooks[event] = [...current, ...toAdd];
  return base;
}

/** Remove our hook and nothing else. An emptied `hooks` key is deleted so the file returns to its prior shape. */
export function unmergeHook(existing, addition, event) {
  if (!existing?.hooks?.[event]) return { settings: existing, removed: false };

  const base = structuredClone(existing);
  const ours = JSON.stringify(addition.hooks[event][0]);
  const before = base.hooks[event].length;

  base.hooks[event] = base.hooks[event].filter((e) => JSON.stringify(e) !== ours);

  if (!base.hooks[event].length) delete base.hooks[event];
  if (!Object.keys(base.hooks).length) delete base.hooks;

  return { settings: base, removed: base.hooks?.[event]?.length !== before };
}

/**
 * The plugin module gistline writes for a plugin-based platform.
 *
 * A re-export rather than a copy. Copying the logic would mean two versions of the advice — one in the package and a stale
 * one in the user's project — and the stale one would keep firing after an upgrade fixed something.
 */
const pluginShim = () =>
  `// Written by \`gistline install\`. Re-exports gistline's plugin so an upgrade takes effect without reinstalling.\n`
  + `export { default } from "gistline/hooks/plugin.mjs";\n`
  + `export { plugin } from "gistline/hooks/plugin.mjs";\n`;

/**
 * Install for a plugin-based platform: a module, plus a config entry naming it.
 *
 * Two artefacts rather than one, which is why it cannot share the settings-merge path directly. The config is still MERGED —
 * `opencode.json` holds the user's own configuration and replacing it would be as bad here as anywhere else.
 */
function installPluginHook(target, { project, cwd, home, dryRun }) {
  const modulePath = resolve(project ? cwd : home, project ? target.pluginProject : target.pluginFile);
  const configPath = resolve(project ? cwd : home, project ? target.project : target.file);

  let existing = {};
  if (existsSync(configPath)) {
    try { existing = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { return { ok: false, reason: `${configPath} is not valid JSON — left untouched` }; }
  }

  const entry = target.build().plugin[0];
  const current = Array.isArray(existing.plugin) ? existing.plugin : [];
  // Idempotent: installing twice must not list the plugin twice, which would run the advice twice.
  const merged = { ...existing, plugin: current.includes(entry) ? current : [...current, entry] };

  if (!dryRun) {
    mkdirSync(dirname(modulePath), { recursive: true });
    writeFileSync(modulePath, pluginShim(), "utf8");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }

  return { ok: true, path: modulePath, configPath, event: "plugin", label: target.label };
}

/** Uninstall for a plugin-based platform: remove the module and its config entry, leaving the rest alone. */
function uninstallPluginHook(target, { project, cwd, home, dryRun }) {
  const modulePath = resolve(project ? cwd : home, project ? target.pluginProject : target.pluginFile);
  const configPath = resolve(project ? cwd : home, project ? target.project : target.file);

  let removed = false;

  if (existsSync(modulePath)) {
    if (!dryRun) rmSync(modulePath, { force: true });
    removed = true;
  }

  if (existsSync(configPath)) {
    let existing;
    try { existing = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { return { ok: removed, path: modulePath, reason: `${configPath} is not valid JSON — left untouched` }; }

    const entry = target.build().plugin[0];
    if (Array.isArray(existing.plugin) && existing.plugin.includes(entry)) {
      const rest = existing.plugin.filter((p) => p !== entry);
      const next = { ...existing };
      // An emptied `plugin` key is deleted, so the file returns to its prior shape rather than gaining an empty array.
      if (rest.length) next.plugin = rest;
      else delete next.plugin;

      if (!dryRun) {
        if (Object.keys(next).length) writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
        else rmSync(configPath, { force: true });
      }
      removed = true;
    }
  }

  return removed ? { ok: true, path: modulePath, event: "plugin" } : { ok: false, reason: "no gistline plugin found" };
}

/**
 * Install the hook for one platform.
 *
 * Returns a result rather than throwing, because a hook is an enhancement: a platform whose settings file cannot be parsed
 * should not fail the whole install, and the instruction file it also received still works.
 */
export function installHook(platformId, { project = false, cwd = process.cwd(), home = homedir(), dryRun = false } = {}) {
  const target = HOOK_TARGETS[platformId];
  if (!target) return { ok: false, reason: `${platformId} does not support hooks` };

  // A plugin platform writes a module and a config entry rather than a command entry.
  if (target.kind === "plugin") return installPluginHook(target, { project, cwd, home, dryRun });

  const path = resolve(project ? cwd : home, project ? target.project : target.file);
  const cmd = hookCommand();

  let existing = {};
  if (existsSync(path)) {
    try { existing = JSON.parse(readFileSync(path, "utf8")); }
    catch { return { ok: false, reason: `${path} is not valid JSON — left untouched` }; }
  }

  const merged = mergeHook(existing, target.build(cmd), target.event);

  if (!dryRun) {
    mkdirSync(dirname(path), { recursive: true });
    // Two-space JSON, matching what these tools write themselves, so a diff shows only the addition.
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  }

  return { ok: true, path, event: target.event, label: target.label, existed: existsSync(path) };
}

/** Remove the hook for one platform. */
export function uninstallHook(platformId, { project = false, cwd = process.cwd(), home = homedir(), dryRun = false } = {}) {
  const target = HOOK_TARGETS[platformId];
  if (!target) return { ok: false, reason: `${platformId} does not support hooks` };

  if (target.kind === "plugin") return uninstallPluginHook(target, { project, cwd, home, dryRun });

  const path = resolve(project ? cwd : home, project ? target.project : target.file);
  if (!existsSync(path)) return { ok: false, reason: "no settings file" };

  let existing;
  try { existing = JSON.parse(readFileSync(path, "utf8")); }
  catch { return { ok: false, reason: `${path} is not valid JSON — left untouched` }; }

  const { settings, removed } = unmergeHook(existing, target.build(hookCommand()), target.event);
  if (!removed) return { ok: false, reason: "no gistline hook found" };

  if (!dryRun) {
    // A settings file holding nothing but our hook is deleted; one with other content keeps it.
    if (Object.keys(settings).length) writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    else rmSync(path, { force: true });
  }

  return { ok: true, path, event: target.event };
}
