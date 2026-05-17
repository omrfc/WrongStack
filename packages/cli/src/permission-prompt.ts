import type { InputReader, Tool } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import { renderDiff } from './diff-renderer.js';
import { theme } from './theme.js';

export type PromptDecision = 'yes' | 'no' | 'always' | 'deny';

/** Signature the Agent expects for confirming tool calls. */
export type ConfirmAwaiter = (
  tool: Tool,
  input: unknown,
  toolUseId: string,
  suggestedPattern: string,
) => Promise<'yes' | 'no' | 'always' | 'deny'>;

export function makePromptDelegate(reader: InputReader) {
  return async (tool: Tool, input: unknown, suggestedPattern: string): Promise<PromptDecision> => {
    // Terminal bell (\x07) to alert the user that action is required.
    // Without this, the prompt can be easily missed when output is
    // scrolling or the user has switched to another window.
    process.stdout.write('\x07');
    process.stdout.write(`\n${theme.warn('⚠ APPROVAL REQUIRED')} ${theme.primary('│')} ${theme.bold(tool.name)}\n`);
    process.stdout.write(`${color.dim(stringifyInput(input))}\n`);

    if (tool.name === 'edit' && hasDiff(input)) {
      const inp = input as { diff?: unknown };
      const diff = typeof inp.diff === 'string' ? inp.diff : '';
      if (diff) process.stdout.write(`${renderDiff(diff)}\n`);
    }

    process.stdout.write(color.dim('─────────────────\n'));
    const answer = await reader.readKey(
      `${theme.bold('[y]')}es  ${theme.bold('[n]')}o  ${theme.bold('[a]')}lways allow (${suggestedPattern})  ${theme.bold('[d]')}eny: `,
      [
        { key: 'y', label: 'yes', value: 'yes' },
        { key: 'n', label: 'no', value: 'no' },
        { key: 'a', label: 'always', value: 'always' },
        { key: 'd', label: 'deny', value: 'deny' },
      ],
    );
    return answer as PromptDecision;
  };
}

/**
 * Create a ConfirmAwaiter for the CLI path. Wraps makePromptDelegate
 * with the ConfirmAwaiter type signature expected by the Agent.
 */
export function makeConfirmAwaiter(reader: InputReader): ConfirmAwaiter {
  const delegate = makePromptDelegate(reader);
  return async (tool: Tool, input: unknown, _toolUseId: string, suggestedPattern: string) => {
    const result = await delegate(tool, input, suggestedPattern);
    return result as 'yes' | 'no' | 'always' | 'deny';
  };
}

function stringifyInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  return Object.entries(obj)
    .filter(([k]) => k !== 'content' && k !== 'new_string')
    .map(([k, v]) => `${k}: ${truncate(JSON.stringify(v), 80)}`)
    .join('  ');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function hasDiff(input: unknown): boolean {
  return Boolean(
    input && typeof input === 'object' && 'diff' in (input as Record<string, unknown>),
  );
}
