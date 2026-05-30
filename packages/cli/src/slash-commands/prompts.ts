import { color } from '@wrongstack/core';
import type { SlashCommand, Context, Provider } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { DefaultPromptStore } from '@wrongstack/core';

function getProvider(opts: SlashCommandContext, ctx: Context): { provider: Provider; model?: string } | null {
  if (opts.llmProvider && typeof opts.llmProvider.complete === 'function') {
    return { provider: opts.llmProvider, model: opts.llmModel };
  }
  if (ctx.provider && typeof (ctx.provider as Provider).complete === 'function') {
    return { provider: ctx.provider as Provider, model: ctx.model };
  }
  return null;
}

export function buildPromptsCommand(opts: SlashCommandContext): SlashCommand {
  const store = opts.paths ? new DefaultPromptStore(opts.paths) : null;

  return {
    name: 'prompts',
    description: 'Manage your prompt library: /prompts [list|view|add|delete|edit|extend]',
    async run(args: string, ctx: Context) {
      if (!store) return { message: 'Prompt store not available — paths not configured.' };
      const parts = args.trim().split(/\s+/);
      const verb = parts[0] ?? '';
      const rest = parts.slice(1);
      const restJoined = rest.join(' ');

      switch (verb) {
        case '':
        case 'list':
        case 'ls': {
          const entries = await store.list();
          if (entries.length === 0) {
            return { message: 'Prompt library is empty. Add one with /prompts add "title" "prompt content".' };
          }
          const lines = entries.map(
            (e) =>
              `  ${color.bold(e.title)}  ${color.dim(e.id)}  ${color.dim(e.tags.join(', ') || '')}`,
          );
          return {
            message: `Prompt library (${entries.length}):\n${lines.join('\n')}\n`,
          };
        }

        case 'view':
        case 'show': {
          if (!restJoined) return { message: 'Usage: /prompts view <title>' };
          const matches = await store.find(restJoined);
          if (matches.length === 0) return { message: `No prompt matching "${restJoined}".` };
          const exact = matches.find((m) => m.title.toLowerCase() === restJoined.toLowerCase());
          const entry = exact ?? matches[0];
          const tags = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
          return {
            message: `# ${entry.title}${tags}\n\n${entry.content}\n\n${color.dim(`id: ${entry.id} | created: ${entry.createdAt}`)}`,
          };
        }

        case 'add':
        case 'new': {
          // Parse: "title" "content" or title content
          const parsed = parseTitleContent(rest);
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
          const exact = matches.find((m) => m.title.toLowerCase() === restJoined.toLowerCase()) ?? matches[0];
          const deleted = await store.delete(exact.id);
          return { message: deleted ? `Deleted "${exact.title}".` : 'Delete failed.' };
        }

        case 'edit':
        case 'update': {
          if (!restJoined) return { message: 'Usage: /prompts edit "title" "new content"' };
          const parsed = parseTitleContent(rest);
          if (!parsed.title) return { message: 'Usage: /prompts edit "title" "new content"' };
          const matches = await store.find(parsed.title);
          if (matches.length === 0) return { message: `No prompt matching "${parsed.title}".` };
          const exact = matches.find((m) => m.title.toLowerCase() === parsed.title!.toLowerCase()) ?? matches[0];
          exact.content = parsed.content;
          exact.updatedAt = new Date().toISOString();
          await store.save(exact);
          return { message: `Updated "${exact.title}".` };
        }

        case 'extend': {
          if (!restJoined) return { message: 'Usage: /prompts extend "title" <additional instructions>' };
          const parsed = parseTitleContent(rest);
          if (!parsed.title) return { message: 'Usage: /prompts extend "title" <additional instructions>' };
          const matches = await store.find(parsed.title);
          if (matches.length === 0) return { message: `No prompt matching "${parsed.title}".` };
          const exact = matches.find((m) => m.title.toLowerCase() === parsed.title!.toLowerCase()) ?? matches[0];

          const prov = getProvider(opts, ctx);
          if (!prov) return { message: 'LLM not available for extend. Make sure a provider is configured.' };

          const enhanced = await prov.provider.complete(
            prov.model,
            `[SYSTEM INSTRUCTIONS]
You are a prompt engineering assistant. Improve the following prompt by integrating the additional instructions seamlessly. Keep the same tone and format. Return only the improved prompt content.

EXISTING PROMPT:
${exact.content}

ADDITIONAL INSTRUCTIONS:
${parsed.content}

Respond with ONLY the improved prompt, no commentary.`,
          );

          exact.content = enhanced.trim();
          exact.updatedAt = new Date().toISOString();
          await store.save(exact);
          return {
            message: `Extended "${exact.title}".\n\n${color.dim('New content:')}\n${exact.content}`,
          };
        }

        default:
          return {
            message: `Unknown subcommand "${verb}". Try: list | view | add | delete | edit | extend`,
          };
      }
    },
  };
}

/**
 * Parse "title" "content" as a pair, or fall back to title<space>content splitting
 * on the first space after the title if title has no quotes.
 */
function parseTitleContent(args: string): { title: string; content: string } {
  const trimmed = args.trim();
  if (!trimmed) return { title: '', content: '' };

  // Quoted: "title" "content"
  const doubleMatch = /^"([^"]+)"\s+"([^"]+)"$/.exec(trimmed) ||
    /^'([^']+)'\s+'([^']+)'$/.exec(trimmed);
  if (doubleMatch) return { title: doubleMatch[1], content: doubleMatch[2] };

  // Single quoted title + rest as content: 'title' rest of content
  const singleMatch = /^'([^']+)'\s+(.+)$/.exec(trimmed);
  if (singleMatch) return { title: singleMatch[1], content: singleMatch[2] };

  // No quotes — split on first space for title, rest is content
  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) return { title: trimmed, content: '' };
  return { title: trimmed.slice(0, firstSpace), content: trimmed.slice(firstSpace + 1) };
}