import { parseAuthFlags } from '../../arg-parser.js';
import { runAuthDirect, runAuthMenu } from '../../auth-menu.js';
import type { SubcommandHandler } from '../index.js';

export const authCmd: SubcommandHandler = async (args, deps) => {
  const flags = parseAuthFlags(args);
  const menuDeps = {
    renderer: deps.renderer,
    reader: deps.reader,
    modelsRegistry: deps.modelsRegistry,
    vault: deps.vault,
    globalConfigPath: deps.paths.globalConfig,
  };
  if (flags.positional.length === 0) return runAuthMenu(menuDeps);
  return runAuthDirect(menuDeps, {
    providerId: flags.positional[0]!,
    label: flags.label,
    family: flags.family,
    baseUrl: flags.baseUrl,
    envVars: flags.envVars,
  });
};
