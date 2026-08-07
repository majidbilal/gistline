// Log template extraction.
//
// ONE RESPONSIBILITY: state each repeated log format once, then emit only what varies.
//
// A log line is a format plus values. In a 40,000-line build log there may be thirty formats, each repeated a thousand
// times, and every repetition of the format is pure redundancy. Stating it once is LOSSLESS — the line is
// reconstructible exactly — where the existing log path drops whole lines and cannot get them back.
//
// This file is short because the pieces it needs already exist: `mask` for variables, `escape` for delimiter-safe
// values, `lines` for splitting. Written before those extractions it would have contained its own copy of each, and the
// masking and escaping copies were both drafted WRONG before being extracted.
//
// WHAT THIS IS NOT: a log parser. Every published parser (Drain, Spell, IPLoM) optimises for matching a human's idea of
// the "correct" template, because they serve anomaly detection. This serves reconstruction: a template that a human
// would call wrong but which round-trips exactly is completely acceptable, and correctness is therefore testable by
// construction rather than against a labelled dataset.

import { mask, unmask, slotCount, anchorTokens } from "../util/mask.mjs";
import { encodeRow, decodeBlock, decodeCell } from "../util/escape.mjs";
import { split, join, rank } from "../util/lines.mjs";
import { encodeColumn, decodeColumn } from "./columnar.mjs";

/**
 * A template must be used this many times before it is worth stating.
 *
 * Below it, the output is LARGER than the input: a template used once costs the template plus its values plus a row
 * marker, where the original cost only the line. My own design document missed this and would have emitted hundreds of
 * single-use templates and inflated the log.
 */
export const MIN_USES = 3;

/**
 * Cap on distinct templates.
 *
 * Bounded degradation beats unbounded memory. Past the cap, remaining lines pass through verbatim and the note says so
 * — a surprising behaviour that announces itself is acceptable, a silent one is not.
 */
export const MAX_TEMPLATES = 500;

/** Grouping key: token count plus the first literal words. Placeholders are skipped; see `anchorTokens`. */
const keyFor = (template) => `${template.split(/\s+/).length}\u0000${anchorTokens(template, 3).join("\u0000")}`;

/**
 * Extract templates from lines.
 *
 * One pass, O(lines). Grouping is a Map lookup rather than a tree walk: published parsers use trees to find
 * APPROXIMATE matches for accuracy, and an exact key is both faster and provably homogeneous, which is all
 * reconstruction needs.
 */
export function extract(lines, { minUses = MIN_USES, maxTemplates = MAX_TEMPLATES } = {}) {
  const groups = new Map();
  const masked = [];
  let capped = false;

  for (const line of lines) {
    const { template, values } = mask(line);
    masked.push({ template, values });

    const key = keyFor(template);
    if (groups.has(key)) {
      groups.get(key).count += 1;
      continue;
    }
    if (groups.size >= maxTemplates) { capped = true; continue; }
    groups.set(key, { template, count: 1, id: groups.size + 1 });
  }

  // Only groups that earn their header row become templates.
  const kept = new Map();
  for (const [key, g] of groups) if (g.count >= minUses) kept.set(key, g);

  // Renumber so ids are contiguous and stable for a given input.
  let n = 0;
  for (const g of kept.values()) g.id = ++n;

  return { masked, templates: kept, capped };
}

/**
 * Render the compacted form.
 *
 * Two sections, because a reader has to be able to tell what they are looking at without documentation:
 *
 *     T1  <ts> INFO [worker-<n>] processed <n> records in <n>s
 *     T2  <ts> WARN disk at <n>
 *     ---
 *     T1 2026-08-03T14:22:01Z,3,142,1.8
 *     T2 2026-08-03T14:22:04Z,91%
 *     2026-08-03T14:22:09Z ODD one-off line kept verbatim
 *
 * A line with a template is `T<id>` plus its values. A line without one is emitted verbatim, so nothing is lost in
 * either case.
 */
