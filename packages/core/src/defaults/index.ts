export { DefaultLogger, type DefaultLoggerOptions } from './logger.js';
export { DefaultPathResolver } from './path-resolver.js';
export { DefaultSecretScrubber } from './secret-scrubber.js';
export { DefaultRetryPolicy } from './retry-policy.js';
export { DefaultErrorHandler } from './error-handler.js';
export { DefaultTokenCounter } from './token-counter.js';
export { DefaultSessionStore, type SessionStoreOptions } from './session-store.js';
export {
  RecoveryLock,
  type RecoveryLockOptions,
  type AbandonedSession,
} from './recovery-lock.js';
export { QueueStore, type PersistedQueueItem } from './queue-store.js';
export {
  DefaultAttachmentStore,
  type AttachmentStoreOptions,
} from './attachment-store.js';
export {
  DefaultSecretVault,
  type SecretVaultOptions,
  decryptConfigSecrets,
  encryptConfigSecrets,
  rewriteConfigEncrypted,
  migratePlaintextSecrets,
} from './secret-vault.js';
export { DefaultMemoryStore, type MemoryStoreOptions } from './memory-store.js';
export { DefaultPermissionPolicy, type PermissionPolicyOptions } from './permission-policy.js';
export { DefaultSkillLoader, type SkillLoaderOptions } from './skill-loader.js';
export { DefaultConfigLoader, type ConfigLoaderOptions, type ConfigSource } from './config-loader.js';
export { HybridCompactor, type CompactorOptions } from './compactor.js';
export { IntelligentCompactor, type IntelligentCompactorOptions } from './intelligent-compactor.js';
export { SelectiveCompactor, type SelectiveCompactorOptions } from './selective-compactor.js';
export { LLMSelector, type LLMSelectorOptions } from './llm-selector.js';
export { AutoCompactionMiddleware } from './auto-compaction-middleware.js';
export {
  DefaultModelsRegistry,
  classifyFamily,
  type DefaultModelsRegistryOptions,
} from './models-registry.js';
export {
  DefaultModeStore,
  loadProjectModes,
  loadUserModes,
  type ModeLoaderOptions,
} from './mode-store.js';
export {
  DefaultMultiAgentCoordinator,
} from './multi-agent-coordinator.js';
export {
  InMemoryAgentBridge,
  InMemoryBridgeTransport,
  createMessage,
} from './agent-bridge.js';
export {
  AutonomousRunner,
  DoneConditionChecker,
  type DoneCheckResult,
  type AutonomousRunnerOptions,
} from './autonomous-runner.js';
export {
  SpecParser,
  type SpecParserOptions,
} from './spec-parser.js';
export {
  TaskGenerator,
  DefaultTaskStore,
  type TaskGeneratorOptions,
  type GeneratedTask,
} from './task-generator.js';
export {
  TaskTracker,
  type TaskStore,
  type TaskTrackerOptions,
  type TaskTransition,
} from './task-tracker.js';
export {
  TaskFlow,
  SpecDrivenDev,
  type TaskFlowPhase,
  type TaskFlowOptions,
  type TaskFlowExecutionContext,
  type TaskFlowEventMap,
  type TaskFlowEventName,
  type SpecDrivenDevOptions,
} from './task-flow.js';
// Types live in types/tool-executor.ts and are exported via types/index.ts.
// Here we only re-export the runtime value to avoid duplicate-symbol errors.
export { ToolExecutor } from './tool-executor.js';
export {
  contextManagerTool,
  createContextManagerTool,
  type ContextManagerInput,
  type ContextManagerResult,
  type ContextManagerAction,
  type ContextManagerToolOptions,
} from './context-manager.js';
