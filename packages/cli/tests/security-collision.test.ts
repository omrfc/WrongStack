// Regression test for the /security slash-command collision.
//
// The CLI's built-in `/security` (packages/cli/src/slash-commands/security.ts)
// and the `wstack-security` plugin's `/security`
// (packages/core/src/security-scanner/slash-command.ts) BOTH register under
// the bare name `security`. Per SlashCommandRegistry semantics, an official
// plugin (the security scanner is marked official=true) keeps the bare name,
// so the plugin's command shadows the CLI built-in.
//
// In the TUI (a synchronous surface), the CLI built-in is the right
// behaviour: it prints dispatch instructions instead of kicking off an
// LLM-powered scan that takes minutes. Before the fix, typing `/security
// scan` in the TUI dispatched to the plugin's handleScan, which:
//   - returned the "requires an active LLM provider" message when the
//     provider was missing .complete, OR
//   - called defaultOrchestrator.run() and either hung, threw, or
//     eventually surfaced a giant scan report — neither matches the
//     expected synchronous "print dispatch instructions" behaviour.
//
// This test confirms the CLI built-in wins after the fix.
import {
  type Context,
  createSecurityPlugin,
  DefaultTokenCounter,
  HybridCompactor,
  type Message,
  SlashCommandRegistry,
  type TodoItem,
  ToolRegistry,
} from '@wrongstack/core';
import { describe, expect, it } from 'vitest';
import {
  buildBuiltinSlashCommands,
  type SlashCommandContext,
} from '../src/slash-commands/index.js';

class FakeRenderer {
  output = '';
  warnings: string[] = [];
  errors: string[] = [];
  infos: string[] = [];
  write(s: unknown): void {
    this.output += typeof s === 'string' ? s : ((s as { text?: string }).text ?? '');
  }
  writeLine(s = ''): void {
    this.output += `${s}\n`;
  }
  writeBlock(): void {}
  writeToolCall(): void {}
  writeToolResult(): void {}
  writeDiff(): void {}
  writeWarning(s: string): void {
    this.warnings.push(s);
  }
  writeError(s: string): void {
    this.errors.push(s);
  }
  writeInfo(s: string): void {
    this.infos.push(s);
  }
  clear(): void {
    this.output = '';
  }
}

function makeContext(): SlashCommandContext {
  const registry = new SlashCommandRegistry();
  const toolRegistry = new ToolRegistry();
  const renderer = new FakeRenderer();
  const tokenCounter = new DefaultTokenCounter();
  const compactor = new HybridCompactor({ preserveK: 5 });
  return {
    registry,
    toolRegistry,
    compactor,
    tokenCounter,
    renderer: renderer as never as Parameters<typeof buildBuiltinSlashCommands>[0]['renderer'],
    cwd: '/tmp',
    projectRoot: '/proj',
    configStore: {
      get: async () => ({}),
      set: async () => {},
    } as never as SlashCommandContext['configStore'],
    onPanelOpen: { current: null },
    events: { on() {}, off() {}, emit() {} },
    reader: {
      async prompt() {
        return null;
      },
      async pickOne() {
        return null;
      },
      async pickMany() {
        return [];
      },
      async confirm() {
        return true;
      },
      async password() {
        return '';
      },
      on() {},
      off() {},
      close() {},
    } as never as SlashCommandContext['reader'],
  } as never as SlashCommandContext;
}

const fakeCtx = {
  messages: [] as Message[],
  todos: [] as TodoItem[],
  systemPrompt: [],
  readFiles: new Set(),
  fileMtimes: new Map(),
  model: 'test-model',
  cwd: '/tmp',
  projectRoot: '/proj',
} as never as Context;

describe('cli boot order: plugin security then built-in /security', () => {
  it('CLI built-in /security wins over the security plugin', async () => {
    const ctx = makeContext();

    // Mirror the real boot order in packages/cli/src/cli-main.ts: setupPlugins()
    // runs before buildBuiltinSlashCommands() registers its commands. The
    // security plugin claims /security first as an official plugin; the
    // built-in registration must NOT clobber it with the wrong behavior.
    const plugin = createSecurityPlugin();
    const api = {
      slashCommands: ctx.registry,
      log: { info() {}, warn() {}, error() {} },
    };
    plugin.setup(api as never);

    for (const c of buildBuiltinSlashCommands(ctx)) ctx.registry.register(c);

    // Built-in /security wins after fix. Behaviour: prints dispatch
    // instructions (sync, no LLM call).
    const r = await ctx.registry.dispatch('/security scan', fakeCtx);
    expect(r?.message).toBeTruthy();
    expect(r?.message ?? '').toContain('dispatch');
    expect(r?.message ?? '').not.toMatch(/requires an active LLM provider/i);
  });

  it('built-in /security help still works after fix', async () => {
    const ctx = makeContext();
    const plugin = createSecurityPlugin();
    const api = {
      slashCommands: ctx.registry,
      log: { info() {}, warn() {}, error() {} },
    };
    plugin.setup(api as never);
    for (const c of buildBuiltinSlashCommands(ctx)) ctx.registry.register(c);

    const r = await ctx.registry.dispatch('/security help', fakeCtx);
    expect(r?.message).toContain('/security');
    expect(r?.message).toContain('audit-deps');
    expect(r?.message).toContain('scan');
  });

  it('built-in /security audit-deps still works after fix', async () => {
    const ctx = makeContext();
    const plugin = createSecurityPlugin();
    const api = {
      slashCommands: ctx.registry,
      log: { info() {}, warn() {}, error() {} },
    };
    plugin.setup(api as never);
    for (const c of buildBuiltinSlashCommands(ctx)) ctx.registry.register(c);

    // audit-deps is async (spawns pnpm). We just confirm dispatch does not
    // throw and returns something truthy — the underlying pnpm spawn may
    // fail in CI without pnpm on PATH, but the slash command still routes
    // through auditDepsCommand which returns a populated message.
    const r = await ctx.registry.dispatch('/security audit-deps', fakeCtx);
    expect(r).toBeDefined();
    // Either the JSON summary or a "failed to spawn pnpm" message is fine —
    // the point is the built-in audit-deps handler runs, not the plugin's
    // "default" branch.
    expect(r?.message).toBeTruthy();
  });
});
