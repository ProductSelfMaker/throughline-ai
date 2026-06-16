// src/server/server.ts
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Locate the package root by walking up from this file until a package.json is found.
// Works in both layouts: dev (tsx runs src/server/server.ts) and the published bundle
// (node runs dist-server/server.mjs) — the built web UI always lives at <root>/dist.
function packageRoot(fromFile: string): string {
  let d = dirname(fromFile);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, 'package.json'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return dirname(dirname(fromFile)); // fallback: assume <root>/<dir>/<file>
}
import open from 'open';
import { SpecStore } from '../core/spec-store';
import { IngestStore } from '../core/ingest-store';
import { ClaudeCodeRunner } from '../agent/claude-code-runner';
import { SessionLogReader } from '../agent/session-log-reader';
import { Session } from './session';
import { WorkspaceManager } from './workspace-manager';
import { createApp } from './app';

// Absolute path to the built web UI (<package-root>/dist), resolved relative to THIS
// file — not the launch directory — so Throughline can be started from any project.
const distDir = join(packageRoot(fileURLToPath(import.meta.url)), 'dist');

// Target project directory: the first CLI arg if given, else the current dir.
const cwd = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
  console.error(`Throughline: '${cwd}' is not a directory.`);
  process.exit(1);
}

// First run only: migrate a legacy root spec.md into .throughline/prd.md so the workspace
// manager then moves it into ws/default. (Skipped once workspaces.json exists.)
const thrDir = join(cwd, '.throughline');
if (!existsSync(join(thrDir, 'workspaces.json'))) {
  const prdPath = join(thrDir, 'prd.md');
  const legacy = join(cwd, 'spec.md');
  if (!existsSync(prdPath) && existsSync(legacy)) {
    try { mkdirSync(thrDir, { recursive: true }); copyFileSync(legacy, prdPath); } catch { /* best-effort */ }
  }
}

// Run the scribe agent in a neutral dir (not the observed project) so its own
// Claude Code session logs don't land in the watched dir and feed back into the PRD.
const scribeDir = join(cwd, '.throughline', 'agent');
mkdirSync(scribeDir, { recursive: true });

// One shared session-log reader (the user's single terminal session), partitioned across
// workspaces by active periods. Each workspace gets its own artifacts + checkpoint.
const reader = new SessionLogReader({ cwd });
const sharedRunner = new ClaudeCodeRunner({ cwd: scribeDir }); // also used for cross-workspace merge
const manager = new WorkspaceManager({
  cwd,
  reader,
  runner: sharedRunner,
  makeSession: ({ artifactsDir, broadcaster }) => new Session({
    store: new SpecStore(join(artifactsDir, 'prd.md')),
    runner: sharedRunner,
    reader,
    selfReader: new SessionLogReader({ cwd: scribeDir }),
    ingest: new IngestStore(cwd, join(artifactsDir, 'ingest-state.json')),
    cwd,
    artifactsDir,
    broadcaster,
  }),
});
await manager.init();

const app = createApp(manager);

const hasUI = existsSync(distDir);
if (hasUI) {
  app.use('/*', serveStatic({ root: distDir }));
}

// Bind a free port so several projects can each run their own Throughline at once
// (different terminals → different ports). Bind-and-retry: the real listen is the
// test, so simultaneous launches never collide (no probe-then-bind race).
const desiredPort = Number(process.env.PORT ?? 5174);
const MAX_PORT_TRIES = 30;
function startServer(port: number, triesLeft: number): void {
  const server = serve({ fetch: app.fetch, port }, (info) => {
    const url = `http://127.0.0.1:${info.port}`;
    if (info.port !== desiredPort) console.log(`Throughline: port ${desiredPort} busy → using ${info.port}`);
    console.log(`Throughline → ${url}  (observing ${cwd})`);
    if (process.env.OPEN !== '0' && hasUI) void open(url);
  });
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      startServer(port + 1, triesLeft - 1);
    } else {
      console.error(`Throughline: failed to start — ${err.message}`);
      process.exit(1);
    }
  });
}
startServer(desiredPort, MAX_PORT_TRIES);

const shutdown = () => { manager.stop(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
