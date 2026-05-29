/**
 * AutoPhase host wiring for the CLI.
 *
 * Turns a free-text goal into a real, LLM-driven phase run:
 *   1. PLAN   — a one-shot subagent generates a phase-by-phase plan where each
 *               phase carries many concrete todos (AutoPhasePlanner).
 *   2. BUILD  — PhaseGraphBuilder materializes the plan into a PhaseGraph with a
 *               populated TaskGraph per phase, persisted as per-project JSON.
 *   3. RUN    — PhaseOrchestrator drives the graph in the background; every task
 *               is executed by a fresh subagent (full tool access). Phase/task
 *               events flow on the shared EventBus so the TUI PhaseMonitor stays
 *               live, and the graph is re-persisted as phases complete.
 *
 * This is "SDD logic but different": phased, persisted task-lists like SDD, but
 * driven by the autonomous orchestrator + concurrent subagents rather than
 * single-thread turn injection.
 */

import { spawn } from 'node:child_process';
import {
  AutoPhasePlanner,
  buildChildEnv,
  PhaseGraphBuilder,
  PhaseOrchestrator,
  PhaseStore,
  WorktreeManager,
  type Config,
  type EventBus,
  type PhaseGraph,
  type PhaseProgress,
  type TaskNode,
} from '@wrongstack/core';
import type { MultiAgentHost } from './multi-agent.js';

/** Default parallel-phase concurrency once worktree isolation is available. */
const WORKTREE_PHASE_CONCURRENCY = 4;

