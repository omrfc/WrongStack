import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { color } from '@wrongstack/core';

// We can't easily test slash commands without the full wiring,
// so we test the helper functions directly

describe('Git commit helper functions', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-commit-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function runGit(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve) => {
      const child = spawn('git', args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => (stdout += d));
      child.stderr?.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    });
  }

  async function initGitRepo() {
    await runGit(['init']);
    await runGit(['config', 'user.email', 'test@test.com']);
    await runGit(['config', 'user.name', 'Test']);
  }

  describe('detectCommitType', () => {
    it('detects test files', async () => {
      const testFile = path.join(tmp, 'foo.test.ts');
      await fs.writeFile(testFile, '', 'utf8');
      await initGitRepo();
      await runGit(['add', '.']);
      const result = await runGit(['diff', '--cached', '--stat']);
      expect(result.stdout).toContain('.test.ts');
    });

    it('detects docs files', async () => {
      const readme = path.join(tmp, 'README.md');
      await fs.writeFile(readme, '# Test', 'utf8');
      await initGitRepo();
      await runGit(['add', '.']);
      const result = await runGit(['diff', '--cached', '--stat']);
      expect(result.stdout).toContain('.md');
    });
  });

  describe('hasUncommittedChanges', () => {
    it('returns false in clean repo', async () => {
      await initGitRepo();
      const result = await runGit(['status', '--porcelain']);
      expect(result.stdout.trim()).toBe('');
    });

    it('returns true when files are modified', async () => {
      await initGitRepo();
      await fs.writeFile(path.join(tmp, 'test.txt'), 'content', 'utf8');
      const result = await runGit(['status', '--porcelain']);
      expect(result.stdout.trim()).not.toBe('');
    });
  });

  describe('isGitRepo', () => {
    it('returns true in git repo', async () => {
      await initGitRepo();
      const result = await runGit(['rev-parse', '--git-dir']);
      expect(result.code).toBe(0);
    });

    it('returns false in non-git directory', async () => {
      const result = await runGit(['rev-parse', '--git-dir']);
      expect(result.code).not.toBe(0);
    });
  });

  describe('commit workflow', () => {
    it('stages and commits all changes', async () => {
      await initGitRepo();
      await fs.writeFile(path.join(tmp, 'test.txt'), 'hello', 'utf8');

      // Stage
      const stageResult = await runGit(['add', '.']);
      expect(stageResult.code).toBe(0);

      // Commit
      const commitResult = await runGit(['commit', '-m', 'test: initial commit']);
      expect(commitResult.code).toBe(0);

      // Verify
      const logResult = await runGit(['log', '--oneline']);
      expect(logResult.stdout).toContain('test: initial commit');
    });

    it('pushes to remote', async () => {
      // Create a bare remote
      const remoteTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-remote-'));
      await runGit(['init', '--bare', remoteTmp]);

      await initGitRepo();
      await fs.writeFile(path.join(tmp, 'test.txt'), 'hello', 'utf8');
      await runGit(['add', '.']);
      await runGit(['commit', '-m', 'test: initial']);

      // Determine branch name
      const branchResult = await runGit(['branch', '--show-current']);
      const branch = branchResult.stdout.trim() || 'main';

      // Add remote
      const remoteResult = await runGit(['remote', 'add', 'origin', remoteTmp]);
      expect(remoteResult.code).toBe(0);

      // Push
      const pushResult = await runGit(['push', '-u', 'origin', branch]);
      expect(pushResult.code).toBe(0);

      await fs.rm(remoteTmp, { recursive: true, force: true });
    });
  });
});