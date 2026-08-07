import { test } from "node:test";
import assert from "node:assert/strict";
import { adviseFor, extractCommand } from "../hooks/pre-tool.mjs";
import { mergeHook, unmergeHook, HOOK_TARGETS, PLATFORMS, contentFor, findPlatform, spliceBlock, removeBlock } from "../install.mjs";

// The hook, and the installer's handling of shared files.
//
// The failure this guards against is not a crash. It is installing something that silently never fires, or overwriting a
// person's own configuration — both of which look like success at the time.

// --- what the hook advises on -------------------------------------------------------------------------------

test("fires on commands that really do produce large output", () => {
  for (const cmd of [
    "npm test", "pnpm run test", "node --test", "npx vitest run", "pytest -v",
    "npm ci", "make -j4", "cargo build --release", "git diff HEAD~1",
    "docker logs my-container", "cat build.log", "curl https://api.example.com/users",
  ]) {
    assert.ok(adviseFor(cmd), `should have advised on: ${cmd}`);
  }
});

test("stays SILENT on ordinary commands", () => {
  // A hook that fires on everything gets ignored, and an ignored hook is worse than none because it trains the reader to
  // skip the channel it speaks on.
  for (const cmd of ["ls", "cd src", "git status", "echo hello", "mkdir build", "node -v", "git commit -m x"]) {
    assert.equal(adviseFor(cmd), null, `should have stayed quiet on: ${cmd}`);
  }
});

test("stays silent when the command ALREADY uses gistline", () => {
  // Repeating advice that has been taken is noise, and noise is what gets a hook disabled.
  assert.equal(adviseFor("npm test 2>&1 | npx gistline --kind test"), null);
  assert.equal(adviseFor("npm test | gistline"), null);
});

test("stays silent when output is being discarded anyway", () => {
  assert.equal(adviseFor("npm test > /dev/null"), null);
  assert.equal(adviseFor("npm ci --silent"), null);
});

test("the advice names the right --kind for the command", () => {
  assert.match(adviseFor("npm test"), /--kind test/);
  assert.match(adviseFor("git diff"), /--kind diff/);
  assert.match(adviseFor("make all"), /--kind log/);
  // A file read has no reliable kind, so none is claimed rather than guessed.
  assert.ok(!/--kind/.test(adviseFor("cat notes.txt")));
});

test("the advice includes the original command, so it can be copied", () => {
  assert.match(adviseFor("pnpm run test:unit"), /pnpm run test:unit 2>&1 \| npx gistline/);
});

// --- reading the payload ------------------------------------------------------------------------------------

test("the command is found in every shape a platform might send", () => {
  // A hook that knows only one nesting silently never fires on the others, which is indistinguishable from being broken.
  const shapes = [
    { tool_input: { command: "npm test" } },
    { toolInput: { command: "npm test" } },
    { input: { command: "npm test" } },
    { params: { command: "npm test" } },
    { arguments: { command: "npm test" } },
    { command: "npm test" },
    { tool_input: { script: "npm test" } },
    { somethingUnexpected: { cmd: "npm test" } },
  ];
  for (const s of shapes) {
    assert.equal(extractCommand(s), "npm test", `failed on ${JSON.stringify(s)}`);
  }
});

test("a payload with no command yields nothing rather than throwing", () => {
  // A hook that throws interrupts real work.
  for (const p of [{}, null, undefined, { tool_input: {} }, { tool_input: { command: "" } }]) {
    assert.equal(extractCommand(p), "");
    assert.equal(adviseFor(extractCommand(p)), null);
  }
});

// --- merging settings without destroying them ----------------------------------------------------------------

test("a hook MERGES into existing settings and destroys nothing", () => {
  // settings.json holds permissions, model choices and other tools' hooks. Replacing it would be the worst thing this
  // installer could do.
  const existing = {
    model: "opus",
    permissions: { allow: ["Bash(git:*)"] },
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "someone-elses-tool" }] }] },
  };
  const addition = HOOK_TARGETS.claude.build("node gistline-hook");
  const merged = mergeHook(existing, addition, "PreToolUse");

  assert.equal(merged.model, "opus", "unrelated settings must survive");
  assert.deepEqual(merged.permissions, existing.permissions);
  assert.equal(merged.hooks.PreToolUse.length, 2, "the other tool's hook must remain");
  assert.match(JSON.stringify(merged), /someone-elses-tool/);
  assert.match(JSON.stringify(merged), /gistline-hook/);
});

