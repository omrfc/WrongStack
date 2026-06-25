// =============================================================================
// @wrongstack/core — defaults barrel (backward-compatible re-exports)
//
// All implementation lives in top-level domain directories under src/.
// This file re-exports for consumers that use the defaults entrypoint.
// New code should import directly from the domain subpath.
//
// Sections:
//   Infrastructure   — Logger, TokenCounter, PathResolver, ContextManager, MCP servers
//   Storage          — SessionStore, MemoryStore, ConfigStore/Loader, Plan, Todos,
//                      RecoveryLock, SessionReader, DirectorState
//   Security         — SecretScrubber, SecretVault, PermissionPolicy
//   Execution        — RetryPolicy, ErrorHandler, SkillLoader, Compactors,
//                      ToolExecutor, AutonomousRunner, ProviderRunner
//   Coordination     — Director, Delegate, MultiAgentCoordinator, SubagentBudget,
//                      FleetBus, AgentBridge, Fleet roster presets
//   Models           — ModelsRegistry, ModeStore, LLMSelector
//   SDD              — SpecParser, TaskGenerator, TaskTracker, TaskFlow
//   Observability    — Metrics, Traces, Prometheus, OTLP, HealthRegistry
// =============================================================================
//
// =============================================================================

// ---- Infrastructure (was core/) ----
export {
  DefaultLogger,
  type DefaultLoggerOptions,
  type LogFormat,
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
  createSessionEventBridge,
  resolveAuditLevel,
  resolveSessionLoggingConfig,
  type SessionEventBridge,
  type AuditLevel,
  type SessionEventBridgeOptions,
  type SessionSamplingOptions,
  type ToolProgressSamplingOptions,
} from '../storage/session-event-bridge.js';
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
  deriveTodosFromPlanItem,
  type PlanItem,
  type PlanFile,
} from '../storage/plan-store.js';
export {
  listPlanTemplates,
  getPlanTemplate,
  formatPlanTemplates,
  type PlanTemplate,
} from '../storage/plan-templates.js';
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
export { DefaultProviderRunner } from '../execution/provider-runner-impl.js';
export {
  HybridCompactor,
  type CompactorOptions,
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_AUTONOMY_CONFIG,
} from '../execution/compactor.js';
export {
  IntelligentCompactor,
  type IntelligentCompactorOptions,
} from '../execution/intelligent-compactor.js';
export {
  SelectiveCompactor,
  type SelectiveCompactorOptions,
} from '../execution/selective-compactor.js';
export {
  createStrategyCompactor,
  type CompactorStrategy,
  type StrategyCompactorOptions,
} from '../execution/strategy-compactor.js';
export { AutoCompactionMiddleware } from '../execution/auto-compaction-middleware.js';
export { ToolExecutor } from '../execution/tool-executor.js';
export {
  AutonomousRunner,
  DoneConditionChecker,
  type DoneCheckResult,
  type AutonomousRunnerOptions,
} from '../execution/autonomous-runner.js';
export {
  EternalAutonomyEngine,
  type EternalAutonomyOptions,
  type EternalEngineState,
  type IterationStage,
} from '../execution/eternal-autonomy.js';
export {
  ParallelEternalEngine,
  type ParallelEternalOptions,
  type ParallelEngineState,
  type ParallelIterationStage,
} from '../execution/parallel-eternal-engine.js';
export {
  makeAutonomyPromptContributor,
  type AutonomyPromptContributorOptions,
} from '../execution/autonomy-prompt-contributor.js';
export { buildGoalPreamble } from '../execution/goal-preamble.js';

// ---- Coordination (multi-agent) ----
export {
  Director,
  FleetSpawnBudgetError,
} from '../coordination/director.js';
export {
  makeSpawnTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeAskTool,
  makeRollUpTool,
  makeTerminateTool,
  makeFleetStatusTool,
  makeFleetUsageTool,
  makeFleetSessionTool,
  makeFleetHealthTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
} from '../coordination/director-tools.js';
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
  FLEET_ROSTER_BUDGETS,
  applyRosterBudget,
  ALL_FLEET_AGENTS,
  type FleetRosterBudget,
} from '../coordination/fleet.js';
export {
  ALL_AGENT_DEFINITIONS,
  AGENT_CATALOG,
  AGENTS_BY_PHASE,
  getAgentDefinition,
  type AgentDefinition,
  type AgentCapability,
  type AgentBudgetTier,
  type AgentPhase,
} from '../coordination/agents/index.js';
export {
  dispatchAgent,
  scoreAgents,
  makeLLMClassifier,
  DEFAULT_DISPATCH_ROLE,
  type DispatchResult,
  type DispatchCandidate,
  type DispatchClassifier,
  type DispatchOptions,
  type DispatchMethod,
} from '../coordination/dispatcher.js';
export {
  attachAutoExtend,
  type AutoExtendPolicy,
  type AutoExtendCeiling,
} from '../coordination/auto-extend.js';
export type { ICoordinator } from '../coordination/icoordinator.js';
export type { IFleetManager } from '../coordination/ifleet-manager.js';
export { NULL_FLEET_BUS } from '../coordination/null-fleet-bus.js';

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
export {
  resolveProviderModelList,
  describeCatalogModel,
  type ProviderModelDescriptor,
} from '../models/provider-model-resolve.js';

