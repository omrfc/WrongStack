import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DefaultSecretVault, type ModelsRegistry, type ResolvedProvider } from '@wrongstack/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthMenuDeps, runAuthDirect, runAuthMenu } from '../src/auth-menu.js';
import type { ReadlineInputReader } from '../src/input-reader.js';
import type { TerminalRenderer } from '../src/renderer.js';

/**
 * V0-C: `auth-menu` is the 776-line entry point for every API-key
 * interaction. We don't aim to drive the full interactive `runAuthMenu`
 * loop — that's an integration test best done by hand. Here we pin:
 *
 *  1. `runAuthDirect` (the scripted one-shot) writes encrypted keys to
 *     the right config shape.
 *  2. Catalog-driven defaults (family/baseUrl/envVars) are pulled when
 *     the provider exists in models.dev.
 *  3. Missing family + missing catalog entry fails with exit 1.
 *  4. Label collisions append a `-2`, `-3`, … suffix.
 *  5. `runAuthMenu` exits cleanly on `q`.
 */

async function mkTempDir(prefix = 'wstack-auth-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRenderer(): TerminalRenderer {
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

function makeReader(lines: string[], secrets: string[] = []): ReadlineInputReader {
  let li = 0;
  let si = 0;
  return {
    readLine: vi.fn(async () => {
      if (li >= lines.length) throw new Error('EOF');
      return lines[li++] ?? '';
    }),
    readSecret: vi.fn(async () => {
      if (si >= secrets.length) throw new Error('EOF (secret)');
      return secrets[si++] ?? '';
    }),
    close: vi.fn(async () => {}),
  } as unknown as ReadlineInputReader;
}

function makeModelsRegistry(catalog: Record<string, Partial<ResolvedProvider>>): ModelsRegistry {
  return {
    getProvider: vi.fn(async (id: string) =>
      catalog[id] ? (catalog[id] as ResolvedProvider) : undefined,
    ),
    listProviders: vi.fn(async () => Object.values(catalog) as ResolvedProvider[]),
    suggestModel: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
  } as unknown as ModelsRegistry;
}

async function setupDeps(opts: {
  catalog?: Record<string, Partial<ResolvedProvider>>;
  preExisting?: object;
  scripted?: { lines?: string[]; secrets?: string[] };
}): Promise<{ deps: AuthMenuDeps; configPath: string; tmpDir: string }> {
  const tmpDir = await mkTempDir();
  const configPath = path.join(tmpDir, 'config.json');
  if (opts.preExisting) {
    await fs.writeFile(configPath, JSON.stringify(opts.preExisting), { mode: 0o600 });
  }
  const vault = new DefaultSecretVault({ keyFile: path.join(tmpDir, '.key') });
  const deps: AuthMenuDeps = {
    renderer: makeRenderer(),
    reader: makeReader(opts.scripted?.lines ?? [], opts.scripted?.secrets ?? []),
    modelsRegistry: makeModelsRegistry(opts.catalog ?? {}),
    vault,
    globalConfigPath: configPath,
  };
  return { deps, configPath, tmpDir };
}

describe('runAuthDirect', () => {
  it('writes encrypted key for a known catalog provider', async () => {
    const { deps, configPath } = await setupDeps({
      catalog: {
        anthropic: {
          id: 'anthropic',
          family: 'anthropic',
          apiBase: 'https://api.anthropic.com',
          envVars: ['ANTHROPIC_API_KEY'],
        },
      },
      scripted: { secrets: ['sk-test-abc'] },
    });

    const code = await runAuthDirect(deps, { providerId: 'anthropic' });
    expect(code).toBe(0);

    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.anthropic).toBeDefined();
    // Encrypted-at-rest — must NOT contain the plaintext key
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain('sk-test-abc');
    // Catalog defaults flowed in
    expect(raw.providers.anthropic.family).toBe('anthropic');
    expect(raw.providers.anthropic.baseUrl).toBe('https://api.anthropic.com');
    expect(raw.providers.anthropic.envVars).toEqual(['ANTHROPIC_API_KEY']);
    expect(raw.providers.anthropic.activeKey).toBe('default');
  });

  it('exits 1 when provider unknown and no --family passed', async () => {
    const { deps } = await setupDeps({ catalog: {} });
    const code = await runAuthDirect(deps, { providerId: 'unknown-provider' });
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('not in catalog'),
    );
  });

  it('explicit --family bypasses catalog requirement', async () => {
    const { deps } = await setupDeps({
      catalog: {},
      scripted: { secrets: ['sk-custom'] },
    });
    const code = await runAuthDirect(deps, {
      providerId: 'self-hosted',
      family: 'openai-compatible',
      baseUrl: 'https://my.api/v1',
    });
    expect(code).toBe(0);
  });

  it('label collision suffixes -2, -3, …', async () => {
    const { deps, configPath } = await setupDeps({
      catalog: {
        anthropic: {
          id: 'anthropic',
          family: 'anthropic',
          envVars: ['ANTHROPIC_API_KEY'],
        },
      },
      scripted: { secrets: ['k1', 'k2', 'k3'] },
    });

    await runAuthDirect(deps, { providerId: 'anthropic' });
    await runAuthDirect(deps, { providerId: 'anthropic' });
    await runAuthDirect(deps, { providerId: 'anthropic' });

    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const labels = (raw.providers.anthropic.apiKeys as { label: string }[])
      .map((k) => k.label)
      .sort();
    expect(labels).toEqual(['default', 'default-2', 'default-3']);
    expect(deps.renderer.writeInfo).toHaveBeenCalledWith(expect.stringMatching(/Label collided/));
  });

  it('empty secret input returns exit 1', async () => {
    const { deps } = await setupDeps({
      catalog: {
        anthropic: { id: 'anthropic', family: 'anthropic', envVars: ['X'] },
      },
      scripted: { secrets: [''] },
    });
    const code = await runAuthDirect(deps, { providerId: 'anthropic' });
    expect(code).toBe(1);
    expect(deps.renderer.writeError).toHaveBeenCalledWith('No key entered.');
  });
});

