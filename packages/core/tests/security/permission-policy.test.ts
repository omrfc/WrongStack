import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AutoApprovePermissionPolicy,
  DefaultPermissionPolicy,
} from '../../src/security/permission-policy.js';
import type { Context, Tool } from '../../src/types/index.js';

function tool(name: string, permission: 'auto' | 'confirm' | 'deny' = 'confirm', riskTier?: 'safe' | 'standard' | 'destructive', mutating = true): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission,
    mutating,
    riskTier,
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
    // Read-only (non-mutating) auto tools short-circuit to auto; mutating auto
    // tools are gated to confirm (covered by the next test).
    const decision = await p.evaluate(
      tool('read', 'auto', undefined, false),
      { path: 'a.ts' },
      {} as Context,
    );
    expect(decision.permission).toBe('auto');
  });

  it('gates mutating auto-permission tools to confirm', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const decision = await p.evaluate(tool('web_search', 'auto'), {}, {} as Context);
    expect(decision.permission).toBe('confirm');
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

  it('promptDelegate resolves inline when set', async () => {
    const p = new DefaultPermissionPolicy({
      trustFile,
      promptDelegate: async () => 'yes',
    });
    const decision = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(decision.permission).toBe('auto');
    expect(decision.source).toBe('user');
  });

  it('setPromptDelegate clears the delegate so evaluate returns confirm', async () => {
    const p = new DefaultPermissionPolicy({
      trustFile,
      promptDelegate: async () => 'yes',
    });
    // Initially resolves inline
    const d1 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d1.permission).toBe('auto');

    // Clear the delegate
    p.setPromptDelegate(undefined);
    const d2 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d2.permission).toBe('confirm');
    expect(d2.source).toBe('default');
  });

  it('setPromptDelegate can replace the delegate', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    // No delegate → confirm
    const d1 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d1.permission).toBe('confirm');

    // Set a delegate that always denies
    p.setPromptDelegate(async () => 'no');
    const d2 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d2.permission).toBe('deny');
    expect(d2.source).toBe('user');
  });

  describe('YOLO destructive gating', () => {
    it('yolo auto-approves non-destructive tools', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(tool('read', 'confirm', 'safe'), { path: 'src/a.ts' }, {} as Context);
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo blocks destructive tools without forceAllYolo', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(tool('bash', 'confirm', 'destructive'), { command: 'rm -rf /' }, {} as Context);
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });

    it('yolo + forceAllYolo allows destructive tools', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, forceAllYolo: true });
      const d = await p.evaluate(tool('bash', 'confirm', 'destructive'), { command: 'rm -rf /' }, {} as Context);
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('setForceAllYolo / getForceAllYolo toggle at runtime', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      expect(p.getForceAllYolo()).toBe(false);
      p.setForceAllYolo(true);
      expect(p.getForceAllYolo()).toBe(true);
      const d = await p.evaluate(tool('bash', 'confirm', 'destructive'), { command: 'rm -rf /' }, {} as Context);
      expect(d.permission).toBe('auto');
      p.setForceAllYolo(false);
      const d2 = await p.evaluate(tool('bash', 'confirm', 'destructive'), { command: 'rm -rf /' }, {} as Context);
      expect(d2.permission).toBe('confirm');
    });

    it('promptDelegate intercepts destructive yolo with always/deny/yes/no', async () => {
      const p = new DefaultPermissionPolicy({
        trustFile,
        yolo: true,
        promptDelegate: async () => 'always',
      });
      const d = await p.evaluate(tool('bash', 'confirm', 'destructive'), { command: 'rm -rf /' }, {} as Context);
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('user');
    });

    it('yolo_destructive source appears in decision', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(tool('bash', 'confirm', 'destructive'), { command: 'rm -rf /' }, {} as Context);
      expect(d.source).toBe('yolo_destructive');
      expect(d.riskTier).toBe('destructive');
    });
  });

  it('setYolo / getYolo toggle YOLO at runtime', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    expect(p.getYolo()).toBe(false);
    p.setYolo(true);
    expect(p.getYolo()).toBe(true);
    p.setYolo(false);
    expect(p.getYolo()).toBe(false);
  });

  it('wildcard trust-file entries match tool names via glob', async () => {
    // A wildcard like "edit*" should match both "edit" and "edit_lines".
    await fs.writeFile(trustFile, JSON.stringify({ 'edit*': { allow: ['src/**'] } }));
    const p = new DefaultPermissionPolicy({ trustFile });
    const d1 = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, {} as Context);
    expect(d1.permission).toBe('auto');
    const d2 = await p.evaluate(tool('edit_lines'), { path: 'src/b.ts' }, {} as Context);
    expect(d2.permission).toBe('auto');
  });
});

describe('AutoApprovePermissionPolicy', () => {
  it('auto-approves non-deny tools without prompting', async () => {
    const p = new AutoApprovePermissionPolicy();
    const auto = await p.evaluate({
      name: 'read',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      mutating: false,
      async execute() { return 'x'; },
    } as Tool);
    expect(auto.permission).toBe('auto');
    expect(auto.source).toBe('yolo');
  });

  it('respects tool-default deny', async () => {
    const p = new AutoApprovePermissionPolicy();
    const denied = await p.evaluate({
      name: 'danger',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'deny',
      mutating: true,
      async execute() { return 'x'; },
    } as Tool);
    expect(denied.permission).toBe('deny');
    expect(denied.source).toBe('subagent_guard');
  });

  it('trust / deny / denyOnce / allowOnce / reload are all no-ops', async () => {
    const p = new AutoApprovePermissionPolicy();
    // These should resolve / return without throwing
    await p.trust();
    await p.deny();
    p.denyOnce();
    p.allowOnce();
    await p.reload();
    // No state change observable — the policy is stateless
    expect(true).toBe(true);
  });
});
