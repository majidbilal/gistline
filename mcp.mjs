#!/usr/bin/env node
// gistline MCP server — lets an AI agent compress and retrieve output directly, without shelling out.
//
// Add to Claude Code / Cursor / Claude Desktop / Codex:
//   { "mcpServers": { "gistline": { "command": "npx", "args": ["-y", "gistline-mcp"] } } }
//
// ── STATELESS BY DESIGN ───────────────────────────────────────────────────────────────────────
// Nothing is held between requests: no session, no connection state, no in-memory cache. Every call
// is self-contained, so any process can serve any request and killing the server mid-conversation
// loses nothing. Retrieval works because ids are CONTENT HASHES on disk, not session handles — an id
// issued by one process resolves in any other. That is what makes the store compatible with
// statelessness rather than an exception to it.
//
// ── PROTOCOL ─────────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 over stdio, one message per line. Zero dependencies — no SDK.
//
// Two generations of the spec are supported deliberately:
//   * 2025-11-25 and earlier: `initialize` handshake, then tools/list + tools/call.
//   * 2026-07-28 (RC): no handshake; every request self-describes via `_meta`, and servers MUST
//     implement `server/discover`. Clients also use it as a stdio compatibility probe.
// Since our tools are pure functions, statelessness costs nothing and both generations work.

import { gist, estimateTokens, DEFAULT_BUDGET } from "./index.mjs";
import { openStore, DEFAULT_STORE_DIR } from "./store.mjs";

const NAME = "gistline";
const VERSION = "0.2.0";

/** Newest first. We echo the client's version when we know it, else advertise our preferred. */
const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const CAPABILITIES = { tools: { listChanged: false } };

const TOOLS = [
  {
    name: "compress",
    title: "Compress large output",
    description:
      "Shrink large command output while keeping what matters: test failures and the summary, your " +
      "own stack frames, JSON structure, and log lines that mention errors. Use this instead of " +
      "reading a long test/build log directly. Set store=true to keep the original so dropped " +
      "detail can be fetched later with grep/slice/retrieve.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The raw output to compress." },
        budget: { type: "integer", description: `Characters to keep (default ${DEFAULT_BUDGET}).` },
        maxTokens: { type: "integer", description: "Budget in estimated tokens instead of characters." },
        kind: {
          type: "string",
          enum: ["test", "diff", "json", "stacktrace", "listing", "log"],
          description: "Force a strategy. Omit to auto-detect.",
        },
        label: { type: "string", description: "What produced this output, e.g. 'npm test'." },
        store: { type: "boolean", description: "Keep the original so it can be retrieved later." },
      },
      required: ["text"],
    },
  },
  {
    name: "retrieve",
    title: "Retrieve a stored original",
    description: "Return the full original output for an id from a previous compress(store=true).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The id printed by compress." } },
      required: ["id"],
    },
  },
  {
    name: "slice",
    title: "Read part of a stored original",
    description:
      "Return a range of lines from a stored original. Prefer this over retrieve — after reading a " +
      "summary you usually want one region, not the whole thing.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        fromLine: { type: "integer", description: "1-based first line (default 1)." },
        lines: { type: "integer", description: "How many lines (default 200)." },
      },
      required: ["id"],
    },
  },
  {
    name: "grep",
    title: "Search a stored original",
    description:
      "Find lines matching a pattern in a stored original, with their line numbers. The cheapest way " +
      "to recover a specific detail that compression dropped.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        pattern: { type: "string", description: "Text or regular expression." },
        max: { type: "integer", description: "Maximum matches (default 100)." },
      },
      required: ["id", "pattern"],
    },
  },
];

// --- tool implementations -------------------------------------------------------------------
// Each opens the store fresh from a path, holding nothing between calls.

const storeFor = (dir) => openStore({ dir: dir || process.env.GISTLINE_STORE || DEFAULT_STORE_DIR });

const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
const failure = (s) => ({ content: [{ type: "text", text: String(s) }], isError: true });

