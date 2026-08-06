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
  { id: "kilo", label: "Kilo Code", kind: "skill", user: ".config/kilo/skills/gistline/SKILL.md", project: ".kilo/skills/gistline/SKILL.md" },

  // --- rule files: always included in the conversation -----------------------------------------------------
  { id: "cursor", label: "Cursor", kind: "rule", user: null, project: ".cursor/rules/gistline.mdc" },
  { id: "windsurf", label: "Windsurf", kind: "rule", user: null, project: ".windsurf/rules/gistline.md" },
  { id: "antigravity", label: "Google Antigravity", kind: "rule", user: null, project: ".agents/rules/gistline.md" },

  // --- instruction files: a delimited block in a shared file -----------------------------------------------
  { id: "codex", label: "Codex", kind: "instruction", user: ".codex/AGENTS.md", project: "AGENTS.md" },
  { id: "opencode", label: "OpenCode", kind: "instruction", user: ".config/opencode/AGENTS.md", project: "AGENTS.md" },
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
a large \`git diff\`, a directory listing — pipe it through gistline instead of reading it directly:

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

### What to expect

- Output is prefixed with a note stating what was compressed and by how much.
- The note says whether anything was **removed** or whether the content was only **restated more compactly**. A lossless
  result means every value is still present.
- The full original is retained and addressable: \`npx gistline retrieve <id>\`, \`slice\`, or \`grep\` it. Nothing is ever
  lost, so aggressive compression is safe.
- gistline **declines** when it cannot help. A refusal is a normal result, not an error.

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