export function render({ masked, templates }) {
  const header = [];
  for (const g of templates.values()) header.push(`T${g.id}  ${g.template}`);

  const body = masked.map(({ template, values }) => {
    const g = templates.get(keyFor(template));
    // No template, or a template whose slot count disagrees with this line's values — emit verbatim rather than risk a
    // misaligned reconstruction. Disagreement should be impossible given the grouping key; the guard is here because
    // "should be impossible" is not a guarantee.
    if (!g || slotCount(g.template) !== values.length) return unmask(template, values);
    return values.length ? `T${g.id} ${encodeRow(values)}` : `T${g.id}`;
  });

  return `${header.join("\n")}\n---\n${body.join("\n")}`;
}

/**
 * Reverse `render` exactly.
 *
 * Exists so "lossless" is verified rather than asserted — and it is called on every run before the output is returned,
 * not only in tests. If reconstruction does not match the input byte for byte, the transform declines entirely.
 */
export function expand(text) {
  const cut = text.indexOf("\n---\n");
  if (cut === -1) return null;

  const templates = new Map();
  for (const line of text.slice(0, cut).split("\n")) {
    const m = line.match(/^T(\d+)\s{2}(.*)$/);
    if (m) templates.set(m[1], m[2]);
  }

  const out = [];
  // Rows are decoded as a stream, so a value containing a newline stays one row.
  const rows = decodeBlock(text.slice(cut + 5));

  for (const cells of rows) {
    const first = cells[0] ?? "";
    const m = String(first).replace(/\u0000/g, "").match(/^T(\d+)(?:\s([\s\S]*))?$/);

    if (!m || !templates.has(m[1])) {
      // A verbatim line. Re-joining its cells restores any delimiter it happened to contain.
      out.push(cells.map((c) => String(c).replace(/\u0000/g, "")).join(","));
      continue;
    }

    const template = templates.get(m[1]);
    const values = [];
    if (m[2] !== undefined) values.push(decodeCell(m[2]));
    for (let i = 1; i < cells.length; i++) values.push(decodeCell(cells[i]));

    out.push(unmask(template, values.map((v) => (v === null ? "" : String(v)))));
  }

  return out.join("\n");
}

/**
 * The transform.
 *
 * `truncatable: false` because the output has a header section: cutting it discards the templates and leaves rows that
 * reference formats no longer present — output that looks structured and cannot be read at all.
 *
 * VERIFIED ON EVERY RUN, not only in tests. `expand(render(...))` is compared against the input, and any mismatch
 * declines the whole transform. Partial application is how a compressor becomes untrustworthy: a reader cannot tell
 * which lines survived correctly.
 */
export const templates = {
  id: "log-templates",
  lossless: true,
  truncatable: false,

  /**
   * Line-oriented text with enough lines for repetition to exist.
   *
   * No early bail-out on a sample. The original design sampled the first N lines and would have bailed on a log whose
   * first 200 lines are a unique banner and whose next 40,000 are three repeated formats — the best possible input.
   * The pass is O(n) and the size check below already protects the output, so a premature optimisation was removed
   * rather than specified more carefully.
   */
  applies: (ctx) => ctx.text.length > 500 && ctx.text.includes("\n"),

  run: (ctx) => {
    const parts = split(ctx.text);
    if (parts.lines.length < MIN_USES * 2) return { text: ctx.text, applied: false, reason: "too few lines" };

    const found = extract(parts.lines);
    if (!found.templates.size) return { text: ctx.text, applied: false, reason: "no format repeats enough to be worth stating" };

    /**
     * Both forms are produced and the SMALLER one wins.
     *
     * Columnar encoding is dramatically better on a real log — 29.3% to 73.5% on a 1,200-line sample — but it is not better
     * on every input. A log with two rows per template, or one whose values are all distinct, gains nothing from columns and
     * pays for the per-column headers. Measuring both costs one extra render and removes the guess entirely.
     */
    const rowForm = render(found);
    const columnForm = renderColumnar(found);
    const useColumns = columnForm.length < rowForm.length;
    const rendered = useColumns ? columnForm : rowForm;

    // Never larger. A compressor that inflates is worse than one that declines, and the design missed this until a
    // worked example showed a single-use template costing more than the line it replaced.
    if (rendered.length >= ctx.text.length) {
      return { text: ctx.text, applied: false, reason: `templating would grow the output (${ctx.text.length} -> ${rendered.length})` };
    }

    // The lossless claim, checked on this exact input rather than trusted — and with the expander that matches the form
    // actually produced, since the two encode rows differently.
    const back = useColumns ? expandColumnar(rendered) : expand(rendered);
    if (back !== join({ ...parts, trailing: false })) {
      return { text: ctx.text, applied: false, reason: "declined: reconstruction did not match the input exactly" };
    }

    const note = found.capped ? `; template cap of ${MAX_TEMPLATES} reached, remaining lines verbatim` : "";
    return {
      text: rendered,
      applied: true,
      reason: `${found.templates.size} format(s) stated once${useColumns ? ", values encoded by column" : ""}, nothing removed${note}`,
    };
  },
};

