import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultWsUrl,
  getTokenFromWsUrl,
  httpOriginForAuth,
  resolveWsPort,
} from '../../src/lib/ws-client-utils.js';

describe('ws-client-utils', () => {
  describe('getTokenFromWsUrl', () => {
    it('extracts token from a ws:// URL with ?token=', () => {
      expect(getTokenFromWsUrl('ws://127.0.0.1:3457?token=abc123')).toBe('abc123');
    });

    it('extracts token from a wss:// URL', () => {
      expect(getTokenFromWsUrl('wss://example.com:443/path?token=xyz789')).toBe('xyz789');
    });

    it('returns null when no token param is present', () => {
      expect(getTokenFromWsUrl('ws://127.0.0.1:3457')).toBeNull();
    });

    it('returns null for an invalid URL', () => {
      expect(getTokenFromWsUrl('not-a-url')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(getTokenFromWsUrl('')).toBeNull();
    });
  });

  describe('resolveWsPort', () => {
    let originalQuerySelector: typeof document.querySelector;

    beforeEach(() => {
      originalQuerySelector = document.querySelector.bind(document);
    });

    afterEach(() => {
      document.querySelector = originalQuerySelector;
    });

    it('returns the port from a valid meta tag', () => {
      vi.spyOn(document, 'querySelector').mockReturnValue({
        getAttribute: () => '4096',
      } as Element);
      expect(resolveWsPort()).toBe(4096);
    });

    it('falls back to 3457 when meta tag is absent', () => {
      vi.spyOn(document, 'querySelector').mockReturnValue(null);
      expect(resolveWsPort()).toBe(3457);
    });

    it('falls back to 3457 when content is not a number', () => {
      vi.spyOn(document, 'querySelector').mockReturnValue({
        getAttribute: () => 'not-a-port',
      } as Element);
      expect(resolveWsPort()).toBe(3457);
    });

    it('falls back to 3457 when port is out of range', () => {
      vi.spyOn(document, 'querySelector').mockReturnValue({
        getAttribute: () => '0',
      } as Element);
      expect(resolveWsPort()).toBe(3457);

      vi.spyOn(document, 'querySelector').mockReturnValue({
        getAttribute: () => '99999',
      } as Element);
      expect(resolveWsPort()).toBe(3457);
    });
  });

  describe('defaultWsUrl', () => {
    const originalLocation = window.location;

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });

    it('returns loopback URL when on localhost', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: 'localhost', port: '3456' },
        writable: true,
      });
      vi.spyOn(document, 'querySelector').mockReturnValue(null);
      expect(defaultWsUrl()).toBe('ws://127.0.0.1:3457');
    });

    it('returns loopback URL when on 127.0.0.1', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: '127.0.0.1', port: '3456' },
        writable: true,
      });
      expect(defaultWsUrl()).toBe('ws://127.0.0.1:3457');
    });

    it('returns hostname-based URL for non-loopback hosts', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: '192.168.1.100', port: '3456' },
        writable: true,
      });
      expect(defaultWsUrl()).toBe('ws://192.168.1.100:3457');
    });
  });

  describe('httpOriginForAuth', () => {
    const originalLocation = window.location;

    afterEach(() => {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
      });
    });

    it('returns loopback origin when on localhost', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: 'localhost', port: '3456' },
        writable: true,
      });
      expect(httpOriginForAuth()).toBe('http://127.0.0.1:3456');
    });

    it('returns loopback origin when on [::1]', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: '[::1]', port: '3456' },
        writable: true,
      });
      expect(httpOriginForAuth()).toBe('http://127.0.0.1:3456');
    });

    it('uses page port for non-loopback hosts', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: '192.168.1.50', port: '8080' },
        writable: true,
      });
      expect(httpOriginForAuth()).toBe('http://192.168.1.50:8080');
    });

    it('falls back to 3456 when page port is empty', () => {
      Object.defineProperty(window, 'location', {
        value: { hostname: 'example.com', port: '' },
        writable: true,
      });
      expect(httpOriginForAuth()).toBe('http://example.com:3456');
    });
  });
});
