// Lossless-first compaction.
//
// THE IDEA, and it is the whole file: try to make the content SMALLER WITHOUT REMOVING ANYTHING before considering
// dropping a single byte.
//
// An array of 140 objects that share six keys repeats those six key names 140 times. Written as a table — the keys
// once, then the rows — it is typically a third of the size and NOTHING HAS BEEN LOST. Every value is still there,
// every row is still there, and a reader can reconstruct the original exactly.
//
// This matters because the alternative is what a naive compressor does: keep the first three items and delete the rest.
// That is fast, it produces a great-looking ratio, and it throws away the error on row 97.
//
// So the contract here is strict: EVERY FUNCTION IN THIS FILE IS LOSSLESS. If a transform cannot preserve all the
// information, it does not belong here — it belongs in the lossy path, behind a retrieval marker, where the caller can
// see that something was set aside.
//
// Determinism is part of the contract too. No sampling, no randomness, no learned thresholds: the same input and the
// same options always produce byte-identical output, because a compressor in a build gate that varies between runs is
// worse than no compressor.

import { ABSENT, encodeRow, decodeBlock, decodeCell } from "./util/escape.mjs";

/**
 * How much smaller a lossless form must be before it is worth using.
 *
 * A table that saves 4% is not worth the reader's unfamiliarity: they now have to mentally re-expand a format to save
 * nothing. Below this threshold the original is returned untouched, which is why `compact()` can always be called
 * safely — it declines rather than damages.
 */
export const MIN_LOSSLESS_GAIN = 0.15;

/** Values that can sit in a table cell without ambiguity when rendered as text. */
const isScalar = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

/**
 * Is this an array of objects with enough shared shape to tabulate?
 *
 * Deliberately strict. Requiring MOST keys to be shared, rather than any, avoids turning a ragged array into a sparse
 * table full of empty cells — which is larger than the original and harder to read.
 */
export function tabulable(value, { minRows = 3, minShared = 0.6 } = {}) {
  if (!Array.isArray(value) || value.length < minRows) return null;

  const rows = value.filter((v) => v && typeof v === "object" && !Array.isArray(v));
  if (rows.length !== value.length) return null;

  // Only scalar cells. A nested object in a cell would have to be re-serialised inline, and that is where a "lossless"
  // table quietly stops being lossless.
  if (!rows.every((r) => Object.values(r).every(isScalar))) return null;

  const counts = new Map();
  for (const r of rows) for (const k of Object.keys(r)) counts.set(k, (counts.get(k) ?? 0) + 1);

  const shared = [...counts.entries()].filter(([, n]) => n / rows.length >= minShared).map(([k]) => k);
  if (!shared.length) return null;

  // Every key must be covered. A key held by only one row would be dropped by a shared-key table, and dropping it
  // silently is exactly the failure this module exists to prevent.
  if (shared.length !== counts.size) return null;

  // Column order: by how many rows carry the key, then alphabetically. Deterministic, and it puts the universal
  // columns first where a reader looks.
  //
  // KNOWN LIMITATION, and it is deliberate: this does NOT preserve the original key order. A table has one column
  // order for every row, so per-row key order cannot survive — and rows in real payloads do not agree on it anyway.
  //
  // What that means precisely: every key and every value round-trips exactly, so `deepEqual` holds and any code
  // reading fields is unaffected. But `JSON.stringify(before) === JSON.stringify(after)` is FALSE, because
  // stringify is order-sensitive. Found by checking a realistic payload after the unit tests passed — `deepEqual`
  // ignores key order, so the tests could not see it.
  //
  // Chosen over preserving order because a stable, frequency-then-alphabetical order is what makes the output
  // deterministic across producers that emit keys in different orders. If byte-identical JSON matters more to a
  // caller than compaction, they should not compact.
  const columns = shared.sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
  return { rows, columns };
}


/**
 * Tabulate an array of like-shaped objects. Lossless, reversible, deterministic.
 *
 * Encoding is delegated to `util/escape.mjs` rather than done here. This file previously carried a private `cell()`
 * and its own `ABSENT` marker; the log-template design then needed identical rules and re-derived them incorrectly.
 * One implementation with one set of round-trip tests, used by both, is the point of the extraction.
 */
