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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AutoPhasePlanner,
  type BrainArbiter,
  buildChildEnv,
  type Config,
  type EventBus,
  type PhaseGraph,
  PhaseGraphBuilder,
  PhaseOrchestrator,
  type PhaseProgress,
  PhaseStore,
  type TaskNode,
  WorktreeManager,
} from '@wrongstack/core';
import type { MultiAgentHost } from './multi-agent.js';

/** Default parallel-phase concurrency once worktree isolation is available. */
const WORKTREE_PHASE_CONCURRENCY = 4;

/**
 * Cap on captured command output. Verification commands (`pnpm test` across
 * a large monorepo) can emit tens of MB on a verbose run — accumulating the
 * full transcript spikes the host heap for output nothing ever reads in
 * full. runCmd keeps the TAIL (the failure summary lives at the end of a
 * test run); gitText keeps the head (its commands are tiny).
 */
const MAX_CMD_OUTPUT = 200_000;

/** Run a git command, returning trimmed stdout (empty string on failure). */
function gitText(args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        env: buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(10_000),
        windowsHide: true,
      });
    } catch (err) {
      // spawn throws synchronously when git is not installed.
      reject(err);
      return;
    }
    const chunks: string[] = [];
    const emit = (c: Buffer) => {
      if (chunks.join('').length < MAX_CMD_OUTPUT) chunks.push(c.toString());
    };
    child.stdout?.on('data', emit);
    child.stderr?.on('data', emit);
    child.on('error', () => resolve({ code: 1, out: chunks.join('') }));
    child.on('close', (code) => resolve({ code: code ?? 1, out: chunks.join('').trim() }));
  });
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const { code, out } = await gitText(['rev-parse', '--is-inside-work-tree'], cwd);
  return code === 0 && out.trim() === 'true';
}

// Commands allowed for autonomous autophase verification. This mirrors
// @wrongstack/tools exec.ts ALLOWED_COMMANDS but is intentionally narrower:
// autophase only ever runs package-manager script invocations and an optional
// user-configured custom verify command.
const AUTOPHASE_SAFE_CMDS: ReadonlySet<string> = new Set(['pnpm', 'npm', 'yarn', 'bun']);

