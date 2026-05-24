import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import type { SlashCommand, SpecRequirement } from '@wrongstack/core';
import {
  SpecParser,
  SpecStore,
  TaskGraphStore,
  AISpecBuilder,
  SpecVersioning,
  analyzeCriticalPath,
  renderTaskGraph,
  renderTaskList,
  renderSpecAnalysis,
  renderProgress,
  listTemplates,
  templateToMarkdown,
  getTemplate,
  TaskGenerator,
  TaskTracker,
  TaskFlow,
  DefaultTaskStore,
  type SpecIndexEntry,
  type TaskGraphIndexEntry,
  type SpecVersion,
  type AISpecPhase,
  type TaskProgress,
} from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/** Key used to store SDD session state in ctx.meta for session isolation. */
const SDD_META_KEY = 'sdd.state';

/**
 * Get or create the SDD state for the current session.
 * Uses ctx.meta so each concurrent browser/REPL session has isolated state.
 */
function getSessionState(ctx: SlashCommandContext['context']): SDDState {
  if (!ctx) {
    // No Context — fall back to a process-lifetime singleton (CLI-only, single session)
    return sddState;
  }
  let state = ctx.meta[SDD_META_KEY] as SDDState | undefined;
  if (!state) {
    state = new SDDState();
    ctx.meta[SDD_META_KEY] = state;
  }
  return state;
}

/** Single shared SDD session state for the process lifetime. */
class SDDState {
  private builder: AISpecBuilder | null = null;
  private taskStore: DefaultTaskStore | null = null;
  private taskTracker: TaskTracker | null = null;
  private taskGraphId: string | null = null;
  private sessionStartTime: number = Date.now();
  private phaseStartTime: number = Date.now();
  private versioning: SpecVersioning | null = null;

  getBuilder(): AISpecBuilder | null { return this.builder; }
  setBuilder(b: AISpecBuilder | null) { this.builder = b; }
  getTaskStore(): DefaultTaskStore | null { return this.taskStore; }
  setTaskStore(s: DefaultTaskStore | null) { this.taskStore = s; }
  getTaskTracker(): TaskTracker | null { return this.taskTracker; }
  setTaskTracker(t: TaskTracker | null) { this.taskTracker = t; }
  getTaskGraphId(): string | null { return this.taskGraphId; }
  setTaskGraphId(id: string | null) { this.taskGraphId = id; }
  getSessionStartTime(): number { return this.sessionStartTime; }
  setSessionStartTime(t: number) { this.sessionStartTime = t; }
  setPhaseStartTime(t: number) { this.phaseStartTime = t; }
  getPhaseStartTime(): number { return this.phaseStartTime; }
  getSessionElapsed(): number { return Date.now() - this.sessionStartTime; }
  getPhaseElapsed(): number { return Date.now() - this.phaseStartTime; }
  getVersioning(): SpecVersioning { return this.versioning ?? (this.versioning = new SpecVersioning()); }

  clearTaskState(): void {
    this.taskStore = null;
    this.taskTracker = null;
    this.taskGraphId = null;
  }

  getContext(): string | null {
    if (!this.builder) return null;
    const session = this.builder.getSession();
    if (session.phase === 'done') return null;
    return this.builder.getAIPrompt();
  }

  getPhase(): AISpecPhase | null {
    return this.builder?.getPhase() ?? null;
  }
}

/** Process-lifetime singleton — used when no Context is available (CLI single-session mode). */
const sddState = new SDDState();

/**
 * Get the active SDD session context for injection into the AI conversation.
 * Returns null if no active session. Called by the REPL before agent.run().
 */
export function getActiveSDDContext(): string | null {
  return sddState.getContext();
}

/**
 * Get the active SDD session phase. Returns null if no active session.
 */
export function getActiveSDDPhase(): AISpecPhase | null {
  return sddState.getPhase();
}

/**
 * Parse a spec from AI output text and save it to the active session.
 * Returns true if a spec was found and saved.
 */
export async function trySaveSpecFromAIOutput(aiOutput: string): Promise<boolean> {
  const builder = sddState.getBuilder();
  if (!builder) return false;
  const spec = builder.tryParseSpecFromOutput(aiOutput);
  if (!spec) return false;
  builder.setSpec(spec);
  return true;
}

/**
 * Parse tasks from AI output and save them to the task graph.
 * Returns true if tasks were found and saved.
 */
export async function trySaveTasksFromAIOutput(aiOutput: string): Promise<boolean> {
  const builder = sddState.getBuilder();
  if (!builder) return false;
  const session = builder.getSession();
  if (!session.spec) return false;

  const json = builder.extractJSONArray(aiOutput);
  if (!json) return false;

  let tasks: Array<Record<string, unknown>>;
  try {
    tasks = JSON.parse(json);
  } catch {
    return false;
  }

  if (!Array.isArray(tasks) || tasks.length === 0) return false;

  // Validate each task has at least a title
  const validTasks = tasks.filter(t => t && typeof t === 'object' && typeof t.title === 'string' && t.title.length > 0);
  if (validTasks.length === 0) return false;

  // If tasks already exist, append to the existing tracker instead of replacing
  const existingTracker = sddState.getTaskTracker();
  if (existingTracker) {
    for (const task of validTasks) {
      const title = String(task.title);
      const description = String(task.description ?? '');
      const type = (['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore']
        .includes(String(task.type)) ? String(task.type) : 'feature') as 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore';
      const priority = (['critical', 'high', 'medium', 'low']
        .includes(String(task.priority)) ? String(task.priority) : 'medium') as 'critical' | 'high' | 'medium' | 'low';
      const estimateHours = Number(task.estimateHours) || 2;
      const tags = Array.isArray(task.tags) ? task.tags.map(String) : [];

      existingTracker.addNode({
        title,
        description,
        type,
        priority,
        status: 'pending',
        estimateHours,
        tags,
      });
    }
    return true;
  }

  // Create task graph from parsed tasks (first time)
  const store = new DefaultTaskStore();
  const tracker = new TaskTracker({ store });
  const graph = await tracker.createGraph(session.spec.id, session.spec.title);

  for (const task of validTasks) {
    const title = String(task.title);
    const description = String(task.description ?? '');
    const type = (['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore']
      .includes(String(task.type)) ? String(task.type) : 'feature') as 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test' | 'chore';
    const priority = (['critical', 'high', 'medium', 'low']
      .includes(String(task.priority)) ? String(task.priority) : 'medium') as 'critical' | 'high' | 'medium' | 'low';
    const estimateHours = Number(task.estimateHours) || 2;
    const tags = Array.isArray(task.tags) ? task.tags.map(String) : [];

    tracker.addNode({
      title,
      description,
      type,
      priority,
      status: 'pending',
      estimateHours,
      tags,
    });
  }

  sddState.setTaskStore(store);
  sddState.setTaskTracker(tracker);
  sddState.setTaskGraphId(graph.id);

  // Save task graph ID to session for persistence
  builder.setTaskGraphId(graph.id);

  return true;
}

/**
 * Get the current task progress. Returns null if no tasks.
 */
export function getTaskProgress(): TaskProgress | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  return tracker.getProgress();
}

/**
 * Get the currently in-progress task node, if any.
 */
export function getCurrentTask(): { id: string; title: string; description: string; priority: string; estimateHours: number; tags: string[]; startedAt: number | undefined } | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  const nodes = tracker.getAllNodes({ status: ['in_progress'] });
  if (nodes.length === 0) return null;
  const n = nodes[0]!;
  return {
    id: n.id,
    title: n.title,
    description: n.description,
    priority: n.priority,
    estimateHours: n.estimateHours ?? 0,
    tags: n.tags ?? [],
    startedAt: n.startedAt,
  };
}

