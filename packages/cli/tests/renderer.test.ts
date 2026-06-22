import { Writable } from 'node:stream';
import { stripAnsi } from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import { renderDiff } from '../src/diff-renderer.js';
import { TerminalRenderer } from '../src/renderer.js';

class CaptureStream extends Writable {
  buf = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

function mkRenderer() {
  const out = new CaptureStream() as never as NodeJS.WriteStream;
  const err = new CaptureStream() as never as NodeJS.WriteStream;
  const renderer = new TerminalRenderer({ out, err });
  return {
    renderer,
    out: () => stripAnsi((out as never as CaptureStream).buf),
    err: () => stripAnsi((err as never as CaptureStream).buf),
  };
}

describe('TerminalRenderer', () => {
  it('write outputs text', () => {
    const r = mkRenderer();
    r.renderer.write('hello');
    expect(r.out()).toContain('hello');
  });

  it('writeLine adds newline', () => {
    const r = mkRenderer();
    r.renderer.writeLine('one');
    r.renderer.writeLine('two');
    expect(r.out()).toContain('one');
    expect(r.out()).toContain('two');
  });

  it('writeToolCall formats name + summary', () => {
    const r = mkRenderer();
    r.renderer.writeToolCall('read', { path: '/tmp/foo.ts' });
    expect(r.out()).toContain('read');
    expect(r.out()).toContain('/tmp/foo.ts');
  });

  it('writeToolResult marks errors', () => {
    const r = mkRenderer();
    r.renderer.writeToolResult('read', 'oops', true);
    expect(r.out()).toContain('oops');
    expect(r.out()).toContain('✘');
  });

  it('writeToolResult renders unified diff for edit tool', () => {
    const r = mkRenderer();
    const payload = JSON.stringify({
      path: '/p/x.ts',
      replacements: 1,
      diff: '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+new\n',
    });
    r.renderer.writeToolResult('edit', payload, false);
    const out = r.out();
    expect(out).toContain('1 replacement');
    expect(out).toContain('-old');
    expect(out).toContain('+new');
  });

  it('writeToolResult shows multi-line preview for read with +N more', () => {
    const r = mkRenderer();
    const lines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join('\n');
    r.renderer.writeToolResult('read', lines, false);
    const out = r.out();
    expect(out).toContain('line-1');
    expect(out).toContain('line-6');
    expect(out).not.toContain('line-7'); // capped at 6 preview lines
    expect(out).toContain('+14 more');
  });

  it('writeToolResult is compact (2-line preview) for unknown tools', () => {
    const r = mkRenderer();
    const lines = Array.from({ length: 5 }, (_, i) => `x${i}`).join('\n');
    r.renderer.writeToolResult('unknown-tool', lines, false);
    const out = r.out();
    expect(out).toContain('x0');
    expect(out).toContain('x1');
    expect(out).not.toContain('x2');
    expect(out).toContain('+3 more');
  });

  it('writeWarning goes to stderr', () => {
    const r = mkRenderer();
    r.renderer.writeWarning('careful');
    expect(r.err()).toContain('careful');
    expect(r.out()).toBe('');
  });

  it('writeError + writeInfo go to stderr', () => {
    const r = mkRenderer();
    r.renderer.writeError('bad');
    r.renderer.writeInfo('fyi');
    expect(r.err()).toContain('bad');
    expect(r.err()).toContain('fyi');
  });

  it('writeBlock dispatches text/tool_use/tool_result', () => {
    const r = mkRenderer();
    r.renderer.writeBlock({ type: 'text', text: 'hi' });
    r.renderer.writeBlock({ type: 'tool_use', id: '1', name: 'glob', input: { pattern: '*.ts' } });
    r.renderer.writeBlock({ type: 'tool_result', tool_use_id: '1', content: 'done' });
    const out = r.out();
    expect(out).toContain('hi');
    expect(out).toContain('glob');
    expect(out).toContain('done');
  });

  it('clear emits ANSI clear sequence', () => {
    const r = mkRenderer();
    r.renderer.clear();
    // raw stream contains the escape, but stripped form is empty
    expect(r.out()).toBe('');
  });

  it('write renders bold and inline code markdown', () => {
    const r = mkRenderer();
    r.renderer.write('Use **pnpm** with `vitest`');
    expect(r.out()).toContain('pnpm');
    expect(r.out()).toContain('vitest');
  });

  it('writeToolResult shows count for grep result (non-JSON string)', () => {
    const r = mkRenderer();
    r.renderer.writeToolResult('grep', 'file.ts:10:match', false);
    expect(r.out()).toContain('file.ts');
  });

  it('writeToolResult shows file list for glob result', () => {
    const r = mkRenderer();
    r.renderer.writeToolResult('glob', '["/a.ts","/b.ts"]', false);
    expect(r.out()).toContain('/a.ts');
  });

  it('writeToolResult handles long line truncation in preview', () => {
    const r = mkRenderer();
    const longLine = 'x'.repeat(250);
    r.renderer.writeToolResult('read', longLine + '\nsecond', false);
    const out = r.out();
    expect(out).toContain('…');
    expect(out).toContain('second');
  });
});

describe('TerminalRenderer.setSilent', () => {
  it('suppresses all stdout-bound writes once enabled', () => {
    const r = mkRenderer();
    r.renderer.setSilent(true);
    expect(r.renderer.isSilent()).toBe(true);
    r.renderer.write('hello');
    r.renderer.writeLine('line');
    r.renderer.writeToolCall('read', { path: '/x' });
    r.renderer.writeToolResult('read', 'big output', false);
    r.renderer.writeDiff('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new');
    r.renderer.writeBlock({ type: 'text', text: 'block' });
    r.renderer.clear();
    expect(r.out()).toBe('');
  });

  it('still routes writeInfo/writeWarning/writeError through stderr while silent', () => {
    const r = mkRenderer();
    r.renderer.setSilent(true);
    r.renderer.writeInfo('hello');
    r.renderer.writeWarning('warn');
    r.renderer.writeError('boom');
    expect(r.err()).toContain('hello');
    expect(r.err()).toContain('warn');
    expect(r.err()).toContain('boom');
    expect(r.out()).toBe('');
  });

  it('resumes stdout writes after setSilent(false)', () => {
    const r = mkRenderer();
    r.renderer.setSilent(true);
    r.renderer.write('hidden');
    r.renderer.setSilent(false);
    r.renderer.write('visible');
    expect(r.out()).not.toContain('hidden');
    expect(r.out()).toContain('visible');
  });
});

describe('renderDiff', () => {
  it('returns empty for empty diff', () => {
    expect(renderDiff('')).toBe('');
  });

  it('keeps content lines, applying ANSI', () => {
    const diff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n unchanged';
    const out = stripAnsi(renderDiff(diff));
    expect(out).toContain('--- a/x');
    expect(out).toContain('+++ b/x');
    expect(out).toContain('-old');
    expect(out).toContain('+new');
    expect(out).toContain('unchanged');
  });
});
