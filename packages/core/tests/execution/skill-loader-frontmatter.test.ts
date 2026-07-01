import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSkillLoader, resolveWstackPaths } from '../../src/index.js';

let tmp: string;
let projectRoot: string;
let loader: DefaultSkillLoader;

async function skill(name: string, contents: string) {
  const dir = path.join(projectRoot, '.wrongstack', 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), contents);
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-fm-'));
  projectRoot = path.join(tmp, 'proj');
  const paths = resolveWstackPaths({ projectRoot, userHome: path.join(tmp, 'home') });
  loader = new DefaultSkillLoader({ paths, readClaudeSkills: false });
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('DefaultSkillLoader frontmatter propagation + name validation', () => {
  it('surfaces license/compatibility/metadata/allowedTools on the manifest', async () => {
    await skill(
      'full',
      `---
name: full
description: a full skill
license: MIT
compatibility: needs node
metadata:
  author: jane
allowed-tools: Bash Read
---
body`,
    );
    const m = await loader.find('full');
    expect(m?.license).toBe('MIT');
    expect(m?.compatibility).toBe('needs node');
    expect(m?.metadata).toEqual({ author: 'jane' });
    expect(m?.allowedTools).toEqual(['Bash', 'Read']);
  });

  it('skips a skill whose name fails the spec format', async () => {
    await skill(
      'BadName',
      `---
name: BadName
description: uppercase name
---
body`,
    );
    expect(await loader.find('BadName')).toBeUndefined();
    expect((await loader.list()).map((s) => s.name)).not.toContain('BadName');
  });
});
