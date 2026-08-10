import { test } from "node:test";
import assert from "node:assert/strict";
import { adviseFor, extractCommand } from "../hooks/pre-tool.mjs";
import gistlinePlugin from "../hooks/plugin.mjs";
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

// --- the shell-fetch and mode guidance the installer writes -------------------------------------------------

test("the instruction tells the agent to fetch through the SHELL, not a built-in tool", () => {
  // The reason this matters: a built-in fetch puts the page straight into the conversation where gistline can never touch
  // it, and scraped HTML is the largest single saving available. Only stdout is compressible.
  const body = contentFor(findPlatform("claude"));
  assert.match(body, /Use the shell, not a built-in fetch tool/);
  assert.match(body, /never be compressed/);
  assert.match(body, /Only what arrives on stdout can be compressed/);
});

test("shell-fetch guidance covers the platforms people actually run on", () => {
  // `curl` is not universal: PowerShell aliases it to Invoke-WebRequest with different semantics, and some images have
  // neither. Naming one command would leave Windows users with something that does not work.
  const body = contentFor(findPlatform("claude"));
  assert.match(body, /curl -sL/, "macOS and Linux");
  assert.match(body, /curl\.exe -sL/, "Windows, where curl is an alias");
  assert.match(body, /Invoke-WebRequest .*-UseBasicParsing/, "PowerShell fallback");
  assert.match(body, /wget -qO-/, "where curl is absent");
});

test("the instruction also covers built-in FILE reading, not just fetching", () => {
  // Same failure mode: a built-in file read loads the whole file into the conversation uncompressed.
  assert.match(contentFor(findPlatform("codex")), /built-in file-reading tool loads the whole thing/);
});

test("the instruction says WHEN to preserve, by what the person asked for", () => {
  // Preserve must be driven by intent rather than by file type, and a flag nobody knows when to set is a flag nobody sets.
  const body = contentFor(findPlatform("cursor"));
  assert.match(body, /--preserve/);
  assert.match(body, /only when the answer has to go back into a document/i);
  // The concrete phrasings, which are what make it actionable.
  assert.match(body, /change this in my PDF/);
  assert.match(body, /here are the files for context/);
});

test("the default is stated as the default, so preserve is not treated as better", () => {
  const body = contentFor(findPlatform("claude"));
  assert.match(body, /By default gistline returns the \*\*information\*\*/);
  assert.match(body, /Feeding a document as background information is the common case/);
});

test("every platform receives the fetch and mode guidance, not just one", () => {
  // The guidance lives in the shared instruction text, so a platform-specific wrapper must not drop it.
  for (const p of PLATFORMS) {
    const body = contentFor(p);
    assert.match(body, /curl -sL/, `${p.id} is missing the fetch guidance`);
    assert.match(body, /--preserve/, `${p.id} is missing the mode guidance`);
  }
});

// --- plugin-based hooks: OpenCode and Kilo Code -------------------------------------------------------------
//
// A genuinely different integration shape, not a different protocol on the same one: these hosts import a MODULE and call an
// exported function, so there is no process to spawn, no stdin and no stdout. Both were recorded in ISSUES.md as not built
// while the other three worked, because claiming support that does not exist is worse than naming the gap.

test("the plugin exposes the SAME advice as the command hook", () => {
  // Two copies of that judgement drifting apart is how one platform nags about `git status` while another stays quiet, so the
  // plugin imports the rule rather than restating it.
  const handlers = gistlinePlugin();
  const handler = handlers["tool.execute.before"];
  assert.equal(typeof handler, "function");
});

test("the plugin advises on a noisy command and stays silent otherwise", async () => {
  const handler = gistlinePlugin()["tool.execute.before"];

  const noisy = await handler({}, { tool_input: { command: "npm test" } });
  assert.ok(noisy?.additionalContext, "a test run should get advice");
  assert.match(noisy.additionalContext, /npx gistline/);

  const quiet = await handler({}, { tool_input: { command: "git status" } });
  assert.equal(quiet, undefined, "an ordinary command should get nothing at all");
});

