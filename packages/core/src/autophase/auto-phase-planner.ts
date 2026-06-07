/**
 * AutoPhasePlanner - converts a goal into phases using a real LLM call,
 * producing a large task list with todos under each phase.
 *
 * Similar to SDD's spec-to-task flow, but different: the output is directly
 * `PhaseTemplate[]`; each phase carries `taskTemplates`, so
 * `PhaseGraphBuilder` produces a populated `PhaseGraph` and `PhaseOrchestrator`
 * runs each task through a real agent execution.
 *
 * The planner is not tied to a specific LLM: callers provide a `runOnce(prompt)` function
 * (a subagent run in the CLI, or a deterministic stub in tests).
 */

import type { TaskPriority, TaskType } from '../types/task-graph.js';
import type { PhaseNode, PhaseTemplate } from './types.js';

/** Single todo template, the element type of PhaseTemplate.taskTemplates. */
type PhaseTaskTemplate = NonNullable<PhaseTemplate['taskTemplates']>[number];

export interface AutoPhasePlannerOptions {
  /**
   * One-shot LLM call: receives a prompt and returns the model text output.
   * In the CLI this wraps subagent.run; in tests it can be a deterministic stub.
   */
  runOnce: (prompt: string) => Promise<string>;
  /** Goal or project title. */
  goal: string;
  /** Optional project context such as package.json or directory structure. */
  projectContext?: string | undefined;
  /** Requested minimum phase count. Defaults to 3. */
  minPhases?: number | undefined;
  /** Requested maximum phase count. Defaults to 8. */
  maxPhases?: number | undefined;
  /** Target todo count per phase. Defaults to 6. */
  todosPerPhase?: number | undefined;
}

export interface AutoPhasePlanResult {
  /** Phase templates passed to PhaseGraphBuilder. */
  phases: PhaseTemplate[];
  /** Raw model output for debugging and logs. */
  raw: string;
  /** True when JSON could not be parsed; `phases` is empty in that case. */
  parseFailed: boolean;
}

const VALID_TASK_TYPES: ReadonlySet<TaskType> = new Set([
  'feature',
  'bugfix',
  'refactor',
  'docs',
  'test',
  'chore',
]);
const VALID_PRIORITIES: ReadonlySet<TaskPriority> = new Set([
  'critical',
  'high',
  'medium',
  'low',
]);

/**
 * AutoPhasePlanner drives the model through `plan()` and produces `PhaseTemplate[]`.
 */
export class AutoPhasePlanner {
  constructor(private readonly opts: AutoPhasePlannerOptions) {}

  /** Convert the goal into a phase-and-todo plan. */
  async plan(): Promise<AutoPhasePlanResult> {
    const prompt = this.buildPrompt();
    const raw = await this.opts.runOnce(prompt);
    const phases = this.parse(raw);
    return { phases, raw, parseFailed: phases.length === 0 };
  }

  /** Instruction prompt for the plan the model should produce. */
  buildPrompt(): string {
    const minP = this.opts.minPhases ?? 3;
    const maxP = this.opts.maxPhases ?? 8;
    const todos = this.opts.todosPerPhase ?? 6;
    const ctx = this.opts.projectContext?.trim();

    return [
      'You are an expert software project planner. Break the following goal into',
      `a dependency-ordered list of ${minP}–${maxP} PHASES. Each phase must contain`,
      `roughly ${todos} concrete, individually-actionable TODO tasks.`,
      '',
      `GOAL: ${this.opts.goal}`,
      ctx ? `\nPROJECT CONTEXT:\n${ctx}\n` : '',
      'Rules:',
      '- Phases run in order; earlier phases are prerequisites for later ones.',
      '- Each todo must be small enough for one focused work session.',
      '- Each todo must be self-contained (an agent will execute it in isolation).',
      '- Prefer concrete verbs ("Add X", "Refactor Y", "Write tests for Z").',
      '',
      'Respond with ONLY a JSON array inside a ```json code fence. No prose before',
      'or after. Schema (TypeScript):',
      '',
      '```json',
      '[',
      '  {',
      '    "name": "Phase name",',
      '    "description": "What this phase accomplishes",',
      '    "priority": "critical" | "high" | "medium" | "low",',
      '    "estimateHours": number,',
      '    "parallelizable": boolean,',
      '    "tasks": [',
      '      {',
      '        "title": "Short task title",',
      '        "description": "What to do and how to know it is done",',
      '        "type": "feature" | "bugfix" | "refactor" | "docs" | "test" | "chore",',
      '        "priority": "critical" | "high" | "medium" | "low",',
      '        "estimateHours": number,',
      '        "tags": ["optional", "labels"]',
      '      }',
      '    ]',
      '  }',
      ']',
      '```',
    ]
      .filter((l) => l !== '')
      .join('\n');
  }

  /** Extract JSON from raw output, validate it, and convert it to PhaseTemplate[]. */
  parse(raw: string): PhaseTemplate[] {
    const json = extractJSONArray(raw);
    if (!json) return [];

    let data: unknown;
    try {
      data = JSON.parse(json);
    } catch {
      // best-effort: invalid JSON yields empty phase list
      return [];
    }
    if (!Array.isArray(data)) return [];

    const phases: PhaseTemplate[] = [];
    for (const entry of data) {
      const phase = this.coercePhase(entry);
      if (phase) phases.push(phase);
    }
    return phases;
  }

  private coercePhase(entry: unknown): PhaseTemplate | null {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.trim() : '';
    if (!name) return null;

    const rawTasks = Array.isArray(e.tasks)
      ? e.tasks
      : Array.isArray(e.taskTemplates)
        ? e.taskTemplates
        : [];

    const taskTemplates = rawTasks
      .map((t) => this.coerceTask(t))
      .filter((t): t is PhaseTaskTemplate => t !== null);

    return {
      name,
      description: typeof e.description === 'string' ? e.description : '',
      priority: coercePriority(e.priority) as PhaseNode['priority'],
      estimateHours: coerceHours(e.estimateHours, 4),
      parallelizable: e.parallelizable === true,
      taskTemplates,
    };
  }

  private coerceTask(t: unknown): PhaseTaskTemplate | null {
    if (!t || typeof t !== 'object') return null;
    const o = t as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!title) return null;

    const type: TaskType = VALID_TASK_TYPES.has(o.type as TaskType)
      ? (o.type as TaskType)
      : 'feature';

    return {
      title,
      description: typeof o.description === 'string' ? o.description : '',
      type,
      priority: coercePriority(o.priority),
      estimateHours: coerceHours(o.estimateHours, 2),
      tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function coercePriority(value: unknown): TaskPriority {
  return VALID_PRIORITIES.has(value as TaskPriority) ? (value as TaskPriority) : 'medium';
}

function coerceHours(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Extract the first JSON array from text. Tries, in order:
 *  1. The first [ ... ] inside a ```json ... ``` or bare ``` code block
 *  2. The first balanced [ ... ] block in the text, aware of strings and escapes
 */
export function extractJSONArray(text: string): string | null {
  // 1) Fenced code block
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fence?.[1]) candidates.push(fence[1]);
  candidates.push(text);

  for (const candidate of candidates) {
    const balanced = firstBalancedArray(candidate);
    if (balanced) return balanced;
  }
  return null;
}

/** Return the first balanced `[ ... ]` block, aware of strings and escapes. */
function firstBalancedArray(text: string): string | null {
  const start = text.indexOf('[');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
