// Lossless JSON table compaction, as a transform.
//
// ONE RESPONSIBILITY: adapt `compact()` to the transform contract.
//
// This is the transform the architecture work existed to make possible. `compact()` was written first and had nowhere
// to attach: `gist()` ran one strategy per kind, so using it would have meant calling it inside `compressJson` and
// again inside `compressLog` and again wherever else JSON appears — the lossless-first rule re-implemented per
// strategy, which is how it ends up implemented differently in each.
//
// It runs BEFORE any lossy transform because of where it sits in the ordered list, not because it checks anything.

import { compact } from "../lossless.mjs";

export const tables = {
  id: "json-tables",
  lossless: true,

  /**
   * `truncatable: false` because the output is a JSON document.
   *
   * Cutting a JSON document in half yields text that looks structured and does not parse. The old blind final
   * truncation did exactly that, and it was a live bug the moment this transform started producing output.
   */
  truncatable: false,

  /**
   * Cheap predicate: JSON only, and only when there is enough text for a table to pay for its header row.
   *
   * `ctx.isJson` is memoised on the context, so asking here costs nothing beyond the first parse — and if the input is
   * a 40 MB log, that first parse already failed once and is never retried.
   */
  applies: (ctx) => ctx.isJson && ctx.text.length > 200,

  run: (ctx) => {
    const r = compact(ctx.text);
    return {
      text: r.text,
      applied: r.applied,
      // `compact` already explains itself precisely — "3 array(s) tabulated, nothing removed", or why it declined.
      // Passing that through rather than restating it keeps one source for the reason.
      reason: r.reason,
    };
  },
};

export default tables;
