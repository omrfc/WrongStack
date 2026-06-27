/**
 * Tests for the remote WebSocket client transport and
 * `ACPSession.connectWebSocket`. A fake global `WebSocket` lets us drive
 * open/message/close without a real socket.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACPSession } from '../src/client/acp-session.js';
import { WebSocketClientTransport } from '../src/client/websocket-transport.js';
import type { ACPMessage } from '../src/types/acp-messages.js';

type Listener = (ev?: unknown) => void;

class FakeWS {
  static instances: FakeWS[] = [];
  readonly url: string;
  readonly listeners: Record<string, Listener[]> = {};
  readonly sent: string[] = [];
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  addEventListener(type: string, cb: Listener): void {
    const list = this.listeners[type] ?? [];
    list.push(cb);
    this.listeners[type] = list;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.fire('close');
  }
  fire(type: string, ev?: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

const realWS = (globalThis as { WebSocket?: unknown }).WebSocket;

function last(): FakeWS {
  const t = FakeWS.instances[FakeWS.instances.length - 1];
  if (!t) throw new Error('no WebSocket constructed');
  return t;
}

beforeEach(() => {
  FakeWS.instances.length = 0;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS as never;
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = realWS;
});

describe('WebSocketClientTransport', () => {
  it('resolves start() on open, dispatches parsed messages, serializes sends', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const startP = t.start();
    last().fire('open');
    await startP;

    const received: ACPMessage[] = [];
    t.onMessage((m) => received.push(m));
    last().fire('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ id: 1, result: { ok: true } });

    await t.send({ jsonrpc: '2.0', id: 2, method: 'ping' } as never as ACPMessage);
    expect(JSON.parse(last().sent[0]!)).toMatchObject({ id: 2, method: 'ping' });

    t.stop();
    expect(last().closed).toBe(true);
  });

  it('rejects start() on a timeout', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test', handshakeTimeoutMs: 10 });
    await expect(t.start()).rejects.toThrow(/within 10ms/);
  });

  it('rejects send() after the socket is closed', async () => {
    const t = new WebSocketClientTransport({ url: 'ws://agent.test' });
    const startP = t.start();
    last().fire('open');
    await startP;
    t.stop();
    await expect(t.send({ jsonrpc: '2.0', id: 1 } as never as ACPMessage)).rejects.toThrow(
      /not open/,
    );
  });
});

describe('ACPSession.connectWebSocket', () => {
  const PROJECT_ROOT = path.resolve(os.tmpdir(), 'wstack-acp-ws-test');

  it('connects, handshakes, and runs a prompt turn over the socket', async () => {
    const sessionP = ACPSession.connectWebSocket(
      { url: 'ws://agent.test' },
      { command: 'remote', projectRoot: PROJECT_ROOT },
    );
    // Open the socket so initialize can be sent.
    last().fire('open');
    await new Promise((r) => setImmediate(r));

    const ws = last();
    const initMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.method === 'initialize');
    expect(initMsg).toBeDefined();
    ws.fire('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: initMsg.id,
        result: { protocolVersion: 1, agentInfo: { name: 'remote', version: '1' } },
      }),
    });
    const session = await sessionP;
    expect(session.getAgentInfo()?.name).toBe('remote');

    // Run a prompt: new → stream a chunk → stopReason.
    const promptP = session.prompt([{ type: 'text', text: 'hi' }], new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    const newMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.method === 'session/new');
    ws.fire('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: newMsg.id, result: { sessionId: 'sess_ws' } }),
    });
    await new Promise((r) => setImmediate(r));
    const promptMsg = ws.sent.map((s) => JSON.parse(s)).find((m) => m.method === 'session/prompt');
    ws.fire('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess_ws',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } },
        },
      }),
    });
    ws.fire('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        id: promptMsg.id,
        result: { stopReason: 'end_turn' },
      }),
    });

    const result = await promptP;
    expect(result.text).toBe('pong');
    expect(result.stopReason).toBe('end_turn');
    await session.close();
  });
});
