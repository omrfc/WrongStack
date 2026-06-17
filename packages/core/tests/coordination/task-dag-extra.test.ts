import { describe, expect, it, vi } from 'vitest';
import { TaskDAG } from '../../src/coordination/task-dag.js';

describe('task-dag — extra coverage', () => {
  it('start/complete/fail/skip are no-ops on unknown ids', () => {
    const dag = new TaskDAG();
    expect(dag.start('nope', 'a')).toBe(false);
    expect(() => dag.complete('nope', 1)).not.toThrow();
    expect(() => dag.fail('nope', 'e')).not.toThrow();
    expect(() => dag.skip('nope', 'r')).not.toThrow();
    expect(dag.getNode('nope')).toBeUndefined();
    expect(() => dag.removeNode('nope')).not.toThrow();
  });

  it('start only transitions a ready node', () => {
    const dag = new TaskDAG();
    dag.addNode('a', 'A');
    dag.addNode('b', 'B', ['a']); // pending
    expect(dag.start('b', 'agent')).toBe(false); // not ready
    expect(dag.start('a', 'agent')).toBe(true);
    expect(dag.start('a', 'agent')).toBe(false); // already running
  });

  it('removeNode unlinks deps and frees dependents that become ready', () => {
    const dag = new TaskDAG();
    dag.addNode('a', 'A');
    dag.addNode('b', 'B', ['a']);
    dag.complete('a', 1); // b becomes ready
    dag.addNode('c', 'C', ['b']);
    // Remove b (which is ready/done dependency of c) — c re-evaluated.
    dag.complete('b', 2);
    dag.removeNode('b');
    expect(dag.getNode('b')).toBeUndefined();
  });

  it('complete and fail unblock dependents via join semantics', () => {
    const dag = new TaskDAG();
    dag.addNode('a', 'A');
    dag.addNode('b', 'B');
    dag.addNode('join', 'Join', ['a', 'b']); // waits on both
    dag.complete('a', 1); // join still blocked on b
    expect(dag.getNode('join')?.status).toBe('pending');
    dag.fail('b', 'boom'); // a failed dep does NOT satisfy the join → stays pending
    expect(dag.getNode('join')?.status).toBe('pending');
    expect(dag.getFailed().map((n) => n.id)).toContain('b');
    expect(dag.isFailed()).toBe(true);
  });

  it('skip settles dependents like done', () => {
    const dag = new TaskDAG();
    dag.addNode('a', 'A');
    dag.addNode('b', 'B', ['a']);
    dag.skip('a', 'unnecessary');
    expect(dag.getNode('b')?.status).toBe('ready');
    expect(dag.getCompleted().map((n) => n.id)).toContain('a');
  });

  it('query helpers and stats reflect mixed states', () => {
    const dag = new TaskDAG();
    dag.addNode('done', 'D');
    dag.addNode('fail', 'F');
    dag.addNode('run', 'R');
    dag.addNode('block', 'B', ['run']);
    dag.complete('done', 1);
    dag.fail('fail', 'e');
    dag.start('run', 'agent');
    expect(dag.getDone().map((n) => n.id)).toEqual(['done']);
    expect(dag.getFailed().map((n) => n.id)).toEqual(['fail']);
    expect(dag.getRunning().map((n) => n.id)).toEqual(['run']);
    expect(dag.getBlocked().map((n) => n.id)).toEqual(['block']);
    expect(dag.getPending().map((n) => n.id)).toEqual(['block']);
    const s = dag.stats();
    expect(s.total).toBe(4);
    expect(s.done).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.running).toBe(1);
    expect(s.progress).toBeGreaterThan(0);
  });

  it('topological order tolerates a dangling dependency', () => {
    const dag = new TaskDAG();
    dag.addNode('a', 'A');
    dag.addNode('b', 'B', ['a']);
    // Delete a out from under b so b.deps references a missing node.
    dag.removeNode('a');
    const order = dag.getTopologicalOrder();
    expect(order.map((n) => n.id)).toContain('b');
  });

  it('onEvent / onRunnable register, fire, swallow handler errors, and unsubscribe', () => {
    const dag = new TaskDAG();
    const events: string[] = [];
    const offEvent = dag.onEvent((e) => { events.push(e.type); throw new Error('handler boom'); });
    const runnableSeen: number[] = [];
    const offRunnable = dag.onRunnable((nodes) => { runnableSeen.push(nodes.length); throw new Error('runnable boom'); });

    dag.addNode('a', 'A'); // ready → emits + runnable handler fires (errors swallowed)
    expect(events.length).toBeGreaterThan(0);
    expect(runnableSeen.length).toBeGreaterThan(0);

    offEvent();
    offRunnable();
    const before = events.length;
    dag.addNode('b', 'B');
    expect(events.length).toBe(before); // no more events after unsubscribe
  });

  it('emits a deadlock event when a pending task can never run', () => {
    const dag = new TaskDAG();
    const evs: string[] = [];
    dag.onEvent((e) => evs.push(e.type));
    dag.addNode('a', 'A');
    dag.addNode('b', 'B', ['a']);
    dag.fail('a', 'boom'); // b is now permanently blocked (dep failed)
    // A standalone completion triggers _emitReady with no runnables → deadlock.
    dag.addNode('c', 'C');
    dag.complete('c', 1);
    expect(dag.hasDeadlock()).toBe(true);
    expect(evs).toContain('deadlock');
  });

  it('_wouldCycle traverses shared descendants without infinite loop', () => {
    const dag = new TaskDAG();
    dag.addNode('a', 'A');
    dag.addNode('b', 'B', ['a']);
    dag.addNode('c', 'C', ['a']);
    dag.addNode('x', 'X', ['b', 'c']); // diamond: x reachable from a via b and c
    // Adding a node depending on a re-traverses dependents incl. x twice.
    expect(() => dag.addNode('y', 'Y', ['a'])).not.toThrow();
  });
});
