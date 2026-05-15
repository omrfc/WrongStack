import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogLevel, Logger } from '../types/logger.js';
import { color } from '../utils/color.js';

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

export interface DefaultLoggerOptions {
  level?: LogLevel;
  file?: string;
  pretty?: boolean;
  bindings?: Record<string, unknown>;
}

export class DefaultLogger implements Logger {
  level: LogLevel;
  private readonly file?: string;
  private readonly bindings: Record<string, unknown>;
  private readonly pretty: boolean;

  constructor(opts: DefaultLoggerOptions = {}) {
    this.level = opts.level ?? (process.env.WRONGSTACK_LOG_LEVEL as LogLevel) ?? 'info';
    this.file = opts.file;
    this.bindings = opts.bindings ?? {};
    this.pretty = opts.pretty ?? true;
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
      pretty: this.pretty,
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
    // Stderr: pretty or json
    if (r <= LEVEL_RANK.warn || this.level === 'debug' || this.level === 'trace') {
      const head = `${color.dim(ts)} ${COLORS[level](level.toUpperCase().padEnd(5))} ${msg}`;
      if (ctx !== undefined) {
        process.stderr.write(`${head} ${formatCtx(ctx)}\n`);
      } else {
        process.stderr.write(`${head}\n`);
      }
    }
  }
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
