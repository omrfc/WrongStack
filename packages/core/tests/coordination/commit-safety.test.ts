import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileAuthorEntry } from '../../src/index.js';
import { assessCommitSafety } from '../../src/index.js';

let repo: string;
let storageDir: string;

async function writeTracker(entries: Partial<FileAuthorEntry>[]): Promise<void> {
  const full = entries.map((e) => ({
    filePath: e.filePath ?? '',
    action: e.action ?? 'edit',
    agentId: e.agentId ?? 'leader',
    agentName: e.agentName,
    sessionId: e.sessionId,
    timestamp: e.timestamp ?? new Date(0).toISOString(),
  }));
  await fs.writeFile(
    path.join(storageDir, 'file-authors.json'),
    JSON.stringify({ projectRoot: repo, entries: full }, null, 2),
  );
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-safety-repo-'));
  storageDir = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-safety-store-'));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
  await fs.rm(storageDir, { recursive: true, force: true }).catch(() => {});
});

describe('assessCommitSafety', () => {
  it('returns an empty report for a clean working tree', async () => {
    const report = await assessCommitSafety({ cwd: repo, projectRoot: repo, storageDir });
    expect(report.dirtyCount).toBe(0);
    expect(report.warning).toBe('');
    expect(report.foreignFiles).toEqual([]);
    expect(report.unverifiedFiles).toEqual([]);
  });

  it('does not flag files this session authored', async () => {
    await fs.writeFile(path.join(repo, 'ours.ts'), 'export const a = 1;\n');
    await writeTracker([{ filePath: 'ours.ts', sessionId: 'sessA', agentName: 'Leader' }]);

    const report = await assessCommitSafety({
      cwd: repo,
      projectRoot: repo,
      sessionId: 'sessA',
      storageDir,
    });

    expect(report.dirtyCount).toBe(1);
    expect(report.foreignFiles).toEqual([]);
    expect(report.unverifiedFiles).toEqual([]);
    expect(report.warning).toBe('');
  });

  it('flags files authored by another session as foreign', async () => {
    await fs.writeFile(path.join(repo, 'ours.ts'), '1\n');
    await fs.writeFile(path.join(repo, 'theirs.ts'), '2\n');
    await writeTracker([
      { filePath: 'ours.ts', sessionId: 'sessA' },
      { filePath: 'theirs.ts', sessionId: 'sessB', agentName: 'Reviewer' },
    ]);

    const report = await assessCommitSafety({
      cwd: repo,
      projectRoot: repo,
      sessionId: 'sessA',
      storageDir,
    });

    expect(report.dirtyCount).toBe(2);
    expect(report.foreignFiles).toHaveLength(1);
    expect(report.foreignFiles[0]?.path).toBe('theirs.ts');
    expect(report.foreignFiles[0]?.agentName).toBe('Reviewer');
    expect(report.warning).toContain('theirs.ts');
    expect(report.warning).toContain('another agent/session');
  });

  it('warns about unverified files only when this session is actively tracked', async () => {
    await fs.writeFile(path.join(repo, 'ours.ts'), 'x\n');
    await fs.writeFile(path.join(repo, 'mystery.ts'), 'y\n');
    // Session sessA has a recorded edit → tracking is active, so an untracked
    // dirty file is genuinely suspicious.
    await writeTracker([{ filePath: 'ours.ts', sessionId: 'sessA' }]);

    const report = await assessCommitSafety({
      cwd: repo,
      projectRoot: repo,
      sessionId: 'sessA',
      storageDir,
    });

    expect(report.foreignFiles).toEqual([]);
    expect(report.unverifiedFiles).toEqual(['mystery.ts']);
    expect(report.warning).toContain('Unverified author');
    expect(report.warning).toContain('mystery.ts');
  });

  it('suppresses unverified-only noise when this session is not tracked', async () => {
    // No tracker entries for sessA → fresh/solo run. An untracked dirty file is
    // most likely our own un-recorded edit, so do not cry wolf.
    await fs.writeFile(path.join(repo, 'mystery.ts'), 'x\n');
    await writeTracker([]); // empty log

    const report = await assessCommitSafety({
      cwd: repo,
      projectRoot: repo,
      sessionId: 'sessA',
      storageDir,
    });

    expect(report.foreignFiles).toEqual([]);
    expect(report.unverifiedFiles).toEqual(['mystery.ts']); // still reported as data
    expect(report.warning).toBe(''); // but no warning
  });

  it('uses the latest author entry when a file was edited more than once', async () => {
    await fs.writeFile(path.join(repo, 'shared.ts'), 'y\n');
    await writeTracker([
      { filePath: 'shared.ts', sessionId: 'sessB', timestamp: new Date(1).toISOString() },
      { filePath: 'shared.ts', sessionId: 'sessA', timestamp: new Date(2).toISOString() },
    ]);

    const report = await assessCommitSafety({
      cwd: repo,
      projectRoot: repo,
      sessionId: 'sessA',
      storageDir,
    });

    // Newest entry is sessA (ours) → not foreign.
    expect(report.foreignFiles).toEqual([]);
    expect(report.warning).toBe('');
  });

  it('never throws when the directory is not a git repo', async () => {
    const notRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'commit-safety-norepo-'));
    try {
      const report = await assessCommitSafety({
        cwd: notRepo,
        projectRoot: notRepo,
        storageDir,
      });
      expect(report.dirtyCount).toBe(0);
      expect(report.warning).toBe('');
    } finally {
      // Windows can briefly hold the dir handle after the git probe — tolerate.
      await fs.rm(notRepo, { recursive: true, force: true }).catch(() => {});
    }
  });
});
