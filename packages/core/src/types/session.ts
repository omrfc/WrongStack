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
  | { type: 'session_end'; ts: string; usage: Usage }
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
  | { type: 'message_truncated'; ts: string; before: number; after: number };

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
}

export interface SessionWriter {
  readonly id: string;
  append(event: SessionEvent): Promise<void>;
  close(): Promise<void>;
}
