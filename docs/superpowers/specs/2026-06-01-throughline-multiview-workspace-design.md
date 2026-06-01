# Throughline — Multi-View Workspace + Live Preview (Design Spec)

- **Status:** Draft (approved in brainstorming, pending written-spec review)
- **Date:** 2026-06-01
- **Builds on:** the merged MVP (living-spec engine + browser app). Reuses `Session`, `ScribeEngine`, `ClaudeCodeRunner`, `SpecStore`, SSE broadcaster, file watch.

---

## 1. Overview

Today the browser app is a fixed split: chat left, `spec.md` right. This feature turns the right side into a **summonable multi-view workspace**. By default the chat fills the screen; a top-right toolbar offers view types (📄 문서 · 🔀 유저 플로우 · 👁 라이브 프리뷰). Clicking one opens a resizable right pane showing that view. The headline addition is **라이브 프리뷰** — the user's own local dev server embedded in an iframe, so they can build their product and watch it run without leaving Throughline.

---

## 2. UX model (locked in brainstorming)

- **Default:** chat occupies the full screen.
- **Top-right view toolbar:** `📄 문서`, `🔀 유저 플로우`, `👁 라이브 프리뷰`.
- **Open:** clicking a view button opens the right pane (split) showing that view. **One view at a time** (tab-like). Clicking the active button again (or a close affordance) collapses back to full-screen chat.
- **Resizable:** the chat｜view boundary is drag-resizable; the ratio persists across reloads (localStorage).

---

## 3. The three views

### 📄 문서 (Document)
The existing living `spec.md` render (current `SpecPane`: markdown + "방금 N줄 갱신" flash). Moves into the new right-pane container unchanged.

### 🔀 유저 플로우 (User Flow)
An **AI-generated mermaid flowchart** of the product's user flow, derived from `spec.md`.
- **Generation timing (locked):** refresh **only while the view is open**. On open → generate once. While open, when `spec.md` updates (SSE `spec-updated`) → regenerate. While closed → no generation (no AI cost).
- Rendered client-side with `mermaid`.

### 👁 라이브 프리뷰 (Live Preview)
The user's local dev server, embedded directly.
- **Approach (locked):** **iframe-direct** to a user-entered URL (e.g. `http://localhost:3000`). HMR works because the iframed app talks to its own origin.
- URL bar (with reload) at the top of the view; the URL persists (localStorage).
- A reverse proxy (to defeat frame-blocking headers) is explicitly **deferred** to a later iteration; if an app blocks framing, we show a clear message.

---

## 4. Architecture

### Frontend (new/changed components)
- **`App.tsx`** — holds `activeView: null | 'doc' | 'flow' | 'preview'`, `splitWidth` (persisted), and a `specRevision` counter incremented on each SSE `spec-updated`. `null` → chat full; otherwise renders `ChatPane | ResizableDivider | RightPane`. Keeps the single SSE subscription (as today) and feeds `md`/`changedLines`/`specRevision` down.
- **`ViewToolbar.tsx`** — the top-right buttons; clicking toggles `activeView` (same button → `null`).
- **`ResizableDivider.tsx`** — drag handle that updates `splitWidth` (clamped, persisted to `throughline.splitWidth`).
- **`RightPane.tsx`** — renders one of `DocView` / `FlowView` / `PreviewView` by `activeView`.
- **`DocView`** — the existing `SpecPane` (used directly), receiving `md` + `changedLines`.
- **`FlowView.tsx`** — fetches `GET /api/flow`, renders the returned mermaid via `mermaid`. `useEffect([specRevision])` re-fetches (only mounts while active → implements "auto-refresh while open"). Loading spinner; on error, keep last diagram + a retry button; on mermaid parse failure, show the error + raw text.
- **`PreviewView.tsx`** — URL input (persisted `throughline.previewUrl`) + `<iframe src={url}>` + reload (remount via key). Empty/invalid URL → placeholder; note that frame-blocking apps won't display (proxy is a later step).
- Add `mermaid` dependency.

