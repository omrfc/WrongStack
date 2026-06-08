import {
  type Config,
  Container,
  DefaultConfigStore,
  DefaultErrorHandler,
  DefaultMemoryStore,
  DefaultModeStore,
  DefaultPermissionPolicy,
  DefaultRetryPolicy,
  DefaultSecretScrubber,
  DefaultSessionStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  DefaultTokenCounter,
  type EventBus,
  HybridCompactor,
  type Logger,
  type ModelsRegistry,
  TOKENS,
  type Tool,
  type WstackPaths,
} from '@wrongstack/core';
import type { DefaultSystemPromptBuilderOptions } from '@wrongstack/core';

export interface CreateContainerOptions {
  config: Config;
  wpaths: WstackPaths;
  logger: Logger;
  modelsRegistry: ModelsRegistry;
  /**
   * Optional event bus — passed to DefaultMemoryStore so plugins and
   * subsystems can react to memory mutations in real time.
   */
  events?: EventBus | undefined;
  permission?: {
    yolo?: boolean | undefined;
    yoloDestructive?: boolean | undefined;
    /** @deprecated Use `yoloDestructive`. */
    forceAllYolo?: boolean | undefined;
    /** When true, destructive ops prompt even in YOLO mode. */
    confirmDestructive?: boolean | undefined;
    promptDelegate?: (
      tool: Tool,
      input: unknown,
      suggestedPattern: string,
    ) => Promise<'yes' | 'no' | 'always' | 'deny'>;
  };
  compactor?: { preserveK?: number | undefined; eliseThreshold?: number | undefined };
  systemPrompt?: Partial<DefaultSystemPromptBuilderOptions> | undefined;
  /** Bundled skills directory path (resolved at boot time). */
  bundledSkillsDir?: string | undefined;
}

/**
 * Create a Container pre-bound with all default service implementations.
 * Both CLI and WebUI use this factory so container wiring stays in one place.
 */
export function createDefaultContainer(opts: CreateContainerOptions): Container {
  const { config, wpaths, logger, modelsRegistry } = opts;
  const container = new Container();

  const configStore = new DefaultConfigStore(config);
  container.bind(TOKENS.ConfigStore, () => configStore);
  container.bind(TOKENS.Logger, () => logger);
  container.bind(TOKENS.SecretScrubber, () => new DefaultSecretScrubber());
  container.bind(TOKENS.RetryPolicy, () => new DefaultRetryPolicy());
  container.bind(TOKENS.ErrorHandler, () => new DefaultErrorHandler());
  container.bind(TOKENS.ModelsRegistry, () => modelsRegistry);
  container.bind(
    TOKENS.TokenCounter,
    () => new DefaultTokenCounter({ registry: modelsRegistry, providerId: config.provider }),
  );

  const modeStore = new DefaultModeStore({ directory: wpaths.configDir });
  container.bind(TOKENS.ModeStore, () => modeStore);
  container.bind(
    TOKENS.SessionStore,
    () =>
      new DefaultSessionStore({
        dir: wpaths.projectSessions,
        // Scrub secrets out of persisted user/model turns (F-06). Tool output
        // is already scrubbed by the executor.
        secretScrubber: container.resolve(TOKENS.SecretScrubber),
      }),
  );

  const memoryStore = new DefaultMemoryStore({ paths: wpaths, events: opts.events });
  container.bind(TOKENS.MemoryStore, () => memoryStore);

  const skillLoader = new DefaultSkillLoader({ paths: wpaths, bundledDir: opts.bundledSkillsDir });
  container.bind(TOKENS.SkillLoader, () => skillLoader);

  if (opts.systemPrompt) {
    container.bind(
      TOKENS.SystemPromptBuilder,
      () => new DefaultSystemPromptBuilder(opts.systemPrompt as DefaultSystemPromptBuilderOptions),
    );
  }

  container.bind(
    TOKENS.PermissionPolicy,
    () => {
      const policyOptions: ConstructorParameters<typeof DefaultPermissionPolicy>[0] = {
        trustFile: wpaths.projectTrust,
        yolo: opts.permission?.yolo ?? false,
        yoloDestructive: opts.permission?.yoloDestructive ?? opts.permission?.forceAllYolo ?? false,
        confirmDestructive: opts.permission?.confirmDestructive ?? false,
      };
      if (opts.permission?.promptDelegate !== undefined) {
        policyOptions.promptDelegate = opts.permission.promptDelegate;
      }
      return new DefaultPermissionPolicy(policyOptions);
    },
  );

  container.bind(
    TOKENS.Compactor,
    () =>
      new HybridCompactor({
        preserveK: opts.compactor?.preserveK ?? 20,
        eliseThreshold: opts.compactor?.eliseThreshold ?? 0.7,
      }),
  );

  return container;
}
