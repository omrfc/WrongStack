import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import {
  handleAutonomySwitch,
  handlePrefsGet,
  handlePrefsUpdate,
} from '../../src/webui-server/ws-handlers/index.js';
import type { PrefsContext } from '../../src/webui-server/ws-handlers/prefs.js';

/**
 * PR 5f of Issue #30: prefs ws-handler unit tests.
 *
 * Drives the handlers with a fake agent ctx and spy prefSnapshot /
 * persistPrefs / onAutonomySwitch callbacks (the durable logic stays in
 * runWebUI's closures).
 */

const FAKE_WS = {} as WebSocket;

function makeCtx(over: Partial<PrefsContext> = {}): {
  ctx: PrefsContext;
  sent: WsServerMessage[];
  bc: WsServerMessage[];
  persisted: Array<Record<string, unknown>>;
  switched: string[];
  meta: Record<string, unknown>;
} {
  const sent: WsServerMessage[] = [];
  const bc: WsServerMessage[] = [];
  const persisted: Array<Record<string, unknown>> = [];
  const switched: string[] = [];
  const meta: Record<string, unknown> = {};
  const ctx: PrefsContext = {
    agent: { ctx: { meta } } as never,
    prefSnapshot: () => ({ ...meta }),
    persistPrefs: async (p) => {
      persisted.push(p);
    },
    onAutonomySwitch: (m) => switched.push(m),
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => bc.push(m),
    log: () => {},
    ...over,
  };
  return { ctx, sent, bc, persisted, switched, meta };
}

const lastOf = (msgs: WsServerMessage[], type: string) =>
  msgs.filter((m) => m.type === type).at(-1);

describe('handlePrefsGet', () => {
  it('sends the current snapshot', () => {
    const { ctx, sent, meta } = makeCtx();
    meta['autonomy'] = 'auto';
    handlePrefsGet(ctx, FAKE_WS);
    expect(lastOf(sent, 'prefs.updated')?.payload).toEqual({ autonomy: 'auto' });
  });
});

describe('handlePrefsUpdate', () => {
  it('merges into meta, persists the payload, broadcasts the snapshot', () => {
    const { ctx, bc, persisted, meta } = makeCtx();
    handlePrefsUpdate(ctx, FAKE_WS, { yolo: true, maxIterations: 9 });
    expect(meta).toMatchObject({ yolo: true, maxIterations: 9 });
    expect(persisted).toEqual([{ yolo: true, maxIterations: 9 }]);
    expect(lastOf(bc, 'prefs.updated')?.payload).toMatchObject({ yolo: true, maxIterations: 9 });
  });
});

describe('handleAutonomySwitch', () => {
  it('sets meta, flips the real autonomy state, broadcasts, persists', () => {
    const { ctx, sent, bc, persisted, switched, meta } = makeCtx();
    handleAutonomySwitch(ctx, FAKE_WS, 'suggest');
    expect(meta['autonomy']).toBe('suggest');
    expect(switched).toEqual(['suggest']);
    const res = sent.find((m) => m.type === 'key.operation_result')?.payload as {
      success: boolean;
    };
    expect(res.success).toBe(true);
    expect(lastOf(bc, 'prefs.updated')?.payload).toEqual({ autonomy: 'suggest' });
    expect(persisted).toEqual([{ autonomy: 'suggest' }]);
  });

  it('tolerates a missing onAutonomySwitch (advisory meta only)', () => {
    const { ctx, meta } = makeCtx({ onAutonomySwitch: undefined });
    expect(() => handleAutonomySwitch(ctx, FAKE_WS, 'off')).not.toThrow();
    expect(meta['autonomy']).toBe('off');
  });
});
