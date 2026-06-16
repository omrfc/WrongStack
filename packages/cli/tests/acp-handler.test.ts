/**
 * Tests for the `wstack acp` subcommand handler.
 *
 * The handler has two top-level concerns:
 *  1. Argument parsing & dispatch (list / spawn / parallel / help / server).
 *  2. For `parallel`, fanning a task out to multiple ACP agents concurrently
 *     and rendering the aggregate result.
 *
 * The actual ACP runner (`@wrongstack/acp`) is heavy — it spawns child
 * processes, opens stdio JSON-RPC, talks to LLM providers. We mock it
 * and assert on the dispatch / aggregation logic in this CLI layer.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock @wrongstack/acp — we don't want to spawn real agents in unit tests.
const makeACPSubagentRunnerWithStop = vi.fn();
const ensembleList = vi.fn();
vi.mock('@wrongstack/acp', () => ({
  makeACPSubagentRunnerWithStop: (...a: unknown[]) => makeACPSubagentRunnerWithStop(...a),
  EnsembleRegistry: class {
    list = ensembleList;
  },
  ACP_AGENT_COMMANDS: {
    'claude-code': { command: 'claude', args: [], role: 'claude-code' },
    'gemini-cli': { command: 'gemini', args: [], role: 'gemini-cli' },
    'codex-cli': { command: 'codex', args: [], role: 'codex-cli' },
  },
}));
vi.mock('@wrongstack/acp/agent', () => ({
  WrongStackACPServer: class {
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn();
  },
}));

import { acpCmd } from '../src/subcommands/handlers/acp.js';

function fakeDeps() {
  return {
    config: {} as never,
    renderer: {
      write: vi.fn(),
      writeError: vi.fn(),
      writeInfo: vi.fn(),
      writeWarning: vi.fn(),
    },
    reader: { readLine: vi.fn() },
    modelsRegistry: {},
    vault: {},
    paths: { globalConfig: '/tmp/cfg.json' },
    cwd: '/tmp',
    projectRoot: '/tmp',
    userHome: '/tmp',
    flags: {},
  } as unknown as Parameters<typeof acpCmd>[1];
}

function flattenWriteCalls(deps: ReturnType<typeof fakeDeps>): string {
  return (deps.renderer.write as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0])
    .join('');
}
function flattenWriteInfoCalls(deps: ReturnType<typeof fakeDeps>): string {
  return (deps.renderer.writeInfo as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0])
    .join('');
}
function flattenWriteErrorCalls(deps: ReturnType<typeof fakeDeps>): string {
  return (deps.renderer.writeError as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0])
    .join('');
}
function flattenWriteWarningCalls(deps: ReturnType<typeof fakeDeps>): string {
  return (deps.renderer.writeWarning as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0])
    .join('');
}

/** Mock `makeACPSubagentRunnerWithStop` to return a runner that resolves to a fixed result. */
function mockRunnerPerAgent(
  results: Record<string, { status: 'success' | 'failed'; result?: unknown; error?: { kind: string; message: string }; iterations?: number; toolCalls?: number }>,
) {
  makeACPSubagentRunnerWithStop.mockImplementation(async (cmd: { role?: string }) => {
    const id = cmd.role!;
    const r = results[id] ?? { status: 'failed', error: { kind: 'unknown', message: 'no mock for ' + id } };
    // The runner throws a structured error for failed agents, resolves for successes.
    const runner = vi.fn().mockImplementation(async () => {
      if (r.status === 'failed') {
        throw { kind: r.error?.kind ?? 'unknown', message: r.error?.message ?? 'failed' };
      }
      return {
        result: r.result,
        iterations: r.iterations ?? 0,
        toolCalls: r.toolCalls ?? 0,
      };
    });
    return { runner, stop: vi.fn() };
  });
}

beforeEach(() => {
  makeACPSubagentRunnerWithStop.mockReset();
  ensembleList.mockReset();
});

describe('acpCmd — dispatch', () => {
  it('shows help for `acp help`', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['help'], deps);
    expect(code).toBe(0);
    const out = flattenWriteCalls(deps);
    expect(out).toContain('wstack acp — ACP');
    expect(out).toContain('wstack acp parallel');
    expect(out).toContain('wstack acp spawn');
  });

  it('returns 1 for an unknown subcommand', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['nonsense'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('Unknown acp subcommand');
  });

  it('shows detected agents for `acp list`', async () => {
    ensembleList.mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', installed: true, version: '2.1.178' },
      { id: 'gemini-cli', displayName: 'Gemini CLI', installed: true, version: '0.45.1' },
      { id: 'goose', displayName: 'Goose', installed: false, reason: 'binary not found' },
    ]);
    const deps = fakeDeps();
    const code = await acpCmd(['list'], deps);
    expect(code).toBe(0);
    const out = flattenWriteCalls(deps);
    expect(out).toContain('claude-code');
    expect(out).toContain('gemini-cli');
    expect(out).toContain('2.1.178');
    expect(out).toContain('2 of 3 agents available');
  });
});

