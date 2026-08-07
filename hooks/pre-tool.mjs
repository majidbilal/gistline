#!/usr/bin/env node
// The pre-tool hook.
//
// ONE RESPONSIBILITY: when an assistant is about to run a command likely to produce large output, say so. It compresses
// nothing and changes nothing.
//
// WHY IT ONLY ADVISES. A hook that REWROTE the command — appending a pipe to gistline — is the obvious design and it would
// be wrong. The assistant chose that command for a reason; silently altering it means the thing that runs is not the thing
// that was decided, and when the output looks unexpected the cause is invisible. Rewriting also breaks on redirections,
// subshells and multi-command lines in ways that are hard to predict and easy to ship.
//
// So this returns a reminder at the moment it applies and the assistant decides. A smaller promise, and one it can keep.
//
// The protocol differs per platform but the shape is the same: read JSON on stdin, write JSON on stdout, exit 0. Exiting
// non-zero would BLOCK the command, which this hook never does — a compression helper must never be able to stop a build.

import { readFileSync } from "node:fs";

/**
 * Commands whose output is usually large enough to be worth compressing.
 *
 * Deliberately conservative. A hook that fires on everything gets ignored, and an ignored hook is worse than none, because
 * it trains the reader to skip the channel it speaks on.
 */
const NOISY = [
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/, kind: "test", why: "a test suite" },
  { re: /\bnode\s+--test\b/, kind: "test", why: "a test run" },
  { re: /\b(?:jest|vitest|mocha|pytest|go\s+test|cargo\s+test|dotnet\s+test)\b/, kind: "test", why: "a test run" },
  { re: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci)\b/, kind: "log", why: "an install log" },
  { re: /\b(?:make|cmake|gradle|mvn|webpack|tsc|cargo\s+build)\b|\brun\s+build\b/, kind: "log", why: "a build log" },
  { re: /\bgit\s+(?:diff|log|show)\b/, kind: "diff", why: "git output that is often long" },
  { re: /\b(?:docker|kubectl)\s+logs\b/, kind: "log", why: "container logs" },
  { re: /\b(?:cat|type)\s+\S+\.(?:log|txt|json|csv|xml)\b/, kind: null, why: "a file that may be large" },
  { re: /\b(?:curl|wget)\b[\s\S]*https?:\/\//, kind: "json", why: "a network response" },
  { re: /\b(?:ls|dir)\s+(?:-\w*R\b|\/s\b)/, kind: null, why: "a recursive listing" },
];

/** Already piped through gistline, or explicitly quiet: say nothing. Repeating advice already taken is noise. */
const ALREADY_HANDLED = /\bgistline\b|--silent\b|\s-q\b|>\s*\/dev\/null|>\s*NUL/i;

/**
 * Find the command in the payload.
 *
 * Platforms nest it differently — `tool_input.command`, `input.command`, `params.command`, `arguments.command` — and a hook
 * that knows only one shape silently never fires on the others. Checked in order, then a shallow scan as a fallback.
 */
export function extractCommand(payload) {
  const direct = [
    payload?.tool_input?.command, payload?.toolInput?.command,
    payload?.input?.command, payload?.params?.command,
    payload?.arguments?.command, payload?.command,
    payload?.tool_input?.script, payload?.input?.script,
  ];
  for (const c of direct) if (typeof c === "string" && c.trim()) return c;

  for (const v of Object.values(payload ?? {})) {
    if (v && typeof v === "object") {
      for (const [k, inner] of Object.entries(v)) {
        if (/^(command|script|cmd)$/i.test(k) && typeof inner === "string" && inner.trim()) return inner;
      }
    }
  }
  return "";
}

/** The advice for a command, or null when there is nothing worth saying. */
export function adviseFor(command) {
  const cmd = String(command ?? "");
  if (!cmd.trim() || ALREADY_HANDLED.test(cmd)) return null;

  const hit = NOISY.find((n) => n.re.test(cmd));
  if (!hit) return null;

  const kindFlag = hit.kind ? ` --kind ${hit.kind}` : "";
  return `This will likely produce ${hit.why}. Consider piping it through gistline so the output arrives compressed:\n`
    + `  ${cmd.trim()} 2>&1 | npx gistline${kindFlag} --label <what-ran>\n`
    + "Failures and errors are kept, and the full original stays retrievable by id.";
}

/** Read stdin, tolerating every shape. A hook that throws on an unexpected field would interrupt real work. */
function readPayload() {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch { return {}; }
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// Entry point. Only runs when invoked directly, so the functions above stay testable.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("pre-tool.mjs")) {
  const advice = adviseFor(extractCommand(readPayload()));

  // No advice means no output at all. An empty object would still be parsed and logged by some platforms, and silence is
  // the correct way to say "nothing to add".
  if (advice) {
    // The permissive shape: platforms read `systemMessage`, `additionalContext` or `output`, and ignore keys they do not
    // know. Emitting all three is how one hook serves five protocols without detecting which is calling.
    process.stdout.write(`${JSON.stringify({
      continue: true,
      suppressOutput: false,
      systemMessage: advice,
      additionalContext: advice,
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: advice },
      output: advice,
    })}\n`);
  }

  // Always zero. Non-zero blocks the command on several platforms, and nothing here justifies that.
  process.exit(0);
}
