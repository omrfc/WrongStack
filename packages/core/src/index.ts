export * from './kernel/index.js';
export * from './types/index.js';
export * from './utils/index.js';
export * from './defaults/index.js';
export * from './skills/index.js';
export * from './storage/index.js';
export { expectDefined } from './utils/expect-defined.js';

// Explicit re-exports for the new session audit bridge (helps some consumers
// and declaration bundlers pick them up reliably).
export {
  createSessionEventBridge,
  resolveAuditLevel,
  resolveSessionLoggingConfig,
  type SessionEventBridge,
  type AuditLevel,
  type SessionEventBridgeOptions,
  type SessionSamplingOptions,
  type ToolProgressSamplingOptions,
} from './storage/session-event-bridge.js';
export * from './security-scanner/index.js';
export {
  FleetManager,
  type FleetManagerOptions,
} from './coordination/fleet-manager.js';
export { createMcpControlTool, type MCPRegistryHandle } from './tools/mcp-control.js';
export { createMcpUseTool } from './tools/mcp-use.js';
// Re-export safeParse explicitly at the top-level export for consumers
// who import from '@wrongstack/core' directly (e.g. providers package).
export { safeParse, safeStringify, sanitizeJsonString } from './utils/safe-json.js';
// Likewise pin the terminal helpers: tsup's DTS deduplication can drop the
// whole term.js module from the bundled declarations (it's only reachable via
// the `export *` util chain), which breaks `import { onResize } from
// '@wrongstack/core'` in the CLI. An explicit re-export forces them in.
export {
  isStdoutTTY,
  isStdinTTY,
  isInteractive,
  getTermSize,
  onResize,
  setRawMode,
  writeOut,
  writeErr,
  setOutputLineGuard,
  type OutputLineGuard,
} from './utils/term.js';
export {
  Agent,
  type RunResult,
  type AgentInit,
  type AgentInput,
  type AgentPipelines,
  type UserInputPayload,
  type ToolCallPipelinePayload,
  createDefaultPipelines,
  DEFAULT_MAX_ITERATIONS,
} from './core/agent.js';
export { runProviderWithRetry } from './core/provider-runner.js';
export {
  HookRegistry,
  HookRunner,
  hookMatcherMatches,
  runShellHook,
  type HookRunEnv,
  type HookRunnerOptions,
  type PreToolUseResult,
  type PromptResult,
  type ShellHookSpec,
} from './hooks/index.js';
export {
  eliseOldToolResults,
  estimateMessages,
  buildLosslessDigest,
  buildSmartDigest,
  hasTextContent,
  findPreserveStart,
  scoreMessage,
  extractText,
  type EliseResult,
  type ContentScore,
} from './execution/compaction-core.js';
export {
  bootConfig,
  flagsToConfigPatch,
  type BootConfigOptions,
  type BootConfigResult,
} from './boot.js';
export {
  parseContinueDirective,
  type ContinueDirective,
  makeContinueToNextIterationTool,
} from './core/continue-to-next-iteration.js';
export {
  setBtwNote,
  consumeBtwNotes,
  pendingBtwCount,
  buildBtwBlock,
} from './core/btw.js';
export {
  setQueuedMessagesSnapshot,
  consumeQueuedMessagesUpdate,
  peekQueuedMessages,
  buildQueuedMessagesBlock,
} from './core/queued-messages.js';
export { Context, type ContextInit, type RunOptions, type TodoItem } from './core/context.js';
export { extractRunEnv, type RunEnv } from './core/run-env.js';
export {
  ConversationState,
  wrapAsState,
  type ReadonlyConversationState,
  type StateChange,
  type StateChangeHandler,
} from './core/conversation-state.js';
export {
  InputBuilder,
  type InputBuilderOptions,
  type InputBuilderEvent,
} from './core/input-builder.js';
export {
  DefaultSystemPromptBuilder,
  LAYER_1_IDENTITY,
  type DefaultSystemPromptBuilderOptions,
} from './core/system-prompt-builder.js';
export { ToolRegistry } from './registry/tool-registry.js';
export type { ToolWrapper } from './registry/tool-registry.js';
export { ProviderRegistry, type ProviderFactory } from './registry/provider-registry.js';
export {
  SlashCommandRegistry,
  type SlashCommand,
} from './registry/slash-command-registry.js';
export { DefaultPluginAPI, type PluginAPIInit } from './plugin/api.js';
export {
  loadPlugins,
  unloadPlugins,
  KERNEL_API_VERSION,
  type LoadPluginsOptions,
} from './plugin/loader.js';

// Extension API
export {
  ExtensionRegistry,
  type AgentExtension,
  type BeforeRunHook,
  type AfterRunHook,
  type BeforeIterationHook,
  type AfterIterationHook,
  type OnErrorHook,
  type ProviderRunnerWrapper,
  type BeforeToolExecutionHook,
  type AfterToolExecutionHook,
} from './extension/index.js';