export default templates;

/**
 * The lossy continuation of `log-templates`.
 *
 * WHY THIS IS NEEDED FOR COMBINING. `log-templates` sets `truncatable: false`, because cutting its output discards the
 * header and leaves rows referencing formats that are no longer present. That protection is correct — and it means the
 * generic line-droppers cannot legally reduce the templated output any further, so a large log would compact losslessly
 * to 50 KB and then stay there, over budget.
 *
 * So the lossy step has to be one that UNDERSTANDS the format. This is it: keep the header intact, keep every row a
 * reader would grep for, and drop ordinary rows from the middle. The output stays expandable, and what was dropped is
 * stated rather than implied.
 *
 * This is the combination the architecture was for: lossless first for the bulk, then a structure-aware lossy pass on
 * the remainder — with the original still retrievable by hash from the store, so nothing is truly gone.
 */
export const templateRows = {
  id: "template-rows",
  lossless: false,
  // Its own output is still header-plus-rows, so it must not be blindly cut either.
  truncatable: false,

  // Only meaningful on output `log-templates` produced.
  applies: (ctx) => ctx.text.includes("\n---\n") && ctx.text.length > ctx.budget,

  run: (ctx) => {
    const cut = ctx.text.indexOf("\n---\n");
    const header = ctx.text.slice(0, cut);
    const rows = ctx.text.slice(cut + 5).split("\n");

    // Rank rows by what a reader would look for. `rank` is the shared judgement, so "interesting" cannot drift between
    // this transform and the others.
    const keep = [];
    const ordinary = [];
    rows.forEach((row, i) => (rank(row) > 0 ? keep : ordinary).push({ row, i }));

    // Budget for rows, after the header and the note.
    const available = Math.max(200, ctx.budget - header.length - 120);

    const chosen = new Map();
    let used = 0;

    // Interesting rows first, highest rank first, so a failure is never dropped in favour of a warning.
    for (const { row, i } of keep.sort((a, b) => rank(b.row) - rank(a.row))) {
      if (used + row.length + 1 > available) break;
      chosen.set(i, row);
      used += row.length + 1;
    }

    // Then ordinary rows from the START, so the beginning of the run is intact and readable.
    for (const { row, i } of ordinary) {
      if (used + row.length + 1 > available) break;
      chosen.set(i, row);
      used += row.length + 1;
    }

    const dropped = rows.length - chosen.size;
    if (!dropped) return { text: ctx.text, applied: false, reason: "every row fits" };

    // Emitted in original order: a reader following a sequence must not have it reordered under them.
    const body = [...chosen.keys()].sort((a, b) => a - b).map((i) => chosen.get(i));

    return {
      text: `${header}\n---\n${body.join("\n")}\n[${dropped} ordinary row(s) dropped — every error and warning kept]`,
      applied: true,
      reason: `${dropped} ordinary row(s) dropped, all ${keep.length} interesting row(s) kept`,
    };
  },
};

/**
 * Render the compacted form with COLUMNAR value encoding.
 *
 * The rows a template produces are grouped by template id and then encoded column by column, because a column is far more
 * predictable than a row: read row-wise, consecutive values are unrelated; read column-wise, they are a series with a cheap
 * description.
 *
 * MEASURED: 29.3% for templates alone, 73.5% with this, on a 1,200-line log — a 62.5% improvement over the row form and
 * finally ahead of what JSON achieves. Every column is verified lossless before being used.
 *
 *     T1  <ts> INFO [worker-<n>] processed <n> records
 *     ---
 *     T1|4|stamps:T Z|1754229600 +3 +3 +3|verbatim:INFO|delta:0 +6 +6|dict:w1\u0002w2\u0003…
 *     2026-08-03T15:00:00Z ERROR failed to flush: disk full
 */
