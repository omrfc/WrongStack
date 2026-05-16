import type { Agent, AttachmentStore, SlashCommandRegistry, TokenCounter } from '@wrongstack/core';
import { InputBuilder, color } from '@wrongstack/core';
import {
  readClipboardImage,
  routeImagesForModel,
  type VisionAdapters,
} from '@wrongstack/runtime';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import { theme } from './theme.js';
import { fmtTok } from './utils.js';
import { CLI_VERSION } from './version.js';

export interface ReplOptions {
  agent: Agent;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  banner?: boolean;
  tokenCounter?: TokenCounter;
  visionAdapters?: VisionAdapters;
  /** Model-specific max context window (tokens). Used for the context bar in turn summaries. */
  effectiveMaxContext?: number;
  /** Project / folder name shown in the banner. Usually `path.basename(projectRoot)`. */
  projectName?: string;
  /** Resolve current model vision support. Falls back to provider capability when omitted. */
  supportsVision?: () => boolean | Promise<boolean>;
}

export async function runRepl(opts: ReplOptions): Promise<number> {
  if (opts.banner !== false) printBanner(opts.renderer, opts.projectName);

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

  // Wrap the entire loop so SIGINT and reader teardown run on every exit
  // path — exceptions, EOF, breakouts. Previously a throw between `on`
  // and the final `off` left the listener installed across REPL restarts.
  try {
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

      if (trimmed === '/image' || trimmed === '/paste-image' || raw === '\x1bv') {
        await pasteClipboardImage(builder, opts);
        continue;
      }

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
        const routed = blocks.some((block) => block.type === 'image')
          ? await routeImagesForModel(blocks, {
              supportsVision: opts.supportsVision
                ? await opts.supportsVision()
                : opts.agent.ctx.provider.capabilities.vision,
              adapters: opts.visionAdapters ?? [],
              ctx: opts.agent.ctx,
              signal: runCtrl.signal,
              providerId: opts.agent.ctx.provider.id,
              model: opts.agent.ctx.model,
            })
          : { blocks, route: 'none' as const, convertedImages: 0 };
        if (routed.route === 'adapter') {
          opts.renderer.write(
            color.dim(
              `  ↳ image analyzed via ${routed.adapterName ?? 'vision adapter'} (${routed.convertedImages} image${routed.convertedImages === 1 ? '' : 's'})\n`,
            ),
          );
        }
        const result = await opts.agent.run(routed.blocks, { signal: runCtrl.signal });
        if (result.status === 'aborted') {
          opts.renderer.writeWarning('Aborted.');
        } else if (result.status === 'failed') {
          const err = result.error;
          if (err) {
            const tag = err.recoverable ? ' (recoverable)' : '';
            opts.renderer.writeError(`Failed [${err.severity}]${tag}: ${err.describe()}`);
          } else {
            opts.renderer.writeError('Failed.');
          }
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

    return 0;
  } finally {
    // Ensure listener + reader cleanup happens on every exit path: normal
    // EOF, /quit, an uncaught throw, etc. Without this, a thrown exception
    // mid-loop would leave the SIGINT handler attached for the rest of
    // the process lifetime (and the reader's terminal handle open).
    process.off('SIGINT', onSigint);
    await opts.reader.close().catch(() => {
      /* best-effort */
    });
  }
}

async function pasteClipboardImage(builder: InputBuilder, opts: ReplOptions): Promise<void> {
  try {
    const img = await readClipboardImage();
    if (!img) {
      opts.renderer.write(color.dim('  no image on clipboard\n'));
      return;
    }
    const placeholder = await builder.appendImage(img.base64, img.mediaType);
    const kb = (img.bytes / 1024).toFixed(0);
    opts.renderer.write(color.dim(`  ↳ ${placeholder} (PNG ${kb}KB)\n`));
  } catch (err) {
    opts.renderer.writeError(
      `Clipboard image error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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

function printBanner(renderer: TerminalRenderer, projectName?: string): void {
  const lines = [
    theme.primary(theme.bold('WrongStack')) + color.dim(` v${CLI_VERSION}`),
    color.dim('Built on the wrong stack. Shipped anyway.'),
  ];
  if (projectName && projectName.length > 0) {
    lines.push(color.dim('Project: ') + theme.bold(projectName));
  }
  lines.push(color.dim('Type /help for commands, /exit to quit.'), '');
  renderer.write(`${lines.join('\n')}\n`);
}
