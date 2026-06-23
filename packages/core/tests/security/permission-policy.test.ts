import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AutoApprovePermissionPolicy,
  DefaultPermissionPolicy,
} from '../../src/security/permission-policy.js';
import type { Context, Tool } from '../../src/types/index.js';
import {
  hasCapability,
  hasDangerousCapabilityForSubagents,
  getDangerousCapabilities,
  ToolCapabilities,
} from '../../src/security/capabilities.js';
import { subjectForToolInput } from '../../src/utils/tool-subject.js';

function tool(
  name: string,
  permission: 'auto' | 'confirm' | 'deny' = 'confirm',
  riskTier?: 'safe' | 'standard' | 'destructive',
  mutating = true,
  capabilities?: readonly string[],
): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission,
    mutating,
    riskTier,
    capabilities,
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

  it('an "always"-trusted bash command with glob metacharacters re-matches itself (#15)', async () => {
    // Subjects are glob-escaped (`[ ] * ?` → `\[ \] \* \?`). Before the fix,
    // `matchAny` re-parsed `\[`/`\]` as a character class, so a trusted command
    // containing brackets — the shell `[ -f x ]` test, `grep "[0-9]"`, … — never
    // matched its own stored pattern and re-prompted on every repeat.
    for (const command of ['[ -f x ]', 'grep "[0-9]" file.txt', 'echo a[b]c']) {
      const subject = subjectForToolInput('bash', { command })!;
      // Emulate the user choosing "always": the subject is stored as the pattern.
      const p = new DefaultPermissionPolicy({ trustFile });
      await p.trust({ tool: 'bash', pattern: subject });
      // A fresh policy (empty eval cache) re-evaluates the identical command —
      // the same flow as a later repeat in-session after the trust was written.
      const fresh = new DefaultPermissionPolicy({ trustFile });
      const d = await fresh.evaluate(tool('bash'), { command }, {} as Context);
      expect(d.permission, `repeat of ${command} should auto-approve`).toBe('auto');
    }
  });

  it('does not widen authorization — a different command is still gated (#15)', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    await p.trust({ tool: 'bash', pattern: subjectForToolInput('bash', { command: '[ -f a ]' })! });
    const fresh = new DefaultPermissionPolicy({ trustFile });
    const d = await fresh.evaluate(tool('bash'), { command: '[ -f b ]' }, {} as Context);
    expect(d.permission).toBe('confirm');
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
      const d = await p.evaluate(
        tool('read', 'confirm', 'safe'),
        { path: 'src/a.ts' },
        {} as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo auto-approves normal exec tools', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('exec', 'confirm', 'standard'),
        { command: 'pnpm', args: ['test'] },
        {} as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo auto-approves simple bash commands', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'echo hello' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo auto-approves in-project cleanup commands', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf .wrongstack/tmp' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo auto-approves clearly destructive bash commands (no longer gated)', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf /' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo auto-approves bash commands that escape the project', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf ../other-project' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo + yoloDestructive is a no-op (YOLO already auto-approves everything)', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, yoloDestructive: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf /' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo + confirmDestructive gates destructive operations', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, confirmDestructive: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf /' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });

    it('setConfirmDestructive / getConfirmDestructive toggle at runtime', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      expect(p.getConfirmDestructive()).toBe(false);
      p.setConfirmDestructive(true);
      expect(p.getConfirmDestructive()).toBe(true);
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf /' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      p.setConfirmDestructive(false);
      const d2 = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf /' },
        {} as Context,
      );
      expect(d2.permission).toBe('auto');
    });

    it('confirmDestructive + promptDelegate intercepts with always/deny/yes/no', async () => {
      const p = new DefaultPermissionPolicy({
        trustFile,
        yolo: true,
        confirmDestructive: true,
        promptDelegate: async () => 'always',
      });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf /' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('user');
    });

    it('yolo_destructive source appears when confirmDestructive is active', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, confirmDestructive: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive'),
        { command: 'rm -rf /' },
        { projectRoot: process.cwd() } as Context,
      );
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

  describe('capability-based destructive gating', () => {
    it('yolo + confirmDestructive gates a shell.arbitrary tool running a destructive command', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, confirmDestructive: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive', true, ['shell.arbitrary']),
        { command: 'git reset --hard' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });

    it('yolo + confirmDestructive gates an fs.write tool targeting a path outside the project', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, confirmDestructive: true });
      const d = await p.evaluate(
        tool('write', 'confirm', 'destructive', true, ['fs.write']),
        { path: '../../../outside.ts' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('confirm');
      expect(d.source).toBe('yolo_destructive');
    });

    it('yolo + confirmDestructive allows an in-project fs.write even with the capability', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true, confirmDestructive: true });
      const d = await p.evaluate(
        tool('write', 'confirm', 'destructive', true, ['fs.write']),
        { path: 'src/a.ts' },
        { projectRoot: process.cwd() } as Context,
      );
      // Inside project = not destructive → yolo auto-approves.
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });

    it('yolo without confirmDestructive auto-approves capability-based destructive tools', async () => {
      const p = new DefaultPermissionPolicy({ trustFile, yolo: true });
      const d = await p.evaluate(
        tool('bash', 'confirm', 'destructive', true, ['shell.arbitrary']),
        { command: 'echo hello' },
        { projectRoot: process.cwd() } as Context,
      );
      expect(d.permission).toBe('auto');
      expect(d.source).toBe('yolo');
    });
  });
});

