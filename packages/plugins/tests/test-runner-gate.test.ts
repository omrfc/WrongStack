import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock execSync and fs before importing the plugin.
const mockExecSync = vi.fn((cmd: string): string => {
  if (cmd.includes('--reporter=json')) {
    // Simulate test failure
    return JSON.stringify({
      numTotalTests: 3,
      numPassedTests: 2,
      numFailedTests: 1,
      success: false,
      testResults: [{
        assertionResults: [
          { status: 'passed', title: 'test A' },
          { status: 'passed', title: 'test B' },
          { status: 'failed', title: 'test C', fullName: 'test C', failureMessages: ['Expected 1 got 2'] },
        ],
      }],
    });
  }
  return '';
});

vi.mock('node:child_process', () => ({ execSync: mockExecSync }));
vi.mock('node:fs', () => ({ existsSync: vi.fn(() => true) }));

const testRunnerGatePlugin = (await import('../src/test-runner-gate')).default;

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  metrics: { counter: ReturnType<typeof vi.fn>; histogram: ReturnType<typeof vi.fn>; gauge: ReturnType<typeof vi.fn> };
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  emitCustom: ReturnType<typeof vi.fn>;
  session: { append: ReturnType<typeof vi.fn> };
}

function makeApi(overrides: { extensions?: Record<string, unknown> } = {}): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onEvent: vi.fn(),
    emitCustom: vi.fn(),
    session: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

function getHook(api: MockApi): (input: unknown) => { additionalContext?: string } | void {
  const call = api.registerHook.mock.calls[0];
  if (!call) throw new Error('hook not registered');
  return (call as unknown[])[2] as ReturnType<typeof getHook>;
}

function getStatusTool(api: MockApi): { execute: (input: unknown) => Promise<unknown> } {
  const call = api.tools.register.mock.calls.find(([t]: unknown[]) => (t as { name: string }).name === 'test_gate_status');
  if (!call) throw new Error('test_gate_status not registered');
  return (call[0] as { execute: (input: unknown) => Promise<unknown> });
}

beforeEach(() => vi.clearAllMocks());

describe('test-runner-gate plugin', () => {
  it('registers test_gate_status tool and a PostToolUse hook', () => {
    const api = makeApi();
    testRunnerGatePlugin.setup(api as never);
    expect(api.tools.register).toHaveBeenCalledTimes(1);
    expect(api.registerHook).toHaveBeenCalledTimes(1);
    const [event, matcher] = api.registerHook.mock.calls[0]!;
    expect(event).toBe('PostToolUse');
    expect(matcher).toBe('write|edit');
  });
});

describe('hook behavior', () => {
  it('injects failure context when tests fail', () => {
    const api = makeApi();
    testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('test-runner-gate');
    expect(result?.additionalContext).toContain('FAILED');
    expect(result?.additionalContext).toContain('test C');
  });

  it('stays silent when tool errored', () => {
    const api = makeApi();
    testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'err', isError: true },
    })).toBeUndefined();
  });

  it('stays silent when enabled=false', () => {
    const api = makeApi({ extensions: { 'test-runner-gate': { enabled: false } } });
    testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    })).toBeUndefined();
  });

  it('stays silent when path is missing', () => {
    const api = makeApi();
    testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({
      toolName: 'write',
      toolInput: { content: 'x' },
      toolResult: { content: 'ok', isError: false },
    })).toBeUndefined();
  });

  it('skips test files themselves', () => {
    const api = makeApi();
    testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    expect(hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.test.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    })).toBeUndefined();
  });
});

describe('pass injection', () => {
  it('injects success context when injectOnPass=true', () => {
    // Override mock to return passing tests
    mockExecSync.mockImplementation((cmd: string): string => {
      if (cmd.includes('--reporter=json')) {
        return JSON.stringify({
          numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, success: true,
          testResults: [],
        });
      }
      return '';
    });

    const api = makeApi({ extensions: { 'test-runner-gate': { injectOnPass: true } } });
    testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'edit',
      toolInput: { path: 'src/foo.ts', old_string: 'a', new_string: 'b' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result?.additionalContext).toContain('passed');

    // Restore failure mock
    mockExecSync.mockImplementation((cmd: string): string => {
      if (cmd.includes('--reporter=json')) {
        return JSON.stringify({
          numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, success: false,
          testResults: [{ assertionResults: [{ status: 'failed', title: 'x', fullName: 'x', failureMessages: ['err'] }] }],
        });
      }
      return '';
    });
  });

  it('stays silent on pass when injectOnPass=false (default)', () => {
    mockExecSync.mockImplementation((cmd: string): string => {
      if (cmd.includes('--reporter=json')) {
        return JSON.stringify({
          numTotalTests: 3, numPassedTests: 3, numFailedTests: 0, success: true,
          testResults: [],
        });
      }
      return '';
    });

    const api = makeApi();
    testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    const result = hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    expect(result).toBeUndefined();

    // Restore
    mockExecSync.mockImplementation((cmd: string): string => {
      if (cmd.includes('--reporter=json')) {
        return JSON.stringify({
          numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, success: false,
          testResults: [{ assertionResults: [{ status: 'failed', title: 'x', fullName: 'x', failureMessages: ['err'] }] }],
        });
      }
      return '';
    });
  });
});

describe('status tool', () => {
  it('reports config + counters', async () => {
    const api = makeApi();
    testRunnerGatePlugin.setup(api as never);
    const status = await getStatusTool(api).execute({});
    expect(status.enabled).toBe(true);
    expect(status.command).toBe('npx vitest run');
    expect(status.counters.invocations).toBe(0);
  });
});

describe('teardown + H1 pattern', () => {
  it('logs completion line and does not throw', () => {
    const api = makeApi();
    testRunnerGatePlugin.setup(api as never);
    expect(() => testRunnerGatePlugin.teardown!(api as never)).not.toThrow();
    expect(api.log.info).toHaveBeenCalledWith('test-runner-gate: teardown complete', expect.any(Object));
  });

  it('zeros counters on teardown', async () => {
    const api = makeApi();
    testRunnerGatePlugin.setup(api as never);
    const hook = getHook(api);
    hook({
      toolName: 'write',
      toolInput: { path: 'src/foo.ts', content: 'x' },
      toolResult: { content: 'ok', isError: false },
    });
    testRunnerGatePlugin.teardown!(api as never);
    const health = await testRunnerGatePlugin.health!();
    expect(health.counters.invocations).toBe(0);
  });

  it('teardown is safe before setup (defensive)', () => {
    const api = makeApi();
    expect(() => testRunnerGatePlugin.teardown!(api as never)).not.toThrow();
  });
});
