import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const pkgRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(pkgRoot, 'package.json');
const distIndex = path.join(pkgRoot, 'dist', 'index.js');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
  version: string;
  exports: Record<string, { types: string; import: string }>;
};

describe('@wrongstack/cli package smoke', () => {
  it('package export points at built dist files', () => {
    const rootExport = pkg.exports['.'];
    expect(rootExport).toBeDefined();
    expect(fs.existsSync(path.resolve(pkgRoot, rootExport.import))).toBe(true);
    expect(fs.existsSync(path.resolve(pkgRoot, rootExport.types))).toBe(true);
  });

  it('dist entry imports without running main', async () => {
    expect(fs.existsSync(distIndex)).toBe(true);
    const script = [
      "import('@wrongstack/cli').then((m) => {",
      "  if (typeof m.main !== 'function') throw new Error('main export missing');",
      `  if (m.CLI_VERSION !== ${JSON.stringify(pkg.version)}) throw new Error('version mismatch');`,
      '}).catch((err) => { console.error(err); process.exit(1); });',
    ].join('\n');
    execFileSync(process.execPath, ['-e', script], {
      cwd: pkgRoot,
      stdio: 'pipe',
    });
  });
});
