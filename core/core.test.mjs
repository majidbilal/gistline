import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, estimateTokens, charsForTokens } from "./context.mjs";
import { runPipeline, validateTransform, wasLossy, appliedIds } from "./pipeline.mjs";

// The context and the pipeline.
//
// These two exist for measurable reasons — one parse instead of two, and stopping as soon as the budget is met — so the
// tests assert those properties directly rather than trusting the design.

const t = (id, opts = {}) => validateTransform({
  id,
  lossless: opts.lossless ?? true,
  truncatable: opts.truncatable ?? true,
  applies: opts.applies ?? (() => true),
  run: opts.run ?? ((ctx) => ({ text: ctx.text.slice(0, Math.floor(ctx.text.length / 2)), applied: true, reason: "halved" })),
});

// --- the context: compute once ---------------------------------------------------------------------------

test("parsed is computed once, not once per transform", () => {
  // The doubled parse was the concrete cost of the old architecture. Counting proves it is gone.
  let parses = 0;
  const original = JSON.parse;
  JSON.parse = (...a) => { parses += 1; return original(...a); };
  try {
    const ctx = createContext('{"a":1}');
    ctx.parsed; ctx.parsed; ctx.parsed;
    assert.equal(parses, 1, "three accesses must cost one parse");
  } finally {
    JSON.parse = original;
  }
});

test("a failed parse is not retried", () => {
  // A 40 MB log is not JSON. Paying for that discovery twice is the invisible cost this removes.
  let parses = 0;
  const original = JSON.parse;
  JSON.parse = (...a) => { parses += 1; return original(...a); };
  try {
    const ctx = createContext("not json at all");
    assert.equal(ctx.parsed, null);
    assert.equal(ctx.parsed, null);
    assert.equal(ctx.isJson, false);
    assert.equal(parses, 1, "a known-bad parse must not be attempted again");
  } finally {
    JSON.parse = original;
  }
});

test("nothing is computed until it is asked for", () => {
  // Lazy, not eager: a log input never needs `parsed`.
  let parses = 0;
  const original = JSON.parse;
  JSON.parse = (...a) => { parses += 1; return original(...a); };
  try {
    createContext('{"a":1}');
    assert.equal(parses, 0, "creating a context must not parse");
  } finally {
    JSON.parse = original;
  }
});

test("lines are computed once and carry the facts needed to rejoin", () => {
  const ctx = createContext("a\r\nb\r\n");
  assert.deepEqual(ctx.lines.lines, ["a", "b"]);
  assert.equal(ctx.lines.crlf, true);
  assert.equal(ctx.lines.trailing, true);
  assert.equal(ctx.lines, ctx.lines, "the same object must come back, not a fresh split");
});

test("token arithmetic has a floor, so a tiny budget still yields usable output", () => {
  assert.equal(charsForTokens(1), 200);
  assert.ok(estimateTokens("a".repeat(360)) === 100);
});

// --- the pipeline: order, stopping, and honesty ----------------------------------------------------------

test("STOP EARLY: a transform is not run once the budget is met", () => {
  // The efficiency win. Previously every strategy ran to completion regardless.
  const ran = [];
  const mark = (id) => t(id, { run: (ctx) => { ran.push(id); return { text: ctx.text.slice(0, 10), applied: true }; } });

  const ctx = createContext("x".repeat(100), { budget: 50 });
  runPipeline(ctx, [mark("first"), mark("second"), mark("third")]);

  assert.deepEqual(ran, ["first"], "the first transform met the budget; the rest must not run");
});

test("STOP EARLY: input already within budget runs nothing at all", () => {
  const ran = [];
  const ctx = createContext("small", { budget: 4000 });
  const out = runPipeline(ctx, [t("any", { run: () => { ran.push("any"); return { text: "", applied: true }; } })]);
  assert.deepEqual(ran, []);
  assert.equal(out.text, "small");
});

test("applies() is consulted before run(), so a useless transform costs a boolean", () => {
  let applied = 0;
  let ran = 0;
  const ctx = createContext("x".repeat(100), { budget: 10 });
  runPipeline(ctx, [t("skip", {
    applies: () => { applied += 1; return false; },
    run: () => { ran += 1; return { text: "", applied: true }; },
  })]);
  assert.equal(applied, 1);
  assert.equal(ran, 0, "run() must not be called when applies() is false");
});

