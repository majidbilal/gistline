import { test } from "node:test";
import assert from "node:assert/strict";
import { html, htmlToMarkdown, looksLikeHtml, decodeEntities, mainRegion } from "./html.mjs";

// HTML to Markdown.
//
// The gate for this stage: a real scraped article converts with all headings, lists, tables and links preserved, and the
// reduction is MEASURED rather than estimated.

const article = `<!DOCTYPE html>
<html><head>
  <title>Ignore me</title>
  <style>body{font:14px/1.5 sans-serif}.wrapper{max-width:960px}</style>
  <script>window.analytics=function(){/* 400 chars of tracking */};dataLayer.push({event:"pageview"});</script>
</head>
<body class="page page--article theme-light" data-page-id="4821">
  <header class="site-header"><nav class="nav"><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav></header>
  <main>
    <article class="post" data-id="991">
      <h1 class="post__title">Passkeys and recovery</h1>
      <p class="lede">Most advice <strong>stops</strong> where your question <em>starts</em>.</p>
      <h2>What to check</h2>
      <ol class="steps"><li>Open <code>Settings</code></li><li>Find the passkey list</li><li>Look for &quot;synced&quot;</li></ol>
      <table class="matrix">
        <tr><th>Account</th><th>Priority</th></tr>
        <tr><td>Email</td><td>First</td></tr>
        <tr><td>Bank</td><td>Second</td></tr>
      </table>
      <p>See <a href="https://example.com/guide" class="cta">the full guide</a> &mdash; it&#39;s free.</p>
      <blockquote>Two ways in beats one perfect way in.</blockquote>
      <img src="data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" alt="A numbered list of accounts">
    </article>
  </main>
  <footer class="site-footer"><p>Copyright 2026. <a href="/privacy">Privacy</a></p></footer>
  <script>console.log("more tracking")</script>
</body></html>`;

// --- the gate ---------------------------------------------------------------------------------------------

