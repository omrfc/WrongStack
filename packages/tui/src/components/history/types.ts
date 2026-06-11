import type { Lang } from '../../highlight.js';

// ============================================
// Shared types for history components
// ============================================

export type HistoryEntry =
  | { id: number; kind: 'user'; text: string; queued?: boolean | undefined; pasteContent?: string | undefined }
  | { id: number; kind: 'assistant'; text: string }
  | {
      id: number;
      kind: 'tool';
      name: string;
      durationMs: number;
      ok: boolean;
      input?: unknown | undefined;
      output?: string | undefined;
      /** Full byte length of the result body the model actually received
       *  (post-cap, post-scrub). Carried separately because `output` is a
       *  ~400-char preview — `outputBytes` is what the model paid for. */
      outputBytes?: number | undefined;
      /** ~3.5 chars/token estimate over `outputBytes`. Cheap to render in
       *  the chip; the authoritative count lives in provider.response.usage. */
      outputTokens?: number | undefined;
      /** Real line count for tools that have a meaningful one — read counts
       *  numbered prefixes, shell/grep/logs count newlines. Undefined for
       *  tools without a line notion (json, fetch, …). */
      outputLines?: number | undefined;
    }
  | { id: number; kind: 'info'; text: string }
  | { id: number; kind: 'warn'; text: string }
  | { id: number; kind: 'error'; text: string }
  | { id: number; kind: 'turn-summary'; text: string }
  | {
      id: number;
      kind: 'brain';
      status: 'thinking' | 'answered' | 'ask_human' | 'denied' | 'intervention';
      source: string;
      risk: 'low' | 'medium' | 'high' | 'critical';
      question: string;
      decision?: string | undefined;
      rationale?: string | undefined;
    }
  | {
      id: number;
      kind: 'banner';
      version: string;
      provider: string;
      model: string;
      cwd: string;
      family?: string | undefined;
      keyTail?: string | undefined;
    }
  | { id: number; kind: 'confirm'; toolName: string; input: unknown; suggestedPattern: string }
  | {
      id: number;
      kind: 'subagent';
      agentLabel: string;
      agentColor: string;
      icon: string;
      text: string;
      detail?: string | undefined;
    };

export interface HistoryProps {
  entries: HistoryEntry[];
  /**
   * Generation counter for wholesale history replacements (session resume).
   * Keys the internal <Static> so a replacement remounts it — Ink's Static
   * tracks written items by index and would otherwise skip replayed entries
   * whenever the new array is shorter than what it already printed.
   */
  generation?: number | undefined;
  streamingText?: string | undefined;
  /**
   * Optional live tail of the currently streaming tool. Rendered below the
   * assistant tail so the user sees both at once: model thinking and tool
   * output. Cleared automatically when the tool's `tool.executed` event
   * fires and the final entry lands in `entries`.
   */
  toolStream?: { toolUseId: string; name: string; text: string; startedAt: number } | null;
}

export interface BodySegment {
  type: 'prose' | 'code';
  text: string;
  lang?: Lang | undefined;
}
