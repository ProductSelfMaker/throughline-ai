# Product-doc source grounding + freshness

**Date:** 2026-06-10
**Branch:** `feat/product-doc-grounding`

## Problem

Source grounding + freshness now make the Architecture doc verifiable. The product doc — the
flagship artifact — still has neither. Extend the same mechanism so each product-doc section
cites the real files it came from, and stale sections are flagged.

The complication: unlike the rebuild-only Architecture doc, the product doc is **continuously
updated** by the background scribe (`buildSyncPrompt`) and by `curate`/`tidy`. So citations
are produced only by the deep Rebuild and must be **preserved** through the continuous edits;
freshness is measured **against the last full Rebuild** (per user decision).

## Design (reuse the Architecture mechanism)

### Grounding — the deep Rebuild path (`product-doc-prompt.ts`)

- `buildCodeMapPrompt(label, code, files)` — gains the chunk file list + `[src: <path>]` tags.
- `buildReduceMergePrompt` — preserves/unions `[src: …]` tags.
- `buildProductDocPrompt(summary, ctx)` — per-`##`-section `**Sources:** \`a.ts\`` line citing
  only `ctx.files` (real paths). `DocContext` gains `files?: string[]`.
- `session.buildDocFromCode`: pass `chunk.files` to the map, the real path set to the doc
  prompt, and `validateCitations(doc, realPaths)` on the result.

### Preserve citations through continuous edits

`buildSyncPrompt`, `buildCuratePrompt`, `buildTidyPrompt` gain one rule: **preserve any
existing `**Sources:**` lines verbatim; do not invent new ones** (they have no full code
scan). So Rebuild-produced citations survive incremental updates.

### Freshness — measured against the last Rebuild

- `rebuild()` writes `.throughline/prd-meta.json` = `{ commit, builtAt }` (current HEAD).
- A shared private `freshness(metaPath, docMd)` helper (generalized from
  `architectureFreshness`) returns `{ commit, stale } | null` via
  `gitChangedSince(commit)` + `staleSections`. `docFreshness()` and `architectureFreshness()`
  both call it.
- `GET /api/doc-freshness` → `{ commit, stale } | null`; `fetchDocFreshness()`.
- MainView doc view: the same `.tl-stale-banner`, worded to convey the citations are *as of
  the last Rebuild* (prose stays current via sync): "⚠ Citations as of `abc123` — N
  section(s)' cited code changed since: X, Y. Rebuild to refresh grounding." Fetched on doc
  view open and after a doc Rebuild (doneCounts.doc).

### Cleanup

Rename `ArchFreshness` → `Freshness` (now shared by doc + architecture).

## Testing

- `product-doc-prompt.test.ts`: map lists files + `[src:`; doc prompt asks for `**Sources:**`
  citing only the provided files.
- `sync-prompt.test.ts` / `curate-prompt.test.ts` / `tidy-prompt.test.ts`: each instructs
  preserving existing `**Sources:**` lines.
- `session.test.ts`: a doc Rebuild validates citations (real kept, hallucinated dropped) and
  writes prd-meta; `docFreshness()` flags a section whose cited file changed; null before any
  Rebuild.
- `app.test.ts`: `GET /api/doc-freshness` returns `{...}` / null.
- Browser (headless): after a doc Rebuild, a changed cited file surfaces the doc banner.

## Out of scope / phase 2

- Click-to-open citations; **git-history mode** (next task, #2).
