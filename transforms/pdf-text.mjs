// PDF text extraction — Tier 1.
//
// ONE RESPONSIBILITY: turn a decoded content stream into positioned text runs. It does no layout analysis.
//
// A content stream is postfix: operands come first, then the operator. `72 720 Td` moves; `(Hello) Tj` shows a string.
// So the tokeniser pushes operands onto a stack and an operator consumes them — which is also why an unknown operator is
// harmless, as long as its operands are cleared.
//
// WHAT THIS TIER CLAIMS. Text and its position, in the order the stream draws it. That order is reading order for a
// single-column page and is NOT reading order for two columns — which is why the output carries the y coordinate rather
// than a finished string. Deciding reading order is the next tier's job, and pretending otherwise here would bake a
// wrong assumption into the data.
//
// THE ONE THING WORTH KNOWING ABOUT PDF STRINGS: parentheses nest, and a `\)` does not close one. A tokeniser that scans
// for the next `)` truncates any string containing a smiley or a citation — which is common enough that getting it wrong
// looks like random text loss.

import { makeFontDecoder, parseWidths } from "../util/pdffont.mjs";
import { parseDict, refTo, decodeStream } from "../util/pdfobj.mjs";
import { readingOrder } from "./pdf-columns.mjs";

/** Escapes inside a PDF string literal. */
const ESCAPES = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };

/**
 * Read a string literal starting at an opening parenthesis.
 *
 * Returns the bytes and where it ended. Bytes rather than characters, because what these codes MEAN depends on the font
 * in effect, which the tokeniser does not know and must not guess.
 */
export function readLiteral(s, start) {
  const out = [];
  let depth = 1;
  let i = start + 1;

  while (i < s.length) {
    const ch = s[i];

    if (ch === "\\") {
      const next = s[i + 1];
      // An octal escape is up to three digits: `\101` is "A". Reading a fixed three would swallow a following digit.
      if (next >= "0" && next <= "7") {
        const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1))[0];
        out.push(parseInt(oct, 8) & 0xff);
        i += 1 + oct.length;
        continue;
      }
      // A backslash before a newline is a line continuation and contributes nothing.
      if (next === "\n") { i += 2; continue; }
      if (next === "\r") { i += s[i + 2] === "\n" ? 3 : 2; continue; }
      if (ESCAPES[next] !== undefined) { out.push(ESCAPES[next].charCodeAt(0)); i += 2; continue; }
      // An unknown escape means the character itself, per the specification.
      out.push(next?.charCodeAt(0) ?? 0);
      i += 2;
      continue;
    }

    // Parentheses NEST. `(a (b) c)` is one string, and scanning for the first `)` would cut it at "a (b".
    if (ch === "(") { depth += 1; out.push(40); i += 1; continue; }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { bytes: Buffer.from(out), end: i + 1 };
      out.push(41);
      i += 1;
      continue;
    }

    out.push(s.charCodeAt(i) & 0xff);
    i += 1;
  }

  // Unterminated: return what was read rather than discarding it. A truncated stream still contains real text.
  return { bytes: Buffer.from(out), end: s.length };
}

/** Read a hex string `<48656C6C6F>`. An odd final digit is padded with zero, per the specification. */
export function readHex(s, start) {
  const end = s.indexOf(">", start);
  const body = (end === -1 ? s.slice(start + 1) : s.slice(start + 1, end)).replace(/[^0-9A-Fa-f]/g, "");
  const padded = body.length % 2 ? `${body}0` : body;
  return { bytes: Buffer.from(padded, "hex"), end: end === -1 ? s.length : end + 1 };
}

/**
 * Tokenise a content stream into operands and operators.
 *
 * Yields `{ op, args }` for each operator. Arrays are captured whole because `TJ` needs the mixed run of strings and
 * kerning numbers inside one; flattening it would lose which numbers sit between which strings.
 */
