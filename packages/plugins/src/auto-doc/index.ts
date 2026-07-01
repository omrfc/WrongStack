/**
 * auto-doc plugin — Auto-generates JSDoc/TSDoc comments for source files.
 *
 * Tools registered:
 * - auto_doc: Generate and inject doc comments into JS/TS files.
 *   Pass `dry_run: true` to preview without writing (replaces the former
 *   `auto_doc (dry_run)` tool).
 */
import type { Plugin } from '@wrongstack/core';

const AUTO_DOC_API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern: shared between setup, teardown,
// health). auto-doc is fundamentally stateless — the actual work happens
// in `runAutoDoc` per call. We track per-session invocation counts so
// /diag plugins can report "how many docstrings this session generated".
// Setup is idempotent: re-init zeros the counter; teardown leaves the
// counter at zero.
// ---------------------------------------------------------------------------
const state = {
  invocationCount: 0,
  /** Last invocation summary — surfaced by health() for /diag plugins. */
  lastInvocation: null as null | {
    when: string;
    files: number;
    style: 'jsdoc' | 'tsdoc';
    dryRun: boolean;
  },
};

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

interface AutoDocInput {
  files: string[];
  style?: 'jsdoc' | 'tsdoc' | undefined;
  force?: boolean | undefined;
  dry_run?: boolean | undefined;
}

// ---------------------------------------------------------------------------
// Doc generation helpers
// ---------------------------------------------------------------------------

type ParsedEntity =
  | { kind: 'function'; name: string; startLine: number; params: string[]; returnType?: string | undefined }
  | { kind: 'class'; name: string; startLine: number }
  | { kind: 'type'; name: string; startLine: number }
  | { kind: 'interface'; name: string; startLine: number };

