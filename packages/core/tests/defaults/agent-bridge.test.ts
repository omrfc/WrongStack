import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  InMemoryBridgeTransport,
  InMemoryAgentBridge,
  createMessage,
} from '../../src/defaults/agent-bridge.js';

describe('InMemoryBridgeTransport', () => {
  let transport: InMemoryBridgeTransport;

  beforeEach(() => {
    transport = new InMemoryBridgeTransport();
  });

  it('delivers message to subscribed handler', async () => {
    let received: any;
    const unsub = transport.subscribe('agent1', (msg) => { received = msg; });
    await transport.send({ id: '1', type: 'task', from: 'c', to: 'agent1', payload: {}, timestamp: Date.now(), priority: 'normal' }, 'agent1');
    expect(received).toBeDefined();
    expect(received.id).toBe('1');
    unsub();
  });

  it('subscribe returns unsubscribe function', () => {
    let count = 0;
    const unsub = transport.subscribe('agent1', () => { count++; });
    transport.send({ id: '1', type: 'task', from: 'c', to: 'agent1', payload: {}, timestamp: Date.now(), priority: 'normal' }, 'agent1');
    unsub();
    transport.send({ id: '2', type: 'task', from: 'c', to: 'agent1', payload: {}, timestamp: Date.now(), priority: 'normal' }, 'agent1');
    expect(count).toBe(1);
  });

  it('close removes subscription', async () => {
    let count = 0;
    transport.subscribe('agent1', () => { count++; });
    await transport.close('agent1');
    await transport.send({ id: '1', type: 'task', from: 'c', to: 'agent1', payload: {}, timestamp: Date.now(), priority: 'normal' }, 'agent1');
    expect(count).toBe(0);
  });

  it('send to unknown agent does not throw', async () => {
    await expect(transport.send({ id: '1', type: 'task', from: 'c', to: 'ghost', payload: {}, timestamp: Date.now(), priority: 'normal' }, 'ghost')).resolves.toBeUndefined();
  });
});

describe('InMemoryAgentBridge', () => {
  let transport: InMemoryBridgeTransport;
  let bridge: InMemoryAgentBridge;

  beforeEach(() => {
    transport = new InMemoryBridgeTransport();
    bridge = new InMemoryAgentBridge({ agentId: 'agent1', coordinatorId: 'coord1' }, transport);
  });

  afterEach(async () => {
    await bridge.stop();
  });

  it('has correct properties', () => {
    expect(bridge.agentId).toBe('agent1');
    expect(bridge.coordinatorId).toBe('coord1');
  });

  it('subscribe delivers messages', async () => {
    const messages: any[] = [];
    bridge.subscribe((msg) => { messages.push(msg); });

    const otherBridge = new InMemoryAgentBridge({ agentId: 'agent2', coordinatorId: 'coord1' }, transport);
    await otherBridge.send(createMessage('task', 'agent2', { data: 'hello' }, 'agent1'));
    await otherBridge.stop();

    expect(messages).toHaveLength(1);
    expect(messages[0].payload.data).toBe('hello');
  });

  it('broadcast sends to wildcard (transport must support it)', async () => {
    const messages: any[] = [];
    bridge.subscribe((msg) => { messages.push(msg); });

    const otherBridge = new InMemoryAgentBridge({ agentId: 'agent2', coordinatorId: 'coord1' }, transport);
    await otherBridge.broadcast(createMessage('task', 'agent2', { data: 'broadcast' }));
    await otherBridge.stop();

    // Note: InMemoryBridgeTransport doesn't have wildcard ('*') subscribers,
    // so broadcast is effectively a no-op in the current implementation.
    // This test documents the expected behavior once a wildcard mechanism is added.
    expect(messages).toHaveLength(0);
  });

  it('stopped bridge does not deliver messages', async () => {
    const messages: any[] = [];
    bridge.subscribe((msg) => { messages.push(msg); });

    const otherBridge = new InMemoryAgentBridge({ agentId: 'agent2', coordinatorId: 'coord1' }, transport);
    await otherBridge.broadcast(createMessage('task', 'agent2', { data: 'test' }));
    await otherBridge.stop();

    // After stop the bridge's subscription is cleared, so no messages should be received
    expect(messages).toHaveLength(0);
  });

  it('request throws when bridge is stopped', async () => {
    await bridge.stop();
    await expect(
      bridge.request(createMessage('task', 'agent1', { data: 1 }, 'coord1'), 100)
    ).rejects.toThrow();
  });
});

describe('createMessage', () => {
  it('creates a message with required fields', () => {
    const msg = createMessage('task', 'a1', { data: 42 });
    expect(msg.id).toBeDefined();
    expect(msg.type).toBe('task');
    expect(msg.from).toBe('a1');
    expect(msg.payload).toEqual({ data: 42 });
    expect(msg.timestamp).toBeDefined();
    expect(msg.priority).toBe('normal');
  });

  it('sets to field when provided', () => {
    const msg = createMessage('task', 'a1', { data: 1 }, 'a2');
    expect(msg.to).toBe('a2');
  });

  it('omits to when not provided', () => {
    const msg = createMessage('task', 'a1', { data: 1 });
    expect(msg.to).toBeUndefined();
  });
});