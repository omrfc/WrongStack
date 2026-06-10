import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogLevel, Logger } from '../types/logger.js';
import { color } from '../utils/color.js';
import { writeErr } from '../utils/term.js';

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const COLORS: Record<LogLevel, (s: string) => string> = {
  error: color.red,
  warn: color.yellow,
  info: color.cyan,
  debug: color.gray,
  trace: color.dim,
};

const LOG_LEVELS = new Set<LogLevel>(['error', 'warn', 'info', 'debug', 'trace']);
const LOG_FORMATS = new Set<string>(['pretty', 'json']);

export type LogFormat = 'pretty' | 'json';

export interface DefaultLoggerOptions {
  level?: LogLevel | undefined;
  file?: string | undefined;
  /**
   * @deprecated Use `format: 'json'` instead. Kept for backward compat
   * with existing callers but has no effect on output — the `format`
   * option controls whether stderr receives pretty-printed or JSON lines.
   */
  pretty?: boolean | undefined;
  /** Output format for stderr. `pretty` (colored, human-readable) or `json` (machine-parseable). Defaults to `WRONGSTACK_LOG_FORMAT` env var, falling back to `pretty`. */
  format?: LogFormat | undefined;
  bindings?: Record<string, unknown>;
  /**
   * When false, suppress stderr output entirely — only write to the log
   * file (if configured). Use this in TUI mode so plugin/library log
   * messages don't interleave with Ink's terminal rendering.
   * Default: true (stderr output is enabled).
   */
  stderr?: boolean | undefined;
}

export class DefaultLogger implements Logger {
  level: LogLevel;
  private readonly file?: string | undefined;
  private readonly bindings: Record<string, unknown>;
  private readonly format: LogFormat;
  private readonly stderr: boolean;

  constructor(opts: DefaultLoggerOptions = {}) {
    this.level = opts.level ?? parseLogLevel(process.env.WRONGSTACK_LOG_LEVEL);
    this.file = opts.file;
    this.bindings = opts.bindings ?? {};
    this.format = opts.format ?? parseLogFormat(process.env.WRONGSTACK_LOG_FORMAT);
    this.stderr = opts.stderr !== false; // default true
    if (this.file) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
      } catch {
        // best-effort
      }
    }
  }

  error(msg: string, ctx?: unknown): void {
    this.log('error', msg, ctx);
  }
  warn(msg: string, ctx?: unknown): void {
    this.log('warn', msg, ctx);
  }
  info(msg: string, ctx?: unknown): void {
    this.log('info', msg, ctx);
  }
  debug(msg: string, ctx?: unknown): void {
    this.log('debug', msg, ctx);
  }
  trace(msg: string, ctx?: unknown): void {
    this.log('trace', msg, ctx);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new DefaultLogger({
      level: this.level,
      file: this.file,
      format: this.format,
      stderr: this.stderr,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  private log(level: LogLevel, msg: string, ctx?: unknown): void {
    const r = LEVEL_RANK[level];
    const allowed = LEVEL_RANK[this.level];
    if (r > allowed) return;
    const ts = new Date().toISOString();
    const entry: Record<string, unknown> = { ts, level, msg, ...this.bindings };
    if (ctx !== undefined) {
      entry.ctx = ctx instanceof Error ? { message: ctx.message, stack: ctx.stack } : ctx;
    }
    // Disk: JSON line
    if (this.file) {
      try {
        fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
      } catch {
        // ignore
      }
    }
    // Stderr: pretty or json. Suppressed when this.stderr is false (TUI mode)
    // so plugin/library log messages don't interleave with Ink's rendering.
    if (!this.stderr) return;
    if (this.format === 'json') {
      writeErr(`${JSON.stringify(entry)}\n`);
    } else {
      const head = `${color.dim(ts)} ${COLORS[level](level.toUpperCase().padEnd(5))} ${msg}`;
      if (ctx !== undefined) {
        writeErr(`${head} ${formatCtx(ctx)}\n`);
      } else {
        writeErr(`${head}\n`);
      }
    }
  }
}

function parseLogLevel(raw: string | undefined): LogLevel {
  return raw && LOG_LEVELS.has(raw as LogLevel) ? (raw as LogLevel) : 'info';
}

function parseLogFormat(raw: string | undefined): LogFormat {
  return raw && LOG_FORMATS.has(raw) ? (raw as LogFormat) : 'pretty';
}

function formatCtx(ctx: unknown): string {
  if (ctx instanceof Error) return color.dim(ctx.message);
  if (typeof ctx === 'string') return color.dim(ctx);
  try {
    return color.dim(JSON.stringify(ctx));
  } catch {
    return color.dim(String(ctx));
  }
}

/**
 * A logger that silently discards all messages. Used during boot before
 * the real logger is configured, and in test contexts where logging
 * would be noise.
 */
export const noOpLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  child: () => noOpLogger,
};
