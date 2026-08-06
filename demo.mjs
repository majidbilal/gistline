// Manual inspection: show the real before and after, on real shapes, so results can be judged rather than trusted.
//
// Run: node demo.mjs
import { templates } from "./transforms/templates.mjs";
import { tables } from "./transforms/tables.mjs";
import { createContext } from "./core/context.mjs";

const show = (title, raw, transform) => {
  const ctx = createContext(raw, { budget: 1_000_000 });
  const applies = transform.applies({ ...ctx, text: raw });
  const t0 = process.hrtime.bigint();
  const r = applies ? transform.run({ ...ctx, text: raw }) : { text: raw, applied: false, reason: "does not apply" };
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const pct = r.applied ? (((raw.length - r.text.length) / raw.length) * 100).toFixed(1) : "0.0";
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
  console.log(`${raw.length} chars -> ${r.text.length} chars   ${pct}% smaller   ${ms.toFixed(1)}ms   lossless=${transform.lossless}`);
  console.log(`reason: ${r.reason}`);
  if (r.applied) {
    console.log(`\n--- OUTPUT (first 900 chars) ---\n${r.text.slice(0, 900)}${r.text.length > 900 ? "\n…" : ""}`);
  }
  return r;
};

// 1. A build log: thirty formats, repeated.
const buildLog = Array.from({ length: 1200 }, (_, i) => {
  const ts = `2026-08-03T14:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
  const k = i % 6;
  if (k === 0) return `${ts} INFO  [worker-${i % 8}] processed ${i} records in ${(i % 40) / 10}s`;
  if (k === 1) return `${ts} DEBUG cache hit ratio ${i % 100}% after ${i} lookups`;
  if (k === 2) return `${ts} INFO  GET /api/users/${i} 200 ${i % 50}ms from 10.0.${i % 8}.${i % 200}`;
  if (k === 3) return `${ts} DEBUG wrote /var/log/app/chunk-${i}.bin (${i * 7}kb)`;
  if (k === 4) return `${ts} INFO  compiled module ${i} of 1200`;
  return `${ts} DEBUG heartbeat ${i}`;
}).concat([
  "2026-08-03T14:59:59Z ERROR failed to flush: disk full",
  "2026-08-03T15:00:00Z FATAL AssertionError: expected 200 to equal 500",
]).join("\n");

const r1 = show("1. BUILD LOG — 1,202 lines, six repeated formats plus two one-off failures", buildLog, templates);

// The question that matters: did the failures survive?
console.log("\n--- FIDELITY CHECK ---");
console.log(`  "disk full" present:      ${r1.text.includes("disk full")}`);
console.log(`  "AssertionError" present: ${r1.text.includes("AssertionError")}`);

// 2. A JSON API payload.
const rows = Array.from({ length: 300 }, (_, i) => ({
  id: i + 1, name: `person-${i + 1}`, email: `p${i}@example.com`,
  role: i % 2 ? "admin" : "user", active: i % 3 !== 0, createdAt: `2026-08-0${(i % 9) + 1}`,
}));
const payload = JSON.stringify({ status: "ok", total: rows.length, data: rows }, null, 2);
const r2 = show("2. JSON PAYLOAD — 300 rows, six fields each", payload, tables);
console.log("\n--- FIDELITY CHECK ---");
console.log(`  row 300 present: ${r2.text.includes("person-300")}`);
console.log(`  rows recorded:   ${(r2.text.match(/"__rows":\s*(\d+)/) ?? [])[1]}`);

// 3. Content that must be DECLINED, because declining is a success.
show("3. PROSE — no repeated format (must decline)", "The quick brown fox. ".repeat(60), templates);
show("4. TINY INPUT — nothing to gain (must decline)", "one\ntwo\nthree\n", templates);