test("GATE: a real article converts and every structural element survives", () => {
  const md = htmlToMarkdown(article);

  assert.match(md, /^# Passkeys and recovery/m, "h1");
  assert.match(md, /^## What to check/m, "h2");
  assert.match(md, /\*\*stops\*\*/, "strong");
  assert.match(md, /\*starts\*/, "em");
  assert.match(md, /^1\. Open `Settings`/m, "ordered list with inline code");
  assert.match(md, /^3\. Look for "synced"/m, "entity decoded inside a list item");
  assert.match(md, /Account,Priority/, "table header");
  assert.match(md, /Email,First/, "table row");
  assert.match(md, /\[the full guide\]\(https:\/\/example\.com\/guide\)/, "link with target");
  assert.match(md, /^> Two ways in beats one perfect way in\./m, "blockquote");
  assert.match(md, /\[image: A numbered list of accounts\]/, "image alt kept");
  assert.match(md, /— it's free/, "mdash and numeric entity");
});

test("GATE: the reduction is real, and measured", () => {
  const md = htmlToMarkdown(article);
  const saved = ((article.length - md.length) / article.length) * 100;
  assert.ok(saved > 50, `expected >50% reduction on a real page, got ${saved.toFixed(1)}%`);
});

// --- what must be discarded --------------------------------------------------------------------------------

test("script, style, nav, header and footer are gone entirely", () => {
  const md = htmlToMarkdown(article);
  for (const noise of ["analytics", "dataLayer", "max-width", "sans-serif", "console.log"]) {
    assert.ok(!md.includes(noise), `leaked: ${noise}`);
  }
  assert.ok(!md.includes("Copyright 2026"), "footer content leaked");
  assert.ok(!/\bHome\b/.test(md), "nav link leaked");
});

test("a base64 data URI never reaches the output", () => {
  // A src attribute can be larger than the entire rest of the page.
  assert.ok(!htmlToMarkdown(article).includes("AAAAAAAA"));
});

test("class names, data attributes and ids are discarded", () => {
  const md = htmlToMarkdown(article);
  for (const attr of ["post__title", "data-page-id", "theme-light", "cta", "matrix"]) {
    assert.ok(!md.includes(attr), `attribute leaked: ${attr}`);
  }
});

// --- declining, which is half the contract -----------------------------------------------------------------

test("a script-rendered shell is DECLINED, not reported as an empty article", () => {
  // A page that is entirely JavaScript yields a few words. Returning those as though they were the document is worse
  // than saying so.
  const shell = `<!DOCTYPE html><html><head><script src="/app.js"></script>
    <script>${"window.__DATA__={a:1};".repeat(80)}</script></head>
    <body><div id="root"></div></body></html>`;
  const r = html.run({ text: shell, budget: 4000 });
  assert.equal(r.applied, false);
  assert.match(r.reason, /script-rendered page/);
  assert.equal(r.text, shell, "the original must come back untouched");
});

test("prose containing an angle bracket is not mistaken for HTML", () => {
  // A stray `<` in text must not trigger conversion — that would silently mangle a plain document.
  assert.equal(looksLikeHtml("if a < b then return"), false);
  assert.equal(looksLikeHtml("use <placeholder> here"), false);
  assert.equal(looksLikeHtml("2 < 3 and 5 > 4"), false);
});

test("real HTML is recognised in both its forms", () => {
  assert.equal(looksLikeHtml("<!DOCTYPE html><html><body>hi</body></html>"), true);
  // A fragment with no doctype needs several distinct tags.
  assert.equal(looksLikeHtml("<div><p>one</p><ul><li>a</li></ul></div>"), true);
  assert.equal(looksLikeHtml("<p>just one tag</p>"), false, "one tag is not enough evidence");
});

test("short input does not apply", () => {
  assert.equal(html.applies({ text: "<html><body>hi</body></html>", budget: 4000 }), false);
});

// --- structure that a naive converter destroys -------------------------------------------------------------

test("a table is converted BEFORE tags are stripped, so rows survive", () => {
  // Once <tr> and <td> are gone the rows cannot be recovered, and a table flattened into a run of words is the most
  // information-destroying thing a naive converter does.
  const md = htmlToMarkdown(`<html><body><main><table>
    <tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
    <p>${"padding ".repeat(40)}</p></main></body></html>`);
  assert.match(md, /A,B/);
  assert.ok(!/---/.test(md.split("\n\n")[0]), "the dense form has no separator row — that is the point of it");
  assert.match(md, /1,2/);
});

test("delimiter safety, per mode: a COMMA is quoted in the dense form", () => {
  // The dense form's delimiter is a comma, so that is what must be escaped. A pipe is ordinary text there and is left
  // exactly as written — this test replaced one asserting pipe escaping, which was testing preserve mode's rule against
  // the default mode's output.
  const md = htmlToMarkdown(`<html><body><main><table><tr><th>Cmd</th></tr><tr><td>a, b</td></tr></table>
    <p>${"padding ".repeat(40)}</p></main></body></html>`);
  assert.match(md, /"a, b"/, "a cell containing the delimiter must be quoted");
});

test("delimiter safety, per mode: a PIPE is left alone in the dense form", () => {
  // The other half. Escaping a pipe where it is not a delimiter would corrupt the value with a stray backslash.
  const md = htmlToMarkdown(`<html><body><main><table><tr><th>Cmd</th></tr><tr><td>a | b</td></tr></table>
    <p>${"padding ".repeat(40)}</p></main></body></html>`);
  assert.match(md, /^a \| b$/m, "the pipe is content here, not syntax");
  assert.ok(!md.includes("\\|"), "it must not be escaped");
});

test("a ragged table is padded rather than misaligned", () => {
  // Padding matters more in the dense form than in the pipe form: without it, a short row's values shift left and land
  // under the wrong header, which reads as data rather than as damage.
  const md = htmlToMarkdown(`<html><body><main><table>
    <tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></table>
    <p>${"padding ".repeat(40)}</p></main></body></html>`);
  const row = md.split("\n").find((l) => l.startsWith("1"));
  assert.equal(row, "1,,", `expected three fields with two empty, got: ${row}`);
});

test("nested noise elements are removed, not just the outermost", () => {
  // A <nav> inside a <header> is ordinary, and a single-pass strip leaves the inner one behind.
  const md = htmlToMarkdown(`<html><body><header><nav><ul><li>Menu</li></ul></nav></header>
    <main><p>${"real content ".repeat(20)}</p></main></body></html>`);
  assert.ok(!md.includes("Menu"));
  assert.match(md, /real content/);
});

test("main or article is preferred over the whole body when the page marks one", () => {
  const body = `<body><div class="sidebar">${"sidebar noise ".repeat(30)}</div>
    <main><p>${"the actual article ".repeat(20)}</p></main></body>`;
  assert.match(mainRegion(body), /the actual article/);
  assert.ok(!mainRegion(body).includes("sidebar noise"));
});

// --- entities ----------------------------------------------------------------------------------------------

test("named, decimal and hex entities all decode; an unknown one is left alone", () => {
  assert.equal(decodeEntities("a &amp; b &lt; c &gt; d"), "a & b < c > d");
  assert.equal(decodeEntities("&quot;q&quot; &apos;a&apos;"), '"q" \'a\'');
  assert.equal(decodeEntities("&#39;&#8212;&#x2014;"), "'\u2014\u2014");
  assert.equal(decodeEntities("&notarealentity;"), "&notarealentity;");
});

test("an out-of-range numeric entity does not crash the converter", () => {
  // One malformed entity must not take down a whole document.
  assert.doesNotThrow(() => decodeEntities("&#x110000; &#99999999;"));
});
