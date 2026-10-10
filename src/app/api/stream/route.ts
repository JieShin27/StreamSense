import { snapshot, subscribe } from '@/lib/store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Server-Sent Events: every screen gets the whole room again whenever it changes. */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(enc.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send(`data: ${JSON.stringify(snapshot())}\n\n`);
      const unsubscribe = subscribe((state) => send(`data: ${JSON.stringify(state)}\n\n`));
      // Keeps proxies from closing a quiet connection.
      const beat = setInterval(() => send(': ping\n\n'), 15000);
      cleanup = () => {
        clearInterval(beat);
        unsubscribe();
      };
      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
