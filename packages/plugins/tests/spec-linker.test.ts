/**
 * @wrongstack/plugins — spec-linker plugin tests
 *
 * Covers the PostToolUse hook's:
 *  - Markdown glob filtering
 *  - Unlinked reference detection (bare plugin name in prose)
 *  - Wrapped-as-link-or-code exclusion
 *  - additionalContext surfacing with maxReferences cap
 *  - Word-boundary matching (no false-positive on substrings)
 *  - H1 audit pattern (teardown + health + idempotent re-init)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import specLinkerPlugin from '../src/spec-linker/index.js';

// ---------------------------------------------------------------------------
// Types + helpers
// ---------------------------------------------------------------------------

interface PluginAPI {
  tools: { register: ReturnType<typeof vi.fn> };
  slashCommands: { register: ReturnType<typeof vi.fn> };
  pipelines: Record<string, { use: (h: unknown) => void }>;
  config: { extensions?: Record<string, unknown> };
  log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  metrics: { counter: ReturnType<typeof vi.fn>; histogram: ReturnType<typeof vi.fn>; gauge: ReturnType<typeof vi.fn> };
  session: { append: ReturnType<typeof vi.fn> };
  extensions: { register: ReturnType<typeof vi.fn> };
  registerSystemPromptContributor: ReturnType<typeof vi.fn>;
  registerHook: ReturnType<typeof vi.fn>;
  onEvent: ReturnType<typeof vi.fn>;
  onPattern: ReturnType<typeof vi.fn>;
  emitCustom: ReturnType<typeof vi.fn>;
  onConfigChange: ReturnType<typeof vi.fn>;
}

function createMockAPI(): PluginAPI {
  return {
    tools: { register: vi.fn() },
    slashCommands: { register: vi.fn() },
    pipelines: {},
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    session: { append: vi.fn().mockResolvedValue(undefined) },
    extensions: { register: vi.fn(() => ({ unregister: vi.fn() })) },
    registerSystemPromptContributor: vi.fn(() => () => {}),
    registerHook: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    onPattern: vi.fn(() => () => {}),
    emitCustom: vi.fn(),
    onConfigChange: vi.fn(() => () => {}),
  };
}

function getHook(api: PluginAPI) {
  const call = vi.mocked(api.registerHook).mock.calls[0];
  if (!call || !call[2]) throw new Error('hook not registered');
  return call[2] as (input: {
    toolName?: string;
    toolInput?: unknown;
    toolResult?: { content: string; isError: boolean };
  }) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spec-linker plugin', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-linker-test-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  describe('plugin contract', () => {
    it('has name, apiVersion, and setup function', () => {
      expect(specLinkerPlugin.name).toBe('spec-linker');
      expect(typeof specLinkerPlugin.apiVersion).toBe('string');
      expect(typeof specLinkerPlugin.setup).toBe('function');
    });

    it('registers one tool and one PostToolUse hook on setup', () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      expect(api.tools.register).toHaveBeenCalledTimes(1);
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as { name: string };
      expect(tool.name).toBe('spec_linker_status');
      expect(api.registerHook).toHaveBeenCalledTimes(1);
      const call = vi.mocked(api.registerHook).mock.calls[0];
      expect(call?.[0]).toBe('PostToolUse');
      expect(call?.[1]).toBe('write|edit');
    });

    it('configSchema defines enabled, fileGlobs, maxReferences', () => {
      const schema = specLinkerPlugin.configSchema as Record<string, { properties?: Record<string, unknown> }>;
      const props = schema.properties;
      expect(props?.enabled).toBeDefined();
      expect(props?.fileGlobs).toBeDefined();
      expect(props?.maxReferences).toBeDefined();
    });

    it('defaultConfig has safe defaults (markdown-only, cap=8)', () => {
      const defaults = specLinkerPlugin.defaultConfig as Record<string, unknown>;
      expect(defaults.enabled).toBe(true);
      expect(defaults.fileGlobs).toEqual(['**/*.md', '**/*.mdx']);
      expect(defaults.maxReferences).toBe(8);
    });
  });

  // -------------------------------------------------------------------------
  describe('H1 audit pattern', () => {
    it('teardown clears state and logs the unload line', () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      specLinkerPlugin.teardown!(api as never);
      expect(api.log.info).toHaveBeenCalledWith(
        expect.stringContaining('spec-linker: teardown complete'),
        expect.anything(),
      );
    });

    it('health() returns ok with counter info', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const health = await specLinkerPlugin.health!();
      expect(health.ok).toBe(true);
      expect(health.message).toContain('0 invocation');
    });

    it('setup is idempotent: counters reset on re-init', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      specLinkerPlugin.teardown!(api as never);
      specLinkerPlugin.setup(api as never);
      const health = await specLinkerPlugin.health!();
      expect(health.message).toContain('0 invocation');
    });
  });

  // -------------------------------------------------------------------------
  describe('hook filtering', () => {
    it('skips when toolName is not write/edit', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api);
      const result = await hook({
        toolName: 'bash',
        toolInput: { path: '/tmp/x.md' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
    });

    it('skips when tool result indicates an error', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api);
      const filePath = path.join(tmpDir, 'err.md');
      await fs.writeFile(filePath, 'see secret-scanner', 'utf-8');
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'permission denied', isError: true },
      });
      expect(result).toBeUndefined();
    });

    it('skips non-markdown files by default', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api);
      const tsPath = path.join(tmpDir, 'src.ts');
      await fs.writeFile(tsPath, 'see secret-scanner', 'utf-8');
      const result = await hook({
        toolName: 'write',
        toolInput: { path: tsPath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as { execute: () => Promise<unknown> };
      const status = (await tool.execute()) as { counters: { skippedNonMd: number; invocations: number } };
      expect(status.counters.skippedNonMd).toBe(1);
      expect(status.counters.invocations).toBe(0);
    });

    it('does not fire when enabled=false', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { enabled: false } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api);
      const filePath = path.join(tmpDir, 'off.md');
      await fs.writeFile(filePath, 'see secret-scanner', 'utf-8');
      await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      const tool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as { execute: () => Promise<unknown> };
      const status = (await tool.execute()) as { counters: { invocations: number } };
      expect(status.counters.invocations).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('detection logic', () => {
    it('detects an unlinked plugin reference in prose', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api);
      const filePath = path.join(tmpDir, 'one.md');
      await fs.writeFile(
        filePath,
        'The secret-scanner plugin blocks credentials. See token-budget for the budget side.\n',
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeDefined();
      const ctx = (result as { additionalContext?: string }).additionalContext ?? '';
      expect(ctx).toContain('secret-scanner');
      expect(ctx).toContain('token-budget');
      expect(ctx).toContain('./src/secret-scanner');
      expect(ctx).toContain('./src/token-budget');
    });

    it('skips references already wrapped in markdown links', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api);
      const filePath = path.join(tmpDir, 'linked.md');
      await fs.writeFile(
        filePath,
        'The [secret-scanner](./src/secret-scanner) plugin blocks credentials.\n',
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
      const statusTool = vi.mocked(api.tools.register).mock.calls[0]?.[0] as { execute: () => Promise<unknown> };
      const status = (await statusTool.execute()) as { counters: { clean: number; unlinked: number } };
      expect(status.counters.clean).toBe(1);
      expect(status.counters.unlinked).toBe(0);
    });

    it('skips references wrapped in inline code', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api);
      const filePath = path.join(tmpDir, 'code.md');
      await fs.writeFile(filePath, 'Run `secret-scanner` to block credentials.\n', 'utf-8');
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
    });

    it('respects word boundaries (no false-positive on substrings)', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api);
      const filePath = path.join(tmpDir, 'substring.md');
      await fs.writeFile(
        filePath,
        'The "secret-scanner-config.json" file is in the repo. Cron-job is a script. No actual plugin name here.\n',
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      expect(result).toBeUndefined();
    });

    it('caps the additionalContext at maxReferences', async () => {
      const api = createMockAPI();
      api.config.extensions = { 'spec-linker': { maxReferences: 2 } };
      specLinkerPlugin.setup(api as never);
      const hook = getHook(api);
      const filePath = path.join(tmpDir, 'many.md');
      await fs.writeFile(
        filePath,
        [
          'First reference: secret-scanner.',
          'Second reference: token-budget.',
          'Third reference: lint-gate.',
          'Fourth reference: branch-guard.',
          'Fifth reference: todo-tracker.',
        ].join('\n'),
        'utf-8',
      );
      const result = await hook({
        toolName: 'write',
        toolInput: { path: filePath, content: '' },
        toolResult: { content: 'ok', isError: false },
      });
      const ctx = (result as { additionalContext?: string }).additionalContext ?? '';
      expect(ctx).toContain('and 3 more');
      // Only 2 plugin lines should appear in the body.
      const lines = ctx.split('\n').filter((l) => l.startsWith('- `'));
      expect(lines.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('status tool', () => {
    function getStatusTool(api: PluginAPI): { execute: () => Promise<unknown> } {
      const call = vi.mocked(api.tools.register).mock.calls[0];
      if (!call || !call[0]) throw new Error('status tool not registered');
      return call[0] as { execute: () => Promise<unknown> };
    }

    it('reports config + counters + catalog size', async () => {
      const api = createMockAPI();
      specLinkerPlugin.setup(api as never);
      const tool = getStatusTool(api);
      const status = (await tool.execute()) as {
        enabled: boolean;
        fileGlobs: string[];
        maxReferences: number;
        catalogSize: number;
        counters: { invocations: number; unlinked: number; clean: number };
      };
      expect(status.enabled).toBe(true);
      expect(status.fileGlobs).toEqual(['**/*.md', '**/*.mdx']);
      expect(status.maxReferences).toBe(8);
      expect(status.catalogSize).toBe(20);
      expect(status.counters.invocations).toBe(0);
      expect(status.counters.unlinked).toBe(0);
      expect(status.counters.clean).toBe(0);
    });
  });
});