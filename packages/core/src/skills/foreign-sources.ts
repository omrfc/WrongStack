/**
 * Well-known foreign coding-agent skill directories. All follow the
 * agentskills.io `SKILL.md` format, so the same loader reads them — this just
 * tells it WHERE each agent keeps them.
 *
 * Claude is handled separately by the loader (`claude-project` / `claude-user`
 * sources); this list covers the OTHER agents. Most store skills under
 * `~/.<tool>/skills` (+ `<project>/.<tool>/skills`); Cursor uses `skills-cursor`.
 * Dirs that don't exist are skipped gracefully, so listing many is cheap.
 */
export interface ForeignSkillTool {
  /** Tool id — also the directory name segment (`~/.<id>/…`). */
  id: string;
  /** Skills subdirectory name under `~/.<id>/`. */
  subdir: string;
}

export const FOREIGN_SKILL_TOOLS: readonly ForeignSkillTool[] = [
  { id: 'agents', subdir: 'skills' }, // shared store (asm / agentskills.io ecosystem)
  { id: 'codex', subdir: 'skills' }, // OpenAI Codex CLI
  { id: 'gemini', subdir: 'skills' }, // Gemini CLI
  { id: 'cursor', subdir: 'skills-cursor' }, // Cursor (non-standard subdir name)
  { id: 'qwen', subdir: 'skills' }, // Qwen Code
  { id: 'trae', subdir: 'skills' }, // Trae
  { id: 'windsurf', subdir: 'skills' }, // Windsurf
];

/**
 * Resolve the `config.skills.foreignSources` option into the list of tool ids
 * to scan.
 * - `false` → none
 * - `string[]` → only those ids (unknown ids dropped)
 * - `true` / `undefined` → all well-known tools
 */
export function resolveForeignToolIds(opt: boolean | string[] | undefined): string[] {
  if (opt === false) return [];
  if (Array.isArray(opt)) {
    const known = new Set(FOREIGN_SKILL_TOOLS.map((t) => t.id));
    return opt.filter((id) => known.has(id));
  }
  return FOREIGN_SKILL_TOOLS.map((t) => t.id);
}
