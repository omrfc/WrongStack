import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillLoader, SkillManifest } from '@wrongstack/core';
import { makeSkillTool } from '../src/skill.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-tool-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** Minimal in-memory SkillLoader backed by a map of name → raw SKILL.md content. */
function loader(manifests: SkillManifest[], bodies: Record<string, string>): SkillLoader {
  return {
    list: async () => manifests,
    listEntries: async () => [],
    find: async (name) =>
      manifests.find((m) => m.name.toLowerCase() === name.toLowerCase()),
    manifestText: async () => '',
    readBody: async (name) => bodies[name] ?? '',
    readSaveBody: async () => '',
    invalidateCache: () => undefined,
  } as unknown as SkillLoader;
}

describe('makeSkillTool', () => {
  it('loads the body and strips frontmatter', async () => {
    const dir = path.join(tmp, 'my-skill');
    await fs.mkdir(dir, { recursive: true });
    const raw = '---\nname: my-skill\ndescription: a skill\n---\nBody instructions here.';
    await fs.writeFile(path.join(dir, 'SKILL.md'), raw);
    const tool = makeSkillTool(
      loader(
        [{ name: 'my-skill', description: 'a skill', path: path.join(dir, 'SKILL.md'), source: 'project' }],
        { 'my-skill': raw },
      ),
    );
    const out = await tool.execute({ name: 'my-skill' });
    expect(out.body).toBe('Body instructions here.');
    expect(out.name).toBe('my-skill');
  });

  it('lists bundled scripts/references/assets resources', async () => {
    const dir = path.join(tmp, 'res-skill');
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: res-skill\ndescription: d\n---\nbody');
    await fs.writeFile(path.join(dir, 'scripts', 'extract.py'), 'print(1)');
    await fs.writeFile(path.join(dir, 'references', 'REF.md'), '# ref');
    const tool = makeSkillTool(
      loader(
        [{ name: 'res-skill', description: 'd', path: path.join(dir, 'SKILL.md'), source: 'project' }],
        { 'res-skill': 'body' },
      ),
    );
    const out = await tool.execute({ name: 'res-skill' });
    expect(out.resources.map((r) => r.path).sort()).toEqual(['references/REF.md', 'scripts/extract.py']);
    const rendered = tool.serialize!(out, { name: 'res-skill' });
    expect(rendered).toContain('scripts/extract.py');
    expect(rendered).toContain('read on demand');
  });

  it('throws on unknown skill name', async () => {
    const tool = makeSkillTool(loader([], {}));
    await expect(tool.execute({ name: 'ghost' })).rejects.toThrow(/not found/);
  });

  it('throws when name is missing', async () => {
    const tool = makeSkillTool(loader([], {}));
    await expect(tool.execute({ name: '' })).rejects.toThrow(/name is required/);
  });

  it('records a skill_activated session event when ctx.session is present', async () => {
    const dir = path.join(tmp, 'ev-skill');
    await fs.mkdir(dir, { recursive: true });
    const raw = '---\nname: ev-skill\ndescription: d\n---\nbody';
    await fs.writeFile(path.join(dir, 'SKILL.md'), raw);
    const append = vi.fn().mockResolvedValue(undefined);
    const ctx = { session: { append } } as never;
    const tool = makeSkillTool(
      loader(
        [{ name: 'ev-skill', description: 'd', path: path.join(dir, 'SKILL.md'), source: 'project' }],
        { 'ev-skill': raw },
      ),
    );
    await tool.execute({ name: 'ev-skill' }, ctx);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0][0]).toMatchObject({ type: 'skill_activated', skillName: 'ev-skill' });
  });
});
