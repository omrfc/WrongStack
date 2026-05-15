import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import type { Context, Tool } from '../../src/types/index.js';

function tool(name: string, permission: 'auto' | 'confirm' | 'deny' = 'confirm'): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission,
    mutating: true,
    async execute() {
      return 'ok';
    },
  };
}

describe('DefaultPermissionPolicy', () => {
  let trustFile: string;
  beforeEach(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-perm-'));
    trustFile = path.join(dir, 'trust.json');
  });
  afterEach(async () => {
    await fs.rm(path.dirname(trustFile), { recursive: true, force: true });
  });

  it('defaults to confirm for confirm-permission tools', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(decision.permission).toBe('confirm');
  });

  it('passes through auto for auto-permission tools', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(tool('read', 'auto'), { path: 'a.ts' }, {} as Context);
    expect(decision.permission).toBe('auto');
  });

  it('deny is absolute even when allowed', async () => {
    await fs.writeFile(
      trustFile,
      JSON.stringify({ edit: { allow: ['**/*'], deny: ['**/.env*'] } }),
    );
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(tool('edit'), { path: '.env.production' }, {} as Context);
    expect(d.permission).toBe('deny');
  });

  it('allow matches glob', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ edit: { allow: ['src/**'] } }));
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d.permission).toBe('auto');
  });

  it('yolo bypasses confirm but respects deny', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ edit: { deny: ['**/.env*'] } }));
    const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
    const ok = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(ok.permission).toBe('auto');
    const denied = await p.evaluate(tool('edit'), { path: '.env' }, {} as Context);
    expect(denied.permission).toBe('deny');
  });

  it('trust() persists allow rules', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    await p.trust({ tool: 'edit', pattern: 'src/**' });
    const raw = await fs.readFile(trustFile, 'utf8');
    expect(JSON.parse(raw)).toEqual({ edit: { allow: ['src/**'] } });
  });
});
