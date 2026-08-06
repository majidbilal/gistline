// The transform pipeline.
//
// ONE RESPONSIBILITY: decide what runs, in what order, and when to stop. It transforms nothing itself.
//
// WHY THIS EXISTS. The previous shape was one strategy per kind, single shot:
//
//     const strategy = STRATEGIES[detected] ?? compressLog;
//     let body = strategy(raw, effective);
//     if (body.length > effective) body = headTail(body, effective);
//
// Five problems, three of which the next feature would have introduced:
//
//  1. Lossless-first had nowhere to live, so it would have been re-implemented inside every strategy.
//  2. The same parse and serialisation happened twice when two transforms both handled JSON.
//  3. Transforms could not compose, and templates need composition: template losslessly, THEN drop rows if still over.
//  4. `headTail` was applied blindly to any output, cutting a table's rows in half — output that looks structured and
//     is silently incomplete. That is a live bug today, not a hypothetical one.
//  5. The note could not distinguish "tabulated losslessly, nothing removed" from "dropped 1,400 lines".
//
// THE ORDERING IS THE ARCHITECTURE. Lossless transforms run before lossy ones because of where they sit in the list,
// not because each one remembers a rule. A transform cannot get lossless-first wrong, because it never decides.

/** A transform declares this shape. Nine implementations, one contract. */
export const TRANSFORM_SHAPE = Object.freeze({
  id: "string",
  lossless: "boolean",
  truncatable: "boolean",   // may a last-resort truncation cut this output?
  applies: "function",      // cheap predicate. No work.
  run: "function",          // returns { text, applied, reason }
});

/** Reject a malformed transform at registration rather than mid-run. */
export function validateTransform(t) {
  const missing = Object.keys(TRANSFORM_SHAPE).filter((k) => {
    const want = TRANSFORM_SHAPE[k];
    return want === "function" ? typeof t?.[k] !== "function" : typeof t?.[k] !== want;
  });
  if (missing.length) throw new Error(`transform "${t?.id ?? "?"}" is missing or mistyped: ${missing.join(", ")}`);
  return t;
}

/**
 * Run the pipeline.
 *
 * Returns the text plus a record of what ran, so the caller can report honestly rather than guessing.
 *
 * THE STOP CONDITION IS THE EFFICIENCY WIN. Previously every strategy ran to completion regardless of whether the
 * budget was already met. Here, a run that fits after the cheapest lossless transform never pays for the expensive
 * ones — and because lossless transforms are ordered cheapest-first, that is the common case rather than the lucky one.
 */
export function runPipeline(ctx, transforms) {
  let text = ctx.raw;
  let truncatable = true;

  for (const t of transforms) {
    // Already within budget: stop. Nothing after this can improve on "fits and is untouched".
    if (text.length <= ctx.budget) break;

    // The view a transform sees. `truncatable` MUST be on it: a transform that refuses to have its output cut can only
    // be respected if later transforms can see the refusal.
    //
    // A revisit caught this. The pipeline tracked `truncatable` in a local and returned it, but never passed it down —
    // so `head-tail.applies()` read `ctx.truncatable` as `undefined`, `!== false` was true, and it cut a JSON document
    // that had explicitly forbidden cutting. The protection existed and did nothing.
    const view = { ...ctx, text, truncatable };

    // A cheap predicate first, so a transform that cannot help costs a boolean rather than a pass over the text.
    let ok;
    try { ok = t.applies(view); }
    catch (e) {
      ctx.applied.push({ id: t.id, applied: false, reason: `applies() threw: ${e.message}` });
      continue;
    }
    if (!ok) continue;

    let result;
    try { result = t.run(view); }
    catch (e) {
      // A failing transform must not fail the call. Recorded and skipped: a compressor that throws on unusual input is
      // worse than one that declines, because the caller loses the output entirely.
      ctx.applied.push({ id: t.id, applied: false, reason: `run() threw: ${e.message}` });
      continue;
    }

    const before = text.length;
    if (result?.applied && typeof result.text === "string" && result.text.length < before) {
      text = result.text;
      // Once a transform declares its output must not be cut, that sticks for the rest of the run.
      if (t.truncatable === false) truncatable = false;
      ctx.applied.push({
        id: t.id,
        applied: true,
        lossless: t.lossless,
        reason: result.reason ?? null,
        before,
        after: text.length,
      });
    } else {
      ctx.applied.push({ id: t.id, applied: false, reason: result?.reason ?? "declined" });
    }
  }

  return { text, truncatable, applied: ctx.applied };
}

/** Did anything lossy run? The one question a reader most needs answered. */
export const wasLossy = (applied) => applied.some((a) => a.applied && a.lossless === false);

/** The ids that actually changed the text, in order. */
export const appliedIds = (applied) => applied.filter((a) => a.applied).map((a) => a.id);
