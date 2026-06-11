// @vitest-environment jsdom
// These helpers touch `document` — the package-local vitest config runs all
// webui tests under jsdom, but the ROOT config (pnpm test) defaults to the
// node environment; this pragma keeps the file green from both entries.
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('favicon helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    document.head.innerHTML = '';
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      value: false,
    });
  });

  it('creates and reuses a SVG favicon link', async () => {
    const { setFaviconStatus } = await import('@/lib/favicon');

    setFaviconStatus('running');
    const first = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(first).toBeTruthy();
    expect(first?.type).toBe('image/svg+xml');
    expect(decodeURIComponent(first?.href ?? '')).toContain('#f59e0b');

    setFaviconStatus('error');
    const links = document.querySelectorAll('link[rel="icon"]');
    expect(links).toHaveLength(1);
    expect(decodeURIComponent(first?.href ?? '')).toContain('#ef4444');
  });

  it('resets attention badges when the tab becomes visible again', async () => {
    const { installFaviconVisibilityReset, setFaviconStatus } = await import('@/lib/favicon');

    setFaviconStatus('attention');
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(decodeURIComponent(link?.href ?? '')).toContain('#eab308');

    installFaviconVisibilityReset();
    document.dispatchEvent(new Event('visibilitychange'));

    expect(decodeURIComponent(link?.href ?? '')).not.toContain('#eab308');
  });
});
