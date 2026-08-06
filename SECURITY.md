# Security policy

## Reporting a vulnerability

Please report privately rather than in a public issue. Use GitHub's **Report a vulnerability** button under the Security
tab, which opens a private advisory.

Include the input that triggers it and what happens. A reproducing file is worth more than a description.

## Scope, and what to think about first

gistline has **no dependencies, makes no network calls, and runs no code from the content it reads.** That removes most
of the usual surface. What remains is worth naming precisely.

### Untrusted content is untrusted after conversion too

**gistline converts and compresses. It does not sanitise.**

If you extract text from a PDF, a scraped page, or a document from outside your organisation and hand it to a model,
whatever that document says arrives as content. That is not a defect in gistline — it is what feeding a document to a
model means — but it is worth stating rather than discovering.

PDF makes this sharper than the other formats. The format separates **rendering** from **extraction** by design: a font
can be constructed so that every glyph displays one character while its mapping returns a different string, and
`/ActualText` overrides what an extractor reports for a span without changing what is drawn. So extracted text can differ
from what a human sees on screen, invisibly.

gistline **flags the mechanism** when it is present — the notes report `/ActualText` overrides — but it cannot judge
intent, and the mechanism has legitimate accessibility uses. Treat extracted text from an untrusted source as untrusted
input.

### Resource exhaustion

A small file can declare an enormous one. These are bounded:

- **Archive decompression** is capped (64 MB by default) and a member that would exceed it is skipped with a reason,
  rather than expanding until memory runs out.
- **PDF streams** are capped per object.
- **Masking patterns** are anchored and free of nested quantifiers, so a pathological input cannot cause catastrophic
  backtracking. There is a test that feeds it 2,000 unterminated quotes and 5,000 digits and requires it to finish in
  under a second.
- **Character-map ranges** are bounded, so a font declaring a million-entry range cannot allocate unboundedly.

If you find an input that makes gistline hang or exhaust memory, that is a vulnerability and worth reporting.

### The local store

Originals are written to a local directory (`GISTLINE_STORE`, defaulting to a temporary directory) so that compressed
output can be reversed. That means **compressed content is on disk in full**.

- Entries are named by a content hash and pruned by age and count.
- Nothing is uploaded anywhere.
- If you compress secrets, they are in that directory until it is pruned. Set `GISTLINE_STORE` to a location with
  appropriate permissions, or delete it after use.

### What is deliberately absent

- **No telemetry, no analytics, no network calls.** There is nothing to opt out of.
- **No code execution.** gistline reads bytes and writes text. It does not evaluate content, run macros, or follow
  references out of a document.
- **No credential handling.** It has none to leak.

## Supported versions

The latest published minor version receives fixes. Older versions do not.

## Verifying what you installed

Every release is published from GitHub Actions using OIDC trusted publishing, with a provenance attestation linking the
package to the commit and workflow run that produced it:

```
npm audit signatures
```

No npm token exists in this repository or in CI, so there is no publishing credential to steal.
