import { describe, expect, it } from 'vitest';
import { renderDiff } from '../src/diff-renderer.js';

describe('renderDiff', () => {
  it('returns empty string for empty input', () => {
    expect(renderDiff('')).toBe('');
  });

  it('preserves whitespace-only lines (no trim)', () => {
    // renderDiff does not trim — whitespace lines are dimmed as-is
    expect(renderDiff('   ')).toBe('   ');
  });

  it('renders +++ and --- lines in bold', () => {
    const diff = '--- a/src/index.ts\n+++ b/src/index.ts';
    const rendered = renderDiff(diff);
    expect(rendered).toContain('--- a/src/index.ts');
    expect(rendered).toContain('+++ b/src/index.ts');
  });

  it('renders @@ hunk headers in cyan', () => {
    const diff = '@@ -1,5 +1,6 @@ function main()';
    const rendered = renderDiff(diff);
    expect(rendered).toContain('@@ -1,5 +1,6 @@ function main()');
  });

  it('renders + additions in green', () => {
    const diff = '+ const x = 1;';
    const rendered = renderDiff(diff);
    expect(rendered).toContain('+ const x = 1;');
  });

  it('renders - deletions in red', () => {
    const diff = '- const y = 2;';
    const rendered = renderDiff(diff);
    expect(rendered).toContain('- const y = 2;');
  });

  it('renders unchanged lines dimmed', () => {
    const diff = ' context line';
    const rendered = renderDiff(diff);
    expect(rendered).toContain(' context line');
  });

  it('handles mixed diff content', () => {
    const diff = [
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,3 +1,4 @@',
      ' const x = 1;',
      '+const y = 2;',
      '-const z = 3;',
    ].join('\n');
    const rendered = renderDiff(diff);
    // Each line type should appear
    expect(rendered).toContain('--- a/src/index.ts');
    expect(rendered).toContain('+++ b/src/index.ts');
    expect(rendered).toContain('@@ -1,3 +1,4 @@');
    expect(rendered).toContain(' const x = 1;');
    expect(rendered).toContain('+const y = 2;');
    expect(rendered).toContain('-const z = 3;');
  });

  it('handles single line starting with +', () => {
    expect(renderDiff('+new line')).toContain('+new line');
  });

  it('handles single line starting with -', () => {
    expect(renderDiff('-old line')).toContain('-old line');
  });

  it('preserves content after the prefix', () => {
    const diff = '+console.log("hello world")';
    const rendered = renderDiff(diff);
    expect(rendered).toContain('console.log("hello world")');
  });
});
