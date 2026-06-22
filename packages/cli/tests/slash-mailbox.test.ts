import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalMailbox } from '@wrongstack/core';
import { buildMailboxCommand } from '../src/slash-commands/mailbox.js';
import { touchProjectInManifest, loadManifest } from '../src/slash-commands/project-utils.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, '');
}

describe('/mailbox slash command', () => {
  let tmp: string;
  let opts: SlashCommandContext;
  let mailbox: GlobalMailbox;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-slash-mb-'));
    await fs.mkdir(tmp, { recursive: true });
    mailbox = new GlobalMailbox(tmp);
    opts = {
      projectRoot: tmp,
      paths: { projectDir: tmp } as SlashCommandContext['paths'],
      context: {
        meta: { agentId: 'leader', globalAgentId: 'leader#999' },
      } as never as SlashCommandContext['context'],
    } as SlashCommandContext;
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('broadcast sends a "*" message attributed to this process leader', async () => {
    const cmd = buildMailboxCommand(opts);
    const res = await cmd.run('broadcast hold deploys until tests pass', opts.context);
    expect(stripAnsi(res?.message ?? '')).toContain('Broadcast to all agents');

    const all = await mailbox.query({ limit: 10 });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      from: 'leader#999',
      to: '*',
      type: 'broadcast',
      body: 'hold deploys until tests pass',
    });
  });

  it('send delivers a direct message to the named agent', async () => {
    const cmd = buildMailboxCommand(opts);
    const res = await cmd.run('send worker#42 please take the auth task', opts.context);
    expect(stripAnsi(res?.message ?? '')).toContain('Sent to worker#42');
    const all = await mailbox.query({ to: 'worker#42', limit: 10 });
    expect(all).toHaveLength(1);
    expect(all[0]!.body).toBe('please take the auth task');
  });

  it('inbox shows messages addressed to the unique id, base alias, and broadcasts — then marks them read', async () => {
    await mailbox.send({ from: 'worker#42', to: 'leader#999', type: 'note', subject: 'direct', body: 'direct msg' });
    await mailbox.send({ from: 'worker#42', to: 'leader', type: 'note', subject: 'alias', body: 'alias msg' });
    await mailbox.send({ from: 'worker#42', to: '*', type: 'broadcast', subject: 'bcast', body: 'bcast msg' });
    await mailbox.send({ from: 'worker#42', to: 'other', type: 'note', subject: 'not-mine', body: 'x' });

    const cmd = buildMailboxCommand(opts);
    const res = await cmd.run('', opts.context);
    const msg = stripAnsi(res?.message ?? '');
    expect(msg).toContain('3 unread message(s)');
    expect(msg).toContain('direct msg');
    expect(msg).toContain('alias msg');
    expect(msg).toContain('bcast msg');
    expect(msg).not.toContain('not-mine');

    // Second call: everything was acked under the unique id.
    const res2 = await cmd.run('', opts.context);
    expect(stripAnsi(res2?.message ?? '')).toContain('Inbox empty');
  });

  it('agents lists registered agents and marks self', async () => {
    await mailbox.registerAgent({ agentId: 'leader#999', name: 'Leader [cli]', sessionId: 's1', pid: 999 });
    await mailbox.registerAgent({ agentId: 'leader#1000', name: 'Leader [webui]', sessionId: 's2', pid: 1000 });

    const cmd = buildMailboxCommand(opts);
    const res = await cmd.run('agents', opts.context);
    const msg = stripAnsi(res?.message ?? '');
    expect(msg).toContain('2 agent(s)');
    expect(msg).toContain('leader#999 (you)');
    expect(msg).toContain('leader#1000');
  });

  it('history shows recent project traffic oldest-first', async () => {
    await mailbox.send({ from: 'a', to: '*', type: 'broadcast', subject: 'first', body: 'first' });
    await mailbox.send({ from: 'b', to: '*', type: 'broadcast', subject: 'second', body: 'second' });
    const cmd = buildMailboxCommand(opts);
    const res = await cmd.run('history 10', opts.context);
    const msg = stripAnsi(res?.message ?? '');
    expect(msg.indexOf('first')).toBeLessThan(msg.indexOf('second'));
  });
});

describe('touchProjectInManifest', () => {
  let home: string;
  let configPath: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-manifest-'));
    configPath = path.join(home, 'config.json');
  });

  afterEach(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it('creates a manifest entry (with workdir) when the project is unknown', async () => {
    const root = path.join(home, 'my-project');
    await fs.mkdir(root, { recursive: true });
    const entry = await touchProjectInManifest({
      projectRoot: root,
      globalConfigPath: configPath,
      workingDir: path.join(root, 'packages', 'core'),
    });
    expect(entry.name).toBe('my-project');
    expect(entry.createdAt).toBeTruthy();
    expect(entry.lastWorkingDir).toContain('core');

    const manifest = await loadManifest(configPath);
    expect(manifest.projects).toHaveLength(1);
    expect(path.resolve(manifest.projects[0]!.root)).toBe(path.resolve(root));
    // Per-project data dir created alongside.
    await expect(
      fs.access(path.join(home, 'projects', entry.slug)),
    ).resolves.toBeUndefined();
  });

  it('refreshes lastSeen/lastWorkingDir without duplicating an existing entry', async () => {
    const root = path.join(home, 'proj');
    await fs.mkdir(root, { recursive: true });
    const first = await touchProjectInManifest({ projectRoot: root, globalConfigPath: configPath });
    await new Promise((r) => setTimeout(r, 5));
    const second = await touchProjectInManifest({
      projectRoot: root,
      globalConfigPath: configPath,
      workingDir: root,
    });
    expect(second.slug).toBe(first.slug);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastSeen! >= first.lastSeen!).toBe(true);
    const manifest = await loadManifest(configPath);
    expect(manifest.projects).toHaveLength(1);
  });

  it('two concurrent registrations of different projects both land (file lock)', async () => {
    const rootA = path.join(home, 'a');
    const rootB = path.join(home, 'b');
    await fs.mkdir(rootA, { recursive: true });
    await fs.mkdir(rootB, { recursive: true });
    await Promise.all([
      touchProjectInManifest({ projectRoot: rootA, globalConfigPath: configPath }),
      touchProjectInManifest({ projectRoot: rootB, globalConfigPath: configPath }),
    ]);
    const manifest = await loadManifest(configPath);
    expect(manifest.projects.map((p) => p.name).sort()).toEqual(['a', 'b']);
  });
});
