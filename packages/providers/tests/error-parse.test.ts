import { describe, it, expect } from 'vitest';
import { ProviderError } from '@wrongstack/core';
import { parseProviderHttpError } from '../src/error-parse.js';

describe('parseProviderHttpError', () => {
  it('parses Anthropic 529 overloaded body', () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'High traffic detected. Upgrade for highspeed model.' },
      request_id: '06534785201de9c0a1b2c3d4e5f6',
    });
    const err = parseProviderHttpError('minimax', 529, body);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(529);
    expect(err.retryable).toBe(true);
    expect(err.providerId).toBe('minimax');
    expect(err.body?.type).toBe('overloaded_error');
    expect(err.body?.message).toBe('High traffic detected. Upgrade for highspeed model.');
    expect(err.body?.requestId).toBe('06534785201de9c0a1b2c3d4e5f6');
    expect(err.describe()).toBe(
      'minimax overloaded (529): High traffic detected. Upgrade for highspeed model. [req 06534785201de9c0…]',
    );
  });

  it('parses OpenAI 429 rate-limit body', () => {
    const body = JSON.stringify({
      error: {
        message: 'Rate limit reached for gpt-4o',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    });
    const err = parseProviderHttpError('openai', 429, body);
    expect(err.retryable).toBe(true);
    expect(err.body?.type).toBe('rate_limit_error');
    expect(err.body?.message).toBe('Rate limit reached for gpt-4o');
    expect(err.describe()).toBe('openai rate limited (429): Rate limit reached for gpt-4o');
  });

  it('parses Google 5xx error with status field', () => {
    const body = JSON.stringify({
      error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' },
    });
    const err = parseProviderHttpError('google', 503, body);
    expect(err.retryable).toBe(true);
    expect(err.body?.type).toBe('UNAVAILABLE');
    expect(err.body?.message).toBe('The model is overloaded.');
    expect(err.describe()).toContain('google HTTP 503 (server error): The model is overloaded.');
  });

  it('does not retry on 400 invalid request', () => {
    const body = JSON.stringify({
      error: { type: 'invalid_request_error', message: 'messages.0.role must be one of [user, assistant]' },
    });
    const err = parseProviderHttpError('anthropic', 400, body);
    expect(err.retryable).toBe(false);
    expect(err.body?.type).toBe('invalid_request_error');
    expect(err.describe()).toContain('anthropic invalid request (400):');
  });

  it('handles unparseable body without throwing', () => {
    const err = parseProviderHttpError('openai', 502, '<html>Bad Gateway</html>');
    expect(err.status).toBe(502);
    expect(err.retryable).toBe(true);
    expect(err.body?.type).toBeUndefined();
    expect(err.body?.message).toBeUndefined();
    expect(err.body?.raw).toBe('<html>Bad Gateway</html>');
    expect(err.describe()).toBe('openai HTTP 502 (server error)');
  });

  it('handles empty body', () => {
    const err = parseProviderHttpError('openai', 500, '');
    expect(err.retryable).toBe(true);
    expect(err.body?.raw).toBe('');
    expect(err.describe()).toBe('openai HTTP 500 (server error)');
  });

  it('truncates very large raw body', () => {
    const raw = 'x'.repeat(5000);
    const err = parseProviderHttpError('openai', 500, raw);
    expect(err.body?.raw?.length).toBe(2000);
  });

  it('classifies overloaded_error retryable even with non-529 status', () => {
    const body = JSON.stringify({ error: { type: 'overloaded_error', message: 'busy' } });
    const err = parseProviderHttpError('anthropic', 503, body);
    expect(err.retryable).toBe(true);
    expect(err.describe()).toContain('overloaded');
  });
});

describe('ProviderError.describe', () => {
  it('truncates long messages', () => {
    const body = { type: 'foo', message: 'x'.repeat(300) };
    const err = new ProviderError('test', 500, true, 'p', { body });
    const out = err.describe();
    expect(out.length).toBeLessThan(280);
    expect(out.endsWith('…')).toBe(true);
  });

  it('handles missing body gracefully', () => {
    const err = new ProviderError('boom', 500, true, 'p');
    expect(err.describe()).toBe('p HTTP 500 (server error)');
  });

  it('renders network error (status 0)', () => {
    const err = new ProviderError('econnreset', 0, true, 'p', {
      body: { message: 'ECONNRESET' },
    });
    expect(err.describe()).toBe('p network error: ECONNRESET');
  });

  it('renders auth/permission/not-found correctly', () => {
    expect(new ProviderError('', 401, false, 'p').describe()).toBe('p auth failed (401)');
    expect(new ProviderError('', 403, false, 'p').describe()).toBe('p forbidden (403)');
    expect(new ProviderError('', 404, false, 'p').describe()).toBe('p not found (404)');
  });

  it('truncates long request ids in the [req …] suffix', () => {
    const err = new ProviderError('', 529, true, 'p', {
      body: { type: 'overloaded_error', requestId: '0123456789abcdef0123456789abcdef' },
    });
    expect(err.describe()).toContain('[req 0123456789abcdef…]');
  });

  it('surfaces a truncated flag + original length when the raw body exceeds 2 KB', () => {
    const giant = 'x'.repeat(5000);
    const err = parseProviderHttpError('p', 500, giant);
    expect(err.body?.raw?.length).toBe(2000);
    expect(err.body?.truncated).toBe(true);
    expect(err.body?.rawLength).toBe(5000);
  });

  it('leaves truncated flag unset when the body is short', () => {
    const err = parseProviderHttpError('p', 500, 'short error');
    expect(err.body?.truncated).toBeUndefined();
    expect(err.body?.rawLength).toBeUndefined();
  });
});
