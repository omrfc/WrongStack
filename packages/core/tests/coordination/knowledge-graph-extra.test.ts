import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeGraph } from '../../src/coordination/knowledge-graph.js';

let dir: string;
let kg: KnowledgeGraph;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kg-'));
  kg = new KnowledgeGraph(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const fact = (over: Record<string, unknown> = {}) =>
  ({ type: 'fact', subject: 's', detail: 'd', category: 'general', tags: [], discoveredBy: 'a1', key: 'k', related: [], ...over }) as never;

describe('knowledge-graph — extra coverage', () => {
  it('getPendingChanges returns proposed changes; getDecisions returns decisions', async () => {
    await kg.add({ type: 'change', title: 't', description: 'd', files: [], status: 'proposed', proposedBy: 'a1', proposedAt: 'now', approvedBy: [], rejectedBy: [], votes: [], qualityGate: { passed: true, checks: [] }, satisfiesGoals: ['goal-1'] } as never);
    expect(kg.getPendingChanges()).toHaveLength(1);
    await kg.add({ type: 'decision', title: 'd1', rationale: 'because', decidedBy: 'a1', decidedAt: 'now' } as never);
    expect(kg.getDecisions()).toHaveLength(1);
  });

  it('searchFacts matches subject, detail, file and tags (case-insensitive)', async () => {
    await kg.add(fact({ subject: 'AuthFlow', detail: 'login logic' }));
    await kg.add(fact({ subject: 'other', detail: 'has TOKEN secret' }));
    await kg.add(fact({ subject: 'x', detail: 'y', file: 'src/Server.ts' }));
    await kg.add(fact({ subject: 'z', detail: 'w', tags: ['Performance'] }));
    expect(kg.searchFacts('authflow')).toHaveLength(1);
    expect(kg.searchFacts('token')).toHaveLength(1);
    expect(kg.searchFacts('server.ts')).toHaveLength(1);
    expect(kg.searchFacts('performance')).toHaveLength(1);
    expect(kg.searchFacts('nomatch')).toHaveLength(0);
  });

  it('getRelatedFacts returns related fact nodes, or [] for an unknown id', async () => {
    const a = await kg.add(fact({ subject: 'A' }));
    const b = await kg.add(fact({ subject: 'B', related: [a.id] }));
    expect(kg.getRelatedFacts(b.id).map((f) => f.id)).toEqual([a.id]);
    expect(kg.getRelatedFacts('nonexistent')).toEqual([]);
  });

  it('makeQualityGate aggregates pass/fail', () => {
    expect(KnowledgeGraph.makeQualityGate([{ name: 'a', passed: true }, { name: 'b', passed: true }]).passed).toBe(true);
    expect(KnowledgeGraph.makeQualityGate([{ name: 'a', passed: true }, { name: 'b', passed: false }]).passed).toBe(false);
  });

  it('getAll filters by assignee, discoveredBy, proposedBy and tags', async () => {
    await kg.add({ type: 'goal', title: 'g', description: '', status: 'pending', priority: 'high', assignee: 'agent-x', tags: ['ui'], createdBy: 'a', createdAt: 'now' } as never);
    await kg.add(fact({ discoveredBy: 'finder-1', tags: ['perf'] }));
    await kg.add({ type: 'change', title: 'c', description: '', files: [], status: 'proposed', proposedBy: 'proposer-1', proposedAt: 'now', approvedBy: [], rejectedBy: [], votes: [], qualityGate: { passed: true, checks: [] }, satisfiesGoals: [] } as never);
    expect(kg.getAll({ assignee: 'agent-x' })).toHaveLength(1);
    expect(kg.getAll({ discoveredBy: 'finder-1' })).toHaveLength(1);
    expect(kg.getAll({ proposedBy: 'proposer-1' })).toHaveLength(1);
    expect(kg.getAll({ tags: ['ui'] })).toHaveLength(1);
    expect(kg.getAll({ tags: ['none'] })).toHaveLength(0);
  });

  it('snapshot returns nodes and subscription count', async () => {
    await kg.add(fact());
    kg.subscribe('a1', { type: 'fact' });
    const snap = kg.snapshot();
    expect(snap.nodes).toHaveLength(1);
    expect(snap.subs).toBe(1);
  });

  it('load() rebuilds state from both plain and {op:"update"} log lines', async () => {
    const gdir = path.join(dir, '_knowledge_graph');
    await fs.mkdir(gdir, { recursive: true });
    const plain = { id: 'n1', type: 'fact', subject: 'plain', detail: 'd', category: 'general', tags: [], discoveredBy: 'a', key: 'k', related: [] };
    const updated = { op: 'update', node: { id: 'n2', type: 'fact', subject: 'updated', detail: 'd', category: 'general', tags: [], discoveredBy: 'a', key: 'k', related: [] } };
    await fs.writeFile(path.join(gdir, 'graph.jsonl'), JSON.stringify(plain) + '\n' + JSON.stringify(updated) + '\n{bad json\n', 'utf8');
    const fresh = new KnowledgeGraph(dir);
    await fresh.load();
    expect(fresh.get('n1')?.type).toBe('fact');
    expect(fresh.get('n2')?.type).toBe('fact');
  });
});