/**
 * Advance the tracker to the next ready task — find all pending tasks
 * whose blockers are all completed, pick the first one, and set it to
 * in_progress. Called automatically after autoDetectTaskCompletion.
 */
export function advanceToNextTask(): boolean {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return false;
  const pending = tracker.getAllNodes({ status: ['pending'] });
  for (const n of pending) {
    if (tracker.canStart(n.id)) {
      tracker.updateNodeStatus(n.id, 'in_progress');
      return true;
    }
  }
  return false;
}

/**
 * Format elapsed milliseconds as a human-readable string.
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

/**
 * Get the current task list as text for AI context.
 */
export function getTaskListText(): string | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  const nodes = tracker.getAllNodes();
  if (nodes.length === 0) return null;

  const lines = nodes.map((n, i) => {
    const status = n.status === 'completed' ? '✅' : n.status === 'in_progress' ? '🔄' : '⏳';
    return `${i + 1}. ${status} [${n.priority}] ${n.title}`;
  });

  return lines.join('\n');
}

/**
 * Render the current task list with a progress bar for AI context.
 * Called by the REPL after auto-detection to show live progress.
 * Includes elapsed time for in_progress tasks.
 */
export function renderTaskListWithProgress(): string | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  const nodes = tracker.getAllNodes();
  if (nodes.length === 0) return null;

  const progress = tracker.getProgress();
  const phase = sddState.getPhase();
  const phaseLabel: Record<string, string> = {
    questioning: '❓ Questioning',
    spec_review: '📋 Spec Review',
    implementation: '🏗️ Implementation',
    task_review: '📝 Task Review',
    executing: '⚡ Executing',
    done: '✅ Done',
  };

  const lines = [
    `**${phaseLabel[phase ?? ''] ?? phase} — Task Status**`,
    '',
    renderProgress(progress),
    '',
  ];

  // Sort: in_progress first, then pending, others last
  const sorted = [...nodes].sort((a, b) => {
    const order: Record<string, number> = { in_progress: 0, pending: 1, review: 2, blocked: 3, failed: 4, completed: 5 };
    return (order[a.status] ?? 6) - (order[b.status] ?? 6);
  });

  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i]!;
    const status = n.status === 'completed' ? '✅' : n.status === 'in_progress' ? '🔄' : n.status === 'failed' ? '❌' : n.status === 'blocked' ? '🚫' : n.status === 'review' ? '👁' : '⏳';
    const title = n.title.length > 50 ? n.title.slice(0, 49) + '…' : n.title;
    let elapsed = '';
    if (n.status === 'in_progress' && n.startedAt) {
      elapsed = ` · ${formatElapsed(Date.now() - n.startedAt)}`;
    }
    lines.push(`${i + 1}. ${status} ${title}${elapsed}`);
  }

  return lines.join('\n');
}

/**
 * Returns a rich context snippet describing the current executing task.
 * Injected into the AI prompt every turn during executing phase so the
 * AI always knows exactly what it's working on.
 */
export function getCurrentExecutingContext(): string | null {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return null;
  const nodes = tracker.getAllNodes({ status: ['in_progress'] });
  if (nodes.length === 0) return null;
  const n = nodes[0]!;
  const elapsed = n.startedAt ? ` · elapsed: ${formatElapsed(Date.now() - n.startedAt)}` : '';
  const progress = tracker.getProgress();
  return [
    `**NOW EXECUTING:** "${n.title}"${elapsed}`,
    `Description: ${n.description.split('\n')[0] ?? '(none)'}`,
    `Priority: ${n.priority} · Est: ${n.estimateHours ?? 0}h · Tags: ${(n.tags ?? []).join(', ') || 'none'}`,
    `Progress: ${progress.completed}/${progress.total} tasks (${progress.percentComplete}%)`,
  ].join('\n');
}

/**
 * Mark a task as completed by title (fuzzy match).
 * Returns true if a task was found and marked.
 */
export function markTaskCompleted(taskTitle: string): boolean {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return false;
  const nodes = tracker.getAllNodes({ status: ['pending', 'in_progress'] });
  const match = nodes.find(n =>
    n.title.toLowerCase().includes(taskTitle.toLowerCase()) ||
    taskTitle.toLowerCase().includes(n.title.toLowerCase())
  );
  if (!match) return false;
  tracker.updateNodeStatus(match.id, 'completed');
  return true;
}

/**
 * Auto-detect task completion patterns in AI output and mark tasks.
 * Returns the number of tasks marked as completed.
 *
 * Patterns detected:
 * - "Task N: complete" / "Task N complete" / "Task N done"
 * - "✅ Task: <title>" / "✅ <title>"
 * - "/sdd done N" / "/sdd done <title>"
 * - "Completed: <title>" / "Done: <title>"
 */
export function autoDetectTaskCompletion(aiOutput: string): number {
  const tracker = sddState.getTaskTracker();
  if (!tracker) return 0;
  const pending = tracker.getAllNodes({ status: ['pending', 'in_progress'] });
  if (pending.length === 0) return 0;

  let completed = 0;
  const lines = aiOutput.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Pattern: /sdd done N or /sdd done <title>
    const sddDoneMatch = trimmed.match(/\/sdd\s+done\s+(.+)/i);
    if (sddDoneMatch?.[1]) {
      const target = sddDoneMatch[1].trim();
      const num = Number(target);
      if (!Number.isNaN(num) && num >= 1 && num <= pending.length) {
        const node = pending[num - 1];
        if (node && node.status !== 'completed') {
          tracker.updateNodeStatus(node.id, 'completed');
          completed++;
        }
      } else {
        const match = pending.find(n =>
          n.title.toLowerCase().includes(target.toLowerCase()) ||
          target.toLowerCase().includes(n.title.toLowerCase())
        );
        if (match && match.status !== 'completed') {
          tracker.updateNodeStatus(match.id, 'completed');
          completed++;
        }
      }
      continue;
    }

    // Pattern: ✅ followed by task title
    const checkmarkMatch = trimmed.match(/^✅\s*(?:Task:\s*)?(.+)/i);
    if (checkmarkMatch?.[1]) {
      const title = checkmarkMatch[1].trim();
      const match = pending.find(n =>
        n.title.toLowerCase().includes(title.toLowerCase()) ||
        title.toLowerCase().includes(n.title.toLowerCase())
      );
      if (match && match.status !== 'completed') {
        tracker.updateNodeStatus(match.id, 'completed');
        completed++;
      }
      continue;
    }

    // Pattern: Task N: complete/done/finished
    const taskNumMatch = trimmed.match(/Task\s+(\d+)\s*[:]\s*(?:complete|done|finished)/i);
    if (taskNumMatch?.[1]) {
      const num = Number(taskNumMatch[1]);
      if (num >= 1 && num <= pending.length) {
        const node = pending[num - 1];
        if (node && node.status !== 'completed') {
          tracker.updateNodeStatus(node.id, 'completed');
          completed++;
        }
      }
      continue;
    }

    // Pattern: Completed: <title> or Done: <title>
    const completedMatch = trimmed.match(/^(?:Completed|Done|Finished)\s*[:]\s*(.+)/i);
    if (completedMatch?.[1]) {
      const title = completedMatch[1].trim();
      const match = pending.find(n =>
        n.title.toLowerCase().includes(title.toLowerCase()) ||
        title.toLowerCase().includes(n.title.toLowerCase())
      );
      if (match && match.status !== 'completed') {
        tracker.updateNodeStatus(match.id, 'completed');
        completed++;
      }
    }
  }

  return completed;
}

