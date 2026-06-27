/**
 * Capstone end-to-end loopback test: OUR client (`ACPSession`) talking to
 * OUR agent (`ACPProtocolHandler`) in-process, with a JSON round-trip on
 * every hop so serialization mismatches surface. Exercises the functional
 * features added across both directions at once:
 *
 *   - DIR-2 agent streams `tool_call` / `tool_call_update` + a diff (B1)
 *   - DIR-1 client captures them into the run result (A1) and fires onProgress (A2)
 *   - DIR-2 agent reads a file via the client's filesystem (B3) — served by
 *     the client's real `FileServer` over `fs/read_text_file`
 *   - DIR-2 agent asks the client for permission (B2); the client's default
 *     policy auto-approves (A3)
 *
 * If the two sides disagree on the wire, this test fails where the unit
 * tests (which use fakes on one side) cannot.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACPProtocolHandler, type RunTurn } from '../src/agent/protocol-handler.js';
import type { ACPClientTransport } from '../src/agent/stdio-transport.js';
import { WsBridgeTransport } from '../src/agent/ws-bridge-transport.js';
import { ACPSession } from '../src/client/acp-session.js';
import type { ACPMessage } from '../src/types/acp-messages.js';

/** JSON round-trip so branded types / undefined fields behave like the wire. */
function wire<T>(m: T): T {
  return JSON.parse(JSON.stringify(m)) as T;
}

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'acp-loopback-'));
});
afterEach(async () => {
  await fsp.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

describe('ACP client ↔ server loopback', () => {
  it('runs a turn end-to-end: tool stream + client fs read + permission', async () => {
    const notePath = path.join(projectRoot, 'note.txt');
    await fsp.writeFile(notePath, 'hello from client fs', 'utf8');

    // The agent's per-turn work: stream a tool call + diff, read a file via
    // the client's fs, ask permission, then echo the file content.
    let fileContent: string | undefined;
    let permissionOutcome: unknown;
    const runTurn: RunTurn = async (_input, emit, api) => {
      emit({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc1',
        title: 'read note.txt',
        kind: 'read',
        status: 'in_progress',
      });
      fileContent = await api!.readTextFile({ path: notePath });
      emit({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc1',
        status: 'completed',
        content: [{ type: 'diff', path: notePath, oldText: null, newText: fileContent }],
      });
      permissionOutcome = await api!.requestPermission({
        toolCall: { toolCallId: 'tc1', title: 'apply edit', kind: 'edit' },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      });
      emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `file says: ${fileContent}` },
      });
      return { stopReason: 'end_turn' };
    };

    // Wire the two sides together with a JSON round-trip on every hop.
    const clientHandlers = new Set<(m: ACPMessage) => void>();
    let handler: ACPProtocolHandler;

    const serverTransport = new WsBridgeTransport((m) => {
      // server → client
      const msg = wire(m);
      for (const h of [...clientHandlers]) h(msg);
    });

    const clientTransport: ACPClientTransport = {
      start: async () => {},
      send: async (m) => {
        // client → server: route responses + process requests
        const msg = wire(m);
        serverTransport.receive(msg);
        void handler.handleMessage(msg);
      },
      onMessage: (h) => {
        clientHandlers.add(h);
        return () => clientHandlers.delete(h);
      },
      stop: () => {},
    };

    handler = new ACPProtocolHandler({
      transport: serverTransport,
      defaultCwd: projectRoot,
      runTurn,
    });

    const session = await ACPSession.connect(clientTransport, {
      command: 'loopback',
      projectRoot,
      timeoutMs: 10_000,
    });

    // Sanity: the real handshake completed over the loopback.
    expect(session.getAgentInfo()?.name).toBe('wrongstack');
    expect(session.getCapabilities().promptCapabilities?.image).toBe(true);

    const progress: string[] = [];
    const result = await session.prompt(
      [{ type: 'text', text: 'read the note' }],
      new AbortController().signal,
      (e) => progress.push(e.type),
    );

    // Agent side: it actually read the client's file and got permission.
    expect(fileContent).toBe('hello from client fs');
    expect(permissionOutcome).toMatchObject({ outcome: 'selected', optionId: 'allow_once' });

    // Client side: captured the stream + final text.
    expect(result.text).toBe('file says: hello from client fs');
    expect(result.stopReason).toBe('end_turn');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({ toolCallId: 'tc1', status: 'completed' });
    expect(result.diffs).toEqual([
      { path: notePath, oldText: null, newText: 'hello from client fs' },
    ]);
    expect(progress).toEqual(
      expect.arrayContaining(['tool_call', 'tool_call_update', 'diff', 'message']),
    );

    await session.close();
  }, 20_000);
});
