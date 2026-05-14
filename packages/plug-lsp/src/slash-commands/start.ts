import type { SlashCommand } from '@wrongstack/core';
import type { LSPRegistry } from '../registry.js';

export function startCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'start',
    description: 'Start an LSP server.',
    async run(args) {
      const name = args.trim();
      if (!name) return { message: 'Usage: /@wrongstack/plug-lsp:start <name>' };
      await registry.start(name);
      return { message: `Started LSP server "${name}".` };
    },
  };
}
