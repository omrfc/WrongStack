import * as os from 'node:os';
import * as path from 'node:path';
import { color } from '../utils/color.js';
import { toErrorMessage } from '../utils/error.js';
import { projectHash, wstackGlobalRoot } from '../utils/wstack-paths.js';
import { SkillInstaller } from '../skills/skill-installer.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand, Context } from '../index.js';
import type { SkillLoader } from '../types/skill.js';

interface SkillsPluginOptions {
  skillLoader?: SkillLoader | undefined;
}

/**
 * SkillsPlugin — skill library + installer.
 *
 * Registers `/skill`, `/skill-gen`, `/skill-install`, `/skill-update`,
 * `/skill-uninstall`. First-party ("official") plugin, so the commands keep
 * their bare names. Needs a `SkillLoader` (injected by the host via
 * `config.skillLoader`); without one the commands report that and no-op.
 */
export function createSkillsPlugin(opts?: SkillsPluginOptions): Plugin {
  return {
    name: 'wstack-skills',
    version: '1.0.0',
    description: 'Skill library and GitHub installer: /skill, /skill-gen, /skill-install, ...',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      const rawConfig = api.config as never as Record<string, unknown>;
      const skillLoader = opts?.skillLoader ?? (rawConfig.skillLoader as SkillLoader | undefined);

      api.slashCommands.register(buildSkillCommand(skillLoader));
      api.slashCommands.register(buildSkillGeneratorCommand(skillLoader));
      api.slashCommands.register(buildSkillInstallCommand(skillLoader));
      api.slashCommands.register(buildSkillImportCommand(skillLoader));
      api.slashCommands.register(buildSkillUpdateCommand(skillLoader));
      api.slashCommands.register(buildSkillUninstallCommand(skillLoader));
      api.log.info('[skills] loaded — /skill, /skill-gen, /skill-install, /skill-import, /skill-update/uninstall available');
    },

    teardown(api) {
      for (const name of ['skill', 'skill-gen', 'skill-install', 'skill-import', 'skill-update', 'skill-uninstall']) {
        api.slashCommands.unregister(name);
      }
      api.log.info('[skills] unloaded');
    },

    async health() {
      return { ok: true, message: 'skills ready' };
    },
  };
}

function makeInstaller(skillLoader: SkillLoader | undefined, projectRoot: string): SkillInstaller {
  const globalRoot = wstackGlobalRoot();
  return new SkillInstaller({
    manifestPath: path.join(globalRoot, 'installed-skills.json'),
    projectSkillsDir: path.join(projectRoot, '.wrongstack', 'skills'),
    globalSkillsDir: path.join(globalRoot, 'skills'),
    projectHash: projectHash(projectRoot),
    skillLoader,
  });
}

export function buildSkillCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill',
    description: 'Show skill details or list available skills. Use /skill-gen to create new skills.',
    async run(args: string) {
      if (!skillLoader) return { message: 'No skill loader configured.' };
      if (!args.trim()) {
        const entries = await skillLoader.listEntries();
        if (entries.length === 0) return { message: 'No skills found.' };
        const lines = entries.map((e) => {
          const scopeTag =
            e.scope.length > 0 ? `  ${color.dim(`(${e.scope.slice(0, 3).join(', ')})`)}` : '';
          return `  ${color.bold(e.name)}${scopeTag}\n    Use when: ${e.trigger}`;
        });
        return { message: `Available skills:\n${lines.join('\n\n')}\n` };
      }
      const skill = await skillLoader.find(args.trim());
      if (!skill) return { message: `Skill "${args.trim()}" not found.` };
      return { message: await skillLoader.readBody(skill.name) };
    },
  };
}

