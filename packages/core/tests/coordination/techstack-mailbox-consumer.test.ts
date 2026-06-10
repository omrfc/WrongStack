import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  startTechStackConsumer,
  type TechStackConsumerOptions,
} from '../../src/coordination/techstack-mailbox-consumer.js';
import { DefaultMailbox } from '../../src/coordination/mailbox.js';
import type { MailboxMessage } from '../../src/coordination/mailbox-types.js';

describe('techstack-mailbox-consumer', () => {
  let tmpDir: string;
  let mailbox: DefaultMailbox;
  let spawnedTasks: Array<{ task: string; name: string }>;
  let dispose: (() => void) | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsc-test-'));
    mailbox = new DefaultMailbox(tmpDir);
    spawnedTasks = [];
  });

  afterEach(async () => {
    if (dispose) {
      dispose();
      dispose = undefined;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('spawns agent when assign message arrives', async () => {
    const onSpawn = vi.fn(async (task: string, name: string) => {
      spawnedTasks.push({ task, name });
      return { subagentId: 'ts-1', taskId: 'task-1' };
    });

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    // Post an assign message
    await mailbox.send({
      id: 'msg-1',
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'Dependency manifest changed: package.json',
      body: 'Manifest: package.json\n\n| File | Event |\n| package.json | change |',
      timestamp: new Date().toISOString(),
    });

    // Wait for poll cycle
    await new Promise((r) => setTimeout(r, 250));

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(spawnedTasks[0].name).toBe('tech-stack-package.json');
    expect(spawnedTasks[0].task).toContain('package.json');
  });

  it('does not spawn for non-assign messages', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    await mailbox.send({
      id: 'msg-2',
      from: 'someone',
      to: 'tech-stack',
      type: 'btw',
      subject: 'Hello',
      body: 'Just saying hi',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('does not spawn for messages to other agents', async () => {
    const onSpawn = vi.fn(async () => ({ subagentId: 'x', taskId: 'y' }));

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      targetAgent: 'tech-stack',
      pollIntervalMs: 100,
    });

    await mailbox.send({
      id: 'msg-3',
      from: 'dep-watcher',
      to: 'bug-hunter',
      type: 'assign',
      subject: 'package.json changed',
      body: 'Manifest: package.json',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('extracts manifest path from subject fallback', async () => {
    const onSpawn = vi.fn(async (task: string, name: string) => {
      spawnedTasks.push({ task, name });
      return { subagentId: 'x', taskId: 'y' };
    });

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      pollIntervalMs: 100,
    });

    await mailbox.send({
      id: 'msg-4',
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'go.mod updated in backend/',
      body: 'Some generic body without manifest info',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(spawnedTasks[0].task).toContain('go.mod');
  });

  it('calls onError when spawn fails', async () => {
    const onSpawn = vi.fn(async () => {
      throw new Error('spawn failed');
    });
    const onError = vi.fn();

    dispose = startTechStackConsumer({
      mailbox,
      onSpawn,
      onError,
      pollIntervalMs: 100,
    });

    await mailbox.send({
      id: 'msg-5',
      from: 'dep-watcher',
      to: 'tech-stack',
      type: 'assign',
      subject: 'Cargo.toml changed',
      body: 'Manifest: Cargo.toml',
      timestamp: new Date().toISOString(),
    });

    await new Promise((r) => setTimeout(r, 250));
    expect(onError).toHaveBeenCalled();
  });
});
