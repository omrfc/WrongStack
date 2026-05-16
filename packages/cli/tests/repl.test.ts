import type {
  Agent,
  AttachmentStore,
  Context,
  RunResult,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { AgentError } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';
import { runRepl } from '../src/repl.js';

function makeFakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    ctx: {} as Context,
    run: vi.fn(
      async (): Promise<RunResult> => ({ status: 'done', iterations: 1, finalText: 'ok' }),
    ),
    ...overrides,
  } as unknown as Agent;
}

function makeFakeReader(lines: string[]): ReadlineInputReader {
  let i = 0;
  return {
    // Real readers throw on EOF (Ctrl+D); the REPL relies on that to break
    // its read loop. Returning '' instead would skip-empty and spin forever
    // → V8 heap exhaustion in CI. Throw once the script is exhausted.
    readLine: vi.fn(async () => {
      if (i >= lines.length) throw new Error('EOF');
      return lines[i++] ?? '';
    }),
    close: vi.fn(async () => {}),
  };
}

function makeFakeRenderer(): TerminalRenderer {
  return {
    write: vi.fn(),
    writeLine: vi.fn(),
    writeBlock: vi.fn(),
    writeToolCall: vi.fn(),
    writeToolResult: vi.fn(),
    writeDiff: vi.fn(),
    writeWarning: vi.fn(),
    writeError: vi.fn(),
    writeInfo: vi.fn(),
    clear: vi.fn(),
    render: vi.fn(),
  } as unknown as TerminalRenderer;
}

function makeFakeSlashRegistry(): SlashCommandRegistry {
  return {
    dispatch: vi.fn(async () => null),
    register: vi.fn(),
    unregister: vi.fn(),
    list: vi.fn(() => []),
    resolve: vi.fn(),
  } as unknown as SlashCommandRegistry;
}

function makeFakeAttachmentStore(): AttachmentStore {
  return {
    add: vi.fn(async () => 'fake-id'),
    get: vi.fn(async () => undefined),
    list: vi.fn(() => []),
    remove: vi.fn(async () => {}),
    resolve: vi.fn(),
    clear: vi.fn(async () => {}),
    // expand turns "[pasted #N]" placeholders into ContentBlock[]. For tests
    // we never insert placeholders, so a plain text-block passthrough is
    // sufficient and keeps the InputBuilder.submit path satisfied.
    expand: vi.fn(async (text: string) => [{ type: 'text', text }]),
  } as unknown as AttachmentStore;
}

function makeFakeTokenCounter(): TokenCounter {
  return {
    reset: vi.fn(),
    add: vi.fn(),
    total: vi.fn(() => ({ input: 100, output: 50, cached: 0 })),
    estimateCost: vi.fn(() => ({ total: 0.01, breakdown: {} })),
    snapshot: vi.fn(),
  } as unknown as TokenCounter;
}

describe('runRepl', () => {
  it('prints banner when banner option is true', async () => {
    const agent = makeFakeAgent();
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: true,
    });

    expect(renderer.write).toHaveBeenCalled();
    const firstWrite = (renderer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] ?? '';
    expect(firstWrite).toContain('WrongStack');
  });

  it('dispatches slash commands via registry', async () => {
    const agent = makeFakeAgent();
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['/help\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(slashRegistry.dispatch).toHaveBeenCalledWith('/help', agent.ctx);
  });

  it('runs agent with user input', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'done',
        iterations: 2,
        finalText: 'hello world',
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(run).toHaveBeenCalled();
  });

  it('uses the dynamic supportsVision resolver when routing image blocks', async () => {
    const image = {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: 'AAAA' },
    };
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'done',
        iterations: 1,
        finalText: 'ok',
      }),
    );
    const agent = makeFakeAgent({
      run,
      ctx: {
        provider: { id: 'p', capabilities: { vision: false } },
        model: 'm',
      } as unknown as Context,
    });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['see this\n']);
    const slashRegistry = makeFakeSlashRegistry();
    const supportsVision = vi.fn(async () => true);

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: {
        ...makeFakeAttachmentStore(),
        expand: vi.fn(async () => [image]),
      } as unknown as AttachmentStore,
      banner: false,
      supportsVision,
    });

    expect(supportsVision).toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith([image], expect.anything());
  });

  it('skips empty lines without running agent', async () => {
    const run = vi.fn();
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['', '', 'hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('shows token stats after agent run when tokenCounter provided', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'done',
        iterations: 1,
        finalText: 'result',
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();
    const tokenCounter = makeFakeTokenCounter();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
      tokenCounter,
      effectiveMaxContext: 200_000,
    });

    const writes = (renderer.write as ReturnType<typeof vi.fn>).mock.calls;
    const statsLine = writes.find(
      (c: unknown[]) => String(c[0] ?? '').includes('in:') && String(c[0] ?? '').includes('out:'),
    );
    expect(statsLine).toBeDefined();
  });

  it('writes error on agent failure', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'failed',
        error: new AgentError({ message: 'oops', code: 'AGENT_RUN_FAILED' }),
        iterations: 1,
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(renderer.writeError).toHaveBeenCalledWith(expect.stringContaining('oops'));
  });

  it('writes warning on aborted status', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'aborted',
        iterations: 0,
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(renderer.writeWarning).toHaveBeenCalledWith('Aborted.');
  });

  it('writes warning on max_iterations', async () => {
    const run = vi.fn(
      async (): Promise<RunResult> => ({
        status: 'max_iterations',
        iterations: 5,
      }),
    );
    const agent = makeFakeAgent({ run });
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['hello\n', '/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(renderer.writeWarning).toHaveBeenCalledWith(expect.stringContaining('max iterations'));
  });

  it('closes reader and returns 0 on /exit', async () => {
    const agent = makeFakeAgent();
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['/exit\n']);
    const slashRegistry = makeFakeSlashRegistry();

    const exitCode = await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(exitCode).toBe(0);
    expect(reader.close).toHaveBeenCalled();
  });

  it('returns 0 on EOF (Ctrl+D)', async () => {
    const agent = makeFakeAgent();
    const renderer = makeFakeRenderer();
    const reader = makeFakeReader(['']);
    const slashRegistry = makeFakeSlashRegistry();

    const exitCode = await runRepl({
      agent,
      renderer,
      reader,
      slashRegistry,
      attachments: makeFakeAttachmentStore(),
      banner: false,
    });

    expect(exitCode).toBe(0);
  });
});
