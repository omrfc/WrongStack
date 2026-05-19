import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadlineInputReader } from '../src/input-reader.js';
import { detectProjectKind, runLaunchPrompts, runProjectCheck } from '../src/pre-launch.js';
import type { TerminalRenderer } from '../src/renderer.js';

/**
 * V0-C: pre-launch decides whether to scaffold AGENTS.md, prompts for
 * TUI/REPL + YOLO, and gates entry to an empty directory. Wrong behavior
 * here is the user's first impression of the tool, so these tests pin the
 * three flow shapes (initialized / project / empty) and the pinning short-
 * circuits.
 */

async function mkTempDir(prefix = 'wstack-prelaunch-'): Promise<string> {
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

function makeReader(answers: string[]): ReadlineInputReader {
  let i = 0;
  return {
    readLine: vi.fn(async () => {
      if (i >= answers.length) throw new Error('EOF');
      return answers[i++] ?? '';
    }),
    close: vi.fn(async () => {}),
  };
}

describe('detectProjectKind', () => {
  it("returns 'initialized' when .wrongstack/AGENTS.md exists", async () => {
    const dir = await mkTempDir();
    await fs.mkdir(path.join(dir, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(dir, '.wrongstack', 'AGENTS.md'), '# notes');
    expect(await detectProjectKind(dir)).toBe('initialized');
  });

  it("returns 'project' when a manifest exists but no AGENTS.md", async () => {
    const dir = await mkTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    expect(await detectProjectKind(dir)).toBe('project');
  });

  it("returns 'project' for non-JS manifests too (pyproject.toml)", async () => {
    const dir = await mkTempDir();
    await fs.writeFile(path.join(dir, 'pyproject.toml'), '');
    expect(await detectProjectKind(dir)).toBe('project');
  });

  it("returns 'empty' when no manifest and no AGENTS.md", async () => {
    const dir = await mkTempDir();
    expect(await detectProjectKind(dir)).toBe('empty');
  });
});

describe('runProjectCheck', () => {
  let renderer: TerminalRenderer;

  beforeEach(() => {
    renderer = makeRenderer();
  });

  it('initialized project returns true without prompting', async () => {
    const dir = await mkTempDir();
    await fs.mkdir(path.join(dir, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(dir, '.wrongstack', 'AGENTS.md'), '# notes');
    const reader = makeReader([]);

    const result = await runProjectCheck({ projectRoot: dir, renderer, reader });

    expect(result).toBe(true);
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it("'project' kind + 'y' answer scaffolds AGENTS.md", async () => {
    const dir = await mkTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    const reader = makeReader(['y']);

    const result = await runProjectCheck({ projectRoot: dir, renderer, reader });

    expect(result).toBe(true);
    const agentsFile = path.join(dir, '.wrongstack', 'AGENTS.md');
    const exists = await fs
      .access(agentsFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("'project' kind + 'n' answer skips scaffolding but still returns true", async () => {
    const dir = await mkTempDir();
    await fs.writeFile(path.join(dir, 'package.json'), '{}');
    const reader = makeReader(['n']);

    const result = await runProjectCheck({ projectRoot: dir, renderer, reader });

    expect(result).toBe(true);
    const agentsFile = path.join(dir, '.wrongstack', 'AGENTS.md');
    const exists = await fs
      .access(agentsFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("'empty' kind + 'n' answer returns false (user bailed)", async () => {
    const dir = await mkTempDir();
    // Two prompts: 'Initialize git?' then 'Continue anyway?'
    const reader = makeReader(['n', 'n']);

    const result = await runProjectCheck({ projectRoot: dir, renderer, reader });

    expect(result).toBe(false);
  });

  it("'empty' kind + 'Y' answer returns true", async () => {
    const dir = await mkTempDir();
    // Two prompts: 'Initialize git?' then 'Continue anyway?'
    const reader = makeReader(['n', 'y']);

    const result = await runProjectCheck({ projectRoot: dir, renderer, reader });

    expect(result).toBe(true);
  });

  it("'empty' kind + empty answer defaults to continuing", async () => {
    const dir = await mkTempDir();
    // Two prompts: 'Initialize git?' (empty) then 'Continue anyway?' (empty)
    const reader = makeReader(['', '']);

    const result = await runProjectCheck({ projectRoot: dir, renderer, reader });

    expect(result).toBe(true);
  });
});

describe('runLaunchPrompts', () => {
  it('returns pinned values without prompting', async () => {
    const renderer = makeRenderer();
    const reader = makeReader([]);

    const result = await runLaunchPrompts({
      renderer,
      reader,
      modePinned: 'tui',
      yoloPinned: false,
    });

    expect(result).toEqual({ mode: 'tui', yolo: false });
    expect(reader.readLine).not.toHaveBeenCalled();
  });

  it("'r' answer picks REPL mode", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['r', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.mode).toBe('repl');
    expect(result.yolo).toBe(true); // default is now Y
  });

  it('empty answer defaults to TUI mode', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.mode).toBe('tui');
  });

  it("'y' on yolo prompt enables YOLO mode", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', 'y']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.yolo).toBe(true);
  });

  it("'n' on yolo prompt disables YOLO mode", async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', 'n']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.yolo).toBe(false);
  });

  it('empty answer on yolo prompt defaults to YOLO enabled', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['', '']);
    const result = await runLaunchPrompts({ renderer, reader });
    expect(result.yolo).toBe(true);
  });

  it('mode prompt asked but yolo pinned skips yolo prompt', async () => {
    const renderer = makeRenderer();
    const reader = makeReader(['r']);
    const result = await runLaunchPrompts({ renderer, reader, yoloPinned: true });
    expect(result.mode).toBe('repl');
    expect(result.yolo).toBe(true);
    expect(reader.readLine).toHaveBeenCalledTimes(1);
  });
});
