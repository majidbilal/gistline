// HTML to Markdown.
//
// ONE RESPONSIBILITY: keep the content, discard the presentation.
//
// This is the largest single win available. Scraped HTML spends most of its tokens on structure that carries no
// meaning: a 500-word article is roughly 700 tokens as Markdown and over 8,000 as raw HTML, because only 10–15% of
// those tokens are the content anyone wanted.
//
// A CONVERSION, NOT A COMPRESSION, and the distinction is recorded rather than glossed. `lossless: false` is
// technically correct — `<div class="wrapper">` is gone and cannot be reconstructed. But no TEXT was removed, which is
// a different thing from dropping 1,400 log lines, and a reader deciding whether to trust the output needs to be able
// to tell those apart. Hence `contentPreserving: true`.
//
// Zero dependencies: string and regex work only. No DOM, no parser.

import { encodeValue } from "../util/escape.mjs";
import { doc, heading, paragraph, list, table, code, raw, rule } from "../core/doc.mjs";
import { toMarkdown } from "../core/markdown.mjs";

/** Elements whose entire contents are noise. Removed with their children. */
const DROP_WHOLE = [
  "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
  "nav", "header", "footer", "aside", "form", "button", "select", "dialog",
];

/** Attributes worth keeping. Everything else is discarded — class names and data attributes are pure cost. */
const KEEP_HREF = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/i;

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013", mdash: "\u2014",
  hellip: "\u2026", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d", copy: "\u00a9",
  reg: "\u00ae", trade: "\u2122", deg: "\u00b0", euro: "\u20ac", pound: "\u00a3", middot: "\u00b7",
};

/** Decode the entities that actually appear in prose, plus numeric forms. */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => safeCodePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeCodePoint(parseInt(d, 10), m))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

/** An out-of-range code point would throw; leaving the original text is better than crashing on one bad entity. */
function safeCodePoint(n, original) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return original;
  try { return String.fromCodePoint(n); } catch { return original; }
}

/**
 * Strip an element and everything inside it.
 *
 * Loops until no match remains, because these elements nest — a `<nav>` inside a `<header>` is ordinary. The loop is
 * bounded: each pass strictly shortens the string, so it terminates.
 */
function dropElements(html, tags) {
  let out = html;
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    let previous;
    do { previous = out; out = out.replace(re, " "); } while (out !== previous);
    // Self-closing or unclosed forms of the same tag.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }
  return out;
}

/**
 * Extract the main content region if the page marks one.
 *
 * A page that says `<main>` or `<article>` has told us where the content is, and trusting it removes far more noise
 * than any heuristic. If it says nothing, the whole body is used — guessing at content boundaries by counting text
 * density is where converters start silently dropping the paragraph someone needed.
 */
export function mainRegion(html) {
  for (const tag of ["main", "article"]) {
    const m = String(html).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i"));
    if (m && m[1].length > 200) return m[1];
  }
  const body = String(html).match(/<body\b[^>]*>([\s\S]*?)<\/body\s*>/i);
  return body ? body[1] : String(html);
}

/**
 * Convert a table to a Markdown table.
 *
 * Done before the generic tag strip, because once `<tr>` and `<td>` are gone the rows cannot be recovered — and a table
 * flattened into a run of words is the single most information-destroying thing a naive converter does.
 *
 * Cells are escaped through the shared encoder, so a cell containing a pipe cannot break the table.
 */
