import type { ContentBlock, Renderer, TextBlock } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import { theme } from './theme.js';
import { renderDiff } from './diff-renderer.js';

export interface TerminalRendererOptions {
  out?: NodeJS.WriteStream;
  err?: NodeJS.WriteStream;
}

export class TerminalRenderer implements Renderer {
  private readonly out: NodeJS.WriteStream;
  private readonly err: NodeJS.WriteStream;
  private lineStart = true;
  /**
   * When true, every stdout-bound method is a no-op. This is the only
   * safe state to be in while Ink owns the terminal (TUI mode):
   * raw writes to stdout interleave with Ink's cursor math and cause
   * the input + status bar to be reprinted as scrollback junk.
   * Stderr-bound methods (writeInfo/Warning/Error) still flow — they
   * go to a different stream Ink does not manage.
   */
  private silent = false;

  constructor(opts: TerminalRendererOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.err = opts.err ?? process.stderr;
  }

  /**
   * Toggle stdout suppression. Call `setSilent(true)` right before
   * handing the terminal to Ink, and `setSilent(false)` after Ink
   * exits. Idempotent.
   */
  setSilent(silent: boolean): void {
    this.silent = silent;
  }

  isSilent(): boolean {
    return this.silent;
  }

  write(input: string | TextBlock): void {
    if (this.silent) return;
    const text = typeof input === 'string' ? input : input.text;
    if (!text) return;
    const rendered = renderMarkdown(text);
    this.out.write(rendered);
    this.lineStart = rendered.endsWith('\n');
  }

  writeLine(text = ''): void {
    if (this.silent) return;
    if (!this.lineStart) this.out.write('\n');
    if (text) this.out.write(`${text}\n`);
    else this.out.write('\n');
    this.lineStart = true;
  }

  writeBlock(block: ContentBlock): void {
    if (this.silent) return;
    if (block.type === 'text') {
      this.write(block);
    } else if (block.type === 'tool_use') {
      this.writeToolCall(block.name, block.input);
    } else if (block.type === 'tool_result') {
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      this.writeToolResult('result', text, !!block.is_error);
    }
  }

  writeToolCall(name: string, input: unknown): void {
    if (this.silent) return;
    if (!this.lineStart) this.out.write('\n');
    const arrow = theme.primary('→');
    const display = formatInputSummary(input);
    this.out.write(`${arrow} ${theme.bold(name)}${display ? color.dim(` ${display}`) : ''}\n`);
    this.lineStart = true;
  }

  writeToolResult(name: string, content: unknown, isError: boolean): void {
    if (this.silent) return;
    const txt = typeof content === 'string' ? content : safeStringify(content);
    const prefix = isError ? theme.error('✘') : theme.success('✓');

    if (isError) {
      const firstLine = txt.split('\n')[0] ?? '';
      const truncated = firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine;
      this.out.write(`  ${prefix} ${color.dim(truncated)}\n`);
      this.lineStart = true;
      return;
    }

    // Tool-specific rendering.
    const isEditLike = name === 'edit' || name === 'write';
    const isReadLike = name === 'read' || name === 'grep' || name === 'glob' || name === 'bash';
    const previewLines = isEditLike ? 0 : isReadLike ? 6 : 2;

    // Edit-like tools: pull the embedded diff if present.
    const diff = extractDiff(content);
    if (isEditLike && diff) {
      this.out.write(`  ${prefix} ${color.dim(summarize(content, name))}\n`);
      const rendered = renderDiff(diff)
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n');
      this.out.write(`${rendered}\n`);
      this.lineStart = true;
      return;
    }

    // Generic preview: show up to N lines, then "+X more" if truncated.
    const lines = txt.split('\n');
    const head = lines.slice(0, previewLines).map((l: string) => l.replace(/\s+$/, ''));
    const moreCount = Math.max(0, lines.length - head.length);
    this.out.write(`  ${prefix} ${color.dim(summarize(content, name))}\n`);
    for (const l of head) {
      const capped = l.length > 200 ? `${l.slice(0, 197)}…` : l;
      this.out.write(`      ${color.dim(capped)}\n`);
    }
    if (moreCount > 0) {
      this.out.write(`      ${color.dim(`+${moreCount} more line${moreCount === 1 ? '' : 's'}`)}\n`);
    }
    this.lineStart = true;
  }

