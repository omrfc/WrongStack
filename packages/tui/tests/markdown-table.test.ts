import { describe, it, expect } from 'vitest';
import { renderMarkdownTables } from '../src/markdown-table.js';

describe('renderMarkdownTables', () => {
  it('passes through prose with no tables unchanged', () => {
    const text = 'Just a paragraph.\n\nAnother one with a | pipe but not a table.';
    expect(renderMarkdownTables(text, 80)).toBe(text);
  });

  it('renders a simple table with Unicode box-drawing chars', () => {
    const input = [
      '| Header A | Header B |',
      '|----------|----------|',
      '| a 1      | b 1      |',
      '| a 2      | b 2      |',
    ].join('\n');
    const out = renderMarkdownTables(input, 80);
    const lines = out.split('\n');
    // Top, header, separator, two rows, bottom = 6 lines
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^┌─+┬─+┐$/);
    expect(lines[1]).toContain('Header A');
    expect(lines[1]).toContain('Header B');
    expect(lines[2]).toMatch(/^├─+┼─+┤$/);
    expect(lines[3]).toContain('a 1');
    expect(lines[4]).toContain('a 2');
    expect(lines[5]).toMatch(/^└─+┴─+┘$/);
  });

  it('preserves surrounding prose around the table', () => {
    const input = [
      'before',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'after',
    ].join('\n');
    const out = renderMarkdownTables(input, 80);
    expect(out.startsWith('before\n\n┌')).toBe(true);
    expect(out.endsWith('┘\n\nafter')).toBe(true);
  });

  it('honours alignment markers (left, right, center)', () => {
    const input = [
      '| L | C | R |',
      '|:--|:-:|--:|',
      '| 1 | 2 | 3 |',
    ].join('\n');
    const out = renderMarkdownTables(input, 80);
    const row = out.split('\n').find((l) => l.includes('1'))!;
    // Left col: "1   ", center: " 2 ", right: "   3"
    // We just check the right column ends with the digit + ` │` (no trailing spaces).
    expect(row).toMatch(/\s3 │$/);
    expect(row).toMatch(/^│ 1\s/); // left aligned starts immediately after the gutter
  });

  it('wraps long cell contents over multiple lines, keeping borders aligned', () => {
    const long = 'this is a fairly long cell content that should wrap';
    const input = [
      '| short | wide |',
      '|-------|------|',
      `| a     | ${long} |`,
    ].join('\n');
    const out = renderMarkdownTables(input, 40);
    const lines = out.split('\n');
    // Border lines all the same width.
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
    // The wide cell must have produced at least one additional row line.
    const dataLines = lines.filter((l) => l.startsWith('│ '));
    expect(dataLines.length).toBeGreaterThan(2);
  });

  it('does not treat a non-separator pipe line as a table', () => {
    // Header followed by something that isn't a separator → keep as prose.
    const input = '| A | B |\n| not a separator | also not |';
    const out = renderMarkdownTables(input, 80);
    expect(out).toBe(input);
  });

  it('handles tables narrower than terminal width without padding to fill', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |';
    const out = renderMarkdownTables(input, 200);
    // The table should be much narrower than 200.
    const first = out.split('\n')[0]!;
    expect([...first].length).toBeLessThan(40);
  });
});
