// Table detection — Tier 4.
//
// ONE RESPONSIBILITY: find lines that form a table and give back its rows and columns. It extracts nothing and renders
// nothing.
//
// WHAT A TABLE ACTUALLY IS, in a PDF. Nothing. There is no table operator and no table object — a table is a set of text
// runs whose x positions happen to line up, plus perhaps some rectangles drawn around them. So detection is a claim about
// alignment, and the honest framing is that a table is INFERRED and labelled as such.
//
// THE SIGNAL. Cells in a column share a left edge. So consecutive lines whose runs start at the same x positions are rows
// of one table, and the shared positions are its columns. That is a strong signal: prose does not accidentally align
// three runs across four consecutive lines.
//
// WHY THE THRESHOLDS ARE HIGH. A false positive here is worse than a miss. Turning two loosely-aligned lines into a table
// mangles ordinary prose into a grid — and unlike a missed table, which merely reads as text, a wrongly-detected one
// reads as structured data that was never there. So: at least three rows, at least two columns, and alignment must hold
// across the whole candidate rather than most of it.
//
// WHAT IS NOT ATTEMPTED. Merged cells, nested tables, and cells whose content wraps onto a second line. Each needs a
// layout model rather than an alignment rule, and guessing at them would produce a table whose rows do not correspond to
// the document's. Their presence is DETECTED where possible and reported, so a reader knows the shape is approximate.

/** A table needs at least this many rows. Two aligned lines are a coincidence; three are a pattern. */
export const MIN_ROWS = 3;

/** And at least this many columns, or it is a list rather than a table. */
export const MIN_COLUMNS = 2;

/** How close two run origins must be, as a fraction of font size, to count as the same column edge. */
export const COLUMN_TOLERANCE = 0.8;

/** A column must be present in at least this share of rows. Below it, the alignment is coincidental. */
export const MIN_COLUMN_FILL = 0.6;

/**
 * Cluster run origins into column edges.
 *
 * Tolerance is a fraction of font size rather than a fixed number of points, because a table set in 8pt has tighter
 * alignment than one set in 14pt, and one absolute threshold would merge columns in the small table or split them in the
 * large one.
 */
export function clusterColumns(lines, { tolerance = COLUMN_TOLERANCE } = {}) {
  const size = median(lines.map((l) => l.size || 10)) || 10;
  const limit = size * tolerance;

  const origins = lines.flatMap((l) => (l.runs ?? []).map((r) => r.x)).sort((a, b) => a - b);
  if (!origins.length) return [];

  const clusters = [];
  let current = [origins[0]];

  for (const x of origins.slice(1)) {
    if (x - current[current.length - 1] <= limit) { current.push(x); continue; }
    clusters.push(current);
    current = [x];
  }
  clusters.push(current);

  // A column's edge is the MINIMUM of its cluster, not the mean: cells are left-aligned to that edge and any variation is
  // a cell whose content starts slightly late. The mean would drift right and start capturing the next column's cells.
  return clusters.map((c) => ({ x: Math.min(...c), hits: c.length }));
}

const median = (arr) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : 0);

/**
 * Assign a line's runs to columns.
 *
 * Returns one cell per column, or null when a run cannot be placed — which happens when a line has content to the LEFT of
 * the first column edge, and means this line is not a row of this table.
 *
 * A run belongs to the rightmost column edge at or before its origin. Cells sharing a column are joined with a space,
 * because a cell whose content is drawn as two runs is one cell.
 */
export function assignToColumns(line, columns, { tolerance = COLUMN_TOLERANCE } = {}) {
  const cells = Array(columns.length).fill("");
  const limit = (line.size || 10) * tolerance;

  for (const run of line.runs ?? []) {
    let index = -1;
    for (let i = columns.length - 1; i >= 0; i--) {
      if (run.x >= columns[i].x - limit) { index = i; break; }
    }
    // Content before the first column edge means this line does not belong to this table.
    if (index === -1) return null;
    cells[index] = cells[index] ? `${cells[index]} ${run.text}` : run.text;
  }

  return cells;
}

