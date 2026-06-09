// ── Barrel re-exports — all stores and types ──

export type {
  MessageContent,
  ToolExecution,
  ChatMessage,
  SessionInfo,
  SessionHistoryEntry,
  SubagentView,
  SubagentEvent,
} from './types.js';

export { useChatStore } from './chat-store.js';
export { useConfigStore } from './config-store.js';
export type { ConfigState } from './config-store.js';
export { useSessionStore } from './session-store.js';
export { useUIStore } from './ui-store.js';
export type { Activity } from './ui-store.js';
export { useHistoryStore } from './history-store.js';
export { useWorktreeStore } from './worktree-store.js';
export { useFleetStore } from './fleet-store.js';
export { useGoalStore } from './goal-store.js';
export { useAutoPhaseStore } from './autophase-store.js';
export { useLocalPrefs } from './local-prefs.js';
export { useFileStore } from './file-store.js';
export type { TreeNode, OpenFile } from './file-store.js';
