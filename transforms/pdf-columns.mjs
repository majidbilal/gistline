// Multi-column reading order — Tier 2.
//
// ONE RESPONSIBILITY: decide whether a page has columns, and if so, put its lines in reading order. It extracts nothing.
//
// WHY THIS IS WORTH DOING. The documented failure of the standard tools: because the text in the left column and the
// right column share the same y coordinate on a given line, a reader that sorts by y then x merges them into a single
// horizontal string. Every line of a two-column paper comes out as two half-sentences spliced together.
//
// They fail because y comes first. The coordinates are in the content stream, so clustering by x FIRST separates the
// columns, and each is then read top to bottom. That is the whole idea.
//
// AND WHY IT IS NOT AS EASY AS THAT SOUNDS. Clustering needs to know where a line ENDS, not just where it starts — a
// narrow line at x=72 and a full-width line at x=72 are indistinguishable by their origin. Line extents come from the
// font's /Widths, which is why real widths had to exist before this tier could.
//
// The naive alternative is explicitly wrong and worth recording so nobody reaches for it: splitting on character counts
// fails because PDF fonts are proportional, not monospaced.

/** A page needs at least this many lines before a column claim means anything. */
export const MIN_LINES = 8;

/** A column must hold at least this share of the page's lines to be real rather than an indented block. */
export const MIN_COLUMN_SHARE = 0.15;

/** How wide a gutter must be, as a fraction of the page's text width, to separate columns. */
export const MIN_GUTTER = 0.04;

/**
 * Find the vertical gutters in a page.
 *
 * A gutter is a band of x where NO line has ink. Found by projecting every line's horizontal extent onto the x axis and
 * looking for gaps — which is why extents matter: with origins alone, a page of short centred lines looks like it has
 * gutters everywhere.
 *
 * Returns the gutters found, widest first.
 */
export function findGutters(lines, { minGutter = MIN_GUTTER, spanRatio = 0.7 } = {}) {
  const all = lines
    .map((l) => ({ from: l.x, to: l.x + (l.width ?? 0) }))
    .filter((s) => s.to > s.from);

  if (all.length < 2) return [];

  const pageLeft = Math.min(...all.map((s) => s.from));
  const pageRight = Math.max(...all.map((s) => s.to));
  const pageWidth = pageRight - pageLeft;
  if (pageWidth <= 0) return [];

  /**
   * FULL-WIDTH LINES ARE EXCLUDED, and this is the fix for a real failure.
   *
   * Every two-column paper has a full-width title, and a title spanning the gutter merges the two occupied bands into
   * one — so gutter detection found nothing and the page was reported as single-column. A test caught it.
   *
   * Gutters are defined by the NARROW lines. A line wide enough to cross a gutter cannot be evidence about where that
   * gutter is; it is one of the things being classified by it.
   */
  const spans = all
    .filter((s) => (s.to - s.from) < pageWidth * spanRatio)
    .sort((a, b) => a.from - b.from);

  if (spans.length < 2) return [];

  // Merge overlapping spans into occupied bands; the gaps between bands are the gutters.
  const bands = [];
  for (const s of spans) {
    const last = bands[bands.length - 1];
    if (last && s.from <= last.to) { last.to = Math.max(last.to, s.to); continue; }
    bands.push({ ...s });
  }

  const gutters = [];
  for (let i = 0; i < bands.length - 1; i++) {
    const from = bands[i].to;
    const to = bands[i + 1].from;
    const width = to - from;
    if (width >= pageWidth * minGutter) gutters.push({ from, to, width });
  }

  return gutters.sort((a, b) => b.width - a.width);
}

/**
 * Assign lines to columns, given a gutter.
 *
 * A line that SPANS the gutter belongs to neither column: it is a full-width heading, a rule, or a table that crosses
 * both. Those must stay in their vertical position rather than being forced into one side, or a section heading ends up
 * halfway down the left column.
 */
export function splitAtGutter(lines, gutter) {
  const left = [];
  const right = [];
  const spanning = [];

  for (const line of lines) {
    const from = line.x;
    const to = line.x + (line.width ?? 0);

    if (to <= gutter.from + 1) left.push(line);
    else if (from >= gutter.to - 1) right.push(line);
    else spanning.push(line);
  }

  return { left, right, spanning };
}

/**
 * Decide the reading order for a page.
 *
 * Returns the lines in order plus the BASIS for that order, because the two cases carry very different confidence and a
 * caller needs to know which it received. Single-column order follows the page; multi-column order is inferred, and
 * inferred order can be wrong in ways that read perfectly.
 *
 * A spanning line divides the page: content above it belongs to the section before, content below to the section after.
 * Ignoring that and reading all of the left column then all of the right would move a heading's own section above it.
 */
export function readingOrder(lines, { minLines = MIN_LINES, minShare = MIN_COLUMN_SHARE } = {}) {
  const byPosition = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);

  if (lines.length < minLines) {
    return { lines: byPosition, columns: 1, basis: `single column assumed: only ${lines.length} line(s) on the page` };
  }

  const gutters = findGutters(lines);
  if (!gutters.length) {
    return { lines: byPosition, columns: 1, basis: "single column: no vertical gutter separates the text" };
  }

  const { left, right, spanning } = splitAtGutter(lines, gutters[0]);
  const needed = Math.max(2, Math.ceil(lines.length * minShare));

  // Both sides must carry real content. A gutter with three lines on one side is an indented block, a pull quote, or a
  // figure caption — not a column — and treating it as one would reorder the page around it.
  if (left.length < needed || right.length < needed) {
    return {
      lines: byPosition,
      columns: 1,
      basis: `single column: a gutter exists but one side holds too little text (${left.length} vs ${right.length}) to be a column`,
    };
  }

  // Segment by the spanning lines, so a full-width heading keeps its section with it.
  const ordered = [];
  const dividers = spanning.sort((a, b) => b.y - a.y);

  let upperBound = Infinity;
  for (const divider of [...dividers, null]) {
    const lowerBound = divider ? divider.y : -Infinity;

    const inBand = (arr) => arr.filter((l) => l.y < upperBound && l.y > lowerBound).sort((a, b) => b.y - a.y || a.x - b.x);

    // Left column fully, then right column fully — which is what reading a two-column page means.
    ordered.push(...inBand(left), ...inBand(right));

    if (divider) ordered.push(divider);
    upperBound = lowerBound;
  }

  return {
    lines: ordered,
    columns: 2,
    gutter: gutters[0],
    spanning: spanning.length,
    basis:
      "two columns inferred from a vertical gutter; each column read top to bottom, with full-width lines kept in place. "
      + "This order is inferred rather than declared by the document.",
  };
}

/**
 * Would reading this page naively have been wrong?
 *
 * Diagnostic rather than functional, and it exists to make the claim checkable: if the naive order and the column order
 * agree, the column logic changed nothing and its risk was not worth taking. On a real two-column page they disagree
 * substantially, and this quantifies it.
 */
export function naiveOrderDiffers(lines) {
  const naive = [...lines].sort((a, b) => b.y - a.y || a.x - b.x).map((l) => l.text).join("\n");
  const smart = readingOrder(lines).lines.map((l) => l.text).join("\n");
  return { differs: naive !== smart, naive, smart };
}
