import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "mcp.mjs");

/**
 * Send a batch of JSON-RPC requests to a FRESH server process and collect the replies.
 *
 * Deliberately one process per call in most tests: if the server were stateful, reusing a process
 * would hide it. Starting fresh proves each request stands alone.
 */
function rpc(requests, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", () => {
      const lines = out.split("\n").filter((l) => l.trim());
      try {
        resolve({ replies: lines.map((l) => JSON.parse(l)), stderr: err });
      } catch (e) {
        reject(new Error(`unparseable output: ${out.slice(0, 300)} / stderr: ${err.slice(0, 300)}`));
      }
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    child.stdin.end();
  });
}

const req = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const call = (id, name, args) => req(id, "tools/call", { name, arguments: args });
const bigLog = (n = 2000) =>
  ["TAP version 13",
    ...Array.from({ length: n }, (_, i) => `ok ${i + 1} - assertion ${i + 1} fine`),
    "not ok 2001 - the real failure",
    "  code: 'ERR_ASSERTION'",
    "# fail 1"].join("\n");

// --- handshake, both spec generations --------------------------------------------------------

test("supports the pre-2026 initialize handshake", async () => {
  const { replies } = await rpc([req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })]);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].result.protocolVersion, "2025-06-18", "must echo a version it supports");
  assert.equal(replies[0].result.serverInfo.name, "gistline");
  assert.ok(replies[0].result.capabilities.tools);
});

test("implements server/discover, required by the 2026-07-28 spec", async () => {
  const { replies } = await rpc([req(1, "server/discover")]);
  const r = replies[0].result;
  assert.ok(Array.isArray(r.protocolVersions) && r.protocolVersions.includes("2026-07-28"));
  assert.equal(r.serverInfo.name, "gistline");
});

test("an unknown requested version falls back rather than failing", async () => {
  const { replies } = await rpc([req(1, "initialize", { protocolVersion: "1999-01-01" })]);
  assert.ok(replies[0].result.protocolVersion, "must still negotiate something");
});

test("works with NO handshake at all, as the 2026 spec requires", async () => {
  // Every request is self-contained; a client may go straight to tools/call.
  const { replies } = await rpc([call(1, "compress", { text: bigLog(), budget: 800 })]);
  assert.ok(replies[0].result.content[0].text.includes("not ok 2001"));
});

test("initialized notification is accepted and draws no reply", async () => {
  const { replies } = await rpc([
    req(1, "initialize", { protocolVersion: "2025-06-18" }),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    req(2, "tools/list"),
  ]);
  assert.deepEqual(replies.map((r) => r.id), [1, 2], "a notification must produce no response");
});

// --- tool surface ----------------------------------------------------------------------------

test("tools/list advertises every tool with a schema and a real description", async () => {
  const { replies } = await rpc([req(1, "tools/list")]);
  const tools = replies[0].result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["compress", "grep", "retrieve", "slice"]);
  for (const t of tools) {
    assert.ok(t.description.length > 40, `${t.name} needs a description an agent can act on`);
    assert.equal(t.inputSchema.type, "object");
    assert.ok(Array.isArray(t.inputSchema.required) && t.inputSchema.required.length);
  }
});

