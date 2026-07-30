// gistline retrieval store — makes the compression promise honest.
//
// gistline's note tells the caller "nothing was deleted; request the verbatim output if you need a
// dropped detail." Without somewhere to keep the original, that is a promise we cannot keep. This is
// that somewhere: a content-addressed store on disk, so a compressed result carries an id the caller
// can exchange for the full text — or for a slice of it.
//
// Deliberately boring: plain files, a content hash for the name, no index to corrupt, no daemon, no
// database. If the directory is deleted the worst case is a failed retrieval, never a corrupt run.
//
// Zero dependencies (node:crypto, node:fs, node:path, node:os only).

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const DEFAULT_STORE_DIR = process.env.GISTLINE_STORE ?? join(tmpdir(), "gistline-store");

/** Content hash → the id. Identical output is stored once, however many times it is compressed. */
export function idFor(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

/**
 * Open a store. Nothing is created until the first `put`, so constructing a store is free and safe
 * in a read-only context.
 *
 * @param {object} opts
 *  - dir          where to keep originals (default: OS temp / GISTLINE_STORE)
 *  - maxEntries   prune oldest beyond this count on put (default 500)
 *  - maxAgeMs     prune entries older than this on put (default 7 days)
 */
export function openStore({ dir = DEFAULT_STORE_DIR, maxEntries = 500, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const pathFor = (id) => join(dir, `${id}.txt`);

  const store = {
    dir,

    /** Store the original; returns its id. Idempotent for identical content. */
    put(text) {
      const body = String(text ?? "");
      const id = idFor(body);
      try {
        mkdirSync(dir, { recursive: true });
        if (!existsSync(pathFor(id))) writeFileSync(pathFor(id), body, "utf8");
        store.prune();
        return { id, chars: body.length, path: pathFor(id) };
      } catch (e) {
        // A store failure must never break the run: compression still succeeded, only retrieval is
        // unavailable. Report it rather than throwing into the caller's work.
        return { id: null, chars: body.length, path: null, error: e.message };
      }
    },

    /** Full original, or null if it is not (or no longer) held. */
    get(id) {
      if (!id || !/^[0-9a-f]{6,64}$/i.test(String(id))) return null;
      try { return existsSync(pathFor(id)) ? readFileSync(pathFor(id), "utf8") : null; } catch { return null; }
    },

    /**
     * A slice of the original — usually what a caller actually wants after seeing a compressed
     * summary ("show me around line 4,300"), and far cheaper than the whole thing.
     */
    slice(id, { fromLine = 1, lines = 200, chars = null } = {}) {
      const text = store.get(id);
      if (text == null) return null;
      if (chars != null) return text.slice(0, Math.max(0, chars));
      const all = text.split(/\r?\n/);
      const start = Math.max(0, fromLine - 1);
      return all.slice(start, start + Math.max(1, lines)).join("\n");
    },

    /** Search the original for a pattern, returning matching lines with their numbers. */
    grep(id, pattern, { max = 100 } = {}) {
      const text = store.get(id);
      if (text == null) return null;
      const rx = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), "i");
      const out = [];
      const all = text.split(/\r?\n/);
      for (let i = 0; i < all.length && out.length < max; i++) {
        if (rx.test(all[i])) out.push({ line: i + 1, text: all[i] });
      }
      return out;
    },

    has(id) { return store.get(id) !== null; },

    /** Drop old or excess entries. Best-effort: never throws. */
    prune() {
      try {
        if (!existsSync(dir)) return { removed: 0 };
        const now = Date.now();
        const entries = readdirSync(dir)
          .filter((f) => f.endsWith(".txt"))
          .map((f) => { const p = join(dir, f); return { p, mtime: statSync(p).mtimeMs }; })
          .sort((a, b) => b.mtime - a.mtime);

        let removed = 0;
        for (const [i, e] of entries.entries()) {
          if (i >= maxEntries || now - e.mtime > maxAgeMs) { rmSync(e.p, { force: true }); removed++; }
        }
        return { removed };
      } catch { return { removed: 0 }; }
    },

    /** Remove everything. Used by tests and by an explicit operator reset. */
    clear() {
      try { rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
    },

    stats() {
      try {
        if (!existsSync(dir)) return { entries: 0, chars: 0 };
        const files = readdirSync(dir).filter((f) => f.endsWith(".txt"));
        const chars = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
        return { entries: files.length, chars };
      } catch { return { entries: 0, chars: 0 }; }
    },
  };

  return store;
}
