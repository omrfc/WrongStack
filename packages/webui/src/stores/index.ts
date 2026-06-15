// ── Barrel re-exports — all stores and types ──

export type {
  MessageContent,
  ToolExecution,
  ChatMessage,
  SessionInfo,
  SessionHistoryEntry,
  SubagentView,
  SubagentEvent,
  FleetTimelineEvent,
} from './types.js';

export { useChatStore } from './chat-store.js';
export { useConfigStore } from './config-store.js';
export type { ConfigState } from './config-store.js';
export { useSessionStore } from './session-store.js';
export { useUIStore, coerceActivity, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH } from './ui-store.js';
export type { Activity } from './ui-store.js';
export { useMailboxStore, selectUnreadCount } from './mailbox-store.js';
export { useGitInfoStore } from './git-info-store.js';
export type { GitInfo } from './git-info-store.js';
export type { MailboxMessage, MailboxAgent } from './mailbox-store.js';
export { useHistoryStore } from './history-store.js';
export { useWorktreeStore } from './worktree-store.js';
export { useFleetStore } from './fleet-store.js';
export { useGoalStore } from './goal-store.js';
export { useAutoPhaseStore } from './autophase-store.js';
export { useLocalPrefs } from './local-prefs.js';
export { useFileStore } from './file-store.js';
export type { TreeNode, OpenFile } from './file-store.js';
export { useVizStore } from './viz-store.js';
export type { VizEvent, VizEdge, VizNode } from './viz-store.js';
