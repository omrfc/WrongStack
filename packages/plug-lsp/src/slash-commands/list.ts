import type { SlashCommand } from '@wrongstack/core';
import type { LSPRegistry } from '../registry.js';

export function listCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'list',
    description: 'List configured LSP servers.',
    async run() {
      const rows = registry.list().map((s) => {
        const langs = s.config.languages.join(',');
        return `${s.name.padEnd(18)} ${s.state.padEnd(14)} ${langs} ${s.rootPath}`;
      });
      return { message: rows.length ? rows.join('\n') : 'No LSP servers configured.' };
    },
  };
}
