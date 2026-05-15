import { describe, expect, it } from 'vitest';
import {
  allServers,
  awsServer,
  blockServer,
  braveSearchServer,
  context7Server,
  everArtServer,
  filesystemServer,
  githubServer,
  googleMapsServer,
  sentinelServer,
  slackServer,
} from '../../src/infrastructure/mcp-servers.js';
import type { MCPServerConfig } from '../../src/types/config.js';

/**
 * V0-D: every built-in MCP preset returns a config that passes the
 * minimum shape the registry requires. We don't try to validate every
 * field — that's the registry's job — but we pin the contract that
 * matters: name, transport, and the transport-specific required keys.
 */

const VALID_TRANSPORTS = new Set<MCPServerConfig['transport']>(['stdio', 'sse', 'streamable-http']);

function assertValidShape(cfg: MCPServerConfig): void {
  expect(typeof cfg.name).toBe('string');
  expect(cfg.name.length).toBeGreaterThan(0);
  expect(VALID_TRANSPORTS.has(cfg.transport)).toBe(true);

  if (cfg.transport === 'stdio') {
    expect(cfg.command, `${cfg.name} stdio: command must be set`).toBeTruthy();
  } else {
    expect(cfg.url, `${cfg.name} ${cfg.transport}: url must be set`).toBeTruthy();
  }

  // Permission must be one of the known kinds (the registry will reject
  // an unknown value at boot, but it's cheaper to catch it here too).
  if (cfg.permission !== undefined) {
    expect(['auto', 'confirm', 'deny']).toContain(cfg.permission);
  }
}

describe('built-in MCP server presets (V0-D)', () => {
  const presets: Array<[string, () => MCPServerConfig]> = [
    ['filesystem', filesystemServer],
    ['github', githubServer],
    ['context7', context7Server],
    ['brave-search', braveSearchServer],
    ['block', blockServer],
    ['everart', everArtServer],
    ['slack', slackServer],
    ['aws', awsServer],
    ['google-maps', googleMapsServer],
    ['sentinel', sentinelServer],
  ];

  for (const [label, factory] of presets) {
    it(`${label} returns a valid MCPServerConfig`, () => {
      assertValidShape(factory());
    });
  }

  it('factories are pure — calling twice yields equivalent (but distinct) objects', () => {
    const a = filesystemServer();
    const b = filesystemServer();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('allServers() returns every preset keyed by config.name', () => {
    const all = allServers();
    const names = Object.keys(all).sort();
    expect(names).toContain('filesystem');
    expect(names).toContain('github');
    expect(names).toContain('context7');
    // Each entry's key matches its config.name.
    for (const [key, cfg] of Object.entries(all)) {
      expect(key).toBe(cfg.name);
      assertValidShape(cfg);
    }
  });

  it('every preset shipped without enabled:true so adoption stays opt-in', () => {
    // It's fine for `enabled` to be undefined, but it must NOT be true by default.
    for (const [label, factory] of presets) {
      const cfg = factory();
      expect(cfg.enabled, `${label} must not default to enabled:true`).not.toBe(true);
    }
  });
});
