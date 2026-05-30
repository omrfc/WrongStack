import { describe, expect, it, vi, beforeEach } from 'vitest';

// SkillInstaller is mocked at its internal module path — its real behaviour
// (GitHub fetch, file extraction) is covered under tests/skills.
const installerMocks = vi.hoisted(() => ({
  install: vi.fn(),
  update: vi.fn(),
  uninstall: vi.fn(),
  listInstalled: vi.fn(),
}));

vi.mock('../../src/skills/skill-installer.js', () => ({
  SkillInstaller: class {
    install = installerMocks.install;
    update = installerMocks.update;
    uninstall = installerMocks.uninstall;
    listInstalled = installerMocks.listInstalled;
  },
}));

import {
  buildSkillCommand,
  buildSkillGeneratorCommand,
  buildSkillInstallCommand,
  buildSkillUpdateCommand,
  buildSkillUninstallCommand,
} from '../../src/plugins/skills-plugin.js';

function fakeLoader(overrides: Record<string, unknown> = {}) {
  return {
    listEntries: vi.fn().mockResolvedValue([]),
    find: vi.fn(),
    readBody: vi.fn(),
    ...overrides,
  } as never;
}

function fakeCtx() {
  return { projectRoot: '/tmp/proj' } as never;
}

beforeEach(() => {
  installerMocks.install.mockReset();
  installerMocks.update.mockReset();
  installerMocks.uninstall.mockReset();
  installerMocks.listInstalled.mockReset();
});

// ── /skill ────────────────────────────────────────────────────────────────────

describe('buildSkillCommand', () => {
  it('reports missing loader gracefully', async () => {
    const res = await buildSkillCommand(undefined).run('');
    expect(res?.message).toContain('No skill loader');
  });

  it('reports "no skills" when listEntries is empty', async () => {
    const res = await buildSkillCommand(fakeLoader()).run('');
    expect(res?.message).toContain('No skills found');
  });

  it('lists available skills with triggers and scope tag', async () => {
    const loader = fakeLoader({
      listEntries: vi.fn().mockResolvedValue([
        { name: 'a', trigger: 'when X', scope: ['project', 'shared', 'user'] },
        { name: 'b', trigger: 'when Y', scope: [] },
      ]),
    });
    const res = await buildSkillCommand(loader).run('');
    expect(res?.message).toContain('Available skills');
    expect(res?.message).toContain('a');
    expect(res?.message).toContain('b');
    expect(res?.message).toContain('when X');
    expect(res?.message).toContain('when Y');
    expect(res?.message).toContain('project, shared, user');
  });

  it('reports "not found" when find returns undefined', async () => {
    const loader = fakeLoader({ find: vi.fn().mockResolvedValue(undefined) });
    const res = await buildSkillCommand(loader).run('mystery');
    expect(res?.message).toContain('not found');
  });

  it('returns body when skill exists', async () => {
    const loader = fakeLoader({
      find: vi.fn().mockResolvedValue({ name: 'real' }),
      readBody: vi.fn().mockResolvedValue('# Body\nDetails'),
    });
    const res = await buildSkillCommand(loader).run('real');
    expect(res?.message).toContain('# Body');
    expect(loader.readBody).toHaveBeenCalledWith('real');
  });

  it('trims arg before lookup', async () => {
    const loader = fakeLoader({
      find: vi.fn().mockResolvedValue({ name: 'real' }),
      readBody: vi.fn().mockResolvedValue('ok'),
    });
    await buildSkillCommand(loader).run('  real  ');
    expect(loader.find).toHaveBeenCalledWith('real');
  });
});

// ── /skill-gen ────────────────────────────────────────────────────────────────

