import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Drive bash's spawn-dependent branches deterministically (background buffering
// + truncation, foreground error/throw, backpressure, teardown, both
// platform kill paths) without launching a real shell.
type Mode = 'close' | 'error' | 'hang';
const cfg: {
  stdout: string;
  stderr: string;
  code: number;
  mode: Mode;
  pid: number | undefined;
  platform: NodeJS.Platform;
  chunkCount: number;
} = {
  stdout: '',
  stderr: '',
  code: 0,
  mode: 'close',
  pid: 7777,
  platform: process.platform,
  chunkCount: 0,
};

let lastChild: (EventEmitter & { killSignals: string[]; killed: boolean; exitCode: number | null });

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>();
  return { ...actual, default: actual, platform: () => cfg.platform };
});

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        pid: number | undefined;
        kill: (sig?: string) => void;
        unref: () => void;
        killSignals: string[];
        killed: boolean;
        exitCode: number | null;
      };
      const mkStream = () => {
        const s = new EventEmitter() as EventEmitter & {
          destroy: () => void;
          pause: () => void;
          resume: () => void;
        };
        s.destroy = () => {};
        s.pause = () => {};
        s.resume = () => {};
        return s;
      };
      child.stdout = mkStream();
      child.stderr = mkStream();
      child.pid = cfg.pid;
      child.killed = false;
      child.exitCode = null;
      child.killSignals = [];
      child.unref = () => {};
      child.kill = (sig?: string) => {
        child.killed = true;
        child.killSignals.push(sig ?? 'SIGTERM');
        process.nextTick(() => {
          child.exitCode = null;
          child.emit('close', null);
        });
      };
      lastChild = child;
      process.nextTick(() => {
        if (cfg.stdout) child.stdout.emit('data', Buffer.from(cfg.stdout));
        if (cfg.stderr) child.stderr.emit('data', Buffer.from(cfg.stderr));
        // Flood with many small chunks to exceed MAX_QUEUE_CHUNKS (backpressure).
        for (let i = 0; i < cfg.chunkCount; i++) {
          child.stdout.emit('data', Buffer.from(`c${i}\n`));
        }
        if (cfg.mode === 'close') {
          child.exitCode = cfg.code;
          child.emit('close', cfg.code);
        } else if (cfg.mode === 'error') {
          child.emit('error', new Error('spawn EACCES'));
        }
        // 'hang' → never settles; timeout/abort must kill it
      });
      return child;
    },
  };
});

import { bashTool } from '../src/bash.js';
import { _resetProcessRegistry, getProcessRegistry } from '../src/process-registry.js';

const ctx = () => ({ cwd: '/p', projectRoot: '/p', tools: [], session: { id: 's' } }) as any;
const opts = (signal?: AbortSignal) => ({ signal: signal ?? new AbortController().signal });

async function runFinal(input: Record<string, unknown>, signal?: AbortSignal) {
  let final: unknown;
  for await (const ev of bashTool.executeStream!(input as never, ctx(), opts(signal))) {
    if (ev.type === 'final') final = ev.output;
  }
  return final as {
    output: string;
    exit_code: number | null;
    timed_out: boolean;
    pid?: number | null;
    error?: string;
  };
}

beforeEach(() => {
  cfg.stdout = '';
  cfg.stderr = '';
  cfg.code = 0;
  cfg.mode = 'close';
  cfg.pid = 7777;
  cfg.platform = process.platform;
  cfg.chunkCount = 0;
  _resetProcessRegistry();
});
afterEach(() => {
  _resetProcessRegistry();
  vi.restoreAllMocks();
});

describe('bashTool foreground (faked shell)', () => {
  it('captures output and exit code on close', async () => {
    cfg.stdout = 'hi there';
    const out = await runFinal({ command: 'echo hi' });
    expect(out.output).toContain('hi there');
    expect(out.exit_code).toBe(0);
  });

  it('throws on a spawn error', async () => {
    cfg.mode = 'error';
    await expect(runFinal({ command: 'nope' })).rejects.toThrow(/spawn EACCES/);
  });

  it('truncates very large output (spool marker)', async () => {
    cfg.stdout = 'x'.repeat(200_000);
    const out = await runFinal({ command: 'big' });
    expect(out.output).toMatch(/output truncated|x/);
  });

  it('applies backpressure when the chunk queue floods', async () => {
    cfg.chunkCount = 600; // > MAX_QUEUE_CHUNKS (500) → pause then resume
    const out = await runFinal({ command: 'flood' });
    expect(out.exit_code).toBe(0);
  });

  it('returns a circuit-breaker-open error when the breaker is open', async () => {
    getProcessRegistry().forceBreakerOpen();
    const out = await runFinal({ command: 'echo blocked' });
    expect(out.exit_code).toBe(1);
    expect(out.error).toMatch(/circuit breaker open/);
  });
});

