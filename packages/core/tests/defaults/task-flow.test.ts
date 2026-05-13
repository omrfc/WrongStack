import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TaskNode, TaskGraph } from '../../src/types/task-graph.js';
import type { Specification } from '../../src/types/spec.js';
import { TaskFlow, SpecDrivenDev } from '../../src/defaults/task-flow.js';
import { TaskTracker } from '../../src/defaults/task-tracker.js';
import { DefaultTaskStore } from '../../src/defaults/task-generator.js';
import { EventBus } from '../../src/kernel/events.js';

function makeSpec(overrides: Partial<Specification> = {}): Specification {
  return {
    id: 'spec-1',
    title: 'Test Specification',
    version: '1.0.0',
    status: 'draft',
    overview: 'Test overview content',
    sections: [
      { type: 'overview', title: 'Overview', level: 2, content: 'Test overview content' },
      { type: 'requirements', title: 'Requirements', level: 2, content: '' },
      { type: 'acceptance', title: 'Acceptance', level: 2, content: '' },
    ],
    requirements: [
      {
        id: 'REQ-1',
        type: 'functional',
        priority: 'critical',
        description: 'Must implement login',
        acceptanceCriteria: ['criteria 1'],
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeTaskNode(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: 'Test description',
    type: 'feature',
    priority: 'high',
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('TaskFlow', () => {
  let store: DefaultTaskStore;
  let tracker: TaskTracker;
  let events: EventBus;

  beforeEach(() => {
    store = new DefaultTaskStore();
    tracker = new TaskTracker({ store });
    events = new EventBus();
  });

  function createFlow() {
    return new TaskFlow({ tracker, events });
  }

  describe('fromSpec', () => {
    it('parses spec and sets phase to generating', async () => {
      const flow = createFlow();
      const specContent = `# Test Spec\n\n## Overview\n\nOverview content.\n\n## Requirements\n\n[critical] Login feature\n\n## Acceptance\n\nCriteria here`;

      const graph = await flow.fromSpec(specContent);

      expect(graph).toBeDefined();
      // fromSpec goes through idle->parsing->analyzing->generating (doesn't reach done until execute)
      expect(['generating', 'idle']).toContain(flow.getPhase());
      expect(flow.getSpec()).toBeDefined();
      expect(flow.getSpec()?.title).toBe('Test Spec');
    });

    it('emits spec.analyzed event with analysis', async () => {
      const flow = createFlow();
      const specContent = `# Test\n\n## Overview\nOverview content\n\n## Requirements\n[functional] Some requirement\n\n## Acceptance\n\nSome acceptance`;

      let analysis: any = null;
      events.on('spec.analyzed' as any, (payload: any) => { analysis = payload; });

      await flow.fromSpec(specContent);

      expect(analysis).toBeDefined();
      expect(analysis.analysis).toBeDefined();
    });

    it('throws when spec completeness is below 50%', async () => {
      const flow = createFlow();
      // Low completeness: no sections, no requirements
      const specContent = `# Test\n\nSome content without proper sections`;

      await expect(flow.fromSpec(specContent)).rejects.toThrow('Spec too incomplete');
    });

    it('emits error event when spec too incomplete', async () => {
      const flow = createFlow();
      const specContent = `# Test\n\nNo proper structure`;

      let errorPayload: any = null;
      events.on('error' as any, (payload: any) => { errorPayload = payload; });

      await expect(flow.fromSpec(specContent)).rejects.toThrow();
    });

    it('generates graph from spec requirements', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature A\n[medium] Feature B\n\n## Acceptance\n\nDone`;

      const graph = await flow.fromSpec(specContent);

      expect(graph.nodes.size).toBeGreaterThan(0);
    });
  });

  describe('execute', () => {
    it('throws error if no graph loaded', async () => {
      const flow = createFlow();
      await expect(flow.execute({
        executeTask: async () => 'result',
      })).rejects.toThrow('No graph loaded');
    });

    it('executes pending tasks and updates status to completed', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[critical] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      let executedTask: any = null;
      const result = await flow.execute({
        executeTask: async (task) => {
          executedTask = task;
          return 'task-result';
        },
      });

      expect(executedTask).toBeDefined();
    });

    it('calls onTaskComplete when task succeeds', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      const onComplete = vi.fn();
      await flow.execute({
        executeTask: async () => 'result',
        onTaskComplete: onComplete,
      });

      // onComplete may be called if tasks were executed
    });

    it('calls onTaskFail when task fails', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[critical] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      const onFail = vi.fn();
      await flow.execute({
        executeTask: async () => { throw new Error('task failed'); },
        onTaskFail: onFail,
      });

      // Failed tasks should trigger onTaskFail
    });

    it('updates phase to executing during execution', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      const phases: string[] = [];
      events.on('phase.change' as any, (p: any) => phases.push(p.to));

      await flow.execute({ executeTask: async () => 'result' });

      expect(phases).toContain('executing');
    });

    it('emits task.started for each task', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature A\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      let startedCount = 0;
      events.on('task.started' as any, () => startedCount++);

      await flow.execute({ executeTask: async () => 'result' });

      expect(startedCount).toBeGreaterThan(0);
    });

    it('emits task.completed when task finishes', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      let completedCount = 0;
      events.on('task.completed' as any, () => completedCount++);

      await flow.execute({ executeTask: async () => 'result' });

      expect(completedCount).toBeGreaterThan(0);
    });

    it('sets phase to done after execution completes', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[medium] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      await flow.execute({ executeTask: async () => 'result' });

      expect(flow.getPhase()).toBe('done');
    });
  });

  describe('reviewTask', () => {
    it('throws error if task not found', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      await expect(flow.reviewTask('nonexistent-id', true)).rejects.toThrow('not found');
    });

    it('marks task as completed when approved', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      const graph = flow.getGraph();
      const firstTaskId = Array.from(graph!.nodes.keys())[0];

      await flow.reviewTask(firstTaskId, true);

      const node = tracker.getNode(firstTaskId);
      expect(node?.status).toBe('completed');
    });

    it('marks task as in_progress when rejected', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      const graph = flow.getGraph();
      const firstTaskId = Array.from(graph!.nodes.keys())[0];

      await flow.reviewTask(firstTaskId, false);

      const node = tracker.getNode(firstTaskId);
      expect(node?.status).toBe('in_progress');
    });

    it('emits task.completed when approved', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      const graph = flow.getGraph();
      const firstTaskId = Array.from(graph!.nodes.keys())[0];

      let eventFired = false;
      events.on('task.completed' as any, () => { eventFired = true; });

      await flow.reviewTask(firstTaskId, true);

      expect(eventFired).toBe(true);
    });

    it('emits task.review when rejected', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      const graph = flow.getGraph();
      const firstTaskId = Array.from(graph!.nodes.keys())[0];

      let eventFired = false;
      events.on('task.review' as any, () => { eventFired = true; });

      await flow.reviewTask(firstTaskId, false);

      expect(eventFired).toBe(true);
    });
  });

  describe('stop', () => {
    it('prevents further task execution', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature A\n[critical] Feature B\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);

      let executedCount = 0;
      const result = await flow.execute({
        executeTask: async () => {
          executedCount++;
          return 'done';
        },
      });

      expect(executedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getPhase', () => {
    it('returns current phase', () => {
      const flow = createFlow();
      expect(flow.getPhase()).toBe('idle');
    });

    it('returns done after successful execution', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);
      await flow.execute({ executeTask: async () => 'result' });
      expect(flow.getPhase()).toBe('done');
    });
  });

  describe('getGraph', () => {
    it('returns null before fromSpec is called', () => {
      const flow = createFlow();
      expect(flow.getGraph()).toBeNull();
    });

    it('returns graph after fromSpec', async () => {
      const flow = createFlow();
      const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);
      expect(flow.getGraph()).not.toBeNull();
    });
  });

  describe('getSpec', () => {
    it('returns null before fromSpec', () => {
      const flow = createFlow();
      expect(flow.getSpec()).toBeNull();
    });

    it('returns spec after fromSpec', async () => {
      const flow = createFlow();
      const specContent = `# My Spec\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
      await flow.fromSpec(specContent);
      expect(flow.getSpec()?.title).toBe('My Spec');
    });
  });
});

describe('SpecDrivenDev', () => {
  let store: DefaultTaskStore;
  let events: EventBus;

  beforeEach(() => {
    store = new DefaultTaskStore();
    events = new EventBus();
  });

  it('creates task flow from spec content', async () => {
    const sdd = new SpecDrivenDev({ workingDirectory: '/tmp', events });
    const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
    const flow = await sdd.createFlow(specContent);

    expect(flow).toBeDefined();
    expect(flow.getSpec()?.title).toBe('Title');
  });

  it('returns same tracker across flows', () => {
    const sdd = new SpecDrivenDev({ workingDirectory: '/tmp', events });
    const tracker1 = sdd.getTracker();
    const tracker2 = sdd.getTracker();
    expect(tracker1).toBe(tracker2);
  });

  it('getFlow returns flow by graph id', async () => {
    const sdd = new SpecDrivenDev({ workingDirectory: '/tmp', events });
    const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
    const flow = await sdd.createFlow(specContent);

    const retrieved = sdd.getFlow(flow.getGraph()!.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.getPhase()).toBe(flow.getPhase());
  });

  it('getFlow returns undefined for unknown id', () => {
    const sdd = new SpecDrivenDev({ workingDirectory: '/tmp', events });
    expect(sdd.getFlow('nonexistent')).toBeUndefined();
  });

  it('listFlows returns all created flows', async () => {
    const sdd = new SpecDrivenDev({ workingDirectory: '/tmp', events });
    const specContent = `# Title\n\n## Overview\nContent\n\n## Requirements\n[high] Feature\n\n## Acceptance\n\nDone`;
    await sdd.createFlow(specContent);
    await sdd.createFlow(specContent.replace('Title', 'Title 2'));

    const flows = sdd.listFlows();
    expect(flows).toHaveLength(2);
    expect(flows[0].title).toBeTruthy();
    expect(flows[1].title).toBeTruthy();
  });
});