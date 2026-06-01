import { runPluginManagementCommand } from '../../plugin-management.js';
import type { SubcommandHandler } from '../index.js';

export const pluginCmd: SubcommandHandler = async (args, deps) => {
  const result = await runPluginManagementCommand(args, {
    config: deps.config,
    configPath: deps.paths.globalConfig,
  });
  if (result.level === 'error') {
    deps.renderer.writeError(`${result.message}\n`);
  } else if (result.level === 'info') {
    deps.renderer.writeInfo(`${result.message}\n`);
  } else {
    deps.renderer.write(`${result.message}\n`);
  }
  return result.code;
};

export const usageCmd: SubcommandHandler = async (_args, deps) => {
  if (!deps.sessionStore) return 0;
  const list = await deps.sessionStore.list(100);
  let totalIn = 0;
  for (const s of list) totalIn += s.tokenTotal;
  deps.renderer.write(`Sessions: ${list.length}  total tokens: ${totalIn}\n`);
  return 0;
};
