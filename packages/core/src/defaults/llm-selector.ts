import type { Message } from '../types/messages.js';
import type { Provider, Request } from '../types/provider.js';
import { isTextBlock } from '../types/blocks.js';
import type { MessageSelector, SelectorResult } from '../types/selector.js';

export interface LLMSelectorOptions {
  /** Provider used for the selector LLM call. Required. */
  provider: Provider;
  /** Model for the selector. Defaults to the provider's default model. */
  model?: string;
  /**
   * Maximum tokens to keep in context (target budget).
   * Selector will aim to keep total content below this.
   */
  maxContextTokens?: number;
  /**
   * Prompt instructing the selector how to behave.
   * Should guide the LLM on importance tiers and output format.
   */
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are a context pruning assistant. Given a conversation history and a token budget, decide which message ranges are worth keeping verbatim and which should be collapsed into summaries.

Output a JSON object with this structure:
{
  "kept": [{"from": 0, "to": 5, "importance": "critical"}],
  "collapsed": [{"from": 6, "to": 20, "summary": "optional summary"}],
  "reasoning": "brief explanation of decisions"
}

Importance tiers:
- "critical": decisions, file edits, tool results that affect state, final answers
- "high": substantive tool use, complex reasoning, non-obvious observations
- "medium": routine exchanges, confirmations, straightforward Q&A

Rules:
- Always keep the most recent K pairs (preserve recency)
- Never collapse the final 2 user/assistant pairs (working memory)
- Preserve tool results that modified files or had external effects
- Collapse old, low-information exchanges (greetings, acknowledgements, etc.)
- If unsure, keep rather than collapse (errors are more costly than waste)

Return ONLY the JSON object, no markdown, no explanation outside the JSON.`;

/** Rough token estimation for a message array */
function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      total += Math.ceil(m.content.length / 4);
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') total += Math.ceil(b.text.length / 4);
        else total += Math.ceil(JSON.stringify(b).length / 4);
      }
    }
  }
  return total;
}

/** Format messages as a compact text dump for the selector LLM */
function formatMessages(messages: Message[], maxChars = 8000): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const role = m.role.padEnd(10, ' ');
    let text: string;
    if (typeof m.content === 'string') {
      text = m.content.slice(0, 500);
    } else {
      const content = m.content as import('../types/blocks.js').ContentBlock[];
      text = content
        .filter(isTextBlock)
        .map((b) => b.text)
        .join(' ');
      // Also capture tool names for context
      const toolUses = content.filter((b) => b.type === 'tool_use');
      if (toolUses.length > 0) {
        text += ` [tools: ${toolUses.map((b) => (b as { name: string }).name).join(', ')}]`;
      }
    }
    const line = `[${i}][${role}]: ${text}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

/**
 * LLM-powered message selector. Calls a sub-LLM to analyze the
 * message history and produce a keep/collapse plan — more surgical
 * than fixed-window rules.
 */
export class LLMSelector implements MessageSelector {
  private readonly provider: Provider;
  private readonly model: string;
  private readonly maxContextTokens: number;
  private readonly systemPrompt: string;

  constructor(opts: LLMSelectorOptions) {
    this.provider = opts.provider;
    this.model = opts.model ?? 'unknown';
    this.maxContextTokens = opts.maxContextTokens ?? 40_000;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async select(messages: Message[], maxToKeep: number): Promise<SelectorResult> {
    const effectiveBudget = Math.min(maxToKeep, this.maxContextTokens);

    // Build a concise representation of the conversation
    const historyText = formatMessages(messages);
    const totalTokens = estimateTokens(messages);
    const systemText = `${this.systemPrompt}\n\nConversation (${messages.length} messages, ~${totalTokens} tokens, budget: ${effectiveBudget}):\n`;

    // Add instruction to stay within budget
    const budgetInstruction =
      totalTokens > effectiveBudget
        ? `\n\nIMPORTANT: Total conversation (${totalTokens} tokens) exceeds budget (${effectiveBudget}). You MUST collapse enough to fit. Prefer collapsing older/lower-importance ranges.`
        : '';

    const req: Request = {
      model: this.model,
      system: [{ type: 'text', text: systemText + budgetInstruction }],
      messages: [{ role: 'user', content: historyText }],
      maxTokens: 1024,
    };

    let raw: string;
    try {
      const res = await this.provider.complete(req, { signal: new AbortController().signal });
      const textBlocks = res.content.filter(isTextBlock);
      raw = textBlocks.map((b) => b.text).join('\n').trim();
    } catch (err) {
      // Fallback: use simple recency-based selection
      return this.fallbackSelect(messages, effectiveBudget);
    }

    return this.parseSelectorOutput(raw, messages.length);
  }

  private fallbackSelect(messages: Message[], budget: number): SelectorResult {
    // Simple fallback: keep from the end until we hit budget
    const toKeep: SelectorResult['kept'] = [];
    const toCollapse: SelectorResult['collapsed'] = [];

    let tokenCount = 0;
    let startIdx = 0;

    // Scan from the end backwards
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      const cost = typeof m.content === 'string'
        ? Math.ceil(m.content.length / 4)
        : m.content.reduce((acc, b) => acc + (b.type === 'text' ? Math.ceil(b.text.length / 4) : Math.ceil(JSON.stringify(b).length / 4)), 0);

      if (tokenCount + cost <= budget) {
        tokenCount += cost;
      } else {
        startIdx = i + 1;
        break;
      }
    }

    if (startIdx > 0) {
      toCollapse.push({ from: 0, to: startIdx - 1 });
    }
    toKeep.push({ from: startIdx, to: messages.length - 1, importance: 'high' });

    return {
      kept: toKeep,
      collapsed: toCollapse,
      reasoning: `Fallback: kept last ${messages.length - startIdx} messages within ${budget} token budget`,
    };
  }

  private parseSelectorOutput(raw: string, messageCount: number): SelectorResult {
    // Try to extract JSON from the response
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      // Can't parse — use fallback
      return this.fallbackSelect(
        Array.from({ length: messageCount }, (_, i) => ({ role: 'user', content: '' } as Message)),
        this.maxContextTokens,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    } catch {
      return this.fallbackSelect(
        Array.from({ length: messageCount }, (_, i) => ({ role: 'user', content: '' } as Message)),
        this.maxContextTokens,
      );
    }

    const obj = parsed as Record<string, unknown>;
    const kept = (obj.kept as Array<{ from: number; to: number; importance: string }> | undefined) ?? [];
    const collapsed = (obj.collapsed as Array<{ from: number; to: number; summary?: string }> | undefined) ?? [];

    return {
      kept: kept.map((k) => ({ from: k.from, to: k.to, importance: (k.importance ?? 'medium') as 'critical' | 'high' | 'medium' })),
      collapsed: collapsed.map((c) => ({ from: c.from, to: c.to, summary: c.summary })),
      reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '',
    };
  }
}