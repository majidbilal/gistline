// OCR, as an optional adapter.
//
// ONE RESPONSIBILITY: use Tesseract if it happens to be installed, and behave exactly as before if it is not.
//
// THE POLICY THIS IMPLEMENTS. gistline has zero dependencies and that is what makes it usable as a build gate. Reading a
// scanned page needs a model, which cannot be bundled without ending that guarantee. So the rule is: adopt the idea, never
// the code — an external tool may be an OPTIONAL adapter that never degrades behaviour when absent.
//
// WHAT "NEVER DEGRADES" MEANS CONCRETELY. With Tesseract absent, every code path here returns the same refusal gistline
// gave before this file existed. Nothing is installed, nothing is downloaded, no error is raised for its absence, and no
// message nags about it beyond naming it once as a possibility. There is a test asserting the refusal is unchanged.
//
// WHY IT IS SYNCHRONOUS. Every other path in gistline is, and the CLI is a filter. Introducing async here would ripple
// through `ingest` and five readers for one optional feature.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Cached, because probing the filesystem once per document is wasteful and the answer cannot change mid-run. */
let cachedProbe = null;

/**
 * Is Tesseract available?
 *
 * Probed by running it rather than by searching `PATH`, because a wrapper script, a shim, or a Windows `.cmd` on the path
 * all satisfy `--version` while defeating a filename search. The answer is what happens when we try, not what a directory
 * listing suggests.
 */
export function probeTesseract({ force = false } = {}) {
  if (cachedProbe && !force) return cachedProbe;

  const bin = process.env.GISTLINE_TESSERACT || "tesseract";

  try {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (r.error || r.status !== 0) {
      cachedProbe = { available: false, reason: r.error?.code === "ENOENT" ? "not on PATH" : `exited ${r.status}` };
    } else {
      const version = (String(r.stdout || r.stderr).match(/tesseract\s+v?([\d.]+)/i) ?? [])[1] ?? "unknown";
      cachedProbe = { available: true, bin, version, languages: probeLanguages(bin) };
    }
  } catch (e) {
    cachedProbe = { available: false, reason: e.message };
  }

  return cachedProbe;
}