// Explicit type re-exports needed because tsup DTS deduplication drops types
// that are reachable through both types/ and defaults/ export chains.
// Consumers (e.g. @wrongstack/providers) import these directly from '@wrongstack/core'.
export type {
  ModelsRegistry,
  ResolvedProvider,
  ResolvedModel,
  WireFamily,
  ModelsDevPayload,
  ModelsDevProvider,
} from './types/models-registry.js';
export type { Logger, LogLevel } from './types/logger.js';
export type { CacheStats, TokenCounter } from './types/token-counter.js';
export type { ProviderRunner, RunProviderOptions } from './types/provider-runner.js';
export type { SecretVault } from './types/secret-vault.js';
export { noOpVault } from './types/secret-vault.js';
export type { Compactor, CompactReport } from './types/compactor.js';
export { DefaultSecretScrubber } from './security/secret-scrubber.js';
export type { SecretScrubber } from './types/secret-scrubber.js';
export {
  HybridCompactor,
  IntelligentCompactor,
  SelectiveCompactor,
  AutoCompactionMiddleware,
  createStrategyCompactor,
  type CompactorOptions,
  type IntelligentCompactorOptions,
  type SelectiveCompactorOptions,
  type CompactorStrategy,
  type StrategyCompactorOptions,
} from './defaults/index.js';
export {
  ENHANCER_SYSTEM_PROMPT,
  shouldEnhance,
  normalizedEqual,
  enhanceUserPrompt,
  recentTextTurns,
  type ConversationTurn,
  type EnhanceResult,
  type EnhanceUserPromptOptions,
} from './execution/prompt-enhancer.js';
export {
  CONTEXT_WINDOW_MODES,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  formatContextWindowModeList,
  getContextWindowMode,
  isContextWindowModeId,
  listContextWindowModes,
  resolveContextWindowPolicy,
  type ContextWindowAggressiveOn,
  type ContextWindowConfigLike,
  type ContextWindowMode,
  type ContextWindowModeId,
  type ContextWindowPolicy,
  type ContextWindowThresholds,
} from './types/context-window.js';
export { DEFAULT_SESSION_PRUNE_DAYS } from './types/default-config.js';

// AutoPhase - autonomous phase-based workflow
export {
  AutoPhaseRunner,
  createAutoPhaseFromTaskGraph,
  AutoPhasePlanner,
  PhaseOrchestrator,
  PhaseGraphBuilder,
  PhaseStore,
  CheckpointManager,
  type AutoPhasePlannerOptions,
  type AutoPhasePlanResult,
  type AutoPhaseRunnerOptions,
  type PhaseOrchestratorOptions,
  type PhaseGraphBuilderOptions,
  type PhaseStoreOptions,
  type CheckpointManagerOptions,
  type Checkpoint,
  type PhaseTemplate,
  type PhaseGraph,
  type PhaseNode,
  type PhaseStatus,
  type PhaseProgress,
  type PhaseEventMap,
  type PhaseEventName,
  type PhaseExecutionContext,
  type AutoPhaseOptions,
  type PhaseFilter,
  type PhaseSort,
} from './autophase/index.js';

export {
  WorktreeManager,
  assertSafePath,
  type WorktreeHandle,
  type WorktreeStatus,
  type WorktreeManagerOptions,
  type AllocateOpts,
  type MergeOpts,
  type MergeResult,
  type WorktreeRunResult,
} from './worktree/index.js';

