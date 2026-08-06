// PDF font decoding — the encoding ladder.
//
// ONE RESPONSIBILITY: turn the byte codes in a content stream into characters. It reads no streams and shows no text.
//
// THE PROBLEM. A PDF string is a sequence of CODES, not characters. What character a code means is decided by the font it
// is shown in, and there are several independent mechanisms for saying so. Get this wrong and the extracted text is
// plausible-looking mojibake — which is worse than nothing, because nothing downstream can detect it.
//
// THE LADDER, in order of reliability. Every path is tried before a code is given up on:
//
//   1. /ToUnicode CMap        an explicit code-to-Unicode map. Definitive.
//   2. /Differences + names   the encoding array names each glyph; names map to Unicode. Definitive.
//   3. Base encoding          /WinAnsiEncoding and friends are fixed tables.
//   4. Implicit standard      a simple font with no encoding at all is effectively StandardEncoding for ASCII.
//
// Path 2 is the one usually omitted from summaries of this problem, and omitting it makes subsetted fonts look hopeless
// when they are not. A subset font with named glyphs is perfectly readable.
//
// WHAT IS NOT ATTEMPTED: guessing a mapping from letter frequencies. It would produce fluent, confident, wrong text —
// the single worst output this tool could emit.

import { parseDict, refTo } from "./pdfobj.mjs";

/**
 * Glyph name to character.
 *
 * Three mechanisms, in order:
 *   - the algorithmic forms `uniXXXX` and `uXXXXXX`, which cover any character
 *   - a table of the names that actually appear in Latin text
 *   - a single-character name, which means itself
 *
 * The table is a SUBSET of the Adobe Glyph List, chosen for the names a business document uses. The full list is
 * thousands of entries and shipping it would be most of this file for a fraction of the benefit; a name that is missing
 * falls through and is reported as unmapped rather than guessed.
 */
const GLYPH_NAMES = {
  space: " ", exclam: "!", quotedbl: '"', numbersign: "#", dollar: "$", percent: "%", ampersand: "&",
  quotesingle: "'", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-",
  period: ".", slash: "/", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">",
  question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", asciicircum: "^",
  underscore: "_", grave: "`", braceleft: "{", bar: "|", braceright: "}", asciitilde: "~",
  quoteleft: "\u2018", quoteright: "\u2019", quotedblleft: "\u201c", quotedblright: "\u201d",
  endash: "\u2013", emdash: "\u2014", bullet: "\u2022", ellipsis: "\u2026", dagger: "\u2020",
  sterling: "\u00a3", euro: "\u20ac", yen: "\u00a5", cent: "\u00a2", currency: "\u00a4",
  section: "\u00a7", paragraph: "\u00b6", copyright: "\u00a9", registered: "\u00ae", trademark: "\u2122",
  degree: "\u00b0", plusminus: "\u00b1", multiply: "\u00d7", divide: "\u00f7", minus: "\u2212",
  onequarter: "\u00bc", onehalf: "\u00bd", threequarters: "\u00be", fraction: "\u2044",
  guillemotleft: "\u00ab", guillemotright: "\u00bb", quotesinglbase: "\u201a", quotedblbase: "\u201e",
  // Ligatures, which appear constantly in typeset text and would otherwise be lost mid-word.
  fi: "\ufb01", fl: "\ufb02", ff: "\uff46\uff46", ffi: "ffi", ffl: "ffl",
  // A non-breaking space renders as a space and must not be dropped: doing so joins two words.
  nbspace: "\u00a0", uni00A0: "\u00a0",
};

/** Accented letters, built from a base letter and an accent name, which is how the AGL forms most of them. */
const ACCENTS = { acute: "\u0301", grave: "\u0300", circumflex: "\u0302", tilde: "\u0303", dieresis: "\u0308", ring: "\u030a", cedilla: "\u0327", caron: "\u030c", macron: "\u0304", breve: "\u0306", ogonek: "\u0328", slash: "\u0338" };

/**
 * Resolve one glyph name.
 *
 * Returns null when nothing maps — deliberately, so the caller can count unmapped codes and report that the text is
 * unreliable rather than emitting a wrong character.
 */
