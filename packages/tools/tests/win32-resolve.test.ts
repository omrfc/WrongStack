import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWin32Command } from '../src/_win32-resolve.js';

const realPlatform = process.platform;
const realPath = process.env['PATH'];
const realPathext = process.env['PATHEXT'];

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  process.env['PATH'] = realPath;
  process.env['PATHEXT'] = realPathext;
});

describe('resolveWin32Command', () => {
  it('returns the command unchanged on non-Windows platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(resolveWin32Command('pnpm')).toBe('pnpm');
  });

  it('returns commands that already contain a path or extension unchanged (win32)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(resolveWin32Command('C:\\tools\\pnpm')).toBe('C:\\tools\\pnpm');
    expect(resolveWin32Command('bin/pnpm')).toBe('bin/pnpm');
    expect(resolveWin32Command('pnpm.cmd')).toBe('pnpm.cmd');
  });

  it('resolves a bare command to its full PATHEXT path when found (win32)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-'));
    try {
      const full = path.join(dir, 'mytool.cmd');
      fs.writeFileSync(full, '@echo off');
      process.env['PATHEXT'] = '.CMD';
      process.env['PATH'] = dir;
      expect(resolveWin32Command('mytool')).toBe(full);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the original command when it cannot be found on PATH (win32)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env['PATHEXT'] = '.CMD';
    process.env['PATH'] = fs.mkdtempSync(path.join(os.tmpdir(), 'w32-empty-'));
    expect(resolveWin32Command('definitely-not-here-xyz')).toBe('definitely-not-here-xyz');
  });

  it('falls back to default PATHEXT/PATH when the env vars are unset (win32)', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env['PATHEXT'];
    delete process.env['PATH'];
    // No PATH → nothing found → returns original (exercises the ?? defaults).
    expect(resolveWin32Command('nope-cmd')).toBe('nope-cmd');
  });
});