// ---- Coordination (fleet/multi-agent tools) ----
export {
  BrainDecisionQueue,
  DefaultBrainArbiter,
  HumanEscalatingBrainArbiter,
  ObservableBrainArbiter,
  formatHumanPrompt,
  type BrainArbiter,
  type BrainDecision,
  type BrainDecisionOption,
  type BrainDecisionRequest,
  type BrainDecisionSource,
  type BrainFallback,
  type BrainRisk,
  type DefaultBrainArbiterOptions,
} from './coordination/brain.js';
export {
  BrainMonitor,
  type BrainMonitorOptions,
  type BrainInterventionInput,
} from './coordination/brain-monitor.js';
export {
  createAutonomyBrain,
  createTieredBrainArbiter,
  formatDecisionSummary,
  type AutonomyBrainOptions,
  type TieredBrainArbiterOptions,
  type BrainAutoRisk,
} from './execution/autonomy-brain.js';
// Re-exported from ./coordination/index.js so they are available at the
// top-level @wrongstack/core import path.  Without this, consumers that
// `import { makeFleetEmitTool } from '@wrongstack/core'` get a runtime
// error even though the symbol exists in the ./coordination submodule.
export {
  Director,
  FleetSpawnBudgetError,
  FleetCostCapError,
} from './coordination/director.js';
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
} from './coordination/director-tools.js';
export {
  makeDirectorSessionFactory,
  type DirectorSessionFactory,
  type DirectorSessionFactoryOptions,
} from './coordination/director-session.js';
export {
  FleetBus,
  FleetUsageAggregator,
  type FleetEvent,
  type FleetHandler,
  type FleetUsage,
  type SubagentUsageSnapshot,
} from './coordination/fleet-bus.js';
export { NULL_FLEET_BUS } from './coordination/null-fleet-bus.js';
export {
  FLEET_ROSTER,
  ALL_FLEET_AGENTS,
  FLEET_ROSTER_BUDGETS,
  ACP_AGENTS,
  FLEET_ROSTER_WITHACP,
  applyRosterBudget,
  type FleetRosterBudget,
} from './coordination/fleet.js';
export {
  AGENTS_BY_PHASE,
  ALL_AGENT_DEFINITIONS,
  AGENT_CATALOG,
  getAgentDefinition,
  type AgentDefinition,
  type AgentPhase,
} from './coordination/agents/index.js';
export {
  resolveModelMatrix,
  phaseForRole,
  matrixKeyKind,
  isValidMatrixKey,
  MATRIX_PHASE_KEYS,
  type MatrixKeyKind,
} from './coordination/model-matrix.js';
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
} from './coordination/dispatcher.js';
export {
  makeAgentSubagentRunner,
  type AgentFactory,
  type AgentFactoryResult,
  type AgentRunnerOptions,
} from './coordination/agent-subagent-runner.js';
export {
  CollaborationBus,
  type CollabBusState,
} from './coordination/collab-bus.js';
// ── Mailbox — inter-agent messaging ──────────────────────────────────────
export { DefaultMailbox } from './coordination/mailbox.js';
export { normalizeRecipient } from './coordination/mailbox-types.js';
export { GlobalMailbox, resolveProjectDir } from './coordination/global-mailbox.js';
export { makeMailboxTool, resolveMailboxIdentity, mailboxSessionTag, type MailboxToolOptions, type MailboxResolver } from './coordination/mailbox-tool.js';
export { makeMailSendTool, makeMailInboxTool, type MailToolsOptions } from './coordination/mail-tools.js';
export type {
  Mailbox,
  MailboxMessage,
  MailboxMessageType,
  MailboxQuery,
  MailboxSendInput,
  MailboxAckInput,
  MailboxAgentStatus,
  MailboxTaskContext,
  ReadReceipts,
  RegisteredAgent,
  AgentRegistrationInput,
  AgentHeartbeatInput,
} from './coordination/mailbox-types.js';
export {
  createMailboxChecker,
  buildMailboxBlock,
  injectPendingMailboxMessages,
  type MailboxLoopOptions,
} from './core/mailbox-loop.js';
export { attachMailboxChecker } from './mailbox-attach.js';
// ── Dependency watcher — file-change → mailbox bridge ────────────────────
export {
  DEPENDENCY_FILE_PATTERNS,
  makeDependencyWatcherConfig,
  type DependencyWatcherConfig,
  type DepWatchEntry,
} from './coordination/dep-watcher.js';
export {
  attachDepWatcherBridge,
  type DepWatcherBridgeOptions,
} from './coordination/dep-watcher-bridge.js';
export {
  recordFileAction,
  getLastAuthor,
  getFileHistory,
  getFilesByAgent,
  getFullLog,
  compactLog,
  type FileAuthorEntry,
  type FileAuthorLog,
  type FileAuthorTrackerOptions,
} from './coordination/file-author-tracker.js';
export {
  recordPackageAction,
  getPackageAuthor,
  getManifestPackages,
  getPackagesByAgent,
  updatePackageOutdatedStatus,
  getFullPackageLog,
  detectEcosystem as detectPackageEcosystem,
  type PackageAuthorEntry,
  type PackageAuthorLog,
  type PackageAuthorTrackerOptions,
} from './coordination/package-author-tracker.js';
export {
  startPackageOutdatedWatcher,
  type PackageOutdatedEntry,
  type PackageOutdatedResult,
  type PackageOutdatedWatcherOptions,
  type OutdatedNotifyMessage,
} from './coordination/package-outdated-watcher.js';
export {
  startTechStackConsumer,
  type TechStackConsumerOptions,
} from './coordination/techstack-mailbox-consumer.js';
export {
  collabPauseMiddleware,
  type CollabPauseMiddlewareOptions,
} from './middleware/collab-pause.js';
export {
  collabInjectMiddleware,
  type InjectedToolResult as CollabInjectedToolResult,
} from './middleware/collab-pause.js';
export {
  hashRequest,
  stableStringify,
} from './replay/hash.js';
export {
  ReplayProviderRunner,
  type ReplayMode,
  type ReplayProviderRunnerOptions,
} from './replay/replay-provider-runner.js';

// Built-in plugins
export { createPromptsPlugin } from './plugins/prompts-plugin.js';
export { createSyncPlugin } from './plugins/sync-plugin.js';
export { createGitPlugin } from './plugins/git-plugin.js';
export { createObservabilityPlugin } from './plugins/observability-plugin.js';
export { createSecurityPlugin } from './plugins/security-plugin.js';
export { createSkillsPlugin } from './plugins/skills-plugin.js';
export { createPlanPlugin } from './plugins/plan-plugin.js';
export { createChimeraPlugin } from './plugins/chimera-plugin.js';
export type { ResolvedChimeraConfig, ChimeraReviewNeededPayload } from './plugins/chimera-plugin.js';
export { CHIMERA_REVIEW_PROMPT, resolveChimeraConfig } from './plugins/chimera-plugin.js';