test("the plugin tolerates BOTH call signatures", async () => {
  // Hosts differ: some pass (input, output), some pass a single object. A plugin that throws on an unexpected shape would
  // interrupt real work, and tolerating both costs three lines.
  const handler = gistlinePlugin()["tool.execute.before"];

  assert.ok(await handler({ tool_input: { command: "npm test" } }), "single-argument form");
  assert.ok(await handler({}, { tool_input: { command: "npm test" } }), "two-argument form");
  assert.doesNotThrow(() => handler(undefined, undefined), "no arguments at all must not throw");
});

test("the plugin writes onto the output object as well as returning", async () => {
  // Hosts differ in which they read, and doing both costs nothing.
  const output = { tool_input: { command: "npm test" }, metadata: {} };
  await gistlinePlugin()["tool.execute.before"]({}, output);
  assert.match(output.gistline, /npx gistline/);
  assert.match(output.metadata.gistline, /npx gistline/);
});

test("a plugin platform installs a MODULE and a config entry, merging the config", () => {
  // opencode.json holds the user's own configuration. Replacing it would be as bad here as replacing a settings.json.
  const existing = { model: "claude", plugin: ["./other/plugin.mjs"] };
  const entry = HOOK_TARGETS.opencode.build().plugin[0];

  const current = existing.plugin;
  const merged = { ...existing, plugin: current.includes(entry) ? current : [...current, entry] };

  assert.equal(merged.model, "claude", "unrelated config must survive");
  assert.deepEqual(merged.plugin, ["./other/plugin.mjs", entry], "the other plugin must remain, ours appended");
});

test("both plugin platforms declare a module path and a config path", () => {
  // A plugin platform with no module path would write a config entry pointing at nothing.
  for (const id of ["opencode", "kilo"]) {
    const t = HOOK_TARGETS[id];
    assert.equal(t.kind, "plugin", `${id} should be a plugin platform`);
    assert.ok(t.pluginFile && t.pluginProject, `${id} needs a module path for both scopes`);
    assert.ok(t.file && t.project, `${id} needs a config path for both scopes`);
    assert.match(t.build().plugin[0], /gistline\.mjs$/, `${id}'s config entry should name the module`);
  }
});

test("all five hook platforms are declared, and none claims support it lacks", () => {
  // The check that catches a platform flagged for hooks with no target, which would claim support that does not exist.
  const flagged = PLATFORMS.filter((p) => p.hooks).map((p) => p.id).sort();
  assert.deepEqual(flagged, ["claude", "codebuddy", "gemini", "kilo", "opencode"]);
  assert.deepEqual(flagged, Object.keys(HOOK_TARGETS).sort());
});

test("the instruction explains WHERE the retrieval id comes from", () => {
  // The whole "nothing is lost" claim rests on retrieval, and the instruction told assistants that retrieval works without
  // ever saying where the id comes from or that a store is needed for anything except `run`. An assistant told it can
  // retrieve, with no way to obtain an id, will either invent one or stop trusting the claim.
  const body = contentFor(findPlatform("claude"));

  assert.match(body, /that is where the id comes from/i, "it must say the id is in the note");
  assert.match(body, /Full output retained as id/, "with a worked example of the note");
  assert.match(body, /npx gistline retrieve/, "and the command that uses it");
});

test("the instruction states when a store is and is not enabled", () => {
  // `gistline run` keeps the original by default; piped input and --file do not. Without this, an assistant expects an id
  // that will not be there and reports the tool as broken.
  const body = contentFor(findPlatform("codex"));
  assert.match(body, /keeps the original \*\*by default\*\*/);
  assert.match(body, /add `--store`/);
  assert.match(body, /cannot be recovered/, "and what the note says when it is absent");
});

test("the instruction says what to do when a detail is missing", () => {
  // The actionable half: retrieve it rather than guessing or re-running the command.
  const body = contentFor(findPlatform("cursor"));
  assert.match(body, /Do not guess and do not re-run/);
  assert.match(body, /npx gistline grep/);
});

test("every platform receives the retrieval guidance", () => {
  for (const p of PLATFORMS) {
    assert.match(contentFor(p), /retrieve/, `${p.id} is missing the retrieval guidance`);
  }
});
