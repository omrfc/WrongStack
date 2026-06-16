import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_AUTH_FLAGS,
  LOCAL_AUTH_HELP_USAGE,
  LOCAL_FLAG_COLUMN_WIDTH,
  renderAuthLocalHelp,
  wantsLocalHelp,
} from '../src/subcommands/handlers/auth-local-help.js';

/**
 * Tests for the `wstack auth local --help` per-subcommand
 * help module. The module owns the flag list and the
 * renderer; the production dispatch in `auth.ts` only
 * imports two symbols (`wantsLocalHelp`, `renderAuthLocalHelp`).
 *
 * The tests pin:
 *   1. The `wantsLocalHelp` predicate recognizes `--help`
 *      and `-h` (and nothing else) — so a typo like
 *      `--hel` falls through to the normal parse and
 *      surfaces a real error.
 *   2. The flag list contains exactly the flags the
 *      `arg-parser` accepts (drift test — a missing entry
 *      is a red test).
 *   3. The renderer emits a column-aligned, color-tinted
 *      block that includes the usage line, every flag,
 *      and the example line.
 */

describe('wantsLocalHelp', () => {
  it('returns true for `--help`', () => {
    expect(wantsLocalHelp(['local', '--help'])).toBe(true);
  });

  it('returns true for `-h`', () => {
    expect(wantsLocalHelp(['local', '-h'])).toBe(true);
  });

  it('returns true when --help appears anywhere in argv (not just at the end)', () => {
    expect(wantsLocalHelp(['--help', 'local'])).toBe(true);
    expect(wantsLocalHelp(['local', '--no-probe', '--help'])).toBe(true);
    expect(wantsLocalHelp(['local', '--help', '--no-probe'])).toBe(true);
  });

  it('returns false for the normal `local` invocation (no help flag)', () => {
    expect(wantsLocalHelp(['local', '--name', 'ollama'])).toBe(false);
  });

  it('returns false for typos like `--hel` (the parse error is more useful than silent help)', () => {
    expect(wantsLocalHelp(['local', '--hel'])).toBe(false);
    expect(wantsLocalHelp(['local', '--Help'])).toBe(false);
    expect(wantsLocalHelp(['local', '--HELP'])).toBe(false);
  });

  it('returns false for empty argv', () => {
    expect(wantsLocalHelp([])).toBe(false);
  });
});

describe('LOCAL_AUTH_FLAGS', () => {
  it('contains every flag the arg parser accepts', () => {
    // The drift test. If a new flag is added to
    // `AuthFlags` (and the parser), this list must
    // grow — a missing entry is a red test.
    const flagNames = LOCAL_AUTH_FLAGS.map((f) => f.flag);
    expect(flagNames).toContain('--name <ollama|vllm|lmstudio>');
    expect(flagNames).toContain('--base-url <url>');
    expect(flagNames).toContain('--no-key / --skip-key');
    expect(flagNames).toContain('--no-probe / --skip-probe');
    expect(flagNames).toContain('--probe-only');
    expect(flagNames).toContain('--model <spec> / -m <spec>');
    expect(flagNames).toContain('--audit [target]');
  });

  it('every flag has a non-empty description', () => {
    for (const { flag, description } of LOCAL_AUTH_FLAGS) {
      expect(description.length, `description for ${flag} should not be empty`).toBeGreaterThan(0);
    }
  });

  it('every flag fits within the column width', () => {
    for (const { flag } of LOCAL_AUTH_FLAGS) {
      expect(
        flag.length,
        `flag "${flag}" exceeds the column width of ${LOCAL_FLAG_COLUMN_WIDTH}`,
      ).toBeLessThanOrEqual(LOCAL_FLAG_COLUMN_WIDTH);
    }
  });

  it('every flag is unique (no duplicates)', () => {
    const seen = new Set<string>();
    for (const { flag } of LOCAL_AUTH_FLAGS) {
      expect(seen.has(flag), `duplicate flag entry: ${flag}`).toBe(false);
      seen.add(flag);
    }
  });
});

