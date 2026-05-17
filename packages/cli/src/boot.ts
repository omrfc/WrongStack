import { createRequire } from 'node:module';
import * as path from 'node:path';
/**
 * Boot phase — everything before the DI container wiring.
 * Extracted from index.ts so main() focuses on wire → execute.
 */
import {
  type Config,
  DefaultLogger,
  DefaultModelsRegistry,
  DefaultSessionStore,
  DefaultSkillLoader,
  type ModelsRegistry,
  type SecretVault,
  ToolRegistry,
  type WstackPaths,
} from '@wrongstack/core';
import { builtinToolsPack } from '@wrongstack/tools';
import { parseArgs } from './arg-parser.js';
import { bootConfig } from './boot-config.js';
import { ReadlineInputReader } from './input-reader.js';
import { runPicker, saveToGlobalConfig } from './picker.js';
import { runLaunchPrompts, runProjectCheck } from './pre-launch.js';
import { TerminalRenderer } from './renderer.js';
import { subcommands } from './subcommands/index.js';
import { patchConfig } from './utils.js';

export interface BootContext {
  config: Config;
  vault: SecretVault;
  wpaths: WstackPaths;
  cwd: string;
  projectRoot: string;
  userHome: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  modelsRegistry: ModelsRegistry;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  logger: DefaultLogger;
}

function resolveBundledSkillsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = req.resolve('@wrongstack/core/package.json');
    return path.join(path.dirname(corePkg), 'skills');
  } catch {
    return undefined;
  }
}

/**
 * Boot the CLI: parse args, load config, handle subcommand dispatch
 * (early exit), run interactive prompts (project check, provider picker,
 * mode/yolo). Returns a BootContext for the wiring phase, or an exit
 * code when the run should stop here.
 */
export async function boot(argv: string[]): Promise<BootContext | number> {
  const { flags, positional } = parseArgs(argv);

  // `wstack resume <id>` is sugar for `wstack --resume <id>`.
  if (positional[0] === 'resume' && positional[1] && !subcommands['__noop_resume_marker']) {
    flags['resume'] = positional[1];
    positional.splice(0, 2);
  }

  let bootResult;
  try {
    bootResult = await bootConfig(flags);
  } catch (err) {
    process.stderr.write(`Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const { paths, config: _config, vault } = bootResult;
  let config = _config;
  const { cwd, projectRoot, userHome, wpaths, pathResolver } = paths;
  void pathResolver; // used by callers via container binding

  const logger = new DefaultLogger({ level: config.log.level, file: wpaths.logFile });
  const renderer = new TerminalRenderer();
  const reader = new ReadlineInputReader({ historyFile: wpaths.historyFile });
  const modelsRegistry = new DefaultModelsRegistry({
    cacheFile: wpaths.modelsCache,
    ttlSeconds: 24 * 3600,
  });

  // Quick path: subcommand dispatch
  const first = positional[0];
  if (first && subcommands[first]) {
    const sessionStore = new DefaultSessionStore({ dir: wpaths.projectSessions });
    const skillLoader = new DefaultSkillLoader({
      paths: wpaths,
      bundledDir: resolveBundledSkillsDir(),
    });
    const toolRegistryForSubcmd = new ToolRegistry();
    toolRegistryForSubcmd.registerAllOrThrow(
      [...(builtinToolsPack.tools ?? [])],
      builtinToolsPack.name,
    );
    const code = await subcommands[first]!(positional.slice(1), {
      config,
      renderer,
      reader,
      sessionStore,
      skillLoader,
      toolRegistry: toolRegistryForSubcmd,
      modelsRegistry,
      paths: wpaths,
      vault,
      cwd,
      projectRoot,
      userHome,
    });
    await reader.close();
    return code;
  }

  const isSingleShot = positional.length > 0 || typeof flags['prompt'] === 'string';
  const isInteractiveTTY = !!process.stdin.isTTY && !isSingleShot;

  if (isInteractiveTTY) {
    const cont = await runProjectCheck({ projectRoot, renderer, reader });
    if (!cont) {
      await reader.close();
      return 0;
    }
  }

  // Provider + model selection
  const providerFlag = typeof flags['provider'] === 'string' ? flags['provider'] : undefined;
  const modelFlag = typeof flags['model'] === 'string' ? flags['model'] : undefined;
  if (!(!!providerFlag && !!modelFlag)) {
    if (process.stdin.isTTY) {
      const picked = await runPicker({
        modelsRegistry,
        renderer,
        reader,
        config,
        defaultProvider: providerFlag ?? config.provider,
        defaultModel: modelFlag ?? config.model,
      });
      if (!picked) {
        if (!config.provider || !config.model) {
          await reader.close();
          return 2;
        }
      } else {
        const prevProvider = config.provider;
        const prevModel = config.model;
        config = patchConfig(config, { provider: picked.provider, model: picked.model });
        if (picked.provider !== prevProvider || picked.model !== prevModel) {
          const saved = await saveToGlobalConfig(
            wpaths.globalConfig,
            picked.provider,
            picked.model,
          );
          if (saved) renderer.writeInfo(`Saved ${picked.provider}/${picked.model} as default.\n`);
        }
      }
    } else if (!config.provider || !config.model) {
      process.stderr.write(
        'No provider or model configured. Run `wrongstack init` first, or pass --provider <id> --model <id>.\n',
      );
      await reader.close();
      return 2;
    }
  }

  // Mode + YOLO prompts
  if (isInteractiveTTY) {
    let modePinned: 'tui' | 'repl' | undefined;
    if (flags['no-tui']) modePinned = 'repl';
    else if (flags['tui']) modePinned = 'tui';
    const yoloPinned: boolean | undefined = flags['yolo'] === true ? true : undefined;
    const choices = await runLaunchPrompts({ renderer, reader, modePinned, yoloPinned });
    if (choices.mode === 'tui') {
      flags['tui'] = true;
      flags['no-tui'] = false;
    } else {
      flags['tui'] = false;
      flags['no-tui'] = true;
    }
    if (choices.yolo !== config.yolo) config = patchConfig(config, { yolo: choices.yolo });
  }

  return {
    config,
    vault,
    wpaths,
    cwd,
    projectRoot,
    userHome,
    flags,
    positional,
    modelsRegistry,
    renderer,
    reader,
    logger,
  };
}
