import type { SessionEvent } from '@wrongstack/core';
import type { HistoryEntry } from './types.js';

/**
 * Render a SessionEvent back into a TUI HistoryEntry so a resumed session
 * displays exactly what the user saw during live interaction.
 *
 * ## Entry mapping
 *
 * | Event type                | HistoryEntry kind |
 * |--------------------------|-------------------|
 * | `user_input`             | `user`            |
 * | `llm_response`           | `assistant`       |
 * | `tool_use` + `tool_result` | `tool` (paired) |
 * | `tool_call_start`/`tool_call_end` | `tool`      |
 * | `compaction`             | `info`            |
 * | `error`                  | `error`           |
 * | `provider_retry`         | `warn`            |
 * | `provider_error`         | `error`           |
 * | `checkpoint`             | `info`            |
 * | `agent_spawned`/`agent_stopped` | `subagent`  |
 * | `agent_error`            | `subagent`        |
 * | `mode_changed`           | `info`            |
 * | `skill_activated`/`skill_deactivated` | `info` |
 * | `message_truncated`      | `warn`            |
 *
 * ## Non-resumable events (subagent transcripts)
 *
 * Subagent events (`agent_spawned`, `agent_stopped`, `agent_error`) are
 * rendered as `subagent` entries in the main TUI history but the full
 * subagent tool-call details live in per-subagent JSONL files. The main
 * session only holds the lifecycle markers.
 *
 * ## Compaction events
 *
 * Compaction boundaries are rendered as `info` entries showing how many
 * tokens were collapsed. This keeps the display neat without pretending
 * the full verbose context never existed.
 *
 * @param events  Parsed SessionEvent[] from session JSONL
 * @param startId Starting id counter for the generated entries
 * @returns       Ordered HistoryEntry[] ready for display
 */
export function replaySessionEvents(
  events: SessionEvent[],
  startId: number,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  let nextId = startId;
  // Pending tool_use events awaiting their tool_result
  const pendingTools = new Map<string, { name: string; input: unknown; ts: string }>();

  for (const ev of events) {
    const entry = eventToEntry(ev, pendingTools);
    if (entry) {
      entries.push({ ...entry, id: nextId++ } as HistoryEntry);
    }
  }

  // Flush any orphaned tool_use events (tool_use without tool_result — e.g. from
  // a crash mid-execution)
  for (const [, tu] of pendingTools) {
    entries.push({
      id: nextId++,
      kind: 'tool',
      name: tu.name,
      durationMs: 0,
      ok: false,
      input: tu.input,
    });
  }

  return entries;
}

/**
 * Convert a single SessionEvent to a HistoryEntry (or null if the event
 * should be skipped in the display). `pendingTools` is mutated to pair
 * tool_use events with their subsequent tool_result.
 */
