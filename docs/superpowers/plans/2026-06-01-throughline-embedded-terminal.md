# Throughline — Embedded Interactive Terminal (SP-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the left pane's read-only mirror with a real interactive terminal (xterm.js ↔ WebSocket ↔ node-pty shell in cwd) so the user runs their own `claude`/shell inside Throughline; the sync agent keeps observing JSONL+git unchanged.

**Architecture:** A `TerminalSession` wraps a PTY (behind a `Pty` interface, so the buffer/protocol logic is unit-testable with a fake). A `/ws/terminal` WebSocket (`@hono/node-ws`) streams pty↔browser; `Terminal.tsx` (xterm.js) renders it. node-pty's prebuilt `spawn-helper` is made executable by a `postinstall` step.

**Tech Stack:** existing engine + `node-pty`, `@hono/node-ws`, `@xterm/xterm`, `@xterm/addon-fit`.

**Builds on:** `docs/superpowers/specs/2026-06-01-throughline-embedded-terminal-design.md`. Memory: `throughline-core-model`, `verify-dev-ui-in-browser`. node-pty feasibility on this machine is verified (works after `chmod +x` the spawn-helper).

---

## File Structure

```
scripts/fix-node-pty.mjs        # NEW: postinstall — chmod +x node-pty spawn-helper
src/server/
  terminal-session.ts           # NEW: Pty interface + TerminalSession (ring buffer, subscribe)
  terminal-session.test.ts      # NEW (fake Pty)
  node-pty-factory.ts           # NEW: spawnNodePty() real Pty (manual smoke)
  terminal-ws.ts                # NEW: handleTerminalMessage + setupTerminalWs(app, getTerminal)
  terminal-ws.test.ts           # NEW (handleTerminalMessage with fake)
  server.ts                     # MODIFY: wire terminal singleton + injectWebSocket
  session.ts                    # MODIFY (cleanup): drop transcript-updated broadcast + readTranscript
  app.ts                        # MODIFY (cleanup): remove /api/transcript
  app.test.ts                   # MODIFY (cleanup): drop transcript test
src/web/
  Terminal.tsx                  # NEW: xterm.js + WebSocket
  TranscriptView.tsx            # DELETE
  App.tsx                       # MODIFY: TranscriptView → Terminal
  api.ts                        # MODIFY (cleanup): remove fetchTranscript + onTranscript
  styles.css                    # MODIFY: .terminal-host
vite.config.ts                  # MODIFY: proxy /ws (ws:true) to backend
package.json                    # MODIFY: deps + postinstall
```

---

## Task 1: Deps + postinstall chmod for node-pty

**Files:** Create `scripts/fix-node-pty.mjs`; Modify `package.json`.

- [ ] **Step 1: Install deps**
```bash
npm install node-pty @hono/node-ws @xterm/xterm @xterm/addon-fit
```
If a version fails to resolve, install the latest of that package and note it.

- [ ] **Step 2: Create `scripts/fix-node-pty.mjs`**
```js
// Ensure node-pty's prebuilt spawn-helper is executable.
// npm sometimes drops the mode bit, causing `posix_spawnp failed` at runtime.
import { chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const base = join('node_modules', 'node-pty', 'prebuilds');
if (existsSync(base)) {
  for (const dir of readdirSync(base)) {
    const helper = join(base, dir, 'spawn-helper');
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
        console.log('fix-node-pty: chmod +x', helper);
      } catch (e) {
        console.warn('fix-node-pty: could not chmod', helper, String(e));
      }
    }
  }
}
```

- [ ] **Step 3: Add `postinstall` to `package.json` scripts** (alongside the existing scripts):
```json
"postinstall": "node scripts/fix-node-pty.mjs"
```

- [ ] **Step 4: Run it + verify**
```bash
node scripts/fix-node-pty.mjs
ls -l node_modules/node-pty/prebuilds/*/spawn-helper
```
Expected: the darwin spawn-helper(s) now show `-rwxr-xr-x`.

- [ ] **Step 5: Verify build still healthy** — `npx tsc --noEmit` (clean), `npm test` (still green, currently 42).

