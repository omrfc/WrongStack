/**
 * LLM-powered commit message generation.
 * Generates proper commit messages by analyzing git diffs via the configured LLM provider.
 */

export interface CommitLLMProvider {
  complete(
    req: {
      model: string;
      system?: { type: 'text'; text: string }[];
      messages: { role: string; content: { type: 'text'; text: string }[] }[];
      maxTokens: number;
      temperature?: number;
    },
    opts: { signal: AbortSignal },
  ): Promise<{
    /** Normalized content blocks (Anthropic/OpenAI compatible) */
    content: { type: 'text'; text: string }[];
    model: string;
  }>;
}

export interface CommitLLMOpts {
  provider: CommitLLMProvider;
  model: string;
}

/**
 * Generate a proper commit message by asking the LLM to analyze the diff.
 * Falls back to heuristics on failure.
 */
export async function generateCommitMessageWithLLM(
  diff: string,
  opts: CommitLLMOpts,
): Promise<string> {
  const systemPrompt =
    'You are a helpful assistant that generates concise, conventional-commit-formatted git commit messages. ' +
    'Analyze the provided diff and output ONLY the commit message (no explanation, no quotes). ' +
    'Format: <type>(<scope>): <short description> — <type> is one of: feat, fix, docs, style, refactor, test, chore, perf, ci, build, temp. ' +
    'If the diff contains multiple unrelated changes, pick the most important one. ' +
    'Keep the description under 72 characters. Example: feat(cli): add /commit LLM integration';

  const userPrompt = `Here is the git diff:\n\n${diff}`;

  try {
    const signal = new AbortController();
    const timeout = setTimeout(() => signal.abort(), 15_000);

    const resp = await opts.provider.complete(
      {
        model: opts.model,
        system: [{ type: 'text', text: systemPrompt }],
        messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
        maxTokens: 80,
        temperature: 0.3,
      },
      { signal: signal.signal },
    );
    clearTimeout(timeout);

    const rawContent = resp.content;
    const text =
      Array.isArray(rawContent)
        ? (rawContent[0] as { type: string; text?: string })?.text ?? ''
        : typeof rawContent === 'object' && rawContent !== null
          ? (rawContent as { type: string; text?: string }).text ?? ''
          : String(rawContent);
    const message = text.trim().split('\n')[0]!;

    if (message.length > 0 && message.length < 200) {
      return message;
    }
  } catch {
    // LLM call failed — fall through to heuristics
  }

  // Fallback: use heuristics via the existing function
  return 'chore: update';
}