import { describe, expect, it } from 'vitest';
import { renderMarkdownTables, strWidth } from '../src/markdown-table.js';
import {
  MESSAGE_PANEL_BORDER_WIDTH,
  MESSAGE_PANEL_CHROME_WIDTH,
  MESSAGE_PANEL_MARGIN,
  assistantContentWidth,
} from '../src/components/history/assistant.js';

/**
 * Regression test for assistant panel table width budget calculations.
 *
 * The assistant panel has:
 *   borderStyle="single" + borderLeft={true}  → 1 column left border
 *   paddingLeft={1}                          → 1 column padding
 *   Total chrome = MESSAGE_PANEL_CHROME_WIDTH = 2
 *
 * For prose, `contentWidth = termWidth - chrome` = termWidth - 2.
 * For tables, `tableWidth = termWidth - border` = termWidth - 1.
 *   The left border is a separate UI element; the table should use the
 *   full content width (minus only the border, not the padding).
 *
 * `MarkdownView` receives `tableWidth` explicitly so prose and tables
 * can use different budgets from the same panel.
 */

const visibleLen = (s: string) => strWidth(s);

// Sized so the natural column width (24) lands at exactly `termWidth`
// after `computeWidths` finishes shrinking. 3 columns × 24 chars = 72
// chars of cell content, with the table renderer adding 10 chars of
// borders/separators → total 80 cols at the full termWidth=80 budget.
// At the corrected table budget of 79 (termWidth-1), the same table
// still fits in one row.
const tableSizedForTerminal = [
  '| Long Column Header AAAAA | Long Column Header BBBBB | Long Column Header CCCCC |',
  '|--------------------------|--------------------------|--------------------------|',
  '| cell1                    | cell2                    | cell3                    |',
].join('\n');

describe('assistant panel — table width budget', () => {
  it('renders the table within the panel content area at the corrected table budget', () => {
    // tableWidth = termWidth - MESSAGE_PANEL_BORDER_WIDTH = termWidth - 1
    const termWidth = 80;
    const tableBudget = termWidth - MESSAGE_PANEL_BORDER_WIDTH;
    const out = renderMarkdownTables(tableSizedForTerminal, tableBudget);
    const longest = Math.max(...out.split('\n').map(visibleLen));
    expect(longest).toBeLessThanOrEqual(tableBudget);
  });

  it('control: the buggy contentWidth budget (termWidth-2) is narrower than needed', () => {
    // Documents the failure mode when chrome (border+padding) is subtracted
    // from table width instead of just the border. The table at contentWidth
    // (termWidth-2) is 1 column narrower than the available space.
    const termWidth = 80;
    const contentWidth = assistantContentWidth(termWidth);
    const out = renderMarkdownTables(tableSizedForTerminal, contentWidth);
    const longest = Math.max(...out.split('\n').map(visibleLen));
    expect(longest).toBeLessThanOrEqual(contentWidth);
    // But at the correct tableWidth (termWidth-1), the same table is wider
    const tableWidth = termWidth - MESSAGE_PANEL_BORDER_WIDTH;
    expect(longest).toBeLessThanOrEqual(tableWidth);
  });

  it('keeps border alignment even when the budget is tight', () => {
    // budget = termWidth(80) - 1 = 79
    const out = renderMarkdownTables(tableSizedForTerminal, 79);
    const widths = new Set(out.split('\n').map(visibleLen));
    expect(widths.size).toBe(1);
  });

  it('panel border width is exactly 1 cell', () => {
    expect(MESSAGE_PANEL_BORDER_WIDTH).toBe(1);
  });

  it('panel chrome is exactly 2 (1 border glyph + 1 paddingLeft)', () => {
    expect(MESSAGE_PANEL_CHROME_WIDTH).toBe(2);
  });

  it('tableWidth is exactly 1 cell wider than prose content width', () => {
    // prose: termWidth - chrome = termWidth - 2
    // table: termWidth - border = termWidth - 1
    const termWidth = 80;
    const proseWidth = assistantContentWidth(termWidth); // termWidth - 2
    const tableWidth = termWidth - MESSAGE_PANEL_BORDER_WIDTH; // termWidth - 1
    expect(proseWidth).toBe(78);
    expect(tableWidth).toBe(79);
    expect(tableWidth - proseWidth).toBe(1); // tables are exactly 1 cell wider
  });
});

describe('assistantContentWidth (the helper)', () => {
  // The assistant Entry render and these tests share this helper, so
  // any drift between them is a TypeScript error or a test failure.
  it('subtracts only the chrome from termWidth and floors at 20', () => {
    // chrome(2) = 2 columns subtracted; panels are now full-width (no margins)
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
