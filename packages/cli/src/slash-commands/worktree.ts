import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/**
 * /worktree — inspect and manage the git worktrees AutoPhase uses for per-phase
 * isolation. Subcommands: list (default), merge <branch>, prune, clean.
 */
export function buildWorktreeCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'worktree',
    aliases: ['wt'],
    description: 'Inspect/manage git worktrees used for AutoPhase per-phase isolation.',
    argsHint: '[list | merge <branch> | prune | clean]',
    help: [
      'Usage: /worktree [subcommand]',
      '',
      '  list             List active worktrees (default).',
      '  merge <branch>   Squash-merge <branch> into the current branch.',
      '  prune            Remove stale worktree administrative entries.',
      '  clean            Remove all wstack-managed worktrees and branches.',
      '',
      'AutoPhase allocates one worktree per phase under .wrongstack/worktrees/',
      'so parallelizable phases run isolated, then merge back sequentially.',
    ].join('\n'),

    async run(args) {
      if (!opts.onWorktree) {
        return { message: '⚠ No worktree manager active in this session.' };
      }
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? 'list').toLowerCase();

      switch (sub) {
        case 'list':
          return { message: await opts.onWorktree('list') };
        case 'merge': {
          const branch = parts[1];
          if (!branch) return { message: 'Usage: /worktree merge <branch>' };
          return { message: await opts.onWorktree('merge', branch) };
        }
        case 'prune':
          return { message: await opts.onWorktree('prune') };
        case 'clean':
          return { message: await opts.onWorktree('clean') };
        default:
          return {
            message: `Unknown subcommand "${sub}". Valid: list, merge <branch>, prune, clean.`,
          };
      }
    },
  };
}
