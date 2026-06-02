import { describe, expect, it } from 'vitest';
import { renderMarkdownTables } from '../src/markdown-table.js';
import {
  MESSAGE_PANEL_CHROME_WIDTH,
  assistantContentWidth,
} from '../src/components/history.js';

/**
 * Regression test for the bug introduced by commit 0f37c5f
 * ("accent left-bar panels for chat messages"). The commit wrapped the
 * assistant message body in
 *
 *   <Box borderStyle="single" borderLeft paddingLeft={1}>
 *
 * which reserves MESSAGE_PANEL_CHROME_WIDTH = 2 columns of horizontal
 * space. `MarkdownView` was, however, still being given the full
 * `termWidth` as the table budget. As a result, a table whose natural
 * width sat at ~termWidth laid out exactly to termWidth and overflowed
 * the bordered box by 2 columns, producing a 2-character shift and a
 * spurious extra row (Ink wrapping the last cell at the right edge).
 *
 * The fix uses `assistantContentWidth(termWidth)` everywhere the inner
 * width is needed (the Entry render and these tests both import the
 * helper, so the formula lives in exactly one place). These tests pin
 * the table renderer's behavior to the corrected budget and assert
 * the chrome constant — if either side drifts, the test will fail and
 * the bug can't sneak back in unnoticed.
 */

const visibleLen = (s: string) => [...s].length;

// Sized so the natural column width (24) lands at exactly `termWidth`
// after `computeWidths` finishes shrinking. 3 columns × 24 chars = 72
// chars of cell content, with the table renderer adding 10 chars of
// borders/separators → total 80 cols at the full termWidth=80 budget.
// At the corrected budget of 78, the same table has to wrap cells.
const tableSizedForTerminal = [
  '| Long Column Header AAAAA | Long Column Header BBBBB | Long Column Header CCCCC |',
  '|--------------------------|--------------------------|--------------------------|',
  '| cell1                    | cell2                    | cell3                    |',
].join('\n');

describe('assistant panel — table width budget', () => {
  it('renders the table within the panel content area when given the corrected budget', () => {
    const termWidth = 80;
    const budget = assistantContentWidth(termWidth);
    const out = renderMarkdownTables(tableSizedForTerminal, budget);
    const longest = Math.max(...out.split('\n').map(visibleLen));
    expect(longest).toBeLessThanOrEqual(budget);
  });

  it('control: the buggy full-termWidth budget overflows the panel', () => {
    // Documents the failure mode the bug produced. The difference between
    // `termWidth` and `termWidth - 2` is exactly the panel chrome; if this
    // assertion ever fails it means the test inputs no longer reproduce
    // the bug, not that the bug is gone.
    const termWidth = 80;
    const out = renderMarkdownTables(tableSizedForTerminal, termWidth);
    const longest = Math.max(...out.split('\n').map(visibleLen));
    expect(longest).toBeGreaterThan(termWidth - MESSAGE_PANEL_CHROME_WIDTH);
  });

  it('keeps border alignment even when the budget is tight', () => {
    const out = renderMarkdownTables(tableSizedForTerminal, 78);
    const widths = new Set(out.split('\n').map(visibleLen));
    expect(widths.size).toBe(1);
  });

  it('panel chrome is exactly 2 (1 border glyph + 1 paddingLeft)', () => {
    // If a future change ever splits border+padding onto different
    // sides, this test makes the drift visible at the call site.
    expect(MESSAGE_PANEL_CHROME_WIDTH).toBe(2);
  });
});

describe('assistantContentWidth (the helper)', () => {
  // The assistant Entry render and these tests share this helper, so
  // any drift between them is a TypeScript error or a test failure.
  it('subtracts the chrome from termWidth and floors at 20', () => {
    expect(assistantContentWidth(80)).toBe(78);
    expect(assistantContentWidth(120)).toBe(118);
  });

  it('clamps to 20 at very small terminal widths', () => {
    // 10-col terminal - 2 chrome = 8 → clamped to 20 so a tiny window
    // doesn't render an unparseable 1-char-wide table.
    expect(assistantContentWidth(10)).toBe(20);
    expect(assistantContentWidth(5)).toBe(20);
  });
});
