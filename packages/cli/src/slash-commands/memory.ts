import type { SlashCommand } from '@wrongstack/core';
import { parseSubcommand, unknownSubcommand } from './helpers.js';
import type { SlashCommandContext } from './index.js';
import { toErrorMessage } from '@wrongstack/core/utils';

export function buildMemoryCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'memory',
    category: 'Inspect',
    description:
      'Inspect or edit persistent memory: /memory [show|remember <text>|forget <query>|clear|compact|stats]',
    async run(args) {
      const store = opts.memoryStore;
      if (!store) return { message: 'No memory store configured.' };
      const { cmd, rest } = parseSubcommand(args);
      const restJoined = rest.join(' ').trim();
      switch (cmd) {
        case '':
        case 'show':
        case 'list': {
          const text = await store.readAll();
          return {
            message:
              text.trim().length === 0
                ? 'Memory is empty. Add an entry with `/memory remember <text>`.'
                : text,
          };
        }
        case 'remember':
        case 'add': {
          if (!restJoined) return { message: 'Usage: /memory remember <text>' };
          await store.remember(restJoined);
          return { message: `Remembered: ${restJoined}` };
        }
        case 'forget':
        case 'rm': {
          if (!restJoined) return { message: 'Usage: /memory forget <query>' };
          const n = await store.forget(restJoined);
          return {
            message: n === 0 ? `No entries matched "${restJoined}".` : `Forgot ${n} entries.`,
          };
        }
        case 'clear': {
          await store.clear();
          return { message: 'Cleared all memory scopes.' };
        }
        case 'compact': {
          return runCompact(opts);
        }
        case 'stats': {
          return runStats(opts);
        }
        default:
          return {
            message: unknownSubcommand(
              cmd,
              ['show', 'remember', 'forget', 'clear', 'compact', 'stats'],
              'memory',
            ),
          };
      }
    },
  };
}

// ── /memory compact — LLM-driven memory review and optimization ────────

interface CompactOperation {
  action: 'keep' | 'rewrite' | 'merge' | 'delete';
  /** For rewrite/merge/delete: the memory entry IDs or search queries to match. */
  targets: string[];
  /** For rewrite/merge: the new text. For keep: unused. */
  newText?: string | undefined;
  /** Reason for the operation — shown in the summary. */
  reason: string;
}

interface CompactResponse {
  operations: CompactOperation[];
  /** Optional summary of what was done. */
  summary?: string | undefined;
}

/**
 * System prompt template for the memory compact LLM call.
 * `__ENTRIES__` is replaced with the formatted entry list at call time.
 * Kept as a module-level constant so the prompt text can be reviewed and
 * iterated on independently of the call logic.
 */
const COMPACT_SYSTEM_PROMPT = `You are a memory curator. Your task is to review, deduplicate, and improve a set of long-term memory entries.

These entries are injected into the context of an AI coding agent. Every token counts. The memory must be concise, accurate, and free of noise.

## Current Memory Entries

__ENTRIES__

## Your Task

Review each entry and return a JSON object with an "operations" array. Each operation targets one or more entries:

### Actions

- **"keep"** — The entry is valuable as-is. Include it in the operations so I know you reviewed it.
- **"rewrite"** — The entry has value but needs better wording. Provide improved "newText". Target a single entry.
- **"merge"** — Two or more entries say essentially the same thing. Combine them into one concise entry. The "targets" should list all entries being merged. Provide the combined "newText".
- **"delete"** — The entry is obsolete, redundant, too vague, or not useful for future sessions. Target one or more entries.

### Rules

1. **Be ruthless about noise.** If an entry won't help a future AI agent do its job better, delete it.
2. **Deduplicate aggressively.** Similar entries should be merged. Identical entries MUST be merged.
3. **Keep entries concise.** Each entry should be one clear sentence. Remove filler words.
4. **Preserve factual accuracy.** Don't change the meaning of entries unless they're wrong.
5. **Handle every entry.** Every entry must appear in at least one operation (keep, rewrite, merge, or delete).
6. **Prefer quality over quantity.** 10 excellent entries > 30 mediocre ones.
7. **Tag entries appropriately.** If an entry mentions a technology or concept that could be tagged, suggest tags in the newText using #hashtag syntax.

### Response Format

Return ONLY valid JSON with this structure:

{
  "operations": [
    { "action": "keep",    "targets": ["mem_1234_abcd"], "reason": "Clear and useful" },
    { "action": "rewrite", "targets": ["mem_5678_ef01"], "newText": "Project uses pnpm v9 with ESM-only modules #pnpm #esm", "reason": "Added version and ESM detail" },
    { "action": "merge",   "targets": ["mem_aaaa_1111", "mem_bbbb_2222"], "newText": "All packages use TypeScript strict mode with noUncheckedIndexedAccess #typescript", "reason": "Two entries about TS config, merged" },
    { "action": "delete",  "targets": ["mem_cccc_3333"], "reason": "Obsolete — was a temporary debug note" }
  ],
  "summary": "Merged 2 TS entries, rewrote 1 for clarity, deleted 1 obsolete note. 12 entries → 10 entries."
}

Use the EXACT entry IDs from the list above for "targets". No markdown, no explanation outside the JSON.`;

