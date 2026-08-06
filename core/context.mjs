// The per-call shared state.
//
// ONE RESPONSIBILITY: hold everything a transform might need, and compute each expensive thing AT MOST ONCE.
//
// WHY THIS EXISTS. `compressJson` parses JSON, transforms, re-serialises. The table transform parses JSON, transforms,
// re-serialises. Running both means TWO parses and TWO serialisations of the same document — the two most expensive
// operations on the path, doubled, on the largest inputs. The same is true of line splitting, which five transforms
// each did independently.
//
// So the context owns them. A transform asks for `ctx.parsed` or `ctx.lines` and gets a memoised value; nothing else in
// the codebase is allowed to parse or split.
//
// LAZY, not eager. A log input never needs `parsed`, and paying for a failed `JSON.parse` on a 40 MB log is exactly the
// kind of invisible cost this module is supposed to remove. Getters compute on first access and never again.

import { split } from "../util/lines.mjs";

/**
 * Create the context for one compression call.
 *
 * `raw` is the only required input. Everything else is derived, and derived once.
 */
export function createContext(raw, { kind = null, budget = 4000, label = "" } = {}) {
  const text = raw == null ? "" : String(raw);

  // Memo slots. `undefined` means "not computed yet"; a computed failure is stored as `null` so it is not retried.
  let parsedMemo;
  let linesMemo;
  let tokensMemo;

  const ctx = {
    raw: text,
    kind,
    budget,
    label,

    /** The transforms that have run, in order, and what each did. Owned here so `report` has one source. */
    applied: [],

    /**
     * The parsed document, or null if the text is not JSON.
     *
     * Attempted at most once. A second transform asking after a failure gets `null` immediately rather than paying for
     * another parse of text already known not to be JSON.
     */
    get parsed() {
      if (parsedMemo === undefined) {
        try { parsedMemo = JSON.parse(text); }
        catch { parsedMemo = null; }
      }
      return parsedMemo;
    },

    /** Whether the input is JSON, without forcing a caller to think about `null` versus a legitimately null document. */
    get isJson() {
      return ctx.parsed !== null;
    },

    /** Lines, with the trailing-newline and CRLF facts needed to rejoin exactly. Computed once. */
    get lines() {
      if (linesMemo === undefined) linesMemo = split(text);
      return linesMemo;
    },

    /**
     * Estimated tokens for the ORIGINAL text.
     *
     * Only computed if something asks. Most calls need character lengths, which are free, and paying for a token
     * estimate nobody reads is the sort of cost that hides inside a "cheap" helper.
     */
    get tokens() {
      if (tokensMemo === undefined) tokensMemo = estimateTokens(text);
      return tokensMemo;
    },
  };

  return ctx;
}

/**
 * Rough token estimate.
 *
 * Deliberately arithmetic rather than a real tokeniser: a tokeniser is a dependency, and the number is used to pick a
 * character budget rather than to bill anyone. Roughly 3.6 characters per token for mixed code and prose.
 */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 3.6);
}

/** Characters available for a token budget. The floor stops a tiny budget producing unusable output. */
export const charsForTokens = (tokens) => Math.max(200, Math.round(tokens * 3.6));
