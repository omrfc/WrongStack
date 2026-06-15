import { describe, expect, it } from 'vitest';
import { spawnStream } from '../src/_spawn-stream.js';

const BOGUS = 'definitely-not-a-real-binary-xyz123';

async function drain(gen: ReturnType<typeof spawnStream>) {
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return value;
  }
}

describe('spawnStream edge cases', () => {
  it('reports a spawn error for a missing binary (no pid → finally SIGKILL path)', async () => {
    const result = await drain(
      spawnStream({
        cmd: BOGUS,
        args: [],
        cwd: process.cwd(),
        signal: new AbortController().signal,
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.error).toBeTruthy();
  });

  it('handles an already-aborted signal for a missing binary (no-pid abort path)', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await drain(
      spawnStream({ cmd: BOGUS, args: [], cwd: process.cwd(), signal: ac.signal }),
    );
    // Either the synthetic abort-close (124) or the spawn error (1) settles it;
    // the point is the no-pid kill branch runs without hanging.
    expect([1, 124]).toContain(result.exitCode);
  });

  it('applies backpressure on stdout when the queue fills (maxQueueSize=1)', async () => {
    const result = await drain(
      spawnStream({
        cmd: process.execPath,
        args: ['-e', "process.stdout.write('x'.repeat(2000))"],
        cwd: process.cwd(),
        signal: new AbortController().signal,
        maxQueueSize: 1,
      }),
    );
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  }, 15_000);

  it('applies backpressure on stderr when the queue fills (maxQueueSize=1)', async () => {
    const result = await drain(
      spawnStream({
        cmd: process.execPath,
        args: ['-e', "process.stderr.write('e'.repeat(2000))"],
        cwd: process.cwd(),
        signal: new AbortController().signal,
        maxQueueSize: 1,
      }),
    );
    expect(result.stderr.length).toBeGreaterThan(0);
  }, 15_000);

  it('aborts a running process mid-stream and settles via the synthetic close', async () => {
    const ac = new AbortController();
    const gen = spawnStream({
      cmd: process.execPath,
      args: ['-e', 'setInterval(()=>process.stdout.write("tick\\n"),5)'],
      cwd: process.cwd(),
      signal: ac.signal,
    });
    // Pull one event, then abort — the onAbort sentinel must wake the loop.
    await gen.next();
    ac.abort();
    const result = await drain(gen);
    expect(result).toHaveProperty('exitCode');
  }, 15_000);
});
