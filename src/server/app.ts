// src/server/app.ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { homedir } from 'node:os';
import { Session } from './session';

export function createApp(session: Session): Hono {
  const app = new Hono();

  // which project this instance observes (shown in the top row)
  app.get('/api/info', (c) => {
    const cwd = session.projectDir();
    const home = homedir();
    const display = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    return c.json({ cwd, display });
  });

  app.post('/api/curate', async (c) => {
    const body = await c.req.json<{ instruction?: string }>();
    const instruction = (body.instruction ?? '').trim();
    if (!instruction) return c.json({ error: 'empty instruction' }, 400);
    await session.curate(instruction);
    return c.json({ ok: true });
  });

  app.post('/api/rebuild', async (c) => {
    await session.rebuild();
    return c.json({ ok: true });
  });

  app.get('/api/analytics', async (c) => c.json(await session.analytics()));

  // history: recent work items (cards) + on-demand detail for one item
  app.get('/api/history', async (c) => {
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 300);
    return c.json({ items: await session.workItems(limit) });
  });
  app.get('/api/history/item', async (c) => {
    const file = c.req.query('file') ?? '';
    const start = Number(c.req.query('start'));
    const end = Number(c.req.query('end'));
    if (!file || !Number.isFinite(start) || !Number.isFinite(end)) return c.json({ error: 'bad request' }, 400);
    const detail = await session.workItemDetail(file, start, end);
    return detail ? c.json(detail) : c.json({ error: 'not found' }, 404);
  });

  // stale-while-revalidate: return the cached doc instantly, refresh in the
  // background if stale (result arrives via the 'decisions-updated' SSE event).
  app.get('/api/decisions', async (c) => {
    const md = await session.readDecisions();
    const refreshing = await session.refreshDecisionsIfStale();
    return c.json({ md, refreshing });
  });

  app.get('/api/mockup', async (c) => c.json({ html: await session.readMockup() }));
  app.post('/api/mockup', async (c) => c.json({ html: await session.generateMockup() }));

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const current = await session.readSpec();
      await stream.writeSSE({ event: 'spec-updated', data: JSON.stringify({ md: current, changedLines: [] }) });
      const unsub = session.broadcaster.subscribe((event, data) => {
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
      const mermaid = await session.generateFlow(c.req.raw.signal);
      return c.json({ mermaid });
    } catch (err) {
      return c.json({ error: (err as Error)?.message ?? String(err) }, 500);
    }
  });

  return app;
}