/**
 * Build the system prompt for the memory compact LLM call.
 * Interpolates the entry list into the shared template.
 */
function buildCompactPrompt(entries: CompactEntry[]): string {
  const entriesBlock = entries
    .map(
      (e, i) =>
        `${i + 1}. [${e.ts.slice(0, 10)}] ${e.id}\n   ${e.text}${e.tags ? `\n   tags: ${e.tags.join(', ')}` : ''}${e.type ? `\n   type: ${e.type}` : ''}${e.priority ? `\n   priority: ${e.priority}` : ''}`,
    )
    .join('\n\n');

  return COMPACT_SYSTEM_PROMPT.replace('__ENTRIES__', entriesBlock);
}

interface CompactEntry {
  id: string;
  text: string;
  ts: string;
  type?: string | undefined;
  tags?: string[] | undefined;
  priority?: string | undefined;
}

async function runCompact(opts: SlashCommandContext): Promise<{ message: string }> {
  const store = opts.memoryStore;
  if (!store) return { message: 'No memory store configured.' };

  // 1. Read all current entries with metadata
  const entries = await store.list('project-memory');
  if (entries.length === 0) {
    return { message: 'Memory is empty — nothing to compact.' };
  }

  // Parse entry IDs from raw content
  const raw = await store.read('project-memory');
  const compactEntries = parseCompactEntries(raw);
  if (compactEntries.length === 0) {
    return { message: 'No parseable entries found.' };
  }

  // 2. Check for LLM provider
  const provider = opts.llmProvider;
  if (!provider?.complete) {
    return {
      message:
        'No LLM provider available. /memory compact requires an active session with a configured provider.',
    };
  }

  // 3. Build prompt and call LLM
  const prompt = buildCompactPrompt(compactEntries);

  let responseText: string;
  try {
    const signal = AbortSignal.timeout(30_000);
    const response = await provider.complete(
      {
        model: opts.llmModel ?? '',
        system: [{ type: 'text', text: prompt }],
        messages: [
          {
            role: 'user',
            content: `Review the ${compactEntries.length} memory entries above and return operations as JSON.`,
          },
        ],
        maxTokens: 2000,
        temperature: 0.1, // low temperature for deterministic curation
      },
      { signal },
    );

    responseText = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    return {
      message: `LLM call failed: ${toErrorMessage(err)}`,
    };
  }

  if (!responseText) {
    return { message: 'LLM returned empty response.' };
  }

  // 4. Parse the JSON response
  let parsed: CompactResponse;
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { message: `LLM response is not valid JSON:\n${responseText.slice(0, 500)}` };
    }
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    return {
      message: `Failed to parse LLM response: ${toErrorMessage(err)}\n\nRaw response:\n${responseText.slice(0, 500)}`,
    };
  }

  if (!Array.isArray(parsed.operations) || parsed.operations.length === 0) {
    return { message: 'LLM returned no operations.' };
  }

  // 5. Apply operations
  let kept = 0;
  let rewritten = 0;
  let merged = 0;
  let deleted = 0;
  const errors: string[] = [];

  for (const op of parsed.operations) {
    try {
      switch (op.action) {
        case 'keep': {
          kept += op.targets.length;
          break;
        }
        case 'rewrite': {
          if (!op.newText) {
            errors.push(`rewrite missing newText for targets: ${op.targets.join(', ')}`);
            continue;
          }
          // Forget old entries, remember the rewritten version
          for (const target of op.targets) {
            await store.forget(target);
          }
          await store.remember(op.newText);
          rewritten++;
          break;
        }
        case 'merge': {
          if (!op.newText) {
            errors.push(`merge missing newText for targets: ${op.targets.join(', ')}`);
            continue;
          }
          // Forget all merged entries, remember the combined version
          for (const target of op.targets) {
            await store.forget(target);
          }
          await store.remember(op.newText);
          merged++;
          break;
        }
        case 'delete': {
          for (const target of op.targets) {
            await store.forget(target);
          }
          deleted += op.targets.length;
          break;
        }
        default: {
          errors.push(`unknown action "${(op as { action: string }).action}"`);
        }
      }
    } catch (err) {
      errors.push(
        `${op.action} failed for ${op.targets.join(', ')}: ${toErrorMessage(err)}`,
      );
    }
  }

  // 6. Build summary
  const lines: string[] = ['## Memory Compact — Complete'];
  const stats: string[] = [];
  if (kept > 0) stats.push(`${kept} kept`);
  if (rewritten > 0) stats.push(`${rewritten} rewritten`);
  if (merged > 0) stats.push(`${merged} merged`);
  if (deleted > 0) stats.push(`${deleted} deleted`);
  lines.push(`**Result:** ${stats.join(', ')}`);
  lines.push(
    `**Before:** ${compactEntries.length} entries → **After:** ${kept + rewritten + merged} entries`,
  );

  if (parsed.summary) {
    lines.push('');
    lines.push(parsed.summary);
  }

  // Show per-operation details
  lines.push('');
  lines.push('### Operations');
  for (const op of parsed.operations) {
    const icon =
      op.action === 'keep'
        ? '✓'
        : op.action === 'rewrite'
          ? '✏️'
          : op.action === 'merge'
            ? '🔀'
            : op.action === 'delete'
              ? '✗'
              : '?';
    const detail = op.newText ? ` → "${op.newText}"` : '';
    lines.push(`- ${icon} **${op.action}** ${op.targets.join(', ')}${detail}`);
    if (op.reason) lines.push(`  _${op.reason}_`);
  }

  if (errors.length > 0) {
    lines.push('');
    lines.push('### Errors');
    for (const err of errors) {
      lines.push(`- ⚠️ ${err}`);
    }
  }

  return { message: lines.join('\n') };
}

