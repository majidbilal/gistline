// The five existing strategies, wrapped as transforms.
//
// ONE RESPONSIBILITY per entry: adapt an existing compressor to the transform contract. No behaviour changes.
//
// WHY WRAPPING RATHER THAN REWRITING. `compressTest`, `compressDiff`, `compressJson`, `compressStacktrace`,
// `compressLog` and `headTail` are exported, tested by 102 assertions, and something outside this package may import
// them. They stay exactly as they are; these wrappers give the pipeline a uniform shape to call.
//
// If a wrapped strategy's behaviour changes, that is a bug rather than a migration — and the existing tests are the
// check on that claim.
//
// All five are LOSSY: each keeps interesting lines and discards the rest. That is why they sit after the lossless
// transforms in the pipeline order, and why the note can now say so.

import { compressTest, compressDiff, compressJson, compressStacktrace, compressLog, headTail } from "../index.mjs";

/** Build a wrapper for a kind-specific strategy. */
const forKind = (id, kind, fn, { truncatable = true } = {}) => ({
  id,
  lossless: false,
  truncatable,
  /**
   * Only runs for its own kind, AND only while nothing earlier has declared its output uncuttable.
   *
   * The second half matters for combining lossless and lossy work. These strategies drop whole lines. Run after
   * `log-templates`, `compressLog` would happily drop the TEMPLATE HEADER and leave rows referencing formats that no
   * longer exist — output that looks structured and cannot be expanded at all.
   *
   * A structure-aware lossy step (`template-rows`) does that job instead, which is why these can safely stand aside.
   */
  applies: (ctx) => ctx.kind === kind && ctx.truncatable !== false,
  run: (ctx) => {
    const text = fn(ctx.text, ctx.budget);
    return {
      text,
      applied: typeof text === "string" && text.length < ctx.text.length,
      reason: `${kind}: kept the lines that matter, dropped the rest`,
    };
  },
});

export const testOutput = forKind("test-output", "test", compressTest);
export const diff = forKind("diff", "diff", compressDiff);
export const stacktrace = forKind("stacktrace", "stacktrace", compressStacktrace);
export const log = forKind("log", "log", compressLog);

/**
 * The JSON strategy.
 *
 * `truncatable: false` because its output is a JSON document. Cutting a JSON document in half yields text that looks
 * structured and does not parse — the corruption the old blind final truncation could cause.
 *
 * It ALSO refuses to run once something earlier declared its output uncuttable, and that guard is not theoretical: this
 * strategy truncates long strings to 200 characters. Run after `json-tables`, it would find the compacted table as one
 * long `__table` string and cut it to 200 characters — silently destroying 200 rows that had just been preserved
 * losslessly. A revisit caught it before it could ship.
 */
export const json = {
  ...forKind("json", "json", compressJson, { truncatable: false }),
  applies: (ctx) => ctx.kind === "json" && ctx.truncatable !== false,
};

/**
 * Last resort.
 *
 * Applies to ANY kind, which is why it is last. It respects nothing about structure, so it must only ever run when the
 * pipeline has failed to fit the budget any other way — and only when nothing before it declared its output uncuttable.
 */
export const lastResort = {
  id: "head-tail",
  lossless: false,
  truncatable: true,
  applies: (ctx) => ctx.truncatable !== false,
  run: (ctx) => {
    const text = headTail(ctx.text, ctx.budget);
    return {
      text,
      applied: typeof text === "string" && text.length < ctx.text.length,
      reason: "last resort: kept the head and the tail, dropped the middle",
    };
  },
};

/**
 * The ordered list.
 *
 * LOSSLESS FIRST. `json-tables` runs before every lossy transform, and that ordering is the whole architecture: a
 * document that compacts losslessly inside budget never reaches a transform that would drop rows from it. No transform
 * checks for this rule; it holds because of where the entries sit.
 *
 * Then the kind-specific lossy strategies — each declines unless the kind matches, so at most one runs — then the last
 * resort.
 */
import { tables } from "./tables.mjs";
import { templates, templateRows } from "./templates.mjs";
import { html } from "./html.mjs";

export const TRANSFORMS = [
  // CONVERSION, first. It changes the FORMAT, and everything after it operates on the result — a compressor running
  // before conversion would be compressing markup.
  html,
  // LOSSLESS, cheapest first. A document that fits after these never reaches anything lossy.
  tables,
  templates,
  // LOSSY, structure-aware. Understands what the lossless step produced, so it can reduce further without breaking it.
  templateRows,
  // LOSSY, kind-specific. Each declines unless the kind matches AND nothing earlier forbade cutting.
  testOutput, diff, stacktrace, json, log,
  // LOSSY, last resort.
  lastResort,
];

/**
 * The lossy-only list, kept for the parity check.
 *
 * It exists to prove the wrapping changed nothing: running this must produce byte-identical output to the pre-pipeline
 * single-strategy path. `TRANSFORMS` above deliberately does more, so it cannot be used for that comparison.
 */
export const LOSSY_TRANSFORMS = [testOutput, diff, stacktrace, json, log, lastResort];
