import type { RunResult } from '../core/agent-types.js';
import type { Context } from '../core/context.js';
import type { AfterRunHook, AgentExtension } from '../extension/extension-points.js';
import type { MemoryEntry, MemoryStore } from '../types/memory.js';
import type { Provider } from '../types/provider.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ConsolidationOp {
  action: 'add' | 'edit' | 'delete';
  /** For add: the fact to remember. For edit: the new text replacing the old. */
  text?: string | undefined;
  /** For edit/delete: the query to match existing entries. */
  query?: string | undefined;
  /** Memory type for categorization. */
  type?: string | undefined;
  /** Tags for grouping. */
  tags?: string[] | undefined;
  /** Priority level. */
  priority?: string | undefined;
}

interface ConsolidationResponse {
  operations: ConsolidationOp[];
  summary?: string | undefined;
}

export interface MemoryConsolidatorOptions {
  memoryStore: MemoryStore;
  /**
   * Provider used for the consolidation LLM call. Uses the session's
   * provider by default.
   */
  provider?: Provider | undefined;
  /**
   * Model override for the consolidation call. Uses the session's model
   * by default. A smaller/faster model is recommended (e.g. haiku, flash).
   */
  model?: string | undefined;
  /**
   * Minimum session iterations before consolidation fires.
   * Sessions shorter than this are skipped (default 2).
   */
  minIterations?: number | undefined;
  /**
   * Maximum memory entries to include in the prompt as context.
   */
  maxExistingEntries?: number | undefined;
}

// ── Prompt ──────────────────────────────────────────────────────────────

function buildConsolidationPrompt(
  finalText: string,
  iterations: number,
  existingEntries: MemoryEntry[],
): string {
  const existingBlock =
    existingEntries.length > 0
      ? `\n\nExisting memory entries:\n${existingEntries
          .map((e) => `- [${e.ts.slice(0, 10)}] ${e.text}`)
          .join('\n')}`
      : '';

  return `You are a memory consolidator. Review the following session summary and decide what key facts, conventions, decisions, or learnings should be persisted to long-term memory.

Session summary (${iterations} iterations):
${finalText.slice(0, 3000)}${existingBlock}

Return a JSON object with an "operations" array. Each operation must have an "action" field:
- "add": create a new memory entry. Include "text", and optionally "type", "tags", "priority".
- "edit": replace an existing entry. Include "query" (to match) and "text" (replacement).
- "delete": remove an entry. Include "query" (to match).

Memory types:
- "fact": Objective truth about the project (e.g. "uses pnpm workspaces")
- "decision": A choice that was made (e.g. "decided to use biome over eslint")
- "convention": A recurring pattern or standard (e.g. "commit messages use conventional format")
- "preference": User or team preference (e.g. "prefers short variable names")
- "reference": Pointer to a file or location (e.g. "auth logic in packages/core/src/auth/")
- "anti_pattern": Something to avoid (e.g. "never use any in TypeScript")

Priority levels:
- "critical": Must always be known (e.g. security constraints)
- "high": Important for most tasks
- "medium": Useful context
- "low": Nice to know

Rules:
- Only persist facts likely useful across multiple future sessions.
- Do NOT persist task progress, temporary state, or one-off observations.
- Prefer "add" over "edit" unless the existing entry is clearly outdated.
- Assign a type and priority to every "add" operation.
- Use 1-3 hashtag tags for each entry (e.g. #typescript #build).
- Be concise — each memory entry should be one clear sentence.

Return ONLY valid JSON, no markdown, no explanation:
{
  "operations": [
    { 
      "action": "add", 
      "text": "Project uses pnpm workspaces with TypeScript strict mode",
      "type": "convention",
      "priority": "high",
      "tags": ["pnpm", "typescript", "build"]
    },
    { 
      "action": "edit", 
      "query": "pnpm", 
      "text": "Project uses pnpm v9+ with ESM-only modules",
      "type": "fact",
      "priority": "medium"
    },
    { "action": "delete", "query": "outdated convention" }
  ]
}`;
}

// ── Consolidator ────────────────────────────────────────────────────────

export class SessionMemoryConsolidator implements AgentExtension {
  name = 'session-memory-consolidator';
  owner = 'core';

  private readonly memoryStore: MemoryStore;
  private readonly provider?: Provider | undefined;
  private readonly model?: string | undefined;
  private readonly minIterations: number;
  private readonly maxExistingEntries: number;

  constructor(opts: MemoryConsolidatorOptions) {
    this.memoryStore = opts.memoryStore;
    this.provider = opts.provider;
    this.model = opts.model;
    this.minIterations = opts.minIterations ?? 2;
    this.maxExistingEntries = opts.maxExistingEntries ?? 15;
  }

  afterRun: AfterRunHook = async (ctx: Context, result: RunResult) => {
    // Only consolidate successful sessions with meaningful output
    if (result.status !== 'done') return;
    if (!result.finalText || result.finalText.trim().length < 20) return;
    if (result.iterations < this.minIterations) return;

    const provider = this.provider ?? ctx.provider;
    if (!provider || !provider.complete) return;

    try {
      // Load existing memory for dedup context
      const existingEntries = await this.memoryStore.list('project-memory', this.maxExistingEntries);
      const prompt = buildConsolidationPrompt(
        result.finalText,
        result.iterations,
        existingEntries,
      );

      // Call the LLM with a focused, one-shot prompt
      const signal = AbortSignal.timeout(15_000);
      const response = await provider.complete(
        {
          model: this.model ?? ctx.model,
          system: [{ type: 'text', text: prompt }],
          messages: [
            { role: 'user', content: 'Review the session and return memory operations as JSON.' },
          ],
          maxTokens: 500,
        },
        { signal },
      );

      const text = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!text) return;

      // Extract JSON from possible markdown wrapper
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const parsed: ConsolidationResponse = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) return;

      // Apply operations
      let added = 0;
      let edited = 0;
      let deleted = 0;

      for (const op of parsed.operations) {
        switch (op.action) {
          case 'add': {
            if (op.text?.trim()) {
              await this.memoryStore.remember(op.text.trim(), undefined, {
                type: op.type as MemoryEntry['type'],
                tags: op.tags,
                priority: op.priority as MemoryEntry['priority'],
              });
              added++;
            }
            break;
          }
          case 'edit': {
            if (op.query && op.text && op.text.trim()) {
              await this.memoryStore.forget(op.query);
              await this.memoryStore.remember(op.text.trim(), undefined, {
                type: op.type as MemoryEntry['type'],
                tags: op.tags,
                priority: op.priority as MemoryEntry['priority'],
              });
              edited++;
            }
            break;
          }
          case 'delete': {
            if (op.query) {
              const n = await this.memoryStore.forget(op.query);
              deleted += n;
            }
            break;
          }
        }
      }

      if (added > 0 || edited > 0 || deleted > 0) {
        const parts: string[] = [];
        if (added) parts.push(`${added} added`);
        if (edited) parts.push(`${edited} edited`);
        if (deleted) parts.push(`${deleted} deleted`);
        // Log to stderr so it surfaces in the terminal
        process.stderr.write(`[memory] Session consolidation: ${parts.join(', ')}\n`);
      }
    } catch {
      // Silent — memory consolidation is best-effort, never blocks session cleanup
    }
  };
}