- [ ] **Step 6: Commit**
```bash
git add package.json package-lock.json scripts/fix-node-pty.mjs
git commit -m "chore: add node-pty/@hono/node-ws/xterm deps + spawn-helper postinstall"
```

---

## Task 2: TerminalSession (fake Pty, TDD)

**Files:** Create `src/server/terminal-session.ts`, `src/server/terminal-session.test.ts`.

- [ ] **Step 1: Write the failing test**
```ts
// src/server/terminal-session.test.ts
import { describe, it, expect } from 'vitest';
import { TerminalSession, type Pty } from './terminal-session';

class FakePty implements Pty {
  written: string[] = [];
  resized: Array<[number, number]> = [];
  killed = false;
  private dataCb?: (d: string) => void;
  private exitCb?: () => void;
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.resized.push([c, r]); }
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: () => void) { this.exitCb = cb; }
  kill() { this.killed = true; }
  emit(d: string) { this.dataCb?.(d); }   // test helper
  exit() { this.exitCb?.(); }              // test helper
}

describe('TerminalSession', () => {
  it('buffers output, caps the buffer, and snapshot() returns recent bytes', () => {
    const pty = new FakePty();
    const s = new TerminalSession(pty, 10); // cap=10 for the test
    pty.emit('abcdef');
    pty.emit('ghij');
    expect(s.snapshot()).toBe('abcdefghij');
    pty.emit('KLM'); // pushes over cap=10 → keep last 10
    expect(s.snapshot()).toBe('defghijKLM');
  });

  it('fans new data out to subscribers and stops after unsubscribe', () => {
    const pty = new FakePty();
    const s = new TerminalSession(pty);
    const got: string[] = [];
    const unsub = s.subscribe((d) => got.push(d));
    pty.emit('x');
    unsub();
    pty.emit('y');
    expect(got).toEqual(['x']);
  });

  it('forwards write/resize/kill to the pty and tracks exit', () => {
    const pty = new FakePty();
    const s = new TerminalSession(pty);
    s.write('ls\r');
    s.resize(100, 30);
    expect(pty.written).toEqual(['ls\r']);
    expect(pty.resized).toEqual([[100, 30]]);
    expect(s.isExited).toBe(false);
    pty.exit();
    expect(s.isExited).toBe(true);
    s.kill();
    expect(pty.killed).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm FAIL** — `npx vitest run src/server/terminal-session.test.ts`.

- [ ] **Step 3: Implement**
```ts
// src/server/terminal-session.ts
export interface Pty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: () => void): void;
  kill(): void;
}

const DEFAULT_CAP = 64 * 1024;

/** Wraps a PTY: keeps a bounded scrollback buffer and fans output to subscribers. */
export class TerminalSession {
  private buffer = '';
  private subscribers = new Set<(d: string) => void>();
  private exited = false;

  constructor(private pty: Pty, private cap = DEFAULT_CAP) {
    pty.onData((d) => {
      this.buffer = (this.buffer + d).slice(-this.cap);
      for (const s of this.subscribers) s(d);
    });
    pty.onExit(() => {
      this.exited = true;
    });
  }

  get isExited(): boolean { return this.exited; }
  snapshot(): string { return this.buffer; }

  subscribe(cb: (d: string) => void): () => void {
    this.subscribers.add(cb);
    return () => { this.subscribers.delete(cb); };
  }

  write(data: string): void { this.pty.write(data); }
  resize(cols: number, rows: number): void { this.pty.resize(cols, rows); }
  kill(): void { this.pty.kill(); }
}
```

- [ ] **Step 4: Run and confirm 3/3 PASS**; `npx tsc --noEmit` clean.

- [ ] **Step 5: Commit**
```bash
git add src/server/terminal-session.ts src/server/terminal-session.test.ts
git commit -m "feat: TerminalSession with bounded scrollback buffer"
```

---

## Task 3: Real node-pty factory + smoke

**Files:** Create `src/server/node-pty-factory.ts`. No vitest unit test (real PTY); manual smoke.

- [ ] **Step 1: Implement**
```ts
// src/server/node-pty-factory.ts
import * as pty from 'node-pty';
import type { Pty } from './terminal-session';