/**
 * Parse raw memory content into compact entries with IDs.
 * Each line: `- [ISO] [type|priority] mem_<id> text #tags`
 */
function parseCompactEntries(raw: string): CompactEntry[] {
  const entries: CompactEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- [')) continue;

    // Extract entry ID: mem_<ts>_<rand>
    const idMatch = trimmed.match(/mem_(\d+_\w+)/);
    if (!idMatch) continue;
    const id = idMatch[0] ?? '';
    const afterId = trimmed.slice((idMatch.index ?? 0) + id.length).trim();

    // Extract timestamp
    const tsMatch = trimmed.match(/^-\s*\[([^\]]+)\]/);
    const ts = tsMatch?.[1] ?? '';

    // Extract #tags
    const tags: string[] = [];
    const tagRe = /#([\w-]+)/g;
    let tm: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((tm = tagRe.exec(afterId)) !== null) {
      tags.push(tm[1] ?? '');
    }

    // Clean text (remove tags)
    const text = afterId
      .replace(tagRe, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!text) continue;

    entries.push({ id, text, ts, tags: tags.length > 0 ? tags : undefined });
  }
  return entries;
}

// ── /memory stats — memory health dashboard ─────────────────────────────

async function runStats(opts: SlashCommandContext): Promise<{ message: string }> {
  const store = opts.memoryStore;
  if (!store) return { message: 'No memory store configured.' };

  const entries = await store.list('project-memory');
  if (entries.length === 0) {
    return { message: '📊 Memory is empty. Start adding entries with `/memory remember <text>`.' };
  }

  const now = Date.now();
  const lines: string[] = ['## 📊 Memory Stats'];

  // ── Overview
  const raw = await store.read('project-memory');
  const byteSize = Buffer.byteLength(raw, 'utf8');
  const kbSize = (byteSize / 1024).toFixed(1);
  const maxKb = (32_000 / 1024).toFixed(1);
  const pctFull = ((byteSize / 32_000) * 100).toFixed(0);
  lines.push(`**Total:** ${entries.length} entries · ${kbSize} KB / ${maxKb} KB (${pctFull}%)`);

  // ── By type
  const byType = new Map<string, number>();
  for (const e of entries) {
    const t = e.type ?? 'untyped';
    byType.set(t, (byType.get(t) ?? 0) + 1);
  }
  if (byType.size > 0) {
    lines.push('');
    lines.push('### By Type');
    const typeOrder = [
      'convention',
      'decision',
      'fact',
      'preference',
      'reference',
      'anti_pattern',
      'untyped',
    ];
    for (const t of typeOrder) {
      const count = byType.get(t);
      if (count) {
        const bar = '█'.repeat(Math.min(count, 20));
        lines.push(`- \`${t}\` ${bar} ${count}`);
      }
    }
  }

  // ── By priority
  const byPriority = new Map<string, number>();
  for (const e of entries) {
    const p = e.priority ?? 'unset';
    byPriority.set(p, (byPriority.get(p) ?? 0) + 1);
  }
  if (byPriority.size > 0) {
    lines.push('');
    lines.push('### By Priority');
    const icon: Record<string, string> = {
      critical: '⚡',
      high: '▲',
      medium: '●',
      low: '○',
      unset: '·',
    };
    for (const [p, count] of [...byPriority.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${icon[p] ?? '·'} \`${p}\`: ${count}`);
    }
  }

  // ── By age
  const ages = entries.map((e) => {
    const ageDays = (now - new Date(e.ts).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < 1) return '<1d';
    if (ageDays < 7) return '<7d';
    if (ageDays < 30) return '<30d';
    return '>30d';
  });
  const byAge = new Map<string, number>();
  for (const a of ages) byAge.set(a, (byAge.get(a) ?? 0) + 1);
  lines.push('');
  lines.push('### By Age');
  for (const age of ['<1d', '<7d', '<30d', '>30d']) {
    const actual = byAge.get(age) ?? 0;
    if (actual > 0 || age === '<7d') {
      lines.push(`- ${age}: ${actual}`);
    }
  }

  // ── Top tags
  const tagCounts = new Map<string, number>();
  for (const e of entries) {
    for (const t of e.tags ?? []) {
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }
  if (tagCounts.size > 0) {
    lines.push('');
    lines.push('### Top Tags');
    const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [tag, count] of sorted) {
      lines.push(`- \`#${tag}\`: ${count}`);
    }
  }

  // ── Health
  lines.push('');
  lines.push('### Health');
  const untyped = byType.get('untyped') ?? 0;
  const unsetPriority = byPriority.get('unset') ?? 0;
  const old = byAge.get('>30d') ?? 0;

  if (untyped > entries.length * 0.5) {
    lines.push(
      `- ⚠️ ${untyped}/${entries.length} entries have no type — run \`/memory compact\` to categorize`,
    );
  } else if (untyped > 0) {
    lines.push(`- ℹ️ ${untyped} entries untyped — consider categorizing`);
  } else {
    lines.push('- ✅ All entries have types');
  }

  if (unsetPriority > entries.length * 0.5) {
    lines.push(`- ⚠️ ${unsetPriority}/${entries.length} entries have no priority`);
  } else if (unsetPriority > 0) {
    lines.push(`- ℹ️ ${unsetPriority} entries have no priority set`);
  } else {
    lines.push('- ✅ All entries have priorities');
  }

  if (old > 5) {
    lines.push(`- ⚠️ ${old} entries older than 30 days — run \`/memory compact\` to review`);
  }

  const pct = Number.parseInt(pctFull, 10);
  if (pct > 80) {
    lines.push(`- ⚠️ Storage ${pct}% full — run \`/memory compact\` to free space`);
  } else {
    lines.push(`- ✅ Storage ${pct}% full — healthy`);
  }

  lines.push('');
  lines.push('**Commands:** `/memory show` · `/memory compact` · `/memory remember <text>`');

  return { message: lines.join('\n') };
}
