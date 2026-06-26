import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  isChipExpired,
  getExpiresInLabel,
  type ChipMeta,
  STREAM_CHIP_EXPIRES_IN_MINUTES,
} from '../src/components/statusline-picker.js';

// ---------------------------------------------------------------------------
// Unit-level helpers (test the pure logic without React)
// ---------------------------------------------------------------------------
describe('statusline picker expiration logic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const makeMeta = (expiresIn: number, shownAt: number): ChipMeta => ({
    key: 'brain',
    expiresIn,
    shownAt,
  });

  describe('isChipExpired', () => {
    it('false when no expiresIn is set', () => {
      const meta = makeMeta(0 as never, Date.now());
      expect(isChipExpired(meta)).toBe(false);
    });

    it('false before expiration boundary', () => {
      const now = Date.now();
      const meta = makeMeta(5, now); // 5 minutes
      vi.setSystemTime(now + 4 * 60 * 1000); // 4 min in
      expect(isChipExpired(meta)).toBe(false);
    });

    it('true after expiration boundary', () => {
      const now = Date.now();
      const meta = makeMeta(5, now); // 5 minutes
      vi.setSystemTime(now + 6 * 60 * 1000); // 6 min in
      expect(isChipExpired(meta)).toBe(true);
    });

    it('true at exactly the expiration boundary (1 second over)', () => {
      const now = Date.now();
      const meta = makeMeta(5, now); // 5 minutes = 300 seconds
      vi.setSystemTime(now + 300 * 1000 + 1); // 300 seconds + 1ms
      expect(isChipExpired(meta)).toBe(true);
    });

    it('false for permanent chip (expiresIn = 0)', () => {
      const meta = makeMeta(0, Date.now());
      expect(isChipExpired(meta)).toBe(false);
    });

    it('false when shownAt is undefined', () => {
      const meta = makeMeta(5, 0 as never);
      expect(isChipExpired(meta)).toBe(false);
    });
  });

  describe('getExpiresInLabel', () => {
    it('null when no expiresIn', () => {
      const meta = makeMeta(0 as never, Date.now());
      expect(getExpiresInLabel(meta)).toBeNull();
    });

    it('null when expired', () => {
      const now = Date.now();
      const meta = makeMeta(5, now);
      vi.setSystemTime(now + 10 * 60 * 1000);
      expect(getExpiresInLabel(meta)).toBeNull();
    });

    it('shows remaining minutes', () => {
      const now = Date.now();
      const meta = makeMeta(5, now);
      vi.setSystemTime(now + 2 * 60 * 1000); // 2 min in, 3 left
      expect(getExpiresInLabel(meta)).toBe('expires in 3 m');
    });

    it('shows <1 m when under 1 minute remains', () => {
      const now = Date.now();
      const meta = makeMeta(5, now);
      vi.setSystemTime(now + 4 * 60 * 1000 + 30 * 1000); // 4m30s in, 30s left
      expect(getExpiresInLabel(meta)).toBe('expires in <1 m');
    });

    it('shows 1 m for exactly 1 minute remaining', () => {
      const now = Date.now();
      const meta = makeMeta(5, now);
      vi.setSystemTime(now + 4 * 60 * 1000); // 4 min in, 1 minute left
      expect(getExpiresInLabel(meta)).toBe('expires in 1 m');
    });

    it('null for permanent chip', () => {
      const meta = makeMeta(0, Date.now());
      expect(getExpiresInLabel(meta)).toBeNull();
    });

    it('null when shownAt is undefined', () => {
      const meta = makeMeta(5, 0 as never);
      expect(getExpiresInLabel(meta)).toBeNull();
    });
  });

  describe('STREAM_CHIP_EXPIRES_IN_MINUTES', () => {
    it('is 5 minutes', () => {
      expect(STREAM_CHIP_EXPIRES_IN_MINUTES).toBe(5);
    });
  });
});
