import * as path from 'node:path';
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
} from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

/** Active AI spec builder session held in memory. */
let activeBuilder: AISpecBuilder | null = null;

/** Active task graph and tracker for the current SDD session. */
let activeTaskStore: DefaultTaskStore | null = null;
let activeTaskTracker: TaskTracker | null = null;
let activeTaskGraphId: string | null = null;

/**
 * Get the active SDD session context for injection into the AI conversation.
 * Returns null if no active session. Called by the REPL before agent.run().
 */
export function getActiveSDDContext(): string | null {
  if (!activeBuilder) return null;
  const session = activeBuilder.getSession();
  if (session.phase === 'done') return null;

  return activeBuilder.getAIPrompt();
}

/**
 * Get the active SDD session phase. Returns null if no active session.
 */
export function getActiveSDDPhase(): AISpecPhase | null {
  if (!activeBuilder) return null;
  return activeBuilder.getPhase();
}

/**
 * Parse a spec from AI output text and save it to the active session.
 * Returns true if a spec was found and saved.
 */
export async function trySaveSpecFromAIOutput(aiOutput: string): Promise<boolean> {
  if (!activeBuilder) return false;
  const spec = activeBuilder.tryParseSpecFromOutput(aiOutput);
  if (!spec) return false;
  activeBuilder.setSpec(spec);
  return true;
}

/**
 * Parse tasks from AI output and save them to the task graph.
 * Returns true if tasks were found and saved.
 */
export async function trySaveTasksFromAIOutput(aiOutput: string): Promise<boolean> {
  if (!activeBuilder) return false;
  const session = activeBuilder.getSession();
  if (!session.spec) return false;

  const json = activeBuilder.extractJSONArray(aiOutput);
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

  // Create task graph from parsed tasks
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

  activeTaskStore = store;
  activeTaskTracker = tracker;
  activeTaskGraphId = graph.id;

  // Save task graph ID to session for persistence
  activeBuilder.setTaskGraphId(graph.id);

  return true;
}

/**
 * Get the current task progress. Returns null if no tasks.
 */
export function getTaskProgress(): { total: number; completed: number; pending: number; percent: number } | null {
  if (!activeTaskTracker) return null;
  const progress = activeTaskTracker.getProgress();
  return {
    total: progress.total,
    completed: progress.completed,
    pending: progress.pending,
    percent: progress.percentComplete,
  };
}

/**
 * Get the current task list as text for AI context.
 */
export function getTaskListText(): string | null {
  if (!activeTaskTracker) return null;
  const nodes = activeTaskTracker.getAllNodes();
  if (nodes.length === 0) return null;

  const lines = nodes.map((n, i) => {
    const status = n.status === 'completed' ? '✅' : n.status === 'in_progress' ? '🔄' : '⏳';
    return `${i + 1}. ${status} [${n.priority}] ${n.title}`;
  });

  return lines.join('\n');
}

/**
 * Mark a task as completed by title (fuzzy match).
 * Returns true if a task was found and marked.
 */
