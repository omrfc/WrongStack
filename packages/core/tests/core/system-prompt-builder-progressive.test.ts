/**
 * Faz 3: progressive skill disclosure. `skillMode: 'progressive'` injects only a
 * name+trigger manifest (the agentskills.io tier-1 model) and points the agent at
 * the `skill` tool to load bodies on demand — instead of eagerly injecting every
 * skill body.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSystemPromptBuilder, type SkillLoader } from '../../src/index.js';

function mkSkillLoader(
  skills: Array<{ name: string; trigger?: string; body?: string }>,
): SkillLoader {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    list: async () =>
      skills.map((s) => ({
        name: s.name,
        description: s.trigger ?? '',
        path: `/mock/${s.name}`,
        source: 'bundled' as const,
      })),
    listEntries: async () =>
      skills.map((s) => ({
        name: s.name,
        trigger: s.trigger ?? '',
        scope: [],
        source: 'bundled' as const,
        path: `/mock/${s.name}`,
      })),
    find: async (name: string) =>
      byName.has(name)
        ? { name, description: byName.get(name)!.trigger ?? '', path: `/mock/${name}`, source: 'bundled' as const }
        : undefined,
    manifestText: async () => '',
    readBody: async (name: string) => byName.get(name)?.body ?? '',
    readSaveBody: async () => '',
    invalidateCache: () => undefined,
  } as unknown as SkillLoader;
}

describe('DefaultSystemPromptBuilder — progressive skill mode', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-prog-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function build(opts: { skillMode?: 'progressive'; skills: SkillLoader }): Promise<string> {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-07-01',
      skillLoader: opts.skills,
      skillMode: opts.skillMode,
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    return blocks.map((bl) => bl.text).join('\n');
  }

  it('progressive mode injects a name+trigger manifest, not bodies', async () => {
    const loader = mkSkillLoader([
      { name: 'docker-deploy', trigger: 'Deploy docker containers.', body: 'DOCKER RULES BODY' },
      { name: 'react-modern', trigger: 'Write React 19 code.', body: 'REACT RULES BODY' },
    ]);
    const prompt = await build({ skillMode: 'progressive', skills: loader });

    // manifest lists both skill names with their triggers
    expect(prompt).toContain('`docker-deploy`');
    expect(prompt).toContain('`react-modern`');
    expect(prompt).toContain('Deploy docker containers.');
    // instructs the agent to use the skill tool
    expect(prompt).toContain('`skill` tool');
    // bodies are NOT eagerly injected
    expect(prompt).not.toContain('DOCKER RULES BODY');
    expect(prompt).not.toContain('REACT RULES BODY');
  });

  it('eager mode (default) still injects full skill bodies', async () => {
    const loader = mkSkillLoader([
      { name: 'docker-deploy', trigger: 'Deploy docker containers.', body: 'DOCKER RULES BODY' },
    ]);
    const prompt = await build({ skills: loader }); // no skillMode → eager
    expect(prompt).toContain('DOCKER RULES BODY');
  });
});
