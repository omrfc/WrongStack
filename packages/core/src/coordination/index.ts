// Coordination domain: multi-agent orchestration, director, fleet bus, agents
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
} from './brain.js';
export {
  Director,
  FleetSpawnBudgetError,
  FleetCostCapError,
} from './director.js';
export {
  makeSpawnTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeAskTool,
  makeAskResultTool,
  makeRollUpTool,
  makeTerminateTool,
  makeFleetStatusTool,
  makeFleetUsageTool,
  makeFleetSessionTool,
  makeFleetHealthTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeWorkCompleteTool,
} from './director-tools.js';
export { LargeAnswerStore } from './large-answer-store.js';
export {
  createDelegateTool,
  type DelegateHost,
  type CreateDelegateToolOptions,
} from './delegate-tool.js';
export {
  DefaultMultiAgentCoordinator,
  type MultiAgentCoordinatorOptions,
} from './multi-agent-coordinator.js';
export {
  SubagentBudget,
  BudgetExceededError,
  BudgetThresholdSignal,
} from './subagent-budget.js';
export type {
  BudgetNegotiationMode,
  BudgetThresholdDecision,
  BudgetThresholdHandler,
  BudgetKind,
  BudgetLimits,
  BudgetUsage,
} from './subagent-budget.js';
export {
  makeAgentSubagentRunner,
  type AgentFactory,
  type AgentFactoryResult,
  type AgentRunnerOptions,
} from './agent-subagent-runner.js';
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
} from './agent-bridge.js';
export {
  AUDIT_LOG_AGENT,
  BUG_HUNTER_AGENT,
  REFACTOR_PLANNER_AGENT,
  SECURITY_SCANNER_AGENT,
  FLEET_ROSTER,
  ALL_FLEET_AGENTS,
  FLEET_ROSTER_BUDGETS,
  ACP_AGENTS,
  FLEET_ROSTER_WITHACP,
  applyRosterBudget,
  type FleetRosterBudget,
} from './fleet.js';
export {
  ALL_AGENT_DEFINITIONS,
  AGENT_CATALOG,
  AGENTS_BY_PHASE,
  getAgentDefinition,
  DISCOVERY_AGENTS,
  PLANNING_AGENTS,
  BUILD_AGENTS,
  VERIFY_AGENTS,
  REVIEW_AGENTS,
  DOMAIN_AGENTS,
  KNOWLEDGE_AGENTS,
  DELIVERY_AGENTS,
  META_AGENTS,
  TOOLS as AGENT_TOOL_PRESETS,
  LIGHT_BUDGET,
  MEDIUM_BUDGET,
  HEAVY_BUDGET,
  type AgentDefinition,
  type AgentCapability,
  type AgentBudgetTier,
  type AgentPhase,
} from './agents/index.js';
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
} from './dispatcher.js';
export {
  attachAutoExtend,
  type AutoExtendPolicy,
  type AutoExtendCeiling,
} from './auto-extend.js';
export type { ICoordinator } from './icoordinator.js';
export type { IFleetManager } from './ifleet-manager.js';
export { NULL_FLEET_BUS } from './null-fleet-bus.js';
export {
  FleetManager,
  type FleetManagerOptions,
} from './fleet-manager.js';
export {
  CollabSession,
  DirectorAlertLevel,
  type CollabDebugReport,
  type CollabSessionOptions,
  type CollabBudgetConfig,
  type CollabBudgetOverrides,
  type DirectorAlert,
  type DirectorCancelCollabPayload,
  type CollabBudgetWarningPayload,
  type SharedFileSnapshot,
  type SharedFileEntry,
  type BugFinding,
  type RefactorPlan,
  type RefactorPhase,
  type CriticEvaluation,
  type CriticConcern,
} from './collab-debug.js';
// ── Mailbox — inter-agent messaging ──────────────────────────────────────
export { DefaultMailbox } from './mailbox.js';
export { normalizeRecipient } from './mailbox-types.js';
export { GlobalMailbox, resolveProjectDir } from './global-mailbox.js';
export { makeMailboxTool, resolveMailboxIdentity, mailboxSessionTag, type MailboxToolOptions, type MailboxResolver } from './mailbox-tool.js';
export { makeMailSendTool, makeMailInboxTool, type MailToolsOptions } from './mail-tools.js';
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
} from './mailbox-types.js';
// ── Dependency watcher — file-change → mailbox bridge ────────────────────
export {
  DEPENDENCY_FILE_PATTERNS,
  makeDependencyWatcherConfig,
  type DependencyWatcherConfig,
  type DepWatchEntry,
} from './dep-watcher.js';
// ── Dependency watcher bridge — file-watcher events → mailbox ────────────
export {
  attachDepWatcherBridge,
  type DepWatcherBridgeOptions,
} from './dep-watcher-bridge.js';
// ── Mailbox hooks — tool-execution integration ────────────────────────────
export {
  createMailboxHooks,
  type MailboxHooksOptions,
} from './mailbox-hooks.js';
// ── Package author tracker — tracks which agent added which package ─────────
export {
  recordPackageAction,
  getPackageAuthor,
  getManifestPackages,
  getPackagesByAgent,
  updatePackageOutdatedStatus,
  getFullPackageLog,
  detectEcosystem,
  type PackageAuthorEntry,
  type PackageAuthorLog,
  type PackageAuthorTrackerOptions,
} from './package-author-tracker.js';
// ── Package outdated watcher — notifies original authors of outdated pkgs ──
export {
  startPackageOutdatedWatcher,
  type PackageOutdatedEntry,
  type PackageOutdatedResult,
  type PackageOutdatedWatcherOptions,
  type OutdatedNotifyMessage,
} from './package-outdated-watcher.js';
