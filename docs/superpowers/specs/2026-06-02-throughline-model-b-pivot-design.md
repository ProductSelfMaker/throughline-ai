# Throughline — Model B Pivot (Observer Companion) Design Spec

- **Status:** Draft (approved in brainstorming)
- **Date:** 2026-06-02
- **Supersedes:** the chat-centric model (SP-C/SP-D). Reverts toward Throughline's original vision: observe the user's real agent, auto-document.

---

## 1. Overview

Throughline stops hosting its own coding chat. The user keeps working in **their own terminal with their own Claude Code**; Throughline runs alongside as an **observer** that reads the agent's session logs (+ `git diff`) and maintains a **living, accumulating PRD** per project, plus a preview. A lightweight **scribe-chat** lets the user steer the document (curation), not write code.

Positioning: not a workspace/orchestrator (cmux, paperclip) — a *"keep using your tools; we keep your intent documented"* companion.

## 2. The model (B)

- **No in-app coding chat.** The coding conversation lives in the user's terminal and is **not displayed** in Throughline. (A read-only activity mirror is explicitly deferred — see §9.)
- **Source of truth = the accumulated PRD**, persisted in the project. Session logs are an *input signal*, not the artifact.
- **Accumulation across months.** A product is built over many Claude Code sessions (opened/closed repeatedly). Throughline folds each new bit of activity into the persisted PRD; restarting in the project restores everything prior.

## 3. Persistence (in `<project>/.throughline/`)

- **`prd.md`** — the accumulating PRD (the doc the views render). Loaded on startup; created from `DEFAULT_SPEC` if absent.
- **`ingest-state.json`** — the ingestion checkpoint. Tracks, per session file, how far it has been processed:
  ```json
  { "version": 1, "sessions": { "<sessionId>.jsonl": { "bytes": 48213 } } }
  ```
  Byte offsets into the append-only JSONL. New files start at 0; processed files resume from their offset.
- (The old `<cwd>/spec.md` and `<cwd>/.throughline/conversation.jsonl` are retired — see §10 Migration.)

## 4. Architecture

### 4.1 `SessionLogReader` (new, `src/agent/` or `src/core/`)
Behind an interface (`ActivityReader`) so the log format stays isolated (Claude Code first; other agents later).