/**
 * Is this band of lines a table?
 *
 * All the thresholds are applied here, and the reason for each is that its absence produces a specific wrong answer:
 * too few rows turns prose into a grid, too few columns turns a list into a table, and a sparsely-filled column means the
 * alignment was coincidence.
 */
export function assessBand(lines, opts = {}) {
  const {
    minRows = MIN_ROWS,
    minColumns = MIN_COLUMNS,
    minFill = MIN_COLUMN_FILL,
  } = opts;

  if (lines.length < minRows) return { isTable: false, reason: `only ${lines.length} row(s)` };

  const clustered = clusterColumns(lines, opts);
  if (clustered.length < minColumns) {
    return { isTable: false, reason: `only ${clustered.length} column edge(s)` };
  }

  const rows = lines.map((l) => assignToColumns(l, clustered, opts));
  if (rows.some((r) => r === null)) {
    return { isTable: false, reason: "a line has content outside the column grid" };
  }

  /**
   * A column must be FILLED across most rows.
   *
   * Prose lines will produce a handful of aligned origins by chance — a paragraph's first word aligns with the next
   * paragraph's first word, trivially, because both start at the margin. That yields one well-filled column and several
   * nearly empty ones. Requiring most columns to be populated is what separates a table from justified text.
   */
  const fill = clustered.map((c, i) => rows.filter((r) => r[i].trim()).length / rows.length);
  const solid = fill.filter((f) => f >= minFill).length;

  if (solid < minColumns) {
    return {
      isTable: false,
      reason: `only ${solid} column(s) are filled in most rows — the alignment looks coincidental`,
    };
  }

  // Drop the columns that are mostly empty, keeping their content by merging it leftward: a stray run should not create a
  // phantom column, and discarding it would lose text.
  const keep = clustered.map((c, i) => ({ ...c, index: i, solid: fill[i] >= minFill }));
  const merged = rows.map((r) => {
    const out = [];
    for (const col of keep) {
      if (col.solid) { out.push(r[col.index]); continue; }
      const value = r[col.index].trim();
      if (!value) continue;
      // Merge into the previous kept column, or the next if this is the first.
      if (out.length) out[out.length - 1] = `${out[out.length - 1]} ${value}`.trim();
      else r[keep.find((k) => k.solid)?.index ?? 0] = `${value} ${r[keep.find((k) => k.solid)?.index ?? 0]}`.trim();
    }
    return out;
  });

  return {
    isTable: true,
    columns: keep.filter((k) => k.solid).length,
    rows: merged,
    reason: `${merged.length} rows aligned across ${keep.filter((k) => k.solid).length} columns`,
  };
}

/**
 * Find the tables on a page.
 *
 * Bands of consecutive lines are grown while they keep aligning, which is what makes this work on a page that is mostly
 * prose with one table in the middle: the table's rows align with each other and the prose around them does not, so the
 * band ends by itself.
 *
 * Returns the page's content as an ordered mix of `text` and `table` segments, so a caller can render each in place. A
 * table lifted out of its position would lose the sentence that introduces it.
 */
