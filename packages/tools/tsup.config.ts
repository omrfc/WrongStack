import { defineConfig } from 'tsup';

// L3-A: every public tool gets its own entry so users can
// `import { bashTool } from '@wrongstack/tools/bash'` and tree-shake the
// rest. Underscored files are private helpers and are excluded.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/builtin.ts',
    'src/pack.ts',
    // Public tool entry points — explicit list rather than a glob so
    // removing a tool doesn't silently break a public subpath.
    'src/read.ts',
    'src/write.ts',
    'src/edit.ts',
    'src/replace.ts',
    'src/glob.ts',
    'src/grep.ts',
    'src/bash.ts',
    'src/exec.ts',
    'src/fetch.ts',
    'src/search.ts',
    'src/todo.ts',
    'src/git.ts',
    'src/patch.ts',
    'src/json.ts',
    'src/diff.ts',
    'src/tree.ts',
    'src/lint.ts',
    'src/format.ts',
    'src/typecheck.ts',
    'src/test.ts',
    'src/install.ts',
    'src/audit.ts',
    'src/outdated.ts',
    'src/logs.ts',
    'src/document.ts',
    'src/scaffold.ts',
    'src/tool-search.ts',
    'src/tool-use.ts',
    'src/batch-tool-use.ts',
    'src/tool-help.ts',
    'src/memory.ts',
    'src/mode.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2023',
  external: ['@wrongstack/core'],
});
