import type { ServerConfig } from './types.js';
import { PRESETS } from './presets.js';
import { resolveServerCommand } from './utils/command-resolver.js';

export async function autoDiscoverServers(
  userServers: Record<string, ServerConfig>,
  cwd = process.cwd(),
): Promise<Record<string, ServerConfig>> {
  const out = { ...userServers };
  for (const [name, cfg] of Object.entries(PRESETS)) {
    if (out[name]) continue;
    const command = await resolveServerCommand(cfg.command, cwd);
    if (command) out[name] = { ...cfg, command };
  }
  return out;
}
