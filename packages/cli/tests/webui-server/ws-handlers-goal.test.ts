import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { WsServerMessage } from '../../src/webui-server/ws-handlers/index.js';
import { handleGoalGet } from '../../src/webui-server/ws-handlers/index.js';
import type { GoalContext } from '../../src/webui-server/ws-handlers/goal.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * PR 5h of Issue #30: goal ws-handler unit tests.
 *
 * Mocks node:fs/promises to test goal.json reading without touching disk.
 */

const FAKE_WS = {} as WebSocket;

function makeCtx(over: Partial<GoalContext> = {}): {
  ctx: GoalContext;
  bc: WsServerMessage[];
} {
  const bc: WsServerMessage[] = [];
  const ctx: GoalContext = {
    send: () => {},
    broadcast: (m) => bc.push(m),
    log: () => {},
    projectRoot: '/tmp/project',
    ...over,
  };
  return { ctx, bc };
}

const lastOf = (msgs: WsServerMessage[], type: string) =>
  msgs.filter((m) => m.type === type).at(-1);

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn(),
  };
});

describe('handleGoalGet', () => {
  it('broadcasts parsed goal.json when file exists', async () => {
    const { ctx, bc } = makeCtx();
    vi.mocked(fs.readFile).mockResolvedValue('{"title":"Test Goal","iterations":5}');
    await handleGoalGet(ctx, FAKE_WS);
    const msg = lastOf(bc, 'goal.updated');
    expect(msg?.payload).toEqual({ title: 'Test Goal', iterations: 5 });
  });

  it('broadcasts null when goal.json is missing', async () => {
    const { ctx, bc } = makeCtx();
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
    await handleGoalGet(ctx, FAKE_WS);
    const msg = lastOf(bc, 'goal.updated');
    expect(msg?.payload).toBeNull();
  });

  it('broadcasts null when goal.json contains invalid JSON', async () => {
    const { ctx, bc } = makeCtx();
    vi.mocked(fs.readFile).mockResolvedValue('not json');
    await handleGoalGet(ctx, FAKE_WS);
    const msg = lastOf(bc, 'goal.updated');
    expect(msg?.payload).toBeNull();
  });

  it('constructs the correct path from projectRoot', async () => {
    const { ctx } = makeCtx({ projectRoot: '/custom/root' });
    vi.mocked(fs.readFile).mockResolvedValue('{}');
    await handleGoalGet(ctx, FAKE_WS);
    expect(fs.readFile).toHaveBeenCalledWith(
      path.join('/custom/root', '.wrongstack', 'goal.json'),
      'utf8',
    );
  });
});
