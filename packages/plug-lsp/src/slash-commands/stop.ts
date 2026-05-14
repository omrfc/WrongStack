import type { SlashCommand } from '@wrongstack/core';
import type { LSPRegistry } from '../registry.js';

export function stopCommand(registry: LSPRegistry): SlashCommand {
  return {
    name: 'stop',
    description: 'Stop an LSP server.',
    async run(args) {
      const name = args.trim();
      if (!name) return { message: 'Usage: /@wrongstack/plug-lsp:stop <name>' };
      await registry.stop(name);
      return { message: `Stopped LSP server "${name}".` };
    },
  };
}
