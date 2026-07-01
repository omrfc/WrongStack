import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { PendingConfirm, WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
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
  yoloSwitches: boolean[];
  pendingConfirms: Map<string, PendingConfirm>;
  meta: Record<string, unknown>;
} {
  const sent: WsServerMessage[] = [];
  const bc: WsServerMessage[] = [];
  const persisted: Array<Record<string, unknown>> = [];
  const switched: string[] = [];
  const yoloSwitches: boolean[] = [];
  const pendingConfirms = new Map<string, PendingConfirm>();
  const meta: Record<string, unknown> = {};
  const ctx: PrefsContext = {
    agent: { ctx: { meta } } as never,
    prefSnapshot: () => ({ ...meta }),
    persistPrefs: async (p) => {
      persisted.push(p);
    },
    onYoloSwitch: (enabled) => yoloSwitches.push(enabled),
    onAutonomySwitch: (m) => switched.push(m),
    pendingConfirms,
    send: (_ws, m) => sent.push(m),
    broadcast: (m) => bc.push(m),
    log: () => {},
    ...over,
  };
  return { ctx, sent, bc, persisted, switched, yoloSwitches, pendingConfirms, meta };
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
    const { ctx, bc, persisted, meta, yoloSwitches } = makeCtx();
    handlePrefsUpdate(ctx, FAKE_WS, { yolo: true, maxIterations: 9 });
    expect(meta).toMatchObject({ yolo: true, maxIterations: 9 });
    expect(persisted).toEqual([{ yolo: true, maxIterations: 9 }]);
    expect(yoloSwitches).toEqual([true]);
    expect(lastOf(bc, 'prefs.updated')?.payload).toMatchObject({ yolo: true, maxIterations: 9 });
  });

  it('approves pending confirmations when yolo is enabled', () => {
    const { ctx, pendingConfirms } = makeCtx();
    const decisions: string[] = [];
    pendingConfirms.set('confirm_1', { resolve: (decision) => decisions.push(decision) });

    handlePrefsUpdate(ctx, FAKE_WS, { yolo: true });

    expect(decisions).toEqual(['yes']);
    expect(pendingConfirms.size).toBe(0);
  });

  it('leaves destructive pending confirmations unresolved when yolo is enabled', () => {
    const { ctx, pendingConfirms } = makeCtx();
    const decisions: string[] = [];
    pendingConfirms.set('confirm_safe', {
      resolve: (decision) => decisions.push(`safe:${decision}`),
      riskTier: 'standard',
    });
    pendingConfirms.set('confirm_destructive', {
      resolve: (decision) => decisions.push(`destructive:${decision}`),
      decisionSource: 'yolo_destructive',
      riskTier: 'destructive',
    });

    handlePrefsUpdate(ctx, FAKE_WS, { yolo: true });

    expect(decisions).toEqual(['safe:yes']);
    expect(pendingConfirms.has('confirm_safe')).toBe(false);
    expect(pendingConfirms.has('confirm_destructive')).toBe(true);
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
