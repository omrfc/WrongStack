import * as os from 'node:os';
import * as path from 'node:path';
import { SkillInstaller } from '@wrongstack/core/skills';
import { projectHash } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

function makeInstaller(opts: SlashCommandContext, projectRoot: string, global?: boolean) {
  const globalRoot = path.join(os.homedir(), '.wrongstack');
  return new SkillInstaller({
    manifestPath: path.join(globalRoot, 'installed-skills.json'),
    projectSkillsDir: path.join(projectRoot, '.wrongstack', 'skills'),
    globalSkillsDir: path.join(globalRoot, 'skills'),
    projectHash: projectHash(projectRoot),
    skillLoader: opts.skillLoader,
  });
}

export function buildSkillInstallCommand(opts: SlashCommandContext): SlashCommand {
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
    async run(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const ref = parts.find((p) => !p.startsWith('--'));
      const isGlobal = parts.includes('--global');

      if (!ref) {
        return { message: 'Usage: /skill-install <user/repo[@ref]> [--global]' };
      }

      const installer = makeInstaller(opts, ctx.projectRoot, isGlobal);

      try {
        const results = await installer.install(ref, { global: isGlobal });

        if (results.length === 0) {
          return { message: 'No skills found in the repository.' };
        }

        const scope = isGlobal ? 'user-global' : 'project';
        const lines = [`Installed ${results.length} skill(s) [${scope}]:`];
        for (const r of results) {
          lines.push(`  ✓ ${r.name} (${r.source}@${r.ref})`);
          lines.push(`    → ${r.path}`);
        }
        return { message: lines.join('\n') };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.renderer.writeError(`Install failed: ${msg}`);
        return { message: `✗ Install failed: ${msg}` };
      }
    },
  };
}

export function buildSkillUpdateCommand(opts: SlashCommandContext): SlashCommand {
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
    async run(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const nameOrRef = parts.find((p) => !p.startsWith('--'));
      const isGlobal = parts.includes('--global');

      const installer = makeInstaller(opts, ctx.projectRoot, isGlobal);

      try {
        const result = await installer.update(nameOrRef, { global: isGlobal });

        const lines: string[] = [];

        if (result.updated.length > 0) {
          lines.push(`Updated ${result.updated.length} skill(s):`);
          for (const u of result.updated) {
            if (u.oldRef !== u.newRef) {
              lines.push(`  ✓ ${u.name} (${u.oldRef} → ${u.newRef})`);
            } else {
              lines.push(`  ✓ ${u.name} (refreshed)`);
            }
          }
        }

        if (result.unchanged.length > 0) {
          lines.push(`Up to date: ${result.unchanged.join(', ')}`);
        }

        if (result.errors.length > 0) {
          for (const e of result.errors) {
            lines.push(`  ✗ ${e.name}: ${e.error}`);
          }
        }

        if (lines.length === 0) {
          return { message: 'No installed skills to update.' };
        }

        return { message: lines.join('\n') };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { message: `✗ Update failed: ${msg}` };
      }
    },
  };
}

export function buildSkillUninstallCommand(opts: SlashCommandContext): SlashCommand {
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
    async run(args, ctx) {
      const parts = args.trim().split(/\s+/);
      const name = parts.find((p) => !p.startsWith('--'));
      const isGlobal = parts.includes('--global');

      if (!name) {
        // List installed skills when no name given
        const installer = makeInstaller(opts, ctx.projectRoot, isGlobal);
        const installed = await installer.listInstalled();
        if (installed.length === 0) {
          return { message: 'No installed skills found.' };
        }
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

      const installer = makeInstaller(opts, ctx.projectRoot, isGlobal);

      try {
        await installer.uninstall(name, { global: isGlobal });
        return { message: `✓ Skill "${name}" uninstalled.` };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { message: `✗ Uninstall failed: ${msg}` };
      }
    },
  };
}