export function* tokenise(content) {
  const s = String(content);
  let stack = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === "%") { // a comment runs to end of line
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl + 1;
      continue;
    }
    if (/\s/.test(ch)) { i += 1; continue; }

    if (ch === "(") { const r = readLiteral(s, i); stack.push({ t: "str", bytes: r.bytes }); i = r.end; continue; }
    if (ch === "<" && s[i + 1] !== "<") { const r = readHex(s, i); stack.push({ t: "str", bytes: r.bytes }); i = r.end; continue; }

    if (ch === "[") {
      // An array of operands, read with its own small loop so nested strings inside it are handled properly.
      const items = [];
      let j = i + 1;
      while (j < s.length && s[j] !== "]") {
        if (/\s/.test(s[j])) { j += 1; continue; }
        if (s[j] === "(") { const r = readLiteral(s, j); items.push({ t: "str", bytes: r.bytes }); j = r.end; continue; }
        if (s[j] === "<") { const r = readHex(s, j); items.push({ t: "str", bytes: r.bytes }); j = r.end; continue; }
        const tok = /^[^\s\]]+/.exec(s.slice(j))[0];
        items.push({ t: "num", v: Number(tok) });
        j += tok.length;
      }
      stack.push({ t: "arr", items });
      i = j + 1;
      continue;
    }

    // A dictionary operand, as used by `BDC`. Skipped whole: its contents are marked-content properties, not text.
    if (s.startsWith("<<", i)) {
      let depth = 0;
      let j = i;
      while (j < s.length) {
        if (s.startsWith("<<", j)) { depth += 1; j += 2; continue; }
        if (s.startsWith(">>", j)) { depth -= 1; j += 2; if (!depth) break; continue; }
        j += 1;
      }
      stack.push({ t: "dict" });
      i = j;
      continue;
    }

    if (ch === "/") { const tok = /^\/[^\s/[\]<>(]*/.exec(s.slice(i))[0]; stack.push({ t: "name", v: tok.slice(1) }); i += tok.length; continue; }

    const tok = /^[^\s/[\]<>()]+/.exec(s.slice(i));
    if (!tok) { i += 1; continue; }

    if (/^[-+.\d]/.test(tok[0])) { stack.push({ t: "num", v: Number(tok[0]) }); i += tok[0].length; continue; }

    // An operator: yield it with everything accumulated, then clear. Clearing is what makes an unknown operator harmless.
    yield { op: tok[0], args: stack };
    stack = [];
    i += tok[0].length;
  }
}

/**
 * Run a content stream and collect positioned text runs.
 *
 * The text state that matters for extraction is small: which font is active, and where the text cursor is. Everything
 * else — colour, rendering mode, stroke width — affects appearance only.
 *
 * POSITION COMES FROM TWO MATRICES multiplied together. `Tm` sets the text matrix and `cm` sets the graphics matrix, and
 * a page that draws its body inside a translated coordinate system has its real y in the product. Tracking only `Tm`
 * gives coordinates that are internally consistent and wrong relative to the page, which shows up as a document whose
 * lines are in the right order and whose columns cannot be told apart.
 *
 * Returns runs, not lines. Grouping into lines is a layout decision and belongs to whoever knows whether this page has
 * one column or two.
 */
