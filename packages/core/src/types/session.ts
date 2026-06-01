import type { ContentBlock } from './blocks.js';
import type { Message } from './messages.js';
import type { Usage } from './provider.js';

export interface SessionMetadata {
  id: string;
  title?: string;
  model?: string;
  provider?: string;
  startedAt: string;
  endedAt?: string;
  /** Set when a session is closed with open tool calls — used to restore pending state on resume. */
  pendingToolUses?: string[];
}

export type SessionEvent =
  | { type: 'session_start'; ts: string; id: string; model: string; provider: string }
  | { type: 'session_resumed'; ts: string; id: string; model: string; provider: string }
  | { type: 'user_input'; ts: string; content: string | ContentBlock[] }
  | { type: 'llm_request'; ts: string; model: string; messageCount: number }
  | {
      type: 'llm_response';
      ts: string;
      content: ContentBlock[];
      stopReason: string;
      usage: Usage;
    }
  | { type: 'tool_use'; ts: string; name: string; id: string; input: unknown }
  | { type: 'tool_result'; ts: string; id: string; content: unknown; isError: boolean }
  | { type: 'compaction'; ts: string; before: number; after: number }
  | { type: 'error'; ts: string; message: string; phase: string }
  | { type: 'session_end'; ts: string; usage: Usage; pendingToolUses?: string[] }
  | { type: 'mode_changed'; ts: string; from: string; to: string }
  | { type: 'task_created'; ts: string; taskId: string; title: string }
  | { type: 'task_updated'; ts: string; taskId: string; status: string }
  | { type: 'task_completed'; ts: string; taskId: string; title: string }
  | { type: 'task_failed'; ts: string; taskId: string; title: string; error: string }
  | { type: 'agent_spawned'; ts: string; agentId: string; role: string }
  | { type: 'agent_stopped'; ts: string; agentId: string }
  | { type: 'agent_error'; ts: string; agentId: string; error: string }
  | { type: 'spec_parsed'; ts: string; specId: string; title: string; completeness: number }
  | { type: 'spec_analyzed'; ts: string; specId: string; gaps: string[] }
  | { type: 'skill_activated'; ts: string; skillName: string }
  | { type: 'skill_deactivated'; ts: string; skillName: string }
  | { type: 'tool_call_start'; ts: string; name: string; id: string; input: unknown }
  | {
      type: 'tool_call_end';
      ts: string;
      name: string;
      id: string;
      durationMs: number;
      outputSize: number;
    }
  | { type: 'message_truncated'; ts: string; before: number; after: number }
  | { type: 'checkpoint'; ts: string; promptIndex: number; promptPreview: string }
  | { type: 'file_snapshot'; ts: string; promptIndex: number; files: FileSnapshot[] }
  | { type: 'rewound'; ts: string; toPromptIndex: number; revertedFiles: string[] }
  | {
      /**
       * Idea #1 from IDEAS.md — Stateful Session Recovery.
       *
       * Marks the start of "the process is currently working on this
       * point in the log". If the process exits cleanly, a matching
       * `in_flight_end` follows. If the process dies (crash, OOM,
       * machine sleep, SIGKILL) the marker is the last event in the
       * file — and `SessionRecovery.detectStale` flags the session
       * as resumable.
       *
       * `context` is a free-form description of the current
       * operation (e.g. "iteration 14 / tool: read / id: tu-7") so
       * the recovery UI can show "what was the agent doing when it
       * died?".
       */
      type: 'in_flight_start';
      ts: string;
      context: string;
    }
  | { type: 'in_flight_end'; ts: string; reason: 'clean' | 'aborted' | 'recovered' };

export type FileSnapshot = {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  before: string | null;
  after: string | null;
};

export interface SessionSummary {
  id: string;
  title: string;
  startedAt: string;
  model: string;
  provider: string;
  tokenTotal: number;
}

