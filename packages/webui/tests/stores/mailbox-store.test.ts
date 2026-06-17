import { afterEach, describe, expect, it } from 'vitest';
import {
  type MailboxMessage,
  selectUnreadCount,
  useMailboxStore,
} from '../../src/stores/mailbox-store';

function makeMessage(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: 'msg_1',
    from: 'agent-a',
    to: '*',
    type: 'note',
    subject: 'hello',
    body: 'body',
    priority: 'normal',
    readBy: {},
    readByCount: 0,
    completed: false,
    timestamp: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('mailbox store', () => {
  afterEach(() => {
    // Clean up persisted state between tests
    useMailboxStore.setState({ messages: [], agents: [] });
  });

  it('counts only unread, uncompleted messages', () => {
    useMailboxStore.getState().setMessages([
      makeMessage({ id: 'a' }), // unread
      makeMessage({ id: 'b', readByCount: 2 }), // read
      makeMessage({ id: 'c', completed: true }), // completed
      makeMessage({ id: 'd' }), // unread
    ]);
    expect(selectUnreadCount(useMailboxStore.getState())).toBe(2);
  });

  it('is zero when empty', () => {
    useMailboxStore.getState().setMessages([]);
    expect(selectUnreadCount(useMailboxStore.getState())).toBe(0);
  });

  it('setMessages updates the messages array', () => {
    const msgs = [makeMessage({ id: 'x' }), makeMessage({ id: 'y' })];
    useMailboxStore.getState().setMessages(msgs);
    expect(useMailboxStore.getState().messages).toEqual(msgs);
  });

  it('setAgents updates the agents array', () => {
    const agents = [{ id: 'agent-1', name: 'Alice' }, { id: 'agent-2', name: 'Bob' }];
    useMailboxStore.getState().setAgents(agents as any);
    expect(useMailboxStore.getState().agents).toEqual(agents);
  });
});
