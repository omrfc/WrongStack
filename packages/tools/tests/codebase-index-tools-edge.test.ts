import type { Context } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Control the index host's reported state so each status-gate branch of the
// three codebase tools runs without a real SQLite index / worker.
type Circuit = { state: string; cooldownRemainingMs: number; lastFailure?: string };
const state: {
  ready: boolean;
  indexing: boolean;
  currentFile: number;
  totalFiles: number;
  lastError?: string;
  circuit: Circuit;
} = { ready: true, indexing: false, currentFile: 0, totalFiles: 0, circuit: { state: 'closed', cooldownRemainingMs: 0 } };

let isIndexingValue = false;
const statsValue = {
  totalSymbols: 5,
  totalFiles: 2,
  byLang: { ts: 5 },
  byKind: { function: 5 },
  lastIndexed: 1,
  sizeBytes: 100,
  indexPath: '/x',
  version: 1,
};
let circuitSnapshot: Circuit = { state: 'closed', cooldownRemainingMs: 0 };

vi.mock('../src/codebase-index/background-indexer.js', () => ({
  getIndexState: () => state,
  isIndexing: () => isIndexingValue,
  codebaseIndexStats: async () => statsValue,
  runStartupIndex: async () => ({
    filesIndexed: 1,
    symbolsIndexed: 1,
    langStats: {},
    durationMs: 1,
    errors: [],
  }),
}));

vi.mock('../src/codebase-index/circuit-breaker.js', () => ({
  indexCircuitBreaker: { snapshot: () => circuitSnapshot },
}));

import { codebaseIndexTool } from '../src/codebase-index/codebase-index-tool.js';
import { codebaseSearchTool } from '../src/codebase-index/codebase-search-tool.js';
import { codebaseStatsTool } from '../src/codebase-index/codebase-stats-tool.js';

const ctx = () => ({ cwd: '/p', projectRoot: '/p', tools: [], meta: {} }) as unknown as Context;
const opts = () => ({ signal: new AbortController().signal });

beforeEach(() => {
  state.ready = true;
  state.indexing = false;
  state.currentFile = 0;
  state.totalFiles = 0;
  state.lastError = undefined;
  state.circuit = { state: 'closed', cooldownRemainingMs: 0 };
  isIndexingValue = false;
  circuitSnapshot = { state: 'closed', cooldownRemainingMs: 0 };
});
afterEach(() => vi.restoreAllMocks());

describe('codebase-index tool gates', () => {
  it('reports when an index is already in progress', async () => {
    isIndexingValue = true;
    const out = await codebaseIndexTool.execute({}, ctx(), opts());
    expect(out.note).toMatch(/already in progress/);
  });

  it('reports when the circuit breaker is open', async () => {
    circuitSnapshot = { state: 'open', cooldownRemainingMs: 5000, lastFailure: 'boom' };
    const out = await codebaseIndexTool.execute({}, ctx(), opts());
    expect(out.note).toMatch(/paused after repeated failures/);
  });

  it('runs the indexer when not gated', async () => {
    const out = await codebaseIndexTool.execute({}, ctx(), opts());
    expect(out.filesIndexed).toBe(1);
  });
});

describe('codebase-stats tool gates', () => {
  it('reports "not yet built" when the index is not ready', async () => {
    state.ready = false;
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toMatch(/not yet built/);
  });

  it('reports indexing-in-progress when not ready but indexing', async () => {
    state.ready = false;
    state.indexing = true;
    state.currentFile = 3;
    state.totalFiles = 10;
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toMatch(/Indexing in progress/);
  });

  it('reports refresh-in-progress when ready and indexing', async () => {
    state.indexing = true;
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toMatch(/refresh in progress/);
  });

  it('appends a paused note when the circuit is open', async () => {
    state.circuit = { state: 'open', cooldownRemainingMs: 3000, lastFailure: 'x' };
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.indexStatus).toMatch(/paused after repeated failures/);
    expect(out.totalSymbols).toBe(5);
  });

  it('returns plain stats when ready and healthy', async () => {
    const out = await codebaseStatsTool.execute({}, ctx(), opts());
    expect(out.totalSymbols).toBe(5);
    expect(out.indexStatus).toBeUndefined();
  });
});

describe('codebase-search tool gates', () => {
  it('reports "not yet built" when not ready', async () => {
    state.ready = false;
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/not yet built/);
  });

  it('reports indexing-in-progress when not ready but indexing', async () => {
    state.ready = false;
    state.indexing = true;
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/Indexing in progress/);
  });

  it('reports refresh-in-progress when ready and indexing', async () => {
    state.indexing = true;
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/refresh in progress/);
  });

  it('reports a build failure with a circuit-open retry hint', async () => {
    state.lastError = 'disk full';
    state.circuit = { state: 'open', cooldownRemainingMs: 2000 };
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/Index build failed.*circuit open/s);
  });

  it('reports a build failure with a plain retry hint when the circuit is closed', async () => {
    state.lastError = 'parse error';
    const out = await codebaseSearchTool.execute({ query: 'q' }, ctx(), opts());
    expect(out.indexStatus).toMatch(/Try \/codebase-reindex/);
  });
});
