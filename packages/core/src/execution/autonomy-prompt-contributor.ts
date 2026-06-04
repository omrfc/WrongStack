/**
 * System-prompt contributor that surfaces eternal-autonomy state to the
 * model on every turn.
 *
 * Why this exists: when the engine drives a long-running loop, the
 * per-iteration directive carries the rules. But the directive is a USER
 * message — it scrolls out of working memory after a few compactions and
 * the model forgets it's in autonomy mode (forgets `[GOAL_COMPLETE]`,
 * forgets the todo-state protocol, forgets the no-confirmation rule).
 * Injecting the same anchor as a CACHED system-prompt block solves that
 * — the rules sit next to the identity layer and survive compactions.
 *
 * Block is tagged `ephemeral` so its content (journal tail, iteration
 * counter) changes each turn without invalidating the upstream prefix
 * cache.
 */

import type { TextBlock } from '../types/blocks.js';
import type { SystemPromptContributor } from '../types/system-prompt-contributor.js';
import { loadGoal } from '../storage/goal-store.js';

export interface AutonomyPromptContributorOptions {
  /** Absolute path to the project's `goal.json`. */
  goalPath: string;
  /**
   * Gating function. The contributor consults this on every build and
   * returns an empty array when `false` — without this, the block would
   * leak into interactive runs that happen to have a goal on disk and
   * teach the model loop-control markers it shouldn't emit.
   *
   * Typical wiring: enable while `eternal` or `eternal-parallel` autonomy is active.
   */
  enabled: () => boolean;
  /** Number of journal entries to include in the recent-tail block. Default 5. */
  journalTailSize?: number;
}

/**
 * Build a contributor that renders the autonomy-state system block.
 * Returns `[]` when disabled, no goal exists, or the goal has been
 * completed/abandoned — all silent fast-paths.
 */
export function makeAutonomyPromptContributor(
  opts: AutonomyPromptContributorOptions,
): SystemPromptContributor {
  return async (ctx): Promise<TextBlock[]> => {
    // Subagents run a single scoped task and don't drive the engine's
    // outer loop — they have no business emitting `[GOAL_COMPLETE]` or
    // marking todos. Skip the block entirely for subagent prompt builds,
    // mirroring how the active-plan layer is suppressed.
    if (ctx.subagent) return [];
    if (!opts.enabled()) return [];

    let goal: Awaited<ReturnType<typeof loadGoal>>;
    try {
      goal = await loadGoal(opts.goalPath);
    } catch {
      return [];
    }
    if (!goal) return [];

    // `active` is the default for legacy goal files without the field.
    const missionState = goal.goalState ?? 'active';
    if (missionState !== 'active') return [];

    const tailSize = opts.journalTailSize ?? 5;
    const journalTail = goal.journal.slice(-tailSize).map((e) => {
      const note = e.note ? ` — ${e.note.slice(0, 80)}` : '';
      return `  #${e.iteration} [${e.status}] ${e.task}${note}`;
    });

    const text = [
      '## ETERNAL AUTONOMY — active mission',
      '',
      'You are inside a long-running autonomous loop. The user is asleep',
      'and is not available to confirm decisions. Each turn you receive a',
      'directive describing one concrete sub-task that advances the mission.',
      '',
      `Mission: ${goal.goal}`,
      `Iteration: #${goal.iterations}`,
      journalTail.length > 0
        ? `Recent journal (last ${journalTail.length}):\n${journalTail.join('\n')}`
        : 'Recent journal: (none — this is the first iteration)',
      '',
      '### Loop control markers',
      'Emit these on their own line in your final text — case-insensitive,',
      'whitespace-tolerant, but they must occupy the entire line:',
      '- `[continue]` — chain to the next internal step without returning.',
      '- `[done]` — the current sub-task is finished; return to the engine.',
      '- `[GOAL_COMPLETE]` — emit ONLY when the OVERALL mission is',
      '  verifiably done. Must be followed by a one-paragraph verification',
      '  recipe (artifact path, test command, or 10-second reproduction).',
      '  The engine halts on this marker — false positives waste real',
      '  human time. If unsure, emit `[done]` and let the next iteration',
      '  decide.',
      '',
      '### Operating principles',
      '- YOLO is active. Do NOT ask for confirmation, do NOT propose',
      '  options. Pick the best path and execute it.',
      '- Use tools freely; multiple calls per turn are normal and expected.',
      '- When working on a todo, mark it `in_progress` via the todos tool',
      '  before tool work and `completed` (or `cancelled` with a reason)',
      '  when done. The loop reads todo state between iterations.',
      "- If an approach fails twice in a row, pivot. Don't grind on the",
      '  same wall — try a different angle, file a cancel on the todo, or',
      '  surface the obstacle via `[done]` and let the next iteration',
      '  re-plan.',
    ].join('\n');

    return [
      {
        type: 'text',
        text,
        cache_control: { type: 'ephemeral' },
      },
    ];
  };
}
