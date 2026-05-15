import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultPathResolver } from '../../src/index.js';

describe('DefaultPathResolver', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-path-'));
    // marker
    await fs.writeFile(path.join(tmp, 'package.json'), '{}');
    await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'src', 'a.ts'), 'x');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('detects project root via marker file', async () => {
    const inner = path.join(tmp, 'src');
    const pr = new DefaultPathResolver(inner);
    // realpath normalises on macOS (/var → /private/var)
    expect(path.resolve(pr.projectRoot)).toBe(path.resolve(tmp));
  });

  it('cwd is absolute and resolved', () => {
    const pr = new DefaultPathResolver(tmp);
    expect(path.isAbsolute(pr.cwd)).toBe(true);
  });

  it('resolve handles relative paths', () => {
    const pr = new DefaultPathResolver(tmp);
    const r = pr.resolve('src/a.ts');
    expect(path.resolve(r)).toBe(path.resolve(tmp, 'src', 'a.ts'));
  });

  it('isInsideRoot rejects parent escapes', () => {
    const pr = new DefaultPathResolver(tmp);
    expect(pr.isInsideRoot(path.join(tmp, 'src', 'a.ts'))).toBe(true);
    expect(pr.isInsideRoot(path.dirname(tmp))).toBe(false);
  });

  it('ensureInsideRoot throws for outside paths', () => {
    const pr = new DefaultPathResolver(tmp);
    expect(() => pr.ensureInsideRoot(path.dirname(tmp))).toThrow(/outside the project root/);
  });

  it('ensureInsideRoot returns resolved path for inside paths', () => {
    const pr = new DefaultPathResolver(tmp);
    const out = pr.ensureInsideRoot('src/a.ts');
    expect(path.basename(out)).toBe('a.ts');
  });
});
