/**
 * Per-section context-window token estimate for the `context.debug` command.
 *
 * Uses the simple 4-chars-per-token heuristic — not exact, but close enough to
 * spot which section (system prompt, tool schemas, or message history) is
 * eating the context window. Tool schemas in particular are easy to overlook:
 * each tool ships its full JSON schema to the model every turn, so 20+ builtins
 * can cost 10-20k tokens on their own.
 *
 * Extracted from `index.ts` as a pure function so the breakdown maths can be
 * unit tested without standing up a Context/ToolRegistry.
 */

/** 4-chars-per-token heuristic estimate for a string. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Stringify arbitrary content for length estimation (JSON, with fallbacks). */
export function stringifyContent(c: unknown): string {
  if (typeof c === 'string') return c;
  try {
    return JSON.stringify(c);
  } catch {
    return String(c);
  }
}

interface PromptBlock {
  text?: string;
}
interface ToolLike {
  name: string;
  inputSchema?: unknown;
  description?: string;
}
interface ContentBlock {
  type?: string;
  text?: string;
  input?: unknown;
  content?: unknown;
  name?: string;
}
interface MessageLike {
  role: string;
  content: unknown;
}

export interface ToolTokenEntry {
  name: string;
  tokens: number;
}
export interface MessageTokenEntry {
  index: number;
  role: string;
  tokens: number;
  preview: string;
}

export interface ContextBreakdown {
  total: number;
  systemPrompt: number;
  tools: { total: number; count: number; breakdown: ToolTokenEntry[] };
  messages: { total: number; count: number; breakdown: MessageTokenEntry[] };
}

function messageTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTokens(content);
  if (!Array.isArray(content)) return 0;
  let tk = 0;
  for (const b of content as ContentBlock[]) {
    if (b.type === 'text') tk += estimateTokens(b.text ?? '');
    else if (b.type === 'tool_use') tk += estimateTokens(stringifyContent(b.input));
    else if (b.type === 'tool_result') tk += estimateTokens(stringifyContent(b.content));
    else tk += estimateTokens(stringifyContent(b));
  }
  return tk;
}

function messagePreview(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 60);
  if (!Array.isArray(content)) return '';
  return (content as ContentBlock[])
    .map((b) =>
      b.type === 'text'
        ? (b.text ?? '').slice(0, 40)
        : b.type === 'tool_use'
          ? `[tool_use: ${b.name}]`
          : b.type === 'tool_result'
            ? '[tool_result]'
            : `[${b.type}]`,
    )
    .join(' ')
    .slice(0, 60);
}

/**
 * Compute the per-section token breakdown for the active context. Mirrors the
 * shape the `context.debug` WS reply expects (minus the `mode`/`policy` fields,
 * which the caller layers on from `context.meta`).
 */
export function estimateContextBreakdown(input: {
  systemPrompt: ReadonlyArray<PromptBlock>;
  tools: ReadonlyArray<ToolLike>;
  messages: ReadonlyArray<MessageLike>;
}): ContextBreakdown {
  const sysTokens = input.systemPrompt.reduce((acc, b) => acc + estimateTokens(b.text ?? ''), 0);

  const toolBreakdown: ToolTokenEntry[] = input.tools.map((t) => {
    const schema = t.inputSchema ?? {};
    const desc = t.description ?? '';
    return {
      name: t.name,
      tokens:
        estimateTokens(t.name) + estimateTokens(desc) + estimateTokens(stringifyContent(schema)),
    };
  });
  const toolTokens = toolBreakdown.reduce((a, b) => a + b.tokens, 0);

  const messageBreakdown: MessageTokenEntry[] = input.messages.map((m, i) => ({
    index: i,
    role: m.role,
    tokens: messageTokens(m.content),
    preview: messagePreview(m.content),
  }));
  const msgTokens = messageBreakdown.reduce((a, b) => a + b.tokens, 0);

  return {
    total: sysTokens + toolTokens + msgTokens,
    systemPrompt: sysTokens,
    tools: { total: toolTokens, count: input.tools.length, breakdown: toolBreakdown },
    messages: { total: msgTokens, count: input.messages.length, breakdown: messageBreakdown },
  };
}