export function toTable(value, opts = {}) {
  const shape = tabulable(value, opts);
  if (!shape) return null;

  const { rows, columns } = shape;
  const lines = [columns.join(",")];
  for (const r of rows) {
    lines.push(encodeRow(columns.map((c) => (c in r ? r[c] : ABSENT))));
  }
  return { text: lines.join("\n"), rows: rows.length, columns };
}

/**
 * Reverse a table back to the original array.
 *
 * Exists so "lossless" is a TESTED claim rather than an adjective: if `fromTable(toTable(x))` does not deep-equal `x`,
 * the transform is not lossless and the suite says so.
 */
export function fromTable(text) {
  const rows = decodeBlock(text);
  if (!rows.length) return [];

  const columns = rows[0].map((c) => decodeCell(c));

  return rows.slice(1).map((cells) => {
    const obj = {};
    columns.forEach((c, i) => {
      const value = decodeCell(cells[i] ?? "");
      // A key that was absent stays absent, which is what distinguishes it from one set to null.
      if (value === ABSENT) return;
      obj[String(c)] = value;
    });
    return obj;
  });
}


/**
 * Walk a document and tabulate every array that qualifies, in place.
 *
 * Recursive rather than top-level-only, because the compactable array is usually nested — `{data: {items: [...]}}` is
 * the shape an API returns, and a top-level-only check finds nothing in it.
 *
 * A tabulated array becomes `{ "__table": "<csv>", "__rows": n }`, which is explicit rather than clever: a reader
 * seeing `__table` knows a transform happened and can reverse it. A bare CSV string in place of an array would look
 * like the original data had a string there.
 */
export function compactDocument(value, opts = {}, depth = 0) {
  // Depth guard: deeply recursive structures are rare and a runaway walk in a build gate is worse than a missed saving.
  if (depth > 12) return { value, tables: 0 };

  if (Array.isArray(value)) {
    const table = toTable(value, opts);
    if (table) return { value: { __table: table.text, __rows: table.rows }, tables: 1 };

    let tables = 0;
    const out = value.map((v) => {
      const r = compactDocument(v, opts, depth + 1);
      tables += r.tables;
      return r.value;
    });
    return { value: out, tables };
  }

  if (value && typeof value === "object") {
    let tables = 0;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const r = compactDocument(v, opts, depth + 1);
      tables += r.tables;
      out[k] = r.value;
    }
    return { value: out, tables };
  }

  return { value, tables: 0 };
}

/**
 * The lossless-first entry point.
 *
 * Returns a verdict rather than a string, so the caller can see WHICH PATH RAN. A compressor that silently chooses
 * between lossless and lossy leaves the reader unable to tell whether anything was set aside — and that ambiguity is
 * the thing that makes compression untrustworthy in a build.
 *
 * `applied: false` is a normal, successful outcome. Declining to compact content that would not benefit is correct
 * behaviour, not a failure.
 */
export function compact(text, { minGain = MIN_LOSSLESS_GAIN, ...opts } = {}) {
  const original = String(text ?? "");

  let parsed;
  try { parsed = JSON.parse(original); }
  catch { return { applied: false, reason: "not JSON", text: original, before: original.length, after: original.length, gain: 0, tables: 0 }; }

  const { value, tables } = compactDocument(parsed, opts);
  if (!tables) {
    return { applied: false, reason: "no tabulable arrays", text: original, before: original.length, after: original.length, gain: 0, tables: 0 };
  }

  // Compact JSON for the wrapper, because the point is size. The table itself stays newline-delimited and readable.
  const candidate = JSON.stringify(value, null, 2);
  const gain = (original.length - candidate.length) / original.length;

  if (gain < minGain) {
    return {
      applied: false,
      reason: `lossless gain ${(gain * 100).toFixed(1)}% is below the ${(minGain * 100).toFixed(0)}% threshold`,
      text: original,
      before: original.length,
      after: original.length,
      gain,
      tables,
    };
  }

  return {
    applied: true,
    reason: `${tables} array(s) tabulated, nothing removed`,
    text: candidate,
    before: original.length,
    after: candidate.length,
    gain,
    tables,
  };
}
