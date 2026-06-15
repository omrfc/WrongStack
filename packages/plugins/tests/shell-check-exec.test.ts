import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

// Mock the OS-facing calls so we exercise the plugin's logic without a real
// shellcheck binary or filesystem.
const cp = vi.hoisted(() => ({ execFileSync: vi.fn(), execSync: vi.fn() }));
vi.mock('node:child_process', async (orig) => ({
  ...(await orig()),
  execFileSync: cp.execFileSync,
  execSync: cp.execSync,
}));

const fsm = vi.hoisted(() => ({ existsSync: vi.fn(), readdirSync: vi.fn() }));
vi.mock('node:fs', async (orig) => ({
  ...(await orig()),
  existsSync: fsm.existsSync,
  readdirSync: fsm.readdirSync,
}));

import shellCheckPlugin from '../src/shell-check';

interface Tool {
  name: string;
  execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

function setup(): { tools: Record<string, Tool>; metrics: { counter: ReturnType<typeof vi.fn>; histogram: ReturnType<typeof vi.fn> } } {
  const tools: Record<string, Tool> = {};
  const metrics = { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() };
  const api = {
    tools: { register: (t: Tool) => { tools[t.name] = t; } },
    config: { extensions: {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics,
    pipelines: { response: { use: vi.fn(), get: vi.fn() } },
  };
  shellCheckPlugin.setup(api as never);
  return { tools, metrics };
}

const issue = (over: Partial<Record<string, unknown>> = {}) => ({
  file: 'a.sh', line: 1, column: 1, level: 'warning', code: 'SC2086', message: 'quote it', ...over,
});
const dirent = (name: string, isDir: boolean) => ({ name, isDirectory: () => isDir, isFile: () => !isDir });

beforeEach(() => {
  vi.clearAllMocks();
  fsm.existsSync.mockReturnValue(true); // pretend `shellcheck` resolves; skip PATH probe
});

describe('shellcheck tool execute', () => {
  it('returns a structured summary and groups issues by file', async () => {
    cp.execFileSync.mockReturnValue(JSON.stringify([
      issue({ file: 'a.sh', level: 'error', code: 'SC1000' }),
      issue({ file: 'a.sh', level: 'warning' }),
      issue({ file: 'b.sh', level: 'info' }),
      issue({ file: 'b.sh', level: 'style' }),
    ]));
    const { tools, metrics } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh', 'b.sh'], severity: 'info' });

    expect(res.ok).toBe(true);
    expect(res.filesScanned).toBe(2);
    expect(res.summary).toEqual({ total: 4, errors: 1, warnings: 1, info: 1, style: 1 });
    expect(Object.keys(res.byFile as object)).toEqual(['a.sh', 'b.sh']);
    expect(res.recommendation).toMatch(/Fix errors/);
    expect(metrics.counter).toHaveBeenCalledWith('issues_found', 4, { severity: 'info' });
    expect(metrics.histogram).toHaveBeenCalled();
  });

  it('recommends reviewing warnings when there are warnings but no errors', async () => {
    cp.execFileSync.mockReturnValue(JSON.stringify([issue({ level: 'warning' })]));
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.recommendation).toMatch(/Review and fix warnings/);
  });

  it('reports no issues for a clean run', async () => {
    cp.execFileSync.mockReturnValue('[]');
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.summary).toMatchObject({ total: 0 });
    expect(res.recommendation).toBe('No issues found.');
  });

  it('returns ok:false when shellcheck is not installed', async () => {
    fsm.existsSync.mockReturnValue(false);
    cp.execSync.mockImplementation(() => { throw new Error('not found'); });
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not installed/);
    expect(res.issues).toEqual([]);
  });

  it('uses the PATH probe when the local binary is absent but shellcheck resolves', async () => {
    fsm.existsSync.mockReturnValue(false);
    cp.execSync.mockReturnValue('ShellCheck 0.9.0');
    cp.execFileSync.mockReturnValue('[]');
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.ok).toBe(true);
    expect(cp.execSync).toHaveBeenCalled();
  });

