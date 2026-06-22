import { AutoApprovePermissionPolicy, type PermissionPolicy, ToolRegistry } from '@wrongstack/core';
import { builtinToolsPack } from '@wrongstack/tools';
import { describe, expect, it } from 'vitest';
import { makeServeContext, selectExposedTools } from '../src/mcp-serve.js';

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
  return r;
}

const ctx = makeServeContext('/tmp', '/tmp', new AbortController().signal);

const allowAll: PermissionPolicy = {
  evaluate: async () => ({ permission: 'auto', source: 'default' }),
  trust: async () => {},
  deny: async () => {},
  denyOnce: () => {},
  allowOnce: () => {},
  reload: async () => {},
} as never as PermissionPolicy;

describe('selectExposedTools', () => {
  it('safe default (AutoApprove) exposes read-only tools but withholds bash/write/edit', async () => {
    const reg = registry();
    const names = new Set(
      (await selectExposedTools(reg, ctx, new AutoApprovePermissionPolicy(), null)).map(
        (t) => t.name,
      ),
    );
    // read-only tools are exposed
    expect(names.has('glob')).toBe(true);
    expect(names.has('grep')).toBe(true);
    expect(names.has('read')).toBe(true);
    // dangerous / mutating tools are withheld
    expect(names.has('bash')).toBe(false);
    expect(names.has('write')).toBe(false);
    expect(names.has('edit')).toBe(false);
  });

  it('--yolo policy exposes everything, including bash/write', async () => {
    const reg = registry();
    const all = await selectExposedTools(reg, ctx, allowAll, null);
    const safe = await selectExposedTools(reg, ctx, new AutoApprovePermissionPolicy(), null);
    expect(all.length).toBeGreaterThan(safe.length);
    const names = new Set(all.map((t) => t.name));
    expect(names.has('bash')).toBe(true);
    expect(names.has('write')).toBe(true);
  });

  it('whitelist intersects with the policy', async () => {
    const reg = registry();
    // glob passes the safe policy; bash does not — so only glob survives.
    const names = new Set(
      (
        await selectExposedTools(
          reg,
          ctx,
          new AutoApprovePermissionPolicy(),
          new Set(['glob', 'bash']),
        )
      ).map((t) => t.name),
    );
    expect(names.has('glob')).toBe(true);
    expect(names.has('bash')).toBe(false);
    expect(names.size).toBe(1);
  });

  it('whitelist + yolo exposes exactly the requested set that exists', async () => {
    const reg = registry();
    const names = new Set(
      (await selectExposedTools(reg, ctx, allowAll, new Set(['bash', 'read']))).map((t) => t.name),
    );
    expect(names).toEqual(new Set(['bash', 'read']));
  });
});
