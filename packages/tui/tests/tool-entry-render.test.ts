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
        created: true,
        diff: '+++ src/new.ts\n+ (new file, 2 lines)',
      }),
    });

    expect(frame).toContain('write');
    expect(frame).toContain('src/new.ts');
    // `created: true` is now rendered as "new file" in the meta line —
    // the visual summary sits above the diff body.
    expect(frame).toContain('new file');
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

  it('renders edit meta line (path + replacement count) above the diff body', () => {
    const frame = renderEntry({
      id: 4,
      kind: 'tool',
      name: 'edit',
      durationMs: 12,
      ok: true,
      input: { path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
      output: JSON.stringify({
        path: 'src/foo.ts',
        replacements: 1,
        diff: [
          'diff --git a/src/foo.ts b/src/foo.ts',
          '--- a/src/foo.ts',
          '+++ b/src/foo.ts',
          '@@ -1 +1 @@',
          '-a',
          '+b',
        ].join('\n'),
      }),
    });

    // Meta line: tool name + path
    expect(frame).toContain('edit');
    expect(frame).toContain('src/foo.ts');
    // Replacement count meta
    expect(frame).toContain('1 replacement');
    // Diff body still rendered below
    expect(frame).toContain('+b');
    expect(frame).toContain('-a');
  });

  it('renders write meta line (path + bytes)', () => {
    const frame = renderEntry({
      id: 5,
      kind: 'tool',
      name: 'write',
      durationMs: 8,
      ok: true,
      input: { path: 'src/bar.ts', content: 'hello\nworld' },
      output: JSON.stringify({ path: 'src/bar.ts', bytes: 11 }),
    });

    expect(frame).toContain('write');
    expect(frame).toContain('src/bar.ts');
    expect(frame).toContain('11 bytes');
  });

  it('does not render the diff body in simple result-render mode for edit', () => {
    const frame = renderEntry({
      id: 6,
      kind: 'tool',
      name: 'edit',
      durationMs: 12,
      ok: true,
      resultRenderMode: 'simple',
      input: { path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
      output: JSON.stringify({
        path: 'src/foo.ts',
        replacements: 1,
        diff: [
          'diff --git a/src/foo.ts b/src/foo.ts',
          '--- a/src/foo.ts',
          '+++ b/src/foo.ts',
          '@@ -1 +1 @@',
          '-a',
          '+b',
        ].join('\n'),
      }),
    });

    // Meta line: still present (path + replacement count).
    expect(frame).toContain('edit');
    expect(frame).toContain('src/foo.ts');
    expect(frame).toContain('1 replacement');
    // Diff BODY is hidden — the raw `-a`/`+b` markers from the diff
    // must not appear in the simple render.
    expect(frame).not.toContain('-a');
    expect(frame).not.toContain('+b');
  });
});