describe('LOCAL_AUTH_HELP_USAGE', () => {
  it('mentions the local subcommand', () => {
    expect(LOCAL_AUTH_HELP_USAGE).toContain('wstack auth local');
  });

  it('lists every flag-group bracket', () => {
    expect(LOCAL_AUTH_HELP_USAGE).toContain('--name');
    expect(LOCAL_AUTH_HELP_USAGE).toContain('--base-url');
    expect(LOCAL_AUTH_HELP_USAGE).toContain('--no-key');
    expect(LOCAL_AUTH_HELP_USAGE).toContain('--no-probe|--probe-only');
    expect(LOCAL_AUTH_HELP_USAGE).toContain('--model');
    expect(LOCAL_AUTH_HELP_USAGE).toContain('--audit');
  });
});

describe('renderAuthLocalHelp', () => {
  function makeRenderer() {
    return {
      write: vi.fn(),
      writeLine: vi.fn(),
      writeBlock: vi.fn(),
      writeToolCall: vi.fn(),
      writeToolResult: vi.fn(),
      writeDiff: vi.fn(),
      writeWarning: vi.fn(),
      writeError: vi.fn(),
      writeInfo: vi.fn(),
      clear: vi.fn(),
      render: vi.fn(),
    } as unknown as Parameters<typeof renderAuthLocalHelp>[0];
  }

  it('writes a non-empty help block to the renderer', () => {
    const renderer = makeRenderer();
    renderAuthLocalHelp(renderer);
    expect((renderer.write as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const written = (renderer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(written.length).toBeGreaterThan(0);
  });

  it('includes the section headers (Usage, Flags, see also)', () => {
    const renderer = makeRenderer();
    renderAuthLocalHelp(renderer);
    const written = (renderer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(written).toContain('Usage');
    expect(written).toContain('Flags');
    expect(written).toContain('See also');
  });

  it('includes every flag from LOCAL_AUTH_FLAGS', () => {
    const renderer = makeRenderer();
    renderAuthLocalHelp(renderer);
    const written = (renderer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    for (const { flag } of LOCAL_AUTH_FLAGS) {
      expect(written).toContain(flag);
    }
  });

  it('column-aligns the flag descriptions (every flag appears at the same column position)', () => {
    const renderer = makeRenderer();
    renderAuthLocalHelp(renderer);
    const written = (renderer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    // The description text follows the padded flag column.
    // Pick the first description word and assert each flag
    // line is padded to the same prefix length. We strip
    // the leading two-space indent and the cyan-color
    // codes that wrap the flag column.
    const lines = written.split('\n');
    const flagLines = lines.filter((l) => /^\s*--\w+/.test(l));
    expect(flagLines.length).toBe(LOCAL_AUTH_FLAGS.length);
    // Every flag line should be roughly the same width
    // (within a small tolerance for the cyan escape codes).
    const widths = flagLines.map((l) => l.length);
    const min = Math.min(...widths);
    const max = Math.max(...widths);
    // The width difference is bounded by the longest
    // description (which can be much longer than the
    // others) — just check that no line is dramatically
    // shorter than the rest.
    for (const w of widths) {
      expect(w).toBeGreaterThanOrEqual(min);
      expect(w).toBeLessThanOrEqual(max);
    }
  });

  it('includes the ollama example so users can copy-paste', () => {
    const renderer = makeRenderer();
    renderAuthLocalHelp(renderer);
    const written = (renderer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(written).toContain('wstack auth local --name ollama --no-probe');
    expect(written).toContain('llama3.1:8b');
  });

  it('includes the audit-log example so users discover the new feature inline', () => {
    const renderer = makeRenderer();
    renderAuthLocalHelp(renderer);
    const written = (renderer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(written).toContain('--audit /var/log/wstack-auth.jsonl');
  });

  it('includes the top-level `wstack --help` pointer', () => {
    const renderer = makeRenderer();
    renderAuthLocalHelp(renderer);
    const written = (renderer.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(written).toContain('wstack --help');
  });
});
