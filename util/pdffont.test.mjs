import { test } from "node:test";
import assert from "node:assert/strict";
import { glyphToChar, parseToUnicode, parseDifferences, makeFontDecoder } from "./pdffont.mjs";

// The encoding ladder.
//
// Getting this wrong produces plausible-looking mojibake, which is worse than nothing because nothing downstream can
// detect it. So the tests concentrate on the four paths and on what happens when none of them resolves a code.

// --- glyph names: the path usually omitted -----------------------------------------------------------------

test("algorithmic names resolve to any character", () => {
  assert.equal(glyphToChar("uni0041"), "A");
  assert.equal(glyphToChar("uni20AC"), "\u20ac");
  assert.equal(glyphToChar("u00E9"), "\u00e9");
  assert.equal(glyphToChar("/uni0041"), "A", "a leading slash is tolerated");
});

test("a single-character name means itself", () => {
  assert.equal(glyphToChar("a"), "a");
  assert.equal(glyphToChar("Z"), "Z");
});

test("the named table covers what a business document actually uses", () => {
  assert.equal(glyphToChar("space"), " ");
  assert.equal(glyphToChar("period"), ".");
  assert.equal(glyphToChar("quoteright"), "\u2019");
  assert.equal(glyphToChar("emdash"), "\u2014");
  assert.equal(glyphToChar("sterling"), "\u00a3");
  assert.equal(glyphToChar("bullet"), "\u2022");
});

test("ligatures resolve, or they are lost mid-word", () => {
  // `fi` and `fl` appear constantly in typeset text, and dropping them removes letters from the middle of words.
  assert.equal(glyphToChar("fi"), "\ufb01");
  assert.equal(glyphToChar("fl"), "\ufb02");
});

test("a non-breaking space is a space, because dropping it JOINS two words", () => {
  assert.equal(glyphToChar("nbspace"), "\u00a0");
  assert.equal(glyphToChar("uni00A0"), "\u00a0");
});

test("accented letters are built from base plus accent", () => {
  assert.equal(glyphToChar("aacute").normalize("NFC"), "\u00e1");
  assert.equal(glyphToChar("Ograve").normalize("NFC"), "\u00d2");
  assert.equal(glyphToChar("ccedilla").normalize("NFC"), "\u00e7");
});

test("variant suffixes fall back to the base character", () => {
  assert.equal(glyphToChar("A.sc"), "A");
  assert.equal(glyphToChar("one.oldstyle"), "1");
});

test("position-reference names return NULL rather than a guess", () => {
  // `g47` and `cid1234` carry no character meaning at all. Returning null lets the caller count them and report the text
  // as unreliable; inventing a character would be undetectable downstream.
  for (const n of ["g47", "cid1234", "index99", "glyph12"]) {
    assert.equal(glyphToChar(n), null, n);
  }
});

test("an unknown name returns null, not an empty string that reads as success", () => {
  assert.equal(glyphToChar("someNameNobodyHas"), null);
  assert.equal(glyphToChar(""), null);
  assert.equal(glyphToChar(null), null);
});

// --- /ToUnicode CMaps -------------------------------------------------------------------------------------

test("bfchar mappings are read", () => {
  const map = parseToUnicode(`
    /CIDInit /ProcSet findresource begin
    2 beginbfchar
    <0003> <0020>
    <0024> <0041>
    endbfchar
  `);
  assert.equal(map.get(3), " ");
  assert.equal(map.get(0x24), "A");
});

test("a bfchar destination may be SEVERAL characters", () => {
  // One glyph can map to several characters — a ligature maps to two. Reading only the first silently halves them.
  const map = parseToUnicode(`1 beginbfchar\n<0001> <00660069>\nendbfchar`);
  assert.equal(map.get(1), "fi");
});

test("contiguous bfranges increment the destination", () => {
  const map = parseToUnicode(`1 beginbfrange\n<0041> <0043> <0061>\nendbfrange`);
  assert.equal(map.get(0x41), "a");
  assert.equal(map.get(0x42), "b");
  assert.equal(map.get(0x43), "c");
});

test("the explicit-list bfrange form is read, and not mistaken for the contiguous one", () => {
  const map = parseToUnicode(`1 beginbfrange\n<0010> <0012> [ <0058> <0059> <005A> ]\nendbfrange`);
  assert.equal(map.get(0x10), "X");
  assert.equal(map.get(0x11), "Y");
  assert.equal(map.get(0x12), "Z");
});

test("both bfrange forms in one CMap are both read", () => {
  const map = parseToUnicode(`
    2 beginbfrange
    <0010> <0012> [ <0058> <0059> <005A> ]
    <0041> <0042> <0061>
    endbfrange
  `);
  assert.equal(map.get(0x10), "X");
  assert.equal(map.get(0x41), "a");
  assert.equal(map.get(0x42), "b");
});

test("a pathological range is bounded rather than allocating unboundedly", () => {
  const map = parseToUnicode(`1 beginbfrange\n<0000> <FFFFFF> <0041>\nendbfrange`);
  assert.ok(map.size <= 65536, `range produced ${map.size} entries`);
});

test("surrogate pairs decode as one character", () => {
  const map = parseToUnicode(`1 beginbfchar\n<0001> <D83DDE00>\nendbfchar`);
  assert.equal(map.get(1), "\u{1F600}");
});

