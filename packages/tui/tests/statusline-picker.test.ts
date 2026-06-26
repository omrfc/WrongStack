import { describe, expect, it, vi, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  STATUSLINE_ITEMS,
  StatuslinePicker,
  isChipExpired,
  getExpiresInLabel,
  type ChipMeta,
} from '../src/components/statusline-picker.js';

// Simple ChipMeta factory — only fields needed by isChipExpired / getExpiresInLabel
function chip(overrides: Partial<ChipMeta> = {}): ChipMeta {
  return {
    key: 'brain',
    shownAt: Date.now(),
    ...overrides,
  } as ChipMeta;
}

describe('isChipExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns false when chip has no expiresIn', () => {
    const c = chip({ shownAt: Date.now() });
    expect(isChipExpired(c)).toBe(false);
  });

  it('returns false when chip has not expired yet', () => {
    const now = Date.now();
    const c = chip({ expiresIn: 5, shownAt: now }); // 5 minutes
    vi.setSystemTime(now + 2 * 60 * 1000); // only 2 minutes elapsed
    expect(isChipExpired(c)).toBe(false);
  });

  it('returns true when chip has expired', () => {
    const now = Date.now();
    const c = chip({ expiresIn: 5, shownAt: now }); // 5 minutes
    vi.setSystemTime(now + 6 * 60 * 1000); // 6 minutes elapsed
    expect(isChipExpired(c)).toBe(true);
  });

  it('returns true at exactly the expiration boundary (1 second over)', () => {
    const now = Date.now();
    const c = chip({ expiresIn: 5, shownAt: now }); // 5 minutes = 300 seconds
    vi.setSystemTime(now + 300 * 1000 + 1); // 300 seconds + 1ms
    expect(isChipExpired(c)).toBe(true);
  });

  it('returns false for permanent chip (expiresIn = 0)', () => {
    const c = chip({ expiresIn: 0, shownAt: Date.now() });
    expect(isChipExpired(c)).toBe(false);
  });

  it('returns false when shownAt is undefined (permanent)', () => {
    const c = chip({ expiresIn: 5, shownAt: undefined as never });
    expect(isChipExpired(c)).toBe(false);
  });
});

describe('getExpiresInLabel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('returns null when chip has no expiresIn', () => {
    const c = chip({ shownAt: Date.now() });
    expect(getExpiresInLabel(c)).toBeNull();
  });

  it('returns null when chip has expired', () => {
    const now = Date.now();
    const c = chip({ expiresIn: 5, shownAt: now });
    vi.setSystemTime(now + 10 * 60 * 1000); // 10 minutes — well past 5
    expect(getExpiresInLabel(c)).toBeNull();
  });

  it('returns "expires in N m" for chips with time remaining', () => {
    const now = Date.now();
    const c = chip({ expiresIn: 5, shownAt: now });
    vi.setSystemTime(now + 2 * 60 * 1000); // 2 minutes in
    expect(getExpiresInLabel(c)).toBe('expires in 3 m');
  });

  it('returns "expires in <1 m" when less than a minute remains', () => {
    const now = Date.now();
    const c = chip({ expiresIn: 5, shownAt: now });
    vi.setSystemTime(now + 4 * 60 * 1000 + 30 * 1000); // 4m30s in
    expect(getExpiresInLabel(c)).toBe('expires in <1 m');
  });

  it('returns "expires in 1 m" for exactly 1 minute remaining', () => {
    const now = Date.now();
    const c = chip({ expiresIn: 5, shownAt: now });
    vi.setSystemTime(now + 4 * 60 * 1000); // 4 minutes in, 1 minute left
    expect(getExpiresInLabel(c)).toBe('expires in 1 m');
  });

  it('returns null for permanent chip (expiresIn = 0)', () => {
    const c = chip({ expiresIn: 0, shownAt: Date.now() });
    expect(getExpiresInLabel(c)).toBeNull();
  });

  it('returns null when shownAt is undefined (permanent)', () => {
    const c = chip({ expiresIn: 5, shownAt: undefined as never });
    expect(getExpiresInLabel(c)).toBeNull();
  });
});

describe('StatuslinePicker render', () => {
  it('shows idle stream chips as auto, not off', () => {
    const { lastFrame, unmount } = render(
      React.createElement(StatuslinePicker, {
        field: STATUSLINE_ITEMS.indexOf('mailbox'),
        hiddenItems: [],
        visibleChips: [],
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('mailbox');
    expect(frame).toContain('auto');
    unmount();
  });
});
