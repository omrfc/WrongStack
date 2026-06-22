/**
 * auto-doc plugin — Auto-generates JSDoc/TSDoc comments for source files.
 *
 * Tools registered:
 * - auto_doc: Generate and inject doc comments into JS/TS files
 * - auto_doc_preview: Preview doc comments without writing them
 */
import type { Plugin } from '@wrongstack/core';

const AUTO_DOC_API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

interface AutoDocInput {
  files: string[];
  style?: 'jsdoc' | 'tsdoc' | undefined;
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
}

interface AutoDocPreviewInput {
  files: string[];
  style?: 'jsdoc' | 'tsdoc' | undefined;
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

      if (!input.dryRun && results.length > 0) {
        writeFileSync(file, modified, 'utf-8');
        api.log.info(`auto-doc: updated ${file}`);
      }
    } catch (err) {
      api.log.error(`auto-doc: error processing ${file}: ${err}`);
    }
  }

  return { ok: true, filesProcessed: input.files.length, changes: results };
}

async function runAutoDocPreview(input: AutoDocPreviewInput, api: Parameters<Plugin['setup']>[0]) {
  if (!input.files || typeof input.files !== 'object' || !Array.isArray(input.files)) {
    return { ok: false, error: 'input.files must be an array of file paths', previews: [] };
  }
  if (input.files.length === 0) {
    return { ok: false, error: 'input.files is empty — provide at least one file path', previews: [] };
  }
  const includeTypes = (api.config.extensions?.['auto-doc'] as Record<string, unknown>)?.['includeTypes'] as boolean ?? false;
  const previews: Array<{ file: string; entities: string[] }> = [];

  for (const file of input.files) {
    try {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(file, 'utf-8');
      const entities = parseSource(content);
      const generated = entities
        .filter((e) => needsDocComment(content, e))
        .map((e) => generateDocComment(e, includeTypes));
      previews.push({ file, entities: generated });
    } catch {
      api.log.warn(`auto-doc-preview: could not read file ${file}`);
    }
  }

  return { ok: true, previews };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'auto-doc',
  version: '0.1.0',
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
    api.tools.register({
      name: 'auto_doc',
      description: 'Auto-generate JSDoc/TSDoc comments for functions, classes, types, and interfaces in source files',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Source files to document' },
          style: { type: 'string', enum: ['jsdoc', 'tsdoc'], default: 'tsdoc', description: 'Comment style' },
          force: { type: 'boolean', default: false, description: 'Overwrite existing docstrings' },
          dryRun: { type: 'boolean', default: false, description: 'Preview without writing' },
        },
        required: ['files'],
      },
      permission: 'auto',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        return runAutoDoc(input as never as AutoDocInput, api);
      },
    });

    api.tools.register({
      name: 'auto_doc_preview',
      description: 'Preview what JSDoc/TSDoc comments would be generated for files, without writing',
      inputSchema: {
        type: 'object',
        properties: {
          files: { type: 'array', items: { type: 'string' }, description: 'Source files to preview' },
          style: { type: 'string', enum: ['jsdoc', 'tsdoc'], default: 'tsdoc' },
        },
        required: ['files'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        return runAutoDocPreview(input as never as AutoDocPreviewInput, api);
      },
    });

    api.log.info('auto-doc plugin loaded', { version: '0.1.0', capabilities: ['auto_doc', 'auto_doc_preview'] });
  },

  teardown(api) {
    api.log.info('auto-doc plugin unloaded');
  },
};

export default plugin;
