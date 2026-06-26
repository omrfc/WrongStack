import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core';
import { describe, expect, it, vi } from 'vitest';
import { diagnoseConfig } from '../src/config-doctor.js';
import { buildDoctorCommand } from '../src/slash-commands/doctor.js';
import type { SlashCommandContext } from '../src/slash-commands/index.js';

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

describe('diagnoseConfig', () => {
  it('reports a clean config as unchanged with no findings', () => {
    const report = diagnoseConfig({
      version: 1,
      provider: 'anthropic',
      model: 'claude-fable-5',
      hints: true,
    });
    expect(report.findings).toEqual([]);
    expect(report.changed).toBe(false);
  });

  it('coerces stringified booleans and removes uncoercible ones', () => {
    const report = diagnoseConfig({ hints: 'true', debugStream: 'banana' });
    expect(report.fixed['hints']).toBe(true);
    expect('debugStream' in report.fixed).toBe(false);
    expect(report.changed).toBe(true);
    expect(report.findings).toHaveLength(2);
    expect(report.findings.every((f) => f.severity === 'error' && f.fix)).toBe(true);
  });

  it('repairs maxConcurrent strings and keeps zero as runtime default', () => {
    expect(diagnoseConfig({ maxConcurrent: '8' }).fixed['maxConcurrent']).toBe(8);
    expect(diagnoseConfig({ maxConcurrent: 0 }).fixed['maxConcurrent']).toBe(0);
    expect('maxConcurrent' in diagnoseConfig({ maxConcurrent: 'lots' }).fixed).toBe(false);
  });

  it('drops invalid autonomy enums and negative delays', () => {
    const report = diagnoseConfig({
      autonomy: {
        defaultMode: 'automatic',
        enhanceLanguage: 'klingon',
        autoProceedDelayMs: -5,
        enhance: 'true',
      },
    });
    const autonomy = report.fixed['autonomy'] as Record<string, unknown>;
    expect('defaultMode' in autonomy).toBe(false);
    expect('enhanceLanguage' in autonomy).toBe(false);
    expect(autonomy['autoProceedDelayMs']).toBe(0);
    expect(autonomy['enhance']).toBe(true);
  });

  it('removes malformed plugins entries but keeps valid ones', () => {
    const report = diagnoseConfig({
      plugins: ['my-plugin', { name: 'other', enabled: 'false' }, 42, { noName: true }],
    });
    const plugins = report.fixed['plugins'] as unknown[];
    expect(plugins).toHaveLength(2);
    expect((plugins[1] as Record<string, unknown>)['enabled']).toBe(false);
  });

  it('removes non-object extensions entries', () => {
    const report = diagnoseConfig({ extensions: { good: { a: 1 }, bad: 'nope' } });
    const ext = report.fixed['extensions'] as Record<string, unknown>;
    expect('good' in ext).toBe(true);
    expect('bad' in ext).toBe(false);
  });

  it('validates extensions against plugin configSchemas and removes invalid options', () => {
    const report = diagnoseConfig(
      { extensions: { 'semver-bump': { defaultPart: 'gigantic', tagPrefix: 'v' } } },
      [
        {
          name: 'semver-bump',
          configSchema: {
            type: 'object',
            properties: {
              defaultPart: { type: 'string', enum: ['major', 'minor', 'patch', 'auto'] },
              tagPrefix: { type: 'string' },
            },
          },
        },
      ],
    );
    const section = (report.fixed['extensions'] as Record<string, Record<string, unknown>>)[
      'semver-bump'
    ]!;
    expect('defaultPart' in section).toBe(false);
    expect(section['tagPrefix']).toBe('v');
  });

  it('renames case-typo top-level keys and warns on truly unknown ones', () => {
    const report = diagnoseConfig({ debugstream: true, frobnicate: 1 });
    expect(report.fixed['debugStream']).toBe(true);
    expect('debugstream' in report.fixed).toBe(false);
    expect(report.fixed['frobnicate']).toBe(1); // left untouched
    const unknown = report.findings.find((f) => f.path === 'frobnicate');
    expect(unknown?.severity).toBe('warning');
    expect(unknown?.fix).toBeUndefined();
  });

  it('warns on plaintext secrets but never rewrites them', () => {
    const report = diagnoseConfig({ apiKey: 'sk-plain', sync: { githubToken: 'enc:v1:abc' } });
    const warning = report.findings.find((f) => f.path === 'apiKey');
    expect(warning?.severity).toBe('warning');
    expect(report.findings.some((f) => f.path === 'sync.githubToken')).toBe(false);
    expect(report.fixed['apiKey']).toBe('sk-plain');
  });
});