### Backend (new/changed)
- **`AgentRunner.complete(prompt, signal?)`** — a generic one-shot completion added to the interface, implemented by `ClaudeCodeRunner` (`collectAssistantText` + `stripCodeFence`) and `FakeAgentRunner` (scripted). `converse`/`scribe` are unchanged.
- **`src/domain/flow-prompt.ts` → `buildFlowPrompt(specMd)`** — instructs the agent to output **only** a mermaid `flowchart` of the user flow (no prose, no code fences).
- **`Session.generateFlow(signal?)`** — `readSpec()` → `runner.complete(buildFlowPrompt(spec))`.
- **`GET /api/flow`** — returns `{ mermaid }`; on failure returns `{ error }` with status 500 (client shows retry).

### Data flow (flow view)
User clicks 🔀 → `RightPane` mounts `FlowView` → `GET /api/flow` → mermaid render. While open, an SSE `spec-updated` bumps `specRevision` → `FlowView` re-fetches → re-render. Closing unmounts `FlowView` (no further calls).

---

## 5. Error handling

- **Preview:** empty/invalid URL → placeholder with guidance; the input is preserved. A frame-blocking app simply won't render inside the iframe — show a one-line note that embedding was blocked (proxy is a future step). No crash.
- **Flow generation:** failure/timeout from `complete` → `/api/flow` returns 500; `FlowView` keeps the last good diagram (if any) and shows a retry button.
- **Mermaid parse failure:** the model occasionally emits invalid mermaid → catch the render error, show a friendly message plus the raw text so nothing is lost.
- **Resize:** clamp `splitWidth` to sane min/max so a pane can't vanish.

---

## 6. Testing

- **Unit (TDD):** `buildFlowPrompt` (contains the mermaid-only instruction + the spec); `FakeAgentRunner.complete`.
- **Integration (TDD, fake runner):** `Session.generateFlow` returns the runner's completion for the current spec; `GET /api/flow` returns `{ mermaid }` (and `{ error }`/500 on a throwing runner).
- **Manual smoke:** toolbar toggling, resize + persistence, DocView unchanged, FlowView renders mermaid + auto-refresh while open, PreviewView iframes a real local dev server (e.g. a `vite`/`next dev` on another port) with working HMR.

---

## 7. Scope & build order

One spec. **Backend first** (`complete` → `flow-prompt` → `generateFlow` → `/api/flow`), then **frontend** (`ViewToolbar`, `ResizableDivider`, `RightPane`, `FlowView`, `PreviewView`, `App` wiring, styles). `DocView` reuses `SpecPane` as-is.

**Out of scope (deferred):** reverse-proxy preview (frame-blocking apps), multiple simultaneous views (grid), and the multi-agent coding loop (§8).

---

## 8. Why this is a deliberate stepping stone — the role-based multi-agent model

Throughline is not one big AI; it is **separate agents distinguished by role**, each a distinct session of the user's own Claude Code, coordinating through **files on disk as the single source of truth** (`spec.md`, and soon code). This is the "company without people" shape: no human glue between agents.

Already running today:
- **대화 에이전트 (`converse`)** — the foreground working conversation.
- **최신화 에이전트 (`scribe`)** — a background, debounced pass that keeps `spec.md` current.
- **(this feature) 플로우 에이전트** — keeps the user-flow diagram current while viewed.

The natural next phase (its own spec) is the **coding loop**:
- **코더 에이전트** — implements from `spec.md` (drives the user's Claude Code to write code).
- **싱크 에이전트 (최신화)** — watches code/conversation changes (via the `watch` we already built) and keeps `spec.md` / flow / docs current (reverse-sync).

These run **concurrently on one subscription** (coder = workhorse; sync = intermittent/debounced, cheap), coordinating through the filesystem. This multi-view + live-preview iteration is the deliberate substrate for it: the **preview** lets you watch the app the coder builds, while the **doc/flow** views stay live via the updater agents. The Build + Sync phases are tracked on the roadmap as the next dedicated spec → plan → implementation cycle.