/** Spawn a real shell PTY in `cwd`, adapted to the Pty interface. */
export function spawnNodePty(opts: { cwd: string; shell?: string }): Pty {
  const proc = pty.spawn(opts.shell ?? process.env.SHELL ?? '/bin/zsh', [], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
  });
  return {
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    onData: (cb) => { proc.onData(cb); },
    onExit: (cb) => { proc.onExit(() => cb()); },
    kill: () => proc.kill(),
  };
}
```
> Verify the node-pty API (`pty.spawn(file, args, opts)`, `.onData`, `.onExit`, `.resize`, `.write`, `.kill`) against the installed `node-pty@1.x` types; adjust if names differ.

- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` clean.

- [ ] **Step 3: Real-PTY smoke (best-effort)** — run:
```bash
node -e "
const { spawnNodePty } = require('./src/server/node-pty-factory.ts');
" 2>/dev/null || npx tsx -e "
import { spawnNodePty } from './src/server/node-pty-factory';
const p = spawnNodePty({ cwd: process.cwd() });
let out=''; p.onData(d=>out+=d);
p.write('echo PTY_OK_\$((6*7))\r');
setTimeout(()=>{ console.log(out.includes('PTY_OK_42')?'SMOKE: WORKS':'SMOKE: no match'); p.kill(); process.exit(0); }, 1500);
"
```
Expected: `SMOKE: WORKS`. If it prints `posix_spawnp failed`, the postinstall chmod (Task 1) didn't run — re-run `node scripts/fix-node-pty.mjs`. If it fails only due to a sandboxed exec environment, note it as DONE_WITH_CONCERNS (it is verified to work on this machine outside the sandbox; the controller will confirm in the Task 7 browser smoke).

- [ ] **Step 4: Commit**
```bash
git add src/server/node-pty-factory.ts
git commit -m "feat: real node-pty factory"
```

---

## Task 4: /ws/terminal WebSocket + server wiring + dev proxy

**Files:** Create `src/server/terminal-ws.ts`, `src/server/terminal-ws.test.ts`; Modify `src/server/server.ts`, `vite.config.ts`.

- [ ] **Step 1: Write the failing test (message dispatcher)**
```ts
// src/server/terminal-ws.test.ts
import { describe, it, expect } from 'vitest';
import { handleTerminalMessage } from './terminal-ws';
import { TerminalSession, type Pty } from './terminal-session';

class FakePty implements Pty {
  written: string[] = []; resized: Array<[number, number]> = [];
  write(d: string){ this.written.push(d); } resize(c: number,r: number){ this.resized.push([c,r]); }
  onData(){} onExit(){} kill(){}
}

describe('handleTerminalMessage', () => {
  it('routes input to write and resize to resize; ignores junk', () => {
    const pty = new FakePty();
    const s = new TerminalSession(pty);
    handleTerminalMessage(s, JSON.stringify({ type: 'input', data: 'ls\r' }));
    handleTerminalMessage(s, JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    handleTerminalMessage(s, 'not json');
    handleTerminalMessage(s, JSON.stringify({ type: 'bogus' }));
    expect(pty.written).toEqual(['ls\r']);
    expect(pty.resized).toEqual([[120, 40]]);
  });
});
```

- [ ] **Step 2: Run and confirm FAIL** — `npx vitest run src/server/terminal-ws.test.ts`.