test("installing twice does not add the hook twice", () => {
  // Two identical hooks would run the advice twice, which reads like a bug.
  const addition = HOOK_TARGETS.claude.build("node gistline-hook");
  const once = mergeHook({}, addition, "PreToolUse");
  const twice = mergeHook(once, addition, "PreToolUse");
  assert.equal(twice.hooks.PreToolUse.length, 1);
});

test("removing the hook leaves everything else byte-identical", () => {
  const existing = { model: "opus", hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "other" }] }] } };
  const addition = HOOK_TARGETS.claude.build("node gistline-hook");

  const merged = mergeHook(existing, addition, "PreToolUse");
  const { settings, removed } = unmergeHook(merged, addition, "PreToolUse");

  assert.equal(removed, true);
  assert.deepEqual(settings, existing, "the file must return to exactly its prior state");
});

test("removing the only hook cleans up the empty keys", () => {
  // Leaving `{"hooks":{}}` behind is litter.
  const addition = HOOK_TARGETS.gemini.build("node gistline-hook");
  const merged = mergeHook({}, addition, "BeforeTool");
  const { settings } = unmergeHook(merged, addition, "BeforeTool");
  assert.deepEqual(settings, {});
});

test("each hook platform uses its OWN protocol shape", () => {
  // Three platforms, genuinely different shapes. Pretending they are the same would install something that never fires.
  const claude = HOOK_TARGETS.claude.build("x");
  const gemini = HOOK_TARGETS.gemini.build("x");

  assert.ok(claude.hooks.PreToolUse[0].hooks, "Claude nests a hooks array");
  assert.ok(gemini.hooks.BeforeTool[0].commands, "Gemini uses a commands array");
  assert.notDeepEqual(claude, gemini);
});

// --- the instruction files, revisited ------------------------------------------------------------------------

test("every platform produces content in the shape it can actually read", () => {
  for (const p of PLATFORMS) {
    const body = contentFor(p);
    assert.ok(body.length > 200, `${p.id}: content is suspiciously short`);

    if (p.kind === "skill") {
      assert.match(body, /^---\nname: gistline/m, `${p.id}: a skill needs frontmatter with a name`);
      assert.match(body, /description:/, `${p.id}: a skill needs a description or it is never loaded`);
    }
    if (p.id === "cursor") {
      assert.match(body, /alwaysApply: true/, "a Cursor rule without alwaysApply is never applied");
    }
    // The instruction must be written as moments, not as a description of the tool.
    assert.match(body, /Before reading/, `${p.id}: the instruction should say WHEN, not just what`);
  }
});

test("every platform has at least one place to write to", () => {
  for (const p of PLATFORMS) {
    assert.ok(p.user || p.project, `${p.id} has neither a user nor a project path`);
  }
});

test("a shared instruction file is spliced and restored exactly", () => {
  const original = "# Project rules\n\nUse tabs, not spaces.\n";
  const spliced = spliceBlock(original, "gistline guidance here");

  assert.match(spliced, /Use tabs, not spaces\./, "the project's own rules must survive");
  assert.match(spliced, /gistline guidance here/);

  const { text, removed } = removeBlock(spliced);
  assert.equal(removed, true);
  assert.equal(text, original, "removal must restore the file exactly");
});

test("re-splicing replaces the block rather than appending another", () => {
  const once = spliceBlock("# Rules\n", "first version");
  const twice = spliceBlock(once, "second version");
  assert.equal((twice.match(/gistline:start/g) ?? []).length, 1);
  assert.match(twice, /second version/);
  assert.ok(!twice.includes("first version"));
});

test("the hook platforms are exactly those flagged in the platform table", () => {
  // A platform flagged for hooks with no HOOK_TARGETS entry would claim support it does not have.
  const flagged = PLATFORMS.filter((p) => p.hooks).map((p) => p.id).sort();
  assert.deepEqual(flagged, Object.keys(HOOK_TARGETS).sort());
});
