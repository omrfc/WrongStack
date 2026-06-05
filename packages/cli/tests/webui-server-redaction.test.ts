import { EventBus } from '@wrongstack/core/kernel';
import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../src/webui-server.js';

const ports = { next: 45_570 };

function nextPort(): number {
  return ports.next++;
}

/**
 * Wraps a WebSocket with a message queue. The `'message'` listener is attached
 * at construction — *before* `'open'` — so the server's immediate `session.start`
 * (sent synchronously inside the connection handler, arriving in the same TCP
 * batch as the handshake) is buffered rather than dropped. Mirrors how a real
 * frontend client sets `onmessage` before the socket opens.
 */
interface WsClient {
  ws: WebSocket;
  waitForMessage(type: string): Promise<any>;
}

function openWs(url: string): Promise<WsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: 'http://localhost' } });
    const buffer: any[] = [];
    const waiters: Array<{ type: string; resolve: (m: any) => void }> = [];

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const idx = waiters.findIndex((w) => w.type === msg.type);
      if (idx >= 0) waiters.splice(idx, 1)[0]!.resolve(msg);
      else buffer.push(msg);
    });

    const waitForMessage = (type: string): Promise<any> =>
      new Promise((res, rej) => {
        const idx = buffer.findIndex((m) => m.type === type);
        if (idx >= 0) {
          res(buffer.splice(idx, 1)[0]);
          return;
        }
        const timer = setTimeout(() => rej(new Error(`timed out waiting for ${type}`)), 5_000);
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(timer);
            res(m);
          },
        });
      });

    ws.once('open', () => resolve({ ws, waitForMessage }));
    ws.once('error', reject);
  });
}

describe('runWebUI redaction', () => {
  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('redacts secrets from tool event input/output before broadcasting to WebSocket clients', async () => {
    const port = nextPort();
    const httpPort = nextPort();
    const events = new EventBus();
    // Port resolution made startup async, so wait for the server to report
    // it's listening before connecting (the old immediate-connect was racy).
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => {
      signalReady = r;
    });
    const serverDone = runWebUI({
      port,
      httpPort,
      onListening: () => signalReady?.(),
      events,
      session: { id: 'test-session' } as any,
      agent: {
        ctx: {
          model: 'test-model',
          provider: { id: 'test-provider' },
        },
        run: vi.fn(),
      } as any,
    });

    await listening;
    const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${port}`);
    await waitForMessage('session.start');

    const openAiKey = `sk-${'1234567890'.repeat(3)}`;
    const bearer = `Bearer ${'abcdefghijklmnopqrstuvwxyz123456'}`;
    const secondOpenAiKey = `sk-${'abcdefghijklmnopqrstuvwxyz123456'}`;

    events.emit('tool.started', {
      id: 'tool-1',
      name: 'fetch',
      input: { url: `https://example.com?token=${openAiKey}` },
    });
    const started = await waitForMessage('tool.started');
    expect(JSON.stringify(started.payload)).not.toContain(openAiKey);
    expect(JSON.stringify(started.payload)).toContain('[REDACTED:openai_key]');

    events.emit('tool.executed', {
      id: 'tool-1',
      name: 'fetch',
      durationMs: 3,
      ok: true,
      input: { authorization: bearer },
      output: `result contains ${secondOpenAiKey}`,
    });
    const executed = await waitForMessage('tool.executed');
    expect(JSON.stringify(executed.payload)).not.toContain(bearer);
    expect(JSON.stringify(executed.payload)).not.toContain(secondOpenAiKey);
    expect(JSON.stringify(executed.payload)).toContain('[REDACTED:bearer_token]');
    expect(JSON.stringify(executed.payload)).toContain('[REDACTED:openai_key]');

    ws.close();
    process.emit('SIGTERM');
    await serverDone;
  });
});
