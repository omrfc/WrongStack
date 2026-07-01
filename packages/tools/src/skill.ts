import { type Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stripFrontmatter, ToolValidationError, type SkillLoader, type Tool } from '@wrongstack/core';

interface SkillToolInput {
  name: string;
}

interface SkillResource {
  /** Path relative to the skill directory (e.g. `scripts/extract.py`). */
  path: string;
  bytes: number;
}

interface SkillToolOutput {
  name: string;
  description: string;
  /** Frontmatter-stripped SKILL.md body (capped). */
  body: string;
  /** Files under scripts/ references/ assets/ — load on demand via the read tool. */
  resources: SkillResource[];
  /** Absolute directory of the skill, for reading bundled resources. */
  dir: string;
}

const RESOURCE_DIRS = ['scripts', 'references', 'assets'];
const MAX_BODY_CHARS = 16_000;

/**
 * Skill tool — the agentskills.io progressive-disclosure activation primitive.
 *
 * In `eager` skill mode every discovered skill body is already in the system
 * prompt, so this tool is mostly a convenience there. In `progressive` mode the
 * prompt carries only the metadata manifest (name + trigger); the agent calls
 * this tool to pull a skill's full instructions on demand, plus a listing of its
 * bundled resource files (scripts/ references/ assets/), which it reads on
 * demand via the read tool — the spec's three-tier loading model.
 */
export function makeSkillTool(skillLoader: SkillLoader): Tool<SkillToolInput, SkillToolOutput> {
  return {
    name: 'skill',
    category: 'Skills',
    description:
      "Load a skill's full instructions on demand. The system prompt only lists skill names and triggers; " +
      'call this with a skill name when a task matches its trigger to read the complete SKILL.md body and ' +
      'see any bundled resource files (scripts/references/assets) you can then read.',
    usageHint:
      'Load a skill body by name (progressive disclosure).\n\n' +
      'WHEN TO USE:\n' +
      '- A task matches a skill trigger listed in the system prompt\n' +
      '- You need the full rules/patterns a skill encodes\n\n' +
      'The response includes the skill body plus any bundled resource files; read those with the read tool only if needed.',
    permission: 'auto',
    mutating: false,
    capabilities: ['fs.read'],
    icon: 'document',
    timeoutMs: 5_000,
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact skill name (as shown in the available-skills list).',
        },
      },
      required: ['name'],
    },
    async execute(input, ctx) {
      const name = input?.name?.trim();
      if (!name) {
        throw new ToolValidationError({ message: 'skill: name is required', field: 'name' });
      }
      const manifest = await skillLoader.find(name);
      if (!manifest) {
        throw new ToolValidationError({
          message: `skill "${name}" not found — use /skill to list available skills`,
          field: 'name',
        });
      }
      const raw = await skillLoader.readBody(name);
      const body = stripFrontmatter(raw).trim().slice(0, MAX_BODY_CHARS);
      const dir = path.dirname(manifest.path);
      const resources = await listResources(dir);
      // Record the activation in the session transcript (best-effort — never
      // block skill loading on session writes). Same ctx.session path the agent
      // loop uses for user_input / llm_response.
      try {
        await ctx?.session?.append({
          type: 'skill_activated',
          ts: new Date().toISOString(),
          skillName: manifest.name,
        });
      } catch {
        // best-effort: session recording must never break skill loading
      }
      return { name: manifest.name, description: manifest.description, body, resources, dir };
    },
    serialize(output) {
      const head = `# Skill: ${output.name}\n${output.description}\n\n${output.body}`;
      if (output.resources.length === 0) return head;
      const listing = output.resources.map((r) => `- ${r.path} (${r.bytes} B)`).join('\n');
      return `${head}\n\n## Bundled resources (read on demand via the read tool, relative to ${output.dir})\n${listing}`;
    },
  };
}

async function listResources(skillDir: string): Promise<SkillResource[]> {
  const out: SkillResource[] = [];
  for (const sub of RESOURCE_DIRS) {
    const dir = path.join(skillDir, sub);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // subdir absent — not every skill has resources
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const stat = await fs.stat(path.join(dir, e.name));
        out.push({ path: `${sub}/${e.name}`, bytes: stat.size });
      } catch {
        // skip unreadable entry
      }
    }
  }
  return out;
}
