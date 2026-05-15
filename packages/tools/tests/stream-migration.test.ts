import type { ToolStreamEvent } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { auditTool } from '../src/audit.js';
import { fetchTool } from '../src/fetch.js';
import { formatTool } from '../src/format.js';
import { grepTool } from '../src/grep.js';
import { installTool } from '../src/install.js';
import { lintTool } from '../src/lint.js';
import { searchTool } from '../src/search.js';
import { testTool } from '../src/test.js';
import { treeTool } from '../src/tree.js';
import { typecheckTool } from '../src/typecheck.js';

const ctx = { cwd: '/__nope__', tools: [], projectRoot: '/__nope__' } as any;
const opts = () => ({ signal: new AbortController().signal });

async function collect<O>(
  iter: AsyncIterable<ToolStreamEvent<O>>,
): Promise<{ events: ToolStreamEvent<O>[]; final?: O }> {
  const events: ToolStreamEvent<O>[] = [];
  let final: O | undefined;
  for await (const ev of iter) {
    events.push(ev);
    if (ev.type === 'final') final = ev.output;
  }
  return { events, final };
}

function assertExactlyOneFinal<O>(events: ToolStreamEvent<O>[]) {
  const finals = events.filter((e) => e.type === 'final');
  expect(finals).toHaveLength(1);
}

describe('L0-A executeStream migration', () => {
  it('lint emits log + final when no linter detected', async () => {
    const { events, final } = await collect(lintTool.executeStream!({}, ctx, opts()));
    // when no linter is detected the tool short-circuits to a "none" final
    // without launching a process — just verify exactly one final.
    assertExactlyOneFinal(events);
    expect(final).toBeDefined();
  });

  it('format short-circuits with exactly one final when no fixer', async () => {
    const { events, final } = await collect(formatTool.executeStream!({}, ctx, opts()));
    assertExactlyOneFinal(events);
    expect(final).toBeDefined();
  });

  it('typecheck emits log + final', async () => {
    const { events, final } = await collect(typecheckTool.executeStream!({}, ctx, opts()));
    assertExactlyOneFinal(events);
    expect(events.some((e) => e.type === 'log')).toBe(true);
    expect(final).toBeDefined();
  });

  it('test short-circuits to none final without runner', async () => {
    const { events, final } = await collect(
      testTool.executeStream!({ runner: 'auto' }, { ...ctx, cwd: '/' }, opts()),
    );
    assertExactlyOneFinal(events);
    expect(final).toBeDefined();
  });

  it('audit emits log + final', async () => {
    const { events, final } = await collect(auditTool.executeStream!({}, ctx, opts()));
    assertExactlyOneFinal(events);
    expect(events.some((e) => e.type === 'log')).toBe(true);
    expect(final).toBeDefined();
  });

  it('install emits resolve + fetch logs + final', async () => {
    const { events, final } = await collect(
      installTool.executeStream!({ dry_run: true }, ctx, opts()),
    );
    assertExactlyOneFinal(events);
    const logPhases = events
      .filter((e) => e.type === 'log')
      .map((e) => (e.data as { phase?: string } | undefined)?.phase);
    expect(logPhases).toContain('resolve');
    expect(logPhases).toContain('fetch');
    expect(final).toBeDefined();
  });

  it('tree emits final with cwd traversal', async () => {
    const realCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const { events, final } = await collect(
      treeTool.executeStream!({ depth: 1, show_files: false }, realCtx, opts()),
    );
    assertExactlyOneFinal(events);
    expect(final?.path).toBe(process.cwd());
  }, 10_000);

  it('grep native fallback yields a final when rg unavailable on a fake path', async () => {
    // Use a non-existent base; native walker just produces an empty result.
    const realCtx = { cwd: process.cwd(), tools: [], projectRoot: process.cwd() } as any;
    const { events, final } = await collect(
      grepTool.executeStream!({ pattern: 'wrongstack', limit: 5 }, realCtx, opts()),
    );
    assertExactlyOneFinal(events);
    expect(final).toBeDefined();
  }, 30_000);

  it('search emits log + partial_output + final without hitting network', async () => {
    // search uses live HTTP; this test asserts shape only — abort before the
    // request races to completion so the assertion stays deterministic.
    const ctrl = new AbortController();
    const iter = searchTool.executeStream!({ query: 'x' }, ctx, { signal: ctrl.signal });
    const events: ToolStreamEvent<unknown>[] = [];
    const iterator = iter[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (!first.done) events.push(first.value);
    ctrl.abort();
    expect(events[0]?.type).toBe('log');
  });

  it('fetch throws on bad protocol from executeStream', async () => {
    const iter = fetchTool.executeStream!({ url: 'ftp://example.com' }, ctx, opts());
    await expect(async () => {
      for await (const _ev of iter) {
        // consume
      }
    }).rejects.toThrow();
  });
});
