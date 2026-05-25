import { describe, expect, it } from 'vitest';
import { EventBus } from '@wrongstack/core';
import {
  FleetStatusLine,
  renderFleetLine,
  type FleetAgentState,
} from '../src/fleet-statusline.js';

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function stateMap(...agents: FleetAgentState[]): Map<string, FleetAgentState> {
  return new Map(agents.map((a) => [a.id, a]));
}

describe('renderFleetLine', () => {
  it('returns empty when there are no agents', () => {
    expect(renderFleetLine(new Map(), 0, 80)).toBe('');
  });

  it('shows running/done/failed counts and per-agent detail', () => {
    const states = stateMap(
      { id: 'a', name: 'Debugger', status: 'running', iterations: 25, toolCalls: 14, lastTool: 'bash', startedAt: 0 },
      { id: 'b', name: 'E2E', status: 'done', iterations: 8, toolCalls: 3, startedAt: 0, endedAt: 5000 },
    );
    const line = strip(renderFleetLine(states, 62_000, 200));
    expect(line).toContain('fleet');
    expect(line).toContain('▶1');
    expect(line).toContain('✓1');
    expect(line).toContain('Debugger');
    expect(line).toContain('1m02s');
    expect(line).toContain('L25');
    expect(line).toContain('14t');
    expect(line).toContain('bash');
  });

  it('prefixes a WS version chip when version is provided', () => {
    const states = stateMap(
      { id: 'a', name: 'Debugger', status: 'running', iterations: 1, toolCalls: 0, startedAt: 0 },
    );
    const line = strip(renderFleetLine(states, 1000, 200, '0.7.0'));
    expect(line).toContain('WS v0.7.0');
    // The version chip leads the line, before the fleet counts.
    expect(line.indexOf('WS v0.7.0')).toBeLessThan(line.indexOf('fleet'));
  });

  it('omits the version chip when version is not provided', () => {
    const states = stateMap(
      { id: 'a', name: 'Debugger', status: 'running', iterations: 1, toolCalls: 0, startedAt: 0 },
    );
    expect(strip(renderFleetLine(states, 1000, 200))).not.toContain('WS v');
  });

  it('renders a ⚡N extension badge for an agent that self-extended', () => {
    const states = stateMap(
      { id: 'a', name: 'Debugger', status: 'running', iterations: 5, toolCalls: 20, extensions: 3, startedAt: 0 },
    );
    const line = strip(renderFleetLine(states, 1000, 200));
    expect(line).toContain('⚡3');
  });

  it('omits the extension badge when an agent has not extended', () => {
    const states = stateMap(
      { id: 'a', name: 'Debugger', status: 'running', iterations: 5, toolCalls: 20, startedAt: 0 },
    );
    expect(strip(renderFleetLine(states, 1000, 200))).not.toContain('⚡');
  });

  it('caps the line to terminal width', () => {
    const many: FleetAgentState[] = Array.from({ length: 6 }, (_, i) => ({
      id: `a${i}`,
      name: `LongAgentName${i}`,
      status: 'running' as const,
      iterations: 100,
      toolCalls: 50,
      lastTool: 'typecheck',
      startedAt: 0,
    }));
    const line = renderFleetLine(stateMap(...many), 1000, 40);
    expect(strip(line).length).toBeLessThanOrEqual(40);
  });
});

class FakeTty {
  isTTY = true;
  rows = 24;
  columns = 80;
  writes: string[] = [];
  private handlers = new Map<string, Array<(...a: unknown[]) => void>>();
  write(s: string): boolean {
    this.writes.push(s);
    return true;
  }
  on(ev: string, fn: (...a: unknown[]) => void): this {
    const arr = this.handlers.get(ev) ?? [];
    arr.push(fn);
    this.handlers.set(ev, arr);
    return this;
  }
  off(): this {
    return this;
  }
  all(): string {
    return this.writes.join('');
  }
}

describe('FleetStatusLine', () => {
  it('activates a scroll region on spawn and paints agent state', () => {
    const events = new EventBus();
    const out = new FakeTty();
    const sl = new FleetStatusLine({ events, out: out as unknown as NodeJS.WriteStream });
    sl.start();

    events.emit('subagent.spawned', { subagentId: 's1', taskId: 't1', name: 'Debugger' });
    events.emit('subagent.tool_executed', { subagentId: 's1', name: 'bash', durationMs: 5, ok: true });

    const all = out.all();
    // Scroll region set to rows-1.
    expect(all).toContain('\x1b[1;23r');
    // Status line painted at the bottom row.
    expect(all).toContain('\x1b[24;1H');
    expect(strip(all)).toContain('Debugger');
    sl.stop();
  });

  it('surfaces a budget_extended event as a ⚡N badge', () => {
    const events = new EventBus();
    const out = new FakeTty();
    const sl = new FleetStatusLine({ events, out: out as unknown as NodeJS.WriteStream, throttleMs: 0 });
    sl.start();
    events.emit('subagent.spawned', { subagentId: 's1', taskId: 't1', name: 'Debugger' });
    events.emit('subagent.budget_extended', { subagentId: 's1', kind: 'timeout', newLimit: 480000, totalExtensions: 2 });
    expect(strip(out.all())).toContain('⚡2');
    sl.stop();
  });

  it('restores the scroll region on stop', () => {
    const events = new EventBus();
    const out = new FakeTty();
    const sl = new FleetStatusLine({ events, out: out as unknown as NodeJS.WriteStream });
    sl.start();
    events.emit('subagent.spawned', { subagentId: 's1', taskId: 't1', name: 'X' });
    out.writes.length = 0;
    sl.stop();
    // Reset scroll region escape.
    expect(out.all()).toContain('\x1b[r');
  });

  it('is a no-op on a non-TTY stream', () => {
    const events = new EventBus();
    const out = new FakeTty();
    out.isTTY = false;
    const sl = new FleetStatusLine({ events, out: out as unknown as NodeJS.WriteStream });
    sl.start();
    events.emit('subagent.spawned', { subagentId: 's1', taskId: 't1', name: 'X' });
    expect(out.writes.length).toBe(0);
    sl.stop();
  });
});
