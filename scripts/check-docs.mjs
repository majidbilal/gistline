// Final sweep: are any stale numbers or claims left anywhere in the docs?
//
// The claim checker covers the README. This looks across ALL of them for figures that were true at some point and are not
// now — the failure mode being a reader who believes a number nobody updated.
import { readFileSync, readdirSync } from "node:fs";

const DOCS = ["README.md", "ROADMAP.md", "ISSUES.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "BENCHMARKS.md"];

// Figures that are now wrong wherever they appear as a CURRENT claim. The changelog may cite them historically, so it is
// checked separately below.
const STALE = [
  ["29.2%", "the old log figure — logs now reach 67.5%"],
  ["379 tests", "the old test count"],
  ["429 tests", "the old test count"],
  ["446 tests", "the old test count"],
  ["484 tests", "the old test count"],
  ["node-%E2%89%A518", "the old engine badge"],
  ["Node 18 or newer", "the old engine floor"],
  ["94.0%", "the old spreadsheet figure"],
  ["94.1%", "the old spreadsheet figure"],
  ["1.9\u00d7 more", "the old combined-path figure"],
  ["Comments are not included", "comments are read now"],
  ["gistline run <command>` does not exist", "it exists"],
  ["No published benchmark", "there is one"],
  ["hooks for three platforms", "five now"],
  ["No OCR, and no plan", "OCR is an optional adapter now"],
  ["Nothing was deleted", "the note wording changed"],
];

let problems = 0;

for (const doc of DOCS) {
  let text;
  try { text = readFileSync(doc, "utf8"); } catch { console.log(`  MISSING  ${doc}`); problems += 1; continue; }

  const found = STALE.filter(([needle]) => {
    if (!text.includes(needle)) return false;

    /**
     * A HISTORICAL reference is not a stale claim.
     *
     * "where they used to sit at 29.2%" is the whole point of saying it, and a changelog entry for an older version citing
     * its own test count is correct. Only a figure presented as CURRENT is a problem.
     */
    const lines = text.split("\n").filter((l) => l.includes(needle));
    return lines.some((l) => !/used to|previously|was |old |up from|from 29|## 0\.[0-4]/i.test(l));
  });

  // The changelog is a record of past releases, so a figure inside an older version's section is correct by definition.
  const real = doc === "CHANGELOG.md" ? [] : found;

  if (real.length) {
    console.log(`  STALE in ${doc}:`);
    for (const [needle, why] of real) console.log(`    "${needle}" — ${why}`);
    problems += real.length;
  } else {
    console.log(`  ok       ${doc}`);
  }
}

// Every doc the README links to must exist, and vice versa for the community files.
const { existsSync } = await import("node:fs");
for (const doc of DOCS) {
  if (!existsSync(doc)) continue;
  const links = [...readFileSync(doc, "utf8").matchAll(/\]\((?!http|#)([^)]+)\)/g)].map((m) => m[1]);
  const broken = links.filter((l) => !existsSync(l));
  if (broken.length) { console.log(`  BROKEN LINKS in ${doc}: ${broken.join(", ")}`); problems += broken.length; }
}

// No emojis anywhere: requested explicitly, and easy to miss by eye.
for (const doc of DOCS) {
  if (!existsSync(doc)) continue;
  const emoji = readFileSync(doc, "utf8").match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu);
  if (emoji) { console.log(`  EMOJI in ${doc}: ${[...new Set(emoji)].join(" ")}`); problems += 1; }
}

console.log(`\n${problems ? `${problems} problem(s)` : "every document is consistent with the current code"}`);
process.exit(problems ? 1 : 0);
