import type { Plugin } from '../types/plugin.js';
import type { SlashCommand, Context } from '../index.js';
import { DefaultPromptStore } from '../storage/prompt-store.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

interface PromptsPluginOptions {
  store?: DefaultPromptStore;
  paths?: WstackPaths;
}

/**
 * PromptsPlugin — built-in prompt library.
 *
 * Registers `/prompts` slash command so users can manage a personal
 * prompt library. Active by default for all WrongStack sessions.
 * No configuration required.
 */
export function createPromptsPlugin(opts?: PromptsPluginOptions): Plugin {
  let store: DefaultPromptStore | null = null;

  return {
    name: 'wstack-prompts',
    version: '1.0.0',
    description: 'Personal prompt library with LLM-powered enhancements',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      const rawConfig = api.config as unknown as Record<string, unknown>;
      const paths = opts?.paths ?? (rawConfig.paths as WstackPaths | undefined);
      store = opts?.store ?? (paths ? new DefaultPromptStore(paths) : null);

      api.slashCommands.register(buildPromptsCommand(store));
      api.log.info('[prompts] loaded — /prompts available');
    },

    teardown(api) {
      api.slashCommands.unregister('prompts');
      api.log.info('[prompts] unloaded');
    },

    async health() {
      return { ok: true, message: 'Prompt store accessible' };
    },
  };
}

function buildPromptsCommand(store: DefaultPromptStore | null): SlashCommand {
  return {
    name: 'prompts',
    description: 'Manage your prompt library: /prompts [list|view|add|delete|edit|extend]',
    async run(args: string, ctx: Context) {
      if (!store) return { message: 'Prompt store not available.' };

      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ');

      switch (verb) {
        case '':
        case 'list':
        case 'ls': {
          const entries = await store.list();
          if (entries.length === 0) {
            return { message: 'Prompt library empty. Add: /prompts add "title" "content"' };
          }
          const lines = entries.map(
            (e) => `  ${e.title}  ${dim(e.id)}  ${e.tags.join(', ') || ''}`,
          );
          return { message: `Prompt library (${entries.length}):\n${lines.join('\n')}\n` };
        }

        case 'view':
        case 'show': {
          if (!restJoined) return { message: 'Usage: /prompts view <title>' };
          const matches = await store.find(restJoined);
          if (matches.length === 0) return { message: `No prompt matching "${restJoined}".` };
          const entry = matches.find((m) => m.title.toLowerCase() === restJoined.toLowerCase()) ?? matches[0]!;
          const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
          return {
            message: `# ${entry.title}${tags}\n\n${entry.content}\n\n${dim(`id: ${entry.id} | created: ${entry.createdAt}`)}`,
          };
        }

        case 'add':
        case 'new': {
          const parsed = parseTitleContent(restJoined);
          if (!parsed.title) return { message: 'Usage: /prompts add "title" "prompt content"' };
          const entry = store.createNew(parsed.title, parsed.content);
          await store.save(entry);
          return { message: `Added prompt "${entry.title}" (${entry.id}).` };
        }

        case 'delete':
        case 'rm': {
          if (!restJoined) return { message: 'Usage: /prompts delete <title>' };
          const matches = await store.find(restJoined);
          if (matches.length === 0) return { message: `No prompt matching "${restJoined}".` };
          const exact = matches.find((m) => m.title.toLowerCase() === restJoined.toLowerCase()) ?? matches[0]!;
          const deleted = await store.delete(exact.id);
          return { message: deleted ? `Deleted "${exact.title}".` : 'Delete failed.' };
        }

        case 'edit':
        case 'update': {
          const parsed = parseTitleContent(restJoined);
          if (!parsed.title) return { message: 'Usage: /prompts edit "title" "new content"' };
          const matches = await store.find(parsed.title);
          if (matches.length === 0) return { message: `No prompt matching "${parsed.title}".` };
          const exact = matches.find((m) => m.title.toLowerCase() === parsed.title!.toLowerCase()) ?? matches[0]!;
          exact.content = parsed.content;
          exact.updatedAt = new Date().toISOString();
          await store.save(exact);
          return { message: `Updated "${exact.title}".` };
        }

        case 'extend': {
          if (!restJoined) return { message: 'Usage: /prompts extend "title" <instructions>' };
          const parsed = parseTitleContent(restJoined);
          if (!parsed.title) return { message: 'Usage: /prompts extend "title" <instructions>' };
          const matches = await store.find(parsed.title);
          if (matches.length === 0) return { message: `No prompt matching "${parsed.title}".` };
          const exact = matches.find((m) => m.title.toLowerCase() === parsed.title!.toLowerCase()) ?? matches[0]!;

          // ctx.provider is the Provider instance. Cast through unknown for the simple text-in/text-out interface.
          const prov = ctx.provider as unknown as {
            complete?: (model: string, text: string) => Promise<string>;
          };
          if (!prov?.complete) return { message: 'LLM not available. Configure a provider first.' };

          const enhanced = await prov.complete(ctx.model, [
            '[SYSTEM INSTRUCTIONS]',
            'You are a prompt engineering assistant. Improve the following prompt by integrating the additional instructions seamlessly. Keep the same tone and format. Return only the improved prompt.',
            '',
            `EXISTING PROMPT:\n${exact.content}`,
            '',
            `ADDITIONAL INSTRUCTIONS:\n${parsed.content}`,
            '',
            'Respond with ONLY the improved prompt, no commentary.',
          ].join('\n'));

          exact.content = enhanced.trim();
          exact.updatedAt = new Date().toISOString();
          await store.save(exact);
          return { message: `Extended "${exact.title}".\n\n${dim('New content:')}\n${exact.content}` };
        }

        default:
          return {
            message: `Unknown subcommand "${verb}". Try: list | view | add | delete | edit | extend`,
          };
      }
    },
  };
}

function parseTitleContent(args: string): { title: string; content: string } {
  const trimmed = args.trim();
  if (!trimmed) return { title: '', content: '' };
  const doubleMatch =
    /^"([^"]+)"\s+"([^"]+)"$/.exec(trimmed) || /^'([^']+)'\s+'([^']+)'$/.exec(trimmed);
  if (doubleMatch) return { title: doubleMatch[1]!, content: doubleMatch[2]! };
  const singleMatch = /^'([^']+)'\s+(.+)$/.exec(trimmed);
  if (singleMatch) return { title: singleMatch[1]!, content: singleMatch[2]! };
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return { title: trimmed, content: '' };
  return { title: trimmed.slice(0, firstSpace), content: trimmed.slice(firstSpace + 1) };
}

function dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}