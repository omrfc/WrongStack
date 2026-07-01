/**
 * spec-linker plugin — PostToolUse hook on `write|edit` that scans
 * the file for `[plugin-name]`-style references and surfaces
 * unlinked ones to the LLM via `additionalContext`.
 *
 * A reference is "linked" if it appears as a markdown link
 * `[name](...)` or as an HTML link `<a href="...">name</a>`. An
 * "unlinked" reference is the bare name — common when an author
 * types `secret-scanner` inline in prose but forgets the link.
 *
 * The plugin does NOT modify the file (no `modifiedInput` rewrite).
 * It only injects a single, low-noise context block listing the
 * unlinked references and their canonical path. The LLM can then
 * decide whether to fix the file in a follow-up edit.
 *
 * Detection rules:
 *  - Source is `.md` or `.mdx` (markdown)
 *  - The reference matches one of the known plugin names exactly
 *    (case-insensitive, word-boundary)
 *  - It is not already wrapped in a markdown link `[name](` or
 *    inline code `` `name` ``
 *
 * The plugin catalog is sourced from `../catalog.js` (single source
 * of truth — adding a new plugin to the catalog table there is
 * enough for this plugin to start detecting it).
 *
 * Config (`config.extensions['spec-linker']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "fileGlobs": ["**\/*.md", "**\/*.mdx"],
 *   "maxReferences": 8
 * }
 * ```
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';
import { existsSync, statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { PLUGIN_CATALOG, PLUGIN_NAMES } from '../catalog.js';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface LinkerState {
  /** Total PostToolUse invocations for matching files. */
  invocationCount: number;
  /** Times at least one unlinked reference was surfaced. */
  unlinkedCount: number;
  /** Times no references were found (clean file or no plugins mentioned). */
  cleanCount: number;
  /** Times the file was not a markdown file (skipped). */
  skippedNonMd: number;
  /** Times the file could not be read (missing, etc.). */
  readErrorCount: number;
  /** Hook handle for teardown. */
  hookUnregister: null | (() => void);
}

const state: LinkerState = {
  invocationCount: 0,
  unlinkedCount: 0,
  cleanCount: 0,
  skippedNonMd: 0,
  readErrorCount: 0,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface SpecLinkerConfig {
  enabled: boolean;
  /** Glob-style extensions to scan. Defaults to markdown only. */
  fileGlobs: string[];
  /** Hard cap on the number of unlinked references in the injected context. */
  maxReferences: number;
}

const DEFAULTS: SpecLinkerConfig = {
  enabled: true,
  fileGlobs: ['**/*.md', '**/*.mdx'],
  maxReferences: 8,
};

function readConfig(raw: unknown): SpecLinkerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    fileGlobs: Array.isArray(r['fileGlobs'])
      ? (r['fileGlobs'] as unknown[]).filter((g): g is string => typeof g === 'string')
      : DEFAULTS.fileGlobs,
    maxReferences:
      typeof r['maxReferences'] === 'number' && r['maxReferences'] > 0
        ? r['maxReferences']
        : DEFAULTS.maxReferences,
  };
}

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

