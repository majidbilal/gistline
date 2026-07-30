import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gist, detectKind, compressTest, compressDiff, compressJson,
  compressStacktrace, compressLog, headTail, makeGistStats, formatGistStats,
  DEFAULT_BUDGET,
} from "./index.mjs";

// `gist` is the public entry point; the alias keeps these tests readable.
const compressOutput = gist;
const makeCompressionStats = makeGistStats;
const formatCompressionStats = formatGistStats;

/** A realistic node:test run: thousands of passes, one failure that is the only thing that matters. */
function bigTestLog() {
  const pass = Array.from({ length: 900 }, (_, i) => `ok ${i + 1} - some passing assertion number ${i + 1}`);
  return [
    "TAP version 13",
    ...pass.slice(0, 450),
    "not ok 451 - readiness gate blocks finalize",
    "  ---",
    "  error: 'expected NOT_READY but finalize succeeded'",
    "  code: 'ERR_ASSERTION'",
    "  ...",
    ...pass.slice(450),
    "# tests 901",
    "# pass 900",
    "# fail 1",
  ].join("\n");
}

test("detectKind classifies the shapes that matter", () => {
  assert.equal(detectKind('{"a":1}'), "json");
  assert.equal(detectKind("diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b"), "diff");
  assert.equal(detectKind(bigTestLog()), "test");
  assert.equal(detectKind("TypeError: x is not a function\n    at foo (/a/b.js:1:1)"), "stacktrace");
  assert.equal(detectKind("just some words about nothing"), "log");
});

test("test compression keeps the FAILURE and the summary, drops the passes", () => {
  const raw = bigTestLog();
  const res = compressOutput(raw, { budget: 2000, label: "npm test" });
  assert.equal(res.compressed, true);
  assert.ok(res.compressedChars < raw.length / 5, `expected big reduction, got ${res.ratio}`);
  // The whole point: the signal survives.
  assert.match(res.text, /not ok 451 - readiness gate blocks finalize/);
  assert.match(res.text, /expected NOT_READY but finalize succeeded/);
  assert.match(res.text, /# fail 1/);
  assert.match(res.text, /passing lines omitted/);
  assert.ok(!/ok 700 - some passing assertion/.test(res.text), "passing noise should be gone");
});

test("compression never exceeds its budget", () => {
  for (const budget of [500, 1200, 4000]) {
    const res = compressOutput(bigTestLog(), { budget });
    assert.ok(res.compressedChars <= budget, `budget ${budget} exceeded: ${res.compressedChars}`);
  }
});

test("short output is passed through untouched", () => {
  const res = compressOutput("all good", { budget: 100 });
  assert.equal(res.compressed, false);
  assert.equal(res.text, "all good");
  assert.equal(res.ratio, 1);
});

test("json compression preserves parseable SHAPE rather than truncating text", () => {
  const payload = JSON.stringify({
    users: Array.from({ length: 500 }, (_, i) => ({ id: i, name: `user${i}`, bio: "x".repeat(400) })),
    meta: { total: 500, nested: { deep: true } },
  });
  const out = compressJson(payload, 4000);
  // The output must be valid JSON as-is: markers are emitted as JSON strings, not raw text.
  const parsed = JSON.parse(out);
  assert.ok(parsed.users.length <= 4, "arrays must be sampled");
  assert.match(String(parsed.users.at(-1)), /more items/, "the omission must be visible in-band");
  assert.ok(parsed.users[0].bio.includes("chars]"), "long strings must be truncated with a marker");
  assert.equal(parsed.meta.total, 500, "structure and scalars must survive");
  assert.equal(parsed.meta.nested.deep, true);
  assert.ok(out.length < payload.length / 10);
});

test("json compression falls back safely on malformed json", () => {
  const broken = `{"a": ${"1,".repeat(3000)}`;
  const out = compressJson(broken, 500);
  assert.ok(out.length <= 500);
});

test("diff compression keeps file headers and changed lines", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,7 +10,7 @@",
    ...Array.from({ length: 300 }, (_, i) => ` unchanged context line ${i}`),
    "-const old = 1;",
    "+const next = 2;",
  ].join("\n");
  const out = compressDiff(diff, 4000);
  assert.match(out, /diff --git a\/src\/app\.ts/);
  assert.match(out, /-const old = 1;/);
  assert.match(out, /\+const next = 2;/);
  assert.match(out, /unchanged context lines omitted/);
  assert.ok(!/unchanged context line 150/.test(out));
});

