import {
  color,
  SessionRecovery,
} from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildSaveCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'save',
    description: 'Save current session (auto by default; this forces flush).',
    async run(_args, ctx) {
      await ctx.session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: opts.tokenCounter.total(),
      });
      return { message: `Session ${ctx.session.id} flushed.` };
    },
  };
}

export function buildLoadCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'resume',
    aliases: ['load', 'sessions'],
    description: 'List recent sessions, show incomplete ones (--incomplete), or plan a recovery (--recover <id>).',
    async run(args) {
      const parts = args.split(/\s+/).filter(Boolean);
      const showIncomplete = parts.includes('--incomplete') || parts.includes('-i');
      const recoverIdx = parts.findIndex((p) => p === '--recover');
      const recoverTarget = recoverIdx >= 0 ? parts[recoverIdx + 1] : undefined;

      if (recoverTarget) {
        if (!opts.paths) {
          return { message: color.yellow('No paths configured — cannot build a recovery plan.') };
        }
        const recovery = new SessionRecovery(opts.paths.projectSessions);
        const plan = await recovery.recover(recoverTarget);
        if (!plan) {
          return {
            message: color.yellow(
              `No session log found for ${recoverTarget} (or it is empty).`,
            ),
          };
        }
        const lines: string[] = [
          color.bold(`Recovery plan for ${plan.sessionId}`),
          `  Stale: ${plan.stale ? color.yellow('yes') : color.green('no')}`,
        ];
        if (plan.context) {
          lines.push(`  Last in-flight context: ${color.cyan(plan.context)}`);
        }
        if (plan.lastCheckpoint && plan.lastCheckpoint.type === 'checkpoint') {
          const cp = plan.lastCheckpoint;
          lines.push(
            `  Last checkpoint: promptIndex=${cp.promptIndex} preview=${color.dim(`"${cp.promptPreview}"`)} at ${color.dim(cp.ts)}`,
          );
        } else {
          lines.push(`  Last checkpoint: ${color.dim('(none — full re-execution)')}`);
        }
        lines.push(
          `  Pending events: ${plan.pendingEvents.length} (the work that would re-run on resume)`,
        );
        if (plan.pendingEvents.length > 0) {
          const summary = summarizePending(plan.pendingEvents);
          lines.push(...summary);
        }
        lines.push('');
        lines.push(
          color.dim(
            plan.stale
              ? '  This session crashed mid-iteration. The full re-execution kernel is coming in a follow-up; for now use this plan to decide whether to start fresh.'
              : '  This session ended cleanly; the plan above describes the most recent turn(s) for context.',
          ),
        );
        return { message: lines.join('\n') };
      }

      if (showIncomplete) {
        if (!opts.paths) {
          return { message: color.yellow('No paths configured — cannot scan for incomplete sessions.') };
        }
        const recovery = new SessionRecovery(opts.paths.projectSessions);
        const resumable = await recovery.listResumable();
        if (resumable.length === 0) {
          return {
            message: color.dim('No incomplete sessions. (Every recorded run ended cleanly.)'),
          };
        }
        const lines: string[] = [
          color.bold(`${resumable.length} incomplete session(s)`),
          color.dim('  (process died mid-iteration; the last event was in_flight_start)'),
          '',
        ];
        for (const s of resumable) {
          const t = color.dim(s.lastEventTs.slice(0, 19).replace('T', ' '));
          lines.push(
            `  ${color.cyan(s.sessionId)}  ${t}  ${color.dim(`${s.eventCount} events`)}  ${s.context}`,
          );
        }
        lines.push('');
        lines.push(
          color.dim(
            '  Resuming re-executes the in-flight work from the last checkpoint. Full resume is coming in a follow-up; for now use this list to identify crashes and decide whether to restart fresh.',
          ),
        );
        return { message: lines.join('\n') };
      }

      if (!opts.sessionStore) return { message: 'No session store configured.' };
      const list = await opts.sessionStore.list(10);
      if (list.length === 0) return { message: 'No saved sessions.' };
      const lines = list.map((s) => {
        // Build a compact stats column: tools, errors, outcome badge.
        const parts: string[] = [];
        parts.push(color.dim(`${s.tokenTotal.toLocaleString()} tok`));
        if (s.toolCallCount) {
          const toolStr = `${s.toolCallCount} call${s.toolCallCount === 1 ? '' : 's'}`;
          parts.push(s.toolErrorCount ? color.yellow(toolStr) : color.cyan(toolStr));
        }
        if (s.iterationCount) parts.push(color.dim(`${s.iterationCount} iter`));
        if (s.outcome) {
          const badge =
            s.outcome === 'completed' ? color.green('✓') :
            s.outcome === 'aborted' ? color.yellow('⚠') :
            s.outcome === 'error' ? color.red('✗') :
            color.dim('?');
          parts.push(badge);
        }
        const stat = parts.join(' ');
        const date = color.dim(s.startedAt.slice(0, 16).replace('T', ' '));
        return `  ${s.id.padEnd(42)} ${date}  ${stat}\n    ${color.dim(s.title)}`;
      });
      const msg = [
        color.bold(`Recent sessions (${list.length}):`),
        ...lines,
        '',
        color.dim(`Resume: wstack resume ${list[0]?.id ?? '<id>'}`),
        color.dim('Tip: /resume --incomplete — list crashed sessions'),
      ].join('\n');
      opts.renderer.write(msg);
      return { message: msg };
    },
  };
}