export function glyphToChar(name) {
  if (!name) return null;
  const n = String(name).replace(/^\//, "");

  // Algorithmic forms first: they are unambiguous and cover everything.
  const uni = /^uni([0-9A-Fa-f]{4,6})$/.exec(n);
  if (uni) return safeChar(parseInt(uni[1], 16));
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(n);
  if (u) return safeChar(parseInt(u[1], 16));

  if (GLYPH_NAMES[n]) return GLYPH_NAMES[n];

  // A single character names itself: `/a` is "a".
  if (n.length === 1) return n;

  // Base letter plus accent, e.g. `aacute`, `Ograve`, `ccedilla`.
  const accent = Object.keys(ACCENTS).find((a) => n.length > a.length && n.endsWith(a));
  if (accent) {
    const base = n.slice(0, -accent.length);
    if (base.length === 1) return base.normalize("NFC") + ACCENTS[accent];
  }

  // A name suffixed for a small-caps or alternate variant still means its base character.
  const variant = /^([A-Za-z]+)\.(?:sc|alt|oldstyle|lf|tf|sups|subs|\d+)$/.exec(n);
  if (variant) return glyphToChar(variant[1]);

  // `g47`, `cid1234`, `index99`, `glyph12` are position references with no character meaning at all. Named explicitly so
  // the caller can distinguish "unmappable by design" from "a name I do not know".
  if (/^(?:g|cid|index|glyph)\d+$/i.test(n)) return null;

  return null;
}

const safeChar = (code) => {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  try { return String.fromCodePoint(code); } catch { return null; }
};

/**
 * WinAnsiEncoding, for the codes that differ from Latin-1.
 *
 * Only the 0x80–0x9F range is listed. Everything else in WinAnsi matches Latin-1, so a table of 256 entries would be 224
 * lines restating `String.fromCharCode(code)`. This range is exactly where a naive Latin-1 reading goes wrong — and it
 * contains the smart quotes, dashes and ellipsis that appear in nearly every real document, so getting it wrong is
 * visible in the first paragraph.
 */
const WIN_ANSI_HIGH = {
  0x80: "\u20ac", 0x82: "\u201a", 0x83: "\u0192", 0x84: "\u201e", 0x85: "\u2026", 0x86: "\u2020",
  0x87: "\u2021", 0x88: "\u02c6", 0x89: "\u2030", 0x8a: "\u0160", 0x8b: "\u2039", 0x8c: "\u0152",
  0x8e: "\u017d", 0x91: "\u2018", 0x92: "\u2019", 0x93: "\u201c", 0x94: "\u201d", 0x95: "\u2022",
  0x96: "\u2013", 0x97: "\u2014", 0x98: "\u02dc", 0x99: "\u2122", 0x9a: "\u0161", 0x9b: "\u203a",
  0x9c: "\u0153", 0x9e: "\u017e", 0x9f: "\u0178",
};

/**
 * Parse a /ToUnicode CMap.
 *
 * Two constructs, and both are needed — a real CMap uses each for what it suits:
 *
 *   bfchar   individual mappings:  <0041> <0041>
 *   bfrange  contiguous runs:      <0041> <005A> <0041>
 *            and explicit lists:   <0041> <0043> [ <0061> <0062> <0063> ]
 *
 * A destination may be MULTIPLE UTF-16 code units, because one glyph can map to several characters — the `fi` ligature
 * maps to two. Reading only the first would silently drop half of every ligature.
 */
export function parseToUnicode(cmapText) {
  const map = new Map();
  const text = String(cmapText ?? "");

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      map.set(parseInt(pair[1], 16), utf16beToString(pair[2]));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    // Explicit list form, matched first because its brackets would otherwise be read as a destination.
    for (const listed of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const from = parseInt(listed[1], 16);
      const items = [...listed[3].matchAll(/<([0-9A-Fa-f]*)>/g)].map((m) => utf16beToString(m[1]));
      items.forEach((ch, i) => map.set(from + i, ch));
    }

    // Contiguous form. The destination increments with the code — but only its LAST unit, which is why the string is
    // rebuilt from a code point rather than by adding to a whole string.
    const withoutLists = block[1].replace(/<[0-9A-Fa-f]+>\s*<[0-9A-Fa-f]+>\s*\[[\s\S]*?\]/g, "");
    for (const range of withoutLists.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      const from = parseInt(range[1], 16);
      const to = parseInt(range[2], 16);
      const dest = range[3];
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;

      // A pathological range would allocate unboundedly; a document has no legitimate use for a million-entry run.
      const span = Math.min(to - from, 65535);
      const base = dest.length <= 4 ? parseInt(dest, 16) : parseInt(dest.slice(-4), 16);
      const prefix = dest.length > 4 ? utf16beToString(dest.slice(0, -4)) : "";

      for (let i = 0; i <= span; i++) {
        map.set(from + i, prefix + (safeChar(base + i) ?? ""));
      }
    }
  }

  return map;
}

