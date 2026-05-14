import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { DefaultSystemPromptBuilder, LAYER_1_IDENTITY } from '../../src/index.js';
import type { MemoryStore, SkillLoader, Tool } from '../../src/index.js';

const mkTool = (name: string, hint?: string): Tool => ({
  name,
  description: `desc-${name}`,
  usageHint: hint,
  permission: 'auto',
  mutating: false,
  inputSchema: { type: 'object' },
  async execute() {
    return '';
  },
});

describe('DefaultSystemPromptBuilder', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-prompt-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('emits three text blocks for empty memory/skills', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.text).toContain(LAYER_1_IDENTITY.slice(0, 40));
    expect(blocks[1]?.text).toContain('No tools registered');
    expect(blocks[2]?.text).toContain('2026-05-13');
    expect(blocks[2]?.text).toContain(tmp);
  });

  it('renders tool usage with usageHint or description fallback', async () => {
    const b = new DefaultSystemPromptBuilder();
    const blocks = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: [mkTool('alpha', 'alpha-hint'), mkTool('beta')],
    });
    const toolBlock = blocks[1]?.text ?? '';
    expect(toolBlock).toContain('### alpha');
    expect(toolBlock).toContain('alpha-hint');
    expect(toolBlock).toContain('### beta');
    expect(toolBlock).toContain('desc-beta');
  });

  it('reports "not a git repo" when no .git directory', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(blocks[2]?.text).toContain('not a git repo');
  });

  it('detects languages from project markers', async () => {
    await fs.writeFile(path.join(tmp, 'package.json'), '{}');
    await fs.writeFile(path.join(tmp, 'go.mod'), 'module x');
    const b = new DefaultSystemPromptBuilder();
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(blocks[2]?.text).toContain('JavaScript/TypeScript');
    expect(blocks[2]?.text).toContain('Go');
  });

  it('includes memory + skill block with ephemeral cache_control when present', async () => {
    const memory: MemoryStore = {
      readAll: async () => '- prefer pnpm',
      read: async () => '',
      remember: async () => undefined,
      forget: async () => 0,
      consolidate: async () => undefined,
    };
    const skills: SkillLoader = {
      manifestText: async () => '## Skills\n- /foo',
      listEntries: async () => [
        { name: 'test-skill', trigger: 'Use for testing.', scope: ['testing'], source: 'bundled', path: '/test/skill.md' },
      ],
      list: async () => [],
      find: async () => undefined,
      load: async () => undefined,
    } as unknown as SkillLoader;
    const b = new DefaultSystemPromptBuilder({ memoryStore: memory, skillLoader: skills });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(blocks).toHaveLength(4);
    const last = blocks[3]!;
    expect(last.text).toContain('Project Memory');
    expect(last.text).toContain('prefer pnpm');
    expect(last.text).toContain('## Available skills');
    expect(last.text).toContain('test-skill');
    expect(last.text).toContain('Use when:');
    expect(last.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits memory block when both readers return empty', async () => {
    const memory: MemoryStore = {
      readAll: async () => '',
      read: async () => '',
      remember: async () => undefined,
      forget: async () => 0,
      consolidate: async () => undefined,
    };
    const b = new DefaultSystemPromptBuilder({ memoryStore: memory });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(blocks).toHaveLength(3);
  });

  it('swallows memory store errors gracefully', async () => {
    const memory: MemoryStore = {
      readAll: async () => {
        throw new Error('disk gone');
      },
      read: async () => '',
      remember: async () => undefined,
      forget: async () => 0,
      consolidate: async () => undefined,
    };
    const b = new DefaultSystemPromptBuilder({ memoryStore: memory });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(blocks).toHaveLength(3); // memory swallowed → no layer 4
  });

  it('caches environment block across builds', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    const a = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const c = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(a[2]?.text).toBe(c[2]?.text);
  });

  it('reports git branch when .git directory exists', async () => {
    const { spawnSync } = await import('node:child_process');
    const init = spawnSync('git', ['init', '--quiet', '--initial-branch=main'], {
      cwd: tmp,
      stdio: 'ignore',
    });
    if (init.status !== 0) return; // git not installed — skip
    spawnSync('git', ['config', 'user.email', 'test@test'], { cwd: tmp, stdio: 'ignore' });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmp, stdio: 'ignore' });
    await fs.writeFile(path.join(tmp, 'a.txt'), 'hi');
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const env = blocks[2]?.text ?? '';
    expect(env).toMatch(/branch=/);
    expect(env).toMatch(/modified/);
  });
});
