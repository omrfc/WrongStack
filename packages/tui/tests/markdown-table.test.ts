import { describe, expect, it } from 'vitest';
import { breakLigatures, renderMarkdownTables, strWidth } from '../src/markdown-table.js';

describe('strWidth', () => {
  it('returns correct widths for emoji', () => {
    expect(strWidth('✅')).toBe(2);
    expect(strWidth('❌')).toBe(2);
  });

  it('returns correct widths for CJK', () => {
    expect(strWidth('名前')).toBe(4);
    expect(strWidth('田中')).toBe(4);
  });

  it('returns correct widths for ASCII', () => {
    expect(strWidth('Status')).toBe(6);
    expect(strWidth('Name')).toBe(4);
  });
});

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
    const input = ['before', '', '| A | B |', '|---|---|', '| 1 | 2 |', '', 'after'].join('\n');
    const out = renderMarkdownTables(input, 80);
    expect(out.startsWith('before\n\n┌')).toBe(true);
    expect(out.endsWith('┘\n\nafter')).toBe(true);
  });

  it('honours alignment markers (left, right, center)', () => {
    const input = ['| L | C | R |', '|:--|:-:|--:|', '| 1 | 2 | 3 |'].join('\n');
    const out = renderMarkdownTables(input, 80);
    // Strip ANSI escape codes so regex assertions only see visible text.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence stripping
    const stripAnsi = (s: string) => s.replace(/\x1B\[\d*m/g, '');
    const row = stripAnsi(out.split('\n').find((l) => l.includes('1'))!);
    // Right column ends with the digit + ` │` (no trailing spaces).
    expect(row).toMatch(/\s3 │$/);
    expect(row).toMatch(/^│ 1\s/);
  });

  it('wraps long cell contents over multiple lines, keeping borders aligned', () => {
    const long = 'this is a fairly long cell content that should wrap';
    const input = ['| short | wide |', '|-------|------|', `| a     | ${long} |`].join('\n');
    const out = renderMarkdownTables(input, 40);
    const lines = out.split('\n');
    // Border lines all the same visual width (use strWidth, not .length,
    // because ANSI escape codes add string bytes but zero visual width).
    const widths = new Set(lines.map((l) => strWidth(l)));
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

  it('keeps table borders aligned when cells contain emoji', () => {
    // Emoji like ✅ are single code points but modern emoji render as
    // double-width in most terminals. Without proper width handling,
    // borders would misalign because text.length != visual width.
    const input = [
      '| Status | Name |',
      '|--------|------|',
      '| ✅     | Alice |',
      '| ❌     | Bob   |',
    ].join('\n');
    const out = renderMarkdownTables(input, 60);
    const lines = out.split('\n');
    // All lines must have the same visual width (not string length, which
    // undercounts emoji/CJK since they occupy 2 terminal columns per code point).
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
    // Borders must use proper box-drawing characters.
    expect(lines[0]).toMatch(/^┌─+┬─+┐$/); // top border
    expect(lines[2]).toMatch(/^├─+┼─+┤$/); // header separator
    expect(lines[5]).toMatch(/^└─+┴─+┘$/); // bottom border
  });

  it('handles CJK characters (double-width) without border misalignment', () => {
    // CJK characters are double-width in terminals.
    const input = [
      '| Name | Status |',
      '|------|--------|',
      '| 名前 | ✅    |',
      '| 山本 | ❌    |',
    ].join('\n');
    const out = renderMarkdownTables(input, 60);
    const lines = out.split('\n');
    // Debug: print lines and widths
    console.log('CJK test output:');
    lines.forEach((l, i) => console.log(`  [${i}] "${l}" visual=${strWidth(l)}`));
    // All lines must have the same visual width.
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
  });

  it('emoji column width matches header width', () => {
    // The emoji column should be as wide as the header column, not just wide enough for the emoji.
    const input = [
      '| Status |',
      '|--------|',
      '| ✅     |',
    ].join('\n');
    const out = renderMarkdownTables(input, 60);
    const lines = out.split('\n');
    console.log('Emoji single column:');
    lines.forEach((l, i) => console.log(`  [${i}] "${l}" visual=${strWidth(l)}`));
    // All lines must have the same visual width.
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
  });

  it('handles emoji in wrapped cells correctly', () => {
    // A long cell with emoji should wrap at the right visual position.
    const input = [
      '| Item | Description |',
      '|------|-------------|',
      '| 1    | This is a very long description with emoji 🚀 that should wrap |',
    ].join('\n');
    const out = renderMarkdownTables(input, 50);
    const lines = out.split('\n');
    // All lines must have the same visual width (strWidth, not string length).
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
  });

  it('prevents -> ligature from misaligning table borders', () => {
    // In Fira Code / Cascadia Code / JetBrains Mono, `->` renders as a
    // single-width → glyph, collapsing 2 character positions into 1 visual
    // column. breakLigatures inserts U+200B to prevent the ligature.
    const input = [
      '| Pattern  | Value |',
      '|----------|-------|',
      '| arrow    | a->b  |',
      '| fat      | x=>y  |',
    ].join('\n');
    const out = renderMarkdownTables(input, 60);
    const lines = out.split('\n');
    // Every line (borders + data) must have identical visual width.
    const widths = new Set(lines.map((l) => strWidth(l)));
    expect(widths.size).toBe(1);
    // The cell containing a->b must have a zero-width space breaking the ligature.
    const arrowRow = lines.find((l) => l.includes('a') && l.includes('b'))!;
    expect(arrowRow).toContain('\u200B');
  });

  it('prevents arrow chain ligatures in cells', () => {
    const input = [
      '| Chain |',
      '|-------|',
      '| a->b=>c |',
    ].join('\n');
    const out = renderMarkdownTables(input, 60);
    // Both ligature pairs must be broken.
    const count = (out.match(/\u200B/g) ?? []).length;
    expect(count).toBe(2);
  });
});
