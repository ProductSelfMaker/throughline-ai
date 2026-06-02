# Throughline — Grok-style Layout Redesign (SP-D) Design Spec

- **Status:** Draft (approved in brainstorming)
- **Date:** 2026-06-02
- **Scope:** Frontend only. Backend (chat, conversation persistence, spec sync, /api/*) is unchanged. Reference: Grok web UI (left sidebar / centered minimal chat / clean white-rounded tone).

---

## 1. Overview

Restyle the app into a Grok-style 3-zone layout: an (empty-for-now) left **Sidebar**, a centered minimal **chat** in the middle, and a far-right vertical **icon rail** (📄 문서 / 🔀 플로우 / 👁 프리뷰) that opens a view panel to its left. The right views adopt the same Grok tone. For this pass, **문서 and 플로우 are empty placeholders**, and **프리뷰 is just a URL input + iframe** (the current preview's extra buttons are removed). White, rounded, generous whitespace, grayscale.

---

## 2. Layout

```
Open:   [Sidebar 240px] │ [Chat (center, shrinks)] │ ⋮resize │ [View panel] │ [Rail 52px]
Closed: [Sidebar 240px] │ [Chat (centered hero)]                            │ [Rail 52px]
```
- Clicking a rail icon opens the view panel to the **left of the rail**; the center chat shrinks. Clicking the active icon closes it (back to full-width centered chat). The chat｜view boundary is drag-resizable (ratio persisted in `localStorage`, as today).

---

## 3. Components

- **`Sidebar.tsx` (new):** Grok-style shell — top: `⌀ Throughline` wordmark; body: **empty** (no conversation list / spaces yet — placeholder for future). Light-grey background, ~240px, subtle right border. No bottom chrome for now.
- **`ChatPane.tsx` (restyle):** Grok-like centered chat.
  - **Empty state (no messages):** vertically/horizontally centered — a mark/logo + heading (e.g. "오늘 무엇을 만들까요?") + a large rounded input (the hero composer).
  - **With messages:** a centered max-width (~720px) column of turns (existing grayscale user box / `✦ CLAUDE` markdown + tool chips / streaming) with the large rounded composer pinned at the bottom-center.
  - Replaces the current small composer with a single Grok-style big rounded input (submit on Enter / send button). Chat content/streaming logic unchanged.
- **`ViewRail.tsx` (new, replaces `ViewToolbar.tsx`):** a far-right vertical rail (~52px) with stacked icon buttons (📄 / 🔀 / 👁); active one highlighted; click toggles `activeView`. Replaces the old top-right horizontal toolbar.
- **`RightPane.tsx` (modify):** renders, in Grok tone, a header + body per active view:
  - `doc` → **empty placeholder** (e.g. "문서가 여기에 표시됩니다" muted text). *(Does NOT import `SpecPane`.)*
  - `flow` → **empty placeholder** (e.g. "유저 플로우가 여기에 표시됩니다"). *(Does NOT import `FlowView`.)*
  - `preview` → the simplified `PreviewView`.
- **`PreviewView.tsx` (simplify):** **just a URL input + the iframe.** A single text input (placeholder `http://localhost:3000`); on Enter, the iframe loads that URL. Remove the separate "열기"/reload buttons (the redundant in-preview button the user noted). Empty/blank URL → muted placeholder.
- **`App.tsx` (rewrite layout):** the 4-zone fl: `Sidebar` | `ChatPane` | (`ResizableDivider` + view panel `RightPane` when open) | `ViewRail`. Keeps the SSE subscription + split-width persistence.
- **`styles.css` (rewrite for tone):** Grok manner — white surfaces, rounded corners (cards/inputs), light-grey sidebar (`#f7f7f8`-ish), thin neutral borders, generous padding, grayscale only.

**Kept but now unused (dormant, for later re-wiring of live content):** `SpecPane.tsx`, `FlowView.tsx`. Because `RightPane` no longer imports `FlowView`, **`mermaid` drops out of the bundle** → the JS bundle shrinks back to ~350 KB (a nice side effect; the dep stays in package.json for when flow is re-wired).

---

## 4. Data flow / behavior

Unchanged backend: chat → `/api/chat` (streamed) → ChatPane; spec sync runs in the background as before (just not rendered while 문서 is a placeholder); `/api/transcript` still restores history. The rail only toggles which (mostly-placeholder) view shows.

---

## 5. Error handling
- Preview: empty URL → muted placeholder; a frame-blocking site simply won't render (unchanged limitation). No crash.
- Resize: clamp split 20–80%.
- Chat: unchanged (error bubble on failure from SP-C).

---

## 6. Testing
- `npx tsc --noEmit` clean; `npm run build:web` clean (and confirm the bundle shrank now that mermaid isn't reachable).
- Browser smoke (Playwright, headless): the 3 zones render (sidebar, centered chat hero, rail); clicking a rail icon opens the view panel (placeholder for doc/flow; URL input for preview) and closing returns to centered chat; sending a message still streams a bubble. (Per memory `verify-dev-ui-in-browser` — actually load it.)

---

## 7. Scope & deferred
**In:** the layout + tone redesign (Sidebar, ViewRail, Grok chat restyle, placeholder doc/flow, simplified preview), styles.
**Deferred:** re-wiring the live spec into 문서 and mermaid into 플로우 under the new tone; sidebar content (conversation list); preview reverse-proxy; per-line highlight; slogan; autonomous direction.
