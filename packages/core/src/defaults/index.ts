// Core utilities: logger, path-resolver, token-counter
export {
  DefaultLogger,
  type DefaultLoggerOptions,
  DefaultPathResolver,
  DefaultTokenCounter,
} from './core/index.js';

// Storage: session, queue, attachment, memory
export {
  DefaultSessionStore,
  type SessionStoreOptions,
  QueueStore,
  type PersistedQueueItem,
  DefaultAttachmentStore,
  type AttachmentStoreOptions,
  DefaultMemoryStore,
  type MemoryStoreOptions,
} from './storage/index.js';

// Security: scrubber, vault, permission
export {
  DefaultSecretScrubber,
  DefaultSecretVault,
  type SecretVaultOptions,
  decryptConfigSecrets,
  encryptConfigSecrets,
  rewriteConfigEncrypted,
  migratePlaintextSecrets,
  DefaultPermissionPolicy,
  type PermissionPolicyOptions,
} from './security/index.js';

// Execution: retry, error, skill-loader, config-loader
export { DefaultRetryPolicy } from './retry-policy.js';
export { DefaultErrorHandler } from './error-handler.js';
export { DefaultSkillLoader, type SkillLoaderOptions } from './skill-loader.js';
export { DefaultConfigLoader, type ConfigLoaderOptions, type ConfigSource } from './config-loader.js';
export { DefaultConfigStore } from './config-store.js';
export {
  runConfigMigrations,
  ConfigMigrationError,
  DEFAULT_CONFIG_MIGRATIONS,
  type ConfigMigration,
  type MigrationContext,
  type MigrationResult,
} from './config-migration.js';

// Compactors: hybrid, intelligent, selective, llm-selector, auto-compaction
export {
  HybridCompactor,
  type CompactorOptions,
  IntelligentCompactor,
  type IntelligentCompactorOptions,
  SelectiveCompactor,
  type SelectiveCompactorOptions,
  LLMSelector,
  type LLMSelectorOptions,
  AutoCompactionMiddleware,
} from './compactors/index.js';

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

// Multi-agent: coordinator, agent-bridge, budget
export {
  DefaultMultiAgentCoordinator,
  type MultiAgentCoordinatorOptions,
} from './multi-agent-coordinator.js';
export {
  SubagentBudget,
  BudgetExceededError,
  type BudgetKind,
  type BudgetLimits,
  type BudgetUsage,
} from './subagent-budget.js';
export {
  makeAgentSubagentRunner,
  type AgentFactory,
  type AgentFactoryResult,
  type AgentRunnerOptions,
} from './agent-subagent-runner.js';
// Director orchestration — per-subagent provider/model/session +
// fleet-wide observability + LLM-callable orchestration tools.
export {
  Director,
} from './director.js';
export {
  FleetBus,
  FleetUsageAggregator,
  type FleetEvent,
  type FleetHandler,
  type FleetUsage,
  type SubagentUsageSnapshot,
} from './fleet-bus.js';
export {
  makeDirectorSessionFactory,
  type DirectorSessionFactory,
  type DirectorSessionFactoryOptions,
} from './director-session.js';
export {
  composeDirectorPrompt,
  composeSubagentPrompt,
  rosterSummaryFromConfigs,
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  type DirectorPromptParts,
  type SubagentPromptParts,
} from './director-prompts.js';
export {
  InMemoryAgentBridge,
  InMemoryBridgeTransport,
  createMessage,
} from './agents/index.js';

// Autonomous runner
export {
  AutonomousRunner,
  DoneConditionChecker,
  type DoneCheckResult,
  type AutonomousRunnerOptions,
} from './autonomous-runner.js';

// Spec-driven development: parser, task-generator, task-tracker, task-flow
export { SpecParser } from './spec-parser.js';
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

// Session reader (L2-A): query/replay/search/export over SessionStore
export { DefaultSessionReader } from './session-reader.js';

// Observability: metrics, health, tracing (opt-in, noop by default)
export {
  InMemoryMetricsSink,
  NoopMetricsSink,
  DefaultHealthRegistry,
  NoopTracer,
  OTelTracer,
  wireMetricsToEvents,
  renderPrometheus,
  startMetricsServer,
  PROMETHEUS_CONTENT_TYPE,
  type MetricsServerOptions,
  type MetricsServerHandle,
  buildOtlpMetricsRequest,
  startOtlpMetricsExporter,
  type OtlpMetricsExporterOptions,
  type OtlpMetricsExporterHandle,
  buildOtlpTracesRequest,
  startOtlpTraceExporter,
  type OtlpTraceExporterOptions,
  type OtlpTraceExporterHandle,
} from './observability/index.js';

// Context manager tool
export {
  contextManagerTool,
  createContextManagerTool,
  type ContextManagerInput,
  type ContextManagerResult,
  type ContextManagerAction,
  type ContextManagerToolOptions,
} from './context-manager.js';

// MCP servers: built-in server presets (all disabled by default)
export {
  filesystemServer,
  githubServer,
  context7Server,
  braveSearchServer,
  blockServer,
  everArtServer,
  slackServer,
  awsServer,
  googleMapsServer,
  sentinelServer,
  allServers,
} from './mcp-servers.js';