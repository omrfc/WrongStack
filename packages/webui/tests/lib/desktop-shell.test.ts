import { describe, expect, it } from 'vitest';
import { detectDesktopShell } from '../../src/lib/desktop-shell.js';

describe('desktop shell detection', () => {
  it('detects the Electron shell query parameter', () => {
    expect(detectDesktopShell('?shell=desktop', false)).toBe(true);
    expect(detectDesktopShell('?token=abc&shell=desktop', false)).toBe(true);
  });

  it('detects the preload host object even without a query parameter', () => {
    expect(detectDesktopShell('', true)).toBe(true);
  });

  it('does not enable desktop shell for normal browser URLs', () => {
    expect(detectDesktopShell('', false)).toBe(false);
    expect(detectDesktopShell('?shell=browser', false)).toBe(false);
  });
});
