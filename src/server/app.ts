// src/server/app.ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { homedir } from 'node:os';
import { Session, isJobKind } from './session';
import type { Broadcaster } from './broadcaster';
import type { WorkspaceInfo, Unified } from './workspace-manager';

/** What the HTTP layer needs: the active workspace's Session + workspace management. */
export interface AppHost {
  active(): Session;
  broadcaster: Broadcaster;
  list(): WorkspaceInfo[];
  activeInfo(): WorkspaceInfo;
  create(name: string): Promise<WorkspaceInfo>;
  select(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  mergeAll(): Promise<Unified>;
  resolveConflict(id: string, answer: string): Promise<Unified>;
  readUnified(): Promise<Unified>;
}

export function createApp(host: AppHost): Hono {
  const app = new Hono();
  const s = () => host.active(); // resolve the active workspace's session per request

  // which project this instance observes (shown in the top row)
  app.get('/api/info', (c) => {
    const cwd = s().projectDir();
    const home = homedir();
    const display = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    return c.json({ cwd, display });
  });

  // workspaces: list / create / select. Selecting routes future activity to that workspace and
  // re-emits its state over SSE.
  app.get('/api/workspaces', (c) => c.json({ active: host.activeInfo().id, workspaces: host.list() }));
  app.post('/api/workspaces', async (c) => {
    const body = await c.req.json<{ name?: string }>().catch(() => ({} as { name?: string }));
    return c.json(await host.create((body.name ?? '').trim()));
  });
  app.post('/api/workspaces/:id/select', async (c) => {
    const ok = await host.select(c.req.param('id'));
    return ok ? c.json({ ok: true, active: host.activeInfo() }) : c.json({ error: 'unknown or already active' }, 400);
  });
  app.post('/api/workspaces/:id/delete', async (c) => {
    const ok = await host.remove(c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'cannot delete (default or unknown)' }, 400);
  });

  // unified merge of all workspaces + chat conflict resolution (default workspace only)
  app.get('/api/unified', async (c) => c.json(await host.readUnified()));
  app.post('/api/unified/merge', async (c) => c.json(await host.mergeAll()));
  app.post('/api/unified/resolve', async (c) => {
    const body = await c.req.json<{ id?: string; answer?: string }>().catch(() => ({} as { id?: string; answer?: string }));
    if (!body.id || !(body.answer ?? '').trim()) return c.json({ error: 'id and answer required' }, 400);
    return c.json(await host.resolveConflict(body.id, body.answer!.trim()));
  });

  app.post('/api/curate', async (c) => {
    const body = await c.req.json<{ instruction?: string }>();
    const instruction = (body.instruction ?? '').trim();
    if (!instruction) return c.json({ error: 'empty instruction' }, 400);
    await s().curate(instruction);
    return c.json({ ok: true });
  });

  // Start a per-page rebuild (doc | decisions | mockup | architecture | tidy) as a background
  // job — runs detached; progress arrives via the 'job-updated' SSE event.
  app.post('/api/jobs/:kind', (c) => {
    const kind = c.req.param('kind');
    if (!isJobKind(kind)) return c.json({ error: 'unknown job kind' }, 400);
    const started = s().startJob(kind);
    return c.json({ started, running: s().runningJobs() });
  });

  // developer-facing architecture overview + freshness (which sections' cited files changed)
  app.get('/api/architecture', async (c) =>
    c.json({ md: await s().readArchitecture(), freshness: await s().architectureFreshness() }));

  // product-doc freshness (the doc itself streams via /api/events)
  app.get('/api/doc-freshness', async (c) => c.json(await s().docFreshness()));

  // project = your coding usage; self = Throughline's own usage (same shape)
  app.get('/api/analytics', async (c) => c.json({ project: await s().analytics(), self: await s().overhead() }));

  // history: recent work items (cards) + on-demand detail for one item
  app.get('/api/history', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 300);
    return c.json({ items: await s().workItems(limit) });
  });
  app.get('/api/history/item', async (c) => {
    const file = c.req.query('file') ?? '';
    const start = Number(c.req.query('start'));
    const end = Number(c.req.query('end'));
    if (!file || !Number.isFinite(start) || !Number.isFinite(end)) return c.json({ error: 'bad request' }, 400);
    const detail = await s().workItemDetail(file, start, end);
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
  });

  // stale-while-revalidate: return the cached ledger instantly, extend it in the background.
  app.get('/api/decisions', async (c) => {
    const items = await s().readDecisions();
    const refreshing = await s().refreshDecisionsIfStale();
    return c.json({ items, refreshing });
  });

  // read-only: the latest mockup html. Generation is a background job (POST /api/jobs/mockup).
  app.get('/api/mockup', async (c) => c.json({ html: await s().readMockup() }));

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const current = await s().readSpec();
      await stream.writeSSE({ event: 'spec-updated', data: JSON.stringify({ md: current, changedLines: [] }) });
      await stream.writeSSE({ event: 'status', data: JSON.stringify({ working: s().isWorking() }) });
      await stream.writeSSE({ event: 'jobs', data: JSON.stringify({ running: s().runningJobs() }) });
      await stream.writeSSE({ event: 'workspace-changed', data: JSON.stringify(host.activeInfo()) });
      const unsub = host.broadcaster.subscribe((event, data) => {
        // never let a write to a closed stream become an unhandled rejection (crashes Node)
        stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {});
      });
      stream.onAbort(() => unsub());
      if (stream.aborted) { unsub(); return; }
      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
    });
  });

  app.get('/api/flow', async (c) => {
    try {
      const mermaid = await s().generateFlow(c.req.raw.signal);
      return c.json({ mermaid });
    } catch (err) {
      return c.json({ error: (err as Error)?.message ?? String(err) }, 500);
    }
  });

  return app;
}
