import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('@wrongstack/webui package bin', () => {
  it('publishes the standalone executable as wstackui, not webui', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'packages/webui/package.json'), 'utf8'),
    ) as { bin?: Record<string, string> };

    expect(pkg.bin).toEqual({ wstackui: './dist/server/entry.js' });
    expect(pkg.bin).not.toHaveProperty('webui');
  });
});
