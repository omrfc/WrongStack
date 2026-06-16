/**
 * Tests for EnsembleRegistry.
 *
 * Strategy: inject a fake `probeFn` so the tests don't depend on what's
 * actually installed on the runner's $PATH. The catalog is the default.
 *
 * At the bottom there's one `it.liveProbe` test gated by `RUN_LIVE_PROBE=1`
 * in the environment — that test runs the real probe against the host's
 * $PATH and prints the result. It's useful for sanity-checking the
 * catalog's `probe` commands on a developer's machine. Skipped by default
 * to keep CI deterministic.
 */
import { describe, expect, it, vi } from 'vitest';
import { AGENTS_CATALOG } from '../src/registry/agents.catalog.js';
import { EnsembleRegistry } from '../src/registry/ensemble-registry.js';
import type { ACPAgentDescriptor, DetectedAgent } from '../src/registry/ensemble-registry.js';

const CLAUDE: ACPAgentDescriptor = {
  id: 'claude-code',
  displayName: 'Claude Code',
  vendor: 'anthropic',
  probe: { command: 'claude', args: ['--version'] },
  acp: { command: 'claude', args: [] },
  supports: { loadSession: true, promptImages: true, terminal: true, fs: true },
  integration: 'native',
  docs: 'https://example.com',
};

const GEMINI: ACPAgentDescriptor = {
  ...CLAUDE,
  id: 'gemini-cli',
  displayName: 'Gemini CLI',
  vendor: 'google',
  probe: { command: 'gemini', args: ['--version'] },
  integration: 'native',
};

const FAKE_CATALOG: readonly ACPAgentDescriptor[] = [CLAUDE, GEMINI];

describe('EnsembleRegistry', () => {
  it('listAll returns the catalog in declaration order', () => {
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG });
    expect(reg.listAll().map((a) => a.id)).toEqual(['claude-code', 'gemini-cli']);
  });

  it('detect() marks an agent installed when the probe reports success', async () => {
    const probe = vi.fn(async () => ({
      ok: true as const,
      version: '2.1.178',
      path: '/usr/local/bin/claude',
      durationMs: 12,
    }));
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    const got: DetectedAgent = await reg.detect(CLAUDE);
    expect(got.installed).toBe(true);
    expect(got.version).toBe('2.1.178');
    expect(got.path).toBe('/usr/local/bin/claude');
  });

  it('detect() marks an agent not-installed and reports the reason on failure', async () => {
    const probe = vi.fn(async () => ({
      ok: false as const,
      reason: 'binary not found',
      durationMs: 0,
    }));
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    const got = await reg.detect(CLAUDE);
    expect(got.installed).toBe(false);
    expect(got.reason).toBe('binary not found');
    expect(got.path).toBeUndefined();
  });

  it('list() probes every catalog entry in parallel', async () => {
    const probe = vi.fn(async (d: ACPAgentDescriptor) =>
      d.id === 'claude-code'
        ? { ok: true as const, version: '1', durationMs: 1 }
        : { ok: false as const, reason: 'no', durationMs: 0 },
    );
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    const all = await reg.list();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(all.find((a) => a.id === 'claude-code')?.installed).toBe(true);
    expect(all.find((a) => a.id === 'gemini-cli')?.installed).toBe(false);
  });

  it('list() caches results for PROBE_CACHE_MS', async () => {
    const probe = vi.fn(async () => ({
      ok: true as const,
      version: '1',
      durationMs: 1,
    }));
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    await reg.list();
    await reg.list();
    expect(probe).toHaveBeenCalledTimes(2); // once per entry, only on first list
    reg.invalidate();
    await reg.list();
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('listInstalled returns only the installed entries', async () => {
    const probe = vi.fn(async (d: ACPAgentDescriptor) =>
      d.id === 'claude-code'
        ? { ok: true as const, version: '1', durationMs: 1 }
        : { ok: false as const, reason: 'no', durationMs: 0 },
    );
    const reg = new EnsembleRegistry({ catalog: FAKE_CATALOG, probeFn: probe });
    const installed = await reg.listInstalled();
    expect(installed.map((a) => a.id)).toEqual(['claude-code']);
  });
});

describe('AGENTS_CATALOG', () => {
  it('has unique ids', () => {
    const ids = AGENTS_CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has non-empty displayName, vendor, and docs', () => {
    for (const a of AGENTS_CATALOG) {
      expect(a.displayName.length).toBeGreaterThan(0);
      expect(a.vendor).toBeTruthy();
      expect(a.docs.length).toBeGreaterThan(0);
    }
  });

  it('every entry has a non-empty probe command', () => {
    for (const a of AGENTS_CATALOG) {
      expect(a.probe.command.length).toBeGreaterThan(0);
    }
  });
});

describe('live probe (opt-in via RUN_LIVE_PROBE=1)', () => {
  it.runIf(process.env.RUN_LIVE_PROBE === '1')(
    'prints the live detection result for the host $PATH',
    async () => {
      const reg = new EnsembleRegistry();
      const all = await reg.list();
      // eslint-disable-next-line no-console
      console.log('\n--- EnsembleRegistry live probe ---');
      for (const a of all) {
        const mark = a.installed ? 'OK ' : '   ';
        const detail = a.installed ? a.version ?? '?' : a.reason ?? '?';
        // eslint-disable-next-line no-console
        console.log(`${mark} ${a.id.padEnd(14)} ${detail}`);
      }
      // eslint-disable-next-line no-console
      console.log('-------------------------------------');
      expect(all.length).toBeGreaterThan(0);
    },
  );
});
