import { describe, expect, it, vi } from 'vitest';
import { clampTerminalHeight } from '@/lib/terminal-dock';

function setViewportHeight(height: number): void {
  vi.stubGlobal('innerHeight', height);
}

describe('TerminalPanel dock height', () => {
  it('keeps enough vertical space for the WebUI above the terminal', () => {
    setViewportHeight(900);

    expect(clampTerminalHeight(700)).toBe(495);
  });

  it('uses the stricter remaining-main-area cap on shorter windows', () => {
    setViewportHeight(700);

    expect(clampTerminalHeight(600)).toBe(385);
  });

  it('still enforces a usable minimum terminal height', () => {
    setViewportHeight(900);

    expect(clampTerminalHeight(40)).toBe(140);
  });
});
