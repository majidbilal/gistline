# gistline

[![npm](https://img.shields.io/npm/v/gistline)](https://www.npmjs.com/package/gistline)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![license](https://img.shields.io/npm/l/gistline)](./LICENSE)
[![CI](https://github.com/majidbilal/gistline/actions/workflows/ci.yml/badge.svg)](https://github.com/majidbilal/gistline/actions/workflows/ci.yml)

**Your AI coding assistant keeps losing the plot after running tests. This fixes that.**

```bash
npm test 2>&1 | npx gistline
```

That's it. No install, no config.

---

## The problem, in one example

You ask Claude Code or Cursor to fix a failing test. It runs `npm test`. The output is 40,000 lines.

The assistant can only "see" so much text at once, so it reads the beginning and gives up on the
rest. The beginning is `TAP version 13` and a few hundred tests that **passed**. The one line that
actually says what broke is somewhere in the middle — and it never gets read.

So the assistant guesses. You get a confident fix for the wrong problem.

## What gistline does

It shrinks the output *before* your assistant reads it, and it's smart about **what to keep**:

- Test runs → keeps the **failures** and the final score, throws away the passing lines
- Errors → keeps **your** code's line numbers, throws away the framework noise
- JSON → keeps the **shape** (what fields exist), shortens the values
- Logs → keeps the lines that mention errors, wherever they are in the file

Real example, from a project with 605 tests:

```
96,443 characters  →  2,284 characters       (98% smaller)
```

…and the failure, the error message, and the file-and-line were all still there.

## Use it with your AI coding assistant

**The easiest way:** paste this into your project's `CLAUDE.md`, `AGENTS.md`, or
`.cursor/rules/gistline.mdc`. Your assistant will then do it automatically.

```markdown
## Reading command output

When a command produces a lot of output (tests, builds, installs, logs), pipe it through
gistline instead of reading it raw:

    npm test 2>&1 | npx gistline --store --label "npm test"

gistline keeps the failures and the summary and drops the noise. It prints an id; if you
need a detail it dropped, fetch it instead of re-running the command:

    npx gistline grep <id> "TypeError"
    npx gistline slice <id> --from-line 4300 --lines 40
```

That's the whole integration. It works with **Claude Code, Cursor, Codex, Copilot CLI, Aider** —
anything that reads a project instruction file and can run a shell command.

### Or connect it as an MCP server

If your tool supports MCP (Claude Code, Claude Desktop, Cursor, Codex), gistline can be a tool the
assistant calls directly — no shell, no piping:

```json
{
  "mcpServers": {
    "gistline": { "command": "npx", "args": ["-y", "-p", "gistline", "gistline-mcp"] }
  }
}
```

That gives the assistant four tools: `compress`, and `retrieve` / `slice` / `grep` for pulling back
anything compression dropped. **It's completely stateless** — nothing is held between calls, so it's
safe to restart at any time, and an id stays valid because it's a hash of the content rather than a
session handle.

## Nothing is lost

Add `--store` and gistline keeps the full original on disk. It prints an id, and you can pull back
exactly the part you want:

```bash
npm test 2>&1 | npx gistline --store
# [npm test output compressed: 96443 → 2284 chars.
#  Full output retained as id dd0fd19eb38f9210 — retrieve, slice, or grep it.]

npx gistline grep    dd0fd19eb38f9210 "FATAL"
npx gistline slice   dd0fd19eb38f9210 --from-line 4300 --lines 40
npx gistline retrieve dd0fd19eb38f9210          # the whole thing
```

Asking for *one region* is usually what you want — and it's far cheaper than re-running a slow test
suite just to see a line you missed.

## All the options

```bash
npx gistline --help
```

| Option | What it does |
|---|---|
| `--budget 4000` | how many characters to keep (default 4000) |
| `--max-tokens 1000` | budget in tokens instead of characters |
| `--label "npm test"` | name the output, so the note tells you where it came from |
| `--store` | keep the original so you can retrieve it later |
| `--kind test` | force a strategy instead of auto-detecting |
| `--file build.log` | read a file instead of piped input |
| `--stats` | print how much was saved |
| `--json` | machine-readable output |

## Using it in code

```js
import { gist } from "gistline";

const result = gist(hugeTestLog, { budget: 4000, label: "npm test" });
result.text;   // the shortened output, with a note at the top
result.ratio;  // 0.024
```

Individual strategies (`compressTest`, `compressDiff`, `compressJson`, `compressStacktrace`,
`compressLog`) are exported too, if you want to build something on top.

## What it won't do

It's honest about its limits, because a tool you can't trust is worse than no tool:

- It **shortens**, it doesn't summarise. There's no AI inside — it's pattern matching, which means
  it's fast, free, and gives the same answer every time.
- It can't know which line *you* care about. It keeps failures and errors; if you need something
  else, that's what `--store` and `grep` are for.
- Token counts are an **estimate**. Close enough to budget with, not for billing.

## Why you can trust it in a build

No dependencies at all — nothing to install, nothing that can break or go stale. Runs anywhere Node
18+ runs. Tested on Linux, macOS and Windows across Node 18, 20 and 22.

## License

MIT © Majid Bilal
