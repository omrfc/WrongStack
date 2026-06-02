import { color, dispatchAgent, AGENTS_BY_PHASE } from '@wrongstack/core';
import type { SlashCommand, AgentPhase } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

const PHASE_ORDER: { phase: AgentPhase; label: string }[] = [
  { phase: 'discovery', label: '1 · Discovery' },
  { phase: 'planning', label: '2 · Planning' },
  { phase: 'build', label: '3 · Build' },
  { phase: 'verify', label: '4 · Verify' },
  { phase: 'review', label: '5 · Review' },
  { phase: 'domain', label: '6 · Domain' },
  { phase: 'knowledge', label: '7 · Knowledge' },
  { phase: 'delivery', label: '8 · Delivery & Ops' },
  { phase: 'meta', label: '9 · Meta' },
];

/**
 * /fleet — live fleet observability and control.
 *
 * Requires a FleetManager or Director instance to be wired into SlashCommandContext.
 * Works during /autonomy parallel mode (when the engine is running) and for
 * any standalone director session.
 *
 * Usage:
 *   /fleet              — status table: subagent id / name / role / status / current task
 *   /fleet status       — same as /fleet (verbose)
 *   /fleet spawn <role> [count]  — spawn N subagents of a given role (default 1)
 *   /fleet terminate <subagentId>  — stop a specific subagent
 *   /fleet kill         — stop all running subagents
 *   /fleet usage        — token and cost breakdown across the fleet
 *   /fleet journal      — show recent journal entries from goal.json
 */
