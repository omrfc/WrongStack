import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultLogger } from '../../src/index.js';

describe('DefaultLogger', () => {
  let tmp: string;
  let stderrWrites: string[];
  let origWrite: typeof process.stderr.write;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-log-'));
    stderrWrites = [];
    origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = origWrite;
    await fsp.rm(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes JSON lines to file', () => {
    const logFile = path.join(tmp, 'app.log');
    const log = new DefaultLogger({ level: 'debug', file: logFile });
    log.info('hello', { x: 1 });
    log.debug('details');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.msg).toBe('hello');
    expect(first.ctx).toEqual({ x: 1 });
    expect(first.level).toBe('info');
  });

  it('honours level threshold', () => {
    const log = new DefaultLogger({ level: 'warn' });
    log.info('skipped');
    log.warn('included');
    expect(stderrWrites.join('')).toContain('included');
    expect(stderrWrites.join('')).not.toContain('skipped');
  });

  it('child inherits bindings', () => {
    const logFile = path.join(tmp, 'c.log');
    const log = new DefaultLogger({ level: 'info', file: logFile, bindings: { app: 'x' } });
    const child = log.child({ comp: 'y' });
    child.info('m');
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    expect(entry.app).toBe('x');
    expect(entry.comp).toBe('y');
  });

  it('serialises Error context to message+stack', () => {
    const logFile = path.join(tmp, 'e.log');
    const log = new DefaultLogger({ level: 'error', file: logFile });
    log.error('boom', new Error('inner'));
    const entry = JSON.parse(fs.readFileSync(logFile, 'utf8').trim());
    expect(entry.ctx.message).toBe('inner');
    expect(typeof entry.ctx.stack).toBe('string');
  });

  // ── format: 'json' stderr output ────────────────────────────────────────

  it('format: json writes valid JSON lines to stderr', () => {
    const log = new DefaultLogger({ level: 'debug', format: 'json' });
    log.info('hello', { x: 1 });
    log.debug('details');
    expect(stderrWrites).toHaveLength(2);
    const info = JSON.parse(stderrWrites[0]!);
    expect(info.level).toBe('info');
    expect(info.msg).toBe('hello');
    expect(info.ctx).toEqual({ x: 1 });
    expect(typeof info.ts).toBe('string');
    const debug = JSON.parse(stderrWrites[1]!);
    expect(debug.level).toBe('debug');
    expect(debug.msg).toBe('details');
  });

  it('format: json respects level threshold for stderr', () => {
    const log = new DefaultLogger({ level: 'warn', format: 'json' });
    log.info('skipped');
    log.warn('included');
    expect(stderrWrites).toHaveLength(1);
    const entry = JSON.parse(stderrWrites[0]!);
    expect(entry.msg).toBe('included');
    expect(entry.level).toBe('warn');
  });

  it('format: json child logger inherits format and merges bindings in stderr', () => {
    const log = new DefaultLogger({ level: 'info', format: 'json', bindings: { app: 'x' } });
    const child = log.child({ comp: 'y' });
    child.info('m');
    expect(stderrWrites).toHaveLength(1);
    const entry = JSON.parse(stderrWrites[0]!);
    expect(entry.app).toBe('x');
    expect(entry.comp).toBe('y');
    expect(entry.msg).toBe('m');
  });

  it('format: json serialises Error context to stderr JSON', () => {
    const log = new DefaultLogger({ level: 'error', format: 'json' });
    log.error('boom', new Error('inner'));
    expect(stderrWrites).toHaveLength(1);
    const entry = JSON.parse(stderrWrites[0]!);
    expect(entry.level).toBe('error');
    expect(entry.msg).toBe('boom');
    expect(entry.ctx.message).toBe('inner');
    expect(typeof entry.ctx.stack).toBe('string');
  });

  it('default format is pretty (not JSON on stderr)', () => {
    const log = new DefaultLogger({ level: 'info' });
    log.info('hello');
    expect(stderrWrites).toHaveLength(1);
    // Pretty-printed lines start with the timestamp, not a JSON object
    expect(stderrWrites[0]).not.toContain('{"ts"');
    expect(stderrWrites[0]).toContain('hello');
  });
});
