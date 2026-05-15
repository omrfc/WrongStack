import { Writable } from 'node:stream';
import type { InputReader, Tool } from '@wrongstack/core';
import { stripAnsi } from '@wrongstack/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makePromptDelegate } from '../src/permission-prompt.js';

class _FakeStdout extends Writable {
  buf = '';
  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    cb();
  }
}

const fakeTool: Tool = {
  name: 'edit',
  description: '',
  inputSchema: { type: 'object' },
  permission: 'confirm',
  mutating: true,
  async execute() {
    return '';
  },
};

const origWrite = process.stdout.write.bind(process.stdout);
let buf = '';
function captureStdout(): void {
  buf = '';
  process.stdout.write = ((chunk: unknown) => {
    buf += typeof chunk === 'string' ? chunk : String(chunk);
    return true;
  }) as typeof process.stdout.write;
}
function getStdout(): string {
  return stripAnsi(buf);
}

afterEach(() => {
  process.stdout.write = origWrite;
});

describe('makePromptDelegate', () => {
  it("returns the reader's answer", async () => {
    captureStdout();
    const reader: InputReader = {
      readLine: vi.fn(async () => ''),
      readKey: vi.fn(async () => 'yes'),
      close: vi.fn(async () => undefined),
    };
    const prompt = makePromptDelegate(reader);
    const decision = await prompt(fakeTool, { path: '/a' }, 'edit:/a');
    expect(decision).toBe('yes');
    expect(reader.readKey).toHaveBeenCalled();
    const out = getStdout();
    expect(out).toContain('edit');
    expect(out).toContain('path');
  });

  it('renders diff when present for edit tool', async () => {
    captureStdout();
    const reader: InputReader = {
      readLine: vi.fn(async () => ''),
      readKey: vi.fn(async () => 'no'),
      close: vi.fn(async () => undefined),
    };
    const prompt = makePromptDelegate(reader);
    await prompt(fakeTool, { path: '/a', diff: '--- a\n+++ a\n@@\n-x\n+y\n' }, 'edit:/a');
    expect(getStdout()).toContain('-x');
    expect(getStdout()).toContain('+y');
  });

  it('omits long content and new_string from summary', async () => {
    captureStdout();
    const reader: InputReader = {
      readLine: vi.fn(async () => ''),
      readKey: vi.fn(async () => 'no'),
      close: vi.fn(async () => undefined),
    };
    const prompt = makePromptDelegate(reader);
    await prompt(
      fakeTool,
      { path: '/a', content: 'x'.repeat(500), new_string: 'y'.repeat(500) },
      'edit:/a',
    );
    expect(getStdout()).not.toContain('xxxxxx');
    expect(getStdout()).not.toContain('yyyyyy');
  });
});
