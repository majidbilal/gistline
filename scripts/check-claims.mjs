// Verify every measurable claim the README makes. Kept in the repo because it caught three of my own errors.
import { PLATFORMS } from "../install.mjs";
import { readFileSync, existsSync } from "node:fs";

const readme = readFileSync("README.md", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const pass = [];
const fail = [];
const check = (name, ok, detail = "") => (ok ? pass : fail).push(`${name}${detail ? `  -> ${detail}` : ""}`);

// Platform count, stated in prose as "and N more".
const more = Number((readme.match(/and (\d+) more/) ?? [])[1]);
check("the 'and N more' count matches the code", more + 5 === PLATFORMS.length, `README implies ${more + 5}, code has ${PLATFORMS.length}`);

// Every --platform id in the README exists, and every supported one is listed.
const inReadme = [...readme.matchAll(/--platform ([a-z][\w-]*)/g)].map((m) => m[1]);
const ids = new Set(PLATFORMS.flatMap((p) => [p.id, ...(p.alias ?? [])]));
check("no unknown platform named", inReadme.every((id) => ids.has(id)), inReadme.filter((id) => !ids.has(id)).join(", "));
const listed = new Set(inReadme);
const missing = PLATFORMS.filter((p) => !listed.has(p.id) && p.id !== "claude");
check("every supported platform is listed", missing.length === 0, missing.map((p) => p.id).join(", "));

// The engine floor must agree between README, badge and package.json.
const badgeNode = (readme.match(/node-%E2%89%A5([\d.]+)/) ?? [])[1];
const tableNode = (readme.match(/\*\*Node\*\* \| ([\d.]+)/) ?? [])[1];
const engineNode = (pkg.engines?.node ?? "").replace(/[^\d.]/g, "");
check("engine floor agrees across badge, table and package.json",
  badgeNode === tableNode && `${tableNode}.0` === engineNode,
  `badge ${badgeNode}, table ${tableNode}, package ${engineNode}`);

// Test count, stated twice.
const badgeTests = Number((readme.match(/tests-(\d+)%20passing/) ?? [])[1]);
const proseTests = Number((readme.match(/\*\*(\d+) tests,/) ?? [])[1]);
check("test count consistent", badgeTests === proseTests, `${badgeTests} vs ${proseTests}`);

// Commands shown must exist.
const cli = readFileSync("cli.mjs", "utf8");
for (const cmd of ["retrieve", "slice", "grep", "store-stats", "install", "uninstall", "status", "platforms"]) {
  check(`command "${cmd}" exists in the CLI`, cli.includes(`"${cmd}"`));
}

// Scripts referenced must exist.
for (const s of ["test", "smoke"]) check(`npm script "${s}" exists`, !!pkg.scripts?.[s]);

// No emojis. Requested explicitly, and a stray one is easy to miss by eye.
const emoji = readme.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F000}-\u{1F0FF}]/gu);
check("no emojis", !emoji, emoji ? [...new Set(emoji)].join(" ") : "");

// Internal anchors resolve to a real heading.
const anchors = [...readme.matchAll(/\]\(#([\w-]+)\)/g)].map((m) => m[1]);
const headings = [...readme.matchAll(/^#{2,3} (.+)$/gm)]
  .map((m) => m[1].toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-"));
check("internal links resolve", anchors.every((a) => headings.includes(a)), anchors.filter((a) => !headings.includes(a)).join(", "));

// Linked files and images exist.
const links = [...readme.matchAll(/\]\((?!http|#)([^)]+)\)/g)].map((m) => m[1]);
check("linked files exist", links.every((l) => existsSync(l)), links.filter((l) => !existsSync(l)).join(", "));

// The hero image must be present and non-trivial.
check("hero image exists and has content",
  existsSync("docs/hero.svg") && readFileSync("docs/hero.svg", "utf8").length > 1000);

// Every file listed in `files` must exist, or the published package is broken.
const globless = pkg.files.filter((f) => !f.includes("*") && !f.startsWith("!"));
check("every non-glob entry in package.files exists",
  globless.every((f) => existsSync(f)), globless.filter((f) => !existsSync(f)).join(", "));

console.log(`README and package claims: ${pass.length} ok, ${fail.length} failed\n`);
for (const f of fail) console.log(`  FAIL  ${f}`);
if (!fail.length) console.log("  every checkable claim holds");
process.exit(fail.length ? 1 : 0);
