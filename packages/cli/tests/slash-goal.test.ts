import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type Context,
  DefaultTokenCounter,
  HybridCompactor,
  SlashCommandRegistry,
  ToolRegistry,
  appendJournal,
  emptyGoal,
  goalFilePath,
  loadGoal,
  saveGoal,
} from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGoalCommand } from '../src/slash-commands/goal.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

class FakeRenderer {
  output = '';
  warnings: string[] = [];
  errors: string[] = [];
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
  writeError(s: string): void {
    this.errors.push(s);
  }
  writeInfo(): void {}
  clear(): void {
    this.output = '';
  }
}

function rig(projectRoot: string) {
  const registry = new SlashCommandRegistry();
  const renderer = new FakeRenderer();
  const ctx: Partial<SlashCommandContext> = {
    registry,
    toolRegistry: new ToolRegistry(),
    tokenCounter: new DefaultTokenCounter(),
    compactor: new HybridCompactor({ preserveK: 5 }),
    renderer: renderer as unknown as SlashCommandContext['renderer'],
    cwd: projectRoot,
    projectRoot,
  };
  const goalCmd = buildGoalCommand(ctx as SlashCommandContext);
  registry.register(goalCmd);
  return { registry, renderer, ctx };
}

const fakeCtx = {
  messages: [],
  todos: [],
  systemPrompt: [],
  readFiles: new Set(),
  fileMtimes: new Map(),
  model: 'test-model',
  cwd: '/tmp',
  projectRoot: '/proj',
} as unknown as Context;

describe('/goal slash command', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-goal-cli-'));
    await fs.mkdir(path.join(tmp, '.wrongstack'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('reports no goal set when goal.json is missing', async () => {
    const { registry } = rig(tmp);
    const result = await registry.dispatch('/goal', fakeCtx);
    expect(result?.message).toMatch(/No goal set/);
  });

  it('/goal set writes the file and reports back', async () => {
    const { registry } = rig(tmp);
    const result = await registry.dispatch('/goal set Ship release v2', fakeCtx);
    expect(result?.message).toContain('Goal locked');
    expect(result?.message).toContain('Ship release v2');
    expect(result?.runText).toContain('GOAL — LOCKED IN');
    expect(result?.runText).toContain('Ship release v2');
    const onDisk = await loadGoal(goalFilePath(tmp));
    expect(onDisk?.goal).toBe('Ship release v2');
    expect(onDisk?.iterations).toBe(0);
  });

  it('/goal <text> without "set" prefix is treated as setting the goal', async () => {
    const { registry } = rig(tmp);
    const result = await registry.dispatch('/goal rewrite the auth module', fakeCtx);
    expect(result?.message).toContain('Goal locked');
    expect(result?.message).toContain('rewrite the auth module');
    expect(result?.runText).toContain('rewrite the auth module');
    const onDisk = await loadGoal(goalFilePath(tmp));
    expect(onDisk?.goal).toBe('rewrite the auth module');
  });

  it('/goal set with existing goal preserves the iteration counter', async () => {
    // Seed an existing goal with journal entries.
    let seed = emptyGoal('original mission');
    seed = appendJournal(seed, { source: 'todo', task: 'a', status: 'success' });
    seed = appendJournal(seed, { source: 'git', task: 'b', status: 'success' });
    await saveGoal(goalFilePath(tmp), seed);

    const { registry } = rig(tmp);
    await registry.dispatch('/goal set replaced mission', fakeCtx);
    const after = await loadGoal(goalFilePath(tmp));
    expect(after?.goal).toBe('replaced mission');
    // Journal + iteration count preserved across set.
    expect(after?.iterations).toBe(2);
    expect(after?.journal).toHaveLength(2);
  });

  it('/goal clear unlinks the goal file and signals stop', async () => {
    await saveGoal(goalFilePath(tmp), emptyGoal('to be cleared'));
    const { registry, ctx } = rig(tmp);
    const stopSpy = vi.fn();
    (ctx as SlashCommandContext).onEternalStop = stopSpy;
    const result = await registry.dispatch('/goal clear', fakeCtx);
    expect(result?.message).toMatch(/Goal cleared/);
    expect(stopSpy).toHaveBeenCalledOnce();
    const after = await loadGoal(goalFilePath(tmp));
    expect(after).toBeNull();
  });

  it('/goal clear is a no-op when no goal exists', async () => {
    const { registry } = rig(tmp);
    const result = await registry.dispatch('/goal clear', fakeCtx);
    expect(result?.message).toMatch(/No goal to clear/);
  });

  it('/goal journal shows recent entries', async () => {
    let seed = emptyGoal('journaled goal');
    seed = appendJournal(seed, { source: 'todo', task: 'first task', status: 'success' });
    seed = appendJournal(seed, { source: 'git', task: 'second task', status: 'failure', note: 'broke tests' });
    await saveGoal(goalFilePath(tmp), seed);

    const { registry } = rig(tmp);
    const result = await registry.dispatch('/goal journal', fakeCtx);
    expect(result?.message).toContain('first task');
    expect(result?.message).toContain('second task');
    expect(result?.message).toContain('broke tests');
  });

  it('/goal journal N respects the limit', async () => {
    let seed = emptyGoal('many entries');
    for (let i = 1; i <= 10; i++) {
      seed = appendJournal(seed, { source: 'todo', task: `task-${i}`, status: 'success' });
    }
    await saveGoal(goalFilePath(tmp), seed);

    const { registry } = rig(tmp);
    const result = await registry.dispatch('/goal journal 3', fakeCtx);
    expect(result?.message).toContain('task-10');
    expect(result?.message).toContain('task-9');
    expect(result?.message).toContain('task-8');
    expect(result?.message).not.toContain('task-7');
  });

  it('/goal status formats Spent line when telemetry is present', async () => {
    let seed = emptyGoal('paid mission');
    seed = appendJournal(seed, {
      source: 'todo',
      task: 'expensive',
      status: 'success',
      tokens: { input: 5000, output: 2500 },
      costUsd: 0.075,
    });
    await saveGoal(goalFilePath(tmp), seed);

    const { registry } = rig(tmp);
    const result = await registry.dispatch('/goal status', fakeCtx);
    expect(result?.message).toContain('Spent: $0.0750');
  });

  it('a single unknown word becomes the goal text (merged TUI semantics)', async () => {
    const { registry } = rig(tmp);
    const result = await registry.dispatch('/goal explode', fakeCtx);
    expect(result?.message).toContain('Goal locked');
    expect(result?.runText).toBeDefined();
    const onDisk = await loadGoal(goalFilePath(tmp));
    expect(onDisk?.goal).toBe('explode');
  });
});