- [ ] **Step 3: Implement `src/server/terminal-ws.ts`**
```ts
// src/server/terminal-ws.ts
import type { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import { TerminalSession } from './terminal-session';

/** Parse a client message and dispatch to the session. Tolerates malformed input. */
export function handleTerminalMessage(session: TerminalSession, raw: string): void {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg?.type === 'input' && typeof msg.data === 'string') session.write(msg.data);
  else if (msg?.type === 'resize' && msg.cols > 0 && msg.rows > 0) session.resize(msg.cols, msg.rows);
}

/**
 * Register GET /ws/terminal on `app`. `getTerminal` lazily provides the singleton
 * TerminalSession. Returns the injectWebSocket fn to attach to the node server.
 */
export function setupTerminalWs(app: Hono, getTerminal: () => TerminalSession) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  app.get(
    '/ws/terminal',
    upgradeWebSocket(() => {
      const session = getTerminal();
      let unsub = () => {};
      return {
        onOpen(_evt, ws) {
          ws.send(JSON.stringify({ type: 'data', data: session.snapshot() }));
          unsub = session.subscribe((d) => ws.send(JSON.stringify({ type: 'data', data: d })));
        },
        onMessage(evt) {
          handleTerminalMessage(session, evt.data.toString());
        },
        onClose() {
          unsub();
        },
      };
    }),
  );

  return injectWebSocket;
}
```
> Verify `@hono/node-ws` API against the installed version: `createNodeWebSocket({ app })` → `{ injectWebSocket, upgradeWebSocket }`; `upgradeWebSocket(handlerFactory)` where the factory returns `{ onOpen(evt, ws), onMessage(evt, ws), onClose() }`; `ws.send(string)`; `evt.data` is string|Buffer. Adjust if the installed version differs.

- [ ] **Step 4: Run and confirm 1/1 PASS** — `npx vitest run src/server/terminal-ws.test.ts`; `npx tsc --noEmit` clean.

- [ ] **Step 5: Wire the server** — replace `src/server/server.ts` with:
```ts
// src/server/server.ts
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import open from 'open';
import { SpecStore } from '../core/spec-store';
import { ClaudeCodeRunner } from '../agent/claude-code-runner';
import { ActivityReader } from '../core/activity-reader';
import { Session } from './session';
import { createApp } from './app';
import { TerminalSession } from './terminal-session';
import { spawnNodePty } from './node-pty-factory';
import { setupTerminalWs } from './terminal-ws';

const cwd = process.cwd();
const specPath = join(cwd, 'spec.md');

const session = new Session({
  store: new SpecStore(specPath),
  runner: new ClaudeCodeRunner({ cwd }),
  reader: new ActivityReader(cwd),
  cwd,
});
session.start();

const app = createApp(session);

// Lazily spawn one terminal PTY shared across (re)connections.
let terminal: TerminalSession | null = null;
const getTerminal = () => (terminal ??= new TerminalSession(spawnNodePty({ cwd })));
const injectWebSocket = setupTerminalWs(app, getTerminal);

if (existsSync(join(cwd, 'dist'))) {
  app.use('/*', serveStatic({ root: './dist' }));
}

const port = Number(process.env.PORT ?? 5174);
const server = serve({ fetch: app.fetch, port }, (info) => {
  const url = `http://localhost:${info.port}`;
  console.log(`Throughline → ${url}  (watching ${cwd}, editing ${specPath})`);
  if (process.env.OPEN !== '0' && existsSync(join(cwd, 'dist'))) void open(url);
});
injectWebSocket(server);