export function buildExitCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the REPL.',
    async run() {
      // Check for uncommitted changes before exit
      if (opts.onBeforeExit) {
        const result = await opts.onBeforeExit();
        if (result?.abort) {
          // warn but allow exit anyway
          opts.onExit?.();
          return { message: result.message ?? '', exit: true };
        }
      }
      opts.onExit?.();
      return { exit: true };
    },
  };
}

/**
 * Build a compact one-line-per-event summary of a recovery plan's
 * pending events. Stops early once we've shown enough to be useful
 * (cap = 12 lines) — the recovery is informational, not a re-execution.
 */
function summarizePending(
  events: import('@wrongstack/core').SessionEvent[],
): string[] {
  const lines: string[] = [];
  const cap = 12;
  for (const ev of events.slice(-cap)) {
    const t = 'ts' in ev ? color.dim(String(ev.ts).slice(11, 19)) : color.dim('--:--:--');
    const kind = color.cyan(String(ev.type).padEnd(18));
    lines.push(`    ${t}  ${kind}  ${summariseEvent(ev)}`);
  }
  if (events.length > cap) {
    lines.push(color.dim(`    … and ${events.length - cap} more`));
  }
  return lines;
}

function summariseEvent(ev: import('@wrongstack/core').SessionEvent): string {
  switch (ev.type) {
    case 'user_input': {
      const text =
        'text' in ev && typeof ev.text === 'string'
          ? ev.text
          : Array.isArray((ev as { content?: unknown }).content)
            ? '…'
            : '';
      return color.dim(text.length > 60 ? text.slice(0, 59) + '…' : text);
    }
    case 'llm_response':
      return color.dim('(model reply)');
    case 'tool_use':
      return color.dim(`name=${(ev as { name?: string }).name ?? '?'}`);
    case 'tool_result':
      return color.dim(`name=${(ev as { name?: string }).name ?? '?'}`);
    case 'in_flight_start':
      return color.dim(`context="${(ev as { context?: string }).context ?? ''}"`);
    case 'in_flight_end':
      return color.dim(`reason=${(ev as { reason?: string }).reason ?? '?'}`);
    case 'checkpoint':
      return color.dim(
        `promptIndex=${(ev as { promptIndex?: number }).promptIndex ?? '?'}`,
      );
    case 'compaction':
      return color.dim('(compaction)');
    case 'error':
      return color.red(String((ev as { message?: string }).message ?? ''));
    default:
      return color.dim('…');
  }
}
