// Delimiter-safe encoding, with exact round-tripping.
//
// ONE RESPONSIBILITY: given a value and a delimiter, produce text that reverses to the same value.
//
// WHY THIS IS ITS OWN MODULE. Two consumers need identical rules — the table writer (`toTable`) and the log-template
// values row. The logic began as a private helper inside the table code, and when the template design was drafted it
// was re-derived from scratch and got it wrong: numeric-looking strings, empty strings and quote-doubling were all
// handled differently. That is the duplication this module exists to prevent.
//
// One implementation, one set of round-trip tests, two consumers. If the escaping is wrong it is wrong in one place.
//
// THE HARD PART is not quoting. It is that plain text is UNTYPED: once `1` is written, nothing distinguishes the number
// 1 from the string "1" unless the string was quoted. So quoting is not only about delimiters — it is about preserving
// the type of the thing on the way back.

/** Values that survive as themselves without quoting. */
const isPlain = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

/**
 * A missing key and a null value are DIFFERENT and a text slot holds one of them.
 *
 * Without an explicit marker, `{a: 1}` and `{a: 1, b: null}` encode identically — lossy in a way that is almost
 * impossible to notice by reading the output. Deliberately a character nobody types.
 */
export const ABSENT = "\u2205"; // ∅

/** Internal marker: "this cell arrived quoted", so decode knows it is a string regardless of shape. */
const WAS_QUOTED = "\u0000";

/**
 * Would this text be read back as something other than a string?
 *
 * `""` decodes to null, `"true"`/`"false"` to booleans, and anything numeric to a number. Those four cases must be
 * quoted even when they contain no delimiter — which is the rule the re-derived version missed.
 */
export function isAmbiguous(s) {
  return s === "" || s === "true" || s === "false" || /^-?\d+(?:\.\d+)?$/.test(s);
}

/**
 * Encode one value.
 *
 * Quotes only when necessary. Unconditional quoting costs two characters per value, which on a 140-row six-column
 * table is ~1,700 characters of pure overhead — enough to push a compaction below its gain threshold and lose the
 * saving entirely. So "only when necessary" is a compression decision, not a style one.
 */
export function encodeValue(v, { delimiter = "," } = {}) {
  if (v === null) return "";

  // Negative zero, before the general number path. `String(-0)` is "0", so -0 would decode as +0 — a difference
  // `===` cannot see, which is why a probe using `===` passed while `deepStrictEqual` failed. `Number("-0")` is -0,
  // so writing the sign is all that is needed.
  if (Object.is(v, -0)) return "-0";

  if (typeof v === "boolean" || typeof v === "number") return String(v);

  const s = String(v);
  const needsQuote = s.includes(delimiter) || /["\n\r]/.test(s) || isAmbiguous(s);
  return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Encode a row. `absent` marks a key that was not present at all, as opposed to present-and-null. */
export function encodeRow(values, { delimiter = "," } = {}) {
  return values
    .map((v) => (v === ABSENT ? ABSENT : encodeValue(v, { delimiter })))
    .join(delimiter);
}

/**
 * Decode a whole block into rows of values.
 *
 * PARSED AS A STREAM, not line by line, and this is not a preference.
 *
 * A value may contain a newline — a stack frame, a multi-line message. Splitting on newlines first and parsing quotes
 * afterwards therefore breaks the row apart, and the round-trip fails on exactly the values that matter most. Rows can
 * only be located while tracking quote state, so quote state has to come first.
 *
 * A round-trip test caught this; reading the code did not.
 */
export function decodeBlock(text, { delimiter = "," } = {}) {
  const src = String(text);
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
      continue;
    }

    if (ch === '"') { quoted = true; cur += WAS_QUOTED; continue; }
    if (ch === delimiter) { row.push(cur); cur = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; continue; }
    cur += ch;
  }

  row.push(cur);

  // A TRAILING NEWLINE produces one empty cell, which is not a row. An input that is ENTIRELY one empty cell IS a row —
  // because `null` encodes to the empty string, so `decodeBlock("")` must yield one cell, not zero.
  //
  // The first version guarded only on the empty cell and dropped both cases. Two tests caught it: encoding `null` and
  // decoding it came back as nothing at all, which would have silently deleted every null in a table.
  if (rows.length === 0 || row.length > 1 || row[0] !== "") rows.push(row);

  return rows;
}

/**
 * Turn one decoded cell back into a value.
 *
 * Returns the ABSENT sentinel for a key that was not present, so the caller can tell "no key" from "key set to null" —
 * a distinction a plain text slot cannot otherwise carry.
 */
export function decodeCell(raw) {
  const wasQuoted = raw.includes(WAS_QUOTED);
  const value = raw.replace(/\u0000/g, "");

  if (value === ABSENT) return ABSENT;

  // A quoted cell is ALWAYS a string, whatever it looks like. That is the entire purpose of `isAmbiguous` in encode:
  // without it, `{ s: "1" }` comes back as `{ s: 1 }`.
  if (wasQuoted) return value;

  if (value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Convenience: decode a block straight to typed rows. */
export function decodeRows(text, opts = {}) {
  return decodeBlock(text, opts).map((cells) => cells.map(decodeCell));
}
