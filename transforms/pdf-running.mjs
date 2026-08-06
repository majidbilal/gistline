// Running headers and footers — Tier 3.
//
// ONE RESPONSIBILITY: find lines that are page furniture rather than content, state them once, and remove them from the
// body. It reads no PDF and extracts no text.
//
// WHY THIS IS THE MOST GISTLINE-SHAPED PART OF THE PDF WORK. A running header appears on EVERY page. In a 200-page
// document that is 200 copies of one line, and generic converters keep all of them. Stating it once is purely lossless:
// nothing is lost, because the information was one fact repeated 200 times.
//
// THE GUARD THAT MAKES IT SAFE, and the plan's review is what forced it. "The same text at the same height on many pages"
// also describes a LEGITIMATELY REPEATED LINE — a form where every page asks the same question, a table header repeated
// per page, a legal document with a recurring clause. Removing those would be information loss dressed up as
// deduplication.
//
// So four conditions must ALL hold: same text, consistent height, on a majority of pages, and OUTSIDE the body's own
// vertical range. Position outside the body is what distinguishes furniture from content — it is the only one of the four
// that a repeated clause cannot satisfy.
//
// And when the conditions are marginal, the line is KEPT. A duplicated line costs tokens; a deleted one costs meaning.

/** A line must appear on at least this share of pages to be furniture. */
export const MIN_PAGE_SHARE = 0.6;

/** A document needs at least this many pages before repetition means anything. */
export const MIN_PAGES = 3;

/** How far a line's height may vary between pages and still count as the same position, as a fraction of font size. */
export const Y_TOLERANCE = 1.5;

/**
 * Normalise a line for comparison.
 *
 * A running header is rarely IDENTICAL across pages: it carries a page number, a date, or a section name that changes.
 * `Chapter 3 — Obligations   14` and `Chapter 3 — Obligations   15` are the same header, and comparing raw text would
 * find no repetition at all in the documents where this matters most.
 *
 * So digits collapse to a placeholder. Everything else is compared literally, because collapsing more would start
 * matching genuinely different lines.
 */
export const normalise = (text) =>
  String(text)
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * The vertical range the body text occupies.
 *
 * FOUND BY THE WHITESPACE GAP, not by discarding a fixed number of edge lines.
 *
 * My first version took the second-from-top and second-from-bottom line of each page, which assumes exactly one header
 * line and one footer line. With a two-line header it left one behind; with no header it treated the FIRST BODY LINE as
 * furniture — and five tests failed because of it, including one where an ordinary opening line was removed from every
 * page.
 *
 * The real signal is the one a reader sees: furniture is separated from the body by whitespace. Body lines sit at regular
 * intervals, so the typical gap between consecutive lines IS the line spacing, and a gap much larger than that is a
 * boundary. That works for one header line or three, and for a page with neither.
 */
export function bodyRange(pages, { gapFactor = 1.8 } = {}) {
  const tops = [];
  const bottoms = [];

  for (const lines of pages) {
    if (lines.length < 5) continue;

    const ys = lines.map((l) => l.y).sort((a, b) => b - a);
    const gaps = ys.slice(0, -1).map((y, i) => y - ys[i + 1]);

    // The typical spacing, as a median: a mean would be dragged upward by the very gaps being looked for.
    const typical = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 1;
    const threshold = typical * gapFactor;

    // Walk in from the top until the first ordinary gap: everything before it is separated from the body.
    let topIdx = 0;
    while (topIdx < gaps.length && gaps[topIdx] > threshold) topIdx += 1;

    // And in from the bottom.
    let bottomIdx = ys.length - 1;
    while (bottomIdx > 0 && gaps[bottomIdx - 1] > threshold) bottomIdx -= 1;

    // A page whose gaps are all irregular yields no usable range rather than a guessed one.
    if (bottomIdx <= topIdx) continue;

    tops.push(ys[topIdx]);
    bottoms.push(ys[bottomIdx]);
  }

  if (!tops.length) return null;

  const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
  return { top: median(tops), bottom: median(bottoms) };
}