// Destructive shell patterns that must never execute autonomously.
// Mirrors the yolo-risk.ts pattern set for autophase context.
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+-rf\s+\//,
  /\bdangerously\s+(?:force|reset|--hard)\b/,
  /\bgit\s+clean\s+-[xdf]{2,}/,
  /\bgit\s+reset\s+--hard\b/,
  /([;&|]\s*)(?!\s*$)/, // command chaining (; && || |)
  /`[^`]+`/, // backtick subshell
  /\$\(/, // $(...) subshell
];

/** Run an arbitrary command, capturing combined stdout+stderr. */
function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  shell = false,
): Promise<{ code: number; out: string }> {
  // ── allowlist gate ──────────────────────────────────────────────────
  if (!AUTOPHASE_SAFE_CMDS.has(cmd)) {
    return Promise.resolve({
      code: 1,
      out:
        `autophase: command "${cmd}" not in autonomous safe-commands allowlist. ` +
        `Allowed: ${[...AUTOPHASE_SAFE_CMDS].join(', ')}. ` +
        `Set WRONGSTACK_AUTOPHASE_VERIFY_CMD to one of these.`,
    });
  }

  // ── destructive-pattern gate ────────────────────────────────────────
  const fullCmd = [cmd, ...args].join(' ');
  for (const pat of DESTRUCTIVE_PATTERNS) {
    if (pat.test(fullCmd)) {
      return Promise.resolve({
        code: 1,
        out: `autophase: rejected destructive command pattern: ${fullCmd}`,
      });
    }
  }

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Pass through explicitly — allowlist validation already runs above,
        // so the caller's shell preference is authoritative.
        shell,
        signal: AbortSignal.timeout(30_000),
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    // Tail-keep: a failing `pnpm test` prints its summary at the end, which
    // is what the verify failure message feeds back to the agent.
    const append = (c: Buffer) => {
      chunks.push(c.toString());
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => resolve({ code: 1, out: `${chunks.join('')}${String(e)}` }));
    child.on('close', (code) => {
      let out = chunks.join('');
      if (out.length > MAX_CMD_OUTPUT) out = out.slice(-MAX_CMD_OUTPUT);
      resolve({ code: code ?? 1, out: out.trim() });
    });
  });
}

/** Detect the project's package manager from lockfiles at the repo root. */
function detectPackageManager(root: string): string {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/** Read package.json scripts for a directory (empty on any failure). */
function readScripts(cwd: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
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
  worktrees?: boolean | undefined;
  /** Max parallel phases when worktrees are active (default 4). */
  maxConcurrentPhases?: number | undefined;
  /** Optional global Brain arbiter for AutoPhase policy decisions. */
  brain?: BrainArbiter | undefined;
  /** Optional progress logger (rendered to the user during start). */
  log?: ((line: string) => void) | undefined;
}

/** A live, read-only view of the running AutoPhase, exposed to slash commands. */
export interface AutoPhaseRunnerView {
  graph: PhaseGraph;
  getProgress: () => PhaseProgress | null;
  isRunning: () => boolean;
}

export type AutoPhaseStartResult = { ok: true; graph: PhaseGraph } | { ok: false; error: string };

export interface AutoPhaseHostHooks {
  onAutoPhaseStart: (opts: {
    goal: string;
    projectContext?: string | undefined;
  }) => Promise<AutoPhaseStartResult>;
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
  finalText?: string | undefined;
  error?: { message?: string | undefined };
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
    cwd?: string | undefined,
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

  function buildRepairPrompt(phaseName: string, failure: string, goal: string): string {
    return [
      `You are repairing a FAILED verification inside an autonomous, phase-based build.`,
      `Overall goal: ${goal}`,
      `Phase: ${phaseName}`,
      '',
      `The phase's code changes were applied, but verification (typecheck/lint)`,
      `failed in this working directory. Verifier output:`,
      '```',
      failure.slice(0, 4000),
      '```',
      '',
      `Fix the code in THIS working directory so verification passes. Use your tools`,
      `(read, edit, write, bash). Fix the root cause — do NOT delete code, weaken`,
      `types, or disable lint rules just to silence the error. When finished, end`,
      `with a one-line summary of what you changed.`,
    ].join('\n');
  }

  function buildConflictPrompt(files: string[], goal: string): string {
    const fileList = files.length
      ? files.map((f) => `  - ${f}`).join('\n')
      : '  (run `git diff --check` or search for "<<<<<<<" to find them)';
    return [
      `A git squash-merge hit conflicts while integrating an autonomous build phase`,
      `into the base branch. Overall goal: ${goal}`,
      '',
      `These files contain conflict markers (<<<<<<<, =======, >>>>>>>) in the`,
      `current working directory:`,
      fileList,
      '',
      `Resolve every conflict by correctly combining BOTH sides — keep the intent of`,
      `the base branch AND the phase's changes; do not blindly discard either side.`,
      `Remove all conflict markers from every affected file. Do NOT run \`git commit\``,
      `or \`git add\` — just leave the resolved files on disk. If a conflict cannot be`,
      `resolved safely, say so explicitly. End with a one-line summary.`,
    ].join('\n');
  }

  /**
   * Verify a phase's working tree. Runs the project's `typecheck` + `lint` scripts
   * (or a custom `WRONGSTACK_AUTOPHASE_VERIFY_CMD`) in `cwd`. Returns ok:true when
   * all pass, or when verification cannot meaningfully run (no deps / no scripts) —
   * the gate never blocks on things it can't actually check.
   */
  async function runVerify(cwd: string): Promise<{ ok: boolean; output?: string | undefined }> {
    // Script commands need resolvable node_modules. A nested git worktree resolves
    // upward to the repo-root node_modules, so accept either location.
    if (
      !existsSync(join(cwd, 'node_modules')) &&
      !existsSync(join(deps.projectRoot, 'node_modules'))
    ) {
      return { ok: true, output: 'verify skipped: node_modules not found' };
    }

    const custom = process.env['WRONGSTACK_AUTOPHASE_VERIFY_CMD']?.trim();
    if (custom) {
      const res = await runCmd(custom, [], cwd, true);
      return res.code === 0
        ? { ok: true }
        : { ok: false, output: `[verify] exited ${res.code}\n${res.out}` };
    }

    const pm = detectPackageManager(deps.projectRoot);
    const scripts = readScripts(cwd);
    const steps = (['typecheck', 'lint'] as const).filter((s) => typeof scripts[s] === 'string');
    if (steps.length === 0) return { ok: true, output: 'verify skipped: no typecheck/lint script' };

    for (const step of steps) {
      const res = await runCmd(pm, ['run', step], cwd);
      if (res.code !== 0) {
        return { ok: false, output: `[${step}] exited ${res.code}\n${res.out}` };
      }
    }
    return { ok: true };
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
        return {
          ok: false,
          error: 'An AutoPhase run is already in progress. Use /autophase stop first.',
        };
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
          return {
            ok: false,
            error: 'The planner did not produce a usable phase plan. Try a more specific goal.',
          };
        }
        phases = result.phases;
      } catch (err) {
        return {
          ok: false,
          error: `Planning failed: ${err instanceof Error ? err.message : String(err)}`,
        };
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
        log(
          `🌿 Worktree isolation on — up to ${deps.maxConcurrentPhases ?? WORKTREE_PHASE_CONCURRENCY} phases run in parallel.`,
        );
      }

      // Per-phase verification gate. After a phase's todos all succeed, run the
      // project's typecheck/lint in the phase worktree before merging; on failure
      // a repair subagent gets the output and fixes the tree, then we re-verify.
      // Disable with WRONGSTACK_AUTOPHASE_VERIFY=0.
      const verifyEnabled = process.env['WRONGSTACK_AUTOPHASE_VERIFY'] !== '0';
      if (verifyEnabled) {
        log(`🔎 Verify gate on — phases must pass typecheck/lint before merging.`);
      }

      // Merge-conflict resolution. Only meaningful with worktree isolation (the
      // only path that merges). On conflict a resolver subagent edits the base
      // tree to clear the markers; if it fails the worktree is parked for review
      // as before. Disable with WRONGSTACK_AUTOPHASE_RESOLVE=0.
      const resolveEnabled = !!worktrees && process.env['WRONGSTACK_AUTOPHASE_RESOLVE'] !== '0';

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
          verifyPhase: verifyEnabled
            ? async (_phase, env) => runVerify(env?.cwd ?? deps.projectRoot)
            : undefined,
          repairPhase: verifyEnabled
            ? async (phase, failure, attempt, env) => {
                log(`🔧 Repairing "${phase.name}" (attempt ${attempt}) after verify failure…`);
                await runOnce(
                  buildRepairPrompt(phase.name, failure, goal),
                  `autophase-repair-${phase.name}`.slice(0, 48),
                  abort.signal,
                  env?.cwd,
                );
              }
            : undefined,
          resolveConflict: resolveEnabled
            ? async (_phase, info) => {
                log(`🔀 Resolving merge conflict in ${info.conflictFiles.length} file(s)…`);
                try {
                  await runOnce(
                    buildConflictPrompt(info.conflictFiles, goal),
                    'autophase-conflict',
                    abort.signal,
                    info.cwd,
                  );
                  return true;
                } catch {
                  return false;
                }
              }
            : undefined,
          brain: deps.brain,
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
        maxConcurrentPhases: worktrees
          ? (deps.maxConcurrentPhases ?? WORKTREE_PHASE_CONCURRENCY)
          : 1,
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
      const finalizeActiveRun = () => {
        if (active?.graph.id !== graph.id) return;
        active.unsubscribe();
        active = null;
      };
      const onDone = () => {
        log(`🎉 AutoPhase complete: ${graph.title}`);
        void persist(graph);
        finalizeActiveRun();
      };
      const onFailed = () => {
        void persist(graph);
        finalizeActiveRun();
      };
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
        void persist(graph);
        finalizeActiveRun();
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
            .split('\n')
            .map((b) => b.replace(/^[*+]?\s*/, '').trim())
            .filter(Boolean);
          for (const b of branches) await gitText(['branch', '-D', b], root);
          return `🧹 Removed ${dirs.length} worktree(s) and ${branches.length} branch(es).`;
        }
        default:
          return `Unknown worktree action: ${action}`;
      }
    },
  };
}
