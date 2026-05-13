import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/kernel/events.js';

describe('EventBus', () => {
  it('emits to subscribers', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('session.started', fn);
    bus.emit('session.started', { id: 'abc' });
    expect(fn).toHaveBeenCalledWith({ id: 'abc' });
  });

  it('emits to multiple event types', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('session.started', a);
    bus.on('tool.executed', b);
    bus.emit('session.started', { id: '1' });
    bus.emit('tool.executed', { name: 'test', durationMs: 100, ok: true });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('multiple subscribers each receive', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('session.started', a);
    bus.on('session.started', b);
    bus.emit('session.started', { id: '1' });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('off unsubscribes', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('session.started', fn);
    bus.off('session.started', fn);
    bus.emit('session.started', { id: '1' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('listener errors are isolated', () => {
    const bus = new EventBus();
    bus.setLogger({ error: () => undefined });
    const good = vi.fn();
    bus.on('session.started', () => {
      throw new Error('bad');
    });
    bus.on('session.started', good);
    bus.emit('session.started', { id: '1' });
    expect(good).toHaveBeenCalled();
  });

  it('unsubscribe returned from on()', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.on('session.started', fn);
    off();
    bus.emit('session.started', { id: '1' });
    expect(fn).not.toHaveBeenCalled();
  });

  describe('once', () => {
    it('fires listener only once', () => {
      const bus = new EventBus();
      const fn = vi.fn();
      bus.once('session.started', fn);
      bus.emit('session.started', { id: '1' });
      bus.emit('session.started', { id: '2' });
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith({ id: '1' });
    });

    it('returns unsubscribe that prevents firing', () => {
      const bus = new EventBus();
      const fn = vi.fn();
      const off = bus.once('session.started', fn);
      off();
      bus.emit('session.started', { id: '1' });
      expect(fn).not.toHaveBeenCalled();
    });

    it('unsubscribes after first call even without explicit off', () => {
      const bus = new EventBus();
      const fn = vi.fn();
      bus.once('iteration.completed', fn);
      bus.emit('iteration.completed', { ctx: null as any, index: 1 });
      bus.emit('iteration.completed', { ctx: null as any, index: 2 });
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes from correct event only', () => {
      const bus = new EventBus();
      const fn = vi.fn();
      bus.once('session.started', fn);
      bus.emit('session.started', { id: '1' });
      // other event type should not trigger
      bus.emit('tool.executed', { name: 'x', durationMs: 0, ok: true });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('clear', () => {
    it('removes all listeners', () => {
      const bus = new EventBus();
      const a = vi.fn();
      const b = vi.fn();
      bus.on('session.started', a);
      bus.on('tool.executed', b);
      bus.clear();
      bus.emit('session.started', { id: '1' });
      bus.emit('tool.executed', { name: 'x', durationMs: 0, ok: true });
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });

    it('clearing empty bus is fine', () => {
      const bus = new EventBus();
      expect(() => bus.clear()).not.toThrow();
    });
  });

  it('does not throw when emitting to empty event', () => {
    const bus = new EventBus();
    expect(() => bus.emit('error', { err: new Error('test'), phase: 'test' })).not.toThrow();
  });

  it('setLogger accepts logger', () => {
    const bus = new EventBus();
    expect(() => bus.setLogger({ error: () => {} })).not.toThrow();
  });

  it('emits error event with error and phase', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('error', fn);
    const err = new Error('boom');
    bus.emit('error', { err, phase: 'execution' });
    expect(fn).toHaveBeenCalledWith({ err, phase: 'execution' });
  });
});