export function runContentStream(content, { fonts = new Map() } = {}) {
  const runs = [];

  // The graphics state stack, for `q`/`Q`. Only the translation and scale are tracked.
  let ctm = { a: 1, d: 1, e: 0, f: 0 };
  const stack = [];

  // Text state.
  let tm = { a: 1, d: 1, e: 0, f: 0 };
  let lineStart = { ...tm };
  let leading = 0;
  let font = null;
  let fontSize = 0;
  let charSpace = 0;
  let wordSpace = 0;
  let horizScale = 1;
  let unmapped = 0;

  const num = (args, i) => (args[i]?.t === "num" ? args[i].v : 0);

  const emit = (bytes) => {
    if (!bytes?.length) return;
    const text = font ? font.decode(bytes) : bytes.toString("latin1");
    if (font) unmapped = font.unmapped;
    if (!text) return;

    /**
     * The run's advance, from the font's real widths where they exist.
     *
     * Tier 1 used `text.length * size * 0.5`, which is enough to tell whether the next run continues a word. Column
     * detection needs the actual RIGHT EDGE of a line, and an estimate 20% wrong makes a two-column page look like one
     * column of long lines, or the reverse.
     *
     * Glyph space is 1/1000 em, hence the division. Character and word spacing are added because they are part of the
     * advance even though they contribute no glyph.
     */
    const glyphWidth = font?.widthOf?.(bytes) ?? null;
    const measured = glyphWidth !== null;
    const advance = measured
      ? (glyphWidth / 1000) * fontSize * horizScale + text.length * charSpace
      : text.length * fontSize * 0.5 * horizScale + text.length * charSpace;

    const scale = Math.abs(tm.a || 1) * Math.abs(ctm.a || 1);

    runs.push({
      text,
      // The device-space position: the text matrix composed with the graphics matrix.
      x: tm.e * ctm.a + ctm.e,
      y: tm.f * ctm.d + ctm.f,
      size: fontSize * Math.abs(tm.a || 1) * Math.abs(ctm.a || 1),
      width: advance * scale,
      // Whether that width came from the font or from an estimate. Carried through so a caller can decline to infer
      // columns from measurements it should not trust.
      measured,
    });

    tm.e += advance;
  };

  const nextLine = (tx, ty) => {
    lineStart = { ...lineStart, e: lineStart.e + tx, f: lineStart.f + ty };
    tm = { ...tm, e: lineStart.e, f: lineStart.f };
  };

  for (const { op, args } of tokenise(content)) {
    switch (op) {
      // --- graphics state ---
      case "q": stack.push({ ...ctm }); break;
      case "Q": ctm = stack.pop() ?? ctm; break;
      case "cm": {
        const [a, , , d, e, f] = [num(args, 0), num(args, 1), num(args, 2), num(args, 3), num(args, 4), num(args, 5)];
        // Composed, not replaced: nested `cm` operators multiply, and replacing loses the outer transform.
        ctm = { a: (a || 1) * ctm.a, d: (d || 1) * ctm.d, e: e * ctm.a + ctm.e, f: f * ctm.d + ctm.f };
        break;
      }

      // --- text object ---
      case "BT":
        tm = { a: 1, d: 1, e: 0, f: 0 };
        lineStart = { ...tm };
        break;
      case "ET": break;

      case "Tf":
        font = fonts.get(args[0]?.v) ?? null;
        fontSize = num(args, 1);
        break;

      case "TL": leading = num(args, 0); break;
      case "Tc": charSpace = num(args, 0); break;
      case "Tw": wordSpace = num(args, 0); break;
      case "Tz": horizScale = (num(args, 0) || 100) / 100; break;

      case "Tm": {
        const [a, , , d, e, f] = [num(args, 0), num(args, 1), num(args, 2), num(args, 3), num(args, 4), num(args, 5)];
        tm = { a: a || 1, d: d || 1, e, f };
        lineStart = { ...tm };
        break;
      }

      case "Td": nextLine(num(args, 0), num(args, 1)); break;
      case "TD":
        // `TD` also sets the leading, to the NEGATIVE of its vertical move. Missing that makes every later `T*` move by
        // zero, and the whole page collapses onto one line.
        leading = -num(args, 1);
        nextLine(num(args, 0), num(args, 1));
        break;
      case "T*": nextLine(0, -leading); break;

      // --- showing text ---
      case "Tj": emit(args[0]?.bytes); break;

      case "TJ": {
        // A mixed array of strings and kerning adjustments. A large negative adjustment is a SPACE that was never written
        // as a character — which is how justified text is set, and why extracting only the strings runs words together.
        for (const item of args[0]?.items ?? []) {
          if (item.t === "str") { emit(item.bytes); continue; }
          const kern = -item.v * fontSize * horizScale / 1000;
          tm.e += kern;
          if (kern > fontSize * 0.18 && runs.length) runs[runs.length - 1].text += " ";
        }
        break;
      }

      case "'":
        nextLine(0, -leading);
        emit(args[0]?.bytes);
        break;

      case '"':
        wordSpace = num(args, 0);
        charSpace = num(args, 1);
        nextLine(0, -leading);
        emit(args[2]?.bytes);
        break;

      default: break; // operands were already cleared, so an unknown operator costs nothing
    }
  }

  return { runs, unmapped };
}

