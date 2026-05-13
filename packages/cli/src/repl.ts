import type {
  Agent,
  AttachmentStore,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { InputBuilder, color } from '@wrongstack/core';
import { theme } from './theme.js';
import type { TerminalRenderer } from './renderer.js';
import type { ReadlineInputReader } from './input-reader.js';

export interface ReplOptions {
  agent: Agent;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  banner?: boolean;
  tokenCounter?: TokenCounter;
  /** Model-specific max context window (tokens). Used for the context bar in turn summaries. */
  effectiveMaxContext?: number;
}

export async function runRepl(opts: ReplOptions): Promise<number> {
  if (opts.banner !== false) printBanner(opts.renderer);

  // Per-iteration abort controller — assigned each loop so a Ctrl+C that
  // cancels turn N doesn't leak into turn N+1. `activeCtrl` is updated
  // before each agent.run so the SIGINT handler can target it.
  let activeCtrl: AbortController | undefined;
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts >= 2) {
      opts.renderer.writeWarning('Exiting.');
      process.exit(130);
    }
    if (activeCtrl) {
      activeCtrl.abort();
      opts.renderer.writeWarning('Iteration cancelled. Press Ctrl+C again to exit.');
    } else {
      opts.renderer.writeWarning('Press Ctrl+C again to exit.');
    }
  };
  process.on('SIGINT', onSigint);

  const builder = new InputBuilder({ store: opts.attachments });

  for (;;) {
    let raw: string;
    try {
      raw = await readPossiblyMultiline(opts);
    } catch {
      break; // EOF (Ctrl+D)
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      interrupts = 0;
      continue;
    }
    interrupts = 0;

    if (trimmed.startsWith('/')) {
      try {
        const res = await opts.slashRegistry.dispatch(trimmed, opts.agent.ctx);
        if (res?.message) opts.renderer.write(`${res.message}\n`);
        if (res?.exit) break;
      } catch (err) {
        opts.renderer.writeError(err instanceof Error ? err.message : String(err));
      }
      continue;
    }

    // Route through InputBuilder so big pastes collapse to placeholders.
    const ph = await builder.appendPaste(raw);
    if (ph) {
      const lineCount = raw.split('\n').length;
      opts.renderer.write(color.dim(`  ↳ ${ph} (${lineCount} lines)\n`));
    }
    const blocks = await builder.submit();

    const runCtrl = new AbortController();
    activeCtrl = runCtrl;
    try {
      const startedAt = Date.now();
      const before = opts.tokenCounter?.total();
      const costBefore = opts.tokenCounter?.estimateCost().total ?? 0;
      const result = await opts.agent.run(blocks, { signal: runCtrl.signal });
      if (result.status === 'aborted') {
        opts.renderer.writeWarning('Aborted.');
      } else if (result.status === 'failed') {
        opts.renderer.writeError(
          `Failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
        );
      } else if (result.status === 'max_iterations') {
        opts.renderer.writeWarning(`Hit max iterations (${result.iterations}).`);
      }
      if (opts.tokenCounter && before) {
        const after = opts.tokenCounter.total();
        const costAfter = opts.tokenCounter.estimateCost().total;
        const ctxChip =
          opts.effectiveMaxContext && opts.effectiveMaxContext > 0
            ? `  ctx: ${renderContextChip(after.input, opts.effectiveMaxContext)}`
            : '';
        opts.renderer.write(
          `\n${color.dim(
            `[in: ${fmtTok(after.input - before.input)}  out: ${fmtTok(after.output - before.output)}  iters: ${result.iterations}  cost: ${(costAfter - costBefore).toFixed(4)}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s]${ctxChip}`,
          )}\n`,
        );
      }
    } catch (err) {
      opts.renderer.writeError(err instanceof Error ? err.message : String(err));
    } finally {
      activeCtrl = undefined;
    }
  }

  process.off('SIGINT', onSigint);
  await opts.reader.close();
  return 0;
}

/**
 * Read a line, but support two multiline patterns:
 *   1. Trailing `\` → continue on the next line (shell-style line continuation).
 *   2. A line that is exactly `"""` → start a heredoc; keep reading until
 *      another bare `"""`. Useful for pasting code snippets.
 * Returns the assembled text and whether it came from a heredoc block (so
 * the caller can decide to always collapse heredocs as pastes).
 */
async function readPossiblyMultiline(opts: ReplOptions): Promise<string> {
  const firstPrompt = theme.primary('› ');
  const contPrompt = color.dim('· ');
  const first = await opts.reader.readLine(firstPrompt);

  if (first.trim() === '"""') {
    const parts: string[] = [];
    for (;;) {
      const next = await opts.reader.readLine(contPrompt);
      if (next.trim() === '"""') break;
      parts.push(next);
    }
    return parts.join('\n');
  }

  let buf = first;
  while (buf.endsWith('\\')) {
    buf = buf.slice(0, -1); // drop the trailing backslash
    const cont = await opts.reader.readLine(contPrompt);
    buf += '\n' + cont;
  }
  return buf;
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const FILLED = '█';
const EMPTY = '░';

function renderContextChip(used: number, max: number): string {
  const ratio = Math.max(0, Math.min(1, used / max));
  const pct = Math.round(ratio * 100);
  const bar = renderProgress(ratio, 6);
  return `${bar} ${pct}% (${fmtTok(used)}/${fmtTok(max)})`;
}

function renderProgress(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

function printBanner(renderer: TerminalRenderer): void {
  const lines = [
    theme.primary(theme.bold('WrongStack')) + color.dim(' v0.0.1'),
    color.dim('Built on the wrong stack. Shipped anyway.'),
    color.dim('Type /help for commands, /exit to quit.'),
    '',
  ];
  renderer.write(`${lines.join('\n')}\n`);
}
