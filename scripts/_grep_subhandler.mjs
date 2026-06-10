import * as fs from 'node:fs';
const src = fs.readFileSync('packages/cli/src/subcommands/index.ts', 'utf8');
const lines = src.split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('SubcommandHandler') || lines[i].includes('export type') || lines[i].includes('export interface') || lines[i].includes('logger')) {
    console.log(`${i + 1}: ${lines[i].trim()}`);
  }
}
