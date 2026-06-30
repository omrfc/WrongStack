import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { designTool } from '../src/design.js';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-design-tool-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const makeCtx = () => ({ cwd: root, tools: [], projectRoot: root, meta: {} }) as any;
const opts = { signal: new AbortController().signal };

describe('designTool', () => {
  it('is confirmation-gated because some actions persist project design state', () => {
    expect(designTool.permission).toBe('confirm');
    expect(designTool.mutating).toBe(true);
    expect(designTool.capabilities).toEqual(['fs.write']);
  });

  it('lists the bundled kit menu by default', async () => {
    const ctx = makeCtx();
    const res = await designTool.execute({}, ctx, opts);
    expect(res.action).toBe('list');
    expect(res.output).toContain('minimal-clarity');
    expect(res.output).not.toContain('_foundations');
  });

  it('loads a kit body for a stack and pins it active on ctx.meta', async () => {
    const ctx = makeCtx();
    const res = await designTool.execute(
      { action: 'use', kit: 'neo-brutalist', stack: 'web' },
      ctx,
      opts,
    );
    expect(res.action).toBe('use');
    expect(res.kit).toBe('neo-brutalist');
    expect(res.stack).toBe('web');
    expect(res.output).toMatch(/Active design kit/i);
    expect(res.output).toContain('## Stack: web');
    expect(res.output).not.toContain('## Stack: flutter');
    // tokens snapshot included
    expect(res.output).toMatch(/oklch/);
    // active kit recorded for the request middleware / UI pickers
    expect((ctx.meta.designStudio as any)?.activeKit).toBe('neo-brutalist');
  });

  it('returns the menu when an unknown kit is requested', async () => {
    const ctx = makeCtx();
    const res = await designTool.execute({ action: 'use', kit: 'nope' }, ctx, opts);
    expect(res.output).toMatch(/not found/i);
    expect(res.output).toContain('minimal-clarity');
  });

  it('returns the mandatory foundations baseline', async () => {
    const ctx = makeCtx();
    const res = await designTool.execute({ action: 'foundations', stack: 'web' }, ctx, opts);
    expect(res.action).toBe('foundations');
    expect(res.output).toMatch(/WCAG/);
  });

  it('blocks a ../ traversal escape in materialize out path (CWE-22)', async () => {
    const ctx = makeCtx();
    // Pin an active kit so materialize has tokens to write.
    await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);

    // A caller-supplied out path that climbs out of the project root must be
    // refused before any file is written.
    const escapePath = path.join('..', '..', '..', '..', 'ws-design-escape.css');
    await expect(
      designTool.execute({ action: 'materialize', out: escapePath }, ctx, opts),
    ).rejects.toThrow(/escape the project root/i);

    // And nothing was written outside the root.
    const outside = path.resolve(root, escapePath);
    let wrote = true;
    try {
      await fs.access(outside);
    } catch {
      wrote = false;
    }
    expect(wrote).toBe(false);
  });

  it('blocks an absolute out path outside the project root', async () => {
    const ctx = makeCtx();
    await designTool.execute({ action: 'use', kit: 'minimal-clarity', stack: 'web' }, ctx, opts);

    const abs = path.join(os.tmpdir(), `ws-design-abs-${Date.now()}.css`);
    await expect(
      designTool.execute({ action: 'materialize', out: abs }, ctx, opts),
    ).rejects.toThrow(/escape the project root/i);
    let wrote = true;
    try {
      await fs.access(abs);
    } catch {
      wrote = false;
    }
    expect(wrote).toBe(false);
  });
});
