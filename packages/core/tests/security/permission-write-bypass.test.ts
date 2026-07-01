import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Context } from '../../src/core/context.js';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import type { Tool } from '../../src/types/index.js';

/**
 * P1 #1 (before-release.md): the permission policy's write-smart-bypass
 * (step 7 in `evaluate()`) auto-approved `write` for any file `ctx.hasRead()`
 * returned true on. Since `edit`/`write` both called `recordRead()` after
 * mutating a file, the model could repeatedly overwrite a file whose content
 * the user never approved — the bypass treated a tool-only write as "user
 * already saw the content".
 *
 * Fix: `recordRead()` now takes a `source` discriminator. `'user'` (read tool,
 * edit auto-read) populates `readFiles` and qualifies for the bypass; `'write'`
 * (edit/write mutations) populates `writtenFiles` only and does NOT qualify.
 *
 * These tests pin both the Context-level split and the permission-policy
 * behavior that depends on it.
 */

function writeTool(): Tool {
  return {
    name: 'write',
    description: 'write',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    permission: 'confirm',
    mutating: true,
    capabilities: ['fs.write'],
    async execute() {
      return 'ok';
    },
  };
}

function mkCtx(): Context {
  // Minimal Context — only the fields the permission policy touches.
  return {
    hasRead: (_p: string) => false,
    hasWritten: (_p: string) => false,
  } as unknown as Context;
}

function ctxWith(
  reads: string[] = [],
  writes: string[] = [],
): Context {
  const readSet = new Set(reads);
  const writeSet = new Set(writes);
  return {
    hasRead: (p: string) => readSet.has(p),
    hasWritten: (p: string) => writeSet.has(p),
  } as unknown as Context;
}

/** Subject the policy actually passes to hasRead() for a write to `path`. */
const subj = (p: string) => p;

describe('Context — readFiles / writtenFiles separation (P1 #1)', () => {
  it('recordRead(user) populates readFiles; hasRead() returns true', () => {
    const ctx = new Context({
      systemPrompt: [],
      provider: {} as never,
      session: {} as never,
      signal: new AbortController().signal,
      tokenCounter: {} as never,
      cwd: '/p',
      projectRoot: '/p',
      model: 'm',
    });
    ctx.recordRead('/p/src/a.ts', 1000);
    expect(ctx.hasRead('/p/src/a.ts')).toBe(true);
    expect(ctx.hasWritten('/p/src/a.ts')).toBe(false);
  });

  it("recordRead(write) does NOT populate readFiles — hasRead() returns false", () => {
    const ctx = new Context({
      systemPrompt: [],
      provider: {} as never,
      session: {} as never,
      signal: new AbortController().signal,
      tokenCounter: {} as never,
      cwd: '/p',
      projectRoot: '/p',
      model: 'm',
    });
    ctx.recordRead('/p/src/b.ts', 2000, 'write');
    // mtime is tracked for staleness checks…
    expect(ctx.lastReadMtime('/p/src/b.ts')).toBe(2000);
    // …but the permission bypass must NOT see it.
    expect(ctx.hasRead('/p/src/b.ts')).toBe(false);
    expect(ctx.hasWritten('/p/src/b.ts')).toBe(true);
  });

  it('default source is "user" (backward-compatible with existing callers)', () => {
    const ctx = new Context({
      systemPrompt: [],
      provider: {} as never,
      session: {} as never,
      signal: new AbortController().signal,
      tokenCounter: {} as never,
      cwd: '/p',
      projectRoot: '/p',
      model: 'm',
    });
    ctx.recordRead('/p/src/c.ts', 3000);
    expect(ctx.hasRead('/p/src/c.ts')).toBe(true);
  });

  it('clearFileTracking clears both readFiles and writtenFiles', () => {
    const ctx = new Context({
      systemPrompt: [],
      provider: {} as never,
      session: {} as never,
      signal: new AbortController().signal,
      tokenCounter: {} as never,
      cwd: '/p',
      projectRoot: '/p',
      model: 'm',
    });
    ctx.recordRead('/p/a', 1);
    ctx.recordRead('/p/b', 2, 'write');
    ctx.clearFileTracking();
    expect(ctx.hasRead('/p/a')).toBe(false);
    expect(ctx.hasWritten('/p/b')).toBe(false);
    expect(ctx.lastReadMtime('/p/a')).toBeUndefined();
  });
});

describe('DefaultPermissionPolicy — write smart-bypass (step 7, P1 #1)', () => {
  let trustFile: string;
  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-perm-write-'));
    trustFile = path.join(dir, 'trust.json');
  });
  afterEach(async () => {
    await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
  });

  const t = writeTool();

  it("auto-approves write to a file the user explicitly read (bypass still works)", async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    // User ran `read` on src/a.ts → hasRead() returns true for the subject.
    const decision = await p.evaluate(t, { path: 'src/a.ts' }, ctxWith([subj('src/a.ts')]));
    expect(decision.permission).toBe('auto');
    expect(decision.source).toBe('context');
  });

  it("does NOT auto-approve write to a file only touched by edit/write (P1 #1 regression)", async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    // edit/write recorded the file, but with source 'write'. The bypass must
    // fall through to the normal confirm flow.
    const decision = await p.evaluate(t, { path: 'src/secret.ts' }, ctxWith([], [subj('src/secret.ts')]));
    expect(decision.permission).toBe('confirm');
  });

  it("does NOT auto-approve when neither read nor write touched the file", async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(t, { path: 'src/new.ts' }, mkCtx());
    expect(decision.permission).toBe('confirm');
  });

  it("a prior user read still bypasses even if the file was later written", async () => {
    // Common flow: read → edit → write. The user saw the original content, so
    // the bypass should apply. Both readFiles and writtenFiles contain the path,
    // but hasRead() (the bypass source of truth) returns true.
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(
      t,
      { path: 'src/iter.ts' },
      ctxWith([subj('src/iter.ts')], [subj('src/iter.ts')]),
    );
    expect(decision.permission).toBe('auto');
    expect(decision.source).toBe('context');
  });
});
