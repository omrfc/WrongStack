// =============================================================================
// @wrongstack/core — defaults barrel (backward-compatible re-exports)
//
// All implementation now lives in top-level domain directories under src/.
// This file re-exports for consumers that import from '@wrongstack/core/defaults'.
// New code should import directly from '@wrongstack/core/<domain>'.
// =============================================================================

// ---- Infrastructure (was core/) ----
export {
  DefaultLogger,
  type DefaultLoggerOptions,
} from '../infrastructure/logger.js';

// ---- Storage ----
export {
  DefaultSessionStore,
  type SessionStoreOptions,
} from '../storage/session-store.js';
export {
  QueueStore,
  type PersistedQueueItem,
} from '../storage/queue-store.js';
export {
  DefaultAttachmentStore,
  type AttachmentStoreOptions,
} from '../storage/attachment-store.js';
export {
  DefaultMemoryStore,
  type MemoryStoreOptions,
} from '../storage/memory-store.js';
export { DefaultConfigStore } from '../storage/config-store.js';
export {
  DefaultConfigLoader,
  type ConfigLoaderOptions,
  type ConfigSource,
} from '../storage/config-loader.js';
export {
  runConfigMigrations,
  ConfigMigrationError,
  DEFAULT_CONFIG_MIGRATIONS,
  type ConfigMigration,
  type MigrationContext,
  type MigrationResult,
} from '../storage/config-migration.js';
export {
  RecoveryLock,
  type RecoveryLockOptions,
  type AbandonedSession,
} from '../storage/recovery-lock.js';
export { DefaultSessionReader } from '../storage/session-reader.js';
export { SessionAnalyzer } from '../storage/session-analyzer.js';
export {
  attachTodosCheckpoint,
  loadTodosCheckpoint,
  saveTodosCheckpoint,
  type TodosCheckpointFile,
} from '../storage/todos-checkpoint.js';
export {
  attachPlanCheckpoint,
  loadPlan,
  savePlan,
  emptyPlan,
  addPlanItem,
  removePlanItem,
  setPlanItemStatus,
  clearPlan,
  formatPlan,
  type PlanItem,
  type PlanFile,
} from '../storage/plan-store.js';
export {
  DirectorStateCheckpoint,
  loadDirectorState,
  type DirectorStateSnapshot,
  type DirectorTaskState,
  type DirectorSubagentState,
} from '../storage/director-state.js';

// ---- Security ----
export { DefaultSecretScrubber } from '../security/secret-scrubber.js';
export {
  DefaultSecretVault,
  type SecretVaultOptions,
  decryptConfigSecrets,
  encryptConfigSecrets,
  rewriteConfigEncrypted,
  migratePlaintextSecrets,
} from '../security/secret-vault.js';
export {
  DefaultPermissionPolicy,
  AutoApprovePermissionPolicy,
  type PermissionPolicyOptions,
} from '../security/permission-policy.js';

// ---- Execution ----
export { DefaultRetryPolicy } from '../execution/retry-policy.js';
export { DefaultErrorHandler } from '../execution/error-handler.js';
export { DefaultSkillLoader, type SkillLoaderOptions } from '../execution/skill-loader.js';
export { HybridCompactor, type CompactorOptions } from '../execution/compactor.js';
export {
  IntelligentCompactor,
  type IntelligentCompactorOptions,
} from '../execution/intelligent-compactor.js';
export {
  SelectiveCompactor,
  type SelectiveCompactorOptions,
} from '../execution/selective-compactor.js';
export { AutoCompactionMiddleware } from '../execution/auto-compaction-middleware.js';
export { ToolExecutor } from '../execution/tool-executor.js';
export {
  AutonomousRunner,
  DoneConditionChecker,
  type DoneCheckResult,
  type AutonomousRunnerOptions,
} from '../execution/autonomous-runner.js';

// ---- Coordination (multi-agent) ----
export {
  Director,
  DirectorBudgetError,
} from '../coordination/director.js';
export {
  createDelegateTool,
  type DelegateHost,
  type CreateDelegateToolOptions,
} from '../coordination/delegate-tool.js';
export {
  DefaultMultiAgentCoordinator,
  type MultiAgentCoordinatorOptions,
} from '../coordination/multi-agent-coordinator.js';
export {
  SubagentBudget,
  BudgetExceededError,
  type BudgetKind,
  type BudgetLimits,
  type BudgetUsage,
} from '../coordination/subagent-budget.js';
export {
  makeAgentSubagentRunner,
  type AgentFactory,
  type AgentFactoryResult,
  type AgentRunnerOptions,
} from '../coordination/agent-subagent-runner.js';
export {
  FleetBus,
  FleetUsageAggregator,
  type FleetEvent,
  type FleetHandler,
  type FleetUsage,
  type SubagentUsageSnapshot,
} from '../coordination/fleet-bus.js';
export {
  makeDirectorSessionFactory,
  type DirectorSessionFactory,
  type DirectorSessionFactoryOptions,
} from '../coordination/director-session.js';
export {
  composeDirectorPrompt,
  composeSubagentPrompt,
  rosterSummaryFromConfigs,
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  type DirectorPromptParts,
  type SubagentPromptParts,
} from '../coordination/director-prompts.js';
export {
  InMemoryAgentBridge,
  InMemoryBridgeTransport,
  createMessage,
} from '../coordination/agent-bridge.js';
export {
  AUDIT_LOG_AGENT,
  BUG_HUNTER_AGENT,
  REFACTOR_PLANNER_AGENT,
  SECURITY_SCANNER_AGENT,
  FLEET_ROSTER,
  ALL_FLEET_AGENTS,
} from '../coordination/fleet.js';

// ---- Models ----
export {
  DefaultModelsRegistry,
  classifyFamily,
  type DefaultModelsRegistryOptions,
} from '../models/models-registry.js';
export {
  DefaultModeStore,
  loadProjectModes,
  loadUserModes,
  type ModeLoaderOptions,
} from '../models/mode-store.js';
export { LLMSelector, type LLMSelectorOptions } from '../models/llm-selector.js';

// ---- SDD ----
export { SpecParser } from '../sdd/spec-parser.js';
export {
  TaskGenerator,
  DefaultTaskStore,
  type TaskGeneratorOptions,
  type GeneratedTask,
} from '../sdd/task-generator.js';
export {
  TaskTracker,
  type TaskStore,
  type TaskTrackerOptions,
  type TaskTransition,
} from '../sdd/task-tracker.js';
export {
  TaskFlow,
  SpecDrivenDev,
  type TaskFlowPhase,
  type TaskFlowOptions,
  type TaskFlowExecutionContext,
  type TaskFlowEventMap,
  type TaskFlowEventName,
  type SpecDrivenDevOptions,
} from '../sdd/task-flow.js';

// ---- Observability ----
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
} from '../observability/index.js';

// ---- Context manager (tool) ----
export {
  contextManagerTool,
  createContextManagerTool,
  type ContextManagerInput,
  type ContextManagerResult,
  type ContextManagerAction,
  type ContextManagerToolOptions,
} from '../infrastructure/context-manager.js';

// ---- MCP servers ----
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
} from '../infrastructure/mcp-servers.js';
