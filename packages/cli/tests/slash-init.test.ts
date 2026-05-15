import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SlashCommandRegistry } from '@wrongstack/core';
import type { Context } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildBuiltinSlashCommands } from '../src/slash-commands/index.js';

class FakeRenderer {
  buf = '';
  write(s: string) {
    this.buf += s;
  }
  writeInfo(s: string) {
    this.buf += `INFO: ${s}\n`;
  }
  writeWarning(s: string) {
    this.buf += `WARN: ${s}\n`;
  }
  writeError(s: string) {
    this.buf += `ERR: ${s}\n`;
  }
  writeToolCall() {}
  writeToolResult() {}
}

function makeRegistry(renderer: FakeRenderer) {
  const reg = new SlashCommandRegistry();
  const cmds = buildBuiltinSlashCommands({
    registry: reg,
    toolRegistry: { list: () => [] } as never,
    renderer: renderer as never,
    tokenCounter: { total: () => ({ input: 0, output: 0 }) } as never,
  });
  for (const c of cmds) reg.register(c);
  return reg;
}

describe('/init slash command', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-init-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function mkCtx(): Context {
    return { projectRoot: tmp } as unknown as Context;
  }

  it('writes .wrongstack/AGENTS.md when missing', async () => {
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('# AGENTS.md');
    expect(written).toContain('Build:');
    expect(r.buf).toContain('INFO: Wrote');
  });

  it('warns and skips when AGENTS.md already exists', async () => {
    await fs.mkdir(path.join(tmp, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'EXISTING');
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toBe('EXISTING');
    expect(r.buf).toContain('WARN:');
    expect(r.buf).toContain('already exists');
  });

  it('overwrites with --force', async () => {
    await fs.mkdir(path.join(tmp, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'EXISTING');
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init --force', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('# AGENTS.md');
    expect(written).not.toBe('EXISTING');
  });

  it('detects package.json scripts and pre-fills build/test/lint', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .' },
        packageManager: 'pnpm@9.0.0',
      }),
    );
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('`pnpm run build`');
    expect(written).toContain('`pnpm test`');
    expect(written).toContain('`pnpm run lint`');
    expect(r.buf).toContain('Pre-filled');
    expect(r.buf).toContain('package.json scripts');
  });

  it('detects Cargo.toml and Go module', async () => {
    await fs.writeFile(path.join(tmp, 'go.mod'), 'module example\ngo 1.21\n');
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('`go build ./...`');
    expect(written).toContain('`go test ./...`');
  });
});
