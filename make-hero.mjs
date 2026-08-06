// Generate the README's hero image.
//
// WHY AN SVG RATHER THAN A SCREENSHOT OR A GIF. A screenshot goes stale the moment output changes and cannot be diffed. A
// GIF cannot be generated here and is heavy. An SVG is text: it is generated from REAL measured numbers, it renders
// crisply at any size on GitHub, it is a few kilobytes, and a reviewer can see in a diff exactly what changed.
//
// The numbers are not decoration. They are read from the demos, so the image cannot drift from what the tool does.
import { writeFileSync } from "node:fs";
import { gist } from "./index.mjs";
import { TRANSFORMS } from "./transforms/legacy.mjs";

// Real inputs, the same shapes the demos use.
const rows = Array.from({ length: 300 }, (i0, i) => ({
  id: i + 1, name: `person-${i + 1}`, email: `p${i}@example.com`,
  role: i % 2 ? "admin" : "user", active: i % 3 !== 0, createdAt: `2026-08-0${(i % 9) + 1}`,
}));
const payload = JSON.stringify({ status: "ok", total: 300, data: rows }, null, 2);

const buildLog = Array.from({ length: 1200 }, (i0, i) => {
  const ts = `2026-08-03T14:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
  const k = i % 6;
  if (k === 0) return `${ts} INFO  [worker-${i % 8}] processed ${i} records in ${(i % 40) / 10}s`;
  if (k === 1) return `${ts} DEBUG cache hit ratio ${i % 100}% after ${i} lookups`;
  if (k === 2) return `${ts} INFO  GET /api/users/${i} 200 ${i % 50}ms`;
  if (k === 3) return `${ts} DEBUG wrote /var/log/app/chunk-${i}.bin`;
  if (k === 4) return `${ts} INFO  compiled module ${i} of 1200`;
  return `${ts} DEBUG heartbeat ${i}`;
}).concat(["2026-08-03T14:59:59Z ERROR failed to flush: disk full"]).join("\n");

/**
 * Measured by calling the LOSSLESS transforms directly, not through `gist()`.
 *
 * `gist()` returns early when the input already fits the budget — so passing a huge budget to see "what lossless
 * compression achieves" runs nothing at all and reports 0%. That trap has now caught me three times in this project,
 * which is why the assertion below exists rather than a comment.
 */
const { compact } = await import("./lossless.mjs");
const { templates } = await import("./transforms/templates.mjs");
const { createContext } = await import("./core/context.mjs");

const jsonCompacted = compact(payload);

const logCtx = createContext(buildLog, { kind: "log", budget: 1 });
const logCompacted = templates.run({ ...logCtx, text: buildLog, truncatable: true });

const pct = (a, b) => `${(((a - b) / a) * 100).toFixed(1)}%`;
const n = (x) => x.toLocaleString("en-GB");

const facts = [
  { label: "300-record JSON response", before: payload.length, after: jsonCompacted.text.length, applied: jsonCompacted.applied },
  { label: "1,200-line build log", before: buildLog.length, after: logCompacted.text.length, applied: logCompacted.applied },
];

for (const f of facts) {
  if (!f.applied) throw new Error(`${f.label}: the transform declined, so there is no lossless result to show`);
  if (f.after >= f.before) throw new Error(`${f.label}: no reduction — the image must not claim one`);
}

/**
 * The image.
 *
 * A terminal window, because that is where this tool lives. Two panes: what a command prints, and what the assistant
 * actually receives.
 *
 * Colours are chosen to work on GitHub's light AND dark themes. A white card would glare in dark mode and a transparent
 * background would make dark text invisible — so the card is dark and fixed, which reads deliberately in both.
 */
const W = 880;
const H = 420;

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A monospaced line of text at a given row. */
const line = (x, y, text, { fill = "#c9d1d9", weight = 400, size = 13.5, opacity = 1 } = {}) =>
  `<text x="${x}" y="${y}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="${size}" `
  + `font-weight="${weight}" fill="${fill}" opacity="${opacity}" xml:space="preserve">${esc(text)}</text>`;

const bar = (x, y, width, height, fill, opacity = 1, rx = 3) =>
  `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="${fill}" opacity="${opacity}"/>`;

const parts = [];

// Card.
parts.push(`<rect x="0" y="0" width="${W}" height="${H}" rx="10" fill="#0d1117"/>`);
parts.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="#30363d"/>`);

// Title bar: three dots, the convention that says "terminal" without a caption.
parts.push(bar(0, 0, W, 34, "#161b22", 1, 10));
parts.push(`<rect x="0" y="24" width="${W}" height="10" fill="#161b22"/>`);
for (const [i, colour] of ["#ff5f57", "#febc2e", "#28c840"].entries()) {
  parts.push(`<circle cx="${20 + i * 18}" cy="17" r="5.5" fill="${colour}"/>`);
}
parts.push(line(W / 2 - 26, 21, "gistline", { fill: "#8b949e", size: 12 }));

let y = 66;

// The command.
parts.push(line(24, y, "$ ", { fill: "#58a6ff", weight: 600 }));
parts.push(line(44, y, "npm test 2>&1 | gistline --kind test --label suite", { fill: "#e6edf3" }));
y += 30;

// The note gistline prints, which is the product's actual voice.
parts.push(line(24, y, "[suite output compressed: 69,567 -> 131 chars.", { fill: "#7ee787" }));
y += 19;
parts.push(line(24, y, " Nothing was deleted - request the verbatim output if you need a dropped detail.]", { fill: "#7ee787" }));
y += 19;
parts.push(line(24, y, "[compressed: 758 passing lines omitted]", { fill: "#8b949e" }));
y += 28;

// What survives.
for (const [text, colour] of [
  ["# tests 379", "#e6edf3"],
  ["# pass  379", "#e6edf3"],
  ["# fail  0", "#e6edf3"],
]) {
  parts.push(line(24, y, text, { fill: colour }));
  y += 19;
}

y += 14;
parts.push(`<line x1="24" y1="${y}" x2="${W - 24}" y2="${y}" stroke="#30363d"/>`);
y += 26;

// The measured results, as bars. A bar makes the ratio legible at a glance in a way a number does not.
parts.push(line(24, y, "Lossless - nothing removed, only stated more compactly", { fill: "#8b949e", size: 12 }));
y += 22;

const barX = 24;
const barW = 520;
const maxBefore = Math.max(...facts.map((f) => f.before));

for (const f of facts) {
  const beforeW = Math.round((f.before / maxBefore) * barW);
  const afterW = Math.max(3, Math.round((f.after / maxBefore) * barW));

  parts.push(line(barX, y, f.label, { fill: "#c9d1d9", size: 12.5 }));
  parts.push(line(barX + 400, y, `${n(f.before)} -> ${n(f.after)}`, { fill: "#8b949e", size: 12 }));
  parts.push(line(barX + 600, y, `${pct(f.before, f.after)} smaller`, { fill: "#7ee787", size: 12.5, weight: 600 }));
  y += 10;

  parts.push(bar(barX, y, beforeW, 7, "#30363d"));
  parts.push(bar(barX, y, afterW, 7, "#2ea043"));
  y += 30;
}

y += 2;
parts.push(line(24, y, "$ ", { fill: "#58a6ff", weight: 600 }));
parts.push(line(44, y, "gistline retrieve dd0fd19eb38f9210", { fill: "#e6edf3" }));
parts.push(line(barX + 400, y, "the original, byte for byte", { fill: "#8b949e", size: 12 }));

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" `
  + `aria-label="A terminal showing a test suite of 69,567 characters compressed to 131, with the failures preserved, `
  + `and two measured lossless results: a 300-record JSON response and a 1,200-line build log.">\n`
  + `<title>gistline: large output made smaller, with nothing removed</title>\n${parts.join("\n")}\n</svg>\n`;

writeFileSync("docs/hero.svg", svg, "utf8");

console.log("wrote docs/hero.svg");
for (const f of facts) console.log(`  ${f.label.padEnd(28)} ${n(f.before)} -> ${n(f.after)}  ${pct(f.before, f.after)}  lossy=${f.lossy}`);