/**
 * Find the running headers and footers.
 *
 * `pages` is an array of positioned-line arrays, one per page. Returns the furniture found and the pages with it removed.
 *
 * Nothing is removed unless all four conditions hold, and a document too short for repetition to be meaningful is left
 * entirely alone.
 */
export function findRunningContent(pages, {
  minShare = MIN_PAGE_SHARE,
  minPages = MIN_PAGES,
  yTolerance = Y_TOLERANCE,
} = {}) {
  if (pages.length < minPages) {
    return { furniture: [], pages, reason: `only ${pages.length} page(s); repetition is not evidence below ${minPages}` };
  }

  const body = bodyRange(pages);
  if (!body) {
    return { furniture: [], pages, reason: "pages are too sparse to establish a body range" };
  }

  // Candidates: lines lying OUTSIDE the body's vertical range. This is the condition a repeated clause cannot satisfy,
  // and checking it first means the expensive grouping only ever sees plausible furniture.
  const candidates = new Map();

  pages.forEach((lines, pageIndex) => {
    for (const line of lines) {
      const isAbove = line.y > body.top;
      const isBelow = line.y < body.bottom;
      if (!isAbove && !isBelow) continue;

      const key = `${isAbove ? "head" : "foot"}\u0000${normalise(line.text)}`;
      if (!candidates.has(key)) {
        candidates.set(key, { where: isAbove ? "header" : "footer", pattern: normalise(line.text), hits: [] });
      }
      candidates.get(key).hits.push({ pageIndex, y: line.y, size: line.size, text: line.text });
    }
  });

  const needed = Math.ceil(pages.length * minShare);
  const furniture = [];

  for (const c of candidates.values()) {
    // On a majority of pages, counted as DISTINCT pages: the same line twice on one page is not evidence of repetition
    // across the document.
    const distinctPages = new Set(c.hits.map((h) => h.pageIndex));
    if (distinctPages.size < needed) continue;

    // At a consistent height. A line that drifts by more than a line's height is not in a fixed position, so it is part
    // of a flowing layout rather than furniture.
    const ys = c.hits.map((h) => h.y);
    const spread = Math.max(...ys) - Math.min(...ys);
    const size = c.hits[0].size || 10;
    if (spread > size * yTolerance) continue;

    furniture.push({
      where: c.where,
      // The most common literal form, which is what a reader should see — not the digit-collapsed pattern.
      text: mostCommon(c.hits.map((h) => h.text)),
      pattern: c.pattern,
      pages: distinctPages.size,
      varies: new Set(c.hits.map((h) => h.text)).size > 1,
    });
  }

  if (!furniture.length) {
    return { furniture: [], pages, reason: "no line repeats in a fixed position outside the body text" };
  }

  const patterns = new Set(furniture.map((f) => f.pattern));
  const stripped = pages.map((lines) =>
    lines.filter((line) => {
      const outside = line.y > body.top || line.y < body.bottom;
      return !(outside && patterns.has(normalise(line.text)));
    }));

  return {
    furniture,
    pages: stripped,
    reason: `${furniture.length} repeated line(s) stated once instead of on every page`,
  };
}

/** The most frequent value, with ties broken by first appearance so the result is deterministic. */
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return best;
}

/**
 * Describe the furniture for a reader.
 *
 * Stated as notes rather than dropped silently: the reader needs to know the header existed, and a header that VARIES —
 * a page number, a changing section name — is worth flagging as such, because "this appeared on every page" is a
 * different fact from "this appeared on every page with a different number each time".
 */
export function describeRunningContent(furniture) {
  return furniture.map((f) => {
    const what = f.where === "header" ? "Running header" : "Running footer";
    const varies = f.varies ? " (the number or reference varied by page)" : "";
    return `${what} on ${f.pages} page(s), shown once here: "${f.text}"${varies}`;
  });
}