export function findTables(lines, opts = {}) {
  const { minRows = MIN_ROWS } = opts;
  const segments = [];
  let i = 0;

  while (i < lines.length) {
    // Grow the longest band starting here that still assesses as a table. Longest-first because a five-row table also
    // contains a three-row table, and stopping at the first success would split it.
    let best = null;
    for (let end = lines.length; end > i + minRows - 1; end--) {
      const band = lines.slice(i, end);
      const verdict = assessBand(band, opts);
      if (!verdict.isTable) continue;

      /**
       * TRIM THE EDGES, and this is not a refinement — without it the feature is actively wrong.
       *
       * Longest-first growth will happily swallow the prose around a table. The sentence that introduces it occupies only
       * the first column, and a column filled in four rows out of six still clears the fill threshold — so the whole page
       * assessed as one table and two sentences became rows with two empty cells each.
       *
       * A row reaching only ONE column is not a table row. Trimming those from each end recovers the table's real extent
       * and hands the sentences back to the prose segment they belong to. A test caught this: the intro and the closing
       * line were both inside the grid.
       *
       * Trimmed only at the EDGES, deliberately. A single-column row in the MIDDLE is a subtotal line or a section label
       * inside the table, and cutting the table in two there would be worse than keeping it.
       */
      const filledCount = (r) => r.filter((c) => c.trim()).length;
      let from = 0;
      let to = verdict.rows.length;
      while (from < to && filledCount(verdict.rows[from]) < 2) from += 1;
      while (to > from && filledCount(verdict.rows[to - 1]) < 2) to -= 1;

      if (to - from < minRows) continue;

      // Re-assess the trimmed extent: dropping rows can change the column grid, and a band that only qualified because of
      // the rows just removed must not survive on their strength.
      const trimmedLines = lines.slice(i + from, i + to);
      const reassessed = assessBand(trimmedLines, opts);
      if (!reassessed.isTable) continue;

      best = { start: i + from, end: i + to, verdict: reassessed };
      break;
    }

    if (!best) {
      // Not a table here. Accumulate prose until a table starts.
      const last = segments[segments.length - 1];
      if (last?.type === "text") last.lines.push(lines[i]);
      else segments.push({ type: "text", lines: [lines[i]] });
      i += 1;
      continue;
    }

    // Any lines between here and the trimmed start are prose, and must not be lost.
    for (let j = i; j < best.start; j++) {
      const last = segments[segments.length - 1];
      if (last?.type === "text") last.lines.push(lines[j]);
      else segments.push({ type: "text", lines: [lines[j]] });
    }

    segments.push({
      type: "table",
      rows: best.verdict.rows,
      columns: best.verdict.columns,
      lineCount: best.end - best.start,
      reason: best.verdict.reason,
    });
    i = best.end;
  }

  return segments;
}

/**
 * Which limitations does this table appear to have?
 *
 * Detected rather than handled, and reported so a reader knows the shape is approximate. This is the honest version of
 * "merged cells are not supported": rather than silently producing a wrong grid, the grid is produced AND the suspicion is
 * stated.
 */
export function tableCaveats(rows) {
  const caveats = [];
  if (!rows.length) return caveats;

  const width = rows[0].length;

  // A row with fewer filled cells than its neighbours suggests a merged cell spanning them.
  const filled = rows.map((r) => r.filter((c) => c.trim()).length);
  const typical = median(filled);
  if (filled.some((f) => f > 0 && f < typical - 1)) {
    caveats.push("Some rows have fewer values than others, which usually means merged cells; the grid is approximate.");
  }

  // A cell far longer than the others is likely wrapped content that belongs to several visual lines.
  const lengths = rows.flat().map((c) => c.length).filter((n) => n > 0);
  const typicalLength = median(lengths);
  if (typicalLength > 0 && lengths.some((n) => n > typicalLength * 6)) {
    caveats.push("One or more cells are much longer than the rest, which can mean wrapped text was joined into one cell.");
  }

  if (rows.some((r) => r.length !== width)) {
    caveats.push("Rows have differing column counts and were padded.");
  }

  return caveats;
}

/**
 * Should the first row be treated as a header?
 *
 * Only when it looks like one: text in every cell where the rows below hold numbers. A table of numbers whose first row is
 * also numbers has no header, and promoting it would lose that row's data — the same judgement the spreadsheet reader
 * makes, for the same reason.
 */
export function looksLikeHeaderRow(rows) {
  if (rows.length < 2) return false;

  const [head, ...body] = rows;
  const nonEmpty = head.filter((c) => c.trim());
  if (!nonEmpty.length) return false;

  const headIsText = nonEmpty.every((c) => Number.isNaN(Number(c.replace(/[,%$£€\s]/g, ""))));
  if (!headIsText) return false;

  // And the body must contain numbers somewhere, or every row is text and the first is not special.
  const bodyHasNumbers = body.some((r) => r.some((c) => c.trim() && !Number.isNaN(Number(c.replace(/[,%$£€\s]/g, "")))));
  return bodyHasNumbers;
}