- **Locate** the project's session dir: encode `cwd` the way Claude Code does (`/Users/x/proj` → `-Users-x-proj`) → `~/.claude/projects/<encoded>/`.
- **Select**: all `*.jsonl` in that dir **except** subagent logs (`agent-*.jsonl`). Not "latest only" — every session contributes; the checkpoint decides what's new.
- **Read new activity**: for each session file, read from its checkpoint byte offset to EOF, parse JSONL lines, and extract a transcript excerpt:
  - lines carrying a `message.role` of `user`/`assistant` → text content;
  - assistant `tool_use` blocks → `{ name, target }` tool events.
  - Malformed/partial trailing lines are skipped (don't advance the offset past a half-written line).
- **Watch**: chokidar on the session dir (`add`/`change`) → schedule an ingest (debounced). On startup, a catch-up pass processes every file whose size exceeds its stored offset.
- Returns `{ excerpt: string, toolEvents: Tool[], advanced: Record<file, bytes> }` for a batch.

### 4.2 Ingestion + sync engine (`Session`, reusing the existing sync)
- On startup: load `prd.md` (or `DEFAULT_SPEC`), load `ingest-state.json`, run a catch-up ingest.
- On new activity (debounced ~8s, existing `Debouncer`):
  1. reader produces the new-activity excerpt + tool events since checkpoint;
  2. `gitDiff(cwd)` (existing helper);
  3. `buildSyncPrompt(currentPRD, excerpt, diff)` → `runner.complete()` → updated PRD;
  4. `applySpecUpdate` (self-heal spine, feature ids, diff) writes `.throughline/prd.md`;
  5. advance `ingest-state.json` to the new offsets (only after a successful write);
  6. broadcast `spec-updated` over SSE.
- The PRD is incremental: the scribe is always given the existing accumulated PRD + only the *new* activity, so months of content persist and grow.

### 4.3 `ScribeChat` (B2) — `/api/curate`
- `POST /api/curate { instruction }` → `session.curate(instruction)`:
  - run a scribe pass over `currentPRD + recent activity + diff + instruction` → updated PRD → `applySpecUpdate` → SSE.
  - A `buildCuratePrompt` (or `buildSyncPrompt` extended with an optional instruction) carries the user's command (e.g. "리스크 섹션 추가", "이 요구사항 틀렸어").
- This chat commands the **scribe**, never a coding agent. No file edits, no `converse`.

### 4.4 Removed / changed
- **Remove:** `POST /api/chat`, `GET /api/transcript`, `ChatPane.tsx`, `runner.converse`, `ConversationStore` (Throughline's own conversation log). `FakeAgentRunner.converse` / chat-event types drop with them.
- **Keep:** `runner.complete` (scribe/sync), `Broadcaster`/SSE, `SpecStore` (retargeted to `.throughline/prd.md`), `Debouncer`, spec engine (PRD spine, self-heal, feature ids), `/api/flow` (still available; flow view deferred), preview.

## 5. Frontend (layout flip — structure only; visuals via Claude Design later)

```
[Sidebar (minimal: project + which session is being watched)] │ [PRD doc — primary] │ [Rail 문서/플로우/프리뷰]
                                                                  └ slim scribe-chat docked at the bottom (curation)
```
- The **PRD doc is the primary surface** (center, large), default view; "자동 동기화됨" pulse reflects live SSE updates.
- **Rail** keeps 문서 / 플로우 / 프리뷰; 문서 is default. 플로우 stays empty (deferred); 프리뷰 is the browser-style iframe (unchanged).
- **Scribe-chat**: a slim composer docked under the doc — sends curation instructions to `/api/curate`. (No coding chat anywhere.)
- The `.tl` cards/light design system from SP-D is reused; the chat-centric arrangement is replaced by this doc-centric one. Pixel-level layout is refined in Claude Design as a follow-up.

## 6. Data flow

**Startup:** resolve cwd → session dir; load `prd.md` + checkpoint; catch-up ingest (offsets < size) → maybe one sync; serve UI; SSE pushes current PRD.

**Live:** user works in their terminal → Claude Code appends to its session `*.jsonl` → chokidar fires → debounced ingest → scribe → `prd.md` updated + checkpoint advanced → SSE → doc view updates.

**Curation:** user types an instruction in the scribe-chat → `/api/curate` → immediate scribe pass → `prd.md` updated → SSE.

## 7. Error handling

- **No session dir / no sessions yet:** show the PRD (DEFAULT_SPEC skeleton); reader is idle until files appear.
- **Malformed JSONL line:** skip it; never advance the checkpoint past an incomplete trailing line (so the next read re-attempts it once complete).
- **No new activity:** no sync (don't rewrite the PRD).
- **Scribe failure / empty output:** best-effort — keep the last good `prd.md`, don't advance the checkpoint (so the activity is retried). (`applySpecUpdate` already rejects empty output.)
- **Checkpoint missing/corrupt:** treat as fresh (offsets 0) and re-ingest; the scribe merges idempotently into the existing PRD (no duplication of already-captured content is the goal — accept mild redundancy over data loss).
- **Preview / resize:** unchanged from current.

## 8. Testing

- **`SessionLogReader` unit tests** (fixture JSONL): session-dir resolution from cwd; `agent-*` exclusion; offset-based incremental read; transcript + tool extraction; malformed-line skip; checkpoint advance/resume across a "restart".
- **Ingestion/accumulation test:** two batches across a simulated restart accumulate into the PRD without reprocessing.
- **`/api/curate` route test** (FakeAgentRunner): instruction → PRD updated + `spec-updated` broadcast.
- **Existing suite** updated for removed chat endpoints (`/api/chat`, `/api/transcript`) and the `.throughline/prd.md` location.
- `tsc --noEmit` clean; `npm run build:web` clean; headless browser smoke (doc renders the live PRD, rail toggles, scribe-chat posts, 0 console errors — per `verify-dev-ui-in-browser`).

## 9. Scope & deferred

**In:** the pivot — SessionLogReader + incremental accumulation into `.throughline/prd.md` with a checkpoint; scribe-chat (`/api/curate`); removal of the coding chat; doc-centric layout (structural).

**Deferred:** a read-only activity/transcript mirror ("진행 상황 슬쩍 보기"); 플로우 (mermaid) view; non-Claude-Code log adapters; pixel-level visual polish (Claude Design handoff); committing the PRD to git / mirroring to a root `spec.md`.

## 10. Migration

- PRD moves from `<cwd>/spec.md` → `<cwd>/.throughline/prd.md` (`SpecStore` path change). On first run, if a legacy `spec.md` exists and `.throughline/prd.md` does not, seed the latter from it.
- `<cwd>/.throughline/conversation.jsonl` (the old Throughline chat log) is no longer written or read.
