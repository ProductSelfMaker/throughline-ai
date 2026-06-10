# Unified merge (Phase 2a) — merge workspaces, resolve conflicts via chat

**Date:** 2026-06-10
**Branch:** `feat/unified-merge`

## Goal

Combine all workspaces' docs into one unified document. Triggered by a **Merge** button on
the **default** workspace (the "everything" workspace — fixed, can't be deleted). The LLM
produces a clean merged doc; where workspaces disagree it does NOT silently pick — it raises
**conflicts**, surfaced **in a chat** (not as in-doc callouts). The user answers each in the
chat; each answer is applied to the merged doc. Result: a clean consolidated doc.

Also (per the same request): **non-default workspaces can be deleted**.

## Design

### Prompts (`src/domain/merge-prompt.ts`, `resolve-prompt.ts` — new)

- `buildMergePrompt(docs: {name, md}[])` — merge into one coherent product doc (keep the
  English spine + language policy). For each genuine disagreement (same feature described
  differently / contradictions), do NOT pick — write a best-effort merged version AND list
  the disagreement as a conflict. Output: the doc, then `<!--CONFLICTS [{"id","question"}]-->`
  (a question to ask the user). `extractConflicts(raw)` → `{ md, conflicts }` (parse + strip).
- `buildResolvePrompt(currentMd, question, answer)` — apply the user's answer to the merged
  doc and return the updated full doc.

### WorkspaceManager

- Gains a shared `runner`. Storage (cross-workspace, at `.throughline/`): `unified.md`,
  `unified-conflicts.json`.
- `allWorkspaceDocs(): {name, md}[]` (read each workspace's store).
- `mergeAll()` — 0–1 workspace → that doc, no conflicts. Else: `extractConflicts(runner.complete(
  buildMergePrompt(docs)))`; persist; return `{ md, conflicts }`.
- `resolveConflict(id, answer)` — `buildResolvePrompt(unified.md, conflict.question, answer)`
  → write `unified.md`, drop that conflict; return `{ md, conflicts }`.
- `readUnified()` → `{ md, conflicts }`.
- `remove(id)` — refuse `default`; drop from registry, delete `ws/<id>/`, stop its session; if
  it was active → switch to `default`; return ok.

### API

- `POST /api/unified/merge` → `{ md, conflicts }`; `POST /api/unified/resolve {id, answer}` →
  `{ md, conflicts }`; `GET /api/unified` → `{ md, conflicts }`.
- `POST /api/workspaces/:id/delete` → `{ ok }` (400 for `default`).

### Client

- **Switcher**: a delete (×) affordance per non-default workspace → confirm → delete; if it was
  active the server switches to default (workspace-changed → remount).
- **Merge**: a **Merge** button shown only on the default workspace's doc view. Clicking opens a
  read-only **merge view**: the merged doc + a **merge chat** that presents conflicts one at a
  time (assistant question bubble + an answer input); answering posts `/resolve`, updates the
  doc + remaining conflicts. When 0 conflicts → "All conflicts resolved." Close returns to the
  doc. (One workspace → merged = that doc, no conflicts.)

## Testing

- `merge-prompt.test.ts`: merge prompt embeds all docs + conflict instruction + spine;
  `extractConflicts` parses/strips the CONFLICTS block (null/empty tolerant). `resolve-prompt`
  embeds doc + question + answer.
- `workspace-manager.test.ts`: `mergeAll` (1 ws → passthrough; 2 → merged + conflicts);
  `resolveConflict` drops the conflict + updates the doc; `remove` (refuses default; switches
  active to default).
- `app.test.ts`: `/api/unified/merge|resolve`, `/api/workspaces/:id/delete`.
- Browser: on default, Merge → merged doc + a conflict question in chat → answer → resolved →
  doc updates; delete a workspace.

## Out of scope

- Phase 1.5 touched-files-scoped Rebuild. Committing the unified doc back into a workspace.
