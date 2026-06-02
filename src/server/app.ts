// src/server/app.ts
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { Session } from './session';

export function createApp(session: Session): Hono {
  const app = new Hono();

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

  app.get('/api/decisions', async (c) => c.json({ md: await session.readDecisions() }));

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