// --- /Differences ----------------------------------------------------------------------------------------

test("a Differences array resets on a number and advances on each name", () => {
  const map = parseDifferences("[ 32 /space /exclam 65 /A /B ]");
  assert.equal(map.get(32), "space");
  assert.equal(map.get(33), "exclam");
  assert.equal(map.get(65), "A");
  assert.equal(map.get(66), "B");
  assert.equal(map.has(34), false, "the sequence must not continue past the reset");
});

// --- the decoder: the four paths, in order -----------------------------------------------------------------

const bytes = (...b) => Buffer.from(b);

test("PATH 1: ToUnicode wins over everything else", () => {
  // It is the only definitive mechanism, so a base encoding that happens to disagree must not override it.
  const d = makeFontDecoder({
    toUnicode: `1 beginbfchar\n<0041> <2713>\nendbfchar`,
    baseEncoding: "/WinAnsiEncoding",
  });
  assert.equal(d.decode(bytes(0x41)), "\u2713");
});

test("PATH 2: Differences plus glyph names decode a SUBSET font", () => {
  // The path that makes subsetted fonts readable. Codes are arbitrary; the names say what they mean.
  const d = makeFontDecoder({ differences: "[ 1 /H /e /l /o 5 /space ]" });
  assert.equal(d.decode(bytes(1, 2, 3, 3, 4)), "Hello");
  assert.equal(d.decode(bytes(5)), " ");
  assert.equal(d.unmapped, 0);
});

test("PATH 3: WinAnsi resolves the range where Latin-1 goes wrong", () => {
  // 0x80-0x9F is exactly where a naive Latin-1 reading fails, and it holds the smart quotes, dashes and ellipsis that
  // appear in nearly every real document - so an error here is visible in the first paragraph.
  const d = makeFontDecoder({ baseEncoding: "/WinAnsiEncoding" });
  assert.equal(d.decode(bytes(0x91, 0x92)), "\u2018\u2019");
  assert.equal(d.decode(bytes(0x93, 0x94)), "\u201c\u201d");
  assert.equal(d.decode(bytes(0x96, 0x97)), "\u2013\u2014");
  assert.equal(d.decode(bytes(0x85)), "\u2026");
  assert.equal(d.decode(bytes(0x80)), "\u20ac");
});

test("PATH 4: a font with no encoding at all still reads ASCII", () => {
  const d = makeFontDecoder({});
  assert.equal(d.decode(bytes(72, 101, 108, 108, 111)), "Hello");
  assert.equal(d.unmapped, 0);
});

test("Differences fills only the codes it names; the rest fall through", () => {
  const d = makeFontDecoder({ differences: "[ 1 /A ]" });
  assert.equal(d.decode(bytes(1)), "A");
  assert.equal(d.decode(bytes(66)), "B", "an unnamed code must still decode");
});

// --- the two-byte trap ------------------------------------------------------------------------------------

test("an Identity-encoded font is read TWO BYTES at a time", () => {
  // Reading a two-byte font one byte at a time produces twice as many wrong characters as right ones.
  const d = makeFontDecoder({
    identity: true,
    toUnicode: `2 beginbfchar\n<0024> <0041>\n<0025> <0042>\nendbfchar`,
  });
  assert.equal(d.twoByte, true);
  assert.equal(d.decode(bytes(0x00, 0x24, 0x00, 0x25)), "AB");
});

test("two-byte mode is inferred from a CMap with codes above 255", () => {
  const d = makeFontDecoder({ toUnicode: `1 beginbfchar\n<0124> <0041>\nendbfchar` });
  assert.equal(d.twoByte, true);
  assert.equal(d.decode(bytes(0x01, 0x24)), "A");
});

test("a single-byte font is NOT read as two-byte", () => {
  const d = makeFontDecoder({ toUnicode: `1 beginbfchar\n<0041> <0041>\nendbfchar` });
  assert.equal(d.twoByte, false);
  assert.equal(d.decode(bytes(0x41, 0x41)), "AA");
});

// --- the honest failure -----------------------------------------------------------------------------------

test("unmapped codes are COUNTED, so a caller learns the text is unreliable", () => {
  // A count is evidence; silence looks like success. This is the case where output would otherwise be confident and
  // wrong - identity encoding with nothing to resolve it.
  const d = makeFontDecoder({ identity: true });
  assert.equal(d.decode(bytes(0x00, 0x24, 0x00, 0x25, 0x00, 0x26)), "", "nothing should be invented");
  assert.equal(d.unmapped, 3);
});

test("a code that resolves through NO path yields nothing rather than a wrong character", () => {
  const d = makeFontDecoder({ identity: true, differences: "[ 1 /g47 ]" });
  assert.equal(d.decode(bytes(0x00, 0x01)), "");
  assert.ok(d.unmapped > 0);
});

test("control codes become spaces rather than disappearing", () => {
  // A tab inside a shown string is whitespace; dropping it joins two words.
  assert.equal(makeFontDecoder({}).decode(bytes(65, 9, 66)), "A B");
});

test("an odd trailing byte in two-byte mode degrades rather than throwing", () => {
  const d = makeFontDecoder({ identity: true, toUnicode: `1 beginbfchar\n<0041> <0041>\nendbfchar` });
  assert.doesNotThrow(() => d.decode(bytes(0x00, 0x41, 0x99)));
});
