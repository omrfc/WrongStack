import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'auto-doc': 'src/auto-doc/index.ts',
    'git-autocommit': 'src/git-autocommit/index.ts',
    'shell-check': 'src/shell-check/index.ts',
    'cost-tracker': 'src/cost-tracker/index.ts',
    'file-watcher': 'src/file-watcher/index.ts',
    'cron': 'src/cron/index.ts',
    'template-engine': 'src/template-engine/index.ts',
    'semver-bump': 'src/semver-bump/index.ts',
    'secret-scanner': 'src/secret-scanner/index.ts',
    'todo-tracker': 'src/todo-tracker/index.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: false,
  treeshake: true,
  clean: true,
  external: ['@wrongstack/core'],
});