describe('runAuthMenu', () => {
  it('exits with 0 on "q"', async () => {
    const { deps } = await setupDeps({
      scripted: { lines: ['q'] },
    });
    const code = await runAuthMenu(deps);
    expect(code).toBe(0);
  });

  it('exits with 0 on empty input', async () => {
    const { deps } = await setupDeps({
      scripted: { lines: [''] },
    });
    const code = await runAuthMenu(deps);
    expect(code).toBe(0);
  });

  it('exits with 0 on "quit" and on "exit" aliases', async () => {
    for (const cmd of ['quit', 'exit']) {
      const { deps } = await setupDeps({ scripted: { lines: [cmd] } });
      const code = await runAuthMenu(deps);
      expect(code).toBe(0);
    }
  });

  it('writes a key after picking a catalog entry by number', async () => {
    const { deps, configPath } = await setupDeps({
      catalog: {
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic',
          family: 'anthropic',
          apiBase: 'https://api.anthropic.com',
          envVars: ['ANTHROPIC_API_KEY'],
        },
      },
      scripted: {
        // Top menu: 'a' (add) → empty filter → pick '1' (the only entry) →
        // accept family default → accept baseUrl default → accept alias →
        // empty label → then 'q' to leave the loop.
        lines: ['a', '', '1', '', '', '', '', 'q'],
        secrets: ['sk-anth-test'],
      },
    });
    const code = await runAuthMenu(deps);
    expect(code).toBe(0);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.anthropic).toBeDefined();
    expect(raw.providers.anthropic.family).toBe('anthropic');
  });

  it('unknown selection writes an error and re-prompts', async () => {
    const { deps } = await setupDeps({
      scripted: { lines: ['xyzzy', 'q'] },
    });
    const code = await runAuthMenu(deps);
    expect(code).toBe(0);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('Unknown selection'),
    );
  });

  it('catalog filter that matches nothing writes an error', async () => {
    const { deps } = await setupDeps({
      catalog: {
        anthropic: { id: 'anthropic', name: 'Anthropic', family: 'anthropic', envVars: ['X'] },
      },
      scripted: { lines: ['a', 'no-match-xyz', 'q'] },
    });
    await runAuthMenu(deps);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(
      expect.stringMatching(/No providers match/),
    );
  });

  it('manages an existing provider via numeric pick + back', async () => {
    const { deps } = await setupDeps({
      preExisting: {
        providers: {
          openai: {
            type: 'openai',
            family: 'openai',
            apiKeys: [{ label: 'default', apiKey: 'plain', createdAt: '2025-01-01T00:00:00.000Z' }],
            activeKey: 'default',
          },
        },
      },
      scripted: { lines: ['1', 'b', 'q'] },
    });
    const code = await runAuthMenu(deps);
    expect(code).toBe(0);
  });

  it('deletes a key with confirmation', async () => {
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          openai: {
            type: 'openai',
            family: 'openai',
            apiKeys: [
              { label: 'default', apiKey: 'plain', createdAt: '2025-01-01T00:00:00.000Z' },
              { label: 'extra', apiKey: 'plain2', createdAt: '2025-01-01T00:00:00.000Z' },
            ],
            activeKey: 'default',
          },
        },
      },
      // 1 -> manage openai; d 2 -> delete second key; y -> confirm; b -> back; q -> quit
      scripted: { lines: ['1', 'd 2', 'y', 'b', 'q'] },
    });
    const code = await runAuthMenu(deps);
    expect(code).toBe(0);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    const labels = (raw.providers.openai.apiKeys as { label: string }[]).map((k) => k.label);
    expect(labels).toEqual(['default']);
  });

  it('s <n> sets active key', async () => {
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          openai: {
            type: 'openai',
            family: 'openai',
            apiKeys: [
              { label: 'default', apiKey: 'plain', createdAt: '2025-01-01T00:00:00.000Z' },
              { label: 'extra', apiKey: 'plain2', createdAt: '2025-01-01T00:00:00.000Z' },
            ],
            activeKey: 'default',
          },
        },
      },
      // 1 -> manage; s 2 -> set extra as active; b; q
      scripted: { lines: ['1', 's 2', 'b', 'q'] },
    });
    await runAuthMenu(deps);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.openai.activeKey).toBe('extra');
  });

  it('f <family> edits the wire family', async () => {
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          custom: {
            type: 'custom',
            family: 'openai',
            apiKeys: [{ label: 'default', apiKey: 'plain', createdAt: '' }],
            activeKey: 'default',
          },
        },
      },
      scripted: { lines: ['1', 'f', 'openai-compatible', 'b', 'q'] },
    });
    await runAuthMenu(deps);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.custom.family).toBe('openai-compatible');
  });

  it('B edits the baseUrl', async () => {
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          custom: {
            type: 'custom',
            family: 'openai',
            apiKeys: [{ label: 'default', apiKey: 'plain', createdAt: '' }],
            activeKey: 'default',
          },
        },
      },
      scripted: { lines: ['1', 'B', 'https://new.base/v1', 'b', 'q'] },
    });
    await runAuthMenu(deps);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.custom.baseUrl).toBe('https://new.base/v1');
  });

  it('m edits the visible models list', async () => {
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          custom: {
            type: 'custom',
            family: 'openai',
            apiKeys: [{ label: 'default', apiKey: 'plain', createdAt: '' }],
            activeKey: 'default',
          },
        },
      },
      scripted: { lines: ['1', 'm', 'gpt-x, gpt-y', 'b', 'q'] },
    });
    await runAuthMenu(deps);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.custom.models).toEqual(['gpt-x', 'gpt-y']);
  });

  it('x removes the provider with confirmation', async () => {
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          doomed: {
            type: 'doomed',
            family: 'openai',
            apiKeys: [{ label: 'default', apiKey: 'plain', createdAt: '' }],
          },
        },
      },
      scripted: { lines: ['1', 'x', 'y', 'q'] },
    });
    await runAuthMenu(deps);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers.doomed).toBeUndefined();
  });

  it('u <n> updates the key value', async () => {
    const { deps, configPath } = await setupDeps({
      preExisting: {
        providers: {
          openai: {
            type: 'openai',
            family: 'openai',
            apiKeys: [{ label: 'default', apiKey: 'old', createdAt: '' }],
            activeKey: 'default',
          },
        },
      },
      // 1 -> manage; u 1 -> update first; secrets[0] is the new key
      scripted: { lines: ['1', 'u 1', 'b', 'q'], secrets: ['fresh-key'] },
    });
    await runAuthMenu(deps);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    // Encrypted on disk
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain('fresh-key');
  });

  it('c (custom provider) writes a new entry from manual input', async () => {
    const { deps, configPath } = await setupDeps({
      // c -> custom flow; type=local-llama; family=openai-compatible; baseUrl;
      // models empty; envVars empty; label empty (default); then q
      scripted: {
        lines: [
          'c',
          'local-llama',
          'openai-compatible',
          'http://localhost:11434/v1',
          '',
          '',
          '',
          'q',
        ],
        secrets: ['llama-key'],
      },
    });
    const code = await runAuthMenu(deps);
    expect(code).toBe(0);
    const raw = JSON.parse(await fs.readFile(configPath, 'utf8'));
    expect(raw.providers['local-llama'].family).toBe('openai-compatible');
    expect(raw.providers['local-llama'].baseUrl).toBe('http://localhost:11434/v1');
  });

  it('c rejects an invalid family', async () => {
    const { deps } = await setupDeps({
      scripted: { lines: ['c', 'local-llama', 'bogus-family', 'q'] },
    });
    await runAuthMenu(deps);
    expect(deps.renderer.writeError).toHaveBeenCalledWith(expect.stringMatching(/Invalid family/));
  });
});
