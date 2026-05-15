import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildChildEnv } from '../src/_env.js';

describe('buildChildEnv (security gate for bash/exec child env)', () => {
  const original: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined) => {
    if (!(k in original)) original[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  beforeEach(() => {
    // Wipe touched keys before each test
    for (const k of Object.keys(original)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });
  afterEach(() => {
    for (const k of Object.keys(original)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it('forwards explicit allowlist (PATH, HOME, LANG, ...)', () => {
    set('PATH', '/usr/bin');
    set('HOME', '/home/test');
    set('LANG', 'en_US.UTF-8');
    const env = buildChildEnv();
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/test');
    expect(env['LANG']).toBe('en_US.UTF-8');
  });

  it('strips provider API keys', () => {
    set('ANTHROPIC_API_KEY', 'sk-ant-xxx');
    set('OPENAI_API_KEY', 'sk-xxx');
    set('GOOGLE_API_KEY', 'AIza-xxx');
    const env = buildChildEnv();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['GOOGLE_API_KEY']).toBeUndefined();
  });

  it('strips GitHub / AWS / npm tokens', () => {
    set('GITHUB_TOKEN', 'ghp_xxx');
    set('AWS_SECRET_ACCESS_KEY', 'xxx');
    set('AWS_ACCESS_KEY_ID', 'AKIA…');
    set('NPM_TOKEN', 'xxx');
    set('NODE_AUTH_TOKEN', 'xxx');
    const env = buildChildEnv();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['AWS_ACCESS_KEY_ID']).toBeUndefined();
    expect(env['NPM_TOKEN']).toBeUndefined();
    expect(env['NODE_AUTH_TOKEN']).toBeUndefined();
  });

  it('strips compound secret names (DATABASE_PASSWORD, CLIENT_SECRET, ...)', () => {
    set('DATABASE_PASSWORD', 'hunter2');
    set('CLIENT_SECRET', 'shh');
    set('SLACK_BEARER_TOKEN', 'xoxb');
    set('REFRESH_TOKEN', 'r');
    set('SESSION_COOKIE', 'c');
    const env = buildChildEnv();
    expect(env['DATABASE_PASSWORD']).toBeUndefined();
    expect(env['CLIENT_SECRET']).toBeUndefined();
    expect(env['SLACK_BEARER_TOKEN']).toBeUndefined();
    expect(env['REFRESH_TOKEN']).toBeUndefined();
    expect(env['SESSION_COOKIE']).toBeUndefined();
  });

  it('preserves PWD (allowlisted, false-positive risk on regex)', () => {
    set('PWD', '/tmp/work');
    const env = buildChildEnv();
    expect(env['PWD']).toBe('/tmp/work');
  });

  it('forwards npm/node/pnpm helper vars (non-secret)', () => {
    set('NODE_OPTIONS', '--no-warnings');
    set('NPM_CONFIG_REGISTRY', 'https://registry.npmjs.org');
    set('PNPM_HOME', '/home/.pnpm');
    set('CI', 'true');
    const env = buildChildEnv();
    expect(env['NODE_OPTIONS']).toBe('--no-warnings');
    expect(env['NPM_CONFIG_REGISTRY']).toBe('https://registry.npmjs.org');
    expect(env['PNPM_HOME']).toBe('/home/.pnpm');
    expect(env['CI']).toBe('true');
  });

  it('strips _AUTHTOKEN suffix (NPM_CONFIG__AUTHTOKEN style)', () => {
    set('NPM_CONFIG__AUTHTOKEN', 'leak');
    set('npm_config__authtoken', 'leak2');
    const env = buildChildEnv();
    expect(env['NPM_CONFIG__AUTHTOKEN']).toBeUndefined();
    expect(env['npm_config__authtoken']).toBeUndefined();
  });

  it('does not forward random unknown vars', () => {
    set('SOMETHING_RANDOM', 'value');
    const env = buildChildEnv();
    expect(env['SOMETHING_RANDOM']).toBeUndefined();
  });

  it('injects WRONGSTACK_SESSION_ID when provided', () => {
    const env = buildChildEnv('session-abc');
    expect(env['WRONGSTACK_SESSION_ID']).toBe('session-abc');
  });

  it('passthrough mode forwards everything when WRONGSTACK_BASH_ENV_PASSTHROUGH=1', () => {
    set('WRONGSTACK_BASH_ENV_PASSTHROUGH', '1');
    set('ANTHROPIC_API_KEY', 'sk-ant-pass');
    set('SOMETHING_RANDOM', 'value');
    const env = buildChildEnv();
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-pass');
    expect(env['SOMETHING_RANDOM']).toBe('value');
  });
});
