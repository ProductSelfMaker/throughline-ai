// src/server/app.ts
import { Hono } from 'hono';
import { streamText, streamSSE } from 'hono/streaming';
import { Session } from './session';

export function createApp(session: Session): Hono {
  const app = new Hono();

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ message?: string }>();
    const message = (body.message ?? '').trim();
    if (!message) return c.json({ error: 'empty message' }, 400);
    return streamText(c, async (stream) => {
      await session.sendUserMessage(message, (e) => {
        void stream.write(JSON.stringify(e) + '\n');
      });
      await stream.write(JSON.stringify({ type: 'done' }) + '\n');
    });
  });

  app.get('/api/transcript', (c) => c.json({ transcript: session.getTranscript() }));

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const current = await session.readSpec();
      await stream.writeSSE({ event: 'spec-updated', data: JSON.stringify({ md: current, changedLines: [] }) });
      const unsub = session.broadcaster.subscribe((event, data) => {
        void stream.writeSSE({ event, data: JSON.stringify(data) });
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
