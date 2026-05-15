import { describe, expect, it } from 'vitest';
import { renderRunningTools } from '../src/app.js';

describe('renderRunningTools', () => {
  it('returns empty string when nothing is running', () => {
    expect(renderRunningTools(new Map())).toBe('');
  });

  it('shows the running tool name + elapsed seconds for a single in-flight tool', () => {
    const m = new Map([['t1', { name: 'bash', startedAt: Date.now() - 2_500 }]]);
    const out = renderRunningTools(m);
    expect(out).toMatch(/^running: bash \d+\.\ds$/);
  });

  it('picks the oldest by startedAt when multiple are running', () => {
    const m = new Map([
      ['t1', { name: 'bash', startedAt: Date.now() - 2_500 }],
      ['t2', { name: 'read', startedAt: Date.now() - 500 }],
    ]);
    const out = renderRunningTools(m);
    expect(out).toMatch(/^running: bash \d+\.\ds \(\+1\)$/);
  });

  it('appends (+N) when more than one tool is running', () => {
    const now = Date.now();
    const m = new Map([
      ['t1', { name: 'bash', startedAt: now - 1000 }],
      ['t2', { name: 'read', startedAt: now - 500 }],
      ['t3', { name: 'fetch', startedAt: now - 250 }],
    ]);
    const out = renderRunningTools(m);
    expect(out).toMatch(/^running: bash \d+\.\ds \(\+2\)$/);
  });
});
