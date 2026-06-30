import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

type ExportEntry = { types?: string; import?: string } | string;

const pkgRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(pkgRoot, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
  exports: Record<string, ExportEntry>;
};

describe('@wrongstack/runtime subpath exports', () => {
  it('publishes the subpaths used by CLI and TUI', () => {
    expect(pkg.exports).toHaveProperty('./vision');
    expect(pkg.exports).toHaveProperty('./clipboard');
    expect(pkg.exports).toHaveProperty('./host');
    expect(pkg.exports).toHaveProperty('./pack');
  });

  it('every declared JS export points at a built dist file', () => {
    const missing: string[] = [];
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      if (typeof entry === 'string' || !entry.import) continue;
      const filePath = path.resolve(pkgRoot, entry.import);
      if (!fs.existsSync(filePath)) {
        missing.push(`${subpath} -> ${entry.import}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('runtime subpath imports resolve through Node package exports', async () => {
    const vision = await import('@wrongstack/runtime/vision');
    expect(typeof vision.routeImagesForModel).toBe('function');

    const clipboard = await import('@wrongstack/runtime/clipboard');
    expect(typeof clipboard.readClipboardImage).toBe('function');
  });

  it('exposes probeLocalLlm from the main barrel', async () => {
    const runtime = await import('@wrongstack/runtime');
    expect(typeof runtime.probeLocalLlm).toBe('function');
  });
});
