// ── Barrel re-exports — all stores and types ──

export type {
  MessageContent,
  ToolExecution,
  ChatMessage,
  SessionInfo,
  SessionHistoryEntry,
  AgentTranscriptEntry,
  AgentTranscriptKind,
  SubagentView,
  SubagentEvent,
  FleetTimelineEvent,
} from './types.js';

export { useChatStore } from './chat-store.js';
export { useConfigStore } from './config-store.js';
export type { ConfigState } from './config-store.js';
export { useSessionStore } from './session-store.js';
export { useUIStore, coerceActivity, resetUiNavigationToHome, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH } from './ui-store.js';
export type { Activity, DockSection, WorkDashboardTab } from './ui-store.js';
export { useMailboxStore, selectUnreadCount } from './mailbox-store.js';
export { useGitInfoStore } from './git-info-store.js';
export type { GitInfo } from './git-info-store.js';
export { useSideEffectStore, type SideEffectEntry } from './side-effect-store.js';
export { useGitChangesStore } from './git-changes-store.js';
export type { GitChangedFile, GitDiffContent } from './git-changes-store.js';
export type { MailboxMessage, MailboxAgent } from './mailbox-store.js';
export { useHistoryStore } from './history-store.js';
export { useWorktreeStore } from './worktree-store.js';
export { EMPTY_AGENT_TRANSCRIPT, useFleetStore } from './fleet-store.js';
export { useGoalStore } from './goal-store.js';
export { useAutoPhaseStore } from './autophase-store.js';
export {
  useSpecsStore,
  type SpecListItem,
  type SpecDetail,
  type SpecColumn,
  type BoardTaskItem,
  type BoardTaskStatus,
} from './specs-store.js';
export {
  useSddBoardStore,
  type SddBoardSnapshotUI,
  type SddBoardSummary,
  type SddBoardStatus,
  type SddBoardFeedEntry,
  type SddLifecycleResultUI,
} from './sdd-board-store.js';
export {
  useSddWizardStore,
  type SddWizardSnapshot,
  type SddWizardPhase,
} from './sdd-wizard-store.js';
export { useLocalPrefs } from './local-prefs.js';
export { useFileStore } from './file-store.js';
export type { TreeNode, OpenFile } from './file-store.js';
export {
  useFileReferenceStore,
  refsToMarkdown,
  refLabel,
} from './file-reference-store.js';
export type { FileReference, FileReferenceInput } from './file-reference-store.js';
export { useVizStore } from './viz-store.js';
export type { VizEvent, VizEdge, VizNode } from './viz-store.js';
export { useMonitorStore } from './monitor-store.js';
export type { ClientCounts, MailActivity, CurrentSessionStats } from './monitor-store.js';
export { useCoordinatorMonitorStore } from './coordinator-monitor-store.js';
export type {
  CoordinatorStatus,
  BudgetKind,
  ConsensusResult,
  VoteValue,
  SubagentEntry,
  FleetEvent,
  ConsensusVote,
  TaskEntry,
  BudgetAlert,
} from './coordinator-monitor-store.js';
export { useOfficeMapStore, type BackgroundStyle } from './office-map-store.js';
