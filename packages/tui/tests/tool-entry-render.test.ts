import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { Entry, type HistoryEntry } from '../src/components/history.js';

function renderEntry(entry: HistoryEntry): string {
  const { lastFrame, unmount } = render(
    React.createElement(Entry, {
      entry,
      termWidth: 100,
    }),
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

describe('<Entry /> tool rendering', () => {
  it('renders semantic grep result rows inside tool entries', () => {
    const frame = renderEntry({
      id: 1,
      kind: 'tool',
      name: 'grep',
      durationMs: 18,
      ok: true,
      input: { pattern: 'Widget' },
      output: JSON.stringify({
        count: 1,
        matches: [{ file: 'src/a.ts', line: 42, text: 'const Widget = makeWidget();' }],
      }),
    });

    expect(frame).toContain('grep');
    expect(frame).toContain('"Widget"');
    expect(frame).toContain('src/a.ts');
    expect(frame).toContain('42');
    expect(frame).toContain('const Widget = makeWidget();');
  });

  it('renders new-file write diffs in committed tool entries', () => {
    const frame = renderEntry({
      id: 2,
      kind: 'tool',
      name: 'write',
      durationMs: 31,
      ok: true,
      input: { path: 'src/new.ts', content: 'alpha\nbeta' },
      output: JSON.stringify({
        path: 'src/new.ts',
        bytes_written: 10,
        created: true,
        diff: '+++ src/new.ts\n+ (new file, 2 lines)',
      }),
    });

    expect(frame).toContain('write');
    expect(frame).toContain('src/new.ts');
    expect(frame).toContain('created');
    expect(frame).toContain('alpha');
    expect(frame).toContain('beta');
  });

  it('renders batch tool execution rows with failed child details', () => {
    const frame = renderEntry({
      id: 3,
      kind: 'tool',
      name: 'batch_tool_use',
      durationMs: 44,
      ok: false,
      input: { calls: [{ tool: 'read' }, { tool: 'write' }] },
      output: JSON.stringify({
        total: 2,
        succeeded: 1,
        failed: 1,
        results: [
          { tool: 'read', success: true, executionMs: 5 },
          { tool: 'write', success: false, error: 'denied', executionMs: 7 },
        ],
      }),
    });

    expect(frame).toContain('batch_tool_use');
    expect(frame).toContain('1/2 succeeded');
    expect(frame).toContain('write');
    expect(frame).toContain('denied');
  });
});