/** Installed languages, so a caller asking for one gistline does not have gets told rather than getting empty output. */
function probeLanguages(bin) {
  try {
    const r = spawnSync(bin, ["--list-langs"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    return String(r.stdout || "").split(/\r?\n/).slice(1).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

/** Reset the cache. Exists for tests: a probe cached from a real machine would make them meaningless. */
export const resetProbe = () => { cachedProbe = null; };

/** Image formats Tesseract reads. A format outside this list is refused before a subprocess is spawned. */
const READABLE = { png: "png", jpg: "jpg", jpeg: "jpg", tif: "tif", tiff: "tif", bmp: "bmp", gif: "gif", webp: "webp" };

/** Detect the format from the bytes rather than a filename, because a filename is a claim. */
export function imageFormat(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? []);
  // A single blanket length check was wrong: it required 12 bytes for every format, so an 8-byte PNG signature — which is
  // complete and unambiguous — returned null. Each check now guards its own length, since they differ.
  if (b.length < 2) return null;
  if (b.length >= 8 && b.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (b.length >= 3 && b.subarray(0, 3).toString("hex") === "ffd8ff") return "jpg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (b.length >= 4 && b.subarray(0, 4).toString("latin1").startsWith("GIF8")) return "gif";
  if (b.subarray(0, 2).toString("latin1") === "BM") return "bmp";
  if (b.length >= 4) {
    const le = b.subarray(0, 4).toString("hex");
    if (le === "49492a00" || le === "4d4d002a") return "tif";
  }
  return null;
}

/**
 * Run OCR on an image.
 *
 * Returns `{ ok, text, ... }` rather than throwing, because absence of Tesseract is a normal condition and not an error —
 * an exception here would force every caller to wrap it, and the whole point is that behaviour is unchanged when it is
 * missing.
 *
 * A temporary file is used rather than stdin because Tesseract's stdin handling varies by build, and `-` is unreliable on
 * Windows. The file is removed in a `finally`, so a crash mid-recognition does not leave rubbish behind.
 */
export function ocrImage(buffer, { lang = null, timeoutMs = 120_000, maxBytes = 32 * 1024 * 1024 } = {}) {
  const probe = probeTesseract();
  if (!probe.available) {
    return { ok: false, available: false, reason: "Tesseract is not installed", text: "" };
  }

  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const format = imageFormat(buf);
  if (!format || !READABLE[format]) {
    return { ok: false, available: true, reason: `not an image format Tesseract reads${format ? ` (${format})` : ""}`, text: "" };
  }
  if (buf.length > maxBytes) {
    return { ok: false, available: true, reason: `image exceeds the ${Math.round(maxBytes / 1024 / 1024)}MB OCR limit`, text: "" };
  }

  // A requested language that is not installed produces empty output rather than an error, which looks like a blank page.
  if (lang && probe.languages.length && !lang.split("+").every((l) => probe.languages.includes(l))) {
    return {
      ok: false, available: true, text: "",
      reason: `language "${lang}" is not installed (available: ${probe.languages.join(", ") || "none reported"})`,
    };
  }

  const dir = mkdtempSync(join(tmpdir(), "gistline-ocr-"));
  const input = join(dir, `page.${READABLE[format]}`);

  try {
    writeFileSync(input, buf);

    // `stdout` as the output target keeps the result in memory. The trailing `-` is Tesseract's convention for it.
    const args = [input, "-", ...(lang ? ["-l", lang] : [])];
    const r = spawnSync(probe.bin, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });

    if (r.error) return { ok: false, available: true, reason: `Tesseract failed: ${r.error.message}`, text: "" };
    if (r.status !== 0) {
      return { ok: false, available: true, reason: `Tesseract exited ${r.status}: ${String(r.stderr || "").trim().slice(0, 200)}`, text: "" };
    }

    const text = String(r.stdout ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

    /**
     * Empty output is a FAILURE, not a success with no text.
     *
     * A blank result from a page that visibly contains writing means recognition did not work — wrong language, too low a
     * resolution, or an image Tesseract could not segment. Returning `ok: true` with an empty string would present that as
     * "this page has no text", which is exactly the confident-and-wrong answer to avoid.
     */
    if (!text) {
      return { ok: false, available: true, reason: "Tesseract produced no text; the image may be too low-resolution or in another language", text: "" };
    }

    return { ok: true, available: true, text, version: probe.version, chars: text.length };
  } catch (e) {
    return { ok: false, available: true, reason: `OCR failed: ${e.message}`, text: "" };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover temp dir is not worth failing over */ }
  }
}

/**
 * What to tell someone about a scanned document.
 *
 * Deliberately DIFFERENT depending on whether Tesseract is present, because the actionable next step differs:
 *
 *   absent   — name the tool, so they can decide to install it
 *   present  — say why it still did not work, which is a different problem
 *
 * And for a scanned PDF specifically, Tesseract alone is not enough: it reads images, not PDFs, so the pages must be
 * rasterised first. Naming the missing piece is more useful than a generic refusal, and pretending gistline can do it would
 * be worse than either.
 */
export function ocrAdvice({ isPdf = false } = {}) {
  const probe = probeTesseract();

  if (!probe.available) {
    return isPdf
      ? "It needs OCR. gistline will use Tesseract if it is installed, but a PDF must also be turned into images first "
        + "(pdftoppm from Poppler, or ImageMagick). Convert the pages to PNG and pass those, or use a dedicated OCR tool."
      : "It needs OCR. gistline will use Tesseract automatically if it is installed — it is not bundled, because that would "
        + "end the zero-dependency guarantee.";
  }

  return isPdf
    ? `Tesseract ${probe.version} is installed, but it reads images rather than PDFs. Turn the pages into images first `
      + "(pdftoppm from Poppler, or ImageMagick) and pass those."
    : `Tesseract ${probe.version} is installed but could not read this image.`;
}