/** Run a git command, returning trimmed stdout (empty string on failure). */
function gitText(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('git', args, { cwd, env: buildChildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr?.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('error', () => resolve({ code: 1, out }));
    child.on('close', (code) => resolve({ code: code ?? 1, out: out.trim() }));
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const { code, out } = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  return code === 0 && out.trim() === 'true';
}

export interface AutoPhaseHostDeps {
  multiAgentHost: MultiAgentHost;
  /** Read the *current* Config lazily (it may be patched, e.g. YOLO toggles). */
  getConfig: () => Config;
  /** Shared app EventBus — orchestrator events feed the TUI PhaseMonitor. */
  events: EventBus;
  /** Directory for per-project phase-graph JSON (wpaths.projectAutophase). */
  storeDir: string;
  /** Project root — base for git-worktree isolation. */
  projectRoot: string;
  /**
   * Enable per-phase git-worktree isolation (default true). When on and the
   * project is a git repo, parallelizable phases run in isolated worktrees and
   * merge back sequentially. Disable with WRONGSTACK_AUTOPHASE_WORKTREES=0.
   */
  worktrees?: boolean;
  /** Max parallel phases when worktrees are active (default 4). */
  maxConcurrentPhases?: number;
  /** Optional progress logger (rendered to the user during start). */
  log?: (line: string) => void;
}

/** A live, read-only view of the running AutoPhase, exposed to slash commands. */
export interface AutoPhaseRunnerView {
  graph: PhaseGraph;
  getProgress: () => PhaseProgress | null;
  isRunning: () => boolean;
}

export type AutoPhaseStartResult =
  | { ok: true; graph: PhaseGraph }
  | { ok: false; error: string };

export interface AutoPhaseHostHooks {
  onAutoPhaseStart: (opts: { goal: string; projectContext?: string }) => Promise<AutoPhaseStartResult>;
  onAutoPhasePause: () => void;
  onAutoPhaseResume: () => void;
  onAutoPhaseStop: () => void;
  getAutoPhaseRunner: () => AutoPhaseRunnerView | null;
  /** Backs the /worktree slash command (list / merge / prune / clean). */
  onWorktree: (action: 'list' | 'merge' | 'prune' | 'clean', target?: string) => Promise<string>;
}

interface ActiveRun {
  graph: PhaseGraph;
  orchestrator: PhaseOrchestrator;
  abort: AbortController;
  unsubscribe: () => void;
}

/** Minimal shape of an agent.run result we depend on. */
interface RunResult {
  status: string;
  finalText?: string;
  error?: { message?: string };
}

export function createAutoPhaseHost(deps: AutoPhaseHostDeps): AutoPhaseHostHooks {
  const store = new PhaseStore({ baseDir: deps.storeDir });
  let active: ActiveRun | null = null;
  const log = deps.log ?? (() => {});

  /** Run a single prompt to completion in a throwaway subagent; return its text. */
  async function runOnce(
    prompt: string,
    label: string,
    signal: AbortSignal,
    cwd?: string,
  ): Promise<string> {
    const factory = deps.multiAgentHost.makeSubagentFactory(deps.getConfig());
    const built = await factory({ name: label, cwd });
    try {
      const result = (await built.agent.run(prompt, { signal })) as RunResult;
      if (result.status !== 'done') {
        throw new Error(result.error?.message ?? `subagent ended with status "${result.status}"`);
      }
      return result.finalText ?? '';
    } finally {
      await built.dispose?.();
    }
  }

  function buildTaskPrompt(task: TaskNode, phaseName: string, goal: string): string {
    return [
      `You are executing one task inside an autonomous, phase-based build.`,
      `Overall goal: ${goal}`,
      `Current phase: ${phaseName}`,
      '',
      `TASK: ${task.title}`,
      task.description ? `Details: ${task.description}` : '',
      `Type: ${task.type} · Priority: ${task.priority}`,
      '',
      `Do the work now using your tools (read, edit, write, bash, …). Make the`,
      `change real — do not just describe it. When finished, end with a one-line`,
      `summary of what you changed. If the task is impossible or already done,`,
      `say so explicitly.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  async function persist(graph: PhaseGraph): Promise<void> {
    try {
      await store.save(graph);
    } catch (err) {
      log(`⚠ AutoPhase save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    async onAutoPhaseStart({ goal, projectContext }): Promise<AutoPhaseStartResult> {
      if (active?.orchestrator.isRunning()) {
        return { ok: false, error: 'An AutoPhase run is already in progress. Use /autophase stop first.' };
      }

      const abort = new AbortController();

      // 1) PLAN
      log(`🧠 Planning phases for: ${goal}`);
      let phases;
      try {
        const planner = new AutoPhasePlanner({
          goal,
          projectContext,
          runOnce: (p) => runOnce(p, 'autophase-planner', abort.signal),
        });
        const result = await planner.plan();
        if (result.parseFailed || result.phases.length === 0) {
          return { ok: false, error: 'The planner did not produce a usable phase plan. Try a more specific goal.' };
        }
        phases = result.phases;
      } catch (err) {
        return { ok: false, error: `Planning failed: ${err instanceof Error ? err.message : String(err)}` };
      }

      const todoCount = phases.reduce((n, p) => n + (p.taskTemplates?.length ?? 0), 0);
      log(`📋 Plan ready: ${phases.length} phases, ${todoCount} todos.`);

      // 2) BUILD + persist
      const graph = await new PhaseGraphBuilder({
        title: goal,
        phases,
        autonomous: true,
      }).build();
      await persist(graph);

      // Per-phase git-worktree isolation. When enabled and inside a git repo,
      // each phase runs in its own worktree+branch so parallelizable phases
      // execute concurrently and merge back sequentially. Otherwise fall back
      // to the legacy single-tree, single-phase, single-task behavior.
      const worktreesEnabled =
        deps.worktrees !== false && process.env['WRONGSTACK_AUTOPHASE_WORKTREES'] !== '0';
      let worktrees: WorktreeManager | undefined;
      if (worktreesEnabled && (await isGitRepo(deps.projectRoot))) {
        worktrees = new WorktreeManager({ projectRoot: deps.projectRoot, events: deps.events });
        log(`🌿 Worktree isolation on — up to ${deps.maxConcurrentPhases ?? WORKTREE_PHASE_CONCURRENCY} phases run in parallel.`);
      }

      // 3) RUN (background)
      const orchestrator = new PhaseOrchestrator({
        graph,
        ctx: {
          executeTask: async (task, phaseId, env) => {
            const phase = graph.phases.get(phaseId);
            const phaseName = phase?.name ?? phaseId;
            return runOnce(
              buildTaskPrompt(task, phaseName, goal),
              `autophase-${phaseName}-${task.title}`.slice(0, 48),
              abort.signal,
              env?.cwd,
            );
          },
          onPhaseComplete: (phase) => {
            log(`✅ Phase completed: ${phase.name}`);
            void persist(graph);
          },
          onPhaseFail: (phase, error) => {
            log(`❌ Phase failed: ${phase.name} — ${error.message}`);
            void persist(graph);
          },
        },
        events: deps.events,
        worktrees,
        autonomous: true,
        // With isolation, parallelizable phases run concurrently; without it,
        // stay strictly sequential to protect the shared working tree.
        maxConcurrentPhases: worktrees ? (deps.maxConcurrentPhases ?? WORKTREE_PHASE_CONCURRENCY) : 1,
        // Sequential within a phase: each todo is a full-tool agent and todos in
        // a phase typically build on one another (they share the phase worktree).
        maxConcurrentTasks: 1,
      });

      // Re-persist on terminal graph events.
      const onUntyped = deps.events.on as unknown as (
        event: string,
        handler: (payload: unknown) => void,
      ) => void;
      const offUntyped = deps.events.off as unknown as (
        event: string,
        handler: (payload: unknown) => void,
      ) => void;
      const onDone = () => {
        log(`🎉 AutoPhase complete: ${graph.title}`);
        void persist(graph);
      };
      const onFailed = () => void persist(graph);
      onUntyped('graph.completed', onDone);
      onUntyped('graph.failed', onFailed);
      const unsubscribe = () => {
        offUntyped('graph.completed', onDone);
        offUntyped('graph.failed', onFailed);
      };

      active = { graph, orchestrator, abort, unsubscribe };

      // Fire-and-forget: orchestrator.start() resolves only when the whole
      // graph finishes, so we must NOT await it here or the slash command
      // would block until the entire project is built.
      void orchestrator.start().catch((err) => {
        log(`💥 AutoPhase aborted: ${err instanceof Error ? err.message : String(err)}`);
      });

      return { ok: true, graph };
    },

    onAutoPhasePause() {
      active?.orchestrator.pause();
    },

    onAutoPhaseResume() {
      active?.orchestrator.resume();
    },

    onAutoPhaseStop() {
      if (!active) return;
      active.abort.abort();
      active.orchestrator.stop();
      active.unsubscribe();
      void persist(active.graph);
      active = null;
    },

    getAutoPhaseRunner() {
      if (!active) return null;
      const a = active;
      return {
        graph: a.graph,
        getProgress: () => a.orchestrator.getProgress(),
        isRunning: () => a.orchestrator.isRunning(),
      };
    },

    async onWorktree(action, target) {
      const root = deps.projectRoot;
      if (!(await isGitRepo(root))) return '⚠ Not a git repository — worktrees unavailable.';

      switch (action) {
        case 'list': {
          const { out } = await gitText(['worktree', 'list'], root);
          return out || 'No worktrees.';
        }
        case 'prune': {
          await gitText(['worktree', 'prune'], root);
          const { out } = await gitText(['worktree', 'list'], root);
          return `Pruned stale worktree entries.\n${out}`;
        }
        case 'merge': {
          if (!target) return 'Usage: /worktree merge <branch>';
          if (target.startsWith('-')) return `Refusing unsafe branch name: ${target}`;
          const base = (await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], root)).out || 'HEAD';
          await gitText(['merge', '--squash', target], root);
          const commit = await gitText(['commit', '-m', `merge ${target} (squash)`], root);
          if (commit.code !== 0 && !/nothing to commit/i.test(commit.out)) {
            await gitText(['reset', '--hard', 'HEAD'], root);
            return `⚠ Merge of "${target}" into ${base} hit conflicts and was rolled back.\n${commit.out}`;
          }
          return `✓ Merged "${target}" into ${base} (squash).`;
        }
        case 'clean': {
          // Remove all wstack-managed worktrees + branches.
          const list = (await gitText(['worktree', 'list', '--porcelain'], root)).out;
          const dirs = list
            .split('\n')
            .filter((l) => l.startsWith('worktree '))
            .map((l) => l.slice('worktree '.length))
            .filter((d) => d.includes('.wrongstack') && d.includes('worktrees'));
          for (const d of dirs) await gitText(['worktree', 'remove', '--force', d], root);
          await gitText(['worktree', 'prune'], root);
          const branches = (await gitText(['branch', '--list', 'wstack/ap/*'], root)).out
            .split('\n').map((b) => b.replace(/^[*+]?\s*/, '').trim()).filter(Boolean);
          for (const b of branches) await gitText(['branch', '-D', b], root);
          return `🧹 Removed ${dirs.length} worktree(s) and ${branches.length} branch(es).`;
        }
        default:
          return `Unknown worktree action: ${action}`;
      }
    },
  };
}
