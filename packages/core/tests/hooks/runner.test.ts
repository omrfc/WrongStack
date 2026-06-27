import { describe, expect, it } from 'vitest';
import { HookRegistry, hookMatcherMatches } from '../../src/hooks/registry.js';
import { HookRunner } from '../../src/hooks/runner.js';

const env = { cwd: '/work' };

describe('hookMatcherMatches', () => {
  it('matches "*" and empty against anything', () => {
    expect(hookMatcherMatches('*', 'bash')).toBe(true);
    expect(hookMatcherMatches('', 'bash')).toBe(true);
  });
  it('matches a pipe-delimited, case-insensitive tool list', () => {
    expect(hookMatcherMatches('Edit|Write', 'write')).toBe(true);
    expect(hookMatcherMatches('Edit|Write', 'bash')).toBe(false);
  });
  it('always matches when no tool name (non-tool events)', () => {
    expect(hookMatcherMatches('Bash', undefined)).toBe(true);
  });
});

describe('HookRunner.preToolUse', () => {
  it('blocks when a hook returns decision:block (first block wins)', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', 'Bash', () => ({ decision: 'block', reason: 'no shell' }));
    const runner = new HookRunner({ registry: reg });
    const r = await runner.preToolUse('bash', { command: 'ls' }, env);
    expect(r.block).toBe(true);
    expect(r.reason).toBe('no shell');
  });

  it('does not run hooks whose matcher excludes the tool', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', 'Edit', () => ({ decision: 'block' }));
    const runner = new HookRunner({ registry: reg });
    const r = await runner.preToolUse('bash', { command: 'ls' }, env);
    expect(r.block).toBeUndefined();
  });

  it('chains modifiedInput through successive hooks', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', (i) => ({
      modifiedInput: { ...(i.toolInput as object), a: 1 },
    }));
    reg.registerInProcess('PreToolUse', '*', (i) => {
      // second hook sees the first hook's mutation
      expect((i.toolInput as { a?: number }).a).toBe(1);
      return { modifiedInput: { ...(i.toolInput as object), b: 2 } };
    });
    const runner = new HookRunner({ registry: reg });
    const r = await runner.preToolUse('bash', { command: 'ls' }, env);
    expect(r.input).toEqual({ command: 'ls', a: 1, b: 2 });
  });

  it('returns {} when nothing matches', async () => {
    const runner = new HookRunner({ registry: new HookRegistry() });
    expect(await runner.preToolUse('bash', {}, env)).toEqual({});
  });
});

describe('HookRunner.postToolUse', () => {
  it('merges additionalContext from all matching hooks', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PostToolUse', '*', () => ({ additionalContext: 'a' }));
    reg.registerInProcess('PostToolUse', '*', () => ({ additionalContext: 'b' }));
    const runner = new HookRunner({ registry: reg });
    const r = await runner.postToolUse('bash', {}, { content: 'out', isError: false }, env);
    expect(r.additionalContext).toBe('a\nb');
  });
});

describe('HookRunner.userPromptSubmit', () => {
  it('blocks and reports the reason', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('UserPromptSubmit', undefined, () => ({
      decision: 'block',
      reason: 'banned word',
    }));
    const runner = new HookRunner({ registry: reg });
    const r = await runner.userPromptSubmit('hello', env);
    expect(r.block).toBe(true);
    expect(r.reason).toBe('banned word');
  });

  it('injects additionalContext', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('UserPromptSubmit', undefined, () => ({ additionalContext: 'ctx' }));
    const runner = new HookRunner({ registry: reg });
    const r = await runner.userPromptSubmit('hello', env);
    expect(r.additionalContext).toBe('ctx');
  });
});

describe('HookRunner — failures and gating', () => {
  it('swallows hook exceptions (never throws into the loop)', async () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => {
      throw new Error('boom');
    });
    const runner = new HookRunner({ registry: reg });
    await expect(runner.preToolUse('bash', {}, env)).resolves.toEqual({});
  });

  it('skips shell hooks when allowShell is false', async () => {
    const reg = new HookRegistry();
    reg.registerShell('PreToolUse', { command: 'exit 2' });
    const runner = new HookRunner({ registry: reg, allowShell: false });
    const r = await runner.preToolUse('bash', {}, env);
    expect(r.block).toBeUndefined();
  });
});

describe('HookRegistry — owner-scoped teardown', () => {
  it('tracks owner via registerInProcess', () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => undefined, 'plugin-a');
    reg.registerInProcess('PreToolUse', '*', () => undefined, 'plugin-b');
    expect(reg.countByOwner('plugin-a')).toBe(1);
    expect(reg.countByOwner('plugin-b')).toBe(1);
    expect(reg.countByOwner('plugin-c')).toBe(0);
  });

  it('drainByOwner removes only the targeted plugin hooks', () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => undefined, 'plugin-a');
    reg.registerInProcess('PostToolUse', '*', () => undefined, 'plugin-a');
    reg.registerInProcess('PreToolUse', '*', () => undefined, 'plugin-b');
    reg.registerShell('PreToolUse', { command: 'echo hi' });

    const removed = reg.drainByOwner('plugin-a');
    expect(removed).toBe(2);
    expect(reg.countByOwner('plugin-a')).toBe(0);
    expect(reg.countByOwner('plugin-b')).toBe(1);
    // Shell hooks survive drainByOwner — they're owned by the runtime.
    expect(reg.has('PreToolUse')).toBe(true);
  });

  it('drainByOwner returns 0 when nothing matches', () => {
    const reg = new HookRegistry();
    expect(reg.drainByOwner('nobody')).toBe(0);
  });

  it('per-call unsubscribe still works alongside drainByOwner', () => {
    const reg = new HookRegistry();
    const off = reg.registerInProcess('PreToolUse', '*', () => undefined, 'plugin-a');
    expect(reg.countByOwner('plugin-a')).toBe(1);
    off();
    expect(reg.countByOwner('plugin-a')).toBe(0);
    // Drain is a no-op on an already-empty owner.
    expect(reg.drainByOwner('plugin-a')).toBe(0);
  });

  it('all() returns a snapshot copy', () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', '*', () => undefined, 'a');
    reg.registerInProcess('PostToolUse', '*', () => undefined, 'b');
    const snap = reg.all();
    expect(snap).toHaveLength(2);
    // Mutating the returned array must not affect the registry.
    snap.length = 0;
    expect(reg.all()).toHaveLength(2);
  });

  it('list() filters by event and preserves registration order', () => {
    const reg = new HookRegistry();
    reg.registerInProcess('PreToolUse', 'Bash', () => undefined, 'x');
    reg.registerInProcess('PreToolUse', 'Edit', () => undefined, 'y');
    reg.registerInProcess('PostToolUse', '*', () => undefined, 'z');
    const pre = reg.list('PreToolUse');
    expect(pre).toHaveLength(2);
    expect((pre[0] as { owner?: string }).owner).toBe('x');
    expect((pre[1] as { owner?: string }).owner).toBe('y');
  });
});
