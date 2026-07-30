import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gist, estimateTokens, charsForTokens } from "./index.mjs";
import { openStore, idFor } from "./store.mjs";

const freshStore = (opts = {}) => openStore({ dir: mkdtempSync(join(tmpdir(), "gistline-store-")), ...opts });

function bigLog(lines = 3000) {
  return Array.from({ length: lines }, (_, i) => `info: routine step ${i} finished without incident`).join("\n");
}

// --- the retrieval promise ------------------------------------------------------------------

test("without a store, the note promises only what it can deliver", () => {
  const res = gist(bigLog(), { budget: 800 });
  assert.equal(res.retrievalId, null);
  assert.match(res.note, /request the verbatim output/);
  assert.ok(!/retained as id/.test(res.note));
});

test("with a store, the original is actually retrievable", () => {
  const store = freshStore();
  try {
    const raw = bigLog();
    const res = gist(raw, { budget: 800, store, label: "npm test" });
    assert.ok(res.retrievalId, "a retrieval id must be issued");
    assert.match(res.note, /retained as id/);
    assert.equal(store.get(res.retrievalId), raw, "the stored original must be byte-identical");
  } finally { store.clear(); }
});

test("identical output is stored once (content-addressed)", () => {
  const store = freshStore();
  try {
    const raw = bigLog();
    const a = gist(raw, { budget: 800, store });
    const b = gist(raw, { budget: 800, store });
    assert.equal(a.retrievalId, b.retrievalId);
    assert.equal(store.stats().entries, 1);
    assert.equal(a.retrievalId, idFor(raw));
  } finally { store.clear(); }
});

test("slice retrieves the part the caller actually wants", () => {
  const store = freshStore();
  try {
    const res = gist(bigLog(), { budget: 500, store });
    const slice = store.slice(res.retrievalId, { fromLine: 100, lines: 3 });
    assert.deepEqual(slice.split("\n"), [
      "info: routine step 99 finished without incident",
      "info: routine step 100 finished without incident",
      "info: routine step 101 finished without incident",
    ]);
    assert.equal(store.slice(res.retrievalId, { chars: 12 }).length, 12);
  } finally { store.clear(); }
});

test("grep finds dropped detail in the original, with line numbers", () => {
  const store = freshStore();
  try {
    const raw = `${bigLog(500)}\nFATAL: disk full at block 42\n${bigLog(500)}`;
    const res = gist(raw, { budget: 400, store });
    const hits = store.grep(res.retrievalId, /FATAL/);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].line, 501);
    assert.match(hits[0].text, /disk full at block 42/);
  } finally { store.clear(); }
});

test("retrieval fails safely for unknown, malformed, or pruned ids", () => {
  const store = freshStore();
  try {
    assert.equal(store.get("deadbeefdeadbeef"), null);
    assert.equal(store.get("../../etc/passwd"), null, "path traversal must be rejected");
    assert.equal(store.get(null), null);
    assert.equal(store.slice("nope"), null);
    assert.equal(store.grep("nope", /x/), null);
    assert.equal(store.has("nope"), false);
  } finally { store.clear(); }
});

test("a store failure degrades compression instead of breaking it", () => {
  // A store whose directory cannot be created: compression must still succeed.
  const broken = openStore({ dir: "\0invalid\0path" });
  const res = gist(bigLog(), { budget: 600, store: broken });
  assert.equal(res.compressed, true);
  assert.equal(res.retrievalId, null);
  assert.match(res.note, /request the verbatim output/, "it must not claim a retrieval it cannot honour");
});

test("prune keeps the store bounded", () => {
  const store = freshStore({ maxEntries: 3 });
  try {
    for (let i = 0; i < 8; i++) store.put(`original number ${i}`);
    assert.ok(store.stats().entries <= 3, `expected ≤3 entries, got ${store.stats().entries}`);
  } finally { store.clear(); }
});

// --- token awareness -----------------------------------------------------------------------

test("token estimation is closer than chars/4 on code", () => {
  const code = `const x = {a:1,b:[2,3]}; if (x.a !== 1) { throw new Error("bad"); }`;
  const naive = Math.ceil(code.length / 4);
  const est = estimateTokens(code);
  assert.ok(est > naive, `code is token-dense: estimate ${est} should exceed naive ${naive}`);
});

test("token estimation stays sane on prose and empty input", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  const prose = "the quick brown fox jumps over the lazy dog";
  const est = estimateTokens(prose);
  assert.ok(est >= 9 && est <= 20, `expected roughly one token per word, got ${est}`);
});

test("a token budget is honoured and reported", () => {
  const res = gist(bigLog(), { maxTokens: 200 });
  assert.equal(res.compressed, true);
  assert.ok(res.compressedChars <= charsForTokens(200));
  assert.ok(res.compressedTokens < res.originalTokens);
  assert.ok(res.originalTokens > 0);
});

test("maxTokens takes precedence over budget", () => {
  const tight = gist(bigLog(), { budget: 100000, maxTokens: 100 });
  assert.equal(tight.compressed, true, "the token budget must win over a generous char budget");
});

test("results always report both chars and tokens", () => {
  for (const opts of [{ budget: 500 }, { maxTokens: 100 }, { budget: 10_000_000 }]) {
    const res = gist(bigLog(), opts);
    for (const k of ["originalChars", "compressedChars", "originalTokens", "compressedTokens"]) {
      assert.equal(typeof res[k], "number", `${k} missing for ${JSON.stringify(opts)}`);
    }
  }
});
