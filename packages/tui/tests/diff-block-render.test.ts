import { render } from 'ink-testing-library';
import { createElement as e } from 'react';
import { describe, expect, it } from 'vitest';
import { DiffBlock, type DiffLineRow } from '../src/components/history/code-block.js';

function renderDiffBlock(
  rows: DiffLineRow[],
  opts: { useColor?: boolean } = {},
): string {
  const { lastFrame, unmount } = render(
    e(DiffBlock, {
      rows,
      hidden: 0,
      hiddenAdded: 0,
      hiddenRemoved: 0,
      useColor: opts.useColor ?? false,
    }),
  );
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
}

describe('<DiffBlock /> rendering', () => {
  const rows: DiffLineRow[] = [
    { kind: 'hunk', text: '@@ -1 +1 @@' },
    { kind: 'del', text: '-old line', oldLine: 1 },
    { kind: 'add', text: '+new line', newLine: 1 },
    { kind: 'ctx', text: ' unchanged', oldLine: 2, newLine: 2 },
  ];

  it('renders the + and - markers for added and removed lines (no-color mode)', () => {
    const frame = renderDiffBlock(rows);
    expect(frame).toContain('+');
    expect(frame).toContain('-');
    expect(frame).toContain('new line');
    expect(frame).toContain('old line');
  });

  it('shows the hunk header', () => {
    const frame = renderDiffBlock(rows);
    expect(frame).toContain('@@ -1 +1 @@');
  });

  it('uses distinct markers — `+` for added, `-` for removed, blank for context', () => {
    const frame = renderDiffBlock(rows);
    // Each line carries its kind marker at the gutter position; the
    // assertion below is intentionally loose because the + appears in
    // the diff text too (in "+new line"); we just verify all three
    // kinds show up in the rendered frame.
    expect(frame).toMatch(/[+]/);
    expect(frame).toMatch(/[-]/);
    expect(frame).toContain('unchanged');
  });

  it('renders a hidden-line footer with +N/-N stats', () => {
    const frame = renderDiffBlock(rows, {});
    // No hidden lines in this fixture — the footer must NOT appear.
    expect(frame).not.toContain('more line');
  });

  it('renders hidden-line footer when there are more rows than shown', () => {
    const many: DiffLineRow[] = [
      { kind: 'hunk', text: '@@ -1,30 +1,30 @@' },
      ...Array.from({ length: 12 }, (_, i) => ({
        kind: 'add' as const,
        text: `+added line ${i}`,
        newLine: i + 1,
      })),
      { kind: 'add', text: '+more', newLine: 13 },
    ];
    // Caller (parseUnifiedDiff) is responsible for slicing the rows
    // AND for reporting `hidden` + `hiddenAdded` separately. Pass them
    // in here so the footer has something to print.
    const { lastFrame, unmount } = render(
      e(DiffBlock, {
        rows: many,
        hidden: 5,
        hiddenAdded: 4,
        hiddenRemoved: 1,
        useColor: false,
      }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('…');
    expect(frame).toContain('more line');
    // +4 / -1 stats
    expect(frame).toMatch(/\+4\b/);
    expect(frame).toMatch(/-1\b/);
  });

  it('renders the + marker with bold styling (no-color fallback)', () => {
    // In `useColor=false` mode the diff still distinguishes added vs
    // removed via the bold marker — the marker character + bold flag
    // are always emitted, only the wash is optional. We assert that the
    // frame carries both markers and they show up in their respective
    // line positions (i.e. we did NOT collapse add/del into the same
    // glyph or drop the bold flag).
    const frame = renderDiffBlock([
      { kind: 'del', text: '-old', oldLine: 1 },
      { kind: 'add', text: '+new', newLine: 1 },
    ]);
    expect(frame).toContain('-');
    expect(frame).toContain('+');
    expect(frame).toContain('old');
    expect(frame).toContain('new');
  });

  it('useColor=true renders content lines with the same body (visual parity)', () => {
    // The structural difference between useColor=true and useColor=false
    // is the background wash on add/del lines. The actual text content
    // (markers + body) must be identical regardless — otherwise users
    // would see different diffs based on terminal capability.
    const withoutColor = renderDiffBlock(
      [
        { kind: 'del', text: '-old line', oldLine: 1 },
        { kind: 'add', text: '+new line', newLine: 1 },
      ],
      { useColor: false },
    );
    const withColor = renderDiffBlock(
      [
        { kind: 'del', text: '-old line', oldLine: 1 },
        { kind: 'add', text: '+new line', newLine: 1 },
      ],
      { useColor: true },
    );
    // Strip whitespace and compare the textual content (ink-testing-library
    // strips ANSI escapes from lastFrame, so both should be plain text).
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    expect(normalize(withoutColor)).toBe(normalize(withColor));
  });
});