import { describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';

const s = new DefaultSecretScrubber();

describe('SecretScrubber', () => {
  it('redacts anthropic-style keys', () => {
    const inp = 'token=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh';
    expect(s.scrub(inp)).toContain('[REDACTED:anthropic_key]');
  });
  it('redacts github PAT', () => {
    const inp = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
    expect(s.scrub(inp)).toContain('[REDACTED:github_pat]');
  });
  it('redacts AWS access keys', () => {
    expect(s.scrub('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED:aws_access_key]');
  });
  it('redacts JWT-like tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(s.scrub(jwt)).toContain('[REDACTED:jwt]');
  });
  it('redacts mongodb URIs', () => {
    expect(s.scrub('mongodb://user:pass@host/db')).toContain('[REDACTED:mongodb_uri]');
  });
  it('redacts high-entropy env-style assignments', () => {
    expect(s.scrub('MY_API_KEY=abcdef1234567890abcdef1234567890')).toContain(
      '[REDACTED:high_entropy_env]',
    );
  });
  it('leaves normal text untouched', () => {
    expect(s.scrub('hello world')).toBe('hello world');
  });
  it('scrubObject recurses', () => {
    const obj = { nested: { token: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123' } };
    const out = s.scrubObject(obj);
    expect(out.nested.token).toContain('[REDACTED');
  });
});
