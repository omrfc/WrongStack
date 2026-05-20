// Coordination domain: multi-agent orchestration, director, fleet bus, agents
export {
  Director,
  FleetSpawnBudgetError,
  FleetCostCapError,
} from './director.js';
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
  type BudgetKind,
  type BudgetLimits,
  type BudgetUsage,
  type BudgetThresholdDecision,
  type BudgetThresholdHandler,
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
} from './fleet.js';
export type {
  ICoordinator,
} from './icoordinator.js';
export type {
  IFleetManager,
} from './ifleet-manager.js';
export {
  NULL_FLEET_BUS,
} from './null-fleet-bus.js';
