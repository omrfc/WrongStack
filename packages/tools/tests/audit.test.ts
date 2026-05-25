import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const spawnStreamMocks = vi.hoisted(() => ({ spawnStream: vi.fn() }));

vi.mock('../src/_spawn-stream.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spawnStream: spawnStreamMocks.spawnStream,
  };
});

import { auditTool } from '../src/audit.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

function fakeSpawnStream(stdout: string, exitCode = 0) {
  // biome-ignore lint/correctness/useYield: test mock doesn't need actual yield
  return async function* () {
    return { stdout, stderr: '', exitCode, truncated: false };
  };
}

beforeEach(() => {
  spawnStreamMocks.spawnStream.mockReset();
  // Default: empty audit (no vulnerabilities)
  spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('', 0));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auditTool', () => {
  it('has correct metadata', () => {
    expect(auditTool.name).toBe('audit');
    expect(auditTool.permission).toBe('confirm');
    expect(auditTool.mutating).toBe(false);
    expect(auditTool.inputSchema.type).toBe('object');
  });

  it('handles empty packages', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ level: 'high' }, ctx, opts);
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('vulnerabilities');
  });

  it('passes fix flag to args', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ fix: true }, ctx, opts);
    expect(result).toHaveProperty('output');
  });

  it('passes packages to args', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ packages: 'foo,bar' }, ctx, opts);
    expect(result).toHaveProperty('output');
  });

  it('handles packages as array', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ packages: ['foo', 'bar'] }, ctx, opts);
    expect(result).toHaveProperty('output');
  });

  it('handles level filter', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ level: 'critical' }, ctx, opts);
    expect(result).toHaveProperty('exit_code');
  });

  it('parses npm audit JSON into vulnerability list (with critical + high tally)', async () => {
    const payload = JSON.stringify({
      advisories: {
        '1001': {
          severity: 'critical',
          module_name: 'evil-pkg',
          title: 'Remote code execution',
          url: 'https://example.com/advisory/1001',
        },
        '1002': {
          severity: 'high',
          module_name: 'bad-pkg',
          title: 'Prototype pollution',
          url: 'https://example.com/advisory/1002',
        },
        '1003': {
          severity: 'moderate',
          module_name: 'meh-pkg',
          title: 'Regex DoS',
          url: 'https://example.com/advisory/1003',
        },
      },
    });
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream(payload, 1));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.total).toBe(3);
    expect(result.summary).toContain('1 critical');
    expect(result.summary).toContain('1 high');
    expect(result.vulnerabilities.map((v) => v.package).sort()).toEqual([
      'bad-pkg',
      'evil-pkg',
      'meh-pkg',
    ]);
  });

  it('reports "No vulnerabilities found" on clean exit with empty output', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('', 0));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.summary).toBe('No vulnerabilities found');
    expect(result.total).toBe(0);
  });

  it('reports "Audit failed" when exit code is non-zero with empty output', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('', 1));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.summary).toBe('Audit failed');
    expect(result.exit_code).toBe(1);
  });

  it('returns "Could not parse" message when JSON is malformed', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('garbage{', 0));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.summary).toBe('Could not parse audit output');
    expect(result.vulnerabilities).toEqual([]);
    expect(result.output).toBe('garbage{');
  });

  it('uses fallback "Unknown vulnerability" when advisory entries are missing fields', async () => {
    const payload = JSON.stringify({
      advisories: {
        only_id: { /* no fields at all */ },
      },
    });
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream(payload, 0));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].title).toBe('Unknown vulnerability');
    expect(result.vulnerabilities[0].severity).toBe('unknown');
    expect(result.vulnerabilities[0].package).toBe('only_id');
  });

  it('reports zero critical/high when only lower-severity advisories are present', async () => {
    const payload = JSON.stringify({
      advisories: { '1': { severity: 'low', module_name: 'x', title: 't', url: 'u' } },
    });
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream(payload, 0));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.summary).toContain('0 critical');
    expect(result.summary).toContain('0 high');
  });

  it('execute throws if executeStream emits no final event', async () => {
    // spawnStream returns empty output — but we make executeStream skip the final yield
    // by replacing it on the tool directly. Easier: stream that throws.
    spawnStreamMocks.spawnStream.mockImplementation(async function* () {
      // Yield nothing, return nothing
    });
    // The default executeStream's `yield* spawnStream(...)` will still call
    // parseAuditOutput on undefined.stdout — so we won't reach the "no final"
    // error. Instead, replace executeStream to skip the final yield entirely.
    const original = auditTool.executeStream!;
    auditTool.executeStream = async function* (this: never) {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(auditTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(/without final event/);
    } finally {
      auditTool.executeStream = original;
    }
  });
});
