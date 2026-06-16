import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChimeraPlugin, resolveChimeraConfig } from '../../src/plugins/chimera-plugin.js';
import type { SlashCommand } from '../../src/index.js';

let tmp: string;
const gitInit = (dir: string) => {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'tester'], { cwd: dir });
};
const commit = (dir: string, msg: string) => {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir });
};

function makeApi(config: Record<string, unknown> = {}) {
  const events: Record<string, () => Promise<void>> = {};
  const configChangeCbs: Array<() => void> = [];
  const registered: SlashCommand[] = [];
  const emitCustom = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    config: { provider: 'anthropic', model: 'claude', cwd: tmp, ...config },
    onConfigChange: (cb: () => void) => configChangeCbs.push(cb),
    onEvent: (type: string, h: () => Promise<void>) => { events[type] = h; },
    emitCustom,
    slashCommands: { register: (c: SlashCommand) => registered.push(c), unregister: vi.fn() },
    log,
  } as never;
  return { api, events, configChangeCbs, registered, emitCustom, log };
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chimera-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveChimeraConfig', () => {
  it('applies defaults and honors overrides', () => {
    expect(resolveChimeraConfig({}, 'p', 'm')).toEqual({ enabled: true, provider: 'p', model: 'm', maxFiles: 15, maxTokens: 4096 });
    expect(resolveChimeraConfig({ enabled: false, provider: 'x', model: 'y', maxFiles: 3, maxTokens: 99 }, 'p', 'm')).toEqual({ enabled: false, provider: 'x', model: 'y', maxFiles: 3, maxTokens: 99 });
  });
});

describe('createChimeraPlugin lifecycle + command', () => {
  it('registers /chimera when enabled and reflects config changes; health/teardown work', () => {
    const { api, registered, configChangeCbs, log } = makeApi();
    const plugin = createChimeraPlugin();
    plugin.setup!(api);
    expect(registered[0]?.name).toBe('chimera');

    // config change with no enabled/provider/model delta → no log
    configChangeCbs[0]!();
    // config change flipping enabled → logs + command reflects the new state
    (api as { config: Record<string, unknown> }).config.extensions = { 'wstack-chimera': { enabled: false } };
    configChangeCbs[0]!();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('config changed'));

    plugin.teardown!(api);
    return plugin.health!().then((h) => expect(h).toMatchObject({ ok: true }));
  });

  it('does not register the command when disabled by config', () => {
    const { api, registered, log } = makeApi({ extensions: { 'wstack-chimera': { enabled: false } } });
    createChimeraPlugin().setup!(api);
    expect(registered).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('disabled by config'));
  });

  it('command renders enabled and disabled status', async () => {
    const { api, registered, configChangeCbs } = makeApi();
    createChimeraPlugin().setup!(api);
    const cmd = registered[0]!;
    expect((await cmd.run!('', {} as never)).message).toContain('Chimera — enabled');
    // flip to disabled via config change → the live getter reflects it
    (api as { config: Record<string, unknown> }).config.extensions = { 'wstack-chimera': { enabled: false } };
    configChangeCbs[0]!();
    expect((await cmd.run!('', {} as never)).message).toContain('Chimera — disabled');
  });
});

describe('session.ended review handler', () => {
  it('skips when the directory is not a git repo', async () => {
    const { api, events, emitCustom, log } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('not a git repo'));
  });

  it('emits review_needed with the changed file contents', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'a.ts'), 'export const a = 1;');
    commit(tmp, 'init');
    await fs.writeFile(path.join(tmp, 'a.ts'), 'export const a = 2; // modified');
    await fs.writeFile(path.join(tmp, 'b.ts'), 'export const b = 3;');

    const { api, events, emitCustom } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();

    expect(emitCustom).toHaveBeenCalledWith('chimera.review_needed', expect.objectContaining({
      cwd: tmp,
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'a.ts', status: 'modified' }),
        expect.objectContaining({ path: 'b.ts', status: 'added' }),
      ]),
    }));
  });

  it('skips .wrongstack files and reports when nothing is left to review', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'keep.ts'), 'x');
    commit(tmp, 'init'); // clean tree now
    const { api, events, emitCustom, log } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no changed files'));
  });

  it('caps the review at maxFiles', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    await fs.writeFile(path.join(tmp, 'one.ts'), '1');
    await fs.writeFile(path.join(tmp, 'two.ts'), '2');
    const { api, events, emitCustom, log } = makeApi({ extensions: { 'wstack-chimera': { maxFiles: 1 } } });
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('capping review at 1 of 2'));
    expect((emitCustom.mock.calls[0]?.[1] as { files: unknown[] }).files).toHaveLength(1);
  });

  it('ignores .wrongstack/ changes', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    await fs.mkdir(path.join(tmp, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.wrongstack', 'note.md'), 'internal');
    const { api, events, emitCustom, log } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no changed files'));
  });

  it('reports when changed paths cannot be read (a directory entry)', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    // an untracked directory shows as a single porcelain entry whose path is a dir → readFile fails
    await fs.mkdir(path.join(tmp, 'newdir'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'newdir', 'inner.ts'), 'y');
    const { api, events, emitCustom, log } = makeApi();
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('could not read'));
  });

  it('skips the review when chimera was disabled after setup', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    await fs.writeFile(path.join(tmp, 'changed.ts'), 'y');
    const { api, events, emitCustom, configChangeCbs } = makeApi();
    createChimeraPlugin().setup!(api);
    (api as { config: Record<string, unknown> }).config.extensions = { 'wstack-chimera': { enabled: false } };
    configChangeCbs[0]!(); // resolved → disabled
    await events['session.ended']!();
    expect(emitCustom).not.toHaveBeenCalled();
  });

  it('swallows a handler error and warns', async () => {
    gitInit(tmp);
    await fs.writeFile(path.join(tmp, 'seed.ts'), 'x');
    commit(tmp, 'init');
    await fs.writeFile(path.join(tmp, 'c.ts'), 'changed');
    const { api, events, emitCustom, log } = makeApi();
    emitCustom.mockImplementation(() => { throw new Error('emit blew up'); });
    createChimeraPlugin().setup!(api);
    await events['session.ended']!();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('session.ended handler failed'));
  });
});
