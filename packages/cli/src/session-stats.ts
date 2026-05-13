import type { EventBus, TokenCounter } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { TerminalRenderer } from './renderer.js';

interface ToolStat {
  ok: number;
  fail: number;
  totalMs: number;
}

/**
 * Accumulates per-session stats by listening to EventBus events. Designed
 * to be created once in main(), live for the whole CLI invocation (single-shot
 * or REPL), and produce the closing report when asked.
 *
 * Cost is intentionally not tracked here — TokenCounter is the authority.
 */
export class SessionStats {
  private readonly tokenCounter: TokenCounter;
  private readonly startedAt = Date.now();

  private apiRequests = 0;
  private iterations = 0;
  private errors = 0;

  private readonly toolStats = new Map<string, ToolStat>();
  private readonly readPaths = new Set<string>();
  private readonly editedPaths = new Set<string>();
  private readonly writtenPaths = new Set<string>();
  private bytesWritten = 0;
  private bashCommands = 0;
  private fetches = 0;

  constructor(events: EventBus, tokenCounter: TokenCounter) {
    this.tokenCounter = tokenCounter;
    events.on('provider.response', () => {
      this.apiRequests++;
    });
    events.on('iteration.completed', () => {
      this.iterations++;
    });
    events.on('error', () => {
      this.errors++;
    });
    events.on('tool.executed', (e) => {
      const slot = this.toolStats.get(e.name) ?? { ok: 0, fail: 0, totalMs: 0 };
      if (e.ok) slot.ok++;
      else slot.fail++;
      slot.totalMs += e.durationMs;
      this.toolStats.set(e.name, slot);

      const input = e.input as Record<string, unknown> | undefined;
      // Side-effect counts are attempt-based (count failed shells / fetches too —
      // the user wants to see "the agent tried to run 4 commands").
      if (e.name === 'bash') this.bashCommands++;
      else if (e.name === 'fetch') this.fetches++;

      // File-path tracking is success-only: a failed read or edit didn't
      // actually touch the file, so don't claim it did.
      if (!e.ok) return;
      const path = typeof input?.path === 'string' ? (input.path as string) : undefined;
      if (e.name === 'read' && path) this.readPaths.add(path);
      else if (e.name === 'edit' && path) this.editedPaths.add(path);
      else if (e.name === 'write' && path) {
        this.writtenPaths.add(path);
        const content = typeof input?.content === 'string' ? (input.content as string) : '';
        this.bytesWritten += Buffer.byteLength(content, 'utf8');
      }
    });
  }

  hasActivity(): boolean {
    return (
      this.apiRequests > 0 ||
      this.iterations > 0 ||
      this.toolStats.size > 0 ||
      this.tokenCounter.total().input > 0
    );
  }

  /**
   * Build the report string. Returns null when there's no recorded
   * activity yet — caller decides whether to emit a placeholder or stay
   * silent. Splitting `format()` out of `render()` lets the TUI's slash
   * dispatcher take the string and turn it into a history entry, while
   * REPL keeps the old direct-write path.
   */
  format(): string | null {
    if (!this.hasActivity()) return null;
    const u = this.tokenCounter.total();
    const cost = this.tokenCounter.estimateCost();
    const elapsedSec = ((Date.now() - this.startedAt) / 1000).toFixed(1);

    const lines: string[] = [];
    lines.push('');
    lines.push(color.bold('Session report'));
    lines.push(color.dim('─'.repeat(40)));
    lines.push(`  Elapsed:       ${elapsedSec}s`);
    lines.push(`  Iterations:    ${this.iterations}`);
    lines.push(`  API requests:  ${this.apiRequests}`);
    if (this.errors > 0) {
      lines.push(`  Errors:        ${color.yellow(String(this.errors))}`);
    }
    lines.push('');
    lines.push(`  Tokens:        in ${fmtTok(u.input)}   out ${fmtTok(u.output)}${u.cacheRead ? `   cacheR ${fmtTok(u.cacheRead)}` : ''}${u.cacheWrite ? `   cacheW ${fmtTok(u.cacheWrite)}` : ''}`);
    const cache = this.tokenCounter.cacheStats();
    if (cache.readTokens > 0 || cache.writeTokens > 0) {
      const pct = (cache.hitRatio * 100).toFixed(1);
      lines.push(
        `  Prompt cache:  ${pct}% hit  ${color.dim(`(${fmtTok(cache.readTokens)} read / ${fmtTok(cache.writeTokens)} write)`)}`,
      );
    }
    if (cost.total > 0) {
      lines.push(`  Cost:          $${cost.total.toFixed(4)}${color.dim(` (in $${cost.input.toFixed(4)} / out $${cost.output.toFixed(4)})`)}`);
    } else {
      lines.push(`  Cost:          ${color.dim('$0 (no pricing on this plan)')}`);
    }

    if (this.toolStats.size > 0) {
      lines.push('');
      lines.push(`  ${color.bold('Tool calls')}`);
      const sorted = [...this.toolStats.entries()].sort(
        (a, b) => (b[1].ok + b[1].fail) - (a[1].ok + a[1].fail),
      );
      for (const [name, s] of sorted) {
        const total = s.ok + s.fail;
        const failPart = s.fail > 0 ? color.yellow(` (${s.fail} failed)`) : '';
        const avgMs = total > 0 ? Math.round(s.totalMs / total) : 0;
        lines.push(`    ${name.padEnd(12)} ${String(total).padStart(3)}×   ${color.dim(`avg ${avgMs}ms`)}${failPart}`);
      }
    }

    const fileActivity =
      this.readPaths.size > 0 ||
      this.editedPaths.size > 0 ||
      this.writtenPaths.size > 0 ||
      this.bytesWritten > 0;
    if (fileActivity) {
      lines.push('');
      lines.push(`  ${color.bold('Files')}`);
      if (this.readPaths.size > 0)
        lines.push(`    read:    ${this.readPaths.size}  ${color.dim(samplePaths(this.readPaths))}`);
      if (this.editedPaths.size > 0)
        lines.push(`    edited:  ${this.editedPaths.size}  ${color.dim(samplePaths(this.editedPaths))}`);
      if (this.writtenPaths.size > 0) {
        const bytes = this.bytesWritten;
        const byteStr = bytes > 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}B`;
        lines.push(`    written: ${this.writtenPaths.size}  (${byteStr})  ${color.dim(samplePaths(this.writtenPaths))}`);
      }
    }

    if (this.bashCommands > 0 || this.fetches > 0) {
      lines.push('');
      if (this.bashCommands > 0) lines.push(`  Shell commands:  ${this.bashCommands}`);
      if (this.fetches > 0) lines.push(`  Web fetches:     ${this.fetches}`);
    }

    lines.push('');
    return lines.join('\n');
  }

  render(renderer: TerminalRenderer): void {
    const text = this.format();
    if (text === null) return;
    renderer.write(`${text}\n`);
  }
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function samplePaths(set: Set<string>): string {
  const arr = [...set];
  if (arr.length <= 2) return arr.join(', ');
  return `${arr[0]}, … (+${arr.length - 1} more)`;
}