/**
 * Group runs into lines by their vertical position.
 *
 * The tolerance is a FRACTION OF FONT SIZE rather than a fixed number of points, because a heading and a footnote on the
 * same page have different line spacings and one absolute threshold cannot suit both. Superscripts and subscripts sit
 * slightly off the baseline and must still join their line, which is what the tolerance buys.
 *
 * Within a line, runs are ordered by x. Across lines, by descending y — PDF's origin is the BOTTOM-left, so a larger y is
 * higher on the page and sorting ascending prints the document upside down.
 */
export function groupIntoLines(runs, { tolerance = 0.5 } = {}) {
  if (!runs.length) return [];

  const lines = [];

  for (const run of runs) {
    const size = run.size || 10;
    // The tolerance uses the LARGER of the line's size and the run's, and that is the fix for a real flaw.
    //
    // Sizing it by the incoming run alone gives small text a small tolerance — and small text is exactly what sits off
    // the baseline. A 6pt superscript beside 10pt body text is 4pt above it and would need a tolerance of 5pt, while its
    // own size only earns 3pt. So it became its own line, which puts a stray digit between two lines of prose.
    const line = lines.find((l) => Math.abs(l.y - run.y) <= Math.max(l.size, size) * tolerance);
    if (line) {
      line.runs.push(run);
      // The line's y drifts toward the largest text on it, which is what a reader perceives as the baseline.
      if (run.size > line.size) { line.y = run.y; line.size = run.size; }
    } else {
      lines.push({ y: run.y, size, runs: [run] });
    }
  }

  for (const line of lines) line.runs.sort((a, b) => a.x - b.x);
  lines.sort((a, b) => b.y - a.y);

  return lines;
}

/**
 * Join a line's runs into text.
 *
 * A GAP BETWEEN RUNS IS A SPACE, and this is where most extractors visibly fail. A PDF frequently draws each word as its
 * own run with no space character anywhere — the space is the distance. Joining without measuring gives
 * "thesupplierhallnotsubcontract".
 *
 * The threshold is a fraction of font size for the same reason the line tolerance is: a 24pt heading's word gap is wider
 * in points than an 8pt footnote's, and a fixed number of points would insert spaces mid-word in one and none in the
 * other.
 */
export function joinLine(line, { gapRatio = 0.25 } = {}) {
  let out = "";
  let prev = null;

  for (const run of line.runs) {
    if (prev) {
      const gap = run.x - prev.x;
      const expected = prev.text.length * prev.size * 0.5;
      const overshoot = gap - expected;
      if (overshoot > (run.size || 10) * gapRatio && !/\s$/.test(out) && !/^\s/.test(run.text)) out += " ";
    }
    out += run.text;
    prev = run;
  }

  return out.replace(/[ \t]{2,}/g, " ").trimEnd();
}

/**
 * Extract one page's text.
 *
 * Returns the text plus a confidence basis, because Tier 1 makes a claim it must be able to justify: order follows the
 * page's own drawing order, which is reading order for one column and is not for two. Saying which is what lets a caller
 * decide how much to trust the sequence — and it matters far more in a contract than in a report.
 */
export function extractPage(content, { fonts = new Map(), columns = true } = {}) {
  const { runs, unmapped } = runContentStream(content, { fonts });
  const lines = groupIntoLines(runs);

  /**
   * Positioned lines, with a horizontal EXTENT.
   *
   * `x` is the leftmost run's origin and `width` reaches the rightmost run's right edge — not the sum of the runs' widths,
   * because runs on a line are separated by gaps and summing them understates the extent by exactly those gaps.
   *
   * `measured` is false if ANY run on the line fell back to an estimate. Column detection then knows the line's edge is
   * approximate, which matters because one badly-measured line can invent or erase a gutter.
   */
  const positioned = lines.map((l) => {
    const left = Math.min(...l.runs.map((r) => r.x));
    const right = Math.max(...l.runs.map((r) => r.x + (r.width ?? 0)));
    return {
      y: l.y,
      size: l.size,
      x: left,
      width: Math.max(0, right - left),
      measured: l.runs.every((r) => r.measured),
      text: joinLine(l),
      // The runs themselves, kept because a table is detected from CELL positions and a joined line has none.
      //
      // A line reading "North   1200   Aug" is one string; the same line as three runs at x=72, x=200 and x=320 is a row
      // whose columns can be compared against the row below it. Table detection is impossible without them, and
      // re-deriving them later would mean extracting the page twice.
      runs: l.runs.map((r) => ({ text: r.text, x: r.x, width: r.width ?? 0 })),
    };
  }).filter((l) => l.text.trim());

  // Reading order. Single-column pages are unaffected; a two-column page is reordered, and the basis says which happened.
  const ordered = columns ? readingOrder(positioned) : { lines: positioned, columns: 1, basis: "column detection disabled" };
  const text = ordered.lines.map((l) => l.text).join("\n");

  // A page where most codes resolved to nothing is a page whose fonts have no recovery path. Reporting the ratio lets a
  // caller refuse the page rather than accept a handful of stray letters as its content.
  const glyphs = runs.reduce((n, r) => n + r.text.length, 0);
  const reliability = glyphs + unmapped === 0 ? 1 : glyphs / (glyphs + unmapped);

  return {
    text,
    lines: ordered.lines.length,
    positioned: ordered.lines,
    runs: runs.length,
    unmapped,
    reliability,
    columns: ordered.columns,
    basis: ordered.basis,
  };
}