export function buildFleetCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'fleet',
    description: 'Inspect and control the agent fleet (subagents, parallel slots).',
    help: [
      'Usage:',
      '  /fleet              Show fleet status (default)',
      '  /fleet status       Same as /fleet (verbose status)',
      '  /fleet list         List the agent roster grouped by phase',
      '  /fleet dispatch <task>  Route a task to the best agent and spawn it',
      '  /fleet spawn <role> [count]  Spawn N subagents of a role (default 1)',
      '  /fleet terminate <subagentId>  Stop a specific subagent by id',
      '  /fleet kill         Stop all running subagents',
      '  /fleet usage        Token and cost breakdown across the fleet',
      '  /fleet journal      Show recent journal entries from /goal journal',
      '',
      'In the TUI, press Ctrl+F to open the graphical fleet monitor.',
      'Works during /autonomy parallel mode and standalone director sessions.',
    ].join('\n'),
    async run(args) {
      const parts = args.trim().split(/\s+/);
      const cmd = parts[0]?.toLowerCase() ?? '';
      const subargs = parts.slice(1);

      // ── /fleet (status / manifest) ────────────────────────────────────────
      if (!cmd || cmd === 'status' || cmd === 'info' || cmd === 'manifest') {
        if (opts.onFleetStatus) {
          const status = opts.onFleetStatus();
          if (!status) {
            const msg = `${color.amber('⚠ No fleet active.')} Start /autonomy parallel first, or pass --director to a session.`;
            opts.renderer.write(msg);
            return { message: msg };
          }
          const lines: string[] = [];
          lines.push(`${color.bold('Fleet Status')}`);
          lines.push(
            color.dim(
              `  coordinator: ${status.coordinatorId}  ·  pending: ${status.pendingTasks}  ·  done: ${status.completedTasks}`,
            ),
          );
          if (status.subagents.length === 0) {
            lines.push(color.dim('  No active subagents.'));
          } else {
            lines.push('');
            lines.push(
              `  ${color.bold('ID').padEnd(36)} ${color.bold('NAME').padEnd(16)} ${color.bold('STATUS').padEnd(10)} ${color.bold('TASK')}`,
            );
            lines.push(color.dim('  ' + '─'.repeat(80)));
            for (const sa of status.subagents) {
              const id = sa.id?.padEnd(36) ?? ''.padEnd(36);
              const name = (sa.name ?? 'worker').padEnd(16);
              const statusColor =
                sa.status === 'running'
                  ? color.green(sa.status.padEnd(10))
                  : sa.status === 'idle'
                    ? color.dim(sa.status.padEnd(10))
                    : color.dim(sa.status.padEnd(10));
              const ext = sa.extensions && sa.extensions > 0 ? `${color.yellow(`⚡×${sa.extensions}`)} ` : '';
              const task = sa.currentTask ?? color.dim('—');
              lines.push(`  ${id} ${name} ${statusColor} ${ext}${task}`);
            }
          }
          const msg = lines.join('\n');
          opts.renderer.write(msg);
          return { message: msg };
        }
        if (opts.onFleet) {
          const msg = await opts.onFleet((cmd || 'status') as 'status' | 'usage' | 'kill' | 'manifest' | 'concurrency' | 'retry' | 'log', undefined);
          return { message: msg };
        }
        const msg = `${color.amber('⚠ No fleet active.')} Start /autonomy parallel first, or pass --director to a session.`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      // ── /fleet usage ─────────────────────────────────────────────────────
      if (cmd === 'usage' || cmd === 'cost' || cmd === 'tokens') {
        if (opts.onFleetUsage) {
          const usage = opts.onFleetUsage();
          if (!usage) {
            const msg = `${color.amber('⚠ No fleet usage data.')} Start /autonomy parallel first.`;
            opts.renderer.write(msg);
            return { message: msg };
          }

          const totalCost = usage.total?.cost ?? 0;
          const totalIn = usage.total?.input ?? 0;
          const totalOut = usage.total?.output ?? 0;

          const lines: string[] = [];
          lines.push(`${color.bold('Fleet Usage')}`);
          lines.push(
            `  ${color.dim('Total:')} ${color.green(`${totalCost.toFixed(4)}`)} · ${color.cyan(totalIn.toLocaleString())} in · ${color.cyan(totalOut.toLocaleString())} out`,
          );

          const subagents = Object.values(usage.perSubagent);
          if (subagents.length > 0) {
            lines.push('');
            for (const sa of subagents) {
              const name = (sa.subagentId ?? '?').padEnd(20);
              const cost = `${(sa.cost ?? 0).toFixed(4)}`.padStart(10);
              const tokens = `${sa.input ?? 0} in / ${sa.output ?? 0} out`.padEnd(30);
              lines.push(`  ${color.dim(name)} ${color.cyan(cost)} ${color.dim(tokens)}`);
            }
          }

          const msg = lines.join('\n');
          opts.renderer.write(msg);
          return { message: msg };
        }
        if (opts.onFleet) {
          const msg = await opts.onFleet('usage', undefined);
          return { message: msg };
        }
        const msg = `${color.amber('⚠ No fleet usage data.')} Start /autonomy parallel first.`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      // ── /fleet retry ───────────────────────────────────────────────────────
      if (cmd === 'retry') {
        if (opts.onFleetRetry) {
          const targetId = subargs[0];
          const msg = await opts.onFleetRetry(targetId);
          return { message: msg };
        }
        if (opts.onFleet) {
          const msg = await opts.onFleet('retry', subargs[0]);
          return { message: msg };
        }
        const msg = `Retry is only available when director mode is active.`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      // ── /fleet journal / log ────────────────────────────────────────────────
      if (cmd === 'journal' || cmd === 'log') {
        if (opts.onFleetLog) {
          const subagentId = subargs[0];
          const mode = subargs[1] === 'raw' ? 'raw' : 'summary';
          const msg = await opts.onFleetLog(subagentId, mode);
          return { message: msg };
        }
        if (opts.onFleet) {
          const msg = await opts.onFleet('log', subargs[0]);
          return { message: msg };
        }
        // Fall through to unknown command when no handlers and no goal
        const msg = `${color.dim('No journal entries yet.')}`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      // ── /fleet kill ──────────────────────────────────────────────────────
      if (cmd === 'kill' || cmd === 'stop-all') {
        if (opts.onFleetKill) {
          const killed = opts.onFleetKill();
          const msg = `${color.red('✗ Killed')} ${killed} subagent(s).`;
          opts.renderer.write(msg);
          return { message: msg };
        }
        if (opts.onFleet) {
          const msg = await opts.onFleet('kill', undefined);
          return { message: msg };
        }
        const msg = `${color.amber('⚠ /fleet kill is not wired in this session.')}`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      // ── /fleet terminate <subagentId> ────────────────────────────────────
      if (cmd === 'terminate' || cmd === 'stop') {
        const targetId = subargs[0];
        if (!targetId) {
          const msg = `${color.amber('⚠ /fleet terminate requires a subagentId.')} Use /fleet to see active ids.`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        if (!opts.onFleetTerminate) {
          const msg = `${color.amber('⚠ /fleet terminate is not wired in this session.')}`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const ok = opts.onFleetTerminate(targetId);
        if (ok) {
          const msg = `${color.green('✓ Terminated')} subagent ${color.bold(targetId)}.`;
          opts.renderer.write(msg);
          return { message: msg };
        }
          const msg = `${color.red('✗ Failed')} to terminate ${color.bold(targetId)}. Subagent may already be stopped.`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
      }

      // ── /fleet spawn <role> [count] ──────────────────────────────────────
      if (cmd === 'spawn' || cmd === 'add') {
        const role = subargs[0] ?? 'worker';
        const count = Math.min(16, Math.max(1, Number.parseInt(subargs[1] ?? '1', 10) || 1));
        if (!opts.onFleetSpawn) {
          const msg = `${color.amber('⚠ /fleet spawn is not wired in this session.')}`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const spawned: string[] = [];
        let msg: string;
        for (let i = 0; i < count; i++) {
          try {
            const id = await opts.onFleetSpawn(role);
            spawned.push(id);
          } catch (err) {
            const msg = `${color.red('✗ Spawn failed')} for slot ${i + 1}: ${err instanceof Error ? err.message : String(err)}`;
            opts.renderer.writeWarning(msg);
          }
        }
        if (spawned.length === count) {
          msg = `${color.green('✓ Spawned')} ${count} subagent(s) of role ${color.bold(role)}.`;
          opts.renderer.write(msg);
        } else {
          msg = `${color.amber('⚠ Spawned')} ${spawned.length}/${count} subagent(s). Check /fleet for details.`;
          opts.renderer.writeWarning(msg);
        }
        return { message: msg };
      }

      // ── /fleet list ──────────────────────────────────────────────────────
      if (cmd === 'list' || cmd === 'roster' || cmd === 'agents') {
        const lines: string[] = [`${color.bold('Agent Roster')} ${color.dim('(spawn with /fleet spawn <role>)')}`];
        for (const { phase, label } of PHASE_ORDER) {
          const defs = AGENTS_BY_PHASE[phase];
          if (!defs || defs.length === 0) continue;
          lines.push('');
          lines.push(color.cyan(`  Phase ${label}`));
          for (const def of defs) {
            const role = (def.config.role ?? '').padEnd(18);
            lines.push(`    ${color.bold(role)} ${color.dim(def.capability.summary)}`);
          }
        }
        const msg = lines.join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      // ── /fleet dispatch <task> ───────────────────────────────────────────
      if (cmd === 'dispatch' || cmd === 'route') {
        const task = subargs.join(' ').trim();
        if (!task) {
          const msg = `Usage: /fleet dispatch <task description> — routes the task to the best agent.`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const decision = await dispatchAgent(task, { classifier: opts.onDispatchClassify });
        const pct = Math.round(decision.confidence * 100);
        const lines: string[] = [];
        lines.push(
          `${color.bold('→ ' + decision.role)} ${color.dim(`(${decision.method}, ${pct}% confidence)`)}`,
        );
        lines.push(`  ${color.dim(decision.definition.capability.summary)}`);
        lines.push(`  ${color.dim('why:')} ${decision.reason}`);
        if (decision.alternatives.length > 0) {
          const alts = decision.alternatives.slice(0, 3).map((a) => a.role).join(', ');
          lines.push(`  ${color.dim('alternatives:')} ${alts}`);
        }
        if (opts.onFleetSpawn) {
          try {
            const id = await opts.onFleetSpawn(decision.role);
            lines.push(`  ${color.green('✓ spawned')} ${color.bold(decision.role)} as ${color.dim(id)}`);
          } catch (err) {
            lines.push(
              `  ${color.amber('⚠ spawn failed:')} ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else {
          lines.push(`  ${color.dim('(no fleet active — run /autonomy parallel or --director to spawn)')}`);
        }
        const msg = lines.join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      // ── /fleet help ───────────────────────────────────────────────────────
      if (cmd === 'help' || cmd === '?') {
        const msg = [
          `${color.bold('Fleet Commands')}`,
          `  ${color.dim('/fleet')}              Show fleet status (default)`,
          `  ${color.dim('/fleet status')}       Same as /fleet (verbose status)`,
          `  ${color.dim('/fleet list')}         List the agent roster grouped by phase`,
          `  ${color.dim('/fleet dispatch <task>')}  Route a task to the best agent and spawn it`,
          `  ${color.dim('/fleet spawn <role> [count]')}  Spawn N subagents of a role (default 1)`,
          `  ${color.dim('/fleet terminate <subagentId>')}  Stop a specific subagent by id`,
          `  ${color.dim('/fleet kill')}         Stop all running subagents`,
          `  ${color.dim('/fleet usage')}        Token and cost breakdown across the fleet`,
          `  ${color.dim('/fleet journal')}      Show recent journal entries from /goal journal`,
        ].join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      // ── Unknown command ───────────────────────────────────────────────────
      const valid = ['status', 'list', 'dispatch', 'usage', 'spawn', 'terminate', 'kill', 'retry', 'journal'];
      const msg = `Unknown subcommand "${cmd}". Valid subcommands: ${valid.join(', ')}. Run /fleet with no args to see status, or /fleet help for usage.`;
      opts.renderer.writeWarning(msg);
      return { message: msg };
    },
  };
}