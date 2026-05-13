import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ToolRegistry,
  resolveWstackPaths,
  type Config,
  type ModelsRegistry,
  type ResolvedProvider,
  type ResolvedModel,
} from '@wrongstack/core';
import { stripAnsi } from '@wrongstack/core';
import { TerminalRenderer } from '../src/renderer.js';
import { subcommands, type SubcommandDeps } from '../src/subcommands/index.js';

class CapStream extends Writable {
  buf = '';
  _write(c: Buffer | string, _e: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.buf += typeof c === 'string' ? c : c.toString('utf8');
    cb();
  }
}

function mkRig() {
  const out = new CapStream();
  const err = new CapStream();
  const renderer = new TerminalRenderer({
    out: out as unknown as NodeJS.WriteStream,
    err: err as unknown as NodeJS.WriteStream,
  });
  return { out, err, renderer };
}

function fakeProvider(over: Partial<ResolvedProvider> = {}): ResolvedProvider {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    family: 'anthropic',
    npm: '@ai-sdk/anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    doc: 'https://docs.anthropic.com',
    models: [
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        tool_call: true,
        reasoning: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 200_000, output: 8000 },
        cost: { input: 3, output: 15 },
        release_date: '2026-01-01',
      } as ResolvedModel,
    ],
    ...over,
  };
}

function fakeRegistry(providers: ResolvedProvider[]): ModelsRegistry {
  return {
    load: async () => ({}) as never,
    refresh: async () => ({}) as never,
    listProviders: async () => providers,
    getProvider: async (id: string) => providers.find((p) => p.id === id),
    getModel: async (pid: string, mid: string) =>
      providers.find((p) => p.id === pid)?.models.find((m) => m.id === mid),
    suggestModel: async (pid: string) =>
      providers.find((p) => p.id === pid)?.models[0]?.id,
    ageSeconds: async () => 60,
  } as ModelsRegistry;
}

function mkDeps(over: Partial<SubcommandDeps> = {}): SubcommandDeps {
  const rig = mkRig();
  return {
    config: { providers: {}, log: { level: 'error' } } as unknown as Config,
    renderer: rig.renderer,
    reader: {
      readLine: vi.fn(async () => ''),
      readKey: vi.fn(async () => ''),
      close: vi.fn(async () => undefined),
    } as never,
    modelsRegistry: fakeRegistry([fakeProvider()]),
    paths: resolveWstackPaths({
      projectRoot: process.cwd(),
      globalRoot: '/tmp/g',
      userHome: '/tmp',
    }),
    cwd: process.cwd(),
    projectRoot: process.cwd(),
    userHome: '/tmp',
    ...over,
  };
}

function getOut(deps: SubcommandDeps): string {
  // Renderer was injected from mkRig, but TerminalRenderer doesn't expose the stream.
  // We need to keep ref. So we change strategy: build rig manually.
  return stripAnsi((deps.renderer as unknown as { out: CapStream }).out?.buf ?? '');
}

function withRig() {
  const out = new CapStream();
  const err = new CapStream();
  const renderer = new TerminalRenderer({
    out: out as unknown as NodeJS.WriteStream,
    err: err as unknown as NodeJS.WriteStream,
  });
  return { out, err, renderer };
}

