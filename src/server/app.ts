// src/server/app.ts
import { Hono } from 'hono';
import { streamText, streamSSE } from 'hono/streaming';
import { Session } from './session';

export function createApp(session: Session): Hono {
  const app = new Hono();

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ message?: string }>();
    return streamText(c, async (stream) => {
      await session.sendUserMessage(body.message ?? '', (t) => stream.write(t));
    });
  });

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const current = await session.readSpec();
      await stream.writeSSE({
        event: 'spec-updated',
        data: JSON.stringify({ md: current, changedLines: [] }),
      });

      const unsub = session.broadcaster.subscribe((event, data) => {
        void stream.writeSSE({ event, data: JSON.stringify(data) });
      });
      stream.onAbort(() => unsub());

      while (!stream.aborted) {
        await stream.sleep(30_000);
        if (!stream.aborted) await stream.writeSSE({ event: 'ping', data: '' });
      }
    });
  });

  return app;
}
