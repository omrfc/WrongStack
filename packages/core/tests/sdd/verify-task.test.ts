import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { makeCommandVerifier } from '../../src/sdd/verify-task.js';
import type { TaskNode } from '../../src/types/task-graph.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

// Minimal stand-ins — the verifier only reads `task.metadata`.
function task(metadata?: Record<string, unknown>): TaskNode {
  return { metadata } as unknown as TaskNode;
}
const result = {} as TaskResult;
const cwd = os.tmpdir();

describe('makeCommandVerifier', () => {
  it('passes through (ok) when the task carries no verification command', async () => {
    const verify = makeCommandVerifier();
    expect(await verify({ task: task(), result, cwd })).toEqual({ ok: true });
    expect(await verify({ task: task({ verificationCommand: '   ' }), result, cwd })).toEqual({ ok: true });
    expect(await verify({ task: task({ verificationCommand: 42 }), result, cwd })).toEqual({ ok: true });
  });

  it('resolves ok on exit 0', async () => {
    const verify = makeCommandVerifier();
    const out = await verify({ task: task({ verificationCommand: 'exit 0' }), result, cwd });
    expect(out.ok).toBe(true);
  });

  it('fails with a reason on non-zero exit', async () => {
    const verify = makeCommandVerifier();
    const out = await verify({ task: task({ verificationCommand: 'exit 3' }), result, cwd });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('exit 3');
    expect(out.reason).toContain('verification failed');
  });

  it('kills and fails on timeout', async () => {
    const verify = makeCommandVerifier({ timeoutMs: 150 });
    // node is guaranteed present; a long sleep exceeds the 150ms budget.
    const cmd = `node -e "setTimeout(()=>{}, 60000)"`;
    const out = await verify({ task: task({ verificationCommand: cmd }), result, cwd });
    expect(out.ok).toBe(false);
    expect(out.reason).toContain('timed out');
  });

  it('honours a custom metadata key', async () => {
    const verify = makeCommandVerifier({ metadataKey: 'check' });
    // The default key is ignored…
    expect(await verify({ task: task({ verificationCommand: 'exit 1' }), result, cwd })).toEqual({ ok: true });
    // …only the configured key runs.
    const out = await verify({ task: task({ check: 'exit 1' }), result, cwd });
    expect(out.ok).toBe(false);
  });
});
