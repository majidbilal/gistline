// Columnar encoding of template values.
//
// ONE RESPONSIBILITY: take the value rows a template produced and encode them column by column. It extracts no templates.
//
// THE GAP THIS CLOSES. Logs compress to 29.2% where JSON reaches 67.9%, and the reason is structural rather than a tuning
// problem: template extraction removes the repeated FORMAT WORDS, but a timestamp masked as `<ts>` still has to be emitted
// in the values row, so it MOVES rather than shrinks. In a 62-character log line the timestamp is 20 of those characters
// and templating cannot touch them.
//
// THE INSIGHT IS THAT A COLUMN IS MORE PREDICTABLE THAN A ROW. Read row-wise, consecutive values are unrelated —
// a timestamp, then a worker id, then a count. Read COLUMN-wise, they are a series: timestamps ascending by seconds, a
// worker id cycling through eight values, a counter incrementing. Each of those has a cheap description.
//
// Three encodings, chosen per column by measuring all of them and keeping the smallest:
//
//   delta      each value as its difference from the previous one   14:22:01 14:22:04 14:22:09  ->  14:22:01 +3 +5
//   dictionary repeated values as short references                  worker-3 x150               ->  legend + w1 x150
//   runs       consecutive identical values as a count              INFO INFO INFO              ->  INFO*3
//
// LOSSLESS, and verified per column: an encoding is only used if decoding it reproduces the column exactly. A column that
// fails is emitted verbatim rather than approximated.

/** A column is only worth encoding if it has enough values for a header to pay for itself. */
export const MIN_ROWS = 4;

/** Encodings, in the order they are tried. Order does not affect the result — the smallest wins — only the tie-break. */
export const ENCODINGS = ["verbatim", "delta", "dict", "runs"];

/**
 * Is every value an integer, and are the differences smaller than the values?
 *
 * Delta encoding only pays when the series is dense: `1, 2, 3` becomes `1 +1 +1`, but `5, 9000, 12` becomes
 * `5 +8995 -8988`, which is larger. Measured rather than assumed, because "timestamps are ascending" is true of most logs
 * and false of a log with interleaved sources.
 */
export function encodeDelta(values) {
  const nums = values.map((v) => (/^-?\d+$/.test(String(v).trim()) ? Number(String(v).trim()) : null));
  if (nums.some((n) => n === null)) return null;

  const out = [String(nums[0])];
  for (let i = 1; i < nums.length; i++) {
    const d = nums[i] - nums[i - 1];
    out.push(d >= 0 ? `+${d}` : String(d));
  }
  return out.join(" ");
}

/** Reverse `encodeDelta`. Its existence is what makes the encoding testably lossless. */
export function decodeDelta(text) {
  const parts = String(text).trim().split(/\s+/);
  if (!parts.length || !parts[0]) return [];

  let current = Number(parts[0]);
  if (!Number.isFinite(current)) return null;

  const out = [String(current)];
  for (const p of parts.slice(1)) {
    const d = Number(p);
    if (!Number.isFinite(d)) return null;
    current += d;
    out.push(String(current));
  }
  return out;
}

/**
 * Dictionary encoding: distinct values listed once, then referenced.
 *
 * Pays when a column has few distinct values relative to its length — a worker id cycling through eight, a log level
 * through four. Does not pay when every value is unique, which is why the caller measures rather than assuming.
 *
 * References are `\u0001N` rather than a printable token, because any printable marker could collide with a real value and
 * would then need escaping. A control character cannot appear in the masked values a template produces.
 */
export function encodeDict(values) {
  const distinct = [...new Set(values.map(String))];
  // More than half distinct means the legend costs more than the references save.
  if (distinct.length > values.length / 2) return null;

  const index = new Map(distinct.map((v, i) => [v, i]));
  const legend = distinct.join("\u0002");
  const refs = values.map((v) => `\u0001${index.get(String(v))}`).join("");
  return `${legend}\u0003${refs}`;
}

/** Reverse `encodeDict`. */
export function decodeDict(text) {
  const cut = String(text).indexOf("\u0003");
  if (cut === -1) return null;

  const legend = String(text).slice(0, cut).split("\u0002");
  const refs = String(text).slice(cut + 1);

  const out = [];
  for (const r of refs.split("\u0001")) {
    if (!r) continue;
    const i = Number(r);
    if (!Number.isInteger(i) || i < 0 || i >= legend.length) return null;
    out.push(legend[i]);
  }
  return out;
}

/**
 * Run-length encoding: consecutive identical values as a count.
 *
 * Pays on a column that is constant for long stretches — a log level that stays INFO for a thousand lines. Useless on an
 * alternating column, and the size comparison catches that.
 */
export function encodeRuns(values) {
  const out = [];
  let i = 0;
  while (i < values.length) {
    let n = 1;
    while (i + n < values.length && String(values[i + n]) === String(values[i])) n += 1;
    out.push(n > 1 ? `${values[i]}\u0001${n}` : String(values[i]));
    i += n;
  }
  return out.join("\u0002");
}

/** Reverse `encodeRuns`. */
export function decodeRuns(text) {
  const out = [];
  for (const part of String(text).split("\u0002")) {
    const [value, count] = part.split("\u0001");
    const n = count === undefined ? 1 : Number(count);
    if (!Number.isInteger(n) || n < 1) return null;
    for (let i = 0; i < n; i++) out.push(value);
  }
  return out;
}

/** Verbatim, as the baseline every other encoding must beat. */
export const encodeVerbatim = (values) => values.map(String).join("\u0002");
export const decodeVerbatim = (text) => String(text).split("\u0002");

