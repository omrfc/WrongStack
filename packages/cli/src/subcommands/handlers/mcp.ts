import * as fs from 'node:fs/promises';
import { atomicWrite } from '@wrongstack/core';
import { allServers } from '@wrongstack/core/infrastructure';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';

const BUILT_IN_MCP = allServers();

export const mcpCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];
  if (!sub || sub === 'list') {
    const servers = deps.config.mcpServers ?? {};
    if (Object.keys(servers).length === 0) {
      deps.renderer.write('No MCP servers configured.\n');
      deps.renderer.write('Use `wstack mcp add <name>` or set mcpServers in your config.\n');
      return 0;
    }
    for (const [name, cfg] of Object.entries(servers)) {
      const status = cfg.enabled === false ? 'disabled' : 'enabled';
      const desc = cfg.description ? `  # ${cfg.description}` : '';
      deps.renderer.write(`  ${name.padEnd(20)} ${cfg.transport.padEnd(16)} ${status}${desc}\n`);
    }
    return 0;
  }
  if (sub === 'add') {
    return addMcpServer(args, deps);
  }
  if (sub === 'remove') {
    const name = args[1];
    if (!name) {
      deps.renderer.writeError('Usage: wstack mcp remove <name>\n');
      return 1;
    }
    return removeMcpServer(name, deps);
  }
  if (sub === 'restart') {
    deps.renderer.writeWarning('mcp restart is only available in REPL mode. Use /mcp restart instead.');
    return 0;
  }
  deps.renderer.writeError(`Unknown mcp subcommand: ${sub}`);
  return 1;
};

async function addMcpServer(args: string[], deps: SubcommandDeps): Promise<number> {
  const name = args[1]!;
  const enable = args.includes('--enable') || args.includes('-e');
  if (!name) {
    deps.renderer.writeError('Usage: wstack mcp add <name>\n');
    deps.renderer.write('Available servers:\n');
    for (const [sname, scfg] of Object.entries(deps.config.mcpServers ?? {}))
      deps.renderer.write(`  ${sname.padEnd(20)} ${scfg.description ?? scfg.transport}\n`);
    if (Object.keys(deps.config.mcpServers ?? {}).length === 0)
      for (const k of Object.keys(BUILT_IN_MCP)) {
        const s = BUILT_IN_MCP[k]!;
        deps.renderer.write(`  ${k.padEnd(20)} ${s.description}\n`);
      }
    deps.renderer.write('\nRun `wstack mcp add <name> --enable` to enable immediately.\n');
    return 1;
  }
  const factory = BUILT_IN_MCP[name];
  if (!factory) {
    deps.renderer.writeError(
      `Unknown server "${name}". Run \`wstack mcp add\` without args to see available servers.\n`,
    );
    return 1;
  }
  const serverCfg = { ...factory };
  serverCfg.enabled = enable;
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(deps.paths.globalConfig, 'utf8'));
  } catch {
    /* fine */
  }
  const mcpServers =
    (existing.mcpServers as Record<string, Record<string, unknown>> | undefined) ?? {};
  if (mcpServers[name])
    deps.renderer.writeWarning(`Server "${name}" already in config. Updating.\n`);
  mcpServers[name] = serverCfg as unknown as Record<string, unknown>;
  existing.mcpServers = mcpServers;
  await atomicWrite(deps.paths.globalConfig, JSON.stringify(existing, null, 2), { mode: 0o600 });
  const verb = enable ? 'Enabled' : 'Added (disabled — set enabled:true to activate)';
  deps.renderer.writeInfo(
    `${verb} "${name}" (${serverCfg.transport}). Config written to ${deps.paths.globalConfig}.\n`,
  );
  return 0;
}

async function removeMcpServer(name: string, deps: SubcommandDeps): Promise<number> {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(deps.paths.globalConfig, 'utf8'));
  } catch {
    deps.renderer.writeError('No config file found.\n');
    return 1;
  }
  const mcpServers =
    (existing.mcpServers as Record<string, Record<string, unknown>> | undefined) ?? {};
  if (!mcpServers[name]) {
    deps.renderer.writeError(`Server "${name}" not in config.\n`);
    return 1;
  }
  delete mcpServers[name];
  existing.mcpServers = mcpServers;
  await atomicWrite(deps.paths.globalConfig, JSON.stringify(existing, null, 2), { mode: 0o600 });
  deps.renderer.writeInfo(`Removed "${name}" from config.\n`);
  return 0;
}
