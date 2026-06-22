import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Tool, ToolRegistry } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTechStackCommand } from '../src/slash-commands/techstack.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

class FakeRenderer {
  output = '';
  warnings: string[] = [];
  write(s: unknown): void {
    this.output += typeof s === 'string' ? s : '';
  }
  writeLine(s = ''): void {
    this.output += `${s}\n`;
  }
  writeBlock(): void {}
  writeToolCall(): void {}
  writeToolResult(): void {}
  writeDiff(): void {}
  writeWarning(s: string): void {
    this.warnings.push(s);
  }
  writeError(): void {}
  writeInfo(): void {}
  clear(): void {
    this.output = '';
  }
}

function fetchToolStub(): Tool {
  return {
    name: 'fetch',
    description: 'stub fetch',
    inputSchema: { type: 'object' },
    permission: 'confirm',
    mutating: false,
    capabilities: ['net.outbound'],
    async execute() {
      return '';
    },
  } as Tool;
}

describe('/techstack', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-techstack-'));
    await fs.writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'x', dependencies: { left: '1.0.0' } }),
    );
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  function rig(opts: { withFetch: boolean; onSpawnAndWait?: SlashCommandContext['onSpawnAndWait'] }) {
    const renderer = new FakeRenderer();
    const toolRegistry = new ToolRegistry();
    if (opts.withFetch) toolRegistry.register(fetchToolStub());
    const ctx: Partial<SlashCommandContext> = {
      toolRegistry,
      renderer: renderer as never as SlashCommandContext['renderer'],
      cwd: projectRoot,
      projectRoot,
      onSpawnAndWait: opts.onSpawnAndWait,
    };
    return { renderer, command: buildTechStackCommand(ctx as SlashCommandContext) };
  }

  it('aborts with a tier hint when the fetch tool is not registered', async () => {
    const spawn = vi.fn(async () => 'summary');
    const { renderer, command } = rig({ withFetch: false, onSpawnAndWait: spawn });
    const res = await command.run('', {} as never);
    expect(spawn).not.toHaveBeenCalled();
    expect(res.message).toMatch(/fetch.*unavailable|token-saving/i);
    expect(renderer.warnings.join('\n')).toMatch(/fetch/i);
  });

  it('spawns with a scoped tool allowlist and fs.write capability when fetch is available', async () => {
    const spawn = vi.fn(async () => 'done');
    const { command } = rig({ withFetch: true, onSpawnAndWait: spawn });
    const res = await command.run('', {} as never);
    expect(spawn).toHaveBeenCalledTimes(1);
    const passedOpts = spawn.mock.calls[0]![1]!;
    expect(passedOpts.tools).toEqual(
      expect.arrayContaining(['read', 'fetch', 'write']),
    );
    // Shell tools must NOT be granted.
    expect(passedOpts.tools).not.toContain('bash');
    expect(passedOpts.tools).not.toContain('exec');
    expect(passedOpts.allowedCapabilities).toEqual(
      expect.arrayContaining(['fs.read', 'net.outbound', 'fs.write']),
    );
    expect(passedOpts.allowedCapabilities).not.toContain('shell.arbitrary');
    expect(res.message).toBe('done');
  });

  it('reports when multi-agent is disabled (no onSpawnAndWait)', async () => {
    const { command } = rig({ withFetch: true });
    const res = await command.run('', {} as never);
    expect(res.message).toMatch(/multi-agent is not enabled/i);
  });
});