describe('subcommands', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sub-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('version prints version line', async () => {
    const rig = withRig();
    const code = await subcommands['version']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('WrongStack 0.0.1');
  });

  it('help lists subcommands', async () => {
    const rig = withRig();
    const code = await subcommands['help']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('wstack');
    expect(text).toContain('resume');
    expect(text).toContain('init');
  });

  it('config show prints redacted config', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      apiKey: 'sk-secret',
      log: { level: 'error' },
    } as unknown as Config;
    await subcommands['config']!(['show'], mkDeps({ renderer: rig.renderer, config }));
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain('sk-secret');
  });

  it('config edit shows hint', async () => {
    const rig = withRig();
    const code = await subcommands['config']!(['edit'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('Run:');
  });

  it('config rejects unknown subcommand', async () => {
    const rig = withRig();
    const code = await subcommands['config']!(['wat'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('Unknown');
  });

  it('tools lists registered tools', async () => {
    const rig = withRig();
    const reg = new ToolRegistry();
    reg.register(
      {
        name: 'echo',
        description: '',
        inputSchema: { type: 'object' },
        permission: 'auto',
        mutating: false,
        async execute() {
          return '';
        },
      },
      'core',
    );
    const code = await subcommands['tools']!(
      [],
      mkDeps({ renderer: rig.renderer, toolRegistry: reg }),
    );
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('echo');
    expect(stripAnsi(rig.out.buf)).toContain('[core]');
  });

  it('providers groups by wire family', async () => {
    const rig = withRig();
    const reg = fakeRegistry([
      fakeProvider({ id: 'anthropic', family: 'anthropic', name: 'Anthropic' }),
      fakeProvider({ id: 'openai', family: 'openai', name: 'OpenAI', envVars: ['OPENAI_API_KEY'] }),
      fakeProvider({ id: 'gemini', family: 'google', name: 'Gemini', envVars: ['GEMINI_API_KEY'] }),
    ]);
    const code = await subcommands['providers']!(
      [],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('anthropic');
    expect(text).toContain('openai');
    expect(text).toContain('google');
  });

  it('models <provider> lists models sorted by release_date desc', async () => {
    const rig = withRig();
    const provider = fakeProvider({
      models: [
        {
          id: 'old',
          release_date: '2024-01-01',
          tool_call: false,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 1000, output: 100 },
        } as ResolvedModel,
        {
          id: 'new',
          release_date: '2026-01-01',
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 200_000, output: 8000 },
        } as ResolvedModel,
      ],
    });
    const reg = fakeRegistry([provider]);
    const code = await subcommands['models']!(
      ['anthropic'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    const newIdx = text.indexOf('new');
    const oldIdx = text.indexOf('old');
    expect(newIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(-1);
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it('models refresh delegates to registry.refresh', async () => {
    const rig = withRig();
    const refresh = vi.fn().mockResolvedValue({ anthropic: {} });
    const reg = { ...fakeRegistry([]), refresh } as unknown as ModelsRegistry;
    const code = await subcommands['models']!(
      ['refresh'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    expect(refresh).toHaveBeenCalled();
  });

  it('models with unknown provider errors out', async () => {
    const rig = withRig();
    const code = await subcommands['models']!(
      ['no-such-provider'],
      mkDeps({ renderer: rig.renderer }),
    );
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('not in catalog');
  });

  it('mcp list says none configured by default', async () => {
    const rig = withRig();
    const code = await subcommands['mcp']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('No MCP servers');
  });

  it('plugin list says none configured by default', async () => {
    const rig = withRig();
    const code = await subcommands['plugin']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('No plugins');
  });

  it('diag prints diagnostics', async () => {
    const rig = withRig();
    const code = await subcommands['diag']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('apiVersion');
    expect(text).toContain('projectRoot');
    expect(text).toContain('cacheAge');
  });

  it('projects reports empty when no projects dir', async () => {
    const rig = withRig();
    const paths = resolveWstackPaths({
      projectRoot: process.cwd(),
      globalRoot: path.join(tmp, 'definitely-empty'),
      userHome: tmp,
    });
    const code = await subcommands['projects']!(
      [],
      mkDeps({ renderer: rig.renderer, paths }),
    );
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('No projects');
  });

  it('projects lists entries with meta.json', async () => {
    const rig = withRig();
    const globalRoot = path.join(tmp, 'g');
    const projectsRoot = path.join(globalRoot, 'projects');
    await fs.mkdir(path.join(projectsRoot, 'abc123'), { recursive: true });
    await fs.writeFile(
      path.join(projectsRoot, 'abc123', 'meta.json'),
      JSON.stringify({ root: '/some/path', lastSeen: '2026-05-13T00:00:00Z' }),
    );
    await fs.mkdir(path.join(projectsRoot, 'def456'), { recursive: true });
    const paths = resolveWstackPaths({
      projectRoot: process.cwd(),
      globalRoot,
      userHome: tmp,
    });
    const code = await subcommands['projects']!(
      [],
      mkDeps({ renderer: rig.renderer, paths }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('abc123');
    expect(text).toContain('/some/path');
    expect(text).toContain('def456');
    expect(text).toContain('(no meta)');
  });

  it('mcp lists configured servers', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      log: { level: 'error' },
      mcpServers: {
        primary: { name: 'primary', transport: 'stdio', command: 'noop' },
        disabled: { name: 'disabled', transport: 'stdio', enabled: false },
      },
    } as unknown as Config;
    const code = await subcommands['mcp']!([], mkDeps({ renderer: rig.renderer, config }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('primary');
    expect(text).toContain('disabled');
  });

  it('plugin lists configured plugins', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      log: { level: 'error' },
      plugins: ['npm:simple', { name: 'fancy', enabled: false }],
    } as unknown as Config;
    const code = await subcommands['plugin']!([], mkDeps({ renderer: rig.renderer, config }));
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('npm:simple');
    expect(text).toContain('fancy');
    expect(text).toContain('disabled');
  });

  it('sessions reports empty when none exist', async () => {
    const rig = withRig();
    const sessionStore = {
      create: async () => ({ id: 'x', append: async () => undefined, close: async () => undefined }),
      load: async () => ({ metadata: {}, events: [], messages: [], usage: { input: 0, output: 0 } }),
      list: async () => [],
      delete: async () => undefined,
    } as never;
    const code = await subcommands['sessions']!(
      [],
      mkDeps({ renderer: rig.renderer, sessionStore }),
    );
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('No sessions');
  });

  it('sessions lists summaries', async () => {
    const rig = withRig();
    const sessionStore = {
      create: async () => ({ id: 'x', append: async () => undefined, close: async () => undefined }),
      load: async () => ({ metadata: {}, events: [], messages: [], usage: { input: 0, output: 0 } }),
      list: async () => [
        {
          id: 's1',
          title: 'Hello task',
          startedAt: '2026-05-12T00:00:00Z',
          model: 'm',
          provider: 'p',
          tokenTotal: 100,
        },
      ],
      delete: async () => undefined,
    } as never;
    const code = await subcommands['sessions']!(
      [],
      mkDeps({ renderer: rig.renderer, sessionStore }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('s1');
    expect(text).toContain('Hello task');
    expect(text).toContain('100');
  });

  // `resume <id>` is no longer a standalone subcommand — it's lifted in
  // src/index.ts into the `--resume <id>` flag before subcommand dispatch.
  // Resume behaviour is covered end-to-end by the session-store resume
  // round-trip test in packages/core.

  it('skills lists discovered skills', async () => {
    const rig = withRig();
    const skillLoader = {
      list: async () => [
        { name: 'graphify', description: 'turn input into knowledge graph', source: 'bundled', path: '/x' },
      ],
      find: async () => undefined,
      manifestText: async () => '',
      readBody: async () => '',
    } as never;
    const code = await subcommands['skills']!(
      [],
      mkDeps({ renderer: rig.renderer, skillLoader }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('graphify');
    expect(text).toContain('[bundled]');
  });

  it('providers --unsupported only shows unsupported family', async () => {
    const rig = withRig();
    const reg = fakeRegistry([
      fakeProvider({ id: 'anthropic', family: 'anthropic' }),
      fakeProvider({
        id: 'weird',
        family: 'unsupported',
        npm: '@something/unknown',
        name: 'Weird',
      }),
    ]);
    const code = await subcommands['providers']!(
      ['--unsupported'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('weird');
    expect(text).toContain('needs plugin');
    expect(text).not.toContain('anthropic');
  });

  it('providers --all includes unsupported alongside supported', async () => {
    const rig = withRig();
    const reg = fakeRegistry([
      fakeProvider({ id: 'anthropic', family: 'anthropic' }),
      fakeProvider({ id: 'weird', family: 'unsupported', name: 'Weird' }),
    ]);
    const code = await subcommands['providers']!(
      ['--all'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('anthropic');
    expect(text).toContain('weird');
  });

  it('providers handles registry failure with non-zero exit', async () => {
    const rig = withRig();
    const reg = {
      ...fakeRegistry([]),
      listProviders: async () => {
        throw new Error('network down');
      },
    } as ModelsRegistry;
    const code = await subcommands['providers']!(
      [],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('network down');
  });

  it('models without args uses config.provider', async () => {
    const rig = withRig();
    const config = {
      providers: {},
      log: { level: 'error' },
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    } as unknown as Config;
    const reg = fakeRegistry([fakeProvider()]);
    const code = await subcommands['models']!(
      [],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg, config }),
    );
    expect(code).toBe(0);
    expect(stripAnsi(rig.out.buf)).toContain('claude-sonnet-4-6');
  });

  it('models without args + no config provider returns usage error', async () => {
    const rig = withRig();
    const code = await subcommands['models']!([], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('Usage');
  });

  it('models refresh surfaces failure', async () => {
    const rig = withRig();
    const reg = {
      ...fakeRegistry([]),
      refresh: async () => {
        throw new Error('fetch failed');
      },
    } as ModelsRegistry;
    const code = await subcommands['models']!(
      ['refresh'],
      mkDeps({ renderer: rig.renderer, modelsRegistry: reg }),
    );
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('fetch failed');
  });

  it('mcp rejects unknown subcommand', async () => {
    const rig = withRig();
    const code = await subcommands['mcp']!(['frobnicate'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(1);
    expect(stripAnsi(rig.err.buf)).toContain('Unknown mcp subcommand');
  });

  it('mcp restart warns and exits 0 outside REPL', async () => {
    const rig = withRig();
    const code = await subcommands['mcp']!(['restart'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.err.buf)).toContain('only available in REPL');
  });

  it('plugin warns on unimplemented subcommand', async () => {
    const rig = withRig();
    const code = await subcommands['plugin']!(['install', 'foo'], mkDeps({ renderer: rig.renderer }));
    expect(code).toBe(0);
    expect(stripAnsi(rig.err.buf)).toContain('not implemented');
  });

  it('usage prints session token totals', async () => {
    const rig = withRig();
    const sessionStore = {
      create: async () => ({ id: 'x', append: async () => undefined, close: async () => undefined }),
      load: async () => ({ metadata: {}, events: [], messages: [], usage: { input: 0, output: 0 } }),
      list: async () => [
        { id: 'a', title: '', startedAt: '', model: '', provider: '', tokenTotal: 50 },
        { id: 'b', title: '', startedAt: '', model: '', provider: '', tokenTotal: 75 },
      ],
      delete: async () => undefined,
    } as never;
    const code = await subcommands['usage']!(
      [],
      mkDeps({ renderer: rig.renderer, sessionStore }),
    );
    expect(code).toBe(0);
    const text = stripAnsi(rig.out.buf);
    expect(text).toContain('Sessions: 2');
    expect(text).toContain('125');
  });
});

// silence unused-helpers lint
void getOut;
void mkDeps;