describe('buildSkillGeneratorCommand', () => {
  it('exposes /skill-gen with help and description', () => {
    const cmd = buildSkillGeneratorCommand(undefined);
    expect(cmd.name).toBe('skill-gen');
    expect(cmd.help).toBeDefined();
    expect(cmd.description).toBeDefined();
  });

  it('list without loader reports unavailable', async () => {
    const res = await buildSkillGeneratorCommand(undefined).run('list');
    expect(res?.message).toContain('No skill loader');
  });

  it('list (and ls alias) report empty when no skills', async () => {
    const cmd = buildSkillGeneratorCommand(fakeLoader());
    expect((await cmd.run('list'))?.message).toContain('No skills found');
    expect((await cmd.run('ls'))?.message).toContain('No skills found');
  });

  it('list renders entries with source-glyph icons', async () => {
    const loader = fakeLoader({
      listEntries: vi.fn().mockResolvedValue([
        { name: 'proj-skill', source: 'project', trigger: 'when project' },
        { name: 'user-skill', source: 'user', trigger: 'when user' },
        { name: 'pkg-skill', source: 'bundled', trigger: 'when bundled' },
      ]),
    });
    const res = await buildSkillGeneratorCommand(loader).run('list');
    const msg = res?.message ?? '';
    expect(msg).toContain('📁');
    expect(msg).toContain('👤');
    expect(msg).toContain('📦');
    expect(msg).toContain('proj-skill');
    expect(msg).toContain('user-skill');
    expect(msg).toContain('pkg-skill');
  });

  it('edit without loader reports unavailable', async () => {
    const res = await buildSkillGeneratorCommand(undefined).run('edit something');
    expect(res?.message).toContain('No skill loader');
  });

  it('edit on unknown name reports not found', async () => {
    const loader = fakeLoader({ find: vi.fn().mockResolvedValue(undefined) });
    const res = await buildSkillGeneratorCommand(loader).run('edit mystery');
    expect(res?.message).toContain('not found');
  });

  it('edit returns formatted skill body when found', async () => {
    const loader = fakeLoader({
      find: vi.fn().mockResolvedValue({ path: '/skills/x/SKILL.md' }),
      readBody: vi.fn().mockResolvedValue('# X\nBody contents'),
    });
    const res = await buildSkillGeneratorCommand(loader).run('edit x');
    expect(res?.message).toContain('Skill: x');
    expect(res?.message).toContain('Path: /skills/x/SKILL.md');
    expect(res?.message).toContain('# X');
  });

  it('default (no subcommand) returns runText to launch AI-guided flow', async () => {
    const res = await buildSkillGeneratorCommand(undefined).run('');
    expect(res?.message).toContain('AI will guide you');
    expect(res?.runText).toMatch(/skill-creator|guide me/i);
  });

  it('arbitrary text triggers the AI-guided flow too', async () => {
    const res = await buildSkillGeneratorCommand(undefined).run('help me');
    expect(res?.runText).toBeTruthy();
  });
});

// ── /skill-install ───────────────────────────────────────────────────────────

describe('buildSkillInstallCommand', () => {
  it('exposes name and frontmatter', () => {
    const cmd = buildSkillInstallCommand(undefined);
    expect(cmd.name).toBe('skill-install');
    expect(cmd.argsHint).toBeDefined();
    expect(cmd.help).toBeDefined();
  });

  it('returns usage when ref missing', async () => {
    const res = await buildSkillInstallCommand(undefined).run('', fakeCtx());
    expect(res?.message).toContain('Usage:');
  });

  it('reports "no skills found" when install returns empty', async () => {
    installerMocks.install.mockResolvedValue([]);
    const res = await buildSkillInstallCommand(undefined).run('user/repo', fakeCtx());
    expect(res?.message).toContain('No skills found');
  });

  it('installs to project scope by default', async () => {
    installerMocks.install.mockResolvedValue([
      { name: 'thing', source: 'user/repo', ref: 'main', path: '/skills/thing' },
    ]);
    const res = await buildSkillInstallCommand(undefined).run('user/repo', fakeCtx());
    expect(installerMocks.install).toHaveBeenCalledWith('user/repo', { global: false });
    expect(res?.message).toContain('[project]');
    expect(res?.message).toContain('thing');
    expect(res?.message).toContain('/skills/thing');
  });

  it('--global routes to user-global scope', async () => {
    installerMocks.install.mockResolvedValue([
      { name: 'thing', source: 'user/repo', ref: 'main', path: '/p' },
    ]);
    const res = await buildSkillInstallCommand(undefined).run('user/repo --global', fakeCtx());
    expect(installerMocks.install).toHaveBeenCalledWith('user/repo', { global: true });
    expect(res?.message).toContain('[user-global]');
  });

  it('surfaces error message on install failure', async () => {
    installerMocks.install.mockRejectedValue(new Error('network down'));
    const res = await buildSkillInstallCommand(undefined).run('user/repo', fakeCtx());
    expect(res?.message).toContain('Install failed: network down');
  });

  it('handles non-Error throws', async () => {
    installerMocks.install.mockRejectedValue('plain string');
    const res = await buildSkillInstallCommand(undefined).run('user/repo', fakeCtx());
    expect(res?.message).toContain('plain string');
  });
});

// ── /skill-update ──────────────────────────────────────────────────────────────