export function buildSkillGeneratorCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill-gen',
    description: 'Create a new AI skill interactively. The AI will guide you.',
    help: [
      '╔═══ Skill Generator ═══╗',
      '',
      'Create new AI skills with AI guidance.',
      '',
      'Usage:',
      '  /skill-gen              Start skill creation',
      '  /skill-gen list         List existing skills',
      '  /skill-gen edit <name>  View an existing skill',
      '',
      'The AI will ask you questions and create the skill file.',
      'Skills are saved to .wrongstack/skills/<name>/SKILL.md',
    ].join('\n'),
    async run(args: string) {
      const trimmed = args.trim();

      if (trimmed === 'list' || trimmed === 'ls') {
        if (!skillLoader) return { message: 'No skill loader configured.' };
        const entries = await skillLoader.listEntries();
        if (entries.length === 0) return { message: 'No skills found.' };
        const lines = entries.map((e) => {
          const src =
            e.source === 'project' ? '📁'
            : e.source === 'user' ? '👤'
            : e.source === 'claude-project' || e.source === 'claude-user' ? '🌐'
            : e.source === 'extra' ? '➕'
            : '📦';
          return `  ${src} ${e.name}\n     ${e.trigger}`;
        });
        return { message: `Available Skills:\n${lines.join('\n\n')}\n` };
      }

      if (trimmed.startsWith('edit ')) {
        const skillName = trimmed.slice(5).trim();
        if (!skillLoader) return { message: 'No skill loader configured.' };
        const skill = await skillLoader.find(skillName);
        if (!skill) return { message: `Skill "${skillName}" not found.` };
        const body = await skillLoader.readBody(skillName);
        return { message: [`Skill: ${skillName}`, `Path: ${skill.path}`, '', body].join('\n') };
      }

      // AI-guided creation: return runText so the AI reads the skill-creator
      // skill and walks the user through it.
      return {
        message:
          '╔═══ Skill Generator ═══╗\n\nThe AI will guide you through creating a new skill.\nAnswer its questions naturally.',
        runText:
          'I want to create a new AI skill. Read the skill-creator skill and guide me through the process. Ask me questions one at a time — name, description, what to cover — then create the SKILL.md file.',
      };
    },
  };
}

export function buildSkillInstallCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill-install',
    description: 'Install skills from a GitHub repository.',
    argsHint: '<user/repo[@ref]> [--global]',
    help: [
      '╔═══ Skill Install ═══╗',
      '',
      'Install skills from a GitHub repository.',
      '',
      'Usage:',
      '  /skill-install <user/repo>              Install from default branch (main)',
      '  /skill-install <user/repo@ref>          Install specific tag/branch/commit',
      '  /skill-install <user/repo> --global     Install to user-global skills',
      '',
      'Supports both single-skill repos (SKILL.md at root)',
      'and multi-skill repos (skills/ subdirectory).',
      '',
      'Examples:',
      '  /skill-install wrongstack/awesome-skills',
      '  /skill-install wrongstack/skills@v1.0',
      '  /skill-install user/my-skills --global',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/);
      const ref = parts.find((p) => !p.startsWith('--'));
      const isGlobal = parts.includes('--global');

      if (!ref) return { message: 'Usage: /skill-install <user/repo[@ref]> [--global]' };

      const installer = makeInstaller(skillLoader, ctx.projectRoot);

      try {
        const results = await installer.install(ref, { global: isGlobal });
        if (results.length === 0) return { message: 'No skills found in the repository.' };

        const scope = isGlobal ? 'user-global' : 'project';
        const lines = [`Installed ${results.length} skill(s) [${scope}]:`];
        for (const r of results) {
          lines.push(`  ✓ ${r.name} (${r.source}@${r.ref})`);
          lines.push(`    → ${r.path}`);
        }
        return { message: lines.join('\n') };
      } catch (err) {
        const msg = toErrorMessage(err);
        return { message: `✗ Install failed: ${msg}` };
      }
    },
  };
}

export function buildSkillImportCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill-import',
    description: 'Import skills from a local directory (.claude/skills, etc.) into .wrongstack/skills.',
    argsHint: '[<src-dir> | --from-claude] [--global] [--link]',
    help: [
      '╔═══ Skill Import ═══╗',
      '',
      'Copy (or symlink) skills from a local directory into .wrongstack/skills',
      'so you can edit and commit them. Foreign skills are already readable',
      'without importing — this takes ownership.',
      '',
      'Usage:',
      '  /skill-import --from-claude             Import project .claude/skills',
      '  /skill-import --from-claude --global    Import ~/.claude/skills',
      '  /skill-import /path/to/skills           Import from any directory',
      '  /skill-import --from-claude --link      Symlink instead of copy',
      '',
      'Each subdirectory with a valid SKILL.md is imported.',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const isGlobal = parts.includes('--global');
      const link = parts.includes('--link');
      const fromClaude = parts.includes('--from-claude');
      const positional = parts.find((p) => !p.startsWith('--'));

      let srcDir: string | undefined;
      if (fromClaude) {
        srcDir = isGlobal
          ? path.join(os.homedir(), '.claude', 'skills')
          : path.join(ctx.projectRoot, '.claude', 'skills');
      } else if (positional) {
        srcDir = path.resolve(ctx.projectRoot, positional);
      } else {
        return { message: 'Usage: /skill-import <src-dir> | --from-claude [--global] [--link]' };
      }

      const installer = makeInstaller(skillLoader, ctx.projectRoot);
      try {
        const results = await installer.importFromDir(srcDir, { global: isGlobal, link });
        if (results.length === 0) {
          return { message: `No valid skills found in ${srcDir}.` };
        }
        const scope = isGlobal ? 'user-global' : 'project';
        const lines = [`Imported ${results.length} skill(s) [${scope}]${link ? ' (symlinked)' : ''}:`];
        for (const r of results) {
          lines.push(`  ✓ ${r.name}`);
          lines.push(`    → ${r.path}`);
        }
        return { message: lines.join('\n') };
      } catch (err) {
        return { message: `✗ Import failed: ${toErrorMessage(err)}` };
      }
    },
  };
}

