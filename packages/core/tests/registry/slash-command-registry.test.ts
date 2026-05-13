import { describe, it, expect } from 'vitest';
import { SlashCommandRegistry } from '../../src/registry/slash-command-registry.js';
import type { Context } from '../../src/core/context.js';

describe('SlashCommandRegistry', () => {
  it('dispatch returns null for non-slash', async () => {
    const r = new SlashCommandRegistry();
    expect(await r.dispatch('hello', {} as Context)).toBeNull();
  });

  it('dispatch returns message for unknown', async () => {
    const r = new SlashCommandRegistry();
    const res = await r.dispatch('/nope', {} as Context);
    expect(res?.message).toMatch(/Unknown/);
  });

  it('dispatches with args', async () => {
    const r = new SlashCommandRegistry();
    let received = '';
    r.register({
      name: 'echo',
      description: 'echo',
      async run(args) {
        received = args;
      },
    });
    await r.dispatch('/echo hi there', {} as Context);
    expect(received).toBe('hi there');
  });

  it('aliases route to same command', async () => {
    const r = new SlashCommandRegistry();
    let calls = 0;
    r.register({
      name: 'exit',
      aliases: ['q', 'quit'],
      description: 'exit',
      async run() {
        calls++;
      },
    });
    await r.dispatch('/exit', {} as Context);
    await r.dispatch('/q', {} as Context);
    await r.dispatch('/quit', {} as Context);
    expect(calls).toBe(3);
  });

  it('rejects duplicate from different owner', () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'x', description: '', async run() {} });
    expect(() => r.register({ name: 'x', description: '', async run() {} }, 'plugin')).toThrow();
  });

  it('plugin commands get namespaced names', async () => {
    const r = new SlashCommandRegistry();
    let ran = false;
    r.register(
      { name: 'cmd', aliases: ['c'], description: 'plugin cmd', async run() { ran = true; } },
      'my-plugin',
    );
    // Registered as `my-plugin:cmd`
    expect(r.get('my-plugin:cmd')?.name).toBe('cmd');
    // Direct lookup
    expect(r.ownerOf('my-plugin:cmd')).toBe('my-plugin');
    // Alias registered as `my-plugin:c`
    expect(r.get('my-plugin:c')?.name).toBe('cmd');
    // /my-plugin:cmd args
    await r.dispatch('/my-plugin:cmd', {} as Context);
    expect(ran).toBe(true);
  });

  it('builtin commands do not get prefix', () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'status', description: 'status', async run() {} });
    expect(r.get('status')?.name).toBe('status');
    expect(r.get('core:status')).toBeUndefined();
  });

  it('dispatches builtin name with colon in it', async () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'git:status', description: 'git status', async run() {} }, 'core');
    // A builtin called "git:status" — parsed as builtin (owner=core)
    await r.dispatch('/git:status', {} as Context);
    expect(r.ownerOf('git:status')).toBe('core');
  });

  it('same plugin can re-register its own commands', async () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'deploy', description: 'deploy', async run() {} }, 'k8s');
    // No throw
    r.register({ name: 'deploy', description: 'deploy v2', async run() {} }, 'k8s');
    expect(r.get('k8s:deploy')?.description).toBe('deploy v2');
  });

  it('listWithOwner includes fullName', async () => {
    const r = new SlashCommandRegistry();
    r.register({ name: 'status', description: 's', async run() {} });
    r.register({ name: 'log', description: 'l', async run() {} }, 'cloud');
    const entries = r.listWithOwner();
    expect(entries.find((e) => e.owner === 'core')?.fullName).toBe('status');
    expect(entries.find((e) => e.owner === 'cloud')?.fullName).toBe('cloud:log');
  });
});