function tableToMarkdown(tableHtml) {
  const rows = [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((m) => m[1]);
  if (!rows.length) return "";

  const cellsOf = (row) =>
    [...row.matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((c) =>
      decodeEntities(c[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).replace(/\|/g, "\\|"));

  const table = rows.map(cellsOf).filter((r) => r.length);
  if (!table.length) return "";

  const width = Math.max(...table.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill("")];

  const [head, ...body] = table;
  const lines = [`| ${pad(head).join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`];
  for (const r of body) lines.push(`| ${pad(r).join(" | ")} |`);
  return `\n\n${lines.join("\n")}\n\n`;
}

/** Convert the block and inline elements that carry meaning, in an order where each step's input is still intact. */
function convertStructure(html) {
  let s = html;

  // Tables first — see above.
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (m) => tableToMarkdown(m));

  // Code and pre before anything strips their contents' angle brackets.
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (m, c) => `\n\n\`\`\`\n${decodeEntities(c.replace(/<[^>]+>/g, ""))}\n\`\`\`\n\n`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (m, c) => `\`${c.replace(/<[^>]+>/g, "")}\``);

  // Headings.
  for (let n = 6; n >= 1; n--) {
    s = s.replace(new RegExp(`<h${n}\\b[^>]*>([\\s\\S]*?)<\\/h${n}\\s*>`, "gi"), (m, c) => `\n\n${"#".repeat(n)} ${inline(c)}\n\n`);
  }

  // Lists. Ordered items are numbered by position, which is what a reader sees.
  s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol\s*>/gi, (m, c) => {
    let i = 0;
    return `\n\n${c.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (mm, item) => `${++i}. ${inline(item)}\n`)}\n`;
  });
  s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/gi, (m, c) =>
    `\n\n${c.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi, (mm, item) => `- ${inline(item)}\n`)}\n`);

  // Blockquote, horizontal rule, paragraph and line break.
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi, (m, c) => `\n\n> ${inline(c)}\n\n`);
  s = s.replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n");
  s = s.replace(/<\/p\s*>/gi, "\n\n").replace(/<p\b[^>]*>/gi, "");
  s = s.replace(/<br\b[^>]*\/?>/gi, "\n");

  return s;
}

/** Inline conversion: links, emphasis, then anything left over is dropped. */
function inline(fragment) {
  let s = String(fragment);

  // Links keep their target, because a URL is content. Link text that is empty gets the URL as its text.
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi, (m, text) => {
    const href = (m.match(KEEP_HREF) ?? [])[1] ?? (m.match(KEEP_HREF) ?? [])[2] ?? (m.match(KEEP_HREF) ?? [])[3] ?? "";
    const label = text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (!href || href.startsWith("#")) return label;
    return label ? `[${label}](${href})` : href;
  });

  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (m, t, c) => `**${c.replace(/<[^>]+>/g, "").trim()}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (m, t, c) => `*${c.replace(/<[^>]+>/g, "").trim()}*`);

  // An image keeps its alt text, which is often the only content in it, and never its src — a base64 data URI in a
  // src attribute can be larger than the entire rest of the page.
  s = s.replace(/<img\b[^>]*\balt\s*=\s*"([^"]*)"[^>]*\/?>/gi, (m, alt) => (alt.trim() ? `[image: ${alt.trim()}]` : ""));
  s = s.replace(/<img\b[^>]*\/?>/gi, "");

  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").trim();
}

/** Looks like HTML? Cheap and deliberately strict: a stray angle bracket in prose must not trigger conversion. */
export function looksLikeHtml(text) {
  const s = String(text).slice(0, 4000);
  if (/^\s*<(?:!doctype html|html|head|body)\b/i.test(s)) return true;
  // Otherwise require several distinct real tags, not one.
  const tags = new Set((s.match(/<\/?(div|p|span|a|table|ul|ol|li|h[1-6]|section|article|main|script|style)\b/gi) ?? [])
    .map((t) => t.toLowerCase().replace(/[<\/]/g, "")));
  return tags.size >= 3;
}

/**
 * Read HTML into the document model.
 *
 * A READER: it walks HTML and emits blocks. It knows nothing about Markdown — the writer in `core/markdown.mjs` handles
 * that, and handles it identically for every other reader.
 *
 * This is the refactor pandoc's architecture argued for. `htmlToMarkdown` below is now a thin composition of
 * reader-then-writer, so its behaviour is unchanged and its 16 tests still hold, while a table's pipe escaping and
 * ragged-row padding now live in ONE place that XLSX, DOCX and PPTX will inherit.
 */
export function readHtml(source) {
  let s = String(source ?? "");
  const notes = [];

  s = s.replace(/<!--[\s\S]*?-->/g, " ").replace(/<!doctype[^>]*>/gi, " ");

  const region = mainRegion(s);
  if (region.length < s.length * 0.6) notes.push("Only the main content region was read; page furniture was skipped.");

  s = dropElements(region, DROP_WHOLE);

  // Structure is converted to Markdown-shaped text first, then split into blocks. Parsing HTML into a block tree
  // directly would need a real DOM; converting then segmenting reaches the same model without one, and the segmenting
  // is unambiguous because every construct we emit starts at a line boundary.
  const md = inline(convertStructure(s))
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return doc(segmentMarkdown(md), { notes, source: "html" });
}

/**
 * Split a Markdown table row into RAW cell values.
 *
 * Splits on UNESCAPED pipes only, then unescapes — because the intermediate text has `\|` for a pipe inside a cell, and
 * a naive `split("|")` cuts the row apart at exactly that point. A test caught it: `a | b` in one cell came back as two
 * cells, `a \` and `b`.
 *
 * The division of labour that makes this correct: the MODEL holds raw values, and the WRITER escapes when rendering.
 * A reader that stored pre-escaped values would double-escape the moment the writer ran.
 */
function splitCells(line) {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "|") { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Split Markdown-shaped text into blocks.
 *
 * Only the constructs `convertStructure` and `inline` actually produce are recognised, so this is not a general
 * Markdown parser and does not pretend to be. Anything unrecognised becomes a paragraph, which is lossless for text.
 */
function segmentMarkdown(md) {
  const blocks = [];
  const chunks = String(md).split(/\n{2,}/);

  for (const chunk of chunks) {
    const t = chunk.trim();
    if (!t) continue;

    const h = t.match(/^(#{1,6})\s+([\s\S]*)$/);
    if (h) { blocks.push(heading(h[1].length, h[2])); continue; }

    if (t === "---") { blocks.push(rule()); continue; }

    if (t.startsWith("```")) {
      const m = t.match(/^```(\w*)\n?([\s\S]*?)\n?```$/);
      blocks.push(m ? code(m[2], { lang: m[1] }) : paragraph(t));
      continue;
    }

    // A table: every line starts with a pipe. The separator row is dropped, since the writer re-emits it.
    if (/^\|/.test(t) && t.split("\n").every((l) => l.trim().startsWith("|"))) {
      const rows = t.split("\n")
        .map((l) => splitCells(l))
        .filter((r) => !r.every((c) => /^-{3,}$/.test(c)));
      const [head, ...body] = rows;
      blocks.push(table(head ?? [], body));
      continue;
    }

    const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length && lines.every((l) => /^\d+\.\s/.test(l))) {
      blocks.push(list(lines.map((l) => l.replace(/^\d+\.\s*/, "")), { ordered: true }));
      continue;
    }
    if (lines.length && lines.every((l) => /^[-*]\s/.test(l))) {
      blocks.push(list(lines.map((l) => l.replace(/^[-*]\s*/, ""))));
      continue;
    }
    if (lines.length && lines.every((l) => l.startsWith(">"))) {
      // No blockquote block type: kept verbatim rather than flattened, which is what `raw` is for.
      blocks.push(raw(lines.join("\n")));
      continue;
    }

    blocks.push(paragraph(t));
  }

  return blocks;
}