/** True if the file path matches any of the configured globs. */
function fileMatchesGlobs(filePath: string, globs: string[]): boolean {
  const lower = filePath.toLowerCase();
  return globs.some((g) => {
    // Translate `**\/*.md` → `**/*.md` (Windows path-safe)
    const normalized = g.replace(/\\/g, '/').toLowerCase();
    // Strip the `**/` prefix so we match the basename and any
    // subdirectory. So `**/*.md` matches `foo.md` and `x/y.md`.
    const pattern = normalized.replace(/^\*\*\//, '');
    // A simple extension match: `*.md` -> ends-with `.md`.
    if (pattern.startsWith('*.')) {
      return lower.endsWith(pattern.slice(1));
    }
    // Fallback: substring match.
    return lower.includes(pattern);
  });
}

/** True if `name` appears as a markdown link `[name](` or inline code `` `name` ``. */
function isWrappedAsLinkOrCode(line: string, name: string): boolean {
  const lower = line.toLowerCase();
  const target = name.toLowerCase();
  // Markdown link: [name](
  if (lower.includes(`[${target}](`)) return true;
  // Inline code: `name`
  if (lower.includes(`\`${target}\``)) return true;
  // Markdown link with label containing the name (e.g. [the `secret-scanner`
  // plugin](./src/secret-scanner))
  if (lower.includes(`[\``) && lower.includes(`\`](`)) return true;
  return false;
}

/**
 * Find all unlinked plugin references on the given lines.
 * Returns a list of plugin names in their original casing.
 */
function findUnlinkedReferences(lines: string[], names: string[]): string[] {
  const found = new Map<string, true>(); // preserve original casing
  for (const line of lines) {
    if (line.length === 0) continue;
    for (const name of names) {
      // Word-boundary check: the name must appear as a complete
      // token, not as a substring of a longer identifier. We also
      // exclude hyphenated continuations (`secret-scanner-config`
      // should not match `secret-scanner`) and dot-continuations
      // (`secret-scanner.json`).
      const re = new RegExp(`(^|[^\\w-])${escapeRegExp(name)}(?![\\w-])`, 'i');
      if (re.test(line) && !isWrappedAsLinkOrCode(line, name)) {
        if (!found.has(name)) found.set(name, true);
      }
    }
  }
  return [...found.keys()];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'spec-linker',
  version: '0.1.0',
  description: 'PostToolUse hook that scans markdown files for unlinked plugin references and surfaces them to the LLM via additionalContext',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      fileGlobs: {
        type: 'array',
        items: { type: 'string' },
        default: DEFAULTS.fileGlobs,
        description: 'Glob patterns to match (markdown by default).',
      },
      maxReferences: {
        type: 'number',
        minimum: 1,
        maximum: 50,
        default: 8,
        description: 'Hard cap on the number of unlinked references in the injected context.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.unlinkedCount = 0;
    state.cleanCount = 0;
    state.skippedNonMd = 0;
    state.readErrorCount = 0;
    state.hookUnregister = null;

    const cfg = readConfig(api.config.extensions?.['spec-linker']);

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): Promise<{ additionalContext?: string } | void> => {
      if (!cfg.enabled) return;
      // Skip on tool errors.
      if (input.toolResult?.isError) return;

      const toolName = input.toolName ?? '';
      if (toolName !== 'write' && toolName !== 'edit') return;

      const inp = (input.toolInput ?? {}) as { path?: string; content?: string };
      const filePath = inp.path;
      if (!filePath || typeof filePath !== 'string') return;

      // Glob filter — only markdown files by default.
      if (!fileMatchesGlobs(filePath, cfg.fileGlobs)) {
        state.skippedNonMd += 1;
        return;
      }

      state.invocationCount += 1;

      // Read the file from disk so we get the post-edit state
      // (the toolInput content might be partial for `edit`).
      if (!existsSync(filePath)) return;
      let content: string;
      try {
        // Make sure it's a file, not a directory.
        const stat = statSync(filePath);
        if (!stat.isFile()) return;
        content = await fs.readFile(filePath, 'utf-8');
      } catch {
        state.readErrorCount += 1;
        return;
      }

      const unlinked = findUnlinkedReferences(content.split('\n'), [...PLUGIN_NAMES]);
      if (unlinked.length === 0) {
        state.cleanCount += 1;
        return;
      }

      state.unlinkedCount += 1;
      const limited = unlinked.slice(0, cfg.maxReferences);
      const overflow = unlinked.length - limited.length;

      const lines = limited
        .map((name) => `- \`${name}\` → \`[${name}](${PLUGIN_CATALOG.get(name) ?? `./src/${name}`})\``)
        .join('\n');
      const overflowNote = overflow > 0 ? `\n- …and ${overflow} more` : '';

      return {
        additionalContext:
          `\n🔗 spec-linker: ${unlinked.length} unlinked plugin reference(s) in '${filePath}'. ` +
          `Consider wrapping them in markdown links to keep the docs navigable:\n` +
          `${lines}${overflowNote}`,
      };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook as never);

    // ── spec_linker_status tool ───────────────────────────────────────
    api.tools.register({
      name: 'spec_linker_status',
      description:
        'Reports spec-linker state: config, counters, and the canonical plugin catalog used for detection.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          fileGlobs: cfg.fileGlobs,
          maxReferences: cfg.maxReferences,
          counters: {
            invocations: state.invocationCount,
            unlinked: state.unlinkedCount,
            clean: state.cleanCount,
            skippedNonMd: state.skippedNonMd,
            readErrors: state.readErrorCount,
          },
          catalogSize: PLUGIN_NAMES.length,
        };
      },
    });

    api.log.info('spec-linker plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      fileGlobs: cfg.fileGlobs,
      catalogSize: PLUGIN_NAMES.length,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocationCount,
      unlinked: state.unlinkedCount,
      clean: state.cleanCount,
      skippedNonMd: state.skippedNonMd,
      readErrors: state.readErrorCount,
    };
    state.invocationCount = 0;
    state.unlinkedCount = 0;
    state.cleanCount = 0;
    state.skippedNonMd = 0;
    state.readErrorCount = 0;
    api.log.info('spec-linker: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `spec-linker: ${state.invocationCount} invocation(s), ${state.unlinkedCount} unlinked, ${state.cleanCount} clean, ${state.skippedNonMd} non-md skipped`,
      counters: {
        invocations: state.invocationCount,
        unlinked: state.unlinkedCount,
        clean: state.cleanCount,
        skippedNonMd: state.skippedNonMd,
        readErrors: state.readErrorCount,
      },
    };
  },
};

export default plugin;