  it('treats a non-zero exit carrying issue JSON on stderr as findings', async () => {
    cp.execFileSync.mockImplementation(() => {
      throw { stderr: JSON.stringify([issue({ level: 'error', code: 'SC2154' })]) };
    });
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.ok).toBe(true);
    expect((res.summary as { errors: number }).errors).toBe(1);
  });

  it('returns no issues when the error has no usable stderr', async () => {
    cp.execFileSync.mockImplementation(() => { throw { stderr: 'shellcheck: fatal' }; });
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.summary).toMatchObject({ total: 0 });
  });

  it('returns no issues when output is blank', async () => {
    cp.execFileSync.mockReturnValue('   ');
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.summary).toMatchObject({ total: 0 });
  });

  it('returns no issues when output is not valid JSON', async () => {
    cp.execFileSync.mockReturnValue('not json at all');
    const { tools } = setup();
    const res = await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(res.summary).toMatchObject({ total: 0 });
  });

  it('defaults severity to warning when omitted', async () => {
    cp.execFileSync.mockReturnValue('[]');
    const { tools, metrics } = setup();
    await tools.shellcheck!.execute({ files: ['a.sh'] });
    expect(metrics.counter).toHaveBeenCalledWith('issues_found', 0, { severity: 'warning' });
  });
});

describe('shellcheck_scan tool execute', () => {
  it('returns early when no shell files are found', async () => {
    fsm.readdirSync.mockReturnValue([dirent('readme.md', false)]);
    const { tools } = setup();
    const res = await tools.shellcheck_scan!.execute({ directory: '/root' });
    expect(res).toMatchObject({ ok: true, filesScanned: 0, summary: { total: 0 } });
  });

  it('scans found files recursively, skipping node_modules and .git', async () => {
    fsm.readdirSync.mockImplementation((dir: string) => {
      if (dir === '/root') {
        return [
          dirent('sub', true),
          dirent('node_modules', true),
          dirent('.git', true),
          dirent('top.sh', false),
          dirent('Dockerfile', false),
          dirent('notes.txt', false),
        ];
      }
      if (dir === join('/root', 'sub')) return [dirent('nested.sh', false)];
      return [];
    });
    cp.execFileSync.mockReturnValue(JSON.stringify([
      issue({ file: 'top.sh', level: 'error' }),
      issue({ file: 'top.sh', level: 'warning' }), // second issue for the same file
      issue({ file: 'nested.sh', level: 'warning' }),
    ]));
    const { tools } = setup();
    const res = await tools.shellcheck_scan!.execute({ directory: '/root' });
    expect(res.ok).toBe(true);
    // top.sh, Dockerfile, nested.sh (node_modules/.git skipped, notes.txt ignored)
    expect(res.filesScanned).toBe(3);
    expect(res.filesWithIssues).toBe(2);
    expect((res.summary as { errors: number; warnings: number })).toMatchObject({ total: 3, errors: 1, warnings: 2 });
  });

  it('filters by filename pattern', async () => {
    fsm.readdirSync.mockReturnValue([dirent('build.sh', false), dirent('deploy.sh', false)]);
    cp.execFileSync.mockReturnValue('[]');
    const { tools } = setup();
    const res = await tools.shellcheck_scan!.execute({ directory: '/root', pattern: 'deploy' });
    expect(res.filesScanned).toBe(1);
  });

  it('tolerates unreadable directories', async () => {
    fsm.readdirSync.mockImplementation(() => { throw new Error('EACCES'); });
    const { tools } = setup();
    const res = await tools.shellcheck_scan!.execute({ directory: '/forbidden' });
    expect(res).toMatchObject({ ok: true, filesScanned: 0 });
  });

  it('returns ok:false when shellcheck fails during a scan', async () => {
    fsm.readdirSync.mockReturnValue([dirent('a.sh', false)]);
    fsm.existsSync.mockReturnValue(false);
    cp.execSync.mockImplementation(() => { throw new Error('nope'); });
    const { tools } = setup();
    const res = await tools.shellcheck_scan!.execute({ directory: '/root' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not installed/);
  });

  it('defaults directory and pattern when omitted', async () => {
    fsm.readdirSync.mockReturnValue([]);
    const { tools } = setup();
    const res = await tools.shellcheck_scan!.execute({});
    expect(res).toMatchObject({ ok: true, filesScanned: 0 });
    expect(fsm.readdirSync).toHaveBeenCalledWith('.', expect.anything());
  });
});
