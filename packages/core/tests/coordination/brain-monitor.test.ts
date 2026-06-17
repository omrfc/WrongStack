import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainArbiter, BrainDecision } from '../../src/coordination/brain.js';
import { DefaultBrainArbiter } from '../../src/coordination/brain.js';
import { type BrainInterventionInput, BrainMonitor } from '../../src/coordination/brain-monitor.js';
import { EventBus, type EventMap } from '../../src/kernel/events.js';
import { createTieredBrainArbiter } from '../../src/execution/autonomy-brain.js';

const STEER: BrainDecision = {
  type: 'answer',
  optionId: 'steer',
  text: 'Steer the agent with corrective guidance',
  rationale: 'Try reading the file before editing it.',
};
const CONTINUE: BrainDecision = {
  type: 'answer',
  optionId: 'continue',
  text: 'Let the agent continue unaided',
};

function failedTool(name: string): EventMap['tool.executed'] {
  return { name, durationMs: 5, ok: false, output: 'boom' };
}

function okTool(name: string): EventMap['tool.executed'] {
  return { name, durationMs: 5, ok: true };
}

/** Wait for the monitor's async engage() chain to settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('BrainMonitor', () => {
  let events: EventBus;
  let interventions: BrainInterventionInput[];
  let intervene: (input: BrainInterventionInput) => Promise<void>;

  beforeEach(() => {
    events = new EventBus();
    interventions = [];
    intervene = async (input) => {
      interventions.push(input);
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function monitor(
    brain: BrainArbiter,
    opts: Partial<ConstructorParameters<typeof BrainMonitor>[0]> = {},
  ) {
    const m = new BrainMonitor({ events, brain, intervene, ...opts });
    m.start();
    return m;
  }

  it('engages after N consecutive failures of the same tool and delivers a steer', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = monitor(brain);

    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.subject).toContain('tool failure streak');
    expect(interventions[0]?.body).toContain('Try reading the file before editing it.');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe('tool_failure_streak');
    expect(emitted[0]?.intervened).toBe(true);
    m.stop();
  });

  it('resets the streak when the tool succeeds', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = monitor(brain);

    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', okTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(0);
    m.stop();
  });

  it('tracks streaks per tool — different tools do not accumulate together', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = monitor(brain);

    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('bash'));
    events.emit('tool.executed', failedTool('grep'));
    await settle();

    expect(interventions).toHaveLength(0);
    m.stop();
  });

  it('observes without intervening when the brain chooses continue', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => CONTINUE) };
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = monitor(brain);

    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.intervened).toBe(false);
    m.stop();
  });

  it('rate-limits engagements of the same kind via cooldown', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = monitor(brain, { cooldownMs: 60_000 });

    for (let i = 0; i < 6; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(1);
    m.stop();
  });

  it('engages on an error storm within the sliding window', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = monitor(brain, { errorStormCount: 3 });

    for (let i = 0; i < 3; i++) {
      events.emit('error', { err: new Error(`boom ${i}`), phase: 'tool' });
    }
    await settle();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.kind).toBe('error_storm');
    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.subject).toContain('error storm');
    m.stop();
  });

  it('never throws when the brain itself fails', async () => {
    const brain: BrainArbiter = {
      decide: async () => {
        throw new Error('brain offline');
      },
    };
    const m = monitor(brain);

    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(0);
    m.stop();
  });

  it('reports intervened=false when steer delivery fails', async () => {
    const brain: BrainArbiter = { decide: async () => STEER };
    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = new BrainMonitor({
      events,
      brain,
      intervene: async () => {
        throw new Error('mailbox unavailable');
      },
    });
    m.start();

    for (let i = 0; i < 3; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.intervened).toBe(false);
    m.stop();
  });

  it('stop() detaches all listeners', async () => {
    const brain: BrainArbiter = { decide: vi.fn(async () => STEER) };
    const m = monitor(brain);
    m.stop();

    for (let i = 0; i < 5; i++) events.emit('tool.executed', failedTool('edit'));
    await settle();

    expect(interventions).toHaveLength(0);
  });

  it('with tiered brain: routes to LLM layer after 3 failures via ask_human fallback', async () => {
    // Mock autonomous layer that returns a real steer (simulates createAutonomyBrain)
    const LLM_STEER: BrainDecision = {
      type: 'answer',
      optionId: 'steer',
      text: 'Steer the agent with corrective guidance',
      rationale: 'The tool "edit" has failed 3 times — try a different approach.',
    };
    const mockAutonomous: BrainArbiter = { decide: vi.fn(async () => LLM_STEER) };

    // TieredBrain: DefaultBrainArbiter (policy) + mock autonomous layer
    const tieredBrain = createTieredBrainArbiter({
      policy: new DefaultBrainArbiter(),
      autonomous: mockAutonomous,
      getMaxAutoRisk: () => 'all',
    });

    const emitted: EventMap['brain.intervention'][] = [];
    events.on('brain.intervention', (e) => emitted.push(e));
    const m = new BrainMonitor({ events, brain: tieredBrain, intervene });

    m.start();
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    events.emit('tool.executed', failedTool('edit'));
    await settle();

    // Autonomous layer should have been consulted (DefaultBrain returned ask_human, tiered routed to LLM)
    expect(mockAutonomous.decide).toHaveBeenCalledOnce();
    // Intervention should be delivered
    expect(interventions).toHaveLength(1);
    expect(interventions[0]?.body).toContain('try a different approach');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.intervened).toBe(true);
    m.stop();
  });
});
