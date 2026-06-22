import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPromptsPlugin } from '../../src/plugins/prompts-plugin.js';
import { DefaultPromptStore } from '../../src/storage/prompt-store.js';
import type { Context } from '../../src/index.js';
import type { SlashCommand } from '../../src/index.js';

let dir: string;
let store: DefaultPromptStore;

function makeApi() {
  const registered: SlashCommand[] = [];
  const unregister = vi.fn();
  return {
    api: {
      config: {},
      slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never,
    registered,
    unregister,
  };
}

const ctx = (over: Record<string, unknown> = {}): Context => ({ model: 'm', ...over }) as never as Context;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompts-plugin-'));
  store = new DefaultPromptStore({ globalPrompts: dir } as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

async function withCommand(): Promise<{ cmd: SlashCommand; unregister: ReturnType<typeof vi.fn>; plugin: ReturnType<typeof createPromptsPlugin> }> {
  const { api, registered, unregister } = makeApi();
  const plugin = createPromptsPlugin({ store });
  plugin.setup!(api);
  return { cmd: registered[0]!, unregister, plugin };
}

describe('createPromptsPlugin lifecycle', () => {
  it('registers /prompts on setup and unregisters on teardown; health is ok', async () => {
    const { api, registered, unregister } = makeApi();
    const plugin = createPromptsPlugin({ store });
    plugin.setup!(api);
    expect(registered[0]?.name).toBe('prompts');
    plugin.teardown!(api);
    expect(unregister).toHaveBeenCalledWith('prompts');
    expect(await plugin.health!()).toMatchObject({ ok: true });
  });

  it('builds a store from paths in plugin options', async () => {
    const { api, registered } = makeApi();
    createPromptsPlugin({ paths: { globalPrompts: dir } as never }).setup!(api);
    expect(await registered[0]!.run!('list', ctx())).toMatchObject({ message: expect.stringContaining('empty') });
  });

  it('builds a store from api.config.paths', async () => {
    const { registered } = makeApi();
    const api = { config: { paths: { globalPrompts: dir } }, slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() }, log: { info: vi.fn() } } as never;
    createPromptsPlugin().setup!(api);
    expect(await registered[0]!.run!('', ctx())).toMatchObject({ message: expect.stringContaining('empty') });
  });

  it('reports unavailable when no store or paths are configured', async () => {
    const { api, registered } = makeApi();
    createPromptsPlugin().setup!(api);
    expect(await registered[0]!.run!('list', ctx())).toMatchObject({ message: expect.stringContaining('not available') });
  });
});

describe('/prompts command verbs', () => {
  it('list: empty then populated', async () => {
    const { cmd } = await withCommand();
    expect((await cmd.run!('list', ctx())).message).toContain('empty');
    const entry = store.createNew('My Title', 'body');
    await store.save(entry);
    const out = await cmd.run!('', ctx());
    expect(out.message).toContain('My Title');
    expect(out.message).toContain('Prompt library (1)');
  });

  it('view: usage, no-match, and a match', async () => {
    const { cmd } = await withCommand();
    expect((await cmd.run!('view', ctx())).message).toContain('Usage');
    expect((await cmd.run!('view nope', ctx())).message).toContain('No prompt matching');
    await store.save(store.createNew('Hello', 'world'));
    expect((await cmd.run!('view Hello', ctx())).message).toContain('world');
  });

  it('add: usage and success with quoted title/content', async () => {
    const { cmd } = await withCommand();
    expect((await cmd.run!('add', ctx())).message).toContain('Usage');
    const out = await cmd.run!('add "Greeting" "say hi"', ctx());
    expect(out.message).toContain('Added prompt "Greeting"');
    expect((await store.list()).map((e) => e.title)).toContain('Greeting');
  });

  it('delete: usage, no-match, and success', async () => {
    const { cmd } = await withCommand();
    expect((await cmd.run!('delete', ctx())).message).toContain('Usage');
    expect((await cmd.run!('rm ghost', ctx())).message).toContain('No prompt matching');
    await store.save(store.createNew('Trash', 'x'));
    expect((await cmd.run!('delete Trash', ctx())).message).toContain('Deleted');
  });

  it('edit: usage, no-match, and success', async () => {
    const { cmd } = await withCommand();
    expect((await cmd.run!('edit', ctx())).message).toContain('Usage');
    expect((await cmd.run!('edit "ghost" "x"', ctx())).message).toContain('No prompt matching');
    await store.save(store.createNew('Doc', 'old'));
    expect((await cmd.run!('update "Doc" "new content"', ctx())).message).toContain('Updated');
    expect((await store.find('Doc'))[0]?.content).toBe('new content');
  });

  it('extend: usage, missing provider, and LLM enhancement', async () => {
    const { cmd } = await withCommand();
    expect((await cmd.run!('extend', ctx())).message).toContain('Usage');
    expect((await cmd.run!("extend 'Ghost' make it better", ctx())).message).toContain('No prompt matching');
    await store.save(store.createNew('Letter', 'Dear team'));
    // no provider.complete ('title' single-quote form → parseTitleContent strips quotes)
    expect((await cmd.run!("extend 'Letter' be formal", ctx({ provider: {} }))).message).toContain('LLM not available');
    // with provider
    const provider = { complete: vi.fn(async () => '  Dear esteemed team  ') };
    const out = await cmd.run!("extend 'Letter' be formal", ctx({ provider }));
    expect(out.message).toContain('Extended "Letter"');
    expect(provider.complete).toHaveBeenCalled();
    expect((await store.find('Letter'))[0]?.content).toBe('Dear esteemed team');
  });

  it('unknown subcommand reports the available verbs', async () => {
    const { cmd } = await withCommand();
    expect((await cmd.run!('frobnicate', ctx())).message).toContain('Unknown subcommand');
  });
});

describe('parseTitleContent (via add)', () => {
  it('handles single-quotes, single-quote+rest, bare word, and space split', async () => {
    const { cmd } = await withCommand();
    await cmd.run!("add 'Quoted' 'single content'", ctx());
    await cmd.run!("add 'Mixed' the rest is content", ctx());
    await cmd.run!('add BareWord', ctx()); // no space → title only, empty content
    await cmd.run!('add Spaced rest of the content', ctx()); // first space splits
    const titles = (await store.list()).map((e) => e.title).sort();
    expect(titles).toEqual(['BareWord', 'Mixed', 'Quoted', 'Spaced']);
  });
});
