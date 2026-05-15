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
});
