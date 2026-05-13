// Core utilities: logger, path-resolver, token-counter
export * from './core/index.js';

// Storage: session, queue, attachment, memory
export * from './storage/index.js';

// Security: scrubber, vault, permission
export * from './security/index.js';

// Execution: retry, error, skill-loader, config-loader
export { DefaultRetryPolicy } from './retry-policy.js';
export { DefaultErrorHandler } from './error-handler.js';
export { DefaultSkillLoader, type SkillLoaderOptions } from './skill-loader.js';
export { DefaultConfigLoader, type ConfigLoaderOptions, type ConfigSource } from './config-loader.js';

// Compactors: hybrid, intelligent, selective, llm-selector, auto-compaction
export * from './compactors/index.js';

// Models & Modes: registry, mode-store
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

// Multi-agent: coordinator, agent-bridge
export { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
export * from './agents/index.js';

// Autonomous runner
export {
  AutonomousRunner,
  DoneConditionChecker,
  type DoneCheckResult,
  type AutonomousRunnerOptions,
} from './autonomous-runner.js';

// Spec-driven development: parser, task-generator, task-tracker, task-flow
export { SpecParser, type SpecParserOptions } from './spec-parser.js';
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

// Recovery & locking
export {
  RecoveryLock,
  type RecoveryLockOptions,
  type AbandonedSession,
} from './recovery-lock.js';

// Tool executor (runtime value only; types are in types/)
export { ToolExecutor } from './tool-executor.js';

// Context manager tool
export {
  contextManagerTool,
  createContextManagerTool,
  type ContextManagerInput,
  type ContextManagerResult,
  type ContextManagerAction,
  type ContextManagerToolOptions,
} from './context-manager.js';