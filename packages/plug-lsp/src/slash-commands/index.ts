import type { PluginAPI } from '@wrongstack/core';
import type { LSPRegistry } from '../registry.js';
import { diagnosticsCommand } from './diagnostics.js';
import { listCommand } from './list.js';
import { restartCommand } from './restart.js';
import { startCommand } from './start.js';
import { stopCommand } from './stop.js';

export function registerSlashCommands(api: PluginAPI, registry: LSPRegistry): string[] {
  const commands = [
    listCommand(registry),
    startCommand(registry),
    stopCommand(registry),
    restartCommand(registry),
    diagnosticsCommand(registry),
  ];
  for (const command of commands) api.slashCommands.register(command);
  return commands.map((cmd) => cmd.name);
}