test("stacktrace compression keeps our frames, drops library noise", () => {
  const trace = [
    "TypeError: cannot read property of undefined",
    "    at buildPlan (/repo/lib/planner.mjs:42:7)",
    "    at process (node:internal/process/task_queues:95:5)",
    "    at run (/repo/node_modules/some-lib/index.js:10:1)",
    "    at main (/repo/bin/teamify.mjs:12:3)",
  ].join("\n");
  const out = compressStacktrace(trace, 4000);
  assert.match(out, /buildPlan \(\/repo\/lib\/planner\.mjs/);
  assert.match(out, /main \(\/repo\/bin\/teamify\.mjs/);
  assert.ok(!/node:internal/.test(out));
  assert.ok(!/node_modules/.test(out));
  assert.match(out, /frames omitted/);
});

test("log compression prioritises salient lines over position", () => {
  const noise = Array.from({ length: 2000 }, (_, i) => `info: routine step ${i} completed`);
  const raw = [...noise.slice(0, 1000), "ERROR: database connection refused", ...noise.slice(1000)].join("\n");
  const out = compressLog(raw, 1500);
  assert.match(out, /ERROR: database connection refused/, "the error must survive even from the middle");
  assert.ok(out.length <= 1600);
});

test("the compression note tells the agent retrieval is possible", () => {
  const res = compressOutput("x".repeat(9000), { budget: 500, label: "build" });
  assert.match(res.note, /build output compressed/);
  assert.match(res.note, /verbatim/i, "an agent must know it can ask for the original");
});

test("headTail keeps both ends and reports the gap", () => {
  const out = headTail(`START${"x".repeat(5000)}END`, 800);
  assert.match(out, /^START/);
  assert.match(out, /END$/);
  assert.match(out, /chars omitted from the middle/);
  assert.ok(out.length <= 900);
});

test("stats make engagement checkable rather than assumed", () => {
  const stats = makeCompressionStats();
  stats.record(compressOutput(bigTestLog(), { budget: 1000 }));
  stats.record(compressOutput("tiny", { budget: 1000 }));
  const snap = stats.snapshot();
  assert.equal(snap.calls, 2);
  assert.equal(snap.compressedCalls, 1);
  assert.ok(snap.charsSaved > 0);
  assert.ok(snap.byKind.test.calls === 1);
  assert.match(formatCompressionStats(snap), /outputs compressed/);
  assert.match(formatCompressionStats(null), /no output/);
});

test("handles null, empty, and non-string input without throwing", () => {
  for (const v of [null, undefined, "", 12345]) {
    assert.doesNotThrow(() => compressOutput(v, { budget: DEFAULT_BUDGET }));
  }
});

test("TAP subtest announcements never masquerade as failures", () => {
  // Regression: test NAMES often contain "fail", "cannot", or "missing" because they describe what
  // is being tested. Those announcements must not be kept as salient — they crowded out the real
  // failures in a live run against this repo's own suite.
  const raw = [
    "TAP version 13",
    ...Array.from({ length: 300 }, (_, i) => [
      `# Subtest: auditor FAIL blocks the step when nothing is missing ${i}`,
      `ok ${i + 1} - auditor FAIL blocks the step when nothing is missing ${i}`,
    ]).flat(),
    "not ok 301 - the one real failure",
    "  error: 'genuinely broken'",
    "# tests 301",
    "# pass 300",
    "# fail 1",
  ].join("\n");

  const out = compressTest(raw, 2000);
  assert.match(out, /not ok 301 - the one real failure/);
  assert.match(out, /genuinely broken/);
  assert.match(out, /# fail 1/);
  assert.ok(!/# Subtest:/.test(out), "subtest announcements must be dropped as structural noise");
  assert.ok(out.length < 800, `expected a tight result, got ${out.length} chars`);
});

test("a passing line whose name contains a number and 'passed' is not mistaken for a summary", () => {
  // Regression: the summary matcher was unanchored, so "ok 5 - assertion 5 passed cleanly" matched
  // "\d+ passed" and was kept as summary. Found by running against a real failing command.
  const raw = [
    "TAP version 13",
    ...Array.from({ length: 200 }, (_, i) => `ok ${i + 1} - assertion ${i + 1} passed cleanly`),
    "not ok 201 - the real failure",
    "  code: 'ERR_ASSERTION'",
    "# tests 201",
    "# pass 200",
    "# fail 1",
  ].join("\n");

  const out = compressTest(raw, 4000);
  assert.ok(!/assertion \d+ passed cleanly/.test(out), "passing lines must not leak in as summary");
  assert.match(out, /not ok 201 - the real failure/);
  assert.match(out, /# fail 1/);
  assert.match(out, /200 passing lines omitted/);
});

test("mocha-style summary lines are still recognised", () => {
  const out = compressTest([
    ...Array.from({ length: 50 }, (_, i) => `  ✓ does a thing ${i}`),
    "  1) fails at the important thing",
    "  50 passing (1s)",
    "  1 failing",
  ].join("\n"), 4000);
  assert.match(out, /50 passing/);
  assert.match(out, /1 failing/);
});

test("a failure's diagnostic block is kept exactly once", () => {
  // Regression: the loop did not skip past a consumed block, so diagnostic lines matching the
  // salience pattern were appended a second time and the error appeared twice.
  const raw = [
    "not ok 1 - something broke",
    "  error: 'expected NOT_READY but finalize succeeded'",
    "  code: 'ERR_ASSERTION'",
    "ok 2 - fine",
  ].join("\n");
  const out = compressTest(raw, 4000);
  const occurrences = (out.match(/expected NOT_READY but finalize succeeded/g) ?? []).length;
  assert.equal(occurrences, 1, `diagnostic duplicated ${occurrences} times`);
});

test("multiple distinct failures are all kept", () => {
  const raw = [
    "not ok 1 - first failure",
    "  code: 'ERR_ONE'",
    "ok 2 - fine",
    "not ok 3 - second failure",
    "  code: 'ERR_TWO'",
    "# fail 2",
  ].join("\n");
  const out = compressTest(raw, 4000);
  assert.match(out, /first failure/);
  assert.match(out, /second failure/);
  assert.match(out, /ERR_ONE/);
  assert.match(out, /ERR_TWO/);
});
