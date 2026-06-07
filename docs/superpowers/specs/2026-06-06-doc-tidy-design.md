# Document Tidy — reorganize the doc in place

**Date:** 2026-06-06
**Branch:** `feat/doc-tidy`

## Problem

The background scribe continuously appends new activity to the product doc, so over time it
sprawls: duplicated points, scattered per-feature content, suboptimal ordering. Rebuild
doesn't help — it re-derives from *code* (and can lose activity-captured nuance). The user
wants a one-click "tidy" — a refactor of the *current doc*: restructure without losing
information.

## Goal

A **Tidy** button next to Rebuild on the Document view that reorganizes the current doc in
place (merge duplicates, group per-feature content, reorder, tighten) while preserving every
fact, the English spine, and the language. Cheap: one LLM pass over the doc text — no code
scan, no map→reduce.

## Design

- **Prompt** `src/domain/tidy-prompt.ts` (new): `buildTidyPrompt(currentDoc)` — instruct a
  restructure-only pass (no add/remove/invent), keep the spine `## Overview` / `## Open
  Questions` and every feature section, preserve all Open Questions, follow the language
  policy (English spine, prose in the doc's language).
- **Server** `src/server/session.ts`: `tidyDoc()` — read the doc → `runner.complete(buildTidyPrompt)`
  → `applySpecUpdate` → broadcast `spec-updated` (the doc view live-updates via SSE). Throw
  on empty/failed output so the job reports `error` (previous doc preserved — nothing is
  written unless a valid doc comes back). `JobKind` gains `'tidy'`; `runJob` dispatches it.
- **Client**: `JobKind` includes `'tidy'`; `useJobs` toast maps + `doneCounts` gain `tidy`
  ("Document tidied" / "Document tidy failed"). MainView shows a **Tidy** button on the doc
  view (next to Rebuild) → `start('tidy')`, label "Tidying…" while running, no confirm modal
  (non-destructive: content is preserved). The doc refreshes via the existing `spec-updated`
  SSE — no refetch needed.

## Testing

- `tidy-prompt.test.ts`: the prompt demands restructure-only, keeps the spine, follows the
  language rule.
- `session.test.ts`: `startJob('tidy')` reorganizes the doc and broadcasts `spec-updated`;
  a failed tidy reports `error` and preserves the previous doc.
- Browser (headless): the Tidy button runs, toasts, and updates the doc; failure → honest
  "… failed" toast.

## Out of scope

- Tidy for decisions/architecture (doc-only for now).
- A confirm modal (tidy preserves content).
