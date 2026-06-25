// makeLlmSubtaskGenerator — the LLM auto-split backing for the SDD supervisor.
//
// When the supervisor's brain returns a `split` verdict for a retry-exhausted
// task, it calls `generateSubtasks(task, error)` to decompose the failing task
// into smaller pieces. This helper produces that closure from a single `run`
// callback (one isolated LLM turn → text), so core stays free of agent-spawning
// coupling: each surface supplies the runner via its own subagent factory (the
// same isolated-turn pattern as the interview driver).
//
// Safety: the result is heavily validated and bounded. A leaf can only be split
// into ≥2 well-formed sub-tasks; anything else (parse failure, 0/1 items, junk)
// returns [] and the supervisor degrades the split into a bounded retry. The
// per-task `maxSupervisorEscalations` guard already caps how often this runs, so
// recursive splitting can't run away.

import type { TaskNode, TaskPriority, TaskType } from '../types/task-graph.js';
import type { SddSubtaskSpec } from './sdd-parallel-run.js';

const TASK_TYPES = new Set<TaskType>(['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore']);
const PRIORITIES = new Set<TaskPriority>(['critical', 'high', 'medium', 'low']);

export interface SubtaskGeneratorOptions {
  /** Runs one self-contained, isolated LLM turn and resolves its final text. */
  run: (prompt: string) => Promise<string>;
  /** Minimum well-formed sub-tasks required to accept a split. Default 2. */
  minSubtasks?: number;
  /** Maximum sub-tasks kept (excess is dropped). Default 4. */
  maxSubtasks?: number;
}

/** Extract a JSON array from model output (```json fence or first bare `[...]`). */
function extractJsonArray(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fence?.[1]) return fence[1].trim();
  const bare = text.match(/(\[[\s\S]*\])/);
  if (bare?.[1]) {
    try {
      if (Array.isArray(JSON.parse(bare[1]))) return bare[1];
    } catch {
      // not valid JSON — fall through
    }
  }
  return null;
}

function buildPrompt(task: TaskNode, error: string, min: number, max: number): string {
  return [
    'You are an engineering lead triaging a software task that FAILED after every',
    'automated retry was exhausted. Break it into smaller, independently-executable',
    `sub-tasks (between ${min} and ${max}) so separate workers can each tackle a`,
    'narrower slice. Each sub-task must be strictly smaller than the parent — never',
    'restate the whole task as one sub-task.',
    '',
    `Parent task title: ${task.title}`,
    `Parent description: ${task.description}`,
    `Failure / error: ${error || '(none recorded)'}`,
    '',
    'Respond with ONLY a JSON array (no prose) of objects with this shape:',
    '[{"title": "...", "description": "...", "type": "feature|bugfix|refactor|docs|test|chore", "priority": "critical|high|medium|low"}]',
    '`type` and `priority` are optional (they default to the parent\'s).',
  ].join('\n');
}

/**
 * Build a `SddSupervisorOptions.generateSubtasks` closure backed by an LLM turn.
 * Returns [] on any failure (parse error, too few valid items, runner throw), so
 * the supervisor safely degrades a `split` verdict into a retry.
 */
export function makeLlmSubtaskGenerator(opts: SubtaskGeneratorOptions) {
  const min = Math.max(2, opts.minSubtasks ?? 2);
  const max = Math.max(min, opts.maxSubtasks ?? 4);

  return async function generateSubtasks(info: {
    task: TaskNode;
    error: string;
  }): Promise<SddSubtaskSpec[]> {
    let text: string;
    try {
      text = await opts.run(buildPrompt(info.task, info.error, min, max));
    } catch {
      return [];
    }

    const json = extractJsonArray(text ?? '');
    if (!json) return [];

    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];

    const specs: SddSubtaskSpec[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const title = typeof r['title'] === 'string' ? r['title'].trim() : '';
      const description = typeof r['description'] === 'string' ? r['description'].trim() : '';
      if (!title || !description) continue;
      const type = TASK_TYPES.has(r['type'] as TaskType) ? (r['type'] as TaskType) : undefined;
      const priority = PRIORITIES.has(r['priority'] as TaskPriority)
        ? (r['priority'] as TaskPriority)
        : undefined;
      specs.push({ title, description, type, priority });
      if (specs.length >= max) break;
    }

    // A split must yield at least `min` genuinely smaller pieces — otherwise it's
    // not a decomposition and we let the supervisor retry instead.
    return specs.length >= min ? specs : [];
  };
}
