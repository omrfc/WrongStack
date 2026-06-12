import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildSettingsCommand } from '../src/slash-commands/settings.js';

function makeCtx(config: Record<string, unknown> = {}): {
  ctx: SlashCommandContext;
  globalConfig: string;
  inProjectConfig: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'wstack-settings-test-'));
  const globalConfig = path.join(dir, 'global', 'config.json');
  const inProjectConfig = path.join(dir, 'project', 'config.json');
  const store = {
    get: vi.fn(() => config),
    update: vi.fn(),
  };
  const ctx = {
    configStore: store,
    paths: { globalConfig, inProjectConfig },
  } as unknown as SlashCommandContext;
  return { ctx, globalConfig, inProjectConfig };
}

describe('/settings slash command', () => {
  it('bare /settings shows the semver default part (factory default: patch)', async () => {
    const { ctx } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('semver default part: patch');
    expect(text).toContain('/settings semver-part');
  });

  it('view reflects a configured semver default part', async () => {
    const { ctx } = makeCtx({ extensions: { 'semver-bump': { defaultPart: 'minor' } } });
    const res = await buildSettingsCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('semver default part: minor');
  });

  it('semver-part persists extensions["semver-bump"].defaultPart to the global config', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('semver-part minor');
    expect(stripAnsi(res!.message!)).toContain('semver default part → minor');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.extensions['semver-bump'].defaultPart).toBe('minor');
  });

  it('semver-part writes to the global config even when configScope is project', async () => {
    // extensions is not in PROJECT_SAFE_FIELDS — a project-scope write would
    // silently drop it, so the subcommand must always target the global file.
    const { ctx, globalConfig, inProjectConfig } = makeCtx({ configScope: 'project' });
    await buildSettingsCommand(ctx).run!('semver-part auto');

    expect(existsSync(inProjectConfig)).toBe(false);
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.extensions['semver-bump'].defaultPart).toBe('auto');
  });

  it('semver-part preserves other semver-bump options on update', async () => {
    const { ctx, globalConfig } = makeCtx();
    const cmd = buildSettingsCommand(ctx);
    await cmd.run!('semver-part minor');
    await cmd.run!('semver-part major');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.extensions['semver-bump'].defaultPart).toBe('major');
  });

  it('semver-part rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('semver-part bogus');
    expect(stripAnsi(res!.message!)).toContain('semver-part patch|minor|major|auto');
    expect(existsSync(globalConfig)).toBe(false);
  });

  it('help lists the semver-part subcommand', () => {
    const { ctx } = makeCtx();
    const cmd = buildSettingsCommand(ctx);
    expect(cmd.help).toContain('semver-part patch|minor|major|auto');
  });
});