const CODECS = {
  verbatim: { encode: encodeVerbatim, decode: decodeVerbatim },
  delta: { encode: encodeDelta, decode: decodeDelta },
  dict: { encode: encodeDict, decode: decodeDict },
  runs: { encode: encodeRuns, decode: decodeRuns },
};

/**
 * Choose the smallest encoding that round-trips this column exactly.
 *
 * MEASURED, NOT PREDICTED. Every applicable encoding is tried, its output measured, and its decode compared against the
 * input. Heuristics like "timestamps are ascending so use delta" are true of most logs and wrong on a log with interleaved
 * sources — and being wrong there means being LARGER, which is the one outcome a compressor must not produce silently.
 *
 * A column whose best encoding is verbatim is emitted verbatim. That is a success, not a failure.
 */
export function encodeColumn(values, { minRows = MIN_ROWS } = {}) {
  const strings = values.map((v) => (v === null || v === undefined ? "" : String(v)));

  if (strings.length < minRows) {
    return { encoding: "verbatim", text: encodeVerbatim(strings), rows: strings.length };
  }

  let best = { encoding: "verbatim", text: encodeVerbatim(strings) };

  for (const name of ENCODINGS) {
    if (name === "verbatim") continue;

    let text;
    try { text = CODECS[name].encode(strings); }
    catch { continue; }
    if (text === null || text === undefined) continue;
    if (text.length >= best.text.length) continue;

    // The lossless check, per column. An encoding that does not reproduce its input exactly is discarded, however small.
    let back;
    try { back = CODECS[name].decode(text); }
    catch { continue; }
    if (!Array.isArray(back) || back.length !== strings.length) continue;
    if (back.some((v, i) => v !== strings[i])) continue;

    best = { encoding: name, text };
  }

  return { ...best, rows: strings.length };
}

/** Decode one column. */
export function decodeColumn(encoding, text) {
  const codec = CODECS[encoding];
  if (!codec) return null;
  return codec.decode(text);
}

/**
 * Timestamps, which are where a log's real cost is.
 *
 * A column of ISO timestamps is 20 characters per row and templating cannot touch it. But consecutive timestamps differ by
 * seconds, so as deltas they are two or three characters — and that single column is often a third of a log's remaining
 * size after templating.
 *
 * The generic delta encoder cannot help, because it needs integers. So a timestamp column is converted to epoch seconds
 * first, delta-encoded, and converted back on decode. The original TEXT FORM is recorded so the reconstruction is exact
 * rather than merely equivalent: `2026-08-03T14:22:01Z` and `2026-08-03T14:22:01.000Z` are the same instant and different
 * strings, and a compressor claiming lossless must return the one it was given.
 */
const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parse to epoch seconds plus the parts needed to rebuild the exact original string. */
function parseStamp(s) {
  const m = ISO.exec(String(s).trim());
  if (!m) return null;
  const [, Y, M, D, h, mi, sec, frac, zone] = m;
  const epoch = Date.UTC(Number(Y), Number(M) - 1, Number(D), Number(h), Number(mi), Number(sec)) / 1000;
  if (!Number.isFinite(epoch)) return null;
  return { epoch, frac: frac ?? "", zone: zone ?? "", sep: String(s).includes("T") ? "T" : " " };
}

/** Rebuild the exact string from epoch seconds and the recorded parts. */
function formatStamp(epoch, { frac, zone, sep }) {
  const d = new Date(epoch * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}${sep}`
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${frac}${zone}`;
}

/**
 * Encode a timestamp column.
 *
 * Returns null unless EVERY value parses and every value shares the same fractional-and-zone shape. A mixed column would
 * need per-row metadata, which costs more than it saves — and handling it would be speculative complexity for a case that
 * does not occur in a single log stream.
 */
export function encodeStamps(values) {
  const parsed = values.map(parseStamp);
  if (parsed.some((p) => p === null)) return null;

  const { frac, zone, sep } = parsed[0];
  if (parsed.some((p) => p.frac !== frac || p.zone !== zone || p.sep !== sep)) return null;

  const deltas = [String(parsed[0].epoch)];
  for (let i = 1; i < parsed.length; i++) {
    const d = parsed[i].epoch - parsed[i - 1].epoch;
    deltas.push(d >= 0 ? `+${d}` : String(d));
  }

  // The shape is stored once, in a header, rather than per row.
  return `${sep}${frac}${zone}\u0003${deltas.join(" ")}`;
}

/** Reverse `encodeStamps`. */
export function decodeStamps(text) {
  const cut = String(text).indexOf("\u0003");
  if (cut === -1) return null;

  const shape = String(text).slice(0, cut);
  const sep = shape[0] === "T" ? "T" : " ";
  const rest = shape.slice(1);
  const zoneMatch = rest.match(/(Z|[+-]\d{2}:?\d{2})$/);
  const zone = zoneMatch ? zoneMatch[1] : "";
  const frac = zone ? rest.slice(0, -zone.length) : rest;

  const parts = String(text).slice(cut + 1).trim().split(/\s+/);
  let epoch = Number(parts[0]);
  if (!Number.isFinite(epoch)) return null;

  const out = [formatStamp(epoch, { frac, zone, sep })];
  for (const p of parts.slice(1)) {
    const d = Number(p);
    if (!Number.isFinite(d)) return null;
    epoch += d;
    out.push(formatStamp(epoch, { frac, zone, sep }));
  }
  return out;
}

// Registered after the generic codecs so a timestamp column is tried as timestamps before falling back.
CODECS.stamps = { encode: encodeStamps, decode: decodeStamps };
ENCODINGS.push("stamps");
