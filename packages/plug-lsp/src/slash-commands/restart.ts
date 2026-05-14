import type { SlashCommand } from '@wrongstack/core';
import type { LSPRegistry } from '../registry.js';

export function restartCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'restart',
    description: 'Restart an LSP server.',
    async run(args) {
      const name = args.trim();
      if (!name) return { message: 'Usage: /@wrongstack/plug-lsp:restart <name>' };
      await registry.restart(name);
      return { message: `Restarted LSP server "${name}".` };
    },
  };
}
