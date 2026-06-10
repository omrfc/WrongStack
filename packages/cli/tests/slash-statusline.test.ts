import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildStatuslineCommand,
  loadStatuslineConfig,
  saveStatuslineConfig,
  type StatuslineCommandDeps,
  type StatuslineConfig,
} from '../src/slash-commands/statusline.js';

let tmp: string;
let prevHome: string | undefined;
let prevEnv: string | undefined;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sl-test-'));
  prevHome = process.env.HOME;
  prevEnv = process.env.WRONGSTACK_STATUSLINE_CONFIG;
  process.env.HOME = tmp;
  delete process.env.WRONGSTACK_STATUSLINE_CONFIG;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevEnv === undefined) delete process.env.WRONGSTACK_STATUSLINE_CONFIG;
  else process.env.WRONGSTACK_STATUSLINE_CONFIG = prevEnv;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('loadStatuslineConfig', () => {
  it('returns DEFAULTS when no file present', async () => {
    const cfg = await loadStatuslineConfig();
    expect(cfg.todos).toBe(true);
    expect(cfg.cost).toBe(true);
    expect(cfg.working_dir).toBe(true);
  });

  it('returns DEFAULTS merged with user overrides', async () => {
    const dir = path.join(tmp, '.wrongstack');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'statusline.json'),
      JSON.stringify({ git: false, cost: false }),
    );
    const cfg = await loadStatuslineConfig();
    expect(cfg.git).toBe(false);
    expect(cfg.cost).toBe(false);
    expect(cfg.todos).toBe(true); // not overridden
  });

  it('returns DEFAULTS on malformed JSON', async () => {
    const dir = path.join(tmp, '.wrongstack');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'statusline.json'), '{not json');
    const cfg = await loadStatuslineConfig();
    expect(cfg).toMatchObject({ todos: true, plan: true });
  });

  it('honors WRONGSTACK_STATUSLINE_CONFIG env path', async () => {
    const custom = path.join(tmp, 'override.json');
    process.env.WRONGSTACK_STATUSLINE_CONFIG = custom;
    await fs.writeFile(custom, JSON.stringify({ fleet: false }));
    const cfg = await loadStatuslineConfig();
    expect(cfg.fleet).toBe(false);
  });
});

describe('saveStatuslineConfig', () => {
  it('writes the config atomically to the resolved path', async () => {
    await saveStatuslineConfig({ todos: false, plan: true });
    const written = JSON.parse(
      await fs.readFile(path.join(tmp, '.wrongstack', 'statusline.json'), 'utf8'),
    );
    expect(written).toEqual({ todos: false, plan: true });
  });

  it('creates parent directory if missing', async () => {
    const dir = path.join(tmp, '.wrongstack');
    // Directory does not exist yet — save must mkdir -p.
    await saveStatuslineConfig({ cost: false });
    const stat = await fs.stat(dir);
    expect(stat.isDirectory()).toBe(true);
  });
});

// ── /statusline command ──────────────────────────────────────────────────────

function makeDeps(initial: StatuslineConfig = { todos: true, plan: true, fleet: true, git: true, elapsed: true, context: true, cost: true, working_dir: true }): StatuslineCommandDeps & { _cfg: StatuslineConfig } {
  const state = { cfg: { ...initial } };
  return {
    cwd: tmp,
    hiddenItems: [],
    setHiddenItems: vi.fn(function (this: { hiddenItems: typeof state }, items) {
      // mutated externally; track separately
    }) as never,
    getConfig: vi.fn(async () => state.cfg),
    setConfig: vi.fn(async (cfg) => {
      state.cfg = cfg;
    }),
    _cfg: state.cfg,
  } as never;
}

describe('buildStatuslineCommand', () => {
  it('shows current config with on/off bullets when called bare', async () => {
    const deps = makeDeps({ todos: true, plan: false, fleet: true, git: true, elapsed: true, context: true, cost: true });
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('');
    expect(res.message).toContain('● todos');
    expect(res.message).toContain('○ plan');
  });

  it('reset writes DEFAULTS and clears hidden items', async () => {
    const setHidden = vi.fn();
    const deps = { ...makeDeps(), setHiddenItems: setHidden } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('reset');
    expect(res.message).toContain('reset to defaults');
    expect(setHidden).toHaveBeenCalledWith([]);
  });

  it('unknown item reports available choices', async () => {
    const cmd = buildStatuslineCommand(makeDeps());
    const res = await cmd.run('foo on');
    expect(res.message).toContain('Unknown item "foo"');
    expect(res.message).toContain('todos');
  });

  it('valid item but missing on|off returns usage', async () => {
    const cmd = buildStatuslineCommand(makeDeps());
    const res = await cmd.run('git');
    expect(res.message).toContain('Usage: /statusline git on|off');
  });

  it('valid item with invalid action returns usage', async () => {
    const cmd = buildStatuslineCommand(makeDeps());
    const res = await cmd.run('git maybe');
    expect(res.message).toContain('Usage: /statusline git on|off');
  });

  it('item off persists and appends to hidden items', async () => {
    const setHidden = vi.fn();
    const deps = { ...makeDeps(), hiddenItems: ['cost'], setHiddenItems: setHidden } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('git off');
    expect(res.message).toBe('statusline git: off');
    expect(setHidden).toHaveBeenCalledWith(['cost', 'git']);
  });

  it('item on persists and removes from hidden items', async () => {
    const setHidden = vi.fn();
    const deps = { ...makeDeps(), hiddenItems: ['git', 'cost'], setHiddenItems: setHidden } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    await cmd.run('git on');
    expect(setHidden).toHaveBeenCalledWith(['cost']);
  });

  it('case-insensitive ON|Off accepted', async () => {
    const cmd = buildStatuslineCommand(makeDeps());
    const res = await cmd.run('todos OFF');
    expect(res.message).toBe('statusline todos: off');
  });

  it('working_dir off persists and appends to hidden items', async () => {
    const setHidden = vi.fn();
    const deps = { ...makeDeps(), hiddenItems: ['cost'], setHiddenItems: setHidden } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    const res = await cmd.run('working_dir off');
    expect(res.message).toBe('statusline working_dir: off');
    expect(setHidden).toHaveBeenCalledWith(['cost', 'working_dir']);
  });

  it('working_dir on persists and removes from hidden items', async () => {
    const setHidden = vi.fn();
    const deps = { ...makeDeps(), hiddenItems: ['working_dir', 'cost'], setHiddenItems: setHidden } as never as StatuslineCommandDeps;
    const cmd = buildStatuslineCommand(deps);
    await cmd.run('working_dir on');
    expect(setHidden).toHaveBeenCalledWith(['cost']);
  });
});
