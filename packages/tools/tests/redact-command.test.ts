import { describe, expect, it } from 'vitest';
import { redactCommand } from '../src/process-registry.js';

/**
 * P2 #13 (before-release.md): redactCommand() applies 5 regex patterns to
 * redact credentials from displayed command lines (TUI status bar, /ps output,
 * crash dumps). These patterns are security-critical: false negatives leak
 * secrets to the TUI and log files; false positives make legitimate commands
 * unreadable. Neither case was tested.
 *
 * These tests pin both directions — secrets are redacted, non-secrets are
 * left intact — across every SENSITIVE_FLAG_PATTERNS regex path.
 */
describe('redactCommand — secret redaction (P2 #13)', () => {
  describe('env-var-style secrets (TOKEN=x, API_KEY=y)', () => {
    it.each([
      ['export API_KEY=sk-abc123', /API_KEY=\[REDACTED\]/],
      ['export TOKEN=ghp_xxxxx', /TOKEN=\[REDACTED\]/],
      ['export GITHUB_TOKEN=ghp_xxxxx', /GITHUB_TOKEN=\[REDACTED\]/],
      ['export GH_TOKEN=ghp_xxxxx', /GH_TOKEN=\[REDACTED\]/],
      ['export SECRET=mypassword', /SECRET=\[REDACTED\]/],
      ['export PASSWORD=hunter2', /PASSWORD=\[REDACTED\]/],
      ['export JWT=eyJhbGci', /JWT=\[REDACTED\]/],
      ['export BEARER=abc123', /BEARER=\[REDACTED\]/],
      ['API_KEY=sk-abc123 npm start', /API_KEY=\[REDACTED\]/],
      // space-separated (export VAR value) — the `=` form is the primary;
      // space-separated may or may not redact depending on the regex. We
      // assert the `=` form is covered and do not over-claim the space form.
    ])('redacts %j', (cmd, pattern) => {
      expect(redactCommand(cmd)).toMatch(pattern);
    });
  });

  describe('long flags (--token=value, --github-token=...)', () => {
    it.each([
      ['npm install --token=abc123', /--token=\[REDACTED\]/],
      ['npm install --api-key=sk-abc123', /--api-key=\[REDACTED\]/],
      ['npm install --api_key=sk-abc123', /--api_key=\[REDACTED\]/],
      ['git clone --github-token=ghp_xxxxx', /--github-token=\[REDACTED\]/],
      ['git clone --gh-token=ghp_xxxxx', /--gh-token=\[REDACTED\]/],
      ['curl --password=hunter2 https://example.com', /--password=\[REDACTED\]/],
      ['curl --secret=mypassword https://example.com', /--secret=\[REDACTED\]/],
      ['curl --auth=bearer123 https://example.com', /--auth=\[REDACTED\]/],
      ['curl --credential=user:pass https://example.com', /--credential=\[REDACTED\]/],
      ['curl --private-key=-----BEGIN https://example.com', /--private-key=\[REDACTED\]/],
      ['curl --access-key=AKIAIOSF https://example.com', /--access-key=\[REDACTED\]/],
      ['curl --access_token=abc https://example.com', /--access_token=\[REDACTED\]/],
    ])('redacts %j', (cmd, pattern) => {
      expect(redactCommand(cmd)).toMatch(pattern);
    });
  });

  describe('short flags (-t value, -p value)', () => {
    it.each([
      ['curl -t abc123 https://example.com', /-t\s+\[REDACTED\]/],
      ['curl -t=abc123 https://example.com', /-t=\[REDACTED\]/],
      // Note: `-password hunter2` is partially redacted — the regex matches
      // `-p` + optional `ssword` + whitespace + value, so it consumes the
      // value but the `ssword` tail survives as `-p[REDACTED]ssword`-style
      // output. This is a known heuristic imprecision (the `-p(?:ssword)?`
      // alternation), not a regression. We assert the value is redacted
      // (hunter2 does not leak) without asserting the exact flag shape.
      // The env-var regex (#3) catches `PASSWORD=hunter2` cleanly, so the
      // export form is the reliable coverage path for password secrets.
    ])('redacts %j', (cmd, pattern) => {
      expect(redactCommand(cmd)).toMatch(pattern);
    });

    it('does not leak the value of -password hunter2', () => {
      const out = redactCommand('curl -password hunter2 https://example.com');
      expect(out).not.toMatch(/hunter2/);
    });
  });

  describe('high-entropy base64 after a secret-flag name', () => {
    it.each([
      ['--github-token=EyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIi', /--github-token=\[REDACTED\]/],
      ['--api-key=SkRmOQzN3a8qP4xY7vW2bH1cU6tZ0sL9', /--api-key=\[REDACTED\]/],
    ])('redacts %j', (cmd, pattern) => {
      expect(redactCommand(cmd)).toMatch(pattern);
    });
  });

  describe('non-secrets are left intact (false-positive guard)', () => {
    it.each([
      ['echo hello', 'echo hello'],
      ['npm install', 'npm install'],
      ['pnpm build', 'pnpm build'],
      ['node index.js', 'node index.js'],
      ['ls -la', 'ls -la'],
      ['git status', 'git status'],
      ['cat /home/user/token.txt', 'cat /home/user/token.txt'],
      // token.txt is a filename, not a --token=value flag — must NOT redact.
    ])('leaves %j unchanged', (cmd, expected) => {
      expect(redactCommand(cmd)).toBe(expected);
    });
  });

  describe('idempotency', () => {
    it('redacting an already-redacted command is stable', () => {
      const once = redactCommand('export TOKEN=secret123');
      const twice = redactCommand(once);
      expect(twice).toBe(once);
    });

    it('redacting a command with no secrets returns the same string', () => {
      const cmd = 'npm install lodash';
      expect(redactCommand(cmd)).toBe(cmd);
    });
  });

  describe('multiple secrets in one command', () => {
    it('redacts every secret, not just the first', () => {
      const cmd = 'export API_KEY=sk-abc TOKEN=ghp_xyz --password=hunter2';
      const redacted = redactCommand(cmd);
      expect(redacted).toMatch(/API_KEY=\[REDACTED\]/);
      expect(redacted).toMatch(/TOKEN=\[REDACTED\]/);
      expect(redacted).toMatch(/--password=\[REDACTED\]/);
      // No raw secrets leak through.
      expect(redacted).not.toMatch(/sk-abc/);
      expect(redacted).not.toMatch(/ghp_xyz/);
      expect(redacted).not.toMatch(/hunter2/);
    });
  });
});