function parseSource(content: string): ParsedEntity[] {
  const entities: ParsedEntity[] = [];
  const lines = content.split('\n');
  const reFunction = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\((.*?)\)(?:\s*:\s*(.+?))?\s*\{/;
  const reArrowFn = /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\((.*?)\)\s*(?::\s*(.+?))?\s*=>/;
  const reClass = /^(?:export\s+)?class\s+(\w+)/;
  const reType = /^(?:export\s+)?type\s+(\w+)\s*=\s*\{/;
  const reInterface = /^(?:export\s+)?interface\s+(\w+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    let m = line.match(reFunction);
    if (m?.[1]) {
      entities.push({
        kind: 'function', name: m[1], startLine: i + 1,
        params: m[2] ? m[2].split(',').map((p) => p.trim().split(':')[0]?.trim()).filter((p): p is string => Boolean(p)) : [],
        returnType: m[3]?.trim(),
      });
      continue;
    }

    m = line.match(reArrowFn);
    if (m?.[1]) {
      entities.push({
        kind: 'function', name: m[1], startLine: i + 1,
        params: m[2] ? m[2].split(',').map((p) => p.trim().split(':')[0]?.trim()).filter((p): p is string => Boolean(p)) : [],
        returnType: m[3]?.trim(),
      });
      continue;
    }

    m = line.match(reClass);
    if (m?.[1]) { entities.push({ kind: 'class', name: m[1], startLine: i + 1 }); continue; }

    m = line.match(reType);
    if (m?.[1]) { entities.push({ kind: 'type', name: m[1], startLine: i + 1 }); continue; }

    m = line.match(reInterface);
    if (m?.[1]) { entities.push({ kind: 'interface', name: m[1], startLine: i + 1 }); }
  }

  return entities;
}

function generateDocComment(entity: ParsedEntity, includeTypes: boolean): string {
  // JSDoc and TSDoc share the same @param/@returns syntax for the entity
  // types this plugin supports (function, class, type, interface). When
  // TSDoc-specific tags (@typeParam, @remarks) are needed, extend here.
  switch (entity.kind) {
    case 'function': {
      const params = entity.params
        .map((p) => `   * @param ${p} - TODO: describe parameter`)
        .join('\n');
      const returns = entity.returnType
        ? `\n   * @returns ${includeTypes ? `{${entity.returnType}} ` : ''}TODO: describe return value`
        : '';
      return `/**\n   * TODO: One-line description of ${entity.name}\n${params}${returns}\n   */`;
    }
    case 'class':    return `/**\n   * TODO: Describe class ${entity.name}\n   */`;
    case 'type':     return `/**\n   * TODO: Describe type ${entity.name}\n   */`;
    case 'interface': return `/**\n   * TODO: Describe interface ${entity.name}\n   */`;
  }
}

function needsDocComment(content: string, entity: ParsedEntity): boolean {
  const lines = content.split('\n');
  const lineIdx = entity.startLine - 1;
  if (lineIdx < 1) return true;
  /* v8 ignore next -- lineIdx >= 1 here, so lines[lineIdx - 1] is always defined; the ?? '' is defensive. */
  const prevLine = lines[lineIdx - 1] ?? '';
  return !/^\s*\/\*\*\s*$/.test(prevLine.trim());
}

function injectDocComment(content: string, entity: ParsedEntity, doc: string): string {
  const lines = content.split('\n');
  const idx = entity.startLine - 1;
  /* v8 ignore next -- idx is a valid line index for a parsed entity; the ?? '' fallback is defensive. */
  const codeLine = lines[idx] ?? '';
  /* v8 ignore next -- /^(\s*)/ always matches; the ?.[1] ?? '' fallback is defensive. */
  const indent = codeLine.match(/^(\s*)/)?.[1] ?? '';
  lines.splice(idx, 0, `${indent}${doc}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function runAutoDoc(input: AutoDocInput, api: Parameters<Plugin['setup']>[0]) {
  if (!input.files || typeof input.files !== 'object' || !Array.isArray(input.files)) {
    return { ok: false, error: 'input.files must be an array of file paths', filesProcessed: 0, changes: [] };
  }
  if (input.files.length === 0) {
    return { ok: false, error: 'input.files is empty — provide at least one file path', filesProcessed: 0, changes: [] };
  }
  const includeTypes = (api.config.extensions?.['auto-doc'] as Record<string, unknown>)?.['includeTypes'] as boolean ?? false;
  const results: Array<{ file: string; entity: string }> = [];

  for (const file of input.files) {
    try {
      const { readFileSync, writeFileSync } = await import('node:fs');
      let content: string;
      try {
        content = readFileSync(file, 'utf-8');
      } catch {
        api.log.warn(`auto-doc: could not read file ${file}`);
        continue;
      }

      const entities = parseSource(content);
      let modified = content;

      for (const entity of entities) {
        if (!input.force && !needsDocComment(modified, entity)) continue;

        const doc = generateDocComment(entity, includeTypes);

        modified = injectDocComment(modified, entity, doc);
        results.push({ file, entity: entity.name });
      }

      if (!input.dry_run && results.length > 0) {
        writeFileSync(file, modified, 'utf-8');
        api.log.info(`auto-doc: updated ${file}`);
      }
    } catch (err) {
      api.log.error(`auto-doc: error processing ${file}: ${err}`);
    }
  }

  return { ok: true, filesProcessed: input.files.length, changes: results };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'auto-doc',
  version: '0.2.0',
  description: 'Auto-generates JSDoc/TSDoc comments for functions, classes, types, and interfaces',
  apiVersion: AUTO_DOC_API_VERSION,
  capabilities: { tools: true, pipelines: ['toolCall'] },
  defaultConfig: { style: 'tsdoc', includeTypes: false, dryRun: false },
  configSchema: {
    type: 'object',
    properties: {
      style: { type: 'string', enum: ['jsdoc', 'tsdoc'], default: 'tsdoc' },
      includeTypes: { type: 'boolean', default: false },
      dryRun: { type: 'boolean', default: false },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern): zero counters on reload.
    state.invocationCount = 0;
    state.lastInvocation = null;

    api.tools.register({
      name: 'auto_doc',
      description: 'Auto-generate JSDoc/TSDoc comments for functions, classes, types, and interfaces in source files. Set `dry_run: true` to preview without writing.',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Source files to document' },
          style: { type: 'string', enum: ['jsdoc', 'tsdoc'], default: 'tsdoc', description: 'Comment style' },
          force: { type: 'boolean', default: false, description: 'Overwrite existing docstrings' },
          dry_run: { type: 'boolean', default: false, description: 'Preview generated comments without writing to files' },
        },
        required: ['files'],
      },
      permission: 'auto',
      mutating: true,
      category: 'Project',
      async execute(input: Record<string, unknown>) {
        // Bump the per-session counter on every invocation — before the
        // call, so failed invocations still count. The health() snapshot
        // below is updated on success so /diag can answer "what was the
        // last auto_doc call this session?"
        const inp = input as never as AutoDocInput;
        state.invocationCount += 1;
        const result = await runAutoDoc(inp, api);
        state.lastInvocation = {
          when: new Date().toISOString(),
          files: Array.isArray(inp.files) ? inp.files.length : 0,
          style: inp.style === 'jsdoc' ? 'jsdoc' : 'tsdoc',
          dryRun: inp.dry_run === true,
        };
        return result;
      },
    });

    api.log.info('auto-doc plugin loaded', { version: '0.2.0', capabilities: ['auto_doc'] });
  },

  teardown(api) {
    // H1 pattern: zero counters on unload. auto-doc has no file
    // handles or timers to release — the existing log is preserved
    // plus a final invocation count so operators can see how many
    // docstrings the session generated.
    const finalCount = state.invocationCount;
    state.invocationCount = 0;
    state.lastInvocation = null;
    api.log.info('auto-doc: teardown complete', { invocations: finalCount });
  },

  async health() {
    // /diag plugins — surface a one-line status plus per-session
    // counters so an operator can confirm the plugin is wired and
    // see how heavily it's been used. No resources to track (the
    // tool is a per-call pure function).
    return {
      ok: true,
      message:
        state.lastInvocation === null
          ? `auto-doc: ${state.invocationCount} invocation(s) this session`
          : `auto-doc: last run ${state.lastInvocation.files} file(s) at ${state.lastInvocation.when} (${state.lastInvocation.dryRun ? 'dry-run' : 'write'})`,
      invocationCount: state.invocationCount,
      lastInvocation: state.lastInvocation,
    };
  },
};

export default plugin;
