// The combined result: lossless first, then structure-aware lossy, with the original recoverable by hash.
//
// Run: node combined.mjs
import { gist } from "../index.mjs";
import { TRANSFORMS, LOSSY_TRANSFORMS } from "../transforms/legacy.mjs";
import { openStore } from "../store.mjs";
import { expand } from "../transforms/templates.mjs";

const buildLog = Array.from({ length: 1200 }, (i0, i) => {
  const ts = `2026-08-03T14:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
  const k = i % 6;
  if (k === 0) return `${ts} INFO  [worker-${i % 8}] processed ${i} records in ${(i % 40) / 10}s`;
  if (k === 1) return `${ts} DEBUG cache hit ratio ${i % 100}% after ${i} lookups`;
  if (k === 2) return `${ts} INFO  GET /api/users/${i} 200 ${i % 50}ms from 10.0.${i % 8}.${i % 200}`;
  if (k === 3) return `${ts} DEBUG wrote /var/log/app/chunk-${i}.bin (${i * 7}kb)`;
  if (k === 4) return `${ts} INFO  compiled module ${i} of 1200`;
  return `${ts} DEBUG heartbeat ${i}`;
}).concat([
  "2026-08-03T14:59:58Z WARN  retrying upload after 3 failures",
  "2026-08-03T14:59:59Z ERROR failed to flush: disk full",
  "2026-08-03T15:00:00Z FATAL AssertionError: expected 200 to equal 500",
]).join("\n");

const store = openStore({ dir: ".gistline-store" });
const B = 4000;

const row = (name, r) => {
  const ids = r.applied ? r.applied.filter((a) => a.applied).map((a) => a.id).join(" -> ") : "-";
  console.log(
    `${name.padEnd(22)} ${String(r.originalChars).padStart(7)} -> ${String(r.compressedChars).padStart(6)}` +
    `  ${(((r.originalChars - r.compressedChars) / r.originalChars) * 100).toFixed(1).padStart(5)}%` +
    `  lossy=${String(r.lossy ?? "-").padEnd(5)} ${ids}`,
  );
  return r;
};

console.log(`budget ${B} chars\n`);
console.log(`${"path".padEnd(22)}   before ->  after  saved  lossy  transforms`);
console.log("-".repeat(110));

const lossyOnly = row("lossy only (old)", gist(buildLog, { kind: "log", budget: B, store, transforms: LOSSY_TRANSFORMS }));
const combined = row("combined (new)", gist(buildLog, { kind: "log", budget: B, store, transforms: TRANSFORMS }));
const losslessOnly = row("lossless only", gist(buildLog, { kind: "log", budget: 1e9, transforms: TRANSFORMS }));

console.log("\nFIDELITY — did the three lines a reader actually needs survive?");
for (const [name, r] of [["lossy only", lossyOnly], ["combined", combined]]) {
  console.log(
    `  ${name.padEnd(12)} WARN:${String(r.text.includes("retrying upload")).padEnd(6)}` +
    ` ERROR:${String(r.text.includes("disk full")).padEnd(6)} FATAL:${r.text.includes("AssertionError")}`,
  );
}

console.log("\nRECOVERY — the hash store is what makes the lossy step safe");
console.log(`  retrieval id: ${combined.retrievalId}`);
const back = store.get(combined.retrievalId);
console.log(`  original recovered byte-exact: ${back === buildLog}`);

console.log("\nLOSSLESS STAGE — expandable back to the input exactly?");
const body = losslessOnly.text.includes("\n---\n") ? losslessOnly.text.slice(losslessOnly.text.indexOf("T1")) : null;
console.log(`  expand() === input: ${body ? expand(body) === buildLog : "(no template stage in output)"}`);

console.log("\nINFORMATION AT A FIXED BUDGET — the metric that actually matters");
console.log("  'saved %' is misleading here: both paths had 4000 chars to spend. The question is how much of the");
console.log("  original each one FITS into that budget, not which one used less of it.\n");

const originals = buildLog.split("\n");
const covered = (out) => {
  // How many original lines can still be read out of this output?
  // For the templated path, expand the row section; for the plain path, count lines present verbatim.
  if (out.includes("\n---\n")) {
    const cut = out.indexOf("\n---\n");
    const header = out.slice(out.indexOf("T1"), cut);
    const rows = out.slice(cut + 5).split("\n").filter((r) => /^T\d+/.test(r));
    try {
      const rebuilt = expand(`${header}\n---\n${rows.join("\n")}`);
      return rebuilt.split("\n").filter((l) => originals.includes(l)).length;
    } catch { return 0; }
  }
  return out.split("\n").filter((l) => originals.includes(l)).length;
};

const a = covered(lossyOnly.text);
const b = covered(combined.text);
console.log(`  lossy only:  ${String(a).padStart(4)} of ${originals.length} original lines recoverable  (${((a / originals.length) * 100).toFixed(1)}%)`);
console.log(`  combined:    ${String(b).padStart(4)} of ${originals.length} original lines recoverable  (${((b / originals.length) * 100).toFixed(1)}%)`);
console.log(`  combined keeps ${b > a ? `${(b / Math.max(1, a)).toFixed(1)}x more` : "less"} of the log in the same budget`);

console.log("\nLOSSLESS STAGE ALONE — forced, without the early return");
// gist() returns early when the input already fits, so a huge budget skips the pipeline entirely. Call the transform
// directly to see what the lossless stage achieves on its own.
const { templates: T } = await import("../transforms/templates.mjs");
const { createContext } = await import("../core/context.mjs");
const ctx = createContext(buildLog, { kind: "log", budget: 1 });
const only = T.run({ ...ctx, text: buildLog, truncatable: true });
console.log(`  ${buildLog.length} -> ${only.text.length} chars  (${(((buildLog.length - only.text.length) / buildLog.length) * 100).toFixed(1)}% smaller, nothing removed)`);
console.log(`  expand() === input: ${expand(only.text) === buildLog}`);
