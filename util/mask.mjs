// Variable masking.
//
// ONE RESPONSIBILITY: replace the high-entropy parts of a line with typed placeholders, and CAPTURE WHAT WAS REPLACED.
//
// The capture is what makes this lossless. A masker that turns a timestamp into `<ts>` and forgets the timestamp is a
// deleter with better manners.
//
// RAW SUBSTRINGS, NEVER PARSED VALUES. `007`, `7` and `7.0` all mask to `<n>`, so the captured value must be the
// original TEXT. The design document for this feature originally showed captured values as `3,142,1.8` — already
// parsed — which would have returned `007` as `7`. That is the same defect the table work hit with numeric-looking
// strings, re-derived one screen after documenting it. Hence the rule, stated here where the code is.
//
// ORDER MATTERS AND IS FIXED. A timestamp contains digits, so `<n>` must not get to it first. The patterns below run in
// order, longest-and-most-specific first, and that order is part of the contract rather than an accident of the array.

/**
 * ONE combined pattern, alternation-ordered.
 *
 * This is a correctness fix, not an optimisation — though it is also faster.
 *
 * The first version applied eight patterns SEQUENTIALLY. That cannot preserve appearance order: in
 * `GET /api/users/4821 200 18ms from 10.0.0.14:53312` the IP pattern runs before the path pattern, so the IP was
 * captured first even though the path appears first. `unmask` then consumed values left to right and produced
 * `GET 10.0.0.14:53312 /api/users/4821 …` — the values transposed. A round-trip test caught it.
 *
 * A single pass with alternation matches in POSITION order by construction, so capture order and placeholder order
 * agree and cannot drift. Alternation order carries the precedence that sequential application used to: a timestamp is
 * listed before a bare number, so `<n>` never reaches a timestamp's digits.
 *
 * Group names are suffixed because a JS regex may not repeat a name; the type is the name without its digit.
 *
 * Every branch is anchored to a boundary and free of nested quantifiers, so it cannot backtrack catastrophically — a
 * hung regex on a 40 MB log is a hung build.
 */
const MASK_RE = new RegExp(
  [
    // ISO-8601, with or without milliseconds and zone. Before the number branch.
    String.raw`(?<ts1>\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)`,
    // Bare clock time.
    String.raw`(?<ts2>\b\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?\b)`,
    // UUID.
    String.raw`(?<id1>\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b)`,
    // Absolute paths, POSIX and Windows. BEFORE ip and n, so a path with digits survives whole.
    String.raw`(?<path1>(?:[A-Za-z]:)?[\\/](?:[\w.-]+[\\/])+[\w.-]+)`,
    // IPv4 with optional port.
    String.raw`(?<ip1>\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b)`,
    // Long hex: SHAs, hashes, addresses. 8+ so short words like "beef" are untouched.
    String.raw`(?<id2>\b(?:0x)?[0-9a-fA-F]{8,}\b)`,
    // Quoted strings. Single-line so an unterminated quote cannot run away.
    String.raw`(?<str1>"[^"\n]*")`,
    // Numbers last: integers, decimals, sizes with a unit.
    String.raw`(?<n1>\b\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|KB|MB|GB|%)?\b)`,
  ].join("|"),
  "g",
);

/** Which named group matched, reduced to its type. */
const typeOf = (groups) => {
  for (const [name, value] of Object.entries(groups)) {
    if (value !== undefined) return name.replace(/\d+$/, "");
  }
  return "n";
};

/** The placeholder text for a type. Angle brackets: rare in log prose, obvious to a reader. */
const slot = (type) => `<${type}>`;

/**
 * Mask a line.
 *
 * Returns the masked template and the raw substrings that were removed, IN APPEARANCE ORDER — which is what makes
 * `unmask(template, values)` reproduce the original exactly.
 */
export function mask(line) {
  const values = [];
  const template = String(line).replace(MASK_RE, (m, ...rest) => {
    const groups = rest[rest.length - 1];
    values.push(m);
    return slot(typeOf(groups));
  });
  return { template, values };
}

/**
 * Reverse `mask` exactly.
 *
 * Its existence is what makes the masking testably lossless: if `unmask(mask(x)) !== x`, the transform is lying.
 * Values are consumed in order, which is why `mask` must return them in appearance order.
 */
export function unmask(template, values) {
  let i = 0;
  return String(template).replace(/<(?:ts|id|ip|path|str|n)>/g, () => (i < values.length ? values[i++] : ""));
}

/** The placeholder count in a template — how many values a matching line must supply. */
export const slotCount = (template) => (String(template).match(/<(?:ts|id|ip|path|str|n)>/g) ?? []).length;

/**
 * The first `n` tokens of a template that are NOT placeholders.
 *
 * These are the literal words that identify a format — `processed`, `records`, `Error:` — and they are the grouping
 * key. Keying on the first token instead fails badly: after masking, nearly every log line begins with `<ts>`, so the
 * first token carries no information at all. That was the original design's key, and it collapsed in exactly that way.
 */
export function anchorTokens(template, n = 3) {
  const out = [];
  for (const tok of String(template).split(/\s+/)) {
    if (!tok || /^<(?:ts|id|ip|path|str|n)>$/.test(tok)) continue;
    out.push(tok);
    if (out.length === n) break;
  }
  return out;
}
