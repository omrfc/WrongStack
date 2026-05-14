import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DefaultSkillLoader, resolveWstackPaths } from '../../src/index.js';

const SKILL_A = `---
name: alpha
description: |
  the alpha skill
  spans multiple lines
version: 1.0.0
---

# alpha body
`;

const SKILL_B = `---
name: beta
description: short
---

# beta body
`;

const SKILL_BAD = '# no frontmatter\n';

const SKILL_NONAME = `---
description: orphan
---
`;

describe('DefaultSkillLoader', () => {
  let tmp: string;
  let projectRoot: string;
  let globalRoot: string;
  let bundled: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-skills-'));
    projectRoot = path.join(tmp, 'proj');
    globalRoot = path.join(tmp, 'global');
    bundled = path.join(tmp, 'bundled');
    await fs.mkdir(path.join(projectRoot, '.wrongstack', 'skills', 'alpha'), { recursive: true });
    await fs.mkdir(path.join(globalRoot, 'skills', 'beta'), { recursive: true });
    await fs.mkdir(path.join(globalRoot, 'skills', 'malformed'), { recursive: true });
    await fs.mkdir(path.join(bundled, 'alpha'), { recursive: true });
    await fs.mkdir(path.join(bundled, 'gamma'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.wrongstack', 'skills', 'alpha', 'SKILL.md'), SKILL_A);
    await fs.writeFile(path.join(globalRoot, 'skills', 'beta', 'SKILL.md'), SKILL_B);
    await fs.writeFile(path.join(globalRoot, 'skills', 'malformed', 'SKILL.md'), SKILL_BAD);
    await fs.writeFile(
      path.join(bundled, 'alpha', 'SKILL.md'),
      `---\nname: alpha\ndescription: bundled alpha (shadowed)\n---\n`,
    );
    await fs.writeFile(
      path.join(bundled, 'gamma', 'SKILL.md'),
      `---\nname: gamma\ndescription: bundled-only\n---\n`,
    );
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('lists project, user, and bundled skills with shadowing', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const loader = new DefaultSkillLoader({ paths, bundledDir: bundled });
    const list = await loader.list();
    const names = list.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta', 'gamma']);
    const alpha = list.find((s) => s.name === 'alpha')!;
    expect(alpha.source).toBe('project'); // project shadows bundled
    expect(alpha.version).toBe('1.0.0');
    expect(alpha.description).toContain('alpha skill');
    const gamma = list.find((s) => s.name === 'gamma')!;
    expect(gamma.source).toBe('bundled');
  });

  it('skips entries missing name/description', async () => {
    await fs.writeFile(path.join(globalRoot, 'skills', 'malformed', 'SKILL.md'), SKILL_NONAME);
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const loader = new DefaultSkillLoader({ paths });
    const list = await loader.list();
    expect(list.find((s) => s.name === undefined)).toBeUndefined();
  });

  it('find returns specific skill', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const loader = new DefaultSkillLoader({ paths });
    const beta = await loader.find('beta');
    expect(beta?.description).toBe('short');
    const missing = await loader.find('nope');
    expect(missing).toBeUndefined();
  });

  it('manifestText lists skills in markdown', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const loader = new DefaultSkillLoader({ paths });
    const txt = await loader.manifestText();
    expect(txt).toContain('## Available skills');
    expect(txt).toContain('alpha');
    expect(txt).toContain('beta');
  });

  it('manifestText empty when no skills', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-empty-skills-'));
    try {
      const paths = resolveWstackPaths({
        projectRoot: path.join(empty, 'p'),
        globalRoot: path.join(empty, 'g'),
      });
      const loader = new DefaultSkillLoader({ paths });
      const txt = await loader.manifestText();
      expect(txt).toBe('');
    } finally {
      await fs.rm(empty, { recursive: true, force: true });
    }
  });

  it('readBody returns SKILL.md contents', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const loader = new DefaultSkillLoader({ paths });
    const body = await loader.readBody('beta');
    expect(body).toContain('beta body');
  });

  it('readBody throws for unknown skill', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const loader = new DefaultSkillLoader({ paths });
    await expect(loader.readBody('does-not-exist')).rejects.toThrow(/not found/);
  });

  it('listEntries returns structured entries with trigger and scope', async () => {
    const paths = resolveWstackPaths({ projectRoot, globalRoot });
    const loader = new DefaultSkillLoader({ paths, bundledDir: bundled });
    const entries = await loader.listEntries();
    const alpha = entries.find((e) => e.name === 'alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.trigger).toBe('the alpha skill'); // first line (no period in description)
    expect(alpha!.scope).toEqual([]); // no "covers/for/including" in description
    expect(alpha!.source).toBe('project');
    const beta = entries.find((e) => e.name === 'beta');
    expect(beta!.trigger).toBe('short');
    expect(beta!.scope).toEqual([]);
  });
});
