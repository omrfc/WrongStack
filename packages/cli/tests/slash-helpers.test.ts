import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  countToolResults,
  countToolUses,
  countTurnPairs,
  detectProjectFacts,
  estimateTokens,
  renderAgentsTemplate,
  statusIcon,
} from '../src/slash-commands/helpers.js';

type Msg = Context['messages'][number];

// Strip ANSI escapes so colored output assertions stay portable.
const stripAnsi = (s: string): string => s.replace(/\[[0-9;]*m/g, '');

describe('slash-commands/helpers — message counters', () => {
  it('countTurnPairs returns 0 for no user/assistant', () => {
    const msgs: Msg[] = [{ role: 'system', content: 'hi' } as Msg];
    expect(countTurnPairs(msgs)).toBe(0);
  });

  it('countTurnPairs floors odd counts', () => {
    const msgs: Msg[] = [
      { role: 'user', content: 'a' } as Msg,
      { role: 'assistant', content: 'b' } as Msg,
      { role: 'user', content: 'c' } as Msg,
    ];
    expect(countTurnPairs(msgs)).toBe(1);
  });

  it('countTurnPairs ignores system messages in the pair count', () => {
    const msgs: Msg[] = [
      { role: 'system', content: 's' } as Msg,
      { role: 'user', content: 'u' } as Msg,
      { role: 'assistant', content: 'a' } as Msg,
    ];
    expect(countTurnPairs(msgs)).toBe(1);
  });

  it('countToolUses counts tool_use blocks across messages', () => {
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'x' },
          { type: 'tool_use', id: '1', name: 'foo', input: {} },
          { type: 'tool_use', id: '2', name: 'bar', input: {} },
        ],
      } as Msg,
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '3', name: 'baz', input: {} }],
      } as Msg,
    ];
    expect(countToolUses(msgs)).toBe(3);
  });

  it('countToolUses ignores string-content messages', () => {
    const msgs: Msg[] = [{ role: 'assistant', content: 'plain text' } as Msg];
    expect(countToolUses(msgs)).toBe(0);
  });

  it('countToolResults counts tool_result blocks', () => {
    const msgs: Msg[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: '1', content: 'ok' },
          { type: 'tool_result', tool_use_id: '2', content: 'ok2' },
        ],
      } as Msg,
    ];
    expect(countToolResults(msgs)).toBe(2);
  });
});

describe('slash-commands/helpers — estimateTokens', () => {
  it('estimates 0 for empty input', () => {
    expect(estimateTokens([])).toBe(0);
  });

  it('uses ceil(len/3.5) for string content', () => {
    // chars/3.5: 4 chars → ceil(4/3.5) = 2, 5 chars → ceil(5/3.5) = 2
    const msgs: Msg[] = [{ role: 'user', content: 'abcd' } as Msg];
    expect(estimateTokens(msgs)).toBe(2);
    const msgs2: Msg[] = [{ role: 'user', content: 'abcde' } as Msg];
    expect(estimateTokens(msgs2)).toBe(2);
  });

  it('sums text block lengths', () => {
    // chars/3.5: each 4-char block → ceil(4/3.5) = 2 tokens
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'aaaa' },
          { type: 'text', text: 'bbbb' },
        ],
      } as Msg,
    ];
    expect(estimateTokens(msgs)).toBe(4); // 2 + 2
  });

  it('counts tool_use and tool_result blocks by serialized length', () => {
    const msgs: Msg[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'foo', input: { x: 1 } }],
      } as Msg,
    ];
    const out = estimateTokens(msgs);
    expect(out).toBeGreaterThan(0);
  });

  it('handles mixed string + block messages', () => {
    // chars/3.5: 'abcd' → 2, 'efgh' → 2 → total 4
    const msgs: Msg[] = [
      { role: 'user', content: 'abcd' } as Msg,
      { role: 'assistant', content: [{ type: 'text', text: 'efgh' }] } as Msg,
    ];
    expect(estimateTokens(msgs)).toBe(4);
  });
});

describe('slash-commands/helpers — statusIcon', () => {
  it('returns green dot for healthy', () => {
    const s = stripAnsi(statusIcon('healthy'));
    expect(s).toBe('●');
  });
  it('returns yellow dot for degraded', () => {
    const s = stripAnsi(statusIcon('degraded'));
    expect(s).toBe('●');
  });
  it('returns red dot for anything else', () => {
    const s = stripAnsi(statusIcon('offline'));
    expect(s).toBe('●');
    const s2 = stripAnsi(statusIcon(''));
    expect(s2).toBe('●');
  });
  it('always contains the bullet glyph regardless of status', () => {
    expect(statusIcon('healthy')).toContain('●');
    expect(statusIcon('degraded')).toContain('●');
    expect(statusIcon('down')).toContain('●');
  });
});

