import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSkillLoader, resolveWstackPaths } from '../../src/index.js';

let tmp: string;
let globalRoot: string;
let loader: DefaultSkillLoader;

const fm = (name: string, desc: string, body = '') => `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;

async function skill(name: string, contents: string, saveBody?: string) {
  const dir = path.join(globalRoot, 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), contents);
  if (saveBody !== undefined) await fs.writeFile(path.join(dir, 'SKILL.save.md'), saveBody);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-loader-extra-'));
  globalRoot = path.join(tmp, 'global');
  await fs.mkdir(path.join(globalRoot, 'skills'), { recursive: true });

  await skill('saved', fm('saved', 'has a hand-written save variant'), '## Compact\nhand-written save body');
  await skill('ovrules', fm('ovrules', 'overview and rules', '## Overview\nThe overview text here.\n\n## Rules\n- rule one\n- rule two\n1. rule three\n'));
  await skill('ovonly', fm('ovonly', 'overview only', '## Overview\nJust an overview, no rules.\n'));
  await skill('rulesonly', fm('rulesonly', 'rules only', '## Rules\n- only a rule\n* another rule\n'));
  await skill('plainbody', fm('plainbody', 'no sections', 'Just a plain paragraph with no headers at all.\n'));
  await skill('longbody', fm('longbody', 'very long', `## Overview\n${'o'.repeat(300)}\n\n## Rules\n${Array.from({ length: 10 }, (_, i) => `- rule ${i} ${'x'.repeat(40)}`).join('\n')}\n`));
  await skill('emptybody', fm('emptybody', 'empty body', '   \n\n  \n'));
  await skill('scoped', fm('scoped', 'Does the thing. Covers alpha, beta, and gamma'));
  // unclosed frontmatter → parseFrontmatter returns {} → skill skipped during list()
  await skill('unclosed', '---\nname: unclosed\ndescription: never closes');
  // a frontmatter key with no value + a stray non-directory entry
  await skill('novalue', '---\nname: novalue\nversion:\ndescription: has an empty version line\n---\nbody');
  await fs.writeFile(path.join(globalRoot, 'skills', 'stray.txt'), 'not a skill dir');

  const paths = resolveWstackPaths({ projectRoot: path.join(tmp, 'proj'), globalRoot });
  loader = new DefaultSkillLoader({ paths });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('DefaultSkillLoader.readSaveBody', () => {
  it('returns a hand-written SKILL.save.md when present', async () => {
    expect(await loader.readSaveBody('saved')).toContain('hand-written save body');
  });

  it('auto-compacts Overview + Rules when no save variant exists', async () => {
    const out = await loader.readSaveBody('ovrules');
    expect(out).toContain('## Overview');
    expect(out).toContain('The overview text here.');
    expect(out).toContain('rule one');
  });

  it('compacts an Overview-only body', async () => {
    expect(await loader.readSaveBody('ovonly')).toContain('Just an overview');
  });

  it('compacts a Rules-only body', async () => {
    expect(await loader.readSaveBody('rulesonly')).toContain('only a rule');
  });

  it('falls back to the first paragraph when there are no sections', async () => {
    expect(await loader.readSaveBody('plainbody')).toContain('plain paragraph');
  });

  it('truncates an over-long compacted body', async () => {
    const out = await loader.readSaveBody('longbody');
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(500);
  });

  it('returns an empty string when the body is blank', async () => {
    expect(await loader.readSaveBody('emptybody')).toBe('');
  });

  it('caches the save body and throws for an unknown skill', async () => {
    const first = await loader.readSaveBody('ovonly');
    expect(await loader.readSaveBody('ovonly')).toBe(first); // cache hit
    await expect(loader.readSaveBody('ghost')).rejects.toThrow(/not found/);
  });
});

describe('DefaultSkillLoader caching + parsing edges', () => {
  it('extracts scope from a "Covers ..." description and caches entries', async () => {
    const entries = await loader.listEntries();
    const scoped = entries.find((e) => e.name === 'scoped');
    expect(scoped?.scope).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(await loader.listEntries()).toBe(entries); // second call → entriesCache hit
  });

  it('skips skills with unclosed frontmatter and stray non-directory entries', async () => {
    const names = (await loader.list()).map((s) => s.name);
    expect(names).not.toContain('unclosed'); // parseFrontmatter returned {}
    expect(names).toContain('novalue');
    expect(names).toContain('saved');
  });

  it('invalidateCache forces a re-read', async () => {
    const before = await loader.list();
    expect(before.length).toBeGreaterThan(0);
    await loader.listEntries(); // populate entriesCache
    loader.invalidateCache();
    // add a new skill, then a fresh list picks it up
    await skill('latecomer', fm('latecomer', 'added after first list'));
    const after = await loader.list();
    expect(after.map((s) => s.name)).toContain('latecomer');
  });

  it('readBody caches the full body', async () => {
    const first = await loader.readBody('ovonly');
    expect(await loader.readBody('ovonly')).toBe(first); // cache hit
  });
});
