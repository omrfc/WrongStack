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

  it('scrubs across the 64KB chunk boundary without missing secrets', () => {
    // Inputs larger than SCRUB_CHUNK_BYTES go through the chunked branch.
    // Build a 100KB payload with a secret in each half so we exercise both
    // the early chunk and a chunk after the newline-break boundary.
    const filler = 'x '.repeat(20_000); // ~40 KB
    const newlines = '\n'.repeat(2000); // ~2 KB of newlines for boundary-snap
    const secret1 = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const secret2 = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const blob = `${filler}\n${secret1}\n${newlines}\n${filler}\n${secret2}\n`;
    expect(blob.length).toBeGreaterThan(64 * 1024);
    const scrubbed = s.scrub(blob);
    expect(scrubbed).toContain('[REDACTED:anthropic_key]');
    expect(scrubbed).toContain('[REDACTED:github_pat]');
    expect(scrubbed).not.toContain(secret1);
    expect(scrubbed).not.toContain(secret2);
  });

  it('chunked path keeps total length roughly preserved (no truncation)', () => {
    // A long innocuous text should pass through every chunk and stay intact.
    const blob = 'safe-text\n'.repeat(8000); // ~80 KB
    const out = s.scrub(blob);
    expect(out.length).toBeGreaterThan(70_000);
    expect(out).toContain('safe-text');
  });

  // Adjacency regression: a consuming trailing delimiter used to eat the
  // separator the next match needed, so every other secret leaked. The
  // trailing boundary is now a non-consuming lookahead.
  it('redacts two space-separated high-entropy env secrets (no plaintext leak)', () => {
    const v1 = 'AAAAAAAAAAAAAAAAAAAA';
    const v2 = 'BBBBBBBBBBBBBBBBBBBB';
    const out = s.scrub(`API_KEY=${v1} SESSION_TOKEN=${v2}`);
    expect(out).not.toContain(v1);
    expect(out).not.toContain(v2);
    expect(out).toBe('API_KEY=[REDACTED:high_entropy_env] SESSION_TOKEN=[REDACTED:high_entropy_env]');
  });

  it('redacts newline-separated high-entropy env secrets (printenv/.env dump shape)', () => {
    const v1 = 'AAAAAAAAAAAAAAAAAAAA';
    const v2 = 'BBBBBBBBBBBBBBBBBBBB';
    const v3 = 'CCCCCCCCCCCCCCCCCCCC';
    const out = s.scrub(`API_KEY=${v1}\nSESSION_TOKEN=${v2}\nROOT_PASSWORD=${v3}`);
    expect(out).not.toContain(v1);
    expect(out).not.toContain(v2);
    expect(out).not.toContain(v3);
    expect((out.match(/\[REDACTED:high_entropy_env\]/g) ?? []).length).toBe(3);
    // Newline separators between the redacted lines must be preserved.
    expect(out.split('\n')).toHaveLength(3);
  });

  it('redacts two adjacent Bearer tokens sharing a single delimiter', () => {
    const t1 = 'tokentokentoken1';
    const t2 = 'tokentokentoken2';
    const out = s.scrub(`Bearer ${t1} Bearer ${t2}`);
    expect(out).not.toContain(t1);
    expect(out).not.toContain(t2);
    expect((out.match(/\[REDACTED:bearer_token\]/g) ?? []).length).toBe(2);
  });

  it('still redacts a single high-entropy env secret with surrounding text', () => {
    // Guard against the lookahead over-relaxing the boundary.
    const v = 'abcdef1234567890abcdef';
    const out = s.scrub(`prefix MY_API_KEY=${v} suffix`);
    expect(out).not.toContain(v);
    expect(out).toContain('[REDACTED:high_entropy_env]');
    expect(out).toContain('suffix');
  });

  // AI/ML provider key patterns
  it('redacts HuggingFace tokens', () => {
    // HuggingFace tokens: hf_ followed by exactly 34 alphanumeric chars
    const token = 'hf_abcdefghijklmnopqrstuvwxyz12345678'; // 34 chars after hf_
    expect(token.length).toBe(37); // hf_ (3) + 34 = 37
    const scrubbed = s.scrub(`token: ${token}`);
    expect(scrubbed).toContain('[REDACTED:huggingface_token]');
    expect(scrubbed).not.toContain(token);
  });

  it('redacts Replicate tokens', () => {
    // Replicate tokens: r8_ followed by 40+ alphanumeric chars
    const token = 'r8_abcdefghijklmnopqrstuvwxyz1234567890abcd'; // 40+ chars after r8_
    const scrubbed = s.scrub(`REPLICATE_API_TOKEN=${token}`);
    expect(scrubbed).toContain('[REDACTED:replicate_token]');
    expect(scrubbed).not.toContain(token);
  });

  it('redacts Perplexity API keys', () => {
    // Perplexity keys: pplx- followed by 40+ alphanumeric chars
    const key = 'pplx-abcdefghijklmnopqrstuvwxyz1234567890abcd'; // 40+ chars after pplx-
    const scrubbed = s.scrub(`PERPLEXITY_API_KEY: ${key}`);
    expect(scrubbed).toContain('[REDACTED:perplexity_key]');
    expect(scrubbed).not.toContain(key);
  });

  it('redacts Groq API keys', () => {
    // Groq keys: gsk_ followed by 40+ alphanumeric chars
    const key = 'gsk_abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH'; // 40+ chars after gsk_
    const scrubbed = s.scrub(`GROQ_API_KEY="${key}"`);
    expect(scrubbed).toContain('[REDACTED:groq_key]');
    expect(scrubbed).not.toContain(key);
  });

  it('does not redact short HuggingFace-like strings', () => {
    // Too short - should not match (needs exactly 34 chars after hf_)
    const short = 'hf_abc123';
    expect(s.scrub(short)).toBe(short);
  });

  it('does not redact short Replicate-like strings', () => {
    // Too short - should not match (needs 40+ chars after r8_)
    const short = 'r8_abc123';
    expect(s.scrub(short)).toBe(short);
  });
});
