// gistline — keep the gist of large tool output.
//
// Structure-aware output compression for AI agents and CI logs. Zero dependencies, pure functions,
// runs anywhere Node runs. Usable standalone (`npx gistline`) or as a library.
//
// WHY: large tool output is the main way an agent's context gets exhausted. A 40k-line test log or a
// giant JSON payload crowds out the requirements, the persona brief, and the actual work.
//
// THE IDEA: compression must be STRUCTURE-AWARE. Keeping the first N characters of a test run throws
// away the failures — the only part that mattered. So each kind of output gets a strategy that keeps
// its signal and drops its noise, and every result reports what was dropped so the caller knows the
// original can still be retrieved.
//
// Pure and dependency-free: no model call, no filesystem, no clock.

/** Default character budget for a single output entering context. */
import { createContext, estimateTokens as estimateTokensCore, charsForTokens as charsForTokensCore } from "./core/context.mjs";
import { runPipeline } from "./core/pipeline.mjs";
// Ingestion: bytes to text. A PRE-STAGE, not a transform — see the header of core/ingest.mjs for why.
import { ingest, tryIngest, UnsupportedFormat } from "./core/ingest.mjs";

export { ingest, tryIngest, UnsupportedFormat };

export const DEFAULT_BUDGET = 4000;

/**
 * Estimate token count without a tokenizer dependency.
 *
 * This is an ESTIMATE, and says so: a real BPE tokenizer would need a vocabulary file, which would
 * mean a dependency and a download. The naive `chars / 4` rule is tuned for English prose and
 * badly underestimates code, where punctuation and short identifiers each cost a token. So words are
 * costed by length and symbols are costed individually, which tracks code far more closely.
 *
 * Accurate enough to budget with; do not use it for billing.
 */
export function estimateTokens(text) {
  // `text = ""` as a default would not help here: a default only applies to `undefined`, so a `null`
  // argument would become the string "null" and be counted as a real token.
  const s = text == null ? "" : String(text);
  if (!s) return 0;
  let tokens = 0;
  // Word-ish runs: roughly one token per 4 characters, minimum one.
  for (const w of s.match(/[A-Za-z0-9_]+/g) ?? []) tokens += Math.max(1, Math.ceil(w.length / 4));
  // Every non-alphanumeric, non-space character tends to be its own token in code.
  tokens += (s.match(/[^A-Za-z0-9_\s]/g) ?? []).length;
  // Newlines are tokens too.
  tokens += (s.match(/\n/g) ?? []).length;
  return tokens;
}

/** Characters that roughly correspond to a token budget, for the clamped strategies. */
export const charsForTokens = (tokens) => Math.max(200, Math.round(tokens * 3.6));

/** Lines worth keeping in almost any output. */
const SALIENT = /\b(error|err|fail(ed|ure)?|fatal|exception|panic|traceback|refus|denied|timeout|timed out|cannot|unable|missing|not found|undefined|null pointer|warn(ing)?|deprecat)\b/i;

/** Lines that are almost always noise when we are short on space. */
const NOISE = /^\s*(at\s+node:internal|npm (WARN|notice)|added \d+ packages|Downloading|Fetching|Progress:|\d+% ?\|)/i;

/**
 * Classify output so the right strategy is used. Order matters: the most specific structural
 * signals are checked first, because a test log can also contain JSON and diffs.
 */