// ---------------------------------------------------------------------------
// /doctor command
// ---------------------------------------------------------------------------

function makeCtx(
  globalContent?: string,
  projectContent?: string,
): {
  ctx: SlashCommandContext;
  globalConfig: string;
  inProjectConfig: string;
  update: ReturnType<typeof vi.fn>;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'wstack-doctor-test-'));
  const wsDir = path.join(dir, '.wrongstack');
  mkdirSync(wsDir, { recursive: true });
  const globalConfig = path.join(wsDir, 'config.json');
  const inProjectConfig = path.join(dir, 'project', 'config.json');
  if (globalContent !== undefined) writeFileSync(globalConfig, globalContent);
  if (projectContent !== undefined) {
    mkdirSync(path.dirname(inProjectConfig), { recursive: true });
    writeFileSync(inProjectConfig, projectContent);
  }
  const update = vi.fn();
  const ctx = {
    configStore: { get: vi.fn(() => ({})), update },
    paths: { globalConfig, inProjectConfig },
  } as never as SlashCommandContext;
  return { ctx, globalConfig, inProjectConfig, update };
}

describe('/doctor slash command', () => {
  it('reports findings without writing in report mode', async () => {
    const content = JSON.stringify({ hints: 'true' });
    const { ctx, globalConfig } = makeCtx(content);
    const res = await buildDoctorCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('hints');
    expect(text).toContain('auto-fixable');
    expect(readFileSync(globalConfig, 'utf8')).toBe(content); // untouched
  });

  it('reports a healthy config', async () => {
    const { ctx } = makeCtx(JSON.stringify({ version: 1, hints: true }));
    const res = await buildDoctorCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('config is healthy');
  });

  it('fix mode repairs the file, backs it up, and updates the config store', async () => {
    const { ctx, globalConfig, update } = makeCtx(
      JSON.stringify({ hints: 'true', maxConcurrent: '6' }),
    );
    const res = await buildDoctorCommand(ctx).run!('fix');
    expect(stripAnsi(res!.message!)).toContain('fixes written');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.hints).toBe(true);
    expect(written.maxConcurrent).toBe(6);
    expect(existsSync(`${globalConfig}.last`)).toBe(true);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ hints: true }));
  });

  it('fix mode restores corrupt JSON from the .last backup', async () => {
    const good = JSON.stringify({ version: 1, hints: true });
    const { ctx, globalConfig } = makeCtx('{ this is not json');
    writeFileSync(`${globalConfig}.last`, good);

    const res = await buildDoctorCommand(ctx).run!('fix');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('restored from config.json.last');
    expect(JSON.parse(readFileSync(globalConfig, 'utf8'))).toEqual({ version: 1, hints: true });
    // The corrupt original is preserved next to the file
    const dir = path.dirname(globalConfig);
    expect(readdirSync(dir).some((f) => f.endsWith('.broken.bak'))).toBe(true);
  });

  it('report mode flags corrupt JSON without touching the file', async () => {
    const { ctx, globalConfig } = makeCtx('{ broken');
    const res = await buildDoctorCommand(ctx).run!('');
    expect(stripAnsi(res!.message!)).toContain('invalid JSON');
    expect(readFileSync(globalConfig, 'utf8')).toBe('{ broken');
  });

  it('warns about credential fields in the project config', async () => {
    const { ctx } = makeCtx(
      JSON.stringify({ version: 1 }),
      JSON.stringify({ apiKey: 'enc:v1:abc', hints: true }),
    );
    const res = await buildDoctorCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('not project-safe');
  });

  it('rejects unknown subcommands', async () => {
    const { ctx } = makeCtx();
    const res = await buildDoctorCommand(ctx).run!('heal');
    expect(stripAnsi(res!.message!)).toContain('Usage: /doctor [fix]');
  });
});