/** A hex run of UTF-16BE code units to a string. Surrogate pairs are handled by the decoder, not by hand. */
function utf16beToString(hex) {
  const clean = String(hex ?? "");
  if (!clean) return "";
  const bytes = Buffer.from(clean.length % 2 ? `0${clean}` : clean, "hex");
  // UTF-16BE decoding, which resolves surrogate pairs correctly — a manual loop over code units would not.
  return bytes.swap16().toString("utf16le");
}

/**
 * Build a decoder for one font.
 *
 * Returns `{ decode(codes) -> string, unmapped, twoByte }`. `unmapped` counts codes nothing could resolve, which is how a
 * caller learns the output is unreliable — a count is evidence, whereas silence looks like success.
 */
export function makeFontDecoder({ toUnicode = null, differences = null, baseEncoding = "", identity = false, widths = null } = {}) {
  const uni = toUnicode ? parseToUnicode(toUnicode) : null;
  const diff = differences ? parseDifferences(differences) : null;
  const isWinAnsi = /WinAnsi/.test(baseEncoding);

  /**
   * A width table that declares NOTHING is not a width table.
   *
   * `parseWidths` always returns an object, because its `of()` falls back to a default so callers need no guard. But a
   * font with no `/Widths` and no `/W` yields a table whose every answer is that default — and treating that as a
   * measurement labels a guess as measured, which is precisely the dishonesty the `measured` flag exists to prevent.
   *
   * A test caught it: a font declaring no widths reported `measured: true`.
   */
  const realWidths = widths && widths.known > 0 ? widths : null;

  // A Type0 font with Identity encoding uses two bytes per code, and reading it one byte at a time produces exactly
  // twice as many wrong characters as there are right ones.
  const twoByte = identity || (uni ? [...uni.keys()].some((k) => k > 0xff) : false);

  let unmapped = 0;

  const one = (code) => {
    if (uni?.has(code)) return uni.get(code);
    if (diff?.has(code)) {
      const ch = glyphToChar(diff.get(code));
      if (ch !== null) return ch;
    }
    if (twoByte) { unmapped += 1; return ""; }
    if (isWinAnsi && WIN_ANSI_HIGH[code]) return WIN_ANSI_HIGH[code];
    // A simple font with no usable mapping: codes 32–255 are Latin-1 in practice, which is right for
    // StandardEncoding and MacRoman across the ASCII range and close enough above it to be worth taking.
    if (code >= 32 && code <= 255) return String.fromCharCode(code);
    if (code === 9 || code === 10 || code === 13) return " ";
    unmapped += 1;
    return "";
  };

  return {
    twoByte,
    get unmapped() { return unmapped; },
    decode(bytes) {
      let out = "";
      if (twoByte) {
        for (let i = 0; i + 1 < bytes.length; i += 2) out += one((bytes[i] << 8) | bytes[i + 1]);
        if (bytes.length % 2) out += one(bytes[bytes.length - 1]);
      } else {
        for (const b of bytes) out += one(b);
      }
      return out;
    },

    /**
     * The width of these codes, in glyph space (1/1000 em).
     *
     * Kept beside `decode` because it must iterate the codes THE SAME WAY. Measuring a two-byte font one byte at a time
     * would give twice as many widths as there are characters — the same off-by-a-factor-of-two error as decoding it
     * wrongly, and it would land in column detection rather than in the visible text where it could be spotted.
     *
     * Returns null when the font declares no widths, so a caller can tell "zero width" from "unknown width" and fall
     * back rather than treating an unmeasured line as empty.
     */
    widthOf(bytes) {
      if (!realWidths) return null;
      let total = 0;
      if (twoByte) {
        for (let i = 0; i + 1 < bytes.length; i += 2) total += realWidths.of((bytes[i] << 8) | bytes[i + 1]);
        if (bytes.length % 2) total += realWidths.of(bytes[bytes.length - 1]);
      } else {
        for (const b of bytes) total += realWidths.of(b);
      }
      return total;
    },

    hasWidths: !!realWidths,
  };
}