test("ORDER IS THE ARCHITECTURE: transforms run in list order, so lossless-first is structural", () => {
  const order = [];
  const mark = (id) => t(id, {
    run: (ctx) => { order.push(id); return { text: ctx.text.slice(0, ctx.text.length - 1), applied: true }; },
  });
  const ctx = createContext("x".repeat(20), { budget: 5 });
  runPipeline(ctx, [mark("lossless-a"), mark("lossless-b"), mark("lossy-c")]);
  assert.deepEqual(order, ["lossless-a", "lossless-b", "lossy-c"]);
});

// --- failure containment ---------------------------------------------------------------------------------

test("a throwing transform is recorded and skipped, never fatal", () => {
  // A compressor that throws on unusual input is worse than one that declines: the caller loses the output entirely.
  const ctx = createContext("x".repeat(100), { budget: 10 });
  const out = runPipeline(ctx, [
    t("boom", { run: () => { throw new Error("kaboom"); } }),
    t("works", { run: (c) => ({ text: c.text.slice(0, 5), applied: true }) }),
  ]);
  assert.equal(out.text.length, 5, "the later transform still ran");
  const boom = ctx.applied.find((a) => a.id === "boom");
  assert.equal(boom.applied, false);
  assert.match(boom.reason, /kaboom/);
});

test("a throwing applies() is contained too", () => {
  const ctx = createContext("x".repeat(100), { budget: 10 });
  runPipeline(ctx, [t("bad", { applies: () => { throw new Error("nope"); } })]);
  assert.match(ctx.applied[0].reason, /applies\(\) threw: nope/);
});

test("a transform that makes text LARGER is rejected", () => {
  // The guarantee that lets transforms be called unconditionally.
  const ctx = createContext("x".repeat(50), { budget: 10 });
  const out = runPipeline(ctx, [t("inflate", { run: (c) => ({ text: c.text + "more", applied: true }) })]);
  assert.equal(out.text.length, 50, "growth must be discarded");
  assert.equal(ctx.applied[0].applied, false);
});

// --- truncatable: the latent corruption this closes -----------------------------------------------------

test("truncatable is false once a transform says its output must not be cut", () => {
  // The live bug: a blind final truncation cuts a table's rows in half, leaving output that looks structured and is
  // silently incomplete.
  const ctx = createContext("x".repeat(100), { budget: 10 });
  const out = runPipeline(ctx, [t("tabular", { truncatable: false, run: (c) => ({ text: c.text.slice(0, 40), applied: true }) })]);
  assert.equal(out.truncatable, false);
});

test("truncatable stays true when every applied transform allows cutting", () => {
  const ctx = createContext("x".repeat(100), { budget: 10 });
  const out = runPipeline(ctx, [t("plain", { truncatable: true, run: (c) => ({ text: c.text.slice(0, 40), applied: true }) })]);
  assert.equal(out.truncatable, true);
});

test("a DECLINED non-truncatable transform does not lock truncation", () => {
  // Only output that actually exists needs protecting.
  const ctx = createContext("x".repeat(100), { budget: 10 });
  const out = runPipeline(ctx, [t("tabular", { truncatable: false, applies: () => false })]);
  assert.equal(out.truncatable, true);
});

// --- reporting honestly ---------------------------------------------------------------------------------

test("wasLossy distinguishes 'nothing removed' from 'something dropped'", () => {
  // The distinction the old note could not express, and the one a reader most needs.
  const ctx = createContext("x".repeat(100), { budget: 10 });
  runPipeline(ctx, [
    t("tables", { lossless: true, run: (c) => ({ text: c.text.slice(0, 60), applied: true, reason: "nothing removed" }) }),
    t("drop", { lossless: false, run: (c) => ({ text: c.text.slice(0, 20), applied: true, reason: "40 lines dropped" }) }),
  ]);
  assert.equal(wasLossy(ctx.applied), true);
  assert.deepEqual(appliedIds(ctx.applied), ["tables", "drop"]);
});

test("a purely lossless run reports as not lossy", () => {
  const ctx = createContext("x".repeat(100), { budget: 10 });
  runPipeline(ctx, [t("tables", { lossless: true, run: (c) => ({ text: c.text.slice(0, 8), applied: true }) })]);
  assert.equal(wasLossy(ctx.applied), false);
});

test("a malformed transform is rejected at registration, not mid-run", () => {
  assert.throws(() => validateTransform({ id: "x" }), /missing or mistyped/);
  assert.throws(() => validateTransform({ id: "x", lossless: true, truncatable: true, applies: 1, run: 2 }), /applies, run/);
});