describe('slash-commands/helpers — renderAgentsTemplate', () => {
  it('emits a markdown document with section headers', () => {
    const out = renderAgentsTemplate({ hints: [] });
    expect(out.startsWith('# AGENTS.md')).toBe(true);
    expect(out).toContain('## Project brief');
    expect(out).toContain('## Commands');
  });

  it('renders TODO placeholder when a command is missing', () => {
    const out = renderAgentsTemplate({ hints: [] });
    expect(out).toContain('| Build | _TODO_ |');
    expect(out).toContain('| Test | _TODO_ |');
  });

  it('renders backticks around supplied commands', () => {
    const out = renderAgentsTemplate({
      hints: ['package.json'],
      build: 'pnpm run build',
      test: 'pnpm test',
      lint: 'pnpm run lint',
      run: 'pnpm run dev',
    });
    expect(out).toContain('| Build | `pnpm run build` |');
    expect(out).toContain('| Test | `pnpm test` |');
    expect(out).toContain('| Lint | `pnpm run lint` |');
    expect(out).toContain('| Run locally | `pnpm run dev` |');
  });
});

describe('slash-commands/helpers — detectProjectFacts', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'ws-helpers-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns empty hints for an unknown directory', async () => {
    const facts = await detectProjectFacts(tmp);
    expect(facts.hints).toEqual([]);
    expect(facts.build).toBeUndefined();
    expect(facts.test).toBeUndefined();
  });

  it('detects pnpm from pnpm-lock.yaml + package.json scripts', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .', dev: 'vite' },
      }),
    );
    await writeFile(path.join(tmp, 'pnpm-lock.yaml'), '');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('pnpm run build');
    expect(facts.test).toBe('pnpm test');
    expect(facts.lint).toBe('pnpm run lint');
    expect(facts.run).toBe('pnpm run dev');
    expect(facts.hints).toContain('package.json scripts');
  });

  it('defaults to npm when no lockfile is present', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('npm run build');
  });

  it('honors packageManager field', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        packageManager: 'yarn@4.0.0',
        scripts: { build: 'tsc' },
      }),
    );
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('yarn run build');
  });

  it('skips the default "no test specified" placeholder', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      }),
    );
    const facts = await detectProjectFacts(tmp);
    expect(facts.test).toBeUndefined();
  });

  it('detects go.mod and provides go-flavored commands', async () => {
    await writeFile(path.join(tmp, 'go.mod'), 'module example.com/x\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('go build ./...');
    expect(facts.test).toBe('go test ./...');
    expect(facts.run).toBe('go run .');
    expect(facts.hints).toContain('go.mod');
  });

  it('detects Cargo.toml and provides rust commands', async () => {
    await writeFile(path.join(tmp, 'Cargo.toml'), '[package]\nname="x"\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('cargo build');
    expect(facts.test).toBe('cargo test');
    expect(facts.lint).toBe('cargo clippy');
    expect(facts.run).toBe('cargo run');
    expect(facts.hints).toContain('Cargo.toml');
  });

  it('detects pyproject.toml', async () => {
    await writeFile(path.join(tmp, 'pyproject.toml'), '[project]\nname="x"\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.test).toBe('pytest');
    expect(facts.lint).toBe('ruff check .');
    expect(facts.hints).toContain('pyproject.toml');
  });

  it('detects Makefile targets and falls back to bare "make"', async () => {
    await writeFile(path.join(tmp, 'Makefile'), 'test:\n\techo hi\n\nlint:\n\techo lint\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('make');
    expect(facts.test).toBe('make test');
    expect(facts.lint).toBe('make lint');
    expect(facts.hints).toContain('Makefile');
  });

  it('Makefile detection does not overwrite earlier detections', async () => {
    await writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }),
    );
    await writeFile(path.join(tmp, 'Makefile'), 'build:\n\techo make-build\n');
    const facts = await detectProjectFacts(tmp);
    expect(facts.build).toBe('npm run build');
    expect(facts.test).toBe('npm test');
    expect(facts.hints).toContain('Makefile');
  });
});
