/**
 * Tests for the v1 ACPProtocolHandler.
 *
 * Uses a fake transport (records every `send`) and a fake `runTurn`
 * (canned stopReason + optional stream of updates) so the handler can
 * be exercised without spawning any real agent or subprocess.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AgentServerTransport } from '../src/agent/stdio-transport.js';
import {
  ACPProtocolHandler,
  WRONGSTACK_VERSION,
  type RunTurn,
  type RunTurnResult,
} from '../src/agent/protocol-handler.js';

interface FakeTransport {
  sent: unknown[];
  send: ReturnType<typeof vi.fn>;
  sendStartupMarker?: () => void;
  read?: () => Promise<unknown>;
  close?: () => void;
}

function fakeTransport(): FakeTransport {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn(async (msg: unknown) => {
      sent.push(msg);
    }),
  };
}

const PASSON_RUN_TURN: RunTurn = async (_input, _emit) => {
  return { stopReason: 'end_turn' };
};

const ABORTING_RUN_TURN: RunTurn = async (input) => {
  return new Promise<RunTurnResult>((resolve) => {
    input.signal.addEventListener('abort', () => {
      resolve({ stopReason: 'cancelled' });
    });
  });
};

function makeHandler(opts: {
  runTurn?: RunTurn;
  defaultCwd?: string;
} = {}): { handler: ACPProtocolHandler; transport: FakeTransport } {
  const transport = fakeTransport();
  const handler = new ACPProtocolHandler({
    transport: transport as never as AgentServerTransport,
    defaultCwd: opts.defaultCwd ?? '/test',
    runTurn: opts.runTurn ?? PASSON_RUN_TURN,
  });
  return { handler, transport };
}

describe('ACPProtocolHandler', () => {
  describe('initialization', () => {
    it('returns v1 capabilities with full session and auth support', async () => {
      const { handler, transport } = makeHandler();
      const terminal = await handler.handleMessage({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1 },
      });
      expect(terminal).toBe(false);
      expect(transport.sent).toHaveLength(1);
      const resp = transport.sent[0] as { result?: Record<string, unknown> };
      expect(resp.result).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: 'wrongstack', title: 'WrongStack', version: WRONGSTACK_VERSION },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { close: {}, list: {}, delete: {}, resume: {} },
          auth: { logout: {} },
        },
        authMethods: [
          {
            id: 'wrongstack-auth',
            name: 'Run wstack auth',
            type: 'terminal',
            args: ['auth'],
          },
        ],
      });
    });

    it('rejects a non-v1 protocol version with -32000', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 99 } });
      const resp = transport.sent[0] as { error?: { code: number; message: string } };
      expect(resp.error?.code).toBe(-32000);
      expect(resp.error?.message).toContain('protocolVersion=1');
    });

    it('rejects non-initialize requests before initialization', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'session/new', params: { cwd: '/x' } });
      const resp = transport.sent[0] as { error?: { code: number; message: string } };
      expect(resp.error?.code).toBe(-32000);
      expect(resp.error?.message).toBe('Not initialized');
    });

    it('accepts a second initialize (idempotent re-init)', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'initialize', params: { protocolVersion: 1 } });
      expect(transport.sent).toHaveLength(2);
    });
  });

  describe('authenticate', () => {
    it('returns the unauthenticated outcome', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0; // clear the initialize response
      await handler.handleMessage({ id: 2, method: 'authenticate', params: {} });
      const resp = transport.sent[0] as { result?: { outcome: string } };
      expect(resp.result).toEqual({ outcome: 'unauthenticated' });
    });
  });

  describe('session/new', () => {
    it('creates a session, emits current_mode_update, returns the id', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;

      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/proj' } });

      expect(transport.sent.length).toBe(2);
      const note = transport.sent[0] as { method?: string; params?: { update?: { sessionUpdate?: string; modeId?: string } } };
      expect(note.method).toBe('session/update');
      expect(note.params?.update?.sessionUpdate).toBe('current_mode_update');
      expect(note.params?.update?.modeId).toBe('code');

      const resp = transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } };
      expect(resp.result?.sessionId).toMatch(/^sess_/);
    });
  });

  describe('session/load', () => {
    it('loads an existing session from memory', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({ id: 3, method: 'session/load', params: { sessionId, cwd: '/x' } });
      expect(transport.sent.length).toBeGreaterThanOrEqual(1);
      const resp = transport.sent[transport.sent.length - 1] as { result?: { initialMode?: { currentModeId?: string } } };
      expect(resp.result?.initialMode?.currentModeId).toBe('code');
    });

    it('returns error for a non-existent session', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'session/load', params: { sessionId: 'sess_nonexist', cwd: '/x' } });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32000);
    });
  });

  describe('session/resume', () => {
    it('resumes an existing session without history replay', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({ id: 3, method: 'session/resume', params: { sessionId, cwd: '/x' } });
      const resp = transport.sent[transport.sent.length - 1] as { result?: { initialMode?: { currentModeId?: string } } };
      expect(resp.result?.initialMode?.currentModeId).toBe('code');
    });

    it('returns error for a non-existent session', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'session/resume', params: { sessionId: 'sess_nonexist', cwd: '/x' } });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32000);
    });
  });

  describe('session/close', () => {
    it('closes an active session gracefully', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({ id: 3, method: 'session/close', params: { sessionId } });
      const resp = transport.sent[transport.sent.length - 1] as { result?: {} };
      expect(resp.result).toEqual({});

      // Session should be removed from list
      transport.sent.length = 0;
      await handler.handleMessage({ id: 4, method: 'session/list' });
      const listResp = transport.sent[0] as { result?: { sessions: unknown[] } };
      expect(listResp.result?.sessions).toHaveLength(0);
    });

    it('returns error for a non-existent session', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'session/close', params: { sessionId: 'sess_nonexist' } });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32000);
    });
  });

  describe('session/delete', () => {
    it('deletes a session from the list', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({ id: 3, method: 'session/delete', params: { sessionId } });
      const resp = transport.sent[transport.sent.length - 1] as { result?: {} };
      expect(resp.result).toEqual({});

      transport.sent.length = 0;
      await handler.handleMessage({ id: 4, method: 'session/list' });
      const listResp = transport.sent[0] as { result?: { sessions: unknown[] } };
      expect(listResp.result?.sessions).toHaveLength(0);
    });
  });

  describe('logout', () => {
    it('returns empty result', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'logout', params: {} });
      const resp = transport.sent[0] as { result?: {} };
      expect(resp.result).toEqual({});
    });
  });

  describe('session/list', () => {
    it('returns an empty list initially, then includes created sessions', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/list' });
      const r1 = transport.sent[transport.sent.length - 1] as { result?: { sessions: unknown[] } };
      expect(r1.result?.sessions).toEqual([]);

      transport.sent.length = 0;
      await handler.handleMessage({ id: 3, method: 'session/new', params: { cwd: '/x' } });
      const newResp = transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } };
      const newId = newResp.result?.sessionId;
      transport.sent.length = 0;
      await handler.handleMessage({ id: 4, method: 'session/list' });
      const r2 = transport.sent[0] as { result?: { sessions: { sessionId: string }[] } };
      expect(r2.result?.sessions.map((s) => s.sessionId)).toEqual([newId]);
    });
  });

  describe('session/prompt', () => {
    it('runs the turn and returns the stopReason', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] },
      });
      const resp = transport.sent[transport.sent.length - 1] as { result?: { stopReason?: string } };
      expect(resp.result?.stopReason).toBe('end_turn');
    });

    it('streams session/update notifications emitted by runTurn', async () => {
      const streamingRunTurn: RunTurn = async (_input, emit) => {
        emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello ' },
        });
        emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'world' },
        });
        return { stopReason: 'end_turn' };
      };
      const { handler, transport } = makeHandler({ runTurn: streamingRunTurn });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      });

      // Three sends: 2 chunk notifications + 1 prompt response
      expect(transport.sent.length).toBe(3);
      const note1 = transport.sent[0] as { params?: { update?: { sessionUpdate?: string } } };
      expect(note1.params?.update?.sessionUpdate).toBe('agent_message_chunk');
      const note2 = transport.sent[1] as { params?: { update?: { sessionUpdate?: string } } };
      expect(note2.params?.update?.sessionUpdate).toBe('agent_message_chunk');
      const resp = transport.sent[2] as { result?: { stopReason?: string } };
      expect(resp.result?.stopReason).toBe('end_turn');
    });

    it('cancels the in-flight turn on session/cancel notification', async () => {
      const { handler, transport } = makeHandler({ runTurn: ABORTING_RUN_TURN });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      // Kick off a turn without awaiting
      const turnDone = handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      });
      // Let the turn register its signal listener
      await new Promise((r) => setImmediate(r));
      // Send the cancel
      await handler.handleMessage({ method: 'session/cancel', params: { sessionId } });
      // Now wait for the turn to resolve
      await turnDone;
      const resp = transport.sent[transport.sent.length - 1] as { result?: { stopReason?: string } };
      expect(resp.result?.stopReason).toBe('cancelled');
    });

    it('rejects a prompt with a missing sessionId', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({
        id: 2,
        method: 'session/prompt',
        params: { prompt: [{ type: 'text', text: 'hi' }] },
      });
      const resp = transport.sent[0] as { error?: { code: number; message: string } };
      expect(resp.error?.code).toBe(-32000);
    });
  });

  describe('session/set_mode', () => {
    it('updates the mode and emits current_mode_update', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/set_mode',
        params: { sessionId, modeId: 'code' },
      });
      expect(transport.sent.length).toBe(2); // notification + result
      const note = transport.sent[0] as { params?: { update?: { modeId?: string } } };
      expect(note.params?.update?.modeId).toBe('code');
    });

    it('rejects an unknown modeId', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      await handler.handleMessage({
        id: 3,
        method: 'session/set_mode',
        params: { sessionId, modeId: 'bogus' },
      });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32602);
    });
  });

  describe('unknown method', () => {
    it('returns -32601', async () => {
      const { handler, transport } = makeHandler();
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      transport.sent.length = 0;
      await handler.handleMessage({ id: 2, method: 'made_up_method' });
      const resp = transport.sent[0] as { error?: { code: number } };
      expect(resp.error?.code).toBe(-32601);
    });
  });

  describe('close', () => {
    it('aborts active turns and clears session state', async () => {
      const { handler, transport } = makeHandler({ runTurn: ABORTING_RUN_TURN });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/x' } });
      const sessionId = (transport.sent[transport.sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      transport.sent.length = 0;

      // Kick off a turn without awaiting
      const turnDone = handler.handleMessage({
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'go' }] },
      });
      await new Promise((r) => setImmediate(r));
      handler.close();
      // The pending turn should resolve because the runTurn's signal fires.
      await turnDone;
    });
  });

  describe('client permission requests', () => {
    it('round-trips session/request_permission to the client and returns the outcome', async () => {
      // Transport that also captures the onMessage handler so we can push
      // a simulated client response back into the handler.
      let onMsg: ((m: unknown) => void) | undefined;
      const sent: unknown[] = [];
      const transport = {
        sent,
        send: vi.fn(async (m: unknown) => { sent.push(m); }),
        onMessage: (h: (m: unknown) => void) => { onMsg = h; return () => {}; },
      };

      let observedOutcome: unknown;
      const runTurn: RunTurn = async (_input, _emit, api) => {
        const outcome = await api!.requestPermission({
          toolCall: { toolCallId: 'tc1', title: 'write a.ts', kind: 'edit' },
          options: [
            { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          ],
        });
        observedOutcome = outcome;
        return { stopReason: 'end_turn' };
      };

      const handler = new ACPProtocolHandler({
        transport: transport as never as AgentServerTransport,
        defaultCwd: '/test',
        runTurn,
      });
      await handler.handleMessage({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/test' } });
      const sessionId = (sent[sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      sent.length = 0;

      // Kick off the turn without awaiting — it parks on requestPermission.
      const turnDone = handler.handleMessage({
        id: 3, method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'edit' }] },
      });
      await new Promise((r) => setImmediate(r));

      // The handler should have sent a session/request_permission REQUEST.
      const req = sent.find(
        (m) => (m as { method?: string }).method === 'session/request_permission',
      ) as { id: string; params?: { toolCall?: unknown; options?: unknown } } | undefined;
      expect(req).toBeDefined();
      expect(req?.params?.toolCall).toMatchObject({ toolCallId: 'tc1' });

      // Simulate the client's response, routed via onMessage.
      onMsg?.({ id: req!.id, result: { outcome: { outcome: 'selected', optionId: 'allow_once' } } });
      await turnDone;

      expect(observedOutcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    });

    it('exposes client fs/terminal via api and round-trips fs/read_text_file', async () => {
      let onMsg: ((m: unknown) => void) | undefined;
      const sent: unknown[] = [];
      const transport = {
        sent,
        send: vi.fn(async (m: unknown) => { sent.push(m); }),
        onMessage: (h: (m: unknown) => void) => { onMsg = h; return () => {}; },
      };

      let content: string | undefined;
      let caps: unknown;
      const runTurn: RunTurn = async (_input, _emit, api) => {
        caps = api!.clientCapabilities;
        content = await api!.readTextFile({ path: '/abs/a.ts' });
        return { stopReason: 'end_turn' };
      };

      const handler = new ACPProtocolHandler({
        transport: transport as never as AgentServerTransport,
        defaultCwd: '/test',
        runTurn,
      });
      await handler.handleMessage({
        id: 1, method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true }, terminal: true } },
      });
      await handler.handleMessage({ id: 2, method: 'session/new', params: { cwd: '/test' } });
      const sessionId = (sent[sent.length - 1] as { result?: { sessionId?: string } }).result?.sessionId!;
      sent.length = 0;

      const turnDone = handler.handleMessage({
        id: 3, method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: 'read it' }] },
      });
      await new Promise((r) => setImmediate(r));

      const req = sent.find(
        (m) => (m as { method?: string }).method === 'fs/read_text_file',
      ) as { id: string; params?: { path?: string } } | undefined;
      expect(req).toBeDefined();
      expect(req?.params?.path).toBe('/abs/a.ts');
      onMsg?.({ id: req!.id, result: { content: 'file body' } });
      await turnDone;

      expect(content).toBe('file body');
      expect(caps).toMatchObject({ fs: { readTextFile: true }, terminal: true });
    });
  });
});
