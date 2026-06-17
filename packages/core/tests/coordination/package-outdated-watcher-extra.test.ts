import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the author tracker so we control author resolution per test.
const getPackageAuthor = vi.fn();
vi.mock('../../src/coordination/package-author-tracker.js', () => ({
  getPackageAuthor: (...args: unknown[]) => getPackageAuthor(...args),
}));

import { startPackageOutdatedWatcher } from '../../src/coordination/package-outdated-watcher.js';

function makeMailbox(messages: unknown[]) {
  return {
    query: vi.fn(async () => messages),
    ack: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
  } as never;
}

async function collectNotifications(messages: unknown[]): Promise<Array<{ to: string; subject: string; body: string }>> {
  const out: Array<{ to: string; subject: string; body: string }> = [];
  const dispose = startPackageOutdatedWatcher({
    mailbox: makeMailbox(messages),
    packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
    pollIntervalMs: 999_999_999,
    onNotify: async (m) => { out.push({ to: m.to, subject: m.subject, body: m.body }); },
    onLog: () => {},
  });
  await vi.advanceTimersByTimeAsync(0);
  dispose();
  return out;
}

const msg = (body: string) => ({ id: 'm1', from: 'tech-stack', body, timestamp: new Date().toISOString(), type: 'result' as const });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getPackageAuthor.mockReset();
  getPackageAuthor.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe('package-outdated-watcher — extra coverage', () => {
  it('detects every ecosystem and emits the right update command', async () => {
    const rows = [
      ['npm-pkg', 'package.json', 'pnpm add'],
      ['go-pkg', 'go.mod', 'go get'],
      ['cargo-pkg', 'cargo.toml', 'cargo update'],
      ['pip-pkg', 'pyproject.toml', 'pip install'],
      ['gem-pkg', 'gemfile', 'gem install'],
      ['comp-pkg', 'composer.json', 'composer require'],
      ['nuget-pkg', 'app.csproj', 'dotnet add package'],
      ['mvn-pkg', 'pom.xml', 'mvn versions'],
      ['dart-pkg', 'pubspec.yaml', 'dart pub upgrade'],
      ['elixir-pkg', 'mix.exs', 'using your package manager'], // elixir → default command
      ['weird-pkg', 'weird.xyz', 'using your package manager'], // unknown → default
    ];
    const table =
      '| Package | Current | Latest | Wanted | Manifest |\n' +
      '|---|---|---|---|---|\n' +
      rows.map(([name, manifest]) => `| ${name} | 1.0.0 | 2.0.0 | ^1.0.0 | ${manifest} |`).join('\n') + '\n';

    const notes = await collectNotifications([msg(table)]);
    expect(notes).toHaveLength(rows.length);
    for (const [name, , cmd] of rows) {
      const note = notes.find((n) => n.subject.includes(name));
      expect(note, name).toBeDefined();
      expect(note?.to).toBe('*'); // no author → broadcast
      expect(note?.body).toContain(cmd);
    }
  });

  it('parses the key=value fallback format when there is no table', async () => {
    const notes = await collectNotifications([msg('package: leftpad current: 1.0.0 latest: 2.0.0')]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.subject).toContain('leftpad');
  });

  it('addresses a known author and labels the body accordingly', async () => {
    getPackageAuthor.mockResolvedValueOnce({ agentId: 'agent-7', agentName: 'bob' });
    const table =
      '| Package | Current | Latest | Wanted | Manifest |\n|---|---|---|---|---|\n' +
      '| known | 1.0.0 | 2.0.0 | ^1.0.0 | package.json |\n';
    const notes = await collectNotifications([msg(table)]);
    expect(notes[0]?.to).toBe('agent-7');
    expect(notes[0]?.body).toContain('You added this package');
    expect(notes[0]?.body).toContain('as bob');
  });

  it('omits the "(as name)" hint when the author name is unknown', async () => {
    getPackageAuthor.mockResolvedValueOnce({ agentId: 'agent-9', agentName: 'unknown' });
    const table =
      '| Package | Current | Latest | Wanted | Manifest |\n|---|---|---|---|---|\n' +
      '| anon | 1.0.0 | 2.0.0 | ^1.0.0 | package.json |\n';
    const notes = await collectNotifications([msg(table)]);
    expect(notes[0]?.body).toContain('You added this package');
    expect(notes[0]?.body).not.toContain('(as ');
  });

  it('logs and skips a message with no parseable packages', async () => {
    const logs: string[] = [];
    const dispose = startPackageOutdatedWatcher({
      mailbox: makeMailbox([msg('nothing to see here')]),
      packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
      pollIntervalMs: 999_999_999,
      onNotify: async () => {},
      onLog: (m) => logs.push(m),
    });
    await vi.advanceTimersByTimeAsync(0);
    dispose();
    expect(logs.some((l) => l.includes('No outdated packages'))).toBe(true);
  });

  it('reports per-entry errors when author lookup throws', async () => {
    getPackageAuthor.mockRejectedValueOnce(new Error('tracker boom'));
    const errors: unknown[] = [];
    const logs: string[] = [];
    const table =
      '| Package | Current | Latest | Wanted | Manifest |\n|---|---|---|---|---|\n' +
      '| boom | 1.0.0 | 2.0.0 | ^1.0.0 | package.json |\n';
    const dispose = startPackageOutdatedWatcher({
      mailbox: makeMailbox([msg(table)]),
      packageTrackerOpts: { storageDir: '/tmp', projectRoot: '/tmp' },
      pollIntervalMs: 999_999_999,
      onNotify: async () => {},
      onLog: (m) => logs.push(m),
      onError: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(0);
    dispose();
    expect(errors).toHaveLength(1);
    expect(logs.some((l) => l.includes('Failed to notify'))).toBe(true);
  });
});