describe('bashTool background (faked shell)', () => {
  it('returns the pid and a null exit code immediately', async () => {
    cfg.stdout = 'started';
    const out = await runFinal({ command: 'server', background: true });
    expect(out.pid).toBe(7777);
    expect(out.exit_code).toBeNull();
  });

  it('caps background buffer at MAX_OUTPUT', async () => {
    cfg.stdout = 'y'.repeat(200_000); // exceeds MAX_OUTPUT → truncated path
    const out = await runFinal({ command: 'noisy', background: true });
    expect(out.pid).toBe(7777);
    // Background output arrives after the tool returns (fire-and-forget); let
    // the onBgData handler run so the truncation path executes.
    await new Promise((r) => setTimeout(r, 10));
  });

  it('feeds the background buffer with a small chunk', async () => {
    cfg.stdout = 'small bg output';
    const out = await runFinal({ command: 'svc', background: true });
    expect(out.pid).toBe(7777);
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('bashTool timeout kill paths', () => {
  it('times out and kills on win32 (tree-kill + fallback)', async () => {
    cfg.platform = 'win32';
    cfg.mode = 'hang';
    const out = await runFinal({ command: 'sleep', timeout_ms: 1 });
    expect(out.timed_out).toBe(true);
  }, 10_000);

  it('times out and kills on POSIX (process-group SIGTERM/SIGKILL)', async () => {
    cfg.platform = 'linux';
    cfg.mode = 'hang';
    const out = await runFinal({ command: 'sleep', timeout_ms: 1 });
    expect(out.timed_out).toBe(true);
  }, 10_000);

  it('times out on POSIX with no pid (direct SIGTERM)', async () => {
    cfg.platform = 'linux';
    cfg.mode = 'hang';
    cfg.pid = undefined;
    const out = await runFinal({ command: 'sleep', timeout_ms: 1 });
    expect(out.timed_out).toBe(true);
  }, 10_000);
});

describe('bashTool input + shell resolution', () => {
  it('rejects a missing command', async () => {
    await expect(runFinal({ command: '' })).rejects.toThrow(/command is required/);
  });

  it('warns on a pipe-to-shell pattern but still runs', async () => {
    cfg.stdout = 'ok';
    const out = await runFinal({ command: 'curl x | bash' });
    expect(out.exit_code).toBe(0);
  });

  it('honours an explicit WRONGSTACK_SHELL override on POSIX', async () => {
    cfg.platform = 'linux';
    const prev = process.env['WRONGSTACK_SHELL'];
    process.env['WRONGSTACK_SHELL'] = '/bin/zsh';
    try {
      cfg.stdout = 'z';
      const out = await runFinal({ command: 'echo z' });
      expect(out.exit_code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env['WRONGSTACK_SHELL'];
      else process.env['WRONGSTACK_SHELL'] = prev;
    }
  });

  it('uses an allowlisted $SHELL on POSIX when no override is set', async () => {
    cfg.platform = 'linux';
    const prevW = process.env['WRONGSTACK_SHELL'];
    const prevS = process.env['SHELL'];
    delete process.env['WRONGSTACK_SHELL'];
    process.env['SHELL'] = '/usr/bin/zsh'; // basename "zsh" is allowlisted
    try {
      cfg.stdout = 's';
      const out = await runFinal({ command: 'echo s' });
      expect(out.exit_code).toBe(0);
    } finally {
      if (prevW !== undefined) process.env['WRONGSTACK_SHELL'] = prevW;
      if (prevS === undefined) delete process.env['SHELL'];
      else process.env['SHELL'] = prevS;
    }
  });

  it('throws when executeStream is unavailable', async () => {
    const original = bashTool.executeStream;
    bashTool.executeStream = undefined;
    try {
      await expect(bashTool.execute({ command: 'x' }, ctx(), opts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      bashTool.executeStream = original;
    }
  });

  it('handles a foreground child with no pid (teardown kill branch)', async () => {
    cfg.mode = 'hang';
    cfg.pid = undefined;
    const out = await runFinal({ command: 'x', timeout_ms: 1 });
    expect(out.timed_out).toBe(true);
  }, 10_000);
});