export interface SessionData {
  metadata: SessionMetadata;
  events: SessionEvent[];
  messages: Message[];
  usage: Usage;
}

export interface ResumedSession {
  writer: SessionWriter;
  data: SessionData;
}

export interface SessionStore {
  create(meta: Omit<SessionMetadata, 'startedAt'>): Promise<SessionWriter>;
  load(id: string): Promise<SessionData>;
  /**
   * Open an existing session for append, returning both a writer that
   * continues writing to the same JSONL file and the replayed state
   * (messages + usage) so the caller can hydrate a Context. A
   * `session_resumed` marker is appended for audit.
   */
  resume(id: string): Promise<ResumedSession>;
  list(limit?: number): Promise<SessionSummary[]>;
  delete(id: string): Promise<void>;
  /**
   * Rewrite the session JSONL file to contain only a fresh session_start
   * event, effectively clearing all conversation history for that session.
   * Called by /clear to wipe persistent chat history.
   */
  clearHistory(id: string): Promise<void>;
}

export interface SessionWriter {
  readonly id: string;
  /**
   * Absolute path to the JSONL file this writer appends to, when one
   * exists. In-memory writers (tests, ephemeral sessions) leave it
   * undefined. Observability surfaces (`/fleet log`, FleetPanel) use
   * this to tell the user *where* the transcript lives without
   * having to recompute the path from session metadata.
   */
  readonly transcriptPath?: string;
  /** IDs of tool_use blocks that have been sent but not yet received a tool_result.
   * Used by the REPL to serialize pending state into `session_end` for proper resume. */
  readonly pendingToolUses: string[];
  append(event: SessionEvent): Promise<void>;
  close(): Promise<void>;
  /**
   * Register a file change for later snapshotting.
   * Called by write/edit/delete tools to track pending changes.
   */
  recordFileChange(input: { path: string; action: 'created' | 'modified' | 'deleted'; before: string | null; after: string | null }): void;
  /**
   * Write a checkpoint marker after a user input is processed.
   * Also flushes any pending file snapshots.
   */
  writeCheckpoint(promptIndex: number, promptPreview: string): Promise<void>;
  /**
   * Write a file snapshot after file changes are detected.
   * Called by the file watcher or tool interceptor.
   */
  writeFileSnapshot(promptIndex: number, files: import('./session.js').FileSnapshot[]): Promise<void>;
  /**
   * Truncate conversation history to a given checkpoint promptIndex.
   * Called after rewind — removes user_input/llm_response/tool_result events
   * that come after the target checkpoint, then writes a rewound event.
   * Returns the number of events removed.
   */
  truncateToCheckpoint(promptIndex: number): Promise<number>;
  /**
   * Clear the session transcript file, resetting the on-disk history.
   * Called by /clear to wipe chat history from persistent storage.
   */
  clearSession(): Promise<void>;
  /**
   * Idea #1 from IDEAS.md — Stateful Session Recovery.
   *
   * Writes an `in_flight_start` event at the current point in the
   * log. The agent loop should call this at the start of every
   * long-running operation (an iteration, a tool execution, a
   * streaming LLM call) so that a crashed process leaves a
   * visible "what was I doing?" marker. Pair with
   * `clearInFlightMarker` on clean shutdown.
   *
   * The `context` string is surfaced verbatim by
   * `SessionRecovery.detectStale` and the `/resume --incomplete`
   * CLI command, so prefer something a human can read at a glance:
   *   "iteration 14 / tool: read / id: tu-7"
   */
  writeInFlightMarker(context: string): Promise<void>;
  /**
   * Writes an `in_flight_end` event. Call on every clean exit
   * point (after a successful iteration, after the user issues
   * /exit, after a graceful SIGINT, etc.). The `reason` is
   * surfaced in the session log for postmortem review.
   */
  clearInFlightMarker(reason: 'clean' | 'aborted' | 'recovered'): Promise<void>;
}