const HANDLERS = {
  compress(args) {
    if (typeof args.text !== "string") return failure("compress requires `text` as a string.");
    const result = gist(args.text, {
      budget: Number.isFinite(args.budget) ? args.budget : DEFAULT_BUDGET,
      maxTokens: Number.isFinite(args.maxTokens) ? args.maxTokens : null,
      kind: args.kind ?? null,
      label: args.label ?? "",
      store: args.store ? storeFor(args.storeDir) : null,
    });
    // Report the numbers alongside the text so the agent can see what it is working with.
    const header = result.compressed
      ? `[${result.originalChars} -> ${result.compressedChars} chars (${Math.round((1 - result.ratio) * 100)}% smaller), ` +
        `~${result.originalTokens} -> ~${result.compressedTokens} tokens, kind=${result.kind}` +
        (result.retrievalId ? `, id=${result.retrievalId}` : ", not stored") + "]"
      : `[under budget, returned unchanged: ${result.originalChars} chars, kind=${result.kind}]`;
    return text(`${header}\n${result.text}`);
  },

  retrieve(args) {
    if (!args.id) return failure("retrieve requires `id`.");
    const out = storeFor(args.storeDir).get(args.id);
    return out === null
      ? failure(`No original held for id "${args.id}". It may have been pruned, or compress was called without store=true.`)
      : text(out);
  },

  slice(args) {
    if (!args.id) return failure("slice requires `id`.");
    const out = storeFor(args.storeDir).slice(args.id, {
      fromLine: Number.isFinite(args.fromLine) ? args.fromLine : 1,
      lines: Number.isFinite(args.lines) ? args.lines : 200,
    });
    return out === null ? failure(`No original held for id "${args.id}".`) : text(out);
  },

  grep(args) {
    if (!args.id || !args.pattern) return failure("grep requires `id` and `pattern`.");
    let hits;
    try {
      hits = storeFor(args.storeDir).grep(args.id, args.pattern, {
        max: Number.isFinite(args.max) ? args.max : 100,
      });
    } catch (e) {
      return failure(`Invalid pattern: ${e.message}`);
    }
    if (hits === null) return failure(`No original held for id "${args.id}".`);
    return text(hits.length ? hits.map((h) => `${h.line}: ${h.text}`).join("\n") : "No matches.");
  },
};

// --- JSON-RPC ------------------------------------------------------------------------------

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

/** Pick a protocol version: echo the client's if known, else our newest. */
const negotiate = (requested) => (SUPPORTED.includes(requested) ? requested : SUPPORTED[0]);

const identity = { name: NAME, version: VERSION };

function handle(msg) {
  const { id, method, params = {} } = msg;
  // A notification (no id) expects no reply — including `notifications/initialized`.
  const isNotification = id === undefined || id === null;

  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const error = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    // Pre-2026-07-28 handshake. Retained because every shipping client still uses it.
    case "initialize":
      return reply({
        protocolVersion: negotiate(params.protocolVersion),
        capabilities: CAPABILITIES,
        serverInfo: identity,
      });

    // Required by 2026-07-28, and used by clients as a stdio compatibility probe.
    case "server/discover":
      return reply({
        protocolVersions: SUPPORTED,
        capabilities: CAPABILITIES,
        serverInfo: identity,
      });

    case "ping":
      return reply({});

    case "tools/list":
      return reply({ tools: TOOLS });

    case "tools/call": {
      const handler = HANDLERS[params.name];
      if (!handler) return error(RPC.INVALID_PARAMS, `Unknown tool: ${params.name}`);
      try {
        return reply(handler(params.arguments ?? {}));
      } catch (e) {
        // A tool failing is a RESULT, not a transport error: the agent should see it and adapt,
        // and the server must stay up either way.
        return reply(failure(`gistline ${params.name} failed: ${e.message}`));
      }
    }

    // Empty lists rather than METHOD_NOT_FOUND: some clients probe these on connect and log noisily.
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });

    default:
      if (isNotification) return null;
      return error(RPC.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

// --- stdio transport -----------------------------------------------------------------------

let buffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: RPC.PARSE_ERROR, message: "Invalid JSON" } });
      continue;
    }

    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: RPC.INVALID_REQUEST, message: "Not a JSON-RPC 2.0 request" } });
      continue;
    }

    try {
      const out = handle(msg);
      if (out) send(out);
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: RPC.INTERNAL, message: e.message } });
    }
  }
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// stdin closing means the host has detached. Deliberately NO `process.exit()` here.
//
// `process.exit()` does not wait for stdout to drain, so anything still buffered is discarded. With a
// large response that truncates the JSON mid-message and the client gets unparseable output. CI caught
// this on macOS with Node 18 and 20; Linux and Windows pipe buffers happened to absorb the write,
// which is exactly why a single-platform test suite would have missed it.
//
// With stdin ended and no work pending, Node exits on its own once stdout has flushed — which is both
// simpler and correct.
process.stdin.on("end", () => {
  process.exitCode = 0;
});