describe('buildSkillUpdateCommand', () => {
  it('renders "no installed skills" when result has nothing', async () => {
    installerMocks.update.mockResolvedValue({ updated: [], unchanged: [], errors: [] });
    const res = await buildSkillUpdateCommand(undefined).run('', fakeCtx());
    expect(res?.message).toContain('No installed skills');
  });

  it('reports updates with ref transitions', async () => {
    installerMocks.update.mockResolvedValue({
      updated: [
        { name: 'a', oldRef: 'v1', newRef: 'v2' },
        { name: 'b', oldRef: 'main', newRef: 'main' },
      ],
      unchanged: [],
      errors: [],
    });
    const res = await buildSkillUpdateCommand(undefined).run('', fakeCtx());
    expect(res?.message).toContain('Updated 2 skill');
    expect(res?.message).toContain('v1 → v2');
    expect(res?.message).toContain('(refreshed)');
  });

  it('reports unchanged skills', async () => {
    installerMocks.update.mockResolvedValue({ updated: [], unchanged: ['x', 'y'], errors: [] });
    const res = await buildSkillUpdateCommand(undefined).run('', fakeCtx());
    expect(res?.message).toContain('Up to date: x, y');
  });

  it('reports per-skill errors', async () => {
    installerMocks.update.mockResolvedValue({
      updated: [],
      unchanged: [],
      errors: [{ name: 'broken', error: 'auth failed' }],
    });
    const res = await buildSkillUpdateCommand(undefined).run('', fakeCtx());
    expect(res?.message).toContain('broken: auth failed');
  });

  it('passes a specific name+global flag through', async () => {
    installerMocks.update.mockResolvedValue({ updated: [], unchanged: [], errors: [] });
    await buildSkillUpdateCommand(undefined).run('my-skill --global', fakeCtx());
    expect(installerMocks.update).toHaveBeenCalledWith('my-skill', { global: true });
  });

  it('catches thrown errors', async () => {
    installerMocks.update.mockRejectedValue(new Error('boom'));
    const res = await buildSkillUpdateCommand(undefined).run('', fakeCtx());
    expect(res?.message).toContain('Update failed: boom');
  });
});

// ── /skill-uninstall ───────────────────────────────────────────────────────────

describe('buildSkillUninstallCommand', () => {
  it('lists installed skills when no name given (project scope)', async () => {
    installerMocks.listInstalled.mockResolvedValue([
      { name: 'a', source: 'u/r', ref: 'v1', installedAt: '2026-01-15T00:00:00Z', scope: 'project' },
      { name: 'b', source: 'u/s', ref: 'main', installedAt: '2026-02-01T00:00:00Z', scope: 'user' },
    ]);
    const res = await buildSkillUninstallCommand(undefined).run('', fakeCtx());
    expect(res?.message).toContain('Installed skills (project)');
    expect(res?.message).toContain('a');
    expect(res?.message).not.toContain('b'); // filtered to project scope
  });

  it('lists nothing when both scopes empty', async () => {
    installerMocks.listInstalled.mockResolvedValue([]);
    const res = await buildSkillUninstallCommand(undefined).run('', fakeCtx());
    expect(res?.message).toContain('No installed skills');
  });

  it('lists nothing when scope filter empties result', async () => {
    installerMocks.listInstalled.mockResolvedValue([
      { name: 'a', source: 's', ref: 'r', installedAt: '2026-01-01T00:00:00Z', scope: 'user' },
    ]);
    const res = await buildSkillUninstallCommand(undefined).run('', fakeCtx());
    expect(res?.message).toContain('No installed skills found (project scope)');
  });

  it('--global lists user-scoped skills', async () => {
    installerMocks.listInstalled.mockResolvedValue([
      { name: 'g', source: 's', ref: 'r', installedAt: '2026-02-01T00:00:00Z', scope: 'user' },
    ]);
    const res = await buildSkillUninstallCommand(undefined).run('--global', fakeCtx());
    expect(res?.message).toContain('Installed skills (user)');
    expect(res?.message).toContain('g');
  });

  it('uninstalls by name when name given', async () => {
    installerMocks.uninstall.mockResolvedValue(undefined);
    const res = await buildSkillUninstallCommand(undefined).run('thing', fakeCtx());
    expect(installerMocks.uninstall).toHaveBeenCalledWith('thing', { global: false });
    expect(res?.message).toContain('uninstalled');
  });

  it('--global routes to user-scope uninstall', async () => {
    installerMocks.uninstall.mockResolvedValue(undefined);
    await buildSkillUninstallCommand(undefined).run('thing --global', fakeCtx());
    expect(installerMocks.uninstall).toHaveBeenCalledWith('thing', { global: true });
  });

  it('reports failure when uninstall throws', async () => {
    installerMocks.uninstall.mockRejectedValue(new Error('ENOENT'));
    const res = await buildSkillUninstallCommand(undefined).run('missing', fakeCtx());
    expect(res?.message).toContain('Uninstall failed: ENOENT');
  });

  it('handles non-Error throws on uninstall', async () => {
    installerMocks.uninstall.mockRejectedValue('reason');
    const res = await buildSkillUninstallCommand(undefined).run('m', fakeCtx());
    expect(res?.message).toContain('reason');
  });
});