test("compress keeps the failure and reports the numbers", async () => {
  const { replies } = await rpc([call(1, "compress", { text: bigLog(), budget: 900, label: "npm test" })]);
  const out = replies[0].result.content[0].text;
  assert.match(out, /not ok 2001 - the real failure/);
  assert.match(out, /# fail 1/);
  assert.match(out, /% smaller/, "the agent should see how much was dropped");
  assert.match(out, /kind=test/);
  assert.ok(!replies[0].result.isError);
});

test("compress honours a token budget", async () => {
  const { replies } = await rpc([call(1, "compress", { text: bigLog(), maxTokens: 120 })]);
  assert.match(replies[0].result.content[0].text, /tokens/);
});

test("output under budget is returned unchanged and says so", async () => {
  const { replies } = await rpc([call(1, "compress", { text: "all good", budget: 4000 })]);
  const out = replies[0].result.content[0].text;
  assert.match(out, /under budget/);
  assert.match(out, /all good/);
});

// --- statelessness ---------------------------------------------------------------------------

test("an id from ONE process is retrievable by a DIFFERENT process", async () => {
  // The core statelessness claim: no session, no in-memory cache. Ids are content hashes on disk.
  const dir = mkdtempSync(join(tmpdir(), "gl-mcp-"));
  try {
    const a = await rpc([call(1, "compress", { text: bigLog(), budget: 700, store: true })], { GISTLINE_STORE: dir });
    const id = /id=([0-9a-f]+)/.exec(a.replies[0].result.content[0].text)?.[1];
    assert.ok(id, "compress(store) must return an id");

    // A brand-new process — nothing shared but the directory.
    const b = await rpc([call(1, "grep", { id, pattern: "ERR_ASSERTION" })], { GISTLINE_STORE: dir });
    assert.match(b.replies[0].result.content[0].text, /ERR_ASSERTION/);

    const c = await rpc([call(1, "slice", { id, fromLine: 1, lines: 1 })], { GISTLINE_STORE: dir });
    assert.match(c.replies[0].result.content[0].text, /TAP version 13/);

    const d = await rpc([call(1, "retrieve", { id })], { GISTLINE_STORE: dir });
    assert.ok(d.replies[0].result.content[0].text.length > 10000, "the whole original comes back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated identical calls give identical results", async () => {
  const first = await rpc([call(1, "compress", { text: bigLog(), budget: 800 })]);
  const second = await rpc([call(1, "compress", { text: bigLog(), budget: 800 })]);
  assert.equal(
    first.replies[0].result.content[0].text,
    second.replies[0].result.content[0].text,
    "a stateless, pure server must be deterministic across processes",
  );
});

// --- errors are results, and the server survives them ----------------------------------------

test("a missing id is a tool error, not a crash", async () => {
  const { replies } = await rpc([
    call(1, "retrieve", { id: "deadbeefdeadbeef" }),
    req(2, "tools/list"),
  ]);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /No original held/);
  assert.equal(replies[1].result.tools.length, 4, "the server must still be serving");
});

test("missing required arguments are reported clearly", async () => {
  const { replies } = await rpc([
    call(1, "compress", {}),
    call(2, "grep", { id: "abc" }),
  ]);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /requires `text`/);
  assert.equal(replies[1].result.isError, true);
  assert.match(replies[1].result.content[0].text, /requires `id` and `pattern`/);
});

test("an invalid regex is reported instead of throwing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gl-mcp-"));
  try {
    const a = await rpc([call(1, "compress", { text: bigLog(), budget: 700, store: true })], { GISTLINE_STORE: dir });
    const id = /id=([0-9a-f]+)/.exec(a.replies[0].result.content[0].text)[1];
    const b = await rpc([call(1, "grep", { id, pattern: "([unclosed" })], { GISTLINE_STORE: dir });
    assert.equal(b.replies[0].result.isError, true);
    assert.match(b.replies[0].result.content[0].text, /Invalid pattern/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown tools and methods return proper JSON-RPC errors", async () => {
  const { replies } = await rpc([
    call(1, "nonsense", {}),
    req(2, "nonsense/method"),
  ]);
  assert.equal(replies[0].error.code, -32602);
  assert.match(replies[0].error.message, /Unknown tool/);
  assert.equal(replies[1].error.code, -32601);
});

test("malformed input does not take the server down", async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.write("this is not json\n");
  child.stdin.write("{\"jsonrpc\":\"1.0\",\"method\":\"x\",\"id\":9}\n"); // wrong version
  child.stdin.write(`${JSON.stringify(req(3, "tools/list"))}\n`);
  child.stdin.end();
  await new Promise((r) => child.on("close", r));

  const replies = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(replies[0].error.code, -32700, "parse error");
  assert.equal(replies[1].error.code, -32600, "invalid request");
  assert.equal(replies[2].result.tools.length, 4, "still alive and serving");
});

test("resources and prompts return empty lists so clients do not log errors", async () => {
  const { replies } = await rpc([req(1, "resources/list"), req(2, "prompts/list")]);
  assert.deepEqual(replies[0].result.resources, []);
  assert.deepEqual(replies[1].result.prompts, []);
});

test("nothing is written to stderr during normal use", async () => {
  const { stderr } = await rpc([req(1, "tools/list"), call(2, "compress", { text: "x", budget: 4000 })]);
  assert.equal(stderr.trim(), "", "stderr noise corrupts some hosts' logs");
});