/**
 * Build a decoder per font name from a page's resources.
 *
 * The map is keyed by the RESOURCE NAME (`F1`, `TT2`) because that is what `Tf` names in the content stream. Two pages
 * can use the same name for different fonts, which is why this is built per page rather than once per document.
 */
export function buildPageFonts(bytes, objects, pageObj) {
  const fonts = new Map();
  const resources = parseDict(pageObj.body).Resources ?? "";

  // Resources may be inline or an indirect reference.
  const resText = refTo(resources) != null
    ? (objects.get(refTo(resources))?.body ?? "")
    : resources;

  const fontDict = parseDict(resText).Font ?? "";
  const fontText = refTo(fontDict) != null ? (objects.get(refTo(fontDict))?.body ?? "") : fontDict;

  for (const m of String(fontText).matchAll(/\/([A-Za-z0-9.+_-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fontObj = objects.get(Number(m[2]));
    if (!fontObj) continue;
    fonts.set(m[1], buildFontDecoder(bytes, objects, fontObj));
  }

  return fonts;
}

/** Assemble one font's decoder by walking every rung of the ladder that this font provides. */
function buildFontDecoder(bytes, objects, fontObj) {
  const dict = parseDict(fontObj.body);

  let toUnicode = null;
  const tuRef = refTo(dict.ToUnicode);
  if (tuRef != null && objects.has(tuRef)) {
    try {
      const decoded = decodeStream(bytes, objects.get(tuRef));
      if (decoded && !decoded.undecoded) toUnicode = decoded.data.toString("latin1");
    } catch { /* an unreadable CMap drops to the next rung rather than failing the font */ }
  }

  // The encoding may be a name, or a dictionary carrying /Differences and a base.
  const encRef = refTo(dict.Encoding);
  const encText = encRef != null ? (objects.get(encRef)?.body ?? "") : String(dict.Encoding ?? "");
  const encDict = parseDict(encText);

  // A descendant font is where a Type0 font's real encoding lives; its presence also confirms two-byte codes.
  const isType0 = /\/Subtype\s*\/Type0\b/.test(fontObj.body);

  return makeFontDecoder({
    toUnicode,
    differences: encDict.Differences ?? null,
    baseEncoding: encDict.BaseEncoding ?? encText,
    identity: isType0 || /\/Identity-[HV]\b/.test(encText),
    // Real character widths, which is what makes column detection trustworthy. A Type0 font's widths live on its
    // DESCENDANT font, so that body is used when present — reading /Widths from the parent would find nothing and fall
    // back to an estimate on exactly the fonts most likely to be in a multi-column paper.
    widths: parseWidths(descendantBody(objects, fontObj) ?? fontObj.body, { objects }),
  });
}

/** A Type0 font's metrics live on its descendant. Returns null for a simple font, whose own dictionary carries them. */
function descendantBody(objects, fontObj) {
  const df = parseDict(fontObj.body).DescendantFonts;
  if (!df) return null;
  const ref = refTo(df) ?? Number((String(df).match(/(\d+)\s+\d+\s+R/) ?? [])[1]);
  return Number.isFinite(ref) && objects.has(ref) ? objects.get(ref).body : null;
}