  writeDiff(diff: string): void {
    if (this.silent) return;
    if (!this.lineStart) this.out.write('\n');
    this.out.write(`${renderDiff(diff)}\n`);
    this.lineStart = true;
  }

  writeWarning(text: string): void {
    this.err.write(`${theme.warn('⚠')} ${text}\n`);
  }
  writeError(text: string): void {
    this.err.write(`${theme.error('✘')} ${text}\n`);
  }
  writeInfo(text: string): void {
    this.err.write(`${theme.info('ℹ')} ${text}\n`);
  }

  clear(): void {
    if (this.silent) return;
    this.out.write('\x1b[2J\x1b[H');
    this.lineStart = true;
  }
}

function renderMarkdown(s: string): string {
  let out = s;
  // Headings
  out = out.replace(/^(#{1,6}) (.+)$/gm, (_m, hashes, text) => {
    return theme.primary(theme.bold(`${hashes} ${text}`));
  });
  // Fenced code
  out = out.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    return color.gray(`\n┌─\n${code.replace(/^/gm, '│ ')}└─`);
  });
  // Inline code
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => theme.accent(code));
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, (_m, text) => theme.bold(text));
  // Italic — single-asterisk
  out = out.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, (_m, l, t, r) => `${l}${color.italic(t)}${r}`);
  return out;
}

function formatInputSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  if (typeof obj['path'] === 'string') return obj['path'] as string;
  if (typeof obj['url'] === 'string') return obj['url'] as string;
  if (typeof obj['command'] === 'string') {
    const cmd = obj['command'] as string;
    return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
  }
  if (typeof obj['pattern'] === 'string') return obj['pattern'] as string;
  return '';
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * If the tool result is an object with a `diff` field (e.g. from the edit
 * tool), return that. If it's a string containing a unified diff header,
 * return it as-is. Otherwise return null and the caller falls back to a
 * generic preview.
 */
function extractDiff(value: unknown): string | null {
  if (typeof value === 'object' && value !== null) {
    const d = (value as { diff?: unknown }).diff;
    if (typeof d === 'string' && d.length > 0) return d;
  }
  if (typeof value === 'string') {
    // The agent serialises tool results to JSON before handing them to the
    // renderer, so a string `{"diff": "..."}` is the common case. Try parsing.
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(value) as { diff?: unknown };
        if (typeof parsed.diff === 'string' && parsed.diff.length > 0) {
          return parsed.diff;
        }
      } catch {
        // fall through
      }
    }
    if (/^---[^\n]*\n\+\+\+/m.test(value)) return value;
  }
  return null;
}

/**
 * Short summary shown next to the ✓: file path + count for edit, line count
 * for read/grep, etc. Falls back to nothing if the shape isn't recognised.
 */
function summarize(value: unknown, name: string): string {
  // Tool results arrive at the renderer already serialised to a JSON string.
  // Re-parse so we can pull out structured fields. Falls back to the raw value
  // for tools that return plain strings.
  let v: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        v = JSON.parse(value);
      } catch {
        // not JSON — leave as string
      }
    }
  }
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    if (name === 'edit') {
      const path = typeof o['path'] === 'string' ? (o['path'] as string) : '';
      const reps = typeof o['replacements'] === 'number' ? (o['replacements'] as number) : 0;
      return `${path}  ${reps} replacement${reps === 1 ? '' : 's'}`.trim();
    }
    if (name === 'write') {
      const path = typeof o['path'] === 'string' ? (o['path'] as string) : '';
      const bytes = typeof o['bytes'] === 'number' ? (o['bytes'] as number) : undefined;
      return bytes !== undefined ? `${path}  ${bytes}B` : path;
    }
    if (typeof o['count'] === 'number') {
      return `${o['count']} match${o['count'] === 1 ? '' : 'es'}`;
    }
  }
  return '';
}