function eventToEntry(
  ev: SessionEvent,
  pendingTools: Map<string, { name: string; input: unknown; ts: string }>,
): Omit<HistoryEntry, 'id'> | null {
  switch (ev.type) {
    case 'user_input': {
      const text =
        typeof ev.content === 'string'
          ? ev.content
          : Array.isArray(ev.content)
            ? ev.content
                .filter((b) => (b as { type: string }).type === 'text')
                .map((b) => (b as { text: string }).text)
                .join('')
            : '';
      if (!text.trim()) return null;
      return { kind: 'user', text };
    }

    case 'llm_response': {
      const text = ev.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('');
      if (!text.trim()) return null;
      return { kind: 'assistant', text };
    }

    case 'tool_use': {
      // Defer — wait for the matching `tool_result` to construct a single
      // tool entry. Store the tool_use data keyed by its id.
      pendingTools.set(ev.id, { name: ev.name, input: ev.input, ts: ev.ts });
      return null;
    }

    case 'tool_result': {
      // Pair with the previously stored tool_use.
      const tu = pendingTools.get(ev.id);
      pendingTools.delete(ev.id);
      return {
        kind: 'tool',
        name: tu?.name ?? ev.id,
        durationMs: 0, // duration not available from tool_result alone
        ok: !ev.isError,
        input: tu?.input,
        output:
          typeof ev.content === 'string'
            ? ev.content.slice(0, 400)
            : undefined,
      };
    }

    case 'tool_call_start': {
      // Defer — wait for tool_call_end
      pendingTools.set(ev.id, { name: ev.name, input: ev.input, ts: ev.ts });
      return null;
    }

    case 'tool_call_end': {
      const tu = pendingTools.get(ev.id);
      pendingTools.delete(ev.id);
      // If we have a matching start, use its metadata; otherwise emit standalone.
      return {
        kind: 'tool',
        name: tu?.name ?? ev.name,
        durationMs: ev.durationMs,
        ok: ev.ok ?? false,
        input: tu?.input,
        outputBytes: ev.outputBytes,
        outputTokens: ev.outputTokens,
        outputLines: ev.outputLines,
      };
    }

    case 'compaction': {
      const before = (ev.before / 1000).toFixed(0);
      const after = (ev.after / 1000).toFixed(0);
      const level = ev.level ? ` (${ev.level})` : '';
      const reductions =
        ev.reductions && ev.reductions.length > 0
          ? ` [${ev.reductions.map((r) => `${r.phase}: −${r.saved}`).join(', ')}]`
          : '';
      return {
        kind: 'info',
        text: `⟲ context compacted${level}: ${before}K → ${after}K tokens${reductions}`,
      };
    }

    case 'error': {
      return {
        kind: 'error',
        text: ev.phase ? `[${ev.phase}] ${ev.message}` : ev.message,
      };
    }

    case 'provider_retry': {
      const secs = (ev.delayMs / 1000).toFixed(ev.delayMs >= 1000 ? 1 : 2);
      return {
        kind: 'warn',
        text: ev.status
          ? `⟳ retry ${ev.attempt} (HTTP ${ev.status}) after ${secs}s — ${ev.description}`
          : `⟳ retry ${ev.attempt} after ${secs}s — ${ev.description}`,
      };
    }

    case 'provider_error': {
      return {
        kind: 'error',
        text: ev.status
          ? `provider error (HTTP ${ev.status}, ${ev.retryable ? 'retryable' : 'fatal'}): ${ev.description}`
          : `provider error (${ev.retryable ? 'retryable' : 'fatal'}): ${ev.description}`,
      };
    }

    case 'checkpoint': {
      return {
        kind: 'info',
        text: `✓ checkpoint #${ev.promptIndex}: "${ev.promptPreview.slice(0, 60)}"`,
      };
    }

    case 'agent_spawned': {
      return {
        kind: 'subagent',
        agentLabel: ev.agentId.slice(0, 8),
        agentColor: 'magenta',
        icon: '⚡',
        text: `spawned as ${ev.role}`,
      };
    }

    case 'agent_stopped': {
      return {
        kind: 'subagent',
        agentLabel: ev.agentId.slice(0, 8),
        agentColor: 'gray',
        icon: '⊘',
        text: 'stopped',
      };
    }

    case 'agent_error': {
      return {
        kind: 'subagent',
        agentLabel: ev.agentId.slice(0, 8),
        agentColor: 'red',
        icon: '✗',
        text: `error: ${ev.error.slice(0, 80)}`,
      };
    }

    case 'mode_changed': {
      return {
        kind: 'info',
        text: `mode: ${ev.from} → ${ev.to}`,
      };
    }

    case 'skill_activated': {
      return {
        kind: 'info',
        text: `skill activated: ${ev.skillName}`,
      };
    }

    case 'skill_deactivated': {
      return {
        kind: 'info',
        text: `skill deactivated: ${ev.skillName}`,
      };
    }

    case 'message_truncated': {
      return {
        kind: 'warn',
        text: ev.after < ev.before
          ? `message truncated: ${ev.before} → ${ev.after} tokens`
          : `message truncated at ${ev.after} tokens`,
      };
    }

    // Skipped — internal markers not relevant for display
    case 'session_start':
    case 'session_resumed':
    case 'session_end':
    case 'in_flight_start':
    case 'in_flight_end':
    case 'llm_request':
    case 'tool_progress':
    case 'rewound':
    case 'file_snapshot':
    case 'task_created':
    case 'task_updated':
    case 'task_completed':
    case 'task_failed':
    case 'spec_parsed':
    case 'spec_analyzed':
      return null;

    default:
      // Exhaustive check: ignore unknown event types silently
      return null;
  }
}
