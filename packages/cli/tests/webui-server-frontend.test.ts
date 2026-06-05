import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../src/webui-server.js';

// High base ports so the test never collides with a real WebUI / dev server.
const ports = { next: 45_700 };
const nextPort = () => ports.next++;

let serverDone: Promise<void> | null = null;

afterEach(async () => {
  if (serverDone) {
    process.emit('SIGTERM');
    await serverDone;
    serverDone = null;
  }
});

describe('runWebUI frontend serving', () => {
  it('serves the React frontend over HTTP with the live WS port injected', async () => {
    const events = new EventBus();
    let info: { httpPort: number; wsPort: number; host: string } | undefined;
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => {
      signalReady = r;
    });

    serverDone = runWebUI({
      port: nextPort(),
      httpPort: nextPort(),
      onListening: (i) => {
        info = i;
        signalReady?.();
      },
      events,
      session: { id: 'test-session' } as never,
      agent: {
        ctx: { model: 'test-model', provider: { id: 'test-provider' } },
        run: vi.fn(),
      } as never,
    });

    await listening;
    expect(info).toBeDefined();

    // The HTTP server should serve index.html with this instance's WS port
    // stamped in — that's what lets the browser connect back to THIS backend.
    // onListening fires on the WS server; the HTTP server listens separately and
    // can lag a tick under parallel test load, so retry the fetch briefly rather
    // than racing it (ECONNREFUSED otherwise).
    const url = `http://${info!.host}:${info!.httpPort}/`;
    let res: Response | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        res = await fetch(url);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    if (!res) throw new Error(`HTTP server never became reachable at ${url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    const html = await res.text();
    expect(html).toContain(`<meta name="wrongstack-ws-port" content="${info!.wsPort}"`);
    expect(html.toLowerCase()).toContain('<!doctype html>');
  });
});
