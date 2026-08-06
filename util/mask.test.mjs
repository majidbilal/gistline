import { test } from "node:test";
import assert from "node:assert/strict";
import { mask, unmask, slotCount, anchorTokens } from "./mask.mjs";

// Masking.
//
// The contract is one property: `unmask(mask(x)) === x`, for every line. Everything else is a compression concern; this
// is the correctness concern, and a masker that fails it is a deleter with better manners.

const rt = (line) => { const { template, values } = mask(line); return unmask(template, values); };

// --- the property ----------------------------------------------------------------------------------------

test("PROPERTY: unmask(mask(x)) === x for real log shapes", () => {
  const lines = [
    "2026-08-03T14:22:01Z INFO  [worker-3] processed 142 records in 1.8s",
    "2026-08-03 14:22:01.123 ERROR failed after 3 retries",
    "14:22:01 WARN disk at 91%",
    "GET /api/users/4821 200 18ms from 10.0.0.14:53312",
    'config loaded from /etc/app/settings.json key="db.host"',
    "req 550e8400-e29b-41d4-a716-446655440000 completed",
    "commit 9f2c1ab4e5d6f7a8b9c0d1e2f3a4b5c6d7e8f9a0 pushed",
    "C:\\Users\\dev\\project\\src\\index.mjs:12:3",
    "no variables here at all",
    "",
    "   leading and trailing   ",
    "0",
    "007 leading zeros must survive",
    "3.14159 and 1e5 and 0x1F",
    "a".repeat(300),
  ];
  for (const line of lines) {
    assert.equal(rt(line), line, `failed to round-trip: ${JSON.stringify(line)}`);
  }
});

test("captured values are RAW TEXT, never parsed", () => {
  // `007`, `7` and `7.0` all mask to `<n>`. If the capture were parsed, `007` would return as `7` — the same defect the
  // table work hit, and one the design document for this feature originally contained.
  const { values } = mask("id 007 took 7.0s and 7 tries");
  assert.ok(values.includes("007"), `expected raw "007", got ${JSON.stringify(values)}`);
  assert.equal(rt("id 007 took 7.0s and 7 tries"), "id 007 took 7.0s and 7 tries");
});

// --- ordering, which is part of the contract -------------------------------------------------------------

test("a timestamp is masked as one unit, not shredded into numbers", () => {
  // `<n>` must not reach a timestamp's digits first. If it did, one timestamp would become six separate values and the
  // template would be unrecognisable across lines — destroying the grouping the whole transform depends on.
  const { template, values } = mask("2026-08-03T14:22:01Z done");
  assert.equal(template, "<ts> done");
  assert.deepEqual(values, ["2026-08-03T14:22:01Z"]);
});

test("a path containing digits survives whole", () => {
  const { template } = mask("reading /var/log/app2/run7.log now");
  assert.equal(template, "reading <path> now");
});

test("a UUID is one value, not five hex runs", () => {
  const { template, values } = mask("req 550e8400-e29b-41d4-a716-446655440000 ok");
  assert.equal(template, "req <id> ok");
  assert.equal(values.length, 1);
});

test("short hex-looking words are not mistaken for ids", () => {
  // `beef` is 4 chars; the id pattern needs 8+. Masking real words would make templates match lines that differ.
  assert.equal(mask("the beef was dead").template, "the beef was dead");
});

// --- anchor tokens: the grouping key ---------------------------------------------------------------------

test("anchors skip placeholders, because the first token is almost always <ts>", () => {
  // The original design keyed on the first token. After masking, nearly every log line begins with `<ts>`, so that key
  // carried no information and grouping collapsed. Anchors are the literal words that identify a format.
  assert.deepEqual(anchorTokens("<ts> INFO [worker-<n>] processed <n> records"), ["INFO", "[worker-<n>]", "processed"]);
  assert.deepEqual(anchorTokens("<ts> <ts> <n>"), []);
});

test("anchors stop at the requested count and tolerate short lines", () => {
  assert.deepEqual(anchorTokens("a b c d e", 3), ["a", "b", "c"]);
  assert.deepEqual(anchorTokens("only", 3), ["only"]);
  assert.deepEqual(anchorTokens("", 3), []);
});

test("slotCount says how many values a template needs", () => {
  assert.equal(slotCount("<ts> INFO <n> records"), 2);
  assert.equal(slotCount("no slots"), 0);
  assert.equal(slotCount("<ts><n><id>"), 3);
});

test("slotCount matches the values mask produced, or unmask would misalign", () => {
  for (const line of [
    "2026-08-03T14:22:01Z INFO 142 records",
    "GET /api/x 200 18ms from 10.0.0.1",
    'key="value" at 14:22:01',
  ]) {
    const { template, values } = mask(line);
    assert.equal(slotCount(template), values.length, line);
  }
});

// --- efficiency: no catastrophic backtracking ------------------------------------------------------------

test("pathological input does not hang the masker", () => {
  // A hung regex on a large log is a hung build, which is worse than no compression. These shapes are the classic
  // backtracking traps: long runs of near-matches with no terminator.
  const traps = [
    '"'.repeat(2000),
    "/".repeat(2000),
    `${"1".repeat(5000)}`,
    `${"a:".repeat(3000)}`,
    `${"0x".repeat(3000)}`,
  ];
  for (const t of traps) {
    const started = Date.now();
    const out = rt(t);
    const ms = Date.now() - started;
    assert.equal(out, t, "pathological input must still round-trip");
    assert.ok(ms < 1000, `masking took ${ms}ms on a pathological input`);
  }
});
