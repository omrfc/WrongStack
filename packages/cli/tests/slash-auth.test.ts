import { describe, expect, it } from 'vitest';
import { buildAuthCommand } from '../src/slash-commands/auth.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function makeContext(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  return {
    registry: {} as SlashCommandContext['registry'],
    toolRegistry: {} as SlashCommandContext['toolRegistry'],
    tokenCounter: { count: () => 0 } as never as SlashCommandContext['tokenCounter'],
    renderer: {} as SlashCommandContext['renderer'],
    events: {} as SlashCommandContext['events'],
    cwd: '/tmp/test',
    projectRoot: '/tmp/test',
    configStore: {} as SlashCommandContext['configStore'],
    reader: {} as SlashCommandContext['reader'],
    ...overrides,
  };
}

describe('/auth slash command', () => {
  it('returns help on /auth help', async () => {
    const ctx = makeContext();
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('help');
    expect(result!.message).toContain('Usage:');
    expect(result!.message).toContain('/auth');
  });

  it('returns help on /auth --help', async () => {
    const ctx = makeContext();
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('--help');
    expect(result!.message).toContain('Usage:');
  });

  it('errors when config path is missing', async () => {
    const ctx = makeContext({ paths: undefined });
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('');
    expect(result!.message).toContain('Error');
    expect(result!.message).toContain('config path missing');
  });

  it('shows open hint with wstack auth instructions', async () => {
    const ctx = makeContext({
      paths: {
        globalConfig: '/tmp/does-not-exist.json',
      } as SlashCommandContext['paths'],
    });
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('open');
    expect(result!.message).toContain('wstack auth');
    expect(result!.message).toContain('Interactive menu');
  });

  it('shows empty state when no providers', async () => {
    const ctx = makeContext({
      paths: {
        globalConfig: '/tmp/empty-config.json',
      } as SlashCommandContext['paths'],
    });
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('');
    // When config doesn't exist, loadConfigProviders returns {}
    expect(result!.message).toContain('No providers configured');
  });

  it('shows usage on /auth status with no argument', async () => {
    const ctx = makeContext({
      paths: {
        globalConfig: '/tmp/empty-config.json',
      } as SlashCommandContext['paths'],
    });
    const cmd = buildAuthCommand(ctx);
    const result = await cmd.run('status');
    expect(result!.message).toContain('Usage:');
    expect(result!.message).toContain('status <provider>');
  });
});
