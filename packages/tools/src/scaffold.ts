import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/core';
import { safeResolve } from './_util.js';

interface ScaffoldInput {
  template: string;
  name: string;
  cwd?: string;
  vars?: Record<string, string>;
  dry_run?: boolean;
}

interface ScaffoldOutput {
  template: string;
  name: string;
  files_created: number;
  files: string[];
  dry_run: boolean;
  output: string;
}

const BUILT_IN_TEMPLATES: Record<string, { description: string; files: Record<string, string> }> = {
  'npm-package': {
    description: 'Basic npm package with ESM',
    files: {
      'package.json': JSON.stringify(
        {
          name: '{{name}}',
          version: '0.1.1',
          type: 'module',
          main: './dist/index.js',
          scripts: { build: 'tsc', test: 'vitest run' },
          devDependencies: { typescript: '^5.0.0' },
        },
        null,
        2,
      ),
      'tsconfig.json': JSON.stringify(
        {
          compilerOptions: { target: 'ES2022', module: 'ESNext', strict: true },
          include: ['src'],
        },
        null,
        2,
      ),
      'src/index.ts': `export function hello() {\n  return 'Hello from {{name}}';\n}\n`,
      'src/index.test.ts': `import { hello } from './index';\nimport { describe, it, expect } from 'vitest';\n\ndescribe('hello', () => {\n  it('returns greeting', () => {\n    expect(hello()).toBe('Hello from {{name}}');\n  });\n});\n`,
    },
  },
  'cli-tool': {
    description: 'CLI tool with argparse',
    files: {
      'package.json': JSON.stringify(
        {
          name: '{{name}}',
          version: '0.1.1',
          type: 'module',
          bin: { '{{name}}': './src/index.js' },
          scripts: { build: 'tsc', start: 'node dist/index.js' },
        },
        null,
        2,
      ),
      'src/index.ts': `#!/usr/bin/env node\n\nasync function main() {\n  console.log('Hello from {{name}}');\n}\n\nmain();\n`,
    },
  },
  'react-component': {
    description: 'React component with TypeScript',
    files: {
      '{{name}}.tsx': `interface {{Name}}Props {\n  className?: string;\n}\n\nexport function {{Name}}({ className }: {{Name}}Props) {\n  return (\n    <div className={className}>\n      {{Name}} Component\n    </div>\n  );\n}\n`,
      '{{name}}.test.tsx': `import { render, screen } from '@testing-library/react';\nimport { {{Name}} } from './{{Name}}';\n\ndescribe('{{Name}}', () => {\n  it('renders', () => {\n    render(<{{Name}} />);\n    expect(screen.getByText('{{Name}} Component')).toBeInTheDocument();\n  });\n});\n`,
    },
  },
};

export const scaffoldTool: Tool<ScaffoldInput, ScaffoldOutput> = {
  name: 'scaffold',
  category: 'Project',
  description:
    'Generate boilerplate code from built-in templates or paths. Creates package.json, source files, tests.',
  usageHint:
    'Set `template` (npm-package, cli-tool, react-component) and `name`. `vars` for template variables. `dry_run` preview.',
  permission: 'confirm',
  mutating: true,
  timeoutMs: 30_000,
  inputSchema: {
    type: 'object',
    properties: {
      template: {
        type: 'string',
        description:
          'Template name (npm-package, cli-tool, react-component) or path to template directory',
      },
      name: {
        type: 'string',
        description: 'Project/component name (used in generated files)',
      },
      cwd: { type: 'string', description: 'Working directory (default: cwd)' },
      vars: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Template variables for custom templates',
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview generated files without creating (default: false)',
      },
    },
    required: ['template', 'name'],
  },
  async execute(input, ctx) {
    const cwd = input.cwd ? safeResolve(input.cwd, ctx) : ctx.cwd;
    const name = input.name;
    const vars = { name, ...input.vars };

    const builtIn = BUILT_IN_TEMPLATES[input.template];
    if (builtIn) {
      return await handleBuiltIn(name, builtIn.files, cwd, ctx, input.dry_run ?? false, vars);
    }

    return {
      template: input.template,
      name,
      files_created: 0,
      files: [],
      dry_run: input.dry_run ?? false,
      output: `Template "${input.template}" not found. Available: ${Object.keys(BUILT_IN_TEMPLATES).join(', ')}`,
    };
  },
};

async function handleBuiltIn(
  name: string,
  templateFiles: Record<string, string>,
  cwd: string,
  ctx: Parameters<Tool['execute']>[1],
  dryRun: boolean,
  vars: Record<string, string>,
): Promise<ScaffoldOutput> {
  const files: string[] = [];
  let filesCreated = 0;

  for (const [filePath, content] of Object.entries(templateFiles)) {
    const resolvedPath = substituteVars(filePath, name, vars);
    const joinedPath = path.join(cwd, resolvedPath);
    // Ensure generated files cannot escape the project root via template variable injection (e.g. name containing "../")
    const root = path.resolve(ctx.projectRoot);
    const target = path.resolve(joinedPath);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`scaffold: generated path "${resolvedPath}" would escape project root`);
    }
    const fullPath = target;

    if (!dryRun) {
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, substituteVars(content, name, vars), 'utf8');
    }
    files.push(resolvedPath);
    filesCreated++;
  }

  return {
    template: 'built-in',
    name,
    files_created: filesCreated,
    files,
    dry_run: dryRun,
    output: dryRun
      ? `Would create ${filesCreated} files: ${files.join(', ')}`
      : `Created ${filesCreated} files: ${files.join(', ')}`,
  };
}

function substituteVars(content: string, name: string, vars: Record<string, string>): string {
  let result = content;
  result = result.replace(/\{\{name\}\}/g, name.toLowerCase().replace(/\s+/g, '-'));
  result = result.replace(
    /\{\{Name\}\}/g,
    name.replace(/(?:^|[-_\s]+)([a-z])/g, (_, c) => c.toUpperCase()),
  );
  for (const [k, v] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
  }
  return result;
}