export function detectKind(text = "") {
  const s = String(text);
  const head = s.slice(0, 2000);

  if (/^\s*[[{]/.test(s.trim()) && looksLikeJson(s)) return "json";
  if (/^(diff --git|index [0-9a-f]{7,}|@@ -\d+)/m.test(head)) return "diff";
  if (/^(ok|not ok)\s+\d+/m.test(head) || /# (pass|fail|tests)\s+\d+/m.test(s) || /\b\d+ (passing|failing|passed|failed)\b/i.test(s)) return "test";
  if (/^\s+at .+\(.+:\d+:\d+\)$/m.test(s) || /^[A-Za-z.]*Error:/m.test(head)) return "stacktrace";
  if (/^[-d rwx@]{10}\s/m.test(head) || /^(total \d+|Directory of )/m.test(head)) return "listing";
  return "log";
}

function looksLikeJson(s) {
  try { JSON.parse(s); return true; } catch { return false; }
}

const lines = (s) => String(s).split(/\r?\n/);

/**
 * Test output: the failures and the summary are the whole point. Passing lines are the noise, and
 * there are usually thousands of them. This is the strategy that most often turns a 40k-line run
 * into something an agent can actually reason about.
 */
export function compressTest(text, budget = DEFAULT_BUDGET) {
  const all = lines(text);
  const kept = [];
  const summary = [];
  let passing = 0;

  for (let i = 0; i < all.length; i++) {
    const l = all[i];
    // Summary lines are anchored to the start of the line ("# pass 511", "  5 passing (20ms)").
    // Matching "\d+ passed" ANYWHERE swept up ordinary passing lines whose test name happened to
    // contain a number and the word "passed" — found when this ran against a real failing command.
    if (/^\s*#\s*(pass|fail|tests|skipped|todo|cancelled|duration)/i.test(l) ||
        /^\s*\d+ (passing|failing|passed|failed|skipped)\b/i.test(l)) {
      summary.push(l);
      continue;
    }
    // TAP announces each test before running it. The NAME often contains words like "fail",
    // "missing", or "cannot" (they describe what is being tested), which would otherwise look
    // salient and crowd out the real failures. The verdict arrives as `ok` / `not ok`, so the
    // announcement is structural noise.
    if (/^\s*#\s*Subtest:/i.test(l)) { passing++; continue; }
    if (/^\s*(ok|✓|√|PASS)\b/i.test(l) || /^\s*ok \d+/.test(l)) { passing++; continue; }
    if (/^\s*(not ok|✗|×|FAIL|✕)\b/i.test(l) || /^\s*not ok \d+/.test(l)) {
      // Keep the failure and the diagnostic block that follows it.
      kept.push(l);
      let j = i + 1;
      for (; j < all.length && j < i + 25; j++) {
        const d = all[j];
        if (/^\s*(ok|not ok|✓|✗)\b/i.test(d)) break;
        if (d.trim()) kept.push(d);
      }
      // Skip past the block we just consumed. Without this the diagnostic lines were re-examined
      // on later iterations and any salient one was added a second time, duplicating the error.
      i = j - 1;
      continue;
    }
    if (SALIENT.test(l) && !NOISE.test(l)) kept.push(l);
  }

  const note = passing ? `[compressed: ${passing} passing lines omitted]` : null;
  const body = [...(note ? [note] : []), ...kept, ...(summary.length ? ["", ...summary] : [])].join("\n");
  return body.length <= budget ? body : headTail(body, budget);
}

/**
 * Diffs: hunk headers and changed lines carry the meaning; unchanged context is padding. Per-file
 * headers are always kept so an agent can see the blast radius even when bodies are dropped.
 */
export function compressDiff(text, budget = DEFAULT_BUDGET) {
  const out = [];
  let droppedContext = 0;
  for (const l of lines(text)) {
    if (/^(diff --git|--- |\+\+\+ |@@ |new file|deleted file|rename )/.test(l)) { out.push(l); continue; }
    if (/^[+-]/.test(l)) { out.push(l); continue; }
    droppedContext++;
  }
  if (droppedContext) out.unshift(`[compressed: ${droppedContext} unchanged context lines omitted]`);
  const body = out.join("\n");
  return body.length <= budget ? body : headTail(body, budget);
}

/**
 * JSON: preserve SHAPE, shrink VALUES. An agent needs to know the structure — which keys exist, what
 * types they hold, how long the arrays are — far more than it needs every element. Truncating the raw
 * text instead would produce unparseable JSON, which is worse than useless.
 */
export function compressJson(text, budget = DEFAULT_BUDGET, { maxArray = 3, maxString = 200 } = {}) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return headTail(text, budget); }

  const shrink = (v, depth = 0) => {
    if (typeof v === "string") return v.length > maxString ? `${v.slice(0, maxString)}…[+${v.length - maxString} chars]` : v;
    if (Array.isArray(v)) {
      if (depth > 6) return `[Array(${v.length})]`;
      const head = v.slice(0, maxArray).map((x) => shrink(x, depth + 1));
      return v.length > maxArray ? [...head, `…[+${v.length - maxArray} more items]`] : head;
    }
    if (v && typeof v === "object") {
      if (depth > 6) return "[Object]";
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = shrink(val, depth + 1);
      return out;
    }
    return v;
  };

  const body = JSON.stringify(shrink(parsed), null, 2);
  return body.length <= budget ? body : headTail(body, budget);
}

/**
 * Stack traces: the message and the frames in OUR code matter; framework and node-internal frames are
 * noise that fills the window.
 */
export function compressStacktrace(text, budget = DEFAULT_BUDGET) {
  const out = [];
  let dropped = 0;
  for (const l of lines(text)) {
    const isFrame = /^\s+at /.test(l);
    if (!isFrame) { out.push(l); continue; }
    if (/node:internal|[\\/]node_modules[\\/]/.test(l)) { dropped++; continue; }
    out.push(l);
  }
  if (dropped) out.push(`[compressed: ${dropped} library/internal frames omitted]`);
  const body = out.join("\n");
  return body.length <= budget ? body : headTail(body, budget);
}

/** Generic logs and listings: keep salient lines, then fill from the head and tail. */
export function compressLog(text, budget = DEFAULT_BUDGET) {
  const all = lines(text);
  const body = all.join("\n");
  if (body.length <= budget) return body;

  const salient = all.filter((l) => SALIENT.test(l) && !NOISE.test(l));
  if (salient.length) {
    const block = salient.slice(0, 200).join("\n");
    if (block.length <= budget * 0.75) {
      const remaining = budget - block.length - 80;
      const tail = all.slice(-40).join("\n");
      return [
        `[compressed: ${all.length} lines → salient lines + tail]`,
        block,
        "",
        "--- tail ---",
        tail.length > remaining ? tail.slice(-Math.max(0, remaining)) : tail,
      ].join("\n");
    }
  }
  return headTail(body, budget);
}

/** Last resort: keep both ends, because the cause is usually at the start and the result at the end. */
export function headTail(text, budget = DEFAULT_BUDGET) {
  const s = String(text);
  if (s.length <= budget) return s;
  const half = Math.max(200, Math.floor((budget - 60) / 2));
  const omitted = s.length - half * 2;
  return `${s.slice(0, half)}\n\n…[compressed: ${omitted} chars omitted from the middle]…\n\n${s.slice(-half)}`;
}

const STRATEGIES = {
  test: compressTest,
  diff: compressDiff,
  json: compressJson,
  stacktrace: compressStacktrace,
  listing: compressLog,
  log: compressLog,
};

/**
 * Reduce one output to its gist, within a budget.
 *
 * @param {string} text raw output
 * @param {object} opts
 *  - budget     character budget (default DEFAULT_BUDGET)
 *  - maxTokens  token budget instead of characters (takes precedence)
 *  - kind       force a strategy; otherwise detected
 *  - label      what produced this (used in the note)
 *  - store      a gistline store (see store.mjs). When given, the ORIGINAL is kept and the note
 *               carries a retrieval id — which is what makes "ask for the verbatim output" true
 *               rather than merely reassuring.
 * @returns {{ text, kind, originalChars, compressedChars, originalTokens, compressedTokens,
 *             ratio, compressed, note, retrievalId }}
 */
export function gist(text, { budget = DEFAULT_BUDGET, maxTokens = null, kind = null, label = "", store = null, transforms = null } = {}) {
  const raw = text == null ? "" : String(text);
  const detected = kind ?? detectKind(raw);
  const effective = maxTokens != null ? charsForTokens(maxTokens) : budget;

  if (raw.length <= effective) {
    return {
      text: raw, kind: detected,
      originalChars: raw.length, compressedChars: raw.length,
      originalTokens: estimateTokens(raw), compressedTokens: estimateTokens(raw),
      ratio: 1, compressed: false, note: null, retrievalId: null,
      // The SAME SHAPE as the compressed path, always.
      //
      // These were missing here, so `gist()` returned one shape for large input and another for small — and a caller
      // doing `result.applied.filter(...)` crashed on exactly the inputs that needed no work. A function whose return
      // type depends on its argument's size is a trap, and it caught me while checking my own wiring.
      applied: [], lossy: false,
    };
  }

  // THE PIPELINE, not a single strategy.
  //
  // Transforms are supplied by the caller-facing registry so this file does not import them and create a cycle:
  // `transforms/legacy.mjs` imports the strategies FROM here, so importing it here would be circular. The registry is
  // injected instead — which also means a caller can supply their own ordering, and the pipeline is testable with
  // fakes.
  //
  // When no registry is given, behaviour is exactly the previous single-strategy path. That is deliberate: the
  // migration must not change output, and the 102 pre-existing assertions are the check.
  let body;
  let applied;
  let truncatable = true;
  // Whether the final safety net still has a job. When a pipeline runs, its own last-resort transform IS the net, and
  // applying it again double-truncates — a parity check caught exactly that: both paths reached 452 characters with
  // DIFFERENT content, because the pipeline path truncated twice and the second pass re-inserted an elision marker.
  let netNeeded = true;

  if (transforms && transforms.length) {
    const ctx = createContext(raw, { kind: detected, budget: effective, label });
    const out = runPipeline(ctx, transforms);
    body = out.text;
    applied = out.applied;
    truncatable = out.truncatable;
    netNeeded = false;
  } else {
    const strategy = STRATEGIES[detected] ?? compressLog;
    body = strategy(raw, effective);
    applied = [{ id: detected, applied: body.length < raw.length, lossless: false }];
  }

  // The final safety net for the legacy path, and it now RESPECTS structure.
  //
  // Previously applied blindly to any output, which cut a table's rows in half and produced text that looks structured
  // and is silently incomplete. A transform whose output must not be cut sets `truncatable: false`, and then the
  // over-budget output is preferred to a corrupted one — being slightly too large is recoverable, being quietly wrong
  // is not.
  if (netNeeded && body.length > effective && truncatable) body = headTail(body, effective);

  const lossy = applied.some((a) => a.applied && a.lossless === false);

  // Keep the original if a store was provided, so retrieval is real.
  let retrievalId = null;
  if (store) {
    const put = store.put(raw);
    retrievalId = put?.id ?? null;
  }

  const retrieval = retrievalId
    ? `Full output retained as id ${retrievalId} — retrieve, slice, or grep it for any dropped detail.`
    : `Nothing was deleted — request the verbatim output if you need a dropped detail.`;
  const note = `[${label || detected} output compressed: ${raw.length} → ${body.length} chars. ${retrieval}]`;

  return {
    text: `${note}\n${body}`,
    kind: detected,
    originalChars: raw.length,
    compressedChars: body.length,
    originalTokens: estimateTokens(raw),
    compressedTokens: estimateTokens(body),
    ratio: Number((body.length / raw.length).toFixed(3)),
    compressed: true,
    note,
    retrievalId,
    // NEW, additive only: what ran and whether anything was actually removed. Existing callers are unaffected because
    // nothing above changed; a caller that wants to know whether the output is complete can now ask instead of guess.
    applied,
    lossy,
  };
}

/**
 * Accounting across a run, so callers can prove the tool is actually engaging. Advisory prose gets
 * ignored; counters are checkable.
 */
export function makeGistStats() {
  const stats = { calls: 0, compressedCalls: 0, charsIn: 0, charsOut: 0, byKind: {} };
  return {
    record(result) {
      stats.calls++;
      if (result.compressed) stats.compressedCalls++;
      stats.charsIn += result.originalChars;
      stats.charsOut += result.compressedChars;
      const k = (stats.byKind[result.kind] ??= { calls: 0, charsIn: 0, charsOut: 0 });
      k.calls++; k.charsIn += result.originalChars; k.charsOut += result.compressedChars;
      return result;
    },
    snapshot() {
      const saved = stats.charsIn - stats.charsOut;
      return {
        ...structuredClone(stats),
        charsSaved: saved,
        ratio: stats.charsIn ? Number((stats.charsOut / stats.charsIn).toFixed(3)) : 1,
      };
    },
  };
}

/** One-line human summary for logs and dashboards. */
export function formatGistStats(snap) {
  if (!snap?.calls) return "gistline: no output processed";
  const pct = Math.round((1 - snap.ratio) * 100);
  return `gistline: ${snap.compressedCalls}/${snap.calls} outputs compressed, ${snap.charsSaved.toLocaleString()} chars saved (${pct}% smaller)`;
}

/**
 * Ingest then compress: the entry point for a FILE rather than a string.
 *
 * Deliberately separate from `gist()`. `gist` compresses text and its contract is settled; this converts first and then
 * calls it. Adding binary handling inside `gist` would have changed an interface nine transforms share in order to serve
 * one input type — and every one of its tests assumes text.
 *
 * The returned shape is `gist`'s, plus what conversion did. A caller that only cares about the text ignores the extra
 * fields; a caller deciding whether to trust the output can see that a spreadsheet was read and what was left out.
 */
export function gistFile(input, { name = "", ...opts } = {}) {
  const ingested = ingest(input, { name });

  // Nothing to compress. Returned in the same shape rather than as a special case, for the reason the early-return path
  // in `gist` was fixed: a function whose result shape depends on its input is a trap.
  if (!ingested.text) {
    return {
      text: "", kind: ingested.kind, originalChars: ingested.original, compressedChars: 0,
      originalTokens: 0, compressedTokens: 0, ratio: 0, compressed: false, note: null, retrievalId: null,
      applied: [], lossy: false,
      ingest: { kind: ingested.kind, converted: ingested.converted, notes: ingested.notes, originalBytes: ingested.original },
    };
  }

  const out = gist(ingested.text, { ...opts, transforms: opts.transforms ?? null });

  return {
    ...out,
    // `originalChars` from `gist` is the length of the CONVERTED text, which would understate the saving. The bytes that
    // arrived are what the caller actually paid for, so both are reported and neither is hidden.
    ingest: {
      kind: ingested.kind,
      converted: ingested.converted,
      notes: ingested.notes,
      originalBytes: ingested.original,
      convertedChars: ingested.text.length,
    },
  };
}
