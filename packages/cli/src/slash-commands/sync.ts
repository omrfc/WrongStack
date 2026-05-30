import { color } from '@wrongstack/core';
import type { SlashCommand, Context } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { CloudSync, type SyncCategory, ALL_SYNC_CATEGORIES } from '@wrongstack/core';
import type { SyncConfig } from '@wrongstack/core';

function getSyncConfig(opts: SlashCommandContext): SyncConfig | null {
  const raw = opts.configStore.get().sync;
  return (raw as SyncConfig | undefined) ?? null;
}

export function buildSyncCommand(opts: SlashCommandContext): SlashCommand {
  if (!opts.paths) {
    return {
      name: 'sync',
      description: 'Cloud sync: /sync [status|enable|disable|push|pull|categories]',
      async run() {
        return { message: 'CloudSync not available — paths not configured.' };
      },
    };
  }

  const cloud = new CloudSync(
    opts.paths,
    getSyncConfig,
    (cfg) => {
      opts.configStore.update({ sync: cfg } as Parameters<typeof opts.configStore.update>[0]);
      return Promise.resolve();
    },
  );

  return {
    name: 'sync',
    description: 'Cloud sync: /sync [status|enable|disable|push|pull|categories]',
    async run(args: string, ctx: Context) {
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ');

      switch (verb) {
        case '':
        case 'status': {
          const msg = await cloud.status();
          return { message: msg };
        }

        case 'enable': {
          // Parse: enable owner/repo TOKEN [categories...]
          const parts = restJoined.trim().split(/\s+/);
          if (parts.length < 2) {
            return { message: 'Usage: /sync enable owner/repo TOKEN [cat1 cat2 ...]' };
          }
          const [repo, token, ...cats] = parts;
          if (!repo.includes('/')) {
            return { message: 'Invalid repo format. Expected "owner/repo".' };
          }
          if (!token || token.length < 5) {
            return { message: 'Token appears invalid. Check your GitHub fine-grained PAT.' };
          }

          const categories: SyncCategory[] = cats.length > 0
            ? (cats as SyncCategory[])
            : ALL_SYNC_CATEGORIES;

          // Persist encrypted token + config
          const syncSection: SyncConfig = {
            enabled: true,
            repo,
            githubToken: token,
            categories,
            lastSyncedAt: undefined,
          };

          opts.configStore.update({ sync: syncSection } as Parameters<typeof opts.configStore.update>[0]);

          await cloud.loadState();
          return {
            message: [
              `${color.green('✓')} CloudSync enabled`,
              `  repo:       ${repo}`,
              `  categories: ${categories.join(', ')}`,
              '',
              `${color.dim('Run `/sync push` to upload your data to GitHub.')}`,
            ].join('\n'),
          };
        }

        case 'disable': {
          await cloud.disable();
          return { message: `${color.green('✓')} CloudSync disabled. Local data kept.` };
        }

        case 'push': {
          const cfg = getSyncConfig(opts);
          if (!cfg?.enabled) return { message: 'CloudSync is not enabled. Run `/sync enable`.' };

          const token = cfg.githubToken;
          if (!token) return { message: 'No GitHub token found. Run `/sync enable owner/repo TOKEN`.' };

          let result;
          try {
            result = await cloud.push(token);
          } catch (err) {
            return { message: `${color.red('Push failed')}: ${err instanceof Error ? err.message : String(err)}` };
          }

          if (result.ok) {
            // Update lastSyncedAt in config
            const updated: SyncConfig = { ...cfg, lastSyncedAt: new Date().toISOString() };
            opts.configStore.update({ sync: updated } as Parameters<typeof opts.configStore.update>[0]);
          }

          return { message: result.message };
        }

        case 'pull': {
          const cfg = getSyncConfig(opts);
          if (!cfg?.enabled) return { message: 'CloudSync is not enabled. Run `/sync enable`.' };

          const token = cfg.githubToken;
          if (!token) return { message: 'No GitHub token found. Run `/sync enable owner/repo TOKEN`.' };

          let result;
          try {
            result = await cloud.pull(token);
          } catch (err) {
            return { message: `${color.red('Pull failed')}: ${err instanceof Error ? err.message : String(err)}` };
          }

          if (result.ok) {
            const updated: SyncConfig = { ...cfg, lastSyncedAt: new Date().toISOString() };
            opts.configStore.update({ sync: updated } as Parameters<typeof opts.configStore.update>[0]);
          }

          return { message: result.message };
        }

        case 'categories': {
          // /sync categories add <cat> | remove <cat> | list
          const [action, ...catRest] = restJoined.trim().split(/\s+/);
          const cfg = getSyncConfig(opts);
          if (!cfg?.enabled) return { message: 'CloudSync is not enabled.' };

          if (action === 'list' || !action) {
            return {
              message: [
                `${color.bold('Synced categories')}: ${cfg.categories.join(', ')}`,
                '',
                `${color.dim('Available: ' + ALL_SYNC_CATEGORIES.join(', '))}`,
                `${color.dim('Update: /sync categories add <name> | remove <name>')}`,
              ].join('\n'),
            };
          }

          if (action === 'add') {
            const catName = catRest[0] as SyncCategory;
            if (!ALL_SYNC_CATEGORIES.includes(catName)) {
              return { message: `Unknown category "${catName}". Available: ${ALL_SYNC_CATEGORIES.join(', ')}` };
            }
            if (cfg.categories.includes(catName)) {
              return { message: `"${catName}" is already synced.` };
            }
            const updated: SyncConfig = { ...cfg, categories: [...cfg.categories, catName] };
            opts.configStore.update({ sync: updated } as Parameters<typeof opts.configStore.update>[0]);
            return { message: `${color.green('✓')} Added "${catName}" to sync categories.` };
          }

          if (action === 'remove') {
            const catName = catRest[0] as SyncCategory;
            if (!cfg.categories.includes(catName)) {
              return { message: `"${catName}" is not in sync categories.` };
            }
            const updated: SyncConfig = { ...cfg, categories: cfg.categories.filter((c) => c !== catName) };
            opts.configStore.update({ sync: updated } as Parameters<typeof opts.configStore.update>[0]);
            return { message: `${color.green('✓')} Removed "${catName}" from sync categories.` };
          }

          return { message: 'Usage: /sync categories list | add <name> | remove <name>' };
        }

        default:
          return {
            message: [
              `${color.bold('/sync — Cloud Sync')}`,
              '',
              `  ${color.cyan('/sync status')}        Show current sync status`,
              `  ${color.cyan('/sync enable')} owner/repo TOKEN  Enable for a repo`,
              `  ${color.cyan('/sync disable')}       Disable sync (keeps local data)`,
              `  ${color.cyan('/sync push')}          Upload selected categories`,
              `  ${color.cyan('/sync pull')}          Download from repo`,
              `  ${color.cyan('/sync categories')}    List/add/remove synced categories`,
              '',
              `${color.dim('Categories: ' + ALL_SYNC_CATEGORIES.join(', '))}`,
            ].join('\n'),
          };
      }
    },
  };
}