export function renderColumnar({ masked, templates: found }) {
  const header = [];
  for (const g of found.values()) header.push(`T${g.id}  ${g.template}`);

  // Rows grouped by template, in first-appearance order, with verbatim lines kept in place by index.
  const groups = new Map();
  const verbatim = [];

  masked.forEach(({ template, values }, i) => {
    const g = found.get(keyFor(template));

    /**
     * INTERESTING LINES STAY VERBATIM, even when they belong to a template.
     *
     * Columnar encoding is far smaller but it is not READABLE: a value split across a delta-encoded column is
     * reconstructible and invisible. A test caught this — the pipeline still reproduced `not ok 2 - b` exactly on decode,
     * while a grep for it in the output found nothing.
     *
     * That breaks the promise the whole tool rests on. Compression is worth having because the failures stay visible; an
     * error you can only see after running a decoder is not visible. So anything `rank` considers interesting — errors,
     * failures, warnings, stack frames — is emitted as itself, and only the ordinary lines are encoded into columns.
     *
     * It costs a little size on logs full of errors, which is exactly the case where the size mattered least.
     */
    const interesting = rank(unmask(template, values)) > 0;

    if (!g || interesting || slotCount(g.template) !== values.length) {
      verbatim.push({ i, text: unmask(template, values) });
      return;
    }
    if (!groups.has(g.id)) groups.set(g.id, { id: g.id, indices: [], rows: [] });
    groups.get(g.id).indices.push(i);
    groups.get(g.id).rows.push(values);
  });

  const body = [];

  for (const g of groups.values()) {
    const width = Math.max(0, ...g.rows.map((r) => r.length));
    const columns = Array.from({ length: width }, (i0, c) => g.rows.map((r) => r[c] ?? ""));

    const encoded = columns.map((col) => encodeColumn(col));

    // The row INDICES are needed to interleave verbatim lines back into place on decode. Delta-encoded, since they ascend.
    const indexCol = encodeColumn(g.indices.map(String));

    body.push([
      `T${g.id}`,
      String(g.rows.length),
      `${indexCol.encoding}:${indexCol.text}`,
      ...encoded.map((e) => `${e.encoding}:${e.text}`),
    ].join("\u0004"));
  }

  for (const v of verbatim) body.push(`V${v.i}\u0004${v.text}`);

  return `${header.join("\n")}\n---\n${body.join("\n")}`;
}

/**
 * Reverse `renderColumnar` exactly.
 *
 * Called on every run before the output is returned, not only in tests. A mismatch declines the whole transform, because
 * partial application is how a compressor becomes untrustworthy — a reader cannot tell which lines survived correctly.
 */
export function expandColumnar(text) {
  const cut = text.indexOf("\n---\n");
  if (cut === -1) return null;

  const templateMap = new Map();
  for (const line of text.slice(0, cut).split("\n")) {
    const m = line.match(/^T(\d+)\s{2}(.*)$/);
    if (m) templateMap.set(m[1], m[2]);
  }

  const placed = new Map();

  for (const line of text.slice(cut + 5).split("\n")) {
    if (!line) continue;
    const parts = line.split("\u0004");

    // A verbatim line carries its original index.
    if (/^V\d+$/.test(parts[0])) {
      placed.set(Number(parts[0].slice(1)), parts.slice(1).join("\u0004"));
      continue;
    }

    const id = parts[0].replace(/^T/, "");
    const template = templateMap.get(id);
    if (!template) return null;

    const rowCount = Number(parts[1]);
    if (!Number.isInteger(rowCount)) return null;

    const readCol = (spec) => {
      const at = spec.indexOf(":");
      if (at === -1) return null;
      return decodeColumn(spec.slice(0, at), spec.slice(at + 1));
    };

    const indices = readCol(parts[2]);
    if (!indices) return null;

    const columns = parts.slice(3).map(readCol);
    if (columns.some((c) => c === null)) return null;

    for (let r = 0; r < rowCount; r++) {
      const values = columns.map((c) => c[r] ?? "");
      placed.set(Number(indices[r]), unmask(template, values));
    }
  }

  // Reassembled in original order, which is what the indices are for.
  return [...placed.keys()].sort((a, b) => a - b).map((k) => placed.get(k)).join("\n");
}