// ---- SDD ----
export { SpecParser } from '../sdd/spec-parser.js';
export {
  TaskGenerator,
  DefaultTaskStore,
  extractVerificationCommand,
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
export { SpecStore, type SpecStoreOptions, type SpecIndexEntry } from '../sdd/spec-store.js';
export {
  TaskGraphStore,
  type TaskGraphStoreOptions,
  type TaskGraphIndexEntry,
} from '../sdd/task-graph-store.js';
export {
  AISpecBuilder,
  type AISpecBuilderOptions,
  type AISpecPhase,
  type AISpecSession,
  type CollectedAnswer,
} from '../sdd/spec-builder.js';
export {
  SPEC_TEMPLATES,
  getTemplate,
  listTemplates,
  templateToMarkdown,
} from '../sdd/spec-templates.js';
export {
  renderTaskGraph,
  renderProgress,
  renderTaskList,
  renderSpecAnalysis,
} from '../sdd/task-visualizer.js';
export {
  analyzeCriticalPath,
  type CriticalPathAnalysis,
  type BottleneckTask,
} from '../sdd/critical-path.js';
export { SpecVersioning, type SpecVersion, type SpecDiff } from '../sdd/spec-versioning.js';
export {
  AutoExecutor,
  createAutoExecutor,
  type AutoExecutorOptions,
  type TaskExecutionContext,
  type TaskExecutionResult,
  type ExecutionSummary,
} from '../sdd/auto-executor.js';
export {
  SddTaskDecomposer,
  type SddTaskDecomposerOptions,
  type TaskBatch,
} from '../sdd/sdd-task-decomposer.js';
export {
  SddParallelRun,
  type SddParallelRunOptions,
  type SddProgress,
  type WaveResult,
  type RunResult,
  type SddSubtaskSpec,
  type SddSupervisorVerdict,
} from '../sdd/sdd-parallel-run.js';
export { SddSupervisor, type SddSupervisorOptions } from '../sdd/sdd-supervisor.js';
export { makeCommandVerifier, type CommandVerifierOptions } from '../sdd/verify-task.js';
export { makeLlmSubtaskGenerator, type SubtaskGeneratorOptions } from '../sdd/decompose-task.js';
export {
  makePreferSideConflictResolver,
  resolveConflictText,
  hasConflictMarkers,
  type ConflictSide,
} from '../sdd/conflict-resolver.js';
// Live SDD board: model, persistence, projector, run registry.
export {
  buildBoardTasks,
  buildBoardSnapshot,
  shortIdMap,
  type SddBoardSnapshot,
  type SddBoardTask,
  type SddBoardColumn,
  type SddBoardStatus,
  type SddTaskDisplayStatus,
  type SddDeadlockChain,
  type SddBoardFeedEntry,
} from '../sdd/board-types.js';
export {
  SddBoardStore,
  type SddBoardStoreOptions,
  type SddBoardIndexEntry,
  type SddBoardEvent,
} from '../sdd/sdd-board-store.js';
export { SddBoardProjector, type SddBoardProjectorOptions } from '../sdd/sdd-board-projector.js';
export { SddRunRegistry, type SddRunControl } from '../sdd/sdd-run-registry.js';
export {
  SddInterviewDriver,
  isExplanatoryText,
  type SddInterviewDriverOptions,
  type SddInterviewSnapshot,
  type SddIngestResult,
} from '../sdd/sdd-interview-driver.js';
export {
  startSddRun,
  type StartSddRunOptions,
  type SddRunHandle,
} from '../sdd/start-sdd-run.js';

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
  zaiVisionServer,
  miniMaxVisionServer,
  playwrightServer,
  sshManagerServer,
  allServers,
} from '../infrastructure/mcp-servers.js';
