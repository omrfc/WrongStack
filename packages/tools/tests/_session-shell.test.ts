import { describe, expect, it } from 'vitest';
import { ensureSessionShell, normalizeShell, resolveSessionShell } from '../src/_session-shell.js';

const envFrom = (vars: Record<string, string | undefined>) => ({
  get: (k: string) => vars[k],
});

describe('normalizeShell', () => {
  it('maps known shells (case/suffix-insensitive) to canonical form', () => {
    expect(normalizeShell('cmd')).toBe('cmd');
    expect(normalizeShell('CMD.exe')).toBe('cmd');
    expect(normalizeShell(' PowerShell ')).toBe('powershell');
    expect(normalizeShell('powershell.exe')).toBe('powershell');
    expect(normalizeShell('PWSH')).toBe('pwsh');
    expect(normalizeShell('pwsh.exe')).toBe('pwsh');
  });

  it('returns undefined for unset / unknown values', () => {
    expect(normalizeShell(undefined)).toBeUndefined();
    expect(normalizeShell('')).toBeUndefined();
    expect(normalizeShell('zsh')).toBeUndefined();
    expect(normalizeShell('/bin/bash')).toBeUndefined();
  });
});

describe('resolveSessionShell', () => {
  it('returns undefined on POSIX (no fixed session shell there)', () => {
    expect(resolveSessionShell('linux', envFrom({}))).toBeUndefined();
    expect(resolveSessionShell('darwin', envFrom({ WRONGSTACK_SHELL: 'pwsh' }))).toBeUndefined();
  });

  it('honours a valid user override on Windows', () => {
    expect(resolveSessionShell('win32', envFrom({ WRONGSTACK_SHELL: 'cmd' }))).toBe('cmd');
    expect(resolveSessionShell('win32', envFrom({ WRONGSTACK_SHELL: 'powershell.exe' }))).toBe(
      'powershell',
    );
    expect(resolveSessionShell('win32', envFrom({ WRONGSTACK_SHELL: 'PWSH' }))).toBe('pwsh');
  });

  it('prefers pwsh 7 when present, else powershell, else cmd', () => {
    const both = (bin: string) => bin === 'pwsh.exe' || bin === 'powershell.exe';
    expect(resolveSessionShell('win32', envFrom({}), { hasBinary: both })).toBe('pwsh');

    const only51 = (bin: string) => bin === 'powershell.exe';
    expect(resolveSessionShell('win32', envFrom({}), { hasBinary: only51 })).toBe('powershell');

    const none = () => false;
    expect(resolveSessionShell('win32', envFrom({}), { hasBinary: none })).toBe('cmd');
  });

  it('override wins even when a different binary is available', () => {
    expect(
      resolveSessionShell('win32', envFrom({ WRONGSTACK_SHELL: 'cmd' }), {
        hasBinary: () => true,
      }),
    ).toBe('cmd');
  });
});

describe('ensureSessionShell', () => {
  it('is a no-op on POSIX', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(ensureSessionShell({ env, platform: 'linux' })).toBeUndefined();
    expect(env['WRONGSTACK_SHELL']).toBeUndefined();
  });

  it('pins the resolved shell into WRONGSTACK_SHELL when unset', () => {
    const env: NodeJS.ProcessEnv = {};
    const chosen = ensureSessionShell({
      env,
      platform: 'win32',
      hasBinary: (bin) => bin === 'pwsh.exe',
    });
    expect(chosen).toBe('pwsh');
    expect(env['WRONGSTACK_SHELL']).toBe('pwsh');
  });

  it('leaves a valid user override untouched (no rewrite/normalisation)', () => {
    const env: NodeJS.ProcessEnv = { WRONGSTACK_SHELL: 'cmd.exe' };
    const chosen = ensureSessionShell({ env, platform: 'win32', hasBinary: () => true });
    expect(chosen).toBe('cmd');
    // The raw user value is preserved verbatim.
    expect(env['WRONGSTACK_SHELL']).toBe('cmd.exe');
  });

  it('is idempotent — a second call does not change the pinned value', () => {
    const env: NodeJS.ProcessEnv = {};
    ensureSessionShell({ env, platform: 'win32', hasBinary: (b) => b === 'powershell.exe' });
    expect(env['WRONGSTACK_SHELL']).toBe('powershell');
    ensureSessionShell({ env, platform: 'win32', hasBinary: () => true });
    expect(env['WRONGSTACK_SHELL']).toBe('powershell');
  });

  it('falls back to cmd when no PowerShell is installed', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(ensureSessionShell({ env, platform: 'win32', hasBinary: () => false })).toBe('cmd');
    expect(env['WRONGSTACK_SHELL']).toBe('cmd');
  });
});