const shutdown = () => {
  terminal?.kill();
  session.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

- [ ] **Step 6: Add the dev WebSocket proxy** — in `vite.config.ts`, change the `proxy` block to add `/ws` (keep `^/api/`):
```ts
  server: {
    port: 5173,
    proxy: {
      '^/api/': 'http://localhost:5174',
      '/ws': { target: 'http://localhost:5174', ws: true },
    },
  },
```

- [ ] **Step 7: Verify** — `npx tsc --noEmit` clean; `npm test` green; `npm run build:web` succeeds. (Do NOT start the real server here.)

- [ ] **Step 8: Commit**
```bash
git add src/server/terminal-ws.ts src/server/terminal-ws.test.ts src/server/server.ts vite.config.ts
git commit -m "feat: /ws/terminal websocket + server wiring + dev ws proxy"
```

---

## Task 5: Terminal.tsx (xterm) + App wiring

**Files:** Create `src/web/Terminal.tsx`; Modify `src/web/App.tsx`, `src/web/styles.css`. Acceptance: `tsc` + `build:web` clean.

- [ ] **Step 1: Create `src/web/Terminal.tsx`**
```tsx
// src/web/Terminal.tsx
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function Terminal() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({ convertEol: true, fontSize: 13, cursorBlink: true, theme: { background: '#0b0e14' } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal`);
    const send = (m: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };

    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'data') term.write(m.data);
    };
    ws.onopen = () => send({ type: 'resize', cols: term.cols, rows: term.rows });

    const onData = term.onData((d) => send({ type: 'input', data: d }));
    const onResize = () => { fit.fit(); send({ type: 'resize', cols: term.cols, rows: term.rows }); };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      onData.dispose();
      ws.close();
      term.dispose();
    };
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
```
> Verify `@xterm/xterm` exports `Terminal` and `@xterm/addon-fit` exports `FitAddon`, and the CSS path `@xterm/xterm/css/xterm.css`, against the installed versions.

- [ ] **Step 2: Wire into `src/web/App.tsx`** — replace the `TranscriptView` import and usage with `Terminal`:
  - Change `import { TranscriptView } from './TranscriptView';` → `import { Terminal } from './Terminal';`
  - Change `<TranscriptView />` → `<Terminal />`
  (Leave everything else in App.tsx unchanged.)

- [ ] **Step 3: Add terminal styles** — append to `src/web/styles.css`:
```css
.terminal-host { flex: 1; min-width: 0; height: 100%; background: #0b0e14; padding: 6px 8px; overflow: hidden; }
.terminal-host .xterm { height: 100%; }
```

- [ ] **Step 4: Verify** — `npx tsc --noEmit` clean; `npm run build:web` succeeds (mermaid chunk warning ok); `npm test` green.

- [ ] **Step 5: Commit**
```bash
git add src/web/Terminal.tsx src/web/App.tsx src/web/styles.css
git commit -m "feat: xterm.js Terminal replaces the read-only mirror"
```

---

## Task 6: Cleanup — remove the read-only transcript viewer

**Files:** Delete `src/web/TranscriptView.tsx`; Modify `src/server/session.ts`, `src/server/app.ts`, `src/server/app.test.ts`, `src/web/api.ts`.

- [ ] **Step 1: Remove the transcript route** — in `src/server/app.ts`, delete the entire `app.get('/api/transcript', ...)` block (keep `/api/events` and `/api/flow`).

- [ ] **Step 2: Update `src/server/app.test.ts`** — delete the `describe('GET /api/transcript', ...)` block entirely (keep the two `/api/flow` tests). Leave the imports/setup as-is (they're still used by the flow tests).

- [ ] **Step 3: Trim `src/server/session.ts`** — in the `start()` watcher trigger, stop broadcasting the transcript and stop reading it. Replace the `syncAndBroadcastTranscript` method and its call with a direct sync:
  - Change the trigger line `const trigger = () => this.debouncer.schedule(() => this.syncAndBroadcastTranscript());` → `const trigger = () => this.debouncer.schedule(() => this.engine.syncNow());`
  - Delete the `private async syncAndBroadcastTranscript()` method.
  - Delete the `readTranscript()` method and the now-unused `TranscriptEntry` import.

- [ ] **Step 4: Trim `src/web/api.ts`** — remove `fetchTranscript` and the `onTranscript` handling. Replace the file with:
```ts
// src/web/api.ts
export type SpecUpdate = { md: string; changedLines: number[] };

/** Subscribe to live spec updates over SSE. Returns an unsubscribe fn. */
export function subscribeSpec(onSpec: (u: SpecUpdate) => void): () => void {
  const es = new EventSource('/api/events');
  es.addEventListener('spec-updated', (e) => onSpec(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

/** Fetch a freshly generated mermaid user-flow for the current spec. */
export async function fetchFlow(): Promise<string> {
  const res = await fetch('/api/flow');
  const data = (await res.json()) as { mermaid?: string; error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `flow request failed (${res.status})`);
  return data.mermaid ?? '';
}
```

- [ ] **Step 5: Update `src/web/App.tsx`** — its SSE subscription used `subscribeEvents({ onSpec })`; change it to the simpler `subscribeSpec`:
  - `import { subscribeEvents } from './api';` → `import { subscribeSpec } from './api';`
  - Replace the `useEffect(() => subscribeEvents({ onSpec: (u) => {...} }), [])` with:
```tsx
  useEffect(
    () =>
      subscribeSpec((u) => {
        setMd(u.md);
        setChangedLines(u.changedLines);
        setSpecRevision((r) => r + 1);
      }),
    [],
  );
```

- [ ] **Step 6: Delete the old view** — `git rm src/web/TranscriptView.tsx`.

- [ ] **Step 7: Verify** — `npx tsc --noEmit` clean (confirm nothing references `TranscriptView`, `fetchTranscript`, `subscribeEvents`, `/api/transcript`, `readTranscript`); `npm test` green; `npm run build:web` succeeds.

- [ ] **Step 8: Commit**
```bash
git add -A
git commit -m "refactor: remove read-only transcript viewer (superseded by terminal)"
```

---

## Task 7: End-to-end browser smoke (controller-run)

> **Note for executor:** this step spawns a real PTY via the server, which the agent's Bash sandbox may block (`posix_spawnp`). The CONTROLLER runs this with the sandbox disabled. If you are a subagent and the PTY won't spawn, report DONE_WITH_CONCERNS with the gate results below; do not treat a sandbox-blocked PTY as a code failure.

- [ ] **Step 1: Automated gates** — `npm test` (all green), `npx tsc --noEmit` (clean), `npm run build:web` (succeeds).

- [ ] **Step 2: Browser smoke via Playwright (headless).** With `npm run dev` running (server :5174 + vite :5173), load `http://localhost:5173` and:
  - assert an `.xterm` element mounts (terminal rendered),
  - assert the `/ws/terminal` WebSocket reaches `OPEN`,
  - type `echo PTY_OK_42\n` into the terminal (`page.keyboard.type`) and assert `PTY_OK_42` appears in the terminal DOM within a few seconds (PTY round-trip works).
  Capture the result. (Playwright is already installed in node_modules via `--no-save`.)

- [ ] **Step 3: Confirm cleanup** — `rm -f spec.md`; `git status` clean; no stray server/vite processes.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- xterm ↔ WS ↔ node-pty, plain shell in cwd → Tasks 3,4,5 ✓
- node-pty spawn-helper exec bit via postinstall → Task 1 ✓ (feasibility-verified)
- PTY survives reload (snapshot replay, not killed on ws close) → `TerminalSession` snapshot + `onClose` only unsubscribes (Tasks 2,4) ✓
- Terminal replaces read-only mirror; sync unchanged → Task 5 + Task 6 (ActivityReader/SyncEngine untouched) ✓
- Remove TranscriptView/`/api/transcript`/`transcript-updated`/`fetchTranscript` → Task 6 ✓
- WebSocket transport via `@hono/node-ws` → Task 4 ✓
- Error handling: ring buffer cap, malformed-message tolerance, ws close keeps PTY → Tasks 2,4 ✓
- Testing: fake-Pty unit tests + real-PTY smoke + Playwright browser smoke → Tasks 2,3,4,7 ✓

**Placeholder scan:** none — complete code in every step.

**Type consistency:** `Pty` interface (Task 2) implemented by `spawnNodePty` (Task 3) and `FakePty` (tests); `TerminalSession(pty, cap?)` with `snapshot`/`subscribe`/`write`/`resize`/`kill`/`isExited` used in Tasks 4,5(server),7; `handleTerminalMessage(session, raw)` + `setupTerminalWs(app, getTerminal) → injectWebSocket` used in `server.ts` (Task 4); WS message shapes `{type:'data'|'input'|'resize', ...}` consistent between `terminal-ws.ts` and `Terminal.tsx`.

**Deferred (per spec §7):** multiple terminal tabs/splits; disk-persisted scrollback; multi-CLI niceties; autonomous-agent direction.