/** Parse an /Differences array: `[ 32 /space /exclam 65 /A ]` — a number resets the code, names advance it. */
export function parseDifferences(arrayText) {
  const map = new Map();
  let code = 0;
  for (const tok of String(arrayText).replace(/[[\]]/g, " ").trim().split(/\s+/)) {
    if (!tok) continue;
    if (/^\d+$/.test(tok)) { code = Number(tok); continue; }
    if (tok.startsWith("/")) { map.set(code, tok.slice(1)); code += 1; }
  }
  return map;
}

/**
 * Character widths for a font, in glyph-space units (1/1000 em).
 *
 * WHY THIS IS NEEDED AND WHY IT WAS DEFERRED. Tier 1 gets by with an estimate: it only needs to know whether the next run
 * continues a word or starts elsewhere, and half an em per character is close enough for that.
 *
 * Column detection cannot use an estimate. It needs to know where a line ENDS — its right edge — to tell a narrow column
 * from a full-width line, and an estimate that is 20% wrong makes a two-column page look like one column of long lines
 * or the reverse. So the real widths have to come from the font.
 *
 * `/Widths` covers `/FirstChar` to `/LastChar`; `/MissingWidth` in the descriptor covers everything else. A Type0 font
 * uses `/W` instead, whose format is a different shape and is handled separately.
 */
export function parseWidths(fontBody, { objects = null } = {}) {
  const dict = parseDict(fontBody);

  const firstChar = Number(dict.FirstChar);
  const widthsRaw = resolveArray(dict.Widths, objects);

  const widths = new Map();
  if (Number.isFinite(firstChar) && widthsRaw) {
    const nums = widthsRaw.replace(/[[\]]/g, " ").trim().split(/\s+/).map(Number);
    nums.forEach((w, i) => { if (Number.isFinite(w)) widths.set(firstChar + i, w); });
  }

  // The descriptor's fallback, for codes outside the /Widths range.
  let missing = 0;
  const fdRef = refTo(dict.FontDescriptor);
  if (fdRef != null && objects?.has(fdRef)) {
    missing = Number((parseDict(objects.get(fdRef).body).MissingWidth ?? 0)) || 0;
  }

  // A Type0 font's /W array: `[ code [w w w] codeStart codeEnd w ... ]` — two interleaved forms in one array, which is
  // why it needs its own pass rather than the flat read above.
  const wRaw = resolveArray(dict.W, objects);
  if (wRaw) parseTypeZeroWidths(wRaw, widths);

  const defaultWidth = Number(dict.DW) || missing || 500;

  return {
    widths,
    /** Width of one code, in glyph space. Falls back rather than returning undefined, so callers need no guard. */
    of: (code) => widths.get(code) ?? defaultWidth,
    defaultWidth,
    known: widths.size,
  };
}

/** A value that may be inline or an indirect reference to an array object. */
function resolveArray(value, objects) {
  if (!value) return null;
  const ref = refTo(value);
  if (ref == null) return String(value);
  if (!objects?.has(ref)) return null;
  // The referenced object's body IS the array, possibly with surrounding whitespace.
  return objects.get(ref).body;
}

/**
 * Parse a Type0 font's /W array.
 *
 * Two forms interleave in one array and both must be recognised:
 *   `c [w1 w2 w3]`   widths for consecutive codes starting at c
 *   `cFirst cLast w` one width for every code in the range
 *
 * Reading only the first form loses every range, and reading only the second misreads a bracketed list as three numbers.
 */
function parseTypeZeroWidths(text, widths) {
  const tokens = String(text).replace(/^\s*\[/, "").replace(/\]\s*$/, "").trim();
  const re = /(\d+)\s*(?:\[([^\]]*)\]|(\d+)\s+(-?\d+(?:\.\d+)?))/g;

  let m;
  while ((m = re.exec(tokens)) !== null) {
    const start = Number(m[1]);
    if (m[2] !== undefined) {
      m[2].trim().split(/\s+/).map(Number).forEach((w, i) => {
        if (Number.isFinite(w)) widths.set(start + i, w);
      });
    } else {
      const end = Number(m[3]);
      const w = Number(m[4]);
      // A pathological range would allocate unboundedly; no real font needs a million-code run.
      const span = Math.min(end - start, 65535);
      for (let i = 0; i <= span; i++) widths.set(start + i, w);
    }
  }
}