export function buildSkillUpdateCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill-update',
    description: 'Update installed skills from their GitHub source.',
    argsHint: '[name|ref] [--global]',
    help: [
      '╔═══ Skill Update ═══╗',
      '',
      'Update installed skills from their GitHub source.',
      '',
      'Usage:',
      '  /skill-update                  Update all installed skills',
      '  /skill-update <name>           Update a specific skill',
      '  /skill-update <user/repo@ref>  Update to a different ref',
      '  /skill-update <name> --global  Update a global skill',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/);
      const nameOrRef = parts.find((p) => !p.startsWith('--'));
      const isGlobal = parts.includes('--global');

      const installer = makeInstaller(skillLoader, ctx.projectRoot);

      try {
        const result = await installer.update(nameOrRef, { global: isGlobal });
        const lines: string[] = [];

        if (result.updated.length > 0) {
          lines.push(`Updated ${result.updated.length} skill(s):`);
          for (const u of result.updated) {
            lines.push(
              u.oldRef !== u.newRef
                ? `  ✓ ${u.name} (${u.oldRef} → ${u.newRef})`
                : `  ✓ ${u.name} (refreshed)`,
            );
          }
        }
        if (result.unchanged.length > 0) lines.push(`Up to date: ${result.unchanged.join(', ')}`);
        if (result.errors.length > 0) {
          for (const e of result.errors) lines.push(`  ✗ ${e.name}: ${e.error}`);
        }
        if (lines.length === 0) return { message: 'No installed skills to update.' };

        return { message: lines.join('\n') };
      } catch (err) {
        const msg = toErrorMessage(err);
        return { message: `✗ Update failed: ${msg}` };
      }
    },
  };
}

export function buildSkillUninstallCommand(skillLoader?: SkillLoader): SlashCommand {
  return {
    name: 'skill-uninstall',
    description: 'Remove an installed skill.',
    argsHint: '<name> [--global]',
    help: [
      '╔═══ Skill Uninstall ═══╗',
      '',
      'Remove an installed skill and its files.',
      '',
      'Usage:',
      '  /skill-uninstall <name>             Remove from project skills',
      '  /skill-uninstall <name> --global    Remove from user-global skills',
    ].join('\n'),
    async run(args: string, ctx: Context) {
      const parts = args.trim().split(/\s+/);
      const name = parts.find((p) => !p.startsWith('--'));
      const isGlobal = parts.includes('--global');

      if (!name) {
        // List installed skills when no name given
        const installer = makeInstaller(skillLoader, ctx.projectRoot);
        const installed = await installer.listInstalled();
        if (installed.length === 0) return { message: 'No installed skills found.' };
        const scope = isGlobal ? 'user' : 'project';
        const filtered = installed.filter((s) => s.scope === scope);
        if (filtered.length === 0) {
          return { message: `No installed skills found (${scope} scope).` };
        }
        const lines = [`Installed skills (${scope}):`];
        for (const s of filtered) {
          lines.push(`  ${s.name}  ${s.source}@${s.ref}  (${s.installedAt.slice(0, 10)})`);
        }
        lines.push('', 'Use /skill-uninstall <name> to remove.');
        return { message: lines.join('\n') };
      }

      const installer = makeInstaller(skillLoader, ctx.projectRoot);

      try {
        await installer.uninstall(name, { global: isGlobal });
        return { message: `✓ Skill "${name}" uninstalled.` };
      } catch (err) {
        const msg = toErrorMessage(err);
        return { message: `✗ Uninstall failed: ${msg}` };
      }
    },
  };
}
