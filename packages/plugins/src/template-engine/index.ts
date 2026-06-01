/**
 * template-engine plugin — File template expansion with variable substitution.
 *
 * Tools registered:
 * - template_expand: Expand a template string with variables
 * - template_render: Read a template file and expand it
 * - template_create: Save a named template to the plugin store
 * - template_list: List all saved templates
 */
import type { Plugin } from '@wrongstack/core';
import { isAbsolute } from 'node:path';

const API_VERSION = '^0.1.10';

interface StoredTemplate {
  name: string;
  content: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Template engine
// ---------------------------------------------------------------------------

function expandTemplate(template: string, variables: Record<string, string>): string {
  let result = template;

  // Replace simple {{variable}} patterns
  result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    const value = variables[key];
    if (value !== undefined) return value;
    return match; // leave unresolved
  });

  return result;
}

function expandConditionals(
  template: string,
  variables: Record<string, string>,
): string {
  // Handle {{#if variable}}...{{/if}}
  return template.replace(
    /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, key, content) => {
      const val = variables[key];
      return val !== undefined && val !== '' && val !== 'false' && val !== '0' ? content : '';
    },
  );
}

function expandLoops(
  template: string,
  variables: Record<string, string>,
): string {
  // Handle {{#each items}}...{{item}}...{{/each}}
  // Simplified: just repeat the block for each item separated by newlines
  return template.replace(
    /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
    (_, key, content) => {
      const val = variables[key];
      if (!val) return '';
      // If the variable value is a comma-separated list, expand each
      if (typeof val === 'string' && val.includes(',')) {
        const items = val.split(',').map((s) => s.trim());
        return items
          .map((item) => expandTemplate(content, { ...variables, [key]: item }))
          .join('\n');
      }
      return expandTemplate(content, variables);
    },
  );
}

