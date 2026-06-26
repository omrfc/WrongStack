import { describe, expect, it } from 'vitest';
import {
  buildWebUIAccessUrl,
  errMessage,
  generateAuthToken,
  hostForBrowserUrl,
  resolveAuthToken,
} from '../../src/server/ws-utils.js';

describe('errMessage', () => {
  it('extracts message from Error', () => {
    expect(errMessage(new Error('something broke'))).toBe('something broke');
  });

  it('stringifies non-Error values', () => {
    expect(errMessage('plain string')).toBe('plain string');
    expect(errMessage(42)).toBe('42');
    expect(errMessage(null)).toBe('null');
    expect(errMessage(undefined)).toBe('undefined');
  });

  it('handles Error subclass', () => {
    expect(errMessage(new TypeError('bad type'))).toBe('bad type');
  });
});

describe('generateAuthToken', () => {
  it('returns a 32-character hex string', () => {
    const token = generateAuthToken();
    expect(token).toHaveLength(32);
    expect(/^[0-9a-f]{32}$/.test(token)).toBe(true);
  });

  it('generates unique tokens', () => {
    const a = generateAuthToken();
    const b = generateAuthToken();
    expect(a).not.toBe(b);
  });
});

describe('resolveAuthToken', () => {
  it('uses an explicit token when provided', () => {
    expect(resolveAuthToken(' fixed-token ')).toBe('fixed-token');
  });

  it('falls back to a generated token when explicit token is empty', () => {
    const previous = process.env['WEBUI_TOKEN'];
    const previousAlias = process.env['WEBUI_AUTH_TOKEN'];
    delete process.env['WEBUI_TOKEN'];
    delete process.env['WEBUI_AUTH_TOKEN'];
    try {
      expect(resolveAuthToken('')).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      if (previous === undefined) delete process.env['WEBUI_TOKEN'];
      else process.env['WEBUI_TOKEN'] = previous;
      if (previousAlias === undefined) delete process.env['WEBUI_AUTH_TOKEN'];
      else process.env['WEBUI_AUTH_TOKEN'] = previousAlias;
    }
  });
});

describe('buildWebUIAccessUrl', () => {
  it('prints wildcard binds as a navigable loopback URL', () => {
    expect(buildWebUIAccessUrl({ host: '0.0.0.0', port: 8080, token: 'abc' })).toBe(
      'http://127.0.0.1:8080?token=abc',
    );
  });

  it('brackets IPv6 hosts', () => {
    expect(hostForBrowserUrl('::1')).toBe('[::1]');
  });

  it('uses publicUrl and preserves existing query params', () => {
    expect(
      buildWebUIAccessUrl({
        host: '127.0.0.1',
        port: 8080,
        token: 'abc 123',
        publicUrl: 'https://wrongstack.example.com/ui?from=tunnel',
      }),
    ).toBe('https://wrongstack.example.com/ui?from=tunnel&token=abc+123');
  });
});