export function markTaskCompleted(taskTitle: string): boolean {
  if (!activeTaskTracker) return false;
  const nodes = activeTaskTracker.getAllNodes({ status: ['pending', 'in_progress'] });
  const match = nodes.find(n =>
    n.title.toLowerCase().includes(taskTitle.toLowerCase()) ||
    taskTitle.toLowerCase().includes(n.title.toLowerCase())
  );
  if (!match) return false;
  activeTaskTracker.updateNodeStatus(match.id, 'completed');
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
  if (!activeTaskTracker) return 0;
  const pending = activeTaskTracker.getAllNodes({ status: ['pending', 'in_progress'] });
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
          activeTaskTracker!.updateNodeStatus(node.id, 'completed');
          completed++;
        }
      } else {
        const match = pending.find(n =>
          n.title.toLowerCase().includes(target.toLowerCase()) ||
          target.toLowerCase().includes(n.title.toLowerCase())
        );
        if (match && match.status !== 'completed') {
          activeTaskTracker!.updateNodeStatus(match.id, 'completed');
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
        activeTaskTracker!.updateNodeStatus(match.id, 'completed');
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
          activeTaskTracker!.updateNodeStatus(node.id, 'completed');
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
        activeTaskTracker!.updateNodeStatus(match.id, 'completed');
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
 */
export function trySaveImplementationPlan(aiOutput: string): boolean {
  if (!activeBuilder) return false;
  const session = activeBuilder.getSession();
  if (session.phase !== 'implementation') return false;

  // Try to find the JSON array and extract text before it
  const jsonMatch = aiOutput.match(/```json\s*\[/);
  if (jsonMatch?.index && jsonMatch.index > 0) {
    const plan = aiOutput.substring(0, jsonMatch.index).trim();
    if (plan.length > 50) { // Must be substantial
      activeBuilder.setImplementation(plan);
      return true;
    }
  }

  // If no JSON found, save the whole output as the plan
  if (aiOutput.length > 100 && !aiOutput.includes('```json')) {
    activeBuilder.setImplementation(aiOutput.trim());
    return true;
  }

  return false;
}

/**
 * Get the active builder instance (for advanced integration).
 */
export function getActiveBuilder(): AISpecBuilder | null {
  return activeBuilder;
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
      const versioning = new SpecVersioning();

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
          if (!activeBuilder && !forceFlag) {
            const sessionPath = path.join(projectRoot, '.wrongstack', 'sdd-session.json');
            try {
              const fsp = await import('node:fs/promises');
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
          activeTaskStore = null;
          activeTaskTracker = null;
          activeTaskGraphId = null;

          // Gather project context for smarter AI questions
          const projectContext = await gatherProjectContext(projectRoot);

          activeBuilder = new AISpecBuilder({
            store: specStore,
            projectContext,
            minQuestions: 2,
            maxQuestions: 10,
            sessionPath: path.join(projectRoot, '.wrongstack', 'sdd-session.json'),
          });
          activeBuilder.startSession(title);

          const aiPrompt = activeBuilder.getAIPrompt();

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
          if (!activeBuilder) {
            return {
              message: 'No active SDD session. Use /sdd new to start one.',
            };
          }

          const phase = activeBuilder.getSession().phase;

          if (phase === 'questioning') {
            // AI hasn't generated spec yet — tell it to generate now
            const sddCtx = activeBuilder.getAIPrompt();
            return {
              message: 'No spec generated yet. Generating now...',
              runText: `[SDD SESSION ACTIVE]\n${sddCtx}\n\n---\nUser message:\nGenerate the complete specification now based on the conversation so far.`,
            };
          }

          if (phase === 'spec_review') {
            const spec = activeBuilder.getSession().spec;
            if (!spec) {
              return { message: 'No spec to approve.' };
            }

            // Save spec and move to implementation phase
            await activeBuilder.saveSpec();
            versioning.recordVersion(spec, 'Initial spec approved');
            activeBuilder.approve(); // spec_review → implementation

            const implPrompt = activeBuilder.getAIPrompt();
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
            activeBuilder.approve(); // task_review → executing

            const execPrompt = activeBuilder.getAIPrompt();
            return {
              message: '✅ Tasks approved! The AI will now execute them one by one.',
              runText: `[SDD SESSION ACTIVE]\n${execPrompt}\n\n---\nUser message:\nStart executing the tasks one by one.`,
            };
          }

          return {
            message: `Current phase is "${phase}". Use /sdd status to see details.`,
          };
        }

        // ── Task Execution ─────────────────────────────────────────────────

        case 'execute':
        case 'run': {
          if (!activeBuilder) {
            return {
              message: 'No active SDD session. Use /sdd new to start one.',
            };
          }

          const session = activeBuilder.getSession();
          if (session.phase !== 'executing' && session.phase !== 'task_review') {
            return {
              message: `Cannot execute in phase "${session.phase}". Use /sdd approve first.`,
            };
          }

          const execPrompt = activeBuilder.getAIPrompt();
          return {
            message: '⚡ Starting task execution. The AI will execute tasks one by one.',
            runText: `[SDD SESSION ACTIVE]\n${execPrompt}\n\n---\nUser message:\nStart executing the tasks one by one.`,
          };
        }

        case 'plan':
        case 'impl': {
          if (!activeBuilder) {
            return { message: 'No active SDD session. Use /sdd new to start one.' };
          }

          const session = activeBuilder.getSession();
          if (!session.implementation) {
            return {
              message: session.phase === 'implementation'
                ? 'No implementation plan yet. The AI will generate it after /sdd approve.'
                : 'No implementation plan in this session.',
            };
          }

          return {
            message: [
              '═══ Implementation Plan ═══',
              '',
              session.implementation,
            ].join('\n'),
          };
        }

        case 'spec': {
          if (!activeBuilder) {
            return { message: 'No active SDD session. Use /sdd new to start one.' };
          }

          const session = activeBuilder.getSession();
          if (!session.spec) {
            return {
              message: session.phase === 'questioning'
                ? 'No spec generated yet. Keep answering the AI\'s questions.'
                : 'No spec in this session.',
            };
          }

          const spec = session.spec;
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
          if (!activeTaskTracker) {
            return { message: 'No tasks generated yet. Use /sdd new to start.' };
          }

          const nodes = activeTaskTracker.getAllNodes();
          if (nodes.length === 0) {
            return { message: 'No tasks in the current graph.' };
          }

          const progress = activeTaskTracker.getProgress();
          const lines = [
            `═══ Task List (${progress.completed}/${progress.total} done) ═══`,
            '',
          ];

          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i]!;
            const status = n.status === 'completed' ? '✅' : n.status === 'in_progress' ? '🔄' : n.status === 'failed' ? '❌' : '⏳';
            lines.push(`${i + 1}. ${status} [${n.priority}] ${n.title}`);
            if (n.description) {
              lines.push(`   ${n.description.split('\n')[0]}`);
            }
          }

          return { message: lines.join('\n') };
        }

        case 'done':
        case 'complete': {
          if (!activeTaskTracker) {
            return { message: 'No tasks to complete.' };
          }

          if (!restJoined) {
            return { message: 'Usage: /sdd done <task title or number>' };
          }

          // Try to match by number first
          const nodes = activeTaskTracker.getAllNodes({ status: ['pending', 'in_progress'] });
          const num = Number(restJoined);
          let matched = false;

          if (!Number.isNaN(num) && num >= 1 && num <= nodes.length) {
            const node = nodes[num - 1];
            if (node) {
              activeTaskTracker.updateNodeStatus(node.id, 'completed');
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
              activeTaskTracker.updateNodeStatus(match.id, 'completed');
              matched = true;
            }
          }

          if (!matched) {
            return { message: `No pending task matching "${restJoined}".` };
          }

          const remaining = activeTaskTracker.getProgress();
          return {
            message: `✅ Task completed! ${remaining.completed}/${remaining.total} done (${remaining.percentComplete}%)`,
          };
        }

        // ── Session Management ─────────────────────────────────────────────

        case 'status': {
          if (!activeBuilder) {
            return { message: 'No active SDD session.' };
          }

          const session = activeBuilder.getSession();
          const phaseEmoji: Record<AISpecPhase, string> = {
            questioning: '❓',
            spec_review: '📋',
            implementation: '🏗️',
            task_review: '📝',
            executing: '⚡',
            done: '✅',
          };

          const progress = getTaskProgress();
          const lines = [
            '═══ SDD Session Status ═══',
            '',
            `Feature: "${session.title}"`,
            `Phase: ${phaseEmoji[session.phase]} ${session.phase}`,
            `Questions asked: ${session.questionCount}`,
          ];

          if (session.spec) {
            lines.push(`Spec: ${session.spec.title} (${session.spec.requirements.length} requirements)`);
            lines.push(`  Requirements: ${session.spec.requirements.map(r => r.description).join(', ')}`);
          }

          if (session.implementation) {
            const planPreview = session.implementation.split('\n').slice(0, 3).join(' ');
            lines.push(`Implementation: ${planPreview}${session.implementation.length > 100 ? '...' : ''}`);
          }

          if (progress && progress.total > 0) {
            lines.push(`Tasks: ${progress.completed}/${progress.total} (${progress.percent}%)`);
          }

          lines.push('', `Session ID: ${session.id}`);
          lines.push('Commands: /sdd plan · /sdd tasks · /sdd approve · /sdd cancel');

          return {
            message: lines.join('\n'),
          };
        }

        case 'cancel': {
          // Always try to delete the session file from disk
          const sessionPath = path.join(projectRoot, '.wrongstack', 'sdd-session.json');
          let deletedFromDisk = false;
          try {
            const fsp = await import('node:fs/promises');
            await fsp.unlink(sessionPath);
            deletedFromDisk = true;
          } catch {
            // No file on disk
          }

          if (activeBuilder) {
            const title = activeBuilder.getSession().title;
            await activeBuilder.deleteSession();
            activeBuilder = null;
            activeTaskStore = null;
            activeTaskTracker = null;
            activeTaskGraphId = null;
            return { message: `SDD session for "${title}" cancelled.` };
          }

          if (deletedFromDisk) {
            return { message: 'Stale SDD session file deleted. You can now use /sdd new.' };
          }

          return { message: 'No active SDD session.' };
        }

        case 'resume': {
          if (activeBuilder) {
            return { message: 'An SDD session is already active. Use /sdd cancel first.' };
          }

          const sessionPath = path.join(projectRoot, '.wrongstack', 'sdd-session.json');
          const projectContext = await gatherProjectContext(projectRoot);

          activeBuilder = new AISpecBuilder({
            store: specStore,
            projectContext,
            minQuestions: 2,
            maxQuestions: 10,
            sessionPath,
          });

          const loaded = await activeBuilder.loadSession();
          if (!loaded) {
            activeBuilder = null;
            return { message: 'No saved SDD session found. Use /sdd new to start one.' };
          }

          const session = activeBuilder.getSession();

          // Restore task graph if it exists
          let taskCount = 0;
          let completedCount = 0;
          const taskGraphId = activeBuilder.getTaskGraphId();
          if (taskGraphId) {
            try {
              const store = new DefaultTaskStore();
              const tracker = new TaskTracker({ store });
              const graph = await tracker.loadGraph(taskGraphId);
              if (graph) {
                activeTaskStore = store;
                activeTaskTracker = tracker;
                activeTaskGraphId = taskGraphId;
                const progress = tracker.getProgress();
                taskCount = progress.total;
                completedCount = progress.completed;
              }
            } catch {
              // Task graph not found — continue without it
            }
          }

          const resumePrompt = activeBuilder.getAIPrompt();
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
    '  └──────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 📋 Task Management ────────────────────────────────────┐',
    '  │  /sdd tasks          Show current task list              │',
    '  │  /sdd done <N>       Mark task complete (by # or name)   │',
    '  └──────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 📊 Info ───────────────────────────────────────────────┐',
    '  │  /sdd status         Show session status                 │',
    '  │  /sdd cancel         Cancel session                      │',
    '  └──────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 📁 Spec History ───────────────────────────────────────┐',
    '  │  /sdd list           List saved specs                    │',
    '  │  /sdd show <id>      Show spec details                   │',
    '  │  /sdd templates      List available templates            │',
    '  │  /sdd from <tmpl>    Create from template                │',
    '  │  /sdd version <id>   Show version history                │',
    '  └──────────────────────────────────────────────────────────┘',
    '',
    '  ┌─ 💡 Quick Start ────────────────────────────────────────┐',
    '  │                                                          │',
    '  │  1. /sdd new Auth System                                 │',
    '  │     → AI starts asking questions                         │',
    '  │                                                          │',
    '  │  2. Just type your answers naturally                     │',
    '  │     → AI continues the interview                         │',
    '  │                                                          │',
    '  │  3. AI generates spec (auto-detected)                    │',
    '  │     → /sdd approve                                       │',
    '  │                                                          │',
    '  │  3. AI generates implementation + tasks                  │',
    '  │     → /sdd approve                                       │',
    '  │                                                          │',
    '  │  4. AI executes tasks one by one                         │',
    '  │     → /sdd tasks (view progress)                         │',
    '  │     → /sdd done 1 (manual completion)                    │',
    '  │                                                          │',
    '  └──────────────────────────────────────────────────────────┘',
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
    const fsp = await import('node:fs/promises');
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
    const fsp = await import('node:fs/promises');
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    await fsp.access(tsconfigPath);
    parts.push('Language: TypeScript');
  } catch {
    // no tsconfig
  }

  try {
    const fsp = await import('node:fs/promises');
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
