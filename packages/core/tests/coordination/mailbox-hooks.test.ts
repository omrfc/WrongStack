import { describe, expect, it, vi } from 'vitest';
import { createMailboxHooks } from '../../src/coordination/mailbox-hooks.js';

function makeMailbox(over: { unreadCount?: () => Promise<number>; heartbeat?: () => Promise<void> } = {}) {
  return {
    unreadCount: vi.fn(over.unreadCount ?? (async () => 0)),
    heartbeat: vi.fn(over.heartbeat ?? (async () => undefined)),
  };
}

describe('createMailboxHooks', () => {
  it('beforeTool emits unread_count only when the count changes', async () => {
    const mailbox = makeMailbox({ unreadCount: vi.fn(async () => 3) as never });
    const emit = vi.fn();
    const hooks = createMailboxHooks({ mailbox: mailbox as never, agentId: 'a1' });

    await hooks.beforeTool({ emit });
    expect(emit).toHaveBeenCalledWith('mailbox.unread_count', { agentId: 'a1', count: 3 });

    emit.mockClear();
    await hooks.beforeTool({ emit }); // same count → no emit
    expect(emit).not.toHaveBeenCalled();
  });

  it('beforeTool does not emit when notifyNewMail is false', async () => {
    const mailbox = makeMailbox({ unreadCount: vi.fn(async () => 5) as never });
    const emit = vi.fn();
    const hooks = createMailboxHooks({ mailbox: mailbox as never, agentId: 'a1', notifyNewMail: false });
    await hooks.beforeTool({ emit });
    expect(emit).not.toHaveBeenCalled();
  });

  it('beforeTool swallows mailbox errors', async () => {
    const mailbox = makeMailbox({ unreadCount: vi.fn(async () => { throw new Error('down'); }) as never });
    const emit = vi.fn();
    const hooks = createMailboxHooks({ mailbox: mailbox as never, agentId: 'a1' });
    await expect(hooks.beforeTool({ emit })).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('reset() re-arms the change detection so the same count emits again', async () => {
    const mailbox = makeMailbox({ unreadCount: vi.fn(async () => 2) as never });
    const emit = vi.fn();
    const hooks = createMailboxHooks({ mailbox: mailbox as never, agentId: 'a1' });
    await hooks.beforeTool({ emit });
    hooks.reset();
    emit.mockClear();
    await hooks.beforeTool({ emit }); // same count, but reset → emits again
    expect(emit).toHaveBeenCalled();
  });

  it('afterTool updates the heartbeat with the current tool', async () => {
    const mailbox = makeMailbox();
    const hooks = createMailboxHooks({ mailbox: mailbox as never, agentId: 'a1' });
    await hooks.afterTool('bash');
    expect(mailbox.heartbeat).toHaveBeenCalledWith({ agentId: 'a1', status: 'running', currentTool: 'bash' });
  });

  it('afterTool is a no-op when heartbeat is disabled', async () => {
    const mailbox = makeMailbox();
    const hooks = createMailboxHooks({ mailbox: mailbox as never, agentId: 'a1', heartbeat: false });
    await hooks.afterTool('bash');
    expect(mailbox.heartbeat).not.toHaveBeenCalled();
  });

  it('afterTool swallows heartbeat errors', async () => {
    const mailbox = makeMailbox({ heartbeat: vi.fn(async () => { throw new Error('hb fail'); }) as never });
    const hooks = createMailboxHooks({ mailbox: mailbox as never, agentId: 'a1' });
    await expect(hooks.afterTool()).resolves.toBeUndefined();
  });
});
