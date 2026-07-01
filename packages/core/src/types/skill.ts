export interface SkillManifest {
  name: string;
  description: string;
  version?: string | undefined;
  /** agentskills.io optional frontmatter fields. */
  license?: string | undefined;
  compatibility?: string | undefined;
  metadata?: Record<string, string> | undefined;
  allowedTools?: string[] | undefined;
  path: string;
  /**
   * Discovery layer the skill came from. `claude-*`, `foreign`, and `extra` are
   * read-only foreign sources (other coding agents' dirs, or
   * `config.skills.extraDirs`); they are never written to by the skill installer.
   */
  source: 'project' | 'user' | 'bundled' | 'claude-project' | 'claude-user' | 'extra' | 'foreign';
  /** For `foreign` sources: the originating tool id (codex, cursor, agents, …). */
  originTool?: string | undefined;
}

/** Parsed skill entry for structured rendering in system prompt. */
export interface SkillEntry {
  name: string;
  /** "Use when..." trigger condition — one-liner */
  trigger: string;
  /** Comma-separated scope items */
  scope: string[];
  source: SkillManifest['source'];
  /** For `foreign` sources: the originating tool id. */
  originTool?: string | undefined;
  path: string;
}

export interface SkillLoader {
  list(): Promise<SkillManifest[]>;
  /** Structured entries with trigger/scope for system prompt rendering. */
  listEntries(): Promise<SkillEntry[]>;
  find(name: string): Promise<SkillManifest | undefined>;
  manifestText(): Promise<string>;
  readBody(name: string): Promise<string>;
  /**
   * Read the token-saving compact variant of a skill body.
   * Tries `SKILL.save.md` first (hand-crafted compact version), falls back
   * to auto-compacting the full `SKILL.md` body.
   */
  readSaveBody(name: string): Promise<string>;
  /** Clear the internal cache so the next list/find re-reads from disk. */
  invalidateCache(): void;
}
