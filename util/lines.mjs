// Lines.
//
// ONE RESPONSIBILITY: decide what "a line" is, in one place.
//
// WHY THIS IS ITS OWN MODULE. Five transforms each call `split("\n")` on the same text and each therefore decides
// independently how to treat `\r\n` and a trailing newline. Those five decisions are currently the same by luck; the
// moment one transform preserves a trailing newline and another does not, output stops round-tripping and the cause is
// spread across five files.
//
// Splitting is also the single most repeated operation on the hot path, so doing it once and sharing the result is a
// time win as well as a correctness one.

/**
 * Split text into lines, remembering how it ended.
 *
 * The `trailing` flag matters: `"a\nb"` and `"a\nb\n"` are different texts, and a transform that rejoins without it
 * silently adds or removes a byte. Byte-exactness is the whole claim of the lossless path, so a byte is not a detail.
 *
 * `\r\n` is normalised to `\n` for processing and the `crlf` flag records it, so `join()` can restore the original
 * ending rather than converting a Windows log to Unix line endings as a side effect of compression.
 */
export function split(text) {
  const raw = String(text ?? "");
  if (raw === "") return { lines: [], trailing: false, crlf: false };

  const crlf = raw.includes("\r\n");
  const normalised = crlf ? raw.replace(/\r\n/g, "\n") : raw;
  const trailing = normalised.endsWith("\n");
  const body = trailing ? normalised.slice(0, -1) : normalised;

  return { lines: body.split("\n"), trailing, crlf };
}

/** Rejoin, restoring the original ending exactly. `join(split(x))` must equal `x` for any x. */
export function join({ lines, trailing = false, crlf = false }) {
  if (!lines.length) return "";
  const body = lines.join("\n") + (trailing ? "\n" : "");
  return crlf ? body.replace(/\n/g, "\r\n") : body;
}

/** Convenience for callers that only need the array and will not rejoin. */
export const toLines = (text) => split(text).lines;

/**
 * Is this line worth keeping when something must be dropped?
 *
 * Shared because four transforms need the same judgement, and because "interesting" drifting apart between them is how
 * a failure survives one path and is dropped by another. Kept as data rather than scattered regexes so it can be
 * reviewed as a list.
 *
 * The ordering is deliberate: an error outranks a warning outranks a summary. A caller dropping lines under pressure
 * should drop the lowest rank first.
 */
const RANKS = [
  // rank 3 — a failure. Never dropped while anything else could be.
  //
  // `not ok` is listed FIRST and explicitly, because it is TAP's failure marker and none of the words below match it. A test
  // caught this: `rank("not ok 2 - b")` returned 0, so the single most important line in a test run was treated as ordinary
  // and dropped. It only surfaced once another transform began winning ahead of the test-specific strategy, which had its
  // own handling — a gap in shared code, hidden by a special case elsewhere.
  //
  // NOT anchored to the line start. The first attempt was `/^\s*not ok\b/`, and a transform that prefixes rows — `V1\u0004`
  // for a verbatim row in the columnar form — defeated the anchor, so the failure was ranked 0 again and dropped again. The
  // trailing `\b` is what keeps it precise: "not okay to proceed" has a word character after "ok" and does not match.
  [3, /\bnot ok\b/i],
  [3, /\b(?:error|fail(?:ed|ure)?|exception|panic|fatal|assert(?:ion)?|refused|denied|timeout|traceback)\b/i],
  // rank 2 — a warning, or a count that tells you the shape of the run.
  [2, /\b(?:warn(?:ing)?|deprecat|skipped|todo|retry|retrying)\b/i],
  [2, /^\s*#?\s*(?:tests?|pass|fail|suites?|duration_ms|cancelled|skipped)\b/i],
  // rank 1 — structural markers a reader uses to orient.
  [1, /^\s*(?:[-=*]{3,}|#{1,6}\s|\d+\)\s|at\s)/],
];

/** 0 = ordinary, 3 = a failure. Higher survives longer. */
export function rank(line) {
  // camelCase is split before matching, and this is not cosmetic.
  //
  // `\berror\b` does NOT match inside `AssertionError`: "n" and "E" are both word characters, so there is no boundary.
  // The same is true of `TypeError`, `ValueError`, `RuntimeException` — the most common failure markers in real test
  // output. A test scored `AssertionError: expected 1` as ORDINARY, which would have dropped it under budget pressure.
  //
  // Splitting on the lowercase-to-uppercase transition fixes it precisely: `AssertionError` becomes
  // `Assertion Error` and matches, while `terror` is untouched and still does not. Dropping the right-hand `\b`
  // instead would have matched `terror`, so the case transition is doing real work.
  const normalised = line.replace(/([a-z])([A-Z])/g, "$1 $2");
  for (const [r, re] of RANKS) if (re.test(normalised)) return r;
  return 0;
}

/** The needles a reader would grep for. Used by the fidelity harness as well as by lossy transforms. */
export const isInteresting = (line) => rank(line) > 0;

/**
 * Group consecutive identical lines, preserving order and count.
 *
 * Lossless: the count plus the line reconstructs the original exactly. Returned as data rather than text so a caller
 * decides how to render it — `dedup` wants "×47", a reader might want something else.
 */
export function foldRuns(lines) {
  const out = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    if (last && last.line === line) last.count += 1;
    else out.push({ line, count: 1 });
  }
  return out;
}

/** Reverse `foldRuns` exactly. Its existence is what makes the fold testably lossless. */
export function unfoldRuns(runs) {
  const out = [];
  for (const { line, count } of runs) for (let i = 0; i < count; i++) out.push(line);
  return out;
}