/**
 * Try to save implementation plan from AI output during implementation phase.
 * Extracts the text before the JSON task array as the implementation plan.
 * Returns true if a plan was saved.
 * Only saves if the content differs from the current plan to avoid
 * overwriting a real plan with conversational AI output mid-implementation.
 */
export function trySaveImplementationPlan(aiOutput: string): boolean {
  const builder = sddState.getBuilder();
  if (!builder) return false;
  const session = builder.getSession();
  if (session.phase !== 'implementation') return false;

  const current = session.implementation ?? '';

  // Try to find the JSON array and extract text before it
  const jsonMatch = aiOutput.match(/```json\s*\[/);
  if (jsonMatch?.index && jsonMatch.index > 0) {
    const plan = aiOutput.substring(0, jsonMatch.index).trim();
    // Skip if it looks like conversational/explanatory output
    if (
      plan.length > 50 &&
      plan !== current &&
      !isExplanatoryText(plan)
    ) {
      builder.setImplementation(plan);
      return true;
    }
  }

  // If no JSON found, save only if it's substantive and different
  if (aiOutput.length > 100 && !aiOutput.includes('```json') && aiOutput !== current && !isExplanatoryText(aiOutput)) {
    builder.setImplementation(aiOutput.trim());
    return true;
  }

  return false;
}

/**
 * Returns true if the text looks like conversational/explanatory output
 * rather than a structured implementation plan.
 */
function isExplanatoryText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.startsWith("i'") ||
    lower.startsWith("i will") ||
    lower.startsWith("let me") ||
    lower.startsWith("here's my") ||
    lower.startsWith("here is my") ||
    lower.startsWith("i'm going to") ||
    lower.startsWith("first, let me") ||
    lower.startsWith("sure") ||
    lower.startsWith("of course") ||
    lower.startsWith("okay") ||
    lower.startsWith("ok,") ||
    lower.startsWith("sounds good") ||
    lower.startsWith("no problem") ||
    // Skip if mostly code-like with minimal prose
    (text.split('\n').length < 3 && !text.includes('.'))
  );
}

/**
 * Get the active builder instance (for advanced integration).
 */
export function getActiveBuilder(): AISpecBuilder | null {
  return sddState.getBuilder();
}

/**
 * `/sdd` — AI-driven Specification-Driven Development workflow.
 *
 * Workflow:
 *   /sdd new [title]       — Start AI-driven spec session (AI asks questions)
 *   /sdd approve           — Approve current phase (spec → impl → tasks → done)
 *   /sdd execute           — Execute generated tasks
 *   /sdd cancel            — Cancel current session
 *   /sdd status            — Show current session status
 *
 * Also:
 *   /sdd list              — List saved specs
 *   /sdd show <id>         — Show a spec
 *   /sdd templates         — List available templates
 */