function renderTemplate(template: string, variables: Record<string, string>): string {
  let result = template;

  // Process conditionals first
  result = expandConditionals(result, variables);

  // Process loops
  result = expandLoops(result, variables);

  // Process simple variable substitution
  result = expandTemplate(result, variables);

  // Auto-escape HTML if configured
  const shouldEscape = true; // safe default
  if (shouldEscape) {
    result = result
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return result;
}

function renderTemplateRaw(template: string, variables: Record<string, string>): string {
  let result = template;

  result = expandConditionals(result, variables);
  result = expandLoops(result, variables);
  result = expandTemplate(result, variables);

  return result;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'template-engine',
  version: '0.1.0',
  description: 'Expands file templates with variable substitution, conditionals, and loops',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: {
    autoEscapeHtml: true,
    templateDir: './templates',
    strictVariables: false,
  },
  configSchema: {
    type: 'object',
    properties: {
      autoEscapeHtml: { type: 'boolean', default: true },
      templateDir: { type: 'string', default: './templates' },
      strictVariables: { type: 'boolean', default: false },
    },
  },

  setup(api) {
    const templates = new Map<string, StoredTemplate>();

    // --- template_expand ---
    api.tools.register({
      name: 'template_expand',
      description: 'Expand a template string with variable substitution. Supports {{variable}}, {{#if var}}...{{/if}} conditionals, and {{#each items}}...{{/each}} loops.',
      inputSchema: {
        type: 'object',
        properties: {
          template: { type: 'string', description: 'Template string with {{variable}} placeholders' },
          variables: {
            type: 'object',
            description: 'Variables to substitute into the template',
            additionalProperties: { type: 'string' },
          },
          outputPath: { type: 'string', description: 'Optional path to write the expanded result' },
          raw: { type: 'boolean', default: false, description: 'Disable HTML auto-escaping' },
        },
        required: ['template', 'variables'],
      },
      permission: 'auto',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        const template = input['template'];
        const variables = input['variables'] as Record<string, string> | undefined;
        const outputPath = input['outputPath'] as string | undefined;
        const raw = (input['raw'] as boolean | undefined) ?? false;

        if (!template || typeof template !== 'string') {
          return { ok: false, error: 'template is required and must be a string' };
        }
        if (!variables || typeof variables !== 'object') {
          return { ok: false, error: 'variables is required and must be an object' };
        }

        let result: string;
        try {
          result = raw ? renderTemplateRaw(template, variables) : renderTemplate(template, variables);
        } catch (err: unknown) {
          return { ok: false, error: String(err) };
        }

        if (outputPath) {
          // Path traversal guard: reject absolute paths and path components
          // that escape the working directory. The core write tool has full
          // project-root sandboxing; plugins get defense-in-depth only.
          if (isAbsolute(outputPath) || outputPath.includes('..')) {
            return { ok: false, error: 'outputPath must be a relative path without ".." components' };
          }
          const { writeFileSync } = await import('node:fs');
          writeFileSync(outputPath, result, 'utf-8');
          return {
            ok: true,
            outputPath,
            contentLength: result.length,
            message: `Wrote ${result.length} characters to ${outputPath}`,
          };
        }

        return {
          ok: true,
          result,
          contentLength: result.length,
          variableCount: Object.keys(variables).length,
        };
      },
    });

    // --- template_render ---
    api.tools.register({
      name: 'template_render',
      description: 'Read a template file from disk and expand it with the given variables.',
      inputSchema: {
        type: 'object',
        properties: {
          templatePath: { type: 'string', description: 'Path to the template file' },
          variables: {
            type: 'object',
            description: 'Variables to substitute',
            additionalProperties: { type: 'string' },
          },
          outputPath: { type: 'string', description: 'Optional path to write the rendered result' },
          raw: { type: 'boolean', default: false },
        },
        required: ['templatePath', 'variables'],
      },
      permission: 'auto',
      mutating: true,
      async execute(input: Record<string, unknown>) {
        const templatePath = input['templatePath'];
        const variables = input['variables'] as Record<string, string> | undefined;
        const outputPath = input['outputPath'] as string | undefined;
        const raw = (input['raw'] as boolean | undefined) ?? false;

        if (!templatePath || typeof templatePath !== 'string') {
          return { ok: false, error: 'templatePath is required and must be a string' };
        }
        if (!variables || typeof variables !== 'object') {
          return { ok: false, error: 'variables is required and must be an object' };
        }

        let content: string;
        try {
          const { readFileSync } = await import('node:fs');
          content = readFileSync(templatePath, 'utf-8');
        } catch (err: unknown) {
          return { ok: false, error: `Could not read template file: ${err}` };
        }

        let result: string;
        try {
          result = raw ? renderTemplateRaw(content, variables) : renderTemplate(content, variables);
        } catch (err: unknown) {
          return { ok: false, error: `Template rendering failed: ${err}` };
        }

        if (outputPath) {
          if (isAbsolute(outputPath) || outputPath.includes('..')) {
            return { ok: false, error: 'outputPath must be a relative path without ".." components' };
          }
          const { writeFileSync } = await import('node:fs');
          writeFileSync(outputPath, result, 'utf-8');
          return {
            ok: true,
            templatePath,
            outputPath,
            message: `Rendered and wrote ${result.length} chars to ${outputPath}`,
          };
        }

        return {
          ok: true,
          templatePath,
          result,
          contentLength: result.length,
        };
      },
    });

    // --- template_create ---
    api.tools.register({
      name: 'template_create',
      description: 'Save a named template to the plugin\'s template store for later use.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Unique name for this template' },
          content: { type: 'string', description: 'Template content with {{variable}} placeholders' },
          description: { type: 'string', description: 'Optional description of what this template is for' },
        },
        required: ['name', 'content'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        const name = input['name'] as string;
        const content = input['content'] as string;
        const description = input['description'] as string | undefined;

        if (!name || typeof name !== 'string' || name.trim() === '') {
          return { ok: false, error: 'name is required and must be a non-empty string' };
        }
        if (!content || typeof content !== 'string') {
          return { ok: false, error: 'content is required and must be a string' };
        }

        const now = new Date().toISOString();
        const existing = templates.get(name);

        const tmpl: StoredTemplate = {
          name,
          content,
          description,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        templates.set(name, tmpl);
        api.metrics.gauge('template_count', templates.size);

        return {
          ok: true,
          name,
          message: existing ? `Updated template '${name}'.` : `Created template '${name}'.`,
          createdAt: tmpl.createdAt,
        };
      },
    });

    // --- template_list ---
    api.tools.register({
      name: 'template_list',
      description: 'List all templates saved in the plugin\'s template store.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        const list = Array.from(templates.values()).map((t) => ({
          name: t.name,
          description: t.description,
          contentLength: t.content.length,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        }));

        return {
          ok: true,
          count: list.length,
          templates: list,
        };
      },
    });

    // System prompt contributor
    api.registerSystemPromptContributor(async () => [
      {
        type: 'text' as const,
        text: `Template engine available:
- template_expand: expand a template string with {{variable}}, {{#if}} conditionals, {{#each}} loops
- template_render: render a template file with variables
- template_create: save a named template
- template_list: list saved templates`,
      },
    ]);

    api.log.info('template-engine plugin loaded', { version: '0.1.0' });
  },
};

export default plugin;