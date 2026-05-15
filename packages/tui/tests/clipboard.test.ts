import { describe, expect, it } from 'vitest';
import { readClipboardImage } from '../src/clipboard.js';

describe('readClipboardImage', () => {
  it('returns null or a valid PNG image, never throws on an empty clipboard', async () => {
    // We can't reliably stage an image on every CI machine, so the contract
    // we test here is: the function is safe to call and either returns
    // a structured ClipboardImage or null. It must NOT throw when the
    // clipboard is empty / no image is present / tooling is missing.
    const result = await readClipboardImage();
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(result.mediaType).toBe('image/png');
      expect(typeof result.base64).toBe('string');
      expect(result.base64.length).toBeGreaterThan(0);
      expect(result.bytes).toBeGreaterThan(0);
    }
  }, 15_000);

  it('returns null on unsupported platforms', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'aix', configurable: true });
    try {
      const result = await readClipboardImage();
      expect(result).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });
});