describe('AutoApprovePermissionPolicy', () => {
  it('auto-approves tools with allowed capabilities (fs.read, net.outbound)', async () => {
    const p = new AutoApprovePermissionPolicy();
    const auto = await p.evaluate({
      name: 'read',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      mutating: false,
      capabilities: ['fs.read'],
      async execute() {
        return 'x';
      },
    } as Tool);
    expect(auto.permission).toBe('auto');
    expect(auto.source).toBe('yolo');
  });

  it('denies tools without any capabilities (allowlist-by-default)', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate({
      name: 'unknown_tool',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'confirm',
      mutating: false,
      async execute() {
        return 'x';
      },
    } as Tool);
    expect(d.permission).toBe('deny');
    expect(d.source).toBe('subagent_guard');
    expect(d.reason).toContain('lacks allowed capability');
  });

  // Subagent guard: tools with non-allowed capabilities are denied.
  it.each([
    { name: 'bash', caps: ['shell.arbitrary'] },
    { name: 'write', caps: ['fs.write'] },
    { name: 'edit', caps: ['fs.write'] },
    { name: 'replace', caps: ['fs.write'] },
    { name: 'scaffold', caps: ['fs.write.outside-project'] },
    { name: 'patch', caps: ['fs.write'] },
    { name: 'install', caps: ['package.install'] },
    { name: 'exec', caps: ['shell.restricted'] },
  ])(
    'denies non-allowed builtin "%s" for subagents via capabilities',
    async ({ name, caps }) => {
      const p = new AutoApprovePermissionPolicy();
      const d = await p.evaluate({
        name,
        description: '',
        inputSchema: { type: 'object' },
        permission: 'confirm',
        mutating: true,
        capabilities: caps,
        async execute() {
          return 'x';
        },
      } as Tool);
      expect(d.permission).toBe('deny');
      expect(d.source).toBe('subagent_guard');
    },
  );

  it('denies MCP tools (mcp__*) for subagents by default', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate({
      name: 'mcp__some_server__run_shell',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'auto',
      mutating: false,
      async execute() {
        return 'x';
      },
    } as Tool);
    expect(d.permission).toBe('deny');
    expect(d.source).toBe('subagent_guard');
  });

  it('respects tool-default deny', async () => {
    const p = new AutoApprovePermissionPolicy();
    const denied = await p.evaluate({
      name: 'danger',
      description: '',
      inputSchema: { type: 'object' },
      permission: 'deny',
      mutating: true,
      async execute() {
        return 'x';
      },
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

  // --- 2026-06 Capability-based tests ---

  it('denies tools that declare non-allowed capabilities even if name is safe', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(
      tool('my-custom-shell', 'confirm', undefined, true, ['shell.arbitrary'])
    );
    expect(d.permission).toBe('deny');
    // shell.arbitrary is a dangerous capability not in the allowlist, so the
    // more specific dangerous-capability reason takes precedence.
    expect(d.reason).toContain('un-granted dangerous capability');
  });

  it('denies tools with fs.write.outside-project capability', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(
      tool('dangerous-scaffold', 'confirm', undefined, true, ['fs.write.outside-project'])
    );
    expect(d.permission).toBe('deny');
  });

  it('auto-approves tools with only safe capabilities', async () => {
    const p = new AutoApprovePermissionPolicy();
    const decision = await p.evaluate(
      tool('safe-read', 'confirm', undefined, false, ['fs.read'])
    );
    expect(decision.permission).toBe('auto');
  });

  it('auto-approves tools with net.outbound capability', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(
      tool('fetch', 'confirm', undefined, false, ['net.outbound'])
    );
    expect(d.permission).toBe('auto');
  });

  it('custom allowlist constructor overrides defaults', async () => {
    const p = new AutoApprovePermissionPolicy(['fs.write']);
    const d = await p.evaluate(
      tool('write', 'confirm', undefined, true, ['fs.write'])
    );
    expect(d.permission).toBe('auto');
    // fs.read is no longer allowed with custom allowlist
    const d2 = await p.evaluate(
      tool('read', 'confirm', undefined, false, ['fs.read'])
    );
    expect(d2.permission).toBe('deny');
  });

  it('denies tools without capabilities under allowlist-by-default', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(tool('bash')); // no capabilities declared
    expect(d.permission).toBe('deny');
    expect(d.source).toBe('subagent_guard');
    expect(d.reason).toContain('lacks allowed capability');
  });

  it('denies a multi-capability tool when a dangerous cap is not granted', async () => {
    // `install` bundles package.install + shell.restricted. Granting only
    // package.install must NOT let shell.restricted ride along: every
    // dangerous capability has to be explicitly in the allowlist.
    const p = new AutoApprovePermissionPolicy(['package.install']);
    const d = await p.evaluate(
      tool('install', 'confirm', undefined, true, ['package.install', 'shell.restricted']),
    );
    expect(d.permission).toBe('deny');
    expect(d.source).toBe('subagent_guard');
    expect(d.reason).toContain('un-granted dangerous capability');
    expect(d.reason).toContain('shell.restricted');
  });

  it('allows a multi-capability tool when every dangerous cap is granted', async () => {
    const p = new AutoApprovePermissionPolicy(['package.install', 'shell.restricted']);
    const d = await p.evaluate(
      tool('install', 'confirm', undefined, true, ['package.install', 'shell.restricted']),
    );
    expect(d.permission).toBe('auto');
    expect(d.source).toBe('yolo');
  });

  it('denies a benign+dangerous combo (fs.read + fs.write) under the read-only default', async () => {
    // A tool that can read AND write must not slip through on the strength of
    // its fs.read capability alone — fs.write is dangerous and ungranted.
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(
      tool('read_write', 'confirm', undefined, true, ['fs.read', 'fs.write']),
    );
    expect(d.permission).toBe('deny');
    expect(d.reason).toContain('un-granted dangerous capability');
  });

  it('allows fs.write when the leader widens the allowlist (e.g. /techstack report)', async () => {
    const p = new AutoApprovePermissionPolicy(['fs.read', 'net.outbound', 'fs.write']);
    const write = await p.evaluate(tool('write', 'confirm', undefined, true, ['fs.write']));
    expect(write.permission).toBe('auto');
    const fetch = await p.evaluate(tool('fetch', 'confirm', undefined, false, ['net.outbound']));
    expect(fetch.permission).toBe('auto');
    // Shell still denied — widening fs.write does not grant arbitrary command exec.
    const bash = await p.evaluate(tool('bash', 'auto', undefined, true, ['shell.arbitrary']));
    expect(bash.permission).toBe('deny');
  });

  it('MCP tools are denied unless mcp.proxy is explicitly granted', async () => {
    const p = new AutoApprovePermissionPolicy();
    const d = await p.evaluate(
      tool('mcp__evil__do_stuff', 'auto', undefined, false, [ToolCapabilities.MCP_PROXY]),
    );
    expect(d.permission).toBe('deny');
    expect(d.reason).toContain('allow mcp.proxy explicitly');
  });

  it('allows MCP tools when the scoped subagent tool slice grants mcp.proxy', async () => {
    const p = new AutoApprovePermissionPolicy([ToolCapabilities.MCP_PROXY]);
    const d = await p.evaluate(
      tool('mcp__ssh__ssh_health_check', 'confirm', undefined, false, [ToolCapabilities.MCP_PROXY]),
    );
    expect(d.permission).toBe('auto');
    expect(d.source).toBe('yolo');
  });
});

describe('Capability helpers', () => {
  it('hasDangerousCapabilityForSubagents detects dangerous caps', () => {
    expect(hasDangerousCapabilityForSubagents(['shell.arbitrary'])).toBe(true);
    expect(hasDangerousCapabilityForSubagents(['fs.read'])).toBe(false);
    expect(hasDangerousCapabilityForSubagents({ capabilities: ['fs.write.outside-project'] })).toBe(true);
  });

  it('hasCapability works with single and multiple', () => {
    expect(hasCapability(['fs.read', 'net.outbound'], ToolCapabilities.FS_READ)).toBe(true);
    expect(hasCapability(['fs.read'], [ToolCapabilities.FS_WRITE, ToolCapabilities.NET_OUTBOUND])).toBe(false);
  });

  it('getDangerousCapabilities extracts correctly', () => {
    const result = getDangerousCapabilities(['fs.read', 'shell.arbitrary', 'mcp.proxy']);
    expect(result).toContain(ToolCapabilities.SHELL_ARBITRARY);
    expect(result).toContain(ToolCapabilities.MCP_PROXY);
    expect(result).not.toContain(ToolCapabilities.FS_READ);
  });
});