describe('acpCmd — parallel', () => {
  it('returns 1 with usage when no args', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['parallel'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('Usage: wstack acp parallel');
  });

  it('returns 1 when csv given but no task', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['parallel', 'claude-code,gemini-cli'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('Task description is required');
  });

  it('skips missing agents and runs the installed ones, returning 0 on at-least-one success', async () => {
    ensembleList.mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', installed: true },
      { id: 'gemini-cli', displayName: 'Gemini CLI', installed: true },
      { id: 'goose', displayName: 'Goose', installed: false, reason: 'not installed' },
    ]);
    mockRunnerPerAgent({
      'claude-code': { status: 'success', result: 'fix applied', iterations: 3, toolCalls: 5 },
      'gemini-cli': { status: 'success', result: 'no changes needed', iterations: 2, toolCalls: 1 },
    });

    const deps = fakeDeps();
    const code = await acpCmd(['parallel', 'claude-code,gemini-cli,goose', 'review diff'], deps);
    expect(code).toBe(0);

    const info = flattenWriteInfoCalls(deps);
    const warn = flattenWriteWarningCalls(deps);
    const out = flattenWriteCalls(deps);

    expect(warn).toContain('goose');
    expect(warn).toContain('not installed');
    expect(info).toContain('claude-code');
    expect(info).toContain('gemini-cli');
    expect(info).toContain('review diff');
    expect(out).toContain('=== claude-code ===');
    expect(out).toContain('=== gemini-cli ===');
    expect(out).toContain('fix applied');
    expect(out).toContain('no changes needed');
    expect(out).toContain('Parallel summary: 2 succeeded, 0 failed, 1 skipped');
  });

  it('returns 1 when ALL agents fail', async () => {
    ensembleList.mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', installed: true },
      { id: 'gemini-cli', displayName: 'Gemini CLI', installed: true },
    ]);
    mockRunnerPerAgent({
      'claude-code': { status: 'failed', error: { kind: 'bridge_failed', message: 'spawn failed' } },
      'gemini-cli': { status: 'failed', error: { kind: 'timeout', message: 'timed out' } },
    });
    const deps = fakeDeps();
    const code = await acpCmd(['parallel', 'claude-code,gemini-cli', 'do thing'], deps);
    expect(code).toBe(1);
    const out = flattenWriteCalls(deps);
    const err = flattenWriteErrorCalls(deps);
    expect(out).toContain('0 succeeded, 2 failed, 0 skipped');
    expect(err).toContain('bridge_failed');
    expect(err).toContain('timeout');
  });

  it('returns 1 when none of the requested agents are installed', async () => {
    ensembleList.mockResolvedValue([
      { id: 'goose', displayName: 'Goose', installed: false, reason: 'not installed' },
      { id: 'openhands', displayName: 'OpenHands', installed: false, reason: 'not installed' },
    ]);
    const deps = fakeDeps();
    const code = await acpCmd(['parallel', 'goose,openhands', 'task'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('No installed agents to run');
    expect(makeACPSubagentRunnerWithStop).not.toHaveBeenCalled();
  });

  it('dedupes ids in the csv', async () => {
    ensembleList.mockResolvedValue([
      { id: 'claude-code', displayName: 'Claude Code', installed: true },
    ]);
    mockRunnerPerAgent({
      'claude-code': { status: 'success', result: 'ok', iterations: 1, toolCalls: 0 },
    });
    const deps = fakeDeps();
    const code = await acpCmd(['parallel', 'claude-code,claude-code,claude-code', 'task'], deps);
    expect(code).toBe(0);
    expect(makeACPSubagentRunnerWithStop).toHaveBeenCalledTimes(1);
  });
});

describe('acpCmd — spawn', () => {
  it('returns 1 with usage when no agent id', async () => {
    const deps = fakeDeps();
    const code = await acpCmd(['spawn'], deps);
    expect(code).toBe(1);
    expect(flattenWriteErrorCalls(deps)).toContain('Usage: wstack acp spawn');
  });

  it('runs a single agent and renders the result', async () => {
    mockRunnerPerAgent({
      'claude-code': { status: 'success', result: 'analysis complete', iterations: 4, toolCalls: 7 },
    });
    const deps = fakeDeps();
    const code = await acpCmd(['spawn', 'claude-code', 'explain this code'], deps);
    expect(code).toBe(0);
    const out = flattenWriteCalls(deps);
    const info = flattenWriteInfoCalls(deps);
    expect(out).toContain('analysis complete');
    expect(info).toContain('iterations=4');
    expect(info).toContain('toolCalls=7');
  });

  it('returns 1 with the error kind when the runner throws', async () => {
    makeACPSubagentRunnerWithStop.mockImplementation(async () => {
      return {
        runner: vi.fn().mockRejectedValue({
          kind: 'bridge_failed',
          message: 'agent crashed',
        }),
        stop: vi.fn(),
      };
    });
    const deps = fakeDeps();
    const code = await acpCmd(['spawn', 'claude-code', 'do thing'], deps);
    expect(code).toBe(1);
    const err = flattenWriteErrorCalls(deps);
    expect(err).toContain('[bridge_failed]');
    expect(err).toContain('agent crashed');
  });
});
