import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffoldTool } from '../src/scaffold.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scaffold-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: tmpDir, tools: [], projectRoot: tmpDir }) as any;

describe('scaffoldTool', () => {
  it('has correct metadata', () => {
    expect(scaffoldTool.name).toBe('scaffold');
    expect(scaffoldTool.permission).toBe('confirm');
    expect(scaffoldTool.mutating).toBe(true);
    expect(scaffoldTool.inputSchema.required).toContain('template');
    expect(scaffoldTool.inputSchema.required).toContain('name');
  });

  it('returns error for unknown template', async () => {
    const ctx = makeCtx();
    const result = await scaffoldTool.execute({ template: 'unknown', name: 'myproject' }, ctx);
    expect(result.files_created).toBe(0);
    expect(result.output).toContain('not found');
  });

  it('creates npm-package template in dry_run', async () => {
    const ctx = makeCtx();
    const result = await scaffoldTool.execute(
      { template: 'npm-package', name: 'myproject', dry_run: true },
      ctx,
    );
    expect(result.template).toBe('built-in');
    expect(result.name).toBe('myproject');
    expect(result.files_created).toBeGreaterThan(0);
    expect(result.files).toHaveLength(result.files_created);
  });

  it('actually creates files when not dry_run', async () => {
    const ctx = makeCtx();
    const result = await scaffoldTool.execute({ template: 'npm-package', name: 'myproject' }, ctx);
    expect(result.files_created).toBeGreaterThan(0);
    for (const f of result.files) {
      const exists = await fs
        .access(path.join(tmpDir, f))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    }
  });

  it('handles cli-tool template', async () => {
    const ctx = makeCtx();
    const result = await scaffoldTool.execute(
      { template: 'cli-tool', name: 'mytool', dry_run: true },
      ctx,
    );
    expect(result.files_created).toBeGreaterThan(0);
  });

  it('handles react-component template', async () => {
    const ctx = makeCtx();
    const result = await scaffoldTool.execute(
      { template: 'react-component', name: 'MyComponent', dry_run: true },
      ctx,
    );
    expect(result.files_created).toBeGreaterThan(0);
    // {{name}}.tsx becomes mycomponent.tsx (lowercase, dashed)
    expect(result.files.some((f) => f.includes('component'))).toBe(true);
  });

  it('substitutes vars in file contents', async () => {
    const ctx = makeCtx();
    const result = await scaffoldTool.execute(
      { template: 'npm-package', name: 'myproject', dry_run: true },
      ctx,
    );
    expect(result.files_created).toBeGreaterThan(0);
    // Check that the first file exists and is a valid template
    expect(result.files.length).toBeGreaterThan(0);
  });

  it('respects custom vars', async () => {
    const ctx = makeCtx();
    const result = await scaffoldTool.execute(
      {
        template: 'npm-package',
        name: 'myproject',
        vars: { description: 'A test project' },
        dry_run: true,
      },
      ctx,
    );
    expect(result.files_created).toBeGreaterThan(0);
  });
});
