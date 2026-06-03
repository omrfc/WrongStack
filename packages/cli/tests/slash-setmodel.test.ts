import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AGENT_CATALOG, type Config } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildSetModelCommand } from '../src/slash-commands/setmodel.js';

const sampleRole = Object.keys(AGENT_CATALOG)[0]!;

function baseConfig(): Partial<Config> {
  return {
    version: 1,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    providers: {
      anthropic: { type: 'anthropic', apiKey: 'sk-ant-x' },
      minimax: { type: 'minimax', apiKey: 'mm-y' },
      nokey: { type: 'nokey' },
    },
  };
}

let tmpDir: string;
let globalConfigPath: string;

function makeCtx(initial: Partial<Config>): {
  ctx: SlashCommandContext;
  store: { value: Partial<Config> };
} {
  const store = { value: { ...initial } };
  const ctx = {
    paths: { globalConfig: globalConfigPath },
    configStore: {
      get: () => store.value,
      update: (partial: Partial<Config>) => {
        store.value = { ...store.value, ...partial };
        return store.value;
      },
    },
  } as unknown as SlashCommandContext;
  return { ctx, store };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wstack-setmodel-'));
  globalConfigPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(globalConfigPath, JSON.stringify(baseConfig(), null, 2));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const readFile = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(globalConfigPath, 'utf8')) as Record<string, unknown>;

describe('/setmodel slash command', () => {
  it('exposes metadata', () => {
    const cmd = buildSetModelCommand(makeCtx(baseConfig()).ctx);
    expect(cmd.name).toBe('setmodel');
    expect(cmd.help).toContain('/setmodel set');
  });

  it('shows the leader model and an empty matrix hint with no args', async () => {
    const cmd = buildSetModelCommand(makeCtx(baseConfig()).ctx);
    const out = await cmd.run!('', undefined);
    expect(out!.message).toContain('anthropic/claude-sonnet-4-6');
    expect(out!.message).toMatch(/empty/);
  });

  it('lists keyed providers (excluding key-less ones)', async () => {
    const cmd = buildSetModelCommand(makeCtx(baseConfig()).ctx);
    const out = await cmd.run!('list', undefined);
    expect(out!.message).toContain('anthropic');
    expect(out!.message).toContain('minimax');
    expect(out!.message).not.toContain('nokey');
    expect(out!.message).toContain(sampleRole);
  });

  it('sets the leader model and persists it', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('leader minimax minimax-m3', undefined);
    expect(out!.message).toMatch(/✓|leader/);
    expect(store.value.provider).toBe('minimax');
    expect(store.value.model).toBe('minimax-m3');
    expect(readFile().provider).toBe('minimax');
    expect(readFile().model).toBe('minimax-m3');
  });

  it('rejects a leader provider without a key', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('leader nokey some-model', undefined);
    expect(out!.message).toMatch(/not available/);
    expect(store.value.provider).toBe('anthropic');
  });

  it('sets a matrix entry by role with provider/model syntax', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!(`set ${sampleRole} minimax/minimax-m3`, undefined);
    expect(out!.message).toMatch(/✓|→/);
    const matrix = (store.value.modelMatrix ?? {}) as Record<string, unknown>;
    expect(matrix[sampleRole]).toEqual({ provider: 'minimax', model: 'minimax-m3' });
    const persisted = (readFile().modelMatrix as Record<string, unknown>)[sampleRole];
    expect(persisted).toEqual({ provider: 'minimax', model: 'minimax-m3' });
  });

  it('sets a bare-model matrix entry (leader provider at resolve)', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    await cmd.run!('set * some-model', undefined);
    expect((store.value.modelMatrix as Record<string, unknown>)['*']).toEqual({
      model: 'some-model',
    });
  });

  it('rejects an unknown matrix key', async () => {
    const { ctx, store } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('set not-a-real-key minimax/x', undefined);
    expect(out!.message).toMatch(/Unknown key/);
    expect(store.value.modelMatrix).toBeUndefined();
  });

  it('rejects a matrix provider without a key', async () => {
    const { ctx } = makeCtx(baseConfig());
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!(`set ${sampleRole} nokey/x`, undefined);
    expect(out!.message).toMatch(/not available/);
  });

  it('clears a matrix entry', async () => {
    const initial = { ...baseConfig(), modelMatrix: { '*': { model: 'x' } } };
    const { ctx, store } = makeCtx(initial);
    fs.writeFileSync(globalConfigPath, JSON.stringify(initial, null, 2));
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('clear *', undefined);
    expect(out!.message).toMatch(/cleared/);
    expect((store.value.modelMatrix as Record<string, unknown>)['*']).toBeUndefined();
    expect((readFile().modelMatrix as Record<string, unknown>)['*']).toBeUndefined();
  });

  it('reports unavailable when paths are missing', async () => {
    const { ctx } = makeCtx(baseConfig());
    (ctx as { paths?: unknown }).paths = undefined;
    const cmd = buildSetModelCommand(ctx);
    const out = await cmd.run!('list', undefined);
    expect(out!.message).toMatch(/not available/);
  });
});
