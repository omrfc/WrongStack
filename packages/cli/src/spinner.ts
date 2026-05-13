import { color } from '@wrongstack/core';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FILLED = '█';
const EMPTY = '░';

export interface ContextInfo {
  used: number;
  max: number;
}

/**
 * Minimal single-line spinner. Writes to stderr so it doesn't get mixed with
 * the agent's stdout output (assistant text, tool diffs). Auto-no-ops outside
 * a TTY so logs don't get spammed with control codes.
 *
 * When a {@link ContextInfo} is set via {@link setContext}, the spinner line
 * appends a compact `ctx ████░░ 42% (12k/200k)` chip so the user can see
 * how full the model's context window is while waiting for a response.
 */
export class Spinner {
  private timer?: NodeJS.Timeout;
  private frame = 0;
  private active = false;
  private label = '';
  private startedAt = 0;
  private context?: ContextInfo;
  private readonly out: NodeJS.WriteStream;
  private readonly enabled: boolean;

  constructor(out: NodeJS.WriteStream = process.stderr) {
    this.out = out;
    this.enabled = Boolean(out.isTTY) && !process.env.NO_COLOR;
  }

  start(label: string): void {
    if (!this.enabled || this.active) return;
    this.label = label;
    this.frame = 0;
    this.active = true;
    this.startedAt = Date.now();
    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % FRAMES.length;
      this.render();
    }, 80);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.clearLine();
  }

  /** Stop and persist a one-line note where the spinner was (e.g. "✓ done in 1.4s"). */
  stopWith(note: string): void {
    this.stop();
    this.out.write(`${note}\n`);
  }

  /** Update the live context-window chip shown on the spinner line. */
  setContext(ctx: ContextInfo | undefined): void {
    this.context = ctx;
  }

  private render(): void {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    let line = `${color.amber(FRAMES[this.frame] ?? '')} ${this.label} ${color.dim(`${elapsed}s`)}`;
    if (this.context && this.context.max > 0) {
      line += '  ' + renderContextChip(this.context);
    }
    this.clearLine();
    this.out.write(line);
  }

  private clearLine(): void {
    if (!this.enabled) return;
    this.out.write('\r\x1b[2K');
  }
}

function renderContextChip(ctx: ContextInfo): string {
  const ratio = Math.max(0, Math.min(1, ctx.used / ctx.max));
  const pct = Math.round(ratio * 100);
  const chipColor = ratio >= 0.85 ? color.red : ratio >= 0.65 ? color.yellow : color.cyan;
  const bar = renderProgress(ratio, 8);
  return (
    color.dim('ctx ') +
    chipColor(bar) +
    chipColor(` ${pct}%`) +
    color.dim(` (${fmtTok(ctx.used)}/${fmtTok(ctx.max)})`)
  );
}

function renderProgress(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
