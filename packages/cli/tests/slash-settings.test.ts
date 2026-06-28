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
  } as never as SlashCommandContext;
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

  it('bare /settings shows filesystem access (default: unrestricted)', async () => {
    const { ctx } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('filesystem access:   unrestricted');
    expect(text).toContain('/settings fs-access unrestricted|project');
  });

  it('bare /settings shows materialized defaults and the active persistence target', async () => {
    const { ctx } = makeCtx({ configScope: 'project' });
    const res = await buildSettingsCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);

    expect(text).toContain('max-concurrent:     4');
    expect(text).toContain('Persisted to <project>/.wrongstack/config.json');
  });

  it('view reflects a configured project-only filesystem scope', async () => {
    const { ctx } = makeCtx({ tools: { restrictToProjectRoot: true } });
    const res = await buildSettingsCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('filesystem access:   project');
  });

  it('fs-access project persists tools.restrictToProjectRoot=true', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('fs-access project');
    expect(stripAnsi(res!.message!)).toContain('filesystem access → project');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.tools.restrictToProjectRoot).toBe(true);
  });

  it('fs-access unrestricted persists tools.restrictToProjectRoot=false', async () => {
    const { ctx, globalConfig } = makeCtx({ tools: { restrictToProjectRoot: true } });
    await buildSettingsCommand(ctx).run!('fs-access unrestricted');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.tools.restrictToProjectRoot).toBe(false);
  });

  it('fs-access rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('fs-access bogus');
    expect(stripAnsi(res!.message!)).toContain('fs-access unrestricted|project');
    expect(existsSync(globalConfig)).toBe(false);
  });

  it('help lists the fs-access subcommand', () => {
    const { ctx } = makeCtx();
    const cmd = buildSettingsCommand(ctx);
    expect(cmd.help).toContain('fs-access unrestricted|project');
  });

  it('token-saving persists features.tokenSavingMode', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('token-saving light');
    expect(stripAnsi(res!.message!)).toContain('token-saving → light');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.features.tokenSavingMode).toBe('light');
  });

  it('bare /settings shows the circuit breaker (default: off)', async () => {
    const { ctx } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('circuit breaker:     off');
    expect(text).toContain('/settings breaker on|off');
  });

  it('view reflects an enabled circuit breaker with its timeout', async () => {
    const { ctx } = makeCtx({ circuitBreaker: { enabled: true, autoKillResetMs: 45_000 } });
    const res = await buildSettingsCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('circuit breaker:     on');
  });

  it('breaker on persists circuitBreaker.enabled=true', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('breaker on');
    expect(stripAnsi(res!.message!)).toContain('circuit breaker → on');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.circuitBreaker.enabled).toBe(true);
  });

  it('breaker-timeout persists circuitBreaker.autoKillResetMs', async () => {
    const { ctx, globalConfig } = makeCtx();
    await buildSettingsCommand(ctx).run!('breaker-timeout 90');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.circuitBreaker.autoKillResetMs).toBe(90_000);
  });

  it('breaker-timeout rejects invalid values without writing', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('breaker-timeout abc');
    expect(stripAnsi(res!.message!)).toContain('Invalid number');
    expect(existsSync(globalConfig)).toBe(false);
  });

  it('help lists the breaker subcommands', () => {
    const { ctx } = makeCtx();
    const cmd = buildSettingsCommand(ctx);
    expect(cmd.help).toContain('breaker on|off');
    expect(cmd.help).toContain('breaker-timeout');
  });

  it('title-animation off persists autonomy.terminalTitleAnimation (NOT top-level titleAnimation)', async () => {
    const { ctx, globalConfig } = makeCtx();
    const res = await buildSettingsCommand(ctx).run!('title-animation off');
    expect(stripAnsi(res!.message!)).toContain('title animation → off');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    // Canonical key — the one execution.ts reads and the TUI picker writes.
    expect(written.autonomy.terminalTitleAnimation).toBe(false);
    // The old broken key must NOT be written.
    expect(written.titleAnimation).toBeUndefined();
  });

  it('view reflects title animation (default on) and disabled state', async () => {
    const onCtx = makeCtx();
    const onRes = await buildSettingsCommand(onCtx.ctx).run!('');
    expect(stripAnsi(onRes!.message!)).toContain('title animation:    on');

    const offCtx = makeCtx({ autonomy: { terminalTitleAnimation: false } });
    const offRes = await buildSettingsCommand(offCtx.ctx).run!('');
    expect(stripAnsi(offRes!.message!)).toContain('title animation:    off');
  });
});