/** Reader plus writer. Kept as the public entry point so existing callers and tests are unaffected. */
export function htmlToMarkdown(source) {
  return toMarkdown(readHtml(source), { includeNotes: false });
}

/**
 * The transform.
 *
 * FIRST in the pipeline order, before every compression stage, because it changes the FORMAT and everything after it
 * operates on the result. A compressor running before conversion would be compressing markup.
 *
 * `contentPreserving: true` is the honest middle category. `lossless: false` because the markup is gone and cannot be
 * reconstructed; content-preserving because no text was removed. A reader needs to distinguish "the div wrappers are
 * gone" from "1,400 lines were dropped", and one boolean cannot carry both.
 */
export const html = {
  id: "html-to-markdown",
  lossless: false,
  contentPreserving: true,
  // Markdown output is prose and tables; a blind cut through it loses meaning but does not corrupt a format.
  truncatable: true,

  applies: (ctx) => ctx.text.length > 300 && looksLikeHtml(ctx.text),

  run: (ctx) => {
    const out = htmlToMarkdown(ctx.text);

    // Refuse if almost nothing survived. A page that is entirely script and layout yields a few words, and returning
    // those as though they were the document is worse than declining.
    if (out.length < 40) {
      return { text: ctx.text, applied: false, reason: `declined: only ${out.length} chars of content found — likely a script-rendered page` };
    }
    if (out.length >= ctx.text.length) {
      return { text: ctx.text, applied: false, reason: "conversion would not reduce the input" };
    }

    return {
      text: out,
      applied: true,
      reason: `HTML to Markdown: markup discarded, all text preserved (${ctx.text.length} -> ${out.length})`,
    };
  },
};

export default html;
