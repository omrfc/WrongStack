import { describe, expect, it } from 'vitest';
import { makeLlmSubtaskGenerator } from '../../src/sdd/decompose-task.js';
import type { TaskNode } from '../../src/types/task-graph.js';

const task = (): TaskNode => ({
  id: 't1',
  title: 'Build the whole feature',
  description: 'Everything at once',
  type: 'feature',
  priority: 'high',
  status: 'failed',
  createdAt: 0,
  updatedAt: 0,
});

const info = () => ({ task: task(), error: 'boom' });

describe('makeLlmSubtaskGenerator', () => {
  it('parses a ```json fenced array into validated specs', async () => {
    const gen = makeLlmSubtaskGenerator({
      run: async () =>
        'Sure:\n```json\n[{"title":"A","description":"da","type":"bugfix","priority":"high"},{"title":"B","description":"db"}]\n```',
    });
    const out = await gen(info());
    expect(out).toEqual([
      { title: 'A', description: 'da', type: 'bugfix', priority: 'high' },
      { title: 'B', description: 'db', type: undefined, priority: undefined },
    ]);
  });

  it('parses a bare JSON array (no fence)', async () => {
    const gen = makeLlmSubtaskGenerator({
      run: async () => 'noise [{"title":"A","description":"da"},{"title":"B","description":"db"}] trailing',
    });
    expect((await gen(info())).map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('drops malformed entries and rejects unknown enums', async () => {
    const gen = makeLlmSubtaskGenerator({
      run: async () =>
        '[{"title":"A","description":"da","type":"nonsense","priority":"urgent"},{"title":"","description":"x"},{"title":"C","description":"dc"}]',
    });
    const out = await gen(info());
    // A kept (bad type/priority cleared), empty-title dropped, C kept → 2 valid.
    expect(out).toEqual([
      { title: 'A', description: 'da', type: undefined, priority: undefined },
      { title: 'C', description: 'dc', type: undefined, priority: undefined },
    ]);
  });

  it('returns [] when fewer than minSubtasks valid items (no self-split)', async () => {
    const gen = makeLlmSubtaskGenerator({
      run: async () => '[{"title":"Only one","description":"d"}]',
    });
    expect(await gen(info())).toEqual([]);
  });

  it('caps at maxSubtasks', async () => {
    const items = Array.from({ length: 9 }, (_, i) => `{"title":"T${i}","description":"d${i}"}`);
    const gen = makeLlmSubtaskGenerator({ run: async () => `[${items.join(',')}]`, maxSubtasks: 3 });
    expect((await gen(info())).length).toBe(3);
  });

  it('returns [] on parse failure or runner throw', async () => {
    expect(await makeLlmSubtaskGenerator({ run: async () => 'no json here' })(info())).toEqual([]);
    expect(await makeLlmSubtaskGenerator({ run: async () => '[not, valid, json' })(info())).toEqual([]);
    expect(
      await makeLlmSubtaskGenerator({
        run: async () => {
          throw new Error('llm down');
        },
      })(info()),
    ).toEqual([]);
  });
});
