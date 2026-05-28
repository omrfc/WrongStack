import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CheckpointManager } from '../../src/autophase/checkpoint.js';
import { PhaseStore } from '../../src/autophase/phase-store.js';
import { PhaseGraphBuilder } from '../../src/autophase/phase-graph-builder.js';

describe('CheckpointManager', () => {
  let tmpDir: string;
  let store: PhaseStore;
  let manager: CheckpointManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
    store = new PhaseStore({ baseDir: tmpDir });
    manager = new CheckpointManager({ store, maxCheckpoints: 3 });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and restore a checkpoint', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Checkpoint Test',
      phases: [
        {
          name: 'Phase A',
          description: 'A',
          priority: 'high',
          estimateHours: 2,
          parallelizable: false,
          taskTemplates: [
            { title: 'Task 1', description: 'First', type: 'feature', priority: 'high', estimateHours: 1 },
          ],
        },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    const checkpoint = await manager.saveCheckpoint(graph, 'Before risky task');
    expect(checkpoint.id).toBeDefined();
    expect(checkpoint.graphId).toBe(graph.id);
    expect(checkpoint.label).toBe('Before risky task');

    // Restore
    const restored = await manager.restoreCheckpoint(checkpoint.id);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(graph.id);
  });

  it('should list checkpoints sorted by timestamp', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'List Test',
      phases: [
        { name: 'Phase A', description: 'A', priority: 'high', estimateHours: 1, parallelizable: false },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    await manager.saveCheckpoint(graph, 'First checkpoint');
    await manager.saveCheckpoint(graph, 'Second checkpoint');

    const checkpoints = manager.listCheckpoints();
    expect(checkpoints.length).toBe(2);
    expect(checkpoints[0]!.label).toBe('Second checkpoint');
  });

  it('should prune old checkpoints when max exceeded', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Prune Test',
      phases: [
        { name: 'Phase A', description: 'A', priority: 'high', estimateHours: 1, parallelizable: false },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    // Save 5 checkpoints (max is 3)
    for (let i = 1; i <= 5; i++) {
      await manager.saveCheckpoint(graph, `Checkpoint ${i}`);
    }

    const checkpoints = manager.listCheckpoints();
    expect(checkpoints.length).toBe(3);
    expect(checkpoints[0]!.label).toBe('Checkpoint 5');
  });

  it('should delete a checkpoint', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Delete Test',
      phases: [
        { name: 'Phase A', description: 'A', priority: 'high', estimateHours: 1, parallelizable: false },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    const checkpoint = await manager.saveCheckpoint(graph, 'To be deleted');
    const deleted = manager.deleteCheckpoint(checkpoint.id);
    expect(deleted).toBe(true);

    const list = manager.listCheckpoints();
    expect(list.length).toBe(0);
  });

  it('should return null for non-existent checkpoint', async () => {
    const restored = await manager.restoreCheckpoint('non-existent-id');
    expect(restored).toBeNull();
  });
});
