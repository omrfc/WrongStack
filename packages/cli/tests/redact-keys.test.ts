import { describe, expect, it } from 'vitest';
import { redactKeys } from '../src/subcommands/handlers/helpers.js';

describe('redactKeys', () => {
  it('passes through primitives', () => {
    expect(redactKeys(null)).toBe(null);
    expect(redactKeys(undefined)).toBe(undefined);
    expect(redactKeys(42)).toBe(42);
    expect(redactKeys('plain')).toBe('plain');
    expect(redactKeys(true)).toBe(true);
  });

  it('redacts apiKey-named string fields', () => {
    expect(redactKeys({ apiKey: 'sk-abc', name: 'foo' })).toEqual({
      apiKey: '[REDACTED]',
      name: 'foo',
    });
  });

  it('redacts case-insensitively', () => {
    expect(redactKeys({ ApiKey: 'x', API_KEY: 'y' })).toEqual({
      ApiKey: '[REDACTED]',
      API_KEY: '[REDACTED]',
    });
  });

  it('redacts variants: secret, token, pass', () => {
    expect(
      redactKeys({
        clientSecret: 's',
        authToken: 't',
        password: 'p',
        someOther: 'keep',
      }),
    ).toEqual({
      clientSecret: '[REDACTED]',
      authToken: '[REDACTED]',
      password: '[REDACTED]',
      someOther: 'keep',
    });
  });

  it('preserves empty-string secrets verbatim', () => {
    expect(redactKeys({ apiKey: '' })).toEqual({ apiKey: '' });
  });

  it('does not redact non-string values at secret-named keys', () => {
    expect(redactKeys({ apiKey: 42, secret: null, token: undefined })).toEqual({
      apiKey: 42,
      secret: null,
      token: undefined,
    });
  });

  it('walks nested objects', () => {
    expect(redactKeys({ outer: { apiKey: 'sk-abc' } })).toEqual({
      outer: { apiKey: '[REDACTED]' },
    });
  });

  it('walks arrays', () => {
    expect(redactKeys([{ apiKey: 'a' }, { apiKey: 'b' }])).toEqual([
      { apiKey: '[REDACTED]' },
      { apiKey: '[REDACTED]' },
    ]);
  });

  it('does not mutate input', () => {
    const input = { apiKey: 'sk-abc' };
    redactKeys(input);
    expect(input).toEqual({ apiKey: 'sk-abc' });
  });

  it('leaves keys like name, host, port, username alone', () => {
    expect(redactKeys({ name: 'a', host: 'h', port: 80, username: 'u' })).toEqual({
      name: 'a',
      host: 'h',
      port: 80,
      username: 'u',
    });
  });
});