export function buildSddCommand(opts: SlashCommandContext): SlashCommand {
  // All state accesses in this command go through sessionState so that
  // concurrent REPL/browser sessions are fully isolated.
  const sessionState = getSessionState(opts.context);

  return {
    name: 'sdd',
    description:
      'AI-driven SDD: /sdd [new|approve|execute|cancel|status|list|show|templates]',
    async run(args) {
      const ctx = opts.context;
      const projectRoot = ctx?.projectRoot ?? process.cwd();
      const specsDir = path.join(projectRoot, '.wrongstack', 'specs');
      const graphsDir = path.join(projectRoot, '.wrongstack', 'task-graphs');

      const specStore = new SpecStore({ baseDir: specsDir });
      const graphStore = new TaskGraphStore({ baseDir: graphsDir });
      const versioning = sddState.getVersioning();

      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();

      switch (verb) {
        case '':
        case 'help':
          return { message: sddHelp() };

        // ── AI-Driven Spec Session ─────────────────────────────────────────

        case 'new':
        case 'create': {
          const forceFlag = rest.includes('--force') || rest.includes('-f');
          const title = rest.filter(a => !a.startsWith('-')).join(' ').trim() || 'Untitled Feature';

          // Check for existing session and offer to resume (unless --force)
          if (!sessionState.getBuilder() && !forceFlag) {
            const sessionPath = path.join(projectRoot, '.wrongstack', 'sdd-session.json');
            try {
              await fsp.access(sessionPath);
              // Session file exists — try to load it
              const projectContext = await gatherProjectContext(projectRoot);
              const tempBuilder = new AISpecBuilder({
                store: specStore,
                projectContext,
                sessionPath,
              });
              const loaded = await tempBuilder.loadSession();
              if (loaded) {
                const existing = tempBuilder.getSession();
                if (existing.phase !== 'done') {
                  return {
                    message: [
                      `An existing SDD session was found:`,
                      `  Feature: "${existing.title}"`,
                      `  Phase: ${existing.phase}`,
                      `  Questions: ${existing.questionCount}`,
                      '',
                      'Use /sdd resume to continue, or /sdd new --force to start fresh.',
                    ].join('\n'),
                  };
                }
              }
            } catch {
              // No existing session — continue
            }
          }

          // Reset task state from previous session
          sddState.clearTaskState();

          // Gather project context for smarter AI questions
          const projectContext = await gatherProjectContext(projectRoot);

          sddState.setBuilder(new AISpecBuilder({
            store: specStore,
            projectContext,
            minQuestions: 2,
            maxQuestions: 10,
            sessionPath: path.join(projectRoot, '.wrongstack', 'sdd-session.json'),
          }));
          // Reset session and phase timers for the new session
          sddState.setSessionStartTime(Date.now());
          sddState.setPhaseStartTime(Date.now());
          const builder = sddState.getBuilder()!;
          builder.startSession(title);

          const aiPrompt = builder.getAIPrompt();

          return {
            message: [
              `╔═══ SDD: AI Spec Builder ═══╗`,
              '',
              `Feature: "${title}"`,
              '',
              'The AI will now ask you contextual questions.',
              'Answer naturally — it will generate the spec when ready.',
              '',
              'Commands: /sdd approve · /sdd status · /sdd cancel',
            ].join('\n'),
            runText: `[SDD SESSION ACTIVE]\n${aiPrompt}\n\n---\nUser message:\nStart the specification interview for "${title}". Ask your first contextual question.`,
          };
        }

        // ── Phase Transitions ──────────────────────────────────────────────

        case 'approve':
        case 'ok':
        case 'confirm': {
          const builder = sddState.getBuilder();
          if (!builder) {
            return {
              message: 'No active SDD session. Use /sdd new to start one.',
            };
          }

          const phase = builder.getSession().phase;

          if (phase === 'questioning') {
            // AI hasn't generated spec yet — tell it to generate now
            const sddCtx = builder.getAIPrompt();
            return {
              message: 'No spec generated yet. Generating now...',
              runText: `[SDD SESSION ACTIVE]\n${sddCtx}\n\n---\nUser message:\nGenerate the complete specification now based on the conversation so far.`,
            };
          }

          if (phase === 'spec_review') {
            const spec = builder.getSession().spec;
            if (!spec) {
              return { message: 'No spec to approve.' };
            }

            // Save spec and move to implementation phase
            await builder.saveSpec();
            versioning.recordVersion(spec, 'Initial spec approved');
            builder.approve(); // spec_review → implementation
            sddState.setPhaseStartTime(Date.now()); // reset phase timer

            const implPrompt = builder.getAIPrompt();
            return {
              message: [
                `✅ Spec "${spec.title}" approved and saved!`,
                `ID: ${spec.id}`,
                `Requirements: ${spec.requirements.length}`,
                '',
                'The AI will now generate an implementation plan and tasks.',
              ].join('\n'),
              runText: `[SDD SESSION ACTIVE]\n${implPrompt}\n\n---\nUser message:\nGenerate the implementation plan and tasks for the approved spec.`,
            };
          }

          if (phase === 'task_review') {
            builder.approve(); // task_review → executing
            sddState.setPhaseStartTime(Date.now()); // reset phase timer

            // Auto-start the first ready task when entering executing phase
            advanceToNextTask();

            const execPrompt = builder.getAIPrompt();
            return {
              message: '✅ Tasks approved! The AI will now execute them one by one.',
              runText: `[SDD SESSION ACTIVE]\n${execPrompt}\n\n---\nUser message:\nStart executing the tasks one by one.`,
            };
          }

          if (phase === 'implementation') {
            const session = builder.getSession();
            const plan = session.implementation;
            if (!plan) {
              return {
                message: 'No implementation plan yet. The AI is still generating it. Try again shortly.',
              };
            }
            return {
              message: [
                `╭─── Implementation Plan ───────────────────────────────╮`,
                '',
                ...plan.split('\n').map(l => `  ${l}`),
                '',
                `╰${'─'.repeat(55)}╯`,
              ].join('\n'),
            };
          }

          return {
            message: `Current phase is "${phase}". Use /sdd status to see details.`,
          };
        }

        // ── Task Execution ─────────────────────────────────────────────────

        case 'execute':
        case 'run': {
          const runBuilder = sddState.getBuilder();
          if (!runBuilder) {
            return {
              message: 'No active SDD session. Use /sdd new to start one.',
            };
          }

          const session = runBuilder.getSession();
          if (session.phase !== 'executing' && session.phase !== 'task_review') {
            return {
              message: `Cannot execute in phase "${session.phase}". Use /sdd approve first.`,
            };
          }

          const execPrompt = runBuilder.getAIPrompt();
          return {
            message: '⚡ Starting task execution. The AI will execute tasks one by one.',
            runText: `[SDD SESSION ACTIVE]\n${execPrompt}\n\n---\nUser message:\nStart executing the tasks one by one.`,
          };
        }

        case 'plan':
        case 'impl': {
          const planBuilder = sddState.getBuilder();
          if (!planBuilder) {
            return { message: 'No active SDD session. Use /sdd new to start one.' };
          }

          const planSession = planBuilder.getSession();
          if (!planSession.implementation) {
            return {
              message: planSession.phase === 'implementation'
                ? 'No implementation plan yet. The AI will generate it after /sdd approve.'
                : 'No implementation plan in this session.',
            };
          }

          return {
            message: [
              '═══ Implementation Plan ═══',
              '',
              planSession.implementation,
            ].join('\n'),
          };
        }

        case 'spec': {
          const specBuilder = sddState.getBuilder();
          if (!specBuilder) {
            return { message: 'No active SDD session. Use /sdd new to start one.' };
          }

          const specSession = specBuilder.getSession();
          if (!specSession.spec) {
            return {
              message: specSession.phase === 'questioning'
                ? 'No spec generated yet. Keep answering the AI\'s questions.'
                : 'No spec in this session.',
            };
          }

          const spec = specSession.spec;
          const lines = [
            `═══ Current Spec ═══`,
            '',
            `Title: ${spec.title}`,
            `Version: ${spec.version}`,
            `Status: ${spec.status}`,
            '',
            '## Overview',
            spec.overview,
          ];

          if (spec.requirements.length > 0) {
            lines.push('', `## Requirements (${spec.requirements.length})`);
            for (const r of spec.requirements) {
              const ac = r.acceptanceCriteria.length > 0 ? ` → ${r.acceptanceCriteria.join(', ')}` : '';
              lines.push(`  [${r.priority}] ${r.description}${ac}`);
            }
          }

          return { message: lines.join('\n') };
        }

        case 'tasks':
        case 'task': {
          const taskTracker = sddState.getTaskTracker();
          if (!taskTracker) {
            return { message: 'No tasks generated yet. Use /sdd new to start.' };
          }

          const nodes = taskTracker.getAllNodes();
          if (nodes.length === 0) {
            return { message: 'No tasks in the current graph.' };
          }

          const progress = taskTracker.getProgress();
          const builder = sddState.getBuilder();
          const phase = builder?.getPhase() ?? 'unknown';
          const phaseLabel: Record<string, string> = {
            questioning: '❓ Questioning',
            spec_review: '📋 Spec Review',
            implementation: '🏗️ Implementation',
            task_review: '📝 Task Review',
            executing: '⚡ Executing',
            done: '✅ Done',
          };

          const lines = [
            `╭─── ${phaseLabel[phase] ?? phase} ───────────────────────────╮`,
            '',
            renderProgress(progress),
            '',
            `  #    Status  Priority  Task`,
            `  ${'─'.repeat(49)}`,
          ];

          // Sort: in_progress first, then pending, then others
          const sorted = [...nodes].sort((a, b) => {
            const order: Record<string, number> = { in_progress: 0, pending: 1, review: 2, blocked: 3, failed: 4, completed: 5 };
            return (order[a.status] ?? 6) - (order[b.status] ?? 6);
          });

          for (let i = 0; i < sorted.length; i++) {
            const n = sorted[i]!;
            const status = n.status === 'completed' ? '✅' : n.status === 'in_progress' ? '🔄' : n.status === 'failed' ? '❌' : n.status === 'blocked' ? '🚫' : n.status === 'review' ? '👁' : '⏳';
            const num = `${i + 1}`.padStart(3);
            const prio = n.priority.slice(0, 4).padEnd(5);
            const title = n.title.length > 36 ? n.title.slice(0, 35) + '…' : n.title;
            const elapsed = n.status === 'in_progress' && n.startedAt ? ` (${formatElapsed(Date.now() - n.startedAt)})` : '';
            lines.push(`  ${num}  ${status}     ${prio}   ${title}${elapsed}`);
            if (n.description && n.status !== 'completed') {
              const first = n.description.split('\n')[0]!;
              const truncated = first.length > 42 ? first.slice(0, 41) + '…' : first;
              lines.push(`        ↳ ${truncated}`);
            }
          }

          lines.push('');
          lines.push(`  Commands: /sdd done <N> · /sdd skip <N> · /sdd fail <N> · /sdd review <N>`);
          lines.push(`             /sdd next · /sdd status · /sdd edit <N> · /sdd approve`);
          lines.push(`╰${'─'.repeat(54)}╯`);

          return { message: lines.join('\n') };
        }

        case 'done':
        case 'complete': {
          const doneTracker = sddState.getTaskTracker();
          if (!doneTracker) {
            return { message: 'No tasks to complete.' };
          }

          if (!restJoined) {
            return { message: 'Usage: /sdd done <task title or number>' };
          }

          // Try to match by number first
          const nodes = doneTracker.getAllNodes({ status: ['pending', 'in_progress'] });
          const num = Number(restJoined);
          let matched = false;

          if (!Number.isNaN(num) && num >= 1 && num <= nodes.length) {
            const node = nodes[num - 1];
            if (node) {
              doneTracker.updateNodeStatus(node.id, 'completed');
              matched = true;
            }
          }

          // Try fuzzy title match
          if (!matched) {
            const match = nodes.find(n =>
              n.title.toLowerCase().includes(restJoined.toLowerCase()) ||
              restJoined.toLowerCase().includes(n.title.toLowerCase())
            );
            if (match) {
              doneTracker.updateNodeStatus(match.id, 'completed');
              matched = true;
            }
          }

          if (!matched) {
            return { message: `No pending task matching "${restJoined}".` };
          }

          const remaining = doneTracker.getProgress();
          return {
            message: `✅ Task marked done! (${remaining.completed}/${remaining.total} — ${remaining.percentComplete}%)`,
          };
        }

        case 'skip': {
          const skipTracker = sddState.getTaskTracker();
          if (!skipTracker) return { message: 'No tasks to skip.' };
          if (!restJoined) return { message: 'Usage: /sdd skip <task title or number>' };

          const nodes = skipTracker.getAllNodes({ status: ['pending', 'in_progress', 'blocked'] });
          const num = Number(restJoined);
          let matched = false;

          if (!Number.isNaN(num) && num >= 1 && num <= nodes.length) {
            const node = nodes[num - 1];
            if (node) {
              skipTracker.updateNodeStatus(node.id, 'pending');
              matched = true;
            }
          }
          if (!matched) {
            const match = nodes.find(n =>
              n.title.toLowerCase().includes(restJoined.toLowerCase()) ||
              restJoined.toLowerCase().includes(n.title.toLowerCase())
            );
            if (match) {
              skipTracker.updateNodeStatus(match.id, 'pending');
              matched = true;
            }
          }

          if (!matched) return { message: `No task matching "${restJoined}".` };

          const progress = skipTracker.getProgress();
          return {
            message: `⏭ Task skipped — moved to pending. (${progress.completed}/${progress.total} — ${progress.percentComplete}%)`,
          };
        }

        case 'fail': {
          const failTracker = sddState.getTaskTracker();
          if (!failTracker) return { message: 'No tasks to fail.' };
          if (!restJoined) return { message: 'Usage: /sdd fail <task title or number>' };

          const nodes = failTracker.getAllNodes({ status: ['pending', 'in_progress'] });
          const num = Number(restJoined);
          let matched = false;

          if (!Number.isNaN(num) && num >= 1 && num <= nodes.length) {
            const node = nodes[num - 1];
            if (node) {
              failTracker.updateNodeStatus(node.id, 'failed');
              matched = true;
            }
          }
          if (!matched) {
            const match = nodes.find(n =>
              n.title.toLowerCase().includes(restJoined.toLowerCase()) ||
              restJoined.toLowerCase().includes(n.title.toLowerCase())
            );
            if (match) {
              failTracker.updateNodeStatus(match.id, 'failed');
              matched = true;
            }
          }

          if (!matched) return { message: `No pending/in-progress task matching "${restJoined}".` };

          const progress = failTracker.getProgress();
          return {
            message: `❌ Task marked as failed. (${progress.failed} failed · ${progress.completed}/${progress.total} done)`,
          };
        }

        case 'review': {
          const reviewTracker = sddState.getTaskTracker();
          if (!reviewTracker) return { message: 'No tasks to review.' };
          if (!restJoined) return { message: 'Usage: /sdd review <task title or number>' };

          const nodes = reviewTracker.getAllNodes();
          const num = Number(restJoined);
          let matched = false;

          // Match by number (within sorted visible list)
          const sorted = [...nodes].sort((a, b) => {
            const order: Record<string, number> = { in_progress: 0, pending: 1, review: 2, blocked: 3, failed: 4, completed: 5 };
            return (order[a.status] ?? 6) - (order[b.status] ?? 6);
          });

          if (!Number.isNaN(num) && num >= 1 && num <= sorted.length) {
            const node = sorted[num - 1];
            if (node) {
              reviewTracker.updateNodeStatus(node.id, 'review');
              matched = true;
            }
          }
          if (!matched) {
            const match = nodes.find(n =>
              n.title.toLowerCase().includes(restJoined.toLowerCase()) ||
              restJoined.toLowerCase().includes(n.title.toLowerCase())
            );
            if (match) {
              reviewTracker.updateNodeStatus(match.id, 'review');
              matched = true;
            }
          }

          if (!matched) return { message: `No task matching "${restJoined}".` };

          const progress = reviewTracker.getProgress();
          return {
            message: `👁 Task sent to review. (${progress.review} in review)`,
          };
        }

        case 'edit': {
          const editTracker = sddState.getTaskTracker();
          if (!editTracker) return { message: 'No tasks to edit.' };
          if (!restJoined) return { message: 'Usage: /sdd edit <N> <new title or description>' };

          // Parse: /sdd edit <N> <new content>
          const parts = restJoined.split(/\s+/);
          const num = Number(parts[0]);
          if (Number.isNaN(num)) return { message: 'Usage: /sdd edit <N> <new title or description>' };

          const nodes = editTracker.getAllNodes();
          if (num < 1 || num > nodes.length) return { message: `Task #${num} not found.` };

          const node = nodes[num - 1];
          if (!node) return { message: `Task #${num} not found.` };

          const newContent = parts.slice(1).join(' ');
          if (!newContent) return { message: 'Provide new title or description content.' };

          // Update title if content looks like a title (short) or description if longer
          if (newContent.length < 60) {
            editTracker.updateNode(node.id, { title: newContent });
          } else {
            editTracker.updateNode(node.id, { description: newContent });
          }

          return { message: `✏️ Task #${num} updated: "${newContent.slice(0, 50)}${newContent.length > 50 ? '…' : ''}"` };
        }

        case 'undo': {
          const undoTracker = sddState.getTaskTracker();
          if (!undoTracker) {
            return { message: 'No tasks to undo.' };
          }
          // Find the most recently completed task from transitions
          const completed = undoTracker.getAllNodes({ status: ['completed'] });
          if (completed.length === 0) {
            return { message: 'No completed tasks to undo.' };
          }
          // Pop the last completed node (most recently completed)
          const last = completed[completed.length - 1]!;
          undoTracker.updateNodeStatus(last.id, 'pending');
          const progress = undoTracker.getProgress();
          return {
            message: `↩ Undo: "${last.title}" back to pending. (${progress.completed}/${progress.total} — ${progress.percentComplete}%)`,
          };
        }

        // ── Next Task Preview ─────────────────────────────────────────────

        case 'next': {
          const nextTracker = sddState.getTaskTracker();
          if (!nextTracker) {
            return { message: 'No tasks generated yet. Use /sdd new to start.' };
          }

          const pending = nextTracker.getAllNodes({ status: ['pending', 'in_progress'] });
          if (pending.length === 0) {
            const allDone = nextTracker.getProgress();
            if (allDone.completed === allDone.total) {
              return { message: '🎉 All tasks completed! Run /sdd status for the full summary.' };
            }
            return { message: 'No pending tasks.' };
          }

          // Find the next executable task (pending with all blockers completed)
          const next = pending.find(n => nextTracker.canStart(n.id));
          if (!next) {
            // All pending tasks are blocked
            const blocked = pending.filter(n => {
              const blockers = nextTracker.getBlockers(n.id);
              return blockers.some(id => nextTracker.getNode(id)?.status !== 'completed');
            });
            if (blocked.length > 0) {
              return {
                message: [
                  `🚫 ${blocked.length} task(s) blocked — waiting on dependencies:`,
                  ...blocked.map((b, i) => {
                    const blockers = nextTracker.getBlockers(b.id);
                    const blockerNames = blockers
                      .map(id => nextTracker.getNode(id)?.title ?? '?')
                      .join(', ');
                    return `  ${i + 1}. ${b.title} (blocked by: ${blockerNames})`;
                  }),
                ].join('\n'),
              };
            }
            return { message: 'No next task found.' };
          }

          const progress = nextTracker.getProgress();
          const blockers = nextTracker.getBlockers(next.id);
          const blockedBy = blockers
            .filter(id => nextTracker.getNode(id)?.status !== 'completed')
            .map(id => nextTracker.getNode(id)?.title ?? '?')
            .join(', ');

          const lines = [
            `╭─── NEXT TASK ───────────────────────────────────────────╮`,
            '',
            `  🔄 ${next.title}`,
          ];

          if (next.description) {
            const first = next.description.split('\n')[0]!;
            lines.push(`     ↳ ${first}`);
          }

          const taskElapsed = next.startedAt ? ` ⏱ ${formatElapsed(Date.now() - next.startedAt)}` : '';
          lines.push(`  Priority: ${next.priority}  |  Est: ${next.estimateHours}h  |  Tags: ${(next.tags ?? []).join(', ') || 'none'}${taskElapsed}`);

          if (blockedBy) {
            lines.push(`  Blocked by: ${blockedBy}`);
          }

          lines.push('');
          lines.push(`  ── Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%) ──`);
          lines.push('');
          lines.push(`  Run /sdd done <task title or number> when done.`);
          lines.push(`╰${'─'.repeat(55)}╯`);

          return { message: lines.join('\n') };
        }

        // ── Session Management ─────────────────────────────────────────────

        case 'status': {
          const statusBuilder = sddState.getBuilder();
          if (!statusBuilder) {
            return { message: 'No active SDD session.' };
          }

          const session = statusBuilder.getSession();
          const phaseEmoji: Record<AISpecPhase, string> = {
            questioning: '❓',
            spec_review: '📋',
            implementation: '🏗️',
            task_review: '📝',
            executing: '⚡',
            done: '✅',
          };
          const phaseLabel: Record<AISpecPhase, string> = {
            questioning: 'Questioning',
            spec_review: 'Spec Review',
            implementation: 'Implementation',
            task_review: 'Task Review',
            executing: 'Executing',
            done: 'Done',
          };

          const progress = getTaskProgress();
          const sessionElapsed = sddState.getSessionElapsed();
          const phaseElapsed = sddState.getPhaseElapsed();
          const lines = [
            `╭─── SDD: ${session.title} ────────────────────────────────╮`,
            '',
            `  ${phaseEmoji[session.phase]} Phase: ${phaseLabel[session.phase]}  ⏱ ${formatElapsed(phaseElapsed)}`,
            `  ⏱ Session: ${formatElapsed(sessionElapsed)}  |  ❝ Questions: ${session.questionCount}`,
          ];

          if (session.spec) {
            lines.push('');
            lines.push(`  📋 Spec: ${session.spec.title}`);
            lines.push(`     ${session.spec.requirements.length} requirements`);
            // Show requirements as compact list
            const reqs = session.spec.requirements.slice(0, 4);
            for (const r of reqs) {
              lines.push(`     • [${r.priority}] ${r.description.length > 42 ? r.description.slice(0, 41) + '…' : r.description}`);
            }
            if (session.spec.requirements.length > 4) {
              lines.push(`     + ${session.spec.requirements.length - 4} more requirements`);
            }
          }

          if (progress && progress.total > 0) {
            lines.push('');
            lines.push(renderProgress(progress));
            lines.push(`  Task breakdown:`);
            if (progress.inProgress > 0) lines.push(`    🔄 ${progress.inProgress} in progress`);
            if (progress.pending > 0) lines.push(`    ⏳ ${progress.pending} pending`);
            if (progress.blocked > 0) lines.push(`    🚫 ${progress.blocked} blocked`);
            if (progress.failed > 0) lines.push(`    ❌ ${progress.failed} failed`);
            if (progress.review > 0) lines.push(`    👁 ${progress.review} in review`);

            // Show next 3 pending tasks
            const tracker = sddState.getTaskTracker();
            if (tracker) {
              const pending = tracker.getAllNodes({ status: ['pending', 'in_progress'] });
              const nextTasks = pending
                .filter(n => n.status === 'pending' && tracker.canStart(n.id))
                .slice(0, 3);
              if (nextTasks.length > 0) {
                lines.push('');
                lines.push(`  Up next:`);
                nextTasks.forEach((t, i) => {
                  lines.push(`    ${i + 1}. ${t.title}`);
                });
              }
            }

            lines.push('');
            lines.push(`  Commands: /sdd tasks · /sdd next · /sdd approve · /sdd cancel`);
          } else {
            lines.push('');
            lines.push(`  Commands: /sdd plan · /sdd approve · /sdd cancel`);
          }

          lines.push(`╰${'─'.repeat(56)}╯`);
          lines.push('');
          lines.push(`  Session ID: ${session.id.slice(0, 8)}…`);

          return {
            message: lines.join('\n'),
          };
        }

        // ── Task Graph Visualization ──────────────────────────────────────

        case 'graph': {
          const graphTracker = sddState.getTaskTracker();
          if (!graphTracker) {
            return { message: 'No tasks generated yet. Use /sdd new to start.' };
          }

          const graphId = sddState.getTaskGraphId();
          if (!graphId) {
            // Show basic list view
            const nodes = graphTracker.getAllNodes();
            if (nodes.length === 0) {
              return { message: 'No tasks in the current graph.' };
            }
            const progress = graphTracker.getProgress();
            const lines = [renderProgress(progress), ''];
            const sorted = [...nodes].sort((a, b) => {
              const order: Record<string, number> = { in_progress: 0, pending: 1, review: 2, blocked: 3, failed: 4, completed: 5 };
              return (order[a.status] ?? 6) - (order[b.status] ?? 6);
            });
            for (let i = 0; i < sorted.length; i++) {
              const n = sorted[i]!;
              const status = n.status === 'completed' ? '✅' : n.status === 'in_progress' ? '🔄' : n.status === 'failed' ? '❌' : n.status === 'blocked' ? '🚫' : n.status === 'review' ? '👁' : '⏳';
              lines.push(`${i + 1}. ${status} [${n.priority}] ${n.title}`);
            }
            return { message: lines.join('\n') };
          }

          // Try to load from store
          try {
            const graphStore = new TaskGraphStore({ baseDir: path.join(projectRoot, '.wrongstack', 'task-graphs') });
            const stored = await graphStore.load(graphId);
            if (stored) {
              return { message: renderTaskGraph(stored, { compact: false }) };
            }
          } catch {
            // fall through to basic view
          }

          // Basic fallback
          const nodes = graphTracker.getAllNodes();
          if (nodes.length === 0) {
            return { message: 'No tasks in the current graph.' };
          }
          const progress = graphTracker.getProgress();
          const lines = [renderProgress(progress), ''];
          const sorted = [...nodes].sort((a, b) => {
            const order: Record<string, number> = { in_progress: 0, pending: 1, review: 2, blocked: 3, failed: 4, completed: 5 };
            return (order[a.status] ?? 6) - (order[b.status] ?? 6);
          });
          for (let i = 0; i < sorted.length; i++) {
            const n = sorted[i]!;
            const status = n.status === 'completed' ? '✅' : n.status === 'in_progress' ? '🔄' : n.status === 'failed' ? '❌' : n.status === 'blocked' ? '🚫' : n.status === 'review' ? '👁' : '⏳';
            lines.push(`${i + 1}. ${status} [${n.priority}] ${n.title}`);
          }
          return { message: lines.join('\n') };
        }

        case 'cancel': {
          // Always try to delete the session file and store dirs from disk
          const sessionPath = path.join(projectRoot, '.wrongstack', 'sdd-session.json');
          let deletedFromDisk = false;
          try {
            await fsp.unlink(sessionPath);
            deletedFromDisk = true;
          } catch {
            // No file on disk
          }
          try {
            await fsp.rm(path.join(projectRoot, '.wrongstack', 'specs'), { recursive: true, force: true });
          } catch {
            // No specs dir
          }
          try {
            await fsp.rm(path.join(projectRoot, '.wrongstack', 'task-graphs'), { recursive: true, force: true });
          } catch {
            // No task-graphs dir
          }

          const cancelBuilder = sddState.getBuilder();
          if (cancelBuilder) {
            const title = cancelBuilder.getSession().title;
            await cancelBuilder.deleteSession();
            sddState.setBuilder(null);
            sddState.clearTaskState();
            return { message: `SDD session for "${title}" cancelled.` };
          }

          if (deletedFromDisk) {
            return { message: 'Stale SDD session file deleted. You can now use /sdd new.' };
          }

          return { message: 'No active SDD session.' };
        }

        case 'resume': {
          if (sddState.getBuilder()) {
            return { message: 'An SDD session is already active. Use /sdd cancel first.' };
          }

          const sessionPath = path.join(projectRoot, '.wrongstack', 'sdd-session.json');
          const projectContext = await gatherProjectContext(projectRoot);

          sddState.setBuilder(new AISpecBuilder({
            store: specStore,
            projectContext,
            minQuestions: 2,
            maxQuestions: 10,
            sessionPath,
          }));
          const resumeBuilder = sddState.getBuilder()!;
          const loaded = await resumeBuilder.loadSession();
          if (!loaded) {
            sddState.setBuilder(null);
            return { message: 'No saved SDD session found. Use /sdd new to start one.' };
          }

          const session = resumeBuilder.getSession();

          // Restore task graph if it exists
          let taskCount = 0;
          let completedCount = 0;
          const taskGraphId = resumeBuilder.getTaskGraphId();
          if (taskGraphId) {
            try {
              const store = new DefaultTaskStore();
              const tracker = new TaskTracker({ store });
              const graph = await tracker.loadGraph(taskGraphId);
              if (graph) {
                sddState.setTaskStore(store);
                sddState.setTaskTracker(tracker);
                sddState.setTaskGraphId(taskGraphId);
                const progress = tracker.getProgress();
                taskCount = progress.total;
                completedCount = progress.completed;
              }
            } catch {
              // Task graph not found — continue without it
            }
          }

          const resumePrompt = resumeBuilder.getAIPrompt();
          return {
            message: [
              `╔═══ SDD Session Resumed ═══╗`,
              '',
              `Feature: "${session.title}"`,
              `Phase: ${session.phase}`,
              `Questions asked: ${session.questionCount}`,
              session.spec ? `Spec: ${session.spec.title}` : '',
              taskCount > 0 ? `Tasks: ${completedCount}/${taskCount} completed` : '',
              '',
              'The AI will continue from where you left off.',
            ].filter(Boolean).join('\n'),
            runText: `[SDD SESSION ACTIVE]\n${resumePrompt}\n\n---\nUser message:\nContinue from where we left off. Check the session status and proceed.`,
          };
        }

        // ── Spec Browsing ──────────────────────────────────────────────────

        case 'list':
        case 'ls': {
          const entries = await specStore.list();
          if (entries.length === 0) {
            return { message: 'No specs saved. Use /sdd new to create one.' };
          }

          const lines = entries.map((e: SpecIndexEntry, i: number) => {
            const status =
              e.status === 'draft'
                ? '📝'
                : e.status === 'approved'
                  ? '✅'
                  : '📋';
            return `${i + 1}. ${status} ${e.title} (${e.version}) — ${e.id.slice(0, 8)}...`;
          });

          return { message: `Saved Specs:\n${lines.join('\n')}` };
        }

        case 'show':
        case 'view': {
          const spec = await findSpec(specStore, restJoined);
          if (!spec) return { message: `Spec "${restJoined}" not found.` };

          const parser = new SpecParser();
          const analysis = parser.analyze(spec);

          return {
            message: [
              `# ${spec.title}`,
              `Version: ${spec.version} | Status: ${spec.status}`,
              '',
              '## Overview',
              spec.overview,
              '',
              `## Requirements (${spec.requirements.length})`,
              ...spec.requirements.map((r: SpecRequirement) => {
                const tags = `[${r.type}][${r.priority}]`;
                const ac =
                  r.acceptanceCriteria.length > 0
                    ? `\n    AC: ${r.acceptanceCriteria.join(', ')}`
                    : '';
                return `- ${tags} ${r.description}${ac}`;
              }),
              '',
              renderSpecAnalysis(spec, {
                completeness: analysis.completeness,
                gaps: analysis.gaps,
                risks: analysis.risks.map((r) => r.risk),
                suggestions: analysis.suggestions,
              }),
            ].join('\n'),
          };
        }

        case 'templates': {
          const templates = listTemplates();
          const lines = templates.map(
            (t: { id: string; name: string; description: string }) =>
              `  ${t.id}: ${t.name} — ${t.description}`,
          );
          return {
            message: `Available Templates:\n${lines.join('\n')}`,
          };
        }

        case 'from': {
          const templateId = restJoined || 'feature';
          const template = getTemplate(templateId);
          if (!template) {
            return {
              message: `Template "${templateId}" not found.\nAvailable: ${listTemplates().map((t: { id: string }) => t.id).join(', ')}`,
            };
          }

          const skeleton = templateToMarkdown(template, 'New Specification');
          const spec = await specStore.createDraft('New Specification');
          await specStore.update(spec.id, { sections: [] });

          return {
            message: [
              `Created draft spec from template "${template.name}".`,
              `ID: ${spec.id}`,
              '',
              'Edit the spec through the AI conversation or /sdd show to review.',
              '',
              skeleton,
            ].join('\n'),
          };
        }

        case 'version':
        case 'history': {
          const spec = await findSpec(specStore, restJoined);
          if (!spec)
            return { message: `Spec "${restJoined}" not found.` };

          const history = versioning.getHistory(spec.id);
          if (history.length === 0) {
            return {
              message: `No version history for "${spec.title}".`,
            };
          }

          const lines = history.map(
            (v: SpecVersion, i: number) =>
              `${i + 1}. v${v.version} — ${new Date(v.timestamp).toISOString()}${v.changeDescription ? ` (${v.changeDescription})` : ''}`,
          );
          return {
            message: `Version History for "${spec.title}":\n${lines.join('\n')}`,
          };
        }

        case 'critical':
        case 'bottleneck': {
          const critTracker = sddState.getTaskTracker();
          if (!critTracker) {
            return { message: 'No tasks generated yet. Use /sdd new to start.' };
          }

          const graphId = sddState.getTaskGraphId();
          if (!graphId) {
            return { message: 'No task graph found. Generate tasks first.' };
          }

          try {
            const graphStore = new TaskGraphStore({ baseDir: path.join(projectRoot, '.wrongstack', 'task-graphs') });
            const graph = await graphStore.load(graphId);
            if (!graph) {
              return { message: 'Could not load task graph.' };
            }

            const analysis = analyzeCriticalPath(graph);
            const lines = [
              `╭─── Critical Path Analysis ───────────────────────────────╮`,
              '',
              `  Critical path length: ${analysis.criticalPath.length} tasks`,
              `  Estimated total time: ${analysis.totalHours}h`,
              '',
            ];

            if (analysis.criticalPath.length > 0) {
              lines.push(`  🔴 Critical path:`);
              analysis.criticalPath.forEach((taskId, i) => {
                const node = graph.nodes.get(taskId);
                if (node) {
                  lines.push(`    ${i + 1}. ${node.title} [${node.priority}] — ${node.estimateHours}h`);
                }
              });
            }

            if (analysis.bottlenecks.length > 0) {
              lines.push('');
              lines.push(`  🚫 Bottlenecks (blocking most downstream):`);
              analysis.bottlenecks.forEach((bt) => {
                const node = graph.nodes.get(bt.taskId);
                if (node) {
                  lines.push(`    • ${node.title} (blocks ${bt.blockedCount} task(s))`);
                }
              });
            }

            if (analysis.parallelGroups.length > 0) {
              lines.push('');
              lines.push(`  ⚡ Parallel groups (can run concurrently):`);
              analysis.parallelGroups.forEach((group, i) => {
                const names = group.map(id => graph.nodes.get(id)?.title ?? '?').join(' | ');
                lines.push(`    Group ${i + 1}: ${names}`);
              });
            }

            if (analysis.readyTasks.length > 0) {
              lines.push('');
              lines.push(`  ✅ Ready to start now:`);
              analysis.readyTasks.forEach((taskId) => {
                const node = graph.nodes.get(taskId);
                if (node) {
                  lines.push(`    • ${node.title}`);
                }
              });
            }

            lines.push(`╰${'─'.repeat(55)}╯`);
            return { message: lines.join('\n') };
          } catch {
            return { message: 'Could not analyze critical path.' };
          }
        }

        default:
          return {
            message: `Unknown command "${verb}".\n\n${sddHelp()}`,
          };
      }
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sddHelp(): string {
  return [
    '',
    '╔══════════════════════════════════════════════════════════════╗',
    '║          🚀 SDD — AI-Driven Spec Builder                    ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    '  ┌─ 🆕 Start ──────────────────────────────────────────────┐',
    '  │  /sdd new [title]    Start a new spec session            │',
    '  │  /sdd new --force    Start fresh (skip resume check)     │',
    '  │  /sdd resume         Resume a saved session              │',
    '  └──────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 🔄 Flow ───────────────────────────────────────────────┐',
    '  │  /sdd approve        Approve current phase               │',
    '  │  /sdd spec           Show current session\'s spec         │',
    '  │  /sdd plan           Show implementation plan            │',
    '  │  /sdd execute        Execute generated tasks             │',
    '  └────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ ⏸ Goal Lifecycle ─────────────────────────────────────┐',
    '  │  /sdd goal            Show current goal + journal         │',
    '  │  /sdd goal set <text> Set autonomous mission             │',
    '  │  /sdd goal pause      Pause at end of current iteration  │',
    '  │  /sdd goal resume     Resume a paused goal               │',
    '  │  /sdd goal journal [N] Show recent journal entries       │',
    '  │  /sdd goal clear      Clear goal + stop eternal mode    │',
    '  └─────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 📡 Eternal Stage ──────────────────────────────────────┐',
    '  │  decide → execute → reflect → sleep | paused | stopped  │',
    '  │  Stage shown in real-time during /sdd goal mode         │',
    '  └─────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 🔧 Task Lifecycle ────────────────────────────────────┐',
    '  │  /sdd tasks          Show task list + progress bar      │',
    '  │  /sdd next           Show next executable task          │',
    '  │  /sdd done <N>       Complete a task                   │',
    '  │  /sdd skip <N>        Skip a task (back to pending)       │',
    '  │  /sdd fail <N>        Mark task as failed               │',
    '  │  /sdd review <N>      Send task to review              │',
    '  │  /sdd edit <N> <txt>  Edit task title or description   │',
    '  │  /sdd undo           Undo last completion              │',
    '  └─────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 📊 Session Info ──────────────────────────────────────┐',
    '  │  /sdd status         Full session status + tasks preview │',
    '  │  /sdd cancel         Cancel session                      │',
    '  └─────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 📁 Spec History ─────────────────────────────────────┐',
    '  │  /sdd list           List saved specs                    │',
    '  │  /sdd show <id>      Show spec details                   │',
    '  │  /sdd templates      List available templates            │',
    '  │  /sdd from <tmpl>    Create from template                │',
    '  │  /sdd version <id>   Show version history                │',
    '  └─────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 💡 Quick Start ───────────────────────────────────────┐',
    '  │                                                         │',
    '  │  1. /sdd new Auth System                                │',
    '  │     → AI starts asking questions                        │',
    '  │                                                         │',
    '  │  2. Just type your answers naturally                    │',
    '  │     → AI continues the interview                        │',
    '  │                                                         │',
    '  │  3. AI generates spec (auto-detected)                   │',
    '  │     → /sdd approve                                    │',
    '  │                                                         │',
    '  │  3. AI generates implementation + tasks                 │',
    '  │     → /sdd approve                                    │',
    '  │                                                         │',
    '  │  4. AI executes tasks one by one                        │',
    '  │     → /sdd tasks (view progress)                       │',
    '  │     → /sdd done 1 (mark task complete)                  │',
    '  │                                                         │',
    '  └─────────────────────────────────────────────────────────┘',
    '',
    '  Tip: tasks are shown with progress bar after each AI turn.',
    '',
  ].join('\n');
}

/**
 * Gather project context to help the AI ask smarter questions.
 * Reads package.json, file structure, and other indicators.
 */
async function gatherProjectContext(projectRoot: string): Promise<string> {
  const parts: string[] = [];

  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    const pkgRaw = await fsp.readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    parts.push(`Project: ${String(pkg.name ?? 'unknown')}`);
    parts.push(`Description: ${String(pkg.description ?? 'none')}`);
    if (pkg.dependencies) {
      const deps = Object.keys(pkg.dependencies as Record<string, unknown>);
      parts.push(`Dependencies: ${deps.slice(0, 20).join(', ')}${deps.length > 20 ? '...' : ''}`);
    }
    if (pkg.devDependencies) {
      const devDeps = Object.keys(pkg.devDependencies as Record<string, unknown>);
      parts.push(`Dev Dependencies: ${devDeps.slice(0, 15).join(', ')}${devDeps.length > 15 ? '...' : ''}`);
    }
  } catch {
    // no package.json — skip
  }

  try {
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    await fsp.access(tsconfigPath);
    parts.push('Language: TypeScript');
  } catch {
    // no tsconfig
  }

  try {
    const srcDir = path.join(projectRoot, 'src');
    const entries = await fsp.readdir(srcDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (dirs.length > 0) {
      parts.push(`Source structure: src/${dirs.join(', src/')}`);
    }
  } catch {
    // no src dir
  }

  return parts.join('\n');
}

async function findSpec(store: SpecStore, idOrTitle: string) {
  if (!idOrTitle) return null;
  const byId = await store.load(idOrTitle);
  if (byId) return byId;
  const all = await store.list();
  const match = all.find(
    (e: SpecIndexEntry) =>
      e.id.startsWith(idOrTitle) ||
      e.title.toLowerCase().includes(idOrTitle.toLowerCase()),
  );
  if (match) return store.load(match.id);
  return null;
}

async function findGraph(store: TaskGraphStore, idOrTitle: string) {
  if (!idOrTitle) {
    const all = await store.list();
    if (all.length === 0) return null;
    const first = all[0];
    return first ? store.load(first.id) : null;
  }
  const byId = await store.load(idOrTitle);
  if (byId) return byId;
  const all = await store.list();
  const match = all.find(
    (e: TaskGraphIndexEntry) =>
      e.id.startsWith(idOrTitle) ||
      e.title.toLowerCase().includes(idOrTitle.toLowerCase()),
  );
  if (match) return store.load(match.id);
  return null